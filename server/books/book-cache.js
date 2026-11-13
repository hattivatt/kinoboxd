'use strict';

const fs = require('fs');
const path = require('path');

const BOOK_CACHE_DIR = process.env.KINOBOXD_CACHE_BOOK_DIR
  ? path.resolve(process.env.KINOBOXD_CACHE_BOOK_DIR)
  : path.join(__dirname, '..', '..', 'cache-book');

const PROFILES_DIR = path.join(BOOK_CACHE_DIR, 'profiles');
const DETAILS_DIR = path.join(BOOK_CACHE_DIR, 'details');
const LINKS_DIR = path.join(BOOK_CACHE_DIR, 'links');
const IMPORTS_DIR = path.join(BOOK_CACHE_DIR, 'imports');
const RESOLVE_STATE_DIR = path.join(BOOK_CACHE_DIR, 'resolve-state');
const FLAGS_DIR = path.join(BOOK_CACHE_DIR, 'flags');
const YEAR_OVERRIDES_DIR = path.join(BOOK_CACHE_DIR, 'year-overrides');
const INDEX_PATH = path.join(BOOK_CACHE_DIR, 'index.json');
const LINKS_JSON_PATH = path.join(BOOK_CACHE_DIR, 'links.json');
const FLAGS_PATH = path.join(FLAGS_DIR, 'book-flags.json');
const MATCH_LOG_PATH = path.join(BOOK_CACHE_DIR, 'match-log.jsonl');
const AUTHORS_PATH = path.join(BOOK_CACHE_DIR, 'authors.json');

for (const dir of [
  PROFILES_DIR,
  DETAILS_DIR,
  LINKS_DIR,
  IMPORTS_DIR,
  RESOLVE_STATE_DIR,
  FLAGS_DIR,
  YEAR_OVERRIDES_DIR,
]) {
  fs.mkdirSync(dir, { recursive: true });
}

const fsStore = require('../core/fs-store');

const fingerprintOf = fsStore.fingerprintOf;
const safeKey = fsStore.safeKey;

function readJsonWithFingerprint(filePath) {
  return fsStore.readJsonWithFingerprint(filePath, { label: 'book-cache' });
}

async function writeJsonAtomic(filePath, data) {
  return fsStore.writeJsonAtomic(filePath, data);
}

function writeJsonAtomicSync(filePath, data) {
  return fsStore.writeJsonAtomicSync(filePath, data);
}

function createDocCache({ keyOf, pathOf, accept }) {
  const memory = new Map();
  return {
    get(...args) {
      const key = keyOf(...args);
      const filePath = pathOf(...args);
      const cached = memory.get(key);
      if (cached && fingerprintOf(cached.path) === cached.fingerprint) return cached.data;
      if (cached) memory.delete(key);
      const found = readJsonWithFingerprint(filePath);
      if (!found || (accept && !accept(found.data))) return null;
      memory.set(key, { data: found.data, path: filePath, fingerprint: found.fingerprint });
      return found.data;
    },
    async save(data, ...args) {
      const key = keyOf(...args);
      const filePath = pathOf(...args);
      const fingerprint = await writeJsonAtomic(filePath, data);
      memory.set(key, { data, path: filePath, fingerprint });
      return filePath;
    },
    clear() {
      memory.clear();
    },
  };
}

function profilePath(source, userKey) {
  return path.join(PROFILES_DIR, `${safeKey(source)}-${safeKey(userKey)}.json`);
}

const profileDocs = createDocCache({
  keyOf: (source, userKey) => `${source}:${userKey}`,
  pathOf: profilePath,
});

function getProfile(source, userKey) {
  return profileDocs.get(source, userKey);
}

async function saveProfile(source, userKey, data) {
  return profileDocs.save(data, source, userKey);
}

function listProfiles() {
  let names = [];
  try {
    names = fs.readdirSync(PROFILES_DIR).filter((name) => name.endsWith('.json'));
  } catch (err) {
    return [];
  }
  const result = [];
  for (const name of names.sort()) {
    const filePath = path.join(PROFILES_DIR, name);
    const found = readJsonWithFingerprint(filePath);
    if (!found || !found.data || !found.data.source) continue;
    const data = found.data;
    const events = Array.isArray(data.events) ? data.events : [];
    const missingStatusId =
      data.source === 'hardcover'
        ? events.filter((event) => event && event.statusId == null).length
        : 0;
    result.push({
      source: data.source,
      userKey: data.userKey,
      origin: data.origin || data.source,
      sourceUserId: data.sourceUserId == null ? null : data.sourceUserId,
      importedAt: data.importedAt || null,
      eventCount: events.length,
      finishedCount: events.filter((event) => event && event.finishedAt).length,
      shelves: data.shelves || null,
      fileImports: Array.isArray(data.fileImports) ? data.fileImports.length : 0,
      missingStatusId,
      needsReimport: data.source === 'hardcover' && missingStatusId > 0,
      status: 'ok',
    });
  }
  return result;
}

function detailsPath(hcWorkId) {
  return path.join(DETAILS_DIR, `${safeKey(hcWorkId)}.json`);
}

function detailsKeyForWork(workId) {
  const value = String(workId == null ? '' : workId);
  const hc = /^hc:(\d+)$/.exec(value);
  if (hc) return hc[1];
  return safeKey(value.replace(':', '-'));
}

const detailDocs = createDocCache({
  keyOf: (hcWorkId) => String(hcWorkId),
  pathOf: (hcWorkId) => detailsPath(String(hcWorkId)),
});

function getWorkDetails(workId) {
  return getDetails(detailsKeyForWork(workId));
}

function getDetails(hcWorkId) {
  return detailDocs.get(hcWorkId);
}

function hasDetails(hcWorkId) {
  return getDetails(hcWorkId) !== null;
}

async function saveDetails(hcWorkId, data) {
  return detailDocs.save(data, hcWorkId);
}

function linkPath(livelibBookId) {
  return path.join(LINKS_DIR, `${safeKey(livelibBookId)}.json`);
}

const linkDocs = createDocCache({
  keyOf: (livelibBookId) => String(livelibBookId),
  pathOf: (livelibBookId) => linkPath(String(livelibBookId)),
});

function getLink(livelibBookId) {
  return linkDocs.get(livelibBookId);
}

async function saveLink(livelibBookId, data) {
  return linkDocs.save(data, livelibBookId);
}

let index = {};
let indexFingerprint = null;
const indexPending = new Map();

try {
  const found = readJsonWithFingerprint(INDEX_PATH);
  if (found && found.data && typeof found.data === 'object' && !Array.isArray(found.data)) {
    index = found.data;
  }
  indexFingerprint = fingerprintOf(INDEX_PATH);
} catch (err) {
  indexFingerprint = fingerprintOf(INDEX_PATH);
}

function refreshIndexIfChanged() {
  const current = fingerprintOf(INDEX_PATH);
  if (current === indexFingerprint) return false;
  let disk = {};
  if (current !== null) {
    const found = readJsonWithFingerprint(INDEX_PATH);
    if (!found || !found.data || typeof found.data !== 'object' || Array.isArray(found.data)) {
      indexFingerprint = current;
      return false;
    }
    disk = found.data;
  }
  const merged = Object.assign({}, disk);
  for (const [key, value] of indexPending) merged[key] = value;
  index = merged;
  indexFingerprint = current;
  if (indexPending.size) persistIndex();
  return true;
}

function getIndexEntry(key) {
  refreshIndexIfChanged();
  if (!Object.prototype.hasOwnProperty.call(index, key)) return undefined;
  return index[key];
}

function setIndexValue(key, value) {
  refreshIndexIfChanged();
  index[key] = value;
  indexPending.set(key, value);
  persistIndex();
}

let indexSaveScheduled = false;
let indexSaving = Promise.resolve();

async function writeIndexNow() {
  refreshIndexIfChanged();
  indexFingerprint = await writeJsonAtomic(INDEX_PATH, index);
  for (const [key, value] of indexPending) {
    if (index[key] === value) indexPending.delete(key);
  }
}

function persistIndex() {
  if (indexSaveScheduled) return;
  indexSaveScheduled = true;
  setTimeout(() => {
    indexSaveScheduled = false;
    indexSaving = indexSaving
      .then(() => {
        if (indexPending.size === 0) return null;
        return writeIndexNow();
      })
      .catch((err) => {
        console.error(`[book-cache] Failed to save index.json: ${err.message}`);
      });
  }, 300);
}

function flushIndex() {
  try {
    refreshIndexIfChanged();
    indexFingerprint = writeJsonAtomicSync(INDEX_PATH, index);
    indexPending.clear();
  } catch (err) {
    console.error(`[book-cache] Failed to flush index.json: ${err.message}`);
  }
}

let links = {};
let linksFingerprint = null;
const linksPending = new Map();

{
  const found = readJsonWithFingerprint(LINKS_JSON_PATH);
  if (found && found.data && typeof found.data === 'object' && !Array.isArray(found.data)) {
    links = found.data;
  }
  linksFingerprint = fingerprintOf(LINKS_JSON_PATH);
}

function refreshLinksIfChanged() {
  const current = fingerprintOf(LINKS_JSON_PATH);
  if (current === linksFingerprint) return false;
  let disk = {};
  if (current !== null) {
    const found = readJsonWithFingerprint(LINKS_JSON_PATH);
    if (found && found.data && typeof found.data === 'object' && !Array.isArray(found.data)) {
      disk = found.data;
    } else {
      linksFingerprint = current;
      return false;
    }
  }
  const merged = Object.assign({}, disk);
  for (const [key, value] of linksPending) merged[key] = value;
  links = merged;
  linksFingerprint = current;
  return true;
}

function getWorkLink(workId) {
  refreshLinksIfChanged();
  return links[workId] || null;
}

function setWorkLink(workId, value) {
  refreshLinksIfChanged();
  const previous = links[workId] || {};
  const next = Object.assign({}, previous, value);
  if (Array.isArray(value && value.livelib)) {
    const merged = new Set(Array.isArray(previous.livelib) ? previous.livelib : []);
    for (const id of value.livelib) merged.add(id);
    next.livelib = [...merged];
  }
  links[workId] = next;
  linksPending.set(workId, next);
  if (!linksSaveScheduled) {
    linksSaveScheduled = true;
    setTimeout(() => {
      linksSaveScheduled = false;
      linksSaving = linksSaving
        .then(() => {
          if (linksPending.size === 0) return null;
          refreshLinksIfChanged();
          return writeJsonAtomic(LINKS_JSON_PATH, links).then((fingerprint) => {
            linksFingerprint = fingerprint;
            linksPending.clear();
          });
        })
        .catch((err) => {
          console.error(`[book-cache] Failed to save links.json: ${err.message}`);
        });
    }, 300);
  }
}

let linksSaveScheduled = false;
let linksSaving = Promise.resolve();

function flushLinks() {
  try {
    refreshLinksIfChanged();
    if (linksPending.size === 0) return;
    linksFingerprint = writeJsonAtomicSync(LINKS_JSON_PATH, links);
    linksPending.clear();
  } catch (err) {
    console.error(`[book-cache] Failed to flush links.json: ${err.message}`);
  }
}

let flags = {};
let flagsFingerprint = null;
let flagsSaving = Promise.resolve();

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeFlags(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [workId, value] of Object.entries(raw)) {
    if (!workId || !isPlainObject(value)) continue;
    if (typeof value.mangaComics !== 'boolean') continue;
    out[workId] = {
      mangaComics: value.mangaComics,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    };
  }
  return out;
}

{
  const found = readJsonWithFingerprint(FLAGS_PATH);
  if (found) flags = sanitizeFlags(found.data);
  flagsFingerprint = fingerprintOf(FLAGS_PATH);
}

function refreshFlagsIfChanged() {
  const current = fingerprintOf(FLAGS_PATH);
  if (current === flagsFingerprint) return false;
  if (current === null) {
    flags = {};
    flagsFingerprint = null;
    return true;
  }
  const found = readJsonWithFingerprint(FLAGS_PATH);
  flags = found ? sanitizeFlags(found.data) : {};
  flagsFingerprint = current;
  return true;
}

function getMangaFlags() {
  refreshFlagsIfChanged();
  return flags;
}

function getMangaFlag(workId) {
  refreshFlagsIfChanged();
  const key = String(workId == null ? '' : workId);
  return Object.prototype.hasOwnProperty.call(flags, key) ? flags[key] : null;
}

function enqueueFlagsWrite(task) {
  const run = flagsSaving.then(task);
  flagsSaving = run.catch(() => {});
  return run;
}

function setMangaFlag(workId, mangaComics) {
  const key = String(workId == null ? '' : workId).trim();
  if (!key) return Promise.reject(new Error('workId is required'));
  if (typeof mangaComics !== 'boolean') {
    return Promise.reject(new Error('mangaComics must be a boolean'));
  }
  return enqueueFlagsWrite(async () => {
    refreshFlagsIfChanged();
    const entry = { mangaComics, updatedAt: new Date().toISOString() };
    const next = Object.assign({}, flags, { [key]: entry });
    const fingerprint = await writeJsonAtomic(FLAGS_PATH, next);
    flags = next;
    flagsFingerprint = fingerprint;
    return entry;
  });
}

function clearMangaFlag(workId) {
  const key = String(workId == null ? '' : workId).trim();
  if (!key) return Promise.reject(new Error('workId is required'));
  return enqueueFlagsWrite(async () => {
    refreshFlagsIfChanged();
    if (!Object.prototype.hasOwnProperty.call(flags, key)) return false;
    const next = Object.assign({}, flags);
    delete next[key];
    const fingerprint = await writeJsonAtomic(FLAGS_PATH, next);
    flags = next;
    flagsFingerprint = fingerprint;
    return true;
  });
}

const YEAR_MIN = -3000;
const YEAR_MAX = 2100;
const yearOverridesMemory = new Map();
let yearOverridesSaving = Promise.resolve();

function yearOverridesPath(source, userKey) {
  return path.join(YEAR_OVERRIDES_DIR, `${safeKey(source)}-${safeKey(userKey)}.json`);
}

function sanitizeYearOverrides(raw, source, userKey) {
  const data = {
    schemaVersion: 1,
    profile: { source: String(source), userKey: String(userKey) },
    overrides: {},
  };
  if (!isPlainObject(raw) || !isPlainObject(raw.overrides)) return data;
  for (const [workId, entry] of Object.entries(raw.overrides)) {
    if (!workId || !isPlainObject(entry)) continue;
    const year = Number(entry.year);
    if (!Number.isInteger(year) || year === 0 || year < YEAR_MIN || year > YEAR_MAX) continue;
    data.overrides[workId] = {
      year,
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
    };
  }
  return data;
}

function refreshYearOverridesIfChanged(source, userKey) {
  const key = `${source}:${userKey}`;
  const filePath = yearOverridesPath(source, userKey);
  const current = fingerprintOf(filePath);
  const cached = yearOverridesMemory.get(key);
  if (cached && cached.fingerprint === current) return false;
  if (current === null) {
    yearOverridesMemory.delete(key);
    return true;
  }
  const found = readJsonWithFingerprint(filePath);
  const data = sanitizeYearOverrides(found && found.data, source, userKey);
  yearOverridesMemory.set(key, { data, path: filePath, fingerprint: current });
  return true;
}

function getYearOverrides(source, userKey) {
  refreshYearOverridesIfChanged(source, userKey);
  const cached = yearOverridesMemory.get(`${source}:${userKey}`);
  return cached ? cached.data.overrides : {};
}

function enqueueYearOverridesWrite(task) {
  const run = yearOverridesSaving.then(task);
  yearOverridesSaving = run.catch(() => {});
  return run;
}

function setYearOverride(source, userKey, workId, year) {
  const key = String(workId == null ? '' : workId).trim();
  const value = Number(year);
  if (!key) return Promise.reject(new Error('workId is required'));
  if (!Number.isInteger(value) || value === 0 || value < YEAR_MIN || value > YEAR_MAX) {
    return Promise.reject(new Error(`year must be an integer in ${YEAR_MIN}..${YEAR_MAX}, not 0`));
  }
  return enqueueYearOverridesWrite(async () => {
    refreshYearOverridesIfChanged(source, userKey);
    const cached = yearOverridesMemory.get(`${source}:${userKey}`);
    const base = cached
      ? cached.data
      : { schemaVersion: 1, profile: { source, userKey }, overrides: {} };
    const entry = { year: value, updatedAt: new Date().toISOString() };
    const next = {
      ...base,
      overrides: { ...base.overrides, [key]: entry },
    };
    const fingerprint = await writeJsonAtomic(yearOverridesPath(source, userKey), next);
    yearOverridesMemory.set(`${source}:${userKey}`, {
      data: next,
      path: yearOverridesPath(source, userKey),
      fingerprint,
    });
    return entry;
  });
}

function clearYearOverride(source, userKey, workId) {
  const key = String(workId == null ? '' : workId).trim();
  if (!key) return Promise.reject(new Error('workId is required'));
  return enqueueYearOverridesWrite(async () => {
    refreshYearOverridesIfChanged(source, userKey);
    const cached = yearOverridesMemory.get(`${source}:${userKey}`);
    if (!cached || !Object.prototype.hasOwnProperty.call(cached.data.overrides, key)) return false;
    const overrides = { ...cached.data.overrides };
    delete overrides[key];
    const next = { ...cached.data, overrides };
    const fingerprint = await writeJsonAtomic(yearOverridesPath(source, userKey), next);
    yearOverridesMemory.set(`${source}:${userKey}`, {
      data: next,
      path: yearOverridesPath(source, userKey),
      fingerprint,
    });
    return true;
  });
}

let authorsMap = null;
let authorsMapFingerprint = null;

function emptyAuthorsMap() {
  return {
    schemaVersion: 2,
    fingerprint: null,
    canonical: {},
    manual: {},
    wikidata: { checkedAt: null, checked: {}, disabledUntil: null },
  };
}

function normalizeWikidataState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const checked =
    source.checked && typeof source.checked === 'object' && !Array.isArray(source.checked)
      ? { ...source.checked }
      : {};
  return {
    checkedAt: source.checkedAt == null ? null : String(source.checkedAt),
    checked,
    disabledUntil: source.disabledUntil == null ? null : String(source.disabledUntil),
  };
}

function refreshAuthorsMapIfChanged() {
  const current = fingerprintOf(AUTHORS_PATH);
  if (current === authorsMapFingerprint && authorsMap) return false;
  const found = current === null ? null : readJsonWithFingerprint(AUTHORS_PATH);
  if (!found || !found.data || typeof found.data !== 'object' || Array.isArray(found.data)) {
    authorsMap = emptyAuthorsMap();
    authorsMapFingerprint = current;
    return true;
  }
  const data = found.data;
  authorsMap = {
    schemaVersion: 2,
    fingerprint: data.fingerprint == null ? null : String(data.fingerprint),
    canonical:
      data.canonical && typeof data.canonical === 'object' && !Array.isArray(data.canonical)
        ? { ...data.canonical }
        : {},
    manual:
      data.manual && typeof data.manual === 'object' && !Array.isArray(data.manual)
        ? { ...data.manual }
        : {},
    wikidata: normalizeWikidataState(data.wikidata),
  };
  authorsMapFingerprint = found.fingerprint;
  return true;
}

function getAuthorsMap() {
  refreshAuthorsMapIfChanged();
  return {
    schemaVersion: 2,
    fingerprint: authorsMap.fingerprint,
    canonical: { ...authorsMap.canonical },
    manual: { ...authorsMap.manual },
    wikidata: normalizeWikidataState(authorsMap.wikidata),
  };
}

async function saveAuthorsMap(next = {}) {
  refreshAuthorsMapIfChanged();
  const storedWikidata = normalizeWikidataState(authorsMap.wikidata);
  const nextWikidata = normalizeWikidataState(
    next.wikidata === undefined ? storedWikidata : { ...storedWikidata, ...next.wikidata }
  );
  const merged = {
    schemaVersion: 2,
    fingerprint: next.fingerprint === undefined ? authorsMap.fingerprint : next.fingerprint,
    canonical: { ...authorsMap.canonical, ...(next.canonical || {}) },
    manual: next.manual === undefined
      ? { ...authorsMap.manual }
      : { ...authorsMap.manual, ...(next.manual || {}) },
    wikidata: {
      checkedAt: nextWikidata.checkedAt,
      checked: { ...storedWikidata.checked, ...nextWikidata.checked },
      disabledUntil: next.wikidata && next.wikidata.disabledUntil !== undefined
        ? nextWikidata.disabledUntil
        : storedWikidata.disabledUntil,
    },
  };
  const fingerprint = await writeJsonAtomic(AUTHORS_PATH, merged);
  authorsMap = merged;
  authorsMapFingerprint = fingerprint;
  return getAuthorsMap();
}

async function saveRawImport(source, userKey, payload) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(IMPORTS_DIR, `${safeKey(source)}-${safeKey(userKey)}-${stamp}.json`);
  await writeJsonAtomic(filePath, payload);
  return filePath;
}

function resolveStatePath(source, userKey) {
  return path.join(RESOLVE_STATE_DIR, `${safeKey(source)}-${safeKey(userKey)}.json`);
}

const resolveStateDocs = createDocCache({
  keyOf: (source, userKey) => `${source}:${userKey}`,
  pathOf: resolveStatePath,
  accept: (data) => Boolean(data) && typeof data === 'object',
});

function getResolveState(source, userKey) {
  return resolveStateDocs.get(source, userKey);
}

async function saveResolveState(source, userKey, data) {
  return resolveStateDocs.save(data, source, userKey);
}

function appendMatchLog(entry) {
  try {
    fs.mkdirSync(path.dirname(MATCH_LOG_PATH), { recursive: true });
    fs.appendFileSync(MATCH_LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    console.warn(`[book-cache] match-log append failed: ${err.message}`);
  }
}

function clearMemory() {
  profileDocs.clear();
  detailDocs.clear();
  linkDocs.clear();
  resolveStateDocs.clear();
  index = {};
  indexFingerprint = null;
  indexPending.clear();
  links = {};
  linksFingerprint = null;
  linksPending.clear();
  flags = {};
  flagsFingerprint = null;
  flagsSaving = Promise.resolve();
  authorsMap = null;
  authorsMapFingerprint = null;
  yearOverridesMemory.clear();
}

module.exports = {
  BOOK_CACHE_DIR,
  PROFILES_DIR,
  DETAILS_DIR,
  LINKS_DIR,
  INDEX_PATH,
  FLAGS_PATH,
  AUTHORS_PATH,
  fingerprintOf,
  readJsonWithFingerprint,
  writeJsonAtomic,
  safeKey,
  profilePath,
  getProfile,
  saveProfile,
  listProfiles,
  detailsPath,
  getDetails,
  hasDetails,
  saveDetails,
  detailsKeyForWork,
  getWorkDetails,
  linkPath,
  getLink,
  saveLink,
  refreshIndexIfChanged,
  getIndexEntry,
  setIndexValue,
  flushIndex,
  getWorkLink,
  setWorkLink,
  flushLinks,
  getMangaFlags,
  getMangaFlag,
  setMangaFlag,
  clearMangaFlag,
  getAuthorsMap,
  saveAuthorsMap,
  yearOverridesPath,
  getYearOverrides,
  setYearOverride,
  clearYearOverride,
  saveRawImport,
  getResolveState,
  saveResolveState,
  appendMatchLog,
  clearMemory,
};
