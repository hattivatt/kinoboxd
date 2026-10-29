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
 * spend the same Литрес budget (2 requests + 2 s per book). Running them at the
 * same time would double the politeness debt on litres.ru and race the link
 * cache. A tiny file lock (`cache-book/resolve.lock`) is the shared gate; it
 * needs no daemon, works across processes, and a killed run is recovered by the
 * stale check below.
 *
 * The lock is best-effort by design: if it cannot be taken within `waitMs`, the
 * caller decides (scheduled job exits 0, import logs a warning and skips this
 * pass instead of corrupting the cache).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const bookCache = require('./book-cache');

const LOCK_NAME = 'resolve.lock';
/** A pass that has held the lock longer than this is considered dead. */
const DEFAULT_STALE_MS = 90 * 60 * 1000;
const DEFAULT_POLL_MS = 2000;

function lockPath() {
  return path.join(bookCache.BOOK_CACHE_DIR, LOCK_NAME);
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
    // EPERM means the process exists but belongs to another user (the systemd
    // unit and the server can run as different users): still alive.
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

/**
 * Is the lock held by a live process? `staleMs` bounds a lock left behind by a
 * killed run whose pid has been reused; a live pid within the window wins.
 */
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

/**
 * Try to take the lock once. Returns a token on success, `null` when another
 * live owner holds it. A stale lock file is replaced.
 */
function tryAcquire(owner) {
  if (isLocked()) return null;
  const token = `${process.pid}:${Date.now()}:${crypto.randomBytes(6).toString('hex')}`;
  const payload = {
    schemaVersion: 1,
    token,
    pid: process.pid,
    owner: String(owner || 'resolve'),
    startedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(bookCache.BOOK_CACHE_DIR, { recursive: true });
    const fd = fs.openSync(lockPath(), 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(payload), 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    return token;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      // The holder may have just died between `isLocked` and `open`.
      if (isLocked()) return null;
      try {
        fs.unlinkSync(lockPath());
      } catch (unlinkErr) {
        return null;
      }
      return tryAcquire(owner);
    }
    // A read-only cache must not crash the job: the caller treats it as busy.
    return null;
  }
}

/**
 * Acquire the lock, polling until `waitMs` runs out. Returns
 * `{ok, token, waitedMs}`; `ok:false` means the caller must not run the pass.
 */
async function acquireLock(options = {}) {
  const owner = options.owner || 'resolve';
  const waitMs = Number.isFinite(Number(options.waitMs)) ? Math.max(0, Number(options.waitMs)) : 0;
  const pollMs = Number.isFinite(Number(options.pollMs))
    ? Math.max(50, Number(options.pollMs))
    : DEFAULT_POLL_MS;
  const sleep = options.sleep || sleepDefault;
  const started = Date.now();
  for (;;) {
    const token = tryAcquire(owner);
    if (token) return { ok: true, token, waitedMs: Date.now() - started };
    if (Date.now() - started >= waitMs) return { ok: false, token: null, waitedMs: Date.now() - started };
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
