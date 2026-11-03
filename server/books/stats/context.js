'use strict';

/**
 * Preprocessor of the books stats payload: profile selection, event
 * preparation, collection/segment rows, the manga/comics filter, per-work
 * re-read flags and the author identity merge.
 *
 * S2 «распил god-функции»: this is the shared state every payload section
 * needs (`works`, `events`, the prepared event set, the manga counters, the
 * author merge). Sections receive it as an explicit argument instead of
 * closing over a 1 000-line function body.
 *
 * Dependency injection: the helpers that stay in `books/stats.js` (they are
 * part of its exported surface — `selectProfiles`, `prepareEvents`,
 * `workMetadata`, …) arrive through `deps`. This module must not
 * `require('../stats')`: `stats.js` requires it, and a reverse require would
 * be a cycle.
 *
 * The returned context is *the* snapshot the payload is built from; builders
 * never mutate it except for `works` (the author merge rewrites
 * `work.authors` in place, exactly as before the split).
 */

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

  /* ---------------- collection rows (СБОРНИКИ-ЭВРИСТИКА §5) ---------------- */
  // A record with >= 2 parsed works is a host row, not a book. Its accepted
  // works (a high-confidence resolve link; `medium` only with the explicit
  // switch) become works of their own; the host is counted only when none of
  // them survived (nothing proven, or every work was hidden as manga), so the
  // row is never lost and the count never invents a split.
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

  // Segments dedupe by canonical provider work (the migration's `hcBookId`
  // rule) automatically: a resolved work takes the canonical `workId`, so two
  // segments of one anthology that resolve to the same edition — or a segment
  // that resolves to a book the profile already has as a normal record — land
  // in the same `byWork` group and count once. The count below is the audit
  // number of segment events absorbed by an already existing work.
  let segmentDuplicates = 0;
  const seenSegmentWorkIds = new Set(workEvents.map((event) => event.workId));
  for (const event of acceptedSegmentEvents) {
    if (seenSegmentWorkIds.has(event.workId)) segmentDuplicates++;
    else seenSegmentWorkIds.add(event.workId);
  }

  // Resolve-cache keys of every work, for the metadata-coverage denominator.
  // A work is "hopeless" only when the last resolve pass asked a provider
  // about *all* of its events and got nothing back (resolve-state).
  // (Built after the manga filter + host fallback: the denominator must cover
  // exactly the works the payload shows.)

  // Manga/comics filter (default OFF = manga excluded). A work is comics when
  // its own flag is true *or* any volume of the same series is comics
  // (series-level propagation above); `null` still survives on its own.
  const mangaFromSeries = propagateSeriesManga(works);
  // Manual override dominates everything above, including an explicit `true`.
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

  // Host fallback: a collection row whose works all vanished (none proven, or
  // every proven work was hidden as manga) is still a read book. Counting the
  // host keeps «каждая запись = отдельная книга» honest instead of deleting
  // the row from bookCount.
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

  // Event-level re-read flag from the per-book group counts.
  for (const event of events) {
    const key = `${event.source}:${event.userKey}:${event.sourceBookId}`;
    const extras = reReadCounts.get(key) || 0;
    event.reread = event.reread || (extras > 0 && event.groupIndex > 1);
  }

  /* ---------------- author identity (RU/EN dedupe) ---------------- */
  // One author can arrive as «Агата Кристи» from LiveLib and «Agatha
  // Christie» from the metadata chain. Group the spellings, prefer the
  // canonical English one, and persist the table so a manual merge survives a
  // rebuild. See server/books/authors.js for the safety rules.
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
    // Writing is best-effort: a read-only cache must never break the payload.
    void bookCache
      .saveAuthorsMap({
        fingerprint: authorsFingerprint,
        canonical: Object.fromEntries(authorMerge.canonicalOf),
      })
      .catch(() => {});
  }

  // Wikidata bridge (default-on, authors-bridge.js): only the spellings the
  // offline rule could not connect, fire-and-forget. `/api/books/stats` never
  // waits for WDQS — the merge lands in authors.json and the next payload (the
  // UI refresh after an import) applies it. Tests pass no bridge, so the
  // payload path never touches the network.
  if (typeof options.authorBridge === 'function') {
    try {
      const pass = options.authorBridge(authorEntries, {
        persisted: persistedAuthors,
        groups: authorMerge.groups,
      });
      if (pass && typeof pass.catch === 'function') pass.catch(() => {});
    } catch (err) {
      // A bridge must never break the payload.
    }
  }

  const finishedEvents = events.filter((event) => event.finishedAt);
  // Month-only events (LiveLib records an exact day for ~28% of a long
  // history; the rest carry `{year, month}`). They are NOT calendar days —
  // inventing a day would corrupt streaks — but they are not "undated" either:
  // they enter the month timeline and the coverage counters.
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
