'use strict';

/**
 * GOG cache (namespace: cache-games/, M6a).
 *
 * GOG is a **same-owner secondary library**, not a second journal (ИГРЫ §14.4,
 * model v7): it never replaces the Steam library and its hours are never summed
 * with Steam. This module owns only the GOG side of the cache so the Steam
 * snapshot (`profiles/steam-*.json`, `library/steam-*.json`) is untouched:
 *
 *   cache-games/
 *     profiles/gog-<userId>.json      username/avatar/country + ownerProfile
 *     library/gog-<userId>.json       getFilteredProducts snapshot (products[])
 *     playtime/gog-<userId>.json      { [gogGameId]: minutes } (time_sum)
 *     tokens/gog-<userId>.json        OAuth tokens — **0600 file, 0700 dir**
 *     state/gog-breaker.json          host breaker (30 min), never a token
 *
 * Rules:
 *   - tokens are never returned by the public view (`publicTokenView`), never
 *     logged, never written to the library/playtime snapshots;
 *   - every write is atomic (tmp + rename);
 *   - token files are created with mode 0600 and the directory with 0700, even
 *     when the process umask is permissive (tests assert this);
 *   - `KINOBOXD_CACHE_GAMES_DIR` moves the whole games cache (tests use /tmp).
 */

const fs = require('fs');
const path = require('path');

const gameCache = require('./game-cache');

const CACHE_DIR = gameCache.GAMES_CACHE_DIR;
const PROFILES_DIR = path.join(CACHE_DIR, 'profiles');
const LIBRARY_DIR = path.join(CACHE_DIR, 'library');
const PLAYTIME_DIR = path.join(CACHE_DIR, 'playtime');
const TOKENS_DIR = path.join(CACHE_DIR, 'tokens');
const STATE_DIR = gameCache.STATE_DIR;
const BREAKER_PATH = path.join(STATE_DIR, 'gog-breaker.json');

const LIBRARY_TTL_MS = 24 * 60 * 60 * 1000;
const PLAYTIME_TTL_MS = 24 * 60 * 60 * 1000;
const PROFILE_TTL_MS = 6 * 60 * 60 * 1000;

// The token directory must not be group/world readable. `recursive: true`
// applies the mode only to directories it creates, so an explicit chmod keeps
// the invariant when the parent already existed.
try {
  fs.mkdirSync(TOKENS_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(TOKENS_DIR, 0o700);
} catch (err) {
  /* best-effort: a read-only worktree must still be able to boot */
}
for (const dir of [PROFILES_DIR, LIBRARY_DIR, PLAYTIME_DIR, STATE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function safeKey(value) {
  return gameCache.safeKey(value);
}

/** GOG user ids are numeric (`user_id` from the token response). */
function isValidUserKey(value) {
  const text = String(value == null ? '' : value).trim();
  return /^\d{1,20}$/.test(text);
}

function userKeyOf(value) {
  const text = String(value == null ? '' : value).trim();
  if (isValidUserKey(text)) return text;
  const prefixed = /^gog-(\d{1,20})$/i.exec(text);
  return prefixed ? prefixed[1] : null;
}

function profileKeyOf(userKey) {
  return `gog-${userKey}`;
}

function tokenPath(userKey) {
  return path.join(TOKENS_DIR, `gog-${safeKey(userKey)}.json`);
}

function profilePath(userKey) {
  return path.join(PROFILES_DIR, `gog-${safeKey(userKey)}.json`);
}

function libraryPath(userKey) {
  return path.join(LIBRARY_DIR, `gog-${safeKey(userKey)}.json`);
}

function playtimePath(userKey) {
  return path.join(PLAYTIME_DIR, `gog-${safeKey(userKey)}.json`);
}

function envMs(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function libraryTtlMs() {
  return envMs('GAMES_GOG_LIBRARY_TTL_MS', LIBRARY_TTL_MS);
}

function playtimeTtlMs() {
  return envMs('GAMES_GOG_PLAYTIME_TTL_MS', PLAYTIME_TTL_MS);
}

function profileTtlMs() {
  return envMs('GAMES_GOG_PROFILE_TTL_MS', PROFILE_TTL_MS);
}

function isFresh(doc, ttlMs) {
  return gameCache.isFresh(doc, ttlMs, 'fetchedAt');
}

/* ------------------------------------------------------------------ */
/* tokens (0600)                                                       */
/* ------------------------------------------------------------------ */

/**
 * Atomic write with an explicit 0600 mode. `writeFileSync` applies the mode
 * only when the file is created; an existing tmp with a wider mode is fixed by
 * the following `chmodSync`, and `rename` preserves the inode mode.
 */
function writeSecretAtomicSync(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data), 'utf8');
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    /* best-effort */
  }
  return gameCache.fingerprintOf(filePath);
}

/**
 * Persist a token document. Callers pass the raw OAuth material; this is the
 * only function that touches `tokens/`, so the 0600 invariant has one owner.
 */
function saveToken(userKey, tokenDoc) {
  if (!isValidUserKey(userKey)) {
    throw new Error('saveToken: userKey must be a numeric GOG user id');
  }
  const doc = {
    schemaVersion: 1,
    source: 'gog',
    ...tokenDoc,
    userKey: String(userKey),
  };
  const fingerprint = writeSecretAtomicSync(tokenPath(userKey), doc);
  return { data: doc, fingerprint };
}

/** Raw token document (contains secrets — never return it from a route). */
function getToken(userKey) {
  if (!isValidUserKey(userKey)) return null;
  const hit = gameCache.readJsonWithFingerprint(tokenPath(userKey));
  return hit ? hit.data : null;
}

function deleteToken(userKey) {
  if (!isValidUserKey(userKey)) return false;
  try {
    fs.unlinkSync(tokenPath(userKey));
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

function listTokens() {
  let names = [];
  try {
    names = fs.readdirSync(TOKENS_DIR).filter((name) => /^gog-.*\.json$/.test(name));
  } catch (err) {
    return [];
  }
  const result = [];
  for (const name of names) {
    const hit = gameCache.readJsonWithFingerprint(path.join(TOKENS_DIR, name));
    if (!hit || !hit.data || !isValidUserKey(hit.data.userKey)) continue;
    result.push(hit.data);
  }
  return result;
}

/**
 * Public (API/UI-safe) view of a token document. It intentionally drops
 * `accessToken`, `refreshToken` and any other credential: only identity,
 * ownership and expiry are exposed.
 */
function publicTokenView(doc) {
  if (!doc) return null;
  const expiresAt = doc.expiresAt || null;
  const expiresMs = expiresAt ? Date.parse(expiresAt) : NaN;
  return {
    source: 'gog',
    userKey: String(doc.userKey),
    key: profileKeyOf(doc.userKey),
    username: doc.username || null,
    galaxyUserId: doc.galaxyUserId || null,
    country: doc.country || null,
    avatar: doc.avatar || null,
    ownerProfile: doc.ownerProfile || null,
    connectedAt: doc.connectedAt || doc.obtainedAt || null,
    obtainedAt: doc.obtainedAt || null,
    refreshedAt: doc.refreshedAt || null,
    expiresAt,
    expired: Number.isFinite(expiresMs) ? expiresMs <= Date.now() : null,
  };
}

/** All connected GOG accounts, newest first, sanitized. */
function listAccounts() {
  return listTokens()
    .map(publicTokenView)
    .sort((left, right) =>
      String(right.connectedAt || '').localeCompare(String(left.connectedAt || ''))
    );
}

/** GOG accounts attached to one Steam owner profile (`steam-<id>`). */
function accountsForOwner(ownerProfile) {
  const owner = String(ownerProfile == null ? '' : ownerProfile).trim();
  if (!owner) return [];
  return listAccounts().filter((entry) => entry.ownerProfile === owner);
}

function setOwner(userKey, ownerProfile) {
  const doc = getToken(userKey);
  if (!doc) return null;
  const next = { ...doc, ownerProfile: ownerProfile || null };
  saveToken(userKey, next);
  const profile = getProfile(userKey);
  if (profile) saveProfile({ ...profile, ownerProfile: ownerProfile || null });
  return publicTokenView(next);
}

/* ------------------------------------------------------------------ */
/* profiles                                                            */
/* ------------------------------------------------------------------ */

function saveProfile(profile) {
  if (!profile || !isValidUserKey(profile.userKey)) {
    throw new Error('saveProfile: profile.userKey (GOG user id) is required');
  }
  const doc = {
    schemaVersion: 1,
    source: 'gog',
    ...profile,
    userKey: String(profile.userKey),
  };
  const fingerprint = gameCache.writeJsonAtomicSync(profilePath(profile.userKey), doc);
  return { data: doc, fingerprint };
}

function getProfile(userKey) {
  if (!isValidUserKey(userKey)) return null;
  const hit = gameCache.readJsonWithFingerprint(profilePath(userKey));
  return hit ? hit.data : null;
}

function listProfiles() {
  let names = [];
  try {
    names = fs.readdirSync(PROFILES_DIR).filter((name) => /^gog-.*\.json$/.test(name));
  } catch (err) {
    return [];
  }
  const result = [];
  for (const name of names) {
    const hit = gameCache.readJsonWithFingerprint(path.join(PROFILES_DIR, name));
    if (hit && hit.data && hit.data.userKey) result.push(hit.data);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* library snapshot                                                    */
/* ------------------------------------------------------------------ */

function saveLibrary(userKey, library) {
  if (!isValidUserKey(userKey)) {
    throw new Error('saveLibrary: userKey must be a numeric GOG user id');
  }
  const doc = {
    schemaVersion: 1,
    source: 'gog',
    ...library,
    userKey: String(userKey),
  };
  const fingerprint = gameCache.writeJsonAtomicSync(libraryPath(userKey), doc);
  return { data: doc, fingerprint };
}

function getLibrary(userKey) {
  if (!isValidUserKey(userKey)) return null;
  const hit = gameCache.readJsonWithFingerprint(libraryPath(userKey));
  return hit ? hit.data : null;
}

function listLibraries() {
  let names = [];
  try {
    names = fs.readdirSync(LIBRARY_DIR).filter((name) => /^gog-.*\.json$/.test(name));
  } catch (err) {
    return [];
  }
  const result = [];
  for (const name of names) {
    const hit = gameCache.readJsonWithFingerprint(path.join(LIBRARY_DIR, name));
    if (hit && hit.data && hit.data.userKey) result.push(hit.data);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* playtime snapshot                                                   */
/* ------------------------------------------------------------------ */

function savePlaytime(userKey, playtime) {
  if (!isValidUserKey(userKey)) {
    throw new Error('savePlaytime: userKey must be a numeric GOG user id');
  }
  const doc = {
    schemaVersion: 1,
    source: 'gog',
    ...playtime,
    userKey: String(userKey),
  };
  const fingerprint = gameCache.writeJsonAtomicSync(playtimePath(userKey), doc);
  return { data: doc, fingerprint };
}

function getPlaytime(userKey) {
  if (!isValidUserKey(userKey)) return null;
  const hit = gameCache.readJsonWithFingerprint(playtimePath(userKey));
  return hit ? hit.data : null;
}

/* ------------------------------------------------------------------ */
/* breaker state (no tokens, no user data)                             */
/* ------------------------------------------------------------------ */

function readBreaker() {
  const hit = gameCache.readJsonWithFingerprint(BREAKER_PATH);
  return hit ? hit.data : {};
}

function writeBreaker(state) {
  return gameCache.writeJsonAtomicSync(BREAKER_PATH, state || {});
}

module.exports = {
  CACHE_DIR,
  PROFILES_DIR,
  LIBRARY_DIR,
  PLAYTIME_DIR,
  TOKENS_DIR,
  STATE_DIR,
  BREAKER_PATH,
  LIBRARY_TTL_MS,
  PLAYTIME_TTL_MS,
  PROFILE_TTL_MS,
  libraryTtlMs,
  playtimeTtlMs,
  profileTtlMs,
  isFresh,
  isValidUserKey,
  userKeyOf,
  profileKeyOf,
  safeKey,
  tokenPath,
  profilePath,
  libraryPath,
  playtimePath,
  saveToken,
  getToken,
  deleteToken,
  listTokens,
  publicTokenView,
  listAccounts,
  accountsForOwner,
  setOwner,
  saveProfile,
  getProfile,
  listProfiles,
  saveLibrary,
  getLibrary,
  listLibraries,
  savePlaytime,
  getPlaytime,
  readBreaker,
  writeBreaker,
};
