'use strict';

const { mapDomainError } = require('../../../core/errors');
const { HttpError } = require('../../../upload');
const { assertOnlyParams, parseAccountId, parseBool, parseOwner } = require('./params');

function register(router, ctx) {
  const { deps, store, importer, errorProfile } = ctx;

  async function startFromRequest(req, res, forceDefault) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const owner = parseOwner(body.owner != null ? body.owner : body.profile, {
      requireProfile: true,
    });
    const accountId = parseAccountId(body.accountId);
    const force = parseBool(
      body.force != null ? body.force : req.query.force,
      'force',
      forceDefault
    );
    const label =
      typeof body.label === 'string' && body.label.trim()
        ? body.label.trim().slice(0, 80)
        : null;
    const job = await importer.startImport({
      accountId: accountId || undefined,
      ownerKey: owner || undefined,
      force,
      label,
      client: deps.client || undefined,
      tokenStore: store,
      autoCatalog: deps.autoCatalog !== false,
      forceCatalog: Boolean(deps.forceCatalog),
    });
    const created = job.status === 'running' && !job.reused && job.stage === 'queued';
    res.status(created ? 201 : 200).json(job);
  }

  router.post('/epic/import', async (req, res, next) => {
    try {
      assertOnlyParams(req, ['force'], 'POST /api/games/epic/import');
      await startFromRequest(req, res, false);
    } catch (err) {
      next(mapDomainError(err, errorProfile));
    }
  });

  router.post('/epic/refresh', async (req, res, next) => {
    try {
      assertOnlyParams(req, [], 'POST /api/games/epic/refresh');
      await startFromRequest(req, res, true);
    } catch (err) {
      next(mapDomainError(err, errorProfile));
    }
  });

  router.get('/epic/import/status', (req, res, next) => {
    try {
      assertOnlyParams(req, ['id'], 'GET /api/games/epic/import/status');
      const id = req.query.id;
      if (id == null || String(id).trim() === '') {
        throw new HttpError(400, 'Query parameter "id" is required.', 'job_id_required');
      }
      const status = importer.getStatus(String(id).trim());
      if (!status) throw new HttpError(404, 'Unknown Epic import job id.', 'unknown_job');
      res.status(200).json(status);
    } catch (err) {
      next(mapDomainError(err, errorProfile));
    }
  });

  router.get('/epic/import/:jobId', (req, res, next) => {
    try {
      const status = importer.getStatus(req.params.jobId);
      if (!status) throw new HttpError(404, 'Unknown Epic import job id.', 'unknown_job');
      res.status(200).json(status);
    } catch (err) {
      next(mapDomainError(err, errorProfile));
    }
  });
}

module.exports = { register };
