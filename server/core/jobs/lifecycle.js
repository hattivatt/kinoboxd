'use strict';

function createLifecycle(ctx) {
  const { now, keyOf, maskError, errorCode } = ctx;

  /** chainKey -> promise; `null` is the registry-wide chain. */
  const chains = new Map();

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
    for (const job of ctx.list()) {
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
        // Every legacy finalizer forces the terminal stage, whatever stage the
        // task was in when it returned.
        job.stage = 'done';
        job.percent = 100;
      }
    }
    job.done = job.status !== 'running';
    return job;
  }

  function finish(job, result) {
    if (result && typeof result === 'object') Object.assign(job, result);
    defaultFinalize(job);
    ctx.noteFinish(job);
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
        if (opts.finish !== false) ctx.noteFinish(job);
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
    const job = ctx.createJob({
      seed: opts.seed == null ? key : opts.seed,
      // The default `keyOf` reads `job.key`; a domain with its own key field
      // (`profile`, `userKey`, `targetKey`, `uploadId`) passes it in `fields`
      // and simply ignores this one.
      key: String(key),
      ...(opts.fields || {}),
    });
    ctx.remember(job);
    run(job, task, opts);
    return job;
  }

  function whenIdle() {
    const pending = [...chains.values()].map((promise) => promise.catch(() => {}));
    if (!pending.length) return Promise.resolve();
    return Promise.all(pending).then(() => undefined);
  }

  return {
    findRunning,
    isRunning,
    start,
    run,
    finish,
    fail,
    whenIdle,
  };
}

module.exports = { createLifecycle };
