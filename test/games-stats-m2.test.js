'use strict';

/**
 * M2 stats: release years/decades, playtime-weighted genres, modes, EA/F2P,
 * platforms, gamesIndex details, and the *real* includeFree/includeDlc filters.
 * Also pins the M1 fallback: no details → old payload + honest pending markers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-stats-m2-'));
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-stats-m2-state-'));

const gameCache = require('../server/games/game-cache');
const { buildGamesStats, buildGamesStatsFromCache } = require('../server/games/stats');

const ID = '76561198000000201';
const PROFILE_KEY = `steam-${ID}`;

function game(appid, minutes) {
  return {
    appid,
    name: `Game ${appid}`,
    playtime_forever: minutes,
    playtime_2weeks: null,
    rtime_last_played: 0,
    img_icon_url: null,
    playtime_windows_forever: 0,
    playtime_mac_forever: 0,
    playtime_linux_forever: 0,
    playtime_deck_forever: 0,
  };
}

function doc(appid, extra) {
  return {
    appid,
    success: true,
    type: 'game',
    name: `Game ${appid}`,
    is_free: false,
    developers: ['CD'],
    publishers: ['CD'],
    genres: [{ id: '3', description: 'RPG' }],
    categories: [{ id: '2', description: 'Single-player' }],
    release_date: {
      date: '1 Jan, 2015',
      coming_soon: false,
      year: 2015,
      month: 1,
      day: 1,
      precision: 'day',
    },
    releaseYear: 2015,
    releasePrecision: 'day',
    dlc: [],
    dlcCount: 0,
    metacritic: null,
    platforms: { windows: true, mac: false, linux: false },
    screenshots: [],
    earlyAccess: false,
    metadataSource: 'steam-store',
    ...extra,
  };
}

const LIBRARY = {
  fetchedAt: new Date().toISOString(),
  partial: false,
  game_count: 6,
  games: [game(1001, 6000), game(1002, 3000), game(1003, 600), game(1004, 0), game(1005, 300), game(1006, 60)],
  totalMinutes: 9960,
  fingerprint: 'm2-fixture',
};

const DETAILS = {
  1001: doc(1001, {
    genres: [
      { id: '3', description: 'RPG' },
      { id: '1', description: 'Action' },
    ],
    dlc: [2001, 2002],
    dlcCount: 2,
    metacritic: { score: 93 },
  }),
  1002: doc(1002, {
    releaseYear: 2020,
    release_date: { date: '10 Dec, 2020', coming_soon: false, year: 2020, month: 12, day: 10, precision: 'day' },
    genres: [{ id: '1', description: 'Action' }],
    categories: [
      { id: '1', description: 'Multi-player' },
      { id: '9', description: 'Co-op' },
      { id: '38', description: 'Online Co-op' },
      { id: '23', description: 'Steam Cloud' },
    ],
    is_free: true,
    earlyAccess: true,
    platforms: { windows: true, mac: false, linux: true },
  }),
  1003: doc(1003, { type: 'dlc', genres: [{ id: '3', description: 'RPG' }] }),
  1004: doc(1004, {
    releaseYear: null,
    release_date: { date: 'Coming soon', coming_soon: true, year: null, month: null, day: null, precision: 'unknown' },
    genres: [{ id: '25', description: 'Indie' }],
    platforms: { windows: false, mac: true, linux: false },
  }),
  // 1005 has no details at all.
  1006: doc(1006, { type: 'demo', releaseYear: 2024, is_free: true }),
};

function stats(options = {}) {
  return buildGamesStats({
    steamId64: ID,
    profile: { userKey: ID, personaName: 'tester', privacy: 'public' },
    library: LIBRARY,
    details: DETAILS,
    achievements: [],
    globals: new Map(),
    ...options,
  });
}

test('base filters (includeFree=1, includeDlc=0): DLC/demo excluded, unknown kept', () => {
  const payload = stats();
  const summary = payload.summary;
  assert.equal(summary.ownedCount, 6);
  assert.equal(summary.gameCount, 4);
  assert.equal(summary.gameCountEstimated, true); // one game has no details
  assert.equal(summary.totalHours, 155);
  assert.equal(summary.playedCount, 3);
  assert.equal(summary.unplayedCount, 1);
  assert.equal(summary.meanHours, 38.75);
  assert.equal(summary.medianHours, 27.5);

  assert.equal(payload.meta.excluded.dlc, 1);
  assert.equal(payload.meta.excluded.otherType, 1);
  assert.equal(payload.meta.excluded.free, 0);
  assert.equal(payload.meta.excluded.unknownType, 1);

  assert.equal(payload.meta.filters.includeFree.requested, true);
  assert.equal(payload.meta.filters.includeFree.applied, true);
  assert.equal(payload.meta.filters.includeFree.excluded, 0);
  assert.equal(payload.meta.filters.includeDlc.requested, false);
  assert.equal(payload.meta.filters.includeDlc.applied, true);
  assert.equal(payload.meta.filters.includeDlc.excluded, 1);
  assert.equal(payload.meta.filters.includeDlc.excludedTypes, 1);

  assert.deepEqual(Object.keys(payload.gamesIndex).sort(), ['1001', '1002', '1004', '1005']);
  assert.equal(payload.unmatchedCount, 1);
  assert.deepEqual(payload.meta.pending, ['tags', 'reviews', 'franchises', 'studios', 'personnelTop']);
});

test('years/decades: releaseYear buckets with an honest unknown bucket last', () => {
  const payload = stats();
  assert.deepEqual(payload.years, [
    { year: 2015, count: 1, hours: 100 },
    { year: 2020, count: 1, hours: 50 },
    { year: null, key: 'unknown', label: 'год неизвестен', unknown: true, count: 2, hours: 5 },
  ]);
  assert.deepEqual(payload.decades, [
    { decade: 2010, count: 1, hours: 100 },
    { decade: 2020, count: 1, hours: 50 },
    { decade: null, key: 'unknown', label: 'год неизвестен', unknown: true, count: 2, hours: 5 },
  ]);
  assert.equal(payload.summary.releaseYearFrom, 2015);
  assert.equal(payload.summary.releaseYearTo, 2020);
});

test('genres: playtime-weighted wall (hours/weight/share) and counts', () => {
  const payload = stats();
  assert.deepEqual(
    payload.genres.map((entry) => entry.name),
    ['Action', 'RPG', 'Indie']
  );
  assert.deepEqual(payload.genres[0], {
    name: 'Action',
    count: 2,
    hours: 150,
    weight: 150,
    share: 0.968,
  });
  assert.equal(payload.genres[1].hours, 100);
  assert.equal(payload.genres[2].hours, 0);
});

test('modes / early access / free-to-play / platforms', () => {
  const payload = stats();
  assert.deepEqual(payload.summary.modes, {
    single: 2,
    multi: 1,
    coop: 1,
    onlineCoop: 1,
    localCoop: 0,
    onlinePvp: 0,
    mmo: 0,
    cloud: 1,
    controller: 0,
  });
  assert.deepEqual(payload.summary.earlyAccess, { count: 1, hours: 50, share: 0.323 });
  assert.deepEqual(payload.summary.freeToPlay, { count: 1, hours: 50, share: 0.323 });
  assert.deepEqual(payload.summary.platforms, {
    windows: 2,
    mac: 1,
    linux: 1,
    deckHours: 0,
    deckHoursShare: 0,
  });
  assert.deepEqual(payload.summary.metadata, {
    detailsResolved: 5,
    detailsTotal: 6,
    detailsPercent: 83.3,
    detailsUnavailable: 0,
    detailsMissing: 1,
    lastEnrichedAt: null,
    // Additive (integration round): the UI polls while a job is running.
    running: false,
  });
});

test('gamesIndex carries the full details entry; top/backlog are enriched', () => {
  const payload = stats();
  assert.deepEqual(payload.gamesIndex[1001], {
    appid: 1001,
    name: 'Game 1001',
    hours: 100,
    hours2w: 0,
    rtime: 0,
    lastPlayed: null,
    iconUrl: null,
    type: 'game',
    year: 2015,
    releaseYear: 2015,
    genres: ['RPG', 'Action'],
    developers: ['CD'],
    publishers: ['CD'],
    categories: ['Single-player'],
    dlcCount: 2,
    metacritic: 93,
    isFree: false,
    earlyAccess: false,
    metadataSources: ['steam-store'],
    // M4 (additive): no SteamSpy/reviews documents in this fixture.
    tags: [],
    reviewScore: null,
    reviewDesc: null,
    completion: null,
    achievements: null,
  });
  // No details → null/[] placeholders, never invented values.
  const unknown = payload.gamesIndex[1005];
  assert.equal(unknown.type, null);
  assert.equal(unknown.releaseYear, null);
  assert.deepEqual(unknown.genres, []);
  assert.deepEqual(unknown.metadataSources, []);

  assert.equal(payload.topGames[0].appid, 1001);
  assert.equal(payload.topGames[0].releaseYear, 2015);
  assert.deepEqual(payload.topGames[0].genres, ['RPG', 'Action']);
  assert.equal(payload.topGames[0].type, 'game');
  assert.equal(payload.backlog.items.length, 1);
  assert.equal(payload.backlog.items[0].appid, 1004);
  assert.equal(payload.backlog.items[0].releaseYear, null);
  assert.deepEqual(payload.backlog.items[0].genres, ['Indie']);
});

test('includeDlc=1 includes DLC in every counter; demo/software stay out', () => {
  const payload = stats({ includeDlc: true });
  assert.equal(payload.summary.gameCount, 5);
  assert.equal(payload.summary.totalHours, 165);
  assert.equal(payload.meta.excluded.dlc, 0);
  assert.equal(payload.meta.excluded.otherType, 1);
  assert.ok(payload.gamesIndex[1003]);
  assert.equal(payload.gamesIndex[1003].type, 'dlc');
  assert.equal(payload.genres.find((entry) => entry.name === 'RPG').hours, 110);
  assert.deepEqual(
    payload.decades.map((entry) => [entry.decade, entry.count, entry.hours]),
    [
      [2010, 2, 110],
      [2020, 1, 50],
      [null, 2, 5],
    ]
  );
  assert.equal(payload.summary.modes.single, 3);
});

test('includeFree=0 really removes free-to-play games from every counter', () => {
  const payload = stats({ includeFree: false });
  assert.equal(payload.summary.gameCount, 3);
  assert.equal(payload.summary.totalHours, 105);
  assert.equal(payload.meta.excluded.free, 1);
  assert.equal(payload.meta.filters.includeFree.requested, false);
  assert.equal(payload.meta.filters.includeFree.excluded, 1);
  assert.equal(payload.gamesIndex[1002], undefined);
  assert.deepEqual(payload.summary.freeToPlay, { count: 0, hours: 0, share: 0 });
  assert.equal(payload.summary.modes.multi, 0);
  assert.deepEqual(
    payload.genres.map((entry) => [entry.name, entry.hours]),
    [
      ['Action', 100],
      ['RPG', 100],
      ['Indie', 0],
    ]
  );
  assert.equal(payload.summary.platforms.windows, 1);
  assert.equal(payload.summary.platforms.linux, 0);
});

test('both filters at once: only paid games and DLC remain', () => {
  const payload = stats({ includeFree: false, includeDlc: true });
  assert.equal(payload.summary.gameCount, 4);
  assert.equal(payload.summary.totalHours, 115);
  assert.deepEqual(Object.keys(payload.gamesIndex).sort(), ['1001', '1003', '1004', '1005']);
});

test('M1 fallback: no details → old payload and explicit pending markers', () => {
  const payload = stats({ details: {} });
  assert.equal(payload.summary.gameCount, 6);
  assert.equal(payload.summary.gameCountEstimated, true);
  assert.equal(payload.summary.totalHours, 166);
  assert.deepEqual(payload.genres, []);
  assert.deepEqual(payload.years, []);
  assert.deepEqual(payload.decades, []);
  assert.equal(payload.summary.modes, null);
  assert.equal(payload.summary.earlyAccess, null);
  assert.equal(payload.summary.freeToPlay, null);
  assert.equal(payload.summary.platforms, null);
  assert.equal(payload.summary.metadata, null);
  assert.equal(payload.meta.filters.includeFree.applied, false);
  assert.equal(payload.meta.filters.includeFree.reason, 'details_not_imported');
  assert.equal(payload.meta.filters.includeDlc.applied, false);
  assert.ok(payload.meta.pending.includes('genres'));
  assert.ok(payload.meta.pending.includes('modes'));
  assert.equal(payload.unmatchedCount, 6);
  assert.equal(payload.gamesIndex[1001].type, null);
});

test('buildGamesStatsFromCache reads details/<appid>.json from the cache', async () => {
  const now = new Date().toISOString();
  await gameCache.saveProfile({
    userKey: ID,
    personaName: 'tester',
    privacy: 'public',
    importedAt: now,
    fetchedAt: now,
  });
  await gameCache.saveLibrary(ID, LIBRARY);
  await gameCache.saveDetails(1001, { ...DETAILS[1001], fetchedAt: now });
  await gameCache.saveDetails(1002, { ...DETAILS[1002], fetchedAt: now });

  const payload = buildGamesStatsFromCache(PROFILE_KEY);
  assert.ok(payload);
  assert.equal(payload.summary.metadata.detailsResolved, 2);
  assert.equal(payload.summary.metadata.lastEnrichedAt, now);
  assert.equal(payload.meta.filters.includeDlc.applied, true);
  assert.ok(payload.years.some((entry) => entry.year === 2015));
  assert.ok(payload.genres.length > 0);
  // includeFree=0 is honoured through the cache path too.
  const paid = buildGamesStatsFromCache(PROFILE_KEY, { includeFree: false });
  assert.equal(paid.meta.excluded.free, 1);
});
