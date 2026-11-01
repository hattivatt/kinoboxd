'use strict';

/**
 * Steam review summary (M4): the `IUserReviewsService/GetAppReviews` envelope,
 * the cheapest request shape (`num_per_page: 1`, no review bodies), the 1.7 s
 * pause and a breaker that is separate from the store appdetails host.
 *
 * Live context (01.11.2026): the old `store.steampowered.com/appreviews/<id>`
 * feed was retired on 22.10.2026 and answers `302 -> /`; the Web API method
 * below needs no key and returns the same `query_summary`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-reviews-'));
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-reviews-state-'));

const store = require('../server/games/store');
const gameCache = require('../server/games/game-cache');
const { readFixture } = require('./fixtures/games/fake-client');

function fixture(appid) {
  return JSON.parse(readFixture(`reviews-${appid}.json`));
}

test('parseAppReviews: real Witcher 3 summary → score 9, desc, counts', () => {
  const doc = store.parseAppReviews(fixture(292030), 292030);
  assert.equal(doc.appid, 292030);
  assert.equal(doc.success, true);
  assert.equal(doc.score, 9);
  assert.equal(doc.desc, 'Overwhelmingly Positive');
  assert.ok(doc.positive > 800000);
  assert.ok(doc.negative > 30000);
  assert.ok(doc.total > 900000);
  assert.equal(doc.metadataSource, 'steam-reviews');
});

test('parseAppReviews: Portal 2 and Dota 2 keep their own levels', () => {
  const portal = store.parseAppReviews(fixture(620), 620);
  assert.equal(portal.score, 9);
  const dota = store.parseAppReviews(fixture(570), 570);
  assert.equal(dota.score, 8);
  assert.equal(dota.desc, 'Very Positive');
});

test('parseAppReviews: a response without query_summary is an honest "no reviews"', () => {
  const doc = store.parseAppReviews({ response: { reviews: [], cursor: '*' } }, 99999999);
  assert.equal(doc.success, false);
  assert.equal(doc.unavailable, true);
  assert.equal(doc.reason, 'no_summary');
  assert.equal(doc.score, null);
  assert.equal(doc.total, 0);
});

test('parseAppReviews: out-of-range scores are dropped, not clamped', () => {
  const doc = store.parseAppReviews(
    { response: { query_summary: { review_score: 12, review_score_desc: 'Nope', total_positive: 1 } } },
    1
  );
  assert.equal(doc.success, true);
  assert.equal(doc.score, null);
  assert.equal(doc.positive, 1);
});

test('reviewsUrl: the Web API method with one JSON blob, cheapest shape', () => {
  const url = new URL(store.reviewsUrl(292030));
  assert.equal(url.host, 'api.steampowered.com');
  assert.equal(url.pathname, '/IUserReviewsService/GetAppReviews/v1/');
  const input = JSON.parse(url.searchParams.get('input_json'));
  assert.deepEqual(input, {
    appid: 292030,
    filter: 1,
    languages: ['all'],
    purchase_type: 1,
    num_per_page: 1,
    cursor: '*',
    filter_offtopic_activity: false,
  });
});

test('createClient: 1.7 s pause between review requests, one request per appid', async () => {
  const calls = [];
  const waits = [];
  let clock = 0;
  const client = store.createClient({
    request: async (url) => {
      calls.push(url);
      return { status: 200, headers: {}, body: readFixture('reviews-292030.json') };
    },
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  const first = await client.getAppReviews(292030);
  const second = await client.getAppReviews(620);
  assert.equal(first.score, 9);
  assert.equal(second.score, 9);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [1700]);
});

test('createClient: 429 trips the reviews breaker only, not the store appdetails one', async () => {
  gameCache.writeBreaker({});
  let calls = 0;
  const client = store.createClient({
    request: async () => {
      calls++;
      return { status: 429, headers: {}, body: '' };
    },
    sleep: async () => {},
    reviewsPauseMs: 0,
    pauseMs: 0,
  });
  await assert.rejects(() => client.getAppReviews(292030), (err) => {
    assert.equal(err.code, 'reviews_rate_limited');
    assert.ok(err.retryAt);
    return true;
  });
  assert.equal(calls, 1);
  const breaker = gameCache.readBreaker();
  assert.ok(breaker[store.REVIEWS_BREAKER_KEY]);
  assert.equal(breaker['api.steampowered.com'], undefined);
  assert.equal(breaker['store.steampowered.com'], undefined);
  // appdetails is not blocked by a reviews 429 (different host, different key).
  assert.equal(client.breakerEntry(), null);
  // A second review call is refused without a request.
  await assert.rejects(() => client.getAppReviews(620), (err) => {
    assert.equal(err.code, 'reviews_rate_limited');
    return true;
  });
  assert.equal(calls, 1);
});

test('createClient: network/5xx/non-JSON are deferred, never cached, no breaker', async () => {
  gameCache.writeBreaker({});
  const cases = [
    {
      response: async () => {
        throw Object.assign(new Error('tls'), { code: 'ECONNRESET' });
      },
      expected: 'reviews_unreachable',
    },
    { response: async () => ({ status: 500, headers: {}, body: '' }), expected: 'reviews_http_error' },
    { response: async () => ({ status: 200, headers: {}, body: '<html>302</html>' }), expected: 'reviews_http_error' },
  ];
  for (const entry of cases) {
    const client = store.createClient({
      request: entry.response,
      sleep: async () => {},
      reviewsPauseMs: 0,
    });
    await assert.rejects(() => client.getAppReviews(292030), (err) => {
      assert.equal(err.code, entry.expected);
      return true;
    });
    assert.equal(client.reviewsBreakerEntry(), null);
  }
  assert.equal(gameCache.getReviews(292030), null);
});

test('reviewsFresh honours the TTL and a missing fetchedAt is stale', () => {
  const now = Date.now();
  assert.equal(store.reviewsFresh({ fetchedAt: new Date(now).toISOString() }, 1000), true);
  assert.equal(
    store.reviewsFresh(
      { fetchedAt: new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString() },
      undefined
    ),
    false
  );
  assert.equal(store.reviewsFresh({}, 1000), false);
});
