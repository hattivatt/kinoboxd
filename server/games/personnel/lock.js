'use strict';

/**
 * Cross-process lock for the games personnel (Wikidata/Moby) pass.
 *
 * Two callers can walk the same `cache-games`:
 *   - the in-process job started by an import/refresh/enrich or by a lazy
 *     `GET /api/games/personnel` (`jobs.js`), and
 *   - the manual `node server/games/personnel/backfill.js` (a *separate*
 *     process, possibly the monthly `kinoboxd-games-personnel` oneshot).
 *
 * Both write `personnel/<appid>.json` and spend the same WDQS budget (one
 * SPARQL batch per <=450 values). Running them together would double the
 * politeness debt on query.wikidata.org and race the per-game documents.
 * The shared gate is `<state>/games/personnel.lock`; the implementation lives
 * in `server/core/lock.js` (the book resolve lock uses the same one).
 *
 * Best-effort by design: when the lock cannot be taken within `waitMs`, the
 * caller skips this pass instead of corrupting the cache.
 */

const path = require('path');

const gameCache = require('../game-cache');
const core = require('../../core/lock');

const LOCK_NAME = 'personnel.lock';
/** A pass that has held the lock longer than this is considered dead. */
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
