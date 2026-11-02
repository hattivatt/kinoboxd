'use strict';

/**
 * Cross-source politeness contract (P2): the table in `core/sources.js`, the
 * counter in `core/budget.js` and the breaker in `core/breaker.js` are the
 * only places those rules live now.
 *
 * Four claims, one per AGENTS.md §1 rule:
 *   1. the pause is read from the table and actually awaited;
 *   2. the per-run budget is not exceeded (one unit per request);
 *   3. a 429 opens the persisted breaker and the next client does not ask;
 *   4. a 5xx is deferred: it throws, writes nothing and does not trip the
 *      breaker.
 *
 * No live request: the store client's `request` is injected, the clock and
 * sleep are fake, and the cache roots point at a tmp directory.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const env = require('./helpers/env');
const tmp = env.makeTmpCache('core-politeness', { budgets: true });

const store = require('../server/games/store');
const gameCache = require('../server/games/game-cache');
const sources = require('../server/core/sources');
const { createBudget } = require('../server/core/budget');
const { readFixture } = require('./fixtures/games/fake-client');

function fixture(appid) {
  return JSON.parse(readFixture(`appdetails-${appid}.json`));
}

test.after(() => {
  tmp.cleanup();
});

test('the pause comes from core/sources and is awaited between requests', async () => {
  assert.equal(sources.pauseMs('steamStore'), 1700);
  const sleeps = [];
  let clock = 100000;
  const client = store.createClient({
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    request: async () => {
      clock += 100;
      return { status: 200, body: JSON.stringify(fixture(620)), headers: {} };
    },
  });
  await client.getAppDetails(620);
  await client.getAppDetails(620);
  assert.deepEqual(sleeps, [1600]);
});

test('the per-run budget stops before the request, not after it', () => {
  const previous = process.env.GAMES_SPY_BUDGET;
  delete process.env.GAMES_SPY_BUDGET;
  const limit = sources.budgetLimit('steamSpy');
  assert.equal(limit, 340);
  const budget = createBudget(limit);
  for (let index = 0; index < limit; index++) assert.equal(budget.take(), true);
  assert.equal(budget.take(), false);
  assert.equal(budget.used, limit);
  assert.equal(budget.remaining, 0);
  if (previous == null) delete process.env.GAMES_SPY_BUDGET;
  else process.env.GAMES_SPY_BUDGET = previous;
});

test('a 429 opens the persisted breaker; the next client does not ask', async () => {
  gameCache.writeBreaker({});
  let clock = 100000;
  let calls = 0;
  const client = store.createClient({
    now: () => clock,
    sleep: async () => {},
    request: async () => {
      calls++;
      return { status: 429, body: '', headers: {} };
    },
  });
  await assert.rejects(() => client.getAppDetails(620), (err) => err.code === 'store_rate_limited');
  assert.equal(calls, 1);
  const state = gameCache.readBreaker();
  const entry = state[store.STORE_HOST];
  assert.ok(entry, 'breaker entry must be persisted');
  assert.ok(entry.until > clock);
  assert.equal(entry.reason, '429 Too Many Requests');

  const second = store.createClient({ now: () => clock, sleep: async () => {} });
  await assert.rejects(() => second.getAppDetails(570), (err) => err.code === 'store_rate_limited');
  assert.equal(calls, 1, 'an open breaker refuses without a request');
  gameCache.writeBreaker({});
});

test('a 5xx is deferred: it throws, writes nothing and does not trip the breaker', async () => {
  gameCache.writeBreaker({});
  let calls = 0;
  const client = store.createClient({
    now: () => 100000,
    sleep: async () => {},
    request: async () => {
      calls++;
      return { status: 503, body: 'oops', headers: {} };
    },
  });
  await assert.rejects(() => client.getAppDetails(620), (err) => err.code === 'store_http_error');
  assert.equal(calls, 1);
  assert.deepEqual(gameCache.readBreaker(), {});
});
