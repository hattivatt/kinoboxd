'use strict';

/**
 * «Читаю сейчас» in the «Недавно читал» strip.
 *
 * The strip used to be finished-only. This round adds the current-read shelf
 * from both sources, while keeping the reading statistics honest:
 *   - `recentlyReading` carries the current books (no invented finish date);
 *   - `summary.readingNowCount` counts them separately;
 *   - bookCount / eventCount / finishedCount / years / authors stay untouched;
 *   - a LiveLib reading shelf is parsed from the file name, the form or a
 *     per-row shelf/status token, and a re-upload stays idempotent;
 *   - Hardcover `status_id = 2` is a stored plan event, not a finished read.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-reading-'));

const bookCache = require('../server/books/book-cache');
const hardcover = require('../server/books/hardcover');
const livelibFile = require('../server/books/livelib-file');
const { buildBooksStats } = require('../server/books/stats');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function readPublic(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

function hcRead(id, bookId, title, finishedAt) {
  return {
    id: `hc:read:${id}`,
    source: 'hardcover',
    sourceBookId: String(bookId),
    workId: `hc:${bookId}`,
    title,
    authors: ['Jim Butcher'],
    status: 'read',
    statusId: 3,
    finishedAt,
    edition: {},
  };
}

function hcReadingRow() {
  return {
    id: 555,
    book_id: 777,
    edition_id: null,
    rating: null,
    status_id: 2,
    read_count: 0,
    first_read_date: null,
    last_read_date: null,
    date_added: '2026-09-01',
    book: {
      id: 777,
      title: 'Текущая книга',
      slug: 'tekushchaya-kniga',
      release_year: 2020,
      cached_image: { url: 'https://assets.hardcover.app/books/current.jpg' },
      contributions: [{ author: { id: 3, name: 'Иван Петров' }, contribution: 'Author' }],
    },
    edition: {},
    user_book_reads: [{ id: 31, started_at: '2026-10-25', finished_at: null }],
  };
}

test.before(async () => {
  const [reading] = hardcover.eventsFromRow(hcReadingRow());
  await bookCache.saveProfile('hardcover', 'reader-now', {
    schemaVersion: 1,
    source: 'hardcover',
    userKey: 'reader-now',
    importedAt: '2026-10-29T00:00:00.000Z',
    events: [
      hcRead(1, 11, 'Первая книга', '2024-01-10'),
      hcRead(2, 12, 'Вторая книга', '2024-02-20'),
      reading,
    ],
  });

  // A livelib-backup export of the «Читаю сейчас» page: the shelf comes from
  // the file name / form, the start date from an optional column.
  const parsed = livelibFile.parseExportFile(
    JSON.stringify([
      {
        title: 'Только прочитанная',
        authors: [{ name: 'Пётр Петров' }],
        readDate: 'Сентябрь 2026 г.',
        bookHref: 'https://www.livelib.ru/book/9001-read',
      },
      {
        title: 'Читается сейчас',
        authors: [{ name: 'Анна Иванова' }],
        startedAt: '2026-10-20',
        coverHref: 'https://s1.livelib.ru/boocover/9002/current.jpg',
        bookHref: 'https://www.livelib.ru/book/9002-reading',
      },
      {
        title: 'Открыта позже',
        authors: [{ name: 'Олег Сидоров' }],
        startedAt: '2026-10-22',
        bookHref: 'https://www.livelib.ru/book/9003-reading',
      },
    ]),
    { filename: 'livelib-margaret-reading-28.10.2026.json' }
  );
  const readBooks = parsed.books.filter((book) => book.bookId === '9001');
  const readingBooks = parsed.books.filter((book) => book.bookId !== '9001');
  let profile = livelibFile.mergeFileIntoProfile(null, {
    userKey: 'file-reader',
    books: readBooks,
    shelf: 'read',
    format: 'json',
  }).profile;
  profile = livelibFile.mergeFileIntoProfile(profile, {
    userKey: 'file-reader',
    books: readingBooks,
    shelf: parsed.shelf,
    format: 'json',
  }).profile;
  await bookCache.saveProfile('livelib', 'file-reader', profile);

  // A profile with nothing finished: the strip must still appear.
  const onlyReading = livelibFile.parseExportFile(
    JSON.stringify([
      {
        title: 'Единственная текущая',
        authors: [{ name: 'Мария Орлова' }],
        startedAt: '2026-10-27',
      },
    ]),
    { filename: 'livelib-margaret-reading-28.10.2026.json' }
  );
  const onlyProfile = livelibFile.mergeFileIntoProfile(null, {
    userKey: 'only-reading',
    books: onlyReading.books,
    shelf: onlyReading.shelf,
    format: 'json',
  }).profile;
  await bookCache.saveProfile('livelib', 'only-reading', onlyProfile);
});

test('livelib-backup reading shelf is parsed from the file name and a row token', () => {
  const byName = livelibFile.parseExportFile(
    JSON.stringify([{ title: 'Книга', startedAt: '2026-10-20' }]),
    { filename: 'livelib-margaret-reading-28.10.2026.json' }
  );
  assert.equal(byName.shelf, 'reading');
  assert.equal(byName.books[0].startedAt, '2026-10-20');
  assert.equal(byName.books[0].startMonth, null);

  // A hand-edited JSON row may carry the shelf/status token itself.
  const byRow = livelibFile.parseExportFile(
    JSON.stringify([{ title: 'Книга', status: 'Читаю сейчас' }]),
    { filename: 'export.json' }
  );
  assert.equal(byRow.shelf, 'reading');
  assert.equal(byRow.books[0].shelfHint, 'reading');

  const merged = livelibFile.mergeFileIntoProfile(null, {
    userKey: 'x',
    books: byName.books,
    shelf: byName.shelf,
    format: 'json',
  });
  const [event] = merged.profile.events;
  assert.equal(event.shelf, 'reading');
  assert.equal(event.status, 'reading');
  assert.equal(event.startedAt, '2026-10-20');
  assert.equal(event.finishedAt, null);
  assert.equal(merged.profile.shelves.reading, 1);

  // A repeated upload is a no-op, exactly like the read shelf.
  const again = livelibFile.mergeFileIntoProfile(merged.profile, {
    userKey: 'x',
    books: byName.books,
    shelf: byName.shelf,
    format: 'json',
  });
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 1);
  assert.equal(again.profile.events.length, 1);
});

test('hardcover status_id=2 is a stored plan event with a start date', () => {
  const [event] = hardcover.eventsFromRow(hcReadingRow());
  assert.equal(event.status, 'reading');
  assert.equal(event.statusId, 2);
  assert.equal(event.finishedAt, null);
  assert.equal(event.startedAt, '2026-10-25');
  assert.equal(event.title, 'Текущая книга');
  assert.equal(event.coverUrl, 'https://assets.hardcover.app/books/current.jpg');
  assert.equal(hardcover.storeStatus(2), true);
  assert.equal(hardcover.keepStatus(2), false);
});

test('reading books lead the strip without inflating finished statistics', () => {
  const stats = buildBooksStats({ profile: 'hardcover-reader-now' });
  assert.equal(stats.summary.readingNowCount, 1);
  assert.equal(stats.summary.bookCount, 2);
  assert.equal(stats.summary.eventCount, 2);
  assert.equal(stats.summary.finishedCount, 2);
  assert.equal(stats.summary.dateTo, '2024-02-20');
  assert.equal(stats.booksIndex['hc:777'], undefined);

  assert.equal(stats.recentlyReading.length, 1);
  const [current] = stats.recentlyReading;
  assert.equal(current.workId, 'hc:777');
  assert.equal(current.title, 'Текущая книга');
  assert.deepEqual(current.authors, ['Иван Петров']);
  assert.equal(current.date, '2026-10-25');
  assert.equal(current.precision, 'day');
  assert.equal(current.status, 'reading');
  assert.equal(current.coverUrl, 'https://assets.hardcover.app/books/current.jpg');

  // The finished strip is unchanged: reading never enters it.
  assert.deepEqual(
    stats.recentlyFinished.map((item) => item.date),
    ['2024-02-20', '2024-01-10']
  );
});

test('livelib reading shelf: strip order, counters and honest bookCount', () => {
  const stats = buildBooksStats({ profile: 'livelib-file-reader' });
  assert.equal(stats.summary.bookCount, 1);
  assert.equal(stats.summary.eventCount, 1);
  assert.equal(stats.summary.readingNowCount, 2);
  assert.equal(stats.summary.shelfExcluded, 2);
  assert.deepEqual(stats.summary.shelves, { read: 1, dnf: 0, reading: 2, wish: 0 });
  assert.equal(stats.booksIndex['ll:9002'], undefined);

  // Newest start first; the finished list still has the read shelf only.
  assert.deepEqual(
    stats.recentlyReading.map((item) => [item.title, item.date]),
    [
      ['Открыта позже', '2026-10-22'],
      ['Читается сейчас', '2026-10-20'],
    ]
  );
  assert.equal(stats.recentlyReading[0].precision, 'day');
  assert.deepEqual(stats.recentlyReading[1].authors, ['Анна Иванова']);
  assert.equal(stats.recentlyFinished.length, 1);

  const only = buildBooksStats({ profile: 'livelib-only-reading' });
  assert.equal(only.summary.bookCount, 0);
  assert.equal(only.summary.readingNowCount, 1);
  assert.equal(only.recentlyFinished.length, 0);
  assert.equal(only.recentlyReading.length, 1);
});

test('public strip renders reading first with a badge and a date-less card', () => {
  const books = readPublic('js/books.js');
  assert.match(books, /recentlyReading/);
  assert.match(books, /const reading = data\.recentlyReading\.slice\(0, 15\)/);
  assert.match(books, /\[\.\.\.reading, \.\.\.data\.recentlyFinished\]\.slice\(0, 15\)/);
  assert.match(books, /recent-reading/);
  assert.match(books, /читает сейчас/);
  // The counter reaches the headline as a separate sentence.
  assert.match(books, /readingNowCount/);

  const css = readPublic('style.css');
  assert.match(css, /\.recent-book-tags \.recent-reading/);

  const html = readPublic('index.html');
  assert.match(html, /«Читаю сейчас» можно загрузить отдельным файлом/);
});
