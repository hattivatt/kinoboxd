'use strict';

const { HttpError } = require('../../core/errors');
const { parseForce } = require('../../core/params');

function register(router, ctx) {
  const { deps, client, importer, storeClient, mapError, resolveProfileOrThrow } = ctx;

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
    const job = importer.startImport(rawTarget, {
      client,
      force,
      label,
      autoEnrich: deps.autoEnrich !== false,
      autoPersonnel: deps.autoPersonnel !== false,
      autoFranchise: deps.autoFranchise !== false,
      personnelOptions: deps.personnelOptions,
      franchiseOptions: deps.franchiseOptions,
      enrichClient: storeClient || undefined,
      // M4: the automatic pass is details+spy; `reviews` stays manual.
      enrichPhases: deps.enrichPhases,
      spyClient: deps.spyClient || undefined,
    });
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

  /**
   * `POST /api/games/refresh` — re-read the library/achievements of an already
   * imported profile (ИГРЫ-АРХИТЕКТУРА §5). Always `force`: a manual refresh
   * exists to bypass the TTLs, so it never returns the cached snapshot.
   * Body: `{ profile: "steam-<steamid64>" }` (query fallback for curl).
   */
  router.post('/refresh', (req, res, next) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const requested = body.profile != null ? body.profile : req.query.profile;
      const scope = resolveProfileOrThrow(requested);
      const job = importer.startImport(scope.parsed.userKey, {
        client,
        force: true,
        autoEnrich: deps.autoEnrich !== false,
        autoPersonnel: deps.autoPersonnel !== false,
        autoFranchise: deps.autoFranchise !== false,
        personnelOptions: deps.personnelOptions,
        franchiseOptions: deps.franchiseOptions,
        enrichClient: storeClient || undefined,
        enrichPhases: deps.enrichPhases,
        spyClient: deps.spyClient || undefined,
      });
      const created = job.status === 'running' && !job.reused && job.stage === 'queued';
      res.status(created ? 201 : 200).json(job);
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
}

module.exports = { register };
