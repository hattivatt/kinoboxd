'use strict';

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

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-gog-auth-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-gog-auth-state-'));

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
