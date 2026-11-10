'use strict';

/**
 * Event preparation of the books stats payload: status/shelf filters, the work
 * identity of one profile record, the «Читаю сейчас» strip, collection/segment
 * expansion, per-book re-read grouping and the per-shelf counts.
 *
 * R12 «god module» split: this is the block `books/stats.js` used to hold
 * inline, moved here without a behavioural change. The orchestrator re-exports
 * the public names, so the module surface does not move.
 */

const bookCache = require('../book-cache');
const {
  expansionBlocked,
  hasCollectionSegments,
  segmentEventsOf,
  segmentConfidenceOf,
} = require('../segments');
const {
  HARDCOVER_PROFILE_STATUS_IDS,
  HARDCOVER_PROFILE_STATUS_LABELS,
  SHELF_LABELS,
  READ_SHELF_LABELS,
} = require('./constants');

/* ------------------------------------------------------------------ */
/* Event preparation                                                   */
/* ------------------------------------------------------------------ */

function ratingOf(event) {
  if (event.rating10 != null && Number.isFinite(Number(event.rating10))) {
    return Number(event.rating10);
  }
  if (event.rating != null && Number.isFinite(Number(event.rating))) {
    const scale = Number(event.ratingScale) || 10;
    return Math.round((Number(event.rating) * 10) / scale);
  }
  return null;
}

function laterDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a >= b ? a : b;
}

function statusIdOf(event) {
  if (!event || event.statusId == null || event.statusId === '') return null;
  const value = Number(event.statusId);
  return Number.isFinite(value) ? value : null;
}

/**
 * Status filter at the aggregation level. Imports made before the import-time
 * filter (commit ca6efc1) persisted wish/reading/paused events; counting them
 * inflated bookCount/series/timeline (Dresden Files showed 17 instead of 9).
 *
 * Priority:
 *   1. `statusId` (new profiles) — keep only 3/5;
 *   2. legacy profiles without `statusId` — fall back to the `status` label
 *      ('read'/'dnf'), so old stale events are dropped without waiting for a
 *      re-import;
 *   3. neither key — keep (unknown schema must not hide data).
 */
function keepHardcoverProfileEvent(event) {
  const statusId = statusIdOf(event);
  if (statusId != null) return HARDCOVER_PROFILE_STATUS_IDS.includes(statusId);
  const label = String((event && event.status) || '').trim().toLowerCase();
  if (!label) return true;
  return HARDCOVER_PROFILE_STATUS_LABELS.includes(label);
}

/**
 * Does this raw event carry a shelf (`read`/`dnf`/`reading`/`wish`)?
 *
 * File imports (`livelib-file`) keep the shelf the user exported: «Прочитал»
 * and «Не дочитал» are reading history, «Читаю сейчас»/«Хочу прочитать» are
 * plans and never join the read statistics. Scraped LiveLib events have no
 * shelf at all (the source only exposes the "read" collection), so they are
 * never filtered — that is why the filter key is the event, not the source.
 */

function shelfOfEvent(event) {
  const shelf = String((event && event.shelf) || '').trim().toLowerCase();
  return SHELF_LABELS.includes(shelf) ? shelf : null;
}

/** Keep only reading-history shelves (read/dnf); plans are not statistics. */
function keepShelfProfileEvent(event) {
  const shelf = shelfOfEvent(event);
  if (!shelf) return true;
  return READ_SHELF_LABELS.includes(shelf);
}

function emptyStatusFilter() {
  return { excluded: 0, byStatus: {}, missingStatusId: 0, shelfExcluded: 0, byShelf: {} };
}

function recordStatusExclusion(filter, event) {
  const statusId = statusIdOf(event);
  const label = String((event && event.status) || 'unknown');
  const key = statusId != null ? `${statusId}:${label}` : `legacy:${label}`;
  filter.excluded++;
  filter.byStatus[key] = (filter.byStatus[key] || 0) + 1;
  if (statusId == null) filter.missingStatusId++;
}

/**
 * Resolve-cache key of a profile event. Must stay identical to `eventKeyOf` in
 * resolve.js: the chain writes `links/<key>.json`, the payload reads it back.
 *
 * A `livelib-backup` file row may have no «Ссылка на книгу» column at all, so
 * its `sourceBookId` is null. Keying such a row by `fileKey` (`file:tk:<sha1>`)
 * keeps it addressable; keying it by the empty string would make every such row
 * share one work (`ll:`) and collapse the whole profile into a single book.
 */
function eventLinkKeyOf(event) {
  if (!event) return null;
  if (event.sourceBookId) return String(event.sourceBookId);
  if (event.fileKey) return `file:${String(event.fileKey)}`;
  return null;
}

/**
 * Work identity of one raw profile event. Shared by the reading-history path
 * and by the «Читаю сейчас» path, so a currently-read book gets exactly the
 * same `workId` it would get as a finished event.
 */
function profileEventIdentity(raw, source) {
  const sourceBookId = String(raw.sourceBookId || '');
  const linkKey = eventLinkKeyOf(raw);
  const cachedLink = !raw.workId && source === 'livelib' && linkKey
    ? bookCache.getLink(linkKey)
    : null;
  // `metadataWorkId` is the canonical (Hardcover/Литрес/GB/OL) work used
  // for metadata only. It must never decide *how many books* the profile
  // has: LiveLib records volumes under one work page, and the user's verdict
  // is one export row = one book. `workId` below stays the per-record book
  // identity; a later pass suffixes the volumes that share a work.
  const rawWorkId = raw.workId == null ? null : String(raw.workId);
  let metadataWorkId = rawWorkId && !rawWorkId.startsWith('ll:') ? rawWorkId : null;
  if (!metadataWorkId && cachedLink && cachedLink.workId) {
    metadataWorkId = String(cachedLink.workId);
  }
  let workId = metadataWorkId;
  if (!workId) {
    // File rows without a link column have no numeric id: the synthetic
    // `file:tk:…` key is their identity (see eventLinkKeyOf).
    const fallback = sourceBookId || linkKey || String(raw.id || 'unknown');
    workId = `${source === 'hardcover' ? 'hc' : 'll'}:${fallback}`;
  }
  return { sourceBookId, linkKey, metadataWorkId, workId, resolved: Boolean(metadataWorkId) };
}

/**
 * Is this raw event the «Читаю сейчас» shelf state?
 *
 * Hardcover: `statusId` wins (2 = reading), legacy profiles fall back to the
 * label. File imports: the shelf is authoritative; a hand-edited row may only
 * carry the `reading` status label.
 */
function isReadingNowEvent(raw, source) {
  const statusId = statusIdOf(raw);
  const label = String((raw && raw.status) || '').trim().toLowerCase();
  if (source === 'hardcover') {
    return statusId != null ? statusId === 2 : label === 'reading';
  }
  if (shelfOfEvent(raw) === 'reading') return true;
  return !shelfOfEvent(raw) && label === 'reading';
}

/**
 * Does the payload accept `medium`-confidence segment links?
 *
 * The migration default is `high` only (`--include-medium` opts in); here the
 * same rule is an env/option switch so the default payload never promotes a
 * fuzzy title+author guess into a work.
 */
function segmentMediumEnabled(options) {
  if (options && options.includeMediumSegments === true) return true;
  const raw = String(process.env.KINOBOXD_SEGMENTS_INCLUDE_MEDIUM || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** Attach workId / reread flags to raw profile events. */
function prepareEvents(profiles, options = {}) {
  const events = [];
  // «Читаю сейчас»: stored in the profile but never in the finished-book
  // aggregates. Kept as a separate list so the strip and `readingNowCount` can
  // show it without touching bookCount/years/authors/timeline.
  const readingEvents = [];
  // Works of collection rows (СБОРНИКИ-ЭВРИСТИКА §5): one synthetic event per
  // work, the parent record stays the host row. `collectionHostIds` names the
  // parents that must NOT be counted as a book of their own.
  const segmentEvents = [];
  const collectionHostIds = new Set();
  const collections = new Map();
  const collectionsBlocked = [];
  const includeMediumSegments = segmentMediumEnabled(options);
  const statusFilter = emptyStatusFilter();
  const profileStatus = new Map();
  for (const profile of profiles) {
    const source = profile.source;
    const userKey = profile.userKey;
    const yearOverrides = options.yearOverrides
      || (source === 'livelib' ? bookCache.getYearOverrides(source, userKey) : {});
    const profileAudit = { kept: 0, excluded: 0, missingStatusId: 0 };
    profileStatus.set(`${source}:${userKey}`, profileAudit);
    for (const raw of profile.events) {
      if (!raw) continue;
      const legacyStatus = statusIdOf(raw) == null;
      const readingNow = isReadingNowEvent(raw, source);
      if (readingNow) {
        const identity = profileEventIdentity(raw, source);
        readingEvents.push({
          ...raw,
          source,
          userKey: profile.userKey,
          ...identity,
          rating10: ratingOf(raw),
          startedAt: raw.startedAt || null,
          startMonth: raw.startMonth || null,
          // A stale persisted row may carry a fake finish date; a book being
          // read now is never finished, so the strip never treats it as one.
          finishedAt: null,
        });
      }
      if (source === 'hardcover' && !keepHardcoverProfileEvent(raw)) {
        recordStatusExclusion(statusFilter, raw);
        profileAudit.excluded++;
        if (legacyStatus) profileAudit.missingStatusId++;
        continue;
      }
      // File import: «Читаю сейчас» / «Хочу прочитать» are plans, not history.
      // The events stay in the profile file (the strip reads `reading`, the
      // watchlist is still future work) but never reach bookCount/genres.
      if (!keepShelfProfileEvent(raw)) {
        const shelf = shelfOfEvent(raw);
        statusFilter.excluded++;
        statusFilter.shelfExcluded++;
        statusFilter.byShelf[shelf || 'unknown'] = (statusFilter.byShelf[shelf || 'unknown'] || 0) + 1;
        profileAudit.excluded++;
        profileAudit.shelfExcluded = (profileAudit.shelfExcluded || 0) + 1;
        continue;
      }
      if (legacyStatus && source === 'hardcover') profileAudit.missingStatusId++;
      profileAudit.kept++;
      const identity = profileEventIdentity(raw, source);
      const event = {
        ...raw,
        source,
        userKey: profile.userKey,
        workId: identity.workId,
        metadataWorkId: identity.metadataWorkId,
        // `resolved` here means "points at a canonical (non-LiveLib-stub) work";
        // metadata may also come from a LiveLib card, which is checked later.
        resolved: identity.resolved,
        rating10: ratingOf(raw),
        finishedAt: raw.finishedAt || null,
        reread: Boolean(raw.reread),
        readIndex: Number(raw.readIndex) || 1,
      };
      events.push(event);

      // Collection expansion: the record is a host row for N works, not a book
      // of its own. A row that was already decided as one book (a resolve link,
      // an enrichment document, a manual year edit) is never re-opened (§6).
      if (!hasCollectionSegments(raw)) continue;
      const parentLink = identity.linkKey ? bookCache.getLink(identity.linkKey) : null;
      const parentDetails = identity.linkKey
        ? bookCache.getWorkDetails(`ll:${identity.linkKey}`)
        : null;
      if (expansionBlocked(raw, { link: parentLink, details: parentDetails, yearOverrides })) {
        collectionsBlocked.push({
          id: event.id,
          title: raw.title || null,
          reason: parentLink && parentLink.workId
            ? 'linked'
            : parentDetails
              ? 'details'
              : 'manual_year',
        });
        continue;
      }
      const segments = [];
      for (const segRaw of segmentEventsOf({ ...raw, workId: identity.workId })) {
        const segLinkKey = segRaw.fileKey ? `file:${segRaw.fileKey}` : null;
        const link = segLinkKey ? bookCache.getLink(segLinkKey) : null;
        const confidence = link && link.workId ? segmentConfidenceOf(link.score) : null;
        const accepted = Boolean(link && link.workId)
          && (confidence === 'high' || (confidence === 'medium' && includeMediumSegments));
        const segIdentity = profileEventIdentity(segRaw, source);
        const segmentEvent = {
          ...segRaw,
          source,
          userKey: profile.userKey,
          workId: segIdentity.workId,
          metadataWorkId: accepted ? segIdentity.metadataWorkId : null,
          resolved: accepted,
          rating10: null,
          reread: false,
          readIndex: 1,
          segmentConfidence: confidence,
          segmentAccepted: accepted,
        };
        segmentEvents.push(segmentEvent);
        segments.push({
          workId: segmentEvent.workId,
          title: segRaw.title,
          key: segRaw.segmentKey,
          accepted,
          confidence,
          linkWorkId: accepted ? segIdentity.metadataWorkId : null,
        });
      }
      collectionHostIds.add(event.id);
      collections.set(event.id, {
        parentId: event.id,
        parentWorkId: identity.workId,
        parentTitle: raw.title || null,
        catalogSeries: raw.catalogSeries || null,
        segments,
      });
    }
  }

  // One LiveLib export row = one book/volume (user verdict, 28.10.2026). Rows
  // that resolve to the same canonical work (all volumes of one manga under a
  // `/work/…` page) must not collapse into one book: the first keeps the
  // canonical id, the rest get a `#n` suffix, while `metadataWorkId` stays
  // shared so metadata/enrichment is not duplicated. Hardcover is different:
  // its repeated `workId` are re-reads of the same book and must stay one work.
  const liveLibWorkCounts = new Map();
  for (const event of events) {
    if (event.source !== 'livelib') continue;
    const base = String(event.workId);
    const count = (liveLibWorkCounts.get(base) || 0) + 1;
    liveLibWorkCounts.set(base, count);
    if (count > 1) event.workId = `${base}#${count}`;
  }

  // Re-read flags per (source, user_book/edition): extras beyond the first.
  // LiveLib has no re-read phenomenon (user verdict, 28.10.2026): every export
  // row is its own book, and linkless rows share `sourceBookId: null` — grouping
  // them would mark hundreds of unrelated books as re-reads.
  const groups = new Map();
  for (const event of events) {
    if (event.source === 'livelib') {
      event.reread = false;
      event.readIndex = 1;
      continue;
    }
    const key = `${event.source}:${event.userKey}:${event.sourceBookId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const reReadCounts = new Map();
  for (const [key, group] of groups) {
    group.sort((a, b) => {
      const left = a.finishedAt || '';
      const right = b.finishedAt || '';
      if (left === right) return String(a.id) < String(b.id) ? -1 : 1;
      return left < right ? -1 : 1;
    });
    group.forEach((event, index) => {
      event.groupIndex = index + 1;
      event.reread = event.reread || index > 0;
      event.readIndex = Math.max(event.readIndex || 1, index + 1);
    });
    const explicit = group.reduce(
      (max, event) => Math.max(max, Number(event.readCount) || 0),
      0
    );
    reReadCounts.set(key, Math.max(group.length - 1, explicit - 1, 0));
  }

  return {
    events,
    readingEvents,
    segmentEvents,
    collectionHostIds,
    collections,
    collectionsBlocked,
    includeMediumSegments,
    reReadCounts,
    statusFilter,
    profileStatus,
  };
}

/** Per-shelf counts of a profile document (read/dnf/reading/wish). */
function profileShelfCounts(events) {
  const counts = { read: 0, dnf: 0, reading: 0, wish: 0 };
  const list = Array.isArray(events) ? events : [];
  for (const event of list) {
    if (!event) continue;
    const shelf = shelfOfEvent(event);
    if (shelf) counts[shelf]++;
    else counts.read++;
  }
  return counts;
}

module.exports = {
  keepHardcoverProfileEvent,
  keepShelfProfileEvent,
  shelfOfEvent,
  eventLinkKeyOf,
  prepareEvents,
  profileShelfCounts,
};
