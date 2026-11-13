'use strict';

const fs = require('fs');
const path = require('path');

const gameCache = require('../game-cache');
const { safeKey } = require('../../core/fs-store');
const { envMs } = require('../../core/env');
const { createSourceGate } = require('../../core/source-client');
const sources = require('../../core/sources');
const { maskSecrets } = require('./errors');
const {
  SCHEMA_VERSION,
  nowMs,
  isoOf,
  catalogMetaFlags,
  detailNeedsCatalog,
  sanitizeDetailGenres,
} = require('./normalize');

const CACHE_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'secondary-details');
const STATE_DIR = gameCache.STATE_DIR;
const BREAKER_PATH = path.join(STATE_DIR, 'secondary-details-breaker.json');
const STATUS_PATH = path.join(STATE_DIR, 'secondary-details-status.json');
const DEBUG_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'debug', 'epic');
const CATALOG_PROBE_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'catalog-probe');
const CATALOG_STATE_PATH = path.join(STATE_DIR, 'catalog-state.json');
const MAX_CATALOG_ATTEMPTS = 5;
const MAX_CATALOG_DEBUG_FILES = 5;
const MAX_CATALOG_STATUS_ITEMS = 20;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 30 * DAY_MS;
const DEFAULT_NOT_FOUND_TTL_MS = 30 * DAY_MS;
const DEFAULT_PROBE_TTL_MS = 7 * DAY_MS;
const DEFAULT_CATALOG_PROBE_TTL_MS = 30 * DAY_MS;
const DEFAULT_BREAKER_MS = sources.breakerMs('secondary');
const MAX_DEBUG_FILES = 3;
const DEBUG_BODY_LIMIT = 2048;
const MAX_STATUS_ERRORS = 5;
const MAX_KICK_HISTORY = 10;

try {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(CATALOG_PROBE_DIR, { recursive: true });
} catch (err) {
}

function ttlMs() {
  return sources.ttlMs('secondary');
}

function notFoundTtlMs() {
  return envMs('GAMES_SECONDARY_NOT_FOUND_TTL_MS', DEFAULT_NOT_FOUND_TTL_MS);
}

function probeTtlMs() {
  return envMs('GAMES_SECONDARY_PROBE_TTL_MS', DEFAULT_PROBE_TTL_MS);
}

function catalogProbeTtlMs() {
  return envMs('GAMES_SECONDARY_CATALOG_PROBE_TTL_MS', DEFAULT_CATALOG_PROBE_TTL_MS);
}

function breakerMs() {
  return sources.breakerMs('secondary');
}

function cachePath(source, id) {
  return path.join(CACHE_DIR, `${safeKey(source)}-${safeKey(id)}.json`);
}

function isFresh(doc, atMs) {
  const fetchedAt = doc && doc.fetchedAt ? Date.parse(doc.fetchedAt) : NaN;
  if (!Number.isFinite(fetchedAt)) return false;
  let ttl = ttlMs();
  if (doc.status === 'not_found') {
    ttl = doc.probe === true ? probeTtlMs() : notFoundTtlMs();
  }
  return atMs - fetchedAt < ttl;
}

function readDetail(source, id, options = {}) {
  if (!source || !id) return { doc: null, fresh: false };
  const hit = gameCache.readJsonWithFingerprint(cachePath(source, id));
  if (!hit || !hit.data) return { doc: null, fresh: false };
  const doc = hit.data;
  const data = doc.data ? sanitizeDetailGenres(doc.data) : doc.data;
  const view = data === doc.data ? doc : { ...doc, data };
  return { doc: view, fresh: isFresh(doc, options.now == null ? nowMs() : options.now) };
}

function writeDetail(source, id, status, data, extra = {}) {
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    source,
    id: String(id),
    status,
    fetchedAt: isoOf(nowMs()),
    ...extra,
    data: data || null,
  };
  gameCache.writeJsonAtomicSync(cachePath(source, id), doc);
  return doc;
}

function catalogProbePath(catalogItemId) {
  return path.join(CATALOG_PROBE_DIR, `${safeKey(catalogItemId)}.json`);
}

function readCatalogProbe(catalogItemId, options = {}) {
  if (!catalogItemId) return { doc: null, fresh: false };
  const hit = gameCache.readJsonWithFingerprint(catalogProbePath(catalogItemId));
  if (!hit || !hit.data) return { doc: null, fresh: false };
  const fetchedAt = Date.parse(hit.data.fetchedAt || '');
  const at = options.now == null ? nowMs() : options.now;
  const fresh = Number.isFinite(fetchedAt) && at - fetchedAt < catalogProbeTtlMs();
  return { doc: hit.data, fresh };
}

function writeCatalogProbe(catalogItemId, status, extra = {}) {
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    source: 'epic-catalog-probe',
    catalogItemId: String(catalogItemId),
    status,
    fetchedAt: isoOf(nowMs()),
    ...extra,
  };
  try {
    gameCache.writeJsonAtomicSync(catalogProbePath(catalogItemId), doc);
  } catch (err) {
  }
  return doc;
}

function readCatalogState() {
  const hit = gameCache.readJsonWithFingerprint(CATALOG_STATE_PATH);
  const doc = (hit && hit.data) || {};
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: doc.updatedAt || null,
    owners: doc.owners && typeof doc.owners === 'object' ? doc.owners : {},
  };
}

function writeCatalogState(state) {
  try {
    gameCache.writeJsonAtomicSync(CATALOG_STATE_PATH, {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: isoOf(nowMs()),
      owners: state && state.owners && typeof state.owners === 'object' ? state.owners : {},
    });
  } catch (err) {
  }
}

function readCatalogAttempt(ownerKey, catalogItemId, state) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  const id = String(catalogItemId == null ? '' : catalogItemId);
  if (!key || !id) return null;
  const source = state || readCatalogState();
  const owner = source.owners[key];
  const entry = owner && owner[id];
  return entry && typeof entry === 'object' ? entry : null;
}

function recordCatalogAttempt(ownerKey, catalogItemId, entry = {}) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  const id = String(catalogItemId == null ? '' : catalogItemId);
  if (!key || !id) return null;
  try {
    const state = readCatalogState();
    if (!state.owners[key] || typeof state.owners[key] !== 'object') state.owners[key] = {};
    const previous = state.owners[key][id] || {};
    const attempts = Array.isArray(previous.attempts) ? previous.attempts.slice() : [];
    const result = entry.result || 'unavailable';
    attempts.push({
      at: isoOf(nowMs()),
      result,
      httpStatus: entry.httpStatus == null ? null : Number(entry.httpStatus),
      bytes: entry.bytes == null ? null : Number(entry.bytes),
      genresOk: entry.genresOk === true,
      yearHas: entry.yearHas === true,
    });
    const next = {
      catalogItemId: id,
      namespace: entry.namespace || previous.namespace || null,
      lastResult: result,
      lastAt: attempts[attempts.length - 1].at,
      attempts: attempts.slice(-MAX_CATALOG_ATTEMPTS),
    };
    state.owners[key][id] = next;
    writeCatalogState(state);
    return next;
  } catch (err) {
    return null;
  }
}

function catalogRetryDue(ownerKey, catalogItemId, options = {}) {
  const entry = readCatalogAttempt(ownerKey, catalogItemId, options.catalogState);
  if (!entry) return true;
  const result = entry.lastResult || null;
  if (result === 'shape_ok') return false;
  if (result === '401' || result === '403' || result === 'unavailable' || result === 'budget') {
    return true;
  }
  const at = Date.parse(entry.lastAt || '');
  const now = options.now == null ? nowMs() : options.now;
  if (!Number.isFinite(at)) return true;
  return now - at >= catalogProbeTtlMs();
}

function shouldAttemptCatalog(data, options = {}) {
  if (!detailNeedsCatalog(data)) return false;
  if (data.catalogPending === true) return true;
  if (data.catalogChecked !== true) return true;
  if (options.ownerKey && options.catalogItemId) {
    return catalogRetryDue(options.ownerKey, options.catalogItemId, options);
  }
  return false;
}

function catalogCompletionState(data, options = {}) {
  if (!data || typeof data !== 'object') return 'unavailable';
  const flags = catalogMetaFlags(data);
  if (flags.metaStatus !== 'unavailable') return flags.metaStatus;
  if (data.catalogPending === true) return 'pending';
  if (data.catalogChecked !== true) return 'pending';
  if (data.catalogSkipped === 'not_connected') {
    return options.hasCatalogToken === true ? 'pending' : 'unavailable';
  }
  if (options.catalogItemId && options.ownerKey) {
    return catalogRetryDue(options.ownerKey, options.catalogItemId, options)
      ? 'pending'
      : 'unavailable';
  }
  return 'unavailable';
}

function catalogIsFresh(catalog) {
  if (!catalog || typeof catalog !== 'object') return false;
  try {
    return gameCache.isFresh(catalog, require('../epic-cache').epicCatalogTtlMs());
  } catch (err) {
    return false;
  }
}

function dumpCatalogFailure(catalogItemId, info = {}) {
  try {
    const id = String(catalogItemId == null ? '' : catalogItemId);
    if (!id) return null;
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const file = path.join(DEBUG_DIR, `catalog-${safeKey(id)}.json`);
    if (!fs.existsSync(file)) {
      let count = 0;
      for (const name of fs.readdirSync(DEBUG_DIR)) {
        if (name.startsWith('catalog-') && name.endsWith('.json')) count++;
      }
      if (count >= MAX_CATALOG_DEBUG_FILES) return null;
    }
    let item = null;
    if (info.item != null) {
      try {
        item = maskSecrets(JSON.stringify(info.item)).slice(0, DEBUG_BODY_LIMIT);
      } catch (err) {
        item = null;
      }
    }
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      source: 'epic-catalog',
      catalogItemId: id,
      namespace: info.namespace || null,
      at: isoOf(nowMs()),
      result: info.result || 'unavailable',
      httpStatus: info.httpStatus == null ? null : Number(info.httpStatus),
      bytes: info.bytes == null ? null : Number(info.bytes),
      genresOk: info.genresOk === true,
      yearHas: info.yearHas === true,
      code: info.code || null,
      reason: info.reason || null,
      item,
      note:
        'Диагностика каталога Epic: статус/размер ответа и нормализованный item ' +
        '(≤2 KB, секреты замаскированы; токен не пишется).',
    };
    gameCache.writeJsonAtomicSync(file, doc);
    return file;
  } catch (err) {
    return null;
  }
}

function catalogAttemptsForOwner(ownerKey) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  const state = readCatalogState();
  const owner = (key && state.owners[key]) || {};
  const items = Object.values(owner)
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const attempts = Array.isArray(entry.attempts) ? entry.attempts.slice(-MAX_CATALOG_ATTEMPTS) : [];
      const last = attempts.length ? attempts[attempts.length - 1] : null;
      return {
        catalogItemId: entry.catalogItemId || null,
        namespace: entry.namespace || null,
        attempts: attempts.length,
        lastResult: entry.lastResult || null,
        lastAt: entry.lastAt || null,
        httpStatus: last ? last.httpStatus : null,
        bytes: last ? last.bytes : null,
        genresOk: last ? last.genresOk === true : false,
        yearHas: last ? last.yearHas === true : false,
        history: attempts,
      };
    })
    .sort((a, b) => (Date.parse(b.lastAt || '') || 0) - (Date.parse(a.lastAt || '') || 0));
  return {
    total: items.reduce((sum, entry) => sum + entry.attempts, 0),
    items: items.slice(0, MAX_CATALOG_STATUS_ITEMS),
  };
}

function readDetailsIndex({ gogIds = [], epicSlugs = [], now = nowMs() } = {}) {
  const index = {};
  let present = null;
  try {
    present = new Set(fs.readdirSync(CACHE_DIR));
  } catch (err) {
    present = null;
  }
  const has = (source, id) =>
    !present || present.has(`${safeKey(source)}-${safeKey(id)}.json`);
  for (const id of gogIds) {
    if (!id || !has('gog', id)) continue;
    const { doc, fresh } = readDetail('gog', id, { now });
    if (fresh && doc && doc.status === 'ok' && doc.data) index[`gog:${id}`] = doc.data;
  }
  for (const slug of epicSlugs) {
    if (!slug || !has('epic', slug)) continue;
    const { doc, fresh } = readDetail('epic', slug, { now });
    if (fresh && doc && doc.status === 'ok' && doc.data) index[`epic:${slug}`] = doc.data;
  }
  return index;
}

function readBreaker() {
  const hit = gameCache.readJsonWithFingerprint(BREAKER_PATH);
  return (hit && hit.data) || {};
}

function writeBreaker(state) {
  return gameCache.writeJsonAtomicSync(BREAKER_PATH, state || {});
}

const breakerGate = createSourceGate({
  now: () => nowMs(),
  breakerMs: () => breakerMs(),
  breakerStore: {
    read: readBreaker,
    write: writeBreaker,
  },
  encode: (entry) => ({
    until: isoOf(entry.until),
    at: isoOf(entry.at),
    code: entry.code || 'blocked',
    status: entry.status == null ? null : entry.status,
  }),
  decode: (raw) => {
    const until = Date.parse(raw && raw.until ? raw.until : '');
    if (!Number.isFinite(until)) return null;
    return {
      until,
      at: Date.parse(raw.at || '') || null,
      reason: raw.code || null,
      code: raw.code || null,
      status: raw.status == null ? null : raw.status,
    };
  },
});

function breakerBlock(source, now = nowMs()) {
  const entry = breakerGate.breakerFor(source, now);
  if (!entry) return null;
  return { until: isoOf(entry.until), code: entry.code || entry.reason || 'blocked' };
}

function tripBreaker(source, code, status) {
  breakerGate.tripBreaker(source, { code: code || 'blocked', status });
  return readBreaker()[source];
}

function readStatusState() {
  const hit = gameCache.readJsonWithFingerprint(STATUS_PATH);
  const doc = (hit && hit.data) || {};
  return {
    schemaVersion: SCHEMA_VERSION,
    lastErrors: Array.isArray(doc.lastErrors) ? doc.lastErrors.slice(-MAX_STATUS_ERRORS) : [],
    kicks: Array.isArray(doc.kicks) ? doc.kicks.slice(-MAX_KICK_HISTORY) : [],
    lastRunAt: doc.lastRunAt || null,
    skips: doc.skips && typeof doc.skips === 'object' ? doc.skips : {},
  };
}

function writeStatusState(state) {
  try {
    gameCache.writeJsonAtomicSync(STATUS_PATH, { schemaVersion: SCHEMA_VERSION, ...state });
  } catch (err) {
  }
}

function recordError(entry) {
  try {
    const state = readStatusState();
    state.lastErrors.push({ at: isoOf(nowMs()), ...entry });
    state.lastErrors = state.lastErrors.slice(-MAX_STATUS_ERRORS);
    writeStatusState(state);
  } catch (err) {
  }
}

function recordKick(entry) {
  try {
    const state = readStatusState();
    state.kicks.push({ at: isoOf(nowMs()), ...entry });
    state.kicks = state.kicks.slice(-MAX_KICK_HISTORY);
    writeStatusState(state);
  } catch (err) {
  }
}

function recordSkip(ownerKey, entry = {}) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  if (!key) return null;
  const source = entry.source || 'epic';
  try {
    const state = readStatusState();
    const ownerSkips = (state.skips && state.skips[key]) || {};
    const previous = ownerSkips[source] || null;
    const next = { source, reason: entry.reason || 'skipped', at: isoOf(nowMs()) };
    for (const field of ['catalogItemId', 'accountId', 'detail', 'otherOwner', 'trigger']) {
      if (entry[field] != null) next[field] = entry[field];
    }
    const at = previous ? Date.parse(previous.at || '') : NaN;
    if (
      previous &&
      previous.reason === next.reason &&
      previous.catalogItemId === next.catalogItemId &&
      Number.isFinite(at) &&
      nowMs() - at < 60_000
    ) {
      return previous;
    }
    if (!state.skips || typeof state.skips !== 'object') state.skips = {};
    if (!state.skips[key] || typeof state.skips[key] !== 'object') state.skips[key] = {};
    state.skips[key][source] = next;
    writeStatusState(state);
    return next;
  } catch (err) {
    return null;
  }
}

function recordRunFinished(job) {
  try {
    const state = readStatusState();
    state.lastRunAt = job.finishedAt || isoOf(nowMs());
    writeStatusState(state);
  } catch (err) {
  }
}

module.exports = {
  CACHE_DIR,
  STATE_DIR,
  BREAKER_PATH,
  STATUS_PATH,
  DEBUG_DIR,
  CATALOG_PROBE_DIR,
  CATALOG_STATE_PATH,
  MAX_CATALOG_ATTEMPTS,
  MAX_CATALOG_DEBUG_FILES,
  MAX_CATALOG_STATUS_ITEMS,
  MAX_DEBUG_FILES,
  MAX_STATUS_ERRORS,
  MAX_KICK_HISTORY,
  DEBUG_BODY_LIMIT,
  DEFAULT_TTL_MS,
  DEFAULT_NOT_FOUND_TTL_MS,
  DEFAULT_PROBE_TTL_MS,
  DEFAULT_CATALOG_PROBE_TTL_MS,
  DEFAULT_BREAKER_MS,
  ttlMs,
  notFoundTtlMs,
  probeTtlMs,
  catalogProbeTtlMs,
  breakerMs,
  cachePath,
  isFresh,
  readDetail,
  writeDetail,
  catalogProbePath,
  readCatalogProbe,
  writeCatalogProbe,
  readCatalogState,
  writeCatalogState,
  readCatalogAttempt,
  recordCatalogAttempt,
  catalogRetryDue,
  catalogIsFresh,
  shouldAttemptCatalog,
  catalogCompletionState,
  dumpCatalogFailure,
  catalogAttemptsForOwner,
  readDetailsIndex,
  readBreaker,
  writeBreaker,
  breakerBlock,
  tripBreaker,
  readStatusState,
  writeStatusState,
  recordError,
  recordKick,
  recordSkip,
  recordRunFinished,
};
