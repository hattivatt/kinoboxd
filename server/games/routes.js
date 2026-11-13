'use strict';

const express = require('express');

const { HttpError, mapDomainError } = require('../core/errors');
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

const GAMES_ERROR_PROFILE = {
  rules: [
    {
      is: [steam.SteamError, store.StoreError, spy.SpyError],
      statuses: STEAM_ERROR_STATUS,
      defaultStatus: 502,
    },
  ],
  fallback: { code: 'games_error' },
  retryAt: true,
};

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
  const ctx = {
    deps,
    client,
    importer,
    storeClient,
    errorProfile: GAMES_ERROR_PROFILE,
    resolveProfileOrThrow,
  };

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
