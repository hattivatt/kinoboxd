'use strict';

/**
 * LiveLib import (reading profile of a public user).
 *
 * Three steps, all public and login-free (P0, 27.10.2026):
 *
 *  0. Browser-like bootstrap (see the HTTP section below)
 *       GET https://www.livelib.ru/reader/{username}/read
 *     with the full Chrome header set; every `Set-Cookie` (DDoS-Guard hands out
 *     `__ddg1_`/`__ddg2_`/...) is kept in a jar and sent with the calls below.
 *     Without it a cold request from a flagged IP gets a challenge 403 in ~0.3 s
 *     and the whole import dies on its first byte.
 *
 *  1. Legacy bulk endpoint (undocumented, "livelib-backup" trick)
 *       POST /reader/{username}/read/listview/biglist
 *       x-requested-with: XMLHttpRequest, form-urlencoded
 *       page_no=1&per_page=1000&is_new_design=ll2015b&is_prev=false
 *     Returns JSON { error_code, content: HTML, last_page, object_ids }.
 *     One request per 1000 books, and the HTML carries ISBN (~68%),
 *     publisher/year/language/series per user_book.
 *
 *  2. Next.js collection pages
 *       GET https://www.livelib.ru/reader/{username}/read?ordering=read_at_desc&page=N
 *     (308 -> /users/{numericId}/books/read?ordering=read_at_desc&page=N).
 *     20 cards per page; the authoritative data is the React Server Component
 *     payload (self.__next_f): personal `rating` (0..10) and `read_date`
 *     (year/month/day) per user_book. 1245 books = 63 pages.
 *
 * Merge: the bulk pass supplies metadata, the RSC pass supplies exact dates and
 * the native 10-scale rating. Both are keyed by the SAME user_book id
 * (`div-userbook-{id}` vs payload `id`), which is stable across re-imports.
 * `art_edition.id` alone is not unique (18 duplicate ids in 1245 events), so
 * events are keyed by user_book id and edition duplicates are reported as
 * re-reads instead of being collapsed.
 *
 * Politeness: one request at a time, random 1.5-2.5 s pause between requests
 * (and before the bootstrap), browser UA, 429/403 -> stop (no hammering),
 * transport retries only.
 *
 * HTML fixtures for tests live in test/fixtures/ (gzipped real pages).
 */

const cheerio = require('cheerio');

const { parseCookieHeader } = require('./cookie-header');

const LIVELIB_ORIGIN = 'https://www.livelib.ru';

/**
 * Desktop Chrome UA. Kept in sync across the scraper: the Site sits behind
 * DDoS-Guard, so a consistent, plausible browser fingerprint matters more than
 * the exact minor version (AGENTS.md: browser UA, no bot-looking strings).
 */
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/140.0.0.0 Safari/537.36';

/**
 * Full browser header set for the bootstrap document request. `sec-ch-*` and
 * `sec-fetch-*` are what Chrome actually sends on a top-level navigation;
 * DDoS-Guard scores their absence, so the first request of a session carries
 * all of them (the JSON/HTML calls after it keep the shorter set).
 */
const BROWSER_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Linux"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

const REQUEST_TIMEOUT_MS = 45000;
const MIN_DELAY_MS = 1500;
const MAX_DELAY_MS = 2500;
const BULK_PER_PAGE = 1000;
const MAX_RSC_PAGES = 200;
const MAX_BULK_PAGES = 10;
const MAX_REDIRECTS = 5;

class LivelibError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LivelibError';
    this.code = code || 'livelib_error';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randomDelay() {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1));
}

function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ */
/* HTTP + anonymous cookie jar                                         */
/* ------------------------------------------------------------------ */

/*
 * LiveLib answers a cold, cookie-less request from a flagged IP with a
 * DDoS-Guard challenge 403 (seen on a user's server: 403 after ~0.3 s, before
 * any collection page was even touched). The working pattern — the same one
 * `server/kp.js` uses for KinoPoisk — is:
 *
 *   1. GET the public profile page like a browser (BROWSER_HEADERS) and keep
 *      every `Set-Cookie` (`__ddg1_`, `__ddg2_`, `__ddg8_`, ...) in a jar,
 *      following redirects manually so intermediate hops are not lost;
 *   2. only then POST the legacy biglist / fetch collection pages with
 *      `Cookie:` from that jar, capturing refreshed cookies on each response.
 *
 * The bootstrap response itself may be 403/redirect/captcha — that is not an
 * error by itself (the cookies it sets are often the point). If the *next*
 * request is blocked too, the job reports `livelib_blocked` and the caller can
 * offer plan B (a cookie header copied from a real browser).
 */

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    if (value != null) return value;
    if (typeof headers.getSetCookie !== 'function') return null;
  }
  const lower = String(name).toLowerCase();
  if (headers instanceof Map) return headers.get(lower) || headers.get(name) || null;
  if (typeof headers === 'object') return headers[lower] || headers[name] || null;
  return null;
}

/**
 * All `Set-Cookie` values of a response. Tolerant to test doubles: undici uses
 * `getSetCookie()`, a Map or a plain object may carry a single `set-cookie`.
 */
function setCookieValues(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') {
    const list = headers.getSetCookie();
    return Array.isArray(list) ? list.filter(Boolean) : [];
  }
  if (typeof headers.raw === 'function') {
    const raw = headers.raw();
    const list = raw && (raw['set-cookie'] || raw['Set-Cookie']);
    if (list) return [].concat(list).filter(Boolean);
  }
  const single = headerValue(headers, 'set-cookie');
  return single ? [].concat(single).filter(Boolean) : [];
}

/**
 * Anonymous cookie jar (`Map<name, value>`), seeded from a stored/user header.
 * Mirrors `makeJar`/`storeCookies`/`cookieHeader` from server/kp.js.
 */
function makeJar(seed) {
  const jar = new Map();
  if (!seed) return jar;
  if (seed instanceof Map) {
    for (const [name, value] of seed) jar.set(name, value);
    return jar;
  }
  for (const [name, value] of parseCookieHeader(String(seed))) jar.set(name, value);
  return jar;
}

function storeCookies(jar, response) {
  if (!jar) return;
  for (const raw of setCookieValues(response && response.headers)) {
    const pair = String(raw).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    const rest = String(raw).toLowerCase();
    // Expired/deleted cookie: `Max-Age=0` or an empty value.
    if (/max-age=0(?:;|$)/.test(rest) || value === '') jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeaderOf(jar) {
  if (!jar || jar.size === 0) return null;
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function withCookies(headers, jar) {
  const merged = Object.assign({}, headers || {});
  const cookie = cookieHeaderOf(jar);
  if (cookie) merged.Cookie = cookie;
  return merged;
}

/** Fetch with transport retries; refuses 403/429 loudly instead of retrying. */
async function request(url, options = {}, label = url) {
  const fetchImpl = options.fetchImpl || fetch;
  const jar = options.jar || null;
  const method = options.method || 'GET';
  // Only idempotent requests are redirected manually: replaying a POST body
  // after a 3xx is not what a browser does for a form post either.
  const followRedirects = String(method).toUpperCase() === 'GET';
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response = null;
    let currentUrl = url;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        response = await fetchImpl(currentUrl, {
          method,
          headers: withCookies(options.headers, jar),
          body: options.body,
          redirect: 'manual',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        storeCookies(jar, response);
        const location = headerValue(response.headers, 'location');
        if (followRedirects && response.status >= 300 && response.status < 400 && location) {
          currentUrl = new URL(location, currentUrl).toString();
          try {
            await response.text();
          } catch (err) {
            // A 3xx body is irrelevant; ignoring it must not break the hop.
          }
          continue;
        }
        break;
      }
    } catch (err) {
      lastError = err;
      if (attempt >= 3) {
        throw new LivelibError(`LiveLib недоступен (${label}): ${err.message}`, 'livelib_network_error');
      }
      await sleep(2000 * attempt);
      continue;
    }

    if (response.status === 429 || response.status === 403) {
      throw new LivelibError(blockedMessage(response.status), 'livelib_blocked');
    }
    if (response.status >= 500) {
      lastError = new LivelibError(
        `LiveLib ответил HTTP ${response.status} (${label}).`,
        'livelib_http_error'
      );
      if (attempt >= 3) throw lastError;
      await sleep(2000 * attempt);
      continue;
    }
    if (response.status !== 200) {
      throw new LivelibError(
        `LiveLib ответил HTTP ${response.status} (${label}).`,
        'livelib_http_error'
      );
    }
    const text = await response.text();
    return {
      status: response.status,
      url: response.url || currentUrl,
      headers: response.headers,
      text,
    };
  }
  throw lastError;
}

function blockedMessage(status) {
  return (
    `LiveLib ограничил доступ (HTTP ${status}) — DDoS-Guard/анти-бот; импорт остановлен. ` +
    'Bootstrap с браузерными заголовками не помог: если профиль открывается в вашем браузере, ' +
    'вставьте cookie из него (поле cookieHeader) и повторите, иначе попробуйте позже.'
  );
}

/** True when the HTML/headers look like a DDoS-Guard or captcha interstitial. */
function isChallengeHtml(html) {
  const text = String(html || '');
  if (!text) return false;
  return (
    /ddos-?guard/i.test(text) ||
    /__ddg\d?[_a-z]*\s*=/i.test(text) ||
    /Checking your browser/i.test(text) ||
    /Проверка браузера/i.test(text) ||
    /cf_chl|Just a moment|cloudflare/i.test(text) ||
    /(?:recaptcha|hcaptcha|smartcaptcha)/i.test(text)
  );
}

function pageTitleOf(html) {
  const match = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(String(html || ''));
  return match ? cleanText(match[1]).slice(0, 120) : null;
}

/**
 * Browser-like bootstrap: GET the public profile page with the full header set
 * and collect the cookies it hands out.
 *
 * Deliberately tolerant: a 403/redirect/challenge answer is *data*, not an
 * error — the response usually still carries the `__ddg*` cookies that make
 * the following JSON call pass. Only transport failures throw.
 *
 * Returns masked diagnostics (`cookieCount`, statuses, title, challenge flag);
 * cookie values never leave this module.
 */
async function bootstrapSession(username, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const jar = options.jar || makeJar(options.cookieHeader);
  const url = `${LIVELIB_ORIGIN}/reader/${encodeURIComponent(username)}/read`;
  const hops = [];
  let status = null;
  let finalUrl = url;
  let html = '';
  let response = null;
  let currentUrl = url;

  if (options.skip === true) {
    return {
      skipped: true,
      status: null,
      url: null,
      hops: [],
      challenge: false,
      blocked: false,
      cookieCount: jar.size,
      title: null,
    };
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    response = await fetchImpl(currentUrl, {
      method: 'GET',
      headers: withCookies(BROWSER_HEADERS, jar),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    storeCookies(jar, response);
    status = response.status;
    finalUrl = response.url || currentUrl;
    hops.push({ status, url: currentUrl, cookieCount: jar.size });
    const location = headerValue(response.headers, 'location');
    if (status >= 300 && status < 400 && location) {
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    try {
      html = await response.text();
    } catch (err) {
      html = '';
    }
    break;
  }

  const challenge = isChallengeHtml(html);
  return {
    skipped: false,
    status,
    url: finalUrl,
    hops,
    challenge,
    blocked: status === 403 || status === 429,
    cookieCount: jar.size,
    title: pageTitleOf(html),
  };
}

/* ------------------------------------------------------------------ */
/* RSC parser                                                          */
/* ------------------------------------------------------------------ */

/**
 * Concatenate all `self.__next_f.push([1,"..."])` chunks back into the flight
 * stream. Each chunk is a JSON string literal, so JSON.parse('"'+chunk+'"')
 * undoes the escaping.
 */
function flightFromHtml(html) {
  const parts = [
    ...String(html || '').matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g),
  ];
  let flight = '';
  for (const part of parts) {
    try {
      flight += JSON.parse(`"${part[1]}"`);
    } catch (err) {
      // A broken chunk is not fatal: the payload may still be in another one.
    }
  }
  return flight;
}

/** Extract the balanced JSON object that starts at `start` (a `{` index). */
function sliceBalancedJson(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * All dehydrated TanStack query payload blocks of the flight stream, each with
 * the `queryKey` that follows it (the key is serialised after the data in the
 * same query object, so the nearest key *after* the payload is its own).
 *
 * Why this exists: the HTML of page N>1 embeds TWO queries for the same
 * collection — `offset:0` (page 1, re-rendered for the client router) and
 * `offset:(N-1)*20` (the requested page). Picking the first `payload` block
 * always read page 1, which is what made a 63-page scan collect 20 books
 * (spike 28.10.2026).
 */
function payloadCandidates(flight) {
  const out = [];
  let index = -1;
  while ((index = flight.indexOf('"payload"', index + 1)) !== -1) {
    const colon = flight.indexOf(':', index);
    const brace = flight.indexOf('{', colon);
    if (brace < 0) continue;
    const raw = sliceBalancedJson(flight, brace);
    if (!raw) continue;
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      continue;
    }
    let offset = null;
    let queryKey = null;
    const keyIndex = flight.indexOf('"queryKey"', brace + raw.length);
    if (keyIndex >= 0 && keyIndex - (brace + raw.length) < 4000) {
      const bracket = flight.indexOf('[', keyIndex);
      const close = bracket >= 0 ? flight.indexOf(']', bracket) : -1;
      if (close > bracket) {
        const rawKey = flight.slice(bracket, close + 1);
        try {
          queryKey = JSON.parse(rawKey);
        } catch (err) {
          queryKey = null;
        }
        if (queryKey) {
          const params = queryKey.find((part) => part && typeof part === 'object' && !Array.isArray(part));
          if (params && params.offset != null && Number.isFinite(Number(params.offset))) {
            offset = Number(params.offset);
          }
        }
      }
    }
    out.push({ payload, offset, queryKey });
  }
  return out;
}

/**
 * Pick the payload block that belongs to the requested collection page.
 *
 * Matching is by `offset`, the only value the dehydrated query carries that is
 * unambiguous: page N is `offset=(N-1)*20`. Fallbacks, in order:
 *   1. an exact offset match;
 *   2. when the caller did not say which page it wanted — the LAST candidate
 *      (the client router appends the requested page after page 1);
 *   3. otherwise the first candidate (page 1), which is right for `page=1`.
 */
function pickPayload(candidates, page) {
  if (!candidates.length) return null;
  const requested = Number(page) > 1 ? (Number(page) - 1) * 20 : null;
  if (requested != null) {
    const exact = candidates.find((entry) => entry.offset === requested);
    if (exact) return exact;
  }
  if (!Number(page)) return candidates[candidates.length - 1];
  return candidates[0];
}

/**
 * Parse one server-rendered collection page.
 *
 * `options.page` is the page number the URL asked for (`?page=N`); its
 * `queryKey.offset` selects the right payload block. Without it the last
 * payload wins (the client-side router appends the requested page), which is
 * the safest guess for a standalone HTML fixture.
 *
 * Returns { rows, total, nextPage, pageTotal, offset, offsets }.
 */
function parseRscHtml(html, options = {}) {
  const flight = flightFromHtml(html);
  if (!flight) {
    throw new LivelibError(
      'LiveLib: RSC-payload не найден (разметка/формат страницы изменились).',
      'livelib_parse_error'
    );
  }

  const candidates = payloadCandidates(flight);
  if (!candidates.length) {
    throw new LivelibError(
      'LiveLib: в RSC-payload нет блока payload/pagination (разметка изменилась).',
      'livelib_parse_error'
    );
  }
  const chosen = pickPayload(candidates, options.page);
  const payload = chosen.payload;

  const data = Array.isArray(payload.data) ? payload.data : [];
  const rows = data
    .map((entry) => {
      const edition = entry && entry.art_edition;
      if (!edition || edition.id == null) return null;
      const readDate = entry.read_date;
      return {
        userBookId: String(entry.id),
        bookId: String(edition.id),
        title: cleanText(edition.title),
        authors: (Array.isArray(edition.authors) ? edition.authors : [])
          .map((author) => cleanText(author && author.full_name))
          .filter(Boolean),
        authorIds: (Array.isArray(edition.authors) ? edition.authors : [])
          .map((author) => (author && author.id != null ? String(author.id) : null))
          .filter(Boolean),
        url: edition.url || null,
        coverUrl: edition.cover_url || null,
        publicationYear: Number(edition.publication_year) > 0 ? Number(edition.publication_year) : null,
        publishers: (Array.isArray(edition.publishers) ? edition.publishers : [])
          .map((publisher) => cleanText(publisher && publisher.title))
          .filter(Boolean),
        communityRating:
          edition.stats && edition.stats.rating != null
            ? String(edition.stats.rating)
            : null,
        rating:
          entry.rating == null || !Number.isFinite(Number(entry.rating)) || Number(entry.rating) <= 0
            ? null
            : Number(entry.rating),
        readDate:
          readDate && Number(readDate.year) > 0
            ? {
                year: Number(readDate.year),
                month: Number(readDate.month) || null,
                day: Number(readDate.day) || null,
              }
            : null,
        statusSetAt: entry.status_set_at || null,
      };
    })
    .filter(Boolean);

  const totalMatch = flight.match(/"counters"\s*:\s*\{\s*"all"\s*:\s*(\d+)/);
  const total = totalMatch ? Number(totalMatch[1]) : null;

  // Pagination links are the only reliable source for the page count:
  // the payload only carries `next_page` (an absolute API path that is 404
  // anonymously), while the rendered controls list real page numbers.
  const pages = new Set();
  const linkRe = /(?:href|action)="([^"]*books\/read[^"]*page=(\d+)[^"]*)"/g;
  let match;
  while ((match = linkRe.exec(String(html))) !== null) {
    pages.add(Number(match[2]));
  }
  const pageTotal = pages.size ? Math.max(...pages) : null;

  return {
    rows,
    total,
    nextPage: payload.pagination ? payload.pagination.next_page || null : null,
    pageTotal,
    offset: chosen.offset,
    offsets: candidates.map((entry) => entry.offset),
  };
}

/* ------------------------------------------------------------------ */
/* Bulk (legacy biglist) parser                                        */
/* ------------------------------------------------------------------ */

const RU_MONTHS = {
  январь: 1,
  февраль: 2,
  март: 3,
  апрель: 4,
  май: 5,
  июнь: 6,
  июль: 7,
  август: 8,
  сентябрь: 9,
  октябрь: 10,
  ноябрь: 11,
  декабрь: 12,
  января: 1,
  февраля: 2,
  марта: 3,
  апреля: 4,
  мая: 5,
  июня: 6,
  июля: 7,
  августа: 8,
  сентября: 9,
  октября: 10,
  ноября: 11,
  декабря: 12,
};

function readDetailRow($, item, label) {
  const rows = item.find('table.compact tr');
  let value = null;
  rows.each((_, tr) => {
    if (value !== null) return;
    const cells = $(tr).find('td');
    if (cells.length < 2) return;
    const name = cleanText(cells.eq(0).text()).replace(/:$/, '').toLowerCase();
    if (name !== label.toLowerCase()) return;
    value = cleanText(cells.eq(1).text());
  });
  return value;
}

function parseBulkContent(content) {
  const $ = cheerio.load(String(content || ''));
  const entries = [];
  let currentMonth = null;

  $('div.brow-h2, div.book-item-manage').each((_, element) => {
    const node = $(element);
    if (node.hasClass('brow-h2')) {
      const text = cleanText(node.find('h2').first().text());
      const monthMatch = text.match(/([А-Яа-яЁё]+)\s+(\d{4})/);
      currentMonth = monthMatch
        ? {
            year: Number(monthMatch[2]),
            month: RU_MONTHS[monthMatch[1].toLowerCase()] || null,
          }
        : null;
      return;
    }

    const userBookId = String(node.attr('id') || '').replace(/^div-userbook-/, '');
    if (!userBookId) return;

    const nameLink = node.find('.brow-data a.brow-book-name').first();
    const href = nameLink.attr('href') || '';
    const bookMatch = href.match(/\/(book|work)\/(\d+)/);
    const editionId = node.find('.xa-main').first().attr('data-edition_id');
    const bookId = bookMatch ? bookMatch[2] : editionId || null;
    const title = cleanText(nameLink.text()) || cleanText(nameLink.attr('title'));

    const authors = [];
    node.find('.brow-data a.brow-book-author').each((__, authorNode) => {
      const name = cleanText($(authorNode).text());
      if (name) authors.push(name);
    });

    const ratingText = cleanText(node.find('.brow-ratings .rating-value').first().text());
    const rating5 = ratingText ? Number(ratingText.replace(',', '.')) : null;

    const isbn = cleanText(node.find('span[itemprop="isbn"]').first().text()) || null;
    const publisher = cleanText(node.find('span[itemprop="publisher"]').first().text()) || null;
    const yearText = readDetailRow($, node, 'Год издания');
    const series = readDetailRow($, node, 'Серия');
    const language = readDetailRow($, node, 'Язык');
    const year = yearText && /^\d{4}$/.test(yearText) ? Number(yearText) : null;

    entries.push({
      userBookId,
      bookId: bookId ? String(bookId) : null,
      editionId:
        editionId && /^\d+$/.test(String(editionId)) ? String(editionId) : bookMatch && bookMatch[1] === 'book' ? bookMatch[2] : null,
      url: bookMatch ? `${LIVELIB_ORIGIN}${href}` : null,
      title: title || null,
      authors,
      isbn,
      publisher,
      year,
      series: series || null,
      language: language || null,
      rating5:
        rating5 != null && Number.isFinite(rating5) && rating5 > 0 && rating5 <= 5 ? rating5 : null,
      readMonth:
        currentMonth && currentMonth.month
          ? `${currentMonth.year}-${String(currentMonth.month).padStart(2, '0')}`
          : null,
    });
  });

  return entries;
}

/** Full bulk pass: keep requesting 1000-book pages until last_page. */
async function fetchBulk(username, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const perPage = Math.min(Math.max(Number(options.perPage) || BULK_PER_PAGE, 1), 2000);
  const jar = options.jar || null;
  const entries = [];
  const byUserBook = new Map();
  let pageNo = 1;
  let requests = 0;
  let lastPage = false;

  // Politeness: after the bootstrap GET the next request must still be spaced
  // out (AGENTS.md: 1.5-2.5 s between LiveLib requests, always).
  const initialDelay = Number.isFinite(Number(options.initialDelayMs))
    ? Number(options.initialDelayMs)
    : null;
  if (requests === 0 && initialDelay && initialDelay > 0) await sleep(initialDelay);

  while (!lastPage && pageNo <= MAX_BULK_PAGES) {
    if (requests > 0) await sleep(randomDelay());
    const res = await request(
      `${LIVELIB_ORIGIN}/reader/${encodeURIComponent(username)}/read/listview/biglist`,
      {
        method: 'POST',
        jar,
        headers: {
          'User-Agent': USER_AGENT,
          'x-requested-with': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'Accept-Language': 'ru-RU,ru;q=0.9',
          Referer: `${LIVELIB_ORIGIN}/reader/${encodeURIComponent(username)}/read`,
        },
        body: `page_no=${pageNo}&per_page=${perPage}&is_new_design=ll2015b&is_prev=false`,
        fetchImpl: options.fetchImpl,
      },
      `bulk page ${pageNo}`
    );
    requests++;

    let json;
    try {
      json = JSON.parse(res.text);
    } catch (err) {
      throw new LivelibError(
        'LiveLib bulk: ответ не является JSON (endpoint изменился?).',
        'livelib_bulk_parse_error'
      );
    }
    if (Number(json.error_code) !== 0) {
      throw new LivelibError(
        `LiveLib bulk: error_code=${json.error_code} (профиль не найден или коллекция закрыта).`,
        'livelib_bulk_error'
      );
    }

    const parsed = parseBulkContent(json.content);
    for (const entry of parsed) {
      if (!byUserBook.has(entry.userBookId)) {
        byUserBook.set(entry.userBookId, entry);
        entries.push(entry);
      }
    }
    lastPage = Boolean(json.last_page);
    const objectIds = Array.isArray(json.object_ids) ? json.object_ids.length : null;
    console.log(
      `[livelib ${username}] bulk page ${pageNo}: rows=${parsed.length} ` +
        `total=${entries.length}${objectIds == null ? '' : ` object_ids=${objectIds}`} last=${lastPage}`
    );
    if (onProgress) onProgress({ stage: 'bulk', page: pageNo, events: entries.length });
    if (parsed.length === 0) break;
    pageNo++;
  }

  return { entries, byUserBook, requests, pageTotal: pageNo };
}

/* ------------------------------------------------------------------ */
/* RSC pass                                                            */
/* ------------------------------------------------------------------ */

function readDateToIso(readDate) {
  if (!readDate || !readDate.year) return null;
  const year = Number(readDate.year);
  const month = Number(readDate.month);
  const day = Number(readDate.day);
  if (!(year >= 1800 && year <= 2200)) return null;
  if (!(month >= 1 && month <= 12)) return null;
  if (!(day >= 1 && day <= 31)) return null;
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.getUTCDate() !== day) return null;
  return iso;
}

/**
 * Month precision of a `read_date`.
 *
 * LiveLib records an exact day only for some entries; the rest carry
 * `{year, month, day: null}` (verified live 28.10.2026 on page 40: 20/20 rows
 * month-only, e.g. 2010-01). A month is a real date signal and must not be
 * thrown away, but it must never become a fake day: `finishedAt` stays null
 * and the event enters the month timeline only, not the day calendar/streaks.
 */
function readMonthOf(readDate) {
  if (!readDate || !readDate.year) return null;
  const year = Number(readDate.year);
  const month = Number(readDate.month);
  if (!(year >= 1800 && year <= 2200)) return null;
  if (!(month >= 1 && month <= 12)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/**
 * Scrape collection pages.
 *
 * Page 1 goes through the public alias (which 308-redirects to the numeric
 * `/users/{id}/books/read` URL); the numeric id is then reused so the remaining
 * pages need no redirect. `options.startPage` resumes a deep scan; it needs
 * `options.userId` (persisted in the profile as `sourceUserId`).
 *
 * `options.onPage({page, pageTotal, parsed, rows, collected, maxPages})` is
 * awaited after every page, so a caller can persist partial results (deep scan
 * batches) without waiting for the whole profile.
 */
async function fetchRsc(username, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const onPage = typeof options.onPage === 'function' ? options.onPage : null;
  const maxPages = Math.min(Math.max(Number(options.maxPages) || MAX_RSC_PAGES, 1), MAX_RSC_PAGES);
  const delayMs = Number.isFinite(Number(options.delayMs)) ? Number(options.delayMs) : null;
  const pageDelay = () => (delayMs == null ? randomDelay() : delayMs);
  const jar = options.jar || null;
  const rows = [];
  const byUserBook = new Map();
  const warnings = [];
  let requests = 0;
  let userId = options.userId != null && /^\d+$/.test(String(options.userId))
    ? String(options.userId)
    : null;
  let pageTotal = null;
  let total = null;
  let pagesFetched = 0;

  let page = Math.max(1, Math.floor(Number(options.startPage) || 1));
  const firstPage = page;
  // A resumed scan must address the numeric URL directly: the public alias
  // would only ever give page 1.
  if (page > 1 && !userId) page = 1;

  const firstUrl = page === 1
    ? `${LIVELIB_ORIGIN}/reader/${encodeURIComponent(username)}/read?ordering=read_at_desc`
    : `${LIVELIB_ORIGIN}/users/${userId}/books/read?ordering=read_at_desc&page=${page}`;
  const first = await request(
    firstUrl,
    {
      jar,
      fetchImpl: options.fetchImpl,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        Referer: `${LIVELIB_ORIGIN}/reader/${encodeURIComponent(username)}/read`,
      },
    },
    `rsc page ${page}`
  );
  requests++;

  const userIdMatch = String(first.url).match(/\/users\/(\d+)\/books\/read/);
  if (userIdMatch) userId = userIdMatch[1];

  let parsed = parseRscHtml(first.text, { page });
  const firstOffsetMismatch = page > 1 &&
    parsed.offset != null &&
    parsed.offset !== (page - 1) * 20;
  if (firstOffsetMismatch) {
    // The server answered with another page's payload (offset:0 for a repeated
    // page 1, or a stale page): applying its rows would write wrong dates.
    warnings.push(
      `Page ${page} returned the payload for offset ${parsed.offset} ` +
        `instead of ${(page - 1) * 20}; deep scan stopped without applying it.`
    );
    parsed = { ...parsed, rows: [] };
  } else if (parsed.rows.length === 0) {
    // A resumed deep scan lands on the last page which may legitimately be
    // empty; only a page-1 read is the schema canary.
    if (page === 1) {
      throw new LivelibError(
        `LiveLib: страница 1 профиля ${username} не содержит книг (канарейка: разметка изменилась).`,
        'livelib_empty'
      );
    }
    warnings.push(`Page ${page} of the collection was empty; deep scan stopped there.`);
  }
  total = parsed.total;
  pageTotal = parsed.pageTotal;
  if (pageTotal == null && total != null) pageTotal = Math.ceil(total / 20);
  for (const row of parsed.rows) {
    if (!byUserBook.has(row.userBookId)) {
      byUserBook.set(row.userBookId, row);
      rows.push(row);
    }
  }
  pagesFetched = firstOffsetMismatch ? page - 1 : page;
  console.log(
    `[livelib ${username}] rsc page ${page}/${pageTotal || '?'}: rows=${parsed.rows.length} ` +
      `offset=${parsed.offset} collected=${rows.length}`
  );
  if (!firstOffsetMismatch && onProgress) {
    onProgress({ stage: 'rsc', page, pageTotal, events: rows.length });
  }
  if (!firstOffsetMismatch && onPage) {
    await onPage({
      page,
      pageTotal,
      firstPage,
      parsed,
      rows: parsed.rows,
      collected: rows.length,
      maxPages,
    });
  }

  const limit = firstOffsetMismatch ? page : Math.min(pageTotal || 1, maxPages);
  while (page < limit) {
    await sleep(pageDelay());
    page++;
    const url = userId
      ? `${LIVELIB_ORIGIN}/users/${userId}/books/read?ordering=read_at_desc&page=${page}`
      : `${LIVELIB_ORIGIN}/reader/${encodeURIComponent(username)}/read?ordering=read_at_desc&page=${page}`;
    const res = await request(
      url,
      {
        jar,
        fetchImpl: options.fetchImpl,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9',
          Referer: `${LIVELIB_ORIGIN}/reader/${encodeURIComponent(username)}/read`,
        },
      },
      `rsc page ${page}`
    );
    requests++;
    parsed = parseRscHtml(res.text, { page });
    if (parsed.offset != null && parsed.offset !== (page - 1) * 20) {
      warnings.push(
        `Page ${page} returned the payload for offset ${parsed.offset} ` +
          `instead of ${(page - 1) * 20}; stopped after ${pagesFetched} page(s).`
      );
      console.warn(
        `[livelib ${username}] page ${page} returned offset ${parsed.offset}; stopping.`
      );
      break;
    }
    if (parsed.pageTotal && parsed.pageTotal > pageTotal) pageTotal = parsed.pageTotal;
    if (parsed.total != null) total = parsed.total;
    if (parsed.rows.length === 0) {
      console.warn(`[livelib ${username}] page ${page} is empty; stopping.`);
      warnings.push(`Page ${page} of the collection was empty; pagination stopped there.`);
      break;
    }
    let added = 0;
    for (const row of parsed.rows) {
      if (!byUserBook.has(row.userBookId)) {
        byUserBook.set(row.userBookId, row);
        rows.push(row);
        added++;
      }
    }
    pagesFetched = page;
    console.log(
      `[livelib ${username}] rsc page ${page}/${pageTotal || '?'}: rows=${parsed.rows.length} ` +
        `offset=${parsed.offset} added=${added} collected=${rows.length}`
    );
    if (onProgress) onProgress({ stage: 'rsc', page, pageTotal, events: rows.length });
    if (onPage) {
      await onPage({
        page,
        pageTotal,
        firstPage,
        parsed,
        rows: parsed.rows,
        collected: rows.length,
        maxPages,
      });
    }

    // The parser now reads the offset-matched payload, so `added === 0` means
    // the page really repeated known user_books (a collection that shrank
    // mid-scan or a server that ignores ?page=) — stop instead of hammering
    // the remaining pages.
    if (added === 0 && page > 1) {
      warnings.push(
        `Collection pagination returned no new books on page ${page}; ` +
          `stopped after ${pagesFetched} page(s).`
      );
      console.warn(`[livelib ${username}] page ${page} repeated known books; stopping.`);
      break;
    }
    if (page >= MAX_RSC_PAGES) break;
  }

  return {
    rows,
    byUserBook,
    userId,
    total,
    pageTotal: limit,
    pagesFetched,
    warnings,
    requests,
  };
}

/* ------------------------------------------------------------------ */
/* Merge + profile                                                     */
/* ------------------------------------------------------------------ */

/**
 * Turn one RSC row + its bulk metadata into a profile event (doc §3.3).
 * LiveLib already uses the 10-point scale; the bulk pass uses 5 stars
 * (×2 for the unified scale) and only serves as a fallback.
 */
function buildEvent(rscRow, bulkRow) {
  const bookId = String((rscRow && rscRow.bookId) || (bulkRow && bulkRow.bookId) || '');
  const rating10 =
    rscRow && rscRow.rating != null
      ? Number(rscRow.rating)
      : bulkRow && bulkRow.rating5 != null
      ? Math.round(Number(bulkRow.rating5) * 2)
      : null;
  const finishedAt = readDateToIso(rscRow && rscRow.readDate);
  const readMonth = finishedAt
    ? null
    : readMonthOf(rscRow && rscRow.readDate) || (bulkRow && bulkRow.readMonth) || null;
  const authors = (rscRow && rscRow.authors && rscRow.authors.length
    ? rscRow.authors
    : (bulkRow && bulkRow.authors) || []
  ).filter(Boolean);
  const publisher =
    (bulkRow && bulkRow.publisher) ||
    (rscRow && rscRow.publishers && rscRow.publishers.length ? rscRow.publishers[0] : null) ||
    null;
  const year = (bulkRow && bulkRow.year) || (rscRow && rscRow.publicationYear) || null;
  const isbn = (bulkRow && bulkRow.isbn) || null;
  const sourceUrl =
    (bulkRow && bulkRow.url) ||
    (rscRow && rscRow.url ? `${LIVELIB_ORIGIN}${rscRow.url}` : null) ||
    (bookId ? `${LIVELIB_ORIGIN}/book/${bookId}` : null);
  const userBookId = (rscRow && rscRow.userBookId) || (bulkRow && bulkRow.userBookId);

  return {
    id: `ll:${userBookId}`,
    source: 'livelib',
    sourceBookId: bookId || null,
    sourceEditionId: (bulkRow && bulkRow.editionId) || null,
    sourceUrl,
    sourceUserBookId: userBookId,
    workId: null,
    title: (rscRow && rscRow.title) || (bulkRow && bulkRow.title) || null,
    authors,
    rating: rating10,
    ratingScale: 10,
    rating10,
    status: 'read',
    // LiveLib is imported from the "Прочитано" shelf only (no want-to-read /
    // reading events exist in the source), so unlike Hardcover there is no
    // status filter here — every scraped row is a finished book.
    startedAt: null,
    finishedAt,
    readMonth,
    reread: false,
    readIndex: 1,
    edition: {
      publisher,
      year,
      isbn,
      language: (bulkRow && bulkRow.language) || (isbn ? 'ru' : null),
      series: (bulkRow && bulkRow.series) || null,
    },
    coverUrl: (rscRow && rscRow.coverUrl) || null,
    communityRating: (rscRow && rscRow.communityRating) || null,
    statusSetAt: (rscRow && rscRow.statusSetAt) || null,
  };
}

/**
 * Copy exact dates (and native ratings) from a previously imported profile into
 * a fresh light re-import. The light phase only reads page 1, so without this
 * merge a periodic re-check would throw away the dates a previous deep scan
 * already collected — the reader would see `undatedEventCount` jump back up.
 * Events that disappeared from LiveLib stay gone: the fresh list wins.
 */
function mergeExistingDates(events, existingProfile) {
  if (!existingProfile || !Array.isArray(existingProfile.events)) return 0;
  const previous = new Map();
  for (const event of existingProfile.events) {
    if (event) previous.set(String(event.id), event);
  }
  let restored = 0;
  for (const event of events) {
    const old = previous.get(String(event.id));
    if (!old) continue;
    if (!event.finishedAt && old.finishedAt) {
      event.finishedAt = old.finishedAt;
      event.readMonth = null;
      restored++;
    }
    if (event.rating10 == null && old.rating10 != null) {
      event.rating10 = old.rating10;
      event.rating = old.rating;
      event.ratingScale = old.ratingScale;
    }
  }
  return restored;
}

/**
 * Deep scan: read every collection page and put the exact `read_date` on the
 * already imported events. It never creates or removes events — that is the
 * light phase's job — and it persists progress in `profile.deepScan` so an
 * interrupted scan resumes at `lastPage + 1`.
 *
 * `options.onBatch(profile, progress)` is awaited every 5 pages (and on the
 * last page): the caller saves the profile file, which is what makes the
 * dashboard see freshly dated events without a restart (the stats reader
 * revalidates the file fingerprint on every read).
 */
async function deepScanProfile(username, profile, options = {}) {
  const startedAt = new Date().toISOString();
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const onBatch = typeof options.onBatch === 'function' ? options.onBatch : null;
  const events = Array.isArray(profile.events) ? profile.events : [];
  const byUserBook = new Map();
  for (const event of events) {
    const key = String(
      event.sourceUserBookId || String(event.id || '').replace(/^ll:/, '')
    );
    if (key) byUserBook.set(key, event);
  }
  const previousDeep = profile.deepScan && typeof profile.deepScan === 'object' ? profile.deepScan : {};
  const pageTotal = Number(previousDeep.pageTotal) || null;
  const alreadyDone = previousDeep.done === true &&
    (!pageTotal || Number(previousDeep.lastPage) >= pageTotal);
  if (alreadyDone) {
    return {
      skipped: true,
      reason: 'deep scan already complete',
      deepScan: profile.deepScan,
      requests: 0,
      dated: events.filter((event) => event.finishedAt).length,
      total: events.length,
    };
  }
  const lastPage = Number(previousDeep.lastPage) || 0;
  // Page 1 is always fresh from the light phase, so a first deep run starts at
  // page 2; a resumed run continues after its persisted `lastPage`.
  const startPage = Math.max(2, lastPage + 1);
  let datedTotal = events.filter((event) => event.finishedAt).length;
  const monthOnlyCount = () => events.filter(
    (event) => !event.finishedAt && /^\d{4}-\d{2}$/.test(String(event.readMonth || ''))
  ).length;
  let batches = 0;
  let lastProgress = null;

  const batchSize = Math.max(1, Number(options.batchPages) || 5);
  const flush = async (page, total, extra = {}) => {
    batches++;
    profile.deepScan = {
      pageTotal: total || pageTotal || null,
      lastPage: page,
      dated: datedTotal,
      monthOnly: monthOnlyCount(),
      total: events.length,
      done: Boolean(total && page >= total),
      startedAt: previousDeep.startedAt || startedAt,
      updatedAt: new Date().toISOString(),
      ...extra,
    };
    if (onBatch) await onBatch(profile, { ...profile.deepScan, page, pageTotal: total });
    return profile.deepScan;
  };

  const rsc = await fetchRsc(username, {
    jar: options.jar,
    fetchImpl: options.fetchImpl,
    delayMs: options.delayMs,
    userId: options.userId != null ? options.userId : profile.sourceUserId,
    startPage,
    maxPages: options.maxPages,
    onProgress: (progress) => {
      lastProgress = progress;
      if (onProgress) onProgress({ ...progress, dated: datedTotal, total: events.length });
    },
    onPage: async ({ page, pageTotal: total, rows }) => {
      let datedHere = 0;
      for (const row of rows) {
        const event = byUserBook.get(String(row.userBookId));
        if (!event) continue;
        const iso = readDateToIso(row.readDate);
        if (iso) {
          if (event.finishedAt !== iso) datedHere++;
          event.finishedAt = iso;
          event.readMonth = null;
        } else {
          // Month-only entry: keep the month for the timeline, never invent a day.
          const month = readMonthOf(row.readDate);
          if (month) event.readMonth = month;
        }
        if (row.rating != null && event.rating10 == null) {
          event.rating10 = Number(row.rating);
          event.rating = Number(row.rating);
          event.ratingScale = 10;
        }
      }
      datedTotal = events.filter((event) => event.finishedAt).length;
      console.log(
        `[livelib ${username}] deep page ${page}/${total || '?'}: dated=${datedTotal}/${events.length}`
      );
      if (onProgress) {
        onProgress({
          stage: 'deep',
          page,
          pageTotal: total,
          events: events.length,
          dated: datedTotal,
          monthOnly: monthOnlyCount(),
        });
      }
      const isLast = Boolean(total && page >= total);
      if (isLast || page % batchSize === 0) {
        await flush(page, total);
      }
    },
  });

  const total = rsc.pageTotal || pageTotal || lastProgress?.pageTotal || null;
  const lastPageSeen = Math.max(rsc.pagesFetched || 0, startPage - 1, Number(lastPage) || 0);
  if (!profile.deepScan || profile.deepScan.lastPage !== lastPageSeen) {
    await flush(lastPageSeen, total);
  } else if (total && lastPageSeen >= total && profile.deepScan.done !== true) {
    await flush(lastPageSeen, total);
  }

  return {
    skipped: false,
    requests: rsc.requests,
    warnings: rsc.warnings,
    deepScan: profile.deepScan,
    dated: datedTotal,
    total: events.length,
    batches,
    startPage,
  };
}

/**
 * LiveLib import.
 *
 * Two phases, one job:
 *
 *   light (default, ~3 requests / ~30-60 s):
 *     0. browser-like bootstrap GET -> cookie jar (`__ddg*` and friends);
 *     1. legacy bulk pass (metadata, ISBN, month headers);
 *     2. RSC page 1 only (20 newest books with exact dates).
 *     Events: every book in the collection; the ones outside page 1 are
 *     honestly undated (`summary.undatedEventCount`).
 *
 *   deep (`mode: 'deep'`, ~63 polite requests / ~3 min):
 *     read every RSC page and fill `finishedAt` on the imported events.
 *     Progress is persisted every 5 pages (`options.onBatch`) and resumed from
 *     `profile.deepScan.lastPage`.
 *
 * `options.existingProfile` keeps dates from a previous deep scan across a
 * light re-check. Merged by user_book id. Returns { profile, requests, ... }.
 */
async function importLivelib(username, options = {}) {
  const cleanUsername = String(username == null ? '' : username).trim().replace(/^@/, '');
  if (!/^[\w.-]{1,64}$/.test(cleanUsername)) {
    throw new LivelibError('Некорректное имя пользователя LiveLib.', 'livelib_invalid_username');
  }
  const mode = options.mode === 'deep' ? 'deep' : 'light';
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const warnings = [];
  const fixedDelay = Number.isFinite(Number(options.delayMs)) ? Number(options.delayMs) : null;
  const pause = () => (fixedDelay == null ? randomDelay() : fixedDelay);
  const jar = options.jar || makeJar(options.cookieHeader);
  const seeded = jar.size;

  // 0. Cold-session bootstrap. The delay is unconditional: the first request of
  // a session is the one DDoS-Guard scores, so it must look like a human click,
  // not like a 5 ms follow-up to the previous import.
  let session = null;
  if (options.bootstrap === false) {
    session = {
      skipped: true,
      status: null,
      url: null,
      hops: [],
      challenge: false,
      blocked: false,
      cookieCount: jar.size,
      title: null,
    };
  } else {
    const delay = options.bootstrapDelayMs == null ? pause() : Number(options.bootstrapDelayMs);
    if (delay > 0) await sleep(delay);
    try {
      session = await bootstrapSession(cleanUsername, {
        jar,
        fetchImpl: options.fetchImpl,
      });
    } catch (err) {
      throw new LivelibError(
        `LiveLib недоступен на bootstrap-запросе: ${err.message}`,
        'livelib_network_error'
      );
    }
    console.log(
      `[livelib ${cleanUsername}] bootstrap: status=${session.status} ` +
        `challenge=${session.challenge} cookies=${session.cookieCount} ` +
        `(seeded=${seeded}) hops=${session.hops.length}`
    );
    if (typeof options.onSession === 'function') {
      try {
        options.onSession(session);
      } catch (err) {
        // Diagnostics must never break the import.
      }
    }
    if (session.blocked || session.challenge) {
      warnings.push(
        `Bootstrap вернул HTTP ${session.status}` +
          `${session.challenge ? ' с DDoS-Guard/captcha-страницей' : ''}; ` +
          `продолжаем с полученными cookie (${session.cookieCount}).`
      );
    }
  }

  const bulk = await fetchBulk(cleanUsername, {
    onProgress: (progress) =>
      onProgress && onProgress({ stage: 'bulk', page: progress.page, pageTotal: null, events: progress.events }),
    perPage: options.bulkPerPage,
    jar,
    fetchImpl: options.fetchImpl,
    initialDelayMs: fixedDelay == null ? randomDelay() : fixedDelay,
  });

  const rsc = await fetchRsc(cleanUsername, {
    onProgress,
    // Light phase = page 1 only: the deep scan is a separate, resumable pass.
    maxPages: options.maxRscPages == null ? 1 : options.maxRscPages,
    jar,
    fetchImpl: options.fetchImpl,
    delayMs: fixedDelay == null ? undefined : fixedDelay,
  });
  for (const warning of rsc.warnings) warnings.push(warning);

  const events = [];
  const seen = new Set();
  for (const row of rsc.rows) {
    const bulkRow = bulk.byUserBook.get(row.userBookId) || null;
    const event = buildEvent(row, bulkRow);
    if (!event.sourceBookId || seen.has(event.id)) continue;
    seen.add(event.id);
    events.push(event);
  }

  // Bulk-only events: the book was in the legacy list but not on any RSC page
  // (possible when the collection shifts during the 2-3 minute scrape).
  let bulkOnly = 0;
  for (const bulkRow of bulk.entries) {
    if (rsc.byUserBook.has(bulkRow.userBookId)) continue;
    if (!bulkRow.bookId) continue;
    const event = buildEvent(null, bulkRow);
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    events.push(event);
    bulkOnly++;
  }
  if (bulkOnly > 0) {
    warnings.push(
      `${bulkOnly} book(s) came only from the legacy bulk pass (no RSC row); they have no exact read date.`
    );
  }

  const expectedTotal = rsc.total != null ? rsc.total : bulk.entries.length;
  if (expectedTotal != null && events.length !== expectedTotal) {
    warnings.push(
      `Event count ${events.length} differs from the profile counter ${expectedTotal} (duplicates or a collection change during the scrape).`
    );
  }

  // A light re-check reads only page 1: keep the exact dates a previous deep
  // scan already put on the other events.
  const restoredDates = mergeExistingDates(events, options.existingProfile);
  if (restoredDates > 0) {
    console.log(
      `[livelib ${cleanUsername}] light re-check kept ${restoredDates} deep-scan date(s)`
    );
  }

  const dated = events.filter((event) => event.finishedAt).length;
  const monthOnly = events.filter(
    (event) => !event.finishedAt && /^\d{4}-\d{2}$/.test(String(event.readMonth || ''))
  ).length;
  if (dated === 0 && mode !== 'light') {
    warnings.push('No exact read dates found: RSC payload may have changed shape.');
  }

  const editionCounts = new Map();
  for (const event of events) {
    if (!event.sourceBookId) continue;
    editionCounts.set(event.sourceBookId, (editionCounts.get(event.sourceBookId) || 0) + 1);
  }
  let duplicateEditions = 0;
  for (const count of editionCounts.values()) if (count > 1) duplicateEditions += count - 1;
  if (duplicateEditions > 0) {
    warnings.push(
      `${duplicateEditions} event(s) share an art_edition.id with another event; kept as separate events (likely re-reads).`
    );
  }

  events.sort((a, b) => {
    const left = a.finishedAt || '';
    const right = b.finishedAt || '';
    if (left === right) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return left < right ? 1 : -1;
  });

  const profile = {
    schemaVersion: 1,
    source: 'livelib',
    userKey: cleanUsername,
    sourceUserId: rsc.userId || null,
    importedAt: new Date().toISOString(),
    events,
    warnings,
    // Deep-scan progress survives a light re-check: a completed scan stays
    // marked done (no 63 pointless requests on every refresh), an interrupted
    // one keeps its `lastPage` so the next run resumes there.
    ...(options.existingProfile && options.existingProfile.deepScan
      ? { deepScan: options.existingProfile.deepScan }
      : {}),
  };

  return {
    profile,
    requests: { bulk: bulk.requests, rsc: rsc.requests, total: bulk.requests + rsc.requests },
    warnings,
    // Masked session diagnostics for the job status: statuses and counts only,
    // never cookie names/values.
    session: {
      bootstrap: session
        ? {
            skipped: Boolean(session.skipped),
            status: session.status == null ? null : session.status,
            challenge: Boolean(session.challenge),
            blocked: Boolean(session.blocked),
            cookieCount: session.cookieCount || 0,
            title: session.title || null,
            hops: Array.isArray(session.hops)
              ? session.hops.map((hop) => ({ status: hop.status, cookieCount: hop.cookieCount }))
              : [],
          }
        : null,
      seededCookies: seeded,
      cookiesUsed: jar.size,
    },
    totals: {
      events: events.length,
      dated,
      undated: events.length - dated - monthOnly,
      monthOnly,
      restoredDates,
      bulkEntries: bulk.entries.length,
      pages: rsc.pageTotal,
      pagesFetched: rsc.pagesFetched,
      profileCounter: expectedTotal,
      duplicateEditions,
    },
  };
}

module.exports = {
  LIVELIB_ORIGIN,
  LivelibError,
  BULK_PER_PAGE,
  USER_AGENT,
  BROWSER_HEADERS,
  makeJar,
  storeCookies,
  cookieHeaderOf,
  isChallengeHtml,
  bootstrapSession,
  flightFromHtml,
  parseRscHtml,
  parseBulkContent,
  readDateToIso,
  buildEvent,
  mergeExistingDates,
  request,
  fetchBulk,
  fetchRsc,
  deepScanProfile,
  importLivelib,
};
