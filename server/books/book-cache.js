'use strict';

/**
 * Book cache (namespace: cache-book/).
 *
 * Mirrors the film cache invariants (server/cache.js):
 *   - everything lives on disk, memory entries carry the file fingerprint
 *     (`mtimeNs:size:ino`) and are revalidated with one stat() per read, so an
 *     external backfill/import process is visible to a running server without
 *     a restart;
 *   - every write is atomic (tmp + rename);
 *   - every JSON file carries `schemaVersion`.
 *
 * Layout (see КНИГИ-АРХИТЕКТУРА.md §3.2):
 *
 *   cache-book/
 *     profiles/{source}-{userKey}.json   reading events of one source
 *     details/{hcWorkId}.json            canonical work metadata
 *     links/{livelibBookId}.json         livelib -> hardcover resolve result
 *     index.json                         matching keys -> workId | false
 *     links.json                         workId -> per-site links
 *     flags/book-flags.json              workId -> manual manga/comics override
 *     match-log.jsonl                    audit of broad matches (append-only)
 *     imports/{source}-{userKey}-{ts}.json  raw import payload (debug)
 *
 * The root can be moved with KINOBOXD_CACHE_BOOK_DIR; by default it is
 * `app/cache-book`, a sibling of the film cache, so the two namespaces never
 * mix.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const BOOK_CACHE_DIR = process.env.KINOBOXD_CACHE_BOOK_DIR
  ? path.resolve(process.env.KINOBOXD_CACHE_BOOK_DIR)
  : path.join(__dirname, '..', '..', 'cache-book');

const PROFILES_DIR = path.join(BOOK_CACHE_DIR, 'profiles');
const DETAILS_DIR = path.join(BOOK_CACHE_DIR, 'details');
const LINKS_DIR = path.join(BOOK_CACHE_DIR, 'links');
const IMPORTS_DIR = path.join(BOOK_CACHE_DIR, 'imports');
const FLAGS_DIR = path.join(BOOK_CACHE_DIR, 'flags');
const INDEX_PATH = path.join(BOOK_CACHE_DIR, 'index.json');
const LINKS_JSON_PATH = path.join(BOOK_CACHE_DIR, 'links.json');
const FLAGS_PATH = path.join(FLAGS_DIR, 'book-flags.json');
const MATCH_LOG_PATH = path.join(BOOK_CACHE_DIR, 'match-log.jsonl');
const AUTHORS_PATH = path.join(BOOK_CACHE_DIR, 'authors.json');

for (const dir of [PROFILES_DIR, DETAILS_DIR, LINKS_DIR, IMPORTS_DIR, FLAGS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

/* ------------------------------------------------------------------ */
/* Freshness + atomic writes                                           */
/* ------------------------------------------------------------------ */

/** Same identity as server/cache.js: inode + size + mtime(ns); null when absent. */
function fingerprintOf(filePath) {
  try {
    const st = fs.statSync(filePath, { bigint: true });
    return `${st.mtimeNs}:${st.size}:${st.ino}`;
  } catch (err) {
    return null;
  }
}

/**
 * Read + parse one JSON file together with the fingerprint of the exact bytes
 * that were parsed. A writer replacing the file mid-read makes the fingerprints
 * differ; retry once so data and fingerprint always describe the same version.
 * Returns { data, fingerprint } or null for missing/corrupt files.
 */
function readJsonWithFingerprint(filePath) {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = fingerprintOf(filePath);
      if (before === null) return null;
      const raw = fs.readFileSync(filePath, 'utf8');
      const after = fingerprintOf(filePath);
      if (after === null) return null;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        console.warn(`[book-cache] corrupt JSON in ${filePath}: ${err.message}`);
        return null;
      }
      if (after === before) return { data: parsed, fingerprint: after };
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function writeJsonAtomic(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fsp.rename(tmp, filePath);
  return fingerprintOf(filePath);
}

function writeJsonAtomicSync(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.flush.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, filePath);
  return fingerprintOf(filePath);
}

/** Make an arbitrary user key safe for a file name (no path traversal). */
function safeKey(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/[^\w.-]/g, '_')
    .slice(0, 120);
}

/* ------------------------------------------------------------------ */
/* Profiles: one file per (source, userKey)                            */
/* ------------------------------------------------------------------ */

const profileMemory = new Map(); // "source:userKey" -> { data, path, fingerprint }

function profilePath(source, userKey) {
  return path.join(PROFILES_DIR, `${safeKey(source)}-${safeKey(userKey)}.json`);
}

function profileMemoryKey(source, userKey) {
  return `${source}:${userKey}`;
}

/**
 * Cached reading profile of one source. Returns the parsed document or null.
 * The memory entry is only trusted while its fingerprint still matches.
 */
function getProfile(source, userKey) {
  const filePath = profilePath(source, userKey);
  const memoryKey = profileMemoryKey(source, userKey);
  const cached = profileMemory.get(memoryKey);
  if (cached && fingerprintOf(cached.path) === cached.fingerprint) {
    return cached.data;
  }
  if (cached) profileMemory.delete(memoryKey);
  const found = readJsonWithFingerprint(filePath);
  if (!found) return null;
  profileMemory.set(memoryKey, { data: found.data, path: filePath, fingerprint: found.fingerprint });
  return found.data;
}

async function saveProfile(source, userKey, data) {
  const filePath = profilePath(source, userKey);
  const fingerprint = await writeJsonAtomic(filePath, data);
  profileMemory.set(profileMemoryKey(source, userKey), { data, path: filePath, fingerprint });
  return filePath;
}

/** All cached profiles, tolerant to individual broken files. */
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
    // Persisted profiles written before `statusId` was recorded cannot be
    // re-filtered by the raw journal key; flag them for a Hardcover re-import.
    const missingStatusId =
      data.source === 'hardcover'
        ? events.filter((event) => event && event.statusId == null).length
        : 0;
    result.push({
      source: data.source,
      userKey: data.userKey,
      // Acquisition path of the document: `livelib` (scrape) or
      // `livelib-file` (livelib-backup export). Same profile key either way.
      origin: data.origin || data.source,
      sourceUserId: data.sourceUserId == null ? null : data.sourceUserId,
      importedAt: data.importedAt || null,
      eventCount: events.length,
      finishedCount: events.filter((event) => event && event.finishedAt).length,
      // Per-shelf counts of a file import (read/dnf/reading/wish).
      shelves: data.shelves || null,
      fileImports: Array.isArray(data.fileImports) ? data.fileImports.length : 0,
      missingStatusId,
      needsReimport: data.source === 'hardcover' && missingStatusId > 0,
      status: 'ok',
    });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Details: cache-book/details/{hcWorkId}.json                         */
/* ------------------------------------------------------------------ */

const detailsMemory = new Map(); // "123" -> { data, path, fingerprint }

function detailsPath(hcWorkId) {
  return path.join(DETAILS_DIR, `${safeKey(hcWorkId)}.json`);
}

/**
 * File-key for a work id: Hardcover keeps the legacy bare numeric key
 * (`details/100.json`), other providers use the prefixed id (`gb-...`,
 * `ol-...`, `ll-...`) so a LiveLib card enrichment never overwrites the
 * canonical Hardcover document.
 */
function detailsKeyForWork(workId) {
  const value = String(workId == null ? '' : workId);
  const hc = /^hc:(\d+)$/.exec(value);
  if (hc) return hc[1];
  return safeKey(value.replace(':', '-'));
}

function getWorkDetails(workId) {
  return getDetails(detailsKeyForWork(workId));
}

function getDetails(hcWorkId) {
  const key = String(hcWorkId);
  const filePath = detailsPath(key);
  const cached = detailsMemory.get(key);
  if (cached && fingerprintOf(cached.path) === cached.fingerprint) return cached.data;
  if (cached) detailsMemory.delete(key);
  const found = readJsonWithFingerprint(filePath);
  if (!found) return null;
  detailsMemory.set(key, { data: found.data, path: filePath, fingerprint: found.fingerprint });
  return found.data;
}

function hasDetails(hcWorkId) {
  return getDetails(hcWorkId) !== null;
}

async function saveDetails(hcWorkId, data) {
  const filePath = detailsPath(hcWorkId);
  const fingerprint = await writeJsonAtomic(filePath, data);
  detailsMemory.set(String(hcWorkId), { data, path: filePath, fingerprint });
  return filePath;
}

/* ------------------------------------------------------------------ */
/* Cross-source links: cache-book/links/{livelibBookId}.json           */
/* ------------------------------------------------------------------ */

const linkMemory = new Map(); // livelibBookId -> { data, path, fingerprint }

function linkPath(livelibBookId) {
  return path.join(LINKS_DIR, `${safeKey(livelibBookId)}.json`);
}

function getLink(livelibBookId) {
  const key = String(livelibBookId);
  const filePath = linkPath(key);
  const cached = linkMemory.get(key);
  if (cached && fingerprintOf(cached.path) === cached.fingerprint) return cached.data;
  if (cached) linkMemory.delete(key);
  const found = readJsonWithFingerprint(filePath);
  if (!found) return null;
  linkMemory.set(key, { data: found.data, path: filePath, fingerprint: found.fingerprint });
  return found.data;
}

async function saveLink(livelibBookId, data) {
  const filePath = linkPath(livelibBookId);
  const fingerprint = await writeJsonAtomic(filePath, data);
  linkMemory.set(String(livelibBookId), { data, path: filePath, fingerprint });
  return filePath;
}

/* ------------------------------------------------------------------ */
/* index.json: matching keys -> hcWorkId (number) | false              */
/* ------------------------------------------------------------------ */

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

/**
 * Reload index.json when another process replaced it. Locally pending writes
 * win over the loaded file, other disk keys are kept.
 */
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
  const tmp = `${INDEX_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(index), 'utf8');
  await fsp.rename(tmp, INDEX_PATH);
  indexFingerprint = fingerprintOf(INDEX_PATH);
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

/** Force a synchronous flush (end of import / tests). */
function flushIndex() {
  try {
    refreshIndexIfChanged();
    const tmp = `${INDEX_PATH}.${process.pid}.flush.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index), 'utf8');
    fs.renameSync(tmp, INDEX_PATH);
    indexFingerprint = fingerprintOf(INDEX_PATH);
    indexPending.clear();
  } catch (err) {
    console.error(`[book-cache] Failed to flush index.json: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* links.json: workId -> per-site links                                */
/* ------------------------------------------------------------------ */

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
          const tmp = `${LINKS_JSON_PATH}.${process.pid}.${Date.now()}.tmp`;
          return fsp
            .writeFile(tmp, JSON.stringify(links), 'utf8')
            .then(() => fsp.rename(tmp, LINKS_JSON_PATH))
            .then(() => {
              linksFingerprint = fingerprintOf(LINKS_JSON_PATH);
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
    writeJsonAtomicSync(LINKS_JSON_PATH, links);
    linksFingerprint = fingerprintOf(LINKS_JSON_PATH);
    linksPending.clear();
  } catch (err) {
    console.error(`[book-cache] Failed to flush links.json: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* flags/book-flags.json: manual manga/comics override per workId       */
/* ------------------------------------------------------------------ */

/*
 * Flat document, one key per work:
 *   { "hc:123": { "mangaComics": true, "updatedAt": "2026-10-27T…" },
 *     "hc:456": { "mangaComics": false, "updatedAt": "…" } }
 *
 * The file is the user's decision, not provider metadata: the stats builder
 * applies it after provider detection and series propagation, and it wins even
 * against an explicit `true` (true -> false is a valid "show again" override).
 * Same freshness contract as links.json: one stat() per read, an external edit
 * is visible without a restart, writes are atomic and serialised per process.
 */

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

/** Reload the file when another process replaced it. */
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

/** Whole override map (live copy; callers must not mutate). */
function getMangaFlags() {
  refreshFlagsIfChanged();
  return flags;
}

/** One override entry or null. */
function getMangaFlag(workId) {
  refreshFlagsIfChanged();
  const key = String(workId == null ? '' : workId);
  return Object.prototype.hasOwnProperty.call(flags, key) ? flags[key] : null;
}

/** Serialise writes so two concurrent toggles cannot lose each other. */
function enqueueFlagsWrite(task) {
  const run = flagsSaving.then(task);
  flagsSaving = run.catch(() => {});
  return run;
}

/** Upsert `{ mangaComics: boolean, updatedAt }` for one work. */
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

/** Remove an override (idempotent); resolves to true when something changed. */
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

/* ------------------------------------------------------------------ */
/* Author alias table: cache-book/authors.json                         */
/* ------------------------------------------------------------------ */

/**
 * Durable author merge table. A false merge is expensive (two people become
 * one), a missed merge is cheap (two rows until the next resolve), so the file
 * is the place where a manual decision lives forever:
 *
 *   {
 *     schemaVersion: 2,
 *     fingerprint: "агата кристи|...",     // corpus that produced `canonical`
 *     canonical: { "нормализованное имя": "Отображаемое имя" },
 *     manual:    { "нормализованное имя": "Отображаемое имя" },
 *     wikidata: {
 *       checkedAt: "2026-10-28T…",         // last successful Wikidata pass
 *       checked: { "нормализованное имя": true },  // already asked from WDQS
 *       disabledUntil: null                // cooldown after 429/403/network
 *     }
 *   }
 *
 * `canonical` is applied on every stats build; `manual` is never overwritten
 * by an automatic rebuild. `wikidata.checked` is what makes the Wikidata bridge
 * default-on without hammering WDQS: a name is asked once, and a repeat stats
 * build with a full map issues zero requests.
 */
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

/**
 * Persist the table. `canonical` is merged over the stored one (an older
 * profile's aliases stay valid); `manual` is preserved unless passed
 * explicitly. `wikidata.checked` is unioned (a name asked once is never asked
 * again); `disabledUntil` is only written when passed. Resolves to the map that
 * is now effective.
 */
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
      // A cooldown is sticky until a later successful pass clears it: passing
      // `wikidata.disabledUntil = null` explicitly is the clear.
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

/* ------------------------------------------------------------------ */
/* Import snapshots + match audit log                                  */
/* ------------------------------------------------------------------ */

async function saveRawImport(source, userKey, payload) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(IMPORTS_DIR, `${safeKey(source)}-${safeKey(userKey)}-${stamp}.json`);
  await writeJsonAtomic(filePath, payload);
  return filePath;
}

/** Append one broad-match audit record. Never throws into the job. */
function appendMatchLog(entry) {
  try {
    fs.mkdirSync(path.dirname(MATCH_LOG_PATH), { recursive: true });
    fs.appendFileSync(MATCH_LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    console.warn(`[book-cache] match-log append failed: ${err.message}`);
  }
}

/** Drop all memory caches (tests). Disk files are untouched. */
function clearMemory() {
  profileMemory.clear();
  detailsMemory.clear();
  linkMemory.clear();
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
}

module.exports = {
  BOOK_CACHE_DIR,
  PROFILES_DIR,
  DETAILS_DIR,
  LINKS_DIR,
  IMPORTS_DIR,
  INDEX_PATH,
  LINKS_JSON_PATH,
  MATCH_LOG_PATH,
  FLAGS_DIR,
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
  refreshFlagsIfChanged,
  getMangaFlags,
  getMangaFlag,
  setMangaFlag,
  clearMangaFlag,
  getAuthorsMap,
  saveAuthorsMap,
  saveRawImport,
  appendMatchLog,
  clearMemory,
};
