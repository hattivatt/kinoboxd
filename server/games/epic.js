'use strict';

/**
 * Epic Games Store client for the games tab (M6b).
 *
 * Server-side channel (§14.2): **device-code OAuth → library items →
 * playtime/account/all**, plus catalog bulk metadata. There is no public
 * no-key path to somebody else's Epic library — every user endpoint answers
 * `401 authentication_failed` without the owner's token.
 *
 * Flow implemented here (primary — authorization code, the one that works):
 *
 *   1. the user opens `authorizeUrl()` → epicgames.com/id/login with
 *      `redirectUrl=…/id/api/redirect?clientId=…&responseType=code`, logs in and
 *      lands on a page that shows a one-time `code`;
 *   2. `exchangeAuthorizationCode(codeOrUrl)` → `POST /account/api/oauth/token`
 *      with `Authorization: basic <client_id:client_secret>`,
 *      `Content-Type: application/x-www-form-urlencoded`,
 *      `grant_type=authorization_code&code=…&token_type=eg1` →
 *      `{access_token, refresh_token, account_id, displayName, …}`;
 *   3. `grant_type=refresh_token` refreshes an expired access token.
 *
 * Legacy device-code flow (`deviceAuthorization()` + `grant_type=device_code`)
 * is kept for completeness, but since 2026 Epic answers **400
 * `unsupported_grant_type` (1016)** for every public launcher client — the
 * grant is reserved for console/Fortnite clients. Live proof (01.11.2026):
 * launcherAppClient2 → 401 `authentication_failed` (1032),
 * fortnitePCGameClient → 400 `unsupported_grant_type` (1016). That 400 is the
 * exact error the user saw on production; it is a capability refusal, not a
 * malformed request, so the fix is the authorization-code flow above.
 *
 * Read endpoints:
 *   - `GET /entitlement/api/account/{id}/entitlements` (primary ownership);
 *   - `GET /library/api/public/items?includeMetadata=true&cursor=…`
 *     (cursor pagination, fallback/merge for appName/platform/acquisition);
 *   - `GET /library/api/public/playtime/account/{id}/all` → `totalTime` is in
 *     **seconds**, there is **no lastPlayed** in the model;
 *   - `GET /catalog/api/shared/namespace/{ns}/bulk/items?id=…` (metadata);
 *   - `GET store-content.ak.epicgames.com/api/content/productmapping`
 *     (public appName → slug fallback, no token).
 *
 * Politeness (§14.5): pause `GAMES_EPIC_PAUSE_MS` (default 300 ms) between
 * requests, 30-minute breaker on 403/429, network/5xx → `epic_unreachable`
 * with `deferred: true` (the importer keeps the previous snapshot instead of
 * caching a negative result), 401 → `epic_auth_expired` (never "0 games").
 *
 * Secrets: access/refresh/device codes and the launcher client secret are
 * never logged or embedded in error messages. `maskSecrets()` is applied to
 * every message that leaves this module.
 *
 * The implementation is split into three private modules: `sources/epic-core`
 * (constants, `EpicError`, pure parsers — re-exported here), `sources/
 * epic-requests` (hosts, pause, breaker, request helpers) and `sources/
 * epic-client` (OAuth grants + read endpoint bodies). This file stays the
 * public facade.
 */

const fs = require('fs');
const path = require('path');

const {
  EpicError,
  VERIFY_URI,
  AUTHORIZE_URI,
  REDIRECT_URI_BASE,
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
  DEFAULT_PAUSE_MS,
  DEFAULT_BREAKER_MS,
  CATALOG_CHUNK,
  authorizeUrl,
  extractAuthCode,
  maskSecrets,
  normalizeDeviceAuthorization,
  normalizeTokenResponse,
  normalizeEntitlement,
  isExcludedEntitlement,
  normalizeLibraryRecord,
  isExcludedLibraryRecord,
  normalizePlaytimeItem,
  normalizePlaytimeResponse,
  secondsToMinutes,
  secondsToHours,
  playtimeForGame,
  normalizeCatalogItem,
  normalizeProductMapping,
  mergeLibrary,
  normalizeSlug,
} = require('./sources/epic-core');
const {
  ACCOUNT_HOST,
  ACCOUNT_HOST_FALLBACKS,
  LIBRARY_HOST,
  CATALOG_HOST,
  ENTITLEMENT_HOST,
  STORE_CONTENT_HOST,
  httpRequest,
  resolveClientOptions,
  createRequestPipeline,
} = require('./sources/epic-requests');
const { createClientApi } = require('./sources/epic-client');

const CLIENT_FILE_ENV = 'KINOBOXD_EPIC_CLIENT_FILE';
const CLIENT_FILE_PATH = path.join(__dirname, '..', '..', 'config', 'epic-client.json');

function clientFilePath() {
  const override = process.env[CLIENT_FILE_ENV];
  if (typeof override === 'string' && override.trim()) return path.resolve(override.trim());
  return CLIENT_FILE_PATH;
}

let credentialsCache = null;

function readClientFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const clientId = parsed && (parsed.clientId || parsed.client_id);
    const clientSecret = parsed && (parsed.clientSecret || parsed.client_secret);
    if (clientId && clientSecret) {
      return { clientId: String(clientId), clientSecret: String(clientSecret), source: 'file' };
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Resolve the launcher client pair once: explicit options → env
 * `EPIC_CLIENT_ID`+`EPIC_CLIENT_SECRET` (aliases `GAMES_EPIC_*`) →
 * `config/epic-client.json` (0600, gitignored) → the built-in public pair.
 * A half-configured env pair is ignored on purpose (the public pair still
 * works); `source` is reported, the values never are.
 */
function loadCredentials(options = {}) {
  if (options.clientId && options.clientSecret) {
    return {
      clientId: String(options.clientId),
      clientSecret: String(options.clientSecret),
      source: 'options',
    };
  }
  if (credentialsCache) return credentialsCache;
  const envId = process.env.EPIC_CLIENT_ID || process.env.GAMES_EPIC_CLIENT_ID;
  const envSecret = process.env.EPIC_CLIENT_SECRET || process.env.GAMES_EPIC_CLIENT_SECRET;
  if (envId && envSecret) {
    credentialsCache = {
      clientId: String(envId).trim(),
      clientSecret: String(envSecret).trim(),
      source: 'env',
    };
    return credentialsCache;
  }
  const fromFile = readClientFile(clientFilePath());
  if (fromFile) {
    credentialsCache = fromFile;
    return credentialsCache;
  }
  credentialsCache = {
    clientId: DEFAULT_CLIENT_ID,
    clientSecret: DEFAULT_CLIENT_SECRET,
    source: 'default',
  };
  return credentialsCache;
}

function clientCredentials(options) {
  const resolved = loadCredentials(options);
  return { clientId: resolved.clientId, clientSecret: resolved.clientSecret };
}

/** `env` | `file` | `default` | `options` — never the value. */
function clientSource(options) {
  return loadCredentials(options).source;
}

/** Test helper: forget the cached pair so the next call re-reads env/file. */
function resetCredentialsCache() {
  credentialsCache = null;
}

function createClient(options = {}) {
  const creds = clientCredentials(options);
  const context = resolveClientOptions(options, creds);
  const pipeline = createRequestPipeline(context);
  const api = createClientApi({ ...context, ...pipeline });

  return {
    options: {
      pauseMs: context.pauseMs,
      breakerMs: context.breakerMs,
      accountHosts: context.accountHosts,
      libraryHost: context.libraryHost,
      catalogHost: context.catalogHost,
      entitlementHost: context.entitlementHost,
    },
    authorizeUrl: () => authorizeUrl(creds.clientId),
    clientSource: () => clientSource(options),
    getClientToken: api.getClientToken,
    deviceAuthorization: api.deviceAuthorization,
    exchangeAuthorizationCode: api.exchangeAuthorizationCode,
    exchangeDeviceCode: api.exchangeDeviceCode,
    refreshTokens: api.refreshTokens,
    getAccessToken: api.getAccessToken,
    getAccount: api.getAccount,
    getEntitlements: api.getEntitlements,
    getLibraryItems: api.getLibraryItems,
    getPlaytime: api.getPlaytime,
    getCatalogBulk: api.getCatalogBulk,
    getProductMapping: api.getProductMapping,
    killSession: api.killSession,
    assertNotBlocked: pipeline.assertNotBlocked,
    tripBreaker: pipeline.tripBreaker,
    breakerFor: pipeline.breakerFor,
    // Exposed for diagnostics/tests only. Never print the values.
    _tokenStore: context.tokenStore,
    _clientCredentials: () => ({ clientId: creds.clientId, hasSecret: Boolean(creds.clientSecret) }),
  };
}

module.exports = {
  EpicError,
  ACCOUNT_HOST,
  ACCOUNT_HOST_FALLBACKS,
  LIBRARY_HOST,
  CATALOG_HOST,
  ENTITLEMENT_HOST,
  STORE_CONTENT_HOST,
  VERIFY_URI,
  AUTHORIZE_URI,
  REDIRECT_URI_BASE,
  DEFAULT_PAUSE_MS,
  DEFAULT_BREAKER_MS,
  CATALOG_CHUNK,
  authorizeUrl,
  extractAuthCode,
  createClient,
  clientSource,
  resetCredentialsCache,
  httpRequest,
  maskSecrets,
  normalizeDeviceAuthorization,
  normalizeTokenResponse,
  normalizeEntitlement,
  isExcludedEntitlement,
  normalizeLibraryRecord,
  isExcludedLibraryRecord,
  normalizePlaytimeItem,
  normalizePlaytimeResponse,
  secondsToMinutes,
  secondsToHours,
  playtimeForGame,
  normalizeCatalogItem,
  normalizeProductMapping,
  mergeLibrary,
  normalizeSlug,
};
