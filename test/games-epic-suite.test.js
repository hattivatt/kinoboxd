'use strict';

/**
 * Games: Epic source client, tokens and GOG profile binding suite: the former standalone `*.test.js` files of this domain,
 * merged into one process (R19 test-suite consolidation).
 *
 * Each block below is its original file, kept verbatim inside its own
 * `describe()`:
 *
 *   - the describe title is the file stem, so every test stays greppable as
 *     `<file> > <original title>`;
 *   - the block scope keeps a file's helper names from colliding with its
 *     neighbours;
 *   - the hooks a file declared (`test.before`/`test.after`/
 *     `test.beforeEach`) stay scoped to that block instead of applying to the
 *     whole process.
 *
 * The tmp root is one `helpers/env` run for the whole suite, created BEFORE
 * any `server/**` require (every cache namespace reads its root once, at load
 * time). A file's own tmp setup folds into that root — the module singletons
 * are process-wide anyway, so a second root would only desynchronise a file
 * from the directory its assertions read. Tests keep apart by `userKey`/work
 * key, never by root.
 *
 * `env.cleanupTmpDirs()` removes every directory this run created.
 */

const { describe, after, before } = require('node:test');
const env = require('./helpers/env');

const run = env.makeTmpCache('games-epic-suite', { budgets: false });

after(() => {
  env.cleanupTmpDirs();
});

process.on('exit', () => {
  env.cleanupTmpDirs();
});


describe('games-gog-auth', () => {
  /**
   * GOG auth lifecycle (01.11.2026 fix): silent refresh, one expiry unit, honest
   * status reasons and the masked `auth-lifecycle.json` trail.
   *
   * The production loop: the access token lives ≈1 h, the refresh token much
   * longer. The old status block treated «access token past» as «подключите GOG
   * заново», so one hour after a successful import (93 games, snapshot on disk)
   * the UI asked for a reconnect; reconnecting «fixed» it for another hour.
   *
   * Pinned here:
   *   - `expiresAt` is milliseconds, always (`expires_in` seconds → ms once);
   *   - an expired-but-refreshable token is NOT a reconnect;
   *   - a token with no refresh token, or a terminal refresh failure, IS;
   *   - every token-needing call refreshes silently inside a 5-minute buffer and
   *     retries **once** after a 401/302;
   *   - a refresh failure never touches the library snapshot;
   *   - the dump has the diagnostic shape and no token value.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const CACHE_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const gameCache = require('../server/games/game-cache');
  const gogCache = require('../server/games/gog-cache');
  const gog = require('../server/games/gog');
  const gogAuth = require('../server/games/gog-auth');
  const gogImport = require('../server/games/gog-import');
  const { buildGamesStatsFromCache } = require('../server/games/stats');

  const STEAM_ID = '76561198000000021';
  const OWNER = `steam-${STEAM_ID}`;
  const USER_KEY = '1234567890';
  const ACCESS = 'secret-access-token';
  const REFRESH = 'secret-refresh-token';

  const HOUR = 3600 * 1000;
  const MIN = 60 * 1000;

  function isoIn(ms) {
    return new Date(Date.now() + ms).toISOString();
  }

  function saveToken(extra = {}) {
    gogCache.saveToken(USER_KEY, {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: isoIn(HOUR),
      username: 'gog_tester',
      ownerProfile: OWNER,
      connectedAt: new Date().toISOString(),
      ...extra,
    });
    return gogCache.getToken(USER_KEY);
  }

  /** A fake client: `refresh` counts calls and can be told to fail. */
  function fakeApi(overrides = {}) {
    const calls = { refresh: 0, sessions: [], userData: 0 };
    return {
      calls,
      async refresh(refreshToken) {
        calls.refresh += 1;
        if (overrides.refresh) return overrides.refresh(refreshToken, calls);
        return {
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
          expiresAt: isoIn(HOUR),
          userId: USER_KEY,
        };
      },
      async getUserData() {
        calls.userData += 1;
        return { userKey: USER_KEY, username: 'gog_tester', galaxyUserId: '5555555555' };
      },
      async getSessions(tokenDoc, gogGameId) {
        calls.sessions.push({ gogGameId, accessToken: tokenDoc && tokenDoc.accessToken });
        if (overrides.getSessions) return overrides.getSessions(tokenDoc, gogGameId);
        return { gogGameId, minutes: 120, found: true, status: 'ok', field: 'time_sum' };
      },
      async fetchAllProducts() {
        return {
          products: [{ gogGameId: '1207658924', title: 'The Witcher 3', category: 'game' }],
          pages: [1],
          totalPages: 1,
          totalProducts: 1,
          productsPerPage: 100,
          complete: true,
        };
      },
    };
  }

  async function waitForJob(jobId) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const status = gogImport.getStatus(jobId);
      if (status && status.done) return status;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`GOG job ${jobId} did not finish`);
  }

  test('GOG auth lifecycle', async (t) => {
    await gameCache.saveProfile({
      userKey: STEAM_ID,
      personaName: 'tester',
      ownerLabel: 'Me',
      importedAt: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    });
    await gameCache.saveLibrary(STEAM_ID, {
      fetchedAt: new Date().toISOString(),
      games: [{ appid: 292030, name: 'The Witcher 3', playtime_forever: 60 }],
      fingerprint: '292030',
    });

    await t.test('expiresAt: ONE unit (ms) with a tolerant reader', () => {
      const now = Date.UTC(2026, 10, 1, 12, 0, 0);
      const seconds = Math.floor(now / 1000) + 3600;
      assert.equal(gogCache.parseExpiresAt(seconds), (seconds) * 1000);
      assert.equal(gogCache.parseExpiresAt(seconds * 1000), seconds * 1000);
      assert.equal(gogCache.parseExpiresAt(new Date(now).toISOString()), now);
      assert.ok(Number.isNaN(gogCache.parseExpiresAt('not-a-date')));
      assert.ok(Number.isNaN(gogCache.parseExpiresAt(null)));
      // `expires_in` is seconds (OAuth2); a value that cannot be seconds is ms.
      assert.equal(gogCache.expiresInMs(3600), HOUR);
      assert.equal(gogCache.expiresInMs('3600'), HOUR);
      assert.equal(gogCache.expiresInMs(HOUR), HOUR);
      assert.equal(gogCache.expiresInMs(0), null);
      assert.equal(gogCache.expiresInMs(null), null);
    });

    await t.test('a 1 h token from /token is valid for ≥59 min (ms, not seconds)', async () => {
      const api = fakeApi();
      const client = gog.createClient({
        request: async () => ({
          status: 200,
          headers: {},
          body: JSON.stringify({
            access_token: ACCESS,
            refresh_token: REFRESH,
            expires_in: 3600,
            user_id: USER_KEY,
          }),
        }),
        now: () => Date.now(),
      });
      const tokens = await client.exchangeCode('code');
      const remaining = Date.parse(tokens.expiresAt) - Date.now();
      assert.ok(remaining > 59 * MIN, `remaining ${remaining} ms must be > 59 min`);
      assert.ok(remaining <= HOUR + 5000);
      assert.equal(tokens.expiresInMs, HOUR);
      // A seconds-vs-ms mix-up would put the expiry in 1970 (negative remaining).
      const state = gogCache.authStateOf({ ...tokens, userKey: USER_KEY }, { marginMs: MIN });
      assert.equal(state.status, 'valid');
      assert.equal(state.needsReconnect, false);
      assert.ok(state.expiresInMs > 59 * MIN);
      void api;
    });

    await t.test('authStateOf names the reason (buffer / failure / no refresh)', () => {
      const doc = saveToken({ expiresAt: isoIn(HOUR) });
      assert.equal(gogCache.authStateOf(doc).status, 'valid');
      // expired-by-buffer: silent refresh is due, the account is still connected
      const expiring = gogCache.authStateOf(saveToken({ expiresAt: isoIn(4 * MIN) }));
      assert.equal(expiring.status, 'expiring');
      assert.equal(expiring.needsReconnect, false);
      assert.equal(expiring.refreshable, true);
      // access token past, refresh token present → refreshable, never reconnect
      const expired = gogCache.authStateOf(saveToken({ expiresAt: isoIn(-HOUR) }));
      assert.equal(expired.status, 'expired');
      assert.equal(expired.expired, true);
      assert.equal(expired.needsReconnect, false);
      // expired with nothing to refresh with → reconnect
      const noRefresh = gogCache.authStateOf(
        saveToken({ expiresAt: isoIn(-HOUR), refreshToken: null })
      );
      assert.equal(noRefresh.status, 'no_refresh_token');
      assert.equal(noRefresh.needsReconnect, true);
      // expired-by-failure: the last /token answer was terminal → reconnect
      const failed = gogCache.authStateOf(
        saveToken({
          expiresAt: isoIn(-HOUR),
          lastRefreshError: { code: 'gog_auth_expired', description: 'Invalid refresh token', at: isoIn(-MIN) },
        })
      );
      assert.equal(failed.status, 'refresh_failed');
      assert.equal(failed.needsReconnect, true);
      // A client/network problem is NOT the user's fault: no reconnect demand.
      const transient = gogCache.authStateOf(
        saveToken({
          expiresAt: isoIn(-HOUR),
          lastRefreshError: { code: 'gog_client_rejected', description: 'invalid_client', at: isoIn(-MIN) },
        })
      );
      assert.equal(transient.needsReconnect, false);
      assert.equal(transient.refreshable, true);
    });

    await t.test('ensureFreshToken refreshes inside the 5-min buffer and persists', async () => {
      saveToken({ expiresAt: isoIn(2 * MIN) });
      const api = fakeApi();
      const { doc, refreshed } = await gogAuth.ensureFreshToken(USER_KEY, api);
      assert.equal(refreshed, true);
      assert.equal(api.calls.refresh, 1);
      assert.equal(doc.accessToken, 'access-2');
      assert.ok(Date.parse(doc.expiresAt) > Date.now() + 59 * MIN);
      assert.ok(doc.refreshedAt);
      const stored = gogCache.getToken(USER_KEY);
      assert.equal(stored.accessToken, 'access-2');
      assert.equal(stored.lastRefreshError, null);
      // A second call inside the new lifetime does not refresh again.
      const again = await gogAuth.ensureFreshToken(USER_KEY, api);
      assert.equal(again.refreshed, false);
      assert.equal(api.calls.refresh, 1);
    });

    await t.test('an unparseable expiresAt is refreshed, never trusted', async () => {
      saveToken({ expiresAt: 'whenever' });
      const api = fakeApi();
      const { refreshed } = await gogAuth.ensureFreshToken(USER_KEY, api);
      assert.equal(refreshed, true);
      assert.equal(api.calls.refresh, 1);
    });

    await t.test('a 401 refreshes once and repeats the call once', async () => {
      saveToken({ expiresAt: isoIn(HOUR) });
      let attempts = 0;
      const api = fakeApi({
        getSessions: (tokenDoc, gogGameId) => {
          attempts += 1;
          if (attempts === 1) {
            throw new gog.GogError('401', 'gog_auth_expired', { status: 401 });
          }
          return { gogGameId, minutes: 60, found: true, status: 'ok', field: 'time_sum' };
        },
      });
      const client = gogAuth.wrapClient(api, USER_KEY);
      const session = await client.getSessions({ accessToken: ACCESS }, '1207658924');
      assert.equal(session.minutes, 60);
      assert.equal(attempts, 2);
      assert.equal(api.calls.refresh, 1);
      assert.equal(gogCache.getToken(USER_KEY).accessToken, 'access-2');
    });

    await t.test('a second 401 propagates and the snapshot stays untouched', async () => {
      saveToken({ expiresAt: isoIn(HOUR) });
      gogCache.saveLibrary(USER_KEY, {
        fetchedAt: new Date().toISOString(),
        ownerProfile: OWNER,
        products: [{ gogGameId: '1207658924', title: 'The Witcher 3', category: 'game' }],
        fingerprint: '1207658924',
      });
      const before = JSON.stringify(gogCache.getLibrary(USER_KEY));
      const api = fakeApi({
        getSessions: () => {
          throw new gog.GogError('401 again', 'gog_auth_expired', { status: 401 });
        },
      });
      const client = gogAuth.wrapClient(api, USER_KEY);
      await assert.rejects(
        () => client.getSessions({ accessToken: ACCESS }, '1207658924'),
        (err) => err.code === 'gog_auth_expired'
      );
      assert.equal(api.calls.refresh, 1);
      assert.equal(JSON.stringify(gogCache.getLibrary(USER_KEY)), before);
      // The failure is recorded on the token, not on the snapshot.
      assert.equal(gogCache.getToken(USER_KEY).lastError.code, 'gog_auth_expired');
    });

    await t.test('a dead refresh_token fails the import but keeps 93 games', async () => {
      saveToken({ expiresAt: isoIn(-HOUR), refreshToken: 'dead' });
      gogCache.saveLibrary(USER_KEY, {
        fetchedAt: new Date().toISOString(),
        ownerProfile: OWNER,
        products: [{ gogGameId: '1207658924', title: 'The Witcher 3', category: 'game' }],
        fingerprint: '1207658924',
      });
      const api = fakeApi({
        refresh: () => {
          throw new gog.GogError('GOG refresh_token больше не действителен', 'gog_auth_expired', {
            status: 400,
            description: 'Invalid refresh token, client_id:1',
          });
        },
      });
      const job = gogImport.startImport({ account: USER_KEY, client: api, force: true, budget: 5 });
      const status = await waitForJob(job.jobId);
      assert.equal(status.status, 'failed');
      assert.equal(status.code, 'gog_auth_expired');
      assert.equal(gogCache.getLibrary(USER_KEY).products.length, 1);
      const stored = gogCache.getToken(USER_KEY);
      assert.equal(stored.lastRefreshError.code, 'gog_auth_expired');
      assert.match(stored.lastRefreshError.description, /Invalid refresh token/);
      // And the status now honestly asks for a reconnect.
      const payload = buildGamesStatsFromCache(OWNER);
      assert.equal(payload.sources.gog.status, 'auth_expired');
    });

    await t.test('/stats: expired-but-refreshable is «ok», not «подключите заново»', () => {
      saveToken({ expiresAt: isoIn(-HOUR) });
      gogCache.saveLibrary(USER_KEY, {
        fetchedAt: new Date().toISOString(),
        ownerProfile: OWNER,
        products: [{ gogGameId: '1207658924', title: 'The Witcher 3', category: 'game' }],
        fingerprint: '1207658924',
      });
      gogCache.savePlaytime(USER_KEY, {
        fetchedAt: new Date().toISOString(),
        ownerProfile: OWNER,
        minutes: { 1207658924: 600 },
        fetchedGames: 1,
      });
      const payload = buildGamesStatsFromCache(OWNER);
      assert.equal(payload.sources.gog.status, 'ok');
      assert.equal(payload.sources.gog.auth.expired, true);
      assert.equal(payload.sources.gog.auth.needsReconnect, false);
      assert.equal(payload.sources.gog.auth.hasRefreshToken, true);
      assert.equal(payload.sources.gog.auth.binding, 'bound');
    });

    await t.test('/stats: no token + snapshot is snapshot_only; unbound token adopts', () => {
      saveToken({ expiresAt: isoIn(-HOUR), refreshToken: null });
      const expiredNoRefresh = buildGamesStatsFromCache(OWNER);
      assert.equal(expiredNoRefresh.sources.gog.status, 'auth_expired');
      // The account is gone from disk: the dated snapshot survives and the status
      // is the honest «снимок от <дата>».
      gogCache.deleteToken(USER_KEY);
      const snapshotOnly = buildGamesStatsFromCache(OWNER);
      assert.equal(snapshotOnly.sources.gog.status, 'snapshot_only');
      assert.equal(snapshotOnly.sources.gog.hours, 10);
      // A token written before the «one owner» rule has no `ownerProfile`; the
      // library snapshot it wrote names the owner, so it is still connected.
      saveToken({ ownerProfile: null, expiresAt: isoIn(-HOUR) });
      const unbound = buildGamesStatsFromCache(OWNER);
      assert.equal(unbound.sources.gog.status, 'ok');
      assert.equal(unbound.sources.gog.auth.binding, 'unbound');
    });

    await t.test('the lifecycle dump is masked and has the diagnostic shape', () => {
      const events = gogCache.readAuthLifecycle();
      assert.ok(events.length >= 3, `events: ${events.length}`);
      const file = gogCache.debugPath(gogCache.AUTH_LIFECYCLE_NAME);
      assert.ok(fs.existsSync(file));
      const raw = fs.readFileSync(file, 'utf8');
      // No token value ever reaches the dump.
      assert.equal(raw.includes(ACCESS), false);
      assert.equal(raw.includes(REFRESH), false);
      assert.equal(raw.includes('access-2'), false);
      assert.equal(raw.includes('refresh-2'), false);
      const steps = new Set(events.map((event) => event.step));
      assert.ok(steps.has('refresh'));
      for (const event of events) {
        assert.ok(typeof event.at === 'string');
        assert.ok(typeof event.step === 'string');
        assert.equal(typeof event.ok, 'boolean');
        assert.equal(typeof event.tokenShape.hasAccess, 'boolean');
        assert.equal(typeof event.tokenShape.hasRefresh, 'boolean');
        // Presence + expiry only: no token, no cookie, no raw response.
        assert.deepEqual(
          Object.keys(event.tokenShape).sort(),
          ['expiresAt', 'expiresIn', 'hasAccess', 'hasRefresh']
        );
        for (const key of ['accessToken', 'refreshToken', 'token', 'authorization']) {
          assert.equal(Object.prototype.hasOwnProperty.call(event, key), false);
        }
      }
      // A failed refresh carries GOG's own error code/description.
      const failure = events.find((event) => event.step === 'refresh' && event.ok === false);
      assert.ok(failure);
      assert.equal(failure.error, 'gog_auth_expired');
      assert.match(failure.error_description, /Invalid refresh token/);
      assert.equal(failure.accountId, USER_KEY);
    });

    await t.test('connect records accountId/galaxyUserId/sessionId, no tokens', async () => {
      gogCache.deleteToken(USER_KEY);
      const api = fakeApi();
      api.exchangeCode = async () => ({
        accessToken: 'connect-access',
        refreshToken: 'connect-refresh',
        expiresAt: isoIn(HOUR),
        userId: USER_KEY,
        sessionId: 'session-abc',
      });
      const result = await gogImport.connect({ code: 'ok', client: api });
      assert.equal(result.account.ownerProfile, OWNER);
      assert.equal(result.account.expired, false);
      const event = gogCache.readAuthLifecycle().filter((row) => row.step === 'connect').pop();
      assert.ok(event);
      assert.equal(event.ok, true);
      assert.equal(event.accountId, USER_KEY);
      assert.equal(event.galaxyUserId, '5555555555');
      assert.equal(event.sessionId, 'session-abc');
      assert.equal(event.tokenShape.hasAccess, true);
      assert.equal(event.tokenShape.hasRefresh, true);
      assert.equal(JSON.stringify(event).includes('connect-access'), false);
      assert.equal(JSON.stringify(event).includes('connect-refresh'), false);
      assert.equal(gogCache.getToken(USER_KEY).sessionId, 'session-abc');
    });

    await t.test('the rolling dump window is bounded', () => {
      for (let index = 0; index < gogCache.AUTH_LIFECYCLE_MAX_EVENTS + 20; index++) {
        gogCache.appendAuthEvent({ step: 'noise', ok: true, tokenShape: { hasAccess: true } });
      }
      const events = gogCache.readAuthLifecycle();
      assert.equal(events.length, gogCache.AUTH_LIFECYCLE_MAX_EVENTS);
      assert.equal(events[events.length - 1].step, 'noise');
    });
  });
  after(() => env.resetMutableState());
});


describe('games-epic-client', () => {
  /**
   * Epic client (M6b): device-code flow, token refresh, entitlements/library
   * cursor pagination, playtime seconds → minutes, catalog batching, breaker and
   * deferred 5xx handling. Every request is a fake: no live Epic call (§14.5).
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const CACHE_DIR = run.cacheGamesDir;
  const STATE_DIR = run.stateDir;
  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const epic = require('../server/games/epic');

  const ACCOUNT = 'epic-account-1';

  function readJson(name) {
    return JSON.parse(
      fs.readFileSync(path.join(__dirname, 'fixtures', 'games', 'epic', name), 'utf8')
    );
  }

  function jsonResponse(value, status = 200) {
    return { status, body: JSON.stringify(value), headers: {} };
  }

  function makeRequest(handler) {
    const calls = [];
    async function request(options) {
      calls.push(options);
      return handler(options, calls);
    }
    return { request, calls };
  }

  function createMemoryBreakerStore() {
    let state = {};
    return {
      read() {
        return { ...state };
      },
      write(next) {
        state = next && typeof next === 'object' ? next : {};
      },
    };
  }

  function createMemoryTokenStore(initial = []) {  const docs = new Map(initial.map((doc) => [doc.accountId, { ...doc }]));
    return {
      docs,
      async getTokens(accountId) {
        return docs.get(accountId) || null;
      },
      async saveTokens(doc) {
        docs.set(doc.accountId, { ...doc });
        return doc;
      },
      async listTokenDocs() {
        return [...docs.values()];
      },
      async deleteTokens(accountId) {
        return docs.delete(accountId);
      },
    };
  }

  function freshTokenDoc(overrides = {}) {
    return {
      accountId: ACCOUNT,
      displayName: 'EpicTester',
      accessToken: 'eg1~stored-access-token',
      refreshToken: 'eg1~stored-refresh-token',
      accessExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      refreshExpiresAt: new Date(Date.now() + 7200000).toISOString(),
      ...overrides,
    };
  }

  function baseHandler(overrides = {}) {
    return (options) => {
      const { url, body } = options;
      if (url.includes('/account/api/oauth/token')) {
        if (String(body).includes('grant_type=client_credentials')) {
          return jsonResponse({ access_token: 'client-token', expires_in: 7200 });
        }
        if (String(body).includes('grant_type=authorization_code')) {
          if (overrides.authorizationCode) return overrides.authorizationCode(options);
          return jsonResponse(readJson('token-response.json'));
        }
        if (String(body).includes('grant_type=device_code')) {
          if (overrides.deviceCode) return overrides.deviceCode(options);
          return jsonResponse(readJson('token-response.json'));
        }
        if (String(body).includes('grant_type=refresh_token')) {
          if (overrides.refresh) return overrides.refresh(options);
          return jsonResponse({
            ...readJson('token-response.json'),
            access_token: 'eg1~refreshed-access-token',
            refresh_token: 'eg1~refreshed-refresh-token',
          });
        }
      }
      if (url.includes('/account/api/oauth/deviceAuthorization')) {
        if (overrides.deviceAuthorization) return overrides.deviceAuthorization(options);
        return jsonResponse(readJson('device-authorization.json'));
      }
      if (url.includes('/account/api/public/account/')) {
        if (overrides.account) return overrides.account(options);
        return jsonResponse({ id: ACCOUNT, displayName: 'EpicTester', country: 'US' });
      }
      if (url.includes('/entitlement/api/account/')) {
        if (overrides.entitlements) return overrides.entitlements(options);
        const parsed = new URL(url);
        const start = Number(parsed.searchParams.get('start') || 0);
        const count = Number(parsed.searchParams.get('count') || 1000);
        const all = readJson('entitlements.json').entitlements;
        return jsonResponse({
          accountId: ACCOUNT,
          entitlements: all.slice(start, start + count),
        });
      }
      if (url.includes('/library/api/public/items')) {
        if (overrides.libraryItems) return overrides.libraryItems(options);
        const parsed = new URL(url);
        const cursor = parsed.searchParams.get('cursor');
        if (!cursor) return jsonResponse(readJson('library-items-page1.json'));
        return jsonResponse(readJson('library-items-page2.json'));
      }
      if (url.includes('/playtime/account/')) {
        if (overrides.playtime) return overrides.playtime(options);
        return jsonResponse(readJson('playtime.json'));
      }
      if (url.includes('/catalog/api/shared/namespace/')) {
        if (overrides.catalog) return overrides.catalog(options);
        const parsed = new URL(url);
        const catalog = readJson('catalog-bulk.json');
        const ids = parsed.searchParams.getAll('id');
        const items = {};
        for (const id of ids) if (catalog[id]) items[id] = catalog[id];
        return jsonResponse(items);
      }
      if (url.includes('/api/content/productmapping')) {
        if (overrides.productMapping) return overrides.productMapping(options);
        return jsonResponse(readJson('productmapping.json'));
      }
      return jsonResponse({ error: 'not found' }, 404);
    };
  }

  test('device authorization returns the user code and never exposes the device code in status', async () => {
    const { request, calls } = makeRequest(baseHandler());
    const client = epic.createClient({ request, pauseMs: 0, breakerStore: createMemoryBreakerStore(), tokenStore: createMemoryTokenStore() });
    const device = await client.deviceAuthorization();
    assert.equal(device.userCode, 'ABCD-1234');
    assert.equal(device.deviceCode, 'device-code-secret-not-for-clients');
    assert.equal(device.expiresIn, 300);
    assert.equal(device.intervalMs, 5000);
    assert.match(device.verificationUriComplete, /userCode=ABCD-1234/);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/account\/api\/oauth\/token$/);
    assert.match(String(calls[0].body), /grant_type=client_credentials/);
    assert.match(calls[1].url, /\/account\/api\/oauth\/deviceAuthorization$/);
    assert.match(String(calls[1].headers.Authorization), /^bearer /);
  });

  test('device-code polling: pending → authorized with normalized tokens', async () => {
    let poll = 0;
    const { request } = makeRequest(
      baseHandler({
        deviceCode: () => {
          poll++;
          if (poll === 1) {
            return jsonResponse(
              {
                errorCode: 'errors.com.epicgames.account.oauth.authorization_pending',
                errorMessage: 'Authorization pending',
                numericErrorCode: 1013,
              },
              400
            );
          }
          return jsonResponse(readJson('token-response.json'));
        },
      })
    );
    const client = epic.createClient({ request, pauseMs: 0, breakerStore: createMemoryBreakerStore(), tokenStore: createMemoryTokenStore() });
    const pending = await client.exchangeDeviceCode('device-code-secret');
    assert.equal(pending.status, 'pending');
    const authorized = await client.exchangeDeviceCode('device-code-secret');
    assert.equal(authorized.status, 'authorized');
    assert.equal(authorized.tokens.accountId, ACCOUNT);
    assert.equal(authorized.tokens.displayName, 'EpicTester');
    assert.equal(authorized.tokens.accessToken, 'eg1~fake-access-token-AAA');
    assert.equal(authorized.tokens.refreshToken, 'eg1~fake-refresh-token-BBB');
  });

  test('device-code polling classifies slow_down, expired and invalid_grant', async () => {
    const cases = [
      [
        { errorCode: 'errors.com.epicgames.account.oauth.slow_down', interval: 10 },
        400,
        'slow_down',
      ],
      [{ errorCode: 'errors.com.epicgames.account.oauth.expired' }, 400, 'expired'],
      [{ errorCode: 'errors.com.epicgames.account.oauth.invalid_grant' }, 400, 'failed'],
    ];
    for (const [body, status, expected] of cases) {
      const { request } = makeRequest(baseHandler({ deviceCode: () => jsonResponse(body, status) }));
      const client = epic.createClient({
        request,
        pauseMs: 0, breakerStore: createMemoryBreakerStore(),
        tokenStore: createMemoryTokenStore(),
      });
      const result = await client.exchangeDeviceCode('device-code-secret');
      assert.equal(result.status, expected);
    }
  });

  test('an expired access token is refreshed and the new pair is stored', async () => {
    const tokenStore = createMemoryTokenStore([
      freshTokenDoc({ accessExpiresAt: new Date(Date.now() - 60000).toISOString() }),
    ]);
    const { request, calls } = makeRequest(baseHandler());
    const client = epic.createClient({ request, pauseMs: 0, breakerStore: createMemoryBreakerStore(), tokenStore });
    const token = await client.getAccessToken(ACCOUNT);
    assert.equal(token, 'eg1~refreshed-access-token');
    assert.match(String(calls.at(-1).body), /grant_type=refresh_token/);
    const stored = await tokenStore.getTokens(ACCOUNT);
    assert.equal(stored.accessToken, 'eg1~refreshed-access-token');
    assert.equal(stored.refreshToken, 'eg1~refreshed-refresh-token');
  });

  test('a rejected refresh becomes epic_auth_expired and marks the token file', async () => {
    const tokenStore = createMemoryTokenStore([
      freshTokenDoc({ accessExpiresAt: new Date(Date.now() - 60000).toISOString() }),
    ]);
    const { request } = makeRequest(
      baseHandler({
        refresh: () =>
          jsonResponse(
            { errorCode: 'errors.com.epicgames.common.oauth.invalid_token' },
            400
          ),
      })
    );
    const client = epic.createClient({ request, pauseMs: 0, breakerStore: createMemoryBreakerStore(), tokenStore });
    await assert.rejects(client.getAccessToken(ACCOUNT), (err) => err.code === 'epic_auth_expired');
    const stored = await tokenStore.getTokens(ACCOUNT);
    assert.equal(stored.lastAuthError, 'auth_expired');
  });

  test('a 401 on a read endpoint is epic_auth_expired, not an empty library', async () => {
    const tokenStore = createMemoryTokenStore([freshTokenDoc()]);
    const { request } = makeRequest(
      baseHandler({ playtime: () => jsonResponse({ errorCode: 'authentication_failed' }, 401) })
    );
    const client = epic.createClient({ request, pauseMs: 0, breakerStore: createMemoryBreakerStore(), tokenStore });
    await assert.rejects(client.getPlaytime(ACCOUNT), (err) => err.code === 'epic_auth_expired');
    const stored = await tokenStore.getTokens(ACCOUNT);
    assert.equal(stored.lastAuthError, 'auth_expired');
  });

  test('entitlements paginate by start/count', async () => {
    const { request, calls } = makeRequest(baseHandler());
    const client = epic.createClient({
      request,
      pauseMs: 0, breakerStore: createMemoryBreakerStore(),
      tokenStore: createMemoryTokenStore([freshTokenDoc()]),
    });
    const result = await client.getEntitlements(ACCOUNT, { pageSize: 3 });
    assert.equal(result.entitlements.length, 8);
    assert.equal(result.pages, 3);
    assert.equal(calls.filter((call) => call.url.includes('/entitlements')).length, 3);
    assert.match(calls.at(-1).url, /start=6/);
  });

  test('library items follow nextCursor until it is empty', async () => {
    const { request, calls } = makeRequest(baseHandler());
    const client = epic.createClient({
      request,
      pauseMs: 0, breakerStore: createMemoryBreakerStore(),
      tokenStore: createMemoryTokenStore([freshTokenDoc()]),
    });
    const result = await client.getLibraryItems(ACCOUNT);
    assert.equal(result.pages, 2);
    assert.equal(result.records.length, 6);
    assert.equal(result.records[0].appName, 'Fortnite');
    assert.match(calls[1].url, /cursor=cursor-page-2/);
  });

  test('playtime totalTime is seconds → integer minutes and one-decimal hours', async () => {
    const { request } = makeRequest(baseHandler());
    const client = epic.createClient({
      request,
      pauseMs: 0, breakerStore: createMemoryBreakerStore(),
      tokenStore: createMemoryTokenStore([freshTokenDoc()]),
    });
    const playtime = await client.getPlaytime(ACCOUNT);
    assert.equal(playtime.totalSeconds, 37800);
    assert.equal(playtime.totalMinutes, 630);
    assert.equal(playtime.totalHours, 10.5);
    assert.equal(playtime.byArtifactId['9d2d0eb64d5c44529cece33fe2a46482'].totalMinutes, 600);
    assert.equal(epic.secondsToMinutes(90), 2);
    assert.equal(epic.secondsToHours(5400), 1.5);
    // No lastPlayed is invented.
    assert.equal(playtime.items[0].lastPlayed, undefined);
  });

  test('catalog bulk is chunked and normalized (slug/title/developer/publisher)', async () => {
    const ids = Array.from({ length: 60 }, (_, index) => `catalog-item-${index}`);
    const { request, calls } = makeRequest(
      baseHandler({
        catalog: (options) => {
          const parsed = new URL(options.url);
          const requested = parsed.searchParams.getAll('id');
          const items = {};
          for (const id of requested) {
            items[id] = {
              title: `Title ${id}`,
              productSlug: `slug-${id}/home`,
              developer: 'Studio',
              publisher: 'Publisher',
              releaseInfo: [{ date: '2020-01-01T00:00:00.000Z' }],
            };
          }
          return jsonResponse(items);
        },
      })
    );
    const client = epic.createClient({
      request,
      pauseMs: 0, breakerStore: createMemoryBreakerStore(),
      tokenStore: createMemoryTokenStore([freshTokenDoc()]),
    });
    const result = await client.getCatalogBulk('fn', ids, { accountId: ACCOUNT });
    assert.equal(result.requests, 3);
    assert.equal(Object.keys(result.items).length, 60);
    assert.equal(result.items['catalog-item-0'].slug, 'slug-catalog-item-0');
    assert.equal(result.items['catalog-item-0'].developer, 'Studio');
    assert.equal(result.items['catalog-item-0'].publisher, 'Publisher');
    assert.equal(calls.filter((call) => call.url.includes('/bulk/items')).length, 3);
  });

  test('catalog 5xx on one chunk is a recorded failure, 401 aborts', async () => {
    const { request } = makeRequest(
      baseHandler({ catalog: () => jsonResponse({ error: 'boom' }, 503) })
    );
    const client = epic.createClient({
      request,
      pauseMs: 0, breakerStore: createMemoryBreakerStore(),
      tokenStore: createMemoryTokenStore([freshTokenDoc()]),
    });
    const result = await client.getCatalogBulk('fn', ['a', 'b'], { accountId: ACCOUNT });
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].code, 'epic_unreachable');

    const unauthorized = makeRequest(
      baseHandler({ catalog: () => jsonResponse({ error: 'auth' }, 401) })
    );
    const client2 = epic.createClient({
      request: unauthorized.request,
      pauseMs: 0, breakerStore: createMemoryBreakerStore(),
      tokenStore: createMemoryTokenStore([freshTokenDoc()]),
    });
    await assert.rejects(
      client2.getCatalogBulk('fn', ['a'], { accountId: ACCOUNT }),
      (err) => err.code === 'epic_auth_expired'
    );
  });

  test('429 trips the 30-minute breaker and the next call is refused without a request', async () => {
    const { request, calls } = makeRequest(
      baseHandler({ playtime: () => jsonResponse({ error: 'slow down' }, 429) })
    );
    const tokenStore = createMemoryTokenStore([freshTokenDoc()]);
    const client = epic.createClient({ request, pauseMs: 0, breakerStore: createMemoryBreakerStore(), tokenStore });
    await assert.rejects(client.getPlaytime(ACCOUNT), (err) => err.code === 'epic_rate_limited');
    const before = calls.length;
    await assert.rejects(client.getPlaytime(ACCOUNT), (err) => err.code === 'epic_rate_limited');
    assert.equal(calls.length, before);
    const entry = client.breakerFor(epic.LIBRARY_HOST);
    assert.ok(entry && entry.until > Date.now());
  });

  test('5xx is deferred (not a negative cache)', async () => {
    const { request } = makeRequest(
      baseHandler({ libraryItems: () => jsonResponse({ error: 'down' }, 502) })
    );
    const client = epic.createClient({
      request,
      pauseMs: 0, breakerStore: createMemoryBreakerStore(),
      tokenStore: createMemoryTokenStore([freshTokenDoc()]),
    });
    await assert.rejects(
      client.getLibraryItems(ACCOUNT),
      (err) => err.code === 'epic_unreachable' && err.deferred === true
    );
  });

  test('productmapping normalizes both object and string values', async () => {
    const { request } = makeRequest(baseHandler());
    const client = epic.createClient({ request, pauseMs: 0 });
    const mapping = await client.getProductMapping();
    assert.equal(mapping.byAppName.TheWitcher3, 'the-witcher-3-wild-hunt');
    assert.equal(mapping.byAppName.Control, 'control');
    assert.equal(mapping.byAppName.Fortnite, 'fortnite');
  });

  test('maskSecrets hides tokens/device codes but keeps the user code', () => {
    const text =
      'GET /x?access_token=eg1~secret&device_code=dev-secret&user_code=ABCD-1234 ' +
      'Authorization: bearer eg1~header-token {"refresh_token":"eg1~json-secret","client_secret":"s3"}';
    const masked = epic.maskSecrets(text);
    assert.equal(masked.includes('eg1~secret'), false);
    assert.equal(masked.includes('dev-secret'), false);
    assert.equal(masked.includes('eg1~header-token'), false);
    assert.equal(masked.includes('eg1~json-secret'), false);
    assert.equal(masked.includes('s3'), false);
    assert.match(masked, /user_code=ABCD-1234/);
  });

  /* ------------------------------------------------------------------ */
  /* Authorization-code login (the flow that actually works, 01.11.2026) */
  /* ------------------------------------------------------------------ */

  function codeClient(request, extra = {}) {
    return epic.createClient({
      request,
      pauseMs: 0,
      breakerStore: createMemoryBreakerStore(),
      tokenStore: createMemoryTokenStore([freshTokenDoc()]),
      ...extra,
    });
  }

  test('authorizeUrl is the official login page with an encoded redirect (no secret)', () => {
    const url = epic.authorizeUrl('client-id-123');
    assert.match(url, /^https:\/\/www\.epicgames\.com\/id\/login\?redirectUrl=/);
    const redirect = decodeURIComponent(url.slice(url.indexOf('redirectUrl=') + 'redirectUrl='.length));
    assert.equal(
      redirect,
      'https://www.epicgames.com/id/api/redirect?clientId=client-id-123&responseType=code'
    );
    // The client id is public and part of the URL; a secret must never be.
    assert.equal(/secret/i.test(url), false);
  });

  test('extractAuthCode accepts a bare code, a redirect URL, a fragment and rejects junk', () => {
    const code = 'abcdef0123456789abcdef0123456789';
    assert.equal(epic.extractAuthCode(code), code);
    assert.equal(epic.extractAuthCode(`https://www.epicgames.com/id/api/redirect?code=${code}`), code);
    assert.equal(epic.extractAuthCode(`https://www.epicgames.com/id/api/redirect#code=${code}`), code);
    assert.equal(epic.extractAuthCode(`code=${code}&state=xyz`), code);
    assert.equal(epic.extractAuthCode('   '), null);
    assert.equal(epic.extractAuthCode('https://example.com/nothing-here'), null);
    assert.equal(epic.extractAuthCode('no code here!'), null);
  });

  test('authorization-code exchange: basic header + form body, code never in the URL', async () => {
    const { request, calls } = makeRequest(baseHandler());
    const client = codeClient(request);
    const tokens = await client.exchangeAuthorizationCode(
      'https://www.epicgames.com/id/api/redirect?code=one-time-code'
    );
    assert.equal(tokens.accountId, ACCOUNT);
    assert.equal(tokens.displayName, 'EpicTester');
    assert.equal(calls.length, 1);
    assert.match(
      calls[0].url,
      /^https:\/\/account-public-service-prod03\.ol\.epicgames\.com\/account\/api\/oauth\/token$/
    );
    assert.equal(calls[0].url.includes('code='), false);
    assert.equal(calls[0].method, 'POST');
    assert.match(String(calls[0].headers['Content-Type']), /^application\/x-www-form-urlencoded/);

    // Basic auth identifies the client; the secret is compared without being
    // hardcoded in the test (policy: no secret literals in fixtures).
    const basic = String(calls[0].headers.Authorization);
    assert.match(basic, /^basic [A-Za-z0-9+/=]+$/);
    const decoded = Buffer.from(basic.slice('basic '.length), 'base64').toString('utf8');
    const [clientId, clientSecret] = decoded.split(':');
    assert.equal(clientId, client._clientCredentials().clientId);
    assert.ok(clientSecret && clientSecret.length >= 20);

    const body = new URLSearchParams(String(calls[0].body));
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'one-time-code');
    assert.equal(body.get('token_type'), 'eg1');
  });

  test('authorization-code exchange: invalid_client vs a dead code, code is never echoed', async () => {
    const rejectedClient = makeRequest(
      baseHandler({
        authorizationCode: () =>
          jsonResponse(
            {
              errorCode: 'errors.com.epicgames.common.oauth.invalid_client',
              errorMessage: 'Invalid Client',
              numericErrorCode: 1011,
            },
            400
          ),
      })
    );
    await assert.rejects(codeClient(rejectedClient.request).exchangeAuthorizationCode('one-time-code'), (err) => {
      assert.equal(err.code, 'epic_client_invalid');
      assert.equal(err.message.includes('one-time-code'), false);
      return true;
    });

    const deadCode = makeRequest(
      baseHandler({
        authorizationCode: () =>
          jsonResponse(
            {
              errorCode: 'errors.com.epicgames.common.oauth.invalid_grant',
              errorMessage: 'Sorry the authorization code is invalid or expired.',
              numericErrorCode: 1012,
            },
            400
          ),
      })
    );
    await assert.rejects(codeClient(deadCode.request).exchangeAuthorizationCode('one-time-code'), (err) => {
      assert.equal(err.code, 'epic_invalid_code');
      assert.equal(err.message.includes('one-time-code'), false);
      assert.match(err.message, /одноразовый/);
      return true;
    });
  });

  test('an empty/garbage code is epic_code_required without any request', async () => {
    const { request, calls } = makeRequest(baseHandler());
    await assert.rejects(
      codeClient(request).exchangeAuthorizationCode('   '),
      (err) => err.code === 'epic_code_required' && err.status === 400
    );
    assert.equal(calls.length, 0);
  });

  test('device-code grant (Epic 1016) becomes epic_device_grant_unavailable', async () => {
    const { request } = makeRequest(
      baseHandler({
        deviceAuthorization: () =>
          jsonResponse(
            {
              errorCode: 'errors.com.epicgames.common.oauth.unsupported_grant_type',
              errorMessage: 'Sorry, your client does not have the proper grant_type for access.',
              numericErrorCode: 1016,
            },
            400
          ),
      })
    );
    await assert.rejects(codeClient(request).deviceAuthorization(), (err) => {
      assert.equal(err.code, 'epic_device_grant_unavailable');
      assert.equal(err.status, 400);
      assert.match(err.message, /authorization code/);
      return true;
    });
  });

  test('client credentials are resolved env → file → public default, source only', () => {
    const previous = {
      EPIC_CLIENT_ID: process.env.EPIC_CLIENT_ID,
      EPIC_CLIENT_SECRET: process.env.EPIC_CLIENT_SECRET,
      GAMES_EPIC_CLIENT_ID: process.env.GAMES_EPIC_CLIENT_ID,
      GAMES_EPIC_CLIENT_SECRET: process.env.GAMES_EPIC_CLIENT_SECRET,
      KINOBOXD_EPIC_CLIENT_FILE: process.env.KINOBOXD_EPIC_CLIENT_FILE,
    };
    try {
      delete process.env.EPIC_CLIENT_ID;
      delete process.env.EPIC_CLIENT_SECRET;
      delete process.env.GAMES_EPIC_CLIENT_ID;
      delete process.env.GAMES_EPIC_CLIENT_SECRET;
      process.env.KINOBOXD_EPIC_CLIENT_FILE = path.join(CACHE_DIR, 'missing-epic-client.json');
      epic.resetCredentialsCache();
      assert.equal(epic.clientSource(), 'default');

      process.env.EPIC_CLIENT_ID = 'env-client-id';
      process.env.EPIC_CLIENT_SECRET = 'env-client-secret-value';
      epic.resetCredentialsCache();
      assert.equal(epic.clientSource(), 'env');

      // A half-configured env pair falls back to the built-in pair.
      delete process.env.EPIC_CLIENT_SECRET;
      epic.resetCredentialsCache();
      assert.equal(epic.clientSource(), 'default');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
      epic.resetCredentialsCache();
    }
  });
  after(() => env.resetMutableState());
});


describe('games-epic-import', () => {
  /**
   * Epic import + isolated layer (M6b): ownership chain (entitlements > library
   * items, filters), playtime seconds, catalog metadata, deferred/auth-expired
   * degradation, owner binding, and the rule that Epic never changes Steam
   * hours (`hoursBySource` stays split).
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const CACHE_DIR = run.cacheGamesDir;
  const STATE_DIR = run.stateDir;
  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;
  process.env.KINOBOXD_GAMES_WD = 'off';

  const epic = require('../server/games/epic');
  const gameCache = require('../server/games/game-cache');
  const epicCache = require('../server/games/epic-cache');
  const epicImport = require('../server/games/epic-import');
  const epicLayer = require('../server/games/secondary/epic');
  const tokenStore = require('../server/games/epic-token-store');
  const { createFakeEpicClient } = require('./fixtures/games/epic/fake-client');

  const ACCOUNT = 'epic-account-1';
  const STEAM_ID = '76561198000000001';
  const OWNER = `steam-${STEAM_ID}`;

  function iso(offsetMs = 0) {
    return new Date(Date.now() + offsetMs).toISOString();
  }

  async function seedSteam() {
    await gameCache.saveProfile({
      userKey: STEAM_ID,
      personaName: 'SteamTester',
      privacy: 'public',
      importedAt: iso(),
      fetchedAt: iso(),
    });
    await gameCache.saveLibrary(STEAM_ID, {
      fetchedAt: iso(),
      partial: false,
      source: 'steam-webapi',
      game_count: 5,
      games: [
        { appid: 1, name: 'Steam One', playtime_forever: 3000, rtime_last_played: 0 },
        { appid: 2, name: 'Steam Two', playtime_forever: 3000, rtime_last_played: 0 },
      ],
      totalMinutes: 6000,
      fingerprint: 'steam-fingerprint',
    });
  }

  async function seedToken(accountId = ACCOUNT, ownerKey = null) {
    return tokenStore.saveTokens({
      accountId,
      displayName: 'EpicTester',
      ownerKey,
      accessToken: 'eg1~fake-access-token',
      refreshToken: 'eg1~fake-refresh-token',
      accessExpiresAt: iso(3600000),
      refreshExpiresAt: iso(7200000),
    });
  }

  test('full import: entitlements + library + playtime + catalog, filters applied', async () => {
    await seedSteam();
    await seedToken();
    const client = createFakeEpicClient();
    const job = await epicImport.startImport({
      accountId: ACCOUNT,
      ownerKey: OWNER,
      client,
      tokenStore,
      force: true,
    });
    assert.equal(job.status, 'running');
    await epicImport.whenIdle();
    const status = epicImport.getStatus(job.jobId);
    assert.equal(status.status, 'done');
    assert.equal(status.stage, 'done');
    assert.equal(status.done, true);
    assert.equal(status.deferred, false);
    assert.equal(status.code, null);
    assert.equal(status.owner, OWNER);
    assert.equal(status.displayName, 'EpicTester');
    assert.equal(status.gameCount, 4);
    assert.equal(status.ownedCount, 4);
    assert.equal(status.totalSeconds, 37800);
    assert.equal(status.totalMinutes, 630);
    assert.equal(status.totalHours, 10.5);
    assert.equal(status.playedCount, 2);
    assert.equal(status.backlogCount, 2);
    assert.equal(status.catalogCount, 4);
    // account + entitlements + 2 library pages + playtime + 3 catalog namespaces
    // + productmapping = 9
    assert.equal(status.requests, 9);

    const library = epicCache.getEpicLibrary(ACCOUNT);
    assert.equal(library.source, 'epic-entitlements+library');
    assert.equal(library.partial, false);
    assert.equal(library.ownerKey, OWNER);
    assert.equal(library.gameCount, 4);
    assert.equal(library.counts.entitlementCount, 4);
    assert.equal(library.counts.libraryCount, 3);
    assert.deepEqual(library.counts.excluded, {
      ue: 2,
      private: 1,
      mobile: 1,
      inactive: 1,
      consumable: 1,
      missingCatalogId: 1,
    });
    assert.ok(library.fingerprint);

    const playtime = epicCache.getEpicPlaytime(ACCOUNT);
    assert.equal(playtime.totalSeconds, 37800);
    assert.equal(playtime.totalMinutes, 630);

    const profile = epicCache.getEpicProfile(ACCOUNT);
    assert.equal(profile.ownerKey, OWNER);
    assert.equal(profile.displayName, 'EpicTester');

    // The Steam cache is untouched: Epic import never rewrites the journal.
    const steamLibrary = gameCache.getLibrary(STEAM_ID);
    assert.equal(steamLibrary.totalMinutes, 6000);
    assert.equal(steamLibrary.game_count, 5);
    assert.equal(steamLibrary.games.some((game) => game.source === 'epic'), false);
  });

  test('isolated layer: hoursBySource split, catalog metadata, exportedGames contract', async () => {
    const layer = await epicLayer.buildEpicLayer({ ownerKey: OWNER });
    assert.equal(layer.status, 'ok');
    assert.equal(layer.owner, OWNER);
    assert.equal(layer.accountId, ACCOUNT);
    assert.deepEqual(layer.hoursBySource, { steam: 100, epic: 10.5 });
    assert.deepEqual(layer.ownedBySource, { steam: 5, epic: 4 });
    assert.equal(layer.summary.ownedCount, 4);
    assert.equal(layer.summary.hours, 10.5);
    assert.equal(layer.summary.libraryExternalNumberCount, 4);
    assert.equal(layer.summary.externalOwnedCount, 4);
    assert.equal(layer.libraries.length, 1);
    assert.equal(layer.libraries[0].source, 'epic');
    assert.equal(layer.libraries[0].userKey, ACCOUNT);

    const witcher = layer.games.find(
      (game) => game.catalogItemId === '9d2d0eb64d5c44529cece33fe2a46482'
    );
    assert.ok(witcher);
    assert.equal(witcher.name, 'The Witcher 3: Wild Hunt');
    assert.equal(witcher.slug, 'the-witcher-3-wild-hunt');
    assert.equal(witcher.developer, 'CD PROJEKT RED');
    assert.equal(witcher.publisher, 'CD PROJEKT RED');
    assert.equal(witcher.totalTimeSec, 36000);
    assert.equal(witcher.totalMinutes, 600);
    assert.equal(witcher.hours, 10);
    assert.equal(witcher.playtimeKnown, true);
    assert.equal(witcher.lastPlayed, null);

    const control = layer.games.find(
      (game) => game.catalogItemId === '5c0e4c8b3a9f4c7e8d1b2a3c4d5e6f70'
    );
    assert.equal(control.slug, 'control'); // productmapping fallback
    assert.equal(control.hours, 0.5);

    const fortnite = layer.games.find(
      (game) => game.catalogItemId === '4fe75bbc5a674f4f9b356b5c90567da5'
    );
    assert.equal(fortnite.hours, 0);
    assert.equal(fortnite.platforms.includes('windows'), true);

    const entitlementOnly = layer.games.find(
      (game) => game.catalogItemId === 'entonly-item-000000000000000000'
    );
    assert.equal(entitlementOnly.appName, null);
    assert.equal(entitlementOnly.name, 'Entitlement Only Game');
    assert.equal(entitlementOnly.playtimeKnown, false);
    assert.equal(entitlementOnly.hours, null);
    assert.deepEqual(entitlementOnly.sources, ['entitlement']);

    assert.equal(layer.exportedGames.length, 4);
    for (const exported of layer.exportedGames) {
      assert.equal(exported.source, 'epic');
      assert.equal(exported.accountId, ACCOUNT);
      assert.equal(exported.owner, OWNER);
      assert.equal(exported.workKey, null);
      assert.equal(exported.steamAppId, null);
    }
    const exportedWitcher = layer.exportedGames.find(
      (game) => game.catalogItemId === '9d2d0eb64d5c44529cece33fe2a46482'
    );
    assert.equal(exportedWitcher.totalTimeSec, 36000);
    assert.equal(exportedWitcher.totalMinutes, 600);
  });

  test('a fresh snapshot is reused without requests; force re-imports', async () => {
    const client = createFakeEpicClient();
    const reused = await epicImport.startImport({
      accountId: ACCOUNT,
      ownerKey: OWNER,
      client,
      tokenStore,
    });
    assert.equal(reused.reused, true);
    assert.equal(reused.status, 'done');
    assert.equal(reused.requests, 0);
    assert.equal(client.calls.length, 0);

    const forced = await epicImport.startImport({
      accountId: ACCOUNT,
      ownerKey: OWNER,
      client,
      tokenStore,
      force: true,
    });
    await epicImport.whenIdle();
    const status = epicImport.getStatus(forced.jobId);
    assert.equal(status.status, 'done');
    // Catalog + productmapping are fresh: only account/entitlements/library/
    // playtime hit the fake client.
    assert.equal(status.requests, 5);
    assert.equal(client.calls.filter((call) => call.startsWith('catalog:')).length, 0);
    assert.equal(client.calls.includes('productmapping'), false);
  });

  test('playtime 5xx is deferred: the ownership snapshot stays, the old playtime is kept', async () => {
    const before = epicCache.getEpicLibrary(ACCOUNT);
    const client = createFakeEpicClient({
      fail: {
        getPlaytime: new epic.EpicError('Epic недоступен', 'epic_unreachable', {
          deferred: true,
        }),
      },
    });
    const job = await epicImport.startImport({
      accountId: ACCOUNT,
      ownerKey: OWNER,
      client,
      tokenStore,
      force: true,
    });
    await epicImport.whenIdle();
    const status = epicImport.getStatus(job.jobId);
    assert.equal(status.status, 'deferred');
    assert.equal(status.deferred, true);
    assert.equal(status.code, 'epic_unreachable');
    assert.equal(status.done, true);

    const after = epicCache.getEpicLibrary(ACCOUNT);
    assert.ok(after);
    assert.equal(after.gameCount, before.gameCount);
    assert.notEqual(after.fetchedAt, before.fetchedAt);
    const playtime = epicCache.getEpicPlaytime(ACCOUNT);
    assert.equal(playtime.totalSeconds, 37800);
  });

  test('a 401 is epic_auth_expired and leaves the previous snapshot intact', async () => {
    const before = epicCache.getEpicLibrary(ACCOUNT);
    const client = createFakeEpicClient({
      fail: {
        getAccount: new epic.EpicError('Epic отклонил токен', 'epic_auth_expired', {
          status: 401,
        }),
      },
    });
    const job = await epicImport.startImport({
      accountId: ACCOUNT,
      ownerKey: OWNER,
      client,
      tokenStore,
      force: true,
    });
    await epicImport.whenIdle();
    const status = epicImport.getStatus(job.jobId);
    assert.equal(status.status, 'failed');
    assert.equal(status.code, 'epic_auth_expired');
    const after = epicCache.getEpicLibrary(ACCOUNT);
    assert.equal(after.fetchedAt, before.fetchedAt);
    assert.equal(after.gameCount, before.gameCount);
  });

  test('an unconnected account is a 400-level error before a job exists', async () => {
    await tokenStore.deleteTokens(ACCOUNT);
    await assert.rejects(
      epicImport.startImport({ accountId: ACCOUNT, client: createFakeEpicClient() }),
      (err) => err.code === 'epic_not_connected'
    );
  });

  test('owner binding: one Epic account per owner, no cross-owner merge', async () => {
    await seedToken('epic-other-account', `steam-76561198000000002`);
    await epicCache.saveEpicProfile({
      accountId: 'epic-other-account',
      displayName: 'Other',
      ownerKey: `steam-76561198000000002`,
    });
    await seedToken(ACCOUNT, null);
    await assert.rejects(
      epicImport.startImport({
        accountId: 'epic-other-account',
        ownerKey: OWNER,
        client: createFakeEpicClient(),
      }),
      (err) => err.code === 'owner_mismatch'
    );
  });

  test('mergeLibrary filters UE/PRIVATE/mobile and keeps entitlement-only rows', () => {
    const merged = epic.mergeLibrary({
      entitlements: [
        { catalogItemId: 'a', namespace: 'fn', active: true, status: 'ACTIVE' },
        { catalogItemId: 'b', namespace: 'ue', active: true, status: 'ACTIVE' },
        { catalogItemId: 'c', namespace: 'fn', active: false, status: 'INACTIVE' },
      ],
      libraryItems: [
        { appName: 'A', namespace: 'fn', catalogItemId: 'a', platform: ['Windows'] },
        { appName: 'B', namespace: 'ue', catalogItemId: 'b', platform: ['Windows'] },
        { appName: 'D', namespace: 'fn', catalogItemId: 'd', sandboxType: 'PRIVATE' },
        { appName: 'E', namespace: 'fn', catalogItemId: 'e', platform: ['Android'] },
        { appName: 'F', namespace: 'fn', catalogItemId: 'f', platform: [] },
      ],
    });
    assert.deepEqual(
      merged.games.map((game) => game.catalogItemId).sort(),
      ['a', 'f']
    );
    assert.equal(merged.counts.excluded.ue, 2);
    assert.equal(merged.counts.excluded.inactive, 1);
    assert.equal(merged.counts.excluded.private, 1);
    assert.equal(merged.counts.excluded.mobile, 1);
    const a = merged.games.find((game) => game.catalogItemId === 'a');
    assert.deepEqual(a.sources.sort(), ['entitlement', 'library']);
    assert.equal(a.appName, 'A');
  });

  test('productmapping fallback by namespace covers Epic exclusives (Alan Wake 2)', () => {
    const mapping = epic.normalizeProductMapping({
      'dc9d2e595d0e4650b35d659f90d41059': 'some-appname-game',
      'c4763f236d08423eb47b4c3008779c84': 'alan-wake-2',
    });
    assert.equal(mapping.count, 2);
    const games = [
      {
        appName: 'dc9d2e595d0e4650b35d659f90d41059',
        namespace: 'c4763f236d08423eb47b4c3008779c84',
        slug: null,
      },
      {
        appName: 'missing-from-mapping',
        namespace: 'c4763f236d08423eb47b4c3008779c84',
        slug: null,
      },
      { appName: 'missing-too', namespace: 'fn', slug: null },
    ];
    epicImport.mergeCatalogSlugs(games, mapping, {});
    // appName wins when present; the namespace key is the second lookup — AW2's
    // live productmapping record is keyed by namespace, not by its appName.
    assert.equal(games[0].slug, 'some-appname-game');
    assert.equal(games[1].slug, 'alan-wake-2');
    assert.equal(games[2].slug, null);
  });
  after(() => env.resetMutableState());
});


describe('games-epic-token-store', () => {
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

  const CACHE_DIR = run.cacheGamesDir;
  const STATE_DIR = run.stateDir;
  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

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
  after(() => env.resetMutableState());
});
