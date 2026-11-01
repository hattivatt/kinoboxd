'use strict';

/**
 * `/api/games/gog/*` HTTP contract (M6a): auth-url → auth → status → import →
 * logout, with a fake GOG client. The token never appears in a response.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-gog-routes-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-gog-routes-state-'));

const { createRouter } = require('../server/games/routes-gog');
const gameCache = require('../server/games/game-cache');
const gogCache = require('../server/games/gog-cache');
const gog = require('../server/games/gog');

const PORT = 7083;
const STEAM_ID = '76561198000000001';
const OWNER = `steam-${STEAM_ID}`;
const USER_KEY = '1234567890';

function fakeClient() {
  return {
    authorizeUrl() {
      return 'https://auth.gog.com/auth?client_id=test-client&response_type=code';
    },
    async exchangeCode(code) {
      if (code === 'bad') throw new gog.GogError('GOG не принял code', 'gog_invalid_code');
      if (code === 'bad-client') {
        throw new gog.GogError('GOG отклонил client credentials', 'gog_client_rejected', { status: 502 });
      }
      return {
        accessToken: 'secret-access-token',
        refreshToken: 'secret-refresh-token',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        userId: USER_KEY,
      };
    },
    async getUserData() {
      return { userKey: USER_KEY, username: 'gog_tester', galaxyUserId: '555', country: 'US' };
    },
    async refresh() {
      return {
        accessToken: 'refreshed',
        refreshToken: 'refreshed-refresh',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
    },
    async fetchAllProducts() {
      return {
        products: [
          { gogGameId: '1207658924', title: 'The Witcher 3', slug: 'the_witcher_3_wild_hunt' },
          { gogGameId: '1999999999', title: 'GOG Exclusive', slug: 'gog_exclusive' },
        ],
        pages: [1],
        totalPages: 1,
        totalProducts: 2,
        productsPerPage: 100,
        complete: true,
      };
    },
    async getSessions(tokenDoc, gogGameId) {
      return { gogGameId, minutes: gogGameId === '1207658924' ? 600 : 30, found: true };
    },
  };
}

function buildApp(client) {
  const app = express();
  app.use(express.json());
  app.use('/api/games/gog', createRouter({ client }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code, retryAt: err.retryAt });
    }
    console.error('[test] unhandled', err);
    res.status(500).json({ error: 'internal', code: 'internal_error' });
  });
  return app;
}

async function waitForJob(base, jobId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${base}/api/games/gog/import/${jobId}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    if (body.done) return body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`GOG job ${jobId} did not finish`);
}

test('GOG routes', async (t) => {
  await gameCache.saveProfile({
    userKey: STEAM_ID,
    personaName: 'tester',
    importedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
  });
  const server = buildApp(fakeClient()).listen(PORT);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${PORT}`;
  const responses = [];
  const call = async (url, options) => {
    const response = await fetch(`${base}${url}`, options);
    const body = await response.json();
    responses.push(JSON.stringify(body));
    return { status: response.status, body };
  };

  await t.test('auth-url returns the login URL and the client source only', async () => {
    const { status, body } = await call('/api/games/gog/auth-url');
    assert.equal(status, 200);
    assert.match(body.url, /^https:\/\/auth\.gog\.com\/auth\?/);
    assert.equal(body.redirectUri, gog.REDIRECT_URI);
    assert.equal(body.clientSource, 'default');
    assert.equal(JSON.stringify(body).includes('secret'), false);
    // The user may paste the whole redirect URL, not only the bare code.
    assert.match(body.instructions, /ссылк/i);
    const extra = await call('/api/games/gog/auth-url?foo=1');
    assert.equal(extra.status, 400);
    assert.equal(extra.body.code, 'unexpected_parameter');
  });

  await t.test('auth requires a code and stores the token server-side', async () => {
    const missing = await call('/api/games/gog/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'gog_code_required');

    const connected = await call('/api/games/gog/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'one-time-code' }),
    });
    assert.equal(connected.status, 200);
    assert.equal(connected.body.connected, true);
    assert.equal(connected.body.account.userKey, USER_KEY);
    assert.equal(connected.body.account.ownerProfile, OWNER);
    assert.equal(JSON.stringify(connected.body).includes('secret-access-token'), false);
    assert.equal(gogCache.getToken(USER_KEY).accessToken, 'secret-access-token');
    assert.equal(fs.statSync(gogCache.tokenPath(USER_KEY)).mode & 0o777, 0o600);
  });

  await t.test('rejected code → 400, broken client pair → 502', async () => {
    const bad = await call('/api/games/gog/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'bad' }),
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'gog_invalid_code');

    const rejected = await call('/api/games/gog/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'bad-client' }),
    });
    assert.equal(rejected.status, 502);
    assert.equal(rejected.body.code, 'gog_client_rejected');
  });

  await t.test('status lists a sanitized account and the owner catalogue', async () => {    const { status, body } = await call('/api/games/gog/status');
    assert.equal(status, 200);
    assert.equal(body.accounts.length, 1);
    assert.equal(body.accounts[0].username, 'gog_tester');
    assert.equal(JSON.stringify(body).includes('secret-access-token'), false);
    assert.equal(JSON.stringify(body).includes('secret-refresh-token'), false);
    assert.deepEqual(body.owners.map((owner) => owner.key), [OWNER]);
    assert.equal(body.budget, 200);
  });

  await t.test('import → job done → library/playtime snapshots', async () => {
    const started = await call('/api/games/gog/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: `gog-${USER_KEY}`, force: true }),
    });
    assert.equal(started.status, 201);
    const job = await waitForJob(base, started.body.jobId);
    assert.equal(job.status, 'done');
    assert.equal(job.libraryCount, 2);
    assert.equal(job.playtimeGames, 2);
    assert.equal(gogCache.getLibrary(USER_KEY).products.length, 2);
    assert.equal(gogCache.getPlaytime(USER_KEY).minutes['1207658924'], 600);
  });

  await t.test('an unknown job id is 404, a missing id is 400', async () => {
    const missing = await call('/api/games/gog/import/status');
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'job_id_required');
    const unknown = await call('/api/games/gog/import/nope');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'unknown_job');
  });

  await t.test('the Steam profiles catalogue shows GOG as a same-owner library', async () => {
    const gamesRoutes = require('../server/games/routes');
    const app2 = express();
    app2.use('/api/games', gamesRoutes.createRouter({ client: fakeClient() }));
    const server2 = app2.listen(0);
    const port2 = server2.address().port;
    try {
      const response = await fetch(`http://127.0.0.1:${port2}/api/games/profiles`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.connected, ['steam', 'gog']);
      assert.equal(body.gog.accounts, 1);
      const profile = body.profiles.find((entry) => entry.key === OWNER);
      assert.equal(profile.libraries.length, 1);
      assert.equal(profile.libraries[0].source, 'gog');
      assert.equal(profile.libraries[0].key, `gog-${USER_KEY}`);
      assert.equal(JSON.stringify(body).includes('secret-access-token'), false);
      // The GOG profile document must never appear as a Steam owner.
      assert.equal(body.profiles.some((entry) => entry.key === `steam-${USER_KEY}`), false);
    } finally {
      await new Promise((resolve) => server2.close(resolve));
    }
  });

  await t.test('logout deletes the token but keeps the dated snapshot', async () => {
    const { status, body } = await call('/api/games/gog/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: `gog-${USER_KEY}` }),
    });
    assert.equal(status, 200);
    assert.equal(body.disconnected, true);
    assert.equal(body.snapshotKept, true);
    assert.equal(gogCache.getToken(USER_KEY), null);
    assert.ok(gogCache.getLibrary(USER_KEY));
    const idempotent = await call('/api/games/gog/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(idempotent.status, 200);
    assert.equal(idempotent.body.disconnected, false);
  });

  await t.test('no response ever carried a token value', () => {
    const all = responses.join('\n');
    assert.equal(all.includes('secret-access-token'), false);
    assert.equal(all.includes('secret-refresh-token'), false);
    assert.equal(all.includes('one-time-code'), false);
  });
});
