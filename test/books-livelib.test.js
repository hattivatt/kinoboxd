'use strict';

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
  // The live site ignores ?page= for anonymous users: page 2 renders page 1.
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
    assert.equal(requests, 2);
    assert.equal(result.pagesFetched, 2);
    assert.equal(result.rows.length, 20);
    assert.ok(result.warnings.some((warning) => /pagination returned no new books/.test(warning)));
  } finally {
    global.fetch = originalFetch;
  }
});
