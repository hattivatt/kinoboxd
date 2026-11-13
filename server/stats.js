'use strict';

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

  const taxonomy = buildTaxonomy(ctx.taxEntries, { blacklist: readBlacklist() });

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
