'use strict';

/**
 * `server/core/lock.js`: the single file lock both the book resolve chain and
 * the games personnel pass use. Covers ownership, staleness (age and dead pid),
 * the busy path and the directory bootstrap.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const core = require('../server/core/lock');

function tempLock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-lock-'));
  return core.createLock({ path: path.join(dir, 'nested', 'test.lock'), name: 'test-lock' });
}

function writeLock(lock, payload) {
  fs.mkdirSync(path.dirname(lock.path), { recursive: true });
  fs.writeFileSync(lock.path, JSON.stringify(payload), 'utf8');
}

test('acquire takes the lock, a second caller is busy, release frees it', () => {
  const lock = tempLock();
  const token = lock.tryAcquire('first');
  assert.ok(token);
  assert.equal(lock.isLocked(), true);
  assert.equal(lock.tryAcquire('second'), null);

  assert.equal(lock.release('foreign-token'), false);
  assert.equal(lock.isLocked(), true);

  assert.equal(lock.release(token), true);
  assert.equal(lock.isLocked(), false);
  assert.equal(fs.existsSync(lock.path), false);
});

test('a lock older than staleMs is ignored even when the pid is alive', () => {
  const lock = tempLock();
  writeLock(lock, {
    token: 'old',
    pid: process.pid,
    startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(lock.isLocked({ staleMs: 60 * 1000 }), false);
  assert.equal(lock.isLocked({ staleMs: 3 * 60 * 60 * 1000 }), true);
});

test('a dead pid does not hold the lock', () => {
  const lock = tempLock();
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  writeLock(lock, {
    token: 'dead',
    pid: child.pid,
    startedAt: new Date().toISOString(),
  });
  assert.equal(core.pidAlive(child.pid), false);
  assert.equal(lock.isLocked(), false);
});

test('acquire reports busy without waiting when waitMs is 0', async () => {
  const lock = tempLock();
  const token = lock.tryAcquire('holder');
  assert.ok(token);
  const result = await lock.acquire({ owner: 'waiter', waitMs: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.token, null);
  assert.ok(result.waitedMs >= 0);
  lock.release(token);
});

test('acquire polls until the holder releases', async () => {
  const lock = tempLock();
  const token = lock.tryAcquire('holder');
  assert.ok(token);
  setTimeout(() => lock.release(token), 40);
  const result = await lock.acquire({ owner: 'waiter', waitMs: 1000, pollMs: 50 });
  assert.equal(result.ok, true);
  assert.ok(result.token);
  lock.release(result.token);
});

test('a corrupt lock file is treated as free and replaced', () => {
  const lock = tempLock();
  fs.mkdirSync(path.dirname(lock.path), { recursive: true });
  fs.writeFileSync(lock.path, '{not json', 'utf8');
  assert.equal(lock.isLocked(), false);
  const token = lock.tryAcquire('next');
  assert.ok(token);
  assert.equal(lock.read().owner, 'next');
  lock.release(token);
});
