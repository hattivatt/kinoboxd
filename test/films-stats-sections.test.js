'use strict';

/**
 * Section builders of the films stats payload (S3 split).
 *
 * These are unit checks of the pieces that came out of the `buildStats`
 * god-function (`server/stats/*`). They do not replace the golden snapshot
 * (`test/golden.test.js`) — the payload contract is covered there
 * byte-for-byte. Here only the rules that are easy to break when a section
 * moves to its own file are pinned:
 *
 *   - the keyword taxonomy classifies and aggregates exactly as before
 *     (`taxonomy.js` had no direct tests at all);
 *   - the runtime histogram keeps the bucket bounds and skips unrated films
 *     in `avgRating`;
 *   - the timeline is the day-level view of the same events, so
 *     `sum(watchDays.count) === sum(timeline.watched)`.
 *
 * The builders are pure reads of a hand-built context; no cache, no network.
 * `widgets.js` pulls `../mcu` (and therefore `cache`), so the tmp-cache helper
 * runs first, exactly like in every other test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const env = require('./helpers/env');
const tmp = env.makeTmpCache('films-stats-sections', { budgets: true });

const { buildTaxonomy } = require('../server/taxonomy');
const { buildRuntimeHistogram } = require('../server/stats/widgets');
const { buildTimeline, buildRewatches } = require('../server/stats/timeline');

test.after(() => {
  tmp.cleanup();
});

test('taxonomy: keyword rules aggregate categories/origins with avgRating', () => {
  const taxonomy = buildTaxonomy([
    {
      slug: 'a',
      rating: 8,
      year: 1995,
      genres: [{ id: 16, name: 'Animation' }],
      keywords: [{ name: 'anime' }, { name: 'based on novel' }],
      wd: {},
      directors: [],
      countries: [],
      kind: 'movie',
    },
    {
      slug: 'b',
      rating: 6,
      year: 2000,
      genres: [],
      keywords: [{ name: 'anime' }],
      wd: {},
      directors: [],
      countries: [],
      kind: 'movie',
    },
  ]);

  const anime = taxonomy.categories.find((entry) => entry.key === 'anime');
  assert.ok(anime, 'anime category missing');
  assert.equal(anime.count, 2);
  assert.equal(anime.avgRating, 7);
  assert.deepEqual(anime.films, ['a', 'b']);

  // "Мультфильмы" is the Animation genre minus anime: only film `a` has the
  // genre, and it is already anime, so the bucket stays empty (and is omitted).
  assert.equal(taxonomy.categories.some((entry) => entry.key === 'animation'), false);

  // Origins are mutually exclusive and always cover every film.
  const origins = Object.fromEntries(taxonomy.origins.map((entry) => [entry.key, entry.count]));
  assert.equal(origins.book, 1, 'based-on-novel film must land in the book origin');
  assert.equal(origins.original, 1, 'a keyword-only film stays original');
  assert.equal(
    taxonomy.origins.reduce((sum, entry) => sum + entry.count, 0),
    2,
    'origins must sum to the number of films'
  );
});

test('runtime histogram: bucket bounds are inclusive and avgRating skips unrated', () => {
  const ctx = {
    filmsIndex: {
      a: { runtime: 39, rating: 8 },
      b: { runtime: 40, rating: 6 },
      c: { runtime: 120, rating: null },
      d: { runtime: 0, rating: 10 },
      e: { runtime: null, rating: 4 },
    },
  };
  const histogram = buildRuntimeHistogram(ctx);
  assert.deepEqual(
    histogram.map((bucket) => [bucket.bucket, bucket.count, bucket.avgRating]),
    [
      ['<40', 1, 8],
      ['40-59', 1, 6],
      ['120-149', 1, null],
      // Missing and zero runtimes share the "unknown" bucket.
      ['unknown', 2, 7],
    ]
  );
});

test('timeline: calendar days mirror the monthly bars and streaks', () => {
  const ctx = {
    isKpSource: false,
    upload: {
      events: [
        { source: 'diary', date: '2024-01-01', rating: 8, slug: 'a', rewatch: false },
        // watched.csv import dates never feed the timeline.
        { source: 'watched', date: '2024-03-01', rating: null, slug: 'b' },
        { source: 'diary', date: '2024-01-02', rating: 6, slug: 'b', rewatch: true },
        { source: 'diary', date: '2024-01-02', rating: null, slug: 'c', rewatch: false },
      ],
    },
    timelineMap: new Map(),
    watchDayMap: new Map(),
    watchEvents: [],
    realDateFrom: null,
    realDateTo: null,
  };

  const { timeline, watchDays, recentlyWatched, streaks, viewCount } = buildTimeline(ctx);

  assert.deepEqual(timeline, [
    { month: '2024-01', watched: 3, rated: 2, rewatchCount: 1 },
  ]);
  assert.equal(viewCount, 3);
  assert.equal(
    watchDays.reduce((sum, day) => sum + day.count, 0),
    viewCount,
    'sum(watchDays.count) must equal sum(timeline.watched)'
  );
  assert.deepEqual(
    watchDays.map((day) => [day.date, day.count, day.rewatchCount]),
    [
      ['2024-01-01', 1, 0],
      ['2024-01-02', 2, 1],
    ]
  );
  // Newest first; same-day viewings keep their insertion order (stable sort).
  assert.deepEqual(recentlyWatched.map((event) => event.slug), ['b', 'c', 'a']);
  assert.equal(streaks.current, 2);
  assert.equal(streaks.best, 2);
  assert.equal(streaks.lastWatchDate, '2024-01-02');
});

test('rewatch ranking keeps films with at least two Rewatch rows', () => {
  const rewatches = buildRewatches({
    rewatchBySlug: new Map([
      ['a', 3],
      ['b', 1],
      ['c', 2],
    ]),
  });
  assert.deepEqual(rewatches, [
    { slug: 'a', count: 3 },
    { slug: 'c', count: 2 },
  ]);
});
