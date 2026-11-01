'use strict';

/**
 * Epic token store (M6b): 0600 file in a 0700 directory, atomic secret write
 * (no world-readable temp window), symlink refusal, mode repair, redaction.
 * The token value is never asserted in a public shape — only presence/expiry.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-epic-tokens-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-epic-tokens-state-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = STATE_DIR;

const tokenStore = require('../server/games/epic-token-store');

const ACCOUNT = 'epic-account-1';

function modeOf(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

function tokenDoc(overrides = {}) {
  return {
    accountId: ACCOUNT,
    displayName: 'EpicTester',
    ownerKey: 'steam-76561198000000001',
    accessToken: 'eg1~fake-access-token-AAA',
    refreshToken: 'eg1~fake-refresh-token-BBB',
    accessExpiresAt: '2026-11-01T12:00:00.000Z',
    refreshExpiresAt: '2026-11-02T00:00:00.000Z',
    tokenType: 'bearer',
    ...overrides,
  };
}

test('token file is 0600 inside a 0700 directory and round-trips', async () => {
  const redacted = await tokenStore.saveTokens(tokenDoc());
  assert.equal(redacted.accountId, ACCOUNT);
  assert.equal(redacted.hasAccessToken, true);
  assert.equal(redacted.hasRefreshToken, true);
  assert.equal(redacted.accessExpiresAt, '2026-11-01T12:00:00.000Z');
  assert.equal(JSON.stringify(redacted).includes('fake-access-token'), false);
  assert.equal(JSON.stringify(redacted).includes('fake-refresh-token'), false);

  const filePath = tokenStore.tokenPath(ACCOUNT);
  assert.equal(modeOf(filePath), 0o600);
  assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);

  const doc = await tokenStore.getTokens(ACCOUNT);
  assert.equal(doc.accessToken, 'eg1~fake-access-token-AAA');
  assert.equal(doc.refreshToken, 'eg1~fake-refresh-token-BBB');
  assert.equal(doc.ownerKey, 'steam-76561198000000001');
  assert.equal(doc.schemaVersion, 1);

  // No temp files left behind.
  const leftovers = fs
    .readdirSync(path.dirname(filePath))
    .filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('overwrite stays 0600 and updates the document', async () => {
  await tokenStore.saveTokens(tokenDoc({ accessToken: 'eg1~second-access-token' }));
  const filePath = tokenStore.tokenPath(ACCOUNT);
  assert.equal(modeOf(filePath), 0o600);
  const doc = await tokenStore.getTokens(ACCOUNT);
  assert.equal(doc.accessToken, 'eg1~second-access-token');
});

test('a token file chmod-ed to 0644 is repaired on read', async () => {
  const filePath = tokenStore.tokenPath(ACCOUNT);
  fs.chmodSync(filePath, 0o644);
  assert.equal(modeOf(filePath), 0o644);
  const doc = await tokenStore.getTokens(ACCOUNT);
  assert.ok(doc);
  assert.equal(modeOf(filePath), 0o600);
});

test('a symlink at the token path is not read', async () => {
  const account = 'epic-symlink-read';
  const victim = path.join(CACHE_DIR, 'victim.json');
  fs.writeFileSync(
    victim,
    JSON.stringify(tokenDoc({ accountId: account, accessToken: 'eg1~victim-token' }))
  );
  const linkPath = tokenStore.tokenPath(account);
  fs.symlinkSync(victim, linkPath);
  const doc = await tokenStore.getTokens(account);
  assert.equal(doc, null);
  fs.unlinkSync(linkPath);
});

test('writing through a planted symlink replaces the link, not the target', async () => {
  const account = 'epic-symlink-write';
  const victim = path.join(CACHE_DIR, 'victim-write.txt');
  fs.writeFileSync(victim, 'do not overwrite');
  const linkPath = tokenStore.tokenPath(account);
  fs.symlinkSync(victim, linkPath);

  await tokenStore.saveTokens(tokenDoc({ accountId: account, accessToken: 'eg1~safe-token' }));

  assert.equal(fs.readFileSync(victim, 'utf8'), 'do not overwrite');
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), false);
  assert.equal(modeOf(linkPath), 0o600);
  const doc = await tokenStore.getTokens(account);
  assert.equal(doc.accessToken, 'eg1~safe-token');
});

test('delete removes the file and is idempotent', async () => {
  assert.equal(await tokenStore.deleteTokens(ACCOUNT), true);
  assert.equal(await tokenStore.getTokens(ACCOUNT), null);
  assert.equal(await tokenStore.deleteTokens(ACCOUNT), false);
});

test('invalid account ids are rejected (no path traversal)', async () => {
  assert.throws(() => tokenStore.tokenPath('../etc/passwd'), /accountId/i);
  await assert.rejects(
    tokenStore.saveTokens(tokenDoc({ accountId: '../escape' })),
    /accountId/i
  );
});
