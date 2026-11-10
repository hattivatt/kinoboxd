'use strict';

const fs = require('fs');

const { STATUS_PATH, readStatusState } = require('./store');

const jobs = new Map();
const lastKick = new Map();
// `ownerKey → {at, pending}` — a *negative* coverage verdict, memoized because
// `/stats` is polled (see `kickFromStats`).
const coverageMemo = new Map();

/** Latest kick of one owner, memory first, then the persisted ledger. */
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

/** Test helper: forget job/cooldown state between cases. */
function resetJobs() {
  jobs.clear();
  lastKick.clear();
  coverageMemo.clear();
  try {
    fs.rmSync(STATUS_PATH, { force: true });
  } catch (err) {
    /* nothing to clean */
  }
}

module.exports = {
  jobs,
  lastKick,
  coverageMemo,
  lastKickAtFor,
  resetJobs,
};
