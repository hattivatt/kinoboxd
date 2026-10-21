'use strict';

/**
 * Runtime configuration.
 *
 * TMDB credentials are resolved once, in this order:
 *   1. TMDB_API_TOKEN          (TMDB read access token v4)
 *   2. TMDB_READ_ACCESS_TOKEN  (alias)
 *   3. config/tmdb-token       (local dev fallback, gitignored)
 *
 * If none is present the server must refuse to start; the caller decides how
 * to report the failure. Missing credentials are a normal startup condition,
 * so the error has no stack trace.
 */

const fs = require('fs');
const path = require('path');

const TOKEN_PATH = path.join(__dirname, '..', 'config', 'tmdb-token');
const ENV_KEYS = ['TMDB_API_TOKEN', 'TMDB_READ_ACCESS_TOKEN'];

const TOKEN_MISSING_MESSAGE =
  'TMDB-токен не найден: задай TMDB_API_TOKEN (read access token v4) в окружении';

let cachedToken = null;
let cachedSource = null;

function fromEnv() {
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim()) {
      return { token: value.trim(), source: key };
    }
  }
  return null;
}

function fromFile() {
  try {
    const value = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (value) return { token: value, source: 'file' };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[config] Не удалось прочитать ${TOKEN_PATH}: ${err.message}`);
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

module.exports = {
  TOKEN_PATH,
  TOKEN_MISSING_MESSAGE,
  loadTmdbToken,
  getTmdbToken: loadTmdbToken,
  tmdbTokenSource,
};
