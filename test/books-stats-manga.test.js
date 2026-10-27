'use strict';

/**
 * Books stats: manga/comics filter (default OFF), tri-state null survival,
 * cross-source dedupe (LiveLib + Google Books = one work) and schema
 * compatibility of the existing payload.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-manga-'));

const bookCache = require('../server/books/book-cache');
const { buildBooksStats } = require('../server/books/stats');

async function details(workId, doc) {
  await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), {
    schemaVersion: 2,
    workId,
    ...doc,
  });
}

async function link(bookId, workId) {
  await bookCache.saveLink(bookId, {
    schemaVersion: 2,
    livelibBookId: String(bookId),
    workId,
    method: 'isbn',
    score: 1,
    evidence: { isbn: '9780441013593' },
  });
}

test.before(async () => {
  await details('hc:100', {
    title: 'Дюна',
    authors: [{ name: 'Фрэнк Герберт' }],
    genres: ['Science Fiction'],
    series: [{ hcId: 5, name: 'Дюны', position: 1 }],
    pages: 512,
    publicationYear: 1965,
    publisher: 'Chilton',
    coverUrl: 'https://example.test/dune.jpg',
    metadataSources: ['hardcover'],
    sources: [{ source: 'hardcover', sourceId: '100', url: 'https://hardcover.app/books/dune' }],
    mangaComics: false,
  });
  await details('gb:vol-dupe', {
    title: 'Дюна',
    authors: [{ name: 'Фрэнк Герберт' }],
    genres: ['Science Fiction', 'Adventure'],
    pages: 704,
    publicationYear: 2016,
    publisher: 'АСТ',
    metadataSources: ['googlebooks'],
    sources: [
      { source: 'googlebooks', sourceId: 'vol-dupe', url: 'https://books.google.com/books?id=vol-dupe' },
    ],
    mangaComics: false,
  });
  await details('gb:vol-naruto', {
    title: 'Наруто',
    authors: [{ name: 'Масаси Кисимото' }],
    genres: ['Manga', 'Action'],
    series: [{ hcId: null, name: 'Наруто', position: 1 }],
    pages: 192,
    publicationYear: 1999,
    publisher: 'Jump',
    metadataSources: ['googlebooks'],
    mangaComics: true,
  });

  await link('9001', 'hc:100');
  await link('9002', 'gb:vol-dupe');
  await link('9004', 'gb:vol-naruto');

  await bookCache.saveProfile('livelib', 'tester', {
    schemaVersion: 1,
    source: 'livelib',
    userKey: 'tester',
    importedAt: '2026-10-27T00:00:00.000Z',
    events: [
      {
        id: 'll:9001',
        source: 'livelib',
        sourceBookId: '9001',
        workId: null,
        title: 'Дюна',
        authors: ['Фрэнк Герберт'],
        rating: 9,
        ratingScale: 10,
        rating10: 9,
        status: 'read',
        finishedAt: '2024-03-02',
        edition: { publisher: null, year: 2016, isbn: '9780441013593' },
      },
      {
        id: 'll:9002',
        source: 'livelib',
        sourceBookId: '9002',
        workId: null,
        title: 'Дюна',
        authors: ['Фрэнк Герберт'],
        rating: 8,
        ratingScale: 10,
        rating10: 8,
        status: 'read',
        finishedAt: '2024-03-02',
        edition: { publisher: null, year: 2016, isbn: null },
      },
      {
        id: 'll:9003',
        source: 'livelib',
        sourceBookId: '9003',
        workId: null,
        title: 'Неизвестная книга',
        authors: ['Никто Никтович'],
        rating: 5,
        ratingScale: 10,
        rating10: 5,
        status: 'read',
        finishedAt: '2024-03-04',
        edition: { publisher: null, year: 2020, isbn: null },
      },
      {
        id: 'll:9004',
        source: 'livelib',
        sourceBookId: '9004',
        workId: null,
        title: 'Наруто',
        authors: ['Масаси Кисимото'],
        rating: 7,
        ratingScale: 10,
        rating10: 7,
        status: 'read',
        finishedAt: '2024-03-03',
        edition: { publisher: null, year: 1999, isbn: null },
      },
    ],
  });

  await bookCache.saveProfile('hardcover', '34748', {
    schemaVersion: 1,
    source: 'hardcover',
    userKey: '34748',
    importedAt: '2026-10-27T00:00:00.000Z',
    events: [
      {
        id: 'hc:read:1',
        source: 'hardcover',
        sourceBookId: '100',
        workId: 'hc:100',
        title: 'Dune',
        authors: ['Фрэнк Герберт'],
        rating: 4.5,
        ratingScale: 5,
        rating10: 9,
        status: 'read',
        finishedAt: '2023-01-10',
        edition: { publisher: null, year: 1965, isbn: null },
      },
    ],
  });
  bookCache.flushLinks();
});

test('default payload excludes manga works but keeps unknown flags', () => {
  const stats = buildBooksStats({});
  assert.equal(stats.summary.includeMangaComics, false);
  assert.equal(stats.summary.mangaExcluded, 1);
  assert.equal(stats.summary.bookCount, 2);
  assert.equal(stats.summary.eventCount, 4);
  assert.equal(Object.keys(stats.booksIndex).length, stats.summary.bookCount);

  assert.equal(stats.booksIndex['gb:vol-naruto'], undefined);
  assert.equal(stats.booksIndex['ll:9003'] !== undefined, true);

  assert.equal(stats.genres.some((entry) => entry.name === 'Manga'), false);
  assert.equal(stats.authors.some((entry) => entry.name === 'Масаси Кисимото'), false);
  assert.equal(stats.series.some((entry) => entry.name === 'Наруто'), false);
  assert.equal(stats.publishers.some((entry) => entry.name === 'Jump'), false);
  assert.equal(stats.years.some((entry) => entry.year === 1999), false);
  assert.equal(stats.readDays.some((entry) => entry.date === '2024-03-03'), false);

  // LL stub with mangaComics=null survives the default filter.
  assert.equal(stats.booksIndex['ll:9003'].mangaComics, null);
  assert.equal(stats.unmatchedCount, 1);
  // Metadata resolved counts: 9001 (hc), 9002 (gb, deduped into hc), 9004 is
  // filtered out with its manga work; 9003 has no metadata.
  assert.equal(stats.summary.resolvedCount, 2);
  assert.equal(stats.summary.unresolvedCount, 1);
});

test('includeMangaComics=1 brings manga back into every widget', () => {
  const stats = buildBooksStats({ includeMangaComics: true });
  assert.equal(stats.summary.includeMangaComics, true);
  assert.equal(stats.summary.mangaExcluded, 0);
  assert.equal(stats.summary.bookCount, 3);
  assert.equal(stats.summary.eventCount, 5);
  assert.equal(Object.keys(stats.booksIndex).length, 3);
  assert.ok(stats.genres.some((entry) => entry.name === 'Manga'));
  assert.ok(stats.authors.some((entry) => entry.name === 'Масаси Кисимото'));
  assert.ok(stats.readDays.some((entry) => entry.date === '2024-03-03'));
});

test('the same book via LiveLib links + Google Books dedupes into one work', () => {
  for (const options of [{}, { includeMangaComics: true }]) {
    const stats = buildBooksStats(options);
    assert.equal(stats.booksIndex['gb:vol-dupe'], undefined);
    const dune = stats.booksIndex['hc:100'];
    assert.ok(dune);
    assert.deepEqual(dune.mergedWorkIds.sort(), ['gb:vol-dupe', 'hc:100'].sort());
    assert.deepEqual(dune.sources, ['hardcover', 'livelib']);
    assert.deepEqual(dune.metadataSources.sort(), ['googlebooks', 'hardcover'].sort());
    // One work, both LL events + the hardcover event.
    assert.equal(dune.pages, 512);
    assert.equal(stats.genres.find((entry) => entry.name === 'Science Fiction').count, 1);
  }
});

test('HTTP route: includeMangaComics default off, 1 includes, invalid rejected', async (t) => {
  const express = require('express');
  const routes = require('../server/books/routes');
  const app = express();
  app.use(express.json());
  app.use('/api/books', routes);
  app.use((err, req, res, next) => {
    res.status(err.status || err.statusCode || 500).json({ code: err.code, error: err.message });
  });
  const server = app.listen(5811);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:5811/api/books/stats';

  const off = await fetch(base);
  assert.equal(off.status, 200);
  const offBody = await off.json();
  assert.equal(offBody.summary.includeMangaComics, false);
  assert.equal(offBody.summary.mangaExcluded, 1);
  assert.equal(offBody.booksIndex['gb:vol-naruto'], undefined);

  const on = await fetch(`${base}?includeMangaComics=1`);
  assert.equal(on.status, 200);
  const onBody = await on.json();
  assert.equal(onBody.summary.includeMangaComics, true);
  assert.ok(onBody.booksIndex['gb:vol-naruto']);

  const bad = await fetch(`${base}?includeMangaComics=2`);
  assert.equal(bad.status, 400);
  const badBody = await bad.json();
  assert.equal(badBody.code, 'invalid_include_manga');
});

test('payload schema stays compatible: old fields keep their place and meaning', () => {
  const stats = buildBooksStats({});
  for (const key of [
    'sources',
    'summary',
    'sourceBreakdown',
    'ratings',
    'genres',
    'decades',
    'years',
    'timeline',
    'readDays',
    'streaks',
    'recentlyFinished',
    'authors',
    'series',
    'publishers',
    'pagesHistogram',
    'booksIndex',
    'unmatchedCount',
    'unmatched',
    'meta',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(stats, key), `missing ${key}`);
  }
  assert.equal(stats.ratings.scale, 10);
  assert.deepEqual(stats.sources.connected.sort(), ['hardcover', 'livelib']);
  assert.deepEqual(stats.sources.selected.sort(), ['hardcover', 'livelib']);
  assert.equal(stats.summary.sources.length, 2);
  assert.equal(stats.sourceBreakdown.reduce((sum, entry) => sum + entry.events, 0), stats.summary.eventCount);
  assert.equal(stats.ratings.merged.length > 0, true);
  // Extension only: new fields are additive.
  assert.equal(typeof stats.summary.mangaExcluded, 'number');
  assert.equal(typeof stats.summary.canonicalResolvedCount, 'number');
  const dune = stats.booksIndex['hc:100'];
  assert.equal(Array.isArray(dune.metadataSources), true);
  assert.equal(dune.mangaComics, false);
});
