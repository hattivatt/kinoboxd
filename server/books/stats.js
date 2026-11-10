'use strict';

/**
 * /api/books/stats payload (КНИГИ-АРХИТЕКТУРА.md §5, v4: single-profile).
 *
 * A books profile IS one source + one account: `livelib-Margaret` OR
 * `hardcover-34748`. Two readers never merge, and two services never merge
 * either — `/api/books/stats` requires exactly one `?profile=` token and every
 * widget is computed from that profile's events only.
 *
 * Consequences, all deliberate:
 *   - events are never merged across sources; a LiveLib event stays a LiveLib
 *     event even when its *metadata* was resolved through Hardcover/Litres/GB;
 *   - `booksIndex` keys are the LiveLib stub `ll:{sourceBookId}` or the resolved
 *     canonical work `hc:{books.id}` that the resolve chain linked *for this
 *     LiveLib book*; no cross-source title dedupe happens in stats;
 *   - there is no `ratings.bySource` / `sources.filter` / `?sources=` any more:
 *     the single-profile contract is strict, extra query parameters are a 400
 *     at the route (`unexpected_parameter`);
 *   - only events with `finishedAt` enter timeline/calendar/streaks;
 *     `summary.undatedEventCount` reports the rest honestly;
 *   - `summary.metadata` reports how much of the profile already has
 *     bibliographic metadata (`resolved/total/percent`) and whether the resolve
 *     stage is running for it right now (`running`, `budgetRemaining`);
 *   - `metadataSources` on a work says where the *bibliographic metadata* came
 *     from. That is a metadata chain, not an event union.
 */

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
  dedupeWorks,
  mergeWorkGroup,
} = require('./stats/work');
const { resolveWorkYear, yearOverrideKeysOf } = require('./stats/years');
const {
  dedupeSeriesSubsets,
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

/* ------------------------------------------------------------------ */
/* Payload                                                             */
/* ------------------------------------------------------------------ */

/**
 * Build the whole /api/books/stats payload for ONE profile.
 *
 * `options.profile` is the raw `?profile=` value (`livelib-Margaret`);
 * `options.profileScope` may carry an already-resolved scope (routes resolve it
 * to answer 400 with a good message). `options.resolveState` is the live
 * import-job view (`{ running, budgetRemaining }`) used for
 * `summary.metadata`; absent means "not running". `options.now` is injectable
 * for tests.
 *
 * S2 «распил god-функции»: this function is the assembly line only.
 * `stats/context.js` prepares the profile/events/work set, and every payload
 * section is built by its own module (`stats/summary.js`, `stats/coverage.js`,
 * `stats/widgets.js`, `stats/timeline.js`, `stats/books-index.js`,
 * `stats/meta.js`). The key order below is the payload contract — the golden
 * hash is byte-sensitive, so each section is slotted in exactly where its
 * value used to be built inline.
 *
 * R12 «god module» split: the helpers that used to live inline here are now
 * grouped by topic — `stats/scope.js` (profile selection), `stats/events.js`
 * (event preparation), `stats/work.js` (work metadata + work dedupe),
 * `stats/series.js` (series lists, file metadata, series manga) and
 * `stats/years.js` (year resolution). Every name is re-exported below, so the
 * module surface of `books/stats.js` is unchanged.
 */
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
  const series = buildSeries(ctx, { dedupeSeriesSubsets });
  // The literal already created `seriesCount`; re-assigning keeps the key in
  // place. The final number is post-`dedupeSeriesSubsets`, as before.
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
    // Which profile produced this payload, plus the catalog of profiles on the
    // server. `selected` is always exactly one source: a profile is one account
    // of one service. There is no `filter` block: the route rejects unknown
    // query parameters instead of echoing an ignored filter.
    sources: {
      connected,
      selected,
      profile: {
        key: profileKeyOf(profile),
        source: profile.source,
        userKey: profile.userKey,
        // How the profile was acquired: `livelib` (scrape) or `livelib-file`
        // (livelib-backup export). Same key contract either way.
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

/**
 * Compact summary of ONE cached profile document, for `GET /api/books/profiles`
 * (switcher badges + docs). Reuses `prepareEvents`, so the Hardcover journal
 * status filter and re-read grouping behave exactly like in the stats build,
 * but no details/metadata files are read — the endpoint must stay cheap for a
 * 1245-event LiveLib profile.
 *
 * Deliberately *not* the stats payload: `bookCount` here is unique `workId`
 * before the cross-source title dedupe (live: 1211 vs 1210 for the same
 * profile) and no manga/comics filter is applied (live Hardcover: 653 events
 * here vs 131 in /stats, where the comics shelf is hidden by default). Use it
 * for badges/docs, never as a substitute for /api/books/stats.
 */
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
  // A collection row is a host for its works: the badge count follows the same
  // semantics as /stats (a host with no proven work still counts as one book).
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

/** Unmatched list for GET /api/books/unmatched (one profile by contract). */
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
  dedupeWorks,
  mergeWorkGroup,
  dedupeSeriesSubsets,
  propagateSeriesManga,
  applyManualMangaFlags,
  buildBooksStats,
  profileSummary,
  listUnmatched,
};
