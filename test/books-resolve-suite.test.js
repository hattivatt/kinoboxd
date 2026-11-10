'use strict';

/**
 * Books: resolve chain and scheduled pass suite: the former standalone `*.test.js` files of this domain,
 * merged into one process (R19 test-suite consolidation).
 *
 * Each block below is its original file, kept verbatim inside its own
 * `describe()`:
 *
 *   - the describe title is the file stem, so every test stays greppable as
 *     `<file> > <original title>`;
 *   - the block scope keeps a file's helper names from colliding with its
 *     neighbours;
 *   - the hooks a file declared (`test.before`/`test.after`/
 *     `test.beforeEach`) stay scoped to that block instead of applying to the
 *     whole process.
 *
 * The tmp root is one `helpers/env` run for the whole suite, created BEFORE
 * any `server/**` require (every cache namespace reads its root once, at load
 * time). A file's own tmp setup folds into that root — the module singletons
 * are process-wide anyway, so a second root would only desynchronise a file
 * from the directory its assertions read. Tests keep apart by `userKey`/work
 * key, never by root.
 *
 * `env.cleanupTmpDirs()` removes every directory this run created.
 */

const { describe, after, before } = require('node:test');
const env = require('./helpers/env');

const run = env.makeTmpCache('books-resolve-suite', { budgets: false });

after(() => {
  env.cleanupTmpDirs();
});

process.on('exit', () => {
  env.cleanupTmpDirs();
});


describe('books-resolve-chain', () => {
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

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;
  process.env.GB_API_KEY = 'AIzaSy_TEST_FIXTURE_KEY';

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
    // A litres hit that already has ISBN + year + pages must not spend the
    // Google Books budget on enrichment: that budget belongs to the tail.
    assert.equal(fetchImpl.calls.filter((url) => url.includes('googleapis')).length, 0);
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
  after(() => env.resetMutableState());
});


describe('books-scheduled-resolve', () => {
  /**
   * Scheduled resolve (kinoboxd-resolve-books): candidate pool, per-candidate
   * negative state, keying of file-only rows, budget and the cross-process lock.
   *
   * The real CLI is exercised through `resolveOneProfile`/`runScheduledResolve`
   * with injected providers, so no test ever touches litres.ru, Hardcover or
   * LiveLib.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;
  process.env.GB_API_KEY = 'AIzaSy_TEST_FIXTURE_KEY';

  const bookCache = require('../server/books/book-cache');
  const resolve = require('../server/books/resolve');
  const scheduled = require('../server/books/scheduled-resolve');
  const resolveLock = require('../server/books/resolve-lock');
  const { buildBooksStats } = require('../server/books/stats');

  const DAY = 24 * 60 * 60 * 1000;

  function fileEvent(fileKey, title, extra = {}) {
    return {
      id: `llfile:${fileKey}:read`,
      fileKey,
      source: 'livelib-file',
      origin: 'livelib-file',
      title,
      authors: ['Автор'],
      rating: 4,
      ratingScale: 5,
      rating10: 8,
      status: 'read',
      shelf: 'read',
      finishedAt: '2024-01-02',
      edition: { isbn: null, isbn13: null, isbn10: null, year: null },
      genres: [],
      ...extra,
    };
  }

  function profile(userKey, events) {
    return {
      schemaVersion: 1,
      source: 'livelib',
      userKey,
      importedAt: '2026-10-28T00:00:00.000Z',
      events,
      warnings: [],
    };
  }

  /** Provider that records calls and always answers "nothing". */
  function missProvider(name = 'googlebooks') {
    const calls = [];
    return {
      NAME: name,
      calls,
      getWork: async (input) => {
        calls.push(input.eventKey || input.llBookId || null);
        return null;
      },
    };
  }

  function statsFor(keys) {
    const booksIndex = {};
    for (const key of keys) booksIndex[`ll:${key}`] = { workId: `ll:${key}`, unresolved: true };
    return { booksIndex };
  }

  test('file-only rows are keyed by file:<fileKey> in attempted/unmatched', async () => {
    const data = profile('FileKey', [fileEvent('tk:abc123', 'Неизвестная книга')]);
    const miss = missProvider('googlebooks');
    const report = await resolve.resolveProfile(data, {
      providers: [miss],
      allowLivelibCard: false,
      litresBudget: { limit: 0, used: 0, remaining: 0, take: () => false },
    });
    assert.deepEqual(report.attemptedKeys, ['file:tk:abc123']);
    assert.deepEqual(report.unmatchedKeys, ['file:tk:abc123']);
    assert.deepEqual(report.missedByKey, { 'file:tk:abc123': ['googlebooks'] });
    assert.deepEqual(miss.calls, ['file:tk:abc123']);
  });

  test('a provider miss is remembered and not re-asked inside the window', async () => {
    const data = profile('Window', [
      fileEvent('tk:one', 'Первая книга'),
      fileEvent('tk:two', 'Вторая книга'),
    ]);
    const stats = statsFor(['file:tk:one', 'file:tk:two']);
    const now = Date.parse('2026-10-29T12:00:00.000Z');

    const first = missProvider('googlebooks');
    const run1 = await scheduled.resolveOneProfile(data, {
      stats,
      providers: [first],
      limit: 1,
      now,
      nowIso: new Date(now).toISOString(),
      litresBudget: { limit: 0, used: 0, remaining: 0, take: () => false },
    });
    assert.equal(run1.selected, 1);
    assert.equal(run1.misses, 1);
    assert.deepEqual(first.calls, ['file:tk:one']);
    const state = scheduled.loadCandidateState('livelib', 'Window');
    assert.equal(state.candidates['file:tk:one'].outcome, 'miss');
    assert.equal(state.candidates['file:tk:one'].askedAt, new Date(now).toISOString());

    // Next hour: the first row is inside the 90-day window, only the second is
    // selected; the provider must not see the missed key again.
    const second = missProvider('googlebooks');
    const run2 = await scheduled.resolveOneProfile(data, {
      stats,
      providers: [second],
      limit: 5,
      now: now + 60 * 60 * 1000,
      nowIso: new Date(now + 60 * 60 * 1000).toISOString(),
      litresBudget: { limit: 0, used: 0, remaining: 0, take: () => false },
    });
    assert.equal(run2.selected, 1);
    assert.deepEqual(second.calls, ['file:tk:two']);
    assert.equal(run2.activeRemaining, 0);

    // After the window (default 90 days) both are candidates again.
    const third = missProvider('googlebooks');
    const run3 = await scheduled.resolveOneProfile(data, {
      stats,
      providers: [third],
      limit: 5,
      now: now + 91 * DAY,
      nowIso: new Date(now + 91 * DAY).toISOString(),
      litresBudget: { limit: 0, used: 0, remaining: 0, take: () => false },
    });
    assert.equal(run3.selected, 2);
    assert.deepEqual(third.calls.sort(), ['file:tk:one', 'file:tk:two']);

    // `--force` ignores the negative cache entirely.
    const forced = missProvider('googlebooks');
    await scheduled.resolveOneProfile(data, {
      stats,
      providers: [forced],
      limit: 5,
      force: true,
      now: now + 92 * DAY,
      nowIso: new Date(now + 92 * DAY).toISOString(),
      litresBudget: { limit: 0, used: 0, remaining: 0, take: () => false },
    });
    assert.equal(forced.calls.length, 2);
  });

  test('a budget-starved provider is a deferral, not a negative verdict', async () => {
    const data = profile('Budget', [fileEvent('tk:budget', 'Неизвестная книга')]);
    const stats = statsFor(['file:tk:budget']);
    const calls = [];
    const starved = {
      NAME: 'litres',
      // Mirrors the real provider: `take()` fails before any request.
      getWork: async (input, options) => {
        if (options.budget && typeof options.budget.take === 'function' && !options.budget.take()) {
          return null;
        }
        calls.push(input.eventKey);
        return null;
      },
    };
    const run = await scheduled.resolveOneProfile(data, {
      stats,
      providers: [starved],
      limit: 5,
      now: Date.parse('2026-10-29T12:00:00.000Z'),
      nowIso: '2026-10-29T12:00:00.000Z',
      litresBudget: { limit: 0, used: 0, remaining: 0, take: () => false },
    });
    assert.equal(run.selected, 1);
    assert.equal(run.misses, 0);
    assert.equal(run.deferred, 1);
    assert.equal(calls.length, 0);
    const state = scheduled.loadCandidateState('livelib', 'Budget');
    assert.deepEqual(state.candidates, {});
  });

  test('empty pool exits without provider calls', async () => {
    const data = profile('Linked', [fileEvent('tk:linked', 'Уже привязана')]);
    await bookCache.saveLink('file:tk:linked', {
      schemaVersion: 1,
      livelibBookId: 'file:tk:linked',
      workId: 'hc:999',
      method: 'isbn',
      score: 1,
      evidence: {},
    });
    const miss = missProvider('googlebooks');
    const run = await scheduled.resolveOneProfile(data, {
      stats: statsFor(['file:tk:linked']),
      providers: [miss],
      limit: 5,
    });
    assert.equal(run.pool, 0);
    assert.equal(run.selected, 0);
    assert.equal(miss.calls.length, 0);
    assert.equal(run.reason, 'pool-empty');
  });

  test('the resolve lock is shared with an in-process/import pass', async () => {
    const data = profile('Locked', [fileEvent('tk:lock', 'Книга под замком')]);
    await bookCache.saveProfile('livelib', 'Locked', data);
    const stats = statsFor(['file:tk:lock']);
    const held = await resolveLock.acquireLock({ owner: 'test-import' });
    assert.equal(held.ok, true);
    try {
      const miss = missProvider('googlebooks');
      const summary = await scheduled.runScheduledResolve({
        profile: 'livelib-Locked',
        statsFor: () => stats,
        providers: [miss],
        limit: 5,
        lockWaitMs: 0,
      });
      assert.deepEqual(summary.skippedProfiles, ['Locked']);
      assert.equal(miss.calls.length, 0);
      assert.equal(summary.requests, 0);
    } finally {
      resolveLock.releaseLock(held.token);
    }
    // The same lock is released properly: the next pass can run.
    assert.equal(resolveLock.isLocked(), false);
  });

  test('scheduled pass links a candidate and updates the honest badge counters', async () => {
    const data = profile('Links', [
      fileEvent('tk:linkme', 'Книга с жанром', { genres: ['Фантастика'] }),
    ]);
    await bookCache.saveProfile('livelib', 'Links', data);
    const stats = statsFor(['file:tk:linkme']);
    const hit = {
      NAME: 'googlebooks',
      calls: 0,
      getWork: async (input) => {
        hit.calls++;
        return {
          source: 'googlebooks',
          sourceId: 'gb-1',
          workId: 'gb:gb-1',
          title: input.title,
          authors: input.authors,
          genres: ['Science Fiction'],
          confidence: 1,
          match: { method: 'title' },
        };
      },
    };
    const before = buildBooksStats({ profile: 'livelib-Links' });
    assert.equal(before.summary.metadata.resolved, 0);
    assert.equal(before.summary.metadata.unlinked, 1);
    assert.equal(before.summary.metadata.percent, 0);
    assert.equal(before.summary.metadata.done, false);

    const run = await scheduled.resolveOneProfile(data, {
      stats,
      providers: [hit],
      limit: 5,
      now: Date.parse('2026-10-29T12:00:00.000Z'),
      nowIso: '2026-10-29T12:00:00.000Z',
      litresBudget: { limit: 0, used: 0, remaining: 0, take: () => false },
    });
    assert.equal(run.linked, 1);
    assert.equal(hit.calls, 1);

    const after = buildBooksStats({ profile: 'livelib-Links' });
    assert.equal(after.summary.metadata.resolved, 1);
    assert.equal(after.summary.metadata.linked, 1);
    assert.equal(after.summary.metadata.unlinked, 0);
    assert.equal(after.summary.metadata.percent, 100);
    assert.equal(after.summary.metadata.done, true);

    // The resolve-state records the asked key with the file: prefix.
    const state = bookCache.getResolveState('livelib', 'Links');
    assert.deepEqual(state.askedKeys, ['file:tk:linkme']);
    assert.equal(state.attempted, 1);
    assert.deepEqual(state.unmatchedKeys, []);
  });

  test('a Литрес verdict survives a supplementary provider outage', async () => {
    const data = profile('LitresVerdict', [fileEvent('tk:ru', 'Неизвестная русская книга')]);
    const stats = statsFor(['file:tk:ru']);
    const calls = [];
    const litresMiss = {
      NAME: 'litres',
      getWork: async (input) => {
        calls.push(`litres:${input.eventKey}`);
        return null;
      },
    };
    const googleError = {
      NAME: 'googlebooks',
      getWork: async () => {
        calls.push('googlebooks');
        const err = new Error('rate limited');
        err.status = 429;
        err.code = 'provider_rate_limited';
        throw err;
      },
    };
    const run = await scheduled.resolveOneProfile(data, {
      stats,
      providers: [litresMiss, googleError],
      limit: 5,
      now: Date.parse('2026-10-29T12:00:00.000Z'),
      nowIso: '2026-10-29T12:00:00.000Z',
      litresBudget: { limit: 5, used: 0, remaining: 5, take: () => true },
    });
    assert.equal(run.linked, 0);
    assert.equal(run.misses, 1);
    assert.equal(run.deferred, 0);
    assert.deepEqual(calls.sort(), ['googlebooks', 'litres:file:tk:ru']);

    const state = scheduled.loadCandidateState('livelib', 'LitresVerdict');
    assert.equal(state.candidates['file:tk:ru'].outcome, 'miss');
    assert.deepEqual(state.candidates['file:tk:ru'].providers, ['litres']);

    // The badge denominator must see this verdict too; otherwise the candidate
    // is not re-asked for 90 days but still pins the percent below 100.
    const resolveState = bookCache.getResolveState('livelib', 'LitresVerdict');
    assert.ok(resolveState.unmatchedKeys.includes('file:tk:ru'));
    assert.equal(resolveState.attempted, 1);
  });
  after(() => env.resetMutableState());
});
