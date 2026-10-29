'use strict';

/**
 * Google Books as a first-class metadata source (round 29.10.2026).
 *
 * Covers: the key plumbing (env/file, never logged), `publishedDate` parsing,
 * the ISBN and Cyrillic-title paths, the author fuzzy guard against false
 * positives, the 30 min 403/429 breaker, network errors as deferrals (no
 * negative cache), the per-run `BOOKS_GB_BUDGET`, and the resolve/scheduled
 * chain wiring (own budget, order, budget skip is not a verdict).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-gb-'));
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-gb-state-'));
// A fake key: the tests assert it never reaches the logs. Set before the first
// `require` of the provider/config so the lazy loader sees it.
const FAKE_KEY = 'AIzaSyTESTKEY_do_not_log_123456789';
process.env.GB_API_KEY = FAKE_KEY;

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../server/config');
const googlebooks = require('../server/books/providers/googlebooks');
const bookCache = require('../server/books/book-cache');
const resolve = require('../server/books/resolve');
const scheduled = require('../server/books/scheduled-resolve');
const { surnameSimilarity, authorsFuzzyOverlap } = require('../server/books/providers/match');

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

function volume(overrides = {}) {
  return {
    id: overrides.id || 'vol-1',
    volumeInfo: {
      title: overrides.title || 'Дюна',
      authors: overrides.authors === undefined ? ['Фрэнк Герберт'] : overrides.authors,
      publisher: 'АСТ',
      publishedDate: overrides.publishedDate === undefined ? '2016-05-01' : overrides.publishedDate,
      categories: ['Fiction / Science Fiction'],
      pageCount: 704,
      industryIdentifiers: overrides.industryIdentifiers || [
        { type: 'ISBN_13', identifier: '9785170987654' },
        { type: 'ISBN_10', identifier: '5170987650' },
      ],
      imageLinks: { thumbnail: 'http://books.google.com/books/content?id=1&edge=curl' },
      infoLink: `https://books.google.com/books?id=${overrides.id || 'vol-1'}`,
      language: overrides.language || 'ru',
    },
  };
}

function gbFetch(handler) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return handler(String(url));
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test.beforeEach(() => {
  googlebooks.resetBreaker();
});

/* ------------------------------------------------------------------ */
/* Key plumbing                                                        */
/* ------------------------------------------------------------------ */

test('gbooks key: GB_API_KEY is the source and the value is never logged', async () => {
  assert.equal(config.gbooksKeySource(), 'GB_API_KEY');
  const logs = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const fetchImpl = gbFetch(() => response({ body: { items: [volume()] } }));
    const result = await googlebooks.getWork(
      { isbn13: '9785170987654', title: 'Дюна', authors: ['Фрэнк Герберт'] },
      { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
    );
    assert.ok(result);
    assert.equal(fetchImpl.calls.length, 1);
    // The key is in the URL (that is how the API works) …
    assert.equal(fetchImpl.calls[0].includes(encodeURIComponent(FAKE_KEY)), true);
    // … but not in any log line.
    const joined = logs.join('\n');
    assert.equal(joined.includes(FAKE_KEY), false);
    assert.equal(joined.includes('AIzaSy'), false);
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
});

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

test('gbooks parses every publishedDate shape into a sane year', () => {
  assert.equal(googlebooks.yearOf('2016-05-01'), 2016);
  assert.equal(googlebooks.yearOf('2016-05'), 2016);
  assert.equal(googlebooks.yearOf('2016'), 2016);
  assert.equal(googlebooks.yearOf('2016-05-01T00:00:00Z'), 2016);
  assert.equal(googlebooks.yearOf('-0500-01-01'), -500);
  assert.equal(googlebooks.yearOf('0'), null);
  assert.equal(googlebooks.yearOf(''), null);
  assert.equal(googlebooks.yearOf('n/a'), null);
  assert.equal(googlebooks.yearOf('9999-01-01'), null);
  assert.equal(googlebooks.yearOf(2016), 2016);
});

test('gbooks ISBN hit carries the edition year, never a first-publication claim', async () => {
  const fetchImpl = gbFetch(() => response({ body: { items: [volume()] } }));
  const result = await googlebooks.getWork(
    { isbn13: '9785170987654' },
    { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
  );
  assert.equal(result.source, 'googlebooks');
  assert.equal(result.year, 2016);
  assert.equal(result.firstPublishedYear, undefined);
  assert.equal(result.match.method, 'isbn');
  assert.equal(result.confidence, 0.96);
  assert.equal(result.isbn13, '9785170987654');
});

/* ------------------------------------------------------------------ */
/* Title path + false-positive guard                                   */
/* ------------------------------------------------------------------ */

test('gbooks Cyrillic title uses the plain phrase query (fielded operators are dead)', async () => {
  const fetchImpl = gbFetch(() =>
    response({ body: { items: [volume({ id: 'vol-nemesis', title: 'Немезида', authors: ['Агата Кристи'], publishedDate: '2019-10-07' })] } })
  );
  const result = await googlebooks.getWork(
    { title: 'Немезида', authors: ['Agatha Christie'] },
    { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
  );
  assert.ok(result);
  assert.equal(fetchImpl.calls.length, 1);
  const url = decodeURIComponent(fetchImpl.calls[0]);
  assert.equal(url.includes('intitle:'), false);
  assert.equal(url.includes('q=Немезида Agatha Christie'), true);
  assert.equal(result.match.authorFuzzy, true);
  assert.equal(result.confidence, 0.95);
});

test('gbooks fuzzy surname matches transliterations, not unrelated names', () => {
  assert.ok(surnameSimilarity('кристи', 'christie') >= 0.6);
  assert.ok(surnameSimilarity('твен', 'twain') >= 0.6);
  assert.ok(surnameSimilarity('герберт', 'herbert') >= 0.6);
  assert.equal(surnameSimilarity('кристи', 'stark') >= 0.6, false);
  assert.equal(authorsFuzzyOverlap(['Agatha Christie'], ['Агата Кристи']), true);
  assert.equal(authorsFuzzyOverlap(['Agatha Christie'], ['Кристина Старк']), false);
});

test('gbooks title fallback rejects a different author and a different title', async () => {
  // Same title, different author: the author guard must reject it.
  let fetchImpl = gbFetch(() =>
    response({ body: { items: [volume({ id: 'wrong-author', title: 'Немезида', authors: ['Другой Автор'] })] } })
  );
  const wrongAuthor = await googlebooks.getWork(
    { title: 'Немезида', authors: ['Agatha Christie'] },
    { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
  );
  assert.equal(wrongAuthor, null);

  // Same author, different title: title similarity is too low.
  fetchImpl = gbFetch(() =>
    response({ body: { items: [volume({ id: 'wrong-title', title: 'Совсем другая книга', authors: ['Агата Кристи'] })] } })
  );
  const wrongTitle = await googlebooks.getWork(
    { title: 'Немезида', authors: ['Agatha Christie'] },
    { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
  );
  assert.equal(wrongTitle, null);
});

/* ------------------------------------------------------------------ */
/* Breaker / errors / budget                                           */
/* ------------------------------------------------------------------ */

test('gbooks 403 and 429 trip a 30 minute breaker', async () => {
  assert.equal(googlebooks.BREAKER_MS, 30 * 60 * 1000);
  for (const status of [403, 429]) {
    googlebooks.resetBreaker();
    const fetchImpl = gbFetch(() => response({ status, body: {} }));
    await assert.rejects(
      googlebooks.getWork({ title: 'Дюна', authors: ['Фрэнк Герберт'] }, { fetchImpl, sleep: noSleep, requestDelayMs: 0 })
    );
    assert.equal(googlebooks.isBreakerOpen(), true);
    const before = fetchImpl.calls.length;
    const second = await googlebooks.getWork(
      { title: 'Дюна', authors: ['Фрэнк Герберт'] },
      { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
    );
    assert.equal(second, null);
    assert.equal(fetchImpl.calls.length, before);
  }
  googlebooks.resetBreaker();
});

test('gbooks network error is a deferral: it throws and writes no negative memo', async () => {
  const memo = new Map();
  const fetchImpl = gbFetch(() => {
    throw new Error('ECONNRESET');
  });
  await assert.rejects(
    googlebooks.getWork(
      { title: 'Дюна', authors: ['Фрэнк Герберт'] },
      { fetchImpl, sleep: noSleep, requestDelayMs: 0, negativeMemo: memo }
    )
  );
  assert.equal(memo.size, 0);
  assert.equal(googlebooks.isBreakerOpen(), false);
});

test('gbooks BOOKS_GB_BUDGET bounds the books per run, not the HTTP requests', async () => {
  const budget = googlebooks.createBudget(2);
  const fetchImpl = gbFetch(() => response({ body: { items: [] } }));
  for (const title of ['Одна', 'Две', 'Три']) {
    await googlebooks.getWork({ title, authors: ['Автор'] }, { fetchImpl, sleep: noSleep, requestDelayMs: 0, budget });
  }
  assert.equal(budget.used, 2);
  assert.equal(budget.remaining, 0);
  assert.equal(fetchImpl.calls.length, 2);
});

/* ------------------------------------------------------------------ */
/* Chain wiring                                                        */
/* ------------------------------------------------------------------ */

function profile(events) {
  return { schemaVersion: 1, source: 'livelib', userKey: 'gb-tester', importedAt: '2026-10-29T00:00:00.000Z', events };
}

function event(bookId, overrides = {}) {
  return {
    id: `ll:${bookId}`,
    source: 'livelib',
    sourceBookId: String(bookId),
    title: overrides.title || 'Немезида',
    authors: overrides.authors || ['Agatha Christie'],
    rating: 8,
    ratingScale: 10,
    rating10: 8,
    edition: { isbn: overrides.isbn === undefined ? null : overrides.isbn, year: null },
  };
}

test('gbooks has its own budget in the chain (not the LiveLib card budget)', async () => {
  const fetchImpl = gbFetch(() => response({ body: { items: [] } }));
  const report = await resolve.resolveProfile(
    profile([event('7001'), event('7002')]),
    {
      providers: ['googlebooks'],
      lookupIsbns: async () => ({ byIsbn: new Map(), works: new Map(), queries: [], requests: 0 }),
      fetchImpl,
      sleep: noSleep,
      requestDelayMs: 0,
      gbBudget: googlebooks.createBudget(1),
      cardBudget: resolve.createCardBudget(10),
    }
  );
  assert.equal(report.gbBudget.used, 1);
  assert.equal(report.gbBudget.limit, 1);
  assert.equal(report.cardBudget.used, 0);
  // The second book was never asked: it must stay pending, not "hopeless".
  assert.deepEqual(report.unmatchedKeys, ['7001']);
  assert.equal(report.budgetPendingKeys.includes('7002'), true);
});

test('gbooks budget skip is a deferral in the scheduled resolve (no negative cache)', async () => {
  const fetchImpl = gbFetch(() => response({ body: { items: [] } }));
  await bookCache.saveProfile('livelib', 'gb-tester', profile([event('7101'), event('7102')]));
  const report = await scheduled.resolveOneProfile(bookCache.getProfile('livelib', 'gb-tester'), {
    providers: ['googlebooks'],
    fetchImpl,
    sleep: noSleep,
    requestDelayMs: 0,
    gbBudget: googlebooks.createBudget(1),
    cardBudget: resolve.createCardBudget(10),
    limit: 2,
    recheckDays: 90,
  });
  assert.equal(report.selected, 2);
  assert.equal(report.linked, 0);
  assert.equal(report.deferred, 1);
  assert.equal(report.misses, 1);
  const state = scheduled.loadCandidateState('livelib', 'gb-tester');
  assert.deepEqual(Object.keys(state.candidates), ['7101']);
});

test('gbooks is the second matcher for a Cyrillic title after litres', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('api.litres.ru')) return response({ body: { payload: { data: [] } } });
    if (String(url).includes('googleapis')) {
      return response({ body: { items: [volume({ id: 'vol-igrok', title: 'Игрок', authors: ['Фёдор Достоевский'], publishedDate: '2014' })] } });
    }
    return response({ body: {} });
  };
  const report = await resolve.resolveProfile(
    profile([event('7201', { title: 'Игрок', authors: ['Фёдор Достоевский'] })]),
    {
      providers: ['litres', 'googlebooks', 'openlibrary'],
      lookupIsbns: async () => ({ byIsbn: new Map(), works: new Map(), queries: [], requests: 0 }),
      fetchImpl,
      sleep: noSleep,
      requestDelayMs: 0,
      litresPauseMs: 0,
    }
  );
  assert.equal(report.resolvedGoogle, 1);
  assert.equal(report.resolvedLitres, 0);
  assert.equal(calls.some((url) => url.includes('openlibrary')), false);
  const link = bookCache.getLink('7201');
  assert.equal(link.method, 'googlebooks-title');
  const details = bookCache.getWorkDetails('gb:vol-igrok');
  assert.equal(details.publicationYear, 2014);
  assert.equal(details.firstPublishedYear, null);
});
