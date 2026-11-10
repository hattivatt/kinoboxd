'use strict';

const { mapDomainError } = require('../../../core/errors');
const { HttpError } = require('../../../upload');
const epic = require('../../epic');
const epicCache = require('../../epic-cache');
const { assertOnlyParams, resolveAccount } = require('./params');

function register(router, ctx) {
  const { deps, store, errorProfile } = ctx;

  /* ------------------------- disconnect ------------------------- */

  router.post('/epic/disconnect', async (req, res, next) => {
    try {
      assertOnlyParams(req, [], 'POST /api/games/epic/disconnect');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const resolved = resolveAccount(
        { accountId: body.accountId, owner: body.owner != null ? body.owner : body.profile },
        { requireProfile: false }
      );
      if (!resolved.accountId) {
        throw new HttpError(
          400,
          'Body must contain "accountId" or "owner" (steam-<steamid64>).',
          'epic_account_required'
        );
      }
      const doc = await store.getTokens(resolved.accountId);
      let remoteRevoked = false;
      if (doc && doc.accessToken) {
        const client = deps.client || epic.createClient({ tokenStore: store });
        remoteRevoked = await client.killSession(doc.accessToken);
      }
      const deleted = await store.deleteTokens(resolved.accountId);
      await epicCache.markEpicDisconnected(resolved.accountId);
      const library = epicCache.getEpicLibrary(resolved.accountId);
      res.status(200).json({
        source: 'epic',
        disconnected: deleted,
        accountId: resolved.accountId,
        owner: resolved.owner || null,
        remoteRevoked,
        // The snapshot is data, not a secret: keep it so the UI can say
        // "данные от <fetchedAt>, требуется переподключение" (§14.4 rule 7).
        snapshotKept: Boolean(library),
        snapshotFetchedAt: library ? library.fetchedAt || null : null,
        status: 'not_connected',
      });
    } catch (err) {
      next(mapDomainError(err, errorProfile));
    }
  });
}

module.exports = { register };
