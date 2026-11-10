'use strict';

const { maskSecrets } = require('./errors');
const { nowMs } = require('./normalize');
const { recordKick, recordSkip } = require('./store');
const { COVERAGE_MEMO_MS, kickCooldownMs } = require('./details-config');
const { jobs, coverageMemo, lastKickAtFor } = require('./details-state');
const { startSecondaryDetails } = require('./details-job');
const { coverageNeedsKick, coverageForOwner } = require('./details-coverage');
const { targetsForOwner } = require('./details-targets');

/** Cheap re-kick guard: `null` = go ahead, otherwise the reason. */
function kickGate(ownerKey, options = {}) {
  const key = String(ownerKey == null ? '' : ownerKey);
  if (!key) return 'no_owner';
  const job = jobs.get(key);
  if (job && job.status === 'running') return 'running';
  if (options.forceKick) return null;
  const last = lastKickAtFor(key);
  const cooldown =
    options.kickCooldownMs != null ? Number(options.kickCooldownMs) : kickCooldownMs();
  if (last && nowMs() - last < cooldown) return 'cooldown';
  return null;
}

/**
 * Fire-and-forget kick after a GOG/Epic import (the `kickFranchiseQuietly`
 * pattern): a failure is a job warning, the import stays `done`. `forceKick`
 * is set for an explicit user import so the cooldown does not swallow it.
 *
 * `trigger` is recorded in the kick ledger (`import`, `refresh`, `stats`) —
 * the status endpoint shows it, so «the fix did nothing on prod» can be told
 * apart from «nobody asked».
 */
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

/**
 * Lazy kick from `GET /api/games/stats` (the missing piece after the 66c3d21
 * deploy: an Epic library imported *before* the deploy never fired a kick, and
 * nothing re-kicked it). Fire-and-forget, coalesced by `kickGate`, disabled
 * with `GAMES_SECONDARY_LAZY_KICK=0`.
 *
 * Kick rule (fix 02.11.2026): `resolved < total || partial > 0 || noSlug > 0`
 * — see `coverageNeedsKick`. The cache refinement then drops works that were
 * already attempted (404/settled negative), while a `partial` whose catalog
 * answer is still due stays kickable. Since 03.11.2026 a partial whose missing
 * fact is already cached in the identity bridge (`healable`) is kickable as
 * well: the job's heal branch writes it with no request, and the counter drops
 * to 0, so the kick cannot repeat for the same document.
 */
function kickFromStats(ownerKey, meta, options = {}) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  if (!key) return { skipped: 'no_owner' };
  if (String(process.env.GAMES_SECONDARY_LAZY_KICK || '').trim() === '0') {
    return { skipped: 'disabled' };
  }
  // An adoptable token (exactly one unbound/old-format token) is not visible to
  // the Epic read layer yet, so `/stats` may report no Epic works at all. The
  // binding must still reach the job that adopts it — otherwise the self-heal
  // would only ever run from an import kick.
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
  // Refine with the cache: a product whose slug 404'd (or whose title probe
  // already failed) is *attempted*, not pending. Without this a no-op job would
  // start every cooldown window for a work that cannot be resolved. A negative
  // verdict is memoized for a minute: `/stats` is polled, and the refinement
  // re-reads the library/catalog.
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
  // A token that names another owner (or several candidates) is never adopted:
  // it is stated in the status ledger and blocks the job instead of silently
  // pretending the owner has no Epic library.
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
  // `partial` is kickable (fix 02.11.2026): the detail exists, but year/genres
  // are incomplete — the catalog is re-asked when no attempt is recorded yet
  // or its 30-day probe window expired. A settled `shape_ok` partial stays
  // settled and must not burn a request on every poll.
  //
  // `healable` is the other way out of `partial` (fix 03.11.2026): the missing
  // fact is already in `links/secondary.json`, so the job heals the document
  // from the cache with **no** request. It must be a kick reason on its own —
  // the AW2 genre line was never a catalog question, so `retryablePartial`
  // stayed 0 and `/stats` answered `attempted` forever. After the heal the
  // document is complete and both counters are 0, so this cannot loop.
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
    // Catalog refetch injection for tests (and for a caller that already owns
    // a client): the lazy kick must use the same token-bound client as an
    // explicit run.
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
