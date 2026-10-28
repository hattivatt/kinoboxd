'use strict';

/**
 * `livelib-backup` export FILE import — parser and profile merge.
 *
 * The format is pinned against the upstream sources (Chimildic/livelib-backup,
 * 28.10.2026):
 *   - `src/gs/book-parser.js` builds one object per shelf row with the keys
 *     `title`, `bookHref`, `coverHref`, `readDate`, `annotation`,
 *     `rating{overall,user}`, `authors[{name,href}]`, `genres[{name,href,
 *     topPlace?}]`, `stats{loved,reviews,quotes,read}`,
 *     `details{isbn,year,publishers,series,language}` (only the ticked columns
 *     are present);
 *   - `src/webpage/export-script.js` writes `JSON.stringify(bookArray)` for
 *     `json`, and a `;`-delimited CSV with the RU column titles from
 *     `FIELDS_DATA` otherwise (the Goodreads flavour is `,` + English titles +
 *     a trailing `Shelves` column and `yyyy/MM/01` dates).
 *
 * Fixtures: `test/fixtures/livelib-file-export.{json,csv}` — three realistic
 * rows (with ISBN / without ISBN / month-only RU date).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lib = require('../server/books/livelib-file');

const FIXTURES = path.join(__dirname, 'fixtures');
const jsonFixture = fs.readFileSync(path.join(FIXTURES, 'livelib-file-export.json'));
const csvFixture = fs.readFileSync(path.join(FIXTURES, 'livelib-file-export.csv'));

function parseJson(options = {}) {
  return lib.parseExportFile(jsonFixture, { filename: 'livelib-margaret-read-28.10.2026.json', ...options });
}

test('JSON export parses into the normalized record shape', () => {
  const parsed = parseJson();
  assert.equal(parsed.format, 'json');
  // The shelf is a property of the exported page: the filename carries it.
  assert.equal(parsed.shelf, 'read');
  assert.equal(parsed.books.length, 3);
  assert.deepEqual(parsed.stats, {
    books: 3,
    withBookId: 3,
    withTitleKey: 3,
    withDay: 0,
    withMonth: 2,
    withYearOnly: 1,
    withRating: 2,
    withIsbn: 1,
    withGenres: 2,
    duplicateBookIds: 0,
  });

  const [annihilation, martinEden, picnic] = parsed.books;
  assert.equal(annihilation.bookId, '1002745594');
  assert.equal(annihilation.title, 'Аннигиляция');
  assert.equal(annihilation.readDateRaw, 'Сентябрь 2026 г.');
  assert.equal(annihilation.readMonth, '2026-09');
  // LiveLib never puts a day in the export: inventing one would fake calendar dots.
  assert.equal(annihilation.finishedAt, null);
  assert.equal(annihilation.datePrecision, 'month');
  assert.equal(annihilation.rating5, 4.5);
  assert.equal(annihilation.communityRating, 7.4);
  assert.deepEqual(annihilation.authors, ['Джефф Вандермеер']);
  assert.deepEqual(annihilation.genres, ['фэнтези', 'ужасы']);
  assert.equal(annihilation.publisher, 'Эксмо');
  assert.equal(annihilation.year, 2018);
  assert.equal(annihilation.language, 'ru');
  assert.equal(annihilation.series, 'Южный предел');
  assert.deepEqual(annihilation.isbn, {
    isbn: '9785699989676',
    isbn13: '9785699989676',
    isbn10: '5699989676',
  });
  assert.deepEqual(annihilation.bookStats, { loved: 0, reviews: 5, quotes: 2, read: 2327 });

  // RU month phrase of the older page header + no ISBN/date columns.
  assert.equal(martinEden.readMonth, '2023-03');
  assert.equal(martinEden.rating5, 5);
  assert.equal(martinEden.isbn.isbn13, null);

  // Year-only date: honest "no month", no fake timeline bucket.
  assert.equal(picnic.datePrecision, 'year');
  assert.equal(picnic.readMonth, null);
  assert.equal(picnic.finishedAt, null);
  assert.equal(picnic.rating5, null);
  assert.deepEqual(picnic.authors, ['Аркадий Стругацкий', 'Борис Стругацкий']);

  assert.deepEqual(parsed.warnings.map((warning) => warning.split(':')[0]), [
    'Точных дат прочтения в файле нет',
    '1 книга с датой «только год»',
  ]);
});

test('a JSON wrapper object is tolerated, a non-array document is not', () => {
  const wrapped = lib.parseExportFile(JSON.stringify({ items: [{ title: 'Одна книга' }] }));
  assert.equal(wrapped.books.length, 1);
  assert.equal(wrapped.books[0].title, 'Одна книга');
  // No link column: identity falls back to title+author so a re-upload is idempotent.
  assert.equal(wrapped.books[0].bookId, null);
  assert.equal(wrapped.books[0].titleKey, 'одна книга|');
  assert.match(wrapped.warnings[0], /Ссылка на книгу/);

  assert.throws(
    () => lib.parseExportFile(JSON.stringify({ meta: { user: 'Margaret' } })),
    (error) => error.name === 'LivelibFileError' && error.code === 'livelib_file_invalid_json'
  );
});

test('CSV export (RU semicolon dialect) carries the same values', () => {
  const parsed = lib.parseExportFile(csvFixture, {
    filename: 'livelib-margaret-read-28.10.2026.csv',
  });
  assert.equal(parsed.format, 'csv');
  assert.equal(parsed.shelf, 'read');
  assert.equal(parsed.books.length, 3);
  assert.equal(parsed.stats.withIsbn, 2);

  const [annihilation, martinEden, picnic] = parsed.books;
  assert.equal(annihilation.title, 'Аннигиляция');
  assert.equal(annihilation.readMonth, '2026-09');
  assert.equal(annihilation.rating5, 4.5);
  assert.equal(annihilation.isbn.isbn13, '9785699989676');
  assert.deepEqual(annihilation.genres, ['фэнтези', 'ужасы']);

  assert.equal(martinEden.readMonth, '2023-03');
  assert.equal(martinEden.publisher, 'АСТ');

  // Quoted cell with a comma inside (authors) and a year-only date.
  assert.deepEqual(picnic.authors, ['Стругацкий Аркадий', 'Стругацкий Борис']);
  assert.equal(picnic.datePrecision, 'year');
  assert.equal(picnic.isbn.isbn13, '9785170863174');
  assert.equal(picnic.year, 1984);
});

test('CSV without the expected columns is refused, not silently empty', () => {
  assert.throws(
    () => lib.parseExportFile('foo;bar\n1;2\n'),
    (error) => error.code === 'livelib_file_unknown_columns'
  );
});

test('parser rejects empty, unparsable and oversized files', () => {
  assert.throws(() => lib.parseExportFile(''), (error) => error.code === 'livelib_file_empty');
  assert.throws(
    () => lib.parseExportFile('[{"title": "A"'),
    (error) => error.code === 'livelib_file_invalid_json'
  );
  assert.throws(
    () => lib.parseExportFile('[{"annotation": "только аннотация"}]'),
    (error) => error.code === 'livelib_file_no_books'
  );
  assert.throws(
    () => lib.parseExportFile(Buffer.alloc(24 * 1024 * 1024 + 10, 0x20)),
    (error) => error.code === 'livelib_file_too_large'
  );
  const many = JSON.stringify(
    Array.from({ length: lib.MAX_BOOKS + 1 }, (unused, index) => ({ title: `Книга ${index}` }))
  );
  assert.throws(() => lib.parseExportFile(many), (error) => error.code === 'livelib_file_too_many_books');
});

test('read dates: month names, prepositional forms, numeric and day precision', () => {
  const cases = [
    ['Сентябрь 2026 г.', { finishedAt: null, readMonth: '2026-09', precision: 'month' }],
    ['декабрь 2025', { finishedAt: null, readMonth: '2025-12', precision: 'month' }],
    ['прочитано в марте 2023', { finishedAt: null, readMonth: '2023-03', precision: 'month' }],
    ['в мае 2020', { finishedAt: null, readMonth: '2020-05', precision: 'month' }],
    ['Март 2023 году', { finishedAt: null, readMonth: '2023-03', precision: 'month' }],
    ['2026-09', { finishedAt: null, readMonth: '2026-09', precision: 'month' }],
    ['09.2026', { finishedAt: null, readMonth: '2026-09', precision: 'month' }],
    ['2021 г.', { finishedAt: null, readMonth: null, precision: 'year' }],
    ['2025', { finishedAt: null, readMonth: null, precision: 'year' }],
    ['02.03.2024', { finishedAt: '2024-03-02', readMonth: null, precision: 'day' }],
    ['2024-03-02', { finishedAt: '2024-03-02', readMonth: null, precision: 'day' }],
    ['2 марта 2024 г.', { finishedAt: '2024-03-02', readMonth: null, precision: 'day' }],
    // The Goodreads flavour fabricates the first of the month out of the same
    // month header: it must stay month-precision.
    ['2024/03/01', { finishedAt: null, readMonth: '2024-03', precision: 'month' }],
    ['2024/03/02', { finishedAt: '2024-03-02', readMonth: null, precision: 'day' }],
    // Garbage and impossible dates.
    ['', { finishedAt: null, readMonth: null, precision: null }],
    ['давно', { finishedAt: null, readMonth: null, precision: null }],
    ['31.02.2024', { finishedAt: null, readMonth: '2024-02', precision: 'month' }],
    ['2024-13', { finishedAt: null, readMonth: null, precision: null }],
  ];
  for (const [raw, expected] of cases) {
    assert.deepEqual(lib.parseFileReadDate(raw), expected, `readDate ${JSON.stringify(raw)}`);
  }
});

test('rating stays on one 10-point scale (the export writes 5-star values)', () => {
  assert.equal(lib.rating5Of('4.5'), 4.5);
  assert.equal(lib.rating10Of('4.5'), 9);
  assert.equal(lib.rating10Of('5'), 10);
  assert.equal(lib.rating10Of('3'), 6);
  assert.equal(lib.rating10Of('0'), null);
  assert.equal(lib.rating10Of(''), null);
  assert.equal(lib.rating5Of('n/a'), null);
  // A hand-edited column in the native LiveLib scale is halved, not clamped.
  assert.equal(lib.rating5Of('7'), 3.5);
  assert.equal(lib.rating10Of('7'), 7);
  assert.equal(lib.rating5Of('11'), null);
});

test('ISBN: list column, checksum preference and ISBN-10 conversion', () => {
  assert.deepEqual(lib.isbnOf('978-5-699-98967-6'), {
    isbn: '9785699989676',
    isbn13: '9785699989676',
    isbn10: '5699989676',
  });
  // The service joins every ISBN of an edition with a comma.
  assert.equal(lib.isbnOf('978-5-699-98967-6, 9785170863174').isbn13, '9785699989676');
  // ISBN-10 -> 13.
  assert.equal(lib.isbnOf('5170863175').isbn13, '9785170863174');
  // A garbled number keeps the display value but never becomes the match key.
  const broken = lib.isbnOf('978-5-699-98967-7');
  assert.equal(broken.isbn, '9785699989677');
  assert.equal(broken.isbn13, null);
  // A broken first candidate does not hide a valid second one.
  assert.equal(lib.isbnOf('978-5-699-98967-7, 9785170863174').isbn13, '9785170863174');
  assert.deepEqual(lib.isbnOf('нет'), { isbn: null, isbn13: null, isbn10: null });
  assert.deepEqual(lib.isbnOf(''), { isbn: null, isbn13: null, isbn10: null });
});

test('shelf aliases and filename sniffing', () => {
  assert.equal(lib.shelfOf('Прочитал'), 'read');
  assert.equal(lib.shelfOf('Не дочитал'), 'dnf');
  assert.equal(lib.shelfOf('Читаю сейчас'), 'reading');
  assert.equal(lib.shelfOf('Хочу прочитать'), 'wish');
  assert.equal(lib.shelfOf('to-read'), 'wish');
  assert.equal(lib.shelfOf('currently-reading'), 'reading');
  assert.equal(lib.shelfOf('unread'), 'dnf');
  assert.equal(lib.shelfOf(''), null);
  assert.equal(lib.shelfOf('полка'), null);

  assert.equal(lib.shelfFromFilename('livelib-margaret-read-28.10.2026.json'), 'read');
  assert.equal(lib.shelfFromFilename('livelib-margaret-wish-28.10.2026.csv'), 'wish');
  assert.equal(lib.shelfFromFilename('livelib-margaret-unread-28.10.2026.json'), 'dnf');
  assert.equal(lib.shelfFromFilename('export.json'), null);
});

test('buildFileEvent keeps the source id, the shelf and the 10-point rating', () => {
  const [book] = parseJson().books;
  const event = lib.buildFileEvent(book, 'read', 1);
  assert.equal(event.source, 'livelib-file');
  assert.equal(event.origin, 'livelib-file');
  assert.equal(event.sourceBookId, '1002745594');
  assert.equal(event.status, 'read');
  assert.equal(event.shelf, 'read');
  assert.equal(event.rating, 4.5);
  assert.equal(event.ratingScale, 5);
  assert.equal(event.rating10, 9);
  assert.equal(event.finishedAt, null);
  assert.equal(event.readMonth, '2026-09');
  assert.equal(event.edition.isbn13, '9785699989676');
  assert.equal(event.edition.publisher, 'Эксмо');
  assert.deepEqual(event.genres, ['фэнтези', 'ужасы']);
  assert.match(event.id, /^llfile:id:1002745594:read$/);

  const wish = lib.buildFileEvent(book, 'wish', 1);
  assert.equal(wish.status, 'wish');
  assert.equal(wish.id, 'llfile:id:1002745594:wish');
});

test('mergeFileIntoProfile: shelves are additive and the file is idempotent', () => {
  const parsed = parseJson();
  const now = '2026-10-28T12:00:00.000Z';

  const first = lib.mergeFileIntoProfile(null, {
    userKey: 'Margaret',
    books: parsed.books,
    shelf: 'read',
    format: 'json',
    filename: 'livelib-margaret-read-28.10.2026.json',
    now,
  });
  assert.deepEqual(
    { added: first.added, enriched: first.enriched, skipped: first.skipped },
    { added: 3, enriched: 0, skipped: 0 }
  );
  assert.equal(first.profile.source, 'livelib');
  assert.equal(first.profile.origin, 'livelib-file');
  assert.equal(first.profile.userKey, 'Margaret');
  assert.deepEqual(first.profile.shelves, { read: 3, dnf: 0, reading: 0, wish: 0 });
  assert.equal(first.profile.fileImports.length, 1);
  assert.deepEqual(first.profile.fileImports[0], {
    shelf: 'read',
    format: 'json',
    filename: 'livelib-margaret-read-28.10.2026.json',
    books: 3,
    added: 3,
    enriched: 0,
    importedAt: now,
  });
  // Sorted by date, newest first; undated rows last.
  assert.deepEqual(first.profile.events.map((event) => event.sourceBookId), [
    '1002745594',
    '1000123456',
    '1000987654',
  ]);

  // Re-upload of the very same file: nothing is duplicated, nothing changes.
  const second = lib.mergeFileIntoProfile(first.profile, {
    userKey: 'Margaret',
    books: parsed.books,
    shelf: 'read',
    format: 'json',
    filename: 'livelib-margaret-read-28.10.2026.json',
    now: '2026-10-28T12:30:00.000Z',
  });
  assert.deepEqual(
    { added: second.added, enriched: second.enriched, skipped: second.skipped },
    { added: 0, enriched: 0, skipped: 3 }
  );
  assert.equal(second.profile.events.length, 3);
  assert.equal(second.profile.fileImports.length, 2);

  // A second shelf is a second set of events, and the plan shelf is counted.
  const wish = lib.mergeFileIntoProfile(second.profile, {
    userKey: 'Margaret',
    books: parsed.books,
    shelf: 'wish',
    format: 'json',
    filename: 'livelib-margaret-wish-28.10.2026.json',
    now: '2026-10-28T13:00:00.000Z',
  });
  assert.equal(wish.added, 3);
  assert.deepEqual(wish.profile.shelves, { read: 3, dnf: 0, reading: 0, wish: 3 });
  assert.equal(wish.profile.events.length, 6);
  assert.equal(wish.profile.origin, 'livelib-file');

  // «Не дочитал» is history, not a plan: the event carries `dnf`.
  const dnfBook = parsed.books[0];
  const dnf = lib.mergeFileIntoProfile(wish.profile, {
    userKey: 'Margaret',
    books: [dnfBook],
    shelf: 'unread',
    now: '2026-10-28T13:30:00.000Z',
  });
  assert.equal(dnf.shelf, 'dnf');
  assert.equal(dnf.added, 1);
  assert.equal(dnf.profile.events.find((event) => event.shelf === 'dnf').status, 'dnf');
});

test('mergeFileIntoProfile never downgrades a scraped day to a month', () => {
  const scraped = {
    schemaVersion: 1,
    source: 'livelib',
    userKey: 'Margaret',
    importedAt: '2026-10-20T00:00:00.000Z',
    warnings: [],
    events: [
      {
        id: 'll:53103775',
        source: 'livelib',
        sourceBookId: '1002745594',
        sourceUserBookId: '53103775',
        title: 'Аннигиляция',
        authors: ['Джефф Вандермеер'],
        status: 'read',
        rating: 7,
        ratingScale: 10,
        rating10: 7,
        finishedAt: '2026-09-14',
        edition: {},
      },
    ],
  };
  const parsed = parseJson();
  const merged = lib.mergeFileIntoProfile(scraped, {
    userKey: 'Margaret',
    books: parsed.books,
    shelf: 'read',
    format: 'json',
    filename: 'read.json',
    now: '2026-10-28T12:00:00.000Z',
  });

  // The scraped row keeps its exact day and its own id; the file only fills gaps.
  const dune = merged.profile.events.find((event) => event.sourceBookId === '1002745594');
  assert.equal(dune.id, 'll:53103775');
  assert.equal(dune.finishedAt, '2026-09-14');
  assert.equal(dune.rating10, 7);
  assert.equal(dune.origin, undefined);
  assert.equal(dune.fileEnriched, true);
  assert.equal(dune.edition.isbn13, '9785699989676');

  // The other two books were not in the scraped profile: they are added.
  assert.equal(merged.added, 2);
  assert.equal(merged.enriched, 1);
  // A document with both acquisition paths says so instead of claiming "file".
  assert.equal(merged.profile.origin, 'mixed');
});

test('a file without link column stays idempotent on title+author', () => {
  // `mergeFileIntoProfile` takes normalized records (`parseExportFile` output);
  // `normalizeRecord` is the per-row entry point used by the tests directly.
  const books = [
    lib.normalizeRecord({
      title: 'Дюна',
      authors: [{ name: 'Фрэнк Герберт' }],
      readDate: 'Октябрь 2024 г.',
      rating: { user: '5' },
    }),
  ];
  const first = lib.mergeFileIntoProfile(null, { userKey: 'x', books, shelf: 'read' });
  assert.equal(first.added, 1);
  assert.equal(first.profile.events[0].sourceBookId, null);
  assert.match(first.profile.events[0].id, /^llfile:tk:[0-9a-f]{10}:read$/);
  assert.equal(first.profile.events[0].fileKey.startsWith('tk:'), true);
  assert.equal(first.profile.events[0].readMonth, '2024-10');

  // Same title with different spacing/case -> same identity -> no duplicate.
  const again = lib.mergeFileIntoProfile(first.profile, {
    userKey: 'x',
    books: [
      lib.normalizeRecord({
        title: '  дюна ',
        authors: [{ name: 'Фрэнк ГЕРБЕРТ' }],
        readDate: '2024-10',
        rating: { user: '5' },
      }),
    ],
    shelf: 'read',
  });
  assert.equal(again.added, 0);
  assert.equal(again.profile.events.length, 1);
  assert.equal(again.skipped, 1);
});

test('preserveFileState keeps plan shelves across a scrape', () => {
  const parsed = parseJson();
  let profile = lib.mergeFileIntoProfile(null, { userKey: 'Margaret', books: parsed.books, shelf: 'read' }).profile;
  profile = lib.mergeFileIntoProfile(profile, { userKey: 'Margaret', books: parsed.books, shelf: 'wish' }).profile;
  profile = lib.mergeFileIntoProfile(profile, { userKey: 'Margaret', books: [parsed.books[1]], shelf: 'dnf' }).profile;

  const scraped = {
    schemaVersion: 1,
    source: 'livelib',
    userKey: 'Margaret',
    importedAt: '2026-10-29T00:00:00.000Z',
    warnings: [],
    events: [
      {
        id: 'll:1',
        source: 'livelib',
        sourceBookId: '1002745594',
        title: 'Аннигиляция',
        status: 'read',
        finishedAt: '2026-09-14',
      },
    ],
  };
  const { profile: merged, preserved } = lib.preserveFileState(profile, scraped);
  // read/ + wish/ + dnf: only the four plan/abandoned rows survive.
  assert.equal(preserved, 4);
  assert.deepEqual(merged.shelves, { read: 1, dnf: 1, reading: 0, wish: 3 });
  assert.equal(merged.origin, 'mixed');
  assert.equal(merged.events.length, 5);
  // The scraped row is untouched and keeps the exact day.
  assert.equal(merged.events.find((event) => event.id === 'll:1').finishedAt, '2026-09-14');
  // File-import audit trail survives too.
  assert.equal(merged.fileImports.length, 3);

  // A profile that never had a file import is left alone.
  const untouched = lib.preserveFileState(null, {
    schemaVersion: 1,
    source: 'livelib',
    events: [],
    warnings: [],
  });
  assert.equal(untouched.preserved, 0);
  assert.equal(untouched.profile.origin, 'livelib');
  assert.deepEqual(untouched.profile.shelves, { read: 0, dnf: 0, reading: 0, wish: 0 });
});
