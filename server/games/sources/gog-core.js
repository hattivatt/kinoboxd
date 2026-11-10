'use strict';

/**
 * GOG constants, the client error type and every pure parser/normalizer.
 *
 * This module owns the pieces that carry no I/O: the host constants, the OAuth
 * error table, the secret masker, the auth-code extractor and the
 * product/session normalizers. `gog.js` re-exports all of it, so the public
 * surface of the client module is unchanged; `gog-requests.js` and
 * `gog-client.js` import the primitives directly and never require `gog.js`
 * back (no cycle).
 */

const { URL } = require('url');

const gogCache = require('../gog-cache');
const sources = require('../../core/sources');

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
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
/* playtime ids                                                        */
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
  AUTH_HOST,
  EMBED_HOST,
  GAMEPLAY_HOST,
  REDIRECT_URI,
  PUBLIC_CLIENT_ID,
  PUBLIC_CLIENT_SECRET,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_LIBRARY_PAUSE_MS,
  DEFAULT_PLAYTIME_PAUSE_MS,
  DEFAULT_BREAKER_MS,
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
  PRODUCTS_PER_PAGE,
  GogError,
  maskSecrets,
  extractAuthCode,
  OAUTH_ERRORS,
  oauthFailure,
  envInt,
  sleepDefault,
  safeJson,
  truncateBody,
  gameplayUserId,
  gameplayUserIdCandidates,
  minutesOfSessionsPayload,
  normalizeProduct,
  libraryFingerprint,
};
