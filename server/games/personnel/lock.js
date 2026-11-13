'use strict';

const path = require('path');

const gameCache = require('../game-cache');
const core = require('../../core/lock');

const LOCK_NAME = 'personnel.lock';
const DEFAULT_STALE_MS = core.DEFAULT_STALE_MS;

const lock = core.createLock({
  path: path.join(gameCache.STATE_DIR, LOCK_NAME),
  name: 'games-personnel',
  staleMs: DEFAULT_STALE_MS,
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
