'use strict';

/**
 * `GetRecentlyPlayedGames` (03.11.2026) and the `recentlyPlayed` fallback.
 *
 * The diagnosed owner (steam-76561198203871831) has a complete 226-game
 * library whose every row says `rtime_last_played: 0`, while Steam still knows
 * six games of the last two weeks. The import now merges that window into the
 * snapshot (merge-only, non-fatal), and `stats/top.js` lets a work with 2-week
 * hours but no launch date into the strip with `lastPlayed: null` — no date is
 * ever invented.
 *
 * Everything is offline: the Steam client is the fixture-backed fake, the
 * cache roots point at /tmp.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-recent-')
);
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-recent-state-')
);
process.env.KINOBOXD_GAMES_WD = 'off';

const steam = require('../server/games/steam');
const gameCache = require('../server/games/game-cache');
const importJobs = require('../server/games/import');
const { buildGamesStatsFromCache } = require('../server/games/stats');
const { createFakeClient, readFixture } = require('./fixtures/games/fake-client');

const ID = '76561198000000001';
const PROFILE_KEY = `steam-${ID}`;

function recentWindow(name) {
  return steam.parseRecentlyPlayedResponse(JSON.parse(readFixture(name)));
}

async function seedLibrary(steamId64, games) {
  const totalMinutes = games.reduce(
    (sum, game) => sum + (Number(game.playtime_forever) || 0),
    0
  );
  await gameCache.saveProfile({
    userKey: steamId64,
    personaName: 'tester',
    avatarUrl: 'https://example.test/avatar.jpg',
    privacy: 'public',
    importedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
  });
  await gameCache.saveLibrary(steamId64, {
    fetchedAt: new Date().toISOString(),
    partial: false,
    source: 'steam-webapi',
    game_count: games.length,
    games,
    totalMinutes,
    fingerprint: steam.libraryFingerprint(games, games.length),
  });
}

test('a full import merges GetRecentlyPlayedGames into the library snapshot', async () => {
  const client = createFakeClient({ recent: recentWindow('recently-played-populated.json') });
  const job = importJobs.startImport(ID, { client, force: true });
  await importJobs.whenIdle();
  const status = importJobs.getStatus(job.jobId);
  assert.equal(status.status, 'done');
  assert.equal(status.code, null);
  assert.deepEqual(status.warnings, []);
  // The foreign appid of the window is ignored (merge-only): 2 of 3 rows hit.
  assert.equal(status.recentPlayedCount, 2);
  assert.ok(status.recentPlayedFetchedAt);

  const library = gameCache.getLibrary(ID);
  assert.ok(library.recentPlayedFetchedAt);
  const cyberpunk = library.games.find((game) => game.appid === 1091500);
  // RGP `rtime_last_played: 0` = "not exposed", so the known launch survives.
  assert.equal(cyberpunk.rtime_last_played, 1793295251);
  assert.equal(cyberpunk.playtime_2weeks, 108);
  assert.equal(cyberpunk.playtime_forever, 120, 'the fresher total wins');
  const portal = library.games.find((game) => game.appid === 620);
  assert.equal(portal.rtime_last_played, 1795000000);
  assert.equal(portal.playtime_2weeks, 60);
  assert.equal(portal.playtime_forever, 1204, 'a staler total never shrinks a row');
  assert.equal(library.games.some((game) => game.appid === 999999), false);
  // Totals/fingerprint describe the rows that were actually stored.
  assert.equal(library.totalMinutes, 36973 + 12);
  assert.equal(status.totalMinutes, 36973 + 12);
  assert.equal(library.fingerprint, steam.libraryFingerprint(library.games, 10));
});

test('an RGP failure is a warning: the import stays done with the plain library', async () => {
  const client = createFakeClient({
    fail: {
      recent: new steam.SteamError('Steam Web API ответил 500', 'steam_http_error'),
    },
  });
  const job = importJobs.startImport(ID, { client, force: true });
  await importJobs.whenIdle();
  const status = importJobs.getStatus(job.jobId);
  assert.equal(status.status, 'done');
  assert.equal(status.code, null);
  assert.deepEqual(status.warnings, ['recent_played_steam_http_error']);
  assert.equal(status.recentPlayedFetchedAt, null);
  assert.equal(status.recentPlayedCount, null);

  const library = gameCache.getLibrary(ID);
  assert.equal(library.recentPlayedFetchedAt, null);
  assert.equal(library.totalMinutes, 36973);
  assert.equal(library.games.find((game) => game.appid === 1091500).playtime_forever, 108);
});

test('a partial (no key) library never asks for the recently-played window', async () => {
  const client = createFakeClient({ key: null });
  const job = importJobs.startImport(ID, { client, force: true });
  await importJobs.whenIdle();
  const status = importJobs.getStatus(job.jobId);
  assert.equal(status.libraryPartial, true);
  assert.deepEqual(client.calls, ['profile']);
  assert.equal(status.recentPlayedFetchedAt, null);
  assert.equal(status.recentPlayedCount, null);
});

test('mergeRecentlyPlayed: merge-only, 0 rtime is unknown, totals never regress', () => {
  const games = [
    { appid: 1, playtime_forever: 10, playtime_2weeks: null, rtime_last_played: 1700 },
  ];
  const merged = importJobs.mergeRecentlyPlayed(games, {
    games: [
      { appid: 1, playtime_forever: 5, playtime_2weeks: 30, rtime_last_played: 0 },
      { appid: 2, playtime_forever: 1, playtime_2weeks: 1, rtime_last_played: 1 },
    ],
  });
  assert.equal(merged, 1, 'only the owned appid counts');
  assert.equal(games.length, 1, 'no row is invented');
  assert.equal(games[0].playtime_forever, 10);
  assert.equal(games[0].playtime_2weeks, 30);
  assert.equal(games[0].rtime_last_played, 1700);
  assert.equal(importJobs.mergeRecentlyPlayed(games, { games: [] }), 0);
  assert.equal(importJobs.mergeRecentlyPlayed(games, null), 0);
});

test('recentlyPlayed: works without a launch date join on 2-week hours, sorted', async () => {
  // The diagnosed profile shape: every rtime=0, activity only in the window.
  const owned = steam.parseOwnedGamesResponse(JSON.parse(readFixture('owned-games.json')));
  const active = { 1091500: 1493, 620: 71, 70: 18 };
  const games = owned.games.map((game) => ({
    ...game,
    rtime_last_played: 0,
    playtime_2weeks: active[game.appid] || null,
  }));
  const id64 = '76561198000000011';
  await seedLibrary(id64, games);

  const stats = buildGamesStatsFromCache(`steam-${id64}`);
  assert.deepEqual(
    stats.recentlyPlayed.map((row) => row.appid),
    [1091500, 620, 70],
    'sorted by two-week minutes desc when no launch date exists'
  );
  assert.equal(stats.recentlyPlayed[0].hours2w, 24.9);
  assert.equal(stats.recentlyPlayed[0].hoursTotal, 1.8);
  for (const row of stats.recentlyPlayed) {
    assert.equal(row.lastPlayed, null, 'no invented date');
  }
  assert.equal(stats.summary.lastPlayedAt, null);
});

test('recentlyPlayed: rtime desc first, then two-week minutes; lastPlayed stays null for rtime=0', async () => {
  const owned = steam.parseOwnedGamesResponse(JSON.parse(readFixture('owned-games.json')));
  const patch = {
    1091500: { rtime_last_played: 0, playtime_2weeks: 1493 },
    620: { rtime_last_played: 0, playtime_2weeks: 71 },
    220: { rtime_last_played: 1715018956, playtime_2weeks: 600 },
    570: { rtime_last_played: 1793295251, playtime_2weeks: null },
  };
  const games = owned.games.map((game) => ({
    ...game,
    rtime_last_played: 0,
    playtime_2weeks: null,
    ...(patch[game.appid] || {}),
  }));
  const id64 = '76561198000000012';
  await seedLibrary(id64, games);

  const stats = buildGamesStatsFromCache(`steam-${id64}`);
  assert.deepEqual(
    stats.recentlyPlayed.map((row) => row.appid),
    [570, 220, 1091500, 620],
    'launch dates come first (newest first), the 2-week-only rows after them'
  );
  assert.equal(stats.recentlyPlayed[0].lastPlayed, '2026-10-29T17:34:11.000Z');
  assert.equal(stats.recentlyPlayed[1].lastPlayed, '2024-05-06T18:09:16.000Z');
  assert.equal(stats.recentlyPlayed[2].lastPlayed, null);
  assert.equal(stats.recentlyPlayed[2].hours2w, 24.9);
  assert.equal(stats.recentlyPlayed[3].lastPlayed, null);
  // The archived 2-week strip is untouched by the fallback.
  assert.deepEqual(
    stats.recently2w.map((row) => row.appid),
    [1091500, 220, 620]
  );
});
