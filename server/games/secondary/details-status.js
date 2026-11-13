'use strict';

const { isoOf, nowMs } = require('./normalize');
const {
  MAX_STATUS_ERRORS,
  MAX_KICK_HISTORY,
  readStatusState,
  breakerBlock,
  catalogAttemptsForOwner,
} = require('./store');
const { kickCooldownMs } = require('./details-config');
const { lastKickAtFor } = require('./details-state');
const { runningFor } = require('./details-job');
const { coverageForOwner } = require('./details-coverage');

function statusForOwner(ownerKey) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  const coverage = coverageForOwner(key);
  const state = readStatusState();
  const lastKick = lastKickAtFor(key);
  const kicks = state.kicks
    .filter((kick) => kick && kick.ownerKey === key)
    .slice(-MAX_KICK_HISTORY);
  const last = kicks.length ? kicks[kicks.length - 1] : null;
  const gogBreaker = breakerBlock('gog');
  const epicBreaker = breakerBlock('epic');
  const ownerSkips = (state.skips && state.skips[key]) || {};
  const cooldownUntil = lastKick ? isoOf(lastKick + kickCooldownMs()) : null;
  const kickCooldownActive = Boolean(
    lastKick && nowMs() - lastKick < kickCooldownMs()
  );
  return {
    profile: key || null,
    resolved: coverage.resolved,
    total: coverage.total,
    pending: coverage.pending,
    partial: coverage.partial,
    retryablePartial: coverage.retryablePartial,
    healable: coverage.healable,
    running: runningFor(key),
    bySource: {
      gog: { ...coverage.gog },
      epic: {
        ...coverage.epic,
        lastSkip: ownerSkips.epic || null,
        binding: coverage.epicBinding || { state: 'none', accountId: null },
      },
    },
    catalogAttempts: catalogAttemptsForOwner(key),
    slugless: coverage.slugless,
    lastErrors: state.lastErrors
      .filter((entry) => entry && entry.ownerKey === key)
      .slice(-MAX_STATUS_ERRORS),
    cooldownUntil: kickCooldownActive ? cooldownUntil : null,
    cooldownActive: kickCooldownActive,
    breakers: {
      gog: gogBreaker ? { until: gogBreaker.until, code: gogBreaker.code } : null,
      epic: epicBreaker ? { until: epicBreaker.until, code: epicBreaker.code } : null,
    },
    kick: {
      lastKickAt: lastKick ? isoOf(lastKick) : null,
      lastJobId: last ? last.jobId || null : null,
      lastResult: last ? last.result || null : null,
      lastSkipped: last && last.result === 'skipped' ? last.skipped || null : null,
      lastTrigger: last ? last.trigger || null : null,
      history: kicks,
    },
    lastRunAt: state.lastRunAt || null,
    checkedAt: isoOf(nowMs()),
  };
}

module.exports = {
  statusForOwner,
};
