'use strict';

/**
 * Metadata providers: normalisation fixtures, manga detection, merge and
 * budget rules. No network: every provider gets an injected fetch + sleep.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const googlebooks = require('../server/books/providers/googlebooks');
const openlibrary = require('../server/books/providers/openlibrary');
const livelibCard = require('../server/books/providers/livelib-card');
const litres = require('../server/books/providers/litres');
const { detectManga } = require('../server/books/providers/manga');
const providers = require('../server/books/providers');

const noSleep = async () => {};

function response({ status = 200, body = {}, headers = {} }) {
  return {
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    async json() {
      return typeof body === 'string' ? JSON.parse(body) : body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

const GB_VOLUME = {
  id: 'vol-dune-ru',
  volumeInfo: {
    title: 'Дюна',
    authors: ['Фрэнк Герберт'],
    publisher: 'АСТ',
    publishedDate: '2016-05-01',
    categories: ['Fiction / Science Fiction / Space Opera'],
    pageCount: 704,
    industryIdentifiers: [
      { type: 'ISBN_13', identifier: '9785170987654' },
      { type: 'ISBN_10', identifier: '5170987650' },
    ],
    imageLinks: { thumbnail: 'http://books.google.com/books/content?id=1&edge=curl' },
    infoLink: 'https://books.google.com/books?id=vol-dune-ru',
    language: 'ru',
  },
};

function gbFetch(handler) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return handler(String(url));
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function cardHtml(overrides = {}) {
  const isbn = overrides.isbn === undefined ? '978-5-699-98967-6' : overrides.isbn;
  const genres = overrides.genres || ['Зарубежная фантастика', 'Научная фантастика'];
  const series = overrides.series === undefined ? 'Кинопремьера мирового масштаба' : overrides.series;
  const publisher = overrides.publisher === undefined ? 'Эксмо' : overrides.publisher;
  const year = overrides.year === undefined ? '2018' : overrides.year;
  const pages = overrides.pages === undefined ? '256' : overrides.pages;
  const rows = [
    publisher ? `<div class="DetailedInfo_DetailedInfoRow__x"><p>Издательство: </p><p>${publisher}</p></div>` : '',
    series ? `<div class="DetailedInfo_DetailedInfoRow__x"><p>Серия: </p><p>${series}</p></div>` : '',
    isbn ? `<div class="DetailedInfo_DetailedInfoRow__x"><p>ISBN: </p><p>${isbn}</p></div>` : '',
    year ? `<div class="DetailedInfo_DetailedInfoRow__x"><p>Год издания: </p><p>${year}</p></div>` : '',
    '<div class="DetailedInfo_DetailedInfoRow__x"><p>Язык: </p><p>Русский</p></div>',
    pages ? `<div class="DetailedInfo_DetailedInfoRow__x"><p>Страниц: ${pages}</p></div>` : '',
  ].join('');
  return `<!doctype html><html><head>
    <link rel="canonical" href="https://www.livelib.ru/book/1002745594-annigilyatsiya"/>
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Book',
      name: overrides.title || 'Аннигиляция',
      author: { name: overrides.author || 'Джефф Вандермеер' },
      image: { url: 'https://s1.livelib.ru/boocover/1002745594/200x305/a33c/book.jpg' },
      inLanguage: 'ru',
      datePublished: year || undefined,
    })}</script>
  </head><body>
    <h1>${overrides.title || 'Аннигиляция'}</h1>
    <div class="DetailedInfo_DetailedInfoContent__y">${rows}</div>
    <section class="ShortInfo_ShortInfoGenres__x"><p>Жанры</p><div>
      ${genres.map((genre) => `<a href="https://www.livelib.ru/genre/${genre}"><span>${genre}</span></a>`).join('')}
    </div></section>
  </body></html>`;
}

test.beforeEach(() => {
  googlebooks.resetBreaker();
  livelibCard.resetBreaker();
  litres.resetBreaker();
});

test('googlebooks normalizes an ISBN hit', async () => {
  const fetchImpl = gbFetch(() => response({ body: { totalItems: 1, items: [GB_VOLUME] } }));
  const result = await googlebooks.getWork(
    { isbn13: '9785170987654', title: 'Дюна', authors: ['Фрэнк Герберт'] },
    { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
  );
  assert.ok(result);
  assert.equal(result.source, 'googlebooks');
  assert.equal(result.sourceId, 'vol-dune-ru');
  assert.equal(result.title, 'Дюна');
  assert.deepEqual(result.authors, ['Фрэнк Герберт']);
  assert.equal(result.year, 2016);
  assert.equal(result.publisher, 'АСТ');
  assert.equal(result.pages, 704);
  assert.equal(result.isbn13, '9785170987654');
  assert.equal(result.isbn10, '5170987650');
  assert.equal(result.cover.startsWith('https://'), true);
  assert.equal(result.cover.includes('edge=curl'), false);
  assert.equal(result.links.pageUrl, 'https://books.google.com/books?id=vol-dune-ru');
  assert.deepEqual(result.genres, ['Fiction', 'Science Fiction', 'Space Opera']);
  assert.equal(result.confidence, 0.96);
  assert.equal(result.mangaComics, false);
});

test('googlebooks title fallback keeps the author guard', async () => {
  const fetchImpl = gbFetch((url) => {
    if (/q=isbn%3A/.test(url)) return response({ body: { totalItems: 0 } });
    return response({
      body: {
        items: [
          {
            id: 'wrong',
            volumeInfo: { title: 'Дюна', authors: ['Другой Автор'], pageCount: 100 },
          },
          { ...GB_VOLUME, id: 'right' },
        ],
      },
    });
  });
  const result = await googlebooks.getWork(
    { isbn13: '9785170987654', title: 'Дюна', authors: ['Фрэнк Герберт'] },
    { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
  );
  assert.ok(result);
  assert.equal(result.sourceId, 'right');
  assert.ok(result.confidence < 0.96);
});

test('googlebooks title fallback rejects everything when the author differs', async () => {
  const fetchImpl = gbFetch((url) => {
    if (/q=isbn%3A/.test(url)) return response({ body: { totalItems: 0 } });
    return response({
      body: { items: [{ id: 'wrong', volumeInfo: { title: 'Дюна', authors: ['Другой Автор'] } }] },
    });
  });
  const result = await googlebooks.getWork(
    { title: 'Дюна', authors: ['Фрэнк Герберт'] },
    { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
  );
  assert.equal(result, null);
});

test('googlebooks 429 trips the breaker and stops further calls', async () => {
  const fetchImpl = gbFetch(() => response({ status: 429, body: { error: { code: 429 } } }));
  await assert.rejects(
    () =>
      googlebooks.getWork(
        { isbn13: '9785170987654' },
        { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
      ),
    /HTTP 429/
  );
  assert.equal(googlebooks.isBreakerOpen(), true);
  const callsAfterError = fetchImpl.calls.length;
  const second = await googlebooks.getWork(
    { isbn13: '9785170987655' },
    { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
  );
  assert.equal(second, null);
  assert.equal(fetchImpl.calls.length, callsAfterError);
});

test('openlibrary parses an ISBN edition and a search hit', async () => {
  const edition = {
    'ISBN:9780441013593': {
      url: 'https://openlibrary.org/books/OL62694654M/Dune',
      key: '/books/OL62694654M',
      title: 'Dune',
      authors: [{ name: 'Frank Herbert' }],
      number_of_pages: 896,
      publishers: [{ name: 'Ace' }],
      publish_date: '2005',
      subjects: [{ name: 'Science Fiction' }, { name: 'Accessible book' }],
      identifiers: { isbn_13: ['9780441013593'], isbn_10: ['0441013597'] },
      cover: { large: 'http://covers.openlibrary.org/b/id/1-L.jpg' },
    },
  };
  const fetchImpl = gbFetch((url) => {
    if (url.includes('/api/books')) return response({ body: edition });
    return response({
      body: {
        docs: [
          {
            key: '/works/OL1W',
            title: 'Dune',
            author_name: ['Frank Herbert'],
            first_publish_year: 1965,
            publisher: ['Chilton'],
            cover_i: 42,
            subject: ['Science Fiction', 'Protected DAISY'],
            isbn: ['9780441013593'],
            number_of_pages_median: 412,
          },
        ],
      },
    });
  });
  const byIsbn = await openlibrary.getWork(
    { isbn13: '9780441013593' },
    { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
  );
  assert.ok(byIsbn);
  assert.equal(byIsbn.source, 'openlibrary');
  assert.equal(byIsbn.sourceId, 'OL62694654M');
  assert.equal(byIsbn.year, 2005);
  assert.equal(byIsbn.pages, 896);
  assert.deepEqual(byIsbn.genres, ['Science Fiction']);
  assert.equal(byIsbn.cover.startsWith('https://'), true);
  assert.equal(byIsbn.confidence, 0.94);

  const byTitle = await openlibrary.getWork(
    { title: 'Dune', authors: ['Frank Herbert'] },
    { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
  );
  assert.ok(byTitle);
  assert.equal(byTitle.sourceId, 'OL1W');
  assert.equal(byTitle.year, 1965);
  assert.equal(byTitle.pages, 412);
  assert.ok(byTitle.confidence < byIsbn.confidence);
});

test('livelib card parses RU edition metadata and respects the per-run budget', async () => {
  const fetchImpl = gbFetch(() => response({ body: cardHtml() }));
  const budget = livelibCard.createBudget(1);
  const first = await livelibCard.getWork(
    { llBookId: '1002745594', title: 'Аннигиляция', authors: ['Джефф Вандермеер'] },
    { fetchImpl, sleep: noSleep, cardPauseMs: 0, budget }
  );
  assert.ok(first);
  assert.equal(first.source, 'livelib-card');
  assert.equal(first.isbn13, '9785699989676');
  assert.equal(first.publisher, 'Эксмо');
  assert.equal(first.year, 2018);
  assert.equal(first.pages, 256);
  assert.deepEqual(first.series, { name: 'Кинопремьера мирового масштаба', position: null });
  assert.deepEqual(first.genres, ['Зарубежная фантастика', 'Научная фантастика']);
  assert.equal(first.mangaComics, false);
  assert.equal(first.links.pageUrl, 'https://www.livelib.ru/book/1002745594-annigilyatsiya');
  assert.equal(budget.used, 1);

  const callsBefore = fetchImpl.calls.length;
  const second = await livelibCard.getWork(
    { llBookId: '2' },
    { fetchImpl, sleep: noSleep, cardPauseMs: 0, budget }
  );
  assert.equal(second, null);
  assert.equal(budget.used, 1);
  assert.equal(fetchImpl.calls.length, callsBefore);
});

test('livelib card marks manga genres', async () => {
  const fetchImpl = gbFetch(() =>
    response({ body: cardHtml({ genres: ['Манга', 'Фэнтези'], title: 'Наруто' }) })
  );
  const result = await livelibCard.getWork(
    { llBookId: '777' },
    { fetchImpl, sleep: noSleep, cardPauseMs: 0 }
  );
  assert.equal(result.mangaComics, true);
});

test('livelib card 403 trips a run breaker instead of retrying every book', async () => {
  const fetchImpl = gbFetch(() => response({ status: 403, body: '<html>DDoS-Guard</html>' }));
  const budget = livelibCard.createBudget(10);
  await assert.rejects(
    () =>
      livelibCard.getWork(
        { llBookId: '1' },
        { fetchImpl, sleep: noSleep, cardPauseMs: 0, budget }
      ),
    /ограничил доступ/
  );
  assert.equal(livelibCard.isBreakerOpen(), true);
  const callsAfterBlock = fetchImpl.calls.length;
  const second = await livelibCard.getWork(
    { llBookId: '2' },
    { fetchImpl, sleep: noSleep, cardPauseMs: 0, budget }
  );
  assert.equal(second, null);
  assert.equal(fetchImpl.calls.length, callsAfterBlock);
  assert.equal(budget.used, 1);
});

test('manga detection is tri-state', () => {
  assert.equal(detectManga({ genres: ['Manga'] }), true);
  assert.equal(detectManga({ genres: ['Комиксы'] }), true);
  assert.equal(detectManga({ series: ['Graphic Novel Series'] }), true);
  assert.equal(detectManga({ genres: ['Fantasy'], publisher: 'Манга-пресс' }), true);
  assert.equal(detectManga({ genres: ['Fantasy'] }), false);
  assert.equal(detectManga({}), null);
  assert.equal(detectManga({ publisher: 'Эксмо' }), null);
});

test('merge fills missing fields from extras and tracks metadataSources', () => {
  const primary = {
    source: 'hardcover',
    sourceId: '100',
    workId: 'hc:100',
    title: 'Дюна',
    authors: ['Фрэнк Герберт'],
    year: 1965,
    publisher: null,
    series: null,
    genres: ['Science Fiction'],
    pages: null,
    isbn13: null,
    isbn10: null,
    cover: null,
    links: { pageUrl: 'https://hardcover.app/books/dune' },
    confidence: 0.99,
    mangaComics: false,
  };
  const extra = {
    source: 'livelib-card',
    sourceId: '9001',
    title: 'Дюна',
    authors: ['Фрэнк Герберт'],
    year: 2016,
    publisher: 'АСТ',
    series: { name: 'Дюны', position: 1 },
    genres: ['Научная фантастика'],
    pages: 704,
    isbn13: '9785170987654',
    isbn10: '5170987650',
    cover: 'https://example.test/cover.jpg',
    links: { pageUrl: 'https://www.livelib.ru/book/9001' },
    confidence: 1,
    mangaComics: false,
  };
  const merged = providers.mergeResults(primary, [extra]);
  assert.equal(merged.title, 'Дюна');
  assert.equal(merged.publisher, 'АСТ');
  assert.equal(merged.pages, 704);
  assert.equal(merged.year, 1965);
  assert.equal(merged.series.name, 'Дюны');
  assert.deepEqual(merged.genres, ['Science Fiction']);
  assert.deepEqual(merged.metadataSources, ['hardcover', 'livelib-card']);
  assert.equal(merged.metadataSources.length, 2);

  const manga = providers.mergeResults(primary, [
    { ...extra, genres: ['Manga'], mangaComics: true },
  ]);
  assert.equal(manga.mangaComics, true);
});

test('details document keeps schema 2 fields and metadataSources', () => {
  const merged = providers.mergeResults(
    {
      source: 'googlebooks',
      sourceId: 'vol-1',
      workId: 'gb:vol-1',
      title: 'Дюна',
      authors: ['Фрэнк Герберт'],
      year: 2016,
      publisher: 'АСТ',
      series: null,
      genres: ['Science Fiction'],
      pages: 704,
      isbn13: '9785170987654',
      isbn10: '5170987650',
      cover: 'https://example.test/cover.jpg',
      links: { pageUrl: 'https://books.google.com/books?id=vol-1' },
      confidence: 0.96,
      mangaComics: false,
    },
    []
  );
  const doc = providers.resultToDetails(merged, { now: '2026-10-27T00:00:00.000Z' });
  assert.equal(doc.schemaVersion, 2);
  assert.equal(doc.workId, 'gb:vol-1');
  assert.deepEqual(doc.authors, [{ name: 'Фрэнк Герберт' }]);
  assert.deepEqual(doc.metadataSources, ['googlebooks']);
  assert.equal(doc.sources[0].source, 'googlebooks');
  assert.equal(doc.sources[0].url, 'https://books.google.com/books?id=vol-1');
  assert.equal(doc.publicationYear, 2016);
  assert.equal(doc.mangaComics, false);
  assert.equal(doc.fetchedAt, '2026-10-27T00:00:00.000Z');
});

test('negative memo prevents duplicate provider requests inside one run', async () => {
  const fetchImpl = gbFetch(() => response({ body: { totalItems: 0 } }));
  const memo = new Map();
  const first = await googlebooks.getWork(
    { isbn13: '9780000000001' },
    { fetchImpl, sleep: noSleep, requestDelayMs: 0, negativeMemo: memo }
  );
  assert.equal(first, null);
  assert.equal(fetchImpl.calls.length, 1);
  const second = await googlebooks.getWork(
    { isbn13: '9780000000001' },
    { fetchImpl, sleep: noSleep, requestDelayMs: 0, negativeMemo: memo }
  );
  assert.equal(second, null);
  assert.equal(fetchImpl.calls.length, 1);
});

const LITRES_ITEM = {
  id: 8981462,
  title: 'Аннигиляция',
  url: '/book/dzheff-vandermeer/annigilyaciya-8981462/',
  cover_url: '/pub/c/cover/8981462.jpg',
  language_code: 'ru',
  date_written_at: '2014-01-01',
  symbols_count: 266345,
  persons: [
    { full_name: 'Джефф Вандермеер', role: 'author' },
    { full_name: 'Михаил Молчанов', role: 'translator' },
  ],
  rating: { rated_avg: 4.35 },
  series: [{ name: 'Зона Икс', art_order: 1 }],
};

function litresDetail(overrides = {}) {
  return {
    id: 8981462,
    title: 'Аннигиляция',
    isbn: overrides.isbn === undefined ? '978-5-699-78049-5' : overrides.isbn,
    publisher: overrides.publisher === undefined ? null : overrides.publisher,
    publication_date: '2014-01-01',
    genres: overrides.genres || [
      { name: 'научная фантастика' },
      { name: 'зарубежная фантастика' },
    ],
    tags: overrides.tags || [{ name: 'хоррор' }],
    series: overrides.series || [{ name: 'Зона Икс', art_order: 1 }],
    paper_book: overrides.paper_book === undefined ? { pages: 256 } : overrides.paper_book,
    cover_url: '/pub/c/cover/8981462.jpg',
    url: '/book/dzheff-vandermeer/annigilyaciya-8981462/',
  };
}

function litresFetch({ items = [LITRES_ITEM], detail = litresDetail(), detailStatus = 200 } = {}) {
  return gbFetch((url) => {
    if (url.includes('/foundation/api/search')) {
      return response({ body: { payload: { data: items.map((item) => ({ type: 'text_book', instance: item })) } } });
    }
    if (url.includes('/foundation/api/arts/')) {
      if (detailStatus !== 200) return response({ status: detailStatus, body: {} });
      return response({ body: { payload: { data: detail } } });
    }
    return response({ status: 404, body: {} });
  });
}

test('litres normalizes a RU search hit with art detail', async () => {
  const fetchImpl = litresFetch();
  const result = await litres.getWork(
    { title: 'Аннигиляция', authors: ['Джефф Вандермеер'] },
    { fetchImpl, sleep: noSleep, litresPauseMs: 0 }
  );
  assert.ok(result);
  assert.equal(result.source, 'litres');
  assert.equal(result.workId, 'lr:8981462');
  assert.equal(result.title, 'Аннигиляция');
  assert.deepEqual(result.authors, ['Джефф Вандермеер']);
  assert.equal(result.isbn13, '9785699780495');
  assert.equal(result.isbn10, '5699780491');
  assert.equal(result.year, 2014);
  assert.deepEqual(result.genres, ['научная фантастика', 'зарубежная фантастика']);
  assert.deepEqual(result.series, { name: 'Зона Икс', position: 1, source: 'litres' });
  assert.equal(result.pages, 256);
  assert.equal(result.cover, 'https://www.litres.ru/pub/c/cover/8981462.jpg');
  assert.equal(
    result.links.pageUrl,
    'https://www.litres.ru/book/dzheff-vandermeer/annigilyaciya-8981462/'
  );
  assert.equal(result.confidence, 0.95);
  assert.equal(result.mangaComics, false);
  assert.equal(fetchImpl.calls.length, 2);
});

test('litres keeps the search card when the art detail fails', async () => {
  const fetchImpl = litresFetch({ detailStatus: 500 });
  const result = await litres.getWork(
    { title: 'Аннигиляция', authors: ['Джефф Вандермеер'] },
    { fetchImpl, sleep: noSleep, litresPauseMs: 0 }
  );
  assert.ok(result);
  assert.equal(result.isbn13, null);
  assert.deepEqual(result.genres, []);
  assert.equal(result.pages, null);
  assert.equal(result.links.pageUrl.includes('/book/dzheff-vandermeer/'), true);
});

test('litres search-only cards keep unknown pages/year as null', () => {
  const normalized = litres.normalizeLitres(
    LITRES_ITEM,
    null,
    { title: 'Аннигиляция', authors: ['Джефф Вандермеер'] },
    { exact: true, score: 1, titleSim: 1, authorHit: true }
  );
  assert.equal(normalized.pages, null);
  assert.deepEqual(normalized.genres, []);
  assert.equal(normalized.year, 2014);
  const doc = providers.resultToDetails(normalized, { now: '2026-10-27T00:00:00.000Z' });
  assert.equal(doc.pages, null);
  assert.equal(doc.publicationYear, 2014);
});

test('litres strips format suffixes and prefers text editions', () => {
  assert.equal(litres.cleanTitle('Игрок (epub)'), 'Игрок');
  assert.equal(litres.cleanTitle('Игрок (fb2, pdf)'), 'Игрок');
  assert.equal(litres.cleanTitle('Игрок (покетбук)'), 'Игрок (покетбук)');
});

test('litres rejects a candidate with a different author', async () => {
  const wrong = {
    ...LITRES_ITEM,
    persons: [{ full_name: 'Другой Автор', role: 'author' }],
  };
  const fetchImpl = litresFetch({ items: [wrong] });
  const result = await litres.getWork(
    { title: 'Аннигиляция', authors: ['Джефф Вандермеер'] },
    { fetchImpl, sleep: noSleep, litresPauseMs: 0 }
  );
  assert.equal(result, null);
  assert.equal(fetchImpl.calls.length, 1);
});

test('litres 403 trips the 30 min breaker', async () => {
  const fetchImpl = gbFetch(() => response({ status: 403, body: '<html>blocked</html>' }));
  const budget = litres.createBudget(10);
  await assert.rejects(
    () =>
      litres.getWork(
        { title: 'Аннигиляция', authors: ['Джефф Вандермеер'] },
        { fetchImpl, sleep: noSleep, litresPauseMs: 0, budget }
      ),
    /HTTP 403/
  );
  assert.equal(litres.isBreakerOpen(), true);
  const callsAfter = fetchImpl.calls.length;
  const second = await litres.getWork(
    { title: 'Игрок', authors: ['Фёдор Достоевский'] },
    { fetchImpl, sleep: noSleep, litresPauseMs: 0, budget }
  );
  assert.equal(second, null);
  assert.equal(fetchImpl.calls.length, callsAfter);
  assert.equal(budget.used, 1);
});

test('litres budget caps book lookups per run', async () => {
  const fetchImpl = litresFetch();
  const budget = litres.createBudget(1);
  const options = { fetchImpl, sleep: noSleep, litresPauseMs: 0, budget };
  const first = await litres.getWork(
    { title: 'Аннигиляция', authors: ['Джефф Вандермеер'] },
    options
  );
  assert.ok(first);
  const second = await litres.getWork(
    { title: 'Игрок', authors: ['Фёдор Достоевский'] },
    options
  );
  assert.equal(second, null);
  assert.equal(budget.used, 1);
  assert.equal(fetchImpl.calls.length, 2);
});

test('litres detects manga via its genre names', async () => {
  const fetchImpl = litresFetch({
    items: [{ ...LITRES_ITEM, title: 'Наруто. Том 1', persons: [{ full_name: 'Масаси Кисимото', role: 'author' }] }],
    detail: litresDetail({ genres: [{ name: 'манга' }, { name: 'фэнтези' }] }),
  });
  const result = await litres.getWork(
    { title: 'Наруто. Том 1', authors: ['Масаси Кисимото'] },
    { fetchImpl, sleep: noSleep, litresPauseMs: 0 }
  );
  assert.ok(result);
  assert.equal(result.mangaComics, true);
});

test('litres negative memo avoids duplicate searches in one run', async () => {
  const fetchImpl = litresFetch({ items: [] });
  const memo = new Map();
  const options = { fetchImpl, sleep: noSleep, litresPauseMs: 0, negativeMemo: memo };
  const first = await litres.getWork({ title: 'Неизвестная книга' }, options);
  assert.equal(first, null);
  const second = await litres.getWork({ title: 'Неизвестная книга' }, options);
  assert.equal(second, null);
  assert.equal(fetchImpl.calls.length, 1);
});
