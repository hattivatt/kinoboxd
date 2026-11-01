'use strict';

/**
 * `/api/games/franchises` + `/api/games/franchise-enrich` (M4-B, ИГРЫ §2.5/§4.4).
 *
 *   GET  /api/games/franchises?profile=steam-<steamid64>
 *   POST /api/games/franchise-enrich { profile, force? }
 *   GET  /api/games/franchise-enrich/status?id=…
 *   GET  /api/games/franchise-enrich/:jobId
 *
 * Same contract style as every other games route: exactly one profile token,
 * unknown query parameters are a 400 `unexpected_parameter`, and the GET never
 * waits for WDQS — it answers from `links/`, `details/` and the library, then
 * starts the franchise pass fire-and-forget when something is pending
 * (`pending.running` / `pending.reason`), exactly like the M3 personnel route.
 *
 * The payload is bottom-up and stays in this route (the big `stats.js` merge
 * is a separate integration step): franchises are grouped by `franchiseKey`
 * (`wd:Q…` from P179, `title:<slug>` for the low-confidence heuristic) and
 * carry `gamesCount`, `hoursSum`, `yearsSpread`, `appids[]`, plus honest
 * coverage (`coverage.links`, `coverage.releaseYears`) and pending counters.
 */

const express = require('express');

const { HttpError } = require('../upload');
const gameCache = require('./game-cache');
const franchise = require('./franchise');
const aggregate = require('./franchise-aggregate');
const franchiseJobs = require('./franchise-jobs');

const ENDPOINT = 'GET /api/games/franchises';

function mapError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof franchise.FranchiseError) {
    return new HttpError(err.status || 400, err.message, err.code);
  }
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) {
    return new HttpError(err.status, err.message, err.code || 'games_franchise_error');
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

function parseForce(raw) {
  if (raw == null || String(raw).trim() === '') return false;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new HttpError(400, 'Parameter "force" must be 0 or 1.', 'invalid_force');
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
  const jobs = deps.jobs || franchiseJobs;
  const key = scope.parsed.key;
  payload.pending = payload.pending || {};

  if (typeof jobs.isRunning === 'function' && jobs.isRunning(key)) {
    payload.pending.running = true;
    payload.pending.reason = 'running';
    return payload;
  }
  if (!(payload.pending.wikidata > 0) && !(payload.pending.bridge > 0)) {
    payload.pending.reason = null;
    return payload;
  }
  if (deps.autoFranchise === false) {
    payload.pending.reason = 'auto_disabled';
    return payload;
  }
  const status = jobs.wikidataStatus
    ? jobs.wikidataStatus(deps.franchiseOptions || {})
    : { state: 'ready' };
  if (status.state === 'disabled') {
    payload.pending.reason = 'sources_disabled';
    return payload;
  }
  if (status.state === 'cooldown') {
    payload.pending.reason = 'wikidata_cooldown';
    payload.pending.wikidataDisabledUntil = status.disabledUntil || null;
    return payload;
  }

  let kick = null;
  try {
    kick = jobs.kickQuietly(key, deps.franchiseOptions || {});
  } catch (err) {
    payload.pending.reason = 'kick_failed';
    return payload;
  }
  if (kick && kick.id) {
    payload.pending.running = true;
    payload.pending.jobId = kick.id;
    payload.pending.reason = 'started';
  } else {
    payload.pending.reason = (kick && kick.skipped) || 'not_fetched';
  }
  return payload;
}

function createRouter(deps = {}) {
  const builder = deps.buildFranchises || aggregate.buildFranchises;
  const jobs = deps.jobs || franchiseJobs;
  const router = express.Router();

  router.get('/franchises', (req, res, next) => {
    try {
      assertOnlyParams(req, ['profile'], ENDPOINT);
      const scope = resolveProfileOrThrow(req.query.profile);
      const payload = builder(scope.parsed.key, deps.aggregateOptions || {});
      if (!payload) {
        throw new HttpError(
          400,
          `"profile": no library snapshot for ${scope.parsed.key}; run the import first.`,
          'profile_not_imported'
        );
      }
      annotatePending(payload, scope, deps);
      res.set('X-Games-Franchises-Build-Ms', String(payload.meta.buildMs));
      res.set('X-Games-Franchises-Pending', String(payload.pending.wikidata));
      res.status(200).json(payload);
    } catch (err) {
      next(mapError(err));
    }
  });

  router.post('/franchise-enrich', (req, res, next) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const requested = body.profile != null ? body.profile : req.query.profile;
      const scope = resolveProfileOrThrow(requested);
      const force = parseForce(body.force != null ? body.force : req.query.force);
      const job = jobs.startFranchise(scope.parsed.key, {
        ...(deps.franchiseOptions || {}),
        force,
        waitForEnrich: true,
        forceKick: true,
      });
      const created = job.status === 'running' && job.stage === 'queued';
      res.status(created ? 202 : 200).json(job);
    } catch (err) {
      next(mapError(err));
    }
  });

  router.get('/franchise-enrich/status', (req, res, next) => {
    try {
      assertOnlyParams(req, ['id'], 'GET /api/games/franchise-enrich/status');
      const id = req.query.id;
      if (id == null || String(id).trim() === '') {
        throw new HttpError(400, 'Query parameter "id" is required.', 'job_id_required');
      }
      const status = jobs.getStatus(String(id).trim());
      if (!status) throw new HttpError(404, 'Unknown franchise job id.', 'unknown_job');
      res.status(200).json(status);
    } catch (err) {
      next(mapError(err));
    }
  });

  router.get('/franchise-enrich/:jobId', (req, res, next) => {
    try {
      const status = jobs.getStatus(req.params.jobId);
      if (!status) throw new HttpError(404, 'Unknown franchise job id.', 'unknown_job');
      res.status(200).json(status);
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
