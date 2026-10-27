'use strict';

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

const BOOK_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-book-import-'));
process.env.KINOBOXD_CACHE_BOOK_DIR = BOOK_CACHE_DIR;

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
