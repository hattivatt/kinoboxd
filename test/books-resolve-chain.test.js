'use strict';

/**
 * resolve v2 provider chain: Hardcover bulk -> Google Books -> Open Library ->
 * LiveLib card, card-ISBN back into Hardcover, metadata-only card enrichment,
 * per-run card budget and in-run negative memo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-chain-'));

const bookCache = require('../server/books/book-cache');
const resolve = require('../server/books/resolve');
const livelibCard = require('../server/books/providers/livelib-card');

const noSleep = async () => {};

function response({ status = 200, body = {} }) {
  return {
    status,
    headers: { get: () => null },
    async json() {
      return typeof body === 'string' ? JSON.parse(body) : body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function cardHtml(overrides = {}) {
  const isbn = overrides.isbn === undefined ? '978-5-699-98967-6' : overrides.isbn;
  const genres = overrides.genres || ['Научная фантастика'];
  return `<!doctype html><html><head>
    <link rel="canonical" href="https://www.livelib.ru/book/${overrides.bookId || 1}"/>
    <script type="application/ld+json">${JSON.stringify({
      '@type': 'Book',
      name: overrides.title || 'Аннигиляция',
      author: { name: overrides.author || 'Джефф Вандермеер' },
    })}</script>
  </head><body><h1>${overrides.title || 'Аннигиляция'}</h1>
    <div class="DetailedInfo_DetailedInfoRow__x"><p>Издательство: </p><p>${
      overrides.publisher || 'Эксмо'
    }</p></div>
    <div class="DetailedInfo_DetailedInfoRow__x"><p>ISBN: </p><p>${isbn}</p></div>
    <div class="DetailedInfo_DetailedInfoRow__x"><p>Год издания: </p><p>2018</p></div>
    <div class="DetailedInfo_DetailedInfoRow__x"><p>Страниц: 256</p></div>
    <section class="ShortInfo_ShortInfoGenres__x">${genres
      .map((genre) => `<a href="https://www.livelib.ru/genre/${genre}">${genre}</a>`)
      .join('')}</section>
  </body></html>`;
}

function router(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    const text = String(url);
    calls.push(text);
    for (const [match, handler] of routes) {
      if (text.includes(match)) return handler(text);
    }
    return response({ body: {} });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function gbItem(id, overrides = {}) {
  return {
    id,
    volumeInfo: {
      title: overrides.title || 'Дюна',
      authors: overrides.authors || ['Фрэнк Герберт'],
      publisher: overrides.publisher || 'АСТ',
      publishedDate: overrides.publishedDate || '2016',
      categories: overrides.categories || ['Science Fiction'],
      pageCount: overrides.pageCount == null ? 704 : overrides.pageCount,
      industryIdentifiers: [
        { type: 'ISBN_13', identifier: overrides.isbn13 || '9785170987654' },
      ],
      imageLinks: { thumbnail: 'https://example.test/cover.jpg' },
      infoLink: `https://books.google.com/books?id=${id}`,
    },
  };
}

function hcEntry({ hcWorkId, isbn13, title, authors, genres = [], pages = null, publisher = null, year = null, slug = null }) {
  const details = {
    schemaVersion: 1,
    hcWorkId,
    title,
    slug,
    authors: authors.map((name, index) => ({ hcId: index + 1, name })),
    genres,
    series: [],
    pages,
    publicationYear: year,
    publisher,
    isbn13,
    isbn10: null,
    coverUrl: null,
    ratingsCount: 100,
    partial: false,
  };
  return { details, editionId: hcWorkId * 10 };
}

function lookupStub(entries) {
  const byIsbn = new Map();
  const works = new Map();
  for (const entry of entries) {
    byIsbn.set(resolve.normalizeIsbn(entry.details.isbn13), entry);
    works.set(entry.details.hcWorkId, entry.details);
  }
  return async () => ({ byIsbn, works, queries: [], requests: 1 });
}

function profile(events) {
  return {
    schemaVersion: 1,
    source: 'livelib',
    userKey: 'tester',
    importedAt: '2026-10-27T00:00:00.000Z',
    events,
  };
}

function event(bookId, overrides = {}) {
  return {
    id: `ll:${bookId}`,
    source: 'livelib',
    sourceBookId: String(bookId),
    title: overrides.title || 'Дюна',
    authors: overrides.authors || ['Фрэнк Герберт'],
    rating: 9,
    ratingScale: 10,
    rating10: 9,
    edition: { isbn: overrides.isbn === undefined ? null : overrides.isbn, year: 2016 },
  };
}

test('ISBN match falls through Hardcover to Google Books and caches details', async () => {
  const fetchImpl = router([
    ['www.googleapis.com/books', () => response({ body: { items: [gbItem('vol-dune-ru')] } })],
    ['openlibrary.org', () => response({ body: {} })],
  ]);
  const report = await resolve.resolveProfile(
    profile([event('1001', { isbn: '9785170987654' })]),
    {
      providers: ['googlebooks', 'openlibrary'],
      lookupIsbns: lookupStub([]),
      fetchImpl,
      sleep: noSleep,
      requestDelayMs: 0,
      now: '2026-10-27T00:00:00.000Z',
    }
  );

  assert.equal(report.resolvedGoogle, 1);
  assert.equal(report.resolved, 1);
  assert.equal(report.unmatched, 0);
  assert.equal(report.methods['googlebooks-isbn'], 1);
  assert.equal(report.providerChain.googlebooks.hits, 1);

  const link = bookCache.getLink('1001');
  assert.equal(link.workId, 'gb:vol-dune-ru');
  assert.equal(link.method, 'googlebooks-isbn');
  assert.equal(bookCache.getIndexEntry('ll:1001'), 'gb:vol-dune-ru');

  const details = bookCache.getWorkDetails('gb:vol-dune-ru');
  assert.ok(details);
  assert.equal(details.schemaVersion, 2);
  assert.deepEqual(details.metadataSources, ['googlebooks']);
  assert.equal(details.pages, 704);
  assert.equal(details.publicationYear, 2016);
});

test('LiveLib card supplies the ISBN, then Hardcover resolves and fields merge', async () => {
  const fetchImpl = router([
    ['www.livelib.ru/book/', () => response({ body: cardHtml({ bookId: '1002' }) })],
    ['www.googleapis.com/books', () => response({ body: { items: [] } })],
    ['openlibrary.org', () => response({ body: {} })],
  ]);
  const lookup = lookupStub([
    hcEntry({
      hcWorkId: 777,
      isbn13: '9785699989676',
      title: 'Аннигиляция',
      authors: ['Джефф Вандермеер'],
      genres: ['Science Fiction'],
      pages: 320,
      publisher: 'Эксмо',
      year: 2018,
      slug: 'annihilation',
    }),
  ]);
  const report = await resolve.resolveProfile(
    profile([event('1002', { title: 'Аннигиляция', authors: ['Джефф Вандермеер'], isbn: null })]),
    {
      providers: ['hardcover', 'googlebooks', 'openlibrary', 'livelib-card'],
      lookupIsbns: lookup,
      fetchImpl,
      sleep: noSleep,
      requestDelayMs: 0,
      cardPauseMs: 0,
      now: '2026-10-27T00:00:00.000Z',
    }
  );

  assert.equal(report.resolvedHardcoverCard, 1);
  assert.equal(report.cardBudget.used, 1);
  assert.equal(report.unmatched, 0);

  const link = bookCache.getLink('1002');
  assert.equal(link.workId, 'hc:777');
  assert.equal(link.method, 'isbn');

  const details = bookCache.getWorkDetails('hc:777');
  assert.equal(details.schemaVersion, 2);
  assert.equal(details.pages, 320);
  assert.equal(details.publisher, 'Эксмо');
  assert.deepEqual(details.metadataSources, ['hardcover', 'livelib-card']);
  assert.equal(details.sources.length, 2);
  assert.equal(details.sources.find((entry) => entry.source === 'livelib-card').url.includes('/book/1002'), true);
});

test('card-only book keeps its LiveLib work id but gets cache metadata', async () => {
  const fetchImpl = router([
    ['www.livelib.ru/book/', () => response({ body: cardHtml({ bookId: '1003', title: 'Пикник на обочине', author: 'Аркадий Стругацкий', genres: ['Фантастика'] }) })],
    ['www.googleapis.com/books', () => response({ body: { items: [] } })],
    ['openlibrary.org', () => response({ body: {} })],
  ]);
  const report = await resolve.resolveProfile(
    profile([event('1003', { title: 'Пикник на обочине', authors: ['Аркадий Стругацкий'] })]),
    {
      providers: ['livelib-card', 'googlebooks', 'openlibrary'],
      lookupIsbns: lookupStub([]),
      fetchImpl,
      sleep: noSleep,
      requestDelayMs: 0,
      cardPauseMs: 0,
      cardBudget: livelibCard.createBudget(10),
      now: '2026-10-27T00:00:00.000Z',
    }
  );

  assert.equal(report.enriched, 1);
  assert.equal(report.resolvedLivelibCard, 1);
  assert.equal(report.resolved, 0);
  assert.equal(report.withMetadata, 1);
  assert.equal(report.unmatched, 0);
  assert.equal(bookCache.getLink('1003'), null);

  const details = bookCache.getWorkDetails('ll:1003');
  assert.ok(details);
  assert.equal(details.workId, 'll:1003');
  assert.deepEqual(details.metadataSources, ['livelib-card']);
  assert.deepEqual(details.genres, ['Фантастика']);
  assert.equal(details.pages, 256);
});

test('saved card metadata is reused without another LiveLib request', async () => {
  const fetchImpl = router([
    ['www.livelib.ru/book/', () => response({ body: cardHtml({ bookId: '1003' }) })],
  ]);
  const report = await resolve.resolveProfile(
    profile([event('1003', { title: 'Пикник на обочине', authors: ['Аркадий Стругацкий'] })]),
    {
      providers: ['livelib-card'],
      lookupIsbns: lookupStub([]),
      fetchImpl,
      sleep: noSleep,
      requestDelayMs: 0,
      cardPauseMs: 0,
    }
  );
  assert.equal(fetchImpl.calls.filter((url) => url.includes('www.livelib.ru')).length, 0);
  assert.equal(report.enriched, 1);
  assert.equal(report.unmatched, 0);
  assert.equal(report.cardBudget.used, 0);
});

test('card budget caps requests per run and leaves the rest unresolved', async () => {
  const fetchImpl = router([
    ['www.livelib.ru/book/', () => response({ body: cardHtml({ bookId: '9' }) })],
    ['www.googleapis.com/books', () => response({ body: { items: [] } })],
    ['openlibrary.org', () => response({ body: {} })],
  ]);
  const budget = livelibCard.createBudget(1);
  const report = await resolve.resolveProfile(
    profile([
      event('2001', { title: 'Книга 1', authors: ['Автор Один'] }),
      event('2002', { title: 'Книга 2', authors: ['Автор Два'] }),
      event('2003', { title: 'Книга 3', authors: ['Автор Три'] }),
    ]),
    {
      providers: ['livelib-card'],
      lookupIsbns: lookupStub([]),
      fetchImpl,
      sleep: noSleep,
      requestDelayMs: 0,
      cardPauseMs: 0,
      cardBudget: budget,
    }
  );

  const cardCalls = fetchImpl.calls.filter((url) => url.includes('www.livelib.ru/book/'));
  assert.equal(cardCalls.length, 1);
  assert.equal(report.cardBudget.used, 1);
  assert.equal(report.cardBudget.limit, 1);
  assert.equal(report.enriched, 1);
  assert.equal(report.unmatched, 2);
});

test('in-run negative memo prevents duplicate Google Books requests', async () => {
  const fetchImpl = router([
    ['www.googleapis.com/books', () => response({ body: { items: [] } })],
    ['openlibrary.org', () => response({ body: {} })],
  ]);
  const report = await resolve.resolveProfile(
    profile([
      event('3001', { title: 'Одна', authors: ['Автор'], isbn: '9780000000001' }),
      event('3002', { title: 'Одна', authors: ['Автор'], isbn: '9780000000001' }),
    ]),
    {
      providers: ['googlebooks', 'openlibrary'],
      lookupIsbns: lookupStub([]),
      fetchImpl,
      sleep: noSleep,
      requestDelayMs: 0,
    }
  );

  const gbCalls = fetchImpl.calls.filter((url) => url.includes('www.googleapis.com/books'));
  assert.equal(gbCalls.length, 2);
  assert.equal(report.resolved, 0);
  assert.equal(report.unmatched, 2);
});
