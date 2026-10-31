'use strict';

/**
 * Runtime configuration.
 *
 * TMDB credentials are resolved once, in this order:
 *   1. TMDB_API_TOKEN          (TMDB read access token v4)
 *   2. TMDB_READ_ACCESS_TOKEN  (alias)
 *   3. config/tmdb-token       (local dev fallback, gitignored)
 *
 * Hardcover credentials are resolved once, in this order:
 *   1. HARDCOVER_API_TOKEN     (Personal Access Token)
 *   2. HARDCOVER_READ_TOKEN    (alias)
 *   3. config/hardcover-token  (local dev fallback, gitignored)
 *
 * Google Books credentials are resolved once, in this order:
 *   1. GB_API_KEY              (API key, raises the anonymous per-IP quota)
 *   2. BOOKS_GOOGLE_API_KEY    (alias kept from the first provider version)
 *   3. config/gbooks-token     (local dev fallback, gitignored)
 * Unlike the other two, a missing Google Books key is NOT an error: the
 * provider still works anonymously, so `loadGbooksKey()` returns null.
 *
 * Steam credentials are resolved once, in this order:
 *   1. STEAM_API_KEY           (Steam Web API key, required for the library)
 *   2. config/steam-token      (local dev fallback, gitignored)
 * A missing Steam key is NOT an error either: the profile, achievements and
 * global percentages work without it, and the import degrades to
 * `libraryPartial` (see ИГРЫ-АРХИТЕКТУРА.md §10.4). `loadSteamKey()` returns
 * null and `steamKeySource()` returns null.
 *
 * Tokens are loaded lazily: requiring this module never touches the
 * environment or the filesystem, and a missing Hardcover token does not
 * affect server startup (the book feature is not wired in yet). The caller
 * decides how to report a missing credential. Missing credentials are a
 * normal startup/feature condition, so the errors have no stack trace.
 *
 * Never log a token value: `*TokenSource()`/`gbooksKeySource()` name the
 * source (`GB_API_KEY`, `file`, …) and nothing else.
 */

const fs = require('fs');
const path = require('path');

const TOKEN_PATH = path.join(__dirname, '..', 'config', 'tmdb-token');
const ENV_KEYS = ['TMDB_API_TOKEN', 'TMDB_READ_ACCESS_TOKEN'];

const HARDCOVER_TOKEN_PATH = path.join(
  __dirname,
  '..',
  'config',
  'hardcover-token',
);
const HARDCOVER_ENV_KEYS = ['HARDCOVER_API_TOKEN', 'HARDCOVER_READ_TOKEN'];

const GBOOKS_KEY_PATH = path.join(__dirname, '..', 'config', 'gbooks-token');
const GBOOKS_ENV_KEYS = ['GB_API_KEY', 'BOOKS_GOOGLE_API_KEY'];

const STEAM_KEY_PATH = path.join(__dirname, '..', 'config', 'steam-token');
const STEAM_ENV_KEYS = ['STEAM_API_KEY'];
// Tests point this at a non-existent file so the local dev fallback
// (`config/steam-token`, present in the main tree) cannot change their result.
const STEAM_KEY_FILE_ENV = 'KINOBOXD_STEAM_KEY_FILE';

function steamKeyPath() {
  const override = process.env[STEAM_KEY_FILE_ENV];
  if (typeof override === 'string' && override.trim()) return path.resolve(override.trim());
  return STEAM_KEY_PATH;
}

const TOKEN_MISSING_MESSAGE =
  'TMDB-токен не найден: задай TMDB_API_TOKEN (read access token v4) в окружении';

const HARDCOVER_TOKEN_MISSING_MESSAGE =
  'Hardcover-токен не найден: задай HARDCOVER_API_TOKEN (Personal Access Token) в окружении';

let cachedToken = null;
let cachedSource = null;

let cachedHardcoverToken = null;
let cachedHardcoverSource = null;

let gbooksLoaded = false;
let cachedGbooksKey = null;
let cachedGbooksSource = null;

let steamLoaded = false;
let cachedSteamKey = null;
let cachedSteamSource = null;

function fromEnv(keys = ENV_KEYS) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim()) {
      return { token: value.trim(), source: key };
    }
  }
  return null;
}

function fromFile(tokenPath = TOKEN_PATH) {
  try {
    const value = fs.readFileSync(tokenPath, 'utf8').trim();
    if (value) return { token: value, source: 'file' };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[config] Не удалось прочитать ${tokenPath}: ${err.message}`);
    }
  }
  return null;
}

/**
 * Return the TMDB token, loading it on first use.
 * Throws an Error with code TMDB_TOKEN_MISSING when no source has it.
 */
function loadTmdbToken() {
  if (cachedToken) return cachedToken;
  const found = fromEnv() || fromFile();
  if (!found) {
    const err = new Error(TOKEN_MISSING_MESSAGE);
    err.code = 'TMDB_TOKEN_MISSING';
    throw err;
  }
  cachedToken = found.token;
  cachedSource = found.source;
  return cachedToken;
}

function tmdbTokenSource() {
  if (!cachedSource) loadTmdbToken();
  return cachedSource;
}

/**
 * Return the Hardcover Personal Access Token, loading it on first use.
 * Throws an Error with code HARDCOVER_TOKEN_MISSING when no source has it.
 * Nothing in the server calls this yet; the books feature will.
 */
function loadHardcoverToken() {
  if (cachedHardcoverToken) return cachedHardcoverToken;
  const found = fromEnv(HARDCOVER_ENV_KEYS) || fromFile(HARDCOVER_TOKEN_PATH);
  if (!found) {
    const err = new Error(HARDCOVER_TOKEN_MISSING_MESSAGE);
    err.code = 'HARDCOVER_TOKEN_MISSING';
    throw err;
  }
  cachedHardcoverToken = found.token;
  cachedHardcoverSource = found.source;
  return cachedHardcoverToken;
}

function hardcoverTokenSource() {
  if (!cachedHardcoverSource) loadHardcoverToken();
  return cachedHardcoverSource;
}

/**
 * Return the Google Books API key, or null when none is configured.
 *
 * Anonymous Google Books still works (a per-IP quota), so a missing key is a
 * normal condition, not a startup error. Never log the returned value: callers
 * that want to report the source use `gbooksKeySource()`.
 */
function loadGbooksKey() {
  if (gbooksLoaded) return cachedGbooksKey;
  const found = fromEnv(GBOOKS_ENV_KEYS) || fromFile(GBOOKS_KEY_PATH);
  cachedGbooksKey = found ? found.token : null;
  cachedGbooksSource = found ? found.source : null;
  gbooksLoaded = true;
  return cachedGbooksKey;
}

function gbooksKeySource() {
  if (!gbooksLoaded) loadGbooksKey();
  return cachedGbooksSource;
}

/**
 * Return the Steam Web API key, or null when none is configured.
 *
 * The key is only needed for the owned-games library (`GetOwnedGames`); the
 * community XML endpoints (profile, achievements, global percentages) work
 * without it. Never log the returned value: report `steamKeySource()` instead.
 */
function loadSteamKey() {
  if (steamLoaded) return cachedSteamKey;
  const found = fromEnv(STEAM_ENV_KEYS) || fromFile(steamKeyPath());
  cachedSteamKey = found ? found.token : null;
  cachedSteamSource = found ? found.source : null;
  steamLoaded = true;
  return cachedSteamKey;
}

function steamKeySource() {
  if (!steamLoaded) loadSteamKey();
  return cachedSteamSource;
}

/** Test helper: forget the cached key so the next call re-reads env/file. */
function resetSteamKeyCache() {
  steamLoaded = false;
  cachedSteamKey = null;
  cachedSteamSource = null;
}

module.exports = {
  TOKEN_PATH,
  TOKEN_MISSING_MESSAGE,
  loadTmdbToken,
  getTmdbToken: loadTmdbToken,
  tmdbTokenSource,
  HARDCOVER_TOKEN_PATH,
  HARDCOVER_TOKEN_MISSING_MESSAGE,
  loadHardcoverToken,
  getHardcoverToken: loadHardcoverToken,
  hardcoverTokenSource,
  GBOOKS_KEY_PATH,
  loadGbooksKey,
  getGbooksKey: loadGbooksKey,
  gbooksKeySource,
  STEAM_KEY_PATH,
  steamKeyPath,
  loadSteamKey,
  getSteamKey: loadSteamKey,
  steamKeySource,
  resetSteamKeyCache,
};
