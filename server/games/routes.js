'use strict';

/**
 * `/api/games/*` router (M1). Mounted under the existing auth gate in
 * server/index.js, exactly like `/api/books`.
 *
 *   GET  /api/games/profiles
 *   POST /api/games/import            { vanityOrId64, label?, force? }
 *   POST /api/games/import/steam      { steamid64 | vanityUrl, label?, force? }
 *   GET  /api/games/import/:jobId
 *   GET  /api/games/import/status?id=…
 *   GET  /api/games/stats?profile=steam-<steamid64>&includeFree=0|1&includeDlc=0|1
 *   GET  /api/games/achievements?profile=…&appid=…&refresh=0|1
 *   GET  /api/games/game/:appid?profile=…
 *
 * Query contract is strict: an unknown parameter is a 400
 * `unexpected_parameter`, never a silent ignore (same rule as books).
 */

const express = require('express');

const { HttpError } = require('../upload');
const config = require('../config');
const steam = require('./steam');
const gameCache = require('./game-cache');
const importJobs = require('./import');
const { buildGamesStatsFromCache, profileSummary, minutesToHours } = require('./stats');

const STEAM_ERROR_STATUS = {
  invalid_steamid: 400,
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
};

function mapError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof steam.SteamError) {
    const status = STEAM_ERROR_STATUS[err.code] || 502;
    const mapped = new HttpError(status, err.message, err.code);
    if (err.retryAt) mapped.retryAt = err.retryAt;
    return mapped;
  }
  return err;
}

function assertOnlyParams(req, allowed, endpoint) {
  const keys = Object.keys(req.query || {});
  const extra = keys.filter((key) => !allowed.includes(key));
  if (!extra.length) return;
  throw new HttpError(
    400,
    `Unexpected query parameter(s) for ${endpoint}: ${extra.map((key) => `"${key}"`).join(', ')}. ` +
      `Accepted: ${allowed.map((key) => `"${key}"`).join(', ')}.`,
    'unexpected_parameter'
  );
}

function parseBoolParam(raw, name, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new HttpError(400, `Query parameter "${name}" must be 0 or 1.`, `invalid_${name}`);
}

function parseForce(raw) {
  if (raw == null || String(raw).trim() === '') return false;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new HttpError(400, 'Parameter "force" must be 0 or 1.', 'invalid_force');
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

function keyInfo() {
  const configured = Boolean(config.loadSteamKey());
  return { configured, source: configured ? config.steamKeySource() : null };
}

function createRouter(deps = {}) {
  const client = deps.client || steam.createClient();
  const importer = deps.importer || importJobs;
  const router = express.Router();

  /* ------------------------- profiles ------------------------- */

  router.get('/profiles', (req, res) => {
    const profiles = gameCache.listProfiles().map((entry) => {
      const profile = gameCache.getProfile(entry.userKey);
      const library = gameCache.getLibrary(entry.userKey);
      return {
        ...entry,
        summary: profileSummary(profile, library),
      };
    });
    res.status(200).json({
      profiles,
      connected: ['steam'],
      availableProfileKeys: profiles.map((entry) => entry.key),
      // Boolean only: the key value is never exposed.
      steamKey: keyInfo(),
      cacheDir: gameCache.GAMES_CACHE_DIR,
      libraryTtlHours: Math.round(gameCache.libraryTtlMs() / 3600000),
    });
  });

  /* ------------------------- import -------------------------- */

  function startFromRequest(req, res) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const rawTarget =
      body.vanityOrId64 != null
        ? body.vanityOrId64
        : body.steamid64 != null
          ? body.steamid64
          : body.vanityUrl != null
            ? body.vanityUrl
            : body.vanity != null
              ? body.vanity
              : null;
    if (rawTarget == null || String(rawTarget).trim() === '') {
      throw new HttpError(
        400,
        'Body must contain "vanityOrId64" (steamid64, vanity name, or a steamcommunity profile URL).',
        'target_required'
      );
    }
    const force = parseForce(body.force != null ? body.force : req.query.force);
    const label =
      typeof body.label === 'string' && body.label.trim()
        ? body.label.trim().slice(0, 80)
        : null;
    const job = importer.startImport(rawTarget, { client, force, label });
    const created = job.status === 'running' && !job.reused && job.stage === 'queued';
    res.status(created ? 201 : 200).json(job);
  }

  router.post('/import', (req, res, next) => {
    try {
      startFromRequest(req, res);
    } catch (err) {
      next(mapError(err));
    }
  });

  router.post('/import/steam', (req, res, next) => {
    try {
      startFromRequest(req, res);
    } catch (err) {
      next(mapError(err));
    }
  });

  router.get('/import/status', (req, res, next) => {
    try {
      const id = req.query.id;
      if (id == null || String(id).trim() === '') {
        throw new HttpError(400, 'Query parameter "id" is required.', 'job_id_required');
      }
      const status = importer.getStatus(String(id).trim());
      if (!status) throw new HttpError(404, 'Unknown import job id.', 'unknown_job');
      res.status(200).json(status);
    } catch (err) {
      next(mapError(err));
    }
  });

  router.get('/import/:jobId', (req, res, next) => {
    try {
      const status = importer.getStatus(req.params.jobId);
      if (!status) throw new HttpError(404, 'Unknown import job id.', 'unknown_job');
      res.status(200).json(status);
    } catch (err) {
      next(mapError(err));
    }
  });

  /* --------------------------- stats -------------------------- */

  router.get('/stats', (req, res, next) => {
    try {
      assertOnlyParams(req, ['profile', 'includeFree', 'includeDlc'], 'GET /api/games/stats');
      const includeFree = parseBoolParam(req.query.includeFree, 'includeFree', true);
      const includeDlc = parseBoolParam(req.query.includeDlc, 'includeDlc', false);
      const scope = resolveProfileOrThrow(req.query.profile);
      const stats = buildGamesStatsFromCache(scope.parsed.key, { includeFree, includeDlc });
      if (!stats) {
        throw new HttpError(
          400,
          `"profile": no library snapshot for ${scope.parsed.key}; run the import first.`,
          'profile_not_imported'
        );
      }
      res.set('X-Games-Build-Ms', String(stats.meta.buildMs));
      res.status(200).json(stats);
    } catch (err) {
      next(mapError(err));
    }
  });

  /* ----------------------- achievements ----------------------- */

  function globalPercentFor(global, apiname) {
    if (!global || !global.byName || !apiname) return null;
    const direct = global.byName[apiname];
    if (direct != null) return direct;
    return global.byName[String(apiname).toLowerCase()] ?? null;
  }

  router.get('/achievements', async (req, res, next) => {
    try {
      assertOnlyParams(
        req,
        ['profile', 'appid', 'refresh'],
        'GET /api/games/achievements'
      );
      const scope = resolveProfileOrThrow(req.query.profile);
      const appid = Number(req.query.appid);
      if (!Number.isInteger(appid) || appid <= 0) {
        throw new HttpError(400, 'Query parameter "appid" must be a positive integer.', 'invalid_appid');
      }
      const game = (scope.library.games || []).find((entry) => entry.appid === appid) || null;
      const refresh = parseBoolParam(req.query.refresh, 'refresh', false);
      const cached = gameCache.getAchievements(scope.parsed.userKey, appid);
      let doc = cached;
      let fetched = false;
      if (!doc || refresh || !gameCache.isFresh(doc, gameCache.achievementsTtlMs())) {
        doc = await client.getAchievements(scope.parsed.userKey, appid);
        doc = {
          ...doc,
          fetchedAt: new Date().toISOString(),
        };
        await gameCache.saveAchievements(scope.parsed.userKey, appid, doc);
        fetched = true;
      }

      let global = gameCache.getGlobal(appid);
      let globalFetched = false;
      let globalError = null;
      if (!global || !gameCache.isFresh(global, gameCache.globalTtlMs())) {
        try {
          const fresh = await client.getGlobalPercentages(appid);
          global = { ...fresh, fetchedAt: new Date().toISOString() };
          await gameCache.saveGlobal(appid, global);
          globalFetched = true;
        } catch (err) {
          globalError = (err && err.code) || 'global_failed';
        }
      }

      const items = (doc.achievements || []).map((entry) => ({
        apiname: entry.apiname,
        name: entry.name,
        description: entry.description,
        achieved: entry.achieved,
        unlockTimestamp: entry.unlockTimestamp,
        unlockAt: entry.unlockAt,
        icon: entry.achieved ? entry.iconOpen || entry.iconClosed : entry.iconClosed || entry.iconOpen,
        globalPercent: globalPercentFor(global, entry.apiname),
      }));
      const rareUnlocked = items.filter(
        (entry) => entry.achieved && entry.globalPercent != null && entry.globalPercent < 5
      ).length;
      res.status(200).json({
        profile: scope.parsed.key,
        appid,
        inLibrary: Boolean(game),
        name: (game && game.name) || doc.gameName || null,
        gameName: doc.gameName || null,
        hoursPlayedStats: doc.statsHoursPlayed,
        unlocked: doc.unlockedCount,
        total: doc.totalCount,
        percent: doc.totalCount ? Math.round((doc.unlockedCount / doc.totalCount) * 1000) / 10 : 0,
        rareUnlocked,
        rareThresholdPercent: 5,
        items,
        source: 'steam-community',
        fetched,
        fetchedAt: doc.fetchedAt || null,
        globalFetched,
        globalAvailable: Boolean(global),
        globalFetchedAt: global ? global.fetchedAt || null : null,
        globalError,
      });
    } catch (err) {
      next(mapError(err));
    }
  });

  /* ------------------------ game card ------------------------- */

  router.get('/game/:appid', (req, res, next) => {
    try {
      assertOnlyParams(req, ['profile'], 'GET /api/games/game/:appid');
      const scope = resolveProfileOrThrow(req.query.profile);
      const appid = Number(req.params.appid);
      if (!Number.isInteger(appid) || appid <= 0) {
        throw new HttpError(400, 'Path parameter "appid" must be a positive integer.', 'invalid_appid');
      }
      const game = (scope.library.games || []).find((entry) => entry.appid === appid);
      if (!game) {
        throw new HttpError(
          404,
          `App ${appid} is not in the ${scope.parsed.key} library.`,
          'game_not_in_library'
        );
      }
      const cached = gameCache.getAchievements(scope.parsed.userKey, appid);
      const achievements = cached
        ? {
            unlocked: cached.unlockedCount,
            total: cached.totalCount,
            percent: cached.totalCount
              ? Math.round((cached.unlockedCount / cached.totalCount) * 1000) / 10
              : 0,
            fetchedAt: cached.fetchedAt || null,
            items: (cached.achievements || []).map((entry) => ({
              apiname: entry.apiname,
              name: entry.name,
              description: entry.description,
              achieved: entry.achieved,
              unlockTimestamp: entry.unlockTimestamp,
              unlockAt: entry.unlockAt,
            })),
          }
        : null;
      res.status(200).json({
        profile: scope.parsed.key,
        appid,
        name: game.name || null,
        hours: minutesToHours(game.playtime_forever),
        hours2w: game.playtime_2weeks ? minutesToHours(game.playtime_2weeks) : 0,
        lastPlayed: Number(game.rtime_last_played)
          ? new Date(Number(game.rtime_last_played) * 1000).toISOString()
          : null,
        iconUrl: game.img_icon_url
          ? `https://media.steampowered.com/steamcommunity/public/images/apps/${appid}/${game.img_icon_url}.jpg`
          : null,
        achievements,
        // M2/M3: store appdetails, personnel and external links.
        details: null,
        personnel: null,
        links: {
          steam: `https://store.steampowered.com/app/${appid}`,
          steamdb: `https://steamdb.info/app/${appid}/`,
        },
        meta: {
          achievementsCached: Boolean(cached),
          pending: ['details', 'personnel', 'links.wikidata', 'links.igdb'],
        },
      });
    } catch (err) {
      next(mapError(err));
    }
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
