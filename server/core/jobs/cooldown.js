'use strict';

function createCooldown(ctx) {
  const { now, cooldownMs, keyOf } = ctx;

  /** key -> { at, status, skipped }: the re-run window (personnel, franchise). */
  const finishes = new Map();

  /* ---------------------------------------------------------------- */
  /* Cooldown window                                                  */
  /* ---------------------------------------------------------------- */

  function noteFinish(job) {
    const key = keyOf(job);
    if (key == null) return;
    finishes.set(String(key), {
      at: job.finishedAt == null ? now() : job.finishedAt,
      status: job.status || null,
      skipped: job.skipped || null,
    });
  }

  function lastFinish(key) {
    return finishes.get(String(key)) || null;
  }

  /**
   * Milliseconds left before `key` may be kicked again; 0 when the window is
   * off, the key never finished, or `ignore(record)` says the last pass does
   * not count (a failed pass is never throttled; franchise also ignores a
   * `lock_busy` skip).
   */
  function cooldownRemaining(key, opts = {}) {
    const windowMs = opts.windowMs == null
      ? cooldownMs
      : Math.max(0, Number(opts.windowMs) || 0);
    if (!(windowMs > 0)) return 0;
    const record = finishes.get(String(key));
    if (!record) return 0;
    const ignore = typeof opts.ignore === 'function'
      ? opts.ignore
      : (entry) => entry.status === 'failed';
    if (ignore(record)) return 0;
    const left = record.at + windowMs - now();
    return left > 0 ? left : 0;
  }

  function resetCooldown() {
    finishes.clear();
  }

  return { noteFinish, lastFinish, cooldownRemaining, resetCooldown };
}

module.exports = { createCooldown };
