'use strict';

/**
 * Cross-process lock for the games personnel (Wikidata/Moby) pass.
 *
 * Two callers can walk the same `cache-games`:
 *   - the in-process job started by an import/refresh/enrich or by a lazy
 *     `GET /api/games/personnel` (`jobs.js`), and
 *   - the manual `node server/games/personnel/backfill.js` (a *separate*
 *     process, possibly the monthly `kinoboxd-games-personnel` oneshot later).
 *
 * Both write `personnel/<appid>.json` and spend the same WDQS budget (one
 * SPARQL batch per ≤450 values). Running them together would double the
 * politeness debt on query.wikidata.org and race the per-game documents. A tiny
 * file lock (`<state>/games/personnel.lock`) is the shared gate; it needs no
 * daemon, works across processes, and a killed run is recovered by the stale
 * check below (same design as `books/resolve-lock.js`).
 *
 * Best-effort by design: when the lock cannot be taken within `waitMs`, the
 * caller skips this pass instead of corrupting the cache.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const gameCache = require('../game-cache');

const LOCK_NAME = 'personnel.lock';
/** A pass that has held the lock longer than this is considered dead. */
const DEFAULT_STALE_MS = 60 * 60 * 1000;
const DEFAULT_POLL_MS = 1000;

function lockPath() {
  return path.join(gameCache.STATE_DIR, LOCK_NAME);
}

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user (systemd unit vs
    // server). Still alive.
    return err && err.code === 'EPERM';
  }
}

function readLock() {
  try {
    const raw = fs.readFileSync(lockPath(), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch (err) {
    return null;
  }
}

/** Is the lock held by a live process (and not older than `staleMs`)? */
function isLocked(options = {}) {
  const now = options.now == null ? Date.now() : Number(options.now);
  const staleMs = Number.isFinite(Number(options.staleMs))
    ? Number(options.staleMs)
    : DEFAULT_STALE_MS;
  const current = readLock();
  if (!current) return false;
  const startedAt = Date.parse(String(current.startedAt || ''));
  const age = Number.isFinite(startedAt) ? now - startedAt : Infinity;
  if (age > staleMs) return false;
  if (current.pid == null) return false;
  if (Number(current.pid) === process.pid) return true;
  return pidAlive(current.pid);
}

/** Try to take the lock once: a token on success, `null` when it is busy. */
function tryAcquire(owner) {
  if (isLocked()) return null;
  const token = `${process.pid}:${Date.now()}:${crypto.randomBytes(6).toString('hex')}`;
  const payload = {
    schemaVersion: 1,
    token,
    pid: process.pid,
    owner: String(owner || 'games-personnel'),
    startedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(gameCache.STATE_DIR, { recursive: true });
    const fd = fs.openSync(lockPath(), 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(payload), 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    return token;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      // The holder may have died between `isLocked` and `open`.
      if (isLocked()) return null;
      try {
        fs.unlinkSync(lockPath());
      } catch (unlinkErr) {
        return null;
      }
      return tryAcquire(owner);
    }
    // A read-only state dir must not crash the job: the caller treats it busy.
    return null;
  }
}

/**
 * Acquire the lock, polling until `waitMs` runs out.
 * Returns `{ok, token, waitedMs}`; `ok:false` means the pass must not run.
 */
async function acquireLock(options = {}) {
  const owner = options.owner || 'games-personnel';
  const waitMs = Number.isFinite(Number(options.waitMs)) ? Math.max(0, Number(options.waitMs)) : 0;
  const pollMs = Number.isFinite(Number(options.pollMs))
    ? Math.max(50, Number(options.pollMs))
    : DEFAULT_POLL_MS;
  const sleep = options.sleep || sleepDefault;
  const started = Date.now();
  for (;;) {
    const token = tryAcquire(owner);
    if (token) return { ok: true, token, waitedMs: Date.now() - started };
    if (Date.now() - started >= waitMs) {
      return { ok: false, token: null, waitedMs: Date.now() - started };
    }
    await sleep(Math.min(pollMs, Math.max(1, waitMs - (Date.now() - started))));
  }
}

/** Release the lock only when this process still owns it. */
function releaseLock(token) {
  if (!token) return false;
  const current = readLock();
  if (!current || current.token !== token) return false;
  try {
    fs.unlinkSync(lockPath());
    return true;
  } catch (err) {
    return false;
  }
}

/** Test helper: remove the lock file regardless of owner. */
function clearLock() {
  try {
    fs.unlinkSync(lockPath());
  } catch (err) {
    /* already gone */
  }
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
