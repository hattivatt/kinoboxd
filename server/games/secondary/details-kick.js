'use strict';

const { maskSecrets } = require('./errors');
const { nowMs } = require('./normalize');
const { recordKick, recordSkip } = require('./store');
const { COVERAGE_MEMO_MS, kickCooldownMs } = require('./details-config');
const { jobs, coverageMemo, lastKickAtFor } = require('./details-state');
const { startSecondaryDetails } = require('./details-job');
const { coverageNeedsKick, coverageForOwner } = require('./details-coverage');
const { targetsForOwner } = require('./details-targets');

function kickGate(ownerKey, options = {}) {
  const key = String(ownerKey == null ? '' : ownerKey);
  if (!key) return 'no_owner';
  const job = jobs.isRunning(key);
  if (job) return 'running';
  if (options.forceKick) return null;
  const last = lastKickAtFor(key);
  const cooldown =
    options.kickCooldownMs != null ? Number(options.kickCooldownMs) : kickCooldownMs();
  if (last && nowMs() - last < cooldown) return 'cooldown';
  return null;
}

function kickSecondaryDetailsQuietly(ownerKey, options = {}) {
  const key = String(ownerKey == null ? '' : ownerKey);
  const trigger = options.trigger || 'import';
  const gate = kickGate(key, options);
  if (gate) {
    if (trigger !== 'stats') {
      recordKick({ ownerKey: key, result: 'skipped', skipped: gate, trigger });
    }
    return { skipped: gate, ownerKey: ownerKey || null };
  }
  try {
    const job = startSecondaryDetails({ ...options, ownerKey });
    recordKick({
      ownerKey: key,
      result: job.reused ? 'reused' : 'started',
      jobId: job.id || null,
      trigger,
      budget: job.budget == null ? null : job.budget,
    });
    console.log(
      `[games-secondary-details] kicked ${job.id} ` +
        `(gog=${job.gog.total}, epic=${job.epic.total}, budget=${job.budget}, trigger=${trigger})`
    );
    return job;
  } catch (err) {
    const message = maskSecrets((err && err.message) || 'secondary details failed');
    console.warn(`[games-secondary-details] kick failed (caller kept): ${message}`);
    recordKick({ ownerKey: key, result: 'failed', trigger, code: (err && err.code) || 'kick_failed' });
    return { skipped: 'kick_failed', code: (err && err.code) || 'kick_failed' };
  }
}

function kickFromStats(ownerKey, meta, options = {}) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  if (!key) return { skipped: 'no_owner' };
  if (String(process.env.GAMES_SECONDARY_LAZY_KICK || '').trim() === '0') {
    return { skipped: 'disabled' };
  }
  const bindingForKick = (() => {
    try {
      const epicCache = require('../epic-cache');
      return typeof epicCache.epicBindingForOwnerSync === 'function'
        ? epicCache.epicBindingForOwnerSync(key)
        : null;
    } catch (err) {
      return null;
    }
  })();
  const adoptableBinding =
    bindingForKick &&
    (bindingForKick.state === 'unbound' || bindingForKick.state === 'profile_missing');
  if (!coverageNeedsKick(meta) && !adoptableBinding) return { skipped: 'covered' };
  const memo = coverageMemo.get(key);
  if (
    memo &&
    memo.pending <= 0 &&
    memo.retryablePartial <= 0 &&
    !(Number(memo.healable) > 0) &&
    nowMs() - memo.at < COVERAGE_MEMO_MS
  ) {
    return { skipped: 'attempted' };
  }
  const coverage = coverageForOwner(key);
  const binding = coverage.epicBinding || null;
  if (binding && (binding.state === 'owner_mismatch' || binding.state === 'ambiguous')) {
    recordSkip(key, {
      source: 'epic',
      reason: binding.state,
      detail: 'binding',
      otherOwner: binding.otherOwner || null,
      trigger: 'stats',
    });
  }
  const retryablePartial = coverage.retryablePartial;
  const healable = Number(coverage.healable) || 0;
  if (coverage.pending <= 0 && retryablePartial <= 0 && healable <= 0) {
    coverageMemo.set(key, { at: nowMs(), pending: 0, retryablePartial: 0, healable: 0 });
    return { skipped: 'attempted' };
  }
  coverageMemo.delete(key);
  const gate = kickGate(key, options);
  if (gate) return { skipped: gate };
  return kickSecondaryDetailsQuietly(key, {
    trigger: 'stats',
    client: options.client,
    epicClient: options.epicClient,
    catalogClient: options.catalogClient,
    tokenStore: options.tokenStore,
    epicAccountId: options.epicAccountId,
    pauseMs: options.pauseMs,
    ...targetsForOwner(key),
  });
}

module.exports = {
  kickGate,
  kickSecondaryDetailsQuietly,
  kickFromStats,
};
