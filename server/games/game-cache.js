'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const GAMES_CACHE_DIR = process.env.KINOBOXD_CACHE_GAMES_DIR
  ? path.resolve(process.env.KINOBOXD_CACHE_GAMES_DIR)
  : path.join(__dirname, '..', '..', 'cache-games');

const STATE_DIR = process.env.KINOBOXD_STATE_DIR
  ? path.join(path.resolve(process.env.KINOBOXD_STATE_DIR), 'games')
  : path.join(GAMES_CACHE_DIR, 'state');

const PROFILES_DIR = path.join(GAMES_CACHE_DIR, 'profiles');
const LIBRARY_DIR = path.join(GAMES_CACHE_DIR, 'library');
const DETAILS_DIR = path.join(GAMES_CACHE_DIR, 'details');
const DETAILS_BASE_DIR = path.join(GAMES_CACHE_DIR, 'details-base');
const SPY_DIR = path.join(GAMES_CACHE_DIR, 'spy');
const REVIEWS_DIR = path.join(GAMES_CACHE_DIR, 'reviews');
const ACHIEVEMENTS_DIR = path.join(GAMES_CACHE_DIR, 'achievements');
const GLOBAL_DIR = path.join(GAMES_CACHE_DIR, 'global');
const BREAKER_PATH = path.join(STATE_DIR, 'games-breaker.json');
const ENRICH_STATE_PATH = path.join(STATE_DIR, 'enrich-state.json');
const DETAILS_HEAL_STATE_PATH = path.join(STATE_DIR, 'details-heal-state.json');
const SPY_STATE_PATH = path.join(STATE_DIR, 'spy-state.json');
const REVIEWS_STATE_PATH = path.join(STATE_DIR, 'reviews-state.json');

const LIBRARY_TTL_MS = 24 * 60 * 60 * 1000;
const ACHIEVEMENTS_TTL_MS = 24 * 60 * 60 * 1000;
const GLOBAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DETAILS_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const SPY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REVIEWS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

for (const dir of [
  PROFILES_DIR,
  LIBRARY_DIR,
  DETAILS_DIR,
  DETAILS_BASE_DIR,
  SPY_DIR,
  REVIEWS_DIR,
  ACHIEVEMENTS_DIR,
  GLOBAL_DIR,
  STATE_DIR,
]) {
  fs.mkdirSync(dir, { recursive: true });
}

const fsStore = require('../core/fs-store');
const { round1 } = require('../core/stats');

const fingerprintOf = fsStore.fingerprintOf;
const safeKey = fsStore.safeKey;

function readJsonWithFingerprint(filePath) {
  return fsStore.readJsonWithFingerprint(filePath, { label: 'game-cache' });
}

async function writeJsonAtomic(filePath, data) {
  return fsStore.writeJsonAtomic(filePath, data);
}

function writeJsonAtomicSync(filePath, data) {
  return fsStore.writeJsonAtomicSync(filePath, data);
}

function profilePath(steamId64) {
  return path.join(PROFILES_DIR, `steam-${safeKey(steamId64)}.json`);
}

function libraryPath(steamId64) {
  return path.join(LIBRARY_DIR, `steam-${safeKey(steamId64)}.json`);
}

function detailsPath(appid) {
  return path.join(DETAILS_DIR, `${safeKey(appid)}.json`);
}

function detailsBasePath(appid) {
  return path.join(DETAILS_BASE_DIR, `${safeKey(appid)}.json`);
}

function spyPath(appid) {
  return path.join(SPY_DIR, `${safeKey(appid)}.json`);
}

function reviewsPath(appid) {
  return path.join(REVIEWS_DIR, `${safeKey(appid)}.json`);
}

function achievementPath(steamId64, appid) {
  return path.join(ACHIEVEMENTS_DIR, safeKey(steamId64), `${safeKey(appid)}.json`);
}

function globalPath(appid) {
  return path.join(GLOBAL_DIR, `${safeKey(appid)}.json`);
}

function profileKeyOf(steamId64) {
  return `steam-${steamId64}`;
}

function parseProfileToken(token) {
  const value = String(token == null ? '' : token).trim();
  const match = /^steam-(\d{17})$/i.exec(value);
  if (!match) return null;
  return { source: 'steam', userKey: match[1], key: profileKeyOf(match[1]) };
}

function isFresh(doc, ttlMs, field = 'fetchedAt') {
  if (!doc) return false;
  const ts = Date.parse(String(doc[field] || doc.importedAt || ''));
  if (!Number.isFinite(ts)) return false;
  const age = Date.now() - ts;
  return age >= 0 && age < ttlMs;
}

function libraryTtlMs() {
  const raw = Number(process.env.GAMES_LIBRARY_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : LIBRARY_TTL_MS;
}

function achievementsTtlMs() {
  const raw = Number(process.env.GAMES_ACHIEVEMENTS_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : ACHIEVEMENTS_TTL_MS;
}

function globalTtlMs() {
  const raw = Number(process.env.GAMES_GLOBAL_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : GLOBAL_TTL_MS;
}

function detailsTtlMs() {
  const raw = Number(process.env.GAMES_STORE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DETAILS_TTL_MS;
}

function spyTtlMs() {
  const raw = Number(process.env.GAMES_SPY_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : SPY_TTL_MS;
}

function reviewsTtlMs() {
  const raw = Number(process.env.GAMES_REVIEWS_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : REVIEWS_TTL_MS;
}

async function saveProfile(profile) {
  if (!profile || !profile.userKey) {
    throw new Error('saveProfile: profile.userKey (steamid64) is required');
  }
  const doc = {
    schemaVersion: 1,
    source: 'steam',
    ...profile,
    key: profileKeyOf(profile.userKey),
  };
  const fingerprint = await writeJsonAtomic(profilePath(profile.userKey), doc);
  return { data: doc, fingerprint };
}

function getProfile(steamId64) {
  const hit = readJsonWithFingerprint(profilePath(steamId64));
  return hit ? hit.data : null;
}

function getProfileByKey(key) {
  const parsed = parseProfileToken(key);
  if (!parsed) return null;
  return getProfile(parsed.userKey);
}

function listProfiles() {
  let names = [];
  try {
    names = fs.readdirSync(PROFILES_DIR).filter((name) => name.endsWith('.json'));
  } catch (err) {
    return [];
  }
  const result = [];
  for (const name of names) {
    const hit = readJsonWithFingerprint(path.join(PROFILES_DIR, name));
    if (!hit || !hit.data || !hit.data.userKey) continue;
    if (hit.data.source && hit.data.source !== 'steam') continue;
    const library = getLibrary(hit.data.userKey);
    result.push({
      source: 'steam',
      userKey: hit.data.userKey,
      key: profileKeyOf(hit.data.userKey),
      personaName: hit.data.personaName || null,
      label: hit.data.ownerLabel || null,
      avatarUrl: hit.data.avatarUrl || null,
      privacy: hit.data.privacy || null,
      importedAt: hit.data.importedAt || null,
      profileFetchedAt: hit.data.fetchedAt || null,
      libraryPartial: Boolean(library && library.partial),
      gameCount: library ? library.game_count : null,
      totalHours:
        library && Number.isFinite(Number(library.totalMinutes))
          ? round1(Number(library.totalMinutes) / 60)
          : null,
      fingerprint: hit.fingerprint,
    });
  }
  result.sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')));
  return result;
}

async function saveLibrary(steamId64, library) {
  const doc = {
    schemaVersion: 1,
    source: 'steam',
    userKey: String(steamId64),
    ...library,
  };
  const fingerprint = await writeJsonAtomic(libraryPath(steamId64), doc);
  return { data: doc, fingerprint };
}

function getLibrary(steamId64) {
  const hit = readJsonWithFingerprint(libraryPath(steamId64));
  return hit ? hit.data : null;
}

async function saveDetails(appid, doc) {
  const payload = {
    schemaVersion: 1,
    source: 'steam-store',
    ...doc,
    appid: Number(appid),
  };
  const fingerprint = await writeJsonAtomic(detailsPath(appid), payload);
  return { data: payload, fingerprint };
}

function getDetails(appid) {
  const hit = readJsonWithFingerprint(detailsPath(appid));
  return hit ? hit.data : null;
}

function listDetails(appids) {
  const result = {};
  if (!Array.isArray(appids)) return result;
  for (const appid of appids) {
    if (appid == null) continue;
    const doc = getDetails(appid);
    if (doc) result[String(appid)] = doc;
  }
  return result;
}

async function saveDetailsBase(appid, doc) {
  const payload = {
    schemaVersion: 1,
    source: 'steam-store',
    ...doc,
    appid: Number(appid),
    baseVersion: true,
  };
  const fingerprint = await writeJsonAtomic(detailsBasePath(appid), payload);
  return { data: payload, fingerprint };
}

function getDetailsBase(appid) {
  const hit = readJsonWithFingerprint(detailsBasePath(appid));
  return hit ? hit.data : null;
}

function listDetailsBase(appids) {
  const result = {};
  if (!Array.isArray(appids)) return result;
  for (const appid of appids) {
    if (appid == null) continue;
    const key = String(appid);
    if (result[key]) continue;
    const doc = getDetailsBase(appid);
    if (doc) result[key] = doc;
  }
  return result;
}

async function saveSpy(appid, doc) {
  const payload = {
    schemaVersion: 1,
    source: 'steamspy',
    ...doc,
    appid: Number(appid),
  };
  const fingerprint = await writeJsonAtomic(spyPath(appid), payload);
  return { data: payload, fingerprint };
}

function getSpy(appid) {
  const hit = readJsonWithFingerprint(spyPath(appid));
  return hit ? hit.data : null;
}

function listSpy(appids) {
  const result = {};
  if (!Array.isArray(appids)) return result;
  for (const appid of appids) {
    if (appid == null) continue;
    const doc = getSpy(appid);
    if (doc) result[String(appid)] = doc;
  }
  return result;
}

async function saveReviews(appid, doc) {
  const payload = {
    schemaVersion: 1,
    source: 'steam-reviews',
    ...doc,
    appid: Number(appid),
  };
  const fingerprint = await writeJsonAtomic(reviewsPath(appid), payload);
  return { data: payload, fingerprint };
}

function getReviews(appid) {
  const hit = readJsonWithFingerprint(reviewsPath(appid));
  return hit ? hit.data : null;
}

function listReviews(appids) {
  const result = {};
  if (!Array.isArray(appids)) return result;
  for (const appid of appids) {
    if (appid == null) continue;
    const doc = getReviews(appid);
    if (doc) result[String(appid)] = doc;
  }
  return result;
}

function readPhaseState(filePath) {
  const hit = readJsonWithFingerprint(filePath);
  if (!hit || !hit.data || typeof hit.data !== 'object') {
    return { schemaVersion: 1, updatedAt: null, profiles: {}, runs: [] };
  }
  return {
    schemaVersion: Number(hit.data.schemaVersion) || 1,
    updatedAt: hit.data.updatedAt || null,
    profiles:
      hit.data.profiles && typeof hit.data.profiles === 'object' ? hit.data.profiles : {},
    runs: Array.isArray(hit.data.runs) ? hit.data.runs : [],
  };
}

async function savePhaseState(filePath, state) {
  const payload = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    profiles: state && state.profiles && typeof state.profiles === 'object' ? state.profiles : {},
    runs: state && Array.isArray(state.runs) ? state.runs : [],
  };
  const fingerprint = await writeJsonAtomic(filePath, payload);
  return { data: payload, fingerprint };
}

function readEnrichState() {
  return readPhaseState(ENRICH_STATE_PATH);
}

async function saveEnrichState(state) {
  return savePhaseState(ENRICH_STATE_PATH, state);
}

function readSpyState() {
  return readPhaseState(SPY_STATE_PATH);
}

async function saveSpyState(state) {
  return savePhaseState(SPY_STATE_PATH, state);
}

function readReviewsState() {
  return readPhaseState(REVIEWS_STATE_PATH);
}

async function saveReviewsState(state) {
  return savePhaseState(REVIEWS_STATE_PATH, state);
}

function readDetailsHealState() {
  const hit = readJsonWithFingerprint(DETAILS_HEAL_STATE_PATH);
  const doc = (hit && hit.data) || {};
  return {
    schemaVersion: 1,
    updatedAt: doc.updatedAt || null,
    appids: doc.appids && typeof doc.appids === 'object' ? doc.appids : {},
  };
}

async function saveDetailsHealState(state) {
  const payload = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    appids: state && state.appids && typeof state.appids === 'object' ? state.appids : {},
  };
  const fingerprint = await writeJsonAtomic(DETAILS_HEAL_STATE_PATH, payload);
  return { data: payload, fingerprint };
}

async function saveAchievements(steamId64, appid, doc) {
  const payload = {
    schemaVersion: 1,
    source: 'steam-community',
    userKey: String(steamId64),
    ...doc,
    appid: Number(appid),
  };
  const fingerprint = await writeJsonAtomic(achievementPath(steamId64, appid), payload);
  return { data: payload, fingerprint };
}

function getAchievements(steamId64, appid) {
  const hit = readJsonWithFingerprint(achievementPath(steamId64, appid));
  return hit ? hit.data : null;
}

function listAchievements(steamId64) {
  const dir = path.join(ACHIEVEMENTS_DIR, safeKey(steamId64));
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch (err) {
    return [];
  }
  const result = [];
  for (const name of names) {
    const hit = readJsonWithFingerprint(path.join(dir, name));
    if (hit && hit.data) result.push(hit.data);
  }
  return result;
}

async function saveGlobal(appid, doc) {
  const payload = {
    schemaVersion: 1,
    source: 'steam-webapi',
    ...doc,
    appid: Number(appid),
  };
  const fingerprint = await writeJsonAtomic(globalPath(appid), payload);
  return { data: payload, fingerprint };
}

function getGlobal(appid) {
  const hit = readJsonWithFingerprint(globalPath(appid));
  return hit ? hit.data : null;
}

function readBreaker() {
  const hit = readJsonWithFingerprint(BREAKER_PATH);
  return hit && hit.data && typeof hit.data === 'object' ? hit.data : {};
}

function writeBreaker(state) {
  writeJsonAtomicSync(BREAKER_PATH, state && typeof state === 'object' ? state : {});
}

module.exports = {
  GAMES_CACHE_DIR,
  STATE_DIR,
  PROFILES_DIR,
  LIBRARY_DIR,
  ACHIEVEMENTS_DIR,
  BREAKER_PATH,
  libraryTtlMs,
  achievementsTtlMs,
  globalTtlMs,
  detailsTtlMs,
  spyTtlMs,
  reviewsTtlMs,
  isFresh,
  safeKey,
  readJsonWithFingerprint,
  writeJsonAtomic,
  writeJsonAtomicSync,
  detailsBasePath,
  achievementPath,
  profileKeyOf,
  parseProfileToken,
  saveProfile,
  getProfile,
  getProfileByKey,
  listProfiles,
  saveLibrary,
  getLibrary,
  saveDetails,
  getDetails,
  listDetails,
  saveDetailsBase,
  getDetailsBase,
  listDetailsBase,
  saveSpy,
  getSpy,
  listSpy,
  saveReviews,
  getReviews,
  listReviews,
  readEnrichState,
  saveEnrichState,
  readDetailsHealState,
  saveDetailsHealState,
  readSpyState,
  saveSpyState,
  readReviewsState,
  saveReviewsState,
  saveAchievements,
  getAchievements,
  listAchievements,
  saveGlobal,
  getGlobal,
  readBreaker,
  writeBreaker,
};
