'use strict';

const path = require('path');

const bookCache = require('./book-cache');
const core = require('../core/lock');

const LOCK_NAME = 'resolve.lock';
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

async function acquireLock(options = {}) {
  return lock.acquire(options);
}

function releaseLock(token) {
  return lock.release(token);
}

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
