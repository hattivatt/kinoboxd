'use strict';

const path = require('path');

const bookCache = require('./book-cache');
const resolve = require('./resolve');
const segments = require('./segments');
const litres = require('./providers/litres');
const googlebooks = require('./providers/googlebooks');
const resolveLock = require('./resolve-lock');
const fsStore = require('../core/fs-store');
const sources = require('../core/sources');

const DEFAULT_LIMIT = 200;
const DEFAULT_RECHECK_DAYS = 90;
const DEFAULT_PAUSE_MS = sources.pauseMs('litres');
const CANDIDATES_DIR_NAME = 'resolve-candidates';

const PLAN_SHELVES = new Set(['reading', 'wish']);
const CYRILLIC_TITLE = /[а-яё]/i;

function candidateStatePath(source, userKey) {
  return path.join(
    bookCache.BOOK_CACHE_DIR,
    CANDIDATES_DIR_NAME,
    `${String(source).replace(/[^\w.-]+/g, '_')}-${String(userKey).replace(/[^\w.-]+/g, '_')}.json`
  );
}

function emptyCandidateState() {
  return { schemaVersion: 1, updatedAt: null, recheckDays: DEFAULT_RECHECK_DAYS, candidates: {} };
}

function loadCandidateState(source, userKey) {
  const data = fsStore.readJson(candidateStatePath(source, userKey), {
    label: 'scheduled-resolve',
  });
  if (!data || typeof data !== 'object') return emptyCandidateState();
  return {
    schemaVersion: Number(data.schemaVersion) || 1,
    updatedAt: data.updatedAt || null,
    recheckDays: Number.isFinite(Number(data.recheckDays))
      ? Number(data.recheckDays)
      : DEFAULT_RECHECK_DAYS,
    candidates: data.candidates && typeof data.candidates === 'object' ? data.candidates : {},
  };
}

function saveCandidateState(source, userKey, state) {
  const filePath = candidateStatePath(source, userKey);
  fsStore.writeJsonAtomicSync(filePath, state, { space: 2 });
  return filePath;
}

function missedAtOf(state, resolveState, key) {
  const entry = state && state.candidates ? state.candidates[String(key)] : null;
  const direct = entry && Date.parse(String(entry.askedAt || ''));
  if (Number.isFinite(direct)) return direct;
  const keys = Array.isArray(resolveState && resolveState.unmatchedKeys)
    ? resolveState.unmatchedKeys.map(String)
    : [];
  if (keys.includes(String(key))) {
    const ranAt = Date.parse(String((resolveState && resolveState.ranAt) || ''));
    if (Number.isFinite(ranAt)) return ranAt;
  }
  return null;
}

function recentlyMissed(state, resolveState, key, nowMs, recheckDays) {
  const at = missedAtOf(state, resolveState, key);
  if (at == null) return false;
  const days = Number(recheckDays);
  const window = Number.isFinite(days) && days >= 0 ? days : DEFAULT_RECHECK_DAYS;
  return nowMs - at < window * 24 * 60 * 60 * 1000;
}

function eventKeyOf(event) {
  return resolve.eventKeyOf(event);
}

function isUnlinked(event) {
  const key = eventKeyOf(event);
  if (!key) return false;
  const link = bookCache.getLink(key);
  if (link && link.workId) return false;
  if (bookCache.getWorkDetails(`ll:${key}`)) return false;
  return true;
}

function expandedProfileEvents(profile) {
  const events = Array.isArray(profile && profile.events) ? profile.events : [];
  const source = (profile && profile.source) || 'livelib';
  const userKey = profile && profile.userKey;
  const yearOverrides = source === 'livelib' && userKey
    ? bookCache.getYearOverrides(source, userKey)
    : null;
  return segments.expandProfileEvents(events, {
    canExpand(event) {
      const key = eventKeyOf(event);
      if (!key) return true;
      return !segments.expansionBlocked(event, {
        link: bookCache.getLink(key),
        details: bookCache.getWorkDetails(`ll:${key}`),
        yearOverrides,
      });
    },
  });
}

function candidatePool(profile, options = {}) {
  const allowedWorkIds = options.allowedWorkIds || null;
  const expanded = expandedProfileEvents(profile);
  const pool = [];
  for (const event of expanded) {
    if (!event || PLAN_SHELVES.has(event.shelf)) continue;
    const key = eventKeyOf(event);
    if (!key) continue;
    if (!isUnlinked(event)) continue;
    if (allowedWorkIds) {
      const workId = `ll:${key}`;
      const hostVisible = Boolean(
        event.collectionParentKey && allowedWorkIds.has(`ll:${event.collectionParentKey}`)
      );
      if (!allowedWorkIds.has(workId) && !hostVisible) continue;
    }
    pool.push({ event, key });
  }
  return pool;
}

function allowedWorkIdsOf(stats) {
  const index = stats && stats.booksIndex && typeof stats.booksIndex === 'object'
    ? stats.booksIndex
    : {};
  return new Set(Object.keys(index));
}

async function mergeResolveState(profile, report, options = {}) {
  const source = profile.source || 'livelib';
  const userKey = profile.userKey;
  const previous = bookCache.getResolveState(source, userKey) || {};
  const askedKeys = new Set(
    Array.isArray(previous.askedKeys) ? previous.askedKeys.map(String) : []
  );
  for (const key of report.askedKeys || []) askedKeys.add(String(key));

  const unmatched = new Set(
    Array.isArray(previous.unmatchedKeys) ? previous.unmatchedKeys.map(String) : []
  );
  for (const key of report.unmatchedKeys || []) unmatched.add(String(key));
  for (const key of options.extraUnmatchedKeys || []) unmatched.add(String(key));

  const events = expandedProfileEvents(profile);
  let resolved = 0;
  for (const event of events) {
    if (!event || PLAN_SHELVES.has(event.shelf)) continue;
    const key = eventKeyOf(event);
    if (!key) continue;
    const linked = !isUnlinked(event);
    if (linked) {
      resolved++;
      unmatched.delete(String(key));
    }
  }
  for (const key of [...unmatched]) {
    if (!events.some((event) => event && eventKeyOf(event) === key)) unmatched.delete(key);
  }

  const data = {
    schemaVersion: 2,
    ranAt: new Date().toISOString(),
    total: events.length,
    attempted: askedKeys.size,
    matched: resolved,
    skippedPlanShelf: report.skippedPlanShelf || 0,
    lookupErrors: report.lookupErrors || [],
    unmatchedKeys: [...unmatched],
    askedKeys: [...askedKeys],
  };
  if (options.dryRun) return data;
  try {
    await bookCache.saveResolveState(source, userKey, data);
  } catch (err) {
    console.warn(`[scheduled-resolve] resolve-state save failed: ${err.message}`);
  }
  return data;
}

function countRequests(report) {
  let requests = Number(report.requests) || 0;
  for (const stat of Object.values(report.providerChain || {})) {
    requests += Number(stat.calls) || 0;
  }
  return requests;
}

async function resolveOneProfile(profile, options = {}) {
  const source = profile.source || 'livelib';
  const userKey = profile.userKey;
  const nowMs = options.now == null ? Date.now() : Number(options.now);
  const recheckDays = Number.isFinite(Number(options.recheckDays))
    ? Number(options.recheckDays)
    : DEFAULT_RECHECK_DAYS;
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(0, Number(options.limit)) : DEFAULT_LIMIT;
  const force = Boolean(options.force);

  const stats = options.stats || require('./stats').buildBooksStats({ profile: `${source}-${userKey}` });
  const allowedWorkIds = allowedWorkIdsOf(stats);
  const pool = candidatePool(profile, { allowedWorkIds });
  const state = loadCandidateState(source, userKey);
  const resolveState = bookCache.getResolveState(source, userKey);
  const active = force
    ? pool
    : pool.filter((entry) => !recentlyMissed(state, resolveState, entry.key, nowMs, recheckDays));
  const selected = limit > 0 ? active.slice(0, limit) : active;

  const report = {
    source,
    userKey,
    pool: pool.length,
    active: active.length,
    selected: selected.length,
    linked: 0,
    misses: 0,
    deferred: 0,
    requests: 0,
    litresUsed: 0,
    litresLimit: null,
    gbUsed: 0,
    gbLimit: null,
    hardcoverRequests: 0,
    remaining: pool.length,
    activeRemaining: active.length,
    runsLeft: 0,
    breaker: false,
    skipped: false,
    reason: null,
  };

  if (selected.length === 0) {
    report.reason = pool.length === 0 ? 'pool-empty' : 'recheck-window';
    report.runsLeft = 0;
    return report;
  }

  if (options.dryRun) {
    report.reason = 'dry-run';
    report.remaining = pool.length;
    report.activeRemaining = active.length;
    report.runsLeft = limit > 0 ? Math.ceil(active.length / limit) : 0;
    return report;
  }

  const selectedKeys = new Set(selected.map((entry) => entry.key));
  const filtered = {
    ...profile,
    events: selected.map((entry) => entry.event),
  };
  const pass = await resolve.resolveProfile(filtered, {
    force,
    allowLivelibCard: false,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    providers: options.providers,
    litresBudget: options.litresBudget,
    gbBudget: options.gbBudget,
    cardBudget: options.cardBudget,
    litresPauseMs: options.pause == null ? DEFAULT_PAUSE_MS : Number(options.pause),
    requestDelayMs: options.requestDelayMs,
    now: options.nowIso,
  });

  report.requests = countRequests(pass);
  report.litresUsed = pass.litresBudget && Number(pass.litresBudget.used);
  report.litresLimit = pass.litresBudget && Number(pass.litresBudget.limit);
  report.gbUsed = pass.gbBudget && Number(pass.gbBudget.used);
  report.gbLimit = pass.gbBudget && Number(pass.gbBudget.limit);
  report.hardcoverRequests = Number(pass.requests) || 0;
  report.breaker = typeof litres.isBreakerOpen === 'function' && litres.isBreakerOpen();

  const missKeys = new Set((pass.unmatchedKeys || []).map(String));
  const askedKeys = new Set((pass.askedKeys || []).map(String));
  const providerErrors = new Set((pass.providerErrorKeys || []).map(String));
  const budgetPending = new Set((pass.budgetPendingKeys || []).map(String));
  const nowIso = options.nowIso || new Date(nowMs).toISOString();
  const newMissKeys = new Set();
  for (const entry of selected) {
    const key = String(entry.key);
    const linked = !isUnlinked(entry.event);
    if (linked) {
      report.linked++;
      delete state.candidates[key];
      continue;
    }
    if (budgetPending.has(key)) {
      report.deferred++;
      continue;
    }
    const providers = (pass.missedByKey && pass.missedByKey[key]) || [];
    const cyrillic = CYRILLIC_TITLE.test(String((entry.event && entry.event.title) || ''));
    const litresVerdict = cyrillic && providers.includes('litres');
    if (missKeys.has(key) || litresVerdict) {
      report.misses++;
      newMissKeys.add(key);
      state.candidates[key] = {
        askedAt: nowIso,
        providers,
        title: entry.event && entry.event.title ? String(entry.event.title) : null,
        outcome: 'miss',
      };
      continue;
    }
    report.deferred++;
    if (!askedKeys.has(key) && !providerErrors.has(key)) {
    }
  }
  const poolKeys = new Set(pool.map((entry) => String(entry.key)));
  for (const key of Object.keys(state.candidates)) {
    if (!poolKeys.has(key)) delete state.candidates[key];
  }
  state.updatedAt = nowIso;
  state.recheckDays = recheckDays;
  if (!options.dryRun) {
    try {
      saveCandidateState(source, userKey, state);
    } catch (err) {
      console.warn(`[scheduled-resolve] candidate-state save failed: ${err.message}`);
    }
  }

  const afterPool = candidatePool(profile, { allowedWorkIds });
  const afterActive = force
    ? afterPool
    : afterPool.filter((entry) => !recentlyMissed(state, null, entry.key, nowMs, recheckDays));
  report.remaining = afterPool.length;
  report.activeRemaining = afterActive.length;
  report.runsLeft = afterActive.length > 0 && limit > 0 ? Math.ceil(afterActive.length / limit) : 0;

  if (!options.dryRun) {
    report.resolveState = await mergeResolveState(profile, pass, {
      ...options,
      extraUnmatchedKeys: [...newMissKeys],
    });
  } else {
    report.resolveState = await mergeResolveState(profile, pass, {
      dryRun: true,
      extraUnmatchedKeys: [...newMissKeys],
    });
  }
  return report;
}

function log(message) {
  console.log(message);
}

async function runScheduledResolve(options = {}) {
  const started = Date.now();
  const source = 'livelib';
  let profiles = bookCache.listProfiles().filter((meta) => meta.source === source);
  if (options.profile) {
    const wanted = String(options.profile).replace(/^livelib-/, '');
    profiles = profiles.filter((meta) => String(meta.userKey) === wanted);
  }
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(0, Number(options.limit)) : DEFAULT_LIMIT;
  const recheckDays = Number.isFinite(Number(options.recheckDays))
    ? Number(options.recheckDays)
    : DEFAULT_RECHECK_DAYS;
  const pause = options.pause == null ? DEFAULT_PAUSE_MS : Number(options.pause);

  const litresBudget = options.litresBudget || litres.createBudget(process.env.BOOKS_LITRES_BUDGET);
  const gbBudget = options.gbBudget || googlebooks.createBudget(process.env.BOOKS_GB_BUDGET);
  const cardBudget = options.cardBudget || resolve.createCardBudget(process.env.BOOKS_LIVELIB_CARD_BUDGET);

  const summary = {
    profiles: 0,
    pool: 0,
    active: 0,
    selected: 0,
    linked: 0,
    misses: 0,
    deferred: 0,
    requests: 0,
    litresUsed: 0,
    litresLimit: litresBudget.limit,
    gbUsed: 0,
    gbLimit: gbBudget.limit,
    hardcoverRequests: 0,
    remaining: 0,
    activeRemaining: 0,
    runsLeft: 0,
    skippedProfiles: [],
    breaker: false,
    elapsedMs: 0,
    empty: false,
  };

  const prepared = [];
  for (const meta of profiles) {
    const data = bookCache.getProfile(source, meta.userKey);
    if (!data) continue;
    const stats = options.statsFor
      ? options.statsFor(data)
      : require('./stats').buildBooksStats({ profile: `${source}-${meta.userKey}` });
    const pool = candidatePool(data, { allowedWorkIds: allowedWorkIdsOf(stats) });
    const state = loadCandidateState(source, meta.userKey);
    const resolveState = bookCache.getResolveState(source, meta.userKey);
    const active = options.force
      ? pool
      : pool.filter((entry) => !recentlyMissed(state, resolveState, entry.key, Date.now(), recheckDays));
    summary.profiles++;
    summary.pool += pool.length;
    summary.active += active.length;
    prepared.push({ meta, data, stats, pool, active });
  }

  if (prepared.every((entry) => entry.active.length === 0)) {
    summary.empty = true;
    summary.elapsedMs = Date.now() - started;
    summary.remaining = summary.pool;
    log(
      `[scheduled-resolve] nothing to do: pool=${summary.pool} active=0 ` +
        `profiles=${summary.profiles} (recheck ${recheckDays}d) — 0 requests`
    );
    return summary;
  }

  const lock = await resolveLock.acquireLock({
    owner: 'scheduled-resolve',
    waitMs: Number(options.lockWaitMs) || 0,
    sleep: options.sleep,
  });
  if (!lock.ok) {
    summary.skippedProfiles = prepared.map((entry) => entry.meta.userKey);
    summary.elapsedMs = Date.now() - started;
    log('[scheduled-resolve] resolve lock is held by another pass (import?) — skipped, 0 requests');
    return summary;
  }

  try {
    for (const entry of prepared) {
      const { meta, data } = entry;
      if (entry.active.length === 0) {
        log(
          `[scheduled-resolve] profile=${source}-${meta.userKey} pool=${entry.pool.length} ` +
            `active=0 — re-check window, skipped`
        );
        summary.skippedProfiles.push(meta.userKey);
        summary.remaining += entry.pool.length;
        continue;
      }
      const report = await resolveOneProfile(data, {
        ...options,
        stats: entry.stats,
        limit,
        recheckDays,
        pause,
        litresBudget,
        gbBudget,
        cardBudget,
      });
      summary.selected += report.selected;
      summary.linked += report.linked;
      summary.misses += report.misses;
      summary.deferred += report.deferred;
      summary.requests += report.requests;
      summary.hardcoverRequests += report.hardcoverRequests;
      summary.remaining += report.remaining;
      summary.activeRemaining += report.activeRemaining;
      summary.runsLeft = Math.max(summary.runsLeft, report.runsLeft);
      summary.breaker = summary.breaker || report.breaker;
      log(
        `[scheduled-resolve] profile=${source}-${meta.userKey} pool=${report.pool} ` +
          `selected=${report.selected} linked=${report.linked} misses=${report.misses} ` +
          `deferred=${report.deferred} budget=${report.litresUsed}/${report.litresLimit} ` +
          `gb=${report.gbUsed}/${report.gbLimit} ` +
          `hc=${report.hardcoverRequests} requests=${report.requests} ` +
          `remaining=${report.remaining} active=${report.activeRemaining} runsLeft=${report.runsLeft}` +
          `${report.breaker ? ' BREAKER' : ''}`
      );
    }
  } finally {
    resolveLock.releaseLock(lock.token);
  }

  summary.litresUsed = litresBudget.used;
  summary.gbUsed = gbBudget.used;
  summary.elapsedMs = Date.now() - started;
  log(
    `[scheduled-resolve] итог: pool=${summary.pool} selected=${summary.selected} ` +
      `linked=${summary.linked} misses=${summary.misses} deferred=${summary.deferred} ` +
      `litres=${summary.litresUsed}/${summary.litresLimit} gb=${summary.gbUsed}/${summary.gbLimit} ` +
      `hc=${summary.hardcoverRequests} ` +
      `requests=${summary.requests} remaining=${summary.remaining} ` +
      `active=${summary.activeRemaining} ` +
      (summary.runsLeft ? `~${summary.runsLeft} прогон(ов) до конца` : 'очередь пуста') +
      ` elapsed=${summary.elapsedMs}ms`
  );
  return summary;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--profile') options.profile = String(argv[++i] || '');
    else if (arg === '--limit') options.limit = Number(argv[++i]);
    else if (arg === '--pause') options.pause = Number(argv[++i]);
    else if (arg === '--recheck-days') options.recheckDays = Number(argv[++i]);
    else if (arg === '--lock-wait-ms') options.lockWaitMs = Number(argv[++i]);
    else if (arg === '--now') options.nowIso = String(argv[++i] || '');
  }
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  runScheduledResolve(options)
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_LIMIT,
  DEFAULT_RECHECK_DAYS,
  DEFAULT_PAUSE_MS,
  candidateStatePath,
  loadCandidateState,
  saveCandidateState,
  missedAtOf,
  recentlyMissed,
  candidatePool,
  resolveOneProfile,
  runScheduledResolve,
  mergeResolveState,
  parseArgs,
};
