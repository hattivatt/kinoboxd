'use strict';

const { fetchJson, defaultSleep, createSourceClient } = require('./http');
const sources = require('../../core/sources');
const { detectManga, collectMangaTexts } = require('./manga');
const { scoreCandidate } = require('./match');
const { normalizeIsbn, isbn10Of, normalizeTitle, surnameOf } = require('../normalize');
const config = require('../../config');

const NAME = 'googlebooks';
const API_URL = 'https://www.googleapis.com/books/v1/volumes';
const source = createSourceClient({ name: NAME, budgetEnv: 'BOOKS_GB_BUDGET' });
const BREAKER_MS = source.breakerMs;
const DEFAULT_REQUEST_DELAY_MS = sources.pauseMs(NAME);
const DEFAULT_BUDGET = source.budgetLimit;
const { isBreakerOpen, tripBreaker, resetBreaker, createBudget, budgetFromEnv } = source;
const YEAR_MIN = -3000;
const YEAR_MAX = 2100;

function authority() {
  let key = null;
  try {
    key = config.loadGbooksKey();
  } catch (err) {
    key = null;
  }
  return key ? `&key=${encodeURIComponent(key)}` : '';
}

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
  const pageUrl = item.id
    ? `https://books.google.com/books?id=${item.id}`
    : volume.canonicalVolumeLink || volume.infoLink || null;

  if (method === 'title') {
    const scored = scoreCandidate(query, { title, authors }, { fuzzyAuthor: true, minSim: 0.7 });
    if (!scored) return null;
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

function plainQueryOf(input) {
  const author = Array.isArray(input.authors) ? input.authors.find(Boolean) : null;
  return [quote(input.title), quote(author)].filter(Boolean).join(' ');
}

const CYRILLIC_TITLE = /[а-яё]/i;

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

async function getWork(input = {}, options = {}) {
  if (isBreakerOpen()) return null;
  const budget = options.budget || null;
  if (budget && typeof budget.take === 'function' && !budget.take()) return null;
  const memo = options.negativeMemo instanceof Map ? options.negativeMemo : null;
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
