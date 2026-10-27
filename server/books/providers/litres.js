'use strict';

/**
 * Litres provider — the first matcher for Russian-titled LiveLib books.
 *
 * CWA's `litres.py` talks to the public foundation API (no key, no cookies):
 *   GET https://api.litres.ru/foundation/api/search?q=...&limit=...&types=text_book
 *   GET https://api.litres.ru/foundation/api/arts/{id}
 * Search returns the work card (title, persons, cover, rating, date), the art
 * endpoint adds ISBN, genres, tags, series and paper-book pages.
 *
 * Politeness: 2 s pause before every request, per-run book budget
 * (`BOOKS_LITRES_BUDGET`, default 200), 30 min breaker on 403/429. Logs never
 * include response bodies, only masked query/status/counters.
 */

const { fetchJson } = require('./http');
const { detectManga, collectMangaTexts } = require('./manga');
const { scoreCandidate } = require('./match');
const { normalizeIsbn, isbn10Of } = require('../normalize');

const NAME = 'litres';
const ORIGIN = 'https://www.litres.ru';
const API_BASE = 'https://api.litres.ru/foundation/api';
const DEFAULT_BUDGET = 200;
const DEFAULT_PAUSE_MS = 2000;
const BLOCK_BREAKER_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;
const SEARCH_LIMIT = 5;
const SEARCH_TYPES = ['text_book', 'audiobook'];

const HEADERS = {
  'User-Agent': 'Calibre-Web-Litres-Provider/2.0',
  accept: 'application/json, text/plain, */*',
  'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8',
  'ui-language-code': 'ru',
};

let blockedUntil = 0;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isBreakerOpen(now = Date.now()) {
  return now < blockedUntil;
}

function tripBreaker(ms = BLOCK_BREAKER_MS) {
  blockedUntil = Date.now() + ms;
}

function resetBreaker() {
  blockedUntil = 0;
}

function createBudget(limit) {
  const parsed = Number(limit);
  const max = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_BUDGET;
  return {
    limit: max,
    used: 0,
    get remaining() {
      return Math.max(max - this.used, 0);
    },
    take() {
      if (this.used >= max) return false;
      this.used++;
      return true;
    },
  };
}

function budgetFromEnv() {
  return createBudget(process.env.BOOKS_LITRES_BUDGET);
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function absoluteUrl(value) {
  if (!value) return null;
  try {
    return new URL(String(value), ORIGIN).toString();
  } catch (err) {
    return null;
  }
}

/** Drop "(epub)", "(pdf)" and similar format suffixes from search titles. */
function cleanTitle(value) {
  return String(value == null ? '' : value)
    .replace(/\s*\([^)]*(?:pdf|epub|fb2|mobi)[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function personsOf(item) {
  return Array.isArray(item && item.persons) ? item.persons : [];
}

function authorNamesOf(item) {
  const names = [];
  for (const person of personsOf(item)) {
    const role = String((person && person.role) || '').toLowerCase();
    const name = person && (person.full_name || person.fullName || person.name);
    if (!name || !String(name).trim()) continue;
    if (role && role !== 'author' && role !== 'автор') continue;
    if (!names.includes(String(name).trim())) names.push(String(name).trim());
  }
  return names;
}

function namesOf(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    const name = typeof entry === 'string' ? entry : entry && entry.name;
    if (typeof name === 'string' && name.trim() && !out.includes(name.trim())) out.push(name.trim());
  }
  return out;
}

function yearOf(...values) {
  for (const value of values) {
    const match = /(\d{4})/.exec(String(value || ''));
    if (match) return Number(match[1]);
  }
  return null;
}

function normalizeLitresIsbn(raw) {
  if (!raw) return null;
  const parts = String(raw).split(/[,;/]\s*/);
  for (const part of parts) {
    const normalized = normalizeIsbn(part);
    if (normalized) return normalized;
  }
  return null;
}

function pagesOf(detail) {
  if (!detail) return null;
  const candidates = [
    detail.paper_book && detail.paper_book.pages,
    detail.paper_book && detail.paper_book.page_count,
    detail.paper_book && detail.paper_book.pages_count,
    Array.isArray(detail.paper_books) && detail.paper_books[0] && detail.paper_books[0].pages,
    Array.isArray(detail.paper_books) && detail.paper_books[0] && detail.paper_books[0].page_count,
  ];
  for (const value of candidates) {
    if (Number.isFinite(Number(value)) && Number(value) > 0) return Number(value);
  }
  return null;
}

function seriesOf(item, detail) {
  const list =
    (detail && Array.isArray(detail.series) && detail.series.length ? detail.series : null) ||
    (item && Array.isArray(item.series) ? item.series : []);
  const first = list.find((entry) => entry && entry.name);
  if (!first) return null;
  const position = Number(first.art_order);
  return {
    name: String(first.name),
    position: Number.isFinite(position) && position > 0 ? position : null,
  };
}

function extractInstances(data) {
  const rows = data && data.payload && Array.isArray(data.payload.data) ? data.payload.data : [];
  const items = [];
  for (const row of rows) {
    const item = row && row.instance ? row.instance : row;
    if (item && (item.id || item.uuid) && item.title) items.push(item);
  }
  return items;
}

/** Normalize a search item + optional art detail into the provider contract. */
function normalizeLitres(item, detail, input, scored) {
  if (!item) return null;
  const id = item.id || item.uuid;
  if (!id) return null;
  const title = cleanTitle(item.title || (detail && detail.title));
  if (!title) return null;
  const authors = authorNamesOf(item).length ? authorNamesOf(item) : authorNamesOf(detail);
  const genres = namesOf(detail && detail.genres);
  const tags = namesOf(detail && detail.tags);
  const publisher =
    (detail && typeof detail.publisher === 'string' && detail.publisher) ||
    (typeof item.publisher === 'string' && item.publisher) ||
    null;
  const series = seriesOf(item, detail);
  const isbn13 = normalizeLitresIsbn(
    (detail && detail.isbn) ||
      item.isbn ||
      (detail && detail.paper_book && detail.paper_book.isbn)
  );
  const isbn10 = isbn13 ? isbn10Of(isbn13) : null;
  const year = yearOf(
    detail && detail.publication_date,
    item.date_written_at,
    detail && detail.first_published_at,
    item.release_date,
    item.available_from
  );
  const confidence = scored && scored.exact ? 0.95 : Number((0.68 + (scored ? scored.score : 0) * 0.2).toFixed(2));
  return {
    source: NAME,
    sourceId: String(id),
    workId: `lr:${id}`,
    title,
    authors,
    year,
    publisher,
    series,
    genres,
    pages: pagesOf(detail),
    isbn13,
    isbn10,
    cover: absoluteUrl(item.cover_url || (detail && detail.cover_url)),
    links: {
      pageUrl: absoluteUrl(item.url || (detail && detail.url)) || `${ORIGIN}/book/${id}/`,
    },
    language: item.language_code || (detail && detail.language_code) || null,
    confidence,
    match: {
      method: 'title',
      titleSim: scored ? scored.titleSim : null,
      exact: scored ? scored.exact : null,
      authorHit: scored ? scored.authorHit : null,
    },
    mangaComics: detectManga({
      genres: genres.concat(tags),
      series: series ? [series] : [],
      publisher,
    }),
    mangaTexts: collectMangaTexts({
      genres: genres.concat(tags),
      series: series ? [series] : [],
      publisher,
    }),
    litres: {
      rating: item.rating && Number.isFinite(Number(item.rating.rated_avg)) ? Number(item.rating.rated_avg) : null,
      artType: item.art_type == null ? null : Number(item.art_type),
      symbolsCount: Number.isFinite(Number(item.symbols_count)) ? Number(item.symbols_count) : null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function searchUrl(query) {
  const url = new URL(`${API_BASE}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(SEARCH_LIMIT));
  url.searchParams.set('show_unavailable', 'true');
  for (const type of SEARCH_TYPES) url.searchParams.append('types', type);
  return url.toString();
}

async function pauseThen(options, label) {
  const sleep = options.sleep || defaultSleep;
  const pause = options.litresPauseMs == null ? DEFAULT_PAUSE_MS : Number(options.litresPauseMs);
  if (pause > 0) await sleep(pause);
  return label;
}

function maskedLog(message) {
  console.log(`[litres] ${message}`);
}

/**
 * @param {{title?:string, authors?:string[], isbn13?:string, isbn10?:string}} input
 * @returns {Promise<object|null>} normalized work
 */
async function getWork(input = {}, options = {}) {
  if (isBreakerOpen()) return null;
  const title = String(input.title || '').trim();
  if (!title) return null;
  const budget = options.budget || null;
  if (budget && typeof budget.take === 'function' && !budget.take()) return null;

  const query = [title, ...(Array.isArray(input.authors) ? input.authors.slice(0, 1) : [])]
    .filter(Boolean)
    .join(' ');
  const memo = options.negativeMemo instanceof Map ? options.negativeMemo : null;
  const memoKey = `litres:${query.toLowerCase()}`;
  if (memo && memo.has(memoKey)) return null;

  let data;
  try {
    await pauseThen(options, 'search');
    data = await fetchJson(searchUrl(query), {
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
      timeoutMs: options.timeoutMs || REQUEST_TIMEOUT_MS,
      headers: HEADERS,
      label: 'litres search',
    });
  } catch (err) {
    if (Number(err && err.status) === 403 || Number(err && err.status) === 429) tripBreaker();
    throw err;
  }

  const items = extractInstances(data);
  let best = null;
  for (const item of items) {
    const scored = scoreCandidate(input, {
      title: cleanTitle(item.title),
      authors: authorNamesOf(item),
    });
    if (!scored) continue;
    const confidence = scored.exact ? 0.95 : 0.68 + scored.score * 0.2;
    const better =
      !best ||
      confidence > best.confidence ||
      (confidence === best.confidence &&
        Number(item.art_type) === 0 &&
        Number(best.item.art_type) !== 0);
    if (better) best = { item, scored, confidence };
  }
  if (!best) {
    if (memo) memo.set(memoKey, true);
    maskedLog(`miss "${title.slice(0, 40)}" (${items.length} result(s))`);
    return null;
  }

  let detail = null;
  try {
    await pauseThen(options, 'detail');
    const detailData = await fetchJson(`${API_BASE}/arts/${encodeURIComponent(best.item.id)}`, {
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
      timeoutMs: options.timeoutMs || REQUEST_TIMEOUT_MS,
      headers: HEADERS,
      label: 'litres art',
    });
    detail = detailData && detailData.payload ? detailData.payload.data : null;
  } catch (err) {
    if (Number(err && err.status) === 403 || Number(err && err.status) === 429) tripBreaker();
    // Search data is still usable; never echo the response body.
    maskedLog(`detail failed id=${best.item.id} code=${(err && err.code) || 'error'}`);
  }

  const result = normalizeLitres(best.item, detail, input, best.scored);
  if (!result) return null;
  maskedLog(
    `hit "${title.slice(0, 40)}" -> ${best.item.id} (${result.isbn13 ? 'isbn' : 'no-isbn'}, ` +
      `${result.genres.length} genre(s))`
  );
  return result;
}

module.exports = {
  NAME,
  ORIGIN,
  API_BASE,
  DEFAULT_BUDGET,
  DEFAULT_PAUSE_MS,
  BLOCK_BREAKER_MS,
  createBudget,
  budgetFromEnv,
  getWork,
  normalizeLitres,
  extractInstances,
  authorNamesOf,
  cleanTitle,
  isBreakerOpen,
  tripBreaker,
  resetBreaker,
};
