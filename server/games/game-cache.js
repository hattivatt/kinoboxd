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
 *     achievements/<steamid64>/<appid>.json  player achievements (unlockTimestamp)
 *     global/<appid>.json                 global achievement percentages
 *     state/games-breaker.json            host breakers (30 min) — see §10.1
 *
 * Roots:
 *   - `KINOBOXD_CACHE_GAMES_DIR` moves the whole cache (tests point it at /tmp);
 *   - `KINOBOXD_STATE_DIR` moves mutable state (breaker) the same way; when it
 *     is set the state lives in `<STATE_DIR>/games`, otherwise under the cache.
 *
 * TTLs (brief for M1; library is 24 h here, §3.3 mentions 6 h for a manual
 * refresh — the import job accepts `force` to bypass either):
 *   profile 6 h · library 24 h · achievements 24 h · global 7 days.
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
const ACHIEVEMENTS_DIR = path.join(GAMES_CACHE_DIR, 'achievements');
const GLOBAL_DIR = path.join(GAMES_CACHE_DIR, 'global');
const BREAKER_PATH = path.join(STATE_DIR, 'games-breaker.json');

const PROFILE_TTL_MS = 6 * 60 * 60 * 1000;
const LIBRARY_TTL_MS = 24 * 60 * 60 * 1000;
const ACHIEVEMENTS_TTL_MS = 24 * 60 * 60 * 1000;
const GLOBAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

for (const dir of [PROFILES_DIR, LIBRARY_DIR, ACHIEVEMENTS_DIR, GLOBAL_DIR, STATE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

/* ------------------------------------------------------------------ */
/* Freshness + atomic writes                                           */
/* ------------------------------------------------------------------ */

/** Same identity as server/cache.js: inode + size + mtime(ns); null when absent. */
function fingerprintOf(filePath) {
  try {
    const st = fs.statSync(filePath, { bigint: true });
    return `${st.mtimeNs}:${st.size}:${st.ino}`;
  } catch (err) {
    return null;
  }
}

/**
 * Read + parse one JSON file together with the fingerprint of the exact bytes
 * that were parsed. Returns { data, fingerprint } or null.
 */
function readJsonWithFingerprint(filePath) {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = fingerprintOf(filePath);
      if (before === null) return null;
      const raw = fs.readFileSync(filePath, 'utf8');
      const after = fingerprintOf(filePath);
      if (after === null) return null;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        console.warn(`[game-cache] corrupt JSON in ${filePath}: ${err.message}`);
        return null;
      }
      if (after === before) return { data: parsed, fingerprint: after };
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function writeJsonAtomic(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fsp.rename(tmp, filePath);
  return fingerprintOf(filePath);
}

function writeJsonAtomicSync(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.flush.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, filePath);
  return fingerprintOf(filePath);
}

/** Make an arbitrary key safe for a file name (no path traversal). */
function safeKey(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/[^\w.-]/g, '_')
    .slice(0, 120);
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
    const library = getLibrary(hit.data.userKey);
    result.push({
      source: 'steam',
      userKey: hit.data.userKey,
      key: profileKeyOf(hit.data.userKey),
      personaName: hit.data.personaName || null,
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
  ACHIEVEMENTS_DIR,
  GLOBAL_DIR,
  BREAKER_PATH,
  PROFILE_TTL_MS,
  LIBRARY_TTL_MS,
  ACHIEVEMENTS_TTL_MS,
  GLOBAL_TTL_MS,
  profileTtlMs,
  libraryTtlMs,
  achievementsTtlMs,
  globalTtlMs,
  isFresh,
  safeKey,
  fingerprintOf,
  readJsonWithFingerprint,
  writeJsonAtomic,
  writeJsonAtomicSync,
  profilePath,
  libraryPath,
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
  saveAchievements,
  getAchievements,
  listAchievements,
  saveGlobal,
  getGlobal,
  readBreaker,
  writeBreaker,
};
