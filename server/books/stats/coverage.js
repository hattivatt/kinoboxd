'use strict';

const bookCache = require('../book-cache');
const { saneYear } = require('./numeric');
const { FILE_METADATA_SOURCE } = require('./constants');

function buildMetadataCoverage(ctx) {
  const { works, workLinkKeys, profile, options } = ctx;
  const metadataTotal = works.size;
  let metadataLinked = 0;
  let metadataWithDetails = 0;
  let metadataUnlinked = 0;
  const resolveArchive =
    profile.source === 'livelib' ? bookCache.getResolveState('livelib', profile.userKey) : null;
  const hopelessKeys = new Set(
    Array.isArray(resolveArchive && resolveArchive.unmatchedKeys)
      ? resolveArchive.unmatchedKeys.map(String)
      : []
  );
  let metadataHopeless = 0;
  let metadataKeyless = 0;
  for (const [workId, work] of works) {
    const canonicalWorkId = work.metadataWorkId && !String(work.metadataWorkId).startsWith('ll:');
    if (canonicalWorkId) metadataLinked++;
    if (work.details) metadataWithDetails++;
    if (canonicalWorkId || work.details) continue;
    metadataUnlinked++;
    const keys = workLinkKeys.get(workId) || [];
    if (keys.length === 0) {
      metadataKeyless++;
      continue;
    }
    if (hopelessKeys.size && keys.every((key) => hopelessKeys.has(String(key)))) {
      metadataHopeless++;
    }
  }
  const metadataResolved = metadataTotal - metadataUnlinked;
  const metadataResolvable = Math.max(
    0,
    metadataTotal - metadataHopeless - metadataKeyless
  );
  const resolveState = options.resolveState && typeof options.resolveState === 'object'
    ? options.resolveState
    : {};
  const metadataRunning = profile.source === 'livelib' && resolveState.running === true;
  const budgetRemaining = resolveState.budgetRemaining != null &&
    Number.isFinite(Number(resolveState.budgetRemaining))
    ? Number(resolveState.budgetRemaining)
    : null;
  const metadataPercent = metadataResolvable
    ? Math.round((metadataResolved * 100) / metadataResolvable)
    : 100;
  return {
    resolved: metadataResolved,
    total: metadataTotal,
    linked: metadataLinked,
    withDetails: metadataWithDetails,
    unlinked: metadataUnlinked,
    resolvable: metadataResolvable,
    hopeless: metadataHopeless,
    keyless: metadataKeyless,
    percent: metadataPercent,
    done: !metadataRunning && metadataResolved >= metadataResolvable,
    running: metadataRunning,
    budgetRemaining: metadataRunning ? budgetRemaining : null,
  };
}

function buildYearBackfill(ctx) {
  const { works, profile } = ctx;
  let yearsKnown = 0;
  let yearsPending = 0;
  let yearsHonest = 0;
  let yearsUnlinked = 0;
  const yearsBySource = { first: 0, edition: 0, manual: 0 };
  const editionChannels = { file: 0, details: 0 };
  for (const work of works.values()) {
    if (Number.isFinite(work.year)) {
      yearsKnown++;
      if (work.yearSource && yearsBySource[work.yearSource] != null) {
        yearsBySource[work.yearSource]++;
      }
      if (work.yearSource === 'edition' && work.editionYearSource && editionChannels[work.editionYearSource] != null) {
        editionChannels[work.editionYearSource]++;
      }
      continue;
    }
    const details = work.details;
    if (!details) {
      yearsUnlinked++;
      continue;
    }
    if (details.firstPublishedYear != null || details.firstPublishedYearCheckedAt) {
      yearsHonest++;
      continue;
    }
    yearsPending++;
  }
  const backfillLimit = Number(process.env.BOOKS_BACKFILL_LIMIT);
  const yearsPerRun =
    Number.isFinite(backfillLimit) && backfillLimit > 0
      ? Math.floor(backfillLimit)
      : Math.max(yearsPending, 1);
  let fileRows = 0;
  let fileRowsWithYear = 0;
  for (const event of profile.events || []) {
    if (!event || event.origin !== FILE_METADATA_SOURCE) continue;
    fileRows++;
    if (event.edition && saneYear(event.edition.year) != null) fileRowsWithYear++;
  }
  return {
    known: yearsKnown,
    unknown: yearsPending + yearsHonest + yearsUnlinked,
    pending: yearsPending,
    honestUnknown: yearsHonest,
    unlinked: yearsUnlinked,
    sources: yearsBySource,
    editionChannels,
    fileColumn: { rows: fileRows, withYear: fileRowsWithYear },
    perRun: yearsPerRun,
    runsLeft: yearsPending > 0 ? Math.ceil(yearsPending / yearsPerRun) : 0,
    open: yearsPending > 0,
  };
}

module.exports = { buildMetadataCoverage, buildYearBackfill };
