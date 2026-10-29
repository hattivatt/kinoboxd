'use strict';

/**
 * Google Books provider (optional `GB_API_KEY`, anonymous fallback).
 *
 * Lookup order: ISBN -> title+author. Both are read-only GETs against
 * `volumes`. The ISBN path is the precise matcher for a tail that still has an
 * ISBN; the title path is the last net for a Cyrillic tail that has none (the
 * Литрес budget is bounded, so GB answers the rest).
 *
 * Credentials: `GB_API_KEY` (alias `BOOKS_GOOGLE_API_KEY`), dev fallback
 * `config/gbooks-token` — resolved by `server/config.js` and never logged. An
 * anonymous request still works; the key only raises the per-IP quota.
 *
 * Politeness / budget (AGENTS.md):
 *   - `BOOKS_GB_BUDGET` books per run (default 300, one budget unit per book,
 *     whatever the number of HTTP requests inside it);
 *   - `DEFAULT_REQUEST_DELAY_MS` (400 ms) before every request;
 *   - 403/429 trips a 30 min breaker (same rule as Литрес) instead of hammering
 *     the endpoint for every remaining book;
 *   - a network/5xx error is thrown (the resolve job treats it as a deferral:
 *     no negative cache, the book is asked again on the next run).
 *
 * Year semantics: `volumeInfo.publishedDate` is the year of the *edition* the
 * volume record describes, not the work's first publication (a 2016 АСТ reprint
 * of «Дюна» is not 2016). It is returned as `year` only; `firstPublishedYear`
 * stays empty, so the merge can never dress it up as a first-publication claim.
 * The year chart may still use it through the honest legacy `edition` channel.
 *
 * Returned fields: title, authors, publisher, year, categories -> genres,
 * pageCount -> pages, industryIdentifiers -> isbn13/isbn10, imageLinks ->
 * cover, infoLink -> links.pageUrl.
 */

const { fetchJson } = require('./http');
const { detectManga, collectMangaTexts } = require('./manga');
const { scoreCandidate } = require('./match');
const { normalizeIsbn, isbn10Of, normalizeTitle, surnameOf } = require('../normalize');
const config = require('../../config');

const NAME = 'googlebooks';
const API_URL = 'https://www.googleapis.com/books/v1/volumes';
const BREAKER_MS = 30 * 60 * 1000;
const DEFAULT_REQUEST_DELAY_MS = 400;
const DEFAULT_BUDGET = 300;
const YEAR_MIN = -3000;
const YEAR_MAX = 2100;

let breakerUntil = 0;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isBreakerOpen(now = Date.now()) {
  return now < breakerUntil;
}

function tripBreaker(ms = BREAKER_MS) {
  breakerUntil = Date.now() + ms;
}

function resetBreaker() {
  breakerUntil = 0;
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
  return createBudget(process.env.BOOKS_GB_BUDGET);
}

/**
 * `&key=…` for the query string, or '' when no key is configured.
 * The value never leaves this function (no logging, no error message).
 */
function authority() {
  let key = null;
  try {
    key = config.loadGbooksKey();
  } catch (err) {
    key = null;
  }
  return key ? `&key=${encodeURIComponent(key)}` : '';
}

/** Log line safe to keep: no URL, no key, only the query title. */
function maskedLog(message) {
  console.log(`[gbooks] ${message}`);
}

function coverOf(imageLinks) {
  if (!imageLinks || typeof imageLinks !== 'object') return null;
  const raw = imageLinks.thumbnail || imageLinks.smallThumbnail;
  if (!raw) return null;
  return String(raw)
    .replace(/^http:\/\//, 'https://')
    .replace(/&edge=curl/g, '');
}

function genresOf(categories) {
  const list = Array.isArray(categories) ? categories : categories ? [categories] : [];
  const out = [];
  for (const raw of list) {
    for (const part of String(raw).split(/\s*\/\s*/)) {
      const value = part.trim();
      if (value && !out.includes(value)) out.push(value);
    }
  }
  return out;
}

/**
 * Parse `volumeInfo.publishedDate` into a sane year.
 *
 * Google sends `YYYY`, `YYYY-MM` or `YYYY-MM-DD` (and occasionally an ISO
 * timestamp). Ancient works may carry a negative year (`-0500-01-01`), which
 * must survive as -500 instead of being read as +500. Zero/garbage is not a
 * year.
 */
function yearOf(publishedDate) {
  const text = String(publishedDate == null ? '' : publishedDate).trim();
  if (!text) return null;
  const match = /^(-?\d{1,4})(?!\d)/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  if (!Number.isFinite(year) || year === 0) return null;
  if (year < YEAR_MIN || year > YEAR_MAX) return null;
  return year;
}

function isbnPair(identifiers) {
  let isbn13 = null;
  let isbn10 = null;
  for (const entry of Array.isArray(identifiers) ? identifiers : []) {
    if (!entry || !entry.identifier) continue;
    if (entry.type === 'ISBN_13') isbn13 = normalizeIsbn(entry.identifier);
    if (entry.type === 'ISBN_10') isbn10 = String(entry.identifier).replace(/[^\dXx]/g, '').toUpperCase();
  }
  if (!isbn10 && isbn13) isbn10 = isbn10Of(isbn13);
  if (!isbn13 && isbn10) isbn13 = normalizeIsbn(isbn10);
  return { isbn13, isbn10 };
}

function normalizeVolume(item, query, method, options = {}) {
  const volume = (item && item.volumeInfo) || {};
  if (!volume.title) return null;
  const ids = isbnPair(volume.industryIdentifiers);
  const genres = genresOf(volume.categories);
  const title = String(volume.title);
  const authors = (Array.isArray(volume.authors) ? volume.authors : []).map((name) => String(name));
  // Canonical volume URL first: `infoLink` is country-specific
  // (books.google.com.vn) and carries the search query (`dq=…`) when the
  // volume was found by a phrase search.
  const pageUrl = item.id
    ? `https://books.google.com/books?id=${item.id}`
    : volume.canonicalVolumeLink || volume.infoLink || null;

  if (method === 'title') {
    const scored = scoreCandidate(query, { title, authors }, { fuzzyAuthor: true, minSim: 0.7 });
    if (!scored) return null;
    // Same confidence ladder as Литрес: an exact normalized title is a strong
    // claim, a fuzzy one can never outrank an exact hit or an ISBN match.
    const confidence = scored.exact ? 0.95 : Number((0.68 + scored.score * 0.2).toFixed(2));
    return {
      source: NAME,
      sourceId: String(item.id),
      workId: `gb:${item.id}`,
      title,
      authors,
      year: yearOf(volume.publishedDate),
      publisher: volume.publisher ? String(volume.publisher) : null,
      series: null,
      genres,
      pages: Number.isFinite(Number(volume.pageCount)) ? Number(volume.pageCount) : null,
      isbn13: ids.isbn13,
      isbn10: ids.isbn10,
      cover: coverOf(volume.imageLinks),
      links: { pageUrl },
      language: volume.language || null,
      confidence,
      match: {
        method,
        titleSim: scored.titleSim,
        exact: scored.exact,
        authorHit: scored.authorHit,
        authorFuzzy: scored.authorFuzzy === true,
      },
      mangaComics: detectManga({ genres, publisher: volume.publisher || null }),
      mangaTexts: collectMangaTexts({ genres, publisher: volume.publisher || null }),
    };
  }

  return {
    source: NAME,
    sourceId: String(item.id),
    workId: `gb:${item.id}`,
    title,
    authors,
    year: yearOf(volume.publishedDate),
    publisher: volume.publisher ? String(volume.publisher) : null,
    series: null,
    genres,
    pages: Number.isFinite(Number(volume.pageCount)) ? Number(volume.pageCount) : null,
    isbn13: ids.isbn13,
    isbn10: ids.isbn10,
    cover: coverOf(volume.imageLinks),
    links: { pageUrl },
    language: volume.language || null,
    confidence: 0.96,
    match: { method: 'isbn', titleSim: 1, exact: true, authorHit: null },
    mangaComics: detectManga({ genres, publisher: volume.publisher || null }),
    mangaTexts: collectMangaTexts({ genres, publisher: volume.publisher || null }),
  };
}

function quote(value) {
  return String(value == null ? '' : value).replace(/"/g, '').trim();
}

function titleQueryOf(input) {
  const parts = [];
  if (input.title) parts.push(`intitle:"${quote(input.title)}"`);
  const author = Array.isArray(input.authors) ? input.authors.find(Boolean) : null;
  if (author) parts.push(`inauthor:"${quote(author)}"`);
  return parts.join(' ');
}

/**
 * Plain phrase query (no `intitle:`/`inauthor:` operators). Google's fielded
 * operators do not index Cyrillic titles at all (probe 29.10.2026: `intitle:`
 * returns 0 for every Russian title tested, while the plain phrase finds the
 * same editions), so a Cyrillic title is searched plain first.
 */
function plainQueryOf(input) {
  const author = Array.isArray(input.authors) ? input.authors.find(Boolean) : null;
  return [quote(input.title), quote(author)].filter(Boolean).join(' ');
}

const CYRILLIC_TITLE = /[а-яё]/i;

/**
 * Title queries in the order worth spending requests on.
 *
 * Cyrillic: plain only (the fielded operators are dead for Russian titles).
 * Latin: fielded first, plain as the one fallback for an edition that is only
 * indexed under the bare phrase. At most two title requests per book.
 */
function titleQueriesOf(input) {
  const plain = plainQueryOf(input);
  if (CYRILLIC_TITLE.test(String(input.title || ''))) return plain ? [plain] : [];
  const fielded = titleQueryOf(input);
  const queries = [];
  for (const query of [fielded, plain]) {
    if (query && !queries.includes(query)) queries.push(query);
  }
  return queries;
}

function negativeKey(method, value) {
  return `${method}:${normalizeTitle(value)}`;
}

async function search(query, input, method, options) {
  const sleep = options.sleep || defaultSleep;
  const delay = options.requestDelayMs == null ? DEFAULT_REQUEST_DELAY_MS : Number(options.requestDelayMs);
  if (delay > 0) await sleep(delay);
  let data;
  try {
    data = await fetchJson(`${API_URL}?q=${encodeURIComponent(query)}&maxResults=5${authority()}`, {
      fetchImpl: options.fetchImpl,
      sleep,
      label: `${NAME} ${method}`,
    });
  } catch (err) {
    // 403 (key/quota blocked) and 429 (quota exhausted) are the same verdict:
    // stop asking for 30 minutes instead of burning the rest of the run.
    if (Number(err && err.status) === 429 || Number(err && err.status) === 403) tripBreaker();
    throw err;
  }
  const items = Array.isArray(data && data.items) ? data.items : [];
  const results = [];
  for (const item of items) {
    const normalized = normalizeVolume(item, input, method, options);
    if (normalized) results.push(normalized);
  }
  if (method === 'title') {
    results.sort((a, b) => b.confidence - a.confidence);
  }
  return results;
}

/**
 * @param {{isbn13?:string, isbn10?:string, title?:string, authors?:string[]}} input
 * @returns {Promise<object|null>} normalized work
 */
async function getWork(input = {}, options = {}) {
  if (isBreakerOpen()) return null;
  const budget = options.budget || null;
  // One budget unit per book, even when the lookup needs two HTTP requests
  // (ISBN search + title fallback). Exhausted budget = "not asked", so the
  // resolve job keeps the book pending instead of writing it off.
  if (budget && typeof budget.take === 'function' && !budget.take()) return null;
  const memo = options.negativeMemo instanceof Map ? options.negativeMemo : null;
  // One canonical ISBN per lookup: the derived ISBN-10 is not queried twice.
  const isbn = normalizeIsbn(input.isbn13) || normalizeIsbn(input.isbn10);

  if (isbn) {
    const key = negativeKey('isbn', isbn);
    if (!memo || !memo.has(key)) {
      const results = await search(`isbn:${isbn}`, input, 'isbn', options);
      if (results.length) return results[0];
      if (memo) memo.set(key, true);
    }
  }

  if (input.title) {
    const key = `${negativeKey('title', input.title)}|${surnameOf((input.authors || [])[0] || '')}`;
    if (memo && memo.has(key)) return null;
    for (const query of titleQueriesOf(input)) {
      const results = await search(query, input, 'title', options);
      if (results.length) {
        maskedLog(`hit "${String(input.title).slice(0, 40)}" -> ${results[0].sourceId} (title)`);
        return results[0];
      }
    }
    if (memo) memo.set(key, true);
  }
  return null;
}

/** Called by resolve: a 403/429 trips the breaker so the rest of the run is skipped. */
function noteError(error) {
  const status = Number(error && error.status);
  if (status === 403 || status === 429) {
    tripBreaker();
    return true;
  }
  return false;
}

module.exports = {
  NAME,
  API_URL,
  BREAKER_MS,
  DEFAULT_BUDGET,
  DEFAULT_REQUEST_DELAY_MS,
  createBudget,
  budgetFromEnv,
  getWork,
  normalizeVolume,
  yearOf,
  titleQueryOf,
  plainQueryOf,
  titleQueriesOf,
  parseSearch: (data) => (Array.isArray(data && data.items) ? data.items : []),
  isBreakerOpen,
  noteError,
  tripBreaker,
  resetBreaker,
};
