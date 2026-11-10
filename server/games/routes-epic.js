'use strict';

/**
 * `/api/games/epic/*` router (M6b). Mounted under the same auth gate as the
 * other games routers (server/index.js) and deliberately on **its own paths**
 * (`/epic/...`), so the parallel GOG branch (M6a) can add `/gog/...` without a
 * route conflict. The integration round (M6c) owns the shared
 * «Подключения» screen and the union aggregates.
 *
 *   GET  /api/games/epic/status?owner=steam-<id64>|accountId=<id>
 *   GET  /api/games/epic/auth-url          (login URL, no network call)
 *   POST /api/games/epic/connect           { code, owner?, label? }   ← primary
 *   POST /api/games/epic/auth              { owner?, label? }         (device-code,
 *                                          unavailable for public clients)
 *   GET  /api/games/epic/auth/:authId
 *   DELETE /api/games/epic/auth/:authId    (cancel)
 *   POST /api/games/epic/import            { accountId?, owner?, force?, label? }
 *   POST /api/games/epic/refresh           { accountId?, owner? }  (force import)
 *   GET  /api/games/epic/import/:jobId
 *   GET  /api/games/epic/import/status?id=…
 *   GET  /api/games/epic/exported?owner=…|accountId=…
 *   POST /api/games/epic/disconnect        { accountId?, owner? }
 *
 * Security: no endpoint returns a device code, access token, refresh token or
 * the launcher client secret. `tokenStore.redactTokens()` is the only token
 * shape that leaves the server (presence + expiry).
 */

const express = require('express');

const { HttpError } = require('../upload');
const epic = require('./epic');
const epicAuth = require('./epic-auth');
const epicImport = require('./epic-import');
const tokenStore = require('./epic-token-store');
const authRoutes = require('./endpoints/epic/auth');
const disconnect = require('./endpoints/epic/disconnect');
const exported = require('./endpoints/epic/exported');
const imports = require('./endpoints/epic/import');
const status = require('./endpoints/epic/status');

const EPIC_ERROR_STATUS = {
  invalid_owner: 400,
  unknown_owner: 400,
  epic_account_required: 400,
  epic_not_connected: 400,
  owner_mismatch: 400,
  epic_invalid_account: 400,
  epic_auth_failed: 400,
  epic_auth_cancelled: 400,
  epic_auth_pending: 409,
  epic_auth_expired: 401,
  epic_rate_limited: 429,
  epic_unreachable: 502,
  epic_http_error: 502,
  epic_invalid_url: 400,
  epic_client_invalid: 502,
  epic_device_grant_unavailable: 400,
  epic_code_required: 400,
  epic_invalid_code: 400,
  epic_library_empty: 400,
  epic_token_store_error: 500,
  epic_invalid_catalog_item: 400,
  epic_import_failed: 502,
  unknown_auth: 404,
};

function mapError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof epic.EpicError || (err && err.code && EPIC_ERROR_STATUS[err.code])) {
    const status =
      Number.isInteger(err.status) && err.status >= 400
        ? err.status
        : EPIC_ERROR_STATUS[err.code] || 502;
    const mapped = new HttpError(status, epic.maskSecrets(err.message || 'Epic error'), err.code);
    if (err.retryAt) mapped.retryAt = err.retryAt;
    return mapped;
  }
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) {
    return new HttpError(err.status, epic.maskSecrets(err.message || 'Epic error'), err.code);
  }
  return err;
}

function createRouter(deps = {}) {
  const store = deps.tokenStore || tokenStore;
  const importer = deps.importer || epicImport;
  const auth = deps.auth || epicAuth;
  const router = express.Router();
  const ctx = { deps, store, importer, auth, mapError };

  status.register(router, ctx);
  authRoutes.register(router, ctx);
  imports.register(router, ctx);
  exported.register(router, ctx);
  disconnect.register(router, ctx);

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
