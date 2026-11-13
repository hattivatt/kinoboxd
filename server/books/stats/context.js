'use strict';

const bookCache = require('../book-cache');
const authors = require('../authors');

function buildContext(options = {}, deps = {}) {
  const {
    resolveProfileScope,
    selectProfiles,
    prepareEvents,
    workMetadata,
    propagateSeriesManga,
    applyManualMangaFlags,
    eventLinkKeyOf,
  } = deps;

  const includeMangaComics = options.includeMangaComics === true;
  const selection = selectProfiles(
    options.profileScope || resolveProfileScope(options.profile, options.profilesOnDisk)
  );
  if (selection.profiles.length !== 1) {
    const error = new Error(
      'Exactly one books profile is required: /api/books/stats?profile=<source>-<userKey>.'
    );
    error.code = 'profile_required';
    error.status = 400;
    error.availableProfileKeys = selection.allProfileKeys;
    throw error;
  }
  const { connected, selected, profiles } = selection;
  const profile = profiles[0];
  const yearOverrides = bookCache.getYearOverrides(profile.source, profile.userKey);
  const prepared = prepareEvents(profiles, {
    yearOverrides,
    includeMediumSegments: options.includeMediumSegments === true,
  });
  const reReadCounts = prepared.reReadCounts;
  let events = prepared.events;

  const collectionHostEvents = events.filter((event) => prepared.collectionHostIds.has(event.id));
  const acceptedSegmentEvents = prepared.segmentEvents.filter((event) => event.segmentAccepted);
  const hostWorks = new Map();
  const hostEvents = new Map();
  for (const event of collectionHostEvents) {
    hostWorks.set(event.id, workMetadata(event.workId, [event], { yearOverrides }));
    hostEvents.set(event.id, event);
  }
  const workEvents = events.filter((event) => !prepared.collectionHostIds.has(event.id));
  let worksEvents = workEvents.concat(acceptedSegmentEvents);

  const byWork = new Map();
  for (const event of worksEvents) {
    if (!byWork.has(event.workId)) byWork.set(event.workId, []);
    byWork.get(event.workId).push(event);
  }
  let works = new Map();
  for (const [workId, list] of byWork) {
    works.set(workId, workMetadata(workId, list, { yearOverrides }));
  }

  let segmentDuplicates = 0;
  const seenSegmentWorkIds = new Set(workEvents.map((event) => event.workId));
  for (const event of acceptedSegmentEvents) {
    if (seenSegmentWorkIds.has(event.workId)) segmentDuplicates++;
    else seenSegmentWorkIds.add(event.workId);
  }

  const mangaFromSeries = propagateSeriesManga(works);
  const manualManga = applyManualMangaFlags(works, bookCache.getMangaFlags());
  let mangaExcluded = 0;
  let mangaSeriesExcluded = 0;
  let mangaManualExcluded = 0;
  let mangaManualRestored = 0;
  for (const [, entry] of manualManga) {
    if (entry.mangaComics === false && entry.previous === true) mangaManualRestored++;
  }
  if (!includeMangaComics) {
    const excluded = new Set();
    for (const [workId, work] of works) {
      if (work.mangaComics === true) {
        excluded.add(workId);
        works.delete(workId);
        mangaExcluded++;
        if (mangaFromSeries.has(workId)) mangaSeriesExcluded++;
        if (manualManga.has(workId)) mangaManualExcluded++;
      }
    }
    if (excluded.size > 0) {
      events = events.filter((event) => !excluded.has(event.workId));
      worksEvents = worksEvents.filter((event) => !excluded.has(event.workId));
    }
  }

  let collectionFallbackHosts = 0;
  for (const [parentId, info] of prepared.collections) {
    const visible = info.segments.some((segment) => segment.accepted && works.has(segment.workId));
    if (visible) continue;
    const hostWork = hostWorks.get(parentId);
    if (!hostWork) continue;
    if (!includeMangaComics) {
      const flags = bookCache.getMangaFlags();
      const flag = flags && flags[hostWork.workId];
      if (flag && flag.mangaComics === true) continue;
      if (!flag && hostWork.mangaComics === true) continue;
    }
    works.set(hostWork.workId, hostWork);
    const hostEvent = hostEvents.get(parentId);
    if (hostEvent) {
      worksEvents.push(hostEvent);
      byWork.set(hostWork.workId, [hostEvent]);
    }
    collectionFallbackHosts++;
  }

  const workLinkKeys = new Map();
  for (const [workId, list] of byWork) {
    const keys = [];
    for (const event of list) {
      const key = eventLinkKeyOf(event);
      if (key && !keys.includes(key)) keys.push(key);
    }
    workLinkKeys.set(workId, keys);
  }

  for (const event of events) {
    const key = `${event.source}:${event.userKey}:${event.sourceBookId}`;
    const extras = reReadCounts.get(key) || 0;
    event.reread = event.reread || (extras > 0 && event.groupIndex > 1);
  }

  const authorEntries = [];
  for (const work of works.values()) {
    const idsByKey = new Map();
    const detailAuthors = work.details && Array.isArray(work.details.authors) ? work.details.authors : [];
    for (const entry of detailAuthors) {
      const name = entry && typeof entry === 'object' ? entry.name : entry;
      const id = entry && typeof entry === 'object' ? entry.hcId : null;
      if (name && id != null) idsByKey.set(authors.normalizeAuthorName(name), String(id));
    }
    for (const name of work.authors) {
      if (!name) continue;
      authorEntries.push({
        name,
        id: idsByKey.get(authors.normalizeAuthorName(name)) || null,
        workId: work.workId,
      });
    }
  }
  const persistedAuthors = bookCache.getAuthorsMap();
  const authorMerge = authors.groupAuthors(authorEntries, persistedAuthors);
  for (const work of works.values()) {
    const seen = new Set();
    const merged = [];
    for (const name of work.authors) {
      const canonical = authorMerge.canonicalOf.get(authors.normalizeAuthorName(name)) || name;
      const key = authors.normalizeAuthorName(canonical);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(canonical);
    }
    work.authors = merged;
  }
  const authorsFingerprint = authors.fingerprintOfNames(authorEntries.map((entry) => entry.name));
  if (persistedAuthors.fingerprint !== authorsFingerprint) {
    void bookCache
      .saveAuthorsMap({
        fingerprint: authorsFingerprint,
        canonical: Object.fromEntries(authorMerge.canonicalOf),
      })
      .catch(() => {});
  }

  if (typeof options.authorBridge === 'function') {
    try {
      const pass = options.authorBridge(authorEntries, {
        persisted: persistedAuthors,
        groups: authorMerge.groups,
      });
      if (pass && typeof pass.catch === 'function') pass.catch(() => {});
    } catch (err) {
    }
  }

  const finishedEvents = events.filter((event) => event.finishedAt);
  const monthOnlyEvents = events.filter(
    (event) => !event.finishedAt && /^\d{4}-\d{2}$/.test(String(event.readMonth || ''))
  );

  return {
    options,
    includeMangaComics,
    selection,
    connected,
    selected,
    profiles,
    profile,
    prepared,
    reReadCounts,
    events,
    worksEvents,
    works,
    workLinkKeys,
    segmentDuplicates,
    collectionFallbackHosts,
    acceptedSegmentEvents,
    manga: {
      excluded: mangaExcluded,
      seriesExcluded: mangaSeriesExcluded,
      manualExcluded: mangaManualExcluded,
      manualRestored: mangaManualRestored,
      seriesPropagated: mangaFromSeries.size,
      overrides: manualManga.size,
    },
    authorMerge,
    authorEntries,
    finishedEvents,
    monthOnlyEvents,
  };
}

module.exports = { buildContext };
