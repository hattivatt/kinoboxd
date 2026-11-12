'use strict';

/**
 * `/api/stats` payload of the films dashboard.
 *
 * The payload contract (keys, their order and every number) is frozen by the
 * golden snapshot (`test/golden/films.json`) and the smoke baseline. The
 * builder is split into sections (S3):
 *
 *   stats/context.js    one pass over `upload.films` → maps/arrays
 *   stats/widgets.js    ratings, genres, decades, franchises, runtime, years
 *   stats/timeline.js   timeline, calendar days, recently watched, streaks
 *   stats/people.js     actors/directors/writers/composers/studios
 *   stats/summary.js    the `summary` block (incl. the auteur index)
 *   stats/unmatched.js  the manual-match list
 *   stats/documents.js  TMDB genre/collection/country helpers
 *   stats/numeric.js    round2, dayNumber, streaks, runtime buckets
 *
 * Nothing here is live: every value comes from the persistent caches (TMDB
 * details/index/links, the Letterboxd attachment). `buildStats` is the
 * orchestrator; it only assembles the sections in the payload's key order.
 */

const { getJob } = require('./enrich');
const { buildTaxonomy, readBlacklist } = require('./taxonomy');
const { buildContext } = require('./stats/context');
const { buildSummary } = require('./stats/summary');
const {
  buildRatings,
  buildGenres,
  buildDecades,
  buildFranchises,
  buildRuntimeHistogram,
  buildDecadeRatings,
  buildYears,
} = require('./stats/widgets');
const { buildTimeline, buildRewatches } = require('./stats/timeline');
const { buildPersons } = require('./stats/people');
const { computeUnmatched, listUnmatched, effectiveKind } = require('./stats/unmatched');
const { cleanCollectionName } = require('./stats/documents');

/**
 * Compute the full dashboard payload for an upload.
 *
 * `jobOverride` is used by the profile comparison endpoint, which resolves
 * TMDB matches straight from the cache and must not register a fake job in the
 * live enrich registry. /api/stats keeps calling buildStats(upload) unchanged.
 */
function buildStats(upload, jobOverride = null) {
  const job = jobOverride || getJob(upload.uploadId);
  if (!job || !job.done) {
    return null;
  }

  const ctx = buildContext(upload, job);

  const ratings = buildRatings(ctx);
  const genres = buildGenres(ctx);
  const decades = buildDecades(ctx);
  const franchises = buildFranchises(ctx);
  const runtimeHistogram = buildRuntimeHistogram(ctx);
  const decadeRatings = buildDecadeRatings(ctx, decades);
  const years = buildYears(ctx);
  const { timeline, watchDays, recentlyWatched, streaks, viewCount } = buildTimeline(ctx);
  const persons = buildPersons(ctx);

  // Keyword taxonomy over matched films. Categories include only non-empty
  // buckets; origins are mutually exclusive and always sum to taxEntries.
  // The per-film blacklist (cache/flags/taxonomy-blacklist.json) is read once
  // per build and only removes a category/period from the listed slug.
  const taxonomy = buildTaxonomy(ctx.taxEntries, { blacklist: readBlacklist() });

  // One flat list for the dashboard: TMDB genres (hidden ones filtered out,
  // Music already adjusted for the "musical" keyword) plus keyword-derived
  // categories. Sorting is count desc, ties by Russian name asc. Counts are
  // intentionally not expected to sum to filmCount: a film can have several
  // genres and several independent categories.
  const mergedGenres = [...genres, ...taxonomy.categories].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru')
  );

  const unmatched = computeUnmatched(upload, job);
  const matchedFilmCount = Math.max(0, upload.films.length - unmatched.length);
  const summary = buildSummary(ctx, {
    unmatchedCount: unmatched.length,
    matchedFilmCount,
    persons,
    viewCount,
  });
  const rewatches = buildRewatches(ctx);

  // Key order is the payload contract — the golden hash is byte-sensitive.
  return {
    summary,
    ratings,
    genres: mergedGenres,
    decades,
    franchises,
    runtimeHistogram,
    decadeRatings,
    years,
    timeline,
    watchDays,
    recentlyWatched,
    streaks,
    persons,
    origins: taxonomy.origins,
    periods: taxonomy.periods,
    filmsIndex: ctx.filmsIndex,
    rewatches,
    unmatched,
  };
}

module.exports = {
  buildStats,
  listUnmatched,
  effectiveKind,
  __internal: { cleanCollectionName },
};
