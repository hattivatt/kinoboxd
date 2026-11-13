'use strict';

const gogCache = require('./gog-cache');
const {
  AUTH_HOST,
  EMBED_HOST,
  GAMEPLAY_HOST,
  REDIRECT_URI,
  PRODUCTS_PER_PAGE,
  DEFAULT_LIBRARY_PAUSE_MS,
  DEFAULT_PLAYTIME_PAUSE_MS,
  DEFAULT_BREAKER_MS,
  GogError,
  maskSecrets,
  extractAuthCode,
  OAUTH_ERRORS,
  envInt,
  sleepDefault,
  normalizeProduct,
  libraryFingerprint,
  gameplayUserId,
  gameplayUserIdCandidates,
  minutesOfSessionsPayload,
  truncateBody,
} = require('./sources/gog-core');
const {
  httpGet,
  loadCredentials,
  clientSource,
  resetCredentialsCache,
  createRequestPipeline,
} = require('./sources/gog-requests');
const { createClientApi } = require('./sources/gog-client');

function createClient(options = {}) {
  const request = options.request || httpGet;
  const sleep = options.sleep || sleepDefault;
  const now = options.now || (() => Date.now());
  const libraryPauseMs =
    options.libraryPauseMs != null
      ? options.libraryPauseMs
      : envInt('GAMES_GOG_LIBRARY_PAUSE_MS', DEFAULT_LIBRARY_PAUSE_MS);
  const playtimePauseMs =
    options.playtimePauseMs != null
      ? options.playtimePauseMs
      : envInt('GAMES_GOG_PLAYTIME_PAUSE_MS', DEFAULT_PLAYTIME_PAUSE_MS);
  const breakerMs =
    options.breakerMs != null
      ? options.breakerMs
      : envInt('GAMES_GOG_BREAKER_MS', DEFAULT_BREAKER_MS);
  const breakerStore = options.breakerStore || {
    read: () => gogCache.readBreaker(),
    write: (state) => gogCache.writeBreaker(state),
  };
  const credentialProvider = options.credentialProvider || loadCredentials;
  const endpoints = {
    auth: options.authOrigin || `https://${AUTH_HOST}`,
    embed: options.embedOrigin || `https://${EMBED_HOST}`,
    gameplay: options.gameplayOrigin || `https://${GAMEPLAY_HOST}`,
  };

  const pipeline = createRequestPipeline({
    request,
    sleep,
    now,
    libraryPauseMs,
    playtimePauseMs,
    breakerMs,
    breakerStore,
  });
  const api = createClientApi({
    request,
    pause: pipeline.pause,
    bearer: pipeline.bearer,
    authenticatedGet: pipeline.authenticatedGet,
    assertNotBlocked: pipeline.assertNotBlocked,
    tripBreaker: pipeline.tripBreaker,
    now,
    breakerMs,
    credentialProvider,
    endpoints,
  });

  return {
    options: { libraryPauseMs, playtimePauseMs, breakerMs, endpoints },
    authorizeUrl: api.authorizeUrl,
    exchangeCode: api.exchangeCode,
    refresh: api.refresh,
    getUserData: api.getUserData,
    getFilteredProducts: api.getFilteredProducts,
    fetchAllProducts: api.fetchAllProducts,
    getOwnedIds: api.getOwnedIds,
    getSessions: api.getSessions,
    assertNotBlocked: pipeline.assertNotBlocked,
    tripBreaker: pipeline.tripBreaker,
    breakerFor: pipeline.breakerFor,
    _credentialProvider: credentialProvider,
  };
}

module.exports = {
  GogError,
  AUTH_HOST,
  EMBED_HOST,
  GAMEPLAY_HOST,
  REDIRECT_URI,
  PRODUCTS_PER_PAGE,
  DEFAULT_LIBRARY_PAUSE_MS,
  DEFAULT_PLAYTIME_PAUSE_MS,
  DEFAULT_BREAKER_MS,
  createClient,
  httpGet,
  maskSecrets,
  extractAuthCode,
  OAUTH_ERRORS,
  loadCredentials,
  clientSource,
  resetCredentialsCache,
  normalizeProduct,
  libraryFingerprint,
  gameplayUserId,
  gameplayUserIdCandidates,
  minutesOfSessionsPayload,
  truncateBody,
};
