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

const LITRES_ITEM = {
  id: 8981462,
  title: 'Игрок',
  url: '/book/fedor-dostoevskiy/igrok-8981462/',
  cover_url: '/pub/c/cover/8981462.jpg',
  language_code: 'ru',
  date_written_at: '2014-01-01',
  persons: [{ full_name: 'Фёдор Достоевский', role: 'author' }],
  series: [{ name: 'Русская классика', art_order: 1 }],
};

const LITRES_DETAIL = {
  id: 8981462,
  title: 'Игрок',
  isbn: '978-5-699-78049-5',
  publisher: 'АСТ',
  publication_date: '2014-01-01',
  genres: [{ name: 'классическая литература' }],
  tags: [{ name: 'роман' }],
  series: [{ name: 'Русская классика', art_order: 1 }],
  paper_book: { pages: 256 },
  cover_url: '/pub/c/cover/8981462.jpg',
  url: '/book/fedor-dostoevskiy/igrok-8981462/',
};

function litresRoutes(item = LITRES_ITEM, detail = LITRES_DETAIL) {
  return [
    [
      'api.litres.ru/foundation/api/search',
      () =>
        response({
          body: { payload: { data: [{ type: 'text_book', instance: item }] } },
        }),
    ],
    [
      'api.litres.ru/foundation/api/arts/',
      () => response({ body: { payload: { data: detail } } }),
    ],
  ];
}

test('RU title goes to litres first and its ISBN closes a Hardcover work', async () => {
  const fetchImpl = router([
    ...litresRoutes(),
    ['www.googleapis.com/books', () => response({ body: { items: [] } })],
    ['openlibrary.org', () => response({ body: {} })],
    ['www.livelib.ru/book/', () => response({ body: cardHtml({ bookId: '4001' }) })],
  ]);
  const lookup = lookupStub([
    hcEntry({
      hcWorkId: 900,
      isbn13: '9785699780495',
      title: 'Игрок',
      authors: ['Фёдор Достоевский'],
      genres: ['Classics'],
      pages: 320,
      publisher: 'АСТ',
      year: 2014,
      slug: 'igrok',
    }),
  ]);
  const report = await resolve.resolveProfile(
    profile([event('4001', { title: 'Игрок', authors: ['Фёдор Достоевский'], isbn: null })]),
    {
      providers: ['hardcover', 'litres', 'googlebooks', 'openlibrary', 'livelib-card'],
      lookupIsbns: lookup,
      fetchImpl,
      sleep: noSleep,
      requestDelayMs: 0,
      litresPauseMs: 0,
      cardPauseMs: 0,
    }
  );

  assert.equal(report.resolvedHardcoverFromLitres, 1);
  assert.equal(report.resolvedLitres, 0);
  assert.equal(report.litresBudget.used, 1);
  assert.equal(fetchImpl.calls.filter((url) => url.includes('litres')).length, 2);
  assert.equal(fetchImpl.calls.filter((url) => url.includes('googleapis')).length, 0);
  assert.equal(fetchImpl.calls.filter((url) => url.includes('openlibrary')).length, 0);
  assert.equal(fetchImpl.calls.filter((url) => url.includes('livelib')).length, 0);

  const link = bookCache.getLink('4001');
  assert.equal(link.workId, 'hc:900');
  assert.equal(link.method, 'isbn');
  const details = bookCache.getWorkDetails('hc:900');
  assert.deepEqual(details.metadataSources.sort(), ['hardcover', 'litres'].sort());
  assert.equal(details.sources.length, 2);
  assert.equal(details.sources.find((entry) => entry.source === 'litres').url.includes('/book/'), true);
});

test('RU title without a Hardcover match becomes a litres work', async () => {
  const item = {
    ...LITRES_ITEM,
    id: 515151,
    title: 'Преступление и наказание',
    url: '/book/fedor-dostoevskiy/prestuplenie-515151/',
  };
  const detail = {
    ...LITRES_DETAIL,
    id: 515151,
    title: 'Преступление и наказание',
    isbn: '978-5-17-090155-0',
    series: [{ name: 'Русская классика', art_order: 2 }],
    url: '/book/fedor-dostoevskiy/prestuplenie-515151/',
  };
  const fetchImpl = router([
    ...litresRoutes(item, detail),
    ['www.googleapis.com/books', () => response({ body: { items: [] } })],
    ['openlibrary.org', () => response({ body: {} })],
  ]);
  const report = await resolve.resolveProfile(
    profile([
      event('4002', {
        title: 'Преступление и наказание',
        authors: ['Фёдор Достоевский'],
        isbn: null,
      }),
    ]),
    {
      providers: ['litres', 'googlebooks', 'openlibrary'],
      lookupIsbns: lookupStub([]),
      fetchImpl,
      sleep: noSleep,
      requestDelayMs: 0,
      litresPauseMs: 0,
    }
  );

  assert.equal(report.resolvedLitres, 1);
  assert.equal(report.resolved, 1);
  assert.equal(report.unmatched, 0);

  const link = bookCache.getLink('4002');
  assert.equal(link.workId, 'lr:515151');
  assert.equal(link.method, 'litres-title');

  const details = bookCache.getWorkDetails('lr:515151');
  assert.equal(details.schemaVersion, 2);
  assert.equal(details.isbn13, '9785170901550');
  assert.equal(details.pages, 256);
  assert.deepEqual(details.genres, ['классическая литература']);
  assert.deepEqual(details.metadataSources, ['litres']);
  assert.equal(details.sources[0].source, 'litres');
});

test('Latin titles never call litres', async () => {
  const fetchImpl = router([
    ...litresRoutes(),
    ['www.googleapis.com/books', () => response({ body: { items: [] } })],
    ['openlibrary.org', () => response({ body: {} })],
  ]);
  await resolve.resolveProfile(
    profile([event('4003', { title: 'Dune', authors: ['Frank Herbert'], isbn: null })]),
    {
      providers: ['litres', 'googlebooks', 'openlibrary'],
      lookupIsbns: lookupStub([]),
      fetchImpl,
      sleep: noSleep,
      requestDelayMs: 0,
      litresPauseMs: 0,
    }
  );
  assert.equal(fetchImpl.calls.filter((url) => url.includes('litres')).length, 0);
});

test('litres breaker stops the rest of the RU batch', async () => {
  let litresCalls = 0;
  const fetchImpl = router([
    [
      'api.litres.ru/foundation/api/search',
      () => {
        litresCalls++;
        return response({ status: 403, body: '<html>blocked</html>' });
      },
    ],
  ]);
  const report = await resolve.resolveProfile(
    profile([
      event('4004', { title: 'Бесы', authors: ['Фёдор Достоевский'], isbn: null }),
      event('4005', { title: 'Подросток', authors: ['Фёдор Достоевский'], isbn: null }),
    ]),
    {
      providers: ['litres'],
      lookupIsbns: lookupStub([]),
      fetchImpl,
      sleep: noSleep,
      requestDelayMs: 0,
      litresPauseMs: 0,
    }
  );
  assert.equal(litresCalls, 1);
  assert.equal(report.providerChain.litres.errors, 1);
  assert.equal(report.providerChain.litres.skipped, 1);
  assert.equal(report.litresBudget.used, 1);
  assert.equal(report.unmatched, 2);
});
