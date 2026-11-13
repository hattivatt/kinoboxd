'use strict';

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

function ensureEditions(profileKey, input = {}) {
  const existing = readEditions(profileKey);
  const signature = inputSignature(input.library, input.details, input.links);
  const manual = existing && existing.manual;
  const fresh =
    existing &&
    Number(existing.algorithmVersion) === ALGORITHM_VERSION &&
    existing.inputsFingerprint === signature &&
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
