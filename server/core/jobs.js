'use strict';

/**
 * In-memory job registry: one implementation for every `start*` / `getStatus`
 * pair in the server (P3, U3).
 *
 * Before this module nine registries repeated the same five things: an id
 * generator, a `MAX_JOBS` ring, a `findRunning` scan, a serialization chain
 * and a `done`/`finishedAt` finalizer. They differed only in the domain fields
 * they carry and in the public shape their `getStatus` returns. Here the
 * mechanics live once; the domain keeps its own public mapping (a facade), so
 * every legacy field of every job response stays byte-identical.
 *
 * Contract:
 *
 *   const jobs = createJobs({ name, idPrefix, maxJobs, cooldownMs, now, keyOf,
 *                             maskError, errorCode });
 *
 *   jobs.createJob(fields)         -> job object (NOT remembered yet)
 *   jobs.remember(job)             -> ring retention (oldest evicted)
 *   jobs.get(id)                   -> job | undefined
 *   jobs.list() / jobs.values()    -> jobs in insertion order
 *   jobs.findRunning(key, pred?)   -> live job for `key` | null
 *   jobs.isRunning(key, pred?)     -> boolean
 *   jobs.start(key, task, opts)    -> single-flight create + remember + run
 *   jobs.run(job, task, opts)      -> serialized execution + finalize
 *   jobs.finish(job, result?)      -> default finalizer (status/done/finishedAt)
 *   jobs.fail(job, err)            -> default error snapshot
 *   jobs.snapshot(job)             -> unified status view
 *   jobs.status(id)                -> snapshot | null
 *   jobs.lastFinish(key)           -> { at, status, skipped } | null
 *   jobs.cooldownRemaining(key, { ignore }) -> ms left in the re-run window
 *   jobs.resetCooldown()           -> forget every re-run window
 *   jobs.whenIdle()                -> wait for every chain to settle
 *
 * Job methods (non-enumerable, attached at creation):
 *
 *   job.setStage(name, current?, total?)  — stage + progress in one call
 *   job.setProgress(current, total)
 *   job.set(fields)                       — Object.assign into the job
 *   job.finish(result?) / job.fail(err)   — early finalize from the task
 *
 * Naming note. The plan sketch spells the stage setter `job.stage(name, …)`,
 * but `job.stage` is the legacy string every registry writes (`job.stage =
 * 'library'`) and every public status returns (`stage: job.stage`); turning it
 * into a function would change nine payloads and their tests. The string stays
 * and the setter is `job.setStage`. The same applies to `job.done`: it is the
 * boolean the payload exposes, so the "job finished" call is `job.finish()`.
 *
 * What stays in the domain (deliberately):
 *
 *   - persistent phase state (`state/games/enrich-state.json`, franchise-state,
 *     resume cursors) — jobs are process-local and vanish on restart, exactly
 *     like the nine maps they replace;
 *   - the meaning of "done": a domain may set `job.status`/`job.stage` itself
 *     before the finalizer runs (`skipped`, `deferred`, `failed` are all
 *     domain verdicts, not registry ones);
 *   - the public status shape and its masking rules.
 *
 * `now` is injectable so the cooldown window is testable without sleeping.
 */

const crypto = require('crypto');

const { safeKey } = require('./fs-store');

const DEFAULT_MAX_JOBS = 20;

function defaultMaskError(err) {
  if (err && err.message) return String(err.message);
  if (typeof err === 'string' && err) return err;
  return 'unknown error';
}

function normalizeProgress(value, total) {
  return {
    current: value == null ? null : value,
    total: total == null ? null : total,
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.name] log/label name, e.g. `games-import`
 * @param {string} [options.idPrefix] id prefix (default: `name`)
 * @param {number} [options.maxJobs] retention ring, 0 = unlimited
 * @param {number} [options.cooldownMs] re-run window between finishes (0 = off)
 * @param {() => number} [options.now] clock injection for tests
 * @param {(job: object) => string|null} [options.keyOf] single-flight key
 * @param {(err: Error) => string} [options.maskError] message masker
 * @param {string} [options.errorCode] default `code` on an uncaught throw
 */
function createJobs(options = {}) {
  const name = String(options.name || 'jobs');
  const idPrefix = String(options.idPrefix || name);
  const maxJobs = options.maxJobs == null
    ? DEFAULT_MAX_JOBS
    : Math.max(0, Math.floor(Number(options.maxJobs) || 0));
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const cooldownMs = Math.max(0, Number(options.cooldownMs) || 0);
  const keyOf = typeof options.keyOf === 'function'
    ? options.keyOf
    : (job) => (job && job.key != null ? String(job.key) : null);
  const maskError = typeof options.maskError === 'function'
    ? options.maskError
    : defaultMaskError;
  const errorCode = String(options.errorCode || `${name}_failed`);

  const byId = new Map();
  const order = [];
  /** key -> { at, status, skipped }: the re-run window (personnel, franchise). */
  const finishes = new Map();
  /** chainKey -> promise; `null` is the registry-wide chain. */
  const chains = new Map();

  /* ---------------------------------------------------------------- */
  /* Ids and retention                                                */
  /* ---------------------------------------------------------------- */

  function newId(seed) {
    const part = seed == null || seed === '' ? 'job' : safeKey(seed);
    return `${idPrefix}-${part}-${now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  }

  function attachMethods(job) {
    const methods = {
      setStage(stage, current, total) {
        job.stage = stage;
        if (current !== undefined) job.progress = normalizeProgress(current, total);
        return job;
      },
      setProgress(current, total) {
        job.progress = normalizeProgress(current, total);
        return job;
      },
      set(fields) {
        if (fields && typeof fields === 'object') Object.assign(job, fields);
        return job;
      },
      finish(result) {
        return finish(job, result);
      },
      fail(err) {
        return fail(job, err);
      },
    };
    for (const [key, fn] of Object.entries(methods)) {
      Object.defineProperty(job, key, {
        value: fn,
        enumerable: false,
        writable: false,
        configurable: true,
      });
    }
    return job;
  }

  /**
   * Build a job. `seed` names the id; `fields` are the domain's own fields
   * (status/stage/startedAt included — a domain may override every default).
   */
  function createJob(fields = {}) {
    const { seed, ...rest } = fields;
    const job = {
      id: rest.id || newId(seed),
      status: 'running',
      stage: 'queued',
      done: false,
      percent: 0,
      progress: normalizeProgress(null, null),
      startedAt: now(),
      finishedAt: null,
      error: null,
      partial: null,
      data: {},
      ...rest,
    };
    return attachMethods(job);
  }

  function remember(job) {
    byId.set(job.id, job);
    order.push(job.id);
    while (maxJobs > 0 && order.length > maxJobs) {
      const stale = order.shift();
      if (stale !== job.id) byId.delete(stale);
    }
    return job;
  }

  function get(id) {
    return byId.get(String(id == null ? '' : id));
  }

  function list() {
    return [...byId.values()];
  }

  /* ---------------------------------------------------------------- */
  /* Single-flight                                                    */
  /* ---------------------------------------------------------------- */

  function isLive(job) {
    if (!job || job.done) return false;
    if (job.stage === 'failed') return false;
    return job.status == null || job.status === 'running';
  }

  function defaultCoalesce(job, key) {
    const own = keyOf(job);
    if (own != null && String(own) === key) return true;
    return Array.isArray(job.aliasKeys) && job.aliasKeys.map(String).includes(key);
  }

  function findRunning(key, coalesce) {
    const match = typeof coalesce === 'function' ? coalesce : defaultCoalesce;
    const wanted = String(key);
    for (const job of byId.values()) {
      if (!isLive(job)) continue;
      if (match(job, wanted)) return job;
    }
    return null;
  }

  function isRunning(key, coalesce) {
    return Boolean(findRunning(key, coalesce));
  }

  /* ---------------------------------------------------------------- */
  /* Execution                                                        */
  /* ---------------------------------------------------------------- */

  function chainFor(chainKey) {
    const key = chainKey == null ? null : String(chainKey);
    if (!chains.has(key)) chains.set(key, Promise.resolve());
    return chains.get(key);
  }

  function defaultFinalize(job) {
    if (job.finishedAt == null) job.finishedAt = now();
    if (job.status === 'running') {
      if (job.stage === 'failed') {
        job.status = 'failed';
      } else {
        job.status = 'done';
        if (job.stage === 'queued' || job.stage === 'running') job.stage = 'done';
        job.percent = 100;
      }
    }
    job.done = job.status !== 'running';
    return job;
  }

  function finish(job, result) {
    if (result && typeof result === 'object') Object.assign(job, result);
    defaultFinalize(job);
    noteFinish(job);
    return job;
  }

  function fail(job, err) {
    const deferred = Boolean(err && err.deferred);
    job.status = deferred ? 'deferred' : 'failed';
    job.stage = job.status;
    if (deferred) job.deferred = true;
    job.code = (err && err.code) || errorCode;
    job.error = maskError(err);
    if (err && err.retryAt) job.retryAt = err.retryAt;
    return job;
  }

  /**
   * Run `task(job)` on the registry chain (`opts.chainKey` selects a per-key
   * chain, like the GOG import does per account) and finalize the job.
   *
   * `opts.onError(job, err)` replaces the default error snapshot (the books
   * import keeps its own `stage`-driven failure shape). `opts.finish === false`
   * skips the default finalizer and lets `opts.onFinish(job)` do it, which is
   * what the books import needs (`done` is false for a failed job there).
   */
  function run(job, task, opts = {}) {
    const chainKey = opts.chainKey == null ? null : String(opts.chainKey);
    const previous = chainFor(chainKey);
    const next = previous
      .catch(() => {})
      .then(() => task(job))
      .catch((err) => {
        if (typeof opts.onError === 'function') return opts.onError(job, err);
        return fail(job, err);
      })
      .then(() => {
        if (opts.finish !== false) defaultFinalize(job);
        if (opts.finish !== false) noteFinish(job);
        if (typeof opts.onFinish === 'function') opts.onFinish(job);
        return job;
      });
    chains.set(chainKey, next);
    return next;
  }

  /**
   * Single-flight start: a live job for `key` (or one of its `aliasKeys`, or
   * whatever `opts.coalesce` accepts) is returned as-is; otherwise a job is
   * created, remembered and queued.
   */
  function start(key, task, opts = {}) {
    const existing = findRunning(key, opts.coalesce);
    if (existing) return existing;
    const job = createJob({
      seed: opts.seed == null ? key : opts.seed,
      // The default `keyOf` reads `job.key`; a domain with its own key field
      // (`profile`, `userKey`, `targetKey`, `uploadId`) passes it in `fields`
      // and simply ignores this one.
      key: String(key),
      ...(opts.fields || {}),
    });
    remember(job);
    run(job, task, opts);
    return job;
  }

  function whenIdle() {
    const pending = [...chains.values()].map((promise) => promise.catch(() => {}));
    if (!pending.length) return Promise.resolve();
    return Promise.all(pending).then(() => undefined);
  }

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
    if (!(cooldownMs > 0)) return 0;
    const record = finishes.get(String(key));
    if (!record) return 0;
    const ignore = typeof opts.ignore === 'function'
      ? opts.ignore
      : (entry) => entry.status === 'failed';
    if (ignore(record)) return 0;
    const left = record.at + cooldownMs - now();
    return left > 0 ? left : 0;
  }

  function resetCooldown() {
    finishes.clear();
  }

  /* ---------------------------------------------------------------- */
  /* Status                                                           */
  /* ---------------------------------------------------------------- */

  /** The unified view every domain facade can spread into its own shape. */
  function snapshot(job) {
    if (!job) return null;
    return {
      id: job.id,
      status: job.status == null ? 'running' : job.status,
      stage: job.stage,
      progress: normalizeProgress(
        job.progress ? job.progress.current : null,
        job.progress ? job.progress.total : null
      ),
      startedAt: job.startedAt == null ? null : job.startedAt,
      finishedAt: job.finishedAt == null ? null : job.finishedAt,
      error: job.error == null ? null : job.error,
      partial: job.partial == null ? null : job.partial,
    };
  }

  function status(id) {
    return snapshot(get(id));
  }

  return {
    name,
    idPrefix,
    maxJobs,
    cooldownMs,
    createJob,
    remember,
    get,
    list,
    values: list,
    findRunning,
    isRunning,
    start,
    run,
    finish,
    fail,
    snapshot,
    status,
    lastFinish,
    cooldownRemaining,
    resetCooldown,
    whenIdle,
    newId,
  };
}

module.exports = { createJobs, DEFAULT_MAX_JOBS };
