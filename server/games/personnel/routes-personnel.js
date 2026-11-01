'use strict';

/**
 * `/api/games/personnel` + `POST /api/games/override` (M3, ИГРЫ §3.8/§5.3/§5.5).
 *
 * Self-contained router: the integration round mounts it under the existing
 * auth gate next to the M1 games router, e.g.
 *
 *   app.use('/api/games', require('./games/personnel/routes-personnel'));
 *
 * It is deliberately NOT wired into `server/games/routes.js` or
 * `server/index.js` in this round (the brief forbids touching `stats.js` and
 * the frontend; the orchestrator merges the wire-up after M2 lands).
 *
 *   GET  /api/games/personnel?profile=steam-<steamid64>&role=…&sort=…
 *   POST /api/games/override   { type, action, from, to }
 *
 * Query contract is strict, like every other games route: an unknown parameter
 * is a 400 `unexpected_parameter`, never a silent ignore.
 *
 * The payload is built from caches only — this route never waits for WDQS or
 * MobyGames. When details/credits are missing it reports honest `pending`
 * counters and `coverage.percent` (the «Кредиты: N%» badge), never fabricated
 * zeros (ИГРЫ §7.2).
 */

const express = require('express');

const { HttpError } = require('../../upload');
const gameCache = require('../game-cache');
const personnel = require('./personnel');

const ENDPOINT = 'GET /api/games/personnel';

function mapError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof personnel.PersonnelError) {
    return new HttpError(err.status || 400, err.message, err.code);
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

/** Exactly one cached games profile (same contract as `/api/games/stats`). */
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
  return { parsed, profile, library };
}

function createRouter(deps = {}) {
  const builder = deps.buildPersonnel || personnel.buildPersonnel;
  const applyOverride = deps.applyOverride || personnel.applyOverride;
  const router = express.Router();

  router.get('/personnel', (req, res, next) => {
    try {
      assertOnlyParams(req, ['profile', 'role', 'sort', 'limit'], ENDPOINT);
      const scope = resolveProfileOrThrow(req.query.profile);
      const role = personnel.normalizeRole(req.query.role);
      const sort = personnel.normalizeSort(req.query.sort);
      let gamesLimit = 5;
      if (req.query.limit != null && String(req.query.limit).trim() !== '') {
        const parsed = Number(req.query.limit);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
          throw new HttpError(
            400,
            'Query parameter "limit" must be an integer between 1 and 50.',
            'invalid_limit'
          );
        }
        gamesLimit = parsed;
      }
      const payload = builder(scope.parsed.key, { role, sort, gamesLimit });
      if (!payload) {
        throw new HttpError(
          400,
          `"profile": no library snapshot for ${scope.parsed.key}; run the import first.`,
          'profile_not_imported'
        );
      }
      res.set('X-Games-Personnel-Build-Ms', String(payload.meta.buildMs));
      res.status(200).json(payload);
    } catch (err) {
      next(mapError(err));
    }
  });

  router.post('/override', async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const result = await applyOverride(body);
      res.status(200).json({
        ok: true,
        type: result.type,
        action: result.action,
        from: result.from,
        to: result.to,
        overrides: {
          updatedAt: result.overrides.updatedAt,
          merges: result.overrides.manual.merges.length,
          aliases: result.overrides.manual.aliases.length,
          splits: result.overrides.manual.splits.length,
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
module.exports.resolveProfileOrThrow = resolveProfileOrThrow;
