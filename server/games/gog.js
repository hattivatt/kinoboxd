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
 */

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const gogCache = require('./gog-cache');
const { createBreaker } = require('../core/breaker');
const { nodeRequest } = require('../core/http');
const sources = require('../core/sources');

const AUTH_HOST = 'auth.gog.com';
const EMBED_HOST = 'embed.gog.com';
const GAMEPLAY_HOST = 'gameplay.gog.com';

const REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client';

/**
 * Public GOG Galaxy client credentials. They are not user secrets: every
 * open-source GOG client ships them. Policy (§14.5, AGENTS §2) still forbids
 * echoing them in docs/logs, so they are never interpolated into messages.
 *
 * The secret is the **full 64-hex** value (`gogapidocs`, lgogdownloader,
 * Heroic, Minigalaxy). A truncated 32-hex prefix is rejected by
 * `auth.gog.com/token` with `invalid_client` / «The client credentials are
 * invalid» — that truncated literal was the 01.11.2026 production bug (the
 * user saw exactly that message for a fresh, unused code). Guarded by a unit
 * test: `GOG_CLIENT_SECRET` must match /^[0-9a-f]{64}$/.
 */
const PUBLIC_CLIENT_ID = '46899977096215655';
const PUBLIC_CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';

const DEFAULT_TIMEOUT_MS = sources.timeoutMs('gog');
const DEFAULT_LIBRARY_PAUSE_MS = sources.pauseMs('gog');
const DEFAULT_PLAYTIME_PAUSE_MS = sources.SOURCES.gog.playtimePauseMs;
const DEFAULT_BREAKER_MS = sources.breakerMs('gog');
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const PRODUCTS_PER_PAGE = 100;

const CLIENT_FILE_ENV = 'KINOBOXD_GOG_CLIENT_FILE';
const CLIENT_FILE_PATH = path.join(__dirname, '..', '..', 'config', 'gog-client.json');

class GogError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'GogError';
    this.code = code || 'gog_error';
    if (details.status != null) this.status = details.status;
    if (details.retryAt != null) this.retryAt = details.retryAt;
    if (details.host != null) this.host = details.host;
    // GOG's own `error_description` (already masked): kept for the
    // auth-lifecycle dump, never concatenated into a message here.
    if (details.description != null) this.description = String(details.description);
  }
}

/* ------------------------------------------------------------------ */
/* secrets                                                             */
/* ------------------------------------------------------------------ */

/**
 * Remove OAuth material from a URL/text. Covers user tokens and the public
 * client secret; the client id stays (it is part of the redirect URL the user
 * opens) but is never logged on its own.
 */
function maskSecrets(value) {
  return String(value == null ? '' : value)
    .replace(/([?&](?:access_token|refresh_token|client_secret|code)=)[^&\s"']+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***');
}

/* ------------------------------------------------------------------ */
/* auth code input                                                     */
/* ------------------------------------------------------------------ */

/**
 * Accept both shapes a user can realistically paste after the GOG login:
 *   - the bare `code` value;
 *   - the whole redirect URL (`https://embed.gog.com/on_login_success?
 *     origin=client&code=<code>`), including the `#code=…` fragment form and
 *     a stray `code=…` string with no scheme;
 *   - the same value wrapped in quotes/angle brackets by a copy action.
 * Returns `''` when the input carries no code (e.g. a login page URL pasted
 * before the login finished) so the caller can raise `gog_code_required`.
 * The value is a one-time secret: it is never logged, only trimmed.
 */
function extractAuthCode(raw) {
  const value = String(raw == null ? '' : raw)
    .trim()
    .replace(/^[<"'\s]+/, '')
    .replace(/[>"'\s]+$/, '');
  if (!value) return '';
  const isUrl = /^https?:\/\//i.test(value);
  const hasCodeParam = /(^|[?&#])code=/i.test(value);
  if (!isUrl && !hasCodeParam) return value;

  let candidate = '';
  if (isUrl) {
    try {
      const parsed = new URL(value);
      candidate = parsed.searchParams.get('code') || '';
      if (!candidate && parsed.hash) {
        candidate = new URLSearchParams(parsed.hash.replace(/^#/, '')).get('code') || '';
      }
    } catch (err) {
      candidate = '';
    }
  }
  if (!candidate) {
    const match =
      /[?&#]code=([^&#\s]+)/i.exec(value) ||
      /^code=([^&#\s]+)/i.exec(value);
    if (match) {
      try {
        candidate = decodeURIComponent(match[1]);
      } catch (err) {
        candidate = match[1];
      }
    }
  }
  return String(candidate || '').trim();
}

/**
 * Human-readable verdicts for the OAuth error codes GOG returns from
 * `/token`. The important distinction (01.11.2026 incident): `invalid_client`
 * means **our app credentials** are rejected — retrying the code is useless;
 * `invalid_grant` means the **code** is expired/used or the `redirect_uri`
 * did not match the auth request.
 */
const OAUTH_ERRORS = {
  invalid_client: {
    code: 'gog_client_rejected',
    status: 502,
    message:
      'GOG отклонил client credentials (invalid_client): встроенная пара Galaxy-клиента не принята. ' +
      'Это ошибка настройки сервера, а не вашего code — повторная вставка не поможет. ' +
      'Проверьте GOG_CLIENT_ID/GOG_CLIENT_SECRET (secret — полные 64 hex-символа) ' +
      'или config/gog-client.json.',
  },
  invalid_grant: {
    code: 'gog_invalid_code',
    status: 400,
    message:
      'GOG не принял code (invalid_grant): он просрочен, уже использован или redirect_uri не совпал ' +
      'со ссылкой входа. Нажмите «Войти через GOG» ещё раз и вставьте новый code (или всю ссылку).',
  },
  invalid_request: {
    code: 'gog_invalid_request',
    status: 400,
    message:
      'GOG отклонил запрос обмена (invalid_request): не хватает параметра или он продублирован. ' +
      'Вставьте code целиком, без обрезания.',
  },
  unauthorized_client: {
    code: 'gog_client_rejected',
    status: 502,
    message:
      'GOG не разрешает этому клиенту обмен по authorization_code (unauthorized_client). ' +
      'Это ошибка настройки сервера, code тут ни при чём.',
  },
  unsupported_grant_type: {
    code: 'gog_invalid_request',
    status: 502,
    message: 'GOG не поддерживает запрошенный grant_type: обмен code недоступен.',
  },
};

/**
 * Map a failed `/token` response to `{ code, status, message }`. `detail` is
 * GOG's own `error_description` (already masked) and is appended so the user
 * sees the real reason instead of a generic «не принял code».
 */
function oauthFailure(response, { detail = '', rawError = '' } = {}) {
  const known = OAUTH_ERRORS[rawError] || null;
  if (known) {
    return {
      code: known.code,
      status: known.status,
      message: `${known.message}${detail ? ` Ответ GOG: «${detail}».` : ''}`,
    };
  }
  return {
    code: 'gog_invalid_code',
    status: 400,
    message:
      `GOG не принял code (${response.status})${detail ? `: ${detail}` : ''}. ` +
      'Скопируйте code заново: он одноразовый и живёт несколько минут.',
  };
}

/* ------------------------------------------------------------------ */
/* client credentials                                                  */
/* ------------------------------------------------------------------ */

let credentialsCache = null;

function clientFilePath() {
  const override = process.env[CLIENT_FILE_ENV];
  if (typeof override === 'string' && override.trim()) return path.resolve(override.trim());
  return CLIENT_FILE_PATH;
}

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
 * Resolve the Galaxy client credentials once:
 *   env `GOG_CLIENT_ID`+`GOG_CLIENT_SECRET` → `config/gog-client.json` →
 *   the public built-in pair. Partial env (only one of the two) is ignored on
 *   purpose: a half-configured pair is a deployment mistake, and the public
 *   fallback still works.
 */
function loadCredentials() {
  if (credentialsCache) return credentialsCache;
  const envId = process.env.GOG_CLIENT_ID;
  const envSecret = process.env.GOG_CLIENT_SECRET;
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
    clientId: PUBLIC_CLIENT_ID,
    clientSecret: PUBLIC_CLIENT_SECRET,
    source: 'default',
  };
  return credentialsCache;
}

/** `env` | `file` | `default` — never the value. */
function clientSource() {
  return loadCredentials().source;
}

/** Test helper: forget the cached pair so the next call re-reads env/file. */
function resetCredentialsCache() {
  credentialsCache = null;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function networkError(err, target) {
  if (err instanceof GogError) return err;
  let host = '';
  try {
    host = new URL(target).host;
  } catch (e) {
    host = '';
  }
  return new GogError(
    `GOG недоступен (${host || 'network'}): ${maskSecrets((err && (err.code || err.message)) || 'network error')}. ` +
      'Это сетевая ошибка, данные не кэшируются как «пустая библиотека».',
    'gog_unreachable',
    { host }
  );
}

/**
 * Minimal GET client (no dependency). Returns `{ status, headers, body }`.
 * Redirects are followed by default; `followRedirect: false` is used for the
 * authenticated endpoints so a `302 → /login` is reported as `auth_expired`
 * instead of being followed to an HTML page.
 */
function httpGet(target, options = {}) {
  const timeoutMs = options.timeoutMs || envInt('GAMES_GOG_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const redirectsLeft = options.redirectsLeft == null ? MAX_REDIRECTS : options.redirectsLeft;
  const followRedirect = options.followRedirect !== false;
  return nodeRequest(target, {
    timeoutMs,
    maxRedirects: followRedirect ? redirectsLeft : 0,
    followRedirect,
    maxBytes: MAX_BODY_BYTES,
    headers: {
      'User-Agent': 'kinoboxd/1.0 (+games-tab; gog)',
      Accept: 'application/json, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(options.headers || {}),
    },
    label: 'gog',
  }).catch((err) => {
    if (err && err.code === 'invalid_url') {
      throw new GogError(`Некорректный URL: ${maskSecrets(target)}`, 'gog_invalid_url');
    }
    if (err && err.code === 'too_many_redirects') {
      throw new GogError(`Слишком много редиректов: ${maskSecrets(target)}`, 'gog_http_error', {
        status: err.status,
      });
    }
    throw networkError(err, target);
  });
}

function parseJsonBody(response, url) {
  try {
    return JSON.parse(response.body);
  } catch (err) {
    throw new GogError(
      `GOG ответил ${response.status} не-JSON: ${maskSecrets(url)}`,
      'gog_http_error',
      { status: response.status }
    );
  }
}

/** Best-effort JSON for error bodies: never throws, never logs. */
function safeJson(body) {
  try {
    const parsed = JSON.parse(String(body == null ? '' : body));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}

/**
 * First `max` bytes of a response body for the diagnostic dump
 * (`cache-games/debug/gog/<id>.json`). Truncation is marked explicitly so a cut
 * JSON body can never be mistaken for a malformed answer.
 */
function truncateBody(body, max = 5 * 1024) {
  const text = String(body == null ? '' : body);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated ${text.length - max} B]`;
}

/* ------------------------------------------------------------------ */
/* client                                                              */
/* ------------------------------------------------------------------ */

/**
 * Which numeric id `gameplay.gog.com` expects as `{uid}`.
 *
 * The reference implementations all use the **Galaxy** id, never the
 * `userData.json` `userId` field:
 *   - Heroic `getGOGPlaytime` — `credentials.user_id` (the OAuth token
 *     response field);
 *   - unifideck `fetch_gog_playtime_minutes` (verified live 06.2026) —
 *     `user_info.galaxy_user_id` from `embed.gog.com/userData.json`;
 *   - comet `sessions.rs` — `user_info.galaxy_user_id` (it even compares the
 *     Galaxy proto `user_id` with it).
 *
 * The 01.11.2026 production bug («в профиле GOG часы есть, у нас 0.00»): the
 * client sent `userData.json.userId`, which is a **different** field from
 * `galaxyUserId` (the fixture models both: `userId` 1234567890 vs
 * `galaxyUserId` 5555555555). A foreign uid answers `{"time_sum":0}`/404 for
 * every game — a systematic zero that looked like "GOG has no playtime".
 *
 * Order: OAuth `user_id` (token) → `galaxyUserId` (userData) → legacy `userKey`
 * (the `userId` field older snapshots stored).
 */
function gameplayUserId(tokenDoc) {
  const candidates = gameplayUserIdCandidates(tokenDoc);
  return candidates.length ? { uid: candidates[0].value, source: candidates[0].source } : { uid: null, source: null };
}

/**
 * Every numeric id the token can offer for `gameplay.gog.com`, in preference
 * order, **with the source label**. Reported in the import status as
 * `playtime.uidCandidates` so «0.0 ч» can be answered with facts: if
 * `token:user_id` and `userData:userId` carry the same number and
 * `userData:galaxyUserId` differs, the OAuth `user_id` is not the Galaxy id and
 * the order (not the presence) is the remaining problem.
 */
function gameplayUserIdCandidates(tokenDoc) {
  const candidates = [
    { value: tokenDoc && tokenDoc.userId, source: 'token:user_id' },
    { value: tokenDoc && tokenDoc.galaxyUserId, source: 'userData:galaxyUserId' },
    { value: tokenDoc && tokenDoc.userKey, source: 'userData:userId' },
  ];
  const out = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!gogCache.isValidUserKey(candidate.value)) continue;
    const value = String(candidate.value).trim();
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ value, source: candidate.source });
  }
  return out;
}

/**
 * Minutes out of one `sessions` response, with the field that carried them.
 *
 * `time_sum` (minutes) is the field every open-source client reads
 * (Heroic/comet/unifideck). The extra shapes are read-only fallbacks for a
 * service that answers a session list instead of a pre-summed number: a **sum
 * of the session lengths** is still the same quantity, never an invented one.
 */
function minutesOfSessionsPayload(json) {
  if (!json || typeof json !== 'object') return { minutes: null, field: null };
  const direct = ['time_sum', 'timeSum', 'total_time', 'totalTime', 'total_minutes'];
  for (const field of direct) {
    if (json[field] == null) continue;
    const value = Number(json[field]);
    if (Number.isFinite(value) && value >= 0) {
      return { minutes: Math.round(value * 100) / 100, field };
    }
  }
  const sessions = Array.isArray(json.sessions) ? json.sessions : null;
  if (sessions) {
    let sum = 0;
    let counted = 0;
    for (const session of sessions) {
      if (!session || typeof session !== 'object') continue;
      const value = Number(
        session.time != null
          ? session.time
          : session.time_sum != null
            ? session.time_sum
            : session.minutes != null
              ? session.minutes
              : session.duration_minutes
      );
      if (Number.isFinite(value) && value >= 0) {
        sum += value;
        counted++;
      }
    }
    if (counted) {
      return { minutes: Math.round(sum * 100) / 100, field: 'sessions[]', sessions: counted };
    }
    // An empty session list is a real zero: the game was never launched.
    return { minutes: 0, field: 'sessions[]', sessions: 0 };
  }
  return { minutes: null, field: null };
}

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

  let lastLibraryAt = null;
  let lastPlaytimeAt = null;
  const breaker = createBreaker({
    now,
    cooldownMs: () => breakerMs,
    read: () => breakerStore.read(),
    write: (state) => breakerStore.write(state),
  });

  function breakerFor(host) {
    return breaker.entry(host);
  }

  function tripBreaker(host, reason) {
    return breaker.trip(host, reason);
  }

  function assertNotBlocked(host) {
    const entry = breakerFor(host);
    if (!entry) return;
    throw new GogError(
      `GOG (${host}) временно не опрашивается: предыдущий ответ ${entry.reason}. ` +
        `Повтор через ${Math.max(1, Math.ceil((entry.until - now()) / 60000))} мин.`,
      'gog_rate_limited',
      { host, retryAt: new Date(entry.until).toISOString() }
    );
  }

  async function pause(kind) {
    if (kind === 'library') {
      if (libraryPauseMs > 0 && lastLibraryAt != null) {
        await sleep(libraryPauseMs);
      }
      lastLibraryAt = now();
      return;
    }
    if (playtimePauseMs > 0 && lastPlaytimeAt != null) await sleep(playtimePauseMs);
    lastPlaytimeAt = now();
  }

  function bearer(tokenDoc) {
    if (!tokenDoc || !tokenDoc.accessToken) {
      throw new GogError(
        'GOG не подключён: нет токена. Нажмите «Войти через GOG».',
        'gog_auth_required'
      );
    }
    return { Authorization: `Bearer ${tokenDoc.accessToken}` };
  }

  async function authenticatedGet(url, tokenDoc, { host, kind }) {
    assertNotBlocked(host);
    await pause(kind);
    const response = await request(url, {
      headers: bearer(tokenDoc),
      followRedirect: false,
    });
    const status = response.status;
    if (status >= 300 && status < 400) {
      throw new GogError(
        `GOG (${host}) требует повторного входа (${status} → логин). Токен истёк или отозван.`,
        'gog_auth_expired',
        { host, status }
      );
    }
    if (status === 401 || status === 403) {
      // 401 = the token is not valid any more (reconnect); 403 = GOG is
      // blocking automation → breaker. A 401 is not a host block.
      if (status === 403) tripBreaker(host, '403');
      throw new GogError(
        status === 401
          ? 'GOG отклонил токен (401): требуется повторный вход.'
          : 'GOG ответил 403: автоматизация временно заблокирована (breaker 30 мин).',
        status === 401 ? 'gog_auth_expired' : 'gog_rate_limited',
        { host, status, retryAt: status === 403 ? new Date(now() + breakerMs).toISOString() : undefined }
      );
    }
    if (status === 429) {
      tripBreaker(host, '429');
      throw new GogError(
        'GOG ответил 429: запросы приостановлены на 30 минут (breaker).',
        'gog_rate_limited',
        { host, status, retryAt: new Date(now() + breakerMs).toISOString() }
      );
    }
    if (status < 200 || status >= 300) {
      throw new GogError(
        `GOG (${host}) ответил ${status}: ${maskSecrets(url)}`,
        'gog_http_error',
        { host, status }
      );
    }
    return response;
  }

  /* --------------------------- OAuth --------------------------- */

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
    // ONE unit inside the module: `expires_in` (seconds, OAuth2) → ms, and a
    // value that cannot be seconds is already ms. `gogCache.expiresInMs` is
    // the only converter; a default of 1 h is used when GOG omits the field.
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
      // The exchange MUST repeat the exact redirect_uri used in the auth URL,
      // otherwise GOG answers invalid_grant even for a fresh code.
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
      // Never echo the code or the secret: only GOG's own error code/text.
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
      // GOG's own text («Invalid refresh token, client_id:…») is the only
      // evidence of *which* half broke; it never contains the token value and
      // is masked anyway, so it is kept on the error for the lifecycle dump.
      const description = parsed && parsed.error_description
        ? maskSecrets(String(parsed.error_description))
        : '';
      if (rawError === 'invalid_client' || rawError === 'unauthorized_client') {
        // The app credentials broke, not the user's session: reconnect would
        // fail the same way, so say so instead of «подключите GOG заново».
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

  /** Identity of the token owner (`embed.gog.com/userData.json`). */
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

  /* ------------------------- library --------------------------- */

  /** One page of `getFilteredProducts` (100 products by default). */
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

  /**
   * Walk every library page. `maxPages` is a safety valve for tests; the
   * default follows `totalPages` from the first response.
   */
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

  /** Owned product ids only (`/user/data/games`); useful as a sanity check. */
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

  /* ------------------------- playtime -------------------------- */

  /**
   * `time_sum` in **minutes** for one product.
   *
   * A 404 means "no sessions recorded" (a game that was never launched) — a
   * real zero, reported as `status:'not_found'` so the importer can re-check it
   * instead of freezing the zero forever. A 200 without a recognizable field
   * is **not** a zero: `status:'unparsed'`, `minutes:null` — the caller keeps
   * it pending and dumps the raw body (`cache-games/debug/gog/`).
   */
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
    options: { libraryPauseMs, playtimePauseMs, breakerMs, endpoints },
    authorizeUrl,
    exchangeCode,
    refresh,
    getUserData,
    getFilteredProducts,
    fetchAllProducts,
    getOwnedIds,
    getSessions,
    assertNotBlocked,
    tripBreaker,
    breakerFor,
    // Exposed for tests/diagnostics only.
    _credentialProvider: credentialProvider,
  };
}

/* ------------------------------------------------------------------ */
/* normalization                                                       */
/* ------------------------------------------------------------------ */

/**
 * Normalize one `getFilteredProducts` row. The public field for the product id
 * is `gogGameId` (the brief fixes the name); the raw `id` is kept as
 * `gogProductId` for debugging.
 */
function normalizeProduct(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id != null ? String(raw.id) : raw.productId != null ? String(raw.productId) : null;
  if (!id) return null;
  return {
    gogGameId: id,
    gogProductId: id,
    title: raw.title || null,
    slug: raw.slug || null,
    image: raw.image || null,
    worksOn: raw.worksOn && typeof raw.worksOn === 'object' ? raw.worksOn : null,
    category: raw.category || null,
    rating: raw.rating != null ? Number(raw.rating) : null,
    releaseDate: raw.releaseDate || null,
    isGame: typeof raw.isGame === 'boolean' ? raw.isGame : null,
    isMovie: typeof raw.isMovie === 'boolean' ? raw.isMovie : null,
    dlcCount: raw.dlcCount != null ? Number(raw.dlcCount) : null,
    isHidden: raw.isHidden === true,
    tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 50) : [],
  };
}

/** Fingerprint of the owned set (product ids in library order). */
function libraryFingerprint(products) {
  return (products || [])
    .map((product) => (product && (product.gogGameId || product.gogProductId)) || '')
    .filter(Boolean)
    .join(',');
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
