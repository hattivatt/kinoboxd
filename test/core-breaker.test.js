'use strict';

/**
 * `core/breaker.js` — the one breaker implementation.
 *
 * Two contracts are pinned:
 *   - memory mode (book providers): trip/isOpen/reset with an injectable clock;
 *   - persisted mode (games): the on-disk entry shape does not change, an
 *     expired entry is pruned and written back, and the custom ISO
 *     `{ until, at, code, status }` shape of secondary-details round-trips.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBreaker, toEpoch } = require('../server/core/breaker');

test('memory breaker: trip opens it for the cooldown, reset closes it', () => {
  let clock = 1_000_000;
  const breaker = createBreaker({ now: () => clock, cooldownMs: 1000 });
  assert.equal(breaker.isOpen('x'), false);
  const entry = breaker.trip('x', 'HTTP 429');
  assert.equal(entry.until, clock + 1000);
  assert.equal(entry.reason, 'HTTP 429');
  assert.equal(breaker.isOpen('x'), true);
  assert.equal(breaker.entry('x').until, clock + 1000);

  clock += 999;
  assert.equal(breaker.isOpen('x'), true);
  clock += 1;
  assert.equal(breaker.isOpen('x'), false);
  assert.equal(breaker.entry('x'), null);

  breaker.trip('x', 'blocked');
  breaker.reset('x');
  assert.equal(breaker.isOpen('x'), false);
});

test('memory breaker: cooldown can be a function and per-trip untilMs wins', () => {
  let clock = 0;
  let windowMs = 500;
  const breaker = createBreaker({ now: () => clock, cooldownMs: () => windowMs });
  breaker.trip('a');
  assert.equal(breaker.entry('a').until, 500);
  windowMs = 2000;
  breaker.trip('b', { untilMs: 100 });
  assert.equal(breaker.entry('b').until, 100);
});

test('persisted breaker keeps the epoch {until, reason, at} format', () => {
  let clock = 5_000;
  let disk = {};
  const writes = [];
  const breaker = createBreaker({
    now: () => clock,
    cooldownMs: 30 * 60 * 1000,
    read: () => disk,
    write: (state) => {
      disk = JSON.parse(JSON.stringify(state));
      writes.push(disk);
    },
  });

  breaker.trip('steamcommunity.com', 'HTTP 403');
  assert.deepEqual(disk, {
    'steamcommunity.com': {
      until: clock + 30 * 60 * 1000,
      reason: 'HTTP 403',
      at: clock,
    },
  });
  assert.equal(breaker.isOpen('steamcommunity.com'), true);

  // An expired entry is pruned and the pruning is persisted.
  clock += 30 * 60 * 1000;
  assert.equal(breaker.isOpen('steamcommunity.com'), false);
  assert.deepEqual(disk, {});
  assert.equal(writes.length, 2);
});

test('persisted breaker: replace/reset/state use raw state', () => {
  let disk = {};
  const breaker = createBreaker({
    now: () => 1000,
    read: () => disk,
    write: (state) => {
      disk = state;
    },
  });
  breaker.replace({ host: { until: 2000, reason: 'HTTP 429', at: 10 } });
  assert.deepEqual(breaker.state(), {
    host: { until: 2000, at: 10, reason: 'HTTP 429', code: null, status: null },
  });
  breaker.reset();
  assert.deepEqual(disk, {});
});

test('secondary-details ISO format round-trips code and status', () => {
  let disk = {};
  const isoEncode = (entry) => ({
    until: new Date(entry.until).toISOString(),
    at: new Date(entry.at).toISOString(),
    code: entry.code || 'blocked',
    status: entry.status == null ? null : entry.status,
  });
  const isoDecode = (raw) => {
    const until = toEpoch(raw && raw.until);
    if (until == null) return null;
    return {
      until,
      at: toEpoch(raw.at),
      reason: raw.code || null,
      code: raw.code || null,
      status: raw.status == null ? null : raw.status,
    };
  };
  let clock = Date.UTC(2026, 10, 3);
  const breaker = createBreaker({
    now: () => clock,
    cooldownMs: 30 * 60 * 1000,
    read: () => disk,
    write: (state) => {
      disk = state;
    },
    encode: isoEncode,
    decode: isoDecode,
  });
  breaker.trip('epic', { code: 'cms_blocked', status: 403 });
  assert.equal(typeof disk.epic.until, 'string');
  assert.equal(disk.epic.code, 'cms_blocked');
  assert.equal(disk.epic.status, 403);
  assert.equal(breaker.entry('epic').code, 'cms_blocked');
  assert.equal(breaker.entry('epic').until, clock + 30 * 60 * 1000);
});

test('toEpoch accepts epoch numbers, numeric strings and ISO strings', () => {
  assert.equal(toEpoch(1234), 1234);
  assert.equal(toEpoch('1234'), 1234);
  assert.equal(toEpoch('2026-11-03T00:00:00.000Z'), Date.UTC(2026, 10, 3));
  assert.equal(toEpoch(null), null);
  assert.equal(toEpoch('nonsense'), null);
});
