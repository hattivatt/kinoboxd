'use strict';

/**
 * M6d → UI: the union card of a secondary (GOG/Epic-only) work paints the
 * store poster, not the horizontal banner.
 *
 * M6d started sending `secondaryWorks[].verticalCover` (GOG box art 171×241,
 * Epic portrait 1200×1600), but `normalizeSecondaryWork` only knew
 * `verticalCoverUrl`/`coverUrl`, so the card fell back to `image`. This smoke
 * drives the real list → union-card path:
 *
 *   - a chart drilldown row (`gamesIndex`, `secondaryOnly`) opens the card from
 *     `secondaryWorks` (the row itself carries no art);
 *   - the card head paints `verticalCover`;
 *   - without a store poster the horizontal `image` is the fallback;
 *   - without any art the initials block is painted, no URL is invented.
 *
 * No network: every node comes from the DOM shim.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom, textOf } = require('./helpers/dom-shim');

const { nodeFor } = installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });

const GOG_POSTER = 'https://images-1.gog-statics.com/box_171x241.jpg';
const GOG_BANNER = 'https://images.gog.com/indie-banner.jpg';

function walk(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function images(host) {
  const found = [];
  walk(host, (node) => {
    if (node.tagName === 'IMG') found.push(node.getAttribute('src') || '');
  });
  return found;
}

function findByClass(host, className) {
  let hit = null;
  walk(host, (node) => {
    if (!hit && String(node.className || '').split(/\s+/).includes(className)) hit = node;
  });
  return hit;
}

/** One `secondaryWorks[]` entry as `/stats` sends it (M6d shape). */
function secondaryWork(overrides = {}) {
  return {
    workKey: 'gog:1999999999',
    name: 'GOG Exclusive Indie',
    source: 'gog',
    sources: ['gog'],
    ownedOn: ['gog'],
    storeIds: { steam: null, gog: '1999999999', epic: null },
    hoursBySource: { steam: null, gog: 12.3, epic: null },
    hours: 12.3,
    secondaryHours: 12.3,
    displayHours: 12.3,
    releaseYear: 2007,
    genres: ['Indie'],
    gog: {
      gogGameId: '1999999999',
      slug: 'gog_exclusive_indie',
      title: 'GOG Exclusive Indie',
      image: GOG_BANNER,
    },
    epic: null,
    ...overrides,
  };
}

function payload(work) {
  return {
    sources: {
      profile: { key: 'steam-76561198038369983', personaName: 'player' },
      gog: { configured: true, connected: true, status: 'ok', productCount: 4 },
      epic: null,
    },
    summary: { gameCount: 340, ownedCount: 340, totalHours: 5852.7 },
    // The light drilldown row: no poster on purpose (the card needs the full
    // `secondaryWorks` entry, exactly like the real payload).
    gamesIndex: {
      'gog:1999999999': {
        appid: null,
        workKey: 'gog:1999999999',
        secondaryOnly: true,
        source: 'gog',
        name: 'GOG Exclusive Indie',
        hours: 12.3,
        hours2w: 0,
        rtime: 0,
        lastPlayed: null,
        iconUrl: null,
        canonicalWorkKey: 'gog:1999999999',
        primaryAppid: null,
        isPrimary: true,
        editionCount: 1,
        canonicalHours: 12.3,
        sources: ['gog'],
        storeIds: { steam: null, gog: '1999999999', epic: null },
        hoursBySource: { steam: null, gog: 12.3, epic: null },
        type: 'game',
        year: 2007,
        releaseYear: 2007,
        genres: ['Indie'],
        developers: [],
        publishers: [],
        categories: [],
      },
    },
    secondaryWorks: [work],
  };
}

function resetModals() {
  const root = nodeFor('modal-root');
  root.replaceChildren();
  return root;
}

async function openCardFromYearList() {
  const { normalizeGamesPayload, gamesInYear } = await import('../public/js/games-view.js');
  const { configureGamesModals, openGameListModal } = await import('../public/js/games-modal.js');
  const data = normalizeGamesPayload(payload(secondaryWork({ verticalCover: GOG_POSTER })));
  configureGamesModals({
    profile: 'steam-76561198038369983',
    gamesIndex: data.gamesIndex,
    secondaryWorks: data.secondaryWorks,
  });
  const root = resetModals();
  const rows = gamesInYear(data.gamesIndex, 2007);
  assert.equal(rows.length, 1, 'drilldown must carry the secondary-only row');
  openGameListModal({ title: '2007 — 1 игра', games: rows });
  const row = findByClass(root, 'film-row');
  assert.ok(row, 'list row did not render');
  assert.match(textOf(row), /GOG Exclusive Indie/);
  row.click();
  return root;
}

test('union card: a secondary work paints its `verticalCover` store poster', async () => {
  const root = await openCardFromYearList();
  const srcs = images(root);
  assert.ok(srcs.length >= 1, 'карточка без обложки');
  assert.equal(srcs[0], GOG_POSTER);
  assert.equal(srcs.includes(GOG_BANNER), false, 'горизонтальный баннер не должен подменять постер');
  assert.match(textOf(root).replace(/\s+/g, ' '), /GOG Exclusive Indie/);
});

test('union card: no `verticalCover` falls back to the horizontal image, then initials', async () => {
  const { normalizeGamesPayload, secondaryWorkCardView } = await import('../public/js/games-view.js');
  const { openSecondaryWorkCardModal } = await import('../public/js/games-modal.js');

  const bannerOnly = normalizeGamesPayload(payload(secondaryWork())).secondaryWorks[0];
  assert.equal(bannerOnly.verticalCover, null);
  assert.equal(secondaryWorkCardView(bannerOnly).coverUrl, GOG_BANNER);
  let root = resetModals();
  openSecondaryWorkCardModal(bannerOnly);
  assert.deepEqual(images(root), [GOG_BANNER]);

  const noArt = normalizeGamesPayload(payload(secondaryWork({
    gog: { gogGameId: '1999999999', slug: 'gog_exclusive_indie', title: 'GOG Exclusive Indie' },
  }))).secondaryWorks[0];
  assert.equal(noArt.verticalCover, null);
  assert.equal(noArt.coverUrl, null);
  root = resetModals();
  openSecondaryWorkCardModal(noArt);
  assert.deepEqual(images(root), []);
  // The initials block still names the work: no invented URL.
  assert.equal(textOf(findByClass(root, 'modal-game-cover')).trim(), 'G');
});
