'use strict';

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

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-hc-inc-'));
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
