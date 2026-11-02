'use strict';

/**
 * Cross-process lock for the book metadata resolve chain.
 *
 * Two callers can walk the same `cache-book`:
 *   - the in-process resolve stage of a user import (`import.js`), and
 *   - the `kinoboxd-resolve-books` systemd oneshot (scheduled-resolve.js),
 *     a *separate process*.
 *
 * Both write `links/`, `details/`, `index.json` and `resolve-state/`, and both
 * spend the same Литрес budget (2 requests + 2 s per book). Running them at
 * the same time would double the politeness debt on litres.ru and race the
 * link cache. The shared gate is `cache-book/resolve.lock`; the implementation
 * lives in `server/core/lock.js` (the games personnel lock uses the same one).
 *
 * Best-effort by design: if it cannot be taken within `waitMs`, the caller
 * decides (the scheduled job exits 0, the import logs a warning and skips this
 * pass instead of corrupting the cache).
 */

const path = require('path');

const bookCache = require('./book-cache');
const core = require('../core/lock');

const LOCK_NAME = 'resolve.lock';
/** A pass that has held the lock longer than this is considered dead. */
const DEFAULT_STALE_MS = 90 * 60 * 1000;
const DEFAULT_POLL_MS = 2000;

const lock = core.createLock({
  path: path.join(bookCache.BOOK_CACHE_DIR, LOCK_NAME),
  name: 'resolve',
  staleMs: DEFAULT_STALE_MS,
  pollMs: DEFAULT_POLL_MS,
});

function lockPath() {
  return lock.path;
}

function isLocked(options = {}) {
  return lock.isLocked(options);
}

function tryAcquire(owner) {
  return lock.tryAcquire(owner);
}

/** Acquire the lock, polling until `waitMs` runs out. */
async function acquireLock(options = {}) {
  return lock.acquire(options);
}

function releaseLock(token) {
  return lock.release(token);
}

/** Test helper: remove the lock file regardless of owner. */
function clearLock() {
  lock.clear();
}

module.exports = {
  LOCK_NAME,
  DEFAULT_STALE_MS,
  lockPath,
  isLocked,
  tryAcquire,
  acquireLock,
  releaseLock,
  clearLock,
};
