'use strict';

const {
  round2,
  mean,
  dayNumber,
  computeStreaks,
} = require('./stats/numeric');
const {
  PAGE_BUCKETS,
  HARDCOVER_PROFILE_STATUS_IDS,
  READ_SHELF_LABELS,
} = require('./stats/constants');
const {
  PROFILE_SOURCES,
  connectedProfiles,
  profileKeyOf,
  parseProfileParam,
  resolveProfileScope,
  selectProfiles,
} = require('./stats/scope');
const {
  keepHardcoverProfileEvent,
  keepShelfProfileEvent,
  shelfOfEvent,
  eventLinkKeyOf,
  prepareEvents,
  profileShelfCounts,
} = require('./stats/events');
const {
  workMetadata,
  canonicalKeyOf,
} = require('./stats/work');
const { resolveWorkYear, yearOverrideKeysOf } = require('./stats/years');
const {
  dedupeSeriesSubsets,
  seriesGroupsOf,
  propagateSeriesManga,
  applyManualMangaFlags,
} = require('./stats/series');
const { buildContext } = require('./stats/context');
const { buildSummary } = require('./stats/summary');
const {
  buildRatings,
  buildGenres,
  buildYearBuckets,
  buildAuthors,
  buildSeries,
  buildPagesHistogram,
} = require('./stats/widgets');
const { buildTimeline, buildRecentlyFinished, buildRecentlyReading } = require('./stats/timeline');
const { buildBooksIndex, buildUnmatched } = require('./stats/books-index');
const { buildMeta } = require('./stats/meta');

function buildBooksStats(options = {}) {
  const startedAt = process.hrtime.bigint();
  const ctx = buildContext(options, {
    resolveProfileScope,
    selectProfiles,
    prepareEvents,
    workMetadata,
    propagateSeriesManga,
    applyManualMangaFlags,
    eventLinkKeyOf,
  });

  const summary = buildSummary(ctx, { profileShelfCounts });
  const ratings = buildRatings(ctx);
  const genres = buildGenres(ctx);
  const { decades, years: yearsList } = buildYearBuckets(ctx);
  const authorsList = buildAuthors(ctx);
  const series = buildSeries(ctx, { dedupeSeriesSubsets, seriesGroupsOf });
  summary.seriesCount = series.length;
  const pagesHistogram = buildPagesHistogram(ctx);
  const { timeline, readDays, streaks } = buildTimeline(ctx);
  const recentlyFinished = buildRecentlyFinished(ctx);
  const recentlyReading = buildRecentlyReading(ctx);
  const booksIndex = buildBooksIndex(ctx);
  const unmatched = buildUnmatched(ctx);

  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const { connected, selected, profile, selection } = ctx;

  return {
    sources: {
      connected,
      selected,
      profile: {
        key: profileKeyOf(profile),
        source: profile.source,
        userKey: profile.userKey,
        origin: profile.origin || profile.source,
        importedAt: profile.importedAt || null,
        eventCount: profile.events.length,
      },
      profiles: {
        connected: selection.allProfileKeys,
        selected: selection.selectedProfileKeys,
      },
    },
    summary,
    ratings,
    genres,
    decades,
    years: yearsList,
    timeline,
    readDays,
    streaks,
    recentlyFinished,
    recentlyReading,
    authors: authorsList,
    series,
    pagesHistogram,
    booksIndex,
    unmatchedCount: unmatched.length,
    unmatched,
    meta: buildMeta(ctx, elapsedMs),
  };
}

function profileSummary(profile) {
  if (!profile || !Array.isArray(profile.events)) {
    return {
      eventCount: 0,
      bookCount: 0,
      finishedCount: 0,
      undatedEventCount: 0,
      monthOnlyEventCount: 0,
      readCount: 0,
      reReadCount: 0,
      avgRating: null,
      dateFrom: null,
      dateTo: null,
    };
  }
  const prepared = prepareEvents([profile]);
  const events = prepared.events;
  const workIds = new Set(
    events
      .filter((event) => !prepared.collectionHostIds.has(event.id))
      .map((event) => event.workId)
  );
  const acceptedSegments = prepared.segmentEvents.filter((event) => event.segmentAccepted);
  for (const event of acceptedSegments) workIds.add(event.workId);
  for (const [parentId] of prepared.collections) {
    const info = prepared.collections.get(parentId);
    const visible = info.segments.some((segment) => segment.accepted);
    if (!visible) {
      workIds.add(info.parentWorkId);
    }
  }
  const finished = events.filter((event) => event.finishedAt);
  const monthOnly = events.filter(
    (event) => !event.finishedAt && /^\d{4}-\d{2}$/.test(String(event.readMonth || ''))
  ).length;
  const dates = finished
    .map((event) => String(event.finishedAt).slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  let reReadCount = 0;
  const groups = new Set(
    events.map((event) => `${event.source}:${event.userKey}:${event.sourceBookId}`)
  );
  for (const key of groups) reReadCount += prepared.reReadCounts.get(key) || 0;

  return {
    eventCount: events.length,
    bookCount: workIds.size,
    finishedCount: finished.length,
    undatedEventCount: events.length - finished.length - monthOnly,
    monthOnlyEventCount: monthOnly,
    readCount: events.filter((event) => event.status === 'read').length,
    reReadCount,
    avgRating: mean(
      events.filter((event) => event.rating10 != null).map((event) => event.rating10)
    ),
    dateFrom: dates.length ? dates[0] : null,
    dateTo: dates.length ? dates[dates.length - 1] : null,
  };
}

function listUnmatched(options = {}) {
  const stats = buildBooksStats(options);
  return {
    count: stats.unmatchedCount,
    items: stats.unmatched,
    profile: stats.sources.profile,
    sources: stats.sources,
  };
}

module.exports = {
  PAGE_BUCKETS,
  HARDCOVER_PROFILE_STATUS_IDS,
  PROFILE_SOURCES,
  round2,
  mean,
  dayNumber,
  computeStreaks,
  connectedProfiles,
  profileKeyOf,
  parseProfileParam,
  resolveProfileScope,
  selectProfiles,
  keepHardcoverProfileEvent,
  keepShelfProfileEvent,
  shelfOfEvent,
  READ_SHELF_LABELS,
  prepareEvents,
  workMetadata,
  resolveWorkYear,
  yearOverrideKeysOf,
  canonicalKeyOf,
  dedupeSeriesSubsets,
  propagateSeriesManga,
  applyManualMangaFlags,
  buildBooksStats,
  profileSummary,
  listUnmatched,
};
