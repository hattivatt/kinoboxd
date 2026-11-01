'use strict';

/**
 * GOG cache (M6a): token storage invariants, sanitized public views, snapshot
 * layout. The token is a secret: the file is 0600 inside a 0700 directory and
 * the API-facing view never carries `accessToken`/`refreshToken`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-gog-cache-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-gog-cache-state-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = STATE_DIR;

const gogCache = require('../server/games/gog-cache');

const USER_KEY = '1234567890';

test('GOG cache', async (t) => {
  await t.test('token file is 0600 inside a 0700 directory', () => {
    gogCache.saveToken(USER_KEY, {
      accessToken: 'secret-access',
      refreshToken: 'secret-refresh',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      username: 'gog_tester',
      ownerProfile: `steam-76561198000000001`,
      connectedAt: new Date().toISOString(),
    });
    const file = gogCache.tokenPath(USER_KEY);
    assert.ok(file.startsWith(CACHE_DIR));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(gogCache.getToken(USER_KEY).refreshToken, 'secret-refresh');
  });

  await t.test('public view drops both tokens but keeps identity/expiry', () => {
    const view = gogCache.publicTokenView(gogCache.getToken(USER_KEY));
    assert.equal(view.userKey, USER_KEY);
    assert.equal(view.username, 'gog_tester');
    assert.equal(view.ownerProfile, 'steam-76561198000000001');
    assert.equal(Object.prototype.hasOwnProperty.call(view, 'accessToken'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(view, 'refreshToken'), false);
    const serialized = JSON.stringify(view);
    assert.equal(serialized.includes('secret-access'), false);
    assert.equal(serialized.includes('secret-refresh'), false);
  });

  await t.test('listAccounts/listTokens are sanitized and owner-scoped', () => {
    const accounts = gogCache.listAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(JSON.stringify(accounts).includes('secret-access'), false);
    assert.equal(gogCache.accountsForOwner('steam-76561198000000001').length, 1);
    assert.equal(gogCache.accountsForOwner('steam-76561198000000002').length, 0);
    // listTokens is the internal raw view (used only by the importer).
    assert.equal(gogCache.listTokens()[0].accessToken, 'secret-access');
  });

  await t.test('profile/library/playtime snapshots keep source + userKey', () => {
    gogCache.saveProfile({ userKey: USER_KEY, username: 'gog_tester' });
    gogCache.saveLibrary(USER_KEY, {
      fetchedAt: new Date().toISOString(),
      products: [{ gogGameId: '1', title: 'Game' }],
      fingerprint: '1',
    });
    gogCache.savePlaytime(USER_KEY, {
      fetchedAt: new Date().toISOString(),
      minutes: { 1: 60 },
      fetchedGames: 1,
    });
    assert.equal(gogCache.getProfile(USER_KEY).source, 'gog');
    assert.equal(gogCache.getLibrary(USER_KEY).products[0].gogGameId, '1');
    assert.equal(gogCache.getPlaytime(USER_KEY).minutes['1'], 60);
    assert.equal(gogCache.listLibraries().length, 1);
    // Steam files are untouched by the GOG module.
    assert.equal(fs.existsSync(path.join(CACHE_DIR, 'library', 'steam-1.json')), false);
  });

  await t.test('userKey parsing accepts uid and gog-<uid>, rejects path traversal', () => {
    assert.equal(gogCache.userKeyOf('123'), '123');
    assert.equal(gogCache.userKeyOf('gog-123'), '123');
    assert.equal(gogCache.userKeyOf('../etc/passwd'), null);
    assert.equal(gogCache.isValidUserKey('12a'), false);
  });

  await t.test('a GOG profile is never listed as a Steam owner', async () => {
    const gameCache = require('../server/games/game-cache');
    await gameCache.saveProfile({
      userKey: '76561198000000001',
      personaName: 'steam_owner',
      importedAt: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    });
    gogCache.saveProfile({ userKey: USER_KEY, username: 'gog_tester' });
    const keys = gameCache.listProfiles().map((entry) => entry.key);
    assert.deepEqual(keys, ['steam-76561198000000001']);
    assert.equal(keys.includes(`steam-${USER_KEY}`), false);
  });

  await t.test('deleteToken removes the secret but leaves the dated snapshot', () => {
    assert.equal(gogCache.deleteToken(USER_KEY), true);
    assert.equal(gogCache.getToken(USER_KEY), null);
    assert.equal(gogCache.deleteToken(USER_KEY), false);
    assert.ok(gogCache.getLibrary(USER_KEY));
  });
});
