'use strict';

/**
 * Steam Store `appdetails` client (M2): release-date parser, clean parser and
 * the politeness layer (one appid per request, 1.7 s pause, 30 min breaker,
 * deferred network/5xx — never a negative cache).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-store-'));
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-store-state-'));

const store = require('../server/games/store');
const gameCache = require('../server/games/game-cache');
const { readFixture } = require('./fixtures/games/fake-client');

function fixture(appid) {
  return JSON.parse(readFixture(`appdetails-${appid}.json`));
}

test('parseReleaseDate: every live format, honest precision, sane year bounds', () => {
  assert.deepEqual(store.parseReleaseDate('18 May, 2015'), {
    text: '18 May, 2015',
    year: 2015,
    month: 5,
    day: 18,
    precision: 'day',
  });
  const us = store.parseReleaseDate('Apr 18, 2011');
  assert.equal(us.year, 2011);
  assert.equal(us.month, 4);
  assert.equal(us.day, 18);
  assert.equal(us.precision, 'day');

  const month = store.parseReleaseDate('September 2026');
  assert.equal(month.year, 2026);
  assert.equal(month.month, 9);
  assert.equal(month.day, null);
  assert.equal(month.precision, 'month');

  const quarter = store.parseReleaseDate('Q4 2026');
  assert.equal(quarter.year, 2026);
  assert.equal(quarter.precision, 'quarter');
  assert.equal(quarter.quarter, 4);

  assert.deepEqual(
    { year: store.parseReleaseDate('2026').year, precision: store.parseReleaseDate('2026').precision },
    { year: 2026, precision: 'year' }
  );
  assert.equal(store.parseReleaseDate('Late 2026').year, 2026);
  assert.equal(store.parseReleaseDate('Coming soon').year, null);
  assert.equal(store.parseReleaseDate('Coming soon').precision, 'unknown');
  // A placeholder year outside 1970..2100 must not create a fake decade.
  assert.equal(store.parseReleaseDate('1 Jan, 1900').year, null);
  assert.equal(store.parseReleaseDate('').year, null);
  assert.equal(store.parseReleaseDate(null).year, null);
});

test('parseAppDetailsResponse: real Portal 2 fragment', () => {
  const parsed = store.parseAppDetailsResponse(fixture(620), 620);
  assert.equal(parsed.found, true);
  const doc = parsed.doc;
  assert.equal(doc.success, true);
  assert.equal(doc.type, 'game');
  assert.equal(doc.name, 'Portal 2');
  assert.equal(doc.is_free, false);
  assert.deepEqual(doc.developers, ['Valve']);
  assert.deepEqual(doc.publishers, ['Valve']);
  assert.deepEqual(
    doc.genres.map((entry) => entry.description),
    ['Action', 'Adventure']
  );
  assert.ok(doc.categories.some((entry) => entry.description === 'Single-player'));
  assert.ok(doc.categories.some((entry) => entry.description === 'Multi-player'));
  assert.equal(doc.release_date.date, '18 Apr, 2011');
  assert.equal(doc.release_date.coming_soon, false);
  assert.equal(doc.releaseYear, 2011);
  assert.equal(doc.releasePrecision, 'day');
  assert.equal(doc.dlcCount, 1);
  assert.equal(doc.metacritic.score, 95);
  assert.deepEqual(doc.platforms, { windows: true, mac: false, linux: true });
  assert.equal(doc.screenshots.length, 3);
  assert.equal(doc.earlyAccess, false);
  assert.equal(doc.metadataSource, 'steam-store');
  // Heavy store fields are not carried into the cache document.
  assert.equal(doc.detailed_description, undefined);
  assert.equal(doc.price_overview, undefined);
});

test('parseAppDetailsResponse: DLC type and a success:false answer', () => {
  const dlc = store.parseAppDetailsResponse(fixture(355880), 355880).doc;
  assert.equal(dlc.success, true);
  assert.equal(dlc.type, 'dlc');
  assert.match(dlc.name, /Expansion Pass/);

  const unavailable = store.parseAppDetailsResponse(
    { 999: { success: false } },
    999
  );
  assert.equal(unavailable.found, true);
  assert.equal(unavailable.doc.success, false);
  assert.equal(unavailable.doc.unavailable, true);
  assert.equal(unavailable.doc.type, null);

  // A missing key is a malformed answer (deferred), not a negative verdict.
  assert.deepEqual(store.parseAppDetailsResponse({}, 999), { found: false, doc: null });
});

test('createClient: one appid per request, 1.7 s pause, clean parse', async () => {
  const requests = [];
  const sleeps = [];
  let clock = 100000;
  const client = store.createClient({
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    request: async (url) => {
      requests.push(url);
      clock += 100;
      return { status: 200, body: JSON.stringify(fixture(620)), headers: {} };
    },
  });
  const first = await client.getAppDetails(620);
  const second = await client.getAppDetails(620);
  assert.equal(first.success, true);
  assert.equal(second.name, 'Portal 2');
  assert.equal(requests.length, 2);
  for (const url of requests) {
    assert.match(url, /store\.steampowered\.com\/api\/appdetails\?/);
    assert.match(url, /appids=620/);
    assert.match(url, /l=english/);
    // Batch was verified broken live (400 for any 2 appids): never send a list.
    assert.doesNotMatch(url, /appids=620[,\d]/);
  }
  // The first request has no pause before it; the second waits the remaining
  // 1600 ms of the 1700 ms window (100 ms was consumed by the request).
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 1600);
});

test('createClient: 429 trips a persisted 30-minute breaker', async () => {
  gameCache.writeBreaker({});
  let calls = 0;
  let clock = 100000;
  const client = store.createClient({
    now: () => clock,
    sleep: async () => {},
    breakerMs: 30 * 60 * 1000,
    request: async () => {
      calls++;
      return { status: 429, body: '', headers: {} };
    },
  });
  await assert.rejects(() => client.getAppDetails(620), (err) => {
    assert.equal(err.code, 'store_rate_limited');
    assert.ok(err.retryAt);
    return true;
  });
  assert.equal(calls, 1);
  const breaker = gameCache.readBreaker();
  assert.ok(breaker[store.STORE_HOST].until > clock);

  // The breaker is persisted: a fresh client does not hit the host either.
  const second = store.createClient({ now: () => clock, sleep: async () => {} });
  await assert.rejects(() => second.getAppDetails(570), (err) => {
    assert.equal(err.code, 'store_rate_limited');
    return true;
  });
  assert.equal(calls, 1);
  gameCache.writeBreaker({});
});

test('createClient: network/5xx/non-JSON are deferred and never trip the breaker', async () => {
  gameCache.writeBreaker({});
  const network = store.createClient({
    request: async () => {
      const err = new Error('boom');
      err.code = 'ECONNRESET';
      throw err;
    },
  });
  await assert.rejects(() => network.getAppDetails(620), (err) => {
    assert.equal(err.code, 'store_unreachable');
    return true;
  });
  assert.deepEqual(gameCache.readBreaker(), {});

  const server = store.createClient({
    request: async () => ({ status: 503, body: 'oops', headers: {} }),
  });
  await assert.rejects(() => server.getAppDetails(620), (err) => {
    assert.equal(err.code, 'store_http_error');
    assert.equal(err.status, 503);
    return true;
  });

  const broken = store.createClient({
    request: async () => ({ status: 200, body: '<html>', headers: {} }),
  });
  await assert.rejects(() => broken.getAppDetails(620), (err) => {
    assert.equal(err.code, 'store_http_error');
    return true;
  });

  // A real "no store page" answer is returned, not thrown.
  const unavailable = store.createClient({
    request: async () => ({
      status: 200,
      body: JSON.stringify({ 620: { success: false } }),
      headers: {},
    }),
  });
  const doc = await unavailable.getAppDetails(620);
  assert.equal(doc.success, false);
  assert.equal(doc.unavailable, true);
  assert.deepEqual(gameCache.readBreaker(), {});
});

test('detailsFresh honours the TTL and a missing fetchedAt is stale', () => {
  const now = Date.now();
  assert.equal(
    store.detailsFresh({ fetchedAt: new Date(now - 1000).toISOString() }, 60 * 1000),
    true
  );
  assert.equal(
    store.detailsFresh({ fetchedAt: new Date(now - 2 * 60 * 1000).toISOString() }, 60 * 1000),
    false
  );
  assert.equal(store.detailsFresh({}, 60 * 1000), false);
  assert.equal(store.detailsFresh(null, 60 * 1000), false);
});
