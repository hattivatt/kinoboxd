'use strict';

/**
 * M4 enrich phases: `details` | `spy` | `reviews` | `all`.
 *
 * The details phase keeps its M2 contract (top-level job fields, one state
 * file), while tags and reviews get their own budgets, TTLs, cache documents
 * and journals. A failure in one phase must not swallow the others.
 * No network: every client is injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-phases-'));
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-phases-state-'));

const gameCache = require('../server/games/game-cache');
const enrich = require('../server/games/enrich');
const { createRouter } = require('../server/games/routes');
const { createFakeClient } = require('./fixtures/games/fake-client');

let nextBase = 700000;
function appidRange(count) {
  const base = nextBase;
  nextBase += 100;
  return Array.from({ length: count }, (_, index) => base + index);
}

function detailDoc(appid) {
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
    release_date: { date: '1 Jan, 2015', coming_soon: false, year: 2015, month: 1, day: 1, precision: 'day' },
    releaseYear: 2015,
    releasePrecision: 'day',
    dlc: [],
    dlcCount: 0,
    metacritic: null,
    platforms: { windows: true, mac: false, linux: false },
    screenshots: [],
    earlyAccess: false,
    metadataSource: 'steam-store',
  };
}

function spyDoc(appid) {
  return {
    appid,
    success: true,
    unavailable: false,
    name: `Game ${appid}`,
    tags: [
      { name: 'Action', weight: 900 },
      { name: 'Indie', weight: 500 },
    ],
    metadataSource: 'steamspy',
  };
}

function reviewDoc(appid) {
  return {
    appid,
    success: true,
    unavailable: false,
    score: 9,
    desc: 'Overwhelmingly Positive',
    positive: 1000,
    negative: 10,
    total: 1010,
    metadataSource: 'steam-reviews',
  };
}

function fakeClient(kind, options = {}) {
  const calls = [];
  const fail = options.fail || {};
  const method =
    kind === 'details' ? 'getAppDetails' : kind === 'spy' ? 'getAppTags' : 'getAppReviews';
  const doc = kind === 'details' ? detailDoc : kind === 'spy' ? spyDoc : reviewDoc;
  return {
    calls,
    async [method](appid) {
      calls.push(appid);
      if (fail[appid]) {
        const err = new Error(`${kind} failed for ${appid}`);
        err.code = fail[appid];
        throw err;
      }
      return doc(appid);
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

async function runJob(profileKey, clients, options = {}) {
  const started = enrich.startEnrich(profileKey, { ...clients, ...options });
  await enrich.whenIdle();
  return enrich.getStatus(started.jobId);
}

test('parsePhases: all/spy/list/aliases, canonical order, honest 400 on typos', () => {
  assert.deepEqual(enrich.parsePhases('all'), ['details', 'spy', 'reviews']);
  assert.deepEqual(enrich.parsePhases('spy'), ['spy']);
  assert.deepEqual(enrich.parsePhases('reviews,spy'), ['spy', 'reviews']);
  assert.deepEqual(enrich.parsePhases(['reviews', 'details']), ['details', 'reviews']);
  assert.deepEqual(enrich.parsePhases('tags,appreviews'), ['spy', 'reviews']);
  assert.deepEqual(enrich.parsePhases(null, 'all'), ['details', 'spy', 'reviews']);
  assert.deepEqual(enrich.parsePhases('', 'spy'), ['spy']);
  assert.deepEqual(enrich.parsePhases(null), ['details']);
  assert.throws(
    () => enrich.parsePhases('spy,dlc'),
    (err) => {
      assert.equal(err.code, 'invalid_phases');
      assert.equal(err.status, 400);
      assert.match(err.message, /"dlc"/);
      return true;
    }
  );
});

test('phases: spy only writes spy/<appid>.json and its own state file', async () => {
  const appids = appidRange(3);
  const profile = await seedProfile('76561198000000201', appids);
  const details = fakeClient('details');
  const spyClient = fakeClient('spy');
  const reviewsClient = fakeClient('reviews');
  const status = await runJob(
    profile,
    { client: details, spyClient, reviewsClient },
    { phases: 'spy', spyBudget: 100 }
  );

  assert.deepEqual(status.phasesRequested, ['spy']);
  assert.deepEqual(spyClient.calls, appids);
  assert.deepEqual(details.calls, []);
  assert.deepEqual(reviewsClient.calls, []);
  assert.equal(status.phases.spy.status, 'done');
  assert.equal(status.phases.spy.ok, 3);
  assert.equal(status.phases.spy.resolved, 3);
  assert.equal(status.phases.spy.percent, 100);
  assert.equal(status.phases.details, undefined);
  // Legacy details fields stay neutral, not invented.
  assert.equal(status.detailsResolved, null);
  assert.equal(status.selected, null);

  for (const appid of appids) {
    const doc = gameCache.getSpy(appid);
    assert.equal(doc.success, true);
    assert.ok(doc.fetchedAt);
    assert.equal(doc.tags.length, 2);
    assert.equal(gameCache.getDetails(appid), null);
    assert.equal(gameCache.getReviews(appid), null);
  }
  const spyState = gameCache.readSpyState();
  assert.equal(spyState.runs.length, 1);
  assert.equal(spyState.runs[0].phase, 'spy');
  assert.equal(spyState.runs[0].source, 'steamspy');
  assert.equal(spyState.runs[0].resolved, 3);
  assert.equal(spyState.profiles[profile].attempted.length, 3);
  // The details journal was not touched by a spy run.
  assert.equal(gameCache.readEnrichState().runs.length, 0);
  assert.equal(gameCache.readReviewsState().runs.length, 0);
});

test('phases: all runs details → spy → reviews, each with its own journal', async () => {
  const appids = appidRange(2);
  const profile = await seedProfile('76561198000000202', appids);
  const details = fakeClient('details');
  const spyClient = fakeClient('spy');
  const reviewsClient = fakeClient('reviews');
  const status = await runJob(
    profile,
    { client: details, spyClient, reviewsClient },
    { phases: 'all', budget: 100, spyBudget: 100, reviewsBudget: 100 }
  );

  assert.deepEqual(status.phasesRequested, ['details', 'spy', 'reviews']);
  assert.deepEqual(Object.keys(status.phases), ['details', 'spy', 'reviews']);
  assert.equal(status.status, 'done');
  assert.equal(status.stage, 'done');
  assert.equal(status.percent, 100);
  // Legacy details contract survives.
  assert.equal(status.selected, 2);
  assert.equal(status.ok, 2);
  assert.equal(status.requests, 2);
  assert.equal(status.detailsResolved, 2);
  assert.equal(status.detailsPercent, 100);
  assert.equal(status.phases.spy.requests, 2);
  assert.equal(status.phases.reviews.requests, 2);
  assert.equal(status.phases.reviews.resolved, 2);

  assert.deepEqual(details.calls, appids);
  assert.deepEqual(spyClient.calls, appids);
  assert.deepEqual(reviewsClient.calls, appids);
  assert.equal(gameCache.getDetails(appids[0]).type, 'game');
  assert.equal(gameCache.getSpy(appids[0]).tags.length, 2);
  assert.equal(gameCache.getReviews(appids[0]).score, 9);
  assert.equal(gameCache.readEnrichState().runs[0].detailsResolved, 2);
  assert.equal(gameCache.readSpyState().runs[0].phase, 'spy');
  assert.equal(gameCache.readReviewsState().runs[0].phase, 'reviews');
});

test('budgets are per phase: a spy slice does not spend the details budget', async () => {
  const appids = appidRange(4);
  const profile = await seedProfile('76561198000000203', appids);
  const details = fakeClient('details');
  const spyClient = fakeClient('spy');
  const first = await runJob(
    profile,
    { client: details, spyClient },
    { phases: 'details,spy', budget: 1, spyBudget: 2 }
  );
  assert.equal(first.phases.details.selected, 1);
  assert.equal(first.phases.details.budgetLimit, 1);
  assert.equal(first.phases.spy.selected, 2);
  assert.equal(first.phases.spy.remaining, 2);
  assert.equal(first.phases.spy.budgetLimit, 2);
  assert.equal(details.calls.length, 1);
  assert.equal(spyClient.calls.length, 2);

  const second = await runJob(
    profile,
    { client: fakeClient('details'), spyClient: fakeClient('spy') },
    { phases: 'spy', spyBudget: 2 }
  );
  assert.equal(second.phases.spy.selected, 2);
  assert.equal(second.phases.spy.remaining, 0);
  assert.equal(second.phases.spy.resolved, 4);
});

test('a systemic spy failure stops the spy phase only; details/reviews still run', async () => {
  const appids = appidRange(3);
  const profile = await seedProfile('76561198000000204', appids);
  const details = fakeClient('details');
  const reviewsClient = fakeClient('reviews');
  const spyClient = fakeClient('spy', { fail: { [appids[0]]: 'spy_unreachable' } });
  const status = await runJob(
    profile,
    { client: details, spyClient, reviewsClient },
    { phases: 'all', budget: 100, spyBudget: 100, reviewsBudget: 100 }
  );
  assert.equal(status.status, 'done');
  assert.equal(status.phases.details.ok, 3);
  assert.equal(status.phases.spy.deferred, 1);
  assert.equal(status.phases.spy.stoppedBy, 'spy_unreachable');
  assert.deepEqual(spyClient.calls, [appids[0]]);
  assert.equal(status.phases.reviews.ok, 3);
  assert.ok(status.errors.includes('spy_unreachable'));
  assert.equal(gameCache.getSpy(appids[0]), null);
  // Reviews and details were not affected by the spy breaker.
  assert.equal(gameCache.getReviews(appids[0]).success, true);
  assert.equal(gameCache.getDetails(appids[0]).success, true);
});

test('force re-fetches every requested phase, freshness is otherwise the progress', async () => {
  const appids = appidRange(2);
  const profile = await seedProfile('76561198000000205', appids);
  await runJob(
    profile,
    { spyClient: fakeClient('spy') },
    { phases: 'spy', spyBudget: 100 }
  );
  const fresh = await runJob(
    profile,
    { spyClient: fakeClient('spy') },
    { phases: 'spy', spyBudget: 100 }
  );
  assert.equal(fresh.phases.spy.selected, 0);
  assert.equal(fresh.phases.spy.skippedFresh, 2);
  assert.equal(fresh.phases.spy.resolved, 2);

  const forcedClient = fakeClient('spy');
  const forced = await runJob(
    profile,
    { spyClient: forcedClient },
    { phases: 'spy', spyBudget: 100, force: true }
  );
  assert.equal(forced.force, true);
  assert.equal(forced.phases.spy.selected, 2);
  assert.deepEqual(forcedClient.calls, appids);
});

/* ------------------------------------------------------------------ */
/* HTTP contract                                                       */
/* ------------------------------------------------------------------ */

function buildApp(clients) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/games',
    createRouter({
      client: createFakeClient(),
      autoEnrich: false,
      autoPersonnel: false,
      ...clients,
    })
  );
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: 'internal', code: 'internal_error' });
  });
  return app;
}

const PORT = 7070;

test('POST /enrich defaults to all phases; phases is accepted; typos are 400', async (t) => {
  const appids = appidRange(2);
  const profile = await seedProfile('76561198000000206', appids);
  const details = fakeClient('details');
  const spyClient = fakeClient('spy');
  const reviewsClient = fakeClient('reviews');
  const server = buildApp({ storeClient: details, spyClient, reviewsClient }).listen(PORT + 2);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${PORT + 2}`;

  const response = await fetch(`${base}/api/games/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile }),
  });
  assert.equal(response.status, 202);
  const job = await response.json();
  assert.deepEqual(job.phasesRequested, ['details', 'spy', 'reviews']);

  // Poll to the end.
  let done = job;
  for (let attempt = 0; attempt < 200 && !done.done; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    done = await (
      await fetch(`${base}/api/games/enrich/status?id=${job.jobId}`)
    ).json();
  }
  assert.equal(done.done, true);
  assert.equal(done.phases.spy.resolved, 2);
  assert.equal(done.phases.reviews.resolved, 2);

  const spyOnly = await fetch(`${base}/api/games/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile, phases: 'spy', force: true }),
  });
  assert.equal(spyOnly.status, 202);
  const spyJob = await spyOnly.json();
  assert.deepEqual(spyJob.phasesRequested, ['spy']);

  const bad = await fetch(`${base}/api/games/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile, phases: 'spy,hl3' }),
  });
  assert.equal(bad.status, 400);
  const badBody = await bad.json();
  assert.equal(badBody.code, 'invalid_phases');
});
