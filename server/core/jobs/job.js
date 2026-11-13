'use strict';

function normalizeProgress(value, total) {
  return {
    current: value == null ? null : value,
    total: total == null ? null : total,
  };
}

function createJobShape(ctx) {
  const { now } = ctx;

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
        return ctx.finish(job, result);
      },
      fail(err) {
        return ctx.fail(job, err);
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

  function createJob(fields = {}) {
    const { seed, ...rest } = fields;
    const job = {
      id: rest.id || ctx.newId(seed),
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
    return snapshot(ctx.get(id));
  }

  return { createJob, attachMethods, snapshot, status };
}

module.exports = { createJobShape };
