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
    // M5-B: the server reports the hours filter it applied (requested vs
    // excluded) — the UI must read it instead of guessing.
    meta: {
      filters: {
        includeFree: { requested: true, applied: true, excluded: 0, reason: null },
        includeDlc: { requested: false, applied: true, excluded: 0, reason: null },
        minHours: { requested: 3, applied: true, excluded: 2, excludedAppids: 2 },
      },
    },
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
  // meta.filters.minHours is read, not guessed: the note prints the applied
  // threshold and how many works it dropped.
  assert.match(textOf(nodeFor('games-filter-note')), /мин\. часов: ≥3 ч — исключено 2 игры/);

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

/* =========================================================
   U5 × M5-B: the contract the two parallel rounds share
   ========================================================= */

test('U5×M5-B: filtersView reads meta.filters.minHours (requested / excluded)', async () => {
  const { filtersView } = await import('../public/js/games-view.js');

  const all = filtersView({
    includeFree: { requested: true, applied: true },
    includeDlc: { requested: false, applied: true },
    minHours: { requested: -1, applied: true, excluded: 0, excludedAppids: 0 },
  });
  assert.equal(all.minHours.status, 'applied');
  assert.equal(all.minHours.text, 'мин. часов: все игры, включая 0 ч — ничего не исключено');
  assert.equal(all.items.length, 3);

  const played = filtersView({ minHours: { requested: 0, applied: true, excluded: 110, excludedAppids: 110 } });
  assert.equal(played.minHours.text, 'мин. часов: только с часами — исключено 110 игр');

  const three = filtersView({ minHours: { requested: 3, applied: true, excluded: 2 } });
  assert.equal(three.minHours.text, 'мин. часов: ≥3 ч — исключено 2 игры');
  assert.equal(three.items.length, 3);

  // An older server without the block: no invented line, the checkboxes keep
  // their own honest requested-vs-applied state.
  const legacy = filtersView({ includeFree: { requested: false, applied: false, reason: 'details_not_imported' } });
  assert.equal(legacy.minHours, null);
  assert.equal(legacy.items.length, 2);
  assert.equal(legacy.honest, true);
});

test('U5×M5-B: the strip shows one card per canonical work, not per edition', async () => {
  const { recentStripView } = await import('../public/js/games-view.js');
  const now = Date.UTC(2026, 10, 1);
  // Darksiders (2013) + Warmastered Edition (2017) are one canonical work in
  // M5-B stats; the strip must not paint the same game twice.
  const index = {
    937: {
      appid: 937, name: 'Darksiders', hours: 15.6, hours2w: 0, rtime: 1360224000,
      canonicalWorkKey: 'steam:50620', primaryAppid: 937, isPrimary: true,
      canonicalHours: 21, editionCount: 2,
    },
    462780: {
      appid: 462780, name: 'Darksiders Warmastered Edition', hours: 5.4, hours2w: 1.2, rtime: 1512248250,
      canonicalWorkKey: 'steam:50620', primaryAppid: 937, isPrimary: false,
      canonicalHours: 21, editionCount: 2,
    },
  };
  const view = recentStripView([], index, { now });
  assert.equal(view.items.length, 1, 'одна работа — одна карточка');
  // The newest launch wins the card face (its appid opens the right card)…
  assert.equal(view.items[0].appid, 462780);
  assert.equal(view.items[0].name, 'Darksiders Warmastered Edition');
  // …2-week hours add up across editions, the total is the canonical one.
  assert.equal(view.items[0].hours2w, 1.2);
  assert.equal(view.items[0].caption, '1,2 ч за 2 недели');
  assert.equal(view.items[0].hoursTotalText, '21,0 ч');

  // The payload's canonical recentlyPlayed row and the per-edition index rows
  // land in the same card: hours never double-count one appid.
  const merged = recentStripView(
    [{
      appid: 937, name: 'Darksiders', hours2w: 0, hoursTotal: 21, lastPlayed: '2013-02-07T00:00:00.000Z',
      canonicalWorkKey: 'steam:50620', editionCount: 2,
    }],
    index,
    { now },
  );
  assert.equal(merged.items.length, 1);
  // U6: the server's canonical row owns the card face (primary edition 937) —
  // it already carries the aggregated hours and the primary appid, so a newer
  // launch of a secondary edition must not repaint the card with an edition
  // name. The index still fills the icon/date the payload may have trimmed.
  assert.equal(merged.items[0].appid, 937);
  assert.equal(merged.items[0].name, 'Darksiders');
  assert.equal(merged.items[0].primaryAppid, 937);
  assert.equal(merged.items[0].hours2w, 1.2);
  assert.equal(merged.items[0].hoursTotalText, '21,0 ч');
});

test('U5×M5-B: index drilldowns count canonical works (editions merged)', async () => {
  const {
    gameRowsFromIndex, allGames, yearCountSeries, gamesInYear, gamesByGenre,
  } = await import('../public/js/games-view.js');

  // BioShock (2007) + BioShock Remastered (2016) are one work: the primary
  // edition is the face, the year is the earliest one (stats.js `workYear`
  // takes the min), genres are the union (`workGenres`), hours are canonical.
  const index = {
    7670: {
      appid: 7670, name: 'BioShock', hours: 0.5, hours2w: 0, releaseYear: 2007,
      genres: ['Action'], tags: ['Atmospheric'], type: 'game',
      canonicalWorkKey: 'steam:7670', primaryAppid: 409710, isPrimary: false,
      editionCount: 2, canonicalHours: 2.6,
    },
    409710: {
      appid: 409710, name: 'BioShock Remastered', hours: 2.1, hours2w: 0.3, releaseYear: 2016,
      genres: ['Action', 'RPG'], tags: ['Story Rich'], type: 'game',
      canonicalWorkKey: 'steam:7670', primaryAppid: 409710, isPrimary: true,
      editionCount: 2, canonicalHours: 2.6,
    },
    550: {
      appid: 550, name: 'Left 4 Dead 2', hours: 5, hours2w: 0, releaseYear: 2009,
      genres: ['Action'], tags: [], type: 'game',
      canonicalWorkKey: 'wd:Q472909', primaryAppid: 550, isPrimary: true,
      editionCount: 1, canonicalHours: 5,
    },
  };

  const rows = allGames(index);
  assert.equal(rows.length, 2, 'две работы — две строки, не три издания');
  const work = rows.find((row) => row.name === 'BioShock Remastered');
  assert.equal(work.appid, 409710, 'лицо работы — primary-издание (карточка откроется по нему)');
  assert.equal(work.hours, 2.6, 'часы работы канонические, а не одного издания');
  assert.equal(work.hours2w, 0.3);
  assert.equal(work.releaseYear, 2007, 'год работы — самый ранний (min по изданиям)');
  assert.deepEqual(work.genres.sort(), ['Action', 'RPG'], 'жанры — объединение изданий');
  assert.deepEqual(work.tags.sort(), ['Atmospheric', 'Story Rich']);
  assert.equal(work.editionCount, 2);
  assert.equal(gameRowsFromIndex(index).length, 2);

  // The charts' client recount agrees with what the server would send.
  const series = yearCountSeries(index);
  assert.deepEqual(series.series.map((item) => [item.year, item.count]), [[2007, 1], [2009, 1]]);
  assert.equal(series.total, 2);
  assert.equal(series.unknown, 0);
  assert.equal(gamesInYear(index, 2007).length, 1);
  assert.equal(gamesInYear(index, 2016).length, 0, 'работа не считается дважды по году издания');
  assert.equal(gamesByGenre(index, 'RPG').length, 1, 'жанр второго издания виден работе');
});
