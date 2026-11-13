'use strict';

const path = require('path');

const { CACHE_DIR } = require('./cache');
const fsStore = require('./core/fs-store');
const { CATEGORY_DEFS, PERIOD_DEFS } = require('./taxonomy-defs');

const BLACKLIST_PATH = path.join(CACHE_DIR, 'flags', 'taxonomy-blacklist.json');
const BLACKLIST_VERSION = 1;

function blacklistVocabulary() {
  const keys = new Set();
  for (const def of CATEGORY_DEFS) keys.add(def.key);
  for (const def of PERIOD_DEFS) keys.add(def.key);
  return keys;
}

function normalizeBlacklist(doc) {
  const vocabulary = blacklistVocabulary();
  const bySlug = new Map();
  const used = new Set();
  const ignored = new Set();
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

function readBlacklist(filePath = BLACKLIST_PATH) {
  return normalizeBlacklist(fsStore.readJson(filePath, { label: 'taxonomy-blacklist' }));
}

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
