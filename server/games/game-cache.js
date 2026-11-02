'use strict';

/**
 * Games cache (namespace: cache-games/).
 *
 * Same invariants as the film/book caches:
 *   - everything lives on disk; a read returns the parsed document together
 *     with the file fingerprint (`mtimeNs:size:ino`) so an external import is
 *     visible to a running server without a restart;
 *   - every write is atomic (tmp + rename);
 *   - every JSON file carries `schemaVersion`.
 *
 * Layout (ИГРЫ-АРХИТЕКТУРА.md §3.2, M1 subset):
 *
 *   cache-games/
 *     profiles/steam-<steamid64>.json     persona/avatar/privacy/importedAt
 *     library/steam-<steamid64>.json      raw GetOwnedGames snapshot + fingerprint
 *     details/<appid>.json                store appdetails (global, not per owner)
 *     details-base/<appid>.json           appdetails of the *base* version of a
 *                                         regional SKU (B6; the owner does not
 *                                         own it, so it never enters details/)
 *     spy/<appid>.json                    SteamSpy tags/owners/ccu (M4, global)
 *     reviews/<appid>.json                appreviews summary (M4, global)
 *     achievements/<steamid64>/<appid>.json  player achievements (unlockTimestamp)
 *     global/<appid>.json                 global achievement percentages
 *     editions.json                       canonical edition index (M5-B, profiles keyed)
 *     state/games-breaker.json            host breakers (30 min) — see §10.1
 *     state/enrich-state.json             details enrich progress/journal (resume)
 *     state/details-heal-state.json       one-time heal ledger for documents
 *                                         written before `headerImage` existed
 *     state/spy-state.json                SteamSpy phase progress/journal
 *     state/reviews-state.json            appreviews phase progress/journal
 *
 * Roots:
 *   - `KINOBOXD_CACHE_GAMES_DIR` moves the whole cache (tests point it at /tmp);
 *   - `KINOBOXD_STATE_DIR` moves mutable state (breaker) the same way; when it
 *     is set the state lives in `<STATE_DIR>/games`, otherwise under the cache.
 *
 * TTLs (library is 24 h here, §3.3 mentions 6 h for a manual refresh — the
 * import job accepts `force` to bypass either):
 *   profile 6 h · library 24 h · achievements 24 h · global 7 days ·
 *   details 180 days (`GAMES_STORE_TTL_MS`, re-check window `GAMES_STORE_RECHECK_DAYS`) ·
 *   spy/reviews 30 days (`GAMES_SPY_TTL_MS` / `GAMES_REVIEWS_TTL_MS`).
 */

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
// B6: appdetails of the **base** version of a regional SKU (`Dishonored RHCP`
// → `Dishonored`). A separate directory on purpose: the owner does not own the
// base card, so it must never enter `details/` (that directory is the library
// enrichment progress and its TTL drives the enrich job).
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

const PROFILE_TTL_MS = 6 * 60 * 60 * 1000;
const LIBRARY_TTL_MS = 24 * 60 * 60 * 1000;
const ACHIEVEMENTS_TTL_MS = 24 * 60 * 60 * 1000;
const GLOBAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Store metadata is mostly static (genres/developers/categories), but release
// dates and DLC lists change; the brief fixes the re-check window at 180 days.
const DETAILS_TTL_MS = 180 * 24 * 60 * 60 * 1000;
// SteamSpy owners/CCU float, tags do not; appreviews counters grow daily. Both
// phases are re-checked monthly (brief M4; ИГРЫ §10.1 said 7 days for reviews).
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

/* ------------------------------------------------------------------ */
/* Freshness + atomic writes                                           */
/* ------------------------------------------------------------------ */

// One implementation for every domain: `server/core/fs-store.js`. The local
// names stay because the rest of this module (and its tests) calls them.
const fsStore = require('../core/fs-store');

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

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

function profilePath(steamId64) {
  return path.join(PROFILES_DIR, `steam-${safeKey(steamId64)}.json`);
}

function libraryPath(steamId64) {
  return path.join(LIBRARY_DIR, `steam-${safeKey(steamId64)}.json`);
}

function detailsPath(appid) {
  return path.join(DETAILS_DIR, `${safeKey(appid)}.json`);
}

/** `details-base/<appid>.json` — appdetails of a base version the owner does not own. */
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

/**
 * Parse a `?profile=` token. Only `steam-<steamid64>` is a valid games profile
 * token; anything else is reported as malformed/unknown by the route.
 */
function parseProfileToken(token) {
  const value = String(token == null ? '' : token).trim();
  const match = /^steam-(\d{17})$/i.exec(value);
  if (!match) return null;
  return { source: 'steam', userKey: match[1], key: profileKeyOf(match[1]) };
}

/** True when `doc[field]` is a valid timestamp younger than `ttlMs`. */
function isFresh(doc, ttlMs, field = 'fetchedAt') {
  if (!doc) return false;
  const ts = Date.parse(String(doc[field] || doc.importedAt || ''));
  if (!Number.isFinite(ts)) return false;
  const age = Date.now() - ts;
  return age >= 0 && age < ttlMs;
}

function profileTtlMs() {
  const raw = Number(process.env.GAMES_PROFILE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : PROFILE_TTL_MS;
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

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

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

/**
 * All cached profiles, newest import first. Metadata is read from the
 * `library/` snapshot when present so the switcher can show game counts
 * without loading every game.
 */
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
    // `profiles/` is shared with the same-owner secondary libraries (M6a:
    // `gog-<userId>.json`). Only Steam documents are owner profiles — a GOG
    // account must never appear as a second Steam owner.
    if (hit.data.source && hit.data.source !== 'steam') continue;
    const library = getLibrary(hit.data.userKey);
    result.push({
      source: 'steam',
      userKey: hit.data.userKey,
      key: profileKeyOf(hit.data.userKey),
      personaName: hit.data.personaName || null,
      // The human name typed at import (`ownerLabel`, ИГРЫ §5.4 `label`). Two
      // owners of one Steam account (or a persona that does not say who it is)
      // are told apart by this field in the switcher chips; it is additive and
      // never replaces `personaName`.
      label: hit.data.ownerLabel || null,
      avatarUrl: hit.data.avatarUrl || null,
      privacy: hit.data.privacy || null,
      importedAt: hit.data.importedAt || null,
      profileFetchedAt: hit.data.fetchedAt || null,
      libraryPartial: Boolean(library && library.partial),
      gameCount: library ? library.game_count : null,
      totalHours:
        library && Number.isFinite(Number(library.totalMinutes))
          ? Math.round((Number(library.totalMinutes) / 60) * 10) / 10
          : null,
      fingerprint: hit.fingerprint,
    });
  }
  result.sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')));
  return result;
}

/* ------------------------------------------------------------------ */
/* Library                                                             */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Details (store appdetails, global per appid — not per owner)         */
/* ------------------------------------------------------------------ */

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

/**
 * Read the details documents for the given appids. Returns a plain object
 * `{ [appid]: doc }`; missing/corrupt files are simply absent (the stats
 * payload then reports the game as «no details», never as a false negative).
 */
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

/* ------------------------------------------------------------------ */
/* Base-version details (B6: canonical metadata of a regional SKU)      */
/* ------------------------------------------------------------------ */

/**
 * Store appdetails of the **base** card (`Dishonored` for `Dishonored RHCP`).
 * Same document shape as `details/`, same 180-day TTL, but a separate
 * directory: `details/` stays «what the owner owns» and its file count is the
 * enrich job's progress counter. Nothing here is owner-scoped.
 */
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

/** `{ [appid]: doc }`; missing/corrupt files are simply absent. */
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

/* ------------------------------------------------------------------ */
/* SteamSpy tags (global per appid — metadata, not owner events)        */
/* ------------------------------------------------------------------ */

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

/** `{ [appid]: spyDoc }`; missing/corrupt files are simply absent. */
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

/* ------------------------------------------------------------------ */
/* Review summaries (global per appid)                                 */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Enrich progress (state dir)                                         */
/* ------------------------------------------------------------------ */

/** Generic resumable phase journal: `{schemaVersion, updatedAt, profiles, runs}`. */
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

/**
 * One-time heal ledger for `details` documents written **before** the store
 * parser started keeping `headerImage` (e5bc5b9, 02.11.2026). Those documents
 * are TTL-fresh, so the ordinary enrich pass skips them and the card never gets
 * a real header. The ledger is global (a details document is global per appid,
 * not owner-scoped) and keyed by appid:
 *
 *   { appids: { "<appid>": { at, appid, result } } }
 *
 * `result` is `healed` (the refetch produced a header), `no_artwork` (the store
 * answered without a header image — do not ask again) or `unavailable` (the
 * store said the item has no page). Any recorded appid is never a heal
 * candidate again; a fetch failure is NOT recorded, so the next run retries.
 */
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

/* ------------------------------------------------------------------ */
/* Achievements (per game) + global percentages                        */
/* ------------------------------------------------------------------ */

async function saveAchievements(steamId64, appid, doc) {
  const payload = {
    schemaVersion: 1,
    source: 'steam-community',
    userKey: String(steamId64),
    ...doc,
    // The requested appid wins over the XML's `gameFriendlyName`, which is a
    // slug ("Portal2"), not a number.
    appid: Number(appid),
  };
  const fingerprint = await writeJsonAtomic(achievementPath(steamId64, appid), payload);
  return { data: payload, fingerprint };
}

function getAchievements(steamId64, appid) {
  const hit = readJsonWithFingerprint(achievementPath(steamId64, appid));
  return hit ? hit.data : null;
}

/** All cached achievement documents of one profile (M1 has no index file). */
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

/* ------------------------------------------------------------------ */
/* Breaker state (state dir)                                           */
/* ------------------------------------------------------------------ */

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
  DETAILS_DIR,
  DETAILS_BASE_DIR,
  SPY_DIR,
  REVIEWS_DIR,
  ACHIEVEMENTS_DIR,
  GLOBAL_DIR,
  BREAKER_PATH,
  ENRICH_STATE_PATH,
  DETAILS_HEAL_STATE_PATH,
  SPY_STATE_PATH,
  REVIEWS_STATE_PATH,
  PROFILE_TTL_MS,
  LIBRARY_TTL_MS,
  ACHIEVEMENTS_TTL_MS,
  GLOBAL_TTL_MS,
  DETAILS_TTL_MS,
  SPY_TTL_MS,
  REVIEWS_TTL_MS,
  profileTtlMs,
  libraryTtlMs,
  achievementsTtlMs,
  globalTtlMs,
  detailsTtlMs,
  spyTtlMs,
  reviewsTtlMs,
  isFresh,
  safeKey,
  fingerprintOf,
  readJsonWithFingerprint,
  writeJsonAtomic,
  writeJsonAtomicSync,
  profilePath,
  libraryPath,
  detailsPath,
  detailsBasePath,
  spyPath,
  reviewsPath,
  achievementPath,
  globalPath,
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
  readPhaseState,
  savePhaseState,
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
