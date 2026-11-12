'use strict';

/**
 * Persistence of the canonical edition index (`cache-games/editions.json`).
 *
 * One document, `profiles` keyed by `steam-<steamid64>` (the same shape idea as
 * `links/`). The stored entry carries the input fingerprint (library
 * fingerprint + details/links watermarks) and `manual.merges` / `manual.splits`,
 * which survive every rebuild.
 */

const path = require('path');

const gameCache = require('../game-cache');
const {
  ALGORITHM_VERSION,
  buildEditionIndex,
  inputSignature,
  manualSignature,
  covers,
} = require('./index-build');

const EDITIONS_PATH = path.join(gameCache.GAMES_CACHE_DIR, 'editions.json');

/* ------------------------------------------------------------------ */
/* Persistence (`cache-games/editions.json`, profiles keyed)            */
/* ------------------------------------------------------------------ */

function readEditionsFile() {
  const hit = gameCache.readJsonWithFingerprint(EDITIONS_PATH);
  if (!hit || !hit.data || typeof hit.data !== 'object') {
    return { schemaVersion: 1, profiles: {} };
  }
  return {
    schemaVersion: Number(hit.data.schemaVersion) || 1,
    profiles:
      hit.data.profiles && typeof hit.data.profiles === 'object' ? hit.data.profiles : {},
  };
}

function readEditions(profileKey) {
  const file = readEditionsFile();
  const doc = file.profiles[String(profileKey)];
  return doc && typeof doc === 'object' ? doc : null;
}

function saveEditions(profileKey, doc) {
  const file = readEditionsFile();
  file.profiles[String(profileKey)] = doc;
  file.schemaVersion = 1;
  gameCache.writeJsonAtomicSync(EDITIONS_PATH, file);
  return doc;
}

/**
 * Read the persisted index, or rebuild+persist it when the inputs moved.
 * Manual overrides survive the rebuild. Returns the document (never null).
 */
function ensureEditions(profileKey, input = {}) {
  const existing = readEditions(profileKey);
  const signature = inputSignature(input.library, input.details, input.links);
  const manual = existing && existing.manual;
  const fresh =
    existing &&
    Number(existing.algorithmVersion) === ALGORITHM_VERSION &&
    existing.inputsFingerprint === signature &&
    // A hand-edited `manual.merges`/`splits` is an input too (audit §4.4d).
    existing.manualFingerprint === manualSignature(manual) &&
    covers(existing, input.games);
  if (fresh) return { doc: existing, rebuilt: false };
  const built = buildEditionIndex({
    games: input.games,
    details: input.details,
    links: input.links,
    manual,
    profileKey,
    libraryFingerprint: input.library && input.library.fingerprint,
    inputsFingerprint: signature,
  });
  saveEditions(profileKey, built);
  return { doc: built, rebuilt: true };
}

module.exports = {
  EDITIONS_PATH,
  readEditionsFile,
  readEditions,
  saveEditions,
  ensureEditions,
};
