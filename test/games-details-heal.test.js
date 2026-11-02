'use strict';

/**
 * One-time heal of `details` documents written before the store parser kept
 * `headerImage` (e5bc5b9, 02.11.2026).
 *
 * The user-visible contract: pressing «Обновить профиль» / «Импорт» after the
 * deploy must **add the missing artwork** to an otherwise TTL-fresh document
 * instead of waiting 180 days or forcing a full re-fetch of the library.
 *
 * Pinned here, with injected fake clients (no live requests):
 *   1. a fresh `success:true` document without `headerImage` is re-fetched
 *      once and the healed URL lands in `details/<appid>.json`;
 *   2. the ledger (`state/details-heal-state.json`) records the outcome, so a
 *      second run selects nothing — no cyclic `force`, no repeated spend;
 *   3. an honest `unavailable` document (success:false) is **not** a candidate:
 *      there is no store page to ask for artwork;
 *   4. a store answer without artwork is remembered as `no_artwork`;
 *   5. a deferred (network) failure is not recorded, so the next run retries;
 *   6. the heal obeys `GAMES_STORE_BUDGET` like any other details request.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-heal-')
);
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-heal-state-')
);

const gameCache = require('../server/games/game-cache');
const enrich = require('../server/games/enrich');

let nextBase = 810000;
function appidRange(count) {
  const base = nextBase;
  nextBase += 100;
  return Array.from({ length: count }, (_, index) => base + index);
}

function headerUrl(appid) {
  return `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/h/hash/header.jpg`;
}

function detailDoc(appid, extra = {}) {
  return {
    appid,
    success: true,
    type: 'game',
    name: `Game ${appid}`,
    is_free: false,
    developers: ['Dev'],
    publishers: ['Pub'],
    genres: [{ id: '1', description: 'Action' }],
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

function healClient(options = {}) {
  const calls = [];
  const fail = options.fail || {};
  return {
    calls,
    async getAppDetails(appid) {
      calls.push(appid);
      if (fail[appid]) {
        const err = new Error(`store failed for ${appid}`);
        err.code = fail[appid];
        throw err;
      }
      if (typeof options.doc === 'function') return options.doc(appid);
      if (options.noArtwork) return detailDoc(appid);
      return detailDoc(appid, { headerImage: headerUrl(appid) });
    },
  };
}

async function seedProfile(id, appids) {
  const now = new Date().toISOString();
  await gameCache.saveProfile({
    userKey: id,
    personaName: `heal-${id.slice(-2)}`,
    privacy: 'public',
    importedAt: now,
    fetchedAt: now,
  });
  const games = appids.map((appid, index) => ({
    appid,
    name: `Game ${appid}`,
    playtime_forever: (index + 1) * 60,
    playtime_2weeks: null,
    rtime_last_played: 0,
    img_icon_url: null,
    playtime_windows_forever: 0,
    playtime_mac_forever: 0,
    playtime_linux_forever: 0,
    playtime_deck_forever: 0,
  }));
  await gameCache.saveLibrary(id, {
    fetchedAt: now,
    partial: false,
    source: 'steam-webapi',
    game_count: games.length,
    games,
    totalMinutes: games.reduce((sum, game) => sum + game.playtime_forever, 0),
    fingerprint: `fp-${id}`,
  });
  return gameCache.profileKeyOf(id);
}

async function seedFreshDetail(appid, extra = {}) {
  const doc = detailDoc(appid, {
    fetchedAt: new Date().toISOString(),
    ...extra,
  });
  await gameCache.saveDetails(appid, doc);
  return doc;
}

async function runDetails(profileKey, client, options = {}) {
  const started = enrich.startEnrich(profileKey, {
    client,
    phases: 'details',
    budget: 100,
    ...options,
  });
  await enrich.whenIdle();
  return enrich.getStatus(started.jobId);
}

test('a fresh document without headerImage is healed once, then skipped', async () => {
  const appids = appidRange(2);
  const profile = await seedProfile('76561198000008101', appids);
  // Both documents are TTL-fresh; only the first predates `headerImage`.
  await seedFreshDetail(appids[0]);
  await seedFreshDetail(appids[1], { headerImage: headerUrl(appids[1]) });

  const first = healClient();
  const status = await runDetails(profile, first);

  assert.deepEqual(first.calls, [appids[0]], 'only the artwork-less document is healed');
  assert.equal(status.phases.details.selected, 1);
  assert.equal(status.phases.details.skippedFresh, 1);
  assert.equal(status.phases.details.healCandidates, 1);
  assert.equal(status.phases.details.healed, 1);
  assert.equal(status.phases.details.ok, 1);
  assert.equal(status.phases.details.resolved, 2);

  const healed = gameCache.getDetails(appids[0]);
  assert.equal(healed.headerImage, headerUrl(appids[0]));
  assert.ok(healed.fetchedAt);

  const ledger = gameCache.readDetailsHealState();
  assert.equal(ledger.appids[String(appids[0])].result, 'healed');
  assert.equal(ledger.appids[String(appids[1])], undefined, 'a document with artwork is not in the ledger');

  // Second «Обновить профиль»: nothing is asked again (no cyclic force).
  const second = healClient();
  const again = await runDetails(profile, second);
  assert.deepEqual(second.calls, []);
  assert.equal(again.phases.details.selected, 0);
  assert.equal(again.phases.details.skippedFresh, 2);
  assert.equal(again.phases.details.healCandidates, 0);
  assert.equal(again.phases.details.healed, 0);
});

test('an honest unavailable document is not a heal candidate', async () => {
  const appids = appidRange(1);
  const profile = await seedProfile('76561198000008102', appids);
  await gameCache.saveDetails(appids[0], {
    appid: appids[0],
    success: false,
    unavailable: true,
    error: 'not_available',
    metadataSource: 'steam-store',
    fetchedAt: new Date().toISOString(),
  });

  const client = healClient();
  const status = await runDetails(profile, client);
  assert.deepEqual(client.calls, [], 'success:false has no store page to ask');
  assert.equal(status.phases.details.selected, 0);
  assert.equal(status.phases.details.healCandidates, 0);
  assert.equal(status.phases.details.skippedFresh, 1);
  assert.equal(gameCache.readDetailsHealState().appids[String(appids[0])], undefined);
});

test('a store answer without artwork is remembered as no_artwork', async () => {
  const appids = appidRange(1);
  const profile = await seedProfile('76561198000008103', appids);
  await seedFreshDetail(appids[0]);

  const first = healClient({ noArtwork: true });
  const status = await runDetails(profile, first);
  assert.deepEqual(first.calls, [appids[0]]);
  assert.equal(status.phases.details.healed, 1);
  assert.equal(gameCache.getDetails(appids[0]).headerImage, undefined);
  const ledger = gameCache.readDetailsHealState();
  assert.equal(ledger.appids[String(appids[0])].result, 'no_artwork');

  const second = healClient();
  const again = await runDetails(profile, second);
  assert.deepEqual(second.calls, [], 'the store already answered without artwork');
  assert.equal(again.phases.details.selected, 0);
});

test('a deferred heal request is retried on the next run', async () => {
  const appids = appidRange(1);
  const profile = await seedProfile('76561198000008104', appids);
  await seedFreshDetail(appids[0]);

  const failing = healClient({ fail: { [appids[0]]: 'store_unreachable' } });
  const first = await runDetails(profile, failing);
  assert.deepEqual(failing.calls, [appids[0]]);
  assert.equal(first.phases.details.deferred, 1);
  assert.equal(
    gameCache.readDetailsHealState().appids[String(appids[0])],
    undefined,
    'a network failure is not a verdict'
  );

  const second = healClient();
  const again = await runDetails(profile, second);
  assert.deepEqual(second.calls, [appids[0]], 'the deferred heal is retried');
  assert.equal(again.phases.details.healed, 1);
  assert.equal(gameCache.getDetails(appids[0]).headerImage, headerUrl(appids[0]));
});

test('the heal obeys the per-run details budget', async () => {
  const appids = appidRange(3);
  const profile = await seedProfile('76561198000008105', appids);
  for (const appid of appids) await seedFreshDetail(appid);

  const first = healClient();
  const firstRun = await runDetails(profile, first, { budget: 2 });
  assert.equal(firstRun.phases.details.healCandidates, 3);
  assert.equal(firstRun.phases.details.selected, 2);
  assert.equal(firstRun.phases.details.remaining, 1);
  assert.equal(first.calls.length, 2);

  const second = healClient();
  const secondRun = await runDetails(profile, second, { budget: 2 });
  assert.equal(secondRun.phases.details.selected, 1);
  assert.equal(secondRun.phases.details.remaining, 0);
  assert.equal(second.calls.length, 1);
  assert.equal(secondRun.phases.details.healed, 1);
  // Every document now carries artwork and is in the ledger.
  for (const appid of appids) {
    assert.ok(gameCache.getDetails(appid).headerImage);
    assert.equal(
      gameCache.readDetailsHealState().appids[String(appid)].result,
      'healed'
    );
  }
});
