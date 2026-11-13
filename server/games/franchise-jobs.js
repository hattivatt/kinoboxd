'use strict';

const gameCache = require('./game-cache');
const { createJobs } = require('../core/jobs');
const enrichJobs = require('./enrich');
const franchise = require('./franchise');
const lock = require('./personnel/lock');
const wd = require('./personnel/wikidata');

const MAX_JOBS = 20;
const DEFAULT_LIMIT = franchise.DEFAULT_BUDGET;
const DEFAULT_LOCK_WAIT_MS = 30 * 1000;
const DEFAULT_WAIT_FOR_ENRICH_MS = 20 * 60 * 1000;
const DEFAULT_KICK_COOLDOWN_MS = 10 * 60 * 1000;

const jobs = createJobs({
  name: 'games-franchise',
  idPrefix: 'games-franchise',
  maxJobs: MAX_JOBS,
  cooldownMs: DEFAULT_KICK_COOLDOWN_MS,
  keyOf: (job) => job.profile,
  maskError: (err) => String((err && err.message) || 'franchise pass failed').slice(0, 300),
  errorCode: 'games_franchise_failed',
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

function codedError(message, code, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function publicStatus(job) {
  if (!job) return null;
  return {
    ...jobs.snapshot(job),
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
    bridgeCandidates: job.bridgeCandidates == null ? null : job.bridgeCandidates,
    bridgeQueries: job.bridgeQueries || 0,
    bridged: job.bridged || 0,
    bridgeMisses: job.bridgeMisses || 0,
    secondaryTargets: job.secondaryTargets || 0,
    secondaryCandidates: job.secondaryCandidates || 0,
    secondaryUpdated: job.secondaryUpdated || 0,
    secondarySkippedFresh: job.secondarySkippedFresh || 0,
    secondaryQueries: job.secondaryQueries || 0,
    secondarySkipped: job.secondarySkipped || null,
    baseDetails: job.baseDetails || null,
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
  if (
    options.forceKick !== true &&
    jobs.cooldownRemaining(parsed.key, {
      windowMs: cooldownMs,
      ignore: (record) => record.status === 'failed' || record.skipped === 'lock_busy',
    }) > 0
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
  let ran = false;
  try {
    job.stage = 'fetching';
    const report = await franchise.enrichFranchises({
      profileKey: parsed.key,
      limit: job.limit,
      force: job.force,
      bridge: options.bridge,
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
    job.setProgress(report.updated, report.games);
    job.skippedFresh = report.skippedFresh;
    job.remaining = report.remaining;
    job.unavailableDetails = report.unavailableDetails;
    job.releaseYearsFilled = report.releaseYearsFilled;
    job.wdQueries = report.wdQueries;
    job.wdAnswered = report.wdAnswered;
    job.wdSkipped = report.wdSkipped || null;
    job.wdDisabledUntil = report.wdDisabledUntil || null;
    job.bridgeCandidates = report.bridgeCandidates == null ? null : report.bridgeCandidates;
    job.bridgeQueries = report.bridgeQueries || 0;
    job.bridged = report.bridged || 0;
    job.bridgeMisses = report.bridgeMisses || 0;
    job.secondaryTargets = report.secondaryTargets || 0;
    job.secondaryCandidates = report.secondaryCandidates || 0;
    job.secondaryUpdated = report.secondaryUpdated || 0;
    job.secondarySkippedFresh = report.secondarySkippedFresh || 0;
    job.secondaryQueries = report.secondaryQueries || 0;
    job.secondarySkipped = report.secondarySkipped || null;
    job.errors = [...(report.errors || [])];
    if (report.skipped) job.skipped = report.skipped;
    job.status = 'done';
    job.stage = 'done';
    ran = true;
  } catch (err) {
    job.status = 'failed';
    job.stage = 'failed';
    job.code = (err && err.code) || 'games_franchise_failed';
    job.error = String((err && err.message) || 'franchise pass failed').slice(0, 300);
    console.error(`[games-franchise ${job.id}] ${job.code}: ${job.error}`);
  } finally {
    lock.releaseLock(held.token);
  }

  if (ran && options.baseDetails !== false) {
    job.stage = 'base_details';
    try {
      const baseReport = await franchise.enrichBaseDetails({
        profileKey: parsed.key,
        limit: options.baseDetailsLimit,
        storeClient: options.storeClient,
        now: options.now,
      });
      job.baseDetails = baseReport;
      if (baseReport.errors && baseReport.errors.length) {
        job.errors = [...job.errors, ...baseReport.errors];
      }
    } catch (err) {
      job.baseDetails = { skipped: 'base_details_failed', error: String((err && err.message) || '').slice(0, 200) };
      console.warn(`[games-franchise ${job.id}] base details failed: ${job.baseDetails.error}`);
    }
    job.stage = job.status === 'failed' ? 'failed' : 'done';
  }
}

function enqueue(job, task) {
  return jobs.run(job, task, {
    onError: (self, err) => {
      jobs.fail(self, err);
      console.error(`[games-franchise ${self.id}] ${self.code}: ${self.error}`);
    },
    onFinish: (self) => {
      console.log(
        `[games-franchise ${self.id}] ${self.status} after ${self.finishedAt - self.startedAt}ms ` +
          `(games=${self.games == null ? '—' : self.games}, updated=${self.updated}, ` +
          `fresh=${self.skippedFresh == null ? '—' : self.skippedFresh}, ` +
          `wdQueries=${self.wdQueries}${self.skipped ? `, skipped=${self.skipped}` : ''}` +
          `${self.code ? `, code=${self.code}` : ''})`
      );
    },
  });
}

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
    bridgeCandidates: null,
    bridgeQueries: 0,
    bridged: 0,
    bridgeMisses: 0,
    baseDetails: null,
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

function whenIdle() {
  return jobs.whenIdle();
}

function resetCooldown() {
  jobs.resetCooldown();
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
