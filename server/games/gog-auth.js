'use strict';

const gogCache = require('./gog-cache');
const { GogError, maskSecrets } = require('./gog');

const TERMINAL_CODES = new Set(['gog_auth_expired', 'gog_invalid_code']);

const TOKEN_METHODS = [
  'getUserData',
  'getFilteredProducts',
  'fetchAllProducts',
  'getOwnedIds',
  'getSessions',
];

const refreshing = new Map();

function isoAt(nowMs) {
  return new Date(nowMs).toISOString();
}

function nowOf(options) {
  if (options && typeof options.now === 'function') return options.now();
  if (options && Number.isFinite(options.now)) return options.now;
  return Date.now();
}

function isAuthError(err) {
  return Boolean(err && (err.code === 'gog_auth_expired' || err.code === 'gog_auth_required'));
}

function isTerminal(err) {
  return Boolean(err && TERMINAL_CODES.has(err.code));
}

function descriptionOf(err) {
  if (!err) return null;
  const raw = err.description != null ? err.description : err.message;
  return raw == null ? null : maskSecrets(String(raw));
}

function recordEvent(step, details = {}) {
  const { doc = null, userKey = null, galaxyUserId = null, sessionId = null } = details;
  const event = {
    at: isoAt(details.now == null ? Date.now() : details.now),
    step: String(step),
    ok: details.ok !== false,
    reason: details.reason || null,
    httpStatus: details.httpStatus == null ? null : Number(details.httpStatus),
    error: details.error == null ? null : String(details.error),
    error_description: details.errorDescription == null ? null : String(details.errorDescription),
    tokenShape: gogCache.tokenShape(doc, { now: details.now }),
    accountId: userKey == null ? null : String(userKey),
    galaxyUserId: galaxyUserId == null ? null : String(galaxyUserId),
    sessionId: sessionId == null ? null : String(sessionId),
  };
  gogCache.appendAuthEvent(event);
  return event;
}

function rememberFailure(userKey, err, step, nowMs) {
  const doc = gogCache.getToken(userKey);
  if (!doc) return null;
  const at = isoAt(nowMs == null ? Date.now() : nowMs);
  const shape = { code: (err && err.code) || 'gog_error', description: descriptionOf(err), at };
  const next = { ...doc, lastError: shape };
  if (step === 'refresh') next.lastRefreshError = shape;
  try {
    gogCache.saveToken(userKey, next);
  } catch (e) {
  }
  return next;
}

function rememberSuccess(userKey, merged, nowMs) {
  const at = isoAt(nowMs == null ? Date.now() : nowMs);
  const next = {
    ...merged,
    refreshedAt: at,
    lastRefreshError: null,
    lastError: null,
  };
  gogCache.saveToken(userKey, next);
  return next;
}

async function refreshOnce(userKey, api, options = {}) {
  const pending = refreshing.get(userKey);
  if (pending) return pending;
  const nowMs = nowOf(options);
  const promise = (async () => {
    const doc = gogCache.getToken(userKey);
    if (!doc) {
      throw new GogError(
        'GOG не подключён: нет токена. Нажмите «Войти через GOG».',
        'gog_auth_required'
      );
    }
    if (!doc.refreshToken) {
      const err = new GogError(
        'Срок действия токена GOG истёк, refresh_token отсутствует: подключите GOG заново.',
        'gog_auth_expired'
      );
      rememberFailure(userKey, err, 'refresh', nowMs);
      recordEvent('refresh', {
        ok: false,
        reason: options.reason || 'buffer',
        error: err.code,
        errorDescription: descriptionOf(err),
        doc,
        userKey,
        galaxyUserId: doc.galaxyUserId,
        sessionId: doc.sessionId,
        now: nowMs,
      });
      throw err;
    }
    try {
      const fresh = await api.refresh(doc.refreshToken);
      const merged = rememberSuccess(
        userKey,
        {
          ...doc,
          accessToken: fresh.accessToken,
          refreshToken: fresh.refreshToken || doc.refreshToken,
          expiresAt: fresh.expiresAt,
          tokenType: fresh.tokenType || doc.tokenType || 'Bearer',
          scope: fresh.scope || doc.scope || null,
          userId: fresh.userId || doc.userId || null,
          sessionId: fresh.sessionId || doc.sessionId || null,
        },
        nowMs
      );
      recordEvent('refresh', {
        ok: true,
        reason: options.reason || 'buffer',
        httpStatus: 200,
        doc: merged,
        userKey,
        galaxyUserId: merged.galaxyUserId,
        sessionId: merged.sessionId,
        now: nowMs,
      });
      return merged;
    } catch (err) {
      const stored = rememberFailure(userKey, err, 'refresh', nowMs);
      recordEvent('refresh', {
        ok: false,
        reason: options.reason || 'buffer',
        httpStatus: err && err.status,
        error: (err && err.code) || 'gog_error',
        errorDescription: descriptionOf(err),
        doc: stored || doc,
        userKey,
        galaxyUserId: doc.galaxyUserId,
        sessionId: doc.sessionId,
        now: nowMs,
      });
      throw err;
    }
  })().finally(() => {
    refreshing.delete(userKey);
  });
  refreshing.set(userKey, promise);
  return promise;
}

async function ensureFreshToken(userKey, api, options = {}) {
  const doc = gogCache.getToken(userKey);
  if (!doc) {
    throw new GogError(
      'GOG не подключён: нет токена. Нажмите «Войти через GOG».',
      'gog_auth_required'
    );
  }
  const nowMs = nowOf(options);
  const marginMs =
    options.marginMs == null ? gogCache.refreshMarginMs() : options.marginMs;
  const expiresMs = gogCache.parseExpiresAt(doc.expiresAt);
  const usable = Boolean(doc.accessToken) && Number.isFinite(expiresMs) && expiresMs > nowMs + marginMs;
  if (usable) return { doc, refreshed: false };
  const merged = await refreshOnce(userKey, api, { ...options, reason: options.reason || 'buffer' });
  return { doc: merged, refreshed: true };
}

function wrapClient(api, userKey, options = {}) {
  if (!api || typeof api !== 'object') return api;
  const client = Object.create(null);
  Object.assign(client, api);
  for (const name of TOKEN_METHODS) {
    const original = api[name];
    if (typeof original !== 'function') continue;
    client[name] = async (tokenDoc, ...rest) => {
      const { doc } = await ensureFreshToken(userKey, api, options);
      try {
        return await original.call(api, doc, ...rest);
      } catch (err) {
        if (!isAuthError(err)) throw err;
        const nowMs = nowOf(options);
        rememberFailure(userKey, err, name, nowMs);
        recordEvent(name, {
          ok: false,
          reason: 'auth_error',
          httpStatus: err && err.status,
          error: err.code,
          errorDescription: descriptionOf(err),
          doc: gogCache.getToken(userKey),
          userKey,
          now: nowMs,
        });
        const retried = await refreshOnce(userKey, api, { ...options, reason: '401' });
        try {
          return await original.call(api, retried, ...rest);
        } catch (again) {
          if (isAuthError(again)) {
            const retryAt = nowOf(options);
            rememberFailure(userKey, again, name, retryAt);
            recordEvent(name, {
              ok: false,
              reason: 'auth_error_after_refresh',
              httpStatus: again && again.status,
              error: again.code,
              errorDescription: descriptionOf(again),
              doc: gogCache.getToken(userKey),
              userKey,
              now: retryAt,
            });
          }
          throw again;
        }
      }
    };
  }
  return client;
}

function authViewOf(doc) {
  const state = gogCache.authStateOf(doc);
  if (!state) return null;
  return {
    status: state.status,
    hasRefreshToken: state.hasRefreshToken,
    expiresAt: state.expiresAt,
    expiresInMs: state.expiresInMs,
    expired: state.expired,
    expiring: state.expiring,
    refreshable: state.refreshable,
    needsReconnect: state.needsReconnect,
    refreshedAt: state.refreshedAt,
    lastRefreshError: state.lastRefreshError,
    lastError: state.lastError,
    binding: state.binding,
  };
}

module.exports = {
  TERMINAL_CODES,
  TOKEN_METHODS,
  isAuthError,
  isTerminal,
  descriptionOf,
  recordEvent,
  refreshOnce,
  ensureFreshToken,
  wrapClient,
  authViewOf,
};
