'use strict';

/**
 * `summary` of the books payload: the headline counters plus three
 * sub-objects (collections audit, metadata coverage, year backfill).
 *
 * S2 «распил god-функции»: `buildSummaryBase` is the literal the payload used
 * to build inline; the sub-objects are assigned afterwards in the same order
 * they were assigned before (`collections`, `metadata`, `yearBackfill`),
 * because the JSON key order is part of the golden contract.
 * `summary.seriesCount` is the one field the assembly line re-assigns after
 * `buildSeries` (the key already exists here, so its position does not move).
 */

const { mean } = require('./numeric');
const { ANCIENT_BEFORE_YEAR } = require('./constants');
const { buildMetadataCoverage, buildYearBackfill } = require('./coverage');

function buildSummaryBase(ctx, deps) {
  const {
    works,
    events,
    worksEvents,
    prepared,
    selected,
    profile,
    authorMerge,
    includeMangaComics,
    segmentDuplicates,
    acceptedSegmentEvents,
    reReadCounts,
  } = ctx;
  const {
    excluded: mangaExcluded,
    seriesExcluded: mangaSeriesExcluded,
    manualExcluded: mangaManualExcluded,
    manualRestored: mangaManualRestored,
    seriesPropagated: mangaSeriesPropagated,
    overrides: mangaOverrides,
  } = ctx.manga;
  const { profileShelfCounts } = deps;
  const finishedEvents = ctx.finishedEvents;
  const monthOnlyCount = ctx.monthOnlyEvents.length;

  const ratedWorks = [...works.values()].filter((work) => work.rating10 != null);
  const pagesWorks = [...works.values()].filter((work) => work.pages != null);
  const years = [...works.values()]
    .map((work) => work.year)
    .filter((year) => Number.isFinite(year) && year >= 1000)
    .sort((a, b) => a - b);
  const yearSourceCounts = { first: 0, edition: 0, manual: 0 };
  for (const work of works.values()) {
    if (!Number.isFinite(work.year)) continue;
    if (work.yearSource && yearSourceCounts[work.yearSource] != null) {
      yearSourceCounts[work.yearSource]++;
    }
  }
  const authorSet = new Set();
  for (const work of works.values()) for (const name of work.authors) authorSet.add(name);
  const seriesSet = new Set();
  for (const work of works.values()) for (const entry of work.series) seriesSet.add(entry.hcId || entry.name);

  let reReadCount = 0;
  const reReadKeys = new Set(
    events.map((event) => `${event.source}:${event.userKey}:${event.sourceBookId}`)
  );
  for (const key of reReadKeys) {
    reReadCount += reReadCounts.get(key) || 0;
  }
  // Works-level counters: a collection row is represented by its works, not by
  // the host record (the host is not in `works`).
  const llEvents = worksEvents.filter((event) => event.source === 'livelib');
  const llResolved = llEvents.filter((event) => {
    const work = works.get(event.workId);
    return Boolean(work && !work.unresolved);
  }).length;
  const llCanonical = llEvents.filter((event) => event.resolved).length;
  const finishedDates = finishedEvents
    .map((event) => String(event.finishedAt))
    .filter((date) => /^\d{4}-\d{2}-\d{2}/.test(date))
    .sort();
  const pagesTotal = pagesWorks.length
    ? pagesWorks.reduce((sum, work) => sum + work.pages, 0)
    : 0;
  const summary = {
    sources: selected,
    bookCount: works.size,
    eventCount: events.length,
    finishedCount: finishedEvents.length,
    readCount: events.filter((event) => event.status === 'read').length,
    reReadCount,
    // Events with neither an exact day nor a month: truly undated.
    undatedEventCount: events.length - finishedEvents.length - monthOnlyCount,
    monthOnlyEventCount: monthOnlyCount,
    // Reading period of the selected sources (film contract: dateFrom/dateTo).
    dateFrom: finishedDates.length ? finishedDates[0].slice(0, 10) : null,
    dateTo: finishedDates.length ? finishedDates[finishedDates.length - 1].slice(0, 10) : null,
    resolvedCount: llResolved,
    unresolvedCount: llEvents.length - llResolved,
    canonicalResolvedCount: llCanonical,
    mangaExcluded,
    // Subset of mangaExcluded: works flagged comics only through a sibling
    // volume of the same series (their own flag was false or null).
    mangaSeriesExcluded,
    mangaSeriesPropagated,
    // Manual override bookkeeping: `hidden` = excluded by a manual `true`,
    // `restored` = a work whose detector/series flag was true but the user
    // explicitly asked to show it again (`false`).
    mangaManualExcluded,
    mangaManualRestored,
    mangaOverrides,
    // Events dropped at aggregation time because their Hardcover journal
    // status is not part of the reading profile (wish/reading/paused).
    hardcoverStatusExcluded: prepared.statusFilter.excluded - prepared.statusFilter.shelfExcluded,
    // File import (`livelib-backup`): «Читаю сейчас»/«Хочу прочитать» are plans,
    // not history. They stay in the profile file (reading feeds the strip,
    // wishlist is future work) and never inflate the finished-book counters.
    shelfExcluded: prepared.statusFilter.shelfExcluded,
    // «Читаю сейчас» shelf state (both sources). Separate from the reading
    // statistics: it is shown in the strip and the dashboard counter only.
    // One event = one book being read (file re-imports are idempotent, and
    // Hardcover collapses the open reads of one user_book into one event).
    readingNowCount: prepared.readingEvents.length,
    // What the profile document holds per shelf (after the filter above).
    shelves: profileShelfCounts(profile.events),
    includeMangaComics,
    avgRating: mean(ratedWorks.map((work) => work.rating10)),
    avgPages: pagesWorks.length
      ? Math.round(pagesWorks.reduce((sum, work) => sum + work.pages, 0) / pagesWorks.length)
      : null,
    pagesTotal,
    pageCount: pagesTotal,
    authorsCount: authorSet.size,
    authorsMergedCount: authorMerge.mergedGroups,
    seriesCount: seriesSet.size,
    // Works that had a blacklisted catalogue tag («Книга на все времена»)
    // removed from their series list (series-blacklist.js); reported instead of
    // the tag itself.
    seriesTagsFiltered: [...works.values()].reduce(
      (sum, work) => sum + (Number(work.seriesTagsFiltered) || 0),
      0
    ),
    ancientBookCount: [...works.values()].filter(
      (work) => Number.isFinite(work.year) && work.year < ANCIENT_BEFORE_YEAR
    ).length,
    // Works whose publication year comes from a print run because no provider
    // knows the first publication (honest `yearSource: 'edition'`), plus the
    // user's manual corrections. The UI marks them and never calls an edition
    // year a first publication.
    yearFirstCount: yearSourceCounts.first,
    yearEditionCount: yearSourceCounts.edition,
    yearManualCount: yearSourceCounts.manual,
    // Works with no year at all: no first publication, no edition year, no
    // manual correction. They are the only ones in «год неизвестен».
    yearUnknownCount: [...works.values()].filter((work) => !Number.isFinite(work.year)).length,
    yearsSpan: years.length ? { from: years[0], to: years[years.length - 1] } : null,
  };
  return summary;
}

/**
 * Collection rows at a glance (СБОРНИКИ-ЭВРИСТИКА §5): how many rows the
 * parser split, how many of their works were proven by a provider link, how
 * many fell back to the host row and why a row was left alone.
 */
function buildCollectionsAudit(ctx) {
  const {
    works,
    prepared,
    acceptedSegmentEvents,
    segmentDuplicates,
    collectionFallbackHosts,
  } = ctx;
  const blockedByReason = { linked: 0, details: 0, manual_year: 0 };
  for (const entry of prepared.collectionsBlocked) {
    if (blockedByReason[entry.reason] != null) blockedByReason[entry.reason]++;
  }
  return {
    rows: prepared.collections.size,
    parsedWorks: prepared.segmentEvents.length,
    linkedWorks: acceptedSegmentEvents.length,
    visibleWorks: new Set(
      acceptedSegmentEvents
        .filter((event) => works.has(event.workId))
        .map((event) => event.workId)
    ).size,
    dedupedWorks: segmentDuplicates,
    fallbackRows: collectionFallbackHosts,
    catalogRows: [...prepared.collections.values()].filter((entry) => entry.catalogSeries).length,
    noAuthorWorks: prepared.segmentEvents.filter((event) => !event.authors.length).length,
    blockedRows: prepared.collectionsBlocked.length,
    blockedByReason,
    includeMedium: prepared.includeMediumSegments,
  };
}

function buildSummary(ctx, deps) {
  const summary = buildSummaryBase(ctx, deps);
  summary.collections = buildCollectionsAudit(ctx);
  summary.metadata = buildMetadataCoverage(ctx);
  summary.yearBackfill = buildYearBackfill(ctx);
  return summary;
}

module.exports = { buildSummary };
