'use strict';

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

function clientSource(options) {
  return loadCredentials(options).source;
}

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
