'use strict';

/**
 * Games split F3: the normalisers moved out of `public/js/games-view.js`.
 *
 * Three properties are pinned here:
 *
 *   1. every `public/js/games/**` module exports exactly the names the view
 *      imports (a stale re-export or a forgotten import fails loudly);
 *   2. `games-view.js` re-exports the moved functions by identity, so
 *      `games.js` / `games-modal.js` keep importing one implementation;
 *   3. the normalisers behave identically on the real `/stats` fixture and on
 *      every JSON fixture under `test/fixtures/games/**`, and stay tolerant on
 *      null / empty / unknown-enum input.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { installDom } = require('./helpers/dom-shim');

installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });

const ROOT = path.join(__dirname, '..');
const GAMES_FIXTURES = path.join(__dirname, 'fixtures', 'games');
const UI_FIXTURES = path.join(__dirname, 'fixtures', 'games-ui');
const JS_DIR = path.join(ROOT, 'public', 'js');

const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const SPLIT_EXPORTS = {
  'public/js/games/normalize/common.js': [
    'STEAM_REVIEW_SCALE', 'boolOrNull', 'hoursText', 'normalizeFranchiseRef', 'normalizeGenres',
    'normalizeHours', 'normalizeHours2w', 'normalizeTagsList', 'resolveReviewBucket',
    'reviewScaleEntry', 'toCount',
  ],
  'public/js/games/normalize/payload.js': ['normalizeGamesPayload'],
  'public/js/games/normalize/secondary.js': [
    'SECONDARY_SOURCE_LABELS', 'SECONDARY_SOURCE_ORDER', 'normalizeSecondaryWork',
    'normalizeSourceKey', 'secondaryChartStatus',
  ],
  'public/js/games/normalize/profile.js': ['normalizeCardPersonnel', 'normalizeProfile'],
  'public/js/games/normalize/buckets.js': [
    'normalizeAchievementDays', 'normalizeDecades', 'normalizeFranchises', 'normalizeHistogram',
    'normalizePersonnelTop', 'normalizeScores', 'normalizeStudios', 'normalizeTimeline',
    'normalizeUnknownYear', 'normalizeWeightItems', 'normalizeYears',
  ],
  'public/js/games/normalize/graph.js': [
    'normalizeGameIndexEntry', 'normalizeIndexAchievements', 'normalizePersonGames',
  ],
  'public/js/games/normalize/summary.js': [
    'MODE_DEFS', 'normalizeAccessBlock', 'normalizeAchievements', 'normalizeCompletion',
    'normalizeDlcSummary', 'normalizeExcluded', 'normalizeFilters', 'normalizeMetadata',
    'normalizeModes', 'normalizeReviewScoreBlock',
  ],
  'public/js/games/labels.js': [
    'GAME_PLURAL', 'SECONDARY_WORK_PLURAL', 'epochSeconds', 'formatDateRu', 'formatDateShortRu',
    'percentNumber', 'percentText', 'shortDayText',
  ],
  'public/js/games/sources.js': ['gogSourcesView', 'gogStatusText'],
  'public/js/games/secondary-card.js': ['asSecondaryWork', 'secondaryWorkCardView'],
  'public/js/games/import-flow.js': [
    'accountFromInput', 'gamesJobId', 'importErrorText', 'jobStageText', 'normalizeProfilesList',
  ],
};

const RE_EXPORTED = {
  'public/js/games/normalize/payload.js': ['normalizeGamesPayload'],
  'public/js/games/normalize/common.js': ['STEAM_REVIEW_SCALE', 'hoursText', 'resolveReviewBucket'],
  'public/js/games/normalize/secondary.js': ['normalizeSecondaryWork', 'secondaryChartStatus'],
  'public/js/games/normalize/summary.js': ['MODE_DEFS'],
  'public/js/games/labels.js': ['formatDateRu', 'formatDateShortRu', 'percentNumber', 'percentText'],
  'public/js/games/sources.js': ['gogSourcesView', 'gogStatusText'],
  'public/js/games/secondary-card.js': ['secondaryWorkCardView'],
  'public/js/games/import-flow.js': [
    'accountFromInput', 'gamesJobId', 'importErrorText', 'jobStageText', 'normalizeProfilesList',
  ],
};

const MOVED_DEFINITIONS = [
  'normalizeGamesPayload', 'normalizeSecondaryWork', 'normalizeCardPersonnel',
  'normalizeScores', 'normalizeStudios', 'normalizePersonGames', 'normalizeReviewScoreBlock',
  'secondaryChartStatus', 'percentText', 'formatDateRu', 'gogSourcesView', 'accountFromInput',
];

const OWN_SCAN_DIRS = [
  path.join(JS_DIR, 'games'),
];
const OWN_SCAN_FILES = [path.join(JS_DIR, 'games-view.js')];

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function jsonFixtures(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsonFixtures(full));
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out.sort();
}

test('the split modules export exactly the names the view imports', async () => {
  for (const [relative, expected] of Object.entries(SPLIT_EXPORTS)) {
    const mod = await load(relative);
    assert.deepEqual(Object.keys(mod).sort(), [...expected].sort(), `${relative} export list`);
  }
});

test('games-view.js re-exports the split functions by identity', async () => {
  const view = await load('public/js/games-view.js');
  for (const [relative, names] of Object.entries(RE_EXPORTED)) {
    const mod = await load(relative);
    for (const name of names) {
      assert.ok(name in mod, `${relative} has no ${name}`);
      assert.equal(view[name], mod[name], `games-view.js ${name} is not the ${relative} one`);
    }
  }
});

test('every moved normaliser is defined once under public/js/games', () => {
  const files = [...OWN_SCAN_DIRS.flatMap(jsFiles), ...OWN_SCAN_FILES];
  const sources = files.map((file) => ({ file, src: fs.readFileSync(file, 'utf8') }));
  const duplicated = [];
  for (const name of MOVED_DEFINITIONS) {
    const pattern = new RegExp(`function ${name}\\s*\\(`);
    const sites = sources
      .filter(({ src }) => pattern.test(src))
      .map(({ file }) => path.relative(ROOT, file));
    if (sites.length !== 1) duplicated.push(`${name}: ${sites.length ? sites.join(', ') : 'nowhere'}`);
  }
  assert.deepEqual(duplicated, [], `definition counts: ${duplicated.join('; ')}`);
});

test('normalizeGamesPayload is deep-equal on the real /stats fixture', async () => {
  const { normalizeGamesPayload } = await load('public/js/games/normalize/payload.js');
  const reExported = (await load('public/js/games-view.js')).normalizeGamesPayload;
  const raw = readJson(path.join(UI_FIXTURES, 'stats-m2-mock.json'));

  const fromModule = normalizeGamesPayload(raw);
  assert.deepEqual(fromModule, reExported(raw));
  assert.equal(fromModule.summary.gameCount, 340);
  assert.equal(fromModule.summary.totalHours, 5862.6);
  assert.equal(fromModule.profile.personaName, 'whitefiercewolf');
  assert.ok(Object.keys(fromModule.gamesIndex).length > 0, 'gamesIndex is empty on the real fixture');
  assert.equal(fromModule.decades.length, 5);
});

test('normalisation matches on every JSON fixture from test/fixtures/games/**', async () => {
  const { normalizeGamesPayload } = await load('public/js/games/normalize/payload.js');
  const reExported = (await load('public/js/games-view.js')).normalizeGamesPayload;
  const files = jsonFixtures(GAMES_FIXTURES);
  assert.ok(files.length >= 10, `found only ${files.length} fixtures`);

  for (const file of files) {
    const raw = readJson(file);
    const relative = path.relative(GAMES_FIXTURES, file);
    assert.deepEqual(
      normalizeGamesPayload(raw),
      reExported(raw),
      `normalizeGamesPayload differs on ${relative}`,
    );
  }
});

test('edge cases stay tolerant and identical: null, {}, missing keys, unknown enum', async () => {
  const payload = await load('public/js/games/normalize/payload.js');
  const view = await load('public/js/games-view.js');

  const empty = payload.normalizeGamesPayload(null);
  assert.deepEqual(empty, view.normalizeGamesPayload(null));
  assert.deepEqual(empty.gamesIndex, {});
  assert.deepEqual(empty.secondaryWorks, []);
  assert.equal(empty.summary.gameCount, 0);
  assert.equal(empty.summary.totalHours, null);
  assert.equal(empty.profile, null);

  const emptyObject = payload.normalizeGamesPayload({});
  assert.deepEqual(emptyObject, view.normalizeGamesPayload({}));
  assert.deepEqual(emptyObject, empty);

  const missingKeys = { summary: { gameCount: '340' }, sources: { profile: {} } };
  assert.deepEqual(payload.normalizeGamesPayload(missingKeys), view.normalizeGamesPayload(missingKeys));
  assert.equal(payload.normalizeGamesPayload(missingKeys).summary.gameCount, 340);
  assert.equal(payload.normalizeGamesPayload(missingKeys).profile, null);

  const unknownEnum = { scores: { buckets: [{ bucket: 'nonsense', count: 3 }] } };
  assert.deepEqual(payload.normalizeGamesPayload(unknownEnum), view.normalizeGamesPayload(unknownEnum));

  const { resolveReviewBucket } = await load('public/js/games/normalize/common.js');
  assert.equal(resolveReviewBucket('что-то своё'), null);
  assert.equal(resolveReviewBucket('Overwhelmingly Positive'), 9);
  assert.equal(view.resolveReviewBucket('что-то своё'), resolveReviewBucket('что-то своё'));

  const { normalizePersonnelRole } = view;
  assert.equal(normalizePersonnelRole('showrunner'), '');
  assert.equal(normalizePersonnelRole('shoe designer'), '');
  assert.equal(normalizePersonnelRole('studio'), 'developer');
});
