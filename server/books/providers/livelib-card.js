'use strict';

const cheerio = require('cheerio');

const livelib = require('../livelib');
const { createSourceClient, defaultSleep } = require('./http');
const sources = require('../../core/sources');
const { detectManga, collectMangaTexts } = require('./manga');
const { seriesEntryOf } = require('./series-name');
const { cleanText, normalizeIsbn, isbn10Of } = require('../normalize');

const NAME = 'livelib-card';
const DEFAULT_PAUSE_MS = sources.SOURCES.livelib.cardPauseMs;
const source = createSourceClient({
  name: NAME,
  source: 'livelib',
  budgetEnv: 'BOOKS_LIVELIB_CARD_BUDGET',
});
const DEFAULT_BUDGET = source.budgetLimit;
const BLOCK_BREAKER_MS = source.breakerMs;
const { isBreakerOpen, tripBreaker, resetBreaker, createBudget, budgetFromEnv } = source;

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
  const genreValues = $(
    'section[class*="ShortInfoGenres"] a[href*="/genre/"], td.genre-card, .genre-card'
  )
    .map((_, element) => cleanText($(element).text()))
    .get()
    .filter(Boolean);
  const genres = [...new Set(genreValues)];
  const rawSeriesName = rows['Серия'] || null;
  const series = seriesEntryOf(rawSeriesName);
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
    series: series ? { name: series.name, position: series.position } : null,
    seriesAll: series ? [series] : [],
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
    mangaComics: detectManga({ genres, series: rawSeriesName ? [rawSeriesName] : [], publisher }),
    mangaTexts: collectMangaTexts({ genres, series: rawSeriesName ? [rawSeriesName] : [], publisher }),
  };
}

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
        jar: options.jar,
        fetchImpl: options.fetchImpl,
      },
      `card ${bookId}`
    );
  } catch (err) {
    if (err && (err.code === 'livelib_blocked' || err.code === 'livelib_http_error')) {
      tripBreaker();
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
