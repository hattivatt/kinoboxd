'use strict';

const authors = require('./authors');
const wd = require('./authors-wikidata');
const bookCache = require('./book-cache');
const { wikidataEnabled } = require('./wikidata-flag');

const COOLDOWN_MS = 30 * 60 * 1000;
const MAX_NAMES_PER_RUN = 900;

let inFlight = null;
const MIN_GAP_MS = 5000;
let lastPassStartedAt = 0;

function pendingCandidates(entries, persisted = {}, groups = null) {
  const checked = (persisted && persisted.wikidata && persisted.wikidata.checked) || {};
  const list = Array.isArray(groups)
    ? groups
    : authors.groupAuthors(entries, persisted || {}).groups;
  const out = [];
  const seen = new Set();
  for (const group of list) {
    if (!group || !Array.isArray(group.names) || group.names.length !== 1) continue;
    const name = group.names[0];
    const key = authors.normalizeAuthorName(name);
    if (!key || seen.has(key) || checked[key]) continue;
    seen.add(key);
    out.push(String(name));
  }
  return out;
}

function cooldownUntil(persisted) {
  const state = persisted && persisted.wikidata;
  if (!state || !state.disabledUntil) return 0;
  const at = Date.parse(String(state.disabledUntil));
  return Number.isFinite(at) ? at : 0;
}

async function resolveAuthorsWikidata(entries, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const persisted = options.persisted || bookCache.getAuthorsMap();
  const pending = pendingCandidates(entries, persisted, options.groups);
  if (!pending.length) {
    return { ran: false, reason: 'nothing_to_do', pending: 0, queries: 0, merged: 0, checked: 0 };
  }
  if (!options.force) {
    if (!wikidataEnabled() && options.ignoreEnv !== true) {
      return { ran: false, reason: 'disabled', pending: pending.length, queries: 0, merged: 0, checked: 0 };
    }
    const until = cooldownUntil(persisted);
    if (until > now()) {
      return {
        ran: false,
        reason: 'cooldown',
        pending: pending.length,
        queries: 0,
        merged: 0,
        checked: 0,
        until: new Date(until).toISOString(),
      };
    }
  }

  const maxNames = options.maxNames == null ? MAX_NAMES_PER_RUN : Number(options.maxNames);
  const names = pending.slice(0, Math.max(0, maxNames));

  let result;
  try {
    result = await wd.resolveWikidataAliases(entries, {
      persisted,
      names,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
      pauseMs: options.pauseMs,
      limit: names.length,
    });
  } catch (err) {
    await applyCooldown(options, err);
    console.warn(
      `[books-authors] wikidata unavailable (${(err && err.message) || 'error'}), ` +
        'degraded to the offline rule'
    );
    return {
      ran: false,
      reason: 'error',
      pending: pending.length,
      queries: 0,
      merged: 0,
      checked: 0,
      error: (err && err.message) || 'wikidata_failed',
    };
  }

  if (result.skipped) {
    await applyCooldown(options, {
      status: result.skipped,
      retryAfter: result.retryAfter,
    });
    console.warn(`[books-authors] wikidata ${result.skipped}, cooldown started; duplicates stay for now`);
    return {
      ran: true,
      reason: 'degraded',
      pending: pending.length,
      queries: result.queries || 0,
      merged: 0,
      checked: 0,
      skipped: result.skipped,
    };
  }

  const checkedKeys = {};
  for (const name of result.checked || []) {
    const key = authors.normalizeAuthorName(name);
    if (key) checkedKeys[key] = true;
  }
  if (options.persist === false) {
    return {
      ran: true,
      reason: 'dry_run',
      pending: pending.length,
      queries: result.queries || 0,
      merged: (result.merged || []).length,
      checked: Object.keys(checkedKeys).length,
      names: result.merged || [],
    };
  }
  try {
    await bookCache.saveAuthorsMap({
      canonical: result.canonical || {},
      wikidata: {
        checked: checkedKeys,
        checkedAt: new Date(now()).toISOString(),
        disabledUntil: null,
      },
    });
  } catch (err) {
    console.warn(`[books-authors] authors.json is not writable: ${(err && err.message) || 'save_failed'}`);
    return {
      ran: true,
      reason: 'cache_read_only',
      pending: pending.length,
      queries: result.queries || 0,
      merged: (result.merged || []).length,
      checked: Object.keys(checkedKeys).length,
      error: (err && err.message) || 'save_failed',
    };
  }

  return {
    ran: true,
    reason: 'ok',
    pending: pending.length,
    queries: result.queries || 0,
    merged: (result.merged || []).length,
    checked: Object.keys(checkedKeys).length,
    names: result.merged || [],
  };
}

function logPass(report) {
  if (!report || !report.ran) return;
  if (report.reason === 'ok' || report.reason === 'dry_run') {
    if (!report.merged) return;
    console.log(
      `[books-authors] wikidata merged=${report.merged} queries=${report.queries} ` +
        `checked=${report.checked}`
    );
  }
}

async function applyCooldown(options, err) {
  if (options.persist === false) return null;
  const persisted = options.persisted || bookCache.getAuthorsMap();
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const base = options.cooldownMs == null ? COOLDOWN_MS : Number(options.cooldownMs);
  const retrySeconds = err && Number.isFinite(Number(err.retryAfter)) && Number(err.retryAfter) > 0
    ? Number(err.retryAfter) * 1000
    : 0;
  const until = new Date(now() + Math.max(base, retrySeconds)).toISOString();
  try {
    await bookCache.saveAuthorsMap({
      wikidata: { checked: {}, checkedAt: persisted.wikidata ? persisted.wikidata.checkedAt : null, disabledUntil: until },
    });
  } catch (saveErr) {
  }
  return until;
}

function kickAuthorsWikidata(entries, options = {}) {
  if (inFlight) return inFlight;
  if (!Array.isArray(entries) || !entries.length) return null;
  if (!wikidataEnabled()) return null;
  const gap = options.minGapMs == null ? MIN_GAP_MS : Number(options.minGapMs);
  if (gap > 0 && Date.now() - lastPassStartedAt < gap) return null;
  lastPassStartedAt = Date.now();
  const promise = resolveAuthorsWikidata(entries, options)
    .then((report) => {
      logPass(report);
      return report;
    })
    .catch(() => null)
    .finally(() => {
      if (inFlight === promise) inFlight = null;
    });
  inFlight = promise;
  return promise;
}

function currentPass() {
  return inFlight;
}

module.exports = {
  COOLDOWN_MS,
  MAX_NAMES_PER_RUN,
  wikidataEnabled,
  pendingCandidates,
  resolveAuthorsWikidata,
  kickAuthorsWikidata,
  currentPass,
};
