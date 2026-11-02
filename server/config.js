'use strict';

/**
 * Runtime configuration.
 *
 * Every credential is resolved lazily: requiring this module never touches the
 * environment or the filesystem, and a missing credential does not affect
 * startup. The caller decides how to report it.
 *
 * Resolution order is env aliases first, then a local dev file:
 *   TMDB         TMDB_API_TOKEN / TMDB_READ_ACCESS_TOKEN      -> config/tmdb-token
 *   Hardcover    HARDCOVER_API_TOKEN / HARDCOVER_READ_TOKEN   -> config/hardcover-token
 *   Google Books GB_API_KEY / BOOKS_GOOGLE_API_KEY            -> config/gbooks-token
 *   Steam        STEAM_API_KEY                                -> config/steam-token
 *
 * A missing Google Books or Steam key is not an error: both providers work
 * anonymously (Google Books on a per-IP quota, Steam for profile/achievements/
 * global percentages) and the import degrades explicitly.
 *
 * Never log a token value: `*Source()` names the source (`GB_API_KEY`, `file`,
 * ...) and nothing else. `server/core/secrets.js` owns the loading itself.
 */

const path = require('path');

const { createSecret } = require('./core/secrets');

const TOKEN_PATH = path.join(__dirname, '..', 'config', 'tmdb-token');
const ENV_KEYS = ['TMDB_API_TOKEN', 'TMDB_READ_ACCESS_TOKEN'];

const HARDCOVER_TOKEN_PATH = path.join(__dirname, '..', 'config', 'hardcover-token');
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

const tmdb = createSecret({
  envKeys: ENV_KEYS,
  file: TOKEN_PATH,
  fileLabel: 'config',
  required: true,
  missingCode: 'TMDB_TOKEN_MISSING',
  missingMessage: TOKEN_MISSING_MESSAGE,
});

const hardcover = createSecret({
  envKeys: HARDCOVER_ENV_KEYS,
  file: HARDCOVER_TOKEN_PATH,
  required: true,
  missingCode: 'HARDCOVER_TOKEN_MISSING',
  missingMessage: HARDCOVER_TOKEN_MISSING_MESSAGE,
});

const gbooks = createSecret({ envKeys: GBOOKS_ENV_KEYS, file: GBOOKS_KEY_PATH });

const steam = createSecret({ envKeys: STEAM_ENV_KEYS, file: steamKeyPath });

/** TMDB token; throws code TMDB_TOKEN_MISSING when no source has it. */
function loadTmdbToken() {
  return tmdb.load();
}

function tmdbTokenSource() {
  return tmdb.source();
}

/** Hardcover PAT; throws code HARDCOVER_TOKEN_MISSING when no source has it. */
function loadHardcoverToken() {
  return hardcover.load();
}

function hardcoverTokenSource() {
  return hardcover.source();
}

/** Google Books key, or null in anonymous mode. */
function loadGbooksKey() {
  return gbooks.load();
}

function gbooksKeySource() {
  return gbooks.source();
}

/** Steam Web API key, or null when only the no-key endpoints are available. */
function loadSteamKey() {
  return steam.load();
}

function steamKeySource() {
  return steam.source();
}

/** Test helper: forget the cached key so the next call re-reads env/file. */
function resetSteamKeyCache() {
  steam.reset();
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
