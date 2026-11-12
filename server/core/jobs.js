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
 *   jobs.newId(seed, prefix?)      -> `<prefix>-<safeKey(seed)>-<ts36>-<hex>`
 *   jobs.remember(job)             -> ring retention (oldest evicted)
 *   jobs.get(id)                   -> job | undefined
 *   jobs.list() / jobs.values()    -> jobs in insertion order
 *   jobs.clear()                   -> forget every remembered job
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

const { createCooldown } = require('./jobs/cooldown');
const { createJobShape } = require('./jobs/job');
const { createLifecycle } = require('./jobs/lifecycle');
const { createRegistry } = require('./jobs/registry');

const DEFAULT_MAX_JOBS = 20;

function defaultMaskError(err) {
  if (err && err.message) return String(err.message);
  if (typeof err === 'string' && err) return err;
  return 'unknown error';
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
  const ctx = {
    name,
    idPrefix: String(options.idPrefix || name),
    maxJobs: options.maxJobs == null
      ? DEFAULT_MAX_JOBS
      : Math.max(0, Math.floor(Number(options.maxJobs) || 0)),
    now: typeof options.now === 'function' ? options.now : Date.now,
    cooldownMs: Math.max(0, Number(options.cooldownMs) || 0),
    keyOf: typeof options.keyOf === 'function'
      ? options.keyOf
      : (job) => (job && job.key != null ? String(job.key) : null),
    maskError: typeof options.maskError === 'function'
      ? options.maskError
      : defaultMaskError,
    errorCode: String(options.errorCode || `${name}_failed`),
  };
  Object.assign(
    ctx,
    createRegistry(ctx),
    createJobShape(ctx),
    createLifecycle(ctx),
    createCooldown(ctx)
  );

  return {
    name: ctx.name,
    idPrefix: ctx.idPrefix,
    maxJobs: ctx.maxJobs,
    cooldownMs: ctx.cooldownMs,
    createJob: ctx.createJob,
    remember: ctx.remember,
    get: ctx.get,
    list: ctx.list,
    values: ctx.list,
    clear: ctx.clear,
    findRunning: ctx.findRunning,
    isRunning: ctx.isRunning,
    start: ctx.start,
    run: ctx.run,
    finish: ctx.finish,
    fail: ctx.fail,
    snapshot: ctx.snapshot,
    status: ctx.status,
    lastFinish: ctx.lastFinish,
    cooldownRemaining: ctx.cooldownRemaining,
    resetCooldown: ctx.resetCooldown,
    whenIdle: ctx.whenIdle,
    newId: ctx.newId,
  };
}

module.exports = { createJobs, DEFAULT_MAX_JOBS };
