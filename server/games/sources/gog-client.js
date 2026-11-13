'use strict';

const { URL } = require('url');

const gogCache = require('../gog-cache');
const {
  GogError,
  maskSecrets,
  extractAuthCode,
  oauthFailure,
  safeJson,
  truncateBody,
  gameplayUserId,
  minutesOfSessionsPayload,
  normalizeProduct,
  REDIRECT_URI,
  EMBED_HOST,
  GAMEPLAY_HOST,
  PRODUCTS_PER_PAGE,
} = require('./gog-core');
const { parseJsonBody } = require('./gog-requests');

function createTokenGrants(context) {
  const { request, now, credentialProvider, endpoints } = context;

  function authorizeUrl() {
    const { clientId } = credentialProvider();
    const url = new URL(`${endpoints.auth}/auth`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('layout', 'client2');
    return url.toString();
  }

  function tokenUrl(params) {
    const { clientId, clientSecret } = credentialProvider();
    const url = new URL(`${endpoints.auth}/token`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('client_secret', clientSecret);
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  function normalizeTokenResponse(json, fallbackRefresh) {
    if (!json || typeof json !== 'object' || !json.access_token) {
      throw new GogError(
        'GOG не вернул access_token (неверный или просроченный code).',
        'gog_invalid_code'
      );
    }
    const ttlMs = gogCache.expiresInMs(json.expires_in) || 3600 * 1000;
    return {
      accessToken: String(json.access_token),
      refreshToken: json.refresh_token ? String(json.refresh_token) : fallbackRefresh || null,
      expiresAt: new Date(now() + ttlMs).toISOString(),
      expiresInMs: ttlMs,
      tokenType: json.token_type || 'Bearer',
      scope: json.scope || null,
      userId: json.user_id != null ? String(json.user_id) : null,
      sessionId: json.session_id || null,
    };
  }

  async function exchangeCode(code) {
    const value = extractAuthCode(code);
    if (!value) {
      throw new GogError(
        'Параметр "code" обязателен: вставьте code из адресной строки после входа в GOG ' +
          'или всю ссылку embed.gog.com/on_login_success?…&code=…',
        'gog_code_required'
      );
    }
    const url = tokenUrl({
      grant_type: 'authorization_code',
      code: value,
      redirect_uri: REDIRECT_URI,
    });
    const response = await request(url, { followRedirect: false });
    if (response.status < 200 || response.status >= 300) {
      if (response.status === 429) {
        throw new GogError(
          'GOG ответил 429 на обмен code: повторите через несколько минут.',
          'gog_rate_limited',
          { status: 429 }
        );
      }
      const parsed = safeJson(response.body);
      const rawError = parsed && parsed.error ? String(parsed.error) : '';
      const detail = parsed && parsed.error_description
        ? maskSecrets(String(parsed.error_description))
        : '';
      const failure = oauthFailure(response, { detail, rawError });
      const source = failure.code === 'gog_client_rejected' ? credentialProvider().source : null;
      throw new GogError(
        `${failure.message}${source ? ` (источник пары: ${source})` : ''}`,
        failure.code,
        { status: failure.status, description: detail }
      );
    }
    return normalizeTokenResponse(parseJsonBody(response, url), null);
  }

  async function refresh(refreshToken) {
    const value = String(refreshToken == null ? '' : refreshToken).trim();
    if (!value) {
      throw new GogError('GOG refresh_token отсутствует: требуется повторный вход.', 'gog_auth_expired');
    }
    const url = tokenUrl({ grant_type: 'refresh_token', refresh_token: value });
    const response = await request(url, { followRedirect: false });
    if (response.status < 200 || response.status >= 300) {
      const parsed = safeJson(response.body);
      const rawError = parsed && parsed.error ? String(parsed.error) : '';
      const description = parsed && parsed.error_description
        ? maskSecrets(String(parsed.error_description))
        : '';
      if (rawError === 'invalid_client' || rawError === 'unauthorized_client') {
        const failure = oauthFailure(response, { rawError });
        throw new GogError(failure.message, failure.code, {
          status: failure.status,
          description,
        });
      }
      if (response.status === 400 || response.status === 401) {
        throw new GogError(
          'GOG refresh_token больше не действителен' +
            `${rawError ? ` (${rawError})` : ''}${description ? `: «${description}»` : ''}: ` +
            'подключите GOG заново.',
          'gog_auth_expired',
          { status: response.status, description }
        );
      }
      throw new GogError(
        `GOG не обновил токен (${response.status}).`,
        response.status === 429 ? 'gog_rate_limited' : 'gog_http_error',
        { status: response.status, description }
      );
    }
    return normalizeTokenResponse(parseJsonBody(response, url), value);
  }

  return {
    authorizeUrl,
    exchangeCode,
    refresh,
  };
}

function createReadEndpoints(context) {
  const {
    request,
    pause,
    bearer,
    authenticatedGet,
    assertNotBlocked,
    tripBreaker,
    now,
    breakerMs,
    endpoints,
  } = context;

  async function getUserData(tokenDoc) {
    const url = `${endpoints.embed}/userData.json`;
    const response = await authenticatedGet(url, tokenDoc, {
      host: EMBED_HOST,
      kind: 'library',
    });
    const json = parseJsonBody(response, url);
    if (!json || json.isLoggedIn !== true) {
      throw new GogError(
        'GOG сообщил isLoggedIn=false: токен не даёт доступа к аккаунту.',
        'gog_auth_expired'
      );
    }
    const userId = json.userId != null ? String(json.userId) : tokenDoc && tokenDoc.userKey;
    if (!gogCache.isValidUserKey(userId)) {
      throw new GogError('GOG не вернул числовой userId.', 'gog_invalid_user');
    }
    return {
      userKey: userId,
      username: json.username || null,
      galaxyUserId: json.galaxyUserId != null ? String(json.galaxyUserId) : null,
      country: json.country || null,
      avatar: json.avatar || null,
      isLoggedIn: true,
    };
  }

  async function getFilteredProducts(tokenDoc, { page = 1, mediaType = 1 } = {}) {
    const url =
      `${endpoints.embed}/account/getFilteredProducts` +
      `?mediaType=${encodeURIComponent(mediaType)}&page=${encodeURIComponent(page)}`;
    const response = await authenticatedGet(url, tokenDoc, {
      host: EMBED_HOST,
      kind: 'library',
    });
    const json = parseJsonBody(response, url);
    const products = Array.isArray(json && json.products) ? json.products : [];
    const totalPages = Number(json && json.totalPages);
    return {
      page: Number(page),
      products: products.map(normalizeProduct),
      productsPerPage: Number(json && json.productsPerPage) || PRODUCTS_PER_PAGE,
      totalPages: Number.isFinite(totalPages) && totalPages >= 0 ? totalPages : null,
      totalProducts: Number(json && json.totalProducts) || products.length,
    };
  }

  async function fetchAllProducts(tokenDoc, { maxPages = null } = {}) {
    const first = await getFilteredProducts(tokenDoc, { page: 1 });
    const products = [...first.products];
    const pages = [first.page];
    const totalPages = first.totalPages == null ? 1 : first.totalPages;
    const limit = maxPages != null ? Math.min(maxPages, totalPages) : totalPages;
    for (let page = 2; page <= limit; page++) {
      const next = await getFilteredProducts(tokenDoc, { page });
      products.push(...next.products);
      pages.push(next.page);
    }
    return {
      products,
      pages,
      totalPages,
      totalProducts: first.totalProducts,
      productsPerPage: first.productsPerPage,
      complete: pages.length >= totalPages,
    };
  }

  async function getOwnedIds(tokenDoc) {
    const url = `${endpoints.embed}/user/data/games`;
    const response = await authenticatedGet(url, tokenDoc, {
      host: EMBED_HOST,
      kind: 'library',
    });
    const json = parseJsonBody(response, url);
    const owned = Array.isArray(json && json.owned) ? json.owned : [];
    return owned.map(String);
  }

  async function getSessions(tokenDoc, gogGameId, options = {}) {
    const { uid, source: uidSource } = gameplayUserId(tokenDoc);
    if (!uid) {
      throw new GogError(
        'GOG: неизвестен числовой userId (ни token user_id, ни galaxyUserId).',
        'gog_invalid_user'
      );
    }
    const url =
      `${endpoints.gameplay}/games/${encodeURIComponent(gogGameId)}` +
      `/users/${encodeURIComponent(uid)}/sessions`;
    assertNotBlocked(GAMEPLAY_HOST);
    await pause('playtime');
    const response = await request(url, {
      headers: bearer(tokenDoc),
      followRedirect: false,
    });
    if (response.status === 404) {
      return {
        gogGameId: String(gogGameId),
        minutes: 0,
        found: false,
        status: 'not_found',
        httpStatus: 404,
        field: null,
        uidSource,
        raw: options.raw ? truncateBody(response.body) : null,
      };
    }
    if (response.status >= 300 && response.status < 400) {
      throw new GogError(
        'GOG gameplay требует повторного входа (redirect): токен истёк.',
        'gog_auth_expired',
        { host: GAMEPLAY_HOST, status: response.status }
      );
    }
    if (response.status === 401) {
      throw new GogError(
        'GOG gameplay отклонил токен (401): требуется повторный вход.',
        'gog_auth_expired',
        { host: GAMEPLAY_HOST, status: 401 }
      );
    }
    if (response.status === 403 || response.status === 429) {
      tripBreaker(GAMEPLAY_HOST, String(response.status));
      throw new GogError(
        `GOG gameplay ответил ${response.status}: запросы приостановлены (breaker 30 мин).`,
        'gog_rate_limited',
        {
          host: GAMEPLAY_HOST,
          status: response.status,
          retryAt: new Date(now() + breakerMs).toISOString(),
        }
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new GogError(
        `GOG gameplay ответил ${response.status} для игры ${gogGameId}.`,
        'gog_http_error',
        { host: GAMEPLAY_HOST, status: response.status }
      );
    }
    const raw = options.raw ? truncateBody(response.body) : null;
    const parsed = minutesOfSessionsPayload(safeJson(response.body));
    return {
      gogGameId: String(gogGameId),
      minutes: parsed.minutes,
      found: parsed.minutes != null,
      status: parsed.minutes == null ? 'unparsed' : 'ok',
      httpStatus: response.status,
      field: parsed.field,
      sessions: parsed.sessions == null ? undefined : parsed.sessions,
      uidSource,
      raw,
    };
  }

  return {
    getUserData,
    getFilteredProducts,
    fetchAllProducts,
    getOwnedIds,
    getSessions,
  };
}

function createClientApi(context) {
  const grants = createTokenGrants(context);
  const reads = createReadEndpoints(context);
  return {
    authorizeUrl: grants.authorizeUrl,
    exchangeCode: grants.exchangeCode,
    refresh: grants.refresh,
    getUserData: reads.getUserData,
    getFilteredProducts: reads.getFilteredProducts,
    fetchAllProducts: reads.fetchAllProducts,
    getOwnedIds: reads.getOwnedIds,
    getSessions: reads.getSessions,
  };
}

module.exports = {
  createTokenGrants,
  createReadEndpoints,
  createClientApi,
};
