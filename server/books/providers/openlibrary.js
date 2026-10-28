'use strict';

/**
 * Open Library provider (anonymous, no key).
 *
 * ISBN path: /api/books?bibkeys=ISBN:{isbn}&format=json&jscmd=data — edition
 * record with title/authors/publishers/publish_date/pages/subjects/cover.
 * Fallback: /search.json?title=...&author=... for works whose ISBN is unknown.
 *
 * Fields are famously dirty: subjects are user tags (`Accessible book`,
 * `Protected DAISY`, ...), so a small stop-list keeps the genre widgets clean.
 */

const { fetchJson } = require('./http');
const { detectManga, collectMangaTexts } = require('./manga');
const { scoreCandidate } = require('./match');
const { normalizeIsbn, isbn10Of, normalizeTitle, surnameOf } = require('../normalize');

const NAME = 'openlibrary';
const BOOKS_URL = 'https://openlibrary.org/api/books';
const SEARCH_URL = 'https://openlibrary.org/search.json';
const DEFAULT_REQUEST_DELAY_MS = 250;

const SUBJECT_STOPLIST =
  /^(accessible book|protected daisy|in library|large type books|reading level-grade|open library staff picks|popular print disabled books|internet archive wishlist|browsing library|overdrive|libby|ebook|audiobook|fiction|nonfiction|general)$/i;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function namesOf(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (!entry) continue;
    const name = typeof entry === 'string' ? entry : entry.name;
    if (typeof name === 'string' && name.trim() && !out.includes(name.trim())) out.push(name.trim());
  }
  return out;
}

function subjectsOf(list, limit = 25) {
  const out = [];
  for (const name of namesOf(list)) {
    if (SUBJECT_STOPLIST.test(name)) continue;
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

function yearOf(value) {
  if (typeof value === 'number' && value > 0) return value;
  const match = /(\d{4})/.exec(String(value || ''));
  return match ? Number(match[1]) : null;
}

function coverOf(cover, coverId) {
  if (cover && typeof cover === 'object') {
    const value = cover.large || cover.medium || cover.small;
    if (value) return String(value).replace(/^http:\/\//, 'https://');
  }
  if (coverId) return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
  return null;
}

function pageUrlOf(key) {
  if (!key) return null;
  if (/^https?:\/\//.test(key)) return key;
  return `https://openlibrary.org${key.startsWith('/') ? '' : '/'}${key}`;
}

function sourceIdOf(key) {
  if (!key) return null;
  return String(key).replace(/^https?:\/\/openlibrary\.org/, '').split('/').filter(Boolean).pop() || null;
}

function isbnPair(identifiers) {
  const ids = identifiers && typeof identifiers === 'object' ? identifiers : {};
  const isbn13 = (Array.isArray(ids.isbn_13) ? ids.isbn_13 : []).map(normalizeIsbn).find(Boolean) || null;
  const raw10 = (Array.isArray(ids.isbn_10) ? ids.isbn_10 : []).find(Boolean) || null;
  const isbn10 = raw10 ? String(raw10).replace(/[^\dXx]/g, '').toUpperCase() : isbn10Of(isbn13);
  return { isbn13: isbn13 || (isbn10 ? normalizeIsbn(isbn10) : null), isbn10 };
}

function normalizeEdition(record, input) {
  if (!record || !record.title) return null;
  const key = record.key || null;
  const ids = isbnPair(record.identifiers);
  // Display genres stay capped; detection reads every usable subject.
  const genres = subjectsOf(record.subjects);
  const allSubjects = subjectsOf(record.subjects, Number.POSITIVE_INFINITY);
  const publisher = namesOf(record.publishers)[0] || null;
  const authors = namesOf(record.authors);
  const mangaTexts = collectMangaTexts({ subjects: allSubjects, publisher });
  return {
    source: NAME,
    sourceId: sourceIdOf(key),
    workId: `ol:${sourceIdOf(key)}`,
    title: String(record.title),
    authors,
    year: yearOf(record.publish_date),
    publisher,
    series: null,
    genres,
    pages: Number.isFinite(Number(record.number_of_pages)) ? Number(record.number_of_pages) : null,
    isbn13: ids.isbn13 || normalizeIsbn(input && input.isbn13) || normalizeIsbn(input && input.isbn10),
    isbn10: ids.isbn10 || (input && input.isbn10) || null,
    cover: coverOf(record.cover, null),
    links: { pageUrl: pageUrlOf(key) },
    language: null,
    confidence: 0.94,
    match: { method: 'isbn', titleSim: 1, exact: true, authorHit: null },
    mangaComics: detectManga({ genres, subjects: allSubjects, publisher }),
    mangaTexts,
  };
}

function normalizeSearchDoc(doc, query) {
  if (!doc || !doc.title) return null;
  const authors = namesOf(doc.author_name);
  const scored = scoreCandidate(query, { title: doc.title, authors });
  if (!scored) return null;
  const publisher = namesOf(doc.publisher)[0] || null;
  const genres = subjectsOf(doc.subject);
  const allSubjects = subjectsOf(doc.subject, Number.POSITIVE_INFINITY);
  const key = doc.key || null;
  const isbns = Array.isArray(doc.isbn) ? doc.isbn.map(normalizeIsbn).filter(Boolean) : [];
  return {
    source: NAME,
    sourceId: sourceIdOf(key),
    workId: `ol:${sourceIdOf(key)}`,
    title: String(doc.title),
    authors,
    year: yearOf(doc.first_publish_year),
    firstPublishedYear: yearOf(doc.first_publish_year),
    publisher,
    series: null,
    genres,
    pages: Number.isFinite(Number(doc.number_of_pages_median))
      ? Number(doc.number_of_pages_median)
      : null,
    isbn13: isbns.find((value) => String(value).length === 13) || null,
    isbn10: isbns.find((value) => String(value).length === 10) || null,
    cover: coverOf(null, doc.cover_i),
    links: { pageUrl: pageUrlOf(key) },
    language: null,
    confidence: Number((0.55 + scored.score * 0.3).toFixed(2)),
    match: {
      method: 'title',
      titleSim: scored.titleSim,
      exact: scored.exact,
      authorHit: scored.authorHit,
    },
    mangaComics: detectManga({ genres, subjects: allSubjects, publisher }),
    mangaTexts: collectMangaTexts({ subjects: allSubjects, publisher }),
  };
}

async function delayThen(options, label) {
  const sleep = options.sleep || defaultSleep;
  const delay =
    options.requestDelayMs == null ? DEFAULT_REQUEST_DELAY_MS : Number(options.requestDelayMs);
  if (delay > 0) await sleep(delay);
  return label;
}

async function byIsbn(isbn, input, options) {
  await delayThen(options, 'isbn');
  const url = `${BOOKS_URL}?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`;
  const data = await fetchJson(url, {
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    label: `${NAME} isbn`,
  });
  const key = `ISBN:${isbn}`;
  const record = data && data[key] ? data[key] : null;
  if (!record) return null;
  const result = normalizeEdition(record, input);
  if (!result) return null;
  // `publish_date` of an edition is not first publication: «Искусство войны»
  // is an ancient work whose АСТ edition is from 2013. The work record knows
  // `first_publish_year`; one extra request, only when the edition points at a
  // work and the first-publish year is still unknown.
  const workKey = Array.isArray(record.works) && record.works[0] && record.works[0].key;
  if (workKey) {
    try {
      await delayThen(options, 'work');
      const work = await fetchJson(`https://openlibrary.org${workKey}.json`, {
        fetchImpl: options.fetchImpl,
        sleep: options.sleep,
        label: `${NAME} work`,
      });
      const firstYear = yearOf(work && work.first_publish_year);
      if (firstYear != null) result.firstPublishedYear = firstYear;
    } catch (err) {
      // The edition is still usable without the work-level year.
    }
  }
  return result;
}

async function byTitle(input, options) {
  await delayThen(options, 'title');
  const params = new URLSearchParams();
  if (input.title) params.set('title', String(input.title));
  const author = Array.isArray(input.authors) ? input.authors.find(Boolean) : null;
  if (author) params.set('author', String(author));
  params.set('limit', '5');
  params.set(
    'fields',
    'key,title,author_name,publisher,first_publish_year,cover_i,subject,isbn,number_of_pages_median'
  );
  const data = await fetchJson(`${SEARCH_URL}?${params.toString()}`, {
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    label: `${NAME} title`,
  });
  const docs = Array.isArray(data && data.docs) ? data.docs : [];
  const results = [];
  for (const doc of docs) {
    const normalized = normalizeSearchDoc(doc, input);
    if (normalized) results.push(normalized);
  }
  results.sort((a, b) => b.confidence - a.confidence);
  return results[0] || null;
}

/**
 * @param {{isbn13?:string, isbn10?:string, title?:string, authors?:string[]}} input
 * @returns {Promise<object|null>} normalized work
 */
async function getWork(input = {}, options = {}) {
  const memo = options.negativeMemo instanceof Map ? options.negativeMemo : null;
  const isbn = normalizeIsbn(input.isbn13) || normalizeIsbn(input.isbn10);

  if (isbn) {
    const key = `isbn:${isbn}`;
    if (!memo || !memo.has(key)) {
      const result = await byIsbn(isbn, input, options);
      if (result) return result;
      if (memo) memo.set(key, true);
    }
  }

  if (input.title) {
    const key = `title:${normalizeTitle(input.title)}|${surnameOf((input.authors || [])[0] || '')}`;
    if (memo && memo.has(key)) return null;
    const result = await byTitle(input, options);
    if (result) return result;
    if (memo) memo.set(key, true);
  }
  return null;
}

module.exports = {
  NAME,
  getWork,
  normalizeEdition,
  normalizeSearchDoc,
  subjectsOf,
  pageUrlOf,
  sourceIdOf,
};
