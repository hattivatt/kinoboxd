'use strict';

/**
 * Games cache (M1): atomic writes, fingerprints, TTLs, state dir.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-cache-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-state-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = STATE_DIR;

const gameCache = require('../server/games/game-cache');

function tmpFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  } catch (err) {
    return [];
  }
}

test('profile: save, read, list, atomic write', async () => {
  const saved = await gameCache.saveProfile({
    userKey: '76561198000000001',
    personaName: 'tester',
    avatarUrl: 'https://example.test/a.jpg',
    privacy: 'public',
    importedAt: '2026-11-01T00:00:00.000Z',
    fetchedAt: '2026-11-01T00:00:00.000Z',
  });
  assert.equal(saved.data.key, 'steam-76561198000000001');
  assert.equal(saved.data.schemaVersion, 1);
  assert.ok(saved.fingerprint);

  const profile = gameCache.getProfile('76561198000000001');
  assert.equal(profile.personaName, 'tester');
  assert.equal(profile.source, 'steam');

  const byKey = gameCache.getProfileByKey('steam-76561198000000001');
  assert.equal(byKey.userKey, '76561198000000001');

  const list = gameCache.listProfiles();
  assert.equal(list.length, 1);
  assert.equal(list[0].key, 'steam-76561198000000001');
  assert.equal(list[0].personaName, 'tester');

  assert.deepEqual(tmpFiles(gameCache.PROFILES_DIR), []);
});

test('library: snapshot round-trip and fingerprint change on rewrite', async () => {
  const library = {
    fetchedAt: '2026-11-01T00:00:00.000Z',
    partial: false,
    game_count: 2,
    games: [
      { appid: 1, name: 'One', playtime_forever: 60, rtime_last_played: 1 },
      { appid: 2, name: 'Two', playtime_forever: 0, rtime_last_played: 0 },
    ],
    totalMinutes: 60,
    fingerprint: 'abc',
  };
  const first = await gameCache.saveLibrary('76561198000000001', library);
  const read = gameCache.getLibrary('76561198000000001');
  assert.equal(read.game_count, 2);
  assert.equal(read.games.length, 2);

  const second = await gameCache.saveLibrary('76561198000000001', { ...library, game_count: 3 });
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.deepEqual(tmpFiles(gameCache.LIBRARY_DIR), []);
});

test('achievements and global percentages are cached per game', async () => {
  await gameCache.saveAchievements('76561198000000001', 620, {
    fetchedAt: '2026-11-01T00:00:00.000Z',
    gameName: 'Portal 2',
    unlockedCount: 3,
    totalCount: 5,
    achievements: [],
  });
  await gameCache.saveAchievements('76561198000000001', 70, {
    fetchedAt: '2026-11-01T00:00:00.000Z',
    gameName: 'Half-Life',
    unlockedCount: 0,
    totalCount: 0,
    achievements: [],
  });
  const one = gameCache.getAchievements('76561198000000001', 620);
  assert.equal(one.gameName, 'Portal 2');
  assert.equal(one.source, 'steam-community');
  const all = gameCache.listAchievements('76561198000000001');
  assert.equal(all.length, 2);
  assert.equal(gameCache.getAchievements('76561198000000001', 999), null);

  await gameCache.saveGlobal(620, {
    fetchedAt: '2026-11-01T00:00:00.000Z',
    achievements: [{ name: 'ACH.WAKE_UP', percent: 64.7 }],
    byName: { 'ACH.WAKE_UP': 64.7, 'ach.wake_up': 64.7 },
  });
  const global = gameCache.getGlobal(620);
  assert.equal(global.byName['ACH.WAKE_UP'], 64.7);
  assert.equal(gameCache.getGlobal(999), null);
});

test('isFresh honours the TTL and rejects invalid timestamps', () => {
  const now = Date.now();
  const doc = { fetchedAt: new Date(now - 1000).toISOString() };
  assert.equal(gameCache.isFresh(doc, 60_000), true);
  assert.equal(gameCache.isFresh(doc, 500), false);
  assert.equal(gameCache.isFresh({ fetchedAt: 'not a date' }, 60_000), false);
  assert.equal(gameCache.isFresh(null, 60_000), false);
  // importedAt is the fallback field for the profile document.
  assert.equal(
    gameCache.isFresh({ importedAt: new Date(now - 1000).toISOString() }, 60_000),
    true
  );
});

test('profile tokens: only steam-<17 digits> is valid', () => {
  assert.deepEqual(gameCache.parseProfileToken('steam-76561198000000001'), {
    source: 'steam',
    userKey: '76561198000000001',
    key: 'steam-76561198000000001',
  });
  assert.equal(gameCache.parseProfileToken('steam-123'), null);
  assert.equal(gameCache.parseProfileToken('livelib-Margaret'), null);
  assert.equal(gameCache.parseProfileToken(''), null);
  assert.equal(gameCache.profileKeyOf('76561198000000001'), 'steam-76561198000000001');
});

test('safeKey blocks path traversal', () => {
  assert.equal(gameCache.safeKey('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(gameCache.safeKey('76561198000000001'), '76561198000000001');
  assert.ok(gameCache.achievementPath('../../x', '../y').startsWith(gameCache.ACHIEVEMENTS_DIR));
});

test('breaker state is persisted under KINOBOXD_STATE_DIR/games', () => {
  gameCache.writeBreaker({ 'steamcommunity.com': { until: 123, reason: 'HTTP 429' } });
  assert.ok(gameCache.BREAKER_PATH.startsWith(path.join(STATE_DIR, 'games')));
  const state = gameCache.readBreaker();
  assert.equal(state['steamcommunity.com'].until, 123);
  assert.equal(fs.existsSync(gameCache.BREAKER_PATH), true);
});
