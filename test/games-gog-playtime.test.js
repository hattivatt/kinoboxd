'use strict';

/**
 * GOG playtime (M6c): the 01.11.2026 «0.00 ч при часах в профиле» bug.
 *
 * What is pinned here:
 *   - the `{uid}` of `gameplay.gog.com/games/{id}/users/{uid}/sessions` is the
 *     **Galaxy** id (OAuth `user_id`, then `userData.json.galaxyUserId`), never
 *     `userData.json.userId` — that field was the production bug;
 *   - `time_sum` is minutes; a session list is summed, a 200 without any
 *     recognizable field is **not** a zero;
 *   - a 404 is a real zero but is re-checked on a later import instead of being
 *     frozen forever;
 *   - the first three raw answers of a run are dumped for the user.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-gog-playtime-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-gog-playtime-state-'));

const gameCache = require('../server/games/game-cache');
const gogCache = require('../server/games/gog-cache');
const gogImport = require('../server/games/gog-import');
const gog = require('../server/games/gog');

const STEAM_ID = '76561198000000011';
const OWNER = `steam-${STEAM_ID}`;
const USER_KEY = '1234567890';
const GALAXY_ID = '5555555555';

const PRODUCTS = [
  { gogGameId: '1207658924', title: 'Majesty 2 Collection', slug: 'majesty_2', category: 'game', isGame: true },
  { gogGameId: '1423049311', title: 'Gothic 2 Gold', slug: 'gothic_2_gold', category: 'game', isGame: true },
  { gogGameId: '1999999999', title: 'Never Played', slug: 'never_played', category: 'game', isGame: true },
];

/** A fake GOG client whose answers can be shaped per test. */
function fakeApi({ answers = {}, onSession = null } = {}) {
  const calls = [];
  return {
    calls,
    async exchangeCode() {
      return {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        userId: GALAXY_ID,
      };
    },
    async getUserData() {
      return {
        userKey: USER_KEY,
        username: 'gog_tester',
        // Deliberately different from the token `user_id`: this is exactly the
        // pair that broke production.
        galaxyUserId: GALAXY_ID,
      };
    },
    async refresh() {
      return {
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        userId: GALAXY_ID,
      };
    },
    async fetchAllProducts() {
      return {
        products: PRODUCTS,
        pages: [1],
        totalPages: 1,
        totalProducts: PRODUCTS.length,
        productsPerPage: 100,
        complete: true,
      };
    },
    async getSessions(tokenDoc, gogGameId, options = {}) {
      calls.push({ gogGameId, tokenDoc, raw: options.raw === true });
      if (onSession) return onSession(gogGameId, tokenDoc, options);
      if (gogGameId === '1999999999') {
        return { gogGameId, minutes: 0, found: false, status: 'not_found', uidSource: 'token:user_id' };
      }
      return { gogGameId, minutes: 240, found: true, status: 'ok', field: 'time_sum', uidSource: 'token:user_id' };
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

async function seed() {
  await gameCache.saveProfile({
    userKey: STEAM_ID,
    personaName: 'tester',
    ownerLabel: 'Me',
    importedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
  });
}

test('GOG playtime: uid, response shapes, diagnostics', async (t) => {
  await seed();

  await t.test('gameplayUserId prefers the OAuth user_id, then galaxyUserId', () => {
    assert.deepEqual(gog.gameplayUserId({ userId: GALAXY_ID, userKey: USER_KEY }), {
      uid: GALAXY_ID,
      source: 'token:user_id',
    });
    // The production case: the token has no `userId` yet, `galaxyUserId` is the
    // Galaxy id, `userKey` is `userData.json.userId` (the wrong field).
    assert.deepEqual(gog.gameplayUserId({ userKey: USER_KEY, galaxyUserId: GALAXY_ID }), {
      uid: GALAXY_ID,
      source: 'userData:galaxyUserId',
    });
    // Legacy document: only the old field is known.
    assert.deepEqual(gog.gameplayUserId({ userKey: USER_KEY }), {
      uid: USER_KEY,
      source: 'userData:userId',
    });
    assert.deepEqual(gog.gameplayUserId({}), { uid: null, source: null });
    assert.deepEqual(gog.gameplayUserId(null), { uid: null, source: null });
  });

  await t.test('minutesOfSessionsPayload: time_sum, timeSum, session lists', () => {
    assert.deepEqual(gog.minutesOfSessionsPayload({ time_sum: 1200 }), {
      minutes: 1200,
      field: 'time_sum',
    });
    assert.deepEqual(gog.minutesOfSessionsPayload({ time_sum: '90' }), {
      minutes: 90,
      field: 'time_sum',
    });
    assert.deepEqual(gog.minutesOfSessionsPayload({ timeSum: 30 }), {
      minutes: 30,
      field: 'timeSum',
    });
    // A session list is summed — the same quantity, not an invented one.
    assert.deepEqual(
      gog.minutesOfSessionsPayload({
        sessions: [{ time: 30 }, { time_sum: 15 }, { minutes: 5 }, { duration_minutes: 10 }],
      }),
      { minutes: 60, field: 'sessions[]', sessions: 4 }
    );
    assert.deepEqual(gog.minutesOfSessionsPayload({ sessions: [] }), {
      minutes: 0,
      field: 'sessions[]',
      sessions: 0,
    });
    // No recognizable field is NOT a zero.
    assert.deepEqual(gog.minutesOfSessionsPayload({ ok: true }), { minutes: null, field: null });
    assert.deepEqual(gog.minutesOfSessionsPayload(null), { minutes: null, field: null });
    assert.deepEqual(gog.minutesOfSessionsPayload({ time_sum: 'abc' }), {
      minutes: null,
      field: null,
    });
  });

  await t.test('connect stores both ids; the job sends the Galaxy uid', async () => {
    const api = fakeApi();
    await gogImport.connect({ code: 'ok', profile: OWNER, client: api });
    const token = gogCache.getToken(USER_KEY);
    assert.equal(token.userId, GALAXY_ID);
    // The import persists `galaxyUserId` on the token so an old account heals
    // without a reconnect.
    const job = gogImport.startImport({ account: USER_KEY, client: api, force: true, budget: 50 });
    const status = await waitForJob(job.jobId);
    assert.equal(status.status, 'done');
    assert.equal(gogCache.getToken(USER_KEY).galaxyUserId, GALAXY_ID);
    assert.equal(status.playtime.uidSource, 'token:user_id');
    assert.equal(status.playtime.ok, 2);
    assert.equal(status.playtime.notFound, 1);
    assert.equal(status.playtime.fields.time_sum, 2);
    assert.equal(status.playtime.targets, 3);
    assert.equal(status.playtime.sample.length, 3);
    assert.deepEqual(
      status.playtime.sample.map((entry) => entry.name),
      ['Majesty 2 Collection', 'Gothic 2 Gold', 'Never Played']
    );
    assert.equal(status.playtime.sample[0].hours, 4);
    assert.equal(status.playtime.sample[2].hours, 0);
    assert.equal(status.playtime.sample[2].status, 'not_found');
  });

  await t.test('the first three raw answers are dumped (no token inside)', async () => {
    const dumps = gogCache.listDebugDumps();
    assert.equal(dumps.length, 3);
    const doc = gogCache.getDebugDump('1207658924');
    assert.equal(doc.kind, 'sessions-raw');
    assert.equal(doc.gogGameId, '1207658924');
    assert.equal(doc.status, 'ok');
    assert.equal(doc.field, 'time_sum');
    assert.equal(doc.minutes, 240);
    assert.match(doc.urlShape, /gameplay\.gog\.com\/games\/\{gogGameId\}\/users\/\{uid\}\/sessions/);
    const serialized = JSON.stringify(doc);
    assert.equal(serialized.includes('access-1'), false);
    assert.equal(serialized.includes('refresh-1'), false);
  });

  await t.test('a 200 without a field stays pending, not zero', async () => {
    const api = fakeApi({
      onSession: (gogGameId) => ({
        gogGameId,
        minutes: null,
        found: false,
        status: 'unparsed',
        httpStatus: 200,
        field: null,
        raw: '{"ok":true}',
      }),
    });
    const job = gogImport.startImport({ account: USER_KEY, client: api, force: true, budget: 50 });
    const status = await waitForJob(job.jobId);
    assert.equal(status.playtime.unparsed, 3);
    assert.equal(status.playtime.ok, 0);
    const playtime = gogCache.getPlaytime(USER_KEY);
    assert.deepEqual(playtime.minutes, {});
    assert.equal(playtime.entries['1207658924'].status, 'unparsed');
    // The raw body is kept for the user even when nothing parsed.
    assert.match(gogCache.getDebugDump('1207658924').raw, /ok/);
  });

  await t.test('a zero written with the old uid is re-checked at once', async () => {
    const first = fakeApi();
    await waitForJob(
      gogImport.startImport({ account: USER_KEY, client: first, force: true, budget: 50 }).jobId
    );
    assert.equal(first.calls.length, 3);

    // Simulate the production snapshot of 01.11.2026: zeros written while the
    // client sent `userData.json.userId` as the uid. After the fix the next
    // import must re-ask them instead of trusting the zeros forever.
    const stale = gogCache.getPlaytime(USER_KEY);
    gogCache.savePlaytime(USER_KEY, { ...stale, uidSource: 'userData:userId' });

    const second = fakeApi();
    const status = await waitForJob(
      gogImport.startImport({ account: USER_KEY, client: second, budget: 50 }).jobId
    );
    assert.deepEqual(second.calls.map((call) => call.gogGameId), ['1999999999']);
    assert.equal(status.playtime.notFound, 1);
  });

  await t.test('a fresh zero with the same uid is not re-asked (24 h window)', async () => {
    const api = fakeApi();
    const status = await waitForJob(
      gogImport.startImport({ account: USER_KEY, client: api, budget: 50 }).jobId
    );
    // The zero was re-checked seconds ago by the previous subtest, with the
    // same uid: no request, no budget spent.
    assert.deepEqual(api.calls, []);
    assert.equal(status.playtime.targets, 3);
    assert.equal(status.playtime.cached, 3);
  });

  await t.test('the raw dump is capped and marked when truncated', () => {
    const long = 'x'.repeat(6000);
    const cut = gog.truncateBody(long, 5 * 1024);
    assert.equal(cut.length > 5 * 1024, true);
    assert.match(cut, /\[truncated \d+ B\]/);
    assert.equal(gog.truncateBody('{"time_sum":1}'), '{"time_sum":1}');
  });
});
