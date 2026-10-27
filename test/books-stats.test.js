'use strict';

/**
 * /api/books/stats aggregation: union of sources, work dedupe, option A rating
 * priority, calendar only for dated events, ?sources= filter.
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

test('union aggregation with work dedupe and option A ratings', async () => {
  await seed();
  const stats = buildBooksStats();

  assert.deepEqual(stats.sources.connected.sort(), ['hardcover', 'livelib']);
  assert.deepEqual(stats.sources.selected.sort(), ['hardcover', 'livelib']);

  assert.equal(stats.summary.eventCount, 5);
  // hc:100, hc:101, ll:9002, ll:9003 (unresolved stub)
  assert.equal(stats.summary.bookCount, 4);
  assert.equal(stats.summary.finishedCount, 4);
  assert.equal(stats.summary.undatedEventCount, 1);
  assert.equal(stats.summary.resolvedCount, 1);
  assert.equal(stats.summary.unresolvedCount, 2);

  // Hardcover priority for the shared work, LiveLib keeps its own value.
  const dune = stats.booksIndex['hc:100'];
  assert.equal(dune.rating, 9);
  assert.equal(dune.ratingsBySource.hardcover.rating10, 9);
  assert.equal(dune.ratingsBySource.livelib.rating10, 7);

  const merged = Object.fromEntries(stats.ratings.merged.map((entry) => [entry.score, entry.count]));
  assert.deepEqual(merged, { 6: 1, 8: 1, 9: 1 });
  const ll = Object.fromEntries(stats.ratings.bySource.livelib.map((entry) => [entry.score, entry.count]));
  assert.deepEqual(ll, { 6: 1, 7: 1 });
  const hc = Object.fromEntries(stats.ratings.bySource.hardcover.map((entry) => [entry.score, entry.count]));
  assert.deepEqual(hc, { 8: 1, 9: 1 });

  // Calendar/timeline only for dated events; both sources count separately.
  const timelineSum = stats.timeline.reduce((sum, entry) => sum + entry.finished, 0);
  assert.equal(timelineSum, stats.summary.finishedCount);
  assert.equal(stats.timeline.length, 2);
  assert.deepEqual(
    stats.timeline.map((entry) => [entry.month, entry.finished, entry.livelib, entry.hardcover]),
    [
      ['2024-03', 3, 1, 2],
      ['2024-04', 1, 1, 0],
    ]
  );
  assert.equal(stats.readDays.length, 3);
  assert.equal(stats.streaks.lastReadDate, '2024-04-01');
  assert.equal(stats.streaks.best >= 1, true);

  // Widgets from Hardcover metadata.
  assert.equal(stats.genres.find((genre) => genre.name === 'Science Fiction').count, 1);
  const herbert = stats.authors.find((author) => author.name === 'Фрэнк Герберт');
  assert.equal(herbert.count, 1);
  assert.equal(herbert.avgRating, 9);
  const duneSeries = stats.series.find((entry) => entry.name === 'Дюны');
  assert.equal(duneSeries.count, 1);
  assert.equal(duneSeries.works[0].workId, 'hc:100');
  assert.equal(stats.publishers.find((entry) => entry.name === 'Chilton').count, 1);
  assert.equal(stats.summary.pagesTotal, 912);
  assert.equal(stats.summary.avgPages, 456);
  // Film-contract aliases consumed by the frontend (period card, pages tile).
  assert.equal(stats.summary.pageCount, stats.summary.pagesTotal);
  assert.equal(stats.summary.dateFrom, '2024-03-02');
  assert.equal(stats.summary.dateTo, '2024-04-01');
  // Link menu is derivable from links.json for merged works.
  assert.equal(stats.booksIndex['hc:100'].links.livelib, 'https://www.livelib.ru/book/9001');
  assert.equal(stats.unmatchedCount, 2);
  assert.equal(stats.recentlyFinished.length, 4);
  assert.equal(stats.recentlyFinished[0].date, '2024-04-01');
});

test('?sources=livelib filters events but keeps work metadata', async () => {
  await seed();
  const stats = buildBooksStats({ sources: 'livelib' });
  assert.deepEqual(stats.sources.selected, ['livelib']);
  assert.equal(stats.summary.eventCount, 3);
  assert.equal(stats.summary.bookCount, 3); // hc:100 via link + two stubs
  assert.equal(stats.summary.finishedCount, 2);
  assert.equal(stats.summary.undatedEventCount, 1);
  assert.equal(stats.sourceBreakdown.length, 1);
  assert.equal(stats.sourceBreakdown[0].source, 'livelib');
  // Metadata for the resolved work still comes from Hardcover details.
  assert.equal(stats.booksIndex['hc:100'].title, 'Дюна');
  assert.equal(stats.booksIndex['hc:100'].rating, 7);
  const timelineSum = stats.timeline.reduce((sum, entry) => sum + entry.finished, 0);
  assert.equal(timelineSum, 2);
});

test('?sources=hardcover excludes LiveLib events', async () => {
  await seed();
  const stats = buildBooksStats({ sources: 'hardcover' });
  assert.equal(stats.summary.eventCount, 2);
  assert.equal(stats.summary.bookCount, 2);
  assert.equal(stats.summary.unresolvedCount, 0);
  assert.deepEqual(stats.ratings.bySource.livelib, []);
});

test('empty profile returns a stable empty payload', () => {
  for (const name of fs.readdirSync(bookCache.PROFILES_DIR)) {
    fs.unlinkSync(path.join(bookCache.PROFILES_DIR, name));
  }
  bookCache.clearMemory();
  const stats = buildBooksStats();
  assert.equal(stats.summary.bookCount, 0);
  assert.equal(stats.summary.eventCount, 0);
  assert.deepEqual(stats.sources.connected, []);
  assert.deepEqual(stats.timeline, []);
  assert.equal(stats.streaks.current, 0);
});
