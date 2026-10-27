'use strict';

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

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-hc-import-'));
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
