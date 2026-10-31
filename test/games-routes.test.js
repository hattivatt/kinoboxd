'use strict';

/**
 * `/api/games/*` routes (M1): import job → stats → per-game achievements.
 * The router is mounted on a throwaway express app with an injected fake Steam
 * client (no live requests), port 7035 per the round brief.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-routes-'));
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-routes-state-'));
// The main tree ships a dev fallback at config/steam-token; keep the assertions
// below independent of it (the "key configured" branch is covered separately).
process.env.KINOBOXD_STEAM_KEY_FILE = path.join(
  process.env.KINOBOXD_STATE_DIR,
  'no-steam-token'
);

const { createRouter } = require('../server/games/routes');
const config = require('../server/config');
const importJobs = require('../server/games/import');
const gameCache = require('../server/games/game-cache');
const { createFakeClient } = require('./fixtures/games/fake-client');

const ID = '76561198000000001';
const PROFILE_KEY = `steam-${ID}`;
const PORT = 7035;

function buildApp(client) {
  const app = express();
  app.use(express.json());
  app.use('/api/games', createRouter({ client }));
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

async function waitForJob(base, jobId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${base}/api/games/import/${jobId}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    if (body.done) return body;
    await delay(10);
  }
  throw new Error(`job ${jobId} did not finish`);
}

test('import → stats → achievements over HTTP', async (t) => {
  const client = createFakeClient({
    // One unlocked achievement with a 3.5% global rate = rare (<5%).
    global: {
      appid: 620,
      achievements: [{ name: 'ACH.SURVIVE_CONTAINER_RIDE', percent: 3.5 }],
      byName: { 'ach.survive_container_ride': 3.5, 'ACH.SURVIVE_CONTAINER_RIDE': 3.5 },
    },
  });
  const server = buildApp(client).listen(PORT);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${PORT}`;

  /* import */
  const started = await fetch(`${base}/api/games/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vanityOrId64: 'test-player', label: 'Я' }),
  });
  assert.equal(started.status, 201);
  const job = await started.json();
  assert.ok(job.jobId);
  assert.equal(job.source, 'steam');
  assert.equal(job.status, 'running');
  assert.equal(job.libraryPartial, false);

  const done = await waitForJob(base, job.jobId);
  assert.equal(done.status, 'done');
  assert.equal(done.profile, PROFILE_KEY);
  assert.equal(done.gameCount, 10);
  assert.equal(done.totalHours, 616.2);

  const byQuery = await (await fetch(`${base}/api/games/import/status?id=${job.jobId}`)).json();
  assert.equal(byQuery.jobId, job.jobId);
  assert.equal(byQuery.status, 'done');

  /* stats */
  const statsResponse = await fetch(`${base}/api/games/stats?profile=${PROFILE_KEY}`);
  assert.equal(statsResponse.status, 200);
  assert.ok(statsResponse.headers.get('x-games-build-ms'));
  const stats = await statsResponse.json();
  assert.equal(stats.sources.selected.length, 1);
  assert.equal(stats.sources.profile.key, PROFILE_KEY);
  assert.equal(stats.summary.ownedCount, 10);
  assert.equal(stats.summary.playedCount, 8);
  assert.equal(stats.summary.unplayedCount, 2);
  assert.equal(stats.summary.totalHours, 616.2);
  assert.equal(stats.summary.recent2wHours, 1.8);
  assert.equal(stats.summary.lastPlayedAt, '2026-10-29T17:34:11.000Z');
  assert.equal(stats.summary.top10HoursShare, 0.556);
  assert.equal(stats.summary.medianHours, 9.1);
  assert.equal(stats.libraryPartial, false);
  assert.equal(Object.keys(stats.gamesIndex).length, 10);

  /* profiles */
  const profiles = await (await fetch(`${base}/api/games/profiles`)).json();
  assert.equal(profiles.profiles.length, 1);
  assert.equal(profiles.availableProfileKeys[0], PROFILE_KEY);
  assert.equal(profiles.steamKey.configured, false);
  assert.equal(JSON.stringify(profiles).includes('SECRET'), false);

  /* a configured key is reported as a boolean and never echoed */
  const envSecret = 'SECRET-ENV-KEY-0123456789';
  process.env.STEAM_API_KEY = envSecret;
  config.resetSteamKeyCache();
  try {
    const withKey = await (await fetch(`${base}/api/games/profiles`)).json();
    assert.equal(withKey.steamKey.configured, true);
    assert.equal(withKey.steamKey.source, 'STEAM_API_KEY');
    assert.equal(JSON.stringify(withKey).includes(envSecret), false);
  } finally {
    delete process.env.STEAM_API_KEY;
    config.resetSteamKeyCache();
  }

  /* achievements: lazily fetched and then served from cache */
  const first = await (
    await fetch(`${base}/api/games/achievements?profile=${PROFILE_KEY}&appid=620`)
  ).json();
  assert.equal(first.unlocked, 3);
  assert.equal(first.total, 5);
  assert.equal(first.percent, 60);
  assert.equal(first.items.length, 5);
  assert.equal(first.fetched, true);
  assert.equal(first.globalAvailable, true);
  assert.equal(first.rareUnlocked, 1);
  const unlocked = first.items.filter((entry) => entry.achieved);
  assert.equal(unlocked.length, 3);
  assert.ok(unlocked.every((entry) => entry.unlockTimestamp > 0));
  const callsAfterFirst = client.calls.length;

  const second = await (
    await fetch(`${base}/api/games/achievements?profile=${PROFILE_KEY}&appid=620`)
  ).json();
  assert.equal(second.fetched, false);
  assert.equal(second.globalFetched, false);
  assert.equal(client.calls.length, callsAfterFirst);
  assert.equal(second.rareUnlocked, 1);

  /* stats now carries the achievements block + calendar */
  const stats2 = await (await fetch(`${base}/api/games/stats?profile=${PROFILE_KEY}`)).json();
  assert.equal(stats2.summary.completion.gamesWithStats, 1);
  assert.equal(stats2.summary.achievements.unlocked, 3);
  assert.equal(stats2.summary.achievements.rareUnlocked, 1);
  assert.equal(stats2.timeline.length, 1);

  /* game card */
  const card = await (await fetch(`${base}/api/games/game/620?profile=${PROFILE_KEY}`)).json();
  assert.equal(card.appid, 620);
  assert.equal(card.name, 'Portal 2');
  assert.equal(card.hours, 20.1);
  assert.equal(card.achievements.unlocked, 3);
  assert.equal(card.details, null);
  assert.match(card.links.steam, /store\.steampowered\.com\/app\/620/);

  /* cached achievements survive a cache read after the import */
  assert.ok(gameCache.getAchievements(ID, 620));
});

test('strict query contract and error mapping', async (t) => {
  const client = createFakeClient();
  // A separate port: undici keeps the previous server's socket alive briefly.
  const port = PORT + 1;
  const server = buildApp(client).listen(port);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;

  const cases = [
    [`${base}/api/games/stats`, 'profile_required'],
    [`${base}/api/games/stats?profile=steam-123`, 'invalid_profile'],
    [`${base}/api/games/stats?profile=livelib-Margaret`, 'invalid_profile'],
    [`${base}/api/games/stats?profile=${PROFILE_KEY}`, null],
    [`${base}/api/games/stats?profile=${PROFILE_KEY}&includeFree=banana`, 'invalid_includeFree'],
    [`${base}/api/games/stats?profile=${PROFILE_KEY}&sources=steam`, 'unexpected_parameter'],
    [`${base}/api/games/stats?profile=steam-76561198000000009`, 'unknown_profile'],
    [`${base}/api/games/stats?profile=${PROFILE_KEY},${PROFILE_KEY}`, 'invalid_profile'],
  ];
  for (const [url, code] of cases) {
    const response = await fetch(url);
    if (code == null) {
      assert.equal(response.status, 200, url);
      continue;
    }
    assert.equal(response.status, 400, url);
    const body = await response.json();
    assert.equal(body.code, code, url);
  }

  const unknownJob = await fetch(`${base}/api/games/import/does-not-exist`);
  assert.equal(unknownJob.status, 404);
  assert.equal((await unknownJob.json()).code, 'unknown_job');

  const missingId = await fetch(`${base}/api/games/import/status`);
  assert.equal(missingId.status, 400);
  assert.equal((await missingId.json()).code, 'job_id_required');

  const noBody = await fetch(`${base}/api/games/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(noBody.status, 400);
  assert.equal((await noBody.json()).code, 'target_required');

  const badTarget = await fetch(`${base}/api/games/import/steam`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ steamid64: '123' }),
  });
  assert.equal(badTarget.status, 400);
  assert.equal((await badTarget.json()).code, 'invalid_steamid');

  const badAppid = await fetch(
    `${base}/api/games/achievements?profile=${PROFILE_KEY}&appid=abc`
  );
  assert.equal(badAppid.status, 400);
  assert.equal((await badAppid.json()).code, 'invalid_appid');

  // Achievements may exist for an appid outside the owned library (family
  // sharing / removed games): the endpoint answers with inLibrary: false.
  const notOwned = await fetch(
    `${base}/api/games/achievements?profile=${PROFILE_KEY}&appid=999999`
  );
  assert.equal(notOwned.status, 200);
  assert.equal((await notOwned.json()).inLibrary, false);

  const unknownCard = await fetch(`${base}/api/games/game/999999?profile=${PROFILE_KEY}`);
  assert.equal(unknownCard.status, 404);
  assert.equal((await unknownCard.json()).code, 'game_not_in_library');
});


test('POST /refresh re-imports the cached profile with force', async (t) => {
  const client = createFakeClient();
  // 7037 is the round smoke port and may be taken by a dev server.
  const port = PORT + 22;
  const server = buildApp(client).listen(port);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;

  const noProfile = await fetch(`${base}/api/games/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(noProfile.status, 400);
  assert.equal((await noProfile.json()).code, 'profile_required');

  const unknown = await fetch(`${base}/api/games/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: 'steam-76561198000000009' }),
  });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).code, 'unknown_profile');

  // A manual refresh must bypass the 24 h library TTL: `force: true` in the job.
  const started = await fetch(`${base}/api/games/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: PROFILE_KEY }),
  });
  assert.equal(started.status, 201);
  const job = await started.json();
  assert.ok(job.jobId);
  assert.equal(job.force, true);
  assert.equal(job.profile, PROFILE_KEY);

  const done = await waitForJob(base, job.jobId);
  assert.equal(done.status, 'done');
  assert.equal(done.gameCount, 10);
  assert.equal(done.totalHours, 616.2);
});
