'use strict';

const gameCache = require('./game-cache');
const { createJobs } = require('../core/jobs');
const steam = require('./steam');
const store = require('./store');
const spy = require('./spy');
const steamArt = require('./art');
const { createBudget: createBudgetImpl, budgetLimitFromEnv: budgetLimitFromEnvImpl } = require('../core/budget');
const sources = require('../core/sources');

const PHASES = ['details', 'spy', 'reviews'];
const DEFAULT_BUDGET = 340;
const DEFAULT_RECHECK_DAYS = 180;
const DEFAULT_PHASE_RECHECK_DAYS = 30;
const MAX_JOBS = 20;
const MAX_RUNS = 10;

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

function publicStatus(job) {
  if (!job) return null;
  return {
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

function overallPercent(job) {
  const phases = job.phasesRequested && job.phasesRequested.length ? job.phasesRequested : ['details'];
  let sum = 0;
  for (const name of phases) {
    const phase = job.phases[name];
    sum += phase ? Math.min(100, Number(phase.percent) || 0) : 0;
  }
  return Math.min(99, Math.round(sum / phases.length));
}

function phaseCoverage(spec, appids) {
  const all = spec.list(appids);
  const resolved = appids.filter((appid) => all[String(appid)] && all[String(appid)].success).length;
  return {
    resolved,
    total: appids.length,
    percent: appids.length ? Math.round((resolved / appids.length) * 1000) / 10 : 0,
  };
}

function artBrowseBudgetLimit() {
  const spec = sources.SOURCES.steamBrowse;
  return budgetLimitFromEnvImpl(spec.budgetEnv, spec.budgetDefault);
}

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
  const mainFile = require.main && require.main.filename ? require.main.filename : '';
  if (/\.test\.js$/.test(mainFile)) return null;
  return passThrough;
}

function artSweepKey(row) {
  return {
    minutes2w: Math.max(0, Number(row && row.playtime_2weeks) || 0),
    rtime: Math.max(0, Number(row && row.rtime_last_played) || 0),
    forever: Math.max(0, Number(row && row.playtime_forever) || 0),
  };
}

function artSweepOrder(candidates, library) {
  const rows = new Map();
  for (const game of (library && Array.isArray(library.games) && library.games) || []) {
    const appid = Number(game && game.appid);
    if (Number.isInteger(appid) && appid > 0 && !rows.has(appid)) rows.set(appid, game);
  }
  return candidates
    .map((candidate, index) => ({ candidate, index, key: artSweepKey(rows.get(candidate.appid)) }))
    .sort(
      (a, b) =>
        b.key.minutes2w - a.key.minutes2w ||
        b.key.rtime - a.key.rtime ||
        b.key.forever - a.key.forever ||
        a.index - b.index
    )
    .map((entry) => entry.candidate);
}

async function resolveArtForLibrary(job, phase, appids, options = {}, library = null) {
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

  for (const { appid, doc } of artSweepOrder(candidates, library)) {
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
    if (phaseName === 'details') await resolveArtForLibrary(job, phase, appids, options, library);
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
      if (spec.systemicCodes.includes(code)) {
        phase.stoppedBy = code;
        break;
      }
    }
    phase.processed = attempted.length + phase.deferred;
    phase.percent = selected.length
      ? Math.min(99, Math.round((phase.processed / selected.length) * 100))
      : 0;
    job.percent = overallPercent(job);
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
  if (phaseName === 'details') await resolveArtForLibrary(job, phase, appids, options, library);
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
