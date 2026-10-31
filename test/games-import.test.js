'use strict';

/**
 * Steam import job (M1): stages, partial mode without a key, errors,
 * idempotent re-import and key masking.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-import-'));
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-import-state-'));

const steam = require('../server/games/steam');
const gameCache = require('../server/games/game-cache');
const importJobs = require('../server/games/import');
const { createFakeClient } = require('./fixtures/games/fake-client');

const ID = '76561198000000001';

test('full import: profile XML + summaries + one GetOwnedGames call', async () => {
  const client = createFakeClient();
  const job = importJobs.startImport('test-player', { client });
  assert.equal(job.status, 'running');
  assert.equal(job.stage, 'queued');
  assert.equal(job.done, false);

  await importJobs.whenIdle();
  const status = importJobs.getStatus(job.jobId);
  assert.equal(status.status, 'done');
  assert.equal(status.stage, 'done');
  assert.equal(status.done, true);
  assert.equal(status.profile, `steam-${ID}`);
  assert.equal(status.libraryPartial, false);
  assert.equal(status.code, null);
  assert.equal(status.error, null);
  assert.equal(status.requests, 3);
  assert.equal(status.gameCount, 10);
  assert.equal(status.ownedCount, 10);
  assert.equal(status.totalMinutes, 36973);
  assert.equal(status.totalHours, 616.2);
  assert.equal(status.playedCount, 8);
  assert.equal(status.backlogCount, 2);
  assert.deepEqual(client.calls, ['profile', 'summaries', 'owned']);

  const profile = gameCache.getProfile(ID);
  assert.equal(profile.personaName, 'test-player');
  assert.equal(profile.privacy, 'public');
  assert.equal(profile.lastLogOff, 1793295403);
  assert.equal(profile.timeCreated, 1298134151);
  assert.equal(profile.customUrl, 'test-player');

  const library = gameCache.getLibrary(ID);
  assert.equal(library.partial, false);
  assert.equal(library.game_count, 10);
  assert.equal(library.games.length, 10);
  assert.equal(library.source, 'steam-webapi');
  assert.equal(library.fingerprint, steam.libraryFingerprint(library.games, 10));
  assert.ok(library.fetchedAt);
});

test('a repeat import reuses the fresh snapshot without touching Steam', async () => {
  const client = createFakeClient();
  const job = importJobs.startImport(ID, { client });
  assert.equal(job.status, 'done');
  assert.equal(job.reused, true);
  assert.equal(job.requests, 0);
  assert.equal(job.gameCount, 10);
  assert.deepEqual(client.calls, []);
});

test('force bypasses the reuse window', async () => {
  const client = createFakeClient();
  const job = importJobs.startImport(ID, { client, force: true });
  assert.equal(job.reused, false);
  await importJobs.whenIdle();
  assert.equal(importJobs.getStatus(job.jobId).status, 'done');
  assert.equal(client.calls.length, 3);
});

test('concurrent requests coalesce into one running job', async () => {
  const client = createFakeClient();
  const first = importJobs.startImport(ID, { client, force: true });
  const second = importJobs.startImport(ID, { client, force: true });
  assert.equal(second.jobId, first.jobId);
  await importJobs.whenIdle();
  assert.equal(importJobs.getStatus(first.jobId).status, 'done');
});

test('no key → libraryPartial with the most recent games, not a failed job', async () => {
  const client = createFakeClient({ key: null });
  const job = importJobs.startImport(ID, { client, force: true });
  await importJobs.whenIdle();
  const status = importJobs.getStatus(job.jobId);
  assert.equal(status.status, 'done');
  assert.equal(status.libraryPartial, true);
  assert.equal(status.code, 'steam_key_missing');
  assert.ok(status.warning);
  assert.equal(status.gameCount, null);
  assert.equal(status.ownedCount, 2); // trimmed fixture has two most-recent games
  assert.equal(status.totalMinutes, 828 + 108); // 13.8 h + 1.8 h
  assert.deepEqual(client.calls, ['profile']);

  const library = gameCache.getLibrary(ID);
  assert.equal(library.partial, true);
  assert.equal(library.game_count, null);
  assert.equal(library.source, 'steam-profile-xml');
  assert.equal(library.games.length, 2);
});

test('private profile fails with profile_private and is not cached', async () => {
  const profile = steam.parseProfileXml(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'games', 'profile.xml'), 'utf8')
  );
  const client = createFakeClient({
    profile: { ...profile, steamId64: '76561198000000009', privacyState: 'private' },
  });
  const job = importJobs.startImport('76561198000000009', { client });
  await importJobs.whenIdle();
  const status = importJobs.getStatus(job.jobId);
  assert.equal(status.status, 'failed');
  assert.equal(status.stage, 'failed');
  assert.equal(status.code, 'profile_private');
  assert.match(status.error, /приватност/i);
  assert.equal(gameCache.getProfile('76561198000000009'), null);
});

test('empty GetOwnedGames is library_private, not "0 games"', async () => {
  const client = createFakeClient({
    owned: { empty: true, gameCount: 0, games: [], totalMinutes: 0, fingerprint: null },
  });
  const job = importJobs.startImport(ID, { client, force: true });
  await importJobs.whenIdle();
  const status = importJobs.getStatus(job.jobId);
  assert.equal(status.status, 'failed');
  assert.equal(status.code, 'library_private');
});

test('invalid targets throw synchronously (route answers 400)', () => {
  assert.throws(() => importJobs.startImport('123'), (err) => err.code === 'invalid_steamid');
  assert.throws(() => importJobs.startImport(''), (err) => err.code === 'invalid_steamid');
});

test('the API key never reaches the job status or the logs', async () => {
  const secret = 'SECRETKEY0123456789';
  const client = createFakeClient({ key: secret });
  client.getOwnedGames = async () => {
    throw new steam.SteamError(
      `Steam Web API ответил 500: https://api.steampowered.com/x?key=${secret}&steamid=1`,
      'steam_http_error'
    );
  };
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const job = importJobs.startImport(ID, { client, force: true });
    await importJobs.whenIdle();
    const status = importJobs.getStatus(job.jobId);
    assert.equal(status.status, 'failed');
    assert.equal(status.code, 'steam_http_error');
    assert.equal(status.error.includes(secret), false);
    assert.match(status.error, /key=\*\*\*/);
    assert.equal(status.keySource, 'test');
    assert.equal(JSON.stringify(status).includes(secret), false);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.equal(logs.join('\n').includes(secret), false);
});
