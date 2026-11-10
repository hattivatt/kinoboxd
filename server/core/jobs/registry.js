'use strict';

const crypto = require('crypto');

const { safeKey } = require('../fs-store');

/* ---------------------------------------------------------------- */
/* Ids and retention                                                */
/* ---------------------------------------------------------------- */

function createRegistry(ctx) {
  const { idPrefix, maxJobs, now } = ctx;

  const byId = new Map();
  const order = [];

  function newId(seed, prefix) {
    const part = seed == null || seed === '' ? 'job' : safeKey(seed);
    const head = prefix == null || prefix === '' ? idPrefix : String(prefix);
    return `${head}-${part}-${now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  }

  function remember(job) {
    if (typeof job.setStage !== 'function') ctx.attachMethods(job);
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

  return { newId, remember, get, list };
}

module.exports = { createRegistry };
