'use strict';

/**
 * Steam Store client (M2 `appdetails` + M4 review summary).
 *
 * `store.steampowered.com/api/appdetails` is the only cheap source of
 * `developers`/`publishers`/`genres`/`categories`/`release_date`/`dlc`/
 * `metacritic`/`type`/`is_free`/`platforms` (ИГРЫ-АРХИТЕКТУРА.md §2.2, §3.6).
 * It is an UNOFFICIAL endpoint, so this module is deliberately defensive:
 *
 *   - **one appid per request.** Verified live 01.11.2026: `appids=620,570`
 *     answers `400` (24 bytes, gzip) for every batch size ≥2, while a single
 *     appid answers `200`; batching is therefore not used;
 *   - `GAMES_STORE_PAUSE_MS` (default **1700 ms**) before every request — the
 *     observed limit is ~200 requests / 5 min / IP and 340 games must fit;
 *   - `403`/`429` trip a persisted 30-minute breaker (`GAMES_STORE_BREAKER_MS`)
 *     for `store.steampowered.com`;
 *   - a network/DNS/TLS/5xx failure is thrown as `store_unreachable` /
 *     `store_http_error` and is NEVER written to the cache (deferred, no
 *     negative cache — AGENTS.md §1);
 *   - `success:false` (region-locked / delisted app) IS an answer: it is
 *     returned as `{ success: false, unavailable: true }` so the enricher can
 *     record "no details" honestly and stop asking for the TTL window.
 *
 * DNS: the same `GAMES_STEAM_DNS_SERVERS` switch as `steam.js` is reused (the
 * sandbox resolver returns TLS-dead edge IPs for Steam hosts; 8.8.8.8 works).
 *
 * The response is cleaned to the fields the tab actually uses — no
 * `detailed_description`, no price, no `pc_requirements`.
 */

const steam = require('./steam');
const gameCache = require('./game-cache');
const { createSourceGate } = require('../core/source-client');
const sources = require('../core/sources');

const STORE_HOST = 'store.steampowered.com';
const DETAILS_URL = `https://${STORE_HOST}/api/appdetails`;
// Reviews moved off the store domain on 22.10.2026: the old
// `store.steampowered.com/appreviews/<appid>?json=1` feed now answers
// `302 -> https://store.steampowered.com/` (verified live 01.11.2026, every
// variant: json=1, num_per_page=0, cookie jar, browser headers). The
// replacement is a Web API method that needs no key and returns the same
// `query_summary` (review_score 1..9, desc, positive/negative/total).
const REVIEWS_HOST = 'api.steampowered.com';
// The breaker key is distinct from the Web API host key used by steam.js:
// a reviews 429 must not freeze GetOwnedGames/achievements for 30 minutes.
const REVIEWS_BREAKER_KEY = `${REVIEWS_HOST}/IUserReviewsService`;
const REVIEWS_URL = `https://${REVIEWS_HOST}/IUserReviewsService/GetAppReviews/v1/`;
const DEFAULT_PAUSE_MS = sources.pauseMs('steamStore');
const DEFAULT_REVIEWS_PAUSE_MS = sources.pauseMs('steamReviews');
const DEFAULT_BREAKER_MS = sources.breakerMs('steamStore');
const DEFAULT_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const DEFAULT_REVIEWS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SCREENSHOTS = 10;
const YEAR_MIN = 1970;
const YEAR_MAX = 2100;

/** Every store error carries a stable `code` the routes map to HTTP status. */
class StoreError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code || 'store_error';
    if (details.status != null) this.status = details.status;
    if (details.retryAt != null) this.retryAt = details.retryAt;
    if (details.host != null) this.host = details.host;
  }
}

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detailsTtlMs() {
  // Single source of truth lives in game-cache (it also owns the file TTLs).
  return gameCache.detailsTtlMs();
}

/* ------------------------------------------------------------------ */
/* Release date parsing                                                */
/* ------------------------------------------------------------------ */

const MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function saneYear(raw) {
  const year = Number(raw);
  if (!Number.isInteger(year)) return null;
  return year >= YEAR_MIN && year <= YEAR_MAX ? year : null;
}

/**
 * Parse the display date Steam sends in `release_date.date`.
 *
 * Formats seen live: `"Apr 18, 2011"`, `"18 May, 2015"`, `"3 Mar, 2015"`,
 * `"Q4 2026"`, `"September 2026"`, `"2026"`, `"Coming soon"`. The returned
 * `year` is the chart bucket; `precision` says how exact the date was, so the
 * payload never pretends a quarter is a day.
 *
 * Years outside 1970..2100 are treated as unknown (games only; a stray
 * "1 Jan, 1900" placeholder must not create a fake decade).
 */
function parseReleaseDate(value) {
  const text = String(value == null ? '' : value).trim();
  const result = { text: text || null, year: null, month: null, day: null, precision: 'unknown' };
  if (!text) return result;

  let match = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (match && MONTHS[match[1].toLowerCase()]) {
    const year = saneYear(match[3]);
    if (year != null) {
      return {
        text,
        year,
        month: MONTHS[match[1].toLowerCase()],
        day: Number(match[2]),
        precision: 'day',
      };
    }
  }

  match = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(text);
  if (match && MONTHS[match[2].toLowerCase()]) {
    const year = saneYear(match[3]);
    if (year != null) {
      return {
        text,
        year,
        month: MONTHS[match[2].toLowerCase()],
        day: Number(match[1]),
        precision: 'day',
      };
    }
  }

  match = /^([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(text);
  if (match && MONTHS[match[1].toLowerCase()]) {
    const year = saneYear(match[2]);
    if (year != null) {
      return { text, year, month: MONTHS[match[1].toLowerCase()], day: null, precision: 'month' };
    }
  }

  match = /^Q([1-4])\s+(\d{4})$/i.exec(text);
  if (match) {
    const year = saneYear(match[2]);
    if (year != null) {
      return { text, year, month: null, day: null, precision: 'quarter', quarter: Number(match[1]) };
    }
  }

  match = /^(\d{4})$/.exec(text);
  if (match) {
    const year = saneYear(match[1]);
    if (year != null) return { text, year, month: null, day: null, precision: 'year' };
  }

  // Last resort: any sane 4-digit year inside a phrase ("Late 2026", "2026-2027").
  match = /(?<!\d)(\d{4})(?!\d)/.exec(text);
  if (match) {
    const year = saneYear(match[1]);
    if (year != null) return { text, year, month: null, day: null, precision: 'year' };
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Parsers (pure)                                                      */
/* ------------------------------------------------------------------ */

function stringList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (entry == null) continue;
    const text = String(entry).trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function idDescriptionList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || entry.description == null) continue;
    const description = String(entry.description).trim();
    if (!description || seen.has(description)) continue;
    seen.add(description);
    out.push({ id: entry.id == null ? null : String(entry.id), description });
  }
  return out;
}

/**
 * Absolute http(s) asset URL or null. `appdetails` already returns absolute
 * `header_image`/`capsule_image` URLs, but the parser stays defensive: a
 * relative or non-http value would make the browser paint a broken image.
 */
function absoluteAssetUrl(value) {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

function screenshotList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const url = entry && (entry.path_full || entry.path_thumbnail);
    if (!url) continue;
    out.push(String(url));
    if (out.length >= MAX_SCREENSHOTS) break;
  }
  return out;
}

/**
 * Early Access is a *genre* on the store (`{id:"70", description:"Early
 * Access"}`); category ids are not stable enough to trust (live 01.11: id 70
 * came back as "Surround Sound"), so only descriptions are matched.
 */
function isEarlyAccessOf(categories, genres) {
  for (const entry of categories || []) {
    if (/early access/i.test(String(entry.description || ''))) return true;
  }
  for (const entry of genres || []) {
    if (/early access/i.test(String(entry.description || ''))) return true;
  }
  return false;
}

/**
 * Clean one `appdetails` `data` object into the §3.6 cache document.
 * `fetchedAt` is added by the caller (it owns the clock).
 */
function parseAppDetails(data, appid) {
  const source = data && typeof data === 'object' ? data : {};
  const genres = idDescriptionList(source.genres);
  const categories = idDescriptionList(source.categories);
  const releaseDate = source.release_date && typeof source.release_date === 'object'
    ? source.release_date
    : {};
  const parsedDate = parseReleaseDate(releaseDate.date);
  const dlc = Array.isArray(source.dlc)
    ? source.dlc.map(Number).filter((value) => Number.isFinite(value))
    : [];
  const platforms = source.platforms && typeof source.platforms === 'object'
    ? {
        windows: Boolean(source.platforms.windows),
        mac: Boolean(source.platforms.mac),
        linux: Boolean(source.platforms.linux),
      }
    : null;
  return {
    appid: Number(appid),
    success: true,
    type: source.type == null ? null : String(source.type),
    name: source.name == null ? null : String(source.name),
    is_free: typeof source.is_free === 'boolean' ? source.is_free : null,
    developers: stringList(source.developers),
    publishers: stringList(source.publishers),
    genres,
    categories,
    release_date: {
      date: parsedDate.text,
      coming_soon: Boolean(releaseDate.coming_soon),
      year: parsedDate.year,
      month: parsedDate.month,
      day: parsedDate.day,
      precision: parsedDate.precision,
    },
    releaseYear: parsedDate.year,
    releasePrecision: parsedDate.precision,
    dlc,
    dlcCount: dlc.length,
    metacritic:
      source.metacritic && Number.isFinite(Number(source.metacritic.score))
        ? {
            score: Number(source.metacritic.score),
            url: source.metacritic.url == null ? null : String(source.metacritic.url),
          }
        : null,
    recommendations:
      source.recommendations && Number.isFinite(Number(source.recommendations.total))
        ? { total: Number(source.recommendations.total) }
        : null,
    achievements:
      source.achievements && Number.isFinite(Number(source.achievements.total))
        ? { total: Number(source.achievements.total) }
        : null,
    platforms,
    // Store artwork (M7): the real URLs Valve ships in `appdetails`. New SKUs
    // live under `store_item_assets/steam/apps/<appid>/<hash>/…`, so the old
    // `<cdn>/steam/apps/<appid>/header.jpg` path 404s for them (live 02.11.2026,
    // CONTROL Resonant appid 3669870). Saving the URL is the honest fix: no
    // guessing of the per-asset hash directory.
    headerImage: absoluteAssetUrl(source.header_image),
    capsuleImage: absoluteAssetUrl(source.capsule_image),
    screenshots: screenshotList(source.screenshots),
    earlyAccess: isEarlyAccessOf(categories, genres),
    metadataSource: 'steam-store',
  };
}

/**
 * Parse the `{ "<appid>": { success, data } }` envelope. Returns
 * `{ found, doc }`; `found:false` means the server answered nothing for the
 * requested appid (treated as a deferred HTTP error, not a negative answer).
 */
function parseAppDetailsResponse(json, appid) {
  const key = String(appid);
  const entry = json && typeof json === 'object' ? json[key] : null;
  if (!entry || typeof entry !== 'object') return { found: false, doc: null };
  if (!entry.success) {
    return {
      found: true,
      doc: {
        appid: Number(appid),
        success: false,
        unavailable: true,
        type: null,
        name: null,
        metadataSource: 'steam-store',
        error: 'not_available',
      },
    };
  }
  return { found: true, doc: parseAppDetails(entry.data, appid) };
}

/** Is a cached details document younger than the TTL? */
function detailsFresh(doc, ttlMs) {
  if (!doc || typeof doc !== 'object') return false;
  const ts = Date.parse(String(doc.fetchedAt || ''));
  if (!Number.isFinite(ts)) return false;
  const age = Date.now() - ts;
  return age >= 0 && age < (ttlMs == null ? detailsTtlMs() : ttlMs);
}

/* ------------------------------------------------------------------ */
/* Reviews (query_summary only)                                        */
/* ------------------------------------------------------------------ */

function reviewsTtlMs() {
  // Single source of truth lives in game-cache (it also owns the file TTLs).
  return gameCache.reviewsTtlMs();
}

function reviewsUrl(appid) {
  // The new method takes its arguments as one JSON blob. `num_per_page: 1` is
  // the cheapest form that still returns the full `query_summary` (verified
  // live: 765 B; `num_per_page: 0` is ignored and returns 20 review bodies,
  // ~26 KB). No key: anonymous calls share a lower limit, 429 on overflow.
  const input = {
    appid: Number(appid),
    filter: 1, // most helpful first (only the summary is read)
    languages: ['all'],
    purchase_type: 1, // all purchase types
    num_per_page: 1,
    cursor: '*',
    filter_offtopic_activity: false,
  };
  return `${REVIEWS_URL}?input_json=${encodeURIComponent(JSON.stringify(input))}`;
}

/**
 * Clean the `IUserReviewsService/GetAppReviews` envelope into the cache doc.
 *
 * The response is `{ response: { query_summary: {...}, reviews: [...] } }`.
 * Only the summary is stored: review bodies are neither needed by the tab nor
 * allowed to bloat `cache-games/`. A missing `query_summary` is an honest
 * "no reviews" answer (`success:false, unavailable:true`), not an error.
 */
function parseAppReviews(json, appid) {
  const body = json && typeof json === 'object' ? json.response || json : null;
  const summary = body && typeof body === 'object' ? body.query_summary : null;
  if (!summary || typeof summary !== 'object') {
    return {
      appid: Number(appid),
      success: false,
      unavailable: true,
      reason: 'no_summary',
      score: null,
      desc: null,
      positive: 0,
      negative: 0,
      total: 0,
      metadataSource: 'steam-reviews',
    };
  }
  const score = Number(summary.review_score);
  const positive = Number(summary.total_positive);
  const negative = Number(summary.total_negative);
  const total = Number(summary.total_reviews);
  return {
    appid: Number(appid),
    success: true,
    unavailable: false,
    score: Number.isFinite(score) && score >= 1 && score <= 9 ? Math.round(score) : null,
    desc: summary.review_score_desc == null ? null : String(summary.review_score_desc),
    positive: Number.isFinite(positive) && positive >= 0 ? positive : 0,
    negative: Number.isFinite(negative) && negative >= 0 ? negative : 0,
    total: Number.isFinite(total) && total >= 0 ? total : 0,
    metadataSource: 'steam-reviews',
  };
}

/** Is a cached review summary younger than the TTL? */
function reviewsFresh(doc, ttlMs) {
  if (!doc || typeof doc !== 'object') return false;
  const ts = Date.parse(String(doc.fetchedAt || ''));
  if (!Number.isFinite(ts)) return false;
  const age = Date.now() - ts;
  return age >= 0 && age < (ttlMs == null ? reviewsTtlMs() : ttlMs);
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

function storeUrl(appid) {
  const params = new URLSearchParams({
    appids: String(appid),
    l: 'english',
  });
  const cc = String(process.env.GAMES_STORE_CC || '').trim();
  if (cc) params.set('cc', cc);
  return `${DETAILS_URL}?${params.toString()}`;
}

/**
 * Create an appdetails client.
 *
 * Options (tests use them to stay offline):
 *   request — `(url, opts) => { status, headers, body }` (default: steam.httpGet)
 *   sleep   — `(ms) => Promise`
 *   now     — `() => epoch ms`
 *   pauseMs — spacing between requests (default env / 1700)
 *   breakerMs — breaker window (default env / 30 min)
 */
function createClient(options = {}) {
  const request = options.request || steam.httpGet;
  const sleep = options.sleep || sleepDefault;
  const now = options.now || (() => Date.now());
  const pauseMs =
    options.pauseMs != null ? options.pauseMs : sources.pauseMs('steamStore');
  const breakerMs =
    options.breakerMs != null ? options.breakerMs : sources.breakerMs('steamStore');
  const reviewsPauseMs =
    options.reviewsPauseMs != null
      ? options.reviewsPauseMs
      : sources.pauseMs('steamReviews');
  const reviewsBreakerMs =
    options.reviewsBreakerMs != null
      ? options.reviewsBreakerMs
      : sources.breakerMs('steamReviews');

  const breakerStore = {
    read: () => gameCache.readBreaker(),
    write: (state) => gameCache.writeBreaker(state),
  };

  function rateLimitedError(host, entry) {
    return new StoreError(
      `${host} временно не опрашивается: предыдущий ответ ${entry.reason}. ` +
        `Повтор через ${Math.max(1, Math.ceil((entry.until - now()) / 60000))} мин.`,
      host === REVIEWS_BREAKER_KEY ? 'reviews_rate_limited' : 'store_rate_limited',
      { host, retryAt: new Date(entry.until).toISOString() }
    );
  }

  const detailsGate = createSourceGate({
    now,
    sleep,
    pauseMs,
    breakerMs,
    breakerStore,
    createError: rateLimitedError,
    mapTransportError(err) {
      if (err instanceof StoreError) return err;
      if (err && err.code === 'steam_unreachable') {
        return new StoreError(err.message, 'store_unreachable', { host: STORE_HOST });
      }
      return new StoreError(
        `Steam Store недоступен (${STORE_HOST}, ${(err && err.code) || 'ENETWORK'}). ` +
          'Это сеть/DNS/TLS, не повод считать игру «без деталей» — повторите позже.',
        'store_unreachable',
        { host: STORE_HOST }
      );
    },
  });

  const reviewsGate = createSourceGate({
    now,
    sleep,
    pauseMs: reviewsPauseMs,
    breakerMs: reviewsBreakerMs,
    breakerStore,
    createError: rateLimitedError,
    mapTransportError(err) {
      if (err instanceof StoreError) return err;
      if (err && err.code === 'steam_unreachable') {
        return new StoreError(err.message, 'reviews_unreachable', { host: REVIEWS_HOST });
      }
      return new StoreError(
        `Steam reviews недоступны (${REVIEWS_HOST}, ${(err && err.code) || 'ENETWORK'}). ` +
          'Это сеть/DNS/TLS, не повод считать игру «без отзывов» — повторите позже.',
        'reviews_unreachable',
        { host: REVIEWS_HOST }
      );
    },
  });

  function breakerEntryFor(host) {
    return detailsGate.breakerFor(host);
  }

  function tripBreakerFor(host, reason, windowMs) {
    return detailsGate.tripBreaker(host, { reason, untilMs: windowMs });
  }

  function breakerEntry() {
    return breakerEntryFor(STORE_HOST);
  }

  function tripBreaker(reason) {
    tripBreakerFor(STORE_HOST, reason, breakerMs);
  }

  function assertNotBlocked() {
    return detailsGate.assertNotBlocked(STORE_HOST);
  }

  /**
   * Fetch one app's details. Throws `StoreError` for network/5xx/429; returns
   * `{ success:false, unavailable:true }` for a real "no store page" answer.
   */
  async function getAppDetails(rawAppid) {
    const appid = Number(rawAppid);
    if (!Number.isInteger(appid) || appid <= 0) {
      throw new StoreError(`Некорректный appid: ${rawAppid}`, 'store_invalid_appid');
    }
    const response = await detailsGate.request(
      STORE_HOST,
      () =>
        request(storeUrl(appid), {
          timeoutMs: envInt('GAMES_STEAM_TIMEOUT_MS', 20000),
        })
    );
    const status = Number(response && response.status) || 0;
    if (status === 403 || status === 429) {
      tripBreaker(status === 429 ? '429 Too Many Requests' : 'HTTP 403');
      throw new StoreError(
        `Steam Store ответил ${status}: запросы к appdetails приостановлены на ` +
          `${Math.round(breakerMs / 60000)} мин (breaker).`,
        'store_rate_limited',
        { host: STORE_HOST, status, retryAt: new Date(now() + breakerMs).toISOString() }
      );
    }
    if (status < 200 || status >= 300) {
      throw new StoreError(
        `Steam Store ответил ${status} для appid ${appid} — ответ не закэширован (deferred).`,
        'store_http_error',
        { host: STORE_HOST, status }
      );
    }
    let json;
    try {
      json = JSON.parse(String((response && response.body) || ''));
    } catch (err) {
      throw new StoreError(
        `Steam Store вернул не JSON для appid ${appid} — ответ не закэширован (deferred).`,
        'store_http_error',
        { host: STORE_HOST, status }
      );
    }
    const parsed = parseAppDetailsResponse(json, appid);
    if (!parsed.found) {
      throw new StoreError(
        `Steam Store не вернул запись для appid ${appid} — ответ не закэширован (deferred).`,
        'store_http_error',
        { host: STORE_HOST, status }
      );
    }
    return parsed.doc;
  }

  function reviewsBreakerEntry() {
    return breakerEntryFor(REVIEWS_BREAKER_KEY);
  }

  function tripReviewsBreaker(reason) {
    tripBreakerFor(REVIEWS_BREAKER_KEY, reason, reviewsBreakerMs);
  }

  function assertReviewsNotBlocked() {
    return reviewsGate.assertNotBlocked(REVIEWS_BREAKER_KEY);
  }

  /**
   * Fetch the review summary of one app. Throws `StoreError` for
   * network/5xx/429; returns `{ success:false, unavailable:true }` when the API
   * answers without a `query_summary` (no reviews / not a store app).
   */
  async function getAppReviews(rawAppid) {
    const appid = Number(rawAppid);
    if (!Number.isInteger(appid) || appid <= 0) {
      throw new StoreError(`Некорректный appid: ${rawAppid}`, 'reviews_invalid_appid');
    }
    const response = await reviewsGate.request(
      REVIEWS_BREAKER_KEY,
      () =>
        request(reviewsUrl(appid), {
          timeoutMs: envInt('GAMES_REVIEWS_TIMEOUT_MS', 20000),
        })
    );
    const status = Number(response && response.status) || 0;
    if (status === 403 || status === 429) {
      tripReviewsBreaker(status === 429 ? '429 Too Many Requests' : 'HTTP 403');
      throw new StoreError(
        `Steam reviews ответили ${status}: запросы приостановлены на ` +
          `${Math.round(reviewsBreakerMs / 60000)} мин (breaker).`,
        'reviews_rate_limited',
        { host: REVIEWS_HOST, status, retryAt: new Date(now() + reviewsBreakerMs).toISOString() }
      );
    }
    if (status < 200 || status >= 300) {
      throw new StoreError(
        `Steam reviews ответили ${status} для appid ${appid} — ответ не закэширован (deferred).`,
        'reviews_http_error',
        { host: REVIEWS_HOST, status }
      );
    }
    let json;
    try {
      json = JSON.parse(String((response && response.body) || ''));
    } catch (err) {
      throw new StoreError(
        `Steam reviews вернули не JSON для appid ${appid} — ответ не закэширован (deferred).`,
        'reviews_http_error',
        { host: REVIEWS_HOST, status }
      );
    }
    return parseAppReviews(json, appid);
  }

  return {
    options: { pauseMs, breakerMs, reviewsPauseMs, reviewsBreakerMs },
    getAppDetails,
    getAppReviews,
    assertNotBlocked,
    assertReviewsNotBlocked,
    tripBreaker,
    tripReviewsBreaker,
    breakerEntry,
    reviewsBreakerEntry,
    detailsTtlMs,
    reviewsTtlMs,
  };
}

module.exports = {
  StoreError,
  STORE_HOST,
  DETAILS_URL,
  REVIEWS_HOST,
  REVIEWS_BREAKER_KEY,
  REVIEWS_URL,
  DEFAULT_PAUSE_MS,
  DEFAULT_REVIEWS_PAUSE_MS,
  DEFAULT_BREAKER_MS,
  DEFAULT_TTL_MS,
  DEFAULT_REVIEWS_TTL_MS,
  YEAR_MIN,
  YEAR_MAX,
  createClient,
  storeUrl,
  reviewsUrl,
  parseReleaseDate,
  parseAppDetails,
  parseAppDetailsResponse,
  parseAppReviews,
  detailsFresh,
  detailsTtlMs,
  reviewsFresh,
  reviewsTtlMs,
  saneYear,
};
