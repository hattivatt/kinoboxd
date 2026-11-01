'use strict';

/**
 * On-demand Wikidata/Moby personnel pass (ИГРЫ §2.4, §9 M3, fix 01.11.2026).
 *
 * Why this module exists — the production bug it fixes:
 * `enrichPersonnel()` used to be reachable only through the manual CLI
 * (`backfill.js`) / a hypothetical monthly unit. `GET /api/games/personnel`
 * reads the cache and never fetches, so on a cache where the CLI had not been
 * run the route could only return Steam studios: composer/designer/writer were
 * empty forever («данных по композиторам так и не приехало»). The 87%
 * studios / 35% people coverage measured by the integration snapshot never
 * reached production because nothing in the request path started the pass.
 *
 * The job below is that trigger:
 *
 *   - `kickQuietly(profile)` — fire-and-forget start, used by
 *     import/refresh (`import.js`), `POST /api/games/enrich` and the lazy
 *     `GET /api/games/personnel` path. It never throws into the caller and
 *     coalesces into an already running job for the same profile;
 *   - one pass at a time per process (`chain`) and across processes
 *     (`personnel.lock`, `lock.js`) — two passes would double the WDQS debt
 *     and race `personnel/<appid>.json`;
 *   - it waits for a running store enrich (`enrichJobs.whenIdle()`) before
 *     asking Wikidata, otherwise `details/<appid>.json` is still missing and
 *     the pass has nothing to enrich (that is also why the import kick is
 *     useful at all: import → enrich → personnel, in that order);
 *   - `getStatus`/`isRunning` feed `pending.running` and the «WD: …» badge, so
 *     the widget can say «композиторы появятся после первого прогона» instead
 *     of pretending the answer is final.
 *
 * The pass never blocks an HTTP response: the route starts it and answers from
 * the cache it already has.
 */

const crypto = require('crypto');

const gameCache = require('../game-cache');
const enrichJobs = require('../enrich');
const personnel = require('./personnel');
const wikidataProvider = require('./wikidata');
const mobyProvider = require('./moby');
const lock = require('./lock');

const MAX_JOBS = 20;
/** One pass may cover the whole library; WDQS still batches by ≤450. */
const DEFAULT_LIMIT = 500;
const DEFAULT_LOCK_WAIT_MS = 5000;
const DEFAULT_WAIT_FOR_ENRICH_MS = 20 * 60 * 1000;
/** Lazy route kicks must not rescan the same cache on every page view. */
const DEFAULT_KICK_COOLDOWN_MS = 10 * 60 * 1000;

const jobs = new Map();
const jobOrder = [];
/** profile → { at, status, skipped }: cheap re-kick guard for the route. */
const lastFinished = new Map();
let chain = Promise.resolve();

function newJobId(seed) {
  return `games-personnel-${gameCache.safeKey(seed)}-${Date.now().toString(36)}-${crypto
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

function codedError(message, code, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

/** Public job view: no secret ever passes through this module (WD has none). */
function publicStatus(job) {
  if (!job) return null;
  return {
    jobId: job.id,
    id: job.id,
    job: 'games-personnel',
    source: 'wikidata',
    profile: job.profile,
    status: job.status,
    stage: job.stage,
    done: job.done,
    reused: job.reused,
    force: job.force,
    limit: job.limit,
    games: job.games,
    updated: job.updated,
    skippedFresh: job.skippedFresh,
    pendingDetails: job.pendingDetails,
    wdQueries: job.wdQueries,
    wdSkipped: job.wdSkipped,
    wdDisabledUntil: job.wdDisabledUntil,
    wdAnswered: job.wdAnswered == null ? null : job.wdAnswered,
    wdDeferred: job.wdDeferred == null ? null : job.wdDeferred,
    mobyRequests: job.mobyRequests,
    enrichWait: job.enrichWait || null,
    errors: job.errors ? [...job.errors] : [],
    skipped: job.skipped || null,
    code: job.code || null,
    error: job.error || null,
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

function enabledOf(provider) {
  if (provider && typeof provider.wikidataEnabled === 'function') return provider.wikidataEnabled();
  if (provider && typeof provider.isEnabled === 'function') return provider.isEnabled();
  return wikidataProvider.wikidataEnabled();
}

function mobyEnabledOf(provider) {
  if (provider && typeof provider.isEnabled === 'function') return provider.isEnabled();
  if (provider && typeof provider.mobyEnabled === 'function') return provider.mobyEnabled();
  return mobyProvider.mobyEnabled();
}

function wikidataStatusFor(options = {}) {
  const provider = options.wikidata || wikidataProvider;
  const store =
    options.stateStore ||
    (provider && typeof provider.defaultStateStore === 'function'
      ? provider.defaultStateStore()
      : wikidataProvider.defaultStateStore());
  const state = store && typeof store.read === 'function' ? store.read() : {};
  return personnel.wikidataStatus(state, Date.now(), enabledOf(provider));
}

/**
 * Why a lazy kick would be pointless right now (`null` = go ahead).
 *
 * @returns {string|null} `library_partial` | `sources_disabled` |
 *          `wikidata_cooldown` | `recent_cooldown` | `profile_not_imported`
 */
function kickGate(profileKey, options = {}) {
  const parsed = gameCache.parseProfileToken(profileKey);
  if (!parsed) return 'invalid_profile';
  const library = gameCache.getLibrary(parsed.userKey);
  if (!library) return 'profile_not_imported';
  if (library.partial) return 'library_partial';
  const wdEnabled = enabledOf(options.wikidata);
  const mobyEnabled = mobyEnabledOf(options.moby);
  if (!wdEnabled && !mobyEnabled) return 'sources_disabled';
  if (!mobyEnabled) {
    const status = wikidataStatusFor(options);
    if (status.state === 'cooldown') return 'wikidata_cooldown';
    if (status.state === 'disabled') return 'sources_disabled';
  }
  const cooldownMs = Number.isFinite(Number(options.kickCooldownMs))
    ? Math.max(0, Number(options.kickCooldownMs))
    : DEFAULT_KICK_COOLDOWN_MS;
  const last = lastFinished.get(parsed.key);
  // A failed pass is not throttled: the WD breaker already protects WDQS.
  // An explicit user action (import/refresh/enrich) sets `forceKick` and skips
  // this guard — coalescing still prevents a second concurrent pass.
  if (
    options.forceKick !== true &&
    last &&
    last.status !== 'failed' &&
    Date.now() - last.at < cooldownMs
  ) {
    return 'recent_cooldown';
  }
  return null;
}

function waitForEnrichChain(ms) {
  const timeoutMs = Number.isFinite(Number(ms)) ? Number(ms) : DEFAULT_WAIT_FOR_ENRICH_MS;
  const idle = Promise.resolve(enrichJobs.whenIdle()).then(() => 'idle');
  if (!(timeoutMs > 0)) return idle;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    // A pending timer must not keep the process alive (tests / shutdown).
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([idle, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function runPass(job, parsed, options) {
  const lockWaitMs = Number.isFinite(Number(options.lockWaitMs))
    ? Math.max(0, Number(options.lockWaitMs))
    : DEFAULT_LOCK_WAIT_MS;
  const held = await lock.acquireLock({
    owner: 'games-personnel',
    waitMs: lockWaitMs,
    pollMs: options.lockPollMs,
  });
  if (!held.ok) {
    job.status = 'skipped';
    job.stage = 'skipped';
    job.skipped = 'lock_busy';
    job.code = 'personnel_lock_busy';
    return;
  }
  try {
    if (options.waitForEnrich !== false && enrichJobs.isRunning(job.profile)) {
      job.stage = 'waiting_details';
      const waited = await waitForEnrichChain(options.waitForEnrichMs);
      job.enrichWait = waited;
    }
    job.stage = 'fetching';
    const report = await personnel.enrichPersonnel({
      profileKey: parsed.key,
      limit: job.limit,
      force: job.force,
      wikidata: options.wikidata,
      moby: options.moby,
    });
    job.games = report.games;
    job.updated = report.updated;
    job.skippedFresh = report.skippedFresh;
    job.pendingDetails = report.pendingDetails;
    job.wdQueries = report.wdQueries;
    job.wdSkipped = report.wdSkipped || null;
    job.wdDisabledUntil = report.wdDisabledUntil || null;
    job.wdAnswered = report.wdAnswered || 0;
    job.wdDeferred = report.wdDeferred || 0;
    job.mobyRequests = report.mobyRequests;
    job.errors = [...report.errors, ...report.mobyErrors];
    if (report.wdSkipped) job.skipped = report.wdSkipped;
    job.status = 'done';
    job.stage = 'done';
  } catch (err) {
    job.status = 'failed';
    job.stage = 'failed';
    job.code = (err && err.code) || 'games_personnel_failed';
    // Messages of these providers never contain a token; keep the code only.
    job.error = String((err && err.message) || 'personnel pass failed').slice(0, 300);
    console.error(`[games-personnel ${job.id}] ${job.code}: ${job.error}`);
  } finally {
    lock.releaseLock(held.token);
  }
}

function enqueue(job, task) {
  chain = chain
    .then(task)
    .catch((err) => {
      job.status = 'failed';
      job.stage = 'failed';
      job.code = (err && err.code) || 'games_personnel_failed';
      job.error = String((err && err.message) || 'personnel pass failed').slice(0, 300);
      console.error(`[games-personnel ${job.id}] ${job.code}: ${job.error}`);
    })
    .then(() => {
      job.done = job.status !== 'running';
      job.finishedAt = Date.now();
      if (job.status === 'running') {
        job.status = 'done';
        job.stage = 'done';
        job.done = true;
      }
      lastFinished.set(job.profile, {
        at: job.finishedAt,
        status: job.status,
        skipped: job.skipped || null,
      });
      console.log(
        `[games-personnel ${job.id}] ${job.status} after ${job.finishedAt - job.startedAt}ms ` +
          `(games=${job.games == null ? '—' : job.games}, updated=${job.updated}, ` +
          `fresh=${job.skippedFresh == null ? '—' : job.skippedFresh}, ` +
          `wdQueries=${job.wdQueries}${job.skipped ? `, skipped=${job.skipped}` : ''}` +
          `${job.code ? `, code=${job.code}` : ''})`
      );
    });
}

/**
 * Start (or coalesce into) one personnel pass for a cached profile.
 *
 * @param {string} profileToken `steam-<steamid64>`
 * @param {{force?:boolean, limit?:number, wikidata?:object, moby?:object,
 *          waitForEnrich?:boolean, waitForEnrichMs?:number,
 *          lockWaitMs?:number, lockPollMs?:number}} [options]
 */
function startPersonnel(profileToken, options = {}) {
  const parsed = gameCache.parseProfileToken(profileToken);
  if (!parsed) {
    throw codedError(
      `"profile": expected "steam-<steamid64>", got: ${profileToken}.`,
      'invalid_profile'
    );
  }
  const profile = gameCache.getProfile(parsed.userKey);
  const library = gameCache.getLibrary(parsed.userKey);
  if (!profile || !library) {
    throw codedError(
      `"profile": not a cached games profile: ${parsed.key}. Run the import first.`,
      'unknown_profile'
    );
  }
  const running = findRunningJob(parsed.key);
  if (running) return publicStatus(running);

  const limit = Math.max(1, Number(options.limit) || DEFAULT_LIMIT);
  const job = {
    id: newJobId(parsed.userKey),
    profile: parsed.key,
    status: 'running',
    stage: 'queued',
    done: false,
    reused: false,
    force: Boolean(options.force),
    limit,
    games: null,
    updated: 0,
    skippedFresh: null,
    pendingDetails: null,
    wdQueries: 0,
    wdSkipped: null,
    wdDisabledUntil: null,
    wdAnswered: 0,
    wdDeferred: 0,
    mobyRequests: 0,
    errors: [],
    skipped: null,
    code: null,
    error: null,
    enrichWait: null,
    startedAt: Date.now(),
  };
  rememberJob(job);
  enqueue(job, () => runPass(job, parsed, options));
  return publicStatus(job);
}

/**
 * Fire-and-forget start used by import/refresh/enrich and the lazy route.
 * Never throws; returns a status-shaped object with `skipped` set when the
 * gate refused (so the caller can put the reason into its own payload).
 */
function kickQuietly(profileToken, options = {}) {
  try {
    const parsed = gameCache.parseProfileToken(profileToken);
    const key = parsed ? parsed.key : String(profileToken || '');
    const gate = kickGate(key, options);
    if (gate) {
      return {
        jobId: null,
        id: null,
        job: 'games-personnel',
        profile: key,
        status: 'skipped',
        stage: 'skipped',
        done: true,
        reused: false,
        skipped: gate,
        code: null,
        error: null,
      };
    }
    const status = startPersonnel(key, options);
    return { ...status, skipped: status.skipped || null };
  } catch (err) {
    const message = String((err && err.message) || 'personnel kick failed').slice(0, 300);
    console.warn(`[games-personnel] kick failed (caller kept): ${message}`);
    return {
      jobId: null,
      id: null,
      job: 'games-personnel',
      profile: String(profileToken || ''),
      status: 'failed',
      stage: 'failed',
      done: true,
      reused: false,
      skipped: 'kick_failed',
      code: (err && err.code) || 'kick_failed',
      error: message,
    };
  }
}

/** Wait for the current personnel chain to settle (tests / shutdown). */
function whenIdle() {
  return chain;
}

/** Test helper: forget the re-kick guard between cases. */
function resetCooldown() {
  lastFinished.clear();
}

module.exports = {
  MAX_JOBS,
  DEFAULT_LIMIT,
  DEFAULT_LOCK_WAIT_MS,
  DEFAULT_WAIT_FOR_ENRICH_MS,
  DEFAULT_KICK_COOLDOWN_MS,
  startPersonnel,
  kickQuietly,
  kickGate,
  getStatus,
  isRunning,
  publicStatus,
  whenIdle,
  resetCooldown,
};
