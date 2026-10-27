'use strict';

/**
 * Hardcover: journal event mapping, metadata extraction, token masking and
 * pagination against a mocked GraphQL endpoint (no live requests).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The journal mock writes details files; keep them out of the repo cache.
process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-hc-'));
process.env.HARDCOVER_API_TOKEN = 'hc_pat_test_token_value';

const hardcover = require('../server/books/hardcover');
const bookCache = require('../server/books/book-cache');

const sample = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'hardcover-journal-sample.json'), 'utf8')
);

function rowByWork(workId) {
  // The fixture stores mapped events/works, not raw rows; rebuild a raw row for
  // the mapping tests from the documented schema.
  return {
    id: 19718676,
    book_id: 377567,
    edition_id: 2660973,
    rating: 4,
    status_id: 3,
    read_count: 2,
    first_read_date: '2026-10-25',
    last_read_date: '2026-10-25',
    book: {
      id: 377567,
      title: 'Daemon',
      slug: 'daemon',
      pages: 320,
      release_year: 2006,
      release_date: '2006-01-01',
      rating: 4.1,
      ratings_count: 1000,
      cached_image: { url: 'https://assets.hardcover.app/books/daemon.jpg' },
      contributions: [
        { author: { id: 1, name: 'Daniel Suarez' }, contribution: 'Author' },
        { author: { id: 2, name: 'Illustrator Person' }, contribution: 'Illustrator' },
      ],
      book_series: [{ position: 1, series: { id: 9, name: 'Daemon' } }],
      taggings: [
        { tag: { id: 6, tag: 'Science Fiction', slug: 'science-fiction', tag_category_id: 1 } },
        { tag: { id: 99, tag: 'Moody', slug: 'moody', tag_category_id: 3 } },
      ],
    },
    edition: {
      id: 2660973,
      isbn_13: '9781101007518',
      isbn_10: '1101007512',
      language_id: 1,
      pages: 300,
      publisher_id: 537,
      release_year: null,
      release_date: '2006-01-01',
      publisher: { id: 537, name: 'Penguin' },
      language: { id: 1, language: 'English' },
    },
    user_book_reads: [
      { id: 10, started_at: '2026-10-20', finished_at: '2026-10-25', finished_at_precision: 1, edition_id: 2660973 },
      { id: 11, started_at: '2024-01-01', finished_at: '2024-01-05', finished_at_precision: 1, edition_id: 2660973 },
    ],
  };
  void workId;
}

test('token masking never leaks the secret', () => {
  assert.equal(hardcover.maskToken('hc_pat_abcdefghijklmnop'), 'hc_pat_***');
  assert.equal(hardcover.maskToken('eyJhbGciOiJIUzI1NiJ9.payload.sig'), '***');
  assert.equal(hardcover.maskToken(''), '(none)');
  assert.ok(!hardcover.maskToken('hc_pat_secret').includes('secret'));
});

test('eventsFromRow creates one event per read with chronological readIndex', () => {
  const events = hardcover.eventsFromRow(rowByWork());
  assert.equal(events.length, 2);
  // Ids are not chronological in Hardcover; dates decide the order.
  assert.equal(events[0].finishedAt, '2024-01-05');
  assert.equal(events[0].readIndex, 1);
  assert.equal(events[0].reread, false);
  assert.equal(events[1].finishedAt, '2026-10-25');
  assert.equal(events[1].readIndex, 2);
  assert.equal(events[1].reread, true);
  assert.equal(events[1].workId, 'hc:377567');
  assert.equal(events[1].rating, 4);
  assert.equal(events[1].ratingScale, 5);
  assert.equal(events[1].rating10, 8);
  assert.equal(events[1].status, 'read');
  assert.equal(events[1].edition.isbn, '9781101007518');
  assert.equal(events[1].edition.publisher, 'Penguin');
});

test('a read user_book without reads yields one undated event', () => {
  const row = rowByWork();
  row.user_book_reads = [];
  row.status_id = 3;
  row.read_count = 1;
  row.rating = null;
  row.last_read_date = null;
  const events = hardcover.eventsFromRow(row);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'hc:ub:19718676');
  assert.equal(events[0].status, 'read');
  assert.equal(events[0].finishedAt, null);
  assert.equal(events[0].rating10, null);
});

test('shelf-only statuses (want/reading/paused) produce no events', () => {
  for (const statusId of [1, 2, 4]) {
    const row = rowByWork();
    row.status_id = statusId;
    row.user_book_reads = [];
    row.last_read_date = null;
    assert.deepEqual(
      hardcover.eventsFromRow(row),
      [],
      `status_id ${statusId} must not become a reading event`
    );
  }
});

test('dnf (status 5) keeps the event but never dates it', () => {
  const synthetic = rowByWork();
  synthetic.status_id = 5;
  synthetic.read_count = 1;
  synthetic.user_book_reads = [];
  synthetic.last_read_date = '2025-03-20';
  const [undated] = hardcover.eventsFromRow(synthetic);
  assert.equal(undated.id, 'hc:ub:19718676');
  assert.equal(undated.status, 'dnf');
  assert.equal(undated.finishedAt, null);
  // Raw dates stay for reference, they just never reach timeline/streaks.
  assert.equal(undated.lastReadDate, '2025-03-20');

  const withReads = rowByWork();
  withReads.status_id = 5;
  const readEvents = hardcover.eventsFromRow(withReads);
  assert.equal(readEvents.length, 2);
  assert.ok(readEvents.every((event) => event.status === 'dnf'));
  assert.ok(readEvents.every((event) => event.finishedAt === null));
});

test('non-finished rows are counted by status, one skip per user_book', () => {
  const counter = hardcover.createStatusFilterCounter();
  const wish = rowByWork();
  wish.status_id = 1;
  const reading = rowByWork();
  reading.status_id = 2;
  const paused = rowByWork();
  paused.status_id = 4;
  const read = rowByWork();
  hardcover.eventsFromRow(wish, counter);
  hardcover.eventsFromRow(reading, counter);
  hardcover.eventsFromRow(paused, counter);
  hardcover.eventsFromRow(read, counter);
  assert.equal(counter.skippedNonFinished, 3);
  assert.deepEqual(counter.byStatus, { '1:wish': 1, '2:reading': 1, '4:paused': 1 });
  assert.deepEqual(hardcover.HARDCOVER_KEEP_STATUS_IDS, [3, 5]);
  assert.equal(hardcover.keepStatus(3), true);
  assert.equal(hardcover.keepStatus(5), true);
  assert.equal(hardcover.keepStatus(1), false);
  assert.equal(hardcover.HARDCOVER_STATUS_LABELS[5], 'dnf');
});

test('detailsFromBook keeps authors, genre tags only, series and publisher', () => {
  const row = rowByWork();
  const details = hardcover.detailsFromBook(row.book, row.edition);
  assert.equal(details.hcWorkId, 377567);
  assert.deepEqual(details.authors, [{ hcId: 1, name: 'Daniel Suarez' }]);
  assert.deepEqual(details.genres, ['Science Fiction']);
  assert.deepEqual(details.series, [{ hcId: 9, name: 'Daemon', position: 1 }]);
  assert.equal(details.publisher, 'Penguin');
  assert.equal(details.pages, 320);
  assert.equal(details.publicationYear, 2006);
  assert.equal(details.editionLanguage, 'English');
  assert.equal(details.partial, false);
});

test('fixture sanity: real journal sample has dated events and genres', () => {
  assert.ok(sample.events.length >= 5);
  assert.ok(sample.works.every((work) => work.hcWorkId));
  assert.ok(sample.events.every((event) => event.workId.startsWith('hc:')));
  const genres = sample.works.flatMap((work) => work.genres);
  assert.ok(genres.includes('Comics'));
  assert.ok(sample.events.some((event) => event.reread));
});

test('fetchJournal paginates on a mocked endpoint and persists details', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.query.includes('me {')) {
      return {
        status: 200,
        ok: true,
        headers: new Map(),
        json: async () => ({ data: { me: [{ id: 34748, username: 'hattivatt' }] } }),
      };
    }
    const offset = body.variables.offset;
    const limit = body.variables.limit;
    const allRows = [
      rowByWork(),
      {
        ...rowByWork(),
        id: 2,
        book_id: 42,
        user_book_reads: [],
        last_read_date: null,
        book: { ...rowByWork().book, id: 42, title: 'Beta' },
      },
      {
        ...rowByWork(),
        id: 3,
        book_id: 43,
        status_id: 1,
        read_count: 0,
        user_book_reads: [],
        last_read_date: null,
        book: { ...rowByWork().book, id: 43, title: 'Gamma' },
      },
    ];
    const rows = allRows.slice(offset, offset + limit);
    return {
      status: 200,
      ok: true,
      headers: new Map([['ratelimit', '"Free";r=1;t=8']]),
      json: async () => ({
        data: {
          total: body.variables.withTotal ? { aggregate: { count: 3 } } : undefined,
          rows,
        },
      }),
    };
  };

  try {
    hardcover.resetCaches();
    const journal = await hardcover.fetchJournal(34748, { pageSize: 1, maxPages: 5 });
    assert.equal(calls.filter((call) => call.query.includes('JournalPage')).length, 3);
    assert.equal(journal.events.length, 3); // 2 reads for work 377567 + 1 undated work 42
    assert.equal(journal.totals.userBooks, 3);
    assert.equal(journal.works.size, 3);
    // A "want to read" row is skipped and reported by status.
    assert.equal(journal.statusFilter.skippedNonFinished, 1);
    assert.deepEqual(journal.statusFilter.byStatus, { '1:wish': 1 });
    assert.deepEqual(journal.keepStatusIds, [3, 5]);
    // Metadata is persisted for the stats payload.
    assert.equal(bookCache.getDetails(377567).title, 'Daemon');
    assert.equal(bookCache.getDetails(42).title, 'Beta');
  } finally {
    global.fetch = originalFetch;
    hardcover.resetCaches();
  }
});

test('resolveUser rejects a foreign profile instead of silently using the owner', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    status: 200,
    ok: true,
    headers: new Map(),
    json: async () => ({ data: { me: [{ id: 34748, username: 'hattivatt' }] } }),
  });
  try {
    hardcover.resetCaches();
    const owner = await hardcover.resolveUser('me');
    assert.equal(owner.id, 34748);
    await assert.rejects(() => hardcover.resolveUser('99999'), /только свой журнал/);
  } finally {
    global.fetch = originalFetch;
    hardcover.resetCaches();
  }
});
