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

function readSecondaryLinks({ allowStale = false } = {}) {
  const doc = readCache();
  if (!doc || !doc.entries || typeof doc.entries !== 'object') return {};
  if (!allowStale && !gameCache.isFresh(doc, ttlMs())) return {};
  return doc.entries;
}

function readSecondaryTitleLinks({ allowStale = false } = {}) {
  const doc = readCache();
  if (!doc || !doc.titleEntries || typeof doc.titleEntries !== 'object') return {};
  if (!allowStale && !gameCache.isFresh(doc, ttlMs())) return {};
  return doc.titleEntries;
}

function readSecondaryLink(store, slug, options = {}) {
  const key = normalizeSlug(slug);
  const prefix = String(store == null ? '' : store).trim().toLowerCase();
  if (!key || !prefix) return null;
  const links = options.links && typeof options.links === 'object'
    ? options.links
    : readSecondaryLinks(options);
  return links[`${prefix}:${key}`] || null;
}

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
  }
  return doc;
}

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
