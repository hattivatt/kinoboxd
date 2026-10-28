'use strict';

/**
 * `summary.metadata` — the honest "metadata is still loading" contract.
 *
 * A LiveLib profile gets genres/series/years from the shared resolve chain,
 * which is budgeted (Litres: 200 books per run) and therefore spreads over
 * several profile refreshes. The payload must say:
 *   - `resolved/total/percent` of the profile's works that already have a
 *     details document (LiveLib card metadata counts too);
 *   - `running` only while the resolve stage is alive, and only for LiveLib
 *     (a Hardcover profile's metadata arrives with the journal);
 *   - `budgetRemaining` only while that job is alive.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-book-meta-'));

const bookCache = require('../server/books/book-cache');
const { buildBooksStats } = require('../server/books/stats');
const { resolveStateFromJobs } = require('../server/books/import');

function event(bookId, extra = {}) {
  return Object.assign(
    {
      id: `ll:${bookId}`,
      sourceBookId: String(bookId),
      title: `Book ${bookId}`,
      authors: ['Author'],
      rating: 7,
      ratingScale: 10,
      status: 'read',
      finishedAt: '2024-01-02',
    },
    extra
  );
}

async function seed() {
  await bookCache.saveDetails(100, {
    schemaVersion: 1,
    hcWorkId: 100,
    title: 'Covered by Hardcover',
    authors: [{ hcId: 1, name: 'Author' }],
    genres: ['Fantasy'],
    partial: false,
  });
  // LiveLib-card metadata lives under the `ll-{bookId}` key and is just as
  // valid: the work is covered, it simply has no canonical Hardcover work.
  await bookCache.saveDetails(bookCache.detailsKeyForWork('ll:300'), {
    schemaVersion: 1,
    title: 'Covered by LiveLib card',
    authors: [{ name: 'Author' }],
    genres: ['Classics'],
    metadataSources: ['livelib-card'],
    partial: false,
  });
  await bookCache.saveLink('101', {
    schemaVersion: 1,
    livelibBookId: '101',
    workId: 'hc:100',
    method: 'isbn',
    score: 1,
    evidence: {},
  });

  await bookCache.saveProfile('livelib', 'Meta', {
    schemaVersion: 1,
    source: 'livelib',
    userKey: 'Meta',
    importedAt: '2026-10-27T00:00:00.000Z',
    events: [
      event(101, { workId: 'hc:100' }),
      event(200),
      event(300),
      event(400),
    ],
    warnings: [],
  });
  await bookCache.saveProfile('hardcover', '777', {
    schemaVersion: 1,
    source: 'hardcover',
    userKey: '777',
    importedAt: '2026-10-27T00:00:00.000Z',
    events: [
      {
        id: 'hc:read:1',
        source: 'hardcover',
        sourceBookId: '100',
        workId: 'hc:100',
        title: 'Covered by Hardcover',
        authors: ['Author'],
        rating: 4,
        ratingScale: 5,
        rating10: 8,
        status: 'read',
        statusId: 3,
        finishedAt: '2024-02-02',
      },
    ],
  });
}

test('metadata coverage counts works with a details document', async () => {
  await seed();
  const stats = buildBooksStats({ profile: 'livelib-Meta' });
  assert.deepEqual(stats.summary.metadata, {
    resolved: 2,
    total: 4,
    resolvable: 4,
    hopeless: 0,
    percent: 50,
    done: false,
    running: false,
    budgetRemaining: null,
  });
});

test('running + budgetRemaining are forwarded only for a LiveLib profile', async () => {
  await seed();
  const live = buildBooksStats({
    profile: 'livelib-Meta',
    resolveState: { running: true, budgetRemaining: 42 },
  });
  assert.equal(live.summary.metadata.running, true);
  assert.equal(live.summary.metadata.budgetRemaining, 42);
  assert.equal(live.summary.metadata.percent, 50);

  // Hardcover: metadata comes from the journal, so a resolve pass of LiveLib
  // books must not make the journal look "half-loaded", and the budget is not
  // relevant to it.
  const hc = buildBooksStats({
    profile: 'hardcover-777',
    resolveState: { running: true, budgetRemaining: 42 },
  });
  assert.deepEqual(hc.summary.metadata, {
    resolved: 1,
    total: 1,
    resolvable: 1,
    hopeless: 0,
    percent: 100,
    done: true,
    running: false,
    budgetRemaining: null,
  });
});

test('a fully enriched or empty profile reports 100% (badge hidden)', async () => {
  await bookCache.saveProfile('livelib', 'Empty', {
    schemaVersion: 1,
    source: 'livelib',
    userKey: 'Empty',
    importedAt: '2026-10-27T00:00:00.000Z',
    events: [],
    warnings: [],
  });
  const stats = buildBooksStats({ profile: 'livelib-Empty' });
  assert.equal(stats.summary.metadata.total, 0);
  assert.equal(stats.summary.metadata.percent, 100);
  assert.equal(stats.summary.metadata.running, false);
});

test('hopeless works leave the metadata denominator (99% -> 100%)', async () => {
  await seed();
  // The resolve pass asked the providers about 200 and 400 and got nothing.
  await bookCache.saveResolveState('livelib', 'Meta', {
    schemaVersion: 1,
    ranAt: '2026-10-28T00:00:00.000Z',
    total: 4,
    attempted: 2,
    matched: 0,
    skippedPlanShelf: 0,
    lookupErrors: [],
    unmatchedKeys: ['200', '400'],
  });

  const stats = buildBooksStats({ profile: 'livelib-Meta' });
  assert.deepEqual(stats.summary.metadata, {
    resolved: 2,
    total: 4,
    // 200 and 400 are dark for every provider -> not part of the pool, so the
    // badge can honestly read 100% instead of freezing at 99% forever.
    resolvable: 2,
    hopeless: 2,
    percent: 100,
    done: true,
    running: false,
    budgetRemaining: null,
  });

  // Only one of them is hopeless: 2 of 3 resolvable = 67%, not done.
  await bookCache.saveResolveState('livelib', 'Meta', {
    schemaVersion: 1,
    ranAt: '2026-10-28T00:00:00.000Z',
    unmatchedKeys: ['200'],
  });
  const partial = buildBooksStats({ profile: 'livelib-Meta' });
  assert.deepEqual(partial.summary.metadata, {
    resolved: 2,
    total: 4,
    resolvable: 3,
    hopeless: 1,
    percent: 67,
    done: false,
    running: false,
    budgetRemaining: null,
  });
});

test('plan shelves never inflate the metadata denominator', async () => {
  await seed();
  const profile = bookCache.getProfile('livelib', 'Meta');
  await bookCache.saveProfile('livelib', 'Meta', {
    ...profile,
    events: [...profile.events, event(500, { shelf: 'wish' }), event(501, { shelf: 'reading' })],
  });
  const stats = buildBooksStats({ profile: 'livelib-Meta' });
  // Same 4 history works; the two plans are not statistics and not metadata.
  assert.equal(stats.summary.metadata.total, 4);
  assert.equal(stats.summary.eventCount, 4);
});

test('resolveStateFromJobs recognises only a live LiveLib resolve stage', () => {
  const live = {
    id: 'job-1',
    source: 'livelib',
    stage: 'resolve',
    done: false,
    startedAt: 1000,
    resolved: 3,
    resolveTotal: 10,
    liveBudget: { litres: { limit: 200, used: 158, remaining: 42 } },
  };
  const state = resolveStateFromJobs([live], 'livelib');
  assert.equal(state.running, true);
  assert.equal(state.jobId, 'job-1');
  assert.equal(state.budgetRemaining, 42);

  // Journal fetch is not metadata loading for the LiveLib chain.
  assert.equal(resolveStateFromJobs([{ ...live, stage: 'livelib-bulk' }], 'livelib').running, false);
  // Done/failed jobs are never "running".
  assert.equal(resolveStateFromJobs([{ ...live, done: true }], 'livelib').running, false);
  // Hardcover profiles are never in the LiveLib resolve chain.
  assert.equal(resolveStateFromJobs([live], 'hardcover').running, false);
  // No budget snapshot yet -> null, not NaN.
  assert.equal(
    resolveStateFromJobs([{ ...live, liveBudget: null }], 'livelib').budgetRemaining,
    null
  );
  assert.equal(resolveStateFromJobs([], 'livelib').running, false);
});
