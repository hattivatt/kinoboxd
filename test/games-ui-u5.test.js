'use strict';

/**
 * Games U5: the four removed widgets, the «Недавно играл» top strip and the
 * «мин. часов» filter.
 *
 * Three layers:
 *
 *   1. markup/CSS absence — the histogram, backlog list, modes and access
 *      cards must stay gone (their ids and selectors are asserted missing in
 *      `games-ui.test.js` / `games-ui-m2.test.js`; this file drives the real
 *      `games.js` and proves the renderers no longer even look them up);
 *   2. the top strip paints cards from `gamesIndex` when the payload's
 *      `recentlyPlayed` is empty (rtime desc, 2-week hours first) and a card
 *      click opens the existing game-card modal;
 *   3. `minHours` is sent as `?minHours=N` (omitted at the 0 default), the
 *      −/+ steppers clamp at −1 and the value is stored per Steam profile.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom, textOf } = require('./helpers/dom-shim');

const { nodeFor, storage, byId } = installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });

const KEY = 'steam-76561198000000001';
const KEY2 = 'steam-76561198000000002';
storage.set('kinoboxd.games.profile.v1', KEY);
storage.set(`kinoboxd.games.filters.${KEY}.v1`, JSON.stringify({ includeFree: true, includeDlc: false, minHours: 3 }));
storage.set(`kinoboxd.games.filters.${KEY2}.v1`, JSON.stringify({ includeFree: false, includeDlc: true, minHours: 7 }));

const nowSeconds = Math.floor(Date.now() / 1000);
const twoDaysAgo = nowSeconds - 2 * 86400;
const tenDaysAgo = nowSeconds - 10 * 86400;
const twoYearsAgo = nowSeconds - 730 * 86400;

function game(appid, name, extra = {}) {
  return {
    appid,
    name,
    hours: 10,
    hours2w: 0,
    rtime: 0,
    lastPlayed: null,
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
  1091500: game(1091500, 'Cyberpunk 2077', {
    hours: 108,
    hours2w: 1.8,
    rtime: twoDaysAgo,
    lastPlayed: new Date(twoDaysAgo * 1000).toISOString(),
    iconUrl: 'https://cdn.example/cyberpunk.jpg',
  }),
  606150: game(606150, 'Moonlighter', {
    hours: 11.9,
    hours2w: 0,
    rtime: tenDaysAgo,
    lastPlayed: new Date(tenDaysAgo * 1000).toISOString(),
  }),
  203770: game(203770, 'Crusader Kings II', {
    hours: 1054.4,
    hours2w: 0,
    rtime: twoYearsAgo,
    lastPlayed: new Date(twoYearsAgo * 1000).toISOString(),
  }),
};

function payload(profileKey) {
  return {
    sources: {
      connected: [profileKey],
      selected: [profileKey],
      profile: {
        key: profileKey,
        source: 'steam',
        userKey: profileKey.replace('steam-', ''),
        personaName: profileKey === KEY ? 'owner-one' : 'owner-two',
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
      totalHours: 1174.3,
      meanHours: 391.43,
      medianHours: 108,
      top10HoursShare: 0.9,
      recent2wHours: 1.8,
      libraryPartial: false,
      steamKeyConfigured: true,
    },
    hoursHistogram: [{ bucket: '5-20', count: 2 }],
    topGames: [{ appid: 203770, name: 'Crusader Kings II', hours: 1054.4, releaseYear: 2012 }],
    // Empty on purpose: the strip must fall back to gamesIndex (tolerant path).
    recentlyPlayed: [],
    backlog: { count: 0, share: 0, items: [] },
    genres: [{ name: 'RPG', count: 3, hours: 1174.3 }],
    modes: { single: { count: 3 } },
    access: { earlyAccess: { count: 0 } },
    tags: [],
    scores: [],
    franchises: [],
    decades: [],
    years: [],
    timeline: [],
    achievementDays: [],
    streaks: [],
    metadata: {},
    gamesIndex,
  };
}

const profileRows = [
  { source: 'steam', userKey: '76561198000000001', key: KEY, personaName: 'owner-one', gameCount: 3 },
  { source: 'steam', userKey: '76561198000000002', key: KEY2, personaName: 'owner-two', gameCount: 3 },
];

const statsUrls = [];
globalThis.fetch = async (url) => {
  const target = String(url);
  let body = {};
  if (target.startsWith('/api/games/profiles')) {
    body = { profiles: profileRows, steamKey: { configured: true, source: 'file' } };
  } else if (target.startsWith('/api/games/stats')) {
    statsUrls.push(target);
    const profileKey = new URL(target, 'http://localhost').searchParams.get('profile') || KEY;
    body = payload(profileKey);
  } else if (target.startsWith('/api/games/personnel')) {
    body = { role: 'developer', persons: [] };
  } else if (target.startsWith('/api/games/enrich')) {
    body = { running: false };
  } else if (target.startsWith('/api/games/game/')) {
    body = { appid: 1091500, name: 'Cyberpunk 2077' };
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

function lastStatsQuery() {
  const url = statsUrls[statsUrls.length - 1] || '';
  return new URL(url, 'http://localhost').searchParams;
}

function lastModalText() {
  const root = nodeFor('modal-root');
  if (!root || !root.children.length) return '';
  return textOf(root.children[root.children.length - 1]).replace(/\s+/g, ' ').trim();
}

const gamesPromise = import('../public/js/games.js');

test('U5: removed widgets are never looked up, the strip paints and the filter round-trips', async () => {
  const games = await gamesPromise;
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(60);

  // 1. The removed widgets no longer exist in the JS/DOM at all.
  for (const id of [
    'games-histogram-widget', 'games-histogram',
    'games-backlog-widget', 'games-backlog-list',
    'games-modes-widget', 'games-modes-list',
    'games-access-widget', 'games-access-body',
  ]) {
    assert.equal(byId.has(id), false, `games.js не должен искать #${id}`);
  }

  // 2. The top strip: index fallback, rtime desc, fresh hours first.
  const strip = nodeFor('games-recent-strip');
  assert.equal(nodeFor('games-recent-widget').hidden, false);
  // Cyberpunk (2-week hours) and Moonlighter (10 days ago) first; CK II
  // (2023) only fills the tail because the strip is not full.
  assert.equal(strip.children.length, 3);
  const first = textOf(strip.children[0]);
  assert.match(first, /Cyberpunk 2077/);
  assert.match(first, /1,8 ч за 2 недели/);
  const second = textOf(strip.children[1]);
  assert.match(second, /Moonlighter/);
  assert.match(second, /последний раз:/);
  assert.match(textOf(strip.children[2]), /Crusader Kings II/);
  assert.match(textOf(nodeFor('games-recent-note')), /3 игры/);

  // A card click opens the existing game-card modal.
  strip.children[0].children[0].click();
  await wait(10);
  assert.match(lastModalText(), /Cyberpunk 2077/);

  // 3. minHours: stored 3 → sent as ?minHours=3, the field prints 3.
  assert.equal(nodeFor('games-filter-hours').value, '3');
  assert.equal(lastStatsQuery().get('minHours'), '3');
  assert.equal(lastStatsQuery().get('profile'), KEY);

  // + → 4, persisted for THIS profile only.
  nodeFor('games-filter-hours-plus').click();
  await wait(40);
  assert.equal(nodeFor('games-filter-hours').value, '4');
  assert.equal(lastStatsQuery().get('minHours'), '4');
  assert.equal(JSON.parse(storage.get(`kinoboxd.games.filters.${KEY}.v1`)).minHours, 4);
  assert.equal(JSON.parse(storage.get(`kinoboxd.games.filters.${KEY2}.v1`)).minHours, 7,
    'фильтр другого профиля не тронут');

  // − × 6 clamps at −1 («показывать все игры»), never below.
  for (let index = 0; index < 6; index += 1) nodeFor('games-filter-hours-minus').click();
  await wait(40);
  assert.equal(nodeFor('games-filter-hours').value, '-1');
  assert.equal(lastStatsQuery().get('minHours'), '-1');
  assert.equal(JSON.parse(storage.get(`kinoboxd.games.filters.${KEY}.v1`)).minHours, -1);

  // 0 is the server default: the param is omitted, the request stays clean.
  const input = nodeFor('games-filter-hours');
  input.value = '0';
  input.dispatch('change');
  await wait(40);
  assert.equal(lastStatsQuery().get('minHours'), null);
  assert.equal(JSON.parse(storage.get(`kinoboxd.games.filters.${KEY}.v1`)).minHours, 0);

  // 4. Switching the owner restores THAT profile's filter (per-profile persist).
  const chips = nodeFor('games-profile-list').children;
  assert.equal(chips.length, 2);
  chips[1].click();
  await wait(60);
  assert.equal(nodeFor('games-filter-hours').value, '7');
  const query = lastStatsQuery();
  assert.equal(query.get('profile'), KEY2);
  assert.equal(query.get('minHours'), '7');
  assert.equal(query.get('includeFree'), '0');
  assert.equal(query.get('includeDlc'), '1');
});
