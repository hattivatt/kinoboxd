'use strict';

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
    undatedEventCount: events.length - finishedEvents.length - monthOnlyCount,
    monthOnlyEventCount: monthOnlyCount,
    dateFrom: finishedDates.length ? finishedDates[0].slice(0, 10) : null,
    dateTo: finishedDates.length ? finishedDates[finishedDates.length - 1].slice(0, 10) : null,
    resolvedCount: llResolved,
    unresolvedCount: llEvents.length - llResolved,
    canonicalResolvedCount: llCanonical,
    mangaExcluded,
    mangaSeriesExcluded,
    mangaSeriesPropagated,
    mangaManualExcluded,
    mangaManualRestored,
    mangaOverrides,
    hardcoverStatusExcluded: prepared.statusFilter.excluded - prepared.statusFilter.shelfExcluded,
    shelfExcluded: prepared.statusFilter.shelfExcluded,
    readingNowCount: prepared.readingEvents.length,
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
    seriesTagsFiltered: [...works.values()].reduce(
      (sum, work) => sum + (Number(work.seriesTagsFiltered) || 0),
      0
    ),
    ancientBookCount: [...works.values()].filter(
      (work) => Number.isFinite(work.year) && work.year < ANCIENT_BEFORE_YEAR
    ).length,
    yearFirstCount: yearSourceCounts.first,
    yearEditionCount: yearSourceCounts.edition,
    yearManualCount: yearSourceCounts.manual,
    yearUnknownCount: [...works.values()].filter((work) => !Number.isFinite(work.year)).length,
    yearsSpan: years.length ? { from: years[0], to: years[years.length - 1] } : null,
  };
  return summary;
}

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
