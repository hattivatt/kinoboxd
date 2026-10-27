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
 * Tokens are loaded lazily: requiring this module never touches the
 * environment or the filesystem, and a missing Hardcover token does not
 * affect server startup (the book feature is not wired in yet). The caller
 * decides how to report a missing credential. Missing credentials are a
 * normal startup/feature condition, so the errors have no stack trace.
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

const TOKEN_MISSING_MESSAGE =
  'TMDB-токен не найден: задай TMDB_API_TOKEN (read access token v4) в окружении';

const HARDCOVER_TOKEN_MISSING_MESSAGE =
  'Hardcover-токен не найден: задай HARDCOVER_API_TOKEN (Personal Access Token) в окружении';

let cachedToken = null;
let cachedSource = null;

let cachedHardcoverToken = null;
let cachedHardcoverSource = null;

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
};
