'use strict';

const gameCache = require('../game-cache');
const { createSourceGate } = require('../../core/source-client');
const { nodeRequest } = require('../../core/http');
const sources = require('../../core/sources');
const {
  EpicError,
  unique,
  maskSecrets,
  parseJsonBody,
  sleepDefault,
  DEFAULT_TIMEOUT_MS,
  MAX_BODY_BYTES,
} = require('./epic-core');

const ACCOUNT_HOST = 'account-public-service-prod03.ol.epicgames.com';
const ACCOUNT_HOST_FALLBACKS = ['account-public-service-prod.ol.epicgames.com'];
const LIBRARY_HOST = 'library-service.live.use1a.on.epicgames.com';
const CATALOG_HOST = 'catalog-public-service-prod06.ol.epicgames.com';
const ENTITLEMENT_HOST = 'entitlement-public-service-prod08.ol.epicgames.com';
const STORE_CONTENT_HOST = 'store-content.ak.epicgames.com';

function defaultBreakerStore() {
  return {
    read() {
      return gameCache.readBreaker();
    },
    write(state) {
      return gameCache.writeBreaker(state);
    },
  };
}

function networkError(err, target) {
  if (err instanceof EpicError) return err;
  const code = err && err.code ? err.code : 'ENETWORK';
  let host = null;
  try {
    host = new URL(target).hostname;
  } catch (_) {
  }
  return new EpicError(
    `Epic недоступен (${host || 'epic'}, ${code}): сеть/DNS/TLS не пускает к источнику. ` +
      'Это не повод считать источник мёртвым — импорт будет отложен (deferred).',
    'epic_unreachable',
    { host, deferred: true }
  );
}

function httpRequest({ method = 'GET', url, headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return nodeRequest(url, {
    method,
    headers,
    body,
    timeoutMs,
    followRedirect: false,
    maxBytes: MAX_BODY_BYTES,
    label: 'epic',
  }).catch((err) => {
    if (err && err.code === 'invalid_url') {
      throw new EpicError(`Некорректный Epic URL: ${maskSecrets(url)}`, 'epic_invalid_url');
    }
    if (err && err.code === 'response_too_large') {
      throw new EpicError(`Ответ Epic больше ${MAX_BODY_BYTES} байт.`, 'epic_http_error', {
        status: err.status,
      });
    }
    throw networkError(err, url);
  });
}

function resolveClientOptions(options = {}, creds) {
  const accountHost = options.accountHost || process.env.GAMES_EPIC_ACCOUNT_HOST || ACCOUNT_HOST;
  const accountHosts = unique([
    accountHost,
    ...(options.accountHosts || ACCOUNT_HOST_FALLBACKS),
  ]);
  return {
    request: options.request || httpRequest,
    sleep: options.sleep || sleepDefault,
    now: options.now || (() => Date.now()),
    pauseMs: options.pauseMs != null ? options.pauseMs : sources.pauseMs('epic'),
    breakerMs: options.breakerMs != null ? options.breakerMs : sources.breakerMs('epic'),
    breakerStore: options.breakerStore || defaultBreakerStore(),
    timeoutMs: options.timeoutMs || sources.timeoutMs('epic'),
    accountHosts,
    libraryHost: options.libraryHost || process.env.GAMES_EPIC_LIBRARY_HOST || LIBRARY_HOST,
    catalogHost: options.catalogHost || process.env.GAMES_EPIC_CATALOG_HOST || CATALOG_HOST,
    entitlementHost:
      options.entitlementHost || process.env.GAMES_EPIC_ENTITLEMENT_HOST || ENTITLEMENT_HOST,
    storeContentHost:
      options.storeContentHost || process.env.GAMES_EPIC_STORE_CONTENT_HOST || STORE_CONTENT_HOST,
    country: options.country || process.env.GAMES_EPIC_COUNTRY || 'US',
    locale: options.locale || process.env.GAMES_EPIC_LOCALE || 'en-US',
    creds,
    tokenStore: options.tokenStore || null,
  };
}

function createRequestPipeline(context) {
  const { request, sleep, now, pauseMs, breakerMs, breakerStore, timeoutMs, accountHosts } = context;

  const gate = createSourceGate({
    now,
    sleep,
    pauseMs,
    breakerMs,
    breakerStore,
    createError(host, entry) {
      return new EpicError(
        `Epic (${host}) временно не опрашивается: предыдущий ответ ${entry.reason}. ` +
          `Повтор через ${Math.max(1, Math.ceil((entry.until - now()) / 60000))} мин.`,
        'epic_rate_limited',
        { host, retryAt: new Date(entry.until).toISOString() }
      );
    },
    mapTransportError(err, context) {
      return networkError(err, context && context.url);
    },
  });

  function breakerFor(host) {
    return gate.breakerFor(host);
  }

  function tripBreaker(host, reason) {
    return gate.tripBreaker(host, reason);
  }

  function assertNotBlocked(host) {
    return gate.assertNotBlocked(host);
  }

  function headersFor({ token, contentType, basic } = {}) {
    const headers = {
      'User-Agent': 'kinoboxd/1.0 (+games-tab)',
      Accept: 'application/json',
    };
    if (contentType) headers['Content-Type'] = contentType;
    if (token) headers.Authorization = `bearer ${token}`;
    if (basic) headers.Authorization = `basic ${basic}`;
    return headers;
  }

  async function requestRaw({ method = 'GET', url, host, token, basic, contentType, body }) {
    const response = await gate.request(
      host,
      () =>
        request({
          method,
          url,
          headers: headersFor({ token, contentType, basic }),
          body: body == null ? null : String(body),
          timeoutMs,
        }),
      { url }
    );
    const status = Number(response.status) || 0;
    if (status === 403 || status === 429) {
      tripBreaker(host, status === 429 ? '429 Too Many Requests' : 'HTTP 403');
    }
    return { status, body: String(response.body || ''), headers: response.headers || {} };
  }

  function classify(status, url, host) {
    if (status === 401) {
      return new EpicError(
        'Epic отклонил токен (401): подключение истекло, требуется переподключение. ' +
          'Значение токена не печатается.',
        'epic_auth_expired',
        { status, host }
      );
    }
    if (status === 403 || status === 429) {
      return new EpicError(
        `Epic (${host}) ответил ${status}: запросы приостановлены на 30 минут (breaker). ` +
          'Это не ошибка аккаунта — повторите позже.',
        'epic_rate_limited',
        { status, host }
      );
    }
    if (status >= 500) {
      return new EpicError(
        `Epic (${host}) ответил ${status}: источник временно недоступен, импорт отложен (deferred).`,
        'epic_unreachable',
        { status, host, deferred: true }
      );
    }
    return new EpicError(
      `Epic (${host}) ответил ${status}: ${maskSecrets(url)}`,
      'epic_http_error',
      { status, host }
    );
  }

  async function requestJson({ method = 'GET', url, host, token, basic, contentType, body }) {
    const response = await requestRaw({ method, url, host, token, basic, contentType, body });
    if (response.status < 200 || response.status >= 300) {
      throw classify(response.status, url, host);
    }
    const json = parseJsonBody(response.body);
    if (json == null) {
      throw new EpicError(
        `Epic (${host}) вернул не JSON: ${maskSecrets(url)}`,
        'epic_http_error',
        { status: response.status, host }
      );
    }
    return json;
  }

  async function requestAccountJson(pathAndQuery, opts = {}) {
    let lastError = null;
    for (const host of accountHosts) {
      try {
        return await requestJson({
          ...opts,
          url: `https://${host}${pathAndQuery}`,
          host,
        });
      } catch (err) {
        lastError = err;
        const retryable = err && (err.code === 'epic_unreachable' || err.code === 'epic_http_error');
        if (!retryable) throw err;
      }
    }
    throw lastError;
  }

  return {
    requestRaw,
    requestJson,
    requestAccountJson,
    classify,
    assertNotBlocked,
    tripBreaker,
    breakerFor,
  };
}

module.exports = {
  ACCOUNT_HOST,
  ACCOUNT_HOST_FALLBACKS,
  LIBRARY_HOST,
  CATALOG_HOST,
  ENTITLEMENT_HOST,
  STORE_CONTENT_HOST,
  httpRequest,
  networkError,
  defaultBreakerStore,
  resolveClientOptions,
  createRequestPipeline,
};
