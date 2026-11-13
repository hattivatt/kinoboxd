'use strict';

const fs = require('fs');

const { createJobs } = require('../../core/jobs');
const { STATUS_PATH, readStatusState } = require('./store');

const jobs = createJobs({
  name: 'games-secondary-details',
  idPrefix: 'secondary-details',
  maxJobs: 50,
  keyOf: (job) => job.ownerKey,
});

const lastKick = new Map();
const coverageMemo = new Map();

function lastKickAtFor(ownerKey) {
  const key = String(ownerKey == null ? '' : ownerKey);
  const memory = lastKick.get(key);
  if (memory) return memory;
  const state = readStatusState();
  let latest = 0;
  for (const kick of state.kicks) {
    if (!kick || kick.ownerKey !== key) continue;
    if (kick.result === 'skipped') continue;
    const at = Date.parse(kick.at || '');
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  if (latest) lastKick.set(key, latest);
  return latest || null;
}

function resetJobs() {
  jobs.clear();
  jobs.resetCooldown();
  lastKick.clear();
  coverageMemo.clear();
  try {
    fs.rmSync(STATUS_PATH, { force: true });
  } catch (err) {
  }
}

module.exports = {
  jobs,
  lastKick,
  coverageMemo,
  lastKickAtFor,
  resetJobs,
};
