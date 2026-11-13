'use strict';

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
const STEAM_KEY_FILE_ENV = 'KINOBOXD_STEAM_KEY_FILE';
const STEAMGRIDDB_KEY_PATH = path.join(__dirname, '..', 'config', 'steamgriddb-token');
const STEAMGRIDDB_ENV_KEYS = ['STEAMGRIDDB_API_KEY'];

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

const steamgriddb = createSecret({
  envKeys: STEAMGRIDDB_ENV_KEYS,
  file: STEAMGRIDDB_KEY_PATH,
});

function loadTmdbToken() {
  return tmdb.load();
}

function hasTmdbToken() {
  try {
    return Boolean(tmdb.load());
  } catch (err) {
    if (err && err.code === 'TMDB_TOKEN_MISSING') return false;
    throw err;
  }
}

function tmdbTokenSource() {
  return tmdb.source();
}

function loadHardcoverToken() {
  return hardcover.load();
}

function hardcoverTokenSource() {
  return hardcover.source();
}

function loadGbooksKey() {
  return gbooks.load();
}

function gbooksKeySource() {
  return gbooks.source();
}

function loadSteamKey() {
  return steam.load();
}

function steamKeySource() {
  return steam.source();
}

function loadSteamgriddbKey() {
  return steamgriddb.load();
}

function steamgriddbKeySource() {
  return steamgriddb.source();
}

function resetSteamKeyCache() {
  steam.reset();
}

module.exports = {
  TOKEN_PATH,
  TOKEN_MISSING_MESSAGE,
  loadTmdbToken,
  getTmdbToken: loadTmdbToken,
  hasTmdbToken,
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
  STEAMGRIDDB_KEY_PATH,
  loadSteamgriddbKey,
  getSteamgriddbKey: loadSteamgriddbKey,
  steamgriddbKeySource,
};
