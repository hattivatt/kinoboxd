'use strict';

/**
 * UX-автообогащение: a successful import/refresh must start the store enrich
 * job by itself, so the dashboard fills in without the user pressing
 * «Обогатить» (ИГРЫ-АРХИТЕКТУРА §9, M2/M3 integration).
 *
 * Pinned here, with injected fake clients (no live requests):
 *   1. `POST /api/games/import` → library saved → enrich job starts, details
 *      land in the cache and `stats.summary.metadata` reports 100%;
 *   2. a second import that reuses the fresh library still kicks enrich, but
 *      fresh details are not re-fetched (the cache is the progress);
 *   3. `POST /api/games/refresh` (always force) kicks enrich again;
 *   4. a partial library (no STEAM_API_KEY) does not kick anything and says so
 *      via `enrichSkipped`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-auto-enrich-')
);
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-auto-enrich-state-')
);
process.env.KINOBOXD_STEAM_KEY_FILE = path.join(process.env.KINOBOXD_STATE_DIR, 'no-steam-token');

const { createRouter } = require('../server/games/routes');
const importJobs = require('../server/games/import');
const enrichJobs = require('../server/games/enrich');
const gameCache = require('../server/games/game-cache');
const { createFakeClient } = require('./fixtures/games/fake-client');

const ID = '76561198000000001';
const PROFILE_KEY = `steam-${ID}`;
const PORT = 7046;

function detailDoc(appid) {
  return {
    appid,
    success: true,
    type: 'game',
    name: `Game ${appid}`,
    is_free: false,
    developers: ['Valve'],
    publishers: ['Valve'],
    genres: [{ id: '1', description: 'Action' }],
    categories: [{ id: '2', description: 'Single-player' }],
    release_date: {
      date: '18 Apr, 2011',
      coming_soon: false,
      year: 2011,
      month: 4,
      day: 18,
      precision: 'day',
    },
    releaseYear: 2011,
    releasePrecision: 'day',
    dlc: [],
    dlcCount: 0,
    metacritic: { score: 90 },
    platforms: { windows: true, mac: false, linux: true },
    screenshots: [],
    earlyAccess: false,
    metadataSource: 'steam-store',
  };
}

function createFakeStoreClient() {
  const calls = [];
  return {
    calls,
    async getAppDetails(appid) {
      calls.push(appid);
      return detailDoc(appid);
    },
  };
}

function buildApp(steamClient, storeClient, options = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/games', createRouter({ client: steamClient, storeClient, ...options }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error('[test] unhandled', err);
    res.status(500).json({ error: 'internal', code: 'internal_error' });
  });
  return app;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(base, pathName, jobId) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const response = await fetch(`${base}${pathName}/${jobId}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    if (body.done) return body;
    await delay(10);
  }
  throw new Error(`job ${jobId} did not finish`);
}

async function post(base, pathName, body) {
  return fetch(`${base}${pathName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('import starts the store enrich job by itself', async (t) => {
  const storeClient = createFakeStoreClient();
  const server = buildApp(createFakeClient(), storeClient).listen(PORT);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${PORT}`;

  const started = await post(base, '/api/games/import', { vanityOrId64: 'test-player' });
  assert.equal(started.status, 201);
  const importJob = await started.json();
  const imported = await waitFor(base, '/api/games/import', importJob.jobId);
  assert.equal(imported.status, 'done');
  assert.equal(imported.gameCount, 10);
  // The import payload names the enrich job it kicked (null would mean "off").
  assert.ok(imported.enrichJobId, 'import payload must carry enrichJobId');
  assert.match(imported.enrichJobId, /^games-enrich-/);
  assert.equal(imported.enrichSkipped, null);

  // Wait for the enrich chain the import started — no extra POST from the test.
  await enrichJobs.whenIdle();
  const enrichStatus = enrichJobs.getStatus(imported.enrichJobId);
  assert.equal(enrichStatus.status, 'done');
  assert.equal(enrichStatus.selected, 10);
  assert.equal(enrichStatus.ok, 10);
  assert.equal(enrichStatus.detailsResolved, 10);
  assert.equal(storeClient.calls.length, 10);

  const stats = await (await fetch(`${base}/api/games/stats?profile=${PROFILE_KEY}`)).json();
  assert.equal(stats.summary.metadata.detailsResolved, 10);
  assert.equal(stats.summary.metadata.detailsPercent, 100);
  assert.equal(stats.meta.filters.includeDlc.applied, true);
  assert.ok(stats.genres.length > 0);

  /* --- a cached import still kicks enrich, but refetches nothing --- */
  const again = await post(base, '/api/games/import', { vanityOrId64: 'test-player' });
  assert.equal(again.status, 200);
  const reused = await again.json();
  assert.equal(reused.reused, true);
  assert.ok(reused.enrichJobId, 'the reuse branch must kick enrich too');
  await enrichJobs.whenIdle();
  const reusedEnrich = enrichJobs.getStatus(reused.enrichJobId);
  assert.equal(reusedEnrich.status, 'done');
  assert.equal(reusedEnrich.selected, 0, 'fresh details must not be re-fetched');
  assert.equal(storeClient.calls.length, 10);

  /* --- refresh (force) kicks enrich again --- */
  const refreshed = await post(base, '/api/games/refresh', { profile: PROFILE_KEY });
  assert.ok([200, 201].includes(refreshed.status));
  const refreshJob = await refreshed.json();
  const refreshDone = await waitFor(base, '/api/games/import', refreshJob.jobId);
  assert.equal(refreshDone.status, 'done');
  assert.ok(refreshDone.enrichJobId);
  await enrichJobs.whenIdle();
  assert.equal(storeClient.calls.length, 10);
});

test('a partial library (no Steam key) does not kick enrich', async (t) => {
  // A distinct steamid64 keeps this test from touching the library the first
  // test enriched (one cache dir for the whole file).
  const base = createFakeClient({ key: '' });
  const profile = { ...base.state.profile, steamId64: '76561198000000077', customUrl: 'keyless-player' };
  const keyless = createFakeClient({ key: '', profile });
  const storeClient = createFakeStoreClient();
  const server = buildApp(keyless, storeClient, { autoEnrich: true }).listen(PORT + 1);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${PORT + 1}`;

  const started = await post(url, '/api/games/import', { vanityOrId64: 'keyless-player', force: true });
  assert.equal(started.status, 201);
  const job = await started.json();
  const done = await waitFor(url, '/api/games/import', job.jobId);
  assert.equal(done.status, 'done');
  assert.equal(done.libraryPartial, true);
  assert.equal(done.code, 'steam_key_missing');
  assert.equal(done.enrichJobId, null);
  assert.equal(done.enrichSkipped, 'library_partial');
  assert.equal(storeClient.calls.length, 0);
  assert.equal(gameCache.getLibrary('76561198000000077').partial, true);
  await importJobs.whenIdle();
});
