'use strict';

/**
 * P0/s (defensive): Steam may not hand over a library that belongs to another
 * owner than the one that was asked for.
 *
 * The community profile XML is the authoritative owner: `profiles/<id64>/`
 * echoes the requested steamid64. If it ever answers a different one (a
 * redirect, a broken vanity, a proxy), the `GetOwnedGames` snapshot that
 * follows would be attributed to the wrong person — the one thing the games
 * model forbids (ИГРЫ §2.0: two owners are never merged). The import fails with
 * `steamid_mismatch` and caches nothing, so the tab cannot show foreign hours.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-mismatch-'));
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-mismatch-state-'));
process.env.KINOBOXD_GAMES_WD = 'off';

const steam = require('../server/games/steam');
const gameCache = require('../server/games/game-cache');
const importJobs = require('../server/games/import');
const { createFakeClient } = require('./fixtures/games/fake-client');

const REQUESTED = '76561198000000009';
const ANSWERED = '76561198000000077';

function profileFixture(overrides = {}) {
  const base = steam.parseProfileXml(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'games', 'profile.xml'), 'utf8')
  );
  return { ...base, ...overrides };
}

test('a profile XML that answers another steamid64 fails the import and caches nothing', async () => {
  const client = createFakeClient();
  // The fake client echoes the requested id64 (like the real endpoint); here we
  // need the pathological answer: a DIFFERENT owner than the one asked for.
  client.getProfile = async () => profileFixture({ steamId64: ANSWERED });
  const job = importJobs.startImport(REQUESTED, { client, force: true });
  await importJobs.whenIdle();
  const status = importJobs.getStatus(job.jobId);

  assert.equal(status.status, 'failed');
  assert.equal(status.code, 'steamid_mismatch');
  assert.match(status.error, new RegExp(REQUESTED));
  assert.match(status.error, new RegExp(ANSWERED));
  assert.equal(status.ownedCount, null, 'the library was never read');
  assert.equal(client.calls.includes('owned'), false, 'no GetOwnedGames for a foreign owner');

  assert.equal(gameCache.getProfile(REQUESTED), null);
  assert.equal(gameCache.getProfile(ANSWERED), null);
  assert.equal(gameCache.getLibrary(REQUESTED), null);
  assert.equal(gameCache.getLibrary(ANSWERED), null);
});

test('a vanity import takes the owner Steam resolves (no mismatch: nothing was claimed)', async () => {
  const client = createFakeClient();
  client.getProfile = async () => profileFixture({ steamId64: ANSWERED });
  const job = importJobs.startImport('some-vanity', { client, force: true });
  await importJobs.whenIdle();
  const status = importJobs.getStatus(job.jobId);

  assert.equal(status.status, 'done');
  assert.equal(status.profile, `steam-${ANSWERED}`);
  assert.equal(gameCache.getProfile(ANSWERED).userKey, ANSWERED);
});
