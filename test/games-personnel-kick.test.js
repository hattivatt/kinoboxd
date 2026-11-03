'use strict';

/**
 * WD trigger flow (ИГРЫ §2.4, production fix 01.11.2026).
 *
 * The bug: `enrichPersonnel()` was only reachable through the manual CLI, so a
 * production cache that had never run the CLI answered `/api/games/personnel`
 * with Steam studios only — composers/designers/writers never arrived. Pinned
 * here with injected providers (no WDQS/Moby/Steam request):
 *
 *   1. import (cached-library branch) → enrich job → personnel job → the
 *      composer role has items and `coverage.byRole.composer > 0`;
 *   2. the personnel pass waits for the running store enrich, so it sees
 *      `details/<appid>.json` instead of an empty library;
 *   3. lazy kick from `GET /api/games/personnel`: the first answer is not
 *      blocked (`pending.running`/`pending.reason: 'started'`, «WD: не
 *      запущено»), the next one has the credits; a second lazy kick within the
 *      cooldown is coalesced (one WD query, `recent_cooldown`);
 *   4. two `kickQuietly` calls for one profile return the same job (coalesce);
 *   5. a lock held by another process makes the pass skip (`lock_busy`)
 *      instead of racing `personnel/<appid>.json`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-kick-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-kick-state-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = STATE_DIR;
process.env.KINOBOXD_MOBY_KEY_FILE = path.join(STATE_DIR, 'no-moby-token');

const gameCache = require('../server/games/game-cache');
const importJobs = require('../server/games/import');
const enrichJobs = require('../server/games/enrich');
const personnelJobs = require('../server/games/personnel/jobs');
const personnel = require('../server/games/personnel/personnel');
const lock = require('../server/games/personnel/lock');
const { createRouter } = require('../server/games/personnel/routes-personnel');

const PORT = 7052;
const DETAILS_DIR = path.join(CACHE_DIR, 'details');

function writeDetails(appid, doc) {
  fs.mkdirSync(DETAILS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DETAILS_DIR, `${appid}.json`),
    JSON.stringify({ fetchedAt: new Date().toISOString(), ...doc })
  );
}

function detailDoc(appid, name) {
  return {
    appid,
    success: true,
    type: 'game',
    name,
    is_free: false,
    developers: ['Steam Dev'],
    publishers: ['Steam Pub'],
    genres: [],
    categories: [],
    releaseYear: 2015,
    releasePrecision: 'year',
    dlc: [],
    dlcCount: 0,
    metadataSource: 'steam-store',
    // Complete enough that the enrich `heal` phase does not re-fetch it
    // (`heal.missing` is `success && !headerImage`); without this the test
    // reaches store.steampowered.com and the personnel pass sees no details.
    headerImage: 'https://cdn.example.invalid/header.jpg',
  };
}

function credit(name, roles, extra = {}) {
  return {
    name,
    nameEn: name,
    nameRu: null,
    qid: null,
    mobyId: null,
    roles,
    roleSource: 'wikidata',
    source: 'wikidata',
    confidence: 'high',
    ...extra,
  };
}

function createMobyMock() {
  return {
    isEnabled: () => false,
    status: () => ({ enabled: false, configured: false, source: null, reason: 'key_missing' }),
    fetchGameCredits: async () => {
      throw new Error('moby must not be called without a key');
    },
  };
}

/**
 * M4: the automatic enrich is `details`+`spy`. This file drives the import
 * kick, so it must inject the spy client — otherwise the phase would reach the
 * live steamspy.com (AGENTS §1: no live scraping in tests).
 */
function createSpyMock() {
  const calls = [];
  return {
    calls,
    async getAppTags(appid) {
      calls.push(appid);
      return { appid, success: true, tags: [{ name: 'Action', weight: 10 }], metadataSource: 'steamspy' };
    },
  };
}

function createWdMock(options = {}) {
  const skip = new Set((options.skip || []).map(Number));
  const calls = { appids: [], qids: 0 };
  return {
    calls,
    wikidataEnabled: () => true,
    defaultStateStore: () => ({
      read: () => ({ schemaVersion: 1, failures: 0, lastSuccessAt: options.lastSuccessAt || null }),
      write: () => {},
    }),
    async creditsForAppids(appids) {
      calls.appids.push([...appids].sort((a, b) => a - b));
      const credits = new Map();
      for (const raw of appids) {
        const appid = Number(raw);
        if (skip.has(appid)) continue;
        credits.set(String(appid), {
          qid: `Q${appid}`,
          appid,
          studios: [credit('WD Studio', ['developer'], { qid: 'Q8000' })],
          people: [credit(`Composer ${appid}`, ['composer'], { qid: `Q9${appid}` })],
        });
      }
      return { credits, queries: 1, batches: 1, errors: [], disabledUntil: null };
    },
    async fetchCredits(qids) {
      calls.qids++;
      return {
        credits: new Map(
          (qids || []).map((qid) => [
            qid,
            { qid, appid: null, studios: [], people: [credit(`Linked ${qid}`, ['composer'])] },
          ])
        ),
        queries: 1,
        batches: 1,
        errors: [],
        disabledUntil: null,
      };
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, attempts = 400) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function seedProfile(userKey, games) {
  const now = new Date().toISOString();
  await gameCache.saveProfile({
    userKey,
    personaName: `player-${userKey.slice(-2)}`,
    privacy: 'public',
    importedAt: now,
    fetchedAt: now,
  });
  await gameCache.saveLibrary(userKey, {
    fetchedAt: now,
    partial: false,
    game_count: games.length,
    games: games.map((appid) => ({ appid, name: `Game ${appid}`, playtime_forever: 600 })),
  });
  for (const appid of games) writeDetails(appid, detailDoc(appid, `Game ${appid}`));
  return `steam-${userKey}`;
}

test.before(() => {
  lock.clearLock();
  personnelJobs.resetCooldown();
});

test.after(() => {
  lock.clearLock();
});

test('import kicks enrich, then personnel: the composer role is filled', async () => {
  const userKey = '76561198000001001';
  const profileKey = await seedProfile(userKey, [8101, 8102, 8103]);
  const wd = createWdMock();
  const moby = createMobyMock();

  const job = importJobs.startImport(userKey, {
    autoEnrich: true,
    autoPersonnel: true,
    personnelOptions: { wikidata: wd, moby },
    spyClient: createSpyMock(),
  });
  assert.equal(job.reused, true, 'a fresh cached library is reused');
  await importJobs.whenIdle();
  // The personnel pass waits for the store enrich internally; under a loaded
  // full-suite run the enrich job may still be in flight here.
  await enrichJobs.whenIdle();
  await personnelJobs.whenIdle();

  const imported = importJobs.getStatus(job.jobId);
  assert.equal(imported.status, 'done');
  assert.ok(imported.enrichJobId, 'enrich job was kicked');
  assert.ok(imported.personnelJobId, 'personnel job was kicked');
  assert.match(imported.personnelJobId, /^games-personnel-/);
  assert.equal(imported.personnelSkipped, null);

  const personnelStatus = personnelJobs.getStatus(imported.personnelJobId);
  assert.equal(personnelStatus.status, 'done');
  assert.equal(personnelStatus.updated, 3);
  assert.equal(personnelStatus.wdQueries, 1, 'one SPARQL batch for three appids');
  assert.deepEqual(wd.calls.appids, [[8101, 8102, 8103]]);

  const payload = personnel.buildPersonnel(profileKey, { role: 'composer' });
  assert.equal(payload.items.length, 3);
  assert.equal(payload.coverage.byRole.composer, 3);
  assert.equal(payload.coverage.percent, 100);
  assert.equal(payload.pending.credits, 0);
  assert.equal(payload.pending.reason, null);

  // Developer credits arrive from both sources; the WD studio is on the role.
  const developers = personnel.buildPersonnel(profileKey, { role: 'developer' });
  const names = developers.items.map((item) => item.name).sort();
  assert.deepEqual(names, ['Steam Dev', 'WD Studio']);
});

test('the personnel pass waits for the store enrich before asking WD', async () => {
  const userKey = '76561198000001002';
  const profileKey = await seedProfile(userKey, [8201, 8202]);
  // Details are stale so the enrich job has work to do (and can be gated).
  for (const appid of [8201, 8202]) {
    fs.writeFileSync(
      path.join(DETAILS_DIR, `${appid}.json`),
      JSON.stringify({ fetchedAt: '2020-01-01T00:00:00.000Z', success: false })
    );
  }

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const gatedStore = {
    async getAppDetails(appid) {
      calls.push(appid);
      await gate;
      return detailDoc(appid, `Game ${appid}`);
    },
  };

  const enrich = enrichJobs.startEnrich(profileKey, { client: gatedStore, force: true });
  assert.equal(enrich.status, 'running');

  const wd = createWdMock();
  const kicked = personnelJobs.kickQuietly(profileKey, {
    wikidata: wd,
    moby: createMobyMock(),
    waitForEnrich: true,
    lockWaitMs: 0,
  });
  assert.ok(kicked.id);

  await waitFor(
    () => (personnelJobs.getStatus(kicked.id) || {}).stage === 'waiting_details',
    'personnel job to wait for details'
  );
  assert.equal(wd.calls.appids.length, 0, 'no WDQS query while details are still missing');

  release();
  await enrichJobs.whenIdle();
  await personnelJobs.whenIdle();

  const status = personnelJobs.getStatus(kicked.id);
  assert.equal(status.status, 'done');
  assert.equal(status.enrichWait, 'idle');
  assert.equal(wd.calls.appids.length, 1);
  assert.deepEqual(wd.calls.appids[0], [8201, 8202]);

  const payload = personnel.buildPersonnel(profileKey, { role: 'composer' });
  assert.equal(payload.coverage.byRole.composer, 2);
});

test('lazy GET /api/games/personnel starts the pass without blocking the answer', async (t) => {
  const userKey = '76561198000001003';
  const profileKey = await seedProfile(userKey, [8301, 8302, 8303]);
  // One game stays without people, so credits stay pending after the pass.
  const wd = createWdMock({ skip: [8303] });
  const app = express();
  app.use(express.json());
  app.use(
    '/api/games',
    createRouter({ personnelOptions: { wikidata: wd, moby: createMobyMock() } })
  );
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    res.status(500).json({ error: 'internal' });
  });
  const server = app.listen(PORT);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${PORT}`;

  const first = await (
    await fetch(`${base}/api/games/personnel?profile=${profileKey}&role=composer`)
  ).json();
  assert.equal(first.items.length, 0, 'the answer is not blocked by the WDQS call');
  assert.equal(first.pending.running, true);
  assert.equal(first.pending.reason, 'started');
  assert.ok(first.pending.jobId);
  assert.equal(first.coverage.wikidata.badge, 'WD: не запущено');
  assert.equal(first.coverage.wikidata.state, 'never_run');

  const jobStatus = await (
    await fetch(`${base}/api/games/personnel/status?id=${first.pending.jobId}`)
  ).json();
  assert.equal(jobStatus.job, 'games-personnel');
  assert.ok(['queued', 'fetching', 'waiting_details', 'done'].includes(jobStatus.stage));

  const unknownJob = await fetch(`${base}/api/games/personnel/status?id=nope`);
  assert.equal(unknownJob.status, 404);

  await personnelJobs.whenIdle();

  const second = await (
    await fetch(`${base}/api/games/personnel?profile=${profileKey}&role=composer`)
  ).json();
  assert.equal(second.items.length, 2, 'credits arrive on the next request');
  assert.equal(second.coverage.byRole.composer, 2);
  assert.equal(second.pending.running, false);
  assert.equal(second.pending.credits, 1);
  // A second lazy kick inside the cooldown is coalesced, not re-run.
  assert.equal(second.pending.reason, 'recent_cooldown');
  assert.equal(wd.calls.appids.length, 1, 'one WD batch, not one per request');
});

test('kickQuietly coalesces into the running job', async () => {
  const userKey = '76561198000001004';
  const profileKey = await seedProfile(userKey, [8401, 8402]);
  personnelJobs.resetCooldown();
  const wd = createWdMock();
  const first = personnelJobs.kickQuietly(profileKey, { wikidata: wd, moby: createMobyMock() });
  const second = personnelJobs.kickQuietly(profileKey, { wikidata: wd, moby: createMobyMock() });
  assert.ok(first.id);
  assert.equal(second.id, first.id, 'the second kick reuses the running job');
  await personnelJobs.whenIdle();
  assert.equal(wd.calls.appids.length, 1);
  const payload = personnel.buildPersonnel(profileKey, { role: 'composer' });
  assert.equal(payload.coverage.byRole.composer, 2);
});

test('a lock held by another pass makes the job skip instead of racing', async () => {
  const userKey = '76561198000001005';
  const profileKey = await seedProfile(userKey, [8501]);
  personnelJobs.resetCooldown();
  fs.mkdirSync(path.dirname(lock.lockPath()), { recursive: true });
  fs.writeFileSync(
    lock.lockPath(),
    JSON.stringify({
      schemaVersion: 1,
      token: 'other',
      pid: process.pid,
      owner: 'test',
      startedAt: new Date().toISOString(),
    })
  );
  const wd = createWdMock();
  const job = personnelJobs.startPersonnel(profileKey, {
    wikidata: wd,
    moby: createMobyMock(),
    lockWaitMs: 0,
  });
  await personnelJobs.whenIdle();
  const status = personnelJobs.getStatus(job.id);
  assert.equal(status.status, 'skipped');
  assert.equal(status.skipped, 'lock_busy');
  assert.equal(status.code, 'personnel_lock_busy');
  assert.equal(wd.calls.appids.length, 0);
  lock.clearLock();

  // Once the lock is gone the next pass runs normally.
  const retry = personnelJobs.startPersonnel(profileKey, {
    wikidata: wd,
    moby: createMobyMock(),
    lockWaitMs: 0,
  });
  await personnelJobs.whenIdle();
  assert.equal(personnelJobs.getStatus(retry.id).status, 'done');
  assert.equal(wd.calls.appids.length, 1);
});

/**
 * Credits complete but written under the old label rule (§4.2): the name in
 * the document may be a truncated Wikidata label, which is what split
 * «Development Studio» from «Paradox Development Studio». The lazy GET must
 * re-fetch such documents once instead of serving the fragment for the whole
 * 90-day TTL.
 */
test('stale label rule alone starts the pass and repairs the document', async (t) => {
  const userKey = '76561198000001007';
  const profileKey = await seedProfile(userKey, [8701, 8702]);
  personnelJobs.resetCooldown();
  const wd = createWdMock();
  personnelJobs.kickQuietly(profileKey, { wikidata: wd, moby: createMobyMock() });
  await personnelJobs.whenIdle();

  const personnelDir = path.join(CACHE_DIR, 'personnel');
  for (const appid of [8701, 8702]) {
    const file = path.join(personnelDir, `${appid}.json`);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(doc.labelRule, personnel.LABEL_RULE_VERSION);
    delete doc.labelRule; // what the pre-fix code wrote
    fs.writeFileSync(file, JSON.stringify(doc));
  }

  const app = express();
  app.use(express.json());
  app.use(
    '/api/games',
    createRouter({ personnelOptions: { wikidata: wd, moby: createMobyMock() } })
  );
  app.use((err, req, res, next) => {
    if (err && err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    res.status(500).json({ error: 'internal' });
  });
  const server = app.listen(PORT);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${PORT}`;

  personnelJobs.resetCooldown();
  const first = await (await fetch(`${base}/api/games/personnel?profile=${profileKey}`)).json();
  assert.equal(first.pending.credits, 0, 'credits are complete — only the labels are old');
  assert.equal(first.pending.staleLabels, 2);
  assert.equal(first.pending.reason, 'started');
  assert.ok(first.pending.jobId);

  await personnelJobs.whenIdle();
  for (const appid of [8701, 8702]) {
    const doc = JSON.parse(fs.readFileSync(path.join(personnelDir, `${appid}.json`), 'utf8'));
    assert.equal(doc.labelRule, personnel.LABEL_RULE_VERSION);
  }

  const second = await (await fetch(`${base}/api/games/personnel?profile=${profileKey}`)).json();
  assert.equal(second.pending.staleLabels, 0);
  assert.equal(second.pending.reason, null);
});

test('an explicit import/enrich kick bypasses the lazy re-kick cooldown', async () => {
  const userKey = '76561198000001006';
  const profileKey = await seedProfile(userKey, [8601]);
  personnelJobs.resetCooldown();
  const wd = createWdMock();
  const lazy = personnelJobs.kickQuietly(profileKey, { wikidata: wd, moby: createMobyMock() });
  assert.ok(lazy.id);
  await personnelJobs.whenIdle();

  const blocked = personnelJobs.kickQuietly(profileKey, { wikidata: wd, moby: createMobyMock() });
  assert.equal(blocked.id, null);
  assert.equal(blocked.skipped, 'recent_cooldown');

  const forced = personnelJobs.kickQuietly(profileKey, {
    wikidata: wd,
    moby: createMobyMock(),
    forceKick: true,
  });
  assert.ok(forced.id, 'a user action must still start a pass');
  await personnelJobs.whenIdle();
  const status = personnelJobs.getStatus(forced.id);
  assert.equal(status.status, 'done');
  assert.equal(status.skippedFresh, 1, 'the cache is the progress: nothing refetched');
  assert.equal(wd.calls.appids.length, 1);
});
