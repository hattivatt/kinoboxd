'use strict';

const { HttpError, mapDomainError } = require('../../core/errors');
const { assertOnlyParams, parseBoolParam, parseMinHours } = require('../../core/params');
const enrichJobs = require('../enrich');
const secondaryDetails = require('../secondary-details');
const { buildGamesStatsFromCache } = require('../stats');

function register(router, ctx) {
  const { deps, errorProfile, resolveProfileOrThrow } = ctx;

  /* --------------------------- stats -------------------------- */

  /**
   * `GET /api/games/secondary-details/status?profile=…` — the owner-facing
   * diagnostic for «вне Steam» metadata (M6d). Answers only from the cache and
   * the job/breaker state, never with a network request:
   *
   *   { resolved, total, running, bySource {gog, epic}, slugless[],
   *     lastErrors[] (max 5), cooldownUntil, breakers, kick, lastRunAt }
   *
   * `resolved < total` means some store page is still missing; `slugless` names
   * the Epic works the job could not even address (title probe failed).
   */
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
      // Default 0: only games the owner actually played (M5-B requirement).
      // `minHours=-1` brings the 0-hour backlog back.
      const minHours = parseMinHours(req.query.minHours, 0);
      const scope = resolveProfileOrThrow(req.query.profile);
      const stats = buildGamesStatsFromCache(scope.parsed.key, {
        includeFree,
        includeDlc,
        minHours,
        // The UI polls `summary.metadata.running`; the flag comes from the
        // in-process enrich job registry (no extra cache read, no request).
        enrichRunning: enrichJobs.isRunning(scope.parsed.key),
      });
      if (!stats) {
        throw new HttpError(
          400,
          `"profile": no library snapshot for ${scope.parsed.key}; run the import first.`,
          'profile_not_imported'
        );
      }
      // M6d lazy kick: the import-time kick alone is not enough — an Epic/GOG
      // library imported **before** the details job existed never got one, and
      // the «Вне Steam» card stayed empty forever. Coalesced (`kickGate`),
      // fire-and-forget (the response is never blocked) and disable-able for
      // tests. `running` is re-read so the very first answer already says so.
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
          // A kick must never break the stats answer.
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
