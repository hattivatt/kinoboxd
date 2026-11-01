'use strict';

/**
 * P3: a vanity import job must name the OWNER, not the string that was typed.
 *
 * `startImport('some-vanity')` used to keep `targetKey = 'vanity:some-vanity'`
 * for the whole run, while the profile is `steam-<steamid64>`. Everything that
 * asks «is an import running for this profile?» (`isRunning('steam-…')`) missed
 * the job until it finished. Now the resolved key replaces the vanity one and
 * the vanity stays as an alias, so coalescing still works both ways.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-targetkey-'));
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-targetkey-state-'));
process.env.KINOBOXD_GAMES_WD = 'off';

const steam = require('../server/games/steam');
const importJobs = require('../server/games/import');
const { createFakeClient, readFixture } = require('./fixtures/games/fake-client');

const ID = steam.parseProfileXml(readFixture('profile.xml')).steamId64;
const PROFILE_KEY = `steam-${ID}`;
const VANITY = 'test-player';

function gatedClient() {
  const client = createFakeClient();
  const owned = client.getOwnedGames.bind(client);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  client.getOwnedGames = async (steamId64) => {
    await gate;
    return owned(steamId64);
  };
  return { client, release };
}

test('the running vanity job answers isRunning("steam-<id64>") and still coalesces', async () => {
  const { client, release } = gatedClient();
  const job = importJobs.startImport(VANITY, { client, force: true });
  assert.equal(job.status, 'running');

  // The profile stage has resolved the owner by now (the library is gated).
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(importJobs.isRunning(PROFILE_KEY), true, 'the job is known by the owner key');
  assert.equal(importJobs.isRunning(`vanity:${VANITY}`), true, 'the vanity stays an alias');

  // A second import — by vanity or by steamid64 — coalesces into the same job.
  const again = importJobs.startImport(VANITY, { client, force: true });
  const byId = importJobs.startImport(ID, { client, force: true });
  assert.equal(again.jobId, job.jobId);
  assert.equal(byId.jobId, job.jobId);

  release();
  await importJobs.whenIdle();
  const status = importJobs.getStatus(job.jobId);
  assert.equal(status.status, 'done');
  assert.equal(status.profile, PROFILE_KEY);
  assert.equal(importJobs.isRunning(PROFILE_KEY), false, 'a finished job is no longer running');
});
