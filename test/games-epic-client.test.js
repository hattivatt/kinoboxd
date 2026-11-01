'use strict';

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

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-epic-client-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-epic-client-state-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = STATE_DIR;

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
