'use strict';

/**
 * `/api/games/epic/*` routes (M6b) over HTTP: device-code session, status,
 * import, exported contract, disconnect, strict query parameters and error
 * mapping. Fake client + fake auth sequence; no live request (§14.5).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-epic-routes-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-epic-routes-state-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = STATE_DIR;
process.env.KINOBOXD_GAMES_WD = 'off';

const { createRouter } = require('../server/games/routes-epic');
const gameCache = require('../server/games/game-cache');
const epicCache = require('../server/games/epic-cache');
const epicImport = require('../server/games/epic-import');
const epicAuth = require('../server/games/epic-auth');
const tokenStore = require('../server/games/epic-token-store');
const { createFakeEpicClient } = require('./fixtures/games/epic/fake-client');

const ACCOUNT = 'epic-account-1';
const STEAM_ID = '76561198000000001';
const OWNER = `steam-${STEAM_ID}`;
const { portFor } = require('./helpers/port');
const PORT = portFor(130);

function future(ms = 7200000) {
  return new Date(Date.now() + ms).toISOString();
}

function buildClient() {
  const client = createFakeEpicClient();
  let poll = 0;
  client.deviceAuthorization = async () => ({
    deviceCode: 'device-code-secret',
    userCode: 'ABCD-1234',
    verificationUri: 'https://www.epicgames.com/id/activate',
    verificationUriComplete: 'https://www.epicgames.com/id/activate?userCode=ABCD-1234',
    expiresIn: 300,
    intervalMs: 0,
  });
  client.exchangeDeviceCode = async () => {
    poll++;
    if (poll === 1) return { status: 'pending' };
    return {
      status: 'authorized',
      tokens: {
        accountId: ACCOUNT,
        displayName: 'EpicTester',
        accessToken: 'eg1~routes-access-token',
        refreshToken: 'eg1~routes-refresh-token',
        accessExpiresAt: future(),
        refreshExpiresAt: future(14400000),
        tokenType: 'bearer',
        clientId: 'fake-client',
      },
    };
  };
  return client;
}

function buildApp(client) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/games',
    createRouter({
      client,
      autoPoll: false,
      autoImport: false,
      pollOnStatus: true,
    })
  );
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

async function getJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { status: response.status, body };
}

test('device-code auth → status → import → exported → disconnect', async (t) => {
  await gameCache.saveProfile({
    userKey: STEAM_ID,
    personaName: 'SteamTester',
    privacy: 'public',
    importedAt: future(),
    fetchedAt: future(),
  });
  await gameCache.saveLibrary(STEAM_ID, {
    fetchedAt: future(),
    partial: false,
    game_count: 5,
    games: [{ appid: 1, name: 'Steam One', playtime_forever: 6000 }],
    totalMinutes: 6000,
    fingerprint: 'steam-fp',
  });

  const client = buildClient();
  const server = buildApp(client).listen(PORT);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${PORT}/api/games/epic`;

  /* auth start */
  const started = await getJson(`${base}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner: OWNER, label: 'Я' }),
  });
  assert.equal(started.status, 201);
  assert.equal(started.body.status, 'pending');
  assert.equal(started.body.userCode, 'ABCD-1234');
  assert.equal(JSON.stringify(started.body).includes('device-code-secret'), false);
  assert.equal(JSON.stringify(started.body).includes('eg1~'), false);
  const authId = started.body.authId;

  /* pending poll, then authorized poll (intervalMs=0 in the fake) */
  const pending = await getJson(`${base}/auth/${authId}`);
  assert.equal(pending.status, 200);
  assert.equal(pending.body.status, 'pending');

  const authorized = await getJson(`${base}/auth/${authId}`);
  assert.equal(authorized.body.status, 'authorized');
  assert.equal(authorized.body.accountId, ACCOUNT);
  assert.equal(JSON.stringify(authorized.body).includes('eg1~routes-access-token'), false);
  assert.equal(JSON.stringify(authorized.body).includes('eg1~routes-refresh-token'), false);
  assert.equal(fs.statSync(tokenStore.tokenPath(ACCOUNT)).mode & 0o777, 0o600);

  /* status before the library import */
  const beforeImport = await getJson(`${base}/status?owner=${encodeURIComponent(OWNER)}`);
  assert.equal(beforeImport.status, 200);
  assert.equal(beforeImport.body.status, 'not_imported');
  assert.deepEqual(beforeImport.body.hoursBySource, { steam: 100, epic: null });
  assert.equal(Object.prototype.hasOwnProperty.call(beforeImport.body, 'games'), false);

  /* import */
  const importStarted = await getJson(`${base}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner: OWNER }),
  });
  assert.equal(importStarted.status, 201);
  await epicImport.whenIdle();
  const job = await getJson(`${base}/import/${importStarted.body.jobId}`);
  assert.equal(job.status, 200);
  assert.equal(job.body.status, 'done');
  assert.equal(job.body.gameCount, 4);
  assert.equal(job.body.totalHours, 10.5);

  /* status after import: split hours, no per-game dump */
  const status = await getJson(`${base}/status?owner=${encodeURIComponent(OWNER)}`);
  assert.equal(status.body.status, 'ok');
  assert.equal(status.body.summary.hours, 10.5);
  assert.equal(status.body.summary.ownedCount, 4);
  assert.deepEqual(status.body.hoursBySource, { steam: 100, epic: 10.5 });
  assert.deepEqual(status.body.ownedBySource, { steam: 5, epic: 4 });
  assert.equal(Object.prototype.hasOwnProperty.call(status.body, 'games'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(status.body, 'exportedGames'), false);

  /* exported contract for M6c */
  const exported = await getJson(`${base}/exported?owner=${encodeURIComponent(OWNER)}`);
  assert.equal(exported.status, 200);
  assert.equal(exported.body.contractVersion, 1);
  assert.equal(exported.body.games.length, 4);
  const witcher = exported.body.games.find(
    (game) => game.catalogItemId === '9d2d0eb64d5c44529cece33fe2a46482'
  );
  assert.equal(witcher.slug, 'the-witcher-3-wild-hunt');
  assert.equal(witcher.totalTimeSec, 36000);
  assert.equal(witcher.totalMinutes, 600);
  assert.equal(witcher.workKey, null);
  assert.equal(witcher.steamAppId, null);
  assert.equal(JSON.stringify(exported.body).includes('eg1~routes-access-token'), false);

  /* global status: configured, redacted tokens only */
  const global = await getJson(`${base}/status`);
  assert.equal(global.status, 200);
  assert.equal(global.body.configured, true);
  assert.equal(global.body.accounts.length, 1);
  assert.equal(global.body.tokens.length, 1);
  assert.equal(global.body.tokens[0].hasAccessToken, true);
  assert.equal(JSON.stringify(global.body).includes('eg1~routes-access-token'), false);

  /* strict query contract */
  const extra = await getJson(`${base}/status?foo=1`);
  assert.equal(extra.status, 400);
  assert.equal(extra.body.code, 'unexpected_parameter');

  /* unknown owner is a 400 before a job */
  const unknownOwner = await getJson(`${base}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner: 'steam-00000000000000000' }),
  });
  assert.equal(unknownOwner.status, 400);
  assert.equal(unknownOwner.body.code, 'unknown_owner');

  /* disconnect: local token gone, snapshot kept and labelled */
  const disconnected = await getJson(`${base}/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner: OWNER }),
  });
  assert.equal(disconnected.status, 200);
  assert.equal(disconnected.body.disconnected, true);
  assert.equal(disconnected.body.snapshotKept, true);
  assert.equal(await tokenStore.getTokens(ACCOUNT), null);

  const afterDisconnect = await getJson(`${base}/status?owner=${encodeURIComponent(OWNER)}`);
  assert.equal(afterDisconnect.body.status, 'not_connected');
  assert.equal(afterDisconnect.body.summary.hours, 10.5);
  assert.ok(afterDisconnect.body.meta.fetchedAt);
});

test('auth without an imported Steam owner is a 400', async (t) => {
  epicAuth._reset();
  const client = buildClient();
  const server = buildApp(client).listen(portFor(131));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${portFor(131)}/api/games/epic`;
  const response = await getJson(`${base}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner: 'steam-00000000000000000' }),
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'unknown_owner');
});

test('exported requires owner or accountId', async (t) => {
  epicAuth._reset();
  const client = buildClient();
  const server = buildApp(client).listen(portFor(132));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${portFor(132)}/api/games/epic`;
  const response = await getJson(`${base}/exported`);
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'owner_required');
});

test('cache module is reachable and epic profiles are listable', () => {
  const profiles = epicCache.listEpicProfiles();
  assert.ok(Array.isArray(profiles));
  assert.equal(epicCache.CACHE_DIR, CACHE_DIR);
});

test('authorization-code connect over HTTP: auth-url → connect → code required', async (t) => {
  epicAuth._reset();
  const steamId = '76561198000000009';
  const owner = `steam-${steamId}`;
  await gameCache.saveProfile({
    userKey: steamId,
    personaName: 'SecondSteam',
    privacy: 'public',
    importedAt: future(),
    fetchedAt: future(),
  });
  const client = createFakeEpicClient({ accountId: 'epic-account-2' });
  const server = buildApp(client).listen(portFor(135));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${portFor(135)}/api/games/epic`;

  const info = await getJson(`${base}/auth-url`);
  assert.equal(info.status, 200);
  assert.match(info.body.url, /^https:\/\/www\.epicgames\.com\/id\/login\?redirectUrl=/);
  assert.match(info.body.url, /responseType%3Dcode/);
  assert.match(info.body.instructions, /code/);
  assert.ok(['env', 'file', 'default'].includes(info.body.clientSource));
  // The client id is public and lives in the redirect; the secret never does.
  const decoded = decodeURIComponent(info.body.url);
  assert.match(decoded, /\/id\/api\/redirect\?clientId=[A-Za-z0-9-]{5,}&responseType=code/);

  const connected = await getJson(`${base}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner,
      code: 'https://www.epicgames.com/id/api/redirect?code=one-time-code',
    }),
  });
  assert.equal(connected.status, 200);
  assert.equal(connected.body.connected, true);
  assert.equal(connected.body.accountId, 'epic-account-2');
  assert.equal(connected.body.owner, owner);
  assert.equal(connected.body.authMethod, 'authorization_code');
  assert.equal(JSON.stringify(connected.body).includes('eg1~'), false);
  assert.equal(JSON.stringify(connected.body).includes('one-time-code'), false);
  assert.ok(client.calls.includes('code:https://www.epicgames.com/id/api/redirect?code=one-time-code'));

  const missing = await getJson(`${base}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner }),
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'epic_code_required');

  const extra = await getJson(`${base}/connect?foo=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner, code: 'one-time-code' }),
  });
  assert.equal(extra.status, 400);
  assert.equal(extra.body.code, 'unexpected_parameter');

  const after = await getJson(`${base}/status?owner=${encodeURIComponent(owner)}`);
  assert.equal(after.status, 200);
  assert.equal(after.body.account.accountId, 'epic-account-2');
});
