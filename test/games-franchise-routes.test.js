'use strict';

/**
 * `/api/games/franchises` + `/api/games/franchise-enrich` route contract
 * (M4-B). Throwaway express app on the brief's port 7069 (fallback to an
 * ephemeral port if it is already taken by a parallel run); no live WDQS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-franchise-routes-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-franchise-routes-state-')
);
// This file pins the payload/route contract only: the WD pass is covered by
// the provider/job tests with an injected fetch. Leaving WD on would make the
// GET below ask the real WDQS.
process.env.KINOBOXD_GAMES_WD = 'off';

const gameCache = require('../server/games/game-cache');
const franchise = require('../server/games/franchise');
const franchiseJobs = require('../server/games/franchise-jobs');
const { createRouter } = require('../server/games/routes-franchise');
const { createRouter: createGamesRouter } = require('../server/games/routes');

const ID = '76561198000005001';
const PROFILE = `steam-${ID}`;
const PREFERRED_PORT = 7069;

async function seed() {
  const now = new Date().toISOString();
  await gameCache.saveProfile({
    userKey: ID,
    personaName: 'routes tester',
    privacy: 'public',
    importedAt: now,
    fetchedAt: now,
  });
  await gameCache.saveLibrary(ID, {
    fetchedAt: now,
    partial: false,
    game_count: 3,
    games: [
      { appid: 292030, name: 'The Witcher 3: Wild Hunt', playtime_forever: 6420 },
      { appid: 20900, name: 'The Witcher: Enhanced Edition', playtime_forever: 600 },
      { appid: 12240, name: 'Region Locked Game', playtime_forever: 120 },
    ],
  });
  fs.mkdirSync(path.join(CACHE_DIR, 'details'), { recursive: true });
  fs.writeFileSync(
    path.join(CACHE_DIR, 'details', '292030.json'),
    JSON.stringify({ success: true, type: 'game', name: 'The Witcher 3: Wild Hunt', releaseYear: 2015 })
  );
  fs.writeFileSync(
    path.join(CACHE_DIR, 'details', '12240.json'),
    JSON.stringify({ success: false, unavailable: true })
  );
  fs.mkdirSync(franchise.LINKS_DIR, { recursive: true });
  fs.writeFileSync(
    franchise.linksPath(292030),
    JSON.stringify({
      schemaVersion: 1,
      appid: 292030,
      wikidata: {
        qid: 'Q4267401',
        franchise: { qid: 'Q1060747', labelEn: 'The Witcher', labelRu: 'Ведьмак' },
        releaseYear: 2015,
        releasePrecision: 'day',
        resolved: true,
        fetchedAt: now,
      },
      franchiseKey: 'wd:Q1060747',
      sources: ['wikidata'],
      fetchedAt: now,
    })
  );
  fs.writeFileSync(
    franchise.linksPath(20900),
    JSON.stringify({
      schemaVersion: 1,
      appid: 20900,
      wikidata: {
        qid: 'Q845211',
        franchise: { qid: 'Q1060747', labelEn: 'The Witcher', labelRu: 'Ведьмак' },
        releaseYear: 2007,
        releasePrecision: 'day',
        resolved: true,
        fetchedAt: now,
      },
      franchiseKey: 'wd:Q1060747',
      sources: ['wikidata'],
      fetchedAt: now,
    })
  );
  fs.writeFileSync(
    franchise.linksPath(12240),
    JSON.stringify({
      schemaVersion: 1,
      appid: 12240,
      wikidata: {
        qid: 'Q1318551',
        franchise: null,
        releaseYear: 2010,
        releasePrecision: 'year',
        resolved: true,
        fetchedAt: now,
      },
      franchiseKey: null,
      sources: ['wikidata'],
      fetchedAt: now,
    })
  );
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/games', createGamesRouter({ autoEnrich: false, autoPersonnel: false, autoFranchise: false }));
  app.use('/api/games', createRouter());
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

let server;
let base;

test.before(async () => {
  await seed();
  const app = buildApp();
  server = await new Promise((resolve, reject) => {
    const tryListen = (port, allowFallback) => {
      const candidate = app.listen(port, '127.0.0.1');
      candidate.once('listening', () => resolve(candidate));
      candidate.once('error', (err) => {
        // A parallel run may already hold 7069; the contract does not depend
        // on the number, only on the routes.
        if (allowFallback && err && err.code === 'EADDRINUSE') {
          tryListen(0, false);
          return;
        }
        reject(err);
      });
    };
    tryListen(PREFERRED_PORT, true);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
  franchiseJobs.resetCooldown();
});

test('GET /api/games/franchises: franchises[] + coverage + pending', async () => {
  const response = await fetch(`${base}/api/games/franchises?profile=${PROFILE}`);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('x-games-franchises-build-ms'));
  assert.equal(response.headers.get('x-games-franchises-pending'), '0');
  const body = await response.json();

  assert.equal(body.profile, PROFILE);
  assert.ok(Array.isArray(body.franchises));
  assert.equal(body.franchises.length, 1);
  const witcher = body.franchises[0];
  assert.equal(witcher.key, 'wd:Q1060747');
  assert.equal(witcher.label, 'The Witcher');
  assert.equal(witcher.labelRu, 'Ведьмак');
  assert.equal(witcher.gamesCount, 2);
  assert.equal(witcher.hoursSum, 117);
  assert.deepEqual(witcher.yearsSpread, { min: 2007, max: 2015, span: 8 });
  assert.deepEqual(witcher.appids, [292030, 20900]);
  assert.equal(witcher.source, 'wikidata');
  assert.equal(witcher.confidence, 'high');

  assert.equal(body.coverage.gamesTotal, 3);
  assert.equal(body.coverage.gamesWithFranchise, 2);
  assert.equal(body.coverage.bySource.wikidata, 2);
  assert.equal(body.coverage.links.withQid, 3);
  assert.equal(body.coverage.releaseYears.fromWikidata, 2);
  assert.equal(body.coverage.releaseYears.fromDetails, 1);
  assert.equal(body.coverage.releaseYears.unavailableDetails, 1);
  assert.equal(body.pending.wikidata, 0);
  assert.equal(body.pending.running, false);
  // WD is off in this file, so an empty pending never triggers a kick.
  assert.equal(body.pending.reason, null);
});

test('GET /franchises is strict: unknown/missing profile is a 400', async () => {
  const unknownParam = await fetch(`${base}/api/games/franchises?profile=${PROFILE}&limit=5`);
  assert.equal(unknownParam.status, 400);
  assert.equal((await unknownParam.json()).code, 'unexpected_parameter');

  const missing = await fetch(`${base}/api/games/franchises`);
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, 'profile_required');

  const notCached = await fetch(
    `${base}/api/games/franchises?profile=steam-76561198000005999`
  );
  assert.equal(notCached.status, 400);
  assert.equal((await notCached.json()).code, 'unknown_profile');
});

test('GET /game/:appid carries the cached franchise and drops links.wikidata from pending', async () => {
  const response = await fetch(`${base}/api/games/game/292030?profile=${PROFILE}`);
  assert.equal(response.status, 200);
  const card = await response.json();
  assert.equal(card.franchise.key, 'wd:Q1060747');
  assert.equal(card.franchise.label, 'The Witcher');
  assert.equal(card.franchise.labelRu, 'Ведьмак');
  assert.equal(card.franchise.source, 'wikidata');
  assert.equal(card.releaseYearWikidata, 2015);
  assert.equal(card.meta.pending.includes('links.wikidata'), false);
});

test('POST /franchise-enrich starts a job and /status reports it', async () => {
  const response = await fetch(`${base}/api/games/franchise-enrich`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile: PROFILE, force: true }),
  });
  assert.ok([200, 202].includes(response.status));
  const job = await response.json();
  assert.equal(job.job, 'games-franchise');
  assert.equal(job.profile, PROFILE);
  assert.match(job.jobId, /^games-franchise-/);

  await franchiseJobs.whenIdle();
  const statusResponse = await fetch(
    `${base}/api/games/franchise-enrich/status?id=${encodeURIComponent(job.jobId)}`
  );
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.jobId, job.jobId);
  assert.equal(status.status, 'done');
  // WD is off: an honest skip, not a fabricated franchise.
  assert.equal(status.wdSkipped, 'disabled_by_env');
  assert.equal(status.updated, 0);

  const missing = await fetch(`${base}/api/games/franchise-enrich/status?id=nope`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'unknown_job');

  const badBody = await fetch(`${base}/api/games/franchise-enrich`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(badBody.status, 400);
  assert.equal((await badBody.json()).code, 'profile_required');
});
