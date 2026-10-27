'use strict';

/**
 * LiveLib card provider — the last, most precise source for Russian editions.
 *
 * The bulk LiveLib pass has no genres/ISBN for every row; the public
 * `/book/{llBookId}` HTML does: `DetailedInfo` rows (ISBN, publisher, year,
 * series, pages, language), a `ShortInfoGenres` block and a JSON-LD `Book`.
 *
 * Politeness: one request per book, 2 s pause, hard per-run budget
 * (`BOOKS_LIVELIB_CARD_BUDGET`, default 300). The budget is NOT persisted: the
 * next run gets a fresh allowance, so a large profile is enriched over several
 * runs without hammering the site in one go.
 */

const cheerio = require('cheerio');

const livelib = require('../livelib');
const { detectManga } = require('./manga');
const { cleanText, normalizeIsbn, isbn10Of } = require('../normalize');

const NAME = 'livelib-card';
const DEFAULT_PAUSE_MS = 2000;
const DEFAULT_BUDGET = 300;
const BLOCK_BREAKER_MS = 30 * 60 * 1000;

let blockedUntil = 0;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isBreakerOpen(now = Date.now()) {
  return now < blockedUntil;
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
  return createBudget(process.env.BOOKS_LIVELIB_CARD_BUDGET);
}

function readDetailRows($) {
  const rows = {};
  $('div[class*="DetailedInfoRow"]').each((_, element) => {
    const text = cleanText($(element).text());
    const match = /^([^:]{2,40}):\s*(.+)$/.exec(text);
    if (!match) return;
    const label = match[1].trim();
    if (!(label in rows)) rows[label] = match[2].trim();
  });
  return rows;
}

function readJsonLd($) {
  const blocks = $('script[type="application/ld+json"]')
    .map((_, element) => $(element).text())
    .get();
  for (const block of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(block);
    } catch (err) {
      continue;
    }
    const graph = Array.isArray(parsed && parsed['@graph']) ? parsed['@graph'] : [parsed];
    const book = graph.find((node) => node && node['@type'] === 'Book');
    if (book) return book;
  }
  return null;
}

function authorNamesOf(book) {
  if (!book || !book.author) return [];
  const list = Array.isArray(book.author) ? book.author : [book.author];
  const names = [];
  for (const entry of list) {
    const name = typeof entry === 'string' ? entry : entry && entry.name;
    if (typeof name === 'string' && name.trim() && !names.includes(name.trim())) {
      names.push(name.trim());
    }
  }
  return names;
}

function yearOf(value) {
  const match = /(\d{4})/.exec(String(value || ''));
  return match ? Number(match[1]) : null;
}

function coverOf($, book, input) {
  if (book && book.image) {
    const value = Array.isArray(book.image) ? book.image[0] : book.image;
    const url = typeof value === 'string' ? value : value && value.url;
    if (url) return String(url).replace(/^http:\/\//, 'https://');
  }
  const img = $('img[src*="boocover"]').first().attr('src');
  if (img) return String(img).replace(/^http:\/\//, 'https://');
  return (input && input.coverUrl) || null;
}

function parseCardHtml(html, input = {}) {
  const $ = cheerio.load(String(html || ''));
  const rows = readDetailRows($);
  const book = readJsonLd($);
  const genreValues = $('section[class*="ShortInfoGenres"] a[href*="/genre/"]')
    .map((_, element) => cleanText($(element).text()))
    .get()
    .filter(Boolean);
  const genres = [...new Set(genreValues)];
  const seriesName = rows['Серия'] || null;
  const publisher = rows['Издательство'] || null;
  const isbnRaw = rows.ISBN || (book && book.isbn) || null;
  const isbn13 = normalizeIsbn(isbnRaw);
  const isbn10 = isbn13 ? isbn10Of(isbn13) : null;
  const bookId = input.llBookId || input.sourceBookId || null;
  const canonical = $('link[rel="canonical"]').attr('href') || null;
  const title =
    (book && typeof book.name === 'string' && book.name.trim()) ||
    cleanText($('h1').first().text()) ||
    input.title ||
    null;
  const authors = authorNamesOf(book);
  const year = yearOf(rows['Год издания'] || (book && book.datePublished) || input.year);
  const pagesText = rows['Страниц'] || (book && book.numberOfPages);
  const pagesMatch = /(\d+)/.exec(String(pagesText || ''));
  const pages = pagesMatch ? Number(pagesMatch[1]) : null;

  return {
    source: NAME,
    sourceId: bookId ? String(bookId) : null,
    workId: bookId ? `ll:${bookId}` : null,
    title,
    authors: authors.length ? authors : (input.authors || []).filter(Boolean),
    year,
    publisher,
    series: seriesName ? { name: seriesName, position: null } : null,
    genres,
    pages,
    isbn13,
    isbn10,
    cover: coverOf($, book, input),
    links: {
      pageUrl: canonical || (bookId ? `${livelib.LIVELIB_ORIGIN}/book/${bookId}` : null),
    },
    language: rows['Язык'] || (book && book.inLanguage) || null,
    confidence: 1,
    match: { method: 'card', titleSim: 1, exact: true, authorHit: true },
    mangaComics: detectManga({ genres, series: seriesName ? [seriesName] : [], publisher }),
  };
}

/**
 * @param {{llBookId?:string, sourceBookId?:string, title?:string,
 *          authors?:string[], year?:number, coverUrl?:string}} input
 */
async function getWork(input = {}, options = {}) {
  const bookId = input.llBookId || input.sourceBookId;
  if (!bookId) return null;
  if (isBreakerOpen()) return null;
  const budget = options.budget || null;
  if (budget && typeof budget.take === 'function' && !budget.take()) return null;

  const sleep = options.sleep || defaultSleep;
  const pause = options.cardPauseMs == null ? DEFAULT_PAUSE_MS : Number(options.cardPauseMs);
  if (pause > 0) await sleep(pause);

  const url = `${livelib.LIVELIB_ORIGIN}/book/${encodeURIComponent(bookId)}`;
  let response;
  try {
    response = await livelib.request(
      url,
      {
        headers: { accept: 'text/html', 'User-Agent': livelib.USER_AGENT },
        fetchImpl: options.fetchImpl,
      },
      `card ${bookId}`
    );
  } catch (err) {
    // DDoS-Guard answers 403 the same way as a real rate limit: stop the whole
    // run instead of retrying 900+ cards against a blocked IP.
    if (err && (err.code === 'livelib_blocked' || err.code === 'livelib_http_error')) {
      blockedUntil = Date.now() + BLOCK_BREAKER_MS;
    }
    throw err;
  }
  return parseCardHtml(response.text, { ...input, llBookId: String(bookId) });
}

module.exports = {
  NAME,
  DEFAULT_BUDGET,
  DEFAULT_PAUSE_MS,
  BLOCK_BREAKER_MS,
  createBudget,
  budgetFromEnv,
  parseCardHtml,
  readDetailRows,
  readJsonLd,
  getWork,
  isBreakerOpen,
  resetBreaker,
};
