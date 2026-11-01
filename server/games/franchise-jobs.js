'use strict';

/**
 * On-demand Wikidata franchise pass (M4-B), modelled on the M3 personnel job
 * (`personnel/jobs.js`) — same health/coalescing contract, different payload.
 *
 *   POST /api/games/franchise-enrich { profile, force? } → job
 *   GET  /api/games/franchise-enrich/status?id=…         → job
 *
 * Why a job and not a route call: one SPARQL query is ~1–5 s (and a cold WDQS
 * can be much slower), the route must answer from the cache immediately, and
 * two page views must not spend the WDQS budget twice. Hence:
 *
 *   - `kickQuietly(profile)` — fire-and-forget, never throws into the caller,
 *     used by import/refresh (`import.js`) and the lazy `GET /franchises`;
 *   - one pass per process (`chain`) and one per host: it takes the **same**
 *     `personnel.lock` file as the M3 credits pass (`personnel/lock.js`,
 *     owner `games-franchise`). Franchise and personnel both walk WDQS; sharing
 *     the lock means the two passes queue instead of hitting query.wikidata.org
 *     at the same time (AGENTS §1 politeness, brief item 4);
 *   - the WD breaker state is shared too (`personnel/wikidata.js`
 *     `defaultStateStore()`), so a 429 in one pass backs off both;
 *   - `franchise-state.json` keeps the last run per profile (resume/force);
 *     `links/<appid>.json` is the real progress;
 *   - the pass waits for a running store enrich (`enrichJobs.whenIdle()`)
 *     before taking the lock: otherwise it would hold the WDQS lock while the
 *     library details are still arriving and starve the personnel pass.
 *
 * Nothing here is owner-agnostic: `links/` is metadata, but the pass is scoped
 * to the library of exactly one cached profile.
 */

const crypto = require('crypto');

const gameCache = require('./game-cache');
const enrichJobs = require('./enrich');
const franchise = require('./franchise');
const lock = require('./personnel/lock');
const wd = require('./personnel/wikidata');

const MAX_JOBS = 20;
const DEFAULT_LIMIT = franchise.DEFAULT_BUDGET;
const DEFAULT_LOCK_WAIT_MS = 30 * 1000;
const DEFAULT_WAIT_FOR_ENRICH_MS = 20 * 60 * 1000;
const DEFAULT_KICK_COOLDOWN_MS = 10 * 60 * 1000;

const jobs = new Map();
const jobOrder = [];
/** profile → { at, status, skipped }: cheap re-kick guard for the lazy route. */
const lastFinished = new Map();
let chain = Promise.resolve();

function newJobId(seed) {
  return `games-franchise-${gameCache.safeKey(seed)}-${Date.now().toString(36)}-${crypto
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

/** Public job view — WD has no secrets, and none are added here. */
function publicStatus(job) {
  if (!job) return null;
  return {
    jobId: job.id,
    id: job.id,
    job: 'games-franchise',
    source: 'wikidata',
    profile: job.profile,
    status: job.status,
    stage: job.stage,
    done: job.done,
    reused: job.reused,
    force: job.force,
    limit: job.limit,
    games: job.games,
    candidates: job.candidates,
    updated: job.updated,
    skippedFresh: job.skippedFresh,
    remaining: job.remaining,
    unavailableDetails: job.unavailableDetails,
    releaseYearsFilled: job.releaseYearsFilled,
    wdQueries: job.wdQueries,
    wdAnswered: job.wdAnswered,
    wdSkipped: job.wdSkipped,
    wdDisabledUntil: job.wdDisabledUntil,
    enrichWait: job.enrichWait || null,
    lockWaitMs: job.lockWaitMs == null ? null : job.lockWaitMs,
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

function wikidataStatus(options = {}) {
  const provider = options.wikidata || wd;
  const store =
    options.stateStore ||
    (typeof provider.defaultStateStore === 'function'
      ? provider.defaultStateStore()
      : wd.defaultStateStore());
  const state = store && typeof store.read === 'function' ? store.read() : {};
  const enabled = typeof provider.wikidataEnabled === 'function'
    ? provider.wikidataEnabled()
    : wd.wikidataEnabled();
  if (!enabled) return { state: 'disabled', enabled: false, disabledUntil: null };
  const until = state && state.disabledUntil ? Date.parse(state.disabledUntil) : NaN;
  if (Number.isFinite(until) && until > Date.now()) {
    return { state: 'cooldown', enabled: true, disabledUntil: state.disabledUntil };
  }
  return { state: 'ready', enabled: true, disabledUntil: null };
}

/**
 * Why a lazy kick would be pointless right now (`null` = go ahead).
 *
 * @returns {string|null} `invalid_profile` | `profile_not_imported` |
 *          `library_partial` | `sources_disabled` | `wikidata_cooldown` |
 *          `recent_cooldown`
 */
function kickGate(profileKey, options = {}) {
  const parsed = gameCache.parseProfileToken(profileKey);
  if (!parsed) return 'invalid_profile';
  const library = gameCache.getLibrary(parsed.userKey);
  if (!library) return 'profile_not_imported';
  if (library.partial) return 'library_partial';
  const status = wikidataStatus(options);
  if (status.state === 'disabled') return 'sources_disabled';
  if (status.state === 'cooldown') return 'wikidata_cooldown';
  const cooldownMs = Number.isFinite(Number(options.kickCooldownMs))
    ? Math.max(0, Number(options.kickCooldownMs))
    : DEFAULT_KICK_COOLDOWN_MS;
  const last = lastFinished.get(parsed.key);
  // A failed pass is not throttled (the WD breaker already protects WDQS); a
  // pass that skipped on a busy lock must also be retryable soon — otherwise a
  // single import race would hide franchises for the whole cooldown.
  if (
    options.forceKick !== true &&
    last &&
    last.status !== 'failed' &&
    last.skipped !== 'lock_busy' &&
    Date.now() - last.at < cooldownMs
  ) {
    return 'recent_cooldown';
  }
  return null;
}

function waitForEnrich(ms) {
  const timeoutMs = Number.isFinite(Number(ms)) ? Number(ms) : DEFAULT_WAIT_FOR_ENRICH_MS;
  const idle = Promise.resolve(enrichJobs.whenIdle()).then(() => 'idle');
  if (!(timeoutMs > 0)) return idle;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([idle, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function runPass(job, parsed, options) {
  if (options.waitForEnrich !== false && enrichJobs.isRunning(job.profile)) {
    job.stage = 'waiting_details';
    job.enrichWait = await waitForEnrich(options.waitForEnrichMs);
  }

  const lockWaitMs = Number.isFinite(Number(options.lockWaitMs))
    ? Math.max(0, Number(options.lockWaitMs))
    : DEFAULT_LOCK_WAIT_MS;
  job.lockWaitMs = lockWaitMs;
  const held = await lock.acquireLock({
    owner: 'games-franchise',
    waitMs: lockWaitMs,
    pollMs: options.lockPollMs,
  });
  if (!held.ok) {
    job.status = 'skipped';
    job.stage = 'skipped';
    job.skipped = 'lock_busy';
    job.code = 'franchise_lock_busy';
    return;
  }
  try {
    job.stage = 'fetching';
    const report = await franchise.enrichFranchises({
      profileKey: parsed.key,
      limit: job.limit,
      force: job.force,
      wikidata: options.wikidata,
      stateStore: options.stateStore,
      fetchImpl: options.fetchImpl,
      pauseMs: options.pauseMs,
      now: options.now,
      sleep: options.sleep,
    });
    job.games = report.games;
    job.candidates = report.candidates;
    job.updated = report.updated;
    job.skippedFresh = report.skippedFresh;
    job.remaining = report.remaining;
    job.unavailableDetails = report.unavailableDetails;
    job.releaseYearsFilled = report.releaseYearsFilled;
    job.wdQueries = report.wdQueries;
    job.wdAnswered = report.wdAnswered;
    job.wdSkipped = report.wdSkipped || null;
    job.wdDisabledUntil = report.wdDisabledUntil || null;
    job.errors = [...(report.errors || [])];
    if (report.skipped) job.skipped = report.skipped;
    job.status = 'done';
    job.stage = 'done';
  } catch (err) {
    job.status = 'failed';
    job.stage = 'failed';
    job.code = (err && err.code) || 'games_franchise_failed';
    job.error = String((err && err.message) || 'franchise pass failed').slice(0, 300);
    console.error(`[games-franchise ${job.id}] ${job.code}: ${job.error}`);
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
      job.code = (err && err.code) || 'games_franchise_failed';
      job.error = String((err && err.message) || 'franchise pass failed').slice(0, 300);
      console.error(`[games-franchise ${job.id}] ${job.code}: ${job.error}`);
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
        `[games-franchise ${job.id}] ${job.status} after ${job.finishedAt - job.startedAt}ms ` +
          `(games=${job.games == null ? '—' : job.games}, updated=${job.updated}, ` +
          `fresh=${job.skippedFresh == null ? '—' : job.skippedFresh}, ` +
          `wdQueries=${job.wdQueries}${job.skipped ? `, skipped=${job.skipped}` : ''}` +
          `${job.code ? `, code=${job.code}` : ''})`
      );
    });
}

/**
 * Start (or coalesce into) one franchise pass for a cached profile.
 *
 * @param {string} profileToken `steam-<steamid64>`
 * @param {{force?:boolean, limit?:number, waitForEnrich?:boolean,
 *          waitForEnrichMs?:number, lockWaitMs?:number, lockPollMs?:number,
 *          fetchImpl?:Function, stateStore?:object}} [options]
 */
function startFranchise(profileToken, options = {}) {
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
    candidates: null,
    updated: 0,
    skippedFresh: null,
    remaining: null,
    unavailableDetails: null,
    releaseYearsFilled: 0,
    wdQueries: 0,
    wdAnswered: 0,
    wdSkipped: null,
    wdDisabledUntil: null,
    enrichWait: null,
    lockWaitMs: null,
    errors: [],
    skipped: null,
    code: null,
    error: null,
    startedAt: Date.now(),
  };
  rememberJob(job);
  enqueue(job, () => runPass(job, parsed, options));
  return publicStatus(job);
}

/**
 * Fire-and-forget start used by import/refresh and the lazy route. Never
 * throws; returns a status-shaped object with `skipped` set when the gate
 * refused (so the caller can put the reason into its own payload).
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
        job: 'games-franchise',
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
    const status = startFranchise(key, options);
    return { ...status, skipped: status.skipped || null };
  } catch (err) {
    const message = String((err && err.message) || 'franchise kick failed').slice(0, 300);
    console.warn(`[games-franchise] kick failed (caller kept): ${message}`);
    return {
      jobId: null,
      id: null,
      job: 'games-franchise',
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

/** Wait for the current franchise chain to settle (tests / shutdown). */
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
  startFranchise,
  kickQuietly,
  kickGate,
  getStatus,
  isRunning,
  publicStatus,
  wikidataStatus,
  whenIdle,
  resetCooldown,
};
