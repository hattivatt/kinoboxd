'use strict';

/**
 * GOG auth lifecycle: silent refresh + the diagnostic trail (M6a-fix,
 * 01.11.2026).
 *
 * The production loop this module closes: the GOG **access** token lives ≈1 h,
 * the **refresh** token lives much longer. The old code refreshed only when the
 * access token was within 60 s of expiry *at the start of an import*, and the
 * status block treated «access token past» as «подключите GOG заново» — so one
 * hour after a successful connect/import the UI demanded a reconnect while the
 * library snapshot (93 games) was perfectly valid. Reconnecting «fixed» it for
 * another hour, which is exactly what the user saw.
 *
 * Rules implemented here:
 *   1. **Silent refresh before every token-needing call** (`userData`,
 *      `getFilteredProducts`, `fetchAllProducts`, `getOwnedIds`, `getSessions`):
 *      if `expiresAt` is inside a 5-minute buffer (or unparseable) the token is
 *      refreshed from `refresh_token` first;
 *   2. **One retry on a 401/302** from the API: a revoked-but-not-yet-expired
 *      token is refreshed once and the call repeated once. A second auth error
 *      propagates — no retry storms;
 *   3. **A refresh failure never touches the library snapshot** (the importer
 *      keeps the dated snapshot; only the token document records the error);
 *   4. **Every step is recorded** in `cache-games/debug/gog/auth-lifecycle.json`
 *      with presence booleans and expiry only — never a token value.
 *
 * Concurrent calls share one in-flight refresh (`refreshing` map) so a
 * paginated library fetch cannot rotate the refresh token twice.
 */

const gogCache = require('./gog-cache');
const { GogError, maskSecrets } = require('./gog');

/** Codes that mean «the user has to log in again», not «retry later». */
const TERMINAL_CODES = new Set(['gog_auth_expired', 'gog_invalid_code']);

/** Token-needing methods of the GOG client (wrapped by `wrapClient`). */
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

/** Masked error description for the dump (GOG's own text or our code). */
function descriptionOf(err) {
  if (!err) return null;
  const raw = err.description != null ? err.description : err.message;
  return raw == null ? null : maskSecrets(String(raw));
}

/**
 * One masked lifecycle row. `step` is the operation (`connect`, `refresh`,
 * `user_data`, `library`, `sessions`, …), `reason` says *why* a refresh ran
 * (`buffer`, `401`, `connect`).
 */
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
    // The session id is a GOG-side session label, not a token value; it is
    // only kept in this file (never in the public API).
    sessionId: sessionId == null ? null : String(sessionId),
  };
  gogCache.appendAuthEvent(event);
  return event;
}

/** Persist the failure facts on the token document (best effort). */
function rememberFailure(userKey, err, step, nowMs) {
  const doc = gogCache.getToken(userKey);
  if (!doc) return null;
  const at = isoAt(nowMs == null ? Date.now() : nowMs);
  const shape = { code: (err && err.code) || 'gog_error', description: descriptionOf(err), at };
  const next = { ...doc, lastError: shape };
  // `lastRefreshError` is only about /token; an API 401 is `lastError`.
  if (step === 'refresh') next.lastRefreshError = shape;
  try {
    gogCache.saveToken(userKey, next);
  } catch (e) {
    /* a read-only cache must not break the import */
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

/**
 * Refresh the access token once and persist the result. Shared by the
 * buffer-based path and the 401 retry. Concurrent callers for one account
 * await the same promise (a second refresh would rotate the refresh token
 * while the first one is still in flight).
 */
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
          // The refresh response carries `user_id` too: an account connected
          // before the uid fix gets it on the first refresh.
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

/**
 * A token document with a usable access token. Refreshes when the access token
 * expires within `marginMs` (default 5 min) — or when its expiry cannot be
 * parsed at all (an unknown lifetime is never treated as valid).
 */
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

/**
 * Wrap a GOG client so every token-needing call is preceded by a silent
 * refresh check and retried **once** after a 401/302. Everything else (OAuth
 * helpers, breaker access, `options`) passes through untouched.
 */
function wrapClient(api, userKey, options = {}) {
  if (!api || typeof api !== 'object') return api;
  const client = Object.create(null);
  Object.assign(client, api);
  for (const name of TOKEN_METHODS) {
    const original = api[name];
    if (typeof original !== 'function') continue;
    // The client contract is `method(tokenDoc, ...args)`: the first argument is
    // *replaced* by the freshly ensured token document, never prepended.
    client[name] = async (tokenDoc, ...rest) => {
      const { doc } = await ensureFreshToken(userKey, api, options);
      try {
        return await original.call(api, doc, ...rest);
      } catch (err) {
        if (!isAuthError(err)) throw err;
        // The token was rejected although it looked alive (revoked/rotated):
        // refresh once, repeat the call once, then let the error through.
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

/** A sanitized auth block for `/status` and `/stats` (no token values). */
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
