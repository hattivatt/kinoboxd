'use strict';

/**
 * GOG connect + import jobs (M6a): owner binding, token refresh, library and
 * playtime snapshots, budget, honest auth degradation. A fake client is
 * injected — no HTTP, no real account.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-gog-import-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-gog-import-state-'));

const gameCache = require('../server/games/game-cache');
const gogCache = require('../server/games/gog-cache');
const gogImport = require('../server/games/gog-import');
const gog = require('../server/games/gog');

const STEAM_ID = '76561198000000001';
const OWNER = `steam-${STEAM_ID}`;
const USER_KEY = '1234567890';

const PRODUCTS = [
  { gogGameId: '1207658924', title: 'The Witcher 3', slug: 'the_witcher_3_wild_hunt', category: 'game', isGame: true, isMovie: false },
  { gogGameId: '1423049311', title: 'Cyberpunk 2077', slug: 'cyberpunk_2077', category: 'game', isGame: true, isMovie: false },
  { gogGameId: '1999999999', title: 'GOG Exclusive', slug: 'gog_exclusive', category: 'game', isGame: true, isMovie: false },
  { gogGameId: '1888888888', title: 'A GOG Movie', slug: 'a_gog_movie', category: 'movie', isGame: false, isMovie: true },
];

function fakeApi(overrides = {}) {
  const calls = { sessions: [], refresh: 0, fetchAll: 0 };
  const api = {
    calls,
    async exchangeCode(code) {
      if (code === 'bad') throw new gog.GogError('bad code', 'gog_invalid_code');
      return {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        userId: USER_KEY,
      };
    },
    async getUserData() {
      return {
        userKey: USER_KEY,
        username: 'gog_tester',
        galaxyUserId: '555',
        country: 'US',
        avatar: 'https://example.test/a.png',
      };
    },
    async refresh(refreshToken) {
      calls.refresh += 1;
      if (refreshToken === 'dead') throw new gog.GogError('dead', 'gog_auth_expired');
      return {
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
    },
    async fetchAllProducts() {
      calls.fetchAll += 1;
      return {
        products: PRODUCTS,
        pages: [1, 2],
        totalPages: 2,
        totalProducts: PRODUCTS.length,
        productsPerPage: 100,
        complete: true,
      };
    },
    async getSessions(tokenDoc, gogGameId) {
      calls.sessions.push(gogGameId);
      if (gogGameId === '1207658924') return { gogGameId, minutes: 1200, found: true };
      if (gogGameId === '1423049311') return { gogGameId, minutes: 600, found: true };
      return { gogGameId, minutes: 90, found: true };
    },
    ...overrides,
  };
  return api;
}

async function waitForJob(jobId) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = gogImport.getStatus(jobId);
    if (status && status.done) return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`GOG job ${jobId} did not finish`);
}

async function seedSteam(label = 'Me') {
  await gameCache.saveProfile({
    userKey: STEAM_ID,
    personaName: 'tester',
    ownerLabel: label,
    importedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
  });
}

test('GOG connect + import', async (t) => {
  await seedSteam();

  await t.test('connect binds the sole Steam owner and stores a 0600 token', async () => {
    const result = await gogImport.connect({ code: 'ok', client: fakeApi() });
    assert.equal(result.connected, undefined);
    assert.equal(result.account.userKey, USER_KEY);
    assert.equal(result.account.ownerProfile, OWNER);
    assert.equal(result.tokenStored, true);
    assert.equal(JSON.stringify(result).includes('access-1'), false);
    assert.equal(JSON.stringify(result).includes('refresh-1'), false);
    const file = gogCache.tokenPath(USER_KEY);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(gogCache.getToken(USER_KEY).ownerProfile, OWNER);
  });

  await t.test('a second GOG account for the same owner is a 400, not a sum', async () => {
    const other = fakeApi({
      async exchangeCode() {
        return {
          accessToken: 'access-x',
          refreshToken: 'refresh-x',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          userId: '9999999999',
        };
      },
      async getUserData() {
        return { userKey: '9999999999', username: 'other' };
      },
    });
    await assert.rejects(
      () => gogImport.connect({ code: 'ok', profile: OWNER, client: other }),
      (err) => err.code === 'gog_already_connected'
    );
  });

  await t.test('two Steam owners without an explicit profile is owner_required', async () => {
    await gameCache.saveProfile({
      userKey: '76561198000000002',
      personaName: 'second',
      importedAt: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    });
    const other = fakeApi({
      async exchangeCode() {
        return {
          accessToken: 'access-y',
          refreshToken: 'refresh-y',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          userId: '8888888888',
        };
      },
      async getUserData() {
        return { userKey: '8888888888', username: 'third' };
      },
    });
    await assert.rejects(
      () => gogImport.connect({ code: 'ok', client: other }),
      (err) => err.code === 'owner_required'
    );
  });

  await t.test('a GOG account cannot be moved to another owner (owner_mismatch)', async () => {
    await assert.rejects(
      () => gogImport.connect({ code: 'ok', profile: 'steam-76561198000000002', client: fakeApi() }),
      (err) => err.code === 'owner_mismatch'
    );
  });

  await t.test('import writes the library and playtime; movies get no sessions request', async () => {
    const api = fakeApi();
    const job = gogImport.startImport({ account: `gog-${USER_KEY}`, client: api, force: true, budget: 200 });
    const status = await waitForJob(job.jobId);
    assert.equal(status.status, 'done');
    assert.equal(status.libraryCount, 4);
    assert.equal(status.playtimeGames, 3);
    assert.deepEqual(api.calls.sessions.sort(), ['1207658924', '1423049311', '1999999999']);
    const library = gogCache.getLibrary(USER_KEY);
    assert.equal(library.products.length, 4);
    assert.equal(library.fingerprint, PRODUCTS.map((p) => p.gogGameId).join(','));
    const playtime = gogCache.getPlaytime(USER_KEY);
    assert.equal(playtime.minutes['1207658924'], 1200);
    assert.equal(playtime.minutes['1423049311'], 600);
    assert.equal(playtime.minutes['1999999999'], 90);
    assert.equal(playtime.minutes['1888888888'], undefined);
    assert.equal(playtime.budgetExceeded, false);
  });

  await t.test('budget stops playtime early and says so', async () => {
    const api = fakeApi();
    const job = gogImport.startImport({ account: USER_KEY, client: api, force: true, budget: 1 });
    const status = await waitForJob(job.jobId);
    assert.equal(status.status, 'done');
    assert.equal(status.budgetExceeded, true);
    assert.equal(api.calls.sessions.length, 1);
    assert.ok(status.playtimePending >= 1);
    const playtime = gogCache.getPlaytime(USER_KEY);
    assert.equal(playtime.budgetExceeded, true);
    assert.ok(playtime.pendingGames >= 1);
  });

  await t.test('an expired access token is refreshed before the import', async () => {
    const current = gogCache.getToken(USER_KEY);
    gogCache.saveToken(USER_KEY, {
      ...current,
      accessToken: 'old',
      refreshToken: 'refresh-1',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const api = fakeApi();
    const token = await gogImport.ensureAccessToken(USER_KEY, api);
    assert.equal(token.accessToken, 'access-2');
    assert.equal(api.calls.refresh, 1);
    assert.equal(gogCache.getToken(USER_KEY).refreshToken, 'refresh-2');
  });

  await t.test('a dead refresh is auth_expired and the snapshot is kept', async () => {
    const current = gogCache.getToken(USER_KEY);
    gogCache.saveToken(USER_KEY, {
      ...current,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      refreshToken: 'dead',
    });
    await assert.rejects(
      () => gogImport.ensureAccessToken(USER_KEY, fakeApi()),
      (err) => err.code === 'gog_auth_expired'
    );
    assert.ok(gogCache.getLibrary(USER_KEY));
  });

  await t.test('a playtime 401 fails the job with auth_expired but keeps the library', async () => {
    const api = fakeApi({
      async getSessions() {
        throw new gog.GogError('401', 'gog_auth_expired');
      },
    });
    // Give the account a valid token again so the job reaches playtime.
    const current = gogCache.getToken(USER_KEY);
    gogCache.saveToken(USER_KEY, {
      ...current,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const job = gogImport.startImport({ account: USER_KEY, client: api, force: true });
    const status = await waitForJob(job.jobId);
    assert.equal(status.status, 'failed');
    assert.equal(status.code, 'gog_auth_expired');
    assert.ok(gogCache.getLibrary(USER_KEY));
  });

  await t.test('playtimeTargets skips movies, DLC and hidden rows', () => {
    const targets = gogImport.playtimeTargets([
      { gogGameId: '1', isGame: true },
      { gogGameId: '2', isMovie: true },
      { gogGameId: '3', category: 'dlc' },
      { gogGameId: '4', isHidden: true },
      { gogGameId: '5', isGame: false },
      { gogGameId: '6' },
    ]);
    assert.deepEqual(targets.map((row) => row.gogGameId), ['1', '6']);
  });
});
