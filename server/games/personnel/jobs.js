'use strict';

const gameCache = require('../game-cache');
const { createJobs } = require('../../core/jobs');
const enrichJobs = require('../enrich');
const personnel = require('./personnel');
const wikidataProvider = require('./wikidata');
const mobyProvider = require('./moby');
const lock = require('./lock');

const MAX_JOBS = 20;
const DEFAULT_LIMIT = 500;
const DEFAULT_LOCK_WAIT_MS = 5000;
const DEFAULT_WAIT_FOR_ENRICH_MS = 20 * 60 * 1000;
const DEFAULT_KICK_COOLDOWN_MS = 10 * 60 * 1000;

const jobs = createJobs({
  name: 'games-personnel',
  idPrefix: 'games-personnel',
  maxJobs: MAX_JOBS,
  cooldownMs: DEFAULT_KICK_COOLDOWN_MS,
  keyOf: (job) => job.profile,
  maskError: (err) => String((err && err.message) || 'personnel pass failed').slice(0, 300),
  errorCode: 'games_personnel_failed',
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
    secondaryGames: job.secondaryGames == null ? null : job.secondaryGames,
    secondaryUpdated: job.secondaryUpdated || 0,
    secondarySkippedFresh: job.secondarySkippedFresh || 0,
    secondaryDeferred: job.secondaryDeferred || 0,
    secondaryQueries: job.secondaryQueries || 0,
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
  if (
    options.forceKick !== true &&
    jobs.cooldownRemaining(parsed.key, { windowMs: cooldownMs }) > 0
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
    job.setProgress(report.updated, report.games);
    job.skippedFresh = report.skippedFresh;
    job.pendingDetails = report.pendingDetails;
    job.wdQueries = report.wdQueries;
    job.wdSkipped = report.wdSkipped || null;
    job.wdDisabledUntil = report.wdDisabledUntil || null;
    job.wdAnswered = report.wdAnswered || 0;
    job.wdDeferred = report.wdDeferred || 0;
    job.secondaryGames = report.secondaryGames || 0;
    job.secondaryUpdated = report.secondaryUpdated || 0;
    job.secondarySkippedFresh = report.secondarySkippedFresh || 0;
    job.secondaryDeferred = report.secondaryDeferred || 0;
    job.secondaryQueries = report.secondaryQueries || 0;
    job.mobyRequests = report.mobyRequests;
    job.errors = [...report.errors, ...report.mobyErrors];
    if (report.wdSkipped) job.skipped = report.wdSkipped;
    job.status = 'done';
    job.stage = 'done';
  } catch (err) {
    job.status = 'failed';
    job.stage = 'failed';
    job.code = (err && err.code) || 'games_personnel_failed';
    job.error = String((err && err.message) || 'personnel pass failed').slice(0, 300);
    console.error(`[games-personnel ${job.id}] ${job.code}: ${job.error}`);
  } finally {
    lock.releaseLock(held.token);
  }
}

function enqueue(job, task) {
  return jobs.run(job, task, {
    onError: (self, err) => {
      jobs.fail(self, err);
      console.error(`[games-personnel ${self.id}] ${self.code}: ${self.error}`);
    },
    onFinish: (self) => {
      console.log(
        `[games-personnel ${self.id}] ${self.status} after ${self.finishedAt - self.startedAt}ms ` +
          `(games=${self.games == null ? '—' : self.games}, updated=${self.updated}, ` +
          `fresh=${self.skippedFresh == null ? '—' : self.skippedFresh}, ` +
          `wdQueries=${self.wdQueries}${self.skipped ? `, skipped=${self.skipped}` : ''}` +
          `${self.code ? `, code=${self.code}` : ''})`
      );
    },
  });
}

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
    secondaryGames: 0,
    secondaryUpdated: 0,
    secondarySkippedFresh: 0,
    secondaryDeferred: 0,
    secondaryQueries: 0,
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
  startPersonnel,
  kickQuietly,
  kickGate,
  getStatus,
  isRunning,
  publicStatus,
  whenIdle,
  resetCooldown,
};
