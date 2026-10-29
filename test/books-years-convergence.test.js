'use strict';

/**
 * Convergence of the first-publication-year backfill (round 29.10.2026).
 *
 * The production symptom was «632 книги висят с „Год неизвестен“» after a
 * single `kinoboxd-backfill-books` run with a small Литрес budget. Two things
 * must hold for the queue to drain across runs:
 *
 *   1. A run that stops because the Литрес budget is gone (or because a
 *      provider errored) must NOT write `firstPublishedYearCheckedAt`. That
 *      marker means «everybody was asked and nobody knows» and hides the
 *      document for 30 days; writing it on a budget stop poisons the queue.
 *   2. The slice's Hardcover ISBNs are one batched lookup, not one request per
 *      book (free plan: one top-level GraphQL field per request, 60/min).
 *
 * Pinned here:
 *   - budget exhaustion → `deferred`, no negative marker, the next run asks
 *     Литрес again (the same document is a candidate);
 *   - a provider network error → `deferred`, no negative marker;
 *   - a real «nobody knows» (all providers answered) → negative marker;
 *   - Hardcover prefetch batches every ISBN of the slice into one call;
 *   - `summary.yearBackfill` tells the UI how much of the unknown bucket is
 *     still a queue (pending) vs honestly unknown (checked) vs unlinked.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-years-'));

const bookCache = require('../server/books/book-cache');
const yearsBackfill = require('../server/books/years-backfill');
const { buildBooksStats } = require('../server/books/stats');

const noSleep = async () => {};

function fakeProvider(source, handler) {
  const calls = [];
  return {
    NAME: source,
    calls,
    async getWork(input, options) {
      calls.push({ input, options: options || {} });
      return typeof handler === 'function' ? handler(input) : handler;
    },
  };
}

async function seed(workId, doc) {
  await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), {
    schemaVersion: 2,
    ...doc,
  });
}

test('an exhausted Литрес budget defers the document without poisoning the negative cache', async () => {
  await seed('lr:7001', {
    workId: 'lr:7001',
    title: 'Война и мир',
    authors: [{ name: 'Лев Толстой' }],
    publicationYear: 2020,
  });

  let budgetLeft = 0;
  let asked = 0;
  const budget = {
    get used() {
      return budgetLeft ? 0 : 1;
    },
    get remaining() {
      return budgetLeft;
    },
    take() {
      if (!budgetLeft) return false;
      budgetLeft--;
      return true;
    },
  };
  const litres = fakeProvider('litres', () => {
    asked++;
    // Real provider: `take()` fails before the request, returns null.
    return null;
  });
  litres.isBreakerOpen = () => false;

  const report = await yearsBackfill.backfill({
    ids: ['lr:7001'],
    budget,
    litresProvider: litres,
    hardcoverProvider: fakeProvider('hardcover', null),
    openlibraryProvider: fakeProvider('openlibrary', null),
    log: () => {},
    sleep: noSleep,
    pause: 0,
  });

  // The fake provider does not take() from the budget itself; the shared
  // counter staying put while `remaining === 0` is exactly how the real
  // provider signals «budget gone before the request». Either way no year is
  // written and no negative marker is allowed.
  assert.equal(asked, 1);
  assert.equal(report.deferred.length, 1);
  assert.deepEqual(report.deferred[0].reasons, ['litres-budget']);
  assert.equal(report.unknown.length, 0);
  const saved = bookCache.getWorkDetails('lr:7001');
  assert.equal(saved.firstPublishedYearCheckedAt, undefined);
  // Still a candidate for the next run: the pending queue did not shrink.
  assert.equal(report.pending, 1);

  // Next run: the budget is fresh, the same document is asked again.
  let secondRunAsked = 0;
  const freshBudget = { used: 0, remaining: 200, take() { this.used++; return true; } };
  const secondLitres = fakeProvider('litres', () => {
    secondRunAsked++;
    return { source: 'litres', sourceId: '1', firstPublishedYear: 1869 };
  });
  secondLitres.isBreakerOpen = () => false;
  const second = await yearsBackfill.backfill({
    ids: ['lr:7001'],
    budget: freshBudget,
    litresProvider: secondLitres,
    hardcoverProvider: fakeProvider('hardcover', null),
    openlibraryProvider: fakeProvider('openlibrary', null),
    log: () => {},
    sleep: noSleep,
    pause: 0,
  });
  assert.equal(secondRunAsked, 1);
  assert.equal(second.resolved.length, 1);
  assert.equal(bookCache.getWorkDetails('lr:7001').firstPublishedYear, 1869);
});

test('a provider network error is a deferral, not a verdict', async () => {
  await seed('lr:7002', {
    workId: 'lr:7002',
    title: 'Анна Каренина',
    authors: [{ name: 'Лев Толстой' }],
    publicationYear: 2019,
  });
  const litres = fakeProvider('litres', () => {
    const err = new Error('network down');
    err.code = 'provider_network_error';
    throw err;
  });
  litres.isBreakerOpen = () => false;
  const report = await yearsBackfill.backfill({
    ids: ['lr:7002'],
    budget: { used: 0, remaining: 200, take() { return true; } },
    litresProvider: litres,
    hardcoverProvider: fakeProvider('hardcover', null),
    openlibraryProvider: fakeProvider('openlibrary', null),
    log: () => {},
    sleep: noSleep,
    pause: 0,
  });
  assert.equal(report.deferred.length, 1);
  assert.deepEqual(report.deferred[0].reasons, ['litres-error']);
  assert.equal(bookCache.getWorkDetails('lr:7002').firstPublishedYearCheckedAt, undefined);
});

test('an open Литрес breaker is not asked and does not mark the document', async () => {
  await seed('lr:7003', {
    workId: 'lr:7003',
    title: 'Преступление и наказание',
    publicationYear: 2018,
  });
  const litres = fakeProvider('litres', { source: 'litres', firstPublishedYear: 1866 });
  litres.isBreakerOpen = () => true;
  const report = await yearsBackfill.backfill({
    ids: ['lr:7003'],
    budget: { used: 0, remaining: 200, take() { return true; } },
    litresProvider: litres,
    hardcoverProvider: fakeProvider('hardcover', null),
    openlibraryProvider: fakeProvider('openlibrary', null),
    log: () => {},
    sleep: noSleep,
    pause: 0,
  });
  assert.equal(litres.calls.length, 0);
  assert.deepEqual(report.deferred[0].reasons, ['litres-breaker']);
  assert.equal(bookCache.getWorkDetails('lr:7003').firstPublishedYearCheckedAt, undefined);
});

test('a failed batched Hardcover lookup defers instead of writing the negative cache', async () => {
  await seed('lr:7005', {
    workId: 'lr:7005',
    title: 'Some English Book',
    isbn13: '9780000000035',
  });
  const lookupIsbns = async () => {
    const err = new Error('hardcover down');
    err.code = 'hardcover_network_error';
    throw err;
  };
  const report = await yearsBackfill.backfill({
    ids: ['lr:7005'],
    lookupIsbns,
    budget: { used: 0, remaining: 200, take() { return true; } },
    litresProvider: fakeProvider('litres', null),
    openlibraryProvider: fakeProvider('openlibrary', null),
    log: () => {},
    sleep: noSleep,
    pause: 0,
  });
  assert.equal(report.deferred.length, 1);
  assert.deepEqual(report.deferred[0].reasons, ['hardcover-error']);
  assert.equal(bookCache.getWorkDetails('lr:7005').firstPublishedYearCheckedAt, undefined);
});

test('a real «nobody knows» writes the negative cache without a provider error', async () => {
  await seed('lr:7004', {
    workId: 'lr:7004',
    title: 'Совсем безымянная книга',
    publicationYear: 2017,
  });
  const litres = fakeProvider('litres', null);
  litres.isBreakerOpen = () => false;
  const report = await yearsBackfill.backfill({
    ids: ['lr:7004'],
    budget: { used: 0, remaining: 200, take() { return true; } },
    litresProvider: litres,
    hardcoverProvider: fakeProvider('hardcover', null),
    openlibraryProvider: fakeProvider('openlibrary', null),
    log: () => {},
    sleep: noSleep,
    pause: 0,
  });
  assert.equal(report.unknown.length, 1);
  assert.equal(report.unknown[0].asked, 'hardcover,litres,openlibrary');
  assert.equal(report.deferred.length, 0);
  const saved = bookCache.getWorkDetails('lr:7004');
  assert.ok(saved.firstPublishedYearCheckedAt);
  assert.equal(saved.firstPublishedYearCheckedBy, 'none');
});

test('the whole slice shares one batched Hardcover ISBN lookup', async () => {
  await seed('lr:7010', {
    workId: 'lr:7010',
    title: 'Book A',
    isbn13: '9780000000011',
  });
  await seed('lr:7011', {
    workId: 'lr:7011',
    title: 'Book B',
    isbn13: '9780000000028',
  });
  const lookups = [];
  const lookupIsbns = async (isbns) => {
    lookups.push([...isbns]);
    const byIsbn = new Map();
    for (const isbn of isbns) {
      byIsbn.set(isbn, {
        details: {
          hcWorkId: isbn.endsWith('1') ? 9001 : 9002,
          title: isbn.endsWith('1') ? 'Book A' : 'Book B',
          firstPublishedYear: isbn.endsWith('1') ? 1901 : 1902,
        },
        editionId: null,
      });
    }
    return { byIsbn, works: new Map(), requests: 1, queries: [] };
  };
  const report = await yearsBackfill.backfill({
    ids: ['lr:7010', 'lr:7011'],
    lookupIsbns,
    budget: { used: 0, remaining: 200, take() { return true; } },
    litresProvider: fakeProvider('litres', null),
    openlibraryProvider: fakeProvider('openlibrary', null),
    log: () => {},
    sleep: noSleep,
    pause: 0,
  });
  assert.equal(lookups.length, 1);
  assert.deepEqual(lookups[0].sort(), ['9780000000011', '9780000000028']);
  assert.equal(report.hardcoverRequests, 1);
  assert.deepEqual(
    report.resolved.map((entry) => [entry.workId, entry.year, entry.source]).sort(),
    [
      ['lr:7010', 1901, 'hardcover'],
      ['lr:7011', 1902, 'hardcover'],
    ]
  );
});

/* ------------------------------------------------------------------ */
/* payload: how much of «год неизвестен» is still a queue              */
/* ------------------------------------------------------------------ */

function event(id) {
  return {
    id: `ll:${id}`,
    source: 'livelib',
    sourceBookId: String(id),
    title: `Book ${id}`,
    authors: [],
    status: 'read',
    finishedAt: '2024-05-05',
  };
}

test('summary.yearBackfill splits the unknown bucket into queue / honest / unlinked', async () => {
  process.env.BOOKS_BACKFILL_LIMIT = '200';
  await seed('hc:8801', { hcWorkId: 8801, title: 'Known', firstPublishedYear: 1900 });
  await seed('hc:8802', { hcWorkId: 8802, title: 'Pending', publicationYear: 2020 });
  await seed('hc:8803', {
    hcWorkId: 8803,
    title: 'Honest unknown',
    publicationYear: 2020,
    firstPublishedYearCheckedAt: '2026-10-29T00:00:00.000Z',
    firstPublishedYearCheckedBy: 'none',
  });
  for (const id of ['8801', '8802', '8803']) {
    await bookCache.saveLink(id, {
      schemaVersion: 2,
      livelibBookId: id,
      workId: `hc:${id}`,
      method: 'isbn',
      score: 1,
    });
  }
  await bookCache.saveProfile('livelib', 'YearsProgress', {
    schemaVersion: 1,
    source: 'livelib',
    userKey: 'YearsProgress',
    importedAt: '2026-10-29T00:00:00.000Z',
    events: [event('8801'), event('8802'), event('8803'), event('8899')],
    warnings: [],
  });

  const stats = buildBooksStats({ profile: 'livelib-YearsProgress' });
  assert.equal(stats.summary.yearUnknownCount, 3);
  assert.deepEqual(stats.summary.yearBackfill, {
    known: 1,
    unknown: 3,
    pending: 1,
    honestUnknown: 1,
    unlinked: 1,
    perRun: 200,
    runsLeft: 1,
    // The queue is not empty, so «год неизвестен» is not a final verdict.
    open: true,
  });
});

test('the years note never calls unlinked works an honest «providers do not know»', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'books.js'),
    'utf8'
  );
  // Queue still open: progress wording with the estimate and the unlinked tail.
  assert.match(source, /бэкфилл идёт, осталось ~/);
  assert.match(source, /ждут привязки к метаданным/);
  // Queue drained but unlinked works remain: the note must not collapse them
  // into «провайдеры не знают» (that branch requires honestUnknown > 0).
  assert.match(source, /backfill\.honestUnknown > 0/);
});

test('a fully filled cache reports no queue', async () => {
  process.env.BOOKS_BACKFILL_LIMIT = '200';
  const stats = buildBooksStats({ profile: 'livelib-YearsProgress' });
  // The previous test wrote the docs for the same profile; re-seed 8802 with a
  // year so only the honest-unknown and the unlinked work remain.
  await seed('hc:8802', { hcWorkId: 8802, title: 'Pending', firstPublishedYear: 1910 });
  const after = buildBooksStats({ profile: 'livelib-YearsProgress' });
  assert.equal(after.summary.yearBackfill.known, 2);
  assert.equal(after.summary.yearBackfill.pending, 0);
  assert.equal(after.summary.yearBackfill.runsLeft, 0);
  assert.equal(after.summary.yearBackfill.open, false);
  void stats;
});
