'use strict';

/**
 * SteamSpy client (M4): tags parser, the "unknown app" skeleton, the 1.1 s
 * politeness pause, the persisted 30-minute breaker and deferred (never
 * negative-cached) network/5xx failures. No network: `request` is injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-spy-'));
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-spy-state-'));

const spy = require('../server/games/spy');
const gameCache = require('../server/games/game-cache');
const { readFixture } = require('./fixtures/games/fake-client');

function fixture(appid) {
  return JSON.parse(readFixture(`spy-${appid}.json`));
}

test('parseSpyDetails: real Portal 2 fragment → weighted tags sorted heaviest first', () => {
  const doc = spy.parseSpyDetails(fixture(620), 620);
  assert.equal(doc.appid, 620);
  assert.equal(doc.success, true);
  assert.equal(doc.unavailable, false);
  assert.equal(doc.name, 'Portal 2');
  assert.equal(doc.developer, 'Valve');
  assert.equal(doc.publisher, 'Valve');
  assert.equal(doc.positive, 427835);
  assert.equal(doc.negative, 5675);
  assert.equal(doc.owners, '5,000,000 .. 10,000,000');
  assert.equal(doc.ccu, 1959);
  assert.equal(doc.metadataSource, 'steamspy');
  assert.ok(doc.tags.length >= 15);
  // Sorted by weight, not by the object's insertion order.
  for (let index = 1; index < doc.tags.length; index++) {
    assert.ok(doc.tags[index - 1].weight >= doc.tags[index].weight);
  }
  assert.deepEqual(doc.tags[0], { name: 'Platformer', weight: 7477 });
  const names = doc.tags.map((tag) => tag.name);
  assert.ok(names.includes('Puzzle'));
  assert.ok(names.includes('Story Rich'));
});

test('parseSpyDetails: the live "unknown app" skeleton is an answer, not metadata', () => {
  const doc = spy.parseSpyDetails(fixture('unknown'), 99999999);
  assert.equal(doc.success, false);
  assert.equal(doc.unavailable, true);
  assert.equal(doc.reason, 'no_data');
  assert.deepEqual(doc.tags, []);
  assert.equal(doc.name, null);
});

test('parseTags: drops empty/zero/non-numeric weights, caps the list', () => {
  const tags = spy.parseTags({
    RPG: 100,
    Broken: 'nope',
    Zero: 0,
    Negative: -5,
    '': 50,
    ' Open World ': 90,
  });
  assert.deepEqual(tags, [
    { name: 'RPG', weight: 100 },
    { name: 'Open World', weight: 90 },
  ]);
  const many = {};
  for (let index = 0; index < 80; index++) many[`Tag ${index}`] = 1000 - index;
  assert.equal(spy.parseTags(many).length, spy.MAX_TAGS);
  assert.deepEqual(spy.parseTags(null), []);
  assert.deepEqual(spy.parseTags([]), []);
});

test('spyFresh honours the TTL and a missing fetchedAt is stale', () => {
  const now = Date.now();
  assert.equal(spy.spyFresh({ fetchedAt: new Date(now).toISOString() }, 1000), true);
  assert.equal(
    spy.spyFresh({ fetchedAt: new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString() }, undefined),
    false
  );
  assert.equal(spy.spyFresh({}, 1000), false);
  assert.equal(spy.spyFresh(null, 1000), false);
});

test('createClient: one request per appid, 1.1 s pause, clean parse', async () => {
  const calls = [];
  const waits = [];
  let clock = 0;
  const client = spy.createClient({
    request: async (url) => {
      calls.push(url);
      return { status: 200, headers: {}, body: readFixture('spy-292030.json') };
    },
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  const first = await client.getAppTags(292030);
  const second = await client.getAppTags(292030);
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^https:\/\/steamspy\.com\/api\.php\?request=appdetails&appid=292030$/);
  // The second request waits the remainder of the 1100 ms window.
  assert.deepEqual(waits, [1100]);
});

test('createClient: 429 trips a persisted 30-minute breaker for steamspy.com only', async () => {
  let calls = 0;
  const client = spy.createClient({
    request: async () => {
      calls++;
      return { status: 429, headers: {}, body: '' };
    },
    sleep: async () => {},
    pauseMs: 0,
  });
  await assert.rejects(() => client.getAppTags(620), (err) => {
    assert.equal(err.code, 'spy_rate_limited');
    assert.ok(err.retryAt);
    return true;
  });
  assert.equal(calls, 1);
  const breaker = gameCache.readBreaker();
  assert.ok(breaker['steamspy.com']);
  assert.ok(breaker['steamspy.com'].until > Date.now());
  assert.equal(breaker['store.steampowered.com'], undefined);

  // A second call is refused without touching the network.
  await assert.rejects(() => client.getAppTags(570), (err) => {
    assert.equal(err.code, 'spy_rate_limited');
    return true;
  });
  assert.equal(calls, 1);
});

test('createClient: network/5xx/non-JSON are deferred and never trip the breaker', async () => {
  // The 429 test above persisted a breaker; start from a clean state.
  gameCache.writeBreaker({});
  const cases = [
    {
      response: async () => {
        throw Object.assign(new Error('dns'), { code: 'ENOTFOUND' });
      },
      expected: 'spy_unreachable',
    },
    { response: async () => ({ status: 503, headers: {}, body: '' }), expected: 'spy_http_error' },
    { response: async () => ({ status: 200, headers: {}, body: '<html>blocked</html>' }), expected: 'spy_http_error' },
  ];
  for (const entry of cases) {
    const client = spy.createClient({ request: entry.response, sleep: async () => {}, pauseMs: 0 });
    await assert.rejects(() => client.getAppTags(620), (err) => {
      assert.equal(err.code, entry.expected);
      return true;
    });
    assert.equal(client.breakerEntry(), null);
  }
  // Nothing was written to the cache by any of those failures.
  assert.equal(gameCache.getSpy(620), null);
});

test('createClient: an invalid appid is rejected before any request', async () => {
  let calls = 0;
  const client = spy.createClient({
    request: async () => {
      calls++;
      return { status: 200, headers: {}, body: '{}' };
    },
  });
  await assert.rejects(() => client.getAppTags('nope'), (err) => {
    assert.equal(err.code, 'spy_invalid_appid');
    return true;
  });
  assert.equal(calls, 0);
});
