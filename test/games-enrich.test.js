'use strict';

/**
 * M2 enrich job: resumable appdetails pass over one library, budget, force,
 * re-check window, deferred failures (no negative cache) and the persisted
 * progress state. No network: the store client is injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-enrich-'));
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-enrich-state-'));

const gameCache = require('../server/games/game-cache');
const enrich = require('../server/games/enrich');

let nextBase = 100000;
function appidRange(count) {
  const base = nextBase;
  nextBase += 100;
  return Array.from({ length: count }, (_, index) => base + index);
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

function createFakeStoreClient(options = {}) {
  const calls = [];
  const docs = options.docs || {};
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
      return JSON.parse(JSON.stringify(docs[appid] || detailDoc(appid)));
    },
  };
}

async function seedProfile(id, appids) {
  const now = new Date().toISOString();
  await gameCache.saveProfile({
    userKey: id,
    personaName: `tester-${id.slice(-2)}`,
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

async function runJob(profileKey, client, options = {}) {
  const started = enrich.startEnrich(profileKey, { client, ...options });
  await enrich.whenIdle();
  return enrich.getStatus(started.jobId);
}

test('full enrich: one request per appid, details written, journal state saved', async () => {
  const appids = appidRange(4);
  const profile = await seedProfile('76561198000000101', appids);
  const client = createFakeStoreClient();
  const status = await runJob(profile, client, { budget: 100 });
  assert.equal(status.status, 'done');
  assert.equal(status.stage, 'done');
  assert.equal(status.done, true);
  assert.equal(status.total, 4);
  assert.equal(status.selected, 4);
  assert.equal(status.ok, 4);
  assert.equal(status.unavailable, 0);
  assert.equal(status.deferred, 0);
  assert.equal(status.requests, 4);
  assert.equal(status.remaining, 0);
  assert.equal(status.budgetLimit, 100);
  assert.equal(status.budgetRemaining, 96);
  assert.equal(status.detailsResolved, 4);
  assert.equal(status.detailsTotal, 4);
  assert.equal(status.detailsPercent, 100);
  assert.deepEqual(client.calls, appids);

  for (const appid of appids) {
    const doc = gameCache.getDetails(appid);
    assert.equal(doc.success, true);
    assert.equal(doc.type, 'game');
    assert.ok(doc.fetchedAt);
  }
  const state = gameCache.readEnrichState();
  assert.equal(state.profiles[profile].attempted.length, 4);
  assert.equal(state.profiles[profile].lastAppid, appids[appids.length - 1]);
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].ok, 4);
  assert.equal(state.runs[0].detailsResolved, 4);
});

test('resume: a second pass skips fresh details and sends zero requests', async () => {
  const appids = appidRange(3);
  const profile = await seedProfile('76561198000000102', appids);
  await runJob(profile, createFakeStoreClient(), { budget: 100 });
  const before = appids.map((appid) => gameCache.getDetails(appid).fetchedAt);

  const client = createFakeStoreClient();
  const second = await runJob(profile, client, { budget: 100 });
  assert.equal(second.selected, 0);
  assert.equal(second.skippedFresh, 3);
  assert.equal(second.requests, 0);
  assert.equal(second.ok, 0);
  assert.equal(second.detailsResolved, 3);
  assert.deepEqual(client.calls, []);
  const after = appids.map((appid) => gameCache.getDetails(appid).fetchedAt);
  assert.deepEqual(after, before);
});

test('force re-fetches everything, ignoring freshness', async () => {
  const appids = appidRange(2);
  const profile = await seedProfile('76561198000000103', appids);
  await runJob(profile, createFakeStoreClient(), { budget: 100 });
  const client = createFakeStoreClient();
  const forced = await runJob(profile, client, { budget: 100, force: true });
  assert.equal(forced.force, true);
  assert.equal(forced.selected, 2);
  assert.equal(forced.requests, 2);
  assert.deepEqual(client.calls, appids);
});

test('recheckDays: only documents older than the window are re-fetched', async () => {
  const appids = appidRange(4);
  const profile = await seedProfile('76561198000000104', appids);
  await runJob(profile, createFakeStoreClient(), { budget: 100 });

  const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  const staleDoc = gameCache.getDetails(appids[1]);
  await gameCache.saveDetails(appids[1], { ...staleDoc, fetchedAt: old });

  const window180 = createFakeStoreClient();
  const first = await runJob(profile, window180, { budget: 100, recheckDays: 180 });
  assert.deepEqual(window180.calls, [appids[1]]);
  assert.equal(first.selected, 1);
  assert.equal(first.skippedFresh, 3);

  const window365 = createFakeStoreClient();
  const second = await runJob(profile, window365, { budget: 100, recheckDays: 365 });
  assert.deepEqual(window365.calls, []);
  assert.equal(second.selected, 0);
  assert.equal(second.skippedFresh, 4);
});

test('budget: each run processes one slice, the next run resumes the rest', async () => {
  // Isolate the run ring so this test counts exactly its own passes.
  await gameCache.saveEnrichState({ profiles: {}, runs: [] });
  const appids = appidRange(10);
  const profile = await seedProfile('76561198000000105', appids);
  const expectations = [
    { selected: 3, remaining: 7 },
    { selected: 3, remaining: 4 },
    { selected: 3, remaining: 1 },
    { selected: 1, remaining: 0 },
    { selected: 0, remaining: 0 },
  ];
  for (const expected of expectations) {
    const client = createFakeStoreClient();
    const status = await runJob(profile, client, { budget: 3 });
    assert.equal(status.selected, expected.selected);
    assert.equal(status.remaining, expected.remaining);
    assert.equal(client.calls.length, expected.selected);
  }
  const state = gameCache.readEnrichState();
  // The fifth pass selected nothing (everything fresh) and is a no-op: only
  // the four fetching passes are journaled.
  assert.equal(state.runs.filter((run) => run.profile === profile).length, 4);
  assert.equal(state.profiles[profile].detailsResolved, 10);
});

test('network failure is deferred: nothing is cached and the run stops', async () => {
  const appids = appidRange(3);
  const profile = await seedProfile('76561198000000106', appids);
  const client = createFakeStoreClient({ fail: { [appids[1]]: 'store_unreachable' } });
  const status = await runJob(profile, client, { budget: 100 });
  assert.equal(status.ok, 1);
  assert.equal(status.deferred, 1);
  assert.equal(status.remaining, 1);
  assert.equal(status.stoppedBy, 'store_unreachable');
  assert.deepEqual(status.errors, ['store_unreachable']);
  assert.ok(gameCache.getDetails(appids[0]));
  assert.equal(gameCache.getDetails(appids[1]), null);
  // The run stopped at the failure: the third appid was not attempted.
  assert.equal(gameCache.getDetails(appids[2]), null);
  assert.deepEqual(client.calls, [appids[0], appids[1]]);
});

test('a single 5xx is deferred but the pass continues with the next appid', async () => {
  const appids = appidRange(3);
  const profile = await seedProfile('76561198000000107', appids);
  const client = createFakeStoreClient({ fail: { [appids[1]]: 'store_http_error' } });
  const status = await runJob(profile, client, { budget: 100 });
  assert.equal(status.ok, 2);
  assert.equal(status.deferred, 1);
  assert.equal(status.remaining, 1);
  assert.equal(status.stoppedBy, null);
  assert.deepEqual(client.calls, appids);
  assert.ok(gameCache.getDetails(appids[2]));
});

test('success:false is an honest unavailable document, not a deferred error', async () => {
  const appids = appidRange(2);
  const profile = await seedProfile('76561198000000108', appids);
  const docs = {
    [appids[0]]: {
      appid: appids[0],
      success: false,
      unavailable: true,
      type: null,
      name: null,
      metadataSource: 'steam-store',
      error: 'not_available',
    },
  };
  const client = createFakeStoreClient({ docs });
  const status = await runJob(profile, client, { budget: 100 });
  assert.equal(status.ok, 1);
  assert.equal(status.unavailable, 1);
  assert.equal(status.deferred, 0);
  assert.equal(status.detailsResolved, 1);
  const doc = gameCache.getDetails(appids[0]);
  assert.equal(doc.success, false);
  assert.equal(doc.unavailable, true);

  // The answer is cached, so the next pass does not ask again.
  const next = createFakeStoreClient({ docs });
  const second = await runJob(profile, next, { budget: 100 });
  assert.equal(second.selected, 0);
  assert.deepEqual(next.calls, []);
});

test('a running job for the same profile coalesces', async () => {
  const appids = appidRange(2);
  const profile = await seedProfile('76561198000000109', appids);
  const client = createFakeStoreClient();
  const first = enrich.startEnrich(profile, { client, budget: 100 });
  const second = enrich.startEnrich(profile, { client, budget: 100 });
  assert.equal(second.jobId, first.jobId);
  await enrich.whenIdle();
  assert.equal(enrich.getStatus(first.jobId).done, true);
});

test('unknown / malformed profiles are rejected synchronously', async () => {
  assert.throws(
    () => enrich.startEnrich('steam-76561198000000999'),
    (err) => err.code === 'unknown_profile' && err.status === 400
  );
  assert.throws(
    () => enrich.startEnrich('livelib-Margaret'),
    (err) => err.code === 'invalid_profile' && err.status === 400
  );
});
