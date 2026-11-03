'use strict';

/**
 * Games M4 widgets: headless DOM smoke.
 *
 * The view-model tests pin the numbers; this one drives the real `games.js`
 * against the DOM shim and checks that the new cards actually paint and
 * that a tag row opens the games modal. It also proves the tolerant path:
 * the payload carries every M4 block, and the widgets appear without a second
 * `/api/games/franchises` request (the block is already in `/stats`).
 * The DLC card was removed in the cosmetic round; its payload block is kept
 * here on purpose, so the test pins «payload unchanged, nothing painted».
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom, textOf } = require('./helpers/dom-shim');

const { nodeFor, storage } = installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });

const KEY = 'steam-76561198038369983';
storage.set('kinoboxd.games.profile.v1', KEY);

function game(appid, name, hours, year, extra = {}) {
  return {
    appid,
    name,
    hours,
    releaseYear: year,
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
    ...extra,
  };
}

const gamesIndex = {
  292030: game(292030, 'The Witcher 3', 107, 2015, {
    tags: ['RPG', 'Open World'],
    reviewScore: 9,
    franchise: { key: 'witcher', label: 'The Witcher' },
  }),
  20900: game(20900, 'The Witcher', 60, 2007, {
    tags: ['RPG'],
    reviewDesc: 'Very Positive',
    franchise: { key: 'witcher', label: 'The Witcher' },
  }),
  203770: game(203770, 'Crusader Kings II', 1054.4, 2012, {
    tags: ['Strategy', 'Open World'],
    reviewScore: 8,
  }),
};

const payload = {
  sources: {
    connected: [KEY],
    selected: [KEY],
    profile: {
      key: KEY,
      source: 'steam',
      userKey: '76561198038369983',
      personaName: 'hattivatt',
      gameCount: 3,
      libraryPartial: false,
    },
    steamKeyConfigured: true,
  },
  summary: {
    gameCount: 3,
    ownedCount: 3,
    playedCount: 3,
    unplayedCount: 0,
    totalHours: 1221.4,
    meanHours: 407.13,
    medianHours: 107,
    top10HoursShare: 1,
    libraryPartial: false,
    steamKeyConfigured: true,
    reviewScore: { avg: 7.4, median: 8 },
    dlc: {
      gamesWithDlc: 2,
      avgCount: 3.25,
      max: [
        { name: 'Crusader Kings II', dlcCount: 24, appid: 203770 },
        { name: 'The Witcher 3', dlcCount: 18, appid: 292030 },
      ],
    },
  },
  hoursHistogram: [],
  topGames: [],
  recentlyPlayed: [],
  backlog: { count: 0, share: 0, items: [] },
  genres: [{ name: 'RPG', count: 3, hours: 1221.4 }],
  tags: [
    { name: 'Open World', count: 2, hours: 1161.4, weight: 12801 },
    { name: 'RPG', count: 2, hours: 167, weight: 10011 },
    { name: 'Strategy', count: 1, hours: 1054.4, weight: 9010 },
  ],
  scores: [
    { bucket: 9, count: 1, hours: 107 },
    { bucket: 'Very Positive', count: 1, hours: 1054.4 },
    { bucket: 5, count: 1, hours: 60 },
  ],
  franchises: [
    { key: 'witcher', label: 'The Witcher', gamesCount: 2, hoursSum: 167, yearsSpread: 8, appids: [292030, 20900] },
  ],
  decades: [{ decade: 2010, count: 1, hours: 107 }, { decade: 2000, count: 1, hours: 60 }],
  years: [{ year: 2012, count: 1, hours: 1054.4 }, { year: 2015, count: 1, hours: 107 }],
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
  gameCount: 3,
};

globalThis.fetch = async (url) => {
  const target = String(url);
  let body = {};
  if (target.startsWith('/api/games/profiles')) {
    body = { profiles: [profileRow], steamKey: { configured: true, source: 'file' } };
  } else if (target.startsWith('/api/games/stats')) {
    body = payload;
  } else if (target.startsWith('/api/games/personnel')) {
    body = { role: 'developer', persons: [] };
  } else if (target.startsWith('/api/games/enrich')) {
    body = { running: false };
  }
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
};

async function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastModalText() {
  const root = nodeFor('modal-root');
  if (!root || !root.children.length) return '';
  return textOf(root.children[root.children.length - 1]).replace(/\s+/g, ' ').trim();
}

test('M4 widgets paint from a /stats payload and a tag row opens the games modal', async () => {
  const games = await import('../public/js/games.js');
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(50);

  assert.equal(nodeFor('games-tags-widget').hidden, false);
  const tagRows = nodeFor('games-tags-chart').children;
  assert.equal(tagRows.length, 3);
  assert.match(textOf(nodeFor('games-tags-chart')), /Open World/);
  assert.match(textOf(nodeFor('games-tags-note')), /3 тега · по часам/);

  assert.equal(nodeFor('games-scores-widget').hidden, false);
  assert.match(textOf(nodeFor('games-scores-legend')), /Очень положительные/);
  assert.match(textOf(nodeFor('games-scores-honest')), /оценки Steam, не личные/);
  assert.match(textOf(nodeFor('games-scores-note')), /средняя 7,4\/9/);

  assert.equal(nodeFor('games-franchises-widget').hidden, false);
  assert.match(textOf(nodeFor('games-franchises-list')), /The Witcher/);
  assert.match(textOf(nodeFor('games-franchises-note')), /1 франшиза · по часам/);

  // Cosmetic round: the DLC card is gone, even though the payload still
  // carries `summary.dlc` (payload contract unchanged) — nothing paints it.
  assert.equal(textOf(nodeFor('games-dlc-summary')), '');
  assert.equal(textOf(nodeFor('games-dlc-list')), '');

  // Tag drilldown: click the «Open World» row.
  const openWorld = tagRows.find((row) => textOf(row).includes('Open World'));
  assert.ok(openWorld, 'нет строки тега Open World');
  openWorld.click();
  await wait(20);
  const modal = lastModalText();
  assert.match(modal, /Open World/);
  assert.match(modal, /The Witcher 3/);
  assert.match(modal, /Crusader Kings II/);
});
