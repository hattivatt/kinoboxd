'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const INDEX_PATH = path.join(CACHE_DIR, 'index.json');
const DETAILS_DIR = path.join(CACHE_DIR, 'details');

fs.mkdirSync(DETAILS_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* Index: "normalized title|year" -> tmdbId (number) or false          */
/* ------------------------------------------------------------------ */

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

/**
 * Index key for a specific media kind. Movies keep the original unscoped
 * key so KinoPoisk entries can hit the existing Letterboxd cache; TV gets a
 * "tv|" prefix because TMDB movie and TV ids live in separate namespaces
 * and the same title/year can legitimately exist as both (e.g. a
 * making-of movie and the series itself).
 */
function makeKindKey(title, year, kind) {
  const key = makeKey(title, year);
  return kind === 'tv' ? `tv|${key}` : key;
}

let index = {};
try {
  const raw = fs.readFileSync(INDEX_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) index = parsed;
} catch (err) {
  if (err.code !== 'ENOENT') {
    console.warn(`[cache] Could not read index.json (${err.message}); starting empty.`);
  }
}

/**
 * Parse one index value. Returns:
 *   undefined                    -> key absent / unusable value
 *   false                        -> definitively unmatched
 *   { id, kind: 'movie'|'tv'|null }
 *
 * Historically values are bare TMDB ids; a manual match stores
 * `{ id, kind }` so a TV series can be attached to a Letterboxd entry that
 * was originally searched as a movie.
 */
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

function getIndexEntry(key) {
  if (!Object.prototype.hasOwnProperty.call(index, key)) return undefined;
  return parseIndexEntry(index[key]);
}

// Backwards-compatible accessor: id, false or undefined.
function getIndexValue(key) {
  const entry = getIndexEntry(key);
  if (entry === undefined || entry === false) return entry;
  return entry.id;
}

function hasKey(key) {
  return Object.prototype.hasOwnProperty.call(index, key);
}

/* ------------------------------ saving ---------------------------- */

let saveScheduled = false;
let saving = Promise.resolve();
let dirty = false;

async function writeIndexNow() {
  dirty = false;
  const tmp = `${INDEX_PATH}.${process.pid}.${Date.now()}.tmp`;
  const data = JSON.stringify(index, null, 0);
  await fsp.writeFile(tmp, data, 'utf8');
  await fsp.rename(tmp, INDEX_PATH);
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
  // Force a final synchronous write; used at the end of enrichment so that
  // results are on disk even if the process exits right after.
  try {
    const tmp = `${INDEX_PATH}.flush.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index, null, 0), 'utf8');
    fs.renameSync(tmp, INDEX_PATH);
    dirty = false;
  } catch (err) {
    console.error(`[cache] Failed to flush index.json: ${err.message}`);
  }
}

function setIndexValue(key, value) {
  index[key] = value;
  persistIndex();
}

/* ------------------------------------------------------------------ */
/* Details: cache/details/{tmdbId}.json -> { kind, details, credits }   */
/* ------------------------------------------------------------------ */

const detailsMemory = new Map();

function detailsPath(id) {
  return path.join(DETAILS_DIR, `${id}.json`);
}

function tvCollisionPath(id) {
  return path.join(DETAILS_DIR, `tv-${id}.json`);
}

function readDetailsFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.details || !parsed.credits) return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

/**
 * Find cached details. Movie and TV ids come from separate TMDB namespaces,
 * so a numeric id can theoretically belong to both; TV data that would
 * overwrite an existing movie file is stored as tv-{id}.json instead.
 * Old cache entries have no `kind` and are treated as movies.
 */
function findDetails(id, kind) {
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  const expected = kind === 'tv' ? 'tv' : kind === 'movie' ? 'movie' : null;

  const candidates = [detailsPath(n)];
  if (expected === 'tv') candidates.push(tvCollisionPath(n));

  for (const filePath of candidates) {
    const data = readDetailsFile(filePath);
    if (!data) continue;
    const dataKind = data.kind === 'tv' ? 'tv' : 'movie';
    if (expected && dataKind !== expected) continue;
    return { path: filePath, data };
  }
  return null;
}

function getDetails(id, kind) {
  if (id == null) return null;
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  const memoryKey = `${kind === 'tv' ? 'tv' : kind === 'movie' ? 'movie' : 'any'}:${n}`;
  if (detailsMemory.has(memoryKey)) return detailsMemory.get(memoryKey);
  const found = findDetails(n, kind);
  if (!found) return null;
  detailsMemory.set(memoryKey, found.data);
  return found.data;
}

function hasDetails(id, kind) {
  if (id == null) return false;
  const n = Number(id);
  if (!Number.isFinite(n)) return false;
  const memoryKey = `${kind === 'tv' ? 'tv' : kind === 'movie' ? 'movie' : 'any'}:${n}`;
  if (detailsMemory.has(memoryKey)) return true;
  return findDetails(n, kind) !== null;
}

async function saveDetails(id, data) {
  const n = Number(id);
  const kind = data && data.kind === 'tv' ? 'tv' : 'movie';

  let target = detailsPath(n);
  if (kind === 'tv') {
    // Never overwrite a movie that happens to share the numeric id.
    const existing = readDetailsFile(target);
    if (existing && existing.kind !== 'tv') {
      target = tvCollisionPath(n);
    }
  }

  detailsMemory.set(`${kind}:${n}`, data);
  if (kind === 'movie') detailsMemory.set(`any:${n}`, data);
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fsp.rename(tmp, target);
}

/**
 * Is the film already fully resolved by the cache?
 * false-entry => yes (known unmatched), id + matching details => yes.
 */
function isFilmCached(title, year, kind) {
  const key = makeKindKey(title, year, kind);
  if (!hasKey(key)) return false;
  const entry = getIndexEntry(key);
  if (entry === false) return true;
  if (entry === undefined) return false;
  // A manual match may point at the other media kind.
  return hasDetails(entry.id, entry.kind || kind);
}

function cacheStats() {
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
  getDetails,
  hasDetails,
  saveDetails,
  isFilmCached,
  flushIndex,
  cacheStats,
};
