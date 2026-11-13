'use strict';

const steam = require('./steam');
const gameCache = require('./game-cache');
const { createSourceGate } = require('../core/source-client');
const sources = require('../core/sources');

const STORE_HOST = 'store.steampowered.com';
const DETAILS_URL = `https://${STORE_HOST}/api/appdetails`;
const REVIEWS_HOST = 'api.steampowered.com';
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
  return gameCache.detailsTtlMs();
}

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

  match = /(?<!\d)(\d{4})(?!\d)/.exec(text);
  if (match) {
    const year = saneYear(match[1]);
    if (year != null) return { text, year, month: null, day: null, precision: 'year' };
  }
  return result;
}

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

function isEarlyAccessOf(categories, genres) {
  for (const entry of categories || []) {
    if (/early access/i.test(String(entry.description || ''))) return true;
  }
  for (const entry of genres || []) {
    if (/early access/i.test(String(entry.description || ''))) return true;
  }
  return false;
}

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
    headerImage: absoluteAssetUrl(source.header_image),
    capsuleImage: absoluteAssetUrl(source.capsule_image),
    screenshots: screenshotList(source.screenshots),
    earlyAccess: isEarlyAccessOf(categories, genres),
    metadataSource: 'steam-store',
  };
}

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

function detailsFresh(doc, ttlMs) {
  if (!doc || typeof doc !== 'object') return false;
  const ts = Date.parse(String(doc.fetchedAt || ''));
  if (!Number.isFinite(ts)) return false;
  const age = Date.now() - ts;
  return age >= 0 && age < (ttlMs == null ? detailsTtlMs() : ttlMs);
}

function reviewsTtlMs() {
  return gameCache.reviewsTtlMs();
}

function reviewsUrl(appid) {
  const input = {
    appid: Number(appid),
    filter: 1,
    languages: ['all'],
    purchase_type: 1,
    num_per_page: 1,
    cursor: '*',
    filter_offtopic_activity: false,
  };
  return `${REVIEWS_URL}?input_json=${encodeURIComponent(JSON.stringify(input))}`;
}

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

function reviewsFresh(doc, ttlMs) {
  if (!doc || typeof doc !== 'object') return false;
  const ts = Date.parse(String(doc.fetchedAt || ''));
  if (!Number.isFinite(ts)) return false;
  const age = Date.now() - ts;
  return age >= 0 && age < (ttlMs == null ? reviewsTtlMs() : ttlMs);
}

function storeUrl(appid) {
  const params = new URLSearchParams({
    appids: String(appid),
    l: 'english',
  });
  const cc = String(process.env.GAMES_STORE_CC || '').trim();
  if (cc) params.set('cc', cc);
  return `${DETAILS_URL}?${params.toString()}`;
}

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
