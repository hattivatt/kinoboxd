'use strict';

/**
 * Games: the decade-narrowed «Годы релиза» chart stays clickable.
 *
 * `renderYears()` paints every release year by default and narrows to ten
 * columns after a decade click (the films-parity drilldown pair). A bar click
 * must open the year modal in *both* states — the user requirement is
 * «десятилетие → годы → год → список игр», not just the full-range chart.
 *
 * The smoke drives the real `games.js` in the headless DOM shim: click the
 * 2010-е row, then the 2012 bar, and read the modal.
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
function yearHits() {
  const hits = [];
  walk(nodeFor('games-years-chart'), (node) => {
    if (node.attributes && node.attributes['data-year']) hits.push(node);
  });
  return hits;
}
function decadeRows() {
  return nodeFor('games-decades-list').children
    .filter((node) => node.classList && node.classList.contains('genre-row'));
}
function lastModalText() {
  const root = nodeFor('modal-root');
  if (!root || !root.children.length) return '';
  return textOf(root.children[root.children.length - 1]).replace(/\s+/g, ' ').trim();
}
function resetModals() { nodeFor('modal-root').children = []; }
async function wait(ms = 0) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('games years: a bar click opens the year modal in narrowed and full-range states', async () => {
  const games = await import('../public/js/games.js');
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(40);

  // Full range first: every release year is a click target.
  assert.equal(nodeFor('games-years-widget').hidden, false);
  assert.deepEqual(
    yearHits().map((node) => node.attributes['data-year']),
    ['2010', '2011', '2012', '2013', '2014', '2015', '2016', '2017', '2018', '2019', '2020'],
  );
  yearHits().find((node) => node.attributes['data-year'] === '2012').click();
  await wait(20);
  assert.match(lastModalText(), /2 игры 2012 года/);
  resetModals();

  // Decade click narrows the pair to ten columns; 2012 must stay clickable.
  const row2010 = decadeRows().find((row) => textOf(row).includes('2010-е'));
  assert.ok(row2010, 'the 2010-е decade row exists');
  row2010.click();
  await wait(20);
  assert.match(textOf(nodeFor('games-years-note')).replace(/\s+/g, ' '), /2010–2019/);
  assert.deepEqual(
    yearHits().map((node) => node.attributes['data-year']),
    ['2010', '2011', '2012', '2013', '2014', '2015', '2016', '2017', '2018', '2019'],
  );
  const hit2012 = yearHits().find((node) => node.attributes['data-year'] === '2012');
  assert.equal(hit2012.classList.contains('is-clickable'), true);
  assert.equal(hit2012.attributes.role, 'button');
  hit2012.click();
  await wait(20);
  assert.match(lastModalText(), /2 игры 2012 года/);
  resetModals();

  // Second decade click restores the full range and clicks still work.
  row2010.click();
  await wait(20);
  assert.equal(yearHits().length, 11);
  yearHits().find((node) => node.attributes['data-year'] === '2012').click();
  await wait(20);
  assert.match(lastModalText(), /2 игры 2012 года/);
});
