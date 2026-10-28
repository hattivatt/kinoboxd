'use strict';

/**
 * /api/books/stats aggregation under the single-profile contract:
 *   - a profile is ONE source + ONE account (`livelib-tester` / `hardcover-34748`);
 *   - events of another profile never leak into the payload (no union);
 *   - work metadata may still come from the shared metadata chain (Hardcover
 *     details resolved for a LiveLib book) — that is metadata, not an event merge;
 *   - the payload has no `ratings.bySource` / `sources.filter` any more;
 *   - calendar/timeline/streaks only use dated events.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-book-stats-'));

const bookCache = require('../server/books/book-cache');
const { buildBooksStats } = require('../server/books/stats');

async function seed() {
  await bookCache.saveDetails(100, {
    schemaVersion: 1,
    hcWorkId: 100,
    title: 'Дюна',
    authors: [{ hcId: 1, name: 'Фрэнк Герберт' }],
    genres: ['Science Fiction'],
    series: [{ hcId: 5, name: 'Дюны', position: 1 }],
    pages: 512,
    publicationYear: 1965,
    publisher: 'Chilton',
    coverUrl: 'https://example.test/dune.jpg',
    ratingsCount: 5000,
    partial: false,
  });
  await bookCache.saveDetails(101, {
    schemaVersion: 1,
    hcWorkId: 101,
    title: 'Мартин Иден',
    authors: [{ hcId: 2, name: 'Джек Лондон' }],
    genres: ['Classics'],
    series: [],
    pages: 400,
    publicationYear: 1909,
    publisher: 'Penguin',
    partial: false,
  });
  await bookCache.saveLink('9001', {
    schemaVersion: 1,
    livelibBookId: '9001',
    workId: 'hc:100',
    method: 'isbn',
    score: 1,
    evidence: { isbn: '9780441013593' },
  });
  bookCache.setWorkLink('hc:100', { livelib: ['9001'] });
  bookCache.flushLinks();

  await bookCache.saveProfile('hardcover', '34748', {
    schemaVersion: 1,
    source: 'hardcover',
    userKey: '34748',
    sourceUserId: 34748,
    importedAt: '2026-10-27T00:00:00.000Z',
    events: [
      {
        id: 'hc:read:1',
        source: 'hardcover',
        sourceBookId: '100',
        workId: 'hc:100',
        title: 'Дюна',
        authors: ['Фрэнк Герберт'],
        rating: 4.5,
        ratingScale: 5,
        rating10: 9,
        status: 'read',
        finishedAt: '2024-03-02',
        readCount: 1,
        edition: { publisher: 'Chilton', year: 1965, isbn: '9780441013593', language: 'English' },
      },
      {
        id: 'hc:read:2',
        source: 'hardcover',
        sourceBookId: '101',
        workId: 'hc:101',
        title: 'Мартин Иден',
        authors: ['Джек Лондон'],
        rating: 4,
        ratingScale: 5,
        rating10: 8,
        status: 'read',
        finishedAt: '2024-03-03',
        readCount: 1,
        edition: { publisher: 'Penguin', year: 1909, isbn: null, language: 'English' },
      },
    ],
    warnings: [],
  });

  await bookCache.saveProfile('livelib', 'tester', {
    schemaVersion: 1,
    source: 'livelib',
    userKey: 'tester',
    importedAt: '2026-10-27T00:00:00.000Z',
    events: [
      {
        id: 'll:1',
        source: 'livelib',
        sourceBookId: '9001',
        sourceUserBookId: '1',
        title: 'Дюна',
        authors: ['Фрэнк Герберт'],
        rating: 7,
        ratingScale: 10,
        rating10: 7,
        status: 'read',
        finishedAt: '2024-03-02',
        edition: { publisher: 'АСТ', year: 2015, isbn: '9785170863174', language: 'Русский' },
      },
      {
        id: 'll:2',
        source: 'livelib',
        sourceBookId: '9002',
        sourceUserBookId: '2',
        title: 'Неизвестная книга',
        authors: ['Автор Один'],
        rating: 6,
        ratingScale: 10,
        rating10: 6,
        status: 'read',
        finishedAt: '2024-04-01',
        edition: { publisher: 'Эксмо', year: 2020, isbn: null, language: 'Русский' },
      },
      {
        id: 'll:3',
        source: 'livelib',
        sourceBookId: '9003',
        sourceUserBookId: '3',
        title: 'Без даты',
        authors: ['Автор Два'],
        rating: null,
        ratingScale: 10,
        rating10: null,
        status: 'read',
        finishedAt: null,
        edition: { publisher: null, year: null, isbn: null, language: null },
      },
    ],
    warnings: [],
  });
}

test('a LiveLib profile aggregates only its own events (metadata may come from Hardcover)', async () => {
  await seed();
  const stats = buildBooksStats({ profile: 'livelib-tester' });

  assert.deepEqual(stats.sources.selected, ['livelib']);
  assert.deepEqual(stats.sources.profile, {
    key: 'livelib-tester',
    source: 'livelib',
    userKey: 'tester',
    // Acquisition path: a scraped profile reports its source as origin.
    origin: 'livelib',
    importedAt: '2026-10-27T00:00:00.000Z',
    eventCount: 3,
  });
  // `connected` still lists every profile on the server: it is the switcher's
  // catalogue, not the scope.
  assert.deepEqual(stats.sources.connected.sort(), ['hardcover', 'livelib']);

  assert.equal(stats.summary.eventCount, 3);
  // hc:100 (via the LL link), ll:9002, ll:9003 (unresolved stub).
  assert.equal(stats.summary.bookCount, 3);
  assert.equal(stats.summary.finishedCount, 2);
  assert.equal(stats.summary.undatedEventCount, 1);
  assert.equal(stats.summary.resolvedCount, 1);
  assert.equal(stats.summary.unresolvedCount, 2);
  assert.deepEqual(stats.summary.sources, ['livelib']);

  // The LiveLib rating is the one shown; the Hardcover account's 9/10 for the
  // same work belongs to a different profile and must not appear.
  const dune = stats.booksIndex['hc:100'];
  assert.equal(dune.rating, 7);
  assert.equal('ratingsBySource' in dune, false);
  assert.deepEqual(dune.sources, ['livelib']);

  const merged = Object.fromEntries(stats.ratings.merged.map((entry) => [entry.score, entry.count]));
  assert.deepEqual(merged, { 6: 1, 7: 1 });
  assert.equal('bySource' in stats.ratings, false);

  // Metadata coverage: one resolved work (hc:100 via the link), two stubs.
  assert.deepEqual(stats.summary.metadata, {
    resolved: 1,
    total: 3,
    percent: 33,
    running: false,
    budgetRemaining: null,
  });

  // Calendar/timeline/streaks only for this profile's dated events.
  const timelineSum = stats.timeline.reduce((sum, entry) => sum + entry.finished, 0);
  assert.equal(timelineSum, stats.summary.finishedCount);
  assert.deepEqual(
    stats.timeline.map((entry) => [entry.month, entry.finished, entry.livelib, entry.hardcover]),
    [
      ['2024-03', 1, 1, 0],
      ['2024-04', 1, 1, 0],
    ]
  );
  assert.equal(stats.readDays.length, 2);
  assert.equal(stats.streaks.lastReadDate, '2024-04-01');

  // Metadata for the resolved work still comes from the details chain.
  assert.equal(dune.title, 'Дюна');
  assert.equal(stats.genres.find((genre) => genre.name === 'Science Fiction').count, 1);
  const herbert = stats.authors.find((author) => author.name === 'Фрэнк Герберт');
  assert.equal(herbert.count, 1);
  assert.equal(herbert.avgRating, 7);
  assert.equal(stats.series.find((entry) => entry.name === 'Дюны').count, 1);
  assert.equal(stats.publishers.find((entry) => entry.name === 'Chilton').count, 1);
  assert.equal(stats.summary.pagesTotal, 512);
  assert.equal(stats.summary.avgPages, 512);
  assert.equal(stats.summary.pageCount, stats.summary.pagesTotal);
  assert.equal(stats.summary.dateFrom, '2024-03-02');
  assert.equal(stats.summary.dateTo, '2024-04-01');
  assert.equal(stats.booksIndex['hc:100'].links.livelib, 'https://www.livelib.ru/book/9001');
  assert.equal(stats.unmatchedCount, 2);
  assert.equal(stats.recentlyFinished.length, 2);
  assert.equal(stats.recentlyFinished[0].date, '2024-04-01');
});

test('a Hardcover profile aggregates only the journal events', async () => {
  await seed();
  const stats = buildBooksStats({ profile: 'hardcover-34748' });

  assert.deepEqual(stats.sources.selected, ['hardcover']);
  assert.equal(stats.summary.eventCount, 2);
  assert.equal(stats.summary.bookCount, 2);
  assert.equal(stats.summary.unresolvedCount, 0);
  assert.deepEqual(
    Object.fromEntries(stats.ratings.merged.map((entry) => [entry.score, entry.count])),
    { 8: 1, 9: 1 }
  );
  // The journal carries its own metadata: coverage is 100%, badge hidden.
  assert.equal(stats.summary.metadata.resolved, 2);
  assert.equal(stats.summary.metadata.total, 2);
  assert.equal(stats.summary.metadata.percent, 100);
  assert.equal(stats.summary.metadata.running, false);
  assert.equal(stats.booksIndex['hc:100'].rating, 9);
  assert.deepEqual(stats.booksIndex['hc:100'].sources, ['hardcover']);
  assert.equal(stats.timeline.length, 1);
  assert.equal(stats.timeline[0].hardcover, 2);
  assert.equal(stats.summary.pagesTotal, 912);
  assert.equal(stats.summary.avgPages, 456);
  assert.equal(stats.summary.dateFrom, '2024-03-02');
  assert.equal(stats.summary.dateTo, '2024-03-03');
});

test('the payload carries no source-filter block any more', async () => {
  await seed();
  const stats = buildBooksStats({ profile: 'livelib-tester' });
  assert.deepEqual(stats.sources.selected, ['livelib']);
  assert.equal('filter' in stats.sources, false);
  assert.equal(stats.summary.eventCount, 3);

  // An old option object cannot re-introduce a filter: the field is gone.
  const withLegacyOption = buildBooksStats({ profile: 'livelib-tester', sources: 'hardcover' });
  assert.deepEqual(withLegacyOption.sources.selected, ['livelib']);
  assert.equal(withLegacyOption.summary.eventCount, 3);
});

test('a missing or ambiguous profile is a 400-shaped error, never a union', () => {
  assert.throws(
    () => buildBooksStats({}),
    (error) => error.code === 'profile_required' && error.status === 400
  );
  assert.throws(
    () => buildBooksStats({ profile: 'livelib-tester,hardcover-34748' }),
    (error) => error.code === 'profile_required' && /Exactly one/.test(error.message)
  );
});

test('empty profile returns a stable empty payload', async () => {
  await bookCache.saveProfile('livelib', 'nobody', {
    schemaVersion: 1,
    source: 'livelib',
    userKey: 'nobody',
    importedAt: '2026-10-27T00:00:00.000Z',
    events: [],
    warnings: [],
  });
  const stats = buildBooksStats({ profile: 'livelib-nobody' });
  assert.equal(stats.summary.bookCount, 0);
  assert.equal(stats.summary.eventCount, 0);
  assert.equal(stats.summary.undatedEventCount, 0);
  assert.deepEqual(stats.timeline, []);
  assert.equal(stats.streaks.current, 0);
  assert.deepEqual(stats.booksIndex, {});
});
