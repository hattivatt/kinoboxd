'use strict';

/**
 * The legacy year channel of the decade/year charts (round 29.10.2026).
 *
 * Before ef593a8 the chart read, in order: `details.firstPublishedYear` →
 * `details.publicationYear` → the event/file `edition.year`. It also *silently
 * dropped* works with no year, which is why «год неизвестен» never appeared:
 * the chart simply showed fewer books than `bookCount`.
 *
 * Pinned here:
 *   - the legacy fallback is the print run: the export/file column
 *     (`edition.year`, the reader's own «Год издания») first, then the details
 *     document's `publicationYear`; both are marked `yearSource: 'edition'`
 *     and `editionYearSource: 'file' | 'details'`, never as a first edition;
 *   - an ancient `publicationYear` survives (the pre-ef593a8 code used the
 *     ancient bound for that field), a year 0 does not;
 *   - priority stays `manual > firstPublishedYear > edition`;
 *   - a re-import of an export that carries the year column enriches existing
 *     events (`mergeFileIntoProfile`) and the years appear in stats — no live
 *     request, the file is the data source;
 *   - works with no year at all stay out of the decade bars but are counted
 *     honestly: `years` sum + `summary.yearUnknownCount` = `bookCount`
 *     (the old chart's silent drop is what we must never reintroduce).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-year-legacy-'));

const bookCache = require('../server/books/book-cache');
const { buildBooksStats, resolveWorkYear } = require('../server/books/stats');
const { parseExportFile, mergeFileIntoProfile } = require('../server/books/livelib-file');

function profile(userKey, events) {
  return {
    schemaVersion: 1,
    source: 'livelib',
    userKey,
    sourceUserId: null,
    importedAt: '2026-10-29T00:00:00.000Z',
    events,
    warnings: [],
  };
}

function fileEvent({ id, title, year = null, isbn = null, shelf = 'read' }) {
  return {
    id: `llfile:id:${id}:${shelf}`,
    fileKey: `id:${id}`,
    source: 'livelib-file',
    origin: 'livelib-file',
    sourceBookId: String(id),
    sourceUrl: `https://www.livelib.ru/book/${id}`,
    workId: null,
    title,
    authors: ['Тестовый Автор'],
    rating: 4,
    ratingScale: 5,
    rating10: 8,
    status: 'read',
    shelf,
    startedAt: null,
    finishedAt: null,
    readMonth: '2026-09',
    readDateRaw: 'Сентябрь 2026 г.',
    reread: false,
    readIndex: 1,
    edition: {
      publisher: 'Тест',
      year,
      isbn: isbn || null,
      isbn13: isbn || null,
      isbn10: null,
      language: 'ru',
      series: null,
    },
    genres: ['Проза'],
    coverUrl: null,
    communityRating: null,
    bookStats: null,
  };
}

/* ------------------------------------------------------------------ */
/* resolveWorkYear: the legacy channels                                */
/* ------------------------------------------------------------------ */

test('legacy year: the export/file column wins and is marked as a file edition year', () => {
  const info = resolveWorkYear({}, { edition: { year: 2019 } }, { year: 2019 }, null);
  assert.equal(info.year, 2019);
  assert.equal(info.yearSource, 'edition');
  assert.equal(info.editionYear, 2019);
  assert.equal(info.editionYearSource, 'file');
  assert.equal(info.firstPublishedYear, null);
});

test('legacy year: details.publicationYear is the second channel (provider print run)', () => {
  const info = resolveWorkYear({ publicationYear: 2005 }, null, {}, null);
  assert.equal(info.year, 2005);
  assert.equal(info.yearSource, 'edition');
  assert.equal(info.editionYearSource, 'details');
});

test('legacy year: the file column outranks the provider print run', () => {
  const info = resolveWorkYear(
    { publicationYear: 2005 },
    { edition: { year: 2019 } },
    { year: 2019 },
    null
  );
  assert.equal(info.year, 2019);
  assert.equal(info.yearSource, 'edition');
  assert.equal(info.editionYearSource, 'file');
  // Both claims are echoed so the card can show «это издание».
  assert.equal(info.editionYear, 2019);
});

test('legacy year: an ancient publicationYear survives, a year 0 does not', () => {
  const ancient = resolveWorkYear({ publicationYear: -500 }, null, {}, null);
  assert.equal(ancient.year, -500);
  assert.equal(ancient.yearSource, 'edition');
  assert.equal(ancient.editionYearSource, 'details');

  const zero = resolveWorkYear({ publicationYear: 0 }, null, {}, null);
  assert.equal(zero.year, null);
  assert.equal(zero.yearSource, null);
});

test('priority: manual > firstPublishedYear > legacy edition', () => {
  const details = { firstPublishedYear: 1603, publicationYear: 2005 };
  const event = { edition: { year: 2019 } };
  const first = resolveWorkYear(details, event, { year: 2019 }, null);
  assert.equal(first.year, 1603);
  assert.equal(first.yearSource, 'first');
  assert.equal(first.editionYear, 2019);
  assert.equal(first.editionYearSource, 'file');

  const manual = resolveWorkYear(details, event, { year: 2019 }, { year: 1700 });
  assert.equal(manual.year, 1700);
  assert.equal(manual.yearSource, 'manual');
});

/* ------------------------------------------------------------------ */
/* stats: channels, re-import and the honest unknown accounting        */
/* ------------------------------------------------------------------ */

test('stats: the file year column restores years and reports its channel', async () => {
  const userKey = 'LegacyFileYear';
  const events = [
    fileEvent({ id: '7001', title: 'Книга с годом', year: 2011 }),
    fileEvent({ id: '7002', title: 'Книга без года' }),
  ];
  await bookCache.saveProfile('livelib', userKey, profile(userKey, events));
  const stats = buildBooksStats({ profile: `livelib-${userKey}` });

  const withYear = stats.booksIndex['ll:7001'];
  assert.equal(withYear.year, 2011);
  assert.equal(withYear.yearSource, 'edition');
  assert.equal(withYear.editionYearSource, 'file');
  assert.equal(stats.booksIndex['ll:7002'].year, null);

  assert.equal(stats.summary.yearEditionCount, 1);
  assert.equal(stats.summary.yearUnknownCount, 1);
  assert.equal(stats.summary.yearBackfill.editionChannels.file, 1);
  assert.deepEqual(stats.summary.yearBackfill.fileColumn, { rows: 2, withYear: 1 });

  // The known year is in a real decade; the year-less work is not painted as
  // a decade, it is only the honest tail bucket.
  const unknownBucket = stats.decades.find((entry) => entry.unknown);
  assert.equal(unknownBucket.count, 1);
  assert.equal(stats.decades.filter((entry) => !entry.unknown).reduce((sum, entry) => sum + entry.count, 0), 1);
});

test('stats: a re-import of an export with the year column heals existing events', async () => {
  const userKey = 'LegacyReimport';
  await bookCache.saveProfile(
    'livelib',
    userKey,
    profile(userKey, [fileEvent({ id: '7101', title: 'Аннигиляция' })])
  );

  let stats = buildBooksStats({ profile: `livelib-${userKey}` });
  assert.equal(stats.booksIndex['ll:7101'].year, null);
  assert.deepEqual(stats.summary.yearBackfill.fileColumn, { rows: 1, withYear: 0 });

  // Same file shape as the 29.10.2026 re-export: `details.year` present.
  const text = JSON.stringify([
    {
      bookHref: 'https://www.livelib.ru/book/7101-annigilyatsiya',
      title: 'Аннигиляция',
      readDate: 'Сентябрь 2026 г.',
      rating: { user: '4' },
      authors: [{ name: 'Тестовый Автор' }],
      genres: [{ name: 'Проза' }],
      details: { publishers: 'Тест', year: '2014', isbn: '9785699780495' },
    },
  ]);
  const parsed = parseExportFile(text, { shelf: 'read' });
  const merged = mergeFileIntoProfile(bookCache.getProfile('livelib', userKey), {
    userKey,
    books: parsed.books,
    shelf: 'read',
    format: parsed.format,
    filename: 'read-10_29_2026.json',
  });
  assert.equal(merged.added, 0);
  assert.equal(merged.enriched, 1);
  await bookCache.saveProfile('livelib', userKey, merged.profile);

  stats = buildBooksStats({ profile: `livelib-${userKey}` });
  assert.equal(stats.booksIndex['ll:7101'].year, 2014);
  assert.equal(stats.booksIndex['ll:7101'].yearSource, 'edition');
  assert.equal(stats.booksIndex['ll:7101'].editionYearSource, 'file');
  assert.equal(stats.summary.yearUnknownCount, 0);
  assert.deepEqual(stats.summary.yearBackfill.fileColumn, { rows: 1, withYear: 1 });
});

test('stats: unknown works are accounted for, never silently dropped', async () => {
  const userKey = 'LegacyUnknownAccounting';
  const events = [
    fileEvent({ id: '7201', title: 'С годом', year: 1999 }),
    fileEvent({ id: '7202', title: 'Без года' }),
    fileEvent({ id: '7203', title: 'Тоже без года' }),
  ];
  await bookCache.saveProfile('livelib', userKey, profile(userKey, events));
  const stats = buildBooksStats({ profile: `livelib-${userKey}` });

  const known = stats.years.reduce((sum, entry) => sum + entry.count, 0);
  const ancient = stats.summary.ancientBookCount || 0;
  // The old chart silently showed only `known` books out of `bookCount`.
  assert.equal(known + ancient + stats.summary.yearUnknownCount, stats.summary.bookCount);
  assert.equal(stats.summary.bookCount, 3);
  assert.equal(stats.summary.yearUnknownCount, 2);
});

test('UI: year-less works leave the donut and get a clickable summary line', () => {
  const booksSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'books.js'), 'utf8');
  const cssSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

  // The unknown slice is filtered out of the decade donut…
  assert.match(booksSource, /const decades = all\.filter\(\(item\) => !item\.unknown\)/);
  // …and the note carries a button that opens the drilldown list.
  assert.match(booksSource, /function unknownYearsButton\(count\)/);
  assert.match(booksSource, /function openUnknownYearModal\(\)/);
  assert.match(booksSource, /'Год можно исправить вручную: меню «…» у книги → «Исправить год»\.'/);
  // The honest reason names the missing export column, not a provider verdict.
  assert.match(booksSource, /в файле-выгрузке не было колонки «Год издания»/);
  assert.match(cssSource, /\.widget-note \.note-link/);
  // Labels no longer claim every bar is a first edition.
  assert.match(booksSource, /Книги по годам издания/);
});
