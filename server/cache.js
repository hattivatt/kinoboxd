'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// KINOBOXD_CACHE_DIR lets tests / alternative deployments point the whole
// TMDB + KinoPoisk cache tree somewhere else. Defaults to app/cache so the
// normal launcher (and the Nix wrapper, which copies server/ next to cache/)
// keeps working unchanged.
const CACHE_DIR = process.env.KINOBOXD_CACHE_DIR
  ? path.resolve(process.env.KINOBOXD_CACHE_DIR)
  : path.join(__dirname, '..', 'cache');
const INDEX_PATH = path.join(CACHE_DIR, 'index.json');
const LB_LINKS_PATH = path.join(CACHE_DIR, 'lb-links.json');
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
/* Letterboxd links: tmdbId -> boxd.it URI (global, cross-export)      */
/* ------------------------------------------------------------------ */

/*
 * Letterboxd deep links cannot be derived from a TMDB id, but every
 * Letterboxd export CSV carries the film's own `https://boxd.it/...` URI.
 * Whenever an enriched Letterboxd upload yields both ids for a film we
 * remember the pair here, so KinoPoisk (or any other) imports can link the
 * same film without ever seeing a Letterboxd export. Letterboxd film pages
 * are public and per-film, so the pairing is account-independent.
 *
 * File shape (cache/lb-links.json):
 *   { "27205": { "lbUri": "https://boxd.it/1pXh", "kind": "movie" } }
 *
 * `kind` keeps TMDB movie/TV ids apart (they share one numeric namespace).
 * Bare string values are accepted when reading; they have no kind and are
 * therefore used for either media kind.
 *
 * Disambiguation: the FIRST learned URI wins. Two different Letterboxd
 * exports may reference the same film with different short links (a per-user
 * diary link vs the canonical one); both open the same film, so stability is
 * preferable to churn on every upload.
 */
let lbLinks = {};
try {
  const raw = fs.readFileSync(LB_LINKS_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) lbLinks = parsed;
} catch (err) {
  if (err.code !== 'ENOENT') {
    console.warn(`[cache] Could not read lb-links.json (${err.message}); starting empty.`);
  }
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

/**
 * Letterboxd page for a TMDB film, or null. `kind` is checked when both the
 * stored and the requested media kind are known.
 */
function getLbLink(tmdbId, kind) {
  const n = Number(tmdbId);
  if (!Number.isFinite(n) || n <= 0) return null;
  const entry = parseLbLink(lbLinks[String(n)]);
  if (!entry) return null;
  const expected = kind === 'tv' ? 'tv' : kind === 'movie' ? 'movie' : null;
  if (entry.kind && expected && entry.kind !== expected) return null;
  return entry.lbUri;
}

/**
 * Remember one TMDB <-> Letterboxd pair. Existing mappings are never
 * overwritten (see the disambiguation note above).
 * Returns true when a new pair was stored.
 */
function setLbLink(tmdbId, lbUri, kind) {
  const n = Number(tmdbId);
  if (!Number.isFinite(n) || n <= 0) return false;
  const uri = typeof lbUri === 'string' ? lbUri.trim() : '';
  if (!/^https?:\/\//i.test(uri)) return false;
  const key = String(n);
  if (Object.prototype.hasOwnProperty.call(lbLinks, key)) return false;
  lbLinks[key] = {
    lbUri: uri,
    kind: kind === 'tv' ? 'tv' : kind === 'movie' ? 'movie' : null,
  };
  persistLbLinks();
  return true;
}

/**
 * Harvest links from a finished enrichment job. Only films that carry both a
 * Letterboxd URI and a TMDB id can teach the mapping; KinoPoisk uploads have
 * no `lbUri` and are a no-op.
 * Returns { added, existing, candidates }.
 */
function learnLbLinks(films, jobFilms) {
  const result = { added: 0, existing: 0, candidates: 0 };
  if (!Array.isArray(films) || !jobFilms || typeof jobFilms.get !== 'function') return result;
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
  lbDirty = false;
  const tmp = `${LB_LINKS_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(lbLinks, null, 0), 'utf8');
  await fsp.rename(tmp, LB_LINKS_PATH);
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

/** Force a synchronous write (used at the end of enrichment). */
function flushLbLinks() {
  try {
    const tmp = `${LB_LINKS_PATH}.flush.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(lbLinks, null, 0), 'utf8');
    fs.renameSync(tmp, LB_LINKS_PATH);
    lbDirty = false;
  } catch (err) {
    console.error(`[cache] Failed to flush lb-links.json: ${err.message}`);
  }
}

function lbLinksStats() {
  return { keys: Object.keys(lbLinks).length };
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
