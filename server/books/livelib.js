'use strict';

/**
 * LiveLib import (reading profile of a public user).
 *
 * Two complementary sources, both public and login-free (P0, 27.10.2026):
 *
 *  1. Next.js collection pages
 *       GET https://www.livelib.ru/reader/{username}/read?ordering=read_at_desc&page=N
 *     (308 -> /users/{numericId}/books/read?ordering=read_at_desc&page=N).
 *     20 cards per page; the authoritative data is the React Server Component
 *     payload (self.__next_f): personal `rating` (0..10) and `read_date`
 *     (year/month/day) per user_book. 1245 books = 63 pages.
 *
 *  2. Legacy bulk endpoint (undocumented, "livelib-backup" trick)
 *       POST /reader/{username}/read/listview/biglist
 *       x-requested-with: XMLHttpRequest, form-urlencoded
 *       page_no=1&per_page=1000&is_new_design=ll2015b&is_prev=false
 *     Returns JSON { error_code, content: HTML, last_page, object_ids }.
 *     One request per 1000 books, and the HTML carries ISBN (~68%),
 *     publisher/year/language/series per user_book.
 *
 * Merge: the bulk pass supplies metadata, the RSC pass supplies exact dates and
 * the native 10-scale rating. Both are keyed by the SAME user_book id
 * (`div-userbook-{id}` vs payload `id`), which is stable across re-imports.
 * `art_edition.id` alone is not unique (18 duplicate ids in 1245 events), so
 * events are keyed by user_book id and edition duplicates are reported as
 * re-reads instead of being collapsed.
 *
 * Politeness: one request at a time, random 1.5-2.5 s pause between requests,
 * browser UA, 429/403 -> stop (no hammering), transport retries only.
 *
 * HTML fixtures for tests live in test/fixtures/ (gzipped real pages).
 */

const cheerio = require('cheerio');

const LIVELIB_ORIGIN = 'https://www.livelib.ru';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/128.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 45000;
const MIN_DELAY_MS = 1500;
const MAX_DELAY_MS = 2500;
const BULK_PER_PAGE = 1000;
const MAX_RSC_PAGES = 200;
const MAX_BULK_PAGES = 10;

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
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

/** Fetch with transport retries; refuses 403/429 loudly instead of retrying. */
async function request(url, options = {}, label = url) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method: options.method || 'GET',
        headers: options.headers,
        body: options.body,
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      lastError = err;
      if (attempt >= 3) {
        throw new LivelibError(`LiveLib недоступен (${label}): ${err.message}`, 'livelib_network_error');
      }
      await sleep(2000 * attempt);
      continue;
    }

    if (response.status === 429 || response.status === 403) {
      throw new LivelibError(
        `LiveLib ограничил доступ (HTTP ${response.status}) — импорт остановлен, повторите позже.`,
        'livelib_blocked'
      );
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
    return { status: response.status, url: response.url || url, headers: response.headers, text };
  }
  throw lastError;
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
 * Parse one server-rendered collection page.
 * Returns { rows, total, nextPage, pageTotal }.
 */
function parseRscHtml(html) {
  const flight = flightFromHtml(html);
  if (!flight) {
    throw new LivelibError(
      'LiveLib: RSC-payload не найден (разметка/формат страницы изменились).',
      'livelib_parse_error'
    );
  }

  const anchor = flight.search(/"payload"\s*:\s*\{\s*"pagination"/);
  if (anchor < 0) {
    throw new LivelibError(
      'LiveLib: в RSC-payload нет блока payload/pagination (разметка изменилась).',
      'livelib_parse_error'
    );
  }
  const brace = flight.indexOf('{', anchor);
  const raw = sliceBalancedJson(flight, brace);
  if (!raw) {
    throw new LivelibError('LiveLib: не удалось разобрать RSC-payload.', 'livelib_parse_error');
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new LivelibError(
      `LiveLib: RSC-payload не является JSON (${err.message}).`,
      'livelib_parse_error'
    );
  }

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
  const entries = [];
  const byUserBook = new Map();
  let pageNo = 1;
  let requests = 0;
  let lastPage = false;

  while (!lastPage && pageNo <= MAX_BULK_PAGES) {
    if (requests > 0) await sleep(randomDelay());
    const res = await request(
      `${LIVELIB_ORIGIN}/reader/${encodeURIComponent(username)}/read/listview/biglist`,
      {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'x-requested-with': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'Accept-Language': 'ru-RU,ru;q=0.9',
          Referer: `${LIVELIB_ORIGIN}/reader/${encodeURIComponent(username)}/read`,
        },
        body: `page_no=${pageNo}&per_page=${perPage}&is_new_design=ll2015b&is_prev=false`,
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
 * Scrape all collection pages. Page 1 goes through the public alias (which
 * 308-redirects to the numeric /users/{id}/books/read URL); the numeric id is
 * then reused so the remaining 62 pages need no redirect.
 */
async function fetchRsc(username, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const maxPages = Math.min(Math.max(Number(options.maxPages) || MAX_RSC_PAGES, 1), MAX_RSC_PAGES);
  const delayMs = Number.isFinite(Number(options.delayMs)) ? Number(options.delayMs) : null;
  const pageDelay = () => (delayMs == null ? randomDelay() : delayMs);
  const rows = [];
  const byUserBook = new Map();
  const warnings = [];
  let requests = 0;
  let userId = null;
  let pageTotal = null;
  let total = null;
  let pagesFetched = 0;

  let page = 1;
  const first = await request(
    `${LIVELIB_ORIGIN}/reader/${encodeURIComponent(username)}/read?ordering=read_at_desc`,
    {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9',
      },
    },
    'rsc page 1'
  );
  requests++;

  const userIdMatch = String(first.url).match(/\/users\/(\d+)\/books\/read/);
  if (userIdMatch) userId = userIdMatch[1];

  let parsed = parseRscHtml(first.text);
  if (parsed.rows.length === 0) {
    throw new LivelibError(
      `LiveLib: страница 1 профиля ${username} не содержит книг (канарейка: разметка изменилась).`,
      'livelib_empty'
    );
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
  pagesFetched = 1;
  console.log(
    `[livelib ${username}] rsc page 1/${pageTotal || '?'}: rows=${parsed.rows.length} total=${total}`
  );
  if (onProgress) onProgress({ stage: 'rsc', page, pageTotal, events: rows.length });

  const limit = Math.min(pageTotal || 1, maxPages);
  while (page < limit) {
    await sleep(pageDelay());
    page++;
    const url = userId
      ? `${LIVELIB_ORIGIN}/users/${userId}/books/read?ordering=read_at_desc&page=${page}`
      : `${LIVELIB_ORIGIN}/reader/${encodeURIComponent(username)}/read?ordering=read_at_desc&page=${page}`;
    const res = await request(
      url,
      {
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
    parsed = parseRscHtml(res.text);
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
        `added=${added} collected=${rows.length}`
    );
    if (onProgress) onProgress({ stage: 'rsc', page, pageTotal, events: rows.length });

    // Pagination is client-side in the current Next.js app: `?page=N` may
    // render page 1 again (verified live 27.10.2026). Stop at the first page
    // that brings no new user_book ids instead of re-reading the same 20 cards
    // 62 times; the bulk pass still carries the rest of the profile.
    if (added === 0) {
      warnings.push(
        `Collection pagination returned no new books on page ${page} ` +
          `(server ignores ?page= for anonymous users); stopped after ${pagesFetched} page(s). ` +
          `Only books from page 1 have exact read dates; the rest come from the legacy bulk pass and are undated.`
      );
      console.warn(
        `[livelib ${username}] page ${page} repeated known books; pagination seems ignored, stopping.`
      );
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
    startedAt: null,
    finishedAt,
    readMonth: finishedAt ? null : (bulkRow && bulkRow.readMonth) || null,
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
 * Full LiveLib import: bulk metadata pass + all RSC pages, merged by
 * user_book id. Returns { profile, requests, warnings, totals }.
 */
async function importLivelib(username, options = {}) {
  const cleanUsername = String(username == null ? '' : username).trim().replace(/^@/, '');
  if (!/^[\w.-]{1,64}$/.test(cleanUsername)) {
    throw new LivelibError('Некорректное имя пользователя LiveLib.', 'livelib_invalid_username');
  }
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const warnings = [];

  const bulk = await fetchBulk(cleanUsername, {
    onProgress: (progress) =>
      onProgress && onProgress({ stage: 'bulk', page: progress.page, pageTotal: null, events: progress.events }),
    perPage: options.bulkPerPage,
  });

  const rsc = await fetchRsc(cleanUsername, {
    onProgress,
    maxPages: options.maxRscPages,
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

  const dated = events.filter((event) => event.finishedAt).length;
  if (dated === 0) {
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
  };

  return {
    profile,
    requests: { bulk: bulk.requests, rsc: rsc.requests, total: bulk.requests + rsc.requests },
    warnings,
    totals: {
      events: events.length,
      dated,
      undated: events.length - dated,
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
  flightFromHtml,
  parseRscHtml,
  parseBulkContent,
  readDateToIso,
  buildEvent,
  request,
  fetchBulk,
  fetchRsc,
  importLivelib,
};
