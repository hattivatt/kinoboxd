'use strict';

/**
 * GOG client (M6a): OAuth code→token/refresh, identity, paginated
 * `getFilteredProducts`, `gameplay/.../sessions` (`time_sum` minutes).
 *
 * Everything runs against a local fake GOG server on port 7084 — no live
 * requests, no real account. Fixtures live in `test/fixtures/games/gog/`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-gog-client-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-gog-client-state-'));

const gog = require('../server/games/gog');
const gogCache = require('../server/games/gog-cache');

const PORT = 7084;
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'games', 'gog');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

function makeServer() {
  const state = {
    tokenCalls: [],
    productCalls: [],
    sessionCalls: [],
    accessToken: 'fake-access-token-value',
    userDataStatus: 200,
    productsStatus: 200,
    sessionsStatus: 200,
    rateLimitOnce: false,
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/auth') {
      return send(200, { ok: true });
    }
    if (url.pathname === '/token') {
      const grant = url.searchParams.get('grant_type');
      state.tokenCalls.push({
        grant,
        code: url.searchParams.get('code'),
        refresh: url.searchParams.get('refresh_token'),
        hasSecret: Boolean(url.searchParams.get('client_secret')),
      });
      if (grant === 'authorization_code') {
        if (url.searchParams.get('code') === 'bad-code') {
          return send(400, { error: 'invalid_grant', error_description: 'bad code' });
        }
        return send(200, fixture('token.json'));
      }
      if (grant === 'refresh_token') {
        if (url.searchParams.get('refresh_token') === 'dead-refresh') {
          return send(400, { error: 'invalid_grant' });
        }
        return send(200, {
          ...fixture('token.json'),
          access_token: 'refreshed-access-token',
          refresh_token: 'rotated-refresh-token',
        });
      }
      return send(400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/userData.json') {
      if (state.userDataStatus !== 200) return send(state.userDataStatus, { isLoggedIn: false });
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ')) return send(401, { isLoggedIn: false });
      return send(200, fixture('userdata.json'));
    }
    if (url.pathname === '/account/getFilteredProducts') {
      if (state.rateLimitOnce) {
        state.rateLimitOnce = false;
        return send(429, { error: 'too_many_requests' });
      }
      if (state.productsStatus !== 200) {
        return send(state.productsStatus, {}, { Location: '/en#openlogin' });
      }
      const page = Number(url.searchParams.get('page') || 1);
      state.productCalls.push(page);
      return send(200, fixture(page === 2 ? 'library-page2.json' : 'library-page1.json'));
    }
    if (url.pathname === '/user/data/games') {
      return send(200, { owned: ['1207658924', '1423049311', '1999999999', '1888888888'] });
    }
    const session = /^\/games\/([^/]+)\/users\/([^/]+)\/sessions$/.exec(url.pathname);
    if (session) {
      state.sessionCalls.push({ productId: session[1], userId: session[2] });
      if (state.sessionsStatus === 404) return send(404, { error: 'not_found' });
      if (state.sessionsStatus === 401) return send(401, { error: 'access_denied' });
      if (session[1] === '1999999999') return send(200, { time_sum: 90 });
      return send(200, fixture('sessions.json'));
    }
    return send(404, { error: 'not_found' });
  });
  return { server, state };
}

function clientFor(state, overrides = {}) {
  return gog.createClient({
    authOrigin: `http://127.0.0.1:${PORT}`,
    embedOrigin: `http://127.0.0.1:${PORT}`,
    gameplayOrigin: `http://127.0.0.1:${PORT}`,
    libraryPauseMs: 0,
    playtimePauseMs: 0,
    credentialProvider: () => ({ clientId: 'test-client', clientSecret: 'test-secret', source: 'env' }),
    breakerStore: {
      state: {},
      read() {
        return this.state;
      },
      write(next) {
        this.state = next;
      },
    },
    ...overrides,
  });
}

test('GOG client', async (t) => {
  const { server, state } = makeServer();
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = clientFor(state);

  await t.test('authorize URL carries the public client id and the embed redirect', () => {
    const url = new URL(client.authorizeUrl());
    assert.equal(url.host, `127.0.0.1:${PORT}`);
    assert.equal(url.pathname, '/auth');
    assert.equal(url.searchParams.get('client_id'), 'test-client');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('layout'), 'client2');
    assert.equal(url.searchParams.get('redirect_uri'), gog.REDIRECT_URI);
    // No user token exists yet.
    assert.equal(url.searchParams.get('access_token'), null);
  });

  await t.test('code → token: access/refresh/expiry/user_id', async () => {
    const tokens = await client.exchangeCode('one-time-code');
    assert.equal(tokens.accessToken, 'fake-access-token-value');
    assert.equal(tokens.refreshToken, 'fake-refresh-token-value');
    assert.equal(tokens.userId, '1234567890');
    assert.ok(Date.parse(tokens.expiresAt) > Date.now());
    assert.equal(state.tokenCalls.at(-1).grant, 'authorization_code');
    assert.equal(state.tokenCalls.at(-1).code, 'one-time-code');
    assert.equal(state.tokenCalls.at(-1).hasSecret, true);
  });

  await t.test('a rejected code is gog_invalid_code and never echoes the code', async () => {
    await assert.rejects(
      () => client.exchangeCode('bad-code'),
      (err) => {
        assert.equal(err.code, 'gog_invalid_code');
        assert.equal(err.message.includes('bad-code'), false);
        return true;
      }
    );
    await assert.rejects(() => client.exchangeCode(''), (err) => err.code === 'gog_code_required');
  });

  await t.test('refresh rotates the token; a dead refresh is auth_expired', async () => {
    const refreshed = await client.refresh('old-refresh');
    assert.equal(refreshed.accessToken, 'refreshed-access-token');
    assert.equal(refreshed.refreshToken, 'rotated-refresh-token');
    await assert.rejects(
      () => client.refresh('dead-refresh'),
      (err) => err.code === 'gog_auth_expired'
    );
  });

  await t.test('identity: isLoggedIn/userId/username', async () => {
    const user = await client.getUserData({ accessToken: 'fake-access-token-value' });
    assert.equal(user.userKey, '1234567890');
    assert.equal(user.username, 'gog_tester');
    assert.equal(user.galaxyUserId, '5555555555');
    state.userDataStatus = 401;
    await assert.rejects(
      () => client.getUserData({ accessToken: 'expired' }),
      (err) => err.code === 'gog_auth_expired'
    );
    state.userDataStatus = 200;
  });

  await t.test('getFilteredProducts walks 100-per-page pagination', async () => {
    const all = await client.fetchAllProducts({ accessToken: 'fake-access-token-value' });
    assert.deepEqual(state.productCalls, [1, 2]);
    assert.equal(all.totalPages, 2);
    assert.equal(all.totalProducts, 4);
    assert.equal(all.complete, true);
    assert.equal(all.products.length, 4);
    const witcher = all.products[0];
    assert.equal(witcher.gogGameId, '1207658924');
    assert.equal(witcher.slug, 'the_witcher_3_wild_hunt');
    assert.equal(witcher.isGame, true);
    assert.deepEqual(all.pages, [1, 2]);
  });

  await t.test('a 302 to the login page is auth_expired, not an empty library', async () => {
    state.productsStatus = 302;
    await assert.rejects(
      () => client.getFilteredProducts({ accessToken: 'expired' }, { page: 1 }),
      (err) => err.code === 'gog_auth_expired'
    );
    state.productsStatus = 200;
  });

  await t.test('sessions: time_sum is minutes; 404 is a real zero', async () => {
    const session = await client.getSessions({ accessToken: 't', userKey: '1234567890' }, '1207658924');
    assert.equal(session.minutes, 1200);
    assert.equal(session.found, true);
    assert.deepEqual(state.sessionCalls.at(-1), {
      productId: '1207658924',
      userId: '1234567890',
    });
    state.sessionsStatus = 404;
    const missing = await client.getSessions({ accessToken: 't', userKey: '1234567890' }, '404404');
    assert.equal(missing.minutes, 0);
    assert.equal(missing.found, false);
    state.sessionsStatus = 401;
    await assert.rejects(
      () => client.getSessions({ accessToken: 't', userKey: '1234567890' }, '1'),
      (err) => err.code === 'gog_auth_expired'
    );
    state.sessionsStatus = 200;
  });

  await t.test('429 trips a 30-minute breaker and the next call is refused locally', async () => {
    state.rateLimitOnce = true;
    await assert.rejects(
      () => client.getFilteredProducts({ accessToken: 't' }, { page: 1 }),
      (err) => err.code === 'gog_rate_limited' && Boolean(err.retryAt)
    );
    await assert.rejects(
      () => client.getFilteredProducts({ accessToken: 't' }, { page: 1 }),
      (err) => err.code === 'gog_rate_limited'
    );
  });

  await t.test('maskSecrets strips user tokens, codes and the client secret', () => {
    const masked = gog.maskSecrets(
      'https://auth.gog.com/token?client_secret=abc&code=xyz&refresh_token=r1&access_token=a1'
    );
    assert.equal(masked.includes('abc'), false);
    assert.equal(masked.includes('xyz'), false);
    assert.equal(masked.includes('r1'), false);
    assert.equal(masked.includes('a1'), false);
    assert.match(masked, /client_secret=\*\*\*/);
    assert.equal(gog.maskSecrets('Authorization: Bearer very.secret.token'), 'Authorization: Bearer ***');
  });

  await t.test('library fingerprint is the owned product ids in order', () => {
    assert.equal(
      gog.libraryFingerprint([
        { gogGameId: '1' },
        { gogGameId: '2' },
        { gogGameId: '1' },
      ]),
      '1,2,1'
    );
  });

  await t.test('token directory/file are 0600 and never written to the real cache', () => {
    gogCache.saveToken('1234567890', { accessToken: 'a', refreshToken: 'r' });
    const file = gogCache.tokenPath('1234567890');
    assert.ok(file.startsWith(CACHE_DIR));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  });
});
