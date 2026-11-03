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

const bookCache = require('./book-cache');
const authors = require('./authors');
const { filterBlacklistedSeries } = require('./series-blacklist');
const { surnameOf } = require('./normalize');
const { detectManga } = require('./providers/manga');
const {
  expansionBlocked,
  hasCollectionSegments,
  segmentEventsOf,
  segmentConfidenceOf,
} = require('./segments');

const {
  round2,
  mean,
  dayNumber,
  computeStreaks,
  saneYear,
} = require('./stats/numeric');
const {
  FILE_METADATA_SOURCE,
  ANCIENT_BEFORE_YEAR,
  ANCIENT_BUCKET_KEY,
  PAGE_BUCKETS,
  HARDCOVER_PROFILE_STATUS_IDS,
  HARDCOVER_PROFILE_STATUS_LABELS,
  SHELF_LABELS,
  READ_SHELF_LABELS,
} = require('./stats/constants');
const { buildContext } = require('./stats/context');
const { buildSummary } = require('./stats/summary');
const {
  buildRatings,
  buildGenres,
  buildYearBuckets,
  buildAuthors,
  buildSeries,
  buildPublishers,
  buildPagesHistogram,
} = require('./stats/widgets');
const { buildTimeline, buildRecentlyFinished, buildRecentlyReading } = require('./stats/timeline');
const { buildBooksIndex, buildUnmatched } = require('./stats/books-index');
const { buildMeta } = require('./stats/meta');

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

/** Sources that can hold a profile document (`profiles/{source}-{userKey}`). */
const PROFILE_SOURCES = ['livelib', 'hardcover'];

/** Connected sources = profiles present on disk. */
function connectedProfiles() {
  return bookCache.listProfiles();
}

/** Canonical profile key, the same token `?profile=` accepts. */
function profileKeyOf(profile) {
  return `${profile.source}-${profile.userKey}`;
}

/**
 * Parse `?profile=` — exactly ONE `source-userKey` token naming a profile
 * document (`cache-book/profiles/{source}-{userKey}.json`).
 *
 * There is no second separator on purpose: the first `-` after the source is
 * the boundary, so a LiveLib username with dashes (`my-reader`) stays intact.
 * The userKey grammar matches what the importers accept (letters, digits,
 * `_`, `.`, `-`), so no token can address a file outside profiles/.
 *
 * A repeated parameter (`?profile=a&profile=b`) or a CSV (`?profile=a,b`) is
 * reported as `multi` — the caller answers 400 instead of picking one.
 */
function parseProfileParam(raw) {
  const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const present = raw != null;
  const tokens = [];
  const malformed = [];
  let parts = 0;
  for (const value of values) {
    for (const part of String(value).split(',')) {
      const token = part.trim();
      if (!token) continue;
      parts++;
      const match = /^(livelib|hardcover)-(.+)$/i.exec(token);
      const userKey = match ? match[2].trim() : '';
      if (!match || !/^[\w.-]{1,120}$/.test(userKey)) {
        malformed.push(token);
        continue;
      }
      tokens.push({ token, source: match[1].toLowerCase(), userKey });
    }
  }
  // The contract is exactly one token. `?profile=a&profile=` is still one;
  // `?profile=a,b` and `?profile=a&profile=b` are multi and get a 400.
  const multi = parts > 1;
  return { present, tokens, malformed, multi, empty: present && parts === 0 };
}

/**
 * Resolve the single `?profile=` token against the profiles on disk.
 *
 * Matching is case-insensitive (a client may lower-case the token) but the
 * result always carries the canonical `userKey` from the file, and a token
 * that names no cached profile is reported as `unknown` instead of silently
 * widening the selection — that is what keeps the scope honest.
 *
 * `explicit` is true whenever the parameter was present at all (including an
 * empty `?profile=`), so the caller can distinguish "no scope asked" from
 * "scope asked but resolved to nothing" (the latter is a 400 at the route).
 */
function resolveProfileScope(raw, profilesIn) {
  const profiles = Array.isArray(profilesIn) ? profilesIn : connectedProfiles();
  const available = profiles.map((profile) => ({
    key: profileKeyOf(profile),
    source: profile.source,
    userKey: profile.userKey,
  }));
  const parsed = parseProfileParam(raw);
  const base = {
    explicit: parsed.present,
    multi: parsed.multi,
    empty: parsed.empty,
    requested: parsed.tokens.map((entry) => entry.token),
    selected: [],
    unknown: [],
    malformed: parsed.malformed,
    profiles,
    availableProfileKeys: available.map((entry) => entry.key),
  };
  if (!parsed.present) return base;
  if (parsed.multi) return base;
  const byLowerKey = new Map(available.map((entry) => [entry.key.toLowerCase(), entry]));
  const unknown = [];
  for (const { token, source, userKey } of parsed.tokens) {
    const hit = byLowerKey.get(`${source}-${userKey}`.toLowerCase());
    if (!hit) {
      unknown.push(token);
      continue;
    }
    base.selected.push(hit);
  }
  base.unknown = unknown;
  return base;
}

/**
 * Load the one profile that feeds the aggregation.
 *
 * No parameter at all means "no profile": the caller (route) answers 400
 * before this point, internal callers get an empty scope.
 */
function selectProfiles(profileScope) {
  const scope = profileScope || resolveProfileScope(undefined);
  const profiles = scope.profiles;
  const connected = [...new Set(profiles.map((profile) => profile.source))];
  const allProfileKeys = profiles.map(profileKeyOf);
  const chosenMeta = scope.selected.length ? scope.selected : [];

  const loaded = [];
  for (const meta of chosenMeta) {
    const data = bookCache.getProfile(meta.source, meta.userKey);
    if (data && Array.isArray(data.events)) loaded.push(data);
  }
  const selected = [...new Set(chosenMeta.map((entry) => entry.source))];
  return {
    connected,
    selected,
    profiles: loaded,
    mode: chosenMeta.length ? 'profile' : 'none',
    requestedProfiles: scope.requested,
    selectedProfileKeys: chosenMeta.map(profileKeyOf),
    allProfileKeys,
  };
}

/**
 * A work's *first publication* year may be ancient («Искусство войны» is
 * ~5th century BC). It is kept in the payload and bucketed as «до 1000 г.»
 * instead of being filtered out like a bad edition year.
 */
function saneFirstYear(value) {
  if (value == null || value === '') return null;
  const year = Number(value);
  if (!Number.isFinite(year)) return null;
  return year >= -3000 && year <= 2100 ? Math.trunc(year) : null;
}

/* ------------------------------------------------------------------ */
/* Work aggregation                                                    */
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

function detailsAuthors(details) {
  if (!details || !Array.isArray(details.authors)) return [];
  const names = [];
  for (const author of details.authors) {
    const name = author && typeof author === 'object' ? author.name : author;
    if (name && !names.includes(String(name))) names.push(String(name));
  }
  return names;
}

function detailsSeries(details) {
  if (!details || !Array.isArray(details.series)) return [];
  const out = [];
  for (const entry of details.series) {
    if (!entry) continue;
    if (typeof entry === 'string') {
      if (entry.trim()) out.push({ hcId: null, name: entry.trim(), position: null });
      continue;
    }
    if (entry.name) {
      out.push({
        hcId: entry.hcId == null ? null : entry.hcId,
        name: entry.name,
        position: entry.position == null ? null : entry.position,
        ...(entry.source ? { source: String(entry.source) } : {}),
      });
    }
  }
  return out;
}

function metadataSourcesOf(details) {
  if (!details) return [];
  if (Array.isArray(details.metadataSources) && details.metadataSources.length) {
    return [...new Set(details.metadataSources.filter(Boolean))];
  }
  if (Array.isArray(details.sources) && details.sources.length) {
    return [...new Set(details.sources.map((entry) => entry && entry.source).filter(Boolean))];
  }
  return details.hcWorkId != null ? ['hardcover'] : [];
}

/** Identity of a genre/series name for dedupe (case, «ё», punctuation). */
function nameKeyOf(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Union of the metadata chain's genres and the file columns' genres.
 *
 * They are not the same vocabulary: Литрес calls a book «Зарубежное фэнтези»,
 * the export says «фэнтези», Hardcover says «Fantasy». The previous rule
 * (`details.genres` wins, else file) silently dropped what the user's own
 * export said the moment the chain resolved the work. Union keeps both, deduped
 * by normalized name; the chain's labels come first, so a donut still has one
 * entry per concept when the labels match.
 */
function mergeGenreLists(primary, extra) {
  const out = [];
  const seen = new Set();
  for (const list of [primary, extra]) {
    for (const name of Array.isArray(list) ? list : []) {
      const clean = String(name == null ? '' : name).trim();
      const key = nameKeyOf(clean);
      if (!clean || !key || seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
    }
  }
  return out;
}

/**
 * Union of series entries: the chain knows ids/positions, the file knows the
 * RU series label (`edition.series`). Same name → the richer entry (one with a
 * position/hcId) wins; a file-only name is kept as a positionless entry.
 */
function mergeSeriesLists(primary, extra) {
  const out = [];
  const index = new Map();
  for (const entry of Array.isArray(primary) ? primary : []) {
    if (!entry || !entry.name) continue;
    const key = nameKeyOf(entry.name);
    if (!key || index.has(key)) continue;
    index.set(key, out.length);
    out.push({ ...entry });
  }
  for (const entry of Array.isArray(extra) ? extra : []) {
    if (!entry || !entry.name) continue;
    const key = nameKeyOf(entry.name);
    if (!key) continue;
    if (index.has(key)) {
      const current = out[index.get(key)];
      if (current.position == null && entry.position != null) current.position = entry.position;
      if (current.hcId == null && entry.hcId != null) current.hcId = entry.hcId;
      continue;
    }
    index.set(key, out.length);
    out.push({ ...entry });
  }
  return out;
}

/**
 * Effective manga/comics flag for one work.
 *
 * The detector is re-run on every read over the full persisted corpus
 * (`mangaTexts`, `tags`) instead of trusting a stale `details.mangaComics`
 * boolean: a cache written before the detector learned new keywords/publishers
 * must start filtering without a full re-import. The stored boolean stays as an
 * additive `true` (a provider may have known a signal we cannot reconstruct)
 * and as the fallback when the current corpus has no classification fields.
 *
 * `fileMeta` (§3.3.2) is a second, independent signal source. A
 * `livelib-backup` file export carries «Жанры»/«Серия»/«Издатель» on the event
 * itself; without it a file-imported profile has no details document at all,
 * so the flag used to be `null` and manga/comics leaked into the statistics.
 * Both corpora are consulted (details *and* file) and `true` wins, because a
 * provider tag on one volume is as valid as a file genre on another: the
 * detector is deliberately greedy and the user can always restore a work with
 * a manual `false` (§5, `POST /api/books/work/flag`).
 */
function mangaOfDetails(details, genres, series, publisher, fileMeta) {
  const sources = [{
    genres,
    tags: details && Array.isArray(details.tags) ? details.tags : [],
    texts: details && Array.isArray(details.mangaTexts) ? details.mangaTexts : [],
    series,
    publisher,
  }];
  if (fileMeta && fileMeta.present) {
    sources.push({
      genres: fileMeta.genres,
      series: fileMeta.series.map((entry) => entry.name),
      publisher: fileMeta.publisher,
    });
  }

  let clean = false;
  for (const input of sources) {
    const detected = detectManga(input);
    if (detected === true) return true;
    if (detected === false) clean = true;
  }
  // A stored provider `true` is additive: it survives a clean re-detection.
  if (details && details.mangaComics === true) return true;
  if (clean) return false;
  return details && typeof details.mangaComics === 'boolean' ? details.mangaComics : null;
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

/**
 * Metadata carried by `livelib-backup` file events themselves.
 *
 * The export can include «Жанры», «Издатель», «Дата издания», «Язык»,
 * «Серия», «ISBN» — the same fields the resolve chain would fetch. When they
 * are present they are used directly: a file-imported profile renders genres,
 * series and publishers without a single network request (the point of the
 * safe path). When the chain resolves a work too, the two corpora are unioned
 * (`mergeGenreLists`/`mergeSeriesLists`) and `metadataSources` lists both.
 *
 * Two flags, because "the file was parsed" and "the file says something about
 * this book" are different questions:
 *   - `present` — at least one bibliographic value was extracted (genres,
 *     series, publisher, year, ISBN or language); it drives
 *     `metadataSources: ['livelib-file']`;
 *   - `coverage` — the fields the «Метадата: N%» badge speaks about
 *     (genres, series, year — exactly what its hint lists). A minimal export
 *     (title + date only, or a publisher column without genres) leaves the
 *     profile genuinely unenriched, so it must count as unresolved instead of
 *     pretending to be 100% covered.
 */
function fileMetadataOf(events) {
  const empty = {
    present: false,
    coverage: false,
    genres: [],
    series: [],
    publisher: null,
    year: null,
    isbn13: null,
    isbn10: null,
    language: null,
  };
  const rows = (events || []).filter((event) => event && event.origin === FILE_METADATA_SOURCE);
  if (!rows.length) return empty;

  const genres = [];
  const series = [];
  let publisher = null;
  let year = null;
  let isbn13 = null;
  let isbn10 = null;
  let language = null;
  for (const event of rows) {
    for (const name of Array.isArray(event.genres) ? event.genres : []) {
      const clean = String(name || '').trim();
      if (clean && !genres.includes(clean)) genres.push(clean);
    }
    const edition = event.edition && typeof event.edition === 'object' ? event.edition : {};
    const seriesName = String(edition.series || '').trim();
    if (seriesName && !series.some((entry) => entry.name === seriesName)) {
      series.push({ hcId: null, name: seriesName, position: null });
    }
    const publisherName = String(edition.publisher || '').trim();
    if (!publisher && publisherName) publisher = publisherName;
    if (year == null) year = saneYear(edition.year);
    if (!isbn13 && edition.isbn13) isbn13 = String(edition.isbn13);
    if (!isbn13 && edition.isbn) isbn13 = String(edition.isbn);
    if (!isbn10 && edition.isbn10) isbn10 = String(edition.isbn10);
    if (!language && edition.language) language = String(edition.language);
  }
  const coverage = genres.length > 0 || series.length > 0 || year != null;
  const present =
    coverage || Boolean(publisher) || Boolean(isbn13) || Boolean(isbn10) || Boolean(language);
  return { present, coverage, genres, series, publisher, year, isbn13, isbn10, language };
}

/**
 * Series entries of a details document, with the Литрес pseudo-series trap
 * removed (§7.4, 28.10.2026).
 *
 * Литрес exposes its catalogue tags in the same `series` array as a real
 * literary series: «Книга на все времена», «Азбука-классика» are shelves, not
 * series. A real series carries a volume order (`art_order` ≥ 1); a positionless
 * Литрес entry is kept only when the user's own export names the same series
 * (the file column is the authority). Hardcover/LiveLib-card series are never
 * filtered by this rule.
 */
function filterDetailsSeries(details, fileSeriesNames) {
  const list = detailsSeries(details);
  const sourceNames = metadataSourcesOf(details);
  const litresOnly = sourceNames.length === 1 && sourceNames[0] === 'litres';
  const fileKeys = new Set(
    (Array.isArray(fileSeriesNames) ? fileSeriesNames : [])
      .map((name) => nameKeyOf(name))
      .filter(Boolean)
  );
  return list.filter((entry) => {
    const fromLitres = entry.source === 'litres' || (entry.source == null && litresOnly);
    if (!fromLitres) return true;
    const position = Number(entry.position);
    if (Number.isFinite(position) && position >= 1) return true;
    return fileKeys.has(nameKeyOf(entry.name));
  });
}

/**
 * First publication year of the *work* — when a provider actually knows it.
 *
 * `details.firstPublishedYear` is the single source of truth for the work's
 * first publication: Hardcover `book.release_year`, Open Library
 * `first_publish_year` (only when the record has more than one edition),
 * Литрес «дата написания». It is preferred over an edition year, but since the
 * 29.10.2026 verdict it is no longer the only source: `resolveWorkYear` falls
 * back to the print run (`editionYear`) with an honest `yearSource: 'edition'`
 * mark, and a manual correction outranks both. A work with neither lands in
 * the honest «год неизвестен» bucket (`decades[]` with `unknown: true`).
 *
 * Ancient years are valid here (Сунь Цзы, ~V century BC).
 */
function firstPublishedYearOf(details) {
  return saneFirstYear(details && details.firstPublishedYear);
}

/**
 * The print run in hand — the «год издания» of the copy the reader actually
 * holds, i.e. the legacy year channel of the pre-ef593a8 chart.
 *
 * Two sources, in this order:
 *   1. the export/event column (`edition.year` of a `livelib-file` row, the
 *      reader's own LiveLib card «Год издания») — the file column wins because
 *      it is the user's data, not a provider's guess;
 *   2. the details document's `publicationYear` — the print run the metadata
 *      provider knows (Литрес `publication_date`, an OL/HC edition record).
 *      Before ef593a8 this field went through `saneFirstYear`, so a reprint of
 *      an ancient text keeps its ancient year instead of vanishing from the
 *      chart; that bound is preserved here.
 *
 * `source` is echoed as `editionYearSource` so the payload/UI can say *which*
 * legacy channel answered instead of lumping them together.
 */
function editionYearOf(details, displayEvent, fileMeta) {
  const fromFile = saneYear(
    (displayEvent && displayEvent.edition && displayEvent.edition.year) || (fileMeta && fileMeta.year)
  );
  if (fromFile != null) return { year: fromFile, source: 'file' };
  const legacy = saneFirstYear(details && details.publicationYear);
  // There is no year zero; a 0 is a typo, not an ancient date.
  if (legacy != null && legacy !== 0) return { year: legacy, source: 'details' };
  return { year: null, source: null };
}

/**
 * Publication year of a work, with the user's priority (verdict 29.10.2026):
 *
 *   manual > firstPublishedYear > editionYear > unknown
 *
 * `firstPublishedYear` is still the preferred bibliographic claim (Hardcover
 * work release, Open Library `first_publish_year`, Литрес «дата написания»).
 * When no provider knows the work's first publication, the edition in hand is
 * an honest fallback: the chart shows the book under its print year and marks
 * it as such (`yearSource: 'edition'`) instead of hiding it in «год неизвестен».
 * The edition year is NEVER labelled as a first publication in the payload/UI.
 *
 * A manual correction is the user's word and outranks every provider. It lives
 * in `cache-book/year-overrides/<profile>.json` (book-cache.js) and survives
 * resolve/backfill/file re-import; `yearOverride` is echoed so the UI can offer
 * "reset".
 */
function saneManualYear(value) {
  const year = saneFirstYear(value);
  // There is no year zero; a 0 is a typo, not an ancient date.
  return year === 0 ? null : year;
}

function resolveWorkYear(details, displayEvent, fileMeta, override) {
  const firstPublishedYear = firstPublishedYearOf(details);
  const edition = editionYearOf(details, displayEvent, fileMeta);
  const editionYear = edition.year;
  const editionYearSource = edition.source;
  const manualYear = override ? saneManualYear(override.year) : null;
  const firstPublishedYearSource =
    details && details.firstPublishedYearSource ? String(details.firstPublishedYearSource) : null;
  if (manualYear != null) {
    return {
      year: manualYear,
      yearSource: 'manual',
      yearOverride: manualYear,
      firstPublishedYear,
      firstPublishedYearSource,
      editionYear,
      editionYearSource,
    };
  }
  if (firstPublishedYear != null) {
    return {
      year: firstPublishedYear,
      yearSource: 'first',
      yearOverride: null,
      firstPublishedYear,
      firstPublishedYearSource,
      editionYear,
      editionYearSource,
    };
  }
  if (editionYear != null) {
    return {
      year: editionYear,
      yearSource: 'edition',
      yearOverride: null,
      firstPublishedYear: null,
      firstPublishedYearSource,
      editionYear,
      editionYearSource,
    };
  }
  return {
    year: null,
    yearSource: null,
    yearOverride: null,
    firstPublishedYear: null,
    firstPublishedYearSource,
    editionYear: null,
    editionYearSource: null,
  };
}

/**
 * Stable keys a manual year override may be stored under. The client stores the
 * `workId` it saw; after a resolve that id can change
 * (`ll:file:tk:<sha1>` / `ll:<bookId>` -> `hc:<id>`). The event's own identity
 * is stable, so the override follows the work across the metadata chain.
 */
function yearOverrideKeysOf(workId, metadataWorkId, events) {
  const keys = [];
  const push = (value) => {
    const key = value == null ? '' : String(value);
    if (key && !keys.includes(key)) keys.push(key);
  };
  push(workId);
  push(metadataWorkId);
  for (const event of events || []) {
    if (!event) continue;
    if (event.sourceBookId) {
      push(`${event.source === 'hardcover' ? 'hc' : 'll'}:${event.sourceBookId}`);
    }
    const linkKey = eventLinkKeyOf(event);
    if (linkKey) {
      push(linkKey);
      push(`ll:${linkKey}`);
    }
  }
  return keys;
}

function findYearOverride(overrides, keys) {
  if (!overrides || typeof overrides !== 'object') return null;
  for (const key of keys) {
    const entry = overrides[key];
    if (entry && saneManualYear(entry.year) != null) return entry;
  }
  return null;
}

function workMetadata(workId, events, options = {}) {
  const hcEvents = events.filter((event) => event.source === 'hardcover');
  const llEvents = events.filter((event) => event.source === 'livelib');
  // Volumes of one work share `metadataWorkId`; the book identity `workId` may
  // carry a `#n` suffix that no details file knows about.
  const metadataWorkId = (events.find((event) => event.metadataWorkId) || {}).metadataWorkId || workId;
  const details = bookCache.getWorkDetails(metadataWorkId);
  // Bibliographic columns of a `livelib-backup` file export (genres,
  // publisher, series, language, ISBN) are already in the file, so a
  // file-imported profile does not have to wait for the metadata chain.
  const fileMeta = fileMetadataOf(events);

  const latest = (list, field) =>
    list.reduce((best, event) => laterDate(best, event[field]), null);

  // Hardcover priority for display fields; LiveLib is the fallback (§3.3.1).
  const hcWithRating = [...hcEvents]
    .filter((event) => event.rating10 != null)
    .sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')))[0];
  const llWithRating = [...llEvents]
    .filter((event) => event.rating10 != null)
    .sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')))[0];
  const displayEvent = hcWithRating || hcEvents[0] || llWithRating || llEvents[0] || null;

  const detailTitle = details && details.title ? details.title : null;
  const hcTitle = detailTitle || (hcEvents[0] && hcEvents[0].title) || null;
  const llTitle = (llEvents.find((event) => event.title) || {}).title || null;
  // A collection work remembers the record it came from, so the UI can say
  // «из сборника «X»» and link the parent page (СБОРНИКИ-ЭВРИСТИКА §5.1).
  const collection = (events.find((event) => event && event.collectionParent) || {}).collectionParent
    || null;

  const authors = [];
  const detailAuthors = detailsAuthors(details);
  if (detailAuthors.length) {
    for (const name of detailAuthors) authors.push(name);
  } else {
    for (const event of hcEvents.concat(llEvents)) {
      for (const name of event.authors || []) {
        if (name && !authors.includes(name)) authors.push(name);
      }
    }
  }

  const publisher =
    (details && details.publisher) ||
    (displayEvent && displayEvent.edition && displayEvent.edition.publisher) ||
    fileMeta.publisher ||
    null;
  const overrideKeys = yearOverrideKeysOf(workId, metadataWorkId, events);
  const yearOverride = findYearOverride(options.yearOverrides, overrideKeys);
  const yearInfo = resolveWorkYear(details, displayEvent, fileMeta, yearOverride);
  const year = yearInfo.year;
  const editionYear = yearInfo.editionYear;
  const editionYearSource = yearInfo.editionYearSource;
  const firstPublishedYear = yearInfo.firstPublishedYear;
  const firstPublishedYearSource = yearInfo.firstPublishedYearSource;
  const pages =
    details && details.pages != null && Number.isFinite(Number(details.pages)) && Number(details.pages) > 0
      ? Number(details.pages)
      : null;
  const genres = mergeGenreLists(
    details && Array.isArray(details.genres) ? details.genres : [],
    fileMeta.genres
  );
  const mergedSeries = mergeSeriesLists(
    filterDetailsSeries(details, fileMeta.series.map((entry) => entry.name)),
    fileMeta.series
  );
  // Catalogue tags («Книга на все времена») are not series (series-blacklist.js).
  // The filter runs on the merged list, *after* the file column has had its
  // say, so a tag that the user's own export carries is still dropped — and it
  // runs before counting/manga detection, so neither sees the tag.
  const seriesFilter = filterBlacklistedSeries(mergedSeries);
  const series = seriesFilter.list;
  const coverUrl =
    (details && details.coverUrl) ||
    (displayEvent && displayEvent.coverUrl) ||
    null;

  const finishDates = events.map((event) => event.finishedAt).filter(Boolean);
  const finishedDate = finishDates.length
    ? finishDates.sort()[finishDates.length - 1]
    : null;

  // Link menu (§6.3): LiveLib is derivable for every work with an LL event or
  // an LL link in links.json; provider page URLs come from the details doc.
  const links = {};
  const llSourceId = String(metadataWorkId).startsWith('ll:') ? String(metadataWorkId).slice(3) : null;
  // Only a real LiveLib book id makes a LiveLib URL; a file-keyed stub
  // (`ll:file:tk:<sha1>`) is an internal identity, not a page. A file row may
  // know its own id even when the resolve link is a HardCover work.
  const llBookId = (events.find((event) => event.sourceBookId) || {}).sourceBookId || llSourceId;
  if (llBookId && /^\d+$/.test(String(llBookId))) {
    links.livelib = `https://www.livelib.ru/book/${llBookId}`;
  }
  if (String(metadataWorkId).startsWith('hc:')) {
    const workLink = bookCache.getWorkLink(metadataWorkId);
    const llId = workLink && Array.isArray(workLink.livelib)
      ? workLink.livelib.map(String).find(Boolean)
      : null;
    if (llId && !links.livelib) links.livelib = `https://www.livelib.ru/book/${llId}`;
  }
  if (details) {
    const providerLinks = Array.isArray(details.sources) ? details.sources : [];
    for (const entry of providerLinks) {
      if (!entry || !entry.url) continue;
      const key = entry.source === 'livelib-card' ? 'livelib' : entry.source;
      if (!links[key]) links[key] = entry.url;
    }
    if (details.slug && !links.hardcover) {
      links.hardcover = `https://hardcover.app/books/${details.slug}`;
    }
  }

  const metadataSources = metadataSourcesOf(details);
  // Union, not either/or: a file-imported work keeps the «livelib-file»
  // provenance after the chain adds litres/hardcover — the file is still where
  // the event's own columns (genres/publisher/series) came from (§5).
  if (fileMeta.present && !metadataSources.includes(FILE_METADATA_SOURCE)) {
    metadataSources.push(FILE_METADATA_SOURCE);
  }

  return {
    workId,
    metadataWorkId,
    title: hcTitle || llTitle,
    titleRu: hcTitle && llTitle && hcTitle !== llTitle ? llTitle : hcTitle ? hcTitle : llTitle,
    authors,
    genres,
    series,
    seriesTagsFiltered: seriesFilter.removed,
    publisher,
    year: year == null ? null : Number(year),
    yearSource: yearInfo.yearSource,
    yearOverride: yearInfo.yearOverride,
    firstPublishedYear,
    firstPublishedYearSource,
    editionYear,
    editionYearSource,
    pages,
    coverUrl,
    isbn13: (details && details.isbn13) || fileMeta.isbn13 || null,
    isbn10: (details && details.isbn10) || fileMeta.isbn10 || null,
    language: (details && details.editionLanguage) || fileMeta.language || null,
    metadataSources,
    mangaComics: mangaOfDetails(details, genres, series, publisher, fileMeta),
    details,
    links,
    finishedDate,
    collection,
    // Option A: Hardcover priority, LiveLib fallback. With one profile this is
    // simply the rating of the profile's own event(s).
    rating10: hcWithRating ? hcWithRating.rating10 : llEvents.find((e) => e.rating10 != null)?.rating10 ?? null,
    sources: [...new Set(events.map((event) => event.source))].sort(),
    // "Unresolved" means "no bibliographic metadata at all": a details
    // document from the chain or the meaningful columns of a file export
    // (genres/series/publisher/year) both count. A file row carrying only a
    // title and a date is real reading history but not enrichment, so it stays
    // unresolved and the «Метадата: N%» badge keeps telling the truth.
    unresolved: !details && !fileMeta.coverage,
  };
}

/* ------------------------------------------------------------------ */
/* Payload                                                             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Cross-source work dedupe                                            */
/* ------------------------------------------------------------------ */

const SOURCE_PRIORITY = { hc: 4, lr: 3.5, gb: 3, ol: 2, ll: 1 };

function workPrefix(workId) {
  return String(workId || '').split(':')[0];
}

/**
 * Strict title key for work dedupe. Unlike the resolve matcher it keeps
 * volume/part numbers: "Наруто. Том 1" and "Наруто. Том 2" are different books
 * and must not collapse into one work in the widgets.
 */
function dedupeTitle(title) {
  return String(title == null ? '' : title)
    .replace(/\u00a0/g, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(
      /(?<![\p{L}])(?:vol(?:ume)?|том|книга|book|часть|кн)\s*\.?\s*(\d+)/giu,
      ' vol $1 '
    )
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stable dedupe key: normalized title + author surnames. LiveLib (RU title)
 * and Google Books (same RU edition) can otherwise produce two works for one
 * book, double-counting it in authors/genres widgets.
 */
function canonicalKeyOf(work) {
  const title = dedupeTitle(work.title || work.titleRu || '');
  const authors = [...new Set((work.authors || []).map((name) => surnameOf(name)).filter(Boolean))].sort();
  if (!title || authors.length === 0) return null;
  return `${title}|${authors.join(',')}`;
}

function unionBy(list, keyOf) {
  const seen = new Map();
  for (const entry of list) {
    if (!entry) continue;
    const key = keyOf(entry);
    if (key == null) continue;
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()];
}

function mergeWorkGroup(list) {
  const rank = (work) => (work.unresolved ? 0 : 10) + (SOURCE_PRIORITY[workPrefix(work.workId)] || 0);
  const ordered = [...list].sort((a, b) => {
    const delta = rank(b) - rank(a);
    if (delta !== 0) return delta;
    return String(a.workId) < String(b.workId) ? -1 : 1;
  });
  const primary = ordered[0];
  const pick = (field) => {
    for (const work of ordered) {
      if (work[field] != null && work[field] !== '') return work[field];
    }
    return null;
  };
  const titles = [...new Set(ordered.map((work) => work.title).filter(Boolean))];
  const authors = unionBy(ordered.flatMap((work) => work.authors || []), (name) => name);
  const genres = unionBy(ordered.flatMap((work) => work.genres || []), (name) => name);
  const series = unionBy(
    ordered.flatMap((work) => work.series || []),
    (entry) => `${entry.hcId == null ? '' : entry.hcId}|${entry.name || ''}`
  );
  const metadataSources = [
    ...new Set(ordered.flatMap((work) => work.metadataSources || [])),
  ];
  const links = {};
  for (const work of [...ordered].reverse()) Object.assign(links, work.links || {});
  const mangaValues = ordered.map((work) => work.mangaComics);
  const mangaComics = mangaValues.includes(true)
    ? true
    : mangaValues.includes(false)
    ? false
    : null;
  const finishedDates = ordered.map((work) => work.finishedDate).filter(Boolean).sort();
  // Year priority across merged ids: the user's correction, then the work's
  // first publication, then an edition fallback. A later provider claim must
  // not override an older honest one.
  const yearRank = { manual: 3, first: 2, edition: 1 };
  const yearWork = ordered
    .filter((work) => Number.isFinite(work.year))
    .sort((a, b) => (yearRank[b.yearSource] || 0) - (yearRank[a.yearSource] || 0))[0] || null;

  return {
    ...primary,
    workId: primary.workId,
    mergedWorkIds: ordered.map((work) => work.workId),
    title: pick('title'),
    titleRu: titles.find((title) => title !== primary.title) || primary.title || pick('titleRu'),
    authors,
    genres,
    series,
    publisher: pick('publisher'),
    year: yearWork ? yearWork.year : null,
    yearSource: yearWork ? yearWork.yearSource : null,
    yearOverride: yearWork ? yearWork.yearOverride : null,
    firstPublishedYear: yearWork ? yearWork.firstPublishedYear : null,
    firstPublishedYearSource: yearWork ? yearWork.firstPublishedYearSource : null,
    editionYear: pick('editionYear'),
    editionYearSource: yearWork ? yearWork.editionYearSource || null : null,
    pages: pick('pages'),
    coverUrl: pick('coverUrl'),
    isbn13: pick('isbn13'),
    isbn10: pick('isbn10'),
    metadataSources,
    mangaComics,
    links,
    finishedDate: finishedDates.length ? finishedDates[finishedDates.length - 1] : null,
    rating10: pick('rating10'),
    sources: [...new Set(ordered.flatMap((work) => work.sources || []))].sort(),
    unresolved: primary.unresolved,
    details: primary.details,
  };
}

/** Merge works that share a canonical title+authors key; return the remap. */
function dedupeWorks(works) {
  const groups = new Map();
  for (const work of works.values()) {
    const key = canonicalKeyOf(work);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(work);
  }
  const merged = new Map(works);
  const remap = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const combined = mergeWorkGroup(group);
    for (const work of group) {
      remap.set(work.workId, combined.workId);
      if (work.workId !== combined.workId) merged.delete(work.workId);
    }
    merged.set(combined.workId, combined);
  }
  return { works: merged, remap };
}

/**
 * Series-level manga/comics propagation.
 *
 * The per-work flag is derived from that work's own genres/series/publisher.
 * Hardcover tags are inconsistent across volumes of the same series: "Fables"
 * has volumes with "Graphic Novels" (flag true) next to volumes tagged only
 * "Fantasy, Adventure" (flag false), and "Homunculus" has volumes with
 * "Comics" next to volumes with no genres at all (null). The user reads one
 * series, so a single comic volume marks the whole series as comics.
 *
 * Rules:
 *   - a work may belong to several series entries (LiveLib name + Hardcover id);
 *     those keys are unioned, so "Fables" and "Fables +" stay one series;
 *   - `true` from any volume wins over per-work `false`/`null`;
 *   - `false` never propagates (an explicit clean genre list says nothing
 *     about the sibling volume).
 * The change is applied to the aggregation copy only (`work.mangaComics`);
 * persisted details files are untouched.
 */
function normalizeSeriesName(name) {
  return String(name == null ? '' : name)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    // Hardcover splits one series into several ids with display suffixes:
    // "Crossed", "Crossed (Collected Editions)", "Crossed (Single Issues)"
    // share the same shelf. The suffix is presentation, not identity.
    .replace(/\s*\([^()]*\)\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function seriesKeysOf(work) {
  const keys = [];
  for (const entry of work.series || []) {
    if (!entry) continue;
    if (entry.hcId != null && entry.hcId !== '') keys.push(`id:${entry.hcId}`);
    // Keep the name key even when an id is present: the same series arrives
    // with different Hardcover ids ("Crossed" 4443 vs "Crossed (Collected
    // Editions)" 14693), and an id-only join leaves those volumes behind.
    const name = normalizeSeriesName(entry.name);
    if (name) keys.push(`name:${name}`);
  }
  return [...new Set(keys)];
}

/** Mark every work whose series contains a comics volume; returns the ids. */
function propagateSeriesManga(works) {
  const parent = new Map();
  const find = (key) => {
    let root = key;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root);
    // Path compression keeps repeated lookups cheap on long series lists.
    let cursor = key;
    while (parent.has(cursor) && parent.get(cursor) !== cursor) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a === b) return;
    parent.set(a, b);
  };

  const keysByWork = new Map();
  for (const work of works.values()) {
    const keys = seriesKeysOf(work);
    keysByWork.set(work.workId, keys);
    for (const key of keys) if (!parent.has(key)) parent.set(key, key);
    for (let i = 1; i < keys.length; i++) union(keys[0], keys[i]);
  }

  const mangaSeries = new Set();
  for (const work of works.values()) {
    if (work.mangaComics !== true) continue;
    for (const key of keysByWork.get(work.workId) || []) mangaSeries.add(find(key));
  }

  const propagated = new Set();
  if (mangaSeries.size === 0) return propagated;
  for (const work of works.values()) {
    if (work.mangaComics === true) continue;
    const hit = (keysByWork.get(work.workId) || []).some((key) => mangaSeries.has(find(key)));
    if (!hit) continue;
    work.mangaComics = true;
    work.mangaComicsSource = 'series';
    propagated.add(work.workId);
  }
  return propagated;
}

/**
 * Per-work manual override, applied last: after provider detection and after
 * series propagation, before any aggregation. It is the user's word over the
 * detector's, in both directions:
 *   - `mangaComics: true`  hides a work even if all genres look clean;
 *   - `mangaComics: false` keeps a work that the detector/series calls comics
 *     ("показать снова").
 *
 * Dedupe may merge a LiveLib stub into a Hardcover work; an override stored on
 * any of the merged ids applies to the combined work.
 *
 * Returns `Map<workId, {mangaComics, previous}>` for the summary counters.
 */
function applyManualMangaFlags(works, flags) {
  const applied = new Map();
  if (!flags || typeof flags !== 'object') return applied;
  for (const work of works.values()) {
    const ids =
      Array.isArray(work.mergedWorkIds) && work.mergedWorkIds.length
        ? work.mergedWorkIds
        : [work.workId];
    if (work.metadataWorkId && !ids.includes(work.metadataWorkId)) ids.push(work.metadataWorkId);
    let entry = null;
    for (const id of ids) {
      const candidate = flags[id];
      if (candidate && typeof candidate.mangaComics === 'boolean') {
        entry = candidate;
        break;
      }
    }
    if (!entry) continue;
    const previous = work.mangaComics;
    work.mangaComics = entry.mangaComics;
    work.mangaComicsSource = 'manual';
    work.mangaComicsOverride = entry.mangaComics;
    work.mangaComicsUpdatedAt = entry.updatedAt || null;
    applied.set(work.workId, { mangaComics: entry.mangaComics, previous });
  }
  return applied;
}

/**
 * Sub-series dedupe (user rule, 28.10.2026): «если у нас несколько серий с
 * одинаковыми книгами, показываем только ту, в которой книг больше всего».
 *
 * Works are compared by exact book identity, so two volumes of one manga are
 * two works (matching the bookCount contract). Equal sets keep the plain name
 * («The Witcher» beats «The Witcher (Publication order)»); a strict subset is
 * dropped in favour of its superset; a partial overlap keeps both series.
 */
function dedupeSeriesSubsets(list) {
  const entries = (Array.isArray(list) ? list : []).map((entry, index) => ({
    entry,
    index,
    works: new Set((entry.works || []).map((work) => String(work.workId))),
    name: String(entry.name || ''),
  }));
  const dropped = new Set();
  const plainName = (name) => normalizeSeriesName(name);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (dropped.has(entries[i].index) || dropped.has(entries[j].index)) continue;
      const a = entries[i];
      const b = entries[j];
      if (!a.works.size || !b.works.size) continue;
      let aSubset = true;
      let bSubset = true;
      for (const id of a.works) if (!b.works.has(id)) { aSubset = false; break; }
      for (const id of b.works) if (!a.works.has(id)) { bSubset = false; break; }
      if (!aSubset && !bSubset) continue;
      let drop = null;
      if (aSubset && bSubset) {
        // Same books: prefer the plain/shorter name, then the more generic
        // (both names normalize to the same series) one.
        const aPlain = plainName(a.name) === plainName(b.name);
        const aSimple = !/\([^()]*\)\s*$/u.test(a.name);
        const bSimple = !/\([^()]*\)\s*$/u.test(b.name);
        const aBetter = aSimple !== bSimple
          ? aSimple
          : a.name.length !== b.name.length
          ? a.name.length < b.name.length
          : a.name.localeCompare(b.name, 'ru') <= 0 || aPlain;
        drop = aBetter ? b : a;
      } else {
        // Strict subset: keep the series with more books.
        if (a.works.size > b.works.size) drop = b;
        else if (b.works.size > a.works.size) drop = a;
        else drop = b.name.length >= a.name.length ? b : a;
      }
      if (drop) dropped.add(drop.index);
    }
  }
  return entries.filter((entry) => !dropped.has(entry.index)).map((entry) => entry.entry);
}

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
  const publishers = buildPublishers(ctx);
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
    publishers,
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
