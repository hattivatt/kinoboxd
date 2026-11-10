'use strict';

const path = require('path');

const gameCache = require('../game-cache');
const { normalizeSlug } = require('./identity');

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const LINKS_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'links');
const CACHE_PATH = path.join(LINKS_DIR, 'secondary.json');

function ttlMs() {
  const raw = Number(process.env.GAMES_SECONDARY_LINKS_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

function isSettledTitleEntry(entry) {
  if (!(entry && typeof entry === 'object' && entry.matchedBy === 'title')) return false;
  // A resolved match written before the genre pass (schema 3) has no `genres`
  // key at all. It is re-asked **once**, so a P136 genre line can arrive and
  // heal the detail; after that the key exists (even as `[]`) and the entry is
  // settled again. A miss (`qid: null`) has no facts to gain and stays settled.
  if (entry.qid && !Object.prototype.hasOwnProperty.call(entry, 'genres')) return false;
  return true;
}

function isSettledEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (!entry.qid) return true;
  return entry.releaseDateSource !== undefined;
}

function readCache() {
  const hit = gameCache.readJsonWithFingerprint(CACHE_PATH);
  return hit ? hit.data : null;
}

/** Cached bridge entries (fresh only unless `allowStale`), never a network call. */
function readSecondaryLinks({ allowStale = false } = {}) {
  const doc = readCache();
  if (!doc || !doc.entries || typeof doc.entries !== 'object') return {};
  if (!allowStale && !gameCache.isFresh(doc, ttlMs())) return {};
  return doc.entries;
}

/**
 * Title-matched identities live **next to** the store-slug entries, never
 * inside them: a unique exact-label match is honest evidence for a year, but
 * it is not a `P6278` identity. Keeping the maps separate means a title match
 * can never silently upgrade a work to `matchedBy: 'wikidata'`.
 */
function readSecondaryTitleLinks({ allowStale = false } = {}) {
  const doc = readCache();
  if (!doc || !doc.titleEntries || typeof doc.titleEntries !== 'object') return {};
  if (!allowStale && !gameCache.isFresh(doc, ttlMs())) return {};
  return doc.titleEntries;
}

/**
 * One cached entry (`{qid, appid, store, releaseYear, releasePrecision,
 * releaseDate, releaseDateSource}`) for a store slug — a cache read, never a
 * request. The key is the normalised slug, exactly like the writer.
 */
function readSecondaryLink(store, slug, options = {}) {
  const key = normalizeSlug(slug);
  const prefix = String(store == null ? '' : store).trim().toLowerCase();
  if (!key || !prefix) return null;
  const links = options.links && typeof options.links === 'object'
    ? options.links
    : readSecondaryLinks(options);
  return links[`${prefix}:${key}`] || null;
}

/** A title-matched entry (separate map, `matchedBy: 'title'`). */
function readSecondaryTitleLink(store, slug, options = {}) {
  const key = normalizeSlug(slug);
  const prefix = String(store == null ? '' : store).trim().toLowerCase();
  if (!key || !prefix) return null;
  const links = options.titleLinks && typeof options.titleLinks === 'object'
    ? options.titleLinks
    : readSecondaryTitleLinks(options);
  return links[`${prefix}:${key}`] || null;
}

function writeCache(entries, extra = {}) {
  // Title matches are a *separate* column: a write of slug entries must not
  // drop them, and the title pass must not drop the slug entries.
  const previous = readCache();
  const hasTitleEntries = Object.prototype.hasOwnProperty.call(extra, 'titleEntries');
  const titleEntries = hasTitleEntries
    ? extra.titleEntries
    : (previous && previous.titleEntries) || {};
  const rest = { ...extra };
  delete rest.titleEntries;
  const doc = {
    schemaVersion: 3,
    source: 'wikidata',
    fetchedAt: new Date().toISOString(),
    entries,
    titleEntries,
    ...rest,
  };
  try {
    gameCache.writeJsonAtomicSync(CACHE_PATH, doc);
  } catch (err) {
    /* a read-only cache (worktree) must not fail the import */
  }
  return doc;
}

/** A cached miss: the QID is unknown, so there is no date either. */
function emptyEntry(store, slug) {
  return {
    qid: null,
    appid: null,
    store,
    slug,
    releaseYear: null,
    releasePrecision: null,
    releaseDate: null,
    releaseDateSource: null,
  };
}

module.exports = {
  CACHE_PATH,
  ttlMs,
  isSettledTitleEntry,
  isSettledEntry,
  readCache,
  readSecondaryLinks,
  readSecondaryTitleLinks,
  readSecondaryLink,
  readSecondaryTitleLink,
  writeCache,
  emptyEntry,
};
