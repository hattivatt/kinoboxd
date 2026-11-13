'use strict';

const fs = require('fs');
const path = require('path');

const gameCache = require('./game-cache');
const { envMs } = require('../core/env');
const { safeKey, writeSecretAtomicSync } = require('../core/fs-store');

const CACHE_DIR = gameCache.GAMES_CACHE_DIR;
const PROFILES_DIR = path.join(CACHE_DIR, 'profiles');
const LIBRARY_DIR = path.join(CACHE_DIR, 'library');
const PLAYTIME_DIR = path.join(CACHE_DIR, 'playtime');
const TOKENS_DIR = path.join(CACHE_DIR, 'tokens');
const STATE_DIR = gameCache.STATE_DIR;
const BREAKER_PATH = path.join(STATE_DIR, 'gog-breaker.json');
const DEBUG_DIR = path.join(CACHE_DIR, 'debug', 'gog');

const LIBRARY_TTL_MS = 24 * 60 * 60 * 1000;
const PLAYTIME_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const EXPIRES_IN_SECONDS_MAX = 1000000;
const TERMINAL_REFRESH_CODES = new Set(['gog_auth_expired', 'gog_invalid_code']);
const AUTH_LIFECYCLE_NAME = 'auth-lifecycle';
const AUTH_LIFECYCLE_MAX_EVENTS = 200;

try {
  fs.mkdirSync(TOKENS_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(TOKENS_DIR, 0o700);
} catch (err) {
}
for (const dir of [PROFILES_DIR, LIBRARY_DIR, PLAYTIME_DIR, STATE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

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

function debugPath(name) {
  return path.join(DEBUG_DIR, `${safeKey(name)}.json`);
}

function libraryTtlMs() {
  return envMs('GAMES_GOG_LIBRARY_TTL_MS', LIBRARY_TTL_MS);
}

function playtimeTtlMs() {
  return envMs('GAMES_GOG_PLAYTIME_TTL_MS', PLAYTIME_TTL_MS);
}

function isFresh(doc, ttlMs) {
  return gameCache.isFresh(doc, ttlMs, 'fetchedAt');
}

function refreshMarginMs() {
  return envMs('GAMES_GOG_REFRESH_MARGIN_MS', DEFAULT_REFRESH_MARGIN_MS);
}

function parseExpiresAt(value) {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return parseExpiresAt(Number(text));
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function expiresInMs(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value > EXPIRES_IN_SECONDS_MAX ? Math.round(value) : Math.round(value * 1000);
}

function tokenShape(doc, options = {}) {
  const now = options.now == null ? Date.now() : options.now;
  if (!doc) {
    return { hasAccess: false, hasRefresh: false, expiresAt: null, expiresIn: null };
  }
  const expiresMs = parseExpiresAt(doc.expiresAt);
  return {
    hasAccess: Boolean(doc.accessToken),
    hasRefresh: Boolean(doc.refreshToken),
    expiresAt: doc.expiresAt || null,
    expiresIn: Number.isFinite(expiresMs) ? Math.round((expiresMs - now) / 1000) : null,
  };
}

function errorShape(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    code: value.code ? String(value.code) : null,
    description: value.description == null ? null : String(value.description),
    at: value.at || null,
  };
}

function authStateOf(doc, options = {}) {
  if (!doc) return null;
  const now = options.now == null ? Date.now() : options.now;
  const marginMs = options.marginMs == null ? refreshMarginMs() : options.marginMs;
  const expiresMs = parseExpiresAt(doc.expiresAt);
  const hasAccess = Boolean(doc.accessToken);
  const hasRefresh = Boolean(doc.refreshToken);
  const remainingMs = Number.isFinite(expiresMs) ? expiresMs - now : null;
  const accessExpired = remainingMs == null ? !hasAccess : remainingMs <= 0;
  const expiring = remainingMs != null && remainingMs > 0 && remainingMs <= marginMs;
  const lastRefreshError = errorShape(doc.lastRefreshError);
  const lastError = errorShape(doc.lastError);
  const terminal = Boolean(lastRefreshError && TERMINAL_REFRESH_CODES.has(lastRefreshError.code));
  const needsReconnect = terminal || ((!hasAccess || accessExpired) && !hasRefresh);
  const status = needsReconnect
    ? terminal && hasRefresh
      ? 'refresh_failed'
      : 'no_refresh_token'
    : accessExpired
      ? 'expired'
      : expiring
        ? 'expiring'
        : 'valid';
  return {
    status,
    hasAccessToken: hasAccess,
    hasRefreshToken: hasRefresh,
    expiresAt: doc.expiresAt || null,
    expiresAtMs: Number.isFinite(expiresMs) ? new Date(expiresMs).toISOString() : null,
    expiresInMs: remainingMs,
    expired: accessExpired,
    expiring,
    refreshable: hasRefresh && !terminal,
    needsReconnect,
    refreshedAt: doc.refreshedAt || null,
    lastRefreshError,
    lastError,
    binding: doc.ownerProfile ? 'bound' : 'unbound',
  };
}

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

function publicTokenView(doc) {
  if (!doc) return null;
  const auth = authStateOf(doc);
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
    expiresAt: doc.expiresAt || null,
    expired: auth ? auth.needsReconnect : null,
    accessExpired: auth ? auth.expired : null,
    refreshable: auth ? auth.refreshable : null,
    authState: auth,
  };
}

function listAccounts() {
  return listTokens()
    .map(publicTokenView)
    .sort((left, right) =>
      String(right.connectedAt || '').localeCompare(String(left.connectedAt || ''))
    );
}

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

function writeDebugDump(name, doc) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const fingerprint = gameCache.writeJsonAtomicSync(debugPath(name), doc);
    return { data: doc, fingerprint };
  } catch (err) {
    return null;
  }
}

function getDebugDump(name) {
  const hit = gameCache.readJsonWithFingerprint(debugPath(name));
  return hit ? hit.data : null;
}

function listDebugDumps() {
  let names = [];
  try {
    names = fs.readdirSync(DEBUG_DIR).filter((name) => /\.json$/.test(name));
  } catch (err) {
    return [];
  }
  return names.sort();
}

function appendAuthEvent(event) {
  try {
    const previous = getDebugDump(AUTH_LIFECYCLE_NAME);
    const events = previous && Array.isArray(previous.events) ? previous.events.slice() : [];
    events.push({ ...(event || {}), at: (event && event.at) || new Date().toISOString() });
    while (events.length > AUTH_LIFECYCLE_MAX_EVENTS) events.shift();
    const doc = {
      schemaVersion: 1,
      source: 'gog',
      kind: 'gog-auth-lifecycle',
      updatedAt: new Date().toISOString(),
      events,
    };
    writeDebugDump(AUTH_LIFECYCLE_NAME, doc);
    return doc;
  } catch (err) {
    return null;
  }
}

function readAuthLifecycle() {
  const doc = getDebugDump(AUTH_LIFECYCLE_NAME);
  return doc && Array.isArray(doc.events) ? doc.events : [];
}

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
  DEBUG_DIR,
  LIBRARY_TTL_MS,
  PLAYTIME_TTL_MS,
  DEFAULT_REFRESH_MARGIN_MS,
  EXPIRES_IN_SECONDS_MAX,
  TERMINAL_REFRESH_CODES,
  AUTH_LIFECYCLE_NAME,
  AUTH_LIFECYCLE_MAX_EVENTS,
  libraryTtlMs,
  playtimeTtlMs,
  refreshMarginMs,
  parseExpiresAt,
  expiresInMs,
  tokenShape,
  authStateOf,
  isFresh,
  isValidUserKey,
  userKeyOf,
  profileKeyOf,
  tokenPath,
  profilePath,
  libraryPath,
  playtimePath,
  debugPath,
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
  writeDebugDump,
  getDebugDump,
  listDebugDumps,
  appendAuthEvent,
  readAuthLifecycle,
  readBreaker,
  writeBreaker,
};
