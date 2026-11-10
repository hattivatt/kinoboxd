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

/**
 * The owner-facing diagnostic (`GET /api/games/secondary-details/status`).
 * Contract: `{ resolved, total, pending, partial, retryablePartial, healable,
 * running, bySource, slugless[], lastErrors[], cooldownUntil, kick, lastRunAt }`.
 * Everything here is a cache/state read — the endpoint never makes a network
 * request.
 */
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
    // Degraded-but-present metadata: a detail document exists, but only one of
    // year/genres arrived. `retryablePartial` is the subset the catalog can
    // still complete (no attempt yet / probe TTL expired) — that subset, not
    // every partial, is what a lazy kick will address.
    partial: coverage.partial,
    retryablePartial: coverage.retryablePartial,
    // The subset of `partial` whose missing fact is already cached in the
    // identity bridge: the next job writes it without a request. Additive
    // diagnostic — it never changes the meaning of the counters above.
    healable: coverage.healable,
    running: runningFor(key),
    bySource: {
      gog: { ...coverage.gog },
      epic: {
        ...coverage.epic,
        // Why the last catalog step did not ask (`not_connected`, `no_token`,
        // `owner_mismatch`, `binding_ambiguous`, `probe`, `budget`,
        // `no_client`, `no_access_token`, …) — `null` when every due work was
        // actually asked. The owner can paste this text back.
        lastSkip: ownerSkips.epic || null,
        // Where the owner→account binding stands, independent of a job run.
        binding: coverage.epicBinding || { state: 'none', accountId: null },
      },
    },
    // The per-owner catalog ledger: which `catalogItemId`s were asked, what
    // the token answered, HTTP status/bytes and whether year/genres arrived.
    // `total: 0` is itself the answer to «did the job ever ask?».
    catalogAttempts: catalogAttemptsForOwner(key),
    slugless: coverage.slugless,
    lastErrors: state.lastErrors
      .filter((entry) => entry && entry.ownerKey === key)
      .slice(-MAX_STATUS_ERRORS),
    // `null` when a kick is allowed right now (cooldown is advisory, the
    // breaker is the hard stop and is reported separately).
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
