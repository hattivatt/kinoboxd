'use strict';

/**
 * Epic device-code auth sessions (M6b): pending → authorized, token file 0600,
 * owner binding, expiry/failure states, and the guarantee that the device code
 * and tokens never leave the server in the public session shape.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-epic-auth-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-epic-auth-state-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = STATE_DIR;
process.env.KINOBOXD_GAMES_WD = 'off';

const epicAuth = require('../server/games/epic-auth');
const epicCache = require('../server/games/epic-cache');
const tokenStore = require('../server/games/epic-token-store');

const ACCOUNT = 'epic-account-auth-1';
const OWNER = 'steam-76561198000000001';
const OTHER_OWNER = 'steam-76561198000000002';

function future(ms = 7200000) {
  return new Date(Date.now() + ms).toISOString();
}

function authorizedTokens(accountId = ACCOUNT) {
  return {
    accountId,
    displayName: 'EpicAuthTester',
    accessToken: 'eg1~auth-access-token',
    refreshToken: 'eg1~auth-refresh-token',
    accessExpiresAt: future(),
    refreshExpiresAt: future(14400000),
    tokenType: 'bearer',
    clientId: 'fake-client',
  };
}

function createAuthClient(sequence) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async deviceAuthorization() {
      calls.push('deviceAuthorization');
      return {
        deviceCode: 'device-code-secret',
        userCode: 'ABCD-1234',
        verificationUri: 'https://www.epicgames.com/id/activate',
        verificationUriComplete: 'https://www.epicgames.com/id/activate?userCode=ABCD-1234',
        expiresIn: 300,
        intervalMs: 5000,
      };
    },
    async exchangeDeviceCode(deviceCode) {
      calls.push(`poll:${deviceCode}`);
      const result = sequence[Math.min(index, sequence.length - 1)];
      index++;
      return typeof result === 'function' ? result() : result;
    },
  };
}

test('pending session exposes the user code/URL, never the device code', async () => {
  epicAuth._reset();
  const client = createAuthClient([{ status: 'pending' }]);
  const session = await epicAuth.startDeviceAuth({
    ownerKey: OWNER,
    client,
    autoPoll: false,
    autoImport: false,
  });
  assert.equal(session.status, 'pending');
  assert.equal(session.userCode, 'ABCD-1234');
  assert.match(session.verificationUriComplete, /userCode=ABCD-1234/);
  assert.equal(session.owner, OWNER);
  assert.equal(session.expiresIn > 0, true);
  assert.equal(Object.prototype.hasOwnProperty.call(session, 'deviceCode'), false);
  assert.equal(JSON.stringify(session).includes('device-code-secret'), false);

  const pending = await epicAuth.pollSession(session.authId);
  assert.equal(pending.status, 'pending');
  assert.equal(client.calls.length, 2);
});

test('authorized session stores the token 0600 and binds the Epic account to the owner', async () => {
  epicAuth._reset();
  const client = createAuthClient([
    { status: 'authorized', tokens: authorizedTokens() },
  ]);
  const session = await epicAuth.startDeviceAuth({
    ownerKey: OWNER,
    label: 'Я',
    client,
    autoPoll: false,
    autoImport: false,
  });
  const authorized = await epicAuth.pollSession(session.authId);
  assert.equal(authorized.status, 'authorized');
  assert.equal(authorized.accountId, ACCOUNT);
  assert.equal(authorized.displayName, 'EpicAuthTester');
  assert.equal(authorized.importJobId, null);
  assert.equal(JSON.stringify(authorized).includes('eg1~auth-access-token'), false);
  assert.equal(JSON.stringify(authorized).includes('eg1~auth-refresh-token'), false);

  const doc = await tokenStore.getTokens(ACCOUNT);
  assert.ok(doc);
  assert.equal(doc.accessToken, 'eg1~auth-access-token');
  assert.equal(doc.ownerKey, OWNER);
  const filePath = tokenStore.tokenPath(ACCOUNT);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);

  const profile = epicCache.getEpicProfile(ACCOUNT);
  assert.equal(profile.ownerKey, OWNER);
  assert.equal(profile.label, 'Я');
  assert.equal(profile.authMethod, 'device_code');

  // The device code is dropped once the token arrives.
  const after = epicAuth.getSession(session.authId);
  assert.equal(JSON.stringify(after).includes('device-code-secret'), false);
});

test('an expired device code ends the session as expired', async () => {
  epicAuth._reset();
  const client = createAuthClient([{ status: 'expired', code: 'epic_auth_expired' }]);
  const session = await epicAuth.startDeviceAuth({
    ownerKey: OWNER,
    client,
    autoPoll: false,
    autoImport: false,
  });
  const result = await epicAuth.pollSession(session.authId);
  assert.equal(result.status, 'expired');
  assert.equal(result.code, 'epic_auth_expired');
});

test('owner_mismatch is a failed session and does not overwrite the other owner', async () => {
  epicAuth._reset();
  const otherAccount = 'epic-account-auth-2';
  await epicCache.saveEpicProfile({
    accountId: otherAccount,
    displayName: 'Other',
    ownerKey: OTHER_OWNER,
  });
  await tokenStore.saveTokens({
    accountId: otherAccount,
    accessToken: 'eg1~other-access',
    refreshToken: 'eg1~other-refresh',
    accessExpiresAt: future(),
    refreshExpiresAt: future(14400000),
    ownerKey: OTHER_OWNER,
  });
  const client = createAuthClient([
    { status: 'authorized', tokens: authorizedTokens(otherAccount) },
  ]);
  const session = await epicAuth.startDeviceAuth({
    ownerKey: OWNER,
    client,
    autoPoll: false,
    autoImport: false,
  });
  const result = await epicAuth.pollSession(session.authId);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'owner_mismatch');

  const doc = await tokenStore.getTokens(otherAccount);
  assert.equal(doc.accessToken, 'eg1~other-access');
  assert.equal(doc.ownerKey, OTHER_OWNER);
  const profile = epicCache.getEpicProfile(otherAccount);
  assert.equal(profile.ownerKey, OTHER_OWNER);
});

test('a second Epic account for the same owner is refused (no library sum)', async () => {
  epicAuth._reset();
  const second = 'epic-account-auth-3';
  await assert.rejects(
    (async () => {
      epicAuth.assertOwnerBinding(second, OWNER);
    })(),
    (err) => err.code === 'owner_mismatch'
  );
});

test('cancel stops a pending session', async () => {
  epicAuth._reset();
  const client = createAuthClient([{ status: 'pending' }]);
  const session = await epicAuth.startDeviceAuth({
    ownerKey: OWNER,
    client,
    autoPoll: false,
    autoImport: false,
  });
  assert.equal(epicAuth.cancelSession(session.authId), true);
  const cancelled = epicAuth.getSession(session.authId);
  assert.equal(cancelled.status, 'failed');
  assert.equal(cancelled.code, 'epic_auth_cancelled');
});

test('authorized login kicks the library import automatically', async () => {
  epicAuth._reset();
  const { createFakeEpicClient } = require('./fixtures/games/epic/fake-client');
  const epicImport = require('../server/games/epic-import');
  const client = createFakeEpicClient({ accountId: ACCOUNT });
  client.deviceAuthorization = async () => ({
    deviceCode: 'device-code-secret',
    userCode: 'WXYZ-9876',
    verificationUri: 'https://www.epicgames.com/id/activate',
    verificationUriComplete: 'https://www.epicgames.com/id/activate?userCode=WXYZ-9876',
    expiresIn: 300,
    intervalMs: 5000,
  });
  client.exchangeDeviceCode = async () => ({
    status: 'authorized',
    tokens: authorizedTokens(),
  });
  const session = await epicAuth.startDeviceAuth({
    ownerKey: OWNER,
    client,
    autoPoll: false,
    autoImport: true,
  });
  const result = await epicAuth.pollSession(session.authId);
  assert.equal(result.status, 'authorized');
  assert.ok(result.importJobId);
  await epicImport.whenIdle();
  const job = epicImport.getStatus(result.importJobId);
  assert.equal(job.status, 'done');
  assert.equal(job.gameCount, 4);
  assert.equal(job.totalHours, 10.5);
});

