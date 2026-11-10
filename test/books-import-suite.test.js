'use strict';

/**
 * Books: import, refresh and resolve jobs suite: the former standalone `*.test.js` files of this domain,
 * merged into one process (R19 test-suite consolidation).
 *
 * Each block below is its original file, kept verbatim inside its own
 * `describe()`:
 *
 *   - the describe title is the file stem, so every test stays greppable as
 *     `<file> > <original title>`;
 *   - the block scope keeps a file's helper names from colliding with its
 *     neighbours;
 *   - the hooks a file declared (`test.before`/`test.after`/
 *     `test.beforeEach`) stay scoped to that block instead of applying to the
 *     whole process.
 *
 * The tmp root is one `helpers/env` run for the whole suite, created BEFORE
 * any `server/**` require (every cache namespace reads its root once, at load
 * time). A file's own tmp setup folds into that root — the module singletons
 * are process-wide anyway, so a second root would only desynchronise a file
 * from the directory its assertions read. Tests keep apart by `userKey`/work
 * key, never by root.
 *
 * `env.cleanupTmpDirs()` removes every directory this run created.
 */

const { describe, after, before } = require('node:test');
const env = require('./helpers/env');

const run = env.makeTmpCache('books-import-suite', { budgets: false });

after(() => {
  env.cleanupTmpDirs();
});

process.on('exit', () => {
  env.cleanupTmpDirs();
});


describe('books-hardcover-incremental', () => {
  /**
   * Incremental Hardcover refresh (user report, 28.10.2026).
   *
   * Adding ONE book used to re-read the whole journal and then run a full
   * LiveLib metadata pass inside the same job, so the progress screen sat on
   * «Читаем журнал» for minutes. The contract pinned here:
   *
   *   - a cached `sync.lastSyncAt` turns the refresh into
   *     `user_books.updated_at > since` — one page, no full journal call;
   *   - changed user_books replace their cached events, untouched books survive;
   *   - `{ force: true }` still does a full pass (the explicit option);
   *   - a shrunk journal (deleted book, invisible to `updated_at`) falls back to
   *     the full pass automatically;
   *   - an unchanged incremental journal queues NO metadata resolve, a changed
   *     one queues it as a separate job instead of blocking this one.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;
  process.env.HARDCOVER_API_TOKEN = 'hc_pat_test_token_value';

  const bookCache = require('../server/books/book-cache');
  const hardcover = require('../server/books/hardcover');
  const importJobs = require('../server/books/import');

  const OWNER = 34748;

  function resetGate() {
    hardcover.gate.stamps = [];
    hardcover.gate.lastRequestAt = 0;
    hardcover.gate.blockedUntil = 0;
  }

  function row(id, bookId, extra = {}) {
    return {
      id,
      book_id: bookId,
      edition_id: null,
      rating: 4,
      status_id: 3,
      read_count: 1,
      first_read_date: '2025-01-01',
      last_read_date: '2025-01-02',
      updated_at: '2026-10-28T10:00:00Z',
      book: {
        id: bookId,
        title: `Book ${bookId}`,
        slug: `book-${bookId}`,
        pages: 100,
        release_year: 2025,
        contributions: [],
        book_series: [],
        taggings: [],
      },
      edition: null,
      user_book_reads: [],
      ...extra,
    };
  }

  function cachedProfile() {
    return {
      schemaVersion: 1,
      source: 'hardcover',
      userKey: String(OWNER),
      importedAt: '2026-10-20T00:00:00.000Z',
      events: [
        {
          id: 'hc:ub:100',
          source: 'hardcover',
          sourceBookId: '10',
          userBookId: 100,
          workId: 'hc:10',
          title: 'Old A',
          status: 'read',
          finishedAt: '2025-01-02',
        },
        {
          id: 'hc:ub:101',
          source: 'hardcover',
          sourceBookId: '11',
          userBookId: 101,
          workId: 'hc:11',
          title: 'Old B',
          status: 'read',
          finishedAt: '2025-02-02',
        },
      ],
      sync: {
        schemaVersion: 1,
        mode: 'full',
        lastSyncAt: '2026-10-27T00:00:00.000Z',
        fullSyncedAt: '2026-10-27T00:00:00.000Z',
        userBooksTotal: 2,
      },
      warnings: [],
    };
  }

  async function seed() {
    await bookCache.saveProfile('hardcover', String(OWNER), cachedProfile());
  }

  /**
   * Mock endpoint. `incremental(request)` returns `{ total, rows }`;
   * `full(request)` the same. Every call is counted by kind.
   */
  function installFetch({ incremental, full }) {
    const calls = { me: 0, incremental: 0, full: 0 };
    const original = global.fetch;
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      const query = String(body.query || '');
      let payload;
      if (query.includes('me {')) {
        calls.me++;
        payload = { data: { me: [{ id: OWNER, username: 'owner' }] } };
      } else if (query.includes('IncrementalJournalPage')) {
        calls.incremental++;
        const result = incremental ? incremental(body.variables) : { total: 2, rows: [] };
        payload = {
          data: {
            total: body.variables.withTotal ? { aggregate: { count: result.total } } : undefined,
            rows: result.rows,
          },
        };
      } else {
        calls.full++;
        const result = full ? full(body.variables) : { total: 2, rows: [] };
        payload = {
          data: {
            total: body.variables.withTotal ? { aggregate: { count: result.total } } : undefined,
            rows: result.rows,
          },
        };
      }
      return { status: 200, ok: true, headers: new Map(), json: async () => payload };
    };
    return {
      calls,
      restore() {
        global.fetch = original;
      },
    };
  }

  async function runJob(options) {
    resetGate();
    const job = importJobs.startHardcoverImport('me', options);
    await importJobs.idle();
    return importJobs.getStatus(job.id);
  }

  test('0 new books: one incremental page, cached events untouched, no resolve job', async () => {
    await seed();
    const mock = installFetch({});
    try {
      const status = await runJob();
      assert.equal(mock.calls.full, 0, 'the full journal must not be fetched');
      assert.equal(mock.calls.incremental, 1);
      assert.equal(status.stage, 'done');
      assert.equal(status.sync.mode, 'incremental');
      assert.equal(status.sync.changedRows, 0);
      assert.equal(status.resolveQueued, null, 'an unchanged journal has nothing to resolve');
      assert.equal(status.percent, 100);

      const profile = bookCache.getProfile('hardcover', String(OWNER));
      assert.equal(profile.events.length, 2);
      assert.deepEqual(
        profile.events.map((event) => event.id).sort(),
        ['hc:ub:100', 'hc:ub:101']
      );
      assert.equal(profile.sync.mode, 'incremental');
      assert.ok(
        profile.sync.lastSyncAt > '2026-10-27T00:00:00.000Z',
        'the cursor advances to the job start time'
      );
    } finally {
      mock.restore();
    }
  });

  test('1 new book: one changed page, old events kept, resolve queued separately', async () => {
    await seed();
    const mock = installFetch({
      incremental: () => ({ total: 3, rows: [row(102, 12)] }),
    });
    try {
      const status = await runJob();
      assert.equal(mock.calls.full, 0);
      assert.equal(mock.calls.incremental, 1);
      assert.equal(status.sync.mode, 'incremental');
      assert.equal(status.sync.changedRows, 1);
      assert.equal(status.sync.userBooksTotal, 3);
      assert.match(String(status.resolveQueued), /^resolve-/);

      const profile = bookCache.getProfile('hardcover', String(OWNER));
      assert.equal(profile.events.length, 3);
      const ids = profile.events.map((event) => event.id).sort();
      assert.deepEqual(ids, ['hc:ub:100', 'hc:ub:101', 'hc:ub:102']);
    } finally {
      mock.restore();
    }
  });

  test('a changed user_book replaces its cached events (no duplicates)', async () => {
    await seed();
    // Same user_book 100, now two reads: the old synthetic event must go away.
    const mock = installFetch({
      incremental: () => ({
        total: 2,
        rows: [
          row(100, 10, {
            read_count: 2,
            user_book_reads: [
              { id: 900, started_at: '2025-01-01', finished_at: '2025-01-02', edition_id: null },
              { id: 901, started_at: '2026-01-01', finished_at: '2026-01-02', edition_id: null },
            ],
          }),
        ],
      }),
    });
    try {
      const status = await runJob();
      assert.equal(status.sync.changedRows, 1);
      const profile = bookCache.getProfile('hardcover', String(OWNER));
      const own = profile.events.filter((event) => Number(event.userBookId) === 100);
      assert.equal(own.length, 2);
      assert.deepEqual(own.map((event) => event.id).sort(), ['hc:read:900', 'hc:read:901']);
      assert.equal(profile.events.length, 3); // 101 untouched + two reads of 100
    } finally {
      mock.restore();
    }
  });

  test('force:true still reads the whole journal', async () => {
    await seed();
    const mock = installFetch({
      full: () => ({ total: 2, rows: [row(100, 10), row(101, 11)] }),
    });
    try {
      const status = await runJob({ force: true });
      assert.equal(mock.calls.incremental, 0);
      assert.equal(mock.calls.full, 1);
      assert.equal(status.force, true);
      assert.equal(status.sync.mode, 'full');
      assert.equal(status.sync.changedRows, null);
      assert.equal(bookCache.getProfile('hardcover', String(OWNER)).sync.mode, 'full');
    } finally {
      mock.restore();
    }
  });

  test('a shrunk journal falls back to the full pass (deleted book)', async () => {
    await seed();
    const mock = installFetch({
      incremental: () => ({ total: 1, rows: [] }),
      full: () => ({ total: 1, rows: [row(100, 10)] }),
    });
    try {
      const status = await runJob();
      assert.equal(mock.calls.incremental, 1);
      assert.equal(mock.calls.full, 1, 'the full pass must repair the deleted row');
      assert.equal(status.sync.mode, 'full');
      assert.equal(status.sync.fallback, 'journal-shrank');
      const profile = bookCache.getProfile('hardcover', String(OWNER));
      assert.equal(profile.events.length, 1);
      assert.equal(profile.sync.userBooksTotal, 1);
    } finally {
      mock.restore();
    }
  });
  after(() => env.resetMutableState());
});


describe('books-hardcover', () => {
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
  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;
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
    // Raw journal keys travel with the event so stats can re-filter a persisted
    // profile without a network round-trip.
    assert.equal(events[1].statusId, 3);
    assert.equal(events[1].userBookId, 19718676);
    assert.equal(events[0].statusId, 3);
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

  test('shelf-only statuses (want/paused) produce no events; reading is a plan event', () => {
    for (const statusId of [1, 4]) {
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

    // «Читаю сейчас» is persisted for the strip, never as a finished read.
    const reading = rowByWork();
    reading.status_id = 2;
    reading.read_count = 0;
    reading.user_book_reads = [{ id: 21, started_at: '2026-10-20', finished_at: null }];
    reading.last_read_date = null;
    const [now] = hardcover.eventsFromRow(reading);
    assert.equal(now.id, 'hc:ub:19718676');
    assert.equal(now.status, 'reading');
    assert.equal(now.statusId, 2);
    assert.equal(now.finishedAt, null);
    assert.equal(now.startedAt, '2026-10-20');
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

  test('non-finished rows are counted by status, reading is stored not skipped', () => {
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
    assert.equal(counter.skippedNonFinished, 2);
    assert.deepEqual(counter.byStatus, { '1:wish': 1, '4:paused': 1 });
    // `keepStatus` is the reading-history contract; `storeStatus` additionally
    // persists the «Читаю сейчас» shelf state for the strip.
    assert.deepEqual(hardcover.HARDCOVER_KEEP_STATUS_IDS, [3, 5]);
    assert.deepEqual(hardcover.HARDCOVER_READING_STATUS_IDS, [2]);
    assert.equal(hardcover.keepStatus(3), true);
    assert.equal(hardcover.keepStatus(5), true);
    assert.equal(hardcover.keepStatus(2), false);
    assert.equal(hardcover.storeStatus(2), true);
    assert.equal(hardcover.storeStatus(1), false);
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
  after(() => env.resetMutableState());
});


describe('books-import-hardcover', () => {
  /**
   * Hardcover import: a repeat click always re-fetches the journal.
   *
   * Unlike LiveLib (20+ polite requests, 12 h reuse TTL), a Hardcover journal is
   * ~7 GraphQL requests, and a cached profile may predate `statusId`. There is
   * deliberately no reuse guard, so a re-import refreshes the status schema.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;
  process.env.HARDCOVER_API_TOKEN = 'hc_pat_test_token_value';

  const bookCache = require('../server/books/book-cache');
  const hardcover = require('../server/books/hardcover');
  const importJobs = require('../server/books/import');

  test('Hardcover import always re-fetches, even with a fresh cached profile', async () => {
    await bookCache.saveProfile('hardcover', '34748', {
      schemaVersion: 1,
      source: 'hardcover',
      userKey: '34748',
      importedAt: new Date().toISOString(),
      events: [{ id: 'hc:read:old', source: 'hardcover', sourceBookId: '7', status: 'read' }],
      warnings: [],
    });

    const originalFetch = global.fetch;
    let journalCalls = 0;
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.query.includes('me {')) {
        return {
          status: 200,
          ok: true,
          headers: new Map(),
          json: async () => ({ data: { me: [{ id: 34748, username: 'hattivatt' }] } }),
        };
      }
      journalCalls++;
      return {
        status: 200,
        ok: true,
        headers: new Map(),
        json: async () => ({
          data: {
            total: body.variables.withTotal ? { aggregate: { count: 1 } } : undefined,
            rows: [
              {
                id: 555,
                book_id: 900,
                edition_id: null,
                rating: 4,
                status_id: 3,
                read_count: 1,
                first_read_date: '2025-01-01',
                last_read_date: '2025-01-02',
                book: {
                  id: 900,
                  title: 'Fresh Work',
                  slug: 'fresh-work',
                  pages: 100,
                  release_year: 2025,
                  contributions: [],
                  book_series: [],
                  taggings: [],
                },
                edition: null,
                user_book_reads: [],
              },
            ],
          },
        }),
      };
    };

    try {
      hardcover.resetCaches();
      const job = importJobs.startHardcoverImport('me');
      assert.equal(job.done, false);
      await importJobs.idle();
      const status = importJobs.getStatus(job.id);
      assert.equal(status.stage, 'done');
      assert.equal(status.reused, false);
      assert.equal(journalCalls, 1);

      const refreshed = bookCache.getProfile('hardcover', '34748');
      assert.equal(refreshed.events.length, 1);
      assert.equal(refreshed.events[0].workId, 'hc:900');
      assert.equal(refreshed.events[0].statusId, 3);
      assert.match(refreshed.events[0].id, /^hc:ub:555$/);
      assert.equal(refreshed.events[0].userBookId, 555);
    } finally {
      global.fetch = originalFetch;
      hardcover.resetCaches();
    }
  });
  after(() => env.resetMutableState());
});


describe('books-import', () => {
  /**
   * Books import job: repeat-import guard.
   *
   * A cached LiveLib profile younger than the reuse TTL must be reused instead
   * of re-scraping the whole profile (LiveLib politeness: 20+ pages per full
   * import). `{ force: true }` bypasses the guard; a stale profile does too.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const BOOK_CACHE_DIR = run.cacheBookDir;
  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const importJobs = require('../server/books/import');

  function profile(importedAt) {
    return {
      schemaVersion: 1,
      source: 'livelib',
      userKey: 'tester',
      importedAt,
      events: [
        { id: 'll:1', sourceBookId: '1', title: 'One', status: 'read' },
        { id: 'll:2', sourceBookId: '2', title: 'Two', status: 'read' },
      ],
      warnings: [],
    };
  }

  test('a fresh cached LiveLib profile is reused without a scrape', async () => {
    await bookCache.saveProfile('livelib', 'reuse', profile(new Date().toISOString()));

    const job = importJobs.startLivelibImport('reuse');
    assert.equal(job.done, true);
    assert.equal(job.reused, true);
    assert.equal(job.stage, 'done');
    assert.equal(job.events, 2);
    assert.ok(job.cachedAt);

    const status = importJobs.getStatus(job.id);
    assert.equal(status.reused, true);
    assert.equal(status.events, 2);
    assert.equal(status.error, null);
  });

  test('the reuse window rejects stale and invalid timestamps', () => {
    const now = Date.now();
    assert.equal(importJobs.isFreshImport(new Date(now - 1000).toISOString()), true);
    assert.equal(
      importJobs.isFreshImport(new Date(now - importJobs.LIVELIB_REIMPORT_TTL_MS - 1000).toISOString()),
      false
    );
    assert.equal(importJobs.isFreshImport(null), false);
    assert.equal(importJobs.isFreshImport('not-a-date'), false);
  });

  test('a stale cached profile does not take the reuse path', async () => {
    const stale = new Date(Date.now() - importJobs.LIVELIB_REIMPORT_TTL_MS - 60 * 1000).toISOString();
    await bookCache.saveProfile('livelib', 'stale', profile(stale));

    // Starting a real import would scrape LiveLib; only assert the guard.
    assert.equal(importJobs.isFreshImport(stale), false);
    const cached = bookCache.getProfile('livelib', 'stale');
    assert.equal(cached.events.length, 2);
  });
  after(() => env.resetMutableState());
});


describe('books-import-two-phase', () => {
  /**
   * Two-phase LiveLib import (light + deep) and the deep-scan progress mechanism.
   *
   * No network: the fake fetch replays the captured fixtures —
   *   - bulk page 1 (100 books, month headers),
   *   - RSC page 1/2/3 (20 distinct user_books with exact read dates each).
   *
   * Contract under test:
   *   - light: 3 requests, every book imported, only page 1 dated;
   *   - deep: exact dates for the rest, persisted every 5 pages, `percent` in the
   *     job status, resumable from `deepScan.lastPage`;
   *   - light re-check keeps the dates a previous deep scan collected;
   *   - `deep: 'auto'` runs deep only while undated events remain.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const zlib = require('node:zlib');

  const BOOK_CACHE_DIR = run.cacheBookDir;
  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;
  // The import job ends with the metadata resolve stage. These tests are about
  // the scrape, so the network budget is zeroed: no Lитрес pause per book and no
  // LiveLib card fetch — resolve must be a no-op here, never a live request.
  process.env.BOOKS_LITRES_BUDGET = '0';
  process.env.BOOKS_LIVELIB_CARD_BUDGET = '0';

  const bookCache = require('../server/books/book-cache');
  const livelib = require('../server/books/livelib');
  const importJobs = require('../server/books/import');

  const FIXTURES = path.join(__dirname, 'fixtures');
  const page1 = zlib
    .gunzipSync(fs.readFileSync(path.join(FIXTURES, 'livelib-read-page1.html.gz')))
    .toString('utf8');
  const page2 = zlib
    .gunzipSync(fs.readFileSync(path.join(FIXTURES, 'livelib-read-page2.html.gz')))
    .toString('utf8');
  const page3 = zlib
    .gunzipSync(fs.readFileSync(path.join(FIXTURES, 'livelib-read-page3.html.gz')))
    .toString('utf8');
  const bulkJson = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, 'livelib-bulk-page1.json.gz'))).toString('utf8')
  );

  function htmlResponse(html, url) {
    return {
      status: 200,
      url,
      headers: new Map(),
      text: async () => html,
    };
  }

  function jsonResponse(payload, url) {
    return {
      status: 200,
      url,
      headers: new Map(),
      text: async () => JSON.stringify(payload),
    };
  }

  /**
   * Fake LiveLib: bootstrap page, bulk JSON, RSC pages 1..3. Page 4+ repeats
   * page 3 so the scan stops there exactly like a shrunk collection.
   */
  function fakeLivelib({ pageLimit = 3 } = {}) {
    const calls = [];
    const rscPages = [];
    const fetchImpl = async (url, options = {}) => {
      const href = String(url);
      calls.push({ url: href, method: (options.method || 'GET').toUpperCase() });
      if (href.includes('biglist')) {
        // The captured fixture says `last_page: false` (it was page 1 of several);
        // the fake serves one page and declares it the last.
        return jsonResponse({ ...bulkJson, last_page: true }, href);
      }
      if (href.includes('/reader/') && !href.includes('ordering=')) {
        return htmlResponse('<html><body>bootstrap</body></html>', href);
      }
      const parsed = new URL(href);
      const page = Number(parsed.searchParams.get('page') || 1);
      rscPages.push(page);
      const body = page === 1 ? page1 : page === 2 ? page2 : page3;
      const finalUrl = 'https://www.livelib.ru/users/50064/books/read?ordering=read_at_desc' +
        (page > 1 ? `&page=${page}` : '');
      if (page > pageLimit) return htmlResponse(page3, finalUrl);
      return htmlResponse(body, finalUrl);
    };
    return { fetchImpl, calls, rscPages };
  }

  async function freshCache() {
    for (const name of fs.readdirSync(bookCache.PROFILES_DIR)) {
      fs.unlinkSync(path.join(bookCache.PROFILES_DIR, name));
    }
    bookCache.clearMemory();
  }

  test('light import: bootstrap + bulk + one RSC page, only page 1 dated', async () => {
    await freshCache();
    const fake = fakeLivelib();
    const result = await livelib.importLivelib('tester', {
      fetchImpl: fake.fetchImpl,
      bootstrapDelayMs: 0,
      delayMs: 0,
    });

    assert.equal(result.totals.events, 100); // bulk page 1 = 100 books
    assert.equal(result.totals.dated, 20); // RSC page 1 only
    assert.equal(result.totals.undated, 0); // every other book has at least a month
    assert.equal(result.totals.monthOnly, 80);
    assert.equal(result.requests.total, 2); // bulk + one RSC page (bootstrap excluded)
    assert.equal(fake.calls.length, 3); // bootstrap GET + bulk POST + RSC page 1
    assert.equal(fake.rscPages.length, 1);
    assert.equal(result.profile.deepScan, undefined);

    // Every page-1 book is in the events with its exact date; the rest honestly
    // has no `finishedAt`.
    const first = result.profile.events.find((event) => event.id === 'll:53103775');
    assert.equal(first.finishedAt, '2026-09-14');
    const undated = result.profile.events.filter((event) => !event.finishedAt);
    assert.equal(undated.length, 80);
    assert.ok(undated.every((event) => event.readMonth == null || /^\d{4}-\d{2}$/.test(event.readMonth)));
  });

  test('deep scan dates the imported events, persists batches and resumes', async () => {
    await freshCache();
    const light = await livelib.importLivelib('tester', {
      fetchImpl: fakeLivelib().fetchImpl,
      bootstrapDelayMs: 0,
      delayMs: 0,
    });
    const profile = light.profile;
    await bookCache.saveProfile('livelib', 'tester', profile);

    const fake = fakeLivelib();
    const batches = [];
    const progress = [];
    const deep = await livelib.deepScanProfile('tester', profile, {
      fetchImpl: fake.fetchImpl,
      delayMs: 0,
      onProgress: (entry) => progress.push(entry),
      onBatch: async (draft, state) => {
        batches.push({ lastPage: state.lastPage, dated: state.dated });
        await bookCache.saveProfile('livelib', 'tester', draft);
      },
    });

    // Page 1 is already fresh, so the scan requests 2 and 3, then page 4 comes
    // back with the offset:0 payload — the parser refuses it and stops instead
    // of writing page-1 dates twice.
    assert.deepEqual(fake.rscPages, [2, 3, 4]);
    assert.equal(deep.dated, 60); // 20 (light) + 20 + 20
    assert.equal(deep.total, 100);
    assert.equal(deep.skipped, false);
    assert.equal(deep.startPage, 2);
    assert.ok(progress.some((entry) => entry.page === 3 && entry.dated === 60));
    assert.ok(deep.warnings.some((warning) => /returned the payload for offset 0/.test(warning)));

    // Progress is persisted: a stored profile can be read mid-scan.
    const stored = bookCache.getProfile('livelib', 'tester');
    assert.equal(stored.deepScan.lastPage, 3);
    assert.equal(stored.deepScan.pageTotal, 63);
    assert.equal(stored.deepScan.dated, 60);
    assert.equal(stored.deepScan.done, false);
    assert.ok(batches.length >= 1);

    // Resume: the next run starts after the persisted page, not from page 1,
    // and an unparsable page leaves the collected dates untouched.
    const fake2 = fakeLivelib({ pageLimit: 6 });
    const resumed = await livelib.deepScanProfile('tester', stored, {
      fetchImpl: fake2.fetchImpl,
      delayMs: 0,
    });
    assert.equal(resumed.startPage, 4);
    assert.equal(fake2.rscPages[0], 4);
    assert.equal(resumed.dated, 60);
  });

  test('a completed deep scan is skipped instead of re-reading 63 pages', async () => {
    await freshCache();
    const profile = {
      schemaVersion: 1,
      source: 'livelib',
      userKey: 'done',
      events: [{ id: 'll:1', sourceUserBookId: '1', finishedAt: '2024-01-01' }],
      deepScan: { pageTotal: 63, lastPage: 63, done: true, dated: 1, total: 1 },
    };
    await bookCache.saveProfile('livelib', 'done', profile);
    const fake = fakeLivelib();
    const result = await livelib.deepScanProfile('done', profile, { fetchImpl: fake.fetchImpl });
    assert.equal(result.skipped, true);
    assert.equal(fake.calls.length, 0);
  });

  test('light re-check keeps deep-scan dates instead of throwing them away', () => {
    const existing = {
      events: [
        { id: 'll:1', finishedAt: '2022-05-06', rating10: 8 },
        { id: 'll:2', finishedAt: '2022-05-07', rating10: 9 },
      ],
    };
    const fresh = [
      { id: 'll:1', finishedAt: null, rating10: 8, readMonth: '2022-05' },
      { id: 'll:2', finishedAt: null, rating10: null },
      { id: 'll:3', finishedAt: '2026-09-01', rating10: 6 },
    ];
    assert.equal(livelib.mergeExistingDates(fresh, existing), 2);
    assert.equal(fresh[0].finishedAt, '2022-05-06');
    assert.equal(fresh[1].finishedAt, '2022-05-07');
    assert.equal(fresh[1].rating10, 9); // rating restored too
    assert.equal(fresh[0].readMonth, null);
    assert.equal(fresh[2].finishedAt, '2026-09-01'); // new event untouched
    // No existing profile = no-op.
    assert.equal(livelib.mergeExistingDates(fresh, null), 0);
  });

  test('job status exposes deep percent; auto-deep runs while dates are missing', async () => {
    await freshCache();
    global.fetch = fakeLivelib().fetchImpl;
    // This file pins the scrape/deep contract, not the metadata chain (that is
    // covered by books-resolve*.test.js and books-livelib-file-resolve.test.js).
    // Without the stub the job's resolve stage would walk 100 ISBN-less events
    // through Литрес/GB/OL with their politeness pauses — minutes of wall clock
    // and, worse, real requests if a provider ever bypassed the fake fetch.
    const resolveModule = require('../server/books/resolve');
    const realResolveProfile = resolveModule.resolveProfile;
    resolveModule.resolveProfile = async (profile) => ({
      total: profile.events.length,
      skippedPlanShelf: 0,
      cached: 0,
      resolvedIsbn: 0,
      resolvedTitle: 0,
      resolvedGoogle: 0,
      resolvedOpenLibrary: 0,
      resolvedLitres: 0,
      resolvedLivelibCard: 0,
      resolvedHardcoverCard: 0,
      resolvedHardcoverFromLitres: 0,
      enriched: 0,
      withMetadata: 0,
      ambiguous: 0,
      unmatched: profile.events.length,
      requests: 0,
      resolved: 0,
      providerChain: {},
      lookupErrors: [],
    });
    try {
      const job = importJobs.startLivelibImport('jobtester', { force: true, deep: 'auto' });
      await importJobs.idle();
      const status = importJobs.getStatus(job.id);

      assert.equal(status.done, true);
      assert.equal(status.stage, 'done');
      assert.equal(status.percent, 100);
      assert.ok(status.deep, 'deep block is reported');
      assert.equal(status.deep.pageTotal, 63);
      assert.equal(status.deep.percent, Math.round((3 / 63) * 100));
      assert.equal(status.deep.dated, 60);
      assert.equal(status.deep.done, false);
      // Every event now has at least a month from the bulk pass: nothing is
      // "undated", even though only page 1-3 books carry an exact day.
      assert.equal(status.undatedEventCount, 0);
      assert.equal(status.deep.monthOnly, 40);
    } finally {
      resolveModule.resolveProfile = realResolveProfile;
      delete global.fetch;
    }
  });
  after(() => env.resetMutableState());
});


describe('books-livelib', () => {
  /**
   * LiveLib parsers against real (gzipped) page fixtures captured on
   * 27.10.2026 from the public Margaret profile:
   *   - livelib-read-page1.html.gz        Next.js page 1 (RSC payload)
   *   - livelib-bulk-page1.json.gz        legacy biglist, per_page=100
   * No network access in these tests.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const zlib = require('node:zlib');

  const livelib = require('../server/books/livelib');

  const FIXTURES = path.join(__dirname, 'fixtures');
  const pageHtml = zlib
    .gunzipSync(fs.readFileSync(path.join(FIXTURES, 'livelib-read-page1.html.gz')))
    .toString('utf8');
  const page2Html = zlib
    .gunzipSync(fs.readFileSync(path.join(FIXTURES, 'livelib-read-page2.html.gz')))
    .toString('utf8');
  const page3Html = zlib
    .gunzipSync(fs.readFileSync(path.join(FIXTURES, 'livelib-read-page3.html.gz')))
    .toString('utf8');
  const bulkJson = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, 'livelib-bulk-page1.json.gz'))).toString('utf8')
  );

  test('RSC page parses 20 user_books, the profile counter and the page count', () => {
    const parsed = livelib.parseRscHtml(pageHtml);
    assert.equal(parsed.rows.length, 20);
    assert.equal(parsed.total, 1245);
    assert.equal(parsed.pageTotal, 63);
    assert.match(parsed.nextPage, /offset=20/);

    const first = parsed.rows[0];
    assert.equal(first.userBookId, '53103775');
    assert.equal(first.bookId, '1002745594');
    assert.equal(first.title, 'Аннигиляция');
    assert.deepEqual(first.authors, ['Джефф Вандермеер']);
    assert.equal(first.rating, 7); // native 10-scale, not 5
    assert.deepEqual(first.readDate, { year: 2026, month: 9, day: 14 });
    assert.deepEqual(first.publishers, ['Эксмо']);
  });

  test('every RSC row has a personal rating and an exact read date', () => {
    const parsed = livelib.parseRscHtml(pageHtml);
    assert.equal(parsed.rows.filter((row) => row.rating != null).length, 20);
    assert.equal(parsed.rows.filter((row) => row.readDate).length, 20);
    // Sanity: ratings stay on the 0..10 scale.
    for (const row of parsed.rows) assert.ok(row.rating >= 1 && row.rating <= 10);
  });

  test('bulk page parses user_book ids, ISBN and edition metadata', () => {
    const rows = livelib.parseBulkContent(bulkJson.content);
    assert.equal(rows.length, 100);
    assert.equal(new Set(rows.map((row) => row.userBookId)).size, 100);
    assert.equal(rows.filter((row) => row.isbn).length, 98);
    assert.equal(rows.filter((row) => row.publisher).length, 99);
    assert.equal(rows.filter((row) => row.year).length, 99);

    const first = rows[0];
    assert.equal(first.userBookId, '53103775');
    assert.equal(first.bookId, '1002745594');
    assert.equal(first.isbn, '978-5-699-98967-6');
    assert.equal(first.publisher, 'Эксмо');
    assert.equal(first.year, 2018);
    assert.equal(first.rating5, 3.5);
    assert.equal(first.readMonth, '2026-09');

    // Work-level entries have no edition id but keep a usable id for matching.
    const workLevel = rows.find((row) => row.userBookId === '52893697');
    assert.equal(workLevel.bookId, '1000452816');
    assert.equal(workLevel.editionId, null);
  });

  test('buildEvent merges RSC dates with bulk metadata by user_book id', () => {
    const parsed = livelib.parseRscHtml(pageHtml);
    const bulk = new Map(
      livelib.parseBulkContent(bulkJson.content).map((row) => [row.userBookId, row])
    );
    const event = livelib.buildEvent(parsed.rows[0], bulk.get('53103775'));
    assert.equal(event.id, 'll:53103775');
    assert.equal(event.source, 'livelib');
    assert.equal(event.sourceBookId, '1002745594');
    assert.equal(event.rating, 7);
    assert.equal(event.ratingScale, 10);
    assert.equal(event.rating10, 7);
    assert.equal(event.finishedAt, '2026-09-14');
    assert.equal(event.edition.isbn, '978-5-699-98967-6');
    assert.equal(event.edition.publisher, 'Эксмо');
    assert.equal(event.edition.year, 2018);
    assert.equal(event.edition.language, 'Русский');
    assert.equal(event.workId, null);
  });

  test('bulk-only events keep the month but never invent a day', () => {
    const bulk = livelib.parseBulkContent(bulkJson.content);
    const event = livelib.buildEvent(null, bulk[0]);
    assert.equal(event.finishedAt, null);
    assert.equal(event.readMonth, '2026-09');
    // The 5-star bulk rating is converted to the unified 10-scale.
    assert.equal(event.rating10, 7);
  });

  test('readDateToIso validates calendar dates', () => {
    assert.equal(livelib.readDateToIso({ year: 2026, month: 9, day: 14 }), '2026-09-14');
    assert.equal(livelib.readDateToIso({ year: 2026, month: 2, day: 31 }), null);
    assert.equal(livelib.readDateToIso({ year: 0, month: 1, day: 1 }), null);
    assert.equal(livelib.readDateToIso(null), null);
  });

  test('an empty page is a canary error, not an empty profile', () => {
    assert.throws(
      () => livelib.parseRscHtml('<html><body>no payload here</body></html>'),
      /RSC-payload/
    );
  });

  test('repeated pagination pages stop the scrape instead of re-reading 62 times', async () => {
    const originalFetch = global.fetch;
    let requests = 0;
    // A server that ignores ?page= renders page 1 again: no offset-matched
    // payload exists, the parser falls back to offset 0 and the scan stops
    // instead of hammering 61 more pages.
    global.fetch = async () => {
      requests++;
      return {
        status: 200,
        url: 'https://www.livelib.ru/users/50064/books/read?ordering=read_at_desc',
        headers: new Map(),
        text: async () => pageHtml,
      };
    };
    try {
      const result = await livelib.fetchRsc('Margaret', { maxPages: 10, delayMs: 0 });
      // Page 2 came back with the offset:0 payload: the parser refuses it and
      // the scan stops after the first (valid) page instead of hammering 61 more.
      assert.equal(requests, 2);
      assert.equal(result.pagesFetched, 1);
      assert.equal(result.rows.length, 20);
      assert.ok(result.warnings.some((warning) => /returned the payload for offset 0/.test(warning)));
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('pages 2 and 3 read the offset-matched payload, not page 1 again', () => {
    // Each page N>1 carries TWO dehydrated queries: offset:0 (page 1) and the
    // requested offset. Taking the first block is the bug this test pins.
    const first = livelib.parseRscHtml(page2Html, { page: 2 });
    assert.equal(first.offset, 20);
    assert.equal(first.rows.length, 20);
    assert.equal(first.rows[0].userBookId, '44519359');
    assert.notEqual(first.rows[0].userBookId, '53103775');

    const third = livelib.parseRscHtml(page3Html, { page: 3 });
    assert.equal(third.offset, 40);
    assert.equal(third.rows[0].userBookId, '41048167');

    // Every row of the requested page carries an exact read date.
    assert.equal(first.rows.filter((row) => row.readDate).length, 20);
    assert.equal(third.rows.filter((row) => row.readDate).length, 20);
    assert.equal(first.total, 1245);
    assert.equal(third.pageTotal, 63);

    const ids = new Set([
      ...first.rows.map((row) => row.userBookId),
      ...third.rows.map((row) => row.userBookId),
    ]);
    assert.equal(ids.size, 40);

    // Without a page hint the LAST payload wins (the router appends the page
    // the user asked for), which keeps a standalone fixture useful.
    const implicit = livelib.parseRscHtml(page3Html);
    assert.equal(implicit.offset, 40);
    assert.deepEqual(implicit.offsets, [0, 40]);
  });

  test('fetchRsc collects distinct rows across offset-matched pages', async () => {
    const originalFetch = global.fetch;
    const byPage = new Map([
      [1, pageHtml],
      [2, page2Html],
      [3, page3Html],
    ]);
    const requestedPages = [];
    global.fetch = async (url) => {
      const parsedUrl = new URL(String(url));
      const page = Number(parsedUrl.searchParams.get('page') || 1);
      requestedPages.push(page);
      return {
        status: 200,
        url: 'https://www.livelib.ru/users/50064/books/read?ordering=read_at_desc' +
          (page > 1 ? `&page=${page}` : ''),
        headers: new Map(),
        // Page 4 repeats page 3: the scan must stop rather than loop to page 63.
        text: async () => byPage.get(page) || page3Html,
      };
    };
    try {
      const result = await livelib.fetchRsc('Margaret', { maxPages: 5, delayMs: 0 });
      assert.equal(result.rows.length, 60);
      assert.equal(new Set(result.rows.map((row) => row.userBookId)).size, 60);
      // Page 4 repeated page 3 (offset 40, asked for 60): rejected, not applied.
      assert.equal(result.pagesFetched, 3);
      assert.deepEqual(requestedPages, [1, 2, 3, 4]);
      assert.ok(result.warnings.some((warning) => /returned the payload for offset 0/.test(warning)));
    } finally {
      global.fetch = originalFetch;
    }
  });
  after(() => env.resetMutableState());
});


describe('books-livelib-bootstrap', () => {
  /**
   * K5 / task 2: LiveLib 403 — browser-like bootstrap + anonymous cookie jar.
   *
   * The reported failure: a user's server got a DDoS-Guard 403 within ~0.3 s on
   * the very first LiveLib request, because the import used to start with a bare
   * POST (no session cookies, no navigation headers).
   *
   * Pinned here:
   *   - bootstrap GET carries the full Chrome header set and keeps every
   *     `Set-Cookie` from every hop, including a 403 challenge page;
   *   - subsequent bulk/RSC/card requests send that jar back and refresh it;
   *   - a 403 *after* the bootstrap still fails loudly (`livelib_blocked`) with a
   *     message pointing at the cookie plan B;
   *   - `cookieHeader` seeds the jar (plan B) end to end;
   *   - diagnostics are masked (counts/statuses/title, never cookie values).
   *
   * No network access: a fake fetch reproduces the shapes.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const zlib = require('node:zlib');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const livelib = require('../server/books/livelib');

  const FIXTURES = path.join(__dirname, 'fixtures');
  const PAGE_HTML = zlib
    .gunzipSync(fs.readFileSync(path.join(FIXTURES, 'livelib-read-page1.html.gz')))
    .toString('utf8');
  const BULK_JSON = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, 'livelib-bulk-page1.json.gz'))).toString('utf8')
  );

  const CHALLENGE_HTML = `<!DOCTYPE html><html><head>
  <title>DDoS-Guard</title></head><body>
  <script>window.__ddg1_ = "x";</script><p>Checking your browser before accessing.</p>
  </body></html>`;

  function response(status, options = {}) {
    const headers = new Map();
    for (const [name, value] of Object.entries(options.headers || {})) {
      headers.set(name.toLowerCase(), value);
    }
    return {
      status,
      url: options.url,
      headers,
      text: async () => options.body || '',
    };
  }

  /** Fake fetch that records every request and answers from a URL router. */
  function fakeFetch(route) {
    const calls = [];
    const impl = async (url, options = {}) => {
      calls.push({ url: String(url), options, headers: options.headers || {} });
      return route(String(url), options || {});
    };
    impl.calls = calls;
    return impl;
  }

  function cookieOf(call) {
    return (call.headers && call.headers.Cookie) || '';
  }

  test('bootstrap keeps the challenge cookies and reports masked diagnostics', async () => {
    const fetchImpl = fakeFetch(() =>
      response(403, {
        body: CHALLENGE_HTML,
        headers: {
          'set-cookie': ['__ddg1_=one; Path=/; HttpOnly', '__ddg2_=two; Path=/'],
          'content-type': 'text/html',
        },
      })
    );

    const session = await livelib.bootstrapSession('Margaret', { fetchImpl });

    assert.equal(fetchImpl.calls.length, 1);
    const headers = fetchImpl.calls[0].headers;
    assert.match(headers['User-Agent'], /Chrome\/140/);
    assert.match(headers['Accept-Language'], /ru-RU/);
    assert.equal(headers['Sec-Fetch-Mode'], 'navigate');
    assert.match(headers['Sec-Ch-Ua'], /Chromium/);
    assert.equal(headers.Cookie, undefined); // first request is cookie-less

    assert.equal(session.status, 403);
    assert.equal(session.challenge, true);
    assert.equal(session.blocked, true);
    assert.equal(session.cookieCount, 2);
    assert.equal(session.title, 'DDoS-Guard');
    assert.deepEqual(session.hops.map((hop) => hop.cookieCount), [2]);

    // Diagnostics are masked: no cookie name/value anywhere in the object.
    const serialised = JSON.stringify(session);
    assert.equal(serialised.includes('__ddg1_'), false);
    assert.equal(serialised.includes('one'), false);
  });

  test('bootstrap follows redirects manually and carries cookies between hops', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.includes('/reader/Margaret/read')) {
        return response(308, {
          url,
          headers: {
            location: '/users/50064/books/read',
            'set-cookie': '__ddg1_=hop1; Path=/',
          },
        });
      }
      return response(200, {
        url,
        body: PAGE_HTML,
        headers: { 'set-cookie': '__ddg8_=hop2; Path=/' },
      });
    });

    const session = await livelib.bootstrapSession('Margaret', { fetchImpl });

    assert.equal(fetchImpl.calls.length, 2);
    assert.match(fetchImpl.calls[1].url, /\/users\/50064\/books\/read$/);
    assert.match(cookieOf(fetchImpl.calls[1]), /__ddg1_=hop1/);
    assert.equal(session.status, 200);
    assert.equal(session.challenge, false);
    assert.equal(session.cookieCount, 2); // hop1 + hop2
    assert.deepEqual(session.hops.map((hop) => hop.status), [308, 200]);
  });

  test('a 403 after the bootstrap fails loudly and points at the cookie plan B', async () => {
    const fetchImpl = fakeFetch(() =>
      response(403, {
        body: CHALLENGE_HTML,
        headers: { 'set-cookie': '__ddg1_=still-blocked; Path=/' },
      })
    );

    await assert.rejects(
      () =>
        livelib.importLivelib('Margaret', {
          fetchImpl,
          delayMs: 0,
          bootstrapDelayMs: 0,
        }),
      (err) => {
        assert.equal(err.code, 'livelib_blocked');
        assert.match(err.message, /ограничил доступ/);
        assert.match(err.message, /cookieHeader/);
        return true;
      }
    );
    // bootstrap GET + one bulk POST, then stop: no hammering.
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(fetchImpl.calls[1].options.method, 'POST');
    assert.match(cookieOf(fetchImpl.calls[1]), /__ddg1_=still-blocked/);
  });

  test('bootstrap 403 -> jar -> bulk/RSC 200 imports the profile end to end', async () => {
    const bulk = JSON.parse(JSON.stringify(BULK_JSON));
    bulk.last_page = true; // keep the fixture to a single page

    const fetchImpl = fakeFetch((url, options) => {
      const method = options.method || 'GET';
      if (method === 'POST' && url.includes('/listview/biglist')) {
        return response(200, { url, body: JSON.stringify(bulk) });
      }
      // The public alias 308-redirects to the numeric collection URL, exactly as
      // the live site does; the redirect must keep the jar.
      if (url.includes('/reader/Margaret/read?')) {
        return response(308, {
          url,
          headers: { location: '/users/50064/books/read?ordering=read_at_desc' },
        });
      }
      if (url.includes('/users/50064/books/read')) {
        return response(200, { url, body: PAGE_HTML });
      }
      // The bootstrap document request (no ?ordering, i.e. a cold visit).
      return response(403, {
        url,
        body: CHALLENGE_HTML,
        headers: { 'set-cookie': ['__ddg1_=jartoken1; Path=/', '__ddg2_=jartoken2; Path=/'] },
      });
    });

    const result = await livelib.importLivelib('Margaret', {
      fetchImpl,
      delayMs: 0,
      bootstrapDelayMs: 0,
      maxRscPages: 2,
    });

    // The bootstrap went first, then every following request carried the jar.
    assert.equal(fetchImpl.calls[0].options.method, 'GET');
    assert.match(fetchImpl.calls[0].url, /\/reader\/Margaret\/read$/);
    for (const call of fetchImpl.calls.slice(1)) {
      assert.match(cookieOf(call), /__ddg1_=jartoken1/, `cookie missing on ${call.url}`);
    }

    assert.equal(result.session.bootstrap.status, 403);
    assert.equal(result.session.bootstrap.challenge, true);
    assert.equal(result.session.seededCookies, 0);
    assert.ok(result.session.cookiesUsed >= 2);

    // 20 RSC rows with exact dates + 80 bulk-only rows without a date.
    assert.equal(result.profile.events.length, 100);
    assert.equal(result.totals.dated, 20);
    assert.equal(result.totals.undated, 0);
    assert.equal(result.totals.monthOnly, 80);
    assert.equal(result.totals.events, 100);
    assert.equal(result.profile.source, 'livelib');
    assert.equal(result.profile.userKey, 'Margaret');
    assert.equal(result.profile.sourceUserId, '50064');
    assert.ok(result.warnings.some((warning) => /bootstrap/i.test(warning)));

    // Masked session block: counts and statuses only.
    const serialised = JSON.stringify(result.session);
    assert.equal(serialised.includes('__ddg'), false);
    assert.equal(serialised.includes('jartoken'), false);
  });

  test('cookieHeader (plan B) seeds the jar before the bootstrap', async () => {
    const bulk = JSON.parse(JSON.stringify(BULK_JSON));
    bulk.last_page = true;
    const fetchImpl = fakeFetch((url, options) => {
      const method = options.method || 'GET';
      if (method === 'POST' && url.includes('/listview/biglist')) {
        return response(200, { url, body: JSON.stringify(bulk) });
      }
      if (url.includes('ordering=read_at_desc')) {
        return response(200, { url, body: PAGE_HTML });
      }
      return response(200, { url, body: PAGE_HTML });
    });

    const result = await livelib.importLivelib('Margaret', {
      fetchImpl,
      cookieHeader: 'Cookie: __ddg1_=frombrowser; sessionid=secret-value',
      delayMs: 0,
      bootstrapDelayMs: 0,
      maxRscPages: 1,
    });

    // Seeded cookie is present on the bootstrap request itself.
    assert.match(cookieOf(fetchImpl.calls[0]), /__ddg1_=frombrowser/);
    assert.match(cookieOf(fetchImpl.calls[0]), /sessionid=secret-value/);
    for (const call of fetchImpl.calls.slice(1)) {
      assert.match(cookieOf(call), /__ddg1_=frombrowser/);
    }
    assert.equal(result.session.seededCookies, 2);
    assert.ok(result.session.cookiesUsed >= 2);
    assert.equal(result.profile.events.length, 100);
  });

  test('request() stores refreshed cookies and rejects 403/429 without retrying', async () => {
    const jar = livelib.makeJar('__ddg1_=old');
    const fetchImpl = fakeFetch(() =>
      response(403, {
        body: CHALLENGE_HTML,
        headers: { 'set-cookie': '__ddg1_=new; Path=/' },
      })
    );

    await assert.rejects(
      () => livelib.request('https://www.livelib.ru/book/1', { jar, fetchImpl }, 'card 1'),
      /ограничил доступ/
    );
    assert.equal(fetchImpl.calls.length, 1);
    assert.match(cookieOf(fetchImpl.calls[0]), /__ddg1_=old/);
    assert.equal(livelib.cookieHeaderOf(jar), '__ddg1_=new');
  });

  test('cookie attributes are not stored as cookie pairs', () => {
    const jar = livelib.makeJar();
    livelib.storeCookies(jar, {
      headers: new Map([
        [
          'set-cookie',
          '__ddg1_=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Max-Age=3600; Path=/; Secure; HttpOnly',
        ],
      ]),
    });
    assert.equal(livelib.cookieHeaderOf(jar), '__ddg1_=abc');

    // Deletion via Max-Age=0 and via an empty value.
    livelib.storeCookies(jar, {
      headers: new Map([['set-cookie', '__ddg1_=; Max-Age=0; Path=/']]),
    });
    assert.equal(jar.size, 0);
  });

  test('challenge detection distinguishes a real page from an interstitial', () => {
    assert.equal(livelib.isChallengeHtml(CHALLENGE_HTML), true);
    assert.equal(livelib.isChallengeHtml('<html><title>DDoS-Guard</title></html>'), true);
    assert.equal(livelib.isChallengeHtml('<div class="g-recaptcha"></div>'), true);
    assert.equal(livelib.isChallengeHtml('<html><title>Проверка браузера</title></html>'), true);
    assert.equal(livelib.isChallengeHtml(PAGE_HTML), false);
    assert.equal(livelib.isChallengeHtml(''), false);
  });
  after(() => env.resetMutableState());
});


describe('books-livelib-file', () => {
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
      collections: 0,
      collectionWorks: 0,
      catalogRows: 0,
      duplicateBookIds: 0,
      exactDuplicateRows: 0,
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
  after(() => env.resetMutableState());
});


describe('books-resolve', () => {
  /**
   * LiveLib -> Hardcover resolve: normalisation, guards and the resolve job
   * (ISBN strategy + title/author strategy + unmatched negatives).
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;
  process.env.HARDCOVER_API_TOKEN = 'hc_pat_test_token_value';

  const bookCache = require('../server/books/book-cache');
  const hardcover = require('../server/books/hardcover');
  const resolve = require('../server/books/resolve');

  test('title normalisation strips series markers but keeps short main titles', () => {
    assert.equal(
      resolve.normalizeTitle('Гарри Поттер и Дары Смерти (Гарри Поттер, #7)'),
      'гарри поттер и дары смерти'
    );
    assert.equal(resolve.normalizeTitle('Дюна: Мессия'), 'дюна мессия');
    assert.equal(resolve.normalizeTitle('Гарри Поттер и Дары Смерти: Пьеса. Часть первая'), 'гарри поттер и дары смерти');
    assert.equal(resolve.normalizeTitle('Ведьмак. Том 3'), 'ведьмак');
    assert.equal(resolve.normalizeTitle('Ёлка и её друзья'), 'елка и ее друзья');
  });

  test('token Jaccard and surname extraction', () => {
    assert.equal(resolve.tokenJaccard('Дюна', 'Дюна'), 1);
    assert.ok(resolve.tokenJaccard('Дюна', 'Дюна: Дом Атрейдесов') < 0.9);
    assert.equal(resolve.surnameOf('Джефф Вандермеер'), 'вандермеер');
    assert.equal(resolve.surnameOf('J. K. Rowling'), 'rowling');
    assert.equal(resolve.surnameOf(''), '');
  });

  test('ISBN normalisation and conversion', () => {
    assert.equal(resolve.normalizeIsbn('978-5-699-98967-6'), '9785699989676');
    assert.equal(resolve.normalizeIsbn('0-306-40615-2'), '9780306406157');
    assert.equal(resolve.isbn10to13('0-306-40615-2'), '9780306406157');
    assert.equal(resolve.isbn10Of('9780306406157'), '0306406152');
    assert.equal(resolve.normalizeIsbn('not-an-isbn'), null);
  });

  test('exact title + author + year scores 1.0', () => {
    const event = {
      title: 'Дюна',
      authors: ['Фрэнк Герберт'],
      edition: { year: 1965 },
    };
    const candidate = {
      hcWorkId: 100,
      title: 'Дюна',
      authors: [{ name: 'Фрэнк Герберт' }],
      publicationYear: 1965,
      ratingsCount: 1000,
      series: [],
    };
    const scored = resolve.scoreCandidate(event, candidate);
    assert.equal(scored.score, 1);
    assert.equal(scored.method, 'title-author-year');
  });

  test('collection marker blocks an otherwise exact match', () => {
    const event = { title: 'Дюна (сборник)', authors: ['Фрэнк Герберт'], edition: { year: 1965 } };
    const candidate = {
      hcWorkId: 100,
      title: 'Дюна',
      authors: [{ name: 'Фрэнк Герберт' }],
      publicationYear: 1965,
      ratingsCount: 1000,
      series: [],
    };
    const scored = resolve.scoreCandidate(event, candidate);
    assert.equal(scored.score, 0);
    assert.equal(scored.evidence.guard, 'collection-marker');
  });

  test('equally good different candidates are reported as ambiguous', () => {
    const event = { title: 'Дюна', authors: ['Фрэнк Герберт'], edition: { year: 1965 } };
    const make = (id) => ({
      hcWorkId: id,
      title: 'Дюна',
      authors: [{ name: 'Фрэнк Герберт' }],
      publicationYear: 1965,
      ratingsCount: 1000,
      series: [],
    });
    const best = resolve.bestCandidate(event, [make(2), make(1)]);
    assert.equal(best.ambiguous, true);
  });

  test('resolveProfile matches by ISBN and by title, keeps negatives uncached', async () => {
    // Two candidate works already known from a journal import.
    await bookCache.saveDetails(200, {
      schemaVersion: 1,
      hcWorkId: 200,
      title: 'Мартин Иден',
      authors: [{ hcId: 1, name: 'Джек Лондон' }],
      genres: [],
      series: [],
      pages: 400,
      publicationYear: 1909,
      ratingsCount: 500,
      partial: false,
    });

    const llProfile = {
      schemaVersion: 1,
      source: 'livelib',
      userKey: 'tester',
      events: [
        {
          id: 'll:1',
          source: 'livelib',
          sourceBookId: '1001',
          title: 'Дюна',
          authors: ['Фрэнк Герберт'],
          rating: 9,
          ratingScale: 10,
          rating10: 9,
          edition: { isbn: '978-0-441-01359-3', year: 1965 },
        },
        {
          id: 'll:2',
          source: 'livelib',
          sourceBookId: '1002',
          title: 'Мартин Иден',
          authors: ['Джек Лондон'],
          rating: 8,
          ratingScale: 10,
          rating10: 8,
          edition: { isbn: null, year: 1909 },
        },
        {
          id: 'll:3',
          source: 'livelib',
          sourceBookId: '1003',
          title: 'Совершенно неизвестная книга',
          authors: ['Никто Никтович'],
          rating: null,
          edition: { isbn: null, year: 2020 },
        },
      ],
    };

    const originalGraphql = hardcover.graphql;
    let queries = 0;
    hardcover.graphql = async (query, variables) => {
      queries++;
      assert.match(query, /editions/);
      assert.deepEqual(variables.isbns.sort(), ['0441013597', '9780441013593'].sort());
      return {
        editions: [
          {
            id: 555,
            book_id: 100,
            isbn_13: '9780441013593',
            isbn_10: '0441013593',
            language_id: 1,
            pages: 512,
            publisher_id: 1,
            release_year: 1965,
            release_date: '1965-08-01',
            publisher: { id: 1, name: 'Chilton' },
            language: { id: 1, language: 'English' },
            book: {
              id: 100,
              title: 'Дюна',
              slug: 'dune',
              pages: 512,
              release_year: 1965,
              rating: 4.5,
              ratings_count: 5000,
              contributions: [{ author: { id: 7, name: 'Фрэнк Герберт' }, contribution: 'Author' }],
              book_series: [],
              taggings: [{ tag: { id: 6, tag: 'Science Fiction', tag_category_id: 1 } }],
            },
          },
        ],
      };
    };

    try {
      const report = await resolve.resolveProfile(llProfile, { providers: [] });
      assert.equal(report.total, 3);
      assert.equal(report.resolvedIsbn, 1);
      assert.equal(report.resolvedTitle, 1);
      assert.equal(report.unmatched, 1);
      assert.equal(queries, 1);

      const isbnLink = bookCache.getLink('1001');
      assert.equal(isbnLink.workId, 'hc:100');
      assert.equal(isbnLink.method, 'isbn');

      const titleLink = bookCache.getLink('1002');
      assert.equal(titleLink.workId, 'hc:200');
      assert.equal(titleLink.method, 'title-author-year');

      // Negative results are not cached: a later import can still resolve them.
      assert.equal(bookCache.getLink('1003'), null);

      // The index gets both key styles.
      assert.equal(bookCache.getIndexEntry('ll:1001'), 100);
      assert.equal(bookCache.getIndexEntry('isbn:9780441013593'), 100);

      // Running again reuses positive links and re-queries only the negative.
      hardcover.graphql = async () => ({ editions: [] });
      const second = await resolve.resolveProfile(llProfile, { providers: [] });
      assert.equal(second.cached, 2);
      assert.equal(second.unmatched, 1);
    } finally {
      hardcover.graphql = originalGraphql;
    }
  });

  test('resolve report separates hopeless keys from budget-pending ones', async () => {
    const miss = { NAME: 'googlebooks', getWork: async () => null };
    const profile = {
      schemaVersion: 1,
      source: 'livelib',
      userKey: 'Hopeless',
      events: [
        {
          id: 'll:101',
          source: 'livelib',
          sourceBookId: '101',
          title: 'Obscure Book',
          authors: ['Nobody'],
          status: 'read',
        },
      ],
    };
    const report = await resolve.resolveProfile(profile, { providers: [miss] });
    // A provider was really called and answered nothing -> the work is reported
    // as hopeless so stats can drop it from the metadata denominator.
    assert.equal(report.attempted, 1);
    assert.deepEqual(report.unmatchedKeys, ['101']);

    // A budget-starved Litres call is NOT an answer: the key stays pending and
    // must not be written off as hopeless.
    const starved = { NAME: 'litres', getWork: async () => null };
    const ruProfile = {
      ...profile,
      events: [
        {
          id: 'll:202',
          source: 'livelib',
          sourceBookId: '202',
          title: 'Неизвестная книга',
          authors: ['Автор'],
          status: 'read',
        },
      ],
    };
    const budget = { limit: 0, used: 0, remaining: 0, take: () => false };
    const starvedReport = await resolve.resolveProfile(ruProfile, {
      providers: [starved],
      litresBudget: budget,
    });
    assert.equal(starvedReport.attempted, 0);
    assert.deepEqual(starvedReport.unmatchedKeys, []);
  });
  after(() => env.resetMutableState());
});
