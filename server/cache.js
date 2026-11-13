'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_DIR = process.env.KINOBOXD_CACHE_DIR
  ? path.resolve(process.env.KINOBOXD_CACHE_DIR)
  : path.join(__dirname, '..', 'cache');
const INDEX_PATH = path.join(CACHE_DIR, 'index.json');
const LB_LINKS_PATH = path.join(CACHE_DIR, 'lb-links.json');
const DETAILS_DIR = path.join(CACHE_DIR, 'details');

fs.mkdirSync(DETAILS_DIR, { recursive: true });

const fsStore = require('./core/fs-store');
const { fingerprintOf } = fsStore;

function normalizeTitle(title) {
  return String(title == null ? '' : title)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function makeKey(title, year) {
  const y = Number.isFinite(Number(year)) && Number(year) > 0 ? Number(year) : '';
  return `${normalizeTitle(title)}|${y}`;
}

function makeKindKey(title, year, kind) {
  const key = makeKey(title, year);
  return kind === 'tv' ? `tv|${key}` : key;
}

let index = {};
let indexFingerprint = null;
const indexPending = new Map();

try {
  const raw = fs.readFileSync(INDEX_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) index = parsed;
  indexFingerprint = fingerprintOf(INDEX_PATH);
} catch (err) {
  indexFingerprint = fingerprintOf(INDEX_PATH);
  if (err.code !== 'ENOENT') {
    console.warn(`[cache] Could not read index.json (${err.message}); starting empty.`);
  }
}

function parseIndexEntry(value) {
  if (value === false) return false;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { id: value, kind: null };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = Number(value.id);
    if (Number.isFinite(id) && id > 0) {
      const kind = value.kind === 'tv' ? 'tv' : value.kind === 'movie' ? 'movie' : null;
      return { id, kind };
    }
  }
  return undefined;
}

function refreshIndexIfChanged() {
  const current = fingerprintOf(INDEX_PATH);
  if (current === indexFingerprint) return false;

  let disk = {};
  if (current !== null) {
    try {
      const raw = fs.readFileSync(INDEX_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not a JSON object');
      }
      disk = parsed;
    } catch (err) {
      indexFingerprint = current;
      console.warn(`[cache] Could not reload index.json (${err.message}); keeping in-memory index.`);
      return false;
    }
  }

  const merged = Object.assign({}, disk);
  for (const [key, value] of indexPending) merged[key] = value;
  index = merged;
  indexFingerprint = current;
  if (indexPending.size > 0) {
    dirty = true;
    persistIndex();
  } else {
    dirty = false;
  }
  return true;
}

function getIndexEntry(key) {
  refreshIndexIfChanged();
  if (!Object.prototype.hasOwnProperty.call(index, key)) return undefined;
  return parseIndexEntry(index[key]);
}

function getIndexValue(key) {
  const entry = getIndexEntry(key);
  if (entry === undefined || entry === false) return entry;
  return entry.id;
}

function hasKey(key) {
  refreshIndexIfChanged();
  return Object.prototype.hasOwnProperty.call(index, key);
}

let saveScheduled = false;
let saving = Promise.resolve();
let dirty = false;

async function writeIndexNow() {
  refreshIndexIfChanged();
  dirty = false;
  indexFingerprint = await fsStore.writeJsonAtomic(INDEX_PATH, index);
  for (const [key, value] of indexPending) {
    if (index[key] === value) indexPending.delete(key);
  }
}

function persistIndex() {
  dirty = true;
  if (saveScheduled) return;
  saveScheduled = true;
  setTimeout(() => {
    saveScheduled = false;
    saving = saving
      .then(() => {
        if (!dirty) return null;
        return writeIndexNow();
      })
      .catch((err) => {
        console.error(`[cache] Failed to save index.json: ${err.message}`);
      });
  }, 300);
}

function flushIndex() {
  try {
    refreshIndexIfChanged();
    indexFingerprint = fsStore.writeJsonAtomicSync(INDEX_PATH, index);
    dirty = false;
    indexPending.clear();
  } catch (err) {
    console.error(`[cache] Failed to flush index.json: ${err.message}`);
  }
}

function setIndexValue(key, value) {
  refreshIndexIfChanged();
  index[key] = value;
  indexPending.set(key, value);
  persistIndex();
}

let lbLinks = {};
let lbFingerprint = null;
const lbPending = new Map();
try {
  const raw = fs.readFileSync(LB_LINKS_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) lbLinks = parsed;
  lbFingerprint = fingerprintOf(LB_LINKS_PATH);
} catch (err) {
  lbFingerprint = fingerprintOf(LB_LINKS_PATH);
  if (err.code !== 'ENOENT') {
    console.warn(`[cache] Could not read lb-links.json (${err.message}); starting empty.`);
  }
}

function refreshLbLinksIfChanged() {
  const current = fingerprintOf(LB_LINKS_PATH);
  if (current === lbFingerprint) return false;

  let disk = {};
  if (current !== null) {
    try {
      const raw = fs.readFileSync(LB_LINKS_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not a JSON object');
      }
      disk = parsed;
    } catch (err) {
      lbFingerprint = current;
      console.warn(`[cache] Could not reload lb-links.json (${err.message}); keeping in-memory links.`);
      return false;
    }
  }

  const merged = Object.assign({}, disk);
  for (const [key, value] of lbPending) merged[key] = value;
  lbLinks = merged;
  lbFingerprint = current;
  if (lbPending.size > 0) {
    lbDirty = true;
    persistLbLinks();
  } else {
    lbDirty = false;
  }
  return true;
}

function parseLbLink(value) {
  if (typeof value === 'string') {
    const uri = value.trim();
    return /^https?:\/\//i.test(uri) ? { lbUri: uri, kind: null } : null;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const lbUri = typeof value.lbUri === 'string' ? value.lbUri.trim() : '';
    if (!/^https?:\/\//i.test(lbUri)) return null;
    const kind = value.kind === 'tv' ? 'tv' : value.kind === 'movie' ? 'movie' : null;
    return { lbUri, kind };
  }
  return null;
}

function getLbLink(tmdbId, kind) {
  const n = Number(tmdbId);
  if (!Number.isFinite(n) || n <= 0) return null;
  refreshLbLinksIfChanged();
  const entry = parseLbLink(lbLinks[String(n)]);
  if (!entry) return null;
  const expected = kind === 'tv' ? 'tv' : kind === 'movie' ? 'movie' : null;
  if (entry.kind && expected && entry.kind !== expected) return null;
  return entry.lbUri;
}

function setLbLink(tmdbId, lbUri, kind) {
  const n = Number(tmdbId);
  if (!Number.isFinite(n) || n <= 0) return false;
  const uri = typeof lbUri === 'string' ? lbUri.trim() : '';
  if (!/^https?:\/\//i.test(uri)) return false;
  refreshLbLinksIfChanged();
  const key = String(n);
  if (Object.prototype.hasOwnProperty.call(lbLinks, key)) return false;
  const value = {
    lbUri: uri,
    kind: kind === 'tv' ? 'tv' : kind === 'movie' ? 'movie' : null,
  };
  lbLinks[key] = value;
  lbPending.set(key, value);
  persistLbLinks();
  return true;
}

function learnLbLinks(films, jobFilms) {
  const result = { added: 0, existing: 0, candidates: 0 };
  if (!Array.isArray(films) || !jobFilms || typeof jobFilms.get !== 'function') return result;
  refreshLbLinksIfChanged();
  for (const film of films) {
    if (!film || !film.lbUri) continue;
    const entry = jobFilms.get(film.slug);
    if (!entry || entry.tmdbId == null) continue;
    result.candidates++;
    if (setLbLink(entry.tmdbId, film.lbUri, entry.kind)) result.added++;
    else result.existing++;
  }
  return result;
}

let lbSaveScheduled = false;
let lbSaving = Promise.resolve();
let lbDirty = false;

async function writeLbLinksNow() {
  refreshLbLinksIfChanged();
  lbDirty = false;
  lbFingerprint = await fsStore.writeJsonAtomic(LB_LINKS_PATH, lbLinks);
  for (const [key, value] of lbPending) {
    if (lbLinks[key] === value) lbPending.delete(key);
  }
}

function persistLbLinks() {
  lbDirty = true;
  if (lbSaveScheduled) return;
  lbSaveScheduled = true;
  setTimeout(() => {
    lbSaveScheduled = false;
    lbSaving = lbSaving
      .then(() => {
        if (!lbDirty) return null;
        return writeLbLinksNow();
      })
      .catch((err) => {
        console.error(`[cache] Failed to save lb-links.json: ${err.message}`);
      });
  }, 300);
}

function flushLbLinks() {
  try {
    refreshLbLinksIfChanged();
    lbFingerprint = fsStore.writeJsonAtomicSync(LB_LINKS_PATH, lbLinks);
    lbDirty = false;
    lbPending.clear();
  } catch (err) {
    console.error(`[cache] Failed to flush lb-links.json: ${err.message}`);
  }
}

function lbLinksStats() {
  refreshLbLinksIfChanged();
  return { keys: Object.keys(lbLinks).length };
}

const detailsMemory = new Map();

function detailsPath(id) {
  return path.join(DETAILS_DIR, `${id}.json`);
}

function tvCollisionPath(id) {
  return path.join(DETAILS_DIR, `tv-${id}.json`);
}

function readDetailsFile(filePath) {
  const found = fsStore.readJsonWithFingerprint(filePath, { label: 'cache-details' });
  if (!found) return null;
  const parsed = found.data;
  if (!parsed || !parsed.details || !parsed.credits) return null;
  return { data: parsed, fingerprint: found.fingerprint };
}

function findDetails(id, kind) {
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  const expected = kind === 'tv' ? 'tv' : kind === 'movie' ? 'movie' : null;

  const candidates = [detailsPath(n)];
  if (expected === 'tv') candidates.push(tvCollisionPath(n));

  for (const filePath of candidates) {
    const found = readDetailsFile(filePath);
    if (!found) continue;
    const dataKind = found.data.kind === 'tv' ? 'tv' : 'movie';
    if (expected && dataKind !== expected) continue;
    return { path: filePath, data: found.data, fingerprint: found.fingerprint };
  }
  return null;
}

function detailsMemoryKey(id, kind) {
  return `${kind === 'tv' ? 'tv' : kind === 'movie' ? 'movie' : 'any'}:${id}`;
}

function memoryDetailsIsFresh(entry) {
  if (!entry || !entry.fingerprint) return false;
  return fingerprintOf(entry.path) === entry.fingerprint;
}

function loadDetailsIntoMemory(memoryKey, n, kind) {
  const found = findDetails(n, kind);
  if (!found) {
    detailsMemory.delete(memoryKey);
    return null;
  }
  const entry = {
    data: found.data,
    path: found.path,
    fingerprint: found.fingerprint,
  };
  detailsMemory.set(memoryKey, entry);
  return entry;
}

function getDetails(id, kind) {
  if (id == null) return null;
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  const memoryKey = detailsMemoryKey(n, kind);
  const cached = detailsMemory.get(memoryKey);
  if (cached) {
    if (memoryDetailsIsFresh(cached)) return cached.data;
    detailsMemory.delete(memoryKey);
  }
  const entry = loadDetailsIntoMemory(memoryKey, n, kind);
  return entry ? entry.data : null;
}

function hasDetails(id, kind) {
  if (id == null) return false;
  const n = Number(id);
  if (!Number.isFinite(n)) return false;
  const memoryKey = detailsMemoryKey(n, kind);
  const cached = detailsMemory.get(memoryKey);
  if (cached) {
    if (memoryDetailsIsFresh(cached)) return true;
    detailsMemory.delete(memoryKey);
  }
  return loadDetailsIntoMemory(memoryKey, n, kind) !== null;
}

async function saveDetails(id, data) {
  const n = Number(id);
  const kind = data && data.kind === 'tv' ? 'tv' : 'movie';

  let target = detailsPath(n);
  if (kind === 'tv') {
    const existing = readDetailsFile(target);
    if (existing && existing.data.kind !== 'tv') {
      target = tvCollisionPath(n);
    }
  }

  const fingerprint = await fsStore.writeJsonAtomic(target, data);

  const entry = { data, path: target, fingerprint };
  detailsMemory.set(`${kind}:${n}`, entry);
  if (kind === 'movie') detailsMemory.set(`any:${n}`, entry);
}

function isFilmCached(title, year, kind) {
  const key = makeKindKey(title, year, kind);
  if (!hasKey(key)) return false;
  const entry = getIndexEntry(key);
  if (entry === false) return true;
  if (entry === undefined) return false;
  return hasDetails(entry.id, entry.kind || kind);
}

function cacheStats() {
  refreshIndexIfChanged();
  let ids = 0;
  let misses = 0;
  for (const value of Object.values(index)) {
    const entry = parseIndexEntry(value);
    if (entry === false) misses++;
    else if (entry) ids++;
  }
  return { keys: Object.keys(index).length, ids, misses };
}

module.exports = {
  CACHE_DIR,
  normalizeTitle,
  makeKey,
  makeKindKey,
  getIndexEntry,
  getIndexValue,
  hasKey,
  setIndexValue,
  refreshIndexIfChanged,
  refreshLbLinksIfChanged,
  getLbLink,
  setLbLink,
  learnLbLinks,
  flushLbLinks,
  lbLinksStats,
  getDetails,
  hasDetails,
  saveDetails,
  isFilmCached,
  flushIndex,
  cacheStats,
};
