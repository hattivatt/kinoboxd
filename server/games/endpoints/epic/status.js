'use strict';

const epicCache = require('../../epic-cache');
const epicLayer = require('../../secondary/epic');
const tokenStore = require('../../epic-token-store');
const { mapDomainError } = require('../../../core/errors');
const { assertOnlyParams, parseAccountId, parseOwner } = require('./params');

function register(router, ctx) {
  const { store, errorProfile } = ctx;

  router.get('/epic/status', async (req, res, next) => {
    try {
      assertOnlyParams(req, ['owner', 'accountId'], 'GET /api/games/epic/status');
      const owner = parseOwner(req.query.owner);
      const accountId = parseAccountId(req.query.accountId);
      if (owner || accountId) {
        const layer = await epicLayer.buildEpicLayer({
          ownerKey: owner,
          accountId,
        });
        return res.status(200).json({
          ...layer,
          games: undefined,
          exportedGames: undefined,
          gameCount: layer.games.length,
        });
      }

      const tokens = await store.listTokenAccounts();
      const tokenDocs = await store.listTokenDocs();
      const profiles = epicCache.listEpicProfiles();
      const accountIds = [...new Set([...tokens.map((t) => t.accountId), ...profiles.map((p) => p.accountId)])];
      const accounts = [];
      for (const id of accountIds) {
        const layer = await epicLayer.buildEpicLayer({ accountId: id });
        accounts.push({
          accountId: id,
          owner: layer.owner,
          displayName: layer.account ? layer.account.displayName : null,
          status: layer.status,
          summary: layer.summary,
          hoursBySource: layer.hoursBySource,
          ownedBySource: layer.ownedBySource,
          libraries: layer.libraries,
          token: layer.account ? layer.account.token : null,
        });
      }
      res.status(200).json({
        source: 'epic',
        contractVersion: epicLayer.CONTRACT_VERSION,
        configured: tokens.length > 0,
        status: tokens.length ? 'connected' : 'not_connected',
        accounts,
        tokens: tokenDocs.map((doc) => tokenStore.redactTokens(doc)),
        cacheDir: epicCache.CACHE_DIR,
        libraryTtlHours: Math.round(epicCache.epicLibraryTtlMs() / 3600000),
      });
    } catch (err) {
      next(mapDomainError(err, errorProfile));
    }
  });
}

module.exports = { register };
