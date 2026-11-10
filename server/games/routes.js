'use strict';

/**
 * `/api/games/*` router assembly (M1 import/achievements + M2 enrich). Mounted
 * under the existing auth gate in server/index.js, exactly like `/api/books`.
 *
 * The endpoint groups live in `server/games/endpoints/*.js` and are registered
 * here in this order (route order decides matching, so it must not change):
 *
 *   profiles      GET  /profiles
 *   import        POST /import, POST /import/steam, POST /refresh,
 *                 GET /import/status, GET /import/:jobId
 *   enrich        POST /enrich, GET /enrich/status, GET /enrich/:jobId
 *   stats         GET  /secondary-details/status, GET /stats
 *   achievements  GET  /achievements
 *   game          GET  /steam-art/:type/:appid, GET /game/:appid
 *
 * Query contract is strict: an unknown parameter is a 400
 * `unexpected_parameter`, never a silent ignore (same rule as books).
 */

const express = require('express');

const { HttpError } = require('../core/errors');
const gameCache = require('./game-cache');
const steam = require('./steam');
const store = require('./store');
const spy = require('./spy');
const importJobs = require('./import');
const achievements = require('./endpoints/achievements');
const enrich = require('./endpoints/enrich');
const game = require('./endpoints/game');
const imports = require('./endpoints/import');
const profiles = require('./endpoints/profiles');
const stats = require('./endpoints/stats');

const STEAM_ERROR_STATUS = {
  invalid_steamid: 400,
  steamid_mismatch: 400,
  profile_private: 400,
  library_private: 400,
  steam_key_missing: 400,
  stats_private: 400,
  stats_not_found: 404,
  steam_unreachable: 502,
  steam_rate_limited: 429,
  steam_key_invalid: 502,
  steam_forbidden: 502,
  steam_http_error: 502,
  steam_invalid_url: 400,
  store_rate_limited: 429,
  store_unreachable: 502,
  store_http_error: 502,
  store_invalid_appid: 400,
  spy_rate_limited: 429,
  spy_unreachable: 502,
  spy_http_error: 502,
  spy_invalid_appid: 400,
  reviews_rate_limited: 429,
  reviews_unreachable: 502,
  reviews_http_error: 502,
  reviews_invalid_appid: 400,
};

function mapError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof steam.SteamError || err instanceof store.StoreError) {
    const status = STEAM_ERROR_STATUS[err.code] || 502;
    const mapped = new HttpError(status, err.message, err.code);
    if (err.retryAt) mapped.retryAt = err.retryAt;
    return mapped;
  }
  if (err instanceof spy.SpyError) {
    const status = STEAM_ERROR_STATUS[err.code] || 502;
    const mapped = new HttpError(status, err.message, err.code);
    if (err.retryAt) mapped.retryAt = err.retryAt;
    return mapped;
  }
  // Job starters throw plain errors with an explicit HTTP status
  // (`invalid_profile`/`unknown_profile` from the enrich job).
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) {
    return new HttpError(err.status, err.message, err.code || 'games_error');
  }
  return err;
}

/**
 * Resolve `?profile=` to exactly one cached games profile. Mirrors the books
 * contract: missing/repeated/malformed/unknown → 400 with the available keys.
 */
function resolveProfileOrThrow(raw) {
  const value = raw == null ? '' : String(raw).trim();
  const available = gameCache.listProfiles().map((entry) => entry.key);
  const availableText = available.length ? available.join(', ') : '(none)';
  if (!value) {
    throw new HttpError(
      400,
      'Query parameter "profile" is required: exactly one token "steam-<steamid64>". ' +
        `Available: ${availableText}.`,
      'profile_required'
    );
  }
  if (/[,;]/.test(value) || /\s/.test(value)) {
    throw new HttpError(
      400,
      `"profile" accepts exactly ONE profile (steam-<steamid64>), got: ${value}.`,
      'invalid_profile'
    );
  }
  const parsed = gameCache.parseProfileToken(value);
  if (!parsed) {
    throw new HttpError(
      400,
      `"profile": expected "steam-<steamid64>", got: ${value}. Available: ${availableText}.`,
      'invalid_profile'
    );
  }
  const profile = gameCache.getProfile(parsed.userKey);
  const library = gameCache.getLibrary(parsed.userKey);
  if (!profile || !library) {
    throw new HttpError(
      400,
      `"profile": not a cached games profile: ${value}. Available: ${availableText}.`,
      'unknown_profile'
    );
  }
  return { parsed, profile, library, available };
}

function createRouter(deps = {}) {
  const client = deps.client || steam.createClient();
  const importer = deps.importer || importJobs;
  const storeClient = deps.storeClient || null;
  const router = express.Router();
  const ctx = { deps, client, importer, storeClient, mapError, resolveProfileOrThrow };

  profiles.register(router);
  imports.register(router, ctx);
  enrich.register(router, ctx);
  stats.register(router, ctx);
  achievements.register(router, ctx);
  game.register(router, ctx);

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
