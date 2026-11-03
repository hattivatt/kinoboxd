'use strict';

/**
 * Optional SteamGridDB artwork provider. Key-gated: without a key it must be a
 * silent `skipped`, never a failure. No live request — `fetch` is injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-sgdb-'));
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-sgdb-state-'));

const sgdb = require('../server/games/steamgriddb');
const gameCache = require('../server/games/game-cache');
const { createBudget } = require('../server/core/budget');

function json(status, body) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async text() {
      return text;
    },
    async arrayBuffer() {
      return Buffer.from(text);
    },
  };
}

function recording(handler) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    return handler(String(url));
  };
  impl.calls = calls;
  return impl;
}

test('no key: provider is skipped without any request', async () => {
  const fetchImpl = recording(async () => json(500, {}));
  const result = await sgdb.resolveSteamGridDb(3669870, { key: null, fetch: fetchImpl });
  assert.equal(result.status, 'skipped');
  assert.equal(fetchImpl.calls.length, 0);
});

test('found: game id → vertical 600×900 grid URL', async () => {
  const fetchImpl = recording(async (url) => {
    if (url.includes('/games/steam/3669870')) return json(200, { success: true, data: { id: 4242 } });
    if (url.includes('/grids/game/4242')) {
      assert.match(url, /dimensions=600x900/);
      return json(200, {
        success: true,
        data: [
          { url: 'https://cdn2.steamgriddb.com/grid/horizontal.png', width: 920, height: 430 },
          { url: 'https://cdn2.steamgriddb.com/grid/vertical.png', width: 600, height: 900 },
        ],
      });
    }
    return json(404, {});
  });
  const result = await sgdb.resolveSteamGridDb(3669870, {
    key: 'test-key-not-real',
    fetch: fetchImpl,
    pauseMs: 0,
  });
  assert.deepEqual(result, {
    status: 'found',
    url: 'https://cdn2.steamgriddb.com/grid/vertical.png',
    source: 'steamgriddb',
  });
  assert.equal(fetchImpl.calls.length, 2);
});

test('no grid: a horizontal-only answer is «none», not a broken poster', async () => {
  const fetchImpl = recording(async (url) => {
    if (url.includes('/games/steam/')) return json(200, { success: true, data: { id: 7 } });
    return json(200, {
      success: true,
      data: [{ url: 'https://cdn2.steamgriddb.com/grid/horizontal.png', width: 920, height: 430 }],
    });
  });
  const result = await sgdb.resolveSteamGridDb(1, {
    key: 'k',
    fetch: fetchImpl,
    pauseMs: 0,
  });
  assert.equal(result.status, 'none');
  assert.equal(result.reason, 'no_grid');
});

test('a non-SteamGridDB host in the asset URL is rejected', async () => {
  const fetchImpl = recording(async (url) => {
    if (url.includes('/games/steam/')) return json(200, { success: true, data: { id: 7 } });
    return json(200, {
      success: true,
      data: [{ url: 'https://evil.example/grid.png', width: 600, height: 900 }],
    });
  });
  const result = await sgdb.resolveSteamGridDb(1, {
    key: 'k',
    fetch: fetchImpl,
    pauseMs: 0,
  });
  assert.equal(result.status, 'none');
  assert.equal(sgdb.allowedGridUrl('http://cdn2.steamgriddb.com/x.png'), false);
});

test('403 trips the persisted breaker; the next call is deferred without a request', async () => {
  gameCache.writeBreaker({});
  const fetchImpl = recording(async () => json(403, { success: false }));
  const first = await sgdb.resolveSteamGridDb(9, {
    key: 'k',
    fetch: fetchImpl,
    pauseMs: 0,
    retries: 0,
    sleep: async () => {},
  });
  assert.equal(first.status, 'deferred');
  assert.equal(first.reason, 'rate_limited');
  assert.ok(gameCache.readBreaker()[sgdb.BREAKER_KEY], 'the breaker is persisted');
  const callsBefore = fetchImpl.calls.length;
  const second = await sgdb.resolveSteamGridDb(10, {
    key: 'k',
    fetch: fetchImpl,
    pauseMs: 0,
  });
  assert.equal(second.status, 'deferred');
  assert.equal(second.reason, 'breaker');
  assert.equal(fetchImpl.calls.length, callsBefore, 'open breaker makes no request');
});

test('an exhausted per-run budget is «deferred», not «no art»', async () => {
  const fetchImpl = recording(async () => json(500, {}));
  const budget = createBudget(0);
  const result = await sgdb.resolveSteamGridDb(11, {
    key: 'k',
    fetch: fetchImpl,
    budget,
  });
  assert.equal(result.status, 'deferred');
  assert.equal(result.reason, 'budget');
  assert.equal(fetchImpl.calls.length, 0);
});
