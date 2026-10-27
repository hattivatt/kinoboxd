'use strict';

/**
 * Books stats: series-level manga/comics propagation.
 *
 * Hardcover tags are inconsistent inside one series (comics on some volumes,
 * plain "Fantasy" or no genres on others). A single comics volume must mark
 * the whole series as comics for the default filter — and only for that
 * series: standalone works keep their own tri-state flag.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-series-'));

const bookCache = require('../server/books/book-cache');
const { buildBooksStats, propagateSeriesManga } = require('../server/books/stats');

async function details(workId, doc) {
  await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), {
    schemaVersion: 2,
    workId,
    ...doc,
  });
}

function hcEvent(bookId, title, finishedAt) {
  return {
    id: `hc:read:${bookId}`,
    source: 'hardcover',
    sourceBookId: String(bookId),
    workId: `hc:${bookId}`,
    title,
    authors: ['Bill Willingham'],
    status: 'read',
    statusId: 3,
    finishedAt,
    edition: {},
  };
}

test.before(async () => {
  // Fables: vol A explicit comics, vol B explicit clean genres, vol C no genres.
  await details('hc:701', {
    title: 'Fables, Vol. 6',
    authors: [{ name: 'Bill Willingham' }],
    genres: ['Graphic Novels', 'Fantasy'],
    series: [{ hcId: 2700, name: 'Fables', position: 6 }],
    mangaComics: true,
  });
  await details('hc:702', {
    title: 'Fables, Vol. 14',
    authors: [{ name: 'Bill Willingham' }],
    genres: ['Fantasy', 'Adventure'],
    series: [{ hcId: 2700, name: 'Fables', position: 14 }],
    mangaComics: false,
  });
  await details('hc:703', {
    title: 'Fables, Vol. 22',
    authors: [{ name: 'Bill Willingham' }],
    genres: [],
    series: [{ hcId: 2700, name: 'Fables', position: 22 }],
    mangaComics: null,
  });

  // Name-only series (LiveLib-shaped strings) with case/spacing differences.
  await details('hc:810', {
    title: 'Homunculus 1',
    authors: [{ name: 'Hideo Yamamoto' }],
    genres: ['Comics'],
    series: [{ name: 'Homunculus' }],
    mangaComics: true,
  });
  await details('hc:811', {
    title: 'Homunculus 2',
    authors: [{ name: 'Hideo Yamamoto' }],
    genres: [],
    series: [{ name: '  homunculus ' }],
    mangaComics: null,
  });

  // Standalone works and a clean series must not be touched.
  await details('hc:801', {
    title: 'Обычный роман',
    authors: [{ name: 'Иван Петров' }],
    genres: ['Fantasy'],
    series: [],
    mangaComics: false,
  });
  await details('hc:802', {
    title: 'Неизвестная книга',
    authors: [{ name: 'Иван Петров' }],
    genres: [],
    series: [],
    mangaComics: null,
  });
  await details('hc:820', {
    title: 'Цикл A',
    authors: [{ name: 'Иван Петров' }],
    genres: ['Fantasy'],
    series: [{ hcId: 500, name: 'Чистый цикл', position: 1 }],
    mangaComics: false,
  });
  await details('hc:821', {
    title: 'Цикл B',
    authors: [{ name: 'Иван Петров' }],
    genres: ['Fantasy'],
    series: [{ hcId: 500, name: 'Чистый цикл', position: 2 }],
    mangaComics: false,
  });

  await bookCache.saveProfile('hardcover', '34748', {
    schemaVersion: 1,
    source: 'hardcover',
    userKey: '34748',
    importedAt: '2026-10-27T00:00:00.000Z',
    events: [
      hcEvent(701, 'Fables, Vol. 6', '2025-01-01'),
      hcEvent(702, 'Fables, Vol. 14', '2025-01-02'),
      hcEvent(703, 'Fables, Vol. 22', '2025-01-03'),
      hcEvent(810, 'Homunculus 1', '2025-02-01'),
      hcEvent(811, 'Homunculus 2', '2025-02-02'),
      hcEvent(801, 'Обычный роман', '2025-03-01'),
      hcEvent(802, 'Неизвестная книга', '2025-03-02'),
      hcEvent(820, 'Цикл A', '2025-04-01'),
      hcEvent(821, 'Цикл B', '2025-04-02'),
    ],
  });
  bookCache.flushLinks();
});

test('propagateSeriesManga flags every volume of a comics series only', () => {
  const works = new Map([
    ['a', { workId: 'a', mangaComics: true, series: [{ hcId: 1, name: 'S' }] }],
    ['b', { workId: 'b', mangaComics: false, series: [{ hcId: 1, name: 'S' }] }],
    ['c', { workId: 'c', mangaComics: null, series: [{ hcId: 1, name: 'S' }] }],
    ['d', { workId: 'd', mangaComics: false, series: [{ hcId: 2, name: 'Other' }] }],
    ['e', { workId: 'e', mangaComics: null, series: [] }],
  ]);
  const propagated = propagateSeriesManga(works);
  assert.deepEqual([...propagated].sort(), ['b', 'c']);
  assert.equal(works.get('a').mangaComics, true);
  assert.equal(works.get('b').mangaComics, true);
  assert.equal(works.get('b').mangaComicsSource, 'series');
  assert.equal(works.get('c').mangaComics, true);
  // The clean series and the standalone works keep their own flags.
  assert.equal(works.get('d').mangaComics, false);
  assert.equal(works.get('e').mangaComics, null);
});

test('default payload excludes all Fables/Homunculus volumes', () => {
  const stats = buildBooksStats({});
  assert.equal(stats.summary.includeMangaComics, false);
  // 5 excluded (3 Fables + 2 Homunculus), 4 kept (2 standalone + 2 clean).
  assert.equal(stats.summary.mangaExcluded, 5);
  assert.equal(stats.summary.mangaSeriesExcluded, 3); // all but the own-flag-true 701/810
  assert.equal(stats.summary.mangaSeriesPropagated, 3);
  assert.equal(stats.summary.bookCount, 4);
  assert.equal(stats.summary.eventCount, 4);

  for (const workId of ['hc:701', 'hc:702', 'hc:703', 'hc:810', 'hc:811']) {
    assert.equal(stats.booksIndex[workId], undefined, workId);
  }
  assert.ok(stats.booksIndex['hc:801']);
  assert.ok(stats.booksIndex['hc:802']);
  assert.ok(stats.booksIndex['hc:820']);
  assert.ok(stats.booksIndex['hc:821']);

  assert.equal(stats.series.some((entry) => entry.name === 'Fables'), false);
  assert.equal(stats.series.some((entry) => /homunculus/i.test(entry.name)), false);
  assert.ok(stats.series.some((entry) => entry.name === 'Чистый цикл'));

  // Series/genre/author/timeline sums exclude the propagated works.
  assert.equal(stats.genres.some((entry) => entry.name === 'Graphic Novels'), false);
  assert.equal(stats.authors.some((entry) => entry.name === 'Bill Willingham'), false);
  assert.equal(stats.authors.some((entry) => entry.name === 'Hideo Yamamoto'), false);
  assert.equal(stats.readDays.some((day) => day.date === '2025-01-02'), false);
  assert.equal(stats.readDays.some((day) => day.date === '2025-01-01'), false);
  assert.ok(stats.readDays.some((day) => day.date === '2025-03-01'));
});

test('includeMangaComics=1 restores them and marks the series provenance', () => {
  const stats = buildBooksStats({ includeMangaComics: true });
  assert.equal(stats.summary.bookCount, 9);
  assert.equal(stats.summary.eventCount, 9);
  assert.equal(stats.summary.mangaExcluded, 0);
  assert.equal(stats.summary.mangaSeriesExcluded, 0);
  assert.equal(stats.summary.mangaSeriesPropagated, 3);

  assert.equal(stats.booksIndex['hc:702'].mangaComics, true);
  assert.equal(stats.booksIndex['hc:702'].mangaComicsSource, 'series');
  assert.equal(stats.booksIndex['hc:703'].mangaComics, true);
  assert.equal(stats.booksIndex['hc:811'].mangaComics, true);
  // own flag true -> no series provenance marker
  assert.equal(stats.booksIndex['hc:701'].mangaComics, true);
  assert.equal(stats.booksIndex['hc:701'].mangaComicsSource, undefined);
  // standalone null survives untouched
  assert.equal(stats.booksIndex['hc:802'].mangaComics, null);
  assert.equal(stats.booksIndex['hc:820'].mangaComics, false);
});
