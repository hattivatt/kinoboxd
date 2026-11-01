'use strict';

/**
 * Games: the decade → years donut pair stays clickable (films/books parity).
 *
 * U6 replaced the ranked decade list + year bar chart with two donuts:
 *   - «Десятилетия» is a donut whose slice is a *selection* (click narrows the
 *     years donut, a second click restores the full range);
 *   - «Годы релиза» is a donut that paints every release year by default and
 *     only the ten years of the selected decade after a decade click.
 *
 * A year slice must open the year modal in *both* states — the user
 * requirement is «десятилетие → годы → год → список игр», not just the
 * full-range chart. The smoke drives the real `games.js` in the headless DOM
 * shim: click the 2010-е slice, then the 2012 slice, and read the modal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom, textOf } = require('./helpers/dom-shim');

const { nodeFor, storage } = installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });

const KEY = 'steam-76561198038369983';
storage.set('kinoboxd.games.profile.v1', KEY);

function game(appid, name, releaseYear, hours) {
  return {
    appid,
    name,
    hours,
    releaseYear,
    genres: ['RPG'],
    categories: ['Single-player'],
    type: 'game',
    isFree: false,
    earlyAccess: false,
    completion: null,
    iconUrl: null,
    developers: [],
    publishers: [],
    achievements: null,
  };
}

const gamesIndex = {};
const years = [];
for (let year = 2010; year <= 2019; year += 1) {
  const appid = year - 2009;
  gamesIndex[appid] = game(appid, `Game ${year}`, year, 1);
  years.push({ year, count: 1, hours: 1 });
}
// A second 2012 game so the year modal count is unambiguous.
gamesIndex[12] = game(12, 'Game 2012 b', 2012, 3);
years.find((item) => item.year === 2012).count = 2;
years.find((item) => item.year === 2012).hours = 4;
// A 2020 game outside the narrowed decade.
gamesIndex[13] = game(13, 'Game 2020', 2020, 2);
years.push({ year: 2020, count: 1, hours: 2 });

const payload = {
  sources: {
    connected: [KEY],
    selected: [KEY],
    profile: {
      key: KEY,
      source: 'steam',
      userKey: '76561198038369983',
      personaName: 'hattivatt',
      gameCount: 12,
      libraryPartial: false,
    },
    steamKeyConfigured: true,
  },
  summary: {
    gameCount: 12,
    ownedCount: 12,
    playedCount: 12,
    unplayedCount: 0,
    totalHours: 15,
    meanHours: 1.25,
    medianHours: 1,
    top10HoursShare: 1,
    libraryPartial: false,
    steamKeyConfigured: true,
  },
  hoursHistogram: [],
  topGames: [],
  recentlyPlayed: [],
  backlog: { count: 0, share: 0, items: [] },
  genres: [{ name: 'RPG', count: 12, hours: 15 }],
  tags: [],
  decades: [
    { decade: 2010, count: 11, hours: 13 },
    { decade: 2020, count: 1, hours: 2 },
  ],
  years,
  modes: [],
  access: {},
  timeline: [],
  achievementDays: [],
  streaks: [],
  metadata: {},
  gamesIndex,
};

const profileRow = {
  source: 'steam',
  userKey: '76561198038369983',
  key: KEY,
  personaName: 'hattivatt',
  gameCount: 5,
};

globalThis.fetch = async (url) => {
  const target = String(url);
  let payloadBody = {};
  if (target.startsWith('/api/games/profiles')) {
    payloadBody = { profiles: [profileRow], steamKey: { configured: true, source: 'file' } };
  } else if (target.startsWith('/api/games/stats')) {
    payloadBody = payload;
  } else if (target.startsWith('/api/games/personnel')) {
    payloadBody = { role: 'developer', persons: [] };
  } else if (target.startsWith('/api/games/enrich')) {
    payloadBody = { running: false };
  }
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    async json() { return payloadBody; },
    async text() { return JSON.stringify(payloadBody); },
  };
};

function walk(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

/** Donut slices of `host` as `{ key, node }` (SVG paths carry `data-key`). */
function slices(hostId) {
  const hits = [];
  walk(nodeFor(hostId), (node) => {
    const key = node.attributes && node.attributes['data-key'];
    if (key) hits.push({ key, node });
  });
  return hits;
}
function yearKeys() {
  return slices('games-years-donut').map((slice) => slice.key);
}
function yearSlice(year) {
  return slices('games-years-donut').find((slice) => slice.key === `year-${year}`).node;
}
function decadeSlice(start) {
  return slices('games-decades-donut').find((slice) => slice.key === `decade-${start}`).node;
}
function lastModalText() {
  const root = nodeFor('modal-root');
  if (!root || !root.children.length) return '';
  return textOf(root.children[root.children.length - 1]).replace(/\s+/g, ' ').trim();
}
function resetModals() { nodeFor('modal-root').children = []; }
async function wait(ms = 0) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('games donut pair: decade selects, year slice opens the year modal in both states', async () => {
  const games = await import('../public/js/games.js');
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(40);

  // Full range first: every release year is a clickable slice (newest first).
  assert.equal(nodeFor('games-years-widget').hidden, false);
  assert.deepEqual(yearKeys(), [
    'year-2020', 'year-2019', 'year-2018', 'year-2017', 'year-2016',
    'year-2015', 'year-2014', 'year-2013', 'year-2012', 'year-2011', 'year-2010',
  ]);
  const firstSlice = yearSlice(2012);
  assert.equal(firstSlice.attributes.role, 'button');
  firstSlice.click();
  await wait(20);
  assert.match(lastModalText(), /2 игры 2012 года/);
  resetModals();

  // The decade donut is a selection: 2010-е narrows the years donut to ten
  // slices, and the slice itself is highlighted (`is-selected`).
  const decade2010 = decadeSlice(2010);
  assert.ok(decade2010, 'the 2010-е decade slice exists');
  assert.equal(decade2010.attributes['aria-pressed'], 'false');
  decade2010.click();
  await wait(20);
  assert.match(textOf(nodeFor('games-years-note')).replace(/\s+/g, ' '), /2010–2019/);
  assert.equal(decadeSlice(2010).attributes['aria-pressed'], 'true');
  assert.deepEqual(yearKeys(), [
    'year-2019', 'year-2018', 'year-2017', 'year-2016', 'year-2015',
    'year-2014', 'year-2013', 'year-2012', 'year-2011', 'year-2010',
  ]);
  yearSlice(2012).click();
  await wait(20);
  assert.match(lastModalText(), /2 игры 2012 года/);
  resetModals();

  // A second click on the same slice clears the selection (full range back).
  decadeSlice(2010).click();
  await wait(20);
  assert.equal(yearKeys().length, 11);
  assert.equal(decadeSlice(2010).attributes['aria-pressed'], 'false');
  yearSlice(2012).click();
  await wait(20);
  assert.match(lastModalText(), /2 игры 2012 года/);
});

test('games decades donut: the unknown-year bucket is a note, not a slice', async () => {
  const games = await import('../public/js/games.js');
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(40);

  // The fixture has no year-less games: the note carries no unknown button.
  assert.doesNotMatch(textOf(nodeFor('games-decades-note')), /без года/);
  // And no slice pretends to be a decade for them.
  assert.equal(slices('games-decades-donut').length, 2);
});
