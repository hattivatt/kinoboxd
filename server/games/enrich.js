'use strict';

/**
 * Library metadata enrichment (M2): Steam Store `appdetails` for every appid
 * of one owned library.
 *
 *   POST /api/games/enrich { profile, force?, recheckDays? } -> job
 *   GET  /api/games/enrich/:jobId | /api/games/enrich/status?id=…
 *
 * Invariants:
 *   - **one owner.** The run reads the library of exactly one cached
 *     `steam-<steamid64>` profile; details are global per appid (metadata is
 *     not owner-scoped, events/hours are — AGENTS.md §6);
 *   - **resumable.** A candidate is an appid whose `details/<appid>.json` is
 *     missing or older than the re-check window (`GAMES_STORE_RECHECK_DAYS`,
 *     default 180). Re-running the job therefore continues where the previous
 *     run stopped (the cache is the progress), and `force: true` re-fetches
 *     everything regardless of freshness;
 *   - **budgeted.** `GAMES_STORE_BUDGET` (default 340) appids per run, one unit
 *     per appid; the remaining count is reported and the next run picks it up;
 *   - **deferred, not negative.** A network/5xx/breaker failure is counted as
 *     deferred and NOT written; a `success:false` store answer (region-locked
 *     / delisted) is written as an honest `unavailable` document so the next
 *     run does not ask again inside the TTL;
 *   - only library appids are enriched (cache `profiles/` + `library/`), never
 *     the whole Steam catalogue.
 *
 * The run journal is one line per job plus the persisted `enrich-state.json`
 * (`state/enrich-state.json`): last run per profile, attempted/deferred appids
 * and a ring of the last 10 run summaries.
 */

const crypto = require('crypto');

const gameCache = require('./game-cache');
const steam = require('./steam');
const store = require('./store');

const DEFAULT_BUDGET = 340;
const DEFAULT_RECHECK_DAYS = 180;
const MAX_JOBS = 20;
const MAX_RUNS = 10;

const jobs = new Map();
const jobOrder = [];
let enrichChain = Promise.resolve();

function newJobId(seed) {
  return `games-enrich-${gameCache.safeKey(seed)}-${Date.now().toString(36)}-${crypto
    .randomBytes(3)
    .toString('hex')}`;
}

function rememberJob(job) {
  jobs.set(job.id, job);
  jobOrder.push(job.id);
  while (jobOrder.length > MAX_JOBS) {
    const stale = jobOrder.shift();
    if (stale !== job.id) jobs.delete(stale);
  }
}

function findRunningJob(profileKey) {
  for (const job of jobs.values()) {
    if (job.profile === profileKey && !job.done && job.status === 'running') return job;
  }
  return null;
}

function budgetLimitFromEnv() {
  const raw = Number(process.env.GAMES_STORE_BUDGET);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_BUDGET;
}

function recheckDaysFromEnv() {
  const raw = Number(process.env.GAMES_STORE_RECHECK_DAYS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RECHECK_DAYS;
}

function createBudget(limit) {
  const parsed = Number(limit);
  const max = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_BUDGET;
  return {
    limit: max,
    used: 0,
    get remaining() {
      return Math.max(max - this.used, 0);
    },
    take() {
      if (this.used >= max) return false;
      this.used++;
      return true;
    },
  };
}

/** Public job view: no key/secret ever passes through this module. */
function publicStatus(job) {
  if (!job) return null;
  return {
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
    recheckDays: job.recheckDays,
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
  enrichChain = enrichChain
    .then(task)
    .catch((err) => {
      job.status = 'failed';
      job.stage = 'failed';
      job.code = (err && err.code) || 'games_enrich_failed';
      job.error = steam.maskSecrets(err && err.message ? err.message : 'неизвестная ошибка');
      if (err && err.retryAt) job.retryAt = err.retryAt;
      console.error(`[games-enrich ${job.id}] ${job.code}: ${job.error}`);
    })
    .then(() => {
      job.done = job.status !== 'running';
      job.finishedAt = Date.now();
      if (job.status === 'running') {
        job.status = 'done';
        job.stage = 'done';
        job.percent = 100;
        job.done = true;
      }
      console.log(
        `[games-enrich ${job.id}] ${job.status} after ${job.finishedAt - job.startedAt}ms ` +
          `(total=${job.total}, selected=${job.selected}, ok=${job.ok}, ` +
          `unavailable=${job.unavailable}, deferred=${job.deferred}, ` +
          `requests=${job.requests}, budget=${job.budgetLimit}/${job.budgetLimit}, ` +
          `remaining=${job.remaining}${job.code ? `, code=${job.code}` : ''})`
      );
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
 * Run one enrich pass. Pure-ish: all I/O goes through gameCache / the injected
 * store client, so tests never touch the network.
 */
async function runEnrich(job, scope, options) {
  const { userKey, library } = scope;
  const profileKey = gameCache.profileKeyOf(userKey);
  const nowIso = () => new Date().toISOString();
  const client = options.client || store.createClient();
  const recheckDays =
    Number.isFinite(Number(options.recheckDays)) && Number(options.recheckDays) >= 0
      ? Number(options.recheckDays)
      : recheckDaysFromEnv();
  const ttlMs = recheckDays * 24 * 60 * 60 * 1000;
  const budget = createBudget(
    options.budget != null ? options.budget : budgetLimitFromEnv()
  );

  job.stage = 'selecting';
  const appids = uniqueAppids(library);
  const cached = gameCache.listDetails(appids);
  const stale = [];
  for (const appid of appids) {
    const doc = cached[String(appid)];
    if (job.force || !doc || !store.detailsFresh(doc, ttlMs)) stale.push(appid);
  }
  job.total = appids.length;
  job.recheckDays = recheckDays;
  job.budgetLimit = budget.limit;
  job.skippedFresh = appids.length - stale.length;

  // Select at most one budget window, but spend a unit per *attempt* below:
  // an interrupted run must report the budget it did not use.
  const selected = budget.limit > 0 ? stale.slice(0, budget.limit) : [];
  job.selected = selected.length;
  job.remaining = stale.length - selected.length;
  job.budgetRemaining = budget.remaining;
  job.percent = selected.length ? 0 : 100;

  if (!selected.length) {
    job.stage = 'done';
    job.remaining = stale.length;
    job.budgetRemaining = budget.remaining;
    job.detailsTotal = appids.length;
    const all = gameCache.listDetails(appids);
    job.detailsResolved = appids.filter((appid) => all[String(appid)] && all[String(appid)].success).length;
    job.detailsPercent = appids.length
      ? Math.round((job.detailsResolved / appids.length) * 1000) / 10
      : 0;
    return;
  }

  job.stage = 'fetching';
  const state = gameCache.readEnrichState();
  const previous = progressSnapshot(state, profileKey);
  const attempted = [];
  const deferredAppids = [];
  const unavailableAppids = [];

  for (const appid of selected) {
    if (!budget.take()) break;
    job.requests++;
    try {
      const doc = await client.getAppDetails(appid);
      doc.fetchedAt = nowIso();
      await gameCache.saveDetails(appid, doc);
      attempted.push(appid);
      job.lastAppid = appid;
      if (doc.success) {
        job.ok++;
      } else {
        job.unavailable++;
        unavailableAppids.push(appid);
      }
    } catch (err) {
      const code = (err && err.code) || 'store_error';
      job.deferred++;
      deferredAppids.push(appid);
      if (!job.errors.includes(code)) job.errors.push(code);
      // Breaker/unreachable is systemic: stop instead of hammering the host.
      if (code === 'store_rate_limited' || code === 'store_unreachable') {
        job.stoppedBy = code;
        break;
      }
    }
    job.percent = selected.length
      ? Math.min(99, Math.round((attempted.length + job.deferred) / selected.length * 100))
      : 0;
    // Persist progress after every appid: a crash mid-run resumes from the
    // cache, but the journal still shows where the pass stopped.
    state.profiles[profileKey] = {
      ...previous,
      lastRunAt: nowIso(),
      lastAppid: job.lastAppid,
      total: job.total,
      selected: job.selected,
      ok: job.ok,
      unavailable: job.unavailable,
      deferred: job.deferred,
      skippedFresh: job.skippedFresh,
      budgetRemaining: budget.remaining,
      attempted: [...attempted],
      deferredAppids: [...deferredAppids],
      unavailableAppids: [...unavailableAppids],
    };
    try {
      await gameCache.saveEnrichState(state);
    } catch (err) {
      console.warn(`[games-enrich ${job.id}] state save failed: ${err.message}`);
    }
  }

  job.remaining = stale.length - selected.length + job.deferred;
  job.budgetRemaining = budget.remaining;
  job.stage = 'done';
  job.percent = 100;

  const all = gameCache.listDetails(appids);
  job.detailsTotal = appids.length;
  job.detailsResolved = appids.filter((appid) => all[String(appid)] && all[String(appid)].success).length;
  job.detailsPercent = appids.length
    ? Math.round((job.detailsResolved / appids.length) * 1000) / 10
    : 0;

  const run = {
    id: job.id,
    profile: profileKey,
    startedAt: new Date(job.startedAt).toISOString(),
    finishedAt: nowIso(),
    force: job.force,
    recheckDays,
    budgetLimit: budget.limit,
    total: job.total,
    selected: job.selected,
    skippedFresh: job.skippedFresh,
    ok: job.ok,
    unavailable: job.unavailable,
    deferred: job.deferred,
    requests: job.requests,
    remaining: job.remaining,
    stoppedBy: job.stoppedBy,
    errors: [...job.errors],
    detailsResolved: job.detailsResolved,
    detailsTotal: job.detailsTotal,
  };
  state.profiles[profileKey] = {
    ...(state.profiles[profileKey] || {}),
    lastRunAt: nowIso(),
    lastRunId: job.id,
    lastAppid: job.lastAppid,
    total: job.total,
    selected: job.selected,
    ok: job.ok,
    unavailable: job.unavailable,
    deferred: job.deferred,
    skippedFresh: job.skippedFresh,
    budgetRemaining: budget.remaining,
    attempted: [...attempted],
    deferredAppids: [...deferredAppids],
    unavailableAppids: [...unavailableAppids],
    detailsResolved: job.detailsResolved,
    detailsTotal: job.detailsTotal,
  };
  state.runs = [...state.runs, run].slice(-MAX_RUNS);
  try {
    await gameCache.saveEnrichState(state);
  } catch (err) {
    console.warn(`[games-enrich ${job.id}] state save failed: ${err.message}`);
  }
}

/**
 * Start (or coalesce into) an enrich job for one cached profile.
 *
 * `profileToken` — `steam-<steamid64>`.
 * `options.force` — re-fetch every appid, ignore the TTL.
 * `options.recheckDays` — override the re-check window.
 * `options.budget` — override `GAMES_STORE_BUDGET` (tests).
 * `options.client` — injected store client (tests: fixtures, no network).
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

  const profileKey = parsed.key;
  const running = findRunningJob(profileKey);
  if (running) return publicStatus(running);

  const job = {
    id: newJobId(parsed.userKey),
    profile: profileKey,
    status: 'running',
    stage: 'queued',
    done: false,
    percent: 0,
    reused: false,
    force: Boolean(options.force),
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
  enqueue(job, () => runEnrich(job, { userKey: parsed.userKey, library }, options));
  return publicStatus(job);
}

/** Wait for the current enrich chain to settle (tests / shutdown). */
function whenIdle() {
  return enrichChain;
}

module.exports = {
  DEFAULT_BUDGET,
  DEFAULT_RECHECK_DAYS,
  MAX_RUNS,
  createBudget,
  startEnrich,
  getStatus,
  isRunning,
  publicStatus,
  whenIdle,
  uniqueAppids,
};
