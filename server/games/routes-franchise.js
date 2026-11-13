'use strict';

const express = require('express');

const { HttpError, mapDomainError } = require('../core/errors');
const { assertOnlyParams, parseForce } = require('../core/params');
const gameCache = require('./game-cache');
const franchise = require('./franchise');
const aggregate = require('./franchise-aggregate');
const franchiseJobs = require('./franchise-jobs');

const ENDPOINT = 'GET /api/games/franchises';

const FRANCHISE_ERROR_PROFILE = {
  rules: [
    {
      is: franchise.FranchiseError,
      defaultStatus: 400,
      ownStatus: 'whenSet',
    },
  ],
  fallback: { code: 'games_franchise_error' },
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
  return { parsed, profile, library };
}

function annotatePending(payload, scope, deps = {}) {
  const jobs = deps.jobs || franchiseJobs;
  const key = scope.parsed.key;
  payload.pending = payload.pending || {};

  if (typeof jobs.isRunning === 'function' && jobs.isRunning(key)) {
    payload.pending.running = true;
    payload.pending.reason = 'running';
    return payload;
  }
  if (!(payload.pending.wikidata > 0) && !(payload.pending.bridge > 0) && !(payload.pending.secondary > 0)) {
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
      next(mapDomainError(err, FRANCHISE_ERROR_PROFILE));
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
      next(mapDomainError(err, FRANCHISE_ERROR_PROFILE));
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
      next(mapDomainError(err, FRANCHISE_ERROR_PROFILE));
    }
  });

  router.get('/franchise-enrich/:jobId', (req, res, next) => {
    try {
      const status = jobs.getStatus(req.params.jobId);
      if (!status) throw new HttpError(404, 'Unknown franchise job id.', 'unknown_job');
      res.status(200).json(status);
    } catch (err) {
      next(mapDomainError(err, FRANCHISE_ERROR_PROFILE));
    }
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
module.exports.resolveProfileOrThrow = resolveProfileOrThrow;
module.exports.annotatePending = annotatePending;
