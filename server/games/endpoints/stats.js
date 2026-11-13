'use strict';

const { HttpError, mapDomainError } = require('../../core/errors');
const { assertOnlyParams, parseBoolParam, parseMinHours } = require('../../core/params');
const enrichJobs = require('../enrich');
const secondaryDetails = require('../secondary-details');
const { buildGamesStatsFromCache } = require('../stats');

function register(router, ctx) {
  const { deps, errorProfile, resolveProfileOrThrow } = ctx;

  router.get('/secondary-details/status', (req, res, next) => {
    try {
      assertOnlyParams(
        req,
        ['profile'],
        'GET /api/games/secondary-details/status'
      );
      const scope = resolveProfileOrThrow(req.query.profile);
      res.status(200).json(secondaryDetails.statusForOwner(scope.parsed.key));
    } catch (err) {
      next(mapDomainError(err, errorProfile));
    }
  });

  router.get('/stats', (req, res, next) => {
    try {
      assertOnlyParams(
        req,
        ['profile', 'includeFree', 'includeDlc', 'minHours'],
        'GET /api/games/stats'
      );
      const includeFree = parseBoolParam(req.query.includeFree, 'includeFree', true);
      const includeDlc = parseBoolParam(req.query.includeDlc, 'includeDlc', false);
      const minHours = parseMinHours(req.query.minHours, 0);
      const scope = resolveProfileOrThrow(req.query.profile);
      const stats = buildGamesStatsFromCache(scope.parsed.key, {
        includeFree,
        includeDlc,
        minHours,
        enrichRunning: enrichJobs.isRunning(scope.parsed.key),
      });
      if (!stats) {
        throw new HttpError(
          400,
          `"profile": no library snapshot for ${scope.parsed.key}; run the import first.`,
          'profile_not_imported'
        );
      }
      if (deps.secondaryDetailsKick !== false) {
        try {
          secondaryDetails.kickFromStats(
            scope.parsed.key,
            stats.meta && stats.meta.secondaryDetails,
            { client: deps.secondaryDetailsClient || undefined }
          );
          if (stats.meta && stats.meta.secondaryDetails) {
            stats.meta.secondaryDetails.running = secondaryDetails.runningFor(
              scope.parsed.key
            );
          }
        } catch (err) {
        }
      }
      res.set('X-Games-Build-Ms', String(stats.meta.buildMs));
      res.status(200).json(stats);
    } catch (err) {
      next(mapDomainError(err, errorProfile));
    }
  });
}

module.exports = { register };
