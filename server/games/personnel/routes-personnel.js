'use strict';

/**
 * `/api/games/personnel` + `POST /api/games/override` (M3, ИГРЫ §3.8/§5.3/§5.5).
 *
 *   GET  /api/games/personnel?profile=steam-<steamid64>&role=…&sort=…
 *   POST /api/games/override   { type, action, from, to }
 *
 * Query contract is strict, like every other games route: an unknown parameter
 * is a 400 `unexpected_parameter`, never a silent ignore.
 *
 * The payload is built from caches only — this route never *waits* for WDQS or
 * MobyGames. But it is also the only reader of `personnel/<appid>.json`, so it
 * owns the lazy trigger: when credits are still missing and no pass is in
 * flight, it starts the personnel job fire-and-forget and says so
 * (`pending.running`/`pending.reason`). Without that kick the cache had no
 * writer in production and composers/designers never arrived (fix 01.11.2026,
 * ИГРЫ §2.4). The answer is never blocked: the next request sees the credits.
 *
 * When details/credits are missing it reports honest `pending` counters and
 * `coverage.percent` (the «Кредиты: N%» badge), never fabricated zeros
 * (ИГРЫ §7.2). `coverage.wikidata` carries the «WD: не запущено / недоступно»
 * badge with its reason, so the UI never has to guess why a role is empty.
 */

const express = require('express');

const { HttpError } = require('../core/errors');
const { assertOnlyParams } = require('../core/params');
const gameCache = require('../game-cache');
const enrichJobs = require('../enrich');
const personnel = require('./personnel');
const personnelJobs = require('./jobs');

const ENDPOINT = 'GET /api/games/personnel';

function mapError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof personnel.PersonnelError) {
    return new HttpError(err.status || 400, err.message, err.code);
  }
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) {
    return new HttpError(err.status, err.message, err.code || 'games_personnel_error');
  }
  return err;
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

/**
 * Fill `pending.running`/`pending.reason` and start the lazy pass when it can
 * help. Never throws: a failed kick only changes the reported reason.
 */
function annotatePending(payload, scope, deps = {}) {
  const jobs = deps.jobs || personnelJobs;
  const enrich = deps.enrichJobs || enrichJobs;
  const key = scope.parsed.key;
  payload.pending = payload.pending || {};

  const personnelRunning = typeof jobs.isRunning === 'function' && jobs.isRunning(key);
  if (personnelRunning) {
    payload.pending.running = true;
    payload.pending.reason = 'running';
    return payload;
  }
  if (typeof enrich.isRunning === 'function' && enrich.isRunning(key)) {
    // The credits pass is started by the same import/enrich kick and waits for
    // the details chain; say so instead of «нет данных».
    payload.pending.running = true;
    payload.pending.reason = 'waiting_details';
    return payload;
  }
  // `staleLabels` is the second reason to run a pass: the credits are complete
  // but their names were built by an older label rule (§4.2), and only a
  // re-fetch repairs a truncated one. Nothing to do means no kick at all.
  if (!(payload.pending.credits > 0) && !(payload.pending.staleLabels > 0)) {
    payload.pending.reason = null;
    return payload;
  }
  if (deps.autoPersonnel === false) {
    payload.pending.reason = 'auto_disabled';
    return payload;
  }
  const gamesTotal = payload.totals ? payload.totals.games : 0;
  if (gamesTotal > 0 && payload.pending.details >= gamesTotal) {
    // No details document at all: Wikidata is asked by appid only for games
    // whose `details/<appid>.json` exists, so a pass now would write nothing.
    payload.pending.reason = 'details_pending';
    return payload;
  }

  let status = null;
  try {
    status = jobs.kickQuietly(key, deps.personnelOptions || {});
  } catch (err) {
    payload.pending.reason = 'kick_failed';
    return payload;
  }
  if (status && status.id) {
    payload.pending.running = true;
    payload.pending.jobId = status.id;
    payload.pending.reason = 'started';
  } else {
    payload.pending.reason = (status && status.skipped) || 'not_fetched';
  }
  return payload;
}

function createRouter(deps = {}) {
  const builder = deps.buildPersonnel || personnel.buildPersonnel;
  const applyOverride = deps.applyOverride || personnel.applyOverride;
  const router = express.Router();

  router.get('/personnel', (req, res, next) => {
    try {
      assertOnlyParams(req, ['profile', 'role', 'sort', 'limit'], ENDPOINT);
      const scope = resolveProfileOrThrow(req.query.profile);
      // `role` is validated here for a fast 400, then passed through raw so the
      // payload can echo `roleRequested` (e.g. the old `studio` alias).
      personnel.normalizeRole(req.query.role);
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
      const payload = builder(scope.parsed.key, {
        role: req.query.role,
        sort,
        gamesLimit,
        // Set from the in-process job registries (no extra cache read).
        running:
          (typeof (deps.jobs || personnelJobs).isRunning === 'function' &&
            (deps.jobs || personnelJobs).isRunning(scope.parsed.key)) ||
          (typeof (deps.enrichJobs || enrichJobs).isRunning === 'function' &&
            (deps.enrichJobs || enrichJobs).isRunning(scope.parsed.key)),
      });
      if (!payload) {
        throw new HttpError(
          400,
          `"profile": no library snapshot for ${scope.parsed.key}; run the import first.`,
          'profile_not_imported'
        );
      }
      annotatePending(payload, scope, deps);
      res.set('X-Games-Personnel-Build-Ms', String(payload.meta.buildMs));
      res.set('X-Games-Personnel-Pending', String(payload.pending.credits));
      res.status(200).json(payload);
    } catch (err) {
      next(mapError(err));
    }
  });

  router.get('/personnel/status', (req, res, next) => {
    try {
      assertOnlyParams(req, ['id'], 'GET /api/games/personnel/status');
      const id = req.query.id;
      if (id == null || String(id).trim() === '') {
        throw new HttpError(400, 'Query parameter "id" is required.', 'job_id_required');
      }
      const status = (deps.jobs || personnelJobs).getStatus(String(id).trim());
      if (!status) throw new HttpError(404, 'Unknown personnel job id.', 'unknown_job');
      res.status(200).json(status);
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
module.exports.annotatePending = annotatePending;
