'use strict';

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
