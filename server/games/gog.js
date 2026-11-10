'use strict';

/**
 * GOG client for the games tab (M6a).
 *
 * GOG is a **same-owner secondary library** (ИГРЫ-АРХИТЕКТУРА §14.4, model
 * v7): ownership + its own hours, never a second journal and never summed with
 * Steam. There is no public "someone else's library" API — the only server
 * channel is the user's own OAuth token (Galaxy client flow, reverse-
 * engineered but stable for 10+ years, used by lgogdownloader/Minigalaxy/
 * Heroic).
 *
 * Flow:
 *   1. `authorizeUrl()` — `auth.gog.com/auth?...` with the public Galaxy
 *      `client_id` and the exact registered `redirect_uri`
 *      (`https://embed.gog.com/on_login_success?origin=client`), plus
 *      `layout=client2` (the Galaxy login layout); the user logs in in their
 *      browser and is redirected to
 *      `embed.gog.com/on_login_success?...&code=<code>`;
 *   2. `exchangeCode(codeOrUrl)` — accepts the bare `code` **or** the whole
 *      redirect URL (see `extractAuthCode`), then `GET auth.gog.com/token?
 *      grant_type=authorization_code...&redirect_uri=<exact>` (the same
 *      `redirect_uri` is mandatory in the exchange) → `access_token` (≈1 h),
 *      `refresh_token`, `user_id`;
 *   3. `refresh(refreshToken)` — same endpoint with `grant_type=refresh_token`.
 *      A **silent** refresh is performed by `gog-auth.js` before every
 *      token-needing call (5-minute buffer, one retry after a 401/302); the
 *      access token lives ≈1 h, the refresh token much longer, so an expired
 *      access token is never a reason to ask the user to reconnect.
 *   4. `getUserData(token)` — `embed.gog.com/userData.json` (identity);
 *   5. `getFilteredProducts(token, page)` — `embed.gog.com/account/
 *      getFilteredProducts?mediaType=1&page=N`, **100 products/page**;
 *   6. `getSessions(token, gogGameId)` — `gameplay.gog.com/games/{id}/users/
 *      {uid}/sessions` → `time_sum` in **minutes**. Shape confirmed by three
 *      independent open-source clients: Heroic `getGOGPlaytime`, unifideck
 *      `fetch_gog_playtime_minutes` («verified live», 06.2026) and comet
 *      `api/gog/sessions.rs`. The `{uid}` is the **Galaxy** user id — the OAuth
 *      `user_id` (Heroic) or `userData.json.galaxyUserId` (comet/unifideck),
 *      never `userData.json.userId` (the 01.11.2026 zero-hours bug).
 *
 * Time units: `expires_in` (seconds, OAuth2) is converted to milliseconds by
 * `gogCache.expiresInMs` **once**; `expiresAt` is always an ISO string in ms.
 *
 * Secrets:
 *   - user tokens never appear in an error message, log line or job status;
 *     `maskSecrets` strips `access_token`/`refresh_token`/`client_secret`/`code`
 *     from any URL before it leaves this module;
 *   - the Galaxy client credentials are public (hardcoded in the open-source
 *     clients above). They can be overridden with `GOG_CLIENT_ID`/
 *     `GOG_CLIENT_SECRET` or `config/gog-client.json` (0600, gitignored); the
 *     built-in pair is the last fallback so the button works after deploy.
 *     `clientSource()` reports only `env`/`file`/`default`, never the value.
 *
 * Politeness (§14.5): one request per library page (300–500 ms pause), one
 * request per game for playtime (500 ms pause, budget enforced by the importer),
 * a 30-minute breaker on `403`/`429` (a `401` is `auth_expired`, not a block —
 * the user must reconnect). Network/5xx are `gog_unreachable`/`gog_http_error`
 * and are **deferred**: the importer must not cache a negative result.
 *
 * Modules: constants/parsers live in `sources/gog-core.js`, credentials and
 * transport in `sources/gog-requests.js`, the endpoints in
 * `sources/gog-client.js`. This file composes them and re-exports the
 * historical surface unchanged.
 */

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

/* ------------------------------------------------------------------ */
/* client                                                              */
/* ------------------------------------------------------------------ */

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
    // Exposed for tests/diagnostics only.
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
