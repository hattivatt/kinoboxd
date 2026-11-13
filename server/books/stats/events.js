'use strict';

const bookCache = require('../book-cache');
const { liveLibMetadata } = require('../year-only');
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

function keepHardcoverProfileEvent(event) {
  const statusId = statusIdOf(event);
  if (statusId != null) return HARDCOVER_PROFILE_STATUS_IDS.includes(statusId);
  const label = String((event && event.status) || '').trim().toLowerCase();
  if (!label) return true;
  return HARDCOVER_PROFILE_STATUS_LABELS.includes(label);
}

function shelfOfEvent(event) {
  const shelf = String((event && event.shelf) || '').trim().toLowerCase();
  return SHELF_LABELS.includes(shelf) ? shelf : null;
}

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

function eventLinkKeyOf(event) {
  if (!event) return null;
  if (event.sourceBookId) return String(event.sourceBookId);
  if (event.fileKey) return `file:${String(event.fileKey)}`;
  return null;
}

function profileEventIdentity(raw, source) {
  const sourceBookId = String(raw.sourceBookId || '');
  const linkKey = eventLinkKeyOf(raw);
  const cachedLink = !raw.workId && source === 'livelib' && linkKey
    ? bookCache.getLink(linkKey)
    : null;
  const rawWorkId = raw.workId == null ? null : String(raw.workId);
  let metadataWorkId = rawWorkId && !rawWorkId.startsWith('ll:') ? rawWorkId : null;
  if (!metadataWorkId && cachedLink && cachedLink.workId) {
    metadataWorkId = String(cachedLink.workId);
  }
  let workId = metadataWorkId;
  if (!workId) {
    const fallback = sourceBookId || linkKey || String(raw.id || 'unknown');
    workId = `${source === 'hardcover' ? 'hc' : 'll'}:${fallback}`;
  }
  return { sourceBookId, linkKey, metadataWorkId, workId, resolved: Boolean(metadataWorkId) };
}

function isReadingNowEvent(raw, source) {
  const statusId = statusIdOf(raw);
  const label = String((raw && raw.status) || '').trim().toLowerCase();
  if (source === 'hardcover') {
    return statusId != null ? statusId === 2 : label === 'reading';
  }
  if (shelfOfEvent(raw) === 'reading') return true;
  return !shelfOfEvent(raw) && label === 'reading';
}

function segmentMediumEnabled(options) {
  if (options && options.includeMediumSegments === true) return true;
  const raw = String(process.env.KINOBOXD_SEGMENTS_INCLUDE_MEDIUM || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function prepareEvents(profiles, options = {}) {
  const events = [];
  const readingEvents = [];
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
          finishedAt: null,
        });
      }
      if (source === 'hardcover' && !keepHardcoverProfileEvent(raw)) {
        recordStatusExclusion(statusFilter, raw);
        profileAudit.excluded++;
        if (legacyStatus) profileAudit.missingStatusId++;
        continue;
      }
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
        resolved: identity.resolved,
        rating10: ratingOf(raw),
        finishedAt: raw.finishedAt || null,
        reread: Boolean(raw.reread),
        readIndex: Number(raw.readIndex) || 1,
      };
      events.push(event);

      if (!hasCollectionSegments(raw)) continue;
      const parentLink = identity.linkKey ? bookCache.getLink(identity.linkKey) : null;
      const parentDetails = identity.linkKey
        ? liveLibMetadata(bookCache.getWorkDetails(`ll:${identity.linkKey}`))
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

  const liveLibWorkCounts = new Map();
  for (const event of events) {
    if (event.source !== 'livelib') continue;
    const base = String(event.workId);
    const count = (liveLibWorkCounts.get(base) || 0) + 1;
    liveLibWorkCounts.set(base, count);
    if (count > 1) event.workId = `${base}#${count}`;
  }

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
