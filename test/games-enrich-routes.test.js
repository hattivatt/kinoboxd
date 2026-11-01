'use strict';

/**
 * M2 wiring over HTTP: import → POST /api/games/enrich → stats/card.
 * The router is mounted on a throwaway express app with an injected fake Steam
 * client and an injected fake store client (no live requests), port 7040.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-enrich-routes-'));
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-enrich-routes-state-'));
// These files pin the import/enrich contract; the personnel pass (and its
// live WDQS batch) is covered by games-personnel-kick.test.js with a mock.
process.env.KINOBOXD_GAMES_WD = 'off';
process.env.KINOBOXD_STEAM_KEY_FILE = path.join(process.env.KINOBOXD_STATE_DIR, 'no-steam-token');

const { createRouter } = require('../server/games/routes');
const gameCache = require('../server/games/game-cache');
const { createFakeClient } = require('./fixtures/games/fake-client');

const ID = '76561198000000001';
const PROFILE_KEY = `steam-${ID}`;
const PORT = 7040;

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
    screenshots: ['https://example.test/shot.jpg'],
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

function buildApp(steamClient, storeClient) {
  const app = express();
  app.use(express.json());
  // The enrich job is started explicitly in these tests (`POST /enrich`), so
  // the import-time auto kick is off — otherwise the "before enrich" snapshot
  // would race with it. `games-auto-enrich.test.js` pins the auto kick.
  app.use('/api/games', createRouter({ client: steamClient, storeClient, autoEnrich: false }));
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
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await fetch(`${base}${pathName}/${jobId}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    if (body.done) return body;
    await delay(10);
  }
  throw new Error(`job ${jobId} did not finish`);
}

test('import → enrich → stats with applied filters and details on the card', async (t) => {
  const storeClient = createFakeStoreClient();
  const server = buildApp(createFakeClient(), storeClient).listen(PORT);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${PORT}`;

  /* import */
  const started = await fetch(`${base}/api/games/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vanityOrId64: 'test-player' }),
  });
  assert.equal(started.status, 201);
  const importJob = await started.json();
  const imported = await waitFor(base, '/api/games/import', importJob.jobId);
  assert.equal(imported.status, 'done');
  assert.equal(imported.gameCount, 10);

  /* stats before enrich: M1 fallback */
  const before = await (await fetch(`${base}/api/games/stats?profile=${PROFILE_KEY}`)).json();
  assert.equal(before.meta.filters.includeDlc.applied, false);
  assert.deepEqual(before.genres, []);

  /* enrich */
  const enrichResponse = await fetch(`${base}/api/games/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: PROFILE_KEY, phases: 'details' }),
  });
  assert.equal(enrichResponse.status, 202);
  const enrichJob = await enrichResponse.json();
  assert.equal(enrichJob.job, 'games-enrich');
  assert.equal(enrichJob.profile, PROFILE_KEY);
  assert.equal(enrichJob.status, 'running');

  const byQuery = await (
    await fetch(`${base}/api/games/enrich/status?id=${enrichJob.jobId}`)
  ).json();
  assert.equal(byQuery.jobId, enrichJob.jobId);

  const enriched = await waitFor(base, '/api/games/enrich', enrichJob.jobId);
  assert.equal(enriched.status, 'done');
  assert.equal(enriched.selected, 10);
  assert.equal(enriched.ok, 10);
  assert.equal(enriched.requests, 10);
  assert.equal(enriched.detailsResolved, 10);
  assert.equal(storeClient.calls.length, 10);

  /* stats after enrich: real filters + M2 buckets (minHours=-1 keeps the
     two 0-hour backlog rows so the enrich coverage numbers stay comparable) */
  const stats = await (
    await fetch(`${base}/api/games/stats?profile=${PROFILE_KEY}&minHours=-1`)
  ).json();
  assert.equal(stats.summary.gameCount, 10);
  assert.equal(stats.summary.gameCountEstimated, false);
  assert.equal(stats.meta.filters.includeDlc.applied, true);
  assert.equal(stats.meta.filters.includeDlc.reason, null);
  assert.equal(stats.summary.metadata.detailsResolved, 10);
  assert.equal(stats.summary.metadata.detailsPercent, 100);
  assert.ok(stats.genres.length > 0);
  assert.ok(stats.years.length > 0);
  assert.equal(stats.summary.releaseYearFrom, 2011);
  assert.ok(stats.summary.modes.single > 0);
  assert.equal(stats.gamesIndex[620].type, 'game');
  assert.equal(stats.gamesIndex[620].releaseYear, 2011);

  /* filters are honoured over HTTP */
  const noFree = await (
    await fetch(`${base}/api/games/stats?profile=${PROFILE_KEY}&includeFree=0`)
  ).json();
  assert.equal(noFree.meta.filters.includeFree.requested, false);
  assert.equal(noFree.meta.filters.includeFree.applied, true);

  /* per-game card carries details now */
  const card = await (
    await fetch(`${base}/api/games/game/620?profile=${PROFILE_KEY}`)
  ).json();
  assert.ok(card.details);
  assert.equal(card.details.releaseYear, 2011);
  assert.equal(card.details.metacritic, 90);
  assert.deepEqual(card.details.genres, ['Action']);
  assert.equal(card.meta.detailsCached, true);
  assert.ok(!card.meta.pending.includes('details'));

  /* strict error contract */
  const unknownJob = await fetch(`${base}/api/games/enrich/status?id=nope`);
  assert.equal(unknownJob.status, 404);
  const badProfile = await fetch(`${base}/api/games/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: 'livelib-Margaret' }),
  });
  assert.equal(badProfile.status, 400);
  const badBody = await badProfile.json();
  assert.equal(badBody.code, 'invalid_profile');

  /* the cache is the progress: a second POST is a no-op (all fresh) */
  const second = await fetch(`${base}/api/games/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: PROFILE_KEY, phases: 'details' }),
  });
  assert.equal(second.status, 202);
  const secondJob = await second.json();
  const secondDone = await waitFor(base, '/api/games/enrich', secondJob.jobId);
  assert.equal(secondDone.selected, 0);
  assert.equal(secondDone.skippedFresh, 10);
  assert.equal(storeClient.calls.length, 10);
});
