'use strict';

const { mapDomainError } = require('../../../core/errors');
const { HttpError } = require('../../../upload');
const epicLayer = require('../../secondary/epic');
const { assertOnlyParams, parseAccountId, parseOwner } = require('./params');

function register(router, ctx) {
  const { errorProfile } = ctx;

  router.get('/epic/exported', async (req, res, next) => {
    try {
      assertOnlyParams(req, ['owner', 'accountId'], 'GET /api/games/epic/exported');
      const owner = parseOwner(req.query.owner);
      const accountId = parseAccountId(req.query.accountId);
      if (!owner && !accountId) {
        throw new HttpError(
          400,
          'Query parameter "owner" (steam-<steamid64>) or "accountId" is required.',
          'owner_required'
        );
      }
      const layer = await epicLayer.buildEpicLayer({ ownerKey: owner, accountId });
      res.status(200).json({
        source: 'epic',
        contractVersion: layer.contractVersion,
        owner: layer.owner,
        accountId: layer.accountId,
        status: layer.status,
        hoursBySource: layer.hoursBySource,
        ownedBySource: layer.ownedBySource,
        summary: layer.summary,
        games: layer.exportedGames,
        meta: layer.meta,
      });
    } catch (err) {
      next(mapDomainError(err, errorProfile));
    }
  });
}

module.exports = { register };
