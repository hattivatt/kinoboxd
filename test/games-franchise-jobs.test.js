'use strict';

/**
 * Franchise job (M4-B): coalescing, shared WDQS lock, resume/force, lazy-kick
 * gate and the import wiring. Providers are injected, no live WDQS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-franchise-jobs-')
);
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-franchise-jobs-state-')
);

const gameCache = require('../server/games/game-cache');
const franchise = require('../server/games/franchise');
const franchiseJobs = require('../server/games/franchise-jobs');
const importJobs = require('../server/games/import');
const lock = require('../server/games/personnel/lock');

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'games', 'wikidata-franchises.json'), 'utf8')
);

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
  };
}

function memoryStore() {
  let state = {};
  return {
    read: () => ({ ...state }),
    write: (next) => {
      state = { ...next };
    },
  };
}

async function seed(userKey, games) {
  const now = new Date().toISOString();
  await gameCache.saveProfile({ userKey, personaName: 'jobs tester', importedAt: now, fetchedAt: now });
  await gameCache.saveLibrary(userKey, {
    fetchedAt: now,
    partial: false,
    game_count: games.length,
    games,
  });
  return gameCache.profileKeyOf(userKey);
}

function clearLinks(appids) {
  for (const appid of appids) {
    try {
      fs.unlinkSync(franchise.linksPath(appid));
    } catch (err) {
      /* already gone */
    }
  }
}

test.before(() => {
  franchiseJobs.resetCooldown();
});

test.after(() => {
  lock.clearLock();
});

test('one pass writes links, records state and coalesces a second start', async () => {
  const userKey = '76561198000004001';
  clearLinks([292030, 12240]);
  const profileKey = await seed(userKey, [
    { appid: 292030, name: 'The Witcher 3: Wild Hunt', playtime_forever: 100 },
    { appid: 12240, name: 'Region Locked', playtime_forever: 10 },
  ]);
  let calls = 0;
  const options = {
    fetchImpl: async () => {
      calls++;
      return jsonResponse(fixture);
    },
    stateStore: memoryStore(),
    pauseMs: 0,
    waitForEnrich: false,
    lockWaitMs: 0,
  };

  const first = franchiseJobs.startFranchise(profileKey, options);
  const second = franchiseJobs.startFranchise(profileKey, options);
  assert.equal(first.jobId, second.jobId, 'a running pass is reused, not duplicated');
  assert.equal(first.status, 'running');

  await franchiseJobs.whenIdle();
  const done = franchiseJobs.getStatus(first.jobId);
  assert.equal(done.status, 'done');
  assert.equal(done.updated, 2);
  assert.equal(done.wdQueries, 1);
  assert.equal(done.wdAnswered, 7);
  assert.equal(done.skipped, null);
  assert.equal(calls, 1);

  assert.ok(franchise.readLinksDoc(292030));
  assert.ok(franchise.readLinksDoc(12240));
  const state = franchise.readFranchiseState();
  assert.equal(state.profiles[profileKey].updated, 2);
});

test('the shared personnel lock makes the pass skip instead of racing WDQS', async () => {
  const userKey = '76561198000004002';
  clearLinks([292030]);
  const profileKey = await seed(userKey, [
    { appid: 292030, name: 'The Witcher 3: Wild Hunt', playtime_forever: 100 },
  ]);
  const token = lock.tryAcquire('another-wdqs-pass');
  assert.ok(token, 'test holds the shared lock');
  try {
    const job = franchiseJobs.startFranchise(profileKey, {
      fetchImpl: async () => jsonResponse(fixture),
      stateStore: memoryStore(),
      pauseMs: 0,
      waitForEnrich: false,
      lockWaitMs: 0,
    });
    await franchiseJobs.whenIdle();
    const done = franchiseJobs.getStatus(job.jobId);
    assert.equal(done.status, 'skipped');
    assert.equal(done.skipped, 'lock_busy');
    assert.equal(done.code, 'franchise_lock_busy');
    assert.equal(franchise.readLinksDoc(292030), null);
  } finally {
    lock.releaseLock(token);
  }
});

test('lazy kick gate: recent_cooldown after a pass, forceKick bypasses, WD off disables', async () => {
  const userKey = '76561198000004003';
  clearLinks([292030]);
  const profileKey = await seed(userKey, [
    { appid: 292030, name: 'The Witcher 3: Wild Hunt', playtime_forever: 100 },
  ]);
  franchiseJobs.resetCooldown();

  const job = franchiseJobs.startFranchise(profileKey, {
    fetchImpl: async () => jsonResponse(fixture),
    stateStore: memoryStore(),
    pauseMs: 0,
    waitForEnrich: false,
    lockWaitMs: 0,
  });
  await franchiseJobs.whenIdle();
  assert.equal(franchiseJobs.getStatus(job.jobId).status, 'done');

  assert.equal(franchiseJobs.kickGate(profileKey), 'recent_cooldown');
  assert.equal(franchiseJobs.kickGate(profileKey, { forceKick: true }), null);

  const skipped = franchiseJobs.kickQuietly(profileKey, {});
  assert.equal(skipped.id, null);
  assert.equal(skipped.skipped, 'recent_cooldown');

  process.env.KINOBOXD_GAMES_WD = 'off';
  try {
    franchiseJobs.resetCooldown();
    assert.equal(franchiseJobs.kickGate(profileKey, { forceKick: true }), 'sources_disabled');
    const disabled = franchiseJobs.kickQuietly(profileKey, { forceKick: true });
    assert.equal(disabled.skipped, 'sources_disabled');
  } finally {
    delete process.env.KINOBOXD_GAMES_WD;
  }
});

test('force re-asks a fresh links document', async () => {
  const userKey = '76561198000004004';
  clearLinks([292030]);
  const profileKey = await seed(userKey, [
    { appid: 292030, name: 'The Witcher 3: Wild Hunt', playtime_forever: 100 },
  ]);
  let calls = 0;
  const options = {
    fetchImpl: async () => {
      calls++;
      return jsonResponse(fixture);
    },
    stateStore: memoryStore(),
    pauseMs: 0,
    waitForEnrich: false,
    lockWaitMs: 0,
  };
  const first = franchiseJobs.startFranchise(profileKey, options);
  await franchiseJobs.whenIdle();
  assert.equal(franchiseJobs.getStatus(first.jobId).updated, 1);

  const cached = franchiseJobs.startFranchise(profileKey, options);
  await franchiseJobs.whenIdle();
  const cachedStatus = franchiseJobs.getStatus(cached.jobId);
  assert.equal(cachedStatus.updated, 0);
  assert.equal(cachedStatus.skippedFresh, 1);
  assert.equal(cachedStatus.skipped, 'nothing_to_ask');
  assert.equal(calls, 1);

  const forced = franchiseJobs.startFranchise(profileKey, { ...options, force: true });
  await franchiseJobs.whenIdle();
  assert.equal(franchiseJobs.getStatus(forced.jobId).updated, 1);
  assert.equal(calls, 2);
});

test('import kicks the franchise pass after the library is ready', async () => {
  const userKey = '76561198000004005';
  clearLinks([292030]);
  await seed(userKey, [
    { appid: 292030, name: 'The Witcher 3: Wild Hunt', playtime_forever: 100 },
  ]);
  franchiseJobs.resetCooldown();

  const job = importJobs.startImport(userKey, {
    autoEnrich: false,
    autoPersonnel: false,
    autoFranchise: true,
    franchiseOptions: {
      fetchImpl: async () => jsonResponse(fixture),
      stateStore: memoryStore(),
      pauseMs: 0,
      lockWaitMs: 0,
    },
  });
  await importJobs.whenIdle();
  await franchiseJobs.whenIdle();

  const status = importJobs.getStatus(job.jobId);
  assert.ok(status.franchiseJobId, 'import reports the franchise job id');
  assert.match(status.franchiseJobId, /^games-franchise-/);
  assert.equal(status.franchiseSkipped, null);
  const franchiseStatus = franchiseJobs.getStatus(status.franchiseJobId);
  assert.equal(franchiseStatus.status, 'done');
  assert.equal(franchiseStatus.updated, 1);
  assert.ok(franchise.readLinksDoc(292030));
});
