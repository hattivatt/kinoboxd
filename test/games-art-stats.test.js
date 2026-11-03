'use strict';

/**
 * `/stats` payload after the vertical-art resolve: `verticalCapsule`,
 * `verticalCapsuleKnown` (false = Steam really has no vertical capsule) and
 * `iconFallbackUrl` (small capsule for a missing 32×32 icon).
 *
 * Additive contract: without a resolve document the rows keep the exact
 * pre-resolve shape and the client walks the legacy CDN chain.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-art-stats-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-art-stats-state-')
);

const gameCache = require('../server/games/game-cache');
const art = require('../server/games/steam-art');
const { buildGamesStatsFromCache } = require('../server/games/stats');

const ID = '76561198000000888';
const PROFILE_KEY = `steam-${ID}`;
const APPID = 3669870;
const HEADER = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${APPID}/1e0c76e4253d347bb1304c3f213570251d924edf/header.jpg`;
const LIB_HASH = '7d4b4f430dc4d07e6562eb445456f9615cb52f77';
const CAPSULE_HASH = '867a73afa5f21c28aaa14e9b0a4d895c540d4a0c';

function row(appid, name, minutes = 60, rtime = 0) {
  return { appid, name, playtime_forever: minutes, playtime_2weeks: 0, rtime_last_played: rtime, img_icon_url: '' };
}

function detailDoc(appid, extra = {}) {
  return {
    appid,
    success: true,
    type: 'game',
    name: `Game ${appid}`,
    is_free: false,
    developers: ['Remedy'],
    publishers: ['505 Games'],
    genres: [{ id: '1', description: 'Action' }],
    categories: [],
    release_date: { date: 'Sep 24, 2026', coming_soon: false, year: 2026, precision: 'year' },
    releaseYear: 2026,
    dlc: [],
    dlcCount: 0,
    metacritic: null,
    platforms: { windows: true, mac: false, linux: false },
    headerImage: HEADER,
    screenshots: [],
    earlyAccess: false,
    metadataSource: 'steam-store',
    ...extra,
  };
}

async function seed(games, details) {
  const now = new Date().toISOString();
  await gameCache.saveProfile({
    userKey: ID,
    personaName: 'art-stats',
    privacy: 'public',
    importedAt: now,
    fetchedAt: now,
  });
  await gameCache.saveLibrary(ID, {
    fetchedAt: now,
    partial: false,
    source: 'steam-webapi',
    game_count: games.length,
    games,
    totalMinutes: games.reduce((sum, game) => sum + game.playtime_forever, 0),
  });
  for (const [appid, doc] of Object.entries(details)) {
    await gameCache.saveDetails(Number(appid), doc);
  }
}

function resolved(extra = {}) {
  return {
    schemaVersion: 1,
    appid: APPID,
    kind: 'library-hashed',
    h: LIB_HASH,
    file: 'library_capsule.jpg',
    proxyType: 'library_capsule',
    matchedBy: 'store-browse',
    source: 'steam-store',
    smallIconFallback: `/api/games/steam-art/capsule/${APPID}?h=${CAPSULE_HASH}`,
    resolvedAt: new Date().toISOString(),
    ...extra,
  };
}

test('gamesIndex/recentlyPlayed: resolved vertical capsule + icon fallback', async () => {
  await seed([row(APPID, 'CONTROL Resonant', 120, 1793000000)], {
    [APPID]: detailDoc(APPID),
  });
  await art.saveResolvedArt(resolved());
  const stats = buildGamesStatsFromCache(PROFILE_KEY);
  const entry = stats.gamesIndex[APPID];
  assert.equal(
    entry.verticalCapsule,
    `/api/games/steam-art/library_capsule/${APPID}?h=${LIB_HASH}`
  );
  assert.equal(entry.verticalCapsuleKnown, true);
  assert.equal(
    entry.iconFallbackUrl,
    `/api/games/steam-art/capsule/${APPID}?h=${CAPSULE_HASH}`
  );
  assert.equal(stats.recentlyPlayed[0].verticalCapsule, entry.verticalCapsule);
  assert.equal(stats.recentlyPlayed[0].iconFallbackUrl, entry.iconFallbackUrl);
});

test('resolved none: verticalCapsuleKnown=false and no URL', async () => {
  await seed([row(APPID, 'CONTROL Resonant', 120, 1793000000)], {
    [APPID]: detailDoc(APPID),
  });
  await art.saveResolvedArt(resolved({
    kind: 'none',
    h: null,
    file: null,
    proxyType: null,
    matchedBy: 'not_found',
  }));
  const entry = buildGamesStatsFromCache(PROFILE_KEY).gamesIndex[APPID];
  assert.equal(entry.verticalCapsule, null);
  assert.equal(entry.verticalCapsuleKnown, false);
  assert.equal(
    entry.iconFallbackUrl,
    `/api/games/steam-art/capsule/${APPID}?h=${CAPSULE_HASH}`
  );
});

test('legacy resolve keeps the hash-less proxy path', async () => {
  await seed([row(APPID, 'CONTROL Resonant', 120, 1793000000)], {
    [APPID]: detailDoc(APPID),
  });
  await art.saveResolvedArt(resolved({
    kind: 'library-legacy',
    h: null,
    file: 'library_600x900.jpg',
    proxyType: 'library',
    matchedBy: 'legacy',
  }));
  const entry = buildGamesStatsFromCache(PROFILE_KEY).gamesIndex[APPID];
  assert.equal(entry.verticalCapsule, `/api/games/steam-art/library/${APPID}`);
  assert.equal(entry.verticalCapsuleKnown, true);
});

test('no resolve document: additive fields stay absent (old payload shape)', async () => {
  const other = 620;
  await seed([row(other, 'Portal 2', 60)], { [other]: detailDoc(other) });
  fs.rmSync(path.join(art.RESOLVED_DIR, `${APPID}.json`), { force: true });
  fs.rmSync(path.join(art.RESOLVED_DIR, `${other}.json`), { force: true });
  const entry = buildGamesStatsFromCache(PROFILE_KEY).gamesIndex[other];
  assert.equal(Object.hasOwn(entry, 'verticalCapsule'), false);
  assert.equal(Object.hasOwn(entry, 'verticalCapsuleKnown'), false);
  assert.equal(Object.hasOwn(entry, 'iconFallbackUrl'), false);
});

test('an edition row paints the primary edition resolved capsule', async () => {
  const primary = 937;
  const edition = 462780;
  await seed(
    [row(edition, 'Darksiders Warmastered Edition', 60, 1793000000)],
    {
      [edition]: detailDoc(edition),
      [primary]: detailDoc(primary),
    }
  );
  await art.saveResolvedArt(resolved({
    appid: primary,
    h: 'primaryhash',
    file: 'library_capsule.jpg',
  }));
  // editions.json merges the two appids only when both are in the library, so
  // seed the primary row as well.
  await gameCache.saveLibrary(ID, {
    fetchedAt: new Date().toISOString(),
    partial: false,
    source: 'steam-webapi',
    game_count: 2,
    games: [row(primary, 'Darksiders', 600), row(edition, 'Darksiders Warmastered Edition', 60, 1793000000)],
    totalMinutes: 660,
  });
  const stats = buildGamesStatsFromCache(PROFILE_KEY);
  assert.equal(stats.gamesIndex[edition].primaryAppid, primary);
  assert.equal(
    stats.gamesIndex[edition].verticalCapsule,
    `/api/games/steam-art/library_capsule/${primary}?h=primaryhash`
  );
});
