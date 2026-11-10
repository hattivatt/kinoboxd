'use strict';

const { HttpError, mapDomainError } = require('../../core/errors');
const { parseForce } = require('../../core/params');
const enrichJobs = require('../enrich');
const franchiseJobs = require('../franchise-jobs');
const personnelJobs = require('../personnel/jobs');

function register(router, ctx) {
  const { deps, storeClient, errorProfile, resolveProfileOrThrow } = ctx;

  /* --------------------------- enrich ------------------------- */

  /**
   * `POST /api/games/enrich` — fetch metadata for the library of one profile.
   * Body: `{ profile, force?, phases?, recheckDays? }` (query fallback for
   * curl). `phases` is `details` | `spy` | `reviews` | `all` (comma-separated
   * or an array); the default is `all`, i.e. run whatever is missing/stale.
   * Resumable: the cache is the progress; `force` re-fetches all.
   */
  router.post('/enrich', (req, res, next) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const requested = body.profile != null ? body.profile : req.query.profile;
      const scope = resolveProfileOrThrow(requested);
      const force = parseForce(body.force != null ? body.force : req.query.force);
      const rawPhases =
        body.phases != null
          ? body.phases
          : body.phase != null
            ? body.phase
            : req.query.phases != null
              ? req.query.phases
              : req.query.phase;
      // Unknown phase names are a 400 (`invalid_phases`), never a silent no-op.
      const phases = enrichJobs.parsePhases(rawPhases, 'all');
      let recheckDays;
      const rawRecheck = body.recheckDays != null ? body.recheckDays : req.query.recheckDays;
      if (rawRecheck != null && String(rawRecheck).trim() !== '') {
        const value = Number(rawRecheck);
        if (!Number.isFinite(value) || value < 0) {
          throw new HttpError(
            400,
            'Parameter "recheckDays" must be a non-negative number of days.',
            'invalid_recheckDays'
          );
        }
        recheckDays = value;
      }
      const job = enrichJobs.startEnrich(scope.parsed.key, {
        force,
        recheckDays,
        phases,
        client: storeClient || undefined,
        spyClient: deps.spyClient || undefined,
        reviewsClient: deps.reviewsClient || undefined,
      });
      // Credits follow the details: the personnel pass waits for this enrich
      // job (`waitForEnrich`), so the widget gets people without a second
      // manual step (ИГРЫ §2.4 fix).
      let personnelJob = null;
      if (deps.autoPersonnel !== false) {
        personnelJob = personnelJobs.kickQuietly(scope.parsed.key, {
          ...(deps.personnelOptions || {}),
          waitForEnrich: true,
          // Explicit «Обогатить» must not be swallowed by the lazy cooldown.
          forceKick: true,
        });
      }
      // M4-B: franchises/release years follow the same explicit action and
      // share the WDQS lock with the credits pass.
      let franchiseJob = null;
      if (deps.autoFranchise !== false) {
        franchiseJob = franchiseJobs.kickQuietly(scope.parsed.key, {
          ...(deps.franchiseOptions || {}),
          waitForEnrich: true,
          forceKick: true,
        });
      }
      const created = job.status === 'running' && job.stage === 'queued';
      res.status(created ? 202 : 200).json({
        ...job,
        personnelJobId: personnelJob && personnelJob.id ? personnelJob.id : null,
        personnelSkipped: personnelJob ? personnelJob.skipped || null : null,
        franchiseJobId: franchiseJob && franchiseJob.id ? franchiseJob.id : null,
        franchiseSkipped: franchiseJob ? franchiseJob.skipped || null : null,
      });
    } catch (err) {
      next(mapDomainError(err, errorProfile));
    }
  });

  router.get('/enrich/status', (req, res, next) => {
    try {
      const id = req.query.id;
      if (id == null || String(id).trim() === '') {
        throw new HttpError(400, 'Query parameter "id" is required.', 'job_id_required');
      }
      const status = enrichJobs.getStatus(String(id).trim());
      if (!status) throw new HttpError(404, 'Unknown enrich job id.', 'unknown_job');
      res.status(200).json(status);
    } catch (err) {
      next(mapDomainError(err, errorProfile));
    }
  });

  router.get('/enrich/:jobId', (req, res, next) => {
    try {
      const status = enrichJobs.getStatus(req.params.jobId);
      if (!status) throw new HttpError(404, 'Unknown enrich job id.', 'unknown_job');
      res.status(200).json(status);
    } catch (err) {
      next(mapDomainError(err, errorProfile));
    }
  });
}

module.exports = { register };
