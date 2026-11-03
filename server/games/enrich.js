'use strict';

/**
 * Library metadata enrichment (M2 details + M4 tags/reviews): a resumable,
 * budgeted pass over the appids of one owned library, split into phases.
 *
 *   POST /api/games/enrich { profile, force?, phases?, recheckDays? } -> job
 *   GET  /api/games/enrich/:jobId | /api/games/enrich/status?id=…
 *
 * Phases (`phases`: `details` | `spy` | `reviews` | `all`, comma-separated or
 * an array; the HTTP route defaults to `all`, a programmatic call to
 * `details` so import-time enrichment keeps its M2 footprint):
 *
 *   details — Steam Store `appdetails` (`details/<appid>.json`)
 *   spy     — SteamSpy tags/owners/ccu (`spy/<appid>.json`)
 *   reviews — Steam review summary (`reviews/<appid>.json`)
 *
 * Invariants:
 *   - **one owner.** The run reads the library of exactly one cached
 *     `steam-<steamid64>` profile; metadata is global per appid (tags, review
 *     scores are not owner-scoped), events/hours are (AGENTS.md §6);
 *   - **resumable.** A candidate is an appid whose document for that phase is
 *     missing or older than the phase re-check window (details 180 days,
 *     spy/reviews 30 days). Re-running the job continues where the previous
 *     run stopped (the cache is the progress); `force: true` re-fetches
 *     everything regardless of freshness;
 *   - **one-time heal (details).** A *fresh* document written before the store
 *     parser kept `headerImage` (02.11.2026, e5bc5b9) is a heal candidate even
 *     though its TTL has not expired: «Обновить профиль» must add the missing
 *     artwork instead of inventing a forced full refetch. The heal is recorded
 *     per appid in `state/details-heal-state.json`, so a document is asked
 *     exactly once — whether the answer was `healed`, `no_artwork` or
 *     `unavailable` — and a failed request is retried on the next run. Only
 *     `success:true` documents are candidates: the 21 honest `unavailable`
 *     rows have no artwork because the store has no page for them, not because
 *     the parser lost a field;
 *   - **budgeted per phase.** `GAMES_STORE_BUDGET` / `GAMES_SPY_BUDGET` /
 *     `GAMES_REVIEWS_BUDGET` (default 340 each) appids per run, one unit per
 *     appid; the remaining count is reported and the next run picks it up;
 *   - **deferred, not negative.** A network/5xx/breaker failure is counted as
 *     deferred and NOT written; a real "no data" answer (store `success:false`,
 *     SteamSpy skeleton, review summary without `query_summary`) is written as
 *     an honest `unavailable` document so the next run does not ask again
 *     inside the TTL;
 *   - only library appids are enriched (cache `profiles/` + `library/`), never
 *     the whole Steam catalogue.
 *
 * Journals: one persisted state file per phase (`state/enrich-state.json`,
 * `state/spy-state.json`, `state/reviews-state.json`), each with the last run
 * per profile, attempted/deferred appids and a ring of the last 10 summaries.
 */

const gameCache = require('./game-cache');
const { createJobs } = require('../core/jobs');
const steam = require('./steam');
const store = require('./store');
const spy = require('./spy');
const steamArt = require('./steam-art');
const { createBudget: createBudgetImpl, budgetLimitFromEnv: budgetLimitFromEnvImpl } = require('../core/budget');
const sources = require('../core/sources');

const PHASES = ['details', 'spy', 'reviews'];
const DEFAULT_BUDGET = 340;
const DEFAULT_RECHECK_DAYS = 180;
const DEFAULT_PHASE_RECHECK_DAYS = 30;
const MAX_JOBS = 20;
const MAX_RUNS = 10;

/** Everything that differs between phases, in one place. */
const PHASE_SPECS = {
  details: {
    name: 'details',
    source: 'steam-store',
    clientOption: 'client',
    clientFactory: () => store.createClient(),
    method: 'getAppDetails',
    list: (appids) => gameCache.listDetails(appids),
    fresh: (doc, ttlMs) => store.detailsFresh(doc, ttlMs),
    save: (appid, doc) => gameCache.saveDetails(appid, doc),
    ttlMs: () => gameCache.detailsTtlMs(),
    sourceId: 'steamStore',
    budgetEnv: sources.SOURCES.steamStore.budgetEnv,
    recheckEnv: 'GAMES_STORE_RECHECK_DAYS',
    defaultRecheckDays: DEFAULT_RECHECK_DAYS,
    readState: () => gameCache.readEnrichState(),
    saveState: (state) => gameCache.saveEnrichState(state),
    systemicCodes: ['store_rate_limited', 'store_unreachable'],
    // One-time heal of pre-`headerImage` documents (see the module comment).
    // Only a real store answer without artwork is a candidate; an
    // `unavailable` row (success:false) has no page to fetch.
    heal: {
      missing: (doc) =>
        Boolean(doc && doc.success === true && !doc.headerImage),
      readState: () => gameCache.readDetailsHealState(),
      saveState: (state) => gameCache.saveDetailsHealState(state),
    },
  },
  spy: {
    name: 'spy',
    source: 'steamspy',
    clientOption: 'spyClient',
    clientFactory: () => spy.createClient(),
    method: 'getAppTags',
    list: (appids) => gameCache.listSpy(appids),
    fresh: (doc, ttlMs) => spy.spyFresh(doc, ttlMs),
    save: (appid, doc) => gameCache.saveSpy(appid, doc),
    ttlMs: () => gameCache.spyTtlMs(),
    sourceId: 'steamSpy',
    budgetEnv: sources.SOURCES.steamSpy.budgetEnv,
    recheckEnv: 'GAMES_SPY_RECHECK_DAYS',
    defaultRecheckDays: DEFAULT_PHASE_RECHECK_DAYS,
    readState: () => gameCache.readSpyState(),
    saveState: (state) => gameCache.saveSpyState(state),
    systemicCodes: ['spy_rate_limited', 'spy_unreachable'],
  },
  reviews: {
    name: 'reviews',
    source: 'steam-reviews',
    clientOption: 'reviewsClient',
    clientFactory: () => store.createClient(),
    method: 'getAppReviews',
    list: (appids) => gameCache.listReviews(appids),
    fresh: (doc, ttlMs) => store.reviewsFresh(doc, ttlMs),
    save: (appid, doc) => gameCache.saveReviews(appid, doc),
    ttlMs: () => gameCache.reviewsTtlMs(),
    sourceId: 'steamReviews',
    budgetEnv: sources.SOURCES.steamReviews.budgetEnv,
    recheckEnv: 'GAMES_REVIEWS_RECHECK_DAYS',
    defaultRecheckDays: DEFAULT_PHASE_RECHECK_DAYS,
    readState: () => gameCache.readReviewsState(),
    saveState: (state) => gameCache.saveReviewsState(state),
    systemicCodes: ['reviews_rate_limited', 'reviews_unreachable'],
  },
};

const PHASE_ALIASES = {
  all: PHASES,
  auto: PHASES,
  store: ['details'],
  steamspy: ['spy'],
  tags: ['spy'],
  appreviews: ['reviews'],
};

/**
 * Job registry (core/jobs): single-flight per profile, one enrich chain and a
 * 20-job ring. Phase journals (`state/enrich-state.json` and friends) stay the
 * domain's own persistent state — jobs are in-memory, exactly like the map
 * they replace, and a restart resumes from those files, not from a job.
 */
const jobs = createJobs({
  name: 'games-enrich',
  idPrefix: 'games-enrich',
  maxJobs: MAX_JOBS,
  keyOf: (job) => job.profile,
  maskError: (err) => steam.maskSecrets(err && err.message ? err.message : 'неизвестная ошибка'),
  errorCode: 'games_enrich_failed',
});

function newJobId(seed) {
  return jobs.newId(seed);
}

function rememberJob(job) {
  return jobs.remember(job);
}

function findRunningJob(profileKey) {
  return jobs.findRunning(profileKey);
}

function budgetLimitFromEnv(phaseName) {
  const spec = PHASE_SPECS[phaseName] || PHASE_SPECS.details;
  const fallback = sources.SOURCES[spec.sourceId].budgetDefault;
  return budgetLimitFromEnvImpl(spec.budgetEnv, fallback);
}

function recheckDaysFromEnv(phaseName) {
  const spec = PHASE_SPECS[phaseName] || PHASE_SPECS.details;
  const raw = Number(process.env[spec.recheckEnv]);
  return Number.isFinite(raw) && raw >= 0 ? raw : spec.defaultRecheckDays;
}

function createBudget(limit) {
  return createBudgetImpl(limit, DEFAULT_BUDGET);
}

/* ------------------------------------------------------------------ */
/* Phase selection                                                     */
/* ------------------------------------------------------------------ */

/**
 * Normalise `phases` (`"all"`, `"spy"`, `"details,reviews"` or an array) into
 * an ordered, de-duplicated list. Unknown names are a 400, never a silent
 * no-op — the same rule the query contract follows everywhere else.
 */
function parsePhases(raw, fallback) {
  const fallbackList = Array.isArray(fallback)
    ? fallback
    : typeof fallback === 'string' && fallback.trim()
      ? fallback.split(',')
      : ['details'];
  let list;
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
    list = fallbackList;
  } else if (Array.isArray(raw)) {
    list = raw;
  } else {
    list = String(raw).split(',');
  }
  const out = [];
  const unknown = [];
  for (const entry of list) {
    const key = String(entry == null ? '' : entry).trim().toLowerCase();
    if (!key) continue;
    const expanded = PHASE_ALIASES[key] || (PHASE_SPECS[key] ? [key] : null);
    if (!expanded) {
      unknown.push(key);
      continue;
    }
    for (const name of expanded) {
      if (!out.includes(name)) out.push(name);
    }
  }
  if (unknown.length) {
    const err = new Error(
      `Unknown enrich phase(s): ${unknown.map((name) => `"${name}"`).join(', ')}. ` +
        `Accepted: ${[...PHASES, 'all'].map((name) => `"${name}"`).join(', ')}.`
    );
    err.code = 'invalid_phases';
    err.status = 400;
    throw err;
  }
  if (!out.length) {
    const err = new Error(`"phases" must name at least one of: ${[...PHASES, 'all'].join(', ')}.`);
    err.code = 'invalid_phases';
    err.status = 400;
    throw err;
  }
  // Keep the canonical order (details → spy → reviews) regardless of input
  // order: details first means the personnel pass sees the finished library.
  return PHASES.filter((name) => out.includes(name));
}

function emptyPhase(name) {
  return {
    phase: name,
    source: PHASE_SPECS[name] ? PHASE_SPECS[name].source : null,
    status: 'pending',
    stage: 'queued',
    total: null,
    selected: null,
    skippedFresh: null,
    healCandidates: null,
    healed: 0,
    artCandidates: null,
    artResolved: 0,
    artNone: 0,
    artDeferred: 0,
    ok: 0,
    unavailable: 0,
    deferred: 0,
    requests: 0,
    processed: 0,
    remaining: null,
    budgetLimit: null,
    budgetRemaining: null,
    recheckDays: null,
    resolved: null,
    percent: null,
    lastAppid: null,
    stoppedBy: null,
    errors: [],
    elapsedMs: null,
  };
}

/** Public phase view: no key/secret ever passes through this module. */
function publicPhase(phase) {
  if (!phase) return null;
  return {
    phase: phase.phase,
    source: phase.source,
    status: phase.status,
    stage: phase.stage,
    total: phase.total,
    selected: phase.selected,
    skippedFresh: phase.skippedFresh,
    healCandidates: phase.healCandidates,
    healed: phase.healed,
    artCandidates: phase.artCandidates,
    artResolved: phase.artResolved,
    artNone: phase.artNone,
    artDeferred: phase.artDeferred,
    artCandidates: phase.artCandidates,
    artResolved: phase.artResolved,
    artNone: phase.artNone,
    artDeferred: phase.artDeferred,
    ok: phase.ok,
    unavailable: phase.unavailable,
    deferred: phase.deferred,
    requests: phase.requests,
    processed: phase.processed,
    remaining: phase.remaining,
    budgetLimit: phase.budgetLimit,
    budgetRemaining: phase.budgetRemaining,
    recheckDays: phase.recheckDays,
    resolved: phase.resolved,
    percent: phase.percent,
    lastAppid: phase.lastAppid,
    stoppedBy: phase.stoppedBy,
    errors: phase.errors ? [...phase.errors] : [],
    elapsedMs: phase.elapsedMs,
  };
}

/** Public job view: no key/secret ever passes through this module. */
function publicStatus(job) {
  if (!job) return null;
  return {
    // Unified job view (id/status/stage/progress/startedAt/finishedAt/error/
    // partial); the legacy fields below keep their exact value.
    ...jobs.snapshot(job),
    jobId: job.id,
    id: job.id,
    job: 'games-enrich',
    source: 'steam-store',
    profile: job.profile,
    status: job.status,
    stage: job.stage,
    done: job.done,
    percent: job.percent,
    reused: job.reused,
    force: job.force,
    phasesRequested: job.phasesRequested ? [...job.phasesRequested] : [],
    phase: job.phase,
    phases: job.phases
      ? Object.fromEntries(Object.entries(job.phases).map(([name, phase]) => [name, publicPhase(phase)]))
      : {},
    recheckDays: job.recheckDays,
    // Legacy (M2) top-level fields mirror the details phase so the existing UI
    // and the M2 tests keep reading one stable shape.
    total: job.total,
    selected: job.selected,
    skippedFresh: job.skippedFresh,
    ok: job.ok,
    unavailable: job.unavailable,
    deferred: job.deferred,
    requests: job.requests,
    remaining: job.remaining,
    budgetLimit: job.budgetLimit,
    budgetRemaining: job.budgetRemaining,
    detailsResolved: job.detailsResolved,
    detailsTotal: job.detailsTotal,
    detailsPercent: job.detailsPercent,
    lastAppid: job.lastAppid,
    stoppedBy: job.stoppedBy,
    errors: job.errors ? [...job.errors] : [],
    code: job.code,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    elapsedMs: job.finishedAt ? job.finishedAt - job.startedAt : null,
  };
}

function getStatus(id) {
  return publicStatus(jobs.get(String(id || '')));
}

function isRunning(profileKey) {
  return Boolean(findRunningJob(profileKey));
}

function enqueue(job, task) {
  return jobs.run(job, task, {
    onError: (self, err) => {
      jobs.fail(self, err);
      console.error(`[games-enrich ${self.id}] ${self.code}: ${self.error}`);
    },
    onFinish: (self) => {
      const phaseText = Object.values(self.phases || {})
        .map(
          (phase) =>
            `${phase.phase}={selected:${phase.selected},ok:${phase.ok},` +
            `unavailable:${phase.unavailable},deferred:${phase.deferred},` +
            `requests:${phase.requests},resolved:${phase.resolved}}`
        )
        .join(' ');
      console.log(
        `[games-enrich ${self.id}] ${self.status} after ${self.finishedAt - self.startedAt}ms ` +
          `(phases=${(self.phasesRequested || []).join('+')}, total=${self.total}, ` +
          `${phaseText}${self.code ? `, code=${self.code}` : ''})`
      );
    },
  });
}

function uniqueAppids(library) {
  const out = [];
  const seen = new Set();
  for (const game of (library && Array.isArray(library.games) && library.games) || []) {
    const appid = Number(game && game.appid);
    if (!Number.isInteger(appid) || appid <= 0 || seen.has(appid)) continue;
    seen.add(appid);
    out.push(appid);
  }
  return out;
}

function progressSnapshot(state, profileKey) {
  const entry = state.profiles[profileKey];
  return entry && typeof entry === 'object' ? entry : {};
}

/**
 * Mean of the requested phases' progress (0..99). A phase that has not started
 * contributes 0; a finished one 100. The enqueue wrapper sets the final 100.
 */
function overallPercent(job) {
  const phases = job.phasesRequested && job.phasesRequested.length ? job.phasesRequested : ['details'];
  let sum = 0;
  for (const name of phases) {
    const phase = job.phases[name];
    sum += phase ? Math.min(100, Number(phase.percent) || 0) : 0;
  }
  return Math.min(99, Math.round(sum / phases.length));
}

/** Coverage of one phase over the whole library (successful documents only). */
function phaseCoverage(spec, appids) {
  const all = spec.list(appids);
  const resolved = appids.filter((appid) => all[String(appid)] && all[String(appid)].success).length;
  return {
    resolved,
    total: appids.length,
    percent: appids.length ? Math.round((resolved / appids.length) * 1000) / 10 : 0,
  };
}

/* ------------------------------------------------------------------ */
/* One phase                                                           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Vertical-art resolve (details phase, one pass per appid)            */
/* ------------------------------------------------------------------ */

function artBrowseBudgetLimit() {
  const spec = sources.SOURCES.steamBrowse;
  return budgetLimitFromEnvImpl(spec.budgetEnv, spec.budgetDefault);
}

/**
 * The resolver the details phase uses. Production talks to the public Steam
 * CDN/store-frontend API; a test must opt in explicitly (`artResolver` or a
 * `fetch`), so the suite never opens a socket. `artResolve: false` disables the
 * sweep entirely.
 */
function artResolverFor(options) {
  if (options.artResolve === false) return null;
  if (typeof options.artResolver === 'function') return options.artResolver;
  if (options.artResolver && typeof options.artResolver.resolve === 'function') {
    return options.artResolver.resolve.bind(options.artResolver);
  }
  const passThrough = (appid, info) =>
    steamArt.resolveVerticalArt(appid, {
      ...info,
      fetch: options.fetch,
      sleep: options.sleep,
      now: options.now,
      sgdbKey: options.sgdbKey,
    });
  if (typeof options.fetch === 'function') return passThrough;
  // A unit test that does not inject a resolver must not accidentally hit the
  // live Steam CDN: under `node --test` the test file itself is `require.main`.
  const mainFile = require.main && require.main.filename ? require.main.filename : '';
  if (/\.test\.js$/.test(mainFile)) return null;
  return passThrough;
}

/**
 * Resolve the vertical capsule for every library appid whose `details`
 * document carries `header_image` and whose resolve document is missing or
 * older than its TTL (180 days positive / 30 days `none`). One pass per
 * appid; the result lives in `cache-games/art/resolved/<appid>.json`.
 *
 * Counters are additive on the phase: `artCandidates`, `artResolved`,
 * `artNone`, `artDeferred`. A deferred lookup is not a verdict and is retried
 * on the next run.
 */
async function resolveArtForLibrary(job, phase, appids, options = {}) {
  const resolver = artResolverFor(options);
  if (!resolver) return;
  const now = Date.now();
  const candidates = [];
  for (const appid of appids) {
    const doc = gameCache.getDetails(appid);
    if (!doc || !doc.headerImage) continue;
    const resolved = steamArt.readResolvedArt(appid);
    if (resolved && !options.forceArt && steamArt.resolvedFresh(resolved, now)) continue;
    candidates.push({ appid, doc });
  }
  phase.artCandidates = candidates.length;
  if (!candidates.length) return;

  const browseBudget = createBudgetImpl(
    artBrowseBudgetLimit(),
    sources.SOURCES.steamBrowse.budgetDefault
  );
  const sgdbSpec = sources.SOURCES.steamGridDb;
  const sgdbBudget = createBudgetImpl(
    budgetLimitFromEnvImpl(sgdbSpec.budgetEnv, sgdbSpec.budgetDefault),
    sgdbSpec.budgetDefault
  );

  for (const { appid, doc } of candidates) {
    try {
      const resolved = await resolver(appid, {
        headerImage: doc.headerImage,
        capsuleImage: doc.capsuleImage || null,
        budget: browseBudget,
        sgdbBudget,
      });
      if (!resolved || resolved.deferred) {
        phase.artDeferred++;
      } else if (resolved.kind === 'none') {
        phase.artNone++;
      } else {
        phase.artResolved++;
      }
    } catch (err) {
      phase.artDeferred++;
      if (!job.errors.includes('art_resolve_error')) job.errors.push('art_resolve_error');
    }
  }
}

/**
 * Run one phase. Pure-ish: all I/O goes through gameCache / the injected
 * client, so tests never touch the network.
 */
async function runPhase(job, phaseName, scope, options) {
  const spec = PHASE_SPECS[phaseName];
  const phase = job.phases[phaseName];
  const { userKey, library } = scope;
  const profileKey = gameCache.profileKeyOf(userKey);
  const nowIso = () => new Date().toISOString();
  const startedAt = Date.now();
  const client = options[spec.clientOption] || spec.clientFactory();
  const recheckOverride =
    phaseName === 'details'
      ? options.recheckDays
      : options[`${phaseName}RecheckDays`];
  const recheckDays =
    Number.isFinite(Number(recheckOverride)) && Number(recheckOverride) >= 0
      ? Number(recheckOverride)
      : recheckDaysFromEnv(phaseName);
  const ttlMs = recheckDays * 24 * 60 * 60 * 1000;
  const budgetOverride =
    phaseName === 'details' ? options.budget : options[`${phaseName}Budget`];
  const budget = createBudget(
    budgetOverride != null ? budgetOverride : budgetLimitFromEnv(phaseName)
  );

  phase.status = 'running';
  phase.stage = 'selecting';
  phase.recheckDays = recheckDays;
  job.stage = 'selecting';
  job.phase = phaseName;

  const appids = uniqueAppids(library);
  const cached = spec.list(appids);

  // One-time heal (details): a TTL-fresh document that predates `headerImage`
  // is still a candidate. The ledger makes it exactly once per appid; a failed
  // request is not recorded, so the next run retries it.
  let healState = null;
  const healRecorded = new Set();
  const healTargets = new Set();
  const healList = [];
  if (spec.heal) {
    try {
      healState = spec.heal.readState();
    } catch (err) {
      healState = { appids: {} };
    }
    for (const appid of Object.keys((healState && healState.appids) || {})) {
      healRecorded.add(String(appid));
    }
  }

  const ttlStale = [];
  for (const appid of appids) {
    const doc = cached[String(appid)];
    const key = String(appid);
    if (
      spec.heal &&
      doc &&
      spec.heal.missing(doc) &&
      !healRecorded.has(key)
    ) {
      healTargets.add(appid);
      healList.push(appid);
    }
    if (job.force || !doc || !spec.fresh(doc, ttlMs)) ttlStale.push(appid);
  }
  const healSet = new Set(healList);
  const stale = [...healList, ...ttlStale.filter((appid) => !healSet.has(appid))];
  phase.total = appids.length;
  phase.budgetLimit = budget.limit;
  phase.skippedFresh = appids.length - stale.length;
  phase.healCandidates = healList.length;

  // Select at most one budget window, but spend a unit per *attempt* below:
  // an interrupted run must report the budget it did not use.
  const selected = budget.limit > 0 ? stale.slice(0, budget.limit) : [];
  phase.selected = selected.length;
  phase.remaining = stale.length - selected.length;
  phase.budgetRemaining = budget.remaining;
  phase.percent = selected.length ? 0 : 100;

  if (!selected.length) {
    phase.stage = 'done';
    phase.status = 'done';
    phase.remaining = stale.length;
    phase.budgetRemaining = budget.remaining;
    const coverage = phaseCoverage(spec, appids);
    phase.resolved = coverage.resolved;
    phase.percent = coverage.percent;
    if (phaseName === 'details') await resolveArtForLibrary(job, phase, appids, options);
    phase.elapsedMs = Date.now() - startedAt;
    return phase;
  }

  phase.stage = 'fetching';
  job.stage = 'fetching';
  const state = spec.readState();
  const previous = progressSnapshot(state, profileKey);
  const attempted = [];
  const deferredAppids = [];
  const unavailableAppids = [];

  for (const appid of selected) {
    if (!budget.take()) break;
    phase.requests++;
    try {
      const doc = await client[spec.method](appid);
      doc.fetchedAt = nowIso();
      await spec.save(appid, doc);
      attempted.push(appid);
      phase.lastAppid = appid;
      job.lastAppid = appid;
      if (doc.success) {
        phase.ok++;
      } else {
        phase.unavailable++;
        unavailableAppids.push(appid);
      }
      // Record the one-time heal outcome. `no_artwork` means the store itself
      // answered without a header image: asking again would not help, the
      // ledger keeps the document out of every future heal pass (normal TTL
      // re-checks still happen every 180 days). The marker is also written for
      // a first-time fetch without artwork, so the deploy that introduced the
      // heal does not re-ask documents the same run just wrote.
      if (
        spec.heal &&
        (healTargets.has(appid) || (doc.success && !doc.headerImage))
      ) {
        const wasHeal = healTargets.has(appid);
        healTargets.delete(appid);
        const result = doc.success
          ? doc.headerImage
            ? 'healed'
            : 'no_artwork'
          : 'unavailable';
        healState.appids[String(appid)] = { at: nowIso(), appid, result };
        healRecorded.add(String(appid));
        if (wasHeal) phase.healed++;
        try {
          await spec.heal.saveState(healState);
        } catch (err) {
          console.warn(
            `[games-enrich ${job.id}/${phaseName}] heal state save failed: ${err.message}`
          );
        }
      }
    } catch (err) {
      const code = (err && err.code) || `${phaseName}_error`;
      phase.deferred++;
      deferredAppids.push(appid);
      if (!phase.errors.includes(code)) phase.errors.push(code);
      if (!job.errors.includes(code)) job.errors.push(code);
      // Breaker/unreachable is systemic: stop instead of hammering the host.
      if (spec.systemicCodes.includes(code)) {
        phase.stoppedBy = code;
        break;
      }
    }
    phase.processed = attempted.length + phase.deferred;
    phase.percent = selected.length
      ? Math.min(99, Math.round((phase.processed / selected.length) * 100))
      : 0;
    // Overall progress = the mean of the requested phases' progress, so a long
    // spy pass does not sit at 0% while the details phase is already done.
    job.percent = overallPercent(job);
    // Persist progress after every appid: a crash mid-run resumes from the
    // cache, but the journal still shows where the pass stopped.
    job.setProgress(phase.processed, phase.selected == null ? phase.total : phase.selected);
    state.profiles[profileKey] = {
      ...previous,
      phase: phaseName,
      lastRunAt: nowIso(),
      lastAppid: phase.lastAppid,
      total: phase.total,
      selected: phase.selected,
      ok: phase.ok,
      unavailable: phase.unavailable,
      deferred: phase.deferred,
      skippedFresh: phase.skippedFresh,
      healCandidates: phase.healCandidates,
      healed: phase.healed,
    artCandidates: phase.artCandidates,
    artResolved: phase.artResolved,
    artNone: phase.artNone,
    artDeferred: phase.artDeferred,
      budgetRemaining: budget.remaining,
      attempted: [...attempted],
      deferredAppids: [...deferredAppids],
      unavailableAppids: [...unavailableAppids],
    };
    try {
      await spec.saveState(state);
    } catch (err) {
      console.warn(`[games-enrich ${job.id}/${phaseName}] state save failed: ${err.message}`);
    }
  }

  phase.remaining = stale.length - selected.length + phase.deferred;
  phase.budgetRemaining = budget.remaining;
  if (phaseName === 'details') await resolveArtForLibrary(job, phase, appids, options);
  phase.stage = 'done';
  phase.status = 'done';
  phase.percent = 100;

  const coverage = phaseCoverage(spec, appids);
  phase.resolved = coverage.resolved;
  phase.elapsedMs = Date.now() - startedAt;

  const run = {
    id: job.id,
    phase: phaseName,
    source: spec.source,
    profile: profileKey,
    startedAt: new Date(job.startedAt).toISOString(),
    finishedAt: nowIso(),
    force: job.force,
    recheckDays,
    budgetLimit: budget.limit,
    total: phase.total,
    selected: phase.selected,
    skippedFresh: phase.skippedFresh,
    healCandidates: phase.healCandidates,
    healed: phase.healed,
    artCandidates: phase.artCandidates,
    artResolved: phase.artResolved,
    artNone: phase.artNone,
    artDeferred: phase.artDeferred,
    artCandidates: phase.artCandidates,
    artResolved: phase.artResolved,
    artNone: phase.artNone,
    artDeferred: phase.artDeferred,
    ok: phase.ok,
    unavailable: phase.unavailable,
    deferred: phase.deferred,
    requests: phase.requests,
    remaining: phase.remaining,
    stoppedBy: phase.stoppedBy,
    errors: [...phase.errors],
    resolved: coverage.resolved,
    resolvedTotal: coverage.total,
    resolvedPercent: coverage.percent,
    // Legacy details keys (M2 tests read the run ring).
    ...(phaseName === 'details'
      ? { detailsResolved: coverage.resolved, detailsTotal: coverage.total }
      : {}),
  };
  state.profiles[profileKey] = {
    ...(state.profiles[profileKey] || {}),
    phase: phaseName,
    lastRunAt: nowIso(),
    lastRunId: job.id,
    lastAppid: phase.lastAppid,
    total: phase.total,
    selected: phase.selected,
    ok: phase.ok,
    unavailable: phase.unavailable,
    deferred: phase.deferred,
    skippedFresh: phase.skippedFresh,
    healCandidates: phase.healCandidates,
    healed: phase.healed,
    artCandidates: phase.artCandidates,
    artResolved: phase.artResolved,
    artNone: phase.artNone,
    artDeferred: phase.artDeferred,
    budgetRemaining: budget.remaining,
    attempted: [...attempted],
    deferredAppids: [...deferredAppids],
    unavailableAppids: [...unavailableAppids],
    resolved: coverage.resolved,
    resolvedTotal: coverage.total,
    // Legacy details key names (M2 tests and the state reader rely on them).
    ...(phaseName === 'details'
      ? { detailsResolved: coverage.resolved, detailsTotal: coverage.total }
      : {}),
  };
  state.runs = [...state.runs, run].slice(-MAX_RUNS);
  try {
    await spec.saveState(state);
  } catch (err) {
    console.warn(`[games-enrich ${job.id}/${phaseName}] state save failed: ${err.message}`);
  }
  return phase;
}

/**
 * Run the requested phases sequentially and keep the legacy top-level fields
 * (M2 details) in sync.
 */
async function runEnrich(job, scope, options) {
  const phases = options.phases && options.phases.length ? options.phases : ['details'];
  const appids = uniqueAppids(scope.library);
  job.total = appids.length;

  for (const phaseName of phases) {
    job.phase = phaseName;
    await runPhase(job, phaseName, scope, options);
    job.percent = overallPercent(job);
  }

  const details = job.phases.details;
  if (details) {
    job.recheckDays = details.recheckDays;
    job.selected = details.selected;
    job.skippedFresh = details.skippedFresh;
    job.ok = details.ok;
    job.unavailable = details.unavailable;
    job.deferred = details.deferred;
    job.requests = details.requests;
    job.remaining = details.remaining;
    job.budgetLimit = details.budgetLimit;
    job.budgetRemaining = details.budgetRemaining;
    job.detailsResolved = details.resolved;
    job.detailsTotal = details.total;
    job.detailsPercent = details.percent;
    job.setProgress(details.resolved, details.total);
    job.lastAppid = details.lastAppid;
    job.stoppedBy = details.stoppedBy;
  }
  job.stage = 'done';
  job.percent = 100;
}

/**
 * Start (or coalesce into) an enrich job for one cached profile.
 *
 * `profileToken` — `steam-<steamid64>`.
 * `options.force` — re-fetch every appid, ignore the TTLs.
 * `options.phases` — `details`/`spy`/`reviews`/`all` (default `details` here;
 *   the HTTP route passes `all`).
 * `options.recheckDays` — override the details re-check window.
 * `options.spyRecheckDays` / `reviewsRecheckDays` — per-phase overrides.
 * `options.budget` / `spyBudget` / `reviewsBudget` — per-phase budget (tests).
 * `options.client` / `spyClient` / `reviewsClient` — injected clients (tests).
 */
function startEnrich(profileToken, options = {}) {
  const parsed = gameCache.parseProfileToken(profileToken);
  if (!parsed) {
    const err = new Error(
      `"profile": expected "steam-<steamid64>", got: ${profileToken}.`
    );
    err.code = 'invalid_profile';
    err.status = 400;
    throw err;
  }
  const profile = gameCache.getProfile(parsed.userKey);
  const library = gameCache.getLibrary(parsed.userKey);
  if (!profile || !library) {
    const err = new Error(
      `"profile": not a cached games profile: ${parsed.key}. Run the import first.`
    );
    err.code = 'unknown_profile';
    err.status = 400;
    throw err;
  }

  const phases = parsePhases(options.phases, options.defaultPhases || 'details');
  const profileKey = parsed.key;
  const running = findRunningJob(profileKey);
  if (running) {
    return { ...publicStatus(running), reused: true };
  }

  const job = {
    id: newJobId(parsed.userKey),
    profile: profileKey,
    status: 'running',
    stage: 'queued',
    done: false,
    percent: 0,
    reused: false,
    force: Boolean(options.force),
    phasesRequested: phases,
    phases: Object.fromEntries(phases.map((name) => [name, emptyPhase(name)])),
    phase: null,
    recheckDays: null,
    total: null,
    selected: null,
    skippedFresh: null,
    ok: 0,
    unavailable: 0,
    deferred: 0,
    requests: 0,
    remaining: null,
    budgetLimit: null,
    budgetRemaining: null,
    detailsResolved: null,
    detailsTotal: null,
    detailsPercent: null,
    lastAppid: null,
    stoppedBy: null,
    errors: [],
    code: null,
    error: null,
    startedAt: Date.now(),
  };
  rememberJob(job);
  enqueue(job, () => runEnrich(job, { userKey: parsed.userKey, library }, { ...options, phases }));
  return publicStatus(job);
}

/** Wait for the current enrich chain to settle (tests / shutdown). */
function whenIdle() {
  return jobs.whenIdle();
}

module.exports = {
  PHASES,
  DEFAULT_BUDGET,
  DEFAULT_RECHECK_DAYS,
  DEFAULT_PHASE_RECHECK_DAYS,
  MAX_RUNS,
  createBudget,
  parsePhases,
  startEnrich,
  getStatus,
  isRunning,
  publicStatus,
  publicPhase,
  whenIdle,
  uniqueAppids,
};
