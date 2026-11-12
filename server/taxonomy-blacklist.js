'use strict';

/**
 * Per-film blacklist of the film taxonomy: the local lever against false
 * positives of rules that are global by design (see `taxonomy.js`).
 *
 * A rule matches a TMDB keyword or a Wikidata genre for the whole corpus, so
 * one noisy tag widens the bucket for every film. This file removes a category
 * or a period from ONE slug and leaves every other film — and the rule — alone.
 *
 * Path: `<films cache>/flags/taxonomy-blacklist.json` (KINOBOXD_CACHE_DIR).
 * Shape: { "version": 1, "films": { "<slug>": ["zombie", "kaiju"] } }
 * Tolerance: missing file, empty file, broken JSON or a wrong shape all mean
 * "no blacklist"; an unknown key (a typo) removes nothing and is reported in
 * `ignored`, so a mistyped entry cannot silently look applied.
 */

const path = require('path');

const { CACHE_DIR } = require('./cache');
const fsStore = require('./core/fs-store');
const { CATEGORY_DEFS, PERIOD_DEFS } = require('./taxonomy-defs');

/* ------------------------------------------------------------------ */
/* Per-film blacklist                                                  */
/* ------------------------------------------------------------------ */

/*
 * A rule is global by design: one TMDB keyword or one Wikidata genre widens a
 * bucket for the whole corpus. False positives are therefore unfixable without
 * losing true positives — the only lever was editing the rule itself. This file
 * is the local lever: it removes a category or a period from ONE slug and
 * leaves every other film, and the rule, untouched.
 *
 * Shape: { "version": 1, "films": { "<slug>": ["zombie", "kaiju"] } }
 * Tolerance: missing file, empty file, broken JSON or a wrong shape all mean
 * "no blacklist"; an unknown key (a typo) removes nothing and is reported in
 * `ignored` so a mistyped entry cannot silently look applied.
 */
const BLACKLIST_PATH = path.join(CACHE_DIR, 'flags', 'taxonomy-blacklist.json');
const BLACKLIST_VERSION = 1;

function blacklistVocabulary() {
  const keys = new Set();
  for (const def of CATEGORY_DEFS) keys.add(def.key);
  for (const def of PERIOD_DEFS) keys.add(def.key);
  return keys;
}

/**
 * Normalize a blacklist document into lookup form. Never throws: anything that
 * is not `{ films: { slug: [key, ...] } }` yields an empty blacklist.
 *
 * @param {any} doc parsed document (or a value from `options.blacklist`)
 * @returns {{bySlug: Map<string, Set<string>>, keys: string[], ignored: string[]}}
 *          `keys` — valid keys actually present in the document,
 *          `ignored` — keys that are not in CATEGORY_DEFS/PERIOD_DEFS.
 */
function normalizeBlacklist(doc) {
  const vocabulary = blacklistVocabulary();
  const bySlug = new Map();
  const used = new Set();
  const ignored = new Set();
  // A version newer than this code understands is not interpreted: an empty
  // blacklist is the safe degradation (the rules simply run unfiltered).
  if (doc && typeof doc === 'object' && Number(doc.version) > BLACKLIST_VERSION) {
    console.warn(
      `[taxonomy-blacklist] unsupported version ${doc.version} in ${BLACKLIST_PATH}, ignored`
    );
    return { bySlug, keys: [], ignored: [] };
  }
  const films =
    doc && typeof doc === 'object' && doc.films && typeof doc.films === 'object'
      ? doc.films
      : null;
  if (films && !Array.isArray(films)) {
    for (const [slug, value] of Object.entries(films)) {
      if (typeof slug !== 'string' || !slug.trim()) continue;
      if (!Array.isArray(value)) continue;
      const keys = new Set();
      for (const entry of value) {
        if (typeof entry !== 'string') continue;
        const key = entry.trim();
        if (!key) continue;
        if (!vocabulary.has(key)) {
          ignored.add(key);
          continue;
        }
        keys.add(key);
        used.add(key);
      }
      if (keys.size > 0) bySlug.set(slug, keys);
    }
  }
  return { bySlug, keys: [...used].sort(), ignored: [...ignored].sort() };
}

/**
 * Read the per-film blacklist from the films cache. Missing or corrupt file
 * means "nothing is blacklisted" (fs-store warns once on corrupt JSON).
 */
function readBlacklist(filePath = BLACKLIST_PATH) {
  return normalizeBlacklist(fsStore.readJson(filePath, { label: 'taxonomy-blacklist' }));
}

/** Accept either a raw document or an already normalized blacklist. */
function resolveBlacklist(value) {
  if (!value) return { bySlug: new Map(), keys: [], ignored: [] };
  if (value.bySlug instanceof Map) return value;
  return normalizeBlacklist(value);
}

module.exports = {
  BLACKLIST_PATH,
  BLACKLIST_VERSION,
  blacklistVocabulary,
  normalizeBlacklist,
  readBlacklist,
  resolveBlacklist,
};
