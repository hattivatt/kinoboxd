'use strict';

/**
 * Google Books provider (anonymous by default, optional `BOOKS_GOOGLE_API_KEY`).
 *
 * Lookup order: ISBN -> title+author. Both are read-only GETs. The anonymous
 * quota is per-IP and can be exhausted (`429 RESOURCE_EXHAUSTED`); in that case
 * a per-process breaker disables the provider for 10 minutes instead of
 * hammering the endpoint for every unresolved book in the run.
 *
 * Returned fields: title, authors, publisher, year, categories -> genres,
 * pageCount -> pages, industryIdentifiers -> isbn13/isbn10, imageLinks ->
 * cover, infoLink -> links.pageUrl.
 */

const { fetchJson } = require('./http');
const { detectManga } = require('./manga');
const { scoreCandidate } = require('./match');
const { normalizeIsbn, isbn10Of, normalizeTitle, surnameOf } = require('../normalize');

const NAME = 'googlebooks';
const API_URL = 'https://www.googleapis.com/books/v1/volumes';
const BREAKER_MS = 10 * 60 * 1000;
const DEFAULT_REQUEST_DELAY_MS = 300;

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

function authority() {
  const key = process.env.BOOKS_GOOGLE_API_KEY;
  return key ? `&key=${encodeURIComponent(key)}` : '';
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
  const match = /^(\d{4})/.exec(String(publishedDate || ''));
  return match ? Number(match[1]) : null;
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
  const pageUrl =
    volume.infoLink ||
    volume.canonicalVolumeLink ||
    (item.id ? `https://books.google.com/books?id=${item.id}` : null);

  if (method === 'title') {
    const scored = scoreCandidate(query, { title, authors });
    if (!scored) return null;
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
      confidence: Number((0.6 + scored.score * 0.28).toFixed(2)),
      match: { method, titleSim: scored.titleSim, exact: scored.exact, authorHit: scored.authorHit },
      mangaComics: detectManga({ genres, publisher: volume.publisher || null }),
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
  };
}

function titleQueryOf(input) {
  const parts = [];
  if (input.title) parts.push(`intitle:"${String(input.title).replace(/"/g, '')}"`);
  const author = Array.isArray(input.authors) ? input.authors.find(Boolean) : null;
  if (author) parts.push(`inauthor:"${String(author).replace(/"/g, '')}"`);
  return parts.join(' ');
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
    if (Number(err && err.status) === 429) tripBreaker();
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
    const query = titleQueryOf(input);
    const results = await search(query, input, 'title', options);
    if (results.length) return results[0];
    if (memo) memo.set(key, true);
  }
  return null;
}

/** Called by resolve: a 429 trips the breaker so the rest of the run is skipped. */
function noteError(error) {
  if (error && Number(error.status) === 429) {
    tripBreaker();
    return true;
  }
  return false;
}

module.exports = {
  NAME,
  getWork,
  normalizeVolume,
  parseSearch: (data) => (Array.isArray(data && data.items) ? data.items : []),
  isBreakerOpen,
  noteError,
  resetBreaker,
};
