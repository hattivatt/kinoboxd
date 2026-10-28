'use strict';

/**
 * Book counting after the 28.10.2026 user verdict:
 *   - every LiveLib export row is a book/volume, even when several rows share
 *     one `/work/…` page (manga volumes). `resolved workId` enriches metadata,
 *     it does not dedupe bookCount;
 *   - an exact-identical row with the same book id is an export artifact;
 *   - Литрес catalogue tags never become series;
 *   - sub-series with the same books collapse to the larger/plainer one;
 *   - the year chart uses the work's first publication (ancient bucket);
 *   - «Недавно читал» includes month-precision events.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-book-identity-'));
process.env.KINOBOXD_CACHE_BOOK_DIR = CACHE;

const bookCache = require('../server/books/book-cache');
const livelibFile = require('../server/books/livelib-file');
const { buildBooksStats, dedupeSeriesSubsets } = require('../server/books/stats');

function profile(userKey, events) {
  return {
    schemaVersion: 1,
    source: 'livelib',
    userKey,
    sourceUserId: null,
    importedAt: '2026-10-28T00:00:00.000Z',
    events,
    warnings: [],
  };
}

function event(id, title, extra = {}) {
  return {
    id,
    source: 'livelib',
    sourceBookId: null,
    title,
    authors: extra.authors || ['Хадзимэ Исаяма'],
    rating: extra.rating == null ? null : extra.rating,
    ratingScale: 10,
    rating10: extra.rating == null ? null : extra.rating,
    status: 'read',
    shelf: 'read',
    origin: 'livelib-file',
    finishedAt: extra.finishedAt || null,
    readMonth: extra.readMonth || null,
    edition: { publisher: null, year: extra.year || null, isbn: null, language: 'ru', series: extra.series || null },
    genres: extra.genres || [],
    ...extra.raw,
  };
}

test('every export row counts as a separate volume, even under one work', async () => {
  // Six rows of one `/work/…` page with different ratings/dates: six books.
  const events = Array.from({ length: 6 }, (_, index) =>
    event(`llfile:tk:issayama:read#${index + 1}`, 'Вторжение гигантов', {
      rating: index % 2 === 0 ? 9 : 10,
      readMonth: index === 5 ? '2015-05' : '2014-12',
      raw: { sourceBookId: '9001' },
    })
  );
  await bookCache.saveProfile('livelib', 'Volumes', profile('Volumes', events));

  const stats = buildBooksStats({ profile: 'livelib-Volumes', includeMangaComics: true });
  assert.equal(stats.summary.eventCount, 6);
  assert.equal(stats.summary.bookCount, 6, 'volumes must not collapse into one resolved work');
  assert.equal(Object.keys(stats.booksIndex).length, 6);
  assert.equal(stats.summary.reReadCount, 0, 'LiveLib rows are never re-reads');
  const workIds = Object.keys(stats.booksIndex);
  assert.ok(workIds.includes('ll:9001'));
  assert.ok(workIds.includes('ll:9001#2'));
  // Metadata identity stays the canonical work for every volume.
  assert.ok(Object.values(stats.booksIndex).every((book) => book.workId.startsWith('ll:9001')));
});

test('exact-identical rows of one book id are dropped, rows without ids are volumes', () => {
  const row = {
    bookHref: 'https://www.livelib.ru/book/1000496048-unesennye-vetrom',
    title: 'Унесенные ветром',
    readDate: 'Ноябрь 2014 г.',
    rating: { user: '5' },
    authors: [{ name: 'Маргарет Митчелл' }],
  };
  const parsed = livelibFile.parseExportFile(JSON.stringify([row, row, { ...row, readDate: '2002 г.' }]), {
    filename: 'read.json',
  });
  assert.equal(parsed.stats.books, 2);
  assert.equal(parsed.stats.exactDuplicateRows, 1);

  // A `/work/…` row has no book id: byte-identical rows are volumes.
  const workRow = {
    bookHref: 'https://www.livelib.ru/work/1000321539-bolshoj-kush',
    title: 'Большой куш',
    readDate: 'Январь 2010 г.',
    rating: { user: '4.5' },
    authors: [{ name: 'Эйитиро Ода' }],
  };
  const volumes = livelibFile.parseExportFile(JSON.stringify([workRow, workRow, workRow]), {
    filename: 'read.json',
  });
  assert.equal(volumes.stats.books, 3);
  assert.equal(volumes.stats.exactDuplicateRows, 0);
});

test('a Литрес catalogue tag does not become a series, even when the file column names it', async () => {
  await bookCache.saveDetails(7101, {
    schemaVersion: 2,
    hcWorkId: 7101,
    title: 'Книга',
    authors: [{ hcId: 1, name: 'Автор' }],
    series: [{ name: 'Книга на все времена', position: null, source: 'litres' }],
    genres: [],
    metadataSources: ['litres'],
  });
  await bookCache.saveLink('7101', { schemaVersion: 2, livelibBookId: '7101', workId: 'hc:7101', method: 'isbn', score: 1 });
  await bookCache.saveProfile(
    'livelib',
    'PseudoSeries',
    profile('PseudoSeries', [
      event('ll:7101', 'Книга', { raw: { sourceBookId: '7101' }, readMonth: '2020-01' }),
    ])
  );
  const noSeries = buildBooksStats({ profile: 'livelib-PseudoSeries', includeMangaComics: true });
  assert.deepEqual(noSeries.series, []);

  await bookCache.saveDetails(7101, {
    schemaVersion: 2,
    hcWorkId: 7101,
    title: 'Книга',
    authors: [{ hcId: 1, name: 'Автор' }],
    series: [{ name: 'Книга на все времена', position: null, source: 'litres' }],
    genres: [],
    metadataSources: ['litres'],
  });
  const withFileSeriesProfile = profile('FileSeries', [
    event('ll:7101', 'Книга', {
      raw: { sourceBookId: '7101' },
      readMonth: '2020-01',
      series: 'Книга на все времена',
    }),
  ]);
  await bookCache.saveProfile('livelib', 'FileSeries', withFileSeriesProfile);
  const withFileSeries = buildBooksStats({ profile: 'livelib-FileSeries', includeMangaComics: true });
  // 28.10.2026 (user decision): the export column is the authority for a
  // bibliographic *value*, not for the *kind* of the value. This is a
  // publisher's tag, so the blacklist removes it even when the file names it
  // (series-blacklist.js).
  assert.deepEqual(withFileSeries.series.map((entry) => entry.name), []);
  assert.equal(withFileSeries.summary.seriesTagsFiltered, 1);
  assert.equal(withFileSeries.summary.seriesCount, 0);

  await bookCache.saveDetails(7101, {
    schemaVersion: 2,
    hcWorkId: 7101,
    title: 'Книга',
    authors: [{ hcId: 1, name: 'Автор' }],
    series: [{ name: 'Настоящая серия', position: 3, source: 'litres' }],
    genres: [],
    metadataSources: ['litres'],
  });
  const ordered = buildBooksStats({ profile: 'livelib-PseudoSeries', includeMangaComics: true });
  assert.deepEqual(ordered.series.map((entry) => entry.name), ['Настоящая серия']);
});

test('series with the same books collapse to the larger/plainer one', () => {
  const list = [
    { name: 'The Witcher (Publication order)', count: 2, works: [{ workId: 'a' }, { workId: 'b' }] },
    { name: 'The Witcher', count: 2, works: [{ workId: 'a' }, { workId: 'b' }] },
    { name: 'Ведьмак. Сага', count: 1, works: [{ workId: 'a' }] },
    { name: 'Другая серия', count: 1, works: [{ workId: 'c' }] },
  ];
  assert.deepEqual(dedupeSeriesSubsets(list).map((entry) => entry.name), ['The Witcher', 'Другая серия']);
});

test('the year chart uses first publication and buckets ancient works', async () => {
  await bookCache.saveDetails(7201, {
    schemaVersion: 2,
    hcWorkId: 7201,
    title: 'Искусство войны',
    authors: [{ hcId: 2, name: 'Сунь Цзы' }],
    series: [],
    genres: [],
    publicationYear: 2013, // the print edition in hand
    firstPublishedYear: -500, // the work itself
    metadataSources: ['openlibrary'],
  });
  await bookCache.saveLink('7201', { schemaVersion: 2, livelibBookId: '7201', workId: 'hc:7201', method: 'isbn', score: 1 });
  await bookCache.saveProfile(
    'livelib',
    'Ancient',
    profile('Ancient', [
      event('ll:7201', 'Искусство войны', {
        raw: { sourceBookId: '7201' },
        authors: ['Сунь-Цзы'],
        year: 2019,
        readMonth: '2021-05',
      }),
    ])
  );
  const stats = buildBooksStats({ profile: 'livelib-Ancient', includeMangaComics: true });
  const book = Object.values(stats.booksIndex)[0];
  assert.equal(book.year, -500);
  assert.equal(stats.summary.ancientBookCount, 1);
  assert.deepEqual(stats.years, []);
  assert.ok(stats.decades.some((entry) => entry.label === 'до 1000 г.' && entry.count === 1));
});

test('recently read includes month-precision file events', async () => {
  await bookCache.saveProfile(
    'livelib',
    'RecentMonths',
    profile('RecentMonths', [
      event('ll:1', 'Мартин Иден', { readMonth: '2023-03' }),
      event('ll:2', 'Стезя смерти', { readMonth: '2024-01' }),
      event('ll:3', 'Без даты'),
    ])
  );
  const stats = buildBooksStats({ profile: 'livelib-RecentMonths', includeMangaComics: true });
  assert.equal(stats.recentlyFinished.length, 2);
  assert.deepEqual(
    stats.recentlyFinished.map((entry) => [entry.date, entry.precision]),
    [['2024-01', 'month'], ['2023-03', 'month']]
  );
});
