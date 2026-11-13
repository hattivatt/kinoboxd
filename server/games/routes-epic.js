'use strict';

const express = require('express');

const { HttpError, mapDomainError } = require('../core/errors');
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

const EPIC_ERROR_PROFILE = {
  rules: [
    {
      is: epic.EpicError,
      statuses: EPIC_ERROR_STATUS,
      defaultStatus: 502,
      ownStatus: 'whenAtLeast400',
    },
    {
      codeIn: EPIC_ERROR_STATUS,
      statuses: EPIC_ERROR_STATUS,
      defaultStatus: 502,
      ownStatus: 'whenAtLeast400',
    },
  ],
  fallback: {},
  retryAt: true,
  message: { mask: epic.maskSecrets, fallback: 'Epic error' },
};

function createRouter(deps = {}) {
  const store = deps.tokenStore || tokenStore;
  const importer = deps.importer || epicImport;
  const auth = deps.auth || epicAuth;
  const router = express.Router();
  const ctx = { deps, store, importer, auth, errorProfile: EPIC_ERROR_PROFILE };

  status.register(router, ctx);
  authRoutes.register(router, ctx);
  imports.register(router, ctx);
  exported.register(router, ctx);
  disconnect.register(router, ctx);

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
