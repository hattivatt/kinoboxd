'use strict';

/**
 * `/api/games/stats` with a GOG secondary library (M6a): per-source hours are
 * separate (never summed), the union counts one work once, secondary-only games
 * are counted but stay out of the Steam journal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-gog-stats-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-gog-stats-state-'));

const gameCache = require('../server/games/game-cache');
const gogCache = require('../server/games/gog-cache');
const { buildGamesStatsFromCache } = require('../server/games/stats');

const ID = '76561198000000001';
const ID2 = '76561198000000002';
const PROFILE_KEY = `steam-${ID}`;
const GOG_KEY = '1234567890';

function steamLibrary(games) {
  const totalMinutes = games.reduce((sum, game) => sum + game.playtime_forever, 0);
  return {
    fetchedAt: new Date().toISOString(),
    partial: false,
    source: 'steam-webapi',
    game_count: games.length,
    games,
    totalMinutes,
    fingerprint: games.map((game) => game.appid).join(','),
  };
}

const STEAM_GAMES = [
  {
    appid: 292030,
    name: 'The Witcher 3: Wild Hunt',
    playtime_forever: 6000,
    playtime_2weeks: 0,
    rtime_last_played: 1793295251,
    img_icon_url: null,
  },
  {
    appid: 1091500,
    name: 'Cyberpunk 2077',
    playtime_forever: 3000,
    playtime_2weeks: 0,
    rtime_last_played: 0,
    img_icon_url: null,
  },
];

const GOG_PRODUCTS = [
  {
    gogGameId: '1207658924',
    title: 'The Witcher 3: Wild Hunt - Game of the Year Edition',
    slug: 'the_witcher_3_wild_hunt',
    image: null,
    category: 'game',
    isGame: true,
    isMovie: false,
    releaseDate: '2015-05-18T00:00:00+0000',
  },
  {
    gogGameId: '1423049311',
    title: 'Cyberpunk 2077: Ultimate Edition',
    slug: 'cyberpunk_2077_ultimate_edition',
    image: null,
    category: 'game',
    isGame: true,
    isMovie: false,
    releaseDate: '2023-09-26T00:00:00+0000',
  },
  {
    gogGameId: '1999999999',
    title: 'GOG Exclusive Indie',
    slug: 'gog_exclusive_indie',
    image: null,
    category: 'game',
    isGame: true,
    isMovie: false,
    releaseDate: '2020-01-01T00:00:00+0000',
  },
];

async function seedOwner(userKey) {
  await gameCache.saveProfile({
    userKey,
    personaName: 'tester',
    ownerLabel: 'Me',
    importedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
  });
  await gameCache.saveLibrary(userKey, steamLibrary(STEAM_GAMES));
}

test('GOG stats', async (t) => {
  await seedOwner(ID);
  await seedOwner(ID2);
  const nowIso = new Date().toISOString();
  gogCache.saveToken(GOG_KEY, {
    accessToken: 'secret-access',
    refreshToken: 'secret-refresh',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    username: 'gog_tester',
    ownerProfile: PROFILE_KEY,
    connectedAt: nowIso,
  });
  gogCache.saveProfile({ userKey: GOG_KEY, username: 'gog_tester', ownerProfile: PROFILE_KEY });
  gogCache.saveLibrary(GOG_KEY, {
    fetchedAt: nowIso,
    ownerProfile: PROFILE_KEY,
    products: GOG_PRODUCTS,
    fingerprint: GOG_PRODUCTS.map((product) => product.gogGameId).join(','),
    account: { username: 'gog_tester' },
  });
  gogCache.savePlaytime(GOG_KEY, {
    fetchedAt: nowIso,
    ownerProfile: PROFILE_KEY,
    minutes: { 1207658924: 1200, 1423049311: 600, 1999999999: 90 },
    fetchedGames: 3,
    budgetExceeded: false,
  });

  await t.test('totalHours is the display sum; hoursBySource.steam stays the journal', () => {
    const payload = buildGamesStatsFromCache(PROFILE_KEY);
    // M6c: the headline number is Steam + GOG + Epic of the same works …
    assert.equal(payload.summary.totalHours, 181.5);
    // … while the Steam journal number and the per-source breakdown stay.
    assert.equal(payload.summary.totalHoursSteam, 150);
    assert.deepEqual(payload.summary.hoursBySource, { steam: 150, gog: 31.5, epic: null, all: 181.5 });
    assert.deepEqual(payload.summary.ownedBySource, { steam: 2, gog: 3, epic: null });
    assert.equal(payload.summary.worksTotal, 3);
    assert.equal(payload.summary.secondaryOnlyWorks, 1);
    assert.equal(payload.gog.status, 'ok');
    assert.equal(payload.gog.gogProducts, 3);
    assert.equal(payload.gog.gogHours, 31.5);
  });

  await t.test('gamesIndex carries sources/storeIds/hoursBySource (hours)', () => {
    const payload = buildGamesStatsFromCache(PROFILE_KEY);
    const witcher = payload.gamesIndex['292030'];
    assert.deepEqual(witcher.sources, ['steam', 'gog']);
    assert.deepEqual(witcher.storeIds, { steam: 292030, gog: '1207658924', epic: null });
    // Integration contract: payload hours, not minutes (100 h + 20 h).
    assert.deepEqual(witcher.hoursBySource, { steam: 100, gog: 20, epic: null });
    assert.deepEqual(witcher.ownedOn, ['steam', 'gog']);
    const cyberpunk = payload.gamesIndex['1091500'];
    assert.deepEqual(cyberpunk.sources, ['steam', 'gog']);
    assert.equal(cyberpunk.storeIds.gog, '1423049311');
  });

  await t.test('a secondary-only work is counted and ranked, not hidden', () => {
    const payload = buildGamesStatsFromCache(PROFILE_KEY);
    assert.equal(payload.secondaryWorks.length, 1);
    assert.equal(payload.secondaryWorks[0].workKey, 'gog:1999999999');
    assert.equal(payload.secondaryWorks[0].hoursBySource.gog, 1.5);
    assert.equal(payload.secondaryWorks[0].hoursBySource.steam, null);
    // M6c: it is a real owned game — one more row in the library, its hours in
    // the totals, its name in the top list.
    assert.equal(payload.summary.gameCount, 3);
    assert.equal(payload.summary.secondaryOnlyWorks, 1);
    const row = payload.topGames.find((entry) => entry.name === 'GOG Exclusive Indie');
    assert.ok(row);
    assert.equal(row.appid, null);
    assert.deepEqual(row.sources, ['gog']);
    assert.equal(row.hours, 1.5);
  });

  await t.test('sources block exposes GOG state without a token', () => {
    const payload = buildGamesStatsFromCache(PROFILE_KEY);
    assert.equal(payload.sources.gog.connected, true);
    assert.equal(payload.sources.gog.userKey, GOG_KEY);
    assert.equal(payload.sources.gog.username, 'gog_tester');
    assert.equal(payload.sources.gog.status, 'ok');
    const serialized = JSON.stringify(payload.sources);
    assert.equal(serialized.includes('secret-access'), false);
    assert.equal(serialized.includes('secret-refresh'), false);
    assert.equal(payload.sources.steam.status, 'ok');
  });

  await t.test('a disconnected account keeps its dated snapshot (snapshot_only)', () => {
    gogCache.deleteToken(GOG_KEY);
    const payload = buildGamesStatsFromCache(PROFILE_KEY);
    assert.equal(payload.sources.gog.connected, false);
    assert.equal(payload.sources.gog.status, 'snapshot_only');
    assert.equal(payload.summary.hoursBySource.gog, 31.5);
    assert.equal(payload.summary.ownedBySource.gog, 3);
    assert.equal(payload.gamesIndex['292030'].storeIds.gog, '1207658924');
  });

  await t.test('a Steam-only profile has no cross-store fields at all', () => {
    const payload = buildGamesStatsFromCache(`steam-${ID2}`);
    assert.deepEqual(payload.summary.hoursBySource, { steam: 150, gog: null, epic: null });
    assert.deepEqual(payload.summary.ownedBySource, { steam: 2, gog: null, epic: null });
    assert.equal(payload.summary.secondaryOnlyWorks, 0);
    assert.equal(payload.summary.worksTotal, payload.summary.gameCount);
    assert.equal(payload.sources.gog.status, 'not_connected');
    assert.equal(payload.secondaryWorks.length, 0);
    assert.equal(Object.prototype.hasOwnProperty.call(payload.gamesIndex['292030'], 'sources'), false);
  });
});
