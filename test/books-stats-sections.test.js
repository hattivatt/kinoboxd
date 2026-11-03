'use strict';

/**
 * Section builders of the books stats payload (S2 split).
 *
 * These are *unit* checks of the pure builders that came out of the
 * `buildBooksStats` god-function (`server/books/stats/*`). They do not replace
 * the golden snapshot (`test/golden.test.js`) — the payload contract is
 * covered there byte-for-byte. Here only the two rules that are easy to break
 * when a section moves to its own file are pinned:
 *
 *   - the year buckets keep the ancient slot OFF the `years[]` axis and
 *     «год неизвестен» last on `decades[]`;
 *   - the pages histogram follows `PAGE_BUCKETS` bounds (inclusive) and
 *     `avgRating` ignores unrated works.
 *
 * The builders are pure reads of a context, so no cache, no tmp dirs and no
 * network are involved: a hand-built `{ works }` map is the whole fixture.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildYearBuckets, buildPagesHistogram } = require('../server/books/stats/widgets');

function makeWork(overrides = {}) {
  return {
    workId: 'll:1',
    title: 'Книга',
    authors: ['Автор'],
    rating10: null,
    year: null,
    yearSource: null,
    genres: [],
    series: [],
    publisher: null,
    pages: null,
    ...overrides,
  };
}

function contextOf(works) {
  return { works: new Map(works.map((work) => [work.workId, work])) };
}

test('widgets: year buckets keep the ancient slot off the years axis', () => {
  const ctx = contextOf([
    makeWork({ workId: 'll:1', year: 2019, yearSource: 'first', rating10: 8 }),
    makeWork({ workId: 'll:2', year: 2019, yearSource: 'edition', rating10: 6 }),
    makeWork({ workId: 'll:3', year: 950, yearSource: 'first', rating10: 10 }),
    makeWork({ workId: 'll:4', year: null }),
  ]);

  const { decades, years } = buildYearBuckets(ctx);

  assert.deepEqual(
    decades.map((entry) => entry.key || entry.decade),
    ['before-1000', 2010, null],
    'ancient first, real decades in order, «год неизвестен» last'
  );
  assert.equal(decades[0].count, 1);
  assert.equal(decades[1].count, 2);
  assert.equal(decades[1].firstCount, 1);
  assert.equal(decades[1].editionCount, 1);
  assert.equal(decades[1].avgRating, 7);
  assert.equal(decades[2].unknown, true);

  // Ancient works never enter `years[]` (they are one bucket, not a year), and
  // the year bucket carries the same counters as the decade bucket.
  assert.deepEqual(
    years.map((entry) => entry.year || entry.key),
    ['before-1000', 2019]
  );
  assert.equal(years[0].count, 1);
  assert.equal(years[1].count, 2);
  assert.equal(years[1].avgRating, 7);
});

test('widgets: pages histogram uses the PAGE_BUCKETS bounds, avgRating skips unrated', () => {
  const ctx = contextOf([
    makeWork({ workId: 'll:1', pages: 50, rating10: 8 }),
    makeWork({ workId: 'll:2', pages: 99, rating10: 6 }),
    makeWork({ workId: 'll:3', pages: 100 }),
    makeWork({ workId: 'll:4', pages: 1000, rating10: 9 }),
    makeWork({ workId: 'll:5', pages: null, rating10: 10 }),
  ]);

  const histogram = buildPagesHistogram(ctx);

  assert.deepEqual(
    histogram.map((bucket) => [bucket.bucket, bucket.count, bucket.avgRating]),
    [
      ['<100', 2, 7],
      ['100-199', 1, null],
      ['200-299', 0, null],
      ['300-399', 0, null],
      ['400-499', 0, null],
      ['500-699', 0, null],
      ['700-999', 0, null],
      ['1000+', 1, 9],
    ]
  );
});
