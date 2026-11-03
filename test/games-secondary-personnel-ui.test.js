'use strict';

/**
 * Secondary-only works in the games UI (03.11.2026): the union card shows
 * developers/publishers and a franchise chip, a person's games resolve by
 * `workKey` (no appid), and a franchise list matches secondary rows.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom, textOf } = require('./helpers/dom-shim');

const AW2_ROW = {
  appid: null,
  workKey: 'epic:cat-aw2',
  secondaryOnly: true,
  source: 'epic',
  name: 'Alan Wake 2',
  hours: 54.5,
  releaseYear: 2023,
  genres: ['Action'],
  developers: ['Remedy Entertainment'],
  publishers: ['Epic Games Publishing'],
  qid: 'Q108417001',
  franchise: { key: 'wd:Q211910', label: 'Alan Wake', labelRu: 'Alan Wake' },
};

const STEAM_ROW = {
  appid: 108710,
  name: 'Alan Wake',
  hours: 10,
  releaseYear: 2010,
  genres: ['Action'],
  developers: ['Remedy Entertainment'],
  publishers: ['Microsoft Studios'],
  franchise: { key: 'wd:Q211910', label: 'Alan Wake', labelRu: 'Alan Wake' },
};

function findNode(root, predicate) {
  let found = null;
  const walk = (node) => {
    if (!node || found) return;
    if (predicate(node)) {
      found = node;
      return;
    }
    for (const child of node.children || []) walk(child);
  };
  walk(root);
  return found;
}

test('normalizeSecondaryWork: developers, publishers, qid and franchise are additive', async () => {
  const view = await import('../public/js/games-view.js');
  const row = view.normalizeSecondaryWork({
    workKey: 'epic:cat-aw2',
    name: 'Alan Wake 2',
    sources: ['epic'],
    developers: ['Remedy Entertainment'],
    publishers: ['Epic Games Publishing'],
    qid: 'Q108417001',
    franchise: { key: 'wd:Q211910', label: 'Alan Wake' },
    hoursBySource: { epic: 54.5 },
    epic: { slug: 'alan-wake-2' },
  });
  assert.deepEqual(row.developers, ['Remedy Entertainment']);
  assert.deepEqual(row.publishers, ['Epic Games Publishing']);
  assert.equal(row.qid, 'Q108417001');
  assert.equal(row.franchise.key, 'wd:Q211910');
  assert.equal(row.franchise.label, 'Alan Wake');
  assert.deepEqual(row.franchise.workKeys, []);

  // An old payload without the new fields stays valid and empty.
  const legacy = view.normalizeSecondaryWork({
    workKey: 'gog:1',
    name: 'Legacy Work',
    sources: ['gog'],
    hoursBySource: { gog: 2 },
  });
  assert.deepEqual(legacy.developers, []);
  assert.deepEqual(legacy.publishers, []);
  assert.equal(legacy.franchise, null);
  assert.equal(legacy.qid, null);
});

test('personGames: a secondary work resolves by workKey and keeps its row', async () => {
  const view = await import('../public/js/games-view.js');
  const gamesIndex = {
    'epic:cat-aw2': AW2_ROW,
    108710: STEAM_ROW,
  };
  const games = view.personGames(
    {
      name: 'Remedy Entertainment',
      games: [
        { appid: 108710, name: 'Alan Wake', hours: 10 },
        {
          appid: null,
          workKey: 'epic:cat-aw2',
          secondaryOnly: true,
          name: 'Alan Wake 2',
          hours: 54.5,
        },
      ],
    },
    gamesIndex
  );
  assert.equal(games.length, 2);
  const aw2 = games.find((row) => row.workKey === 'epic:cat-aw2');
  assert.ok(aw2, 'the secondary row must not be dropped');
  assert.equal(aw2.appid, null);
  assert.equal(aw2.secondaryOnly, true);
  assert.equal(aw2.name, 'Alan Wake 2');
  assert.equal(aw2.hours, 54.5);
  assert.equal(aw2.franchise.label, 'Alan Wake');
  // A row without appid and without workKey is still unusable — dropped.
  assert.equal(view.personGames({ games: [{ name: 'nothing' }] }, gamesIndex).length, 0);
});

test('gamesInFranchise: explicit workKeys match secondary rows; label fallback still works', async () => {
  const view = await import('../public/js/games-view.js');
  const gamesIndex = {
    'epic:cat-aw2': AW2_ROW,
    108710: STEAM_ROW,
  };
  const byKeys = view.gamesInFranchise(gamesIndex, {
    key: 'wd:Q211910',
    label: 'Alan Wake',
    appids: [108710],
    workKeys: ['epic:cat-aw2'],
  });
  assert.deepEqual(
    byKeys.map((row) => row.workKey || row.appid).sort(),
    [108710, 'epic:cat-aw2'].sort()
  );

  // Without explicit membership the row's own franchise reference decides.
  const byLabel = view.gamesInFranchise(gamesIndex, {
    key: 'wd:Q211910',
    label: 'Alan Wake',
    appids: [],
    workKeys: [],
  });
  assert.equal(byLabel.length, 2);
});

test('franchisesView: workKeys survive the view model', async () => {
  const view = await import('../public/js/games-view.js');
  const block = view.franchisesView({
    franchises: [
      {
        key: 'wd:Q211910',
        label: 'Alan Wake',
        gamesCount: 2,
        hoursSum: 64.5,
        appids: [108710],
        workKeys: ['epic:cat-aw2'],
      },
    ],
  });
  assert.ok(block);
  assert.deepEqual(block.rows[0].workKeys, ['epic:cat-aw2']);
});

test('secondary card: developers/publishers rows + franchise chip that opens the list', async () => {
  const { nodeFor } = installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });
  const modal = await import('../public/js/games-modal.js');
  modal.configureGamesModals({
    profile: 'steam-76561198000000901',
    gamesIndex: { 'epic:cat-aw2': AW2_ROW, 108710: STEAM_ROW },
    secondaryWorks: [AW2_ROW],
  });
  modal.openSecondaryWorkCardModal(AW2_ROW);
  const root = nodeFor('modal-root');
  const text = textOf(root).replace(/\s+/g, ' ');
  assert.match(text, /разработчики/);
  assert.match(text, /Remedy Entertainment/);
  assert.match(text, /издатели/);
  assert.match(text, /Epic Games Publishing/);
  assert.match(text, /Франшиза/);
  assert.match(text, /Alan Wake/);
  assert.match(text, /Q108417001/);

  const chip = findNode(root, (node) =>
    String(node.className || '').includes('game-franchise-chip')
  );
  assert.ok(chip, 'the card must paint a franchise chip');
  chip.click();
  const listText = textOf(nodeFor('modal-root')).replace(/\s+/g, ' ');
  assert.match(listText, /Alan Wake 2/);
  assert.match(listText, /Alan Wake/);
});
