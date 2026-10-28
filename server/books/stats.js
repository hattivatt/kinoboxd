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
const { surnameOf } = require('./normalize');
const { detectManga } = require('./providers/manga');

const PAGE_BUCKETS = [
  { key: '<100', min: 0, max: 99 },
  { key: '100-199', min: 100, max: 199 },
  { key: '200-299', min: 200, max: 299 },
  { key: '300-399', min: 300, max: 399 },
  { key: '400-499', min: 400, max: 499 },
  { key: '500-699', min: 500, max: 699 },
  { key: '700-999', min: 700, max: 999 },
  { key: '1000+', min: 1000, max: Number.POSITIVE_INFINITY },
];

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function mean(values) {
  const list = values.filter((value) => Number.isFinite(value));
  if (list.length === 0) return null;
  return round2(list.reduce((sum, value) => sum + value, 0) / list.length);
}

function dayNumber(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!match) return null;
  return Math.floor(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000
  );
}

/** Same contract as the film calendar: `current` ends at the latest reading day. */
function computeStreaks(readDays, field) {
  const lastField = field || 'lastReadDate';
  const dates = (Array.isArray(readDays) ? readDays : [])
    .map((entry) => (entry && entry.date ? String(entry.date) : ''))
    .filter((date) => dayNumber(date) != null)
    .sort();
  if (!dates.length) {
    return { current: 0, best: 0, [lastField]: null, bestDates: [] };
  }
  let best = 1;
  let bestFrom = dates[0];
  let bestTo = dates[0];
  let run = 1;
  let runStart = dates[0];
  for (let i = 1; i < dates.length; i++) {
    if (dayNumber(dates[i]) - dayNumber(dates[i - 1]) === 1) {
      run++;
    } else {
      run = 1;
      runStart = dates[i];
    }
    if (run > best) {
      best = run;
      bestFrom = runStart;
      bestTo = dates[i];
    }
  }
  let current = 1;
  for (let i = dates.length - 1; i > 0; i--) {
    if (dayNumber(dates[i]) - dayNumber(dates[i - 1]) === 1) current++;
    else break;
  }
  return { current, best, [lastField]: dates[dates.length - 1], bestDates: [bestFrom, bestTo] };
}

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

function saneYear(value) {
  const year = Number(value);
  if (!Number.isFinite(year)) return null;
  return year >= 1000 && year <= 2100 ? year : null;
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

/**
 * Hardcover journal statuses that belong to the reading profile: 3 = read,
 * 5 = dnf ("did not finish"). Mirrors `HARDCOVER_KEEP_STATUS_IDS` from
 * `hardcover.js`; kept local so a persisted profile can be re-filtered without
 * loading the network module.
 */
const HARDCOVER_PROFILE_STATUS_IDS = [3, 5];
const HARDCOVER_PROFILE_STATUS_LABELS = ['read', 'dnf'];

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

function emptyStatusFilter() {
  return { excluded: 0, byStatus: {}, missingStatusId: 0 };
}

function recordStatusExclusion(filter, event) {
  const statusId = statusIdOf(event);
  const label = String((event && event.status) || 'unknown');
  const key = statusId != null ? `${statusId}:${label}` : `legacy:${label}`;
  filter.excluded++;
  filter.byStatus[key] = (filter.byStatus[key] || 0) + 1;
  if (statusId == null) filter.missingStatusId++;
}

/** Attach workId / reread flags to raw profile events. */
function prepareEvents(profiles) {
  const events = [];
  const statusFilter = emptyStatusFilter();
  const profileStatus = new Map();
  for (const profile of profiles) {
    const source = profile.source;
    const profileAudit = { kept: 0, excluded: 0, missingStatusId: 0 };
    profileStatus.set(`${source}:${profile.userKey}`, profileAudit);
    for (const raw of profile.events) {
      if (!raw) continue;
      const legacyStatus = statusIdOf(raw) == null;
      if (source === 'hardcover' && !keepHardcoverProfileEvent(raw)) {
        recordStatusExclusion(statusFilter, raw);
        profileAudit.excluded++;
        if (legacyStatus) profileAudit.missingStatusId++;
        continue;
      }
      if (legacyStatus && source === 'hardcover') profileAudit.missingStatusId++;
      profileAudit.kept++;
      const sourceBookId = String(raw.sourceBookId || '');
      let workId = raw.workId || null;
      if (!workId && source === 'livelib' && sourceBookId) {
        const link = bookCache.getLink(sourceBookId);
        workId = link && link.workId ? link.workId : null;
      }
      if (!workId) {
        workId = `${source === 'hardcover' ? 'hc' : 'll'}:${sourceBookId}`;
      }
      events.push({
        ...raw,
        source,
        userKey: profile.userKey,
        workId,
        // `resolved` here means "points at a canonical (non-LiveLib-stub) work";
        // metadata may also come from a LiveLib card, which is checked later.
        resolved: !String(workId).startsWith('ll:'),
        rating10: ratingOf(raw),
        finishedAt: raw.finishedAt || null,
        reread: Boolean(raw.reread),
        readIndex: Number(raw.readIndex) || 1,
      });
    }
  }

  // Re-read flags per (source, user_book/edition): extras beyond the first.
  const groups = new Map();
  for (const event of events) {
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

  return { events, reReadCounts, statusFilter, profileStatus };
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

/**
 * Effective provider-level flag for one work.
 *
 * The detector is re-run on every read over the full persisted corpus
 * (`mangaTexts`, `tags`) instead of trusting a stale `details.mangaComics`
 * boolean: a cache written before the detector learned new keywords/publishers
 * must start filtering without a full re-import. The stored boolean stays as an
 * additive `true` (a provider may have known a signal we cannot reconstruct)
 * and as the fallback when the current corpus has no classification fields.
 */
function mangaOfDetails(details, genres, series, publisher) {
  if (!details) return null;
  const detected = detectManga({
    genres,
    tags: Array.isArray(details.tags) ? details.tags : [],
    texts: Array.isArray(details.mangaTexts) ? details.mangaTexts : [],
    series,
    publisher,
  });
  if (detected === true) return true;
  if (details.mangaComics === true) return true;
  if (detected === false) return false;
  return typeof details.mangaComics === 'boolean' ? details.mangaComics : null;
}

function workMetadata(workId, events) {
  const hcEvents = events.filter((event) => event.source === 'hardcover');
  const llEvents = events.filter((event) => event.source === 'livelib');
  const details = bookCache.getWorkDetails(workId);

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
    null;
  const rawYear =
    (details && details.publicationYear) ||
    (displayEvent && displayEvent.edition && Number(displayEvent.edition.year)) ||
    null;
  const year = saneYear(rawYear);
  const pages =
    details && details.pages != null && Number.isFinite(Number(details.pages)) && Number(details.pages) > 0
      ? Number(details.pages)
      : null;
  const genres = details && Array.isArray(details.genres) ? [...details.genres] : [];
  const series = detailsSeries(details);
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
  const llSourceId = String(workId).startsWith('ll:') ? String(workId).slice(3) : null;
  if (llSourceId) links.livelib = `https://www.livelib.ru/book/${llSourceId}`;
  if (String(workId).startsWith('hc:')) {
    const workLink = bookCache.getWorkLink(workId);
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

  return {
    workId,
    title: hcTitle || llTitle,
    titleRu: hcTitle && llTitle && hcTitle !== llTitle ? llTitle : hcTitle ? hcTitle : llTitle,
    authors,
    genres,
    series,
    publisher,
    year: Number.isFinite(Number(year)) ? Number(year) : null,
    pages,
    coverUrl,
    isbn13: (details && details.isbn13) || null,
    isbn10: (details && details.isbn10) || null,
    metadataSources,
    mangaComics: mangaOfDetails(details, genres, series, publisher),
    details,
    links,
    finishedDate,
    // Option A: Hardcover priority, LiveLib fallback. With one profile this is
    // simply the rating of the profile's own event(s).
    rating10: hcWithRating ? hcWithRating.rating10 : llEvents.find((e) => e.rating10 != null)?.rating10 ?? null,
    sources: [...new Set(events.map((event) => event.source))].sort(),
    unresolved: !details,
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
    year: pick('year'),
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
 * Build the whole /api/books/stats payload for ONE profile.
 *
 * `options.profile` is the raw `?profile=` value (`livelib-Margaret`);
 * `options.profileScope` may carry an already-resolved scope (routes resolve it
 * to answer 400 with a good message). `options.resolveState` is the live
 * import-job view (`{ running, budgetRemaining }`) used for
 * `summary.metadata`; absent means "not running". `options.now` is injectable
 * for tests.
 */
function buildBooksStats(options = {}) {
  const startedAt = process.hrtime.bigint();
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
  const prepared = prepareEvents(profiles);
  const reReadCounts = prepared.reReadCounts;
  let events = prepared.events;

  const byWork = new Map();
  for (const event of events) {
    if (!byWork.has(event.workId)) byWork.set(event.workId, []);
    byWork.get(event.workId).push(event);
  }
  let works = new Map();
  for (const [workId, list] of byWork) works.set(workId, workMetadata(workId, list));

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
    if (excluded.size > 0) events = events.filter((event) => !excluded.has(event.workId));
  }

  // Event-level re-read flag from the per-book group counts.
  for (const event of events) {
    const key = `${event.source}:${event.userKey}:${event.sourceBookId}`;
    const extras = reReadCounts.get(key) || 0;
    event.reread = event.reread || (extras > 0 && event.groupIndex > 1);
  }

  /* ---------------- summary ---------------- */
  const ratedWorks = [...works.values()].filter((work) => work.rating10 != null);
  const pagesWorks = [...works.values()].filter((work) => work.pages != null);
  const years = [...works.values()]
    .map((work) => work.year)
    .filter((year) => Number.isFinite(year) && year > 0)
    .sort((a, b) => a - b);
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

  const finishedEvents = events.filter((event) => event.finishedAt);
  // Month-only events (LiveLib records an exact day for ~28% of a long
  // history; the rest carry `{year, month}`). They are NOT calendar days —
  // inventing a day would corrupt streaks — but they are not "undated" either:
  // they enter the month timeline and the coverage counters.
  const monthOnlyEvents = events.filter(
    (event) => !event.finishedAt && /^\d{4}-\d{2}$/.test(String(event.readMonth || ''))
  );
  const monthOnlyCount = monthOnlyEvents.length;
  const llEvents = events.filter((event) => event.source === 'livelib');
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
    mangaSeriesPropagated: mangaFromSeries.size,
    // Manual override bookkeeping: `hidden` = excluded by a manual `true`,
    // `restored` = a work whose detector/series flag was true but the user
    // explicitly asked to show it again (`false`).
    mangaManualExcluded,
    mangaManualRestored,
    mangaOverrides: manualManga.size,
    // Events dropped at aggregation time because their Hardcover journal
    // status is not part of the reading profile (wish/reading/paused).
    hardcoverStatusExcluded: prepared.statusFilter.excluded,
    includeMangaComics,
    avgRating: mean(ratedWorks.map((work) => work.rating10)),
    avgPages: pagesWorks.length
      ? Math.round(pagesWorks.reduce((sum, work) => sum + work.pages, 0) / pagesWorks.length)
      : null,
    pagesTotal,
    pageCount: pagesTotal,
    authorsCount: authorSet.size,
    seriesCount: seriesSet.size,
    yearsSpan: years.length ? { from: years[0], to: years[years.length - 1] } : null,
  };

  // Metadata coverage of the profile: a work is "covered" when a details
  // document exists (shared metadata chain: Hardcover/Litres/GB/OL/LiveLib
  // card). `running` is only true while the resolve stage of an import job is
  // alive; it lets the UI say "догружается" instead of showing empty genres as
  // final. A Hardcover profile takes its metadata from the journal, so it is
  // never "loading" here.
  const metadataResolved = [...works.values()].filter((work) => !work.unresolved).length;
  const metadataTotal = works.size;
  const resolveState = options.resolveState && typeof options.resolveState === 'object'
    ? options.resolveState
    : {};
  const metadataRunning = profile.source === 'livelib' && resolveState.running === true;
  const budgetRemaining = resolveState.budgetRemaining != null &&
    Number.isFinite(Number(resolveState.budgetRemaining))
    ? Number(resolveState.budgetRemaining)
    : null;
  summary.metadata = {
    resolved: metadataResolved,
    total: metadataTotal,
    percent: metadataTotal ? Math.round((metadataResolved * 100) / metadataTotal) : 100,
    running: metadataRunning,
    budgetRemaining: metadataRunning ? budgetRemaining : null,
  };

  /* ---------------- ratings ---------------- */
  function distribution(list) {
    const counts = new Map();
    for (const value of list) {
      if (!Number.isFinite(value) || value < 1 || value > 10) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([score, count]) => ({ score, count }));
  }

  // One profile = one rating scale. There is no per-source split on the wire:
  // `merged` IS the profile's distribution.
  const ratings = {
    scale: 10,
    merged: distribution(
      [...works.values()].map((work) => work.rating10).filter((v) => v != null)
    ),
  };

  /* ---------------- works-based widgets ---------------- */
  function pushWorks(map, key, payload, work) {
    if (!map.has(key)) map.set(key, { ...payload, works: [], sum: 0, rated: 0, count: 0 });
    const entry = map.get(key);
    entry.count++;
    if (work.rating10 != null) {
      entry.sum += work.rating10;
      entry.rated++;
    }
    entry.works.push({
      workId: work.workId,
      title: work.title,
      rating: work.rating10,
      year: work.year,
    });
    return entry;
  }

  const genreMap = new Map();
  for (const work of works.values()) {
    for (const genre of work.genres) {
      pushWorks(genreMap, genre, { name: genre }, work);
    }
  }
  const genres = [...genreMap.values()]
    .map((entry) => ({
      name: entry.name,
      count: entry.count,
      avgRating: entry.rated ? round2(entry.sum / entry.rated) : null,
      works: entry.works,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const decadeMap = new Map();
  const yearMap = new Map();
  for (const work of works.values()) {
    if (!Number.isFinite(work.year) || work.year <= 0) continue;
    const decade = Math.floor(work.year / 10) * 10;
    pushWorks(decadeMap, decade, { decade }, work);
    pushWorks(yearMap, work.year, { year: work.year }, work);
  }
  const decades = [...decadeMap.values()]
    .map((entry) => ({
      decade: entry.decade,
      count: entry.count,
      avgRating: entry.rated ? round2(entry.sum / entry.rated) : null,
    }))
    .sort((a, b) => a.decade - b.decade);
  const yearsList = [...yearMap.values()]
    .map((entry) => ({
      year: entry.year,
      count: entry.count,
      avgRating: entry.rated ? round2(entry.sum / entry.rated) : null,
    }))
    .sort((a, b) => a.year - b.year);

  const authorMap = new Map();
  for (const work of works.values()) {
    for (const name of work.authors) {
      pushWorks(authorMap, name.toLowerCase(), { name }, work);
    }
  }
  const authors = [...authorMap.values()]
    .map((entry) => ({
      name: entry.name,
      count: entry.count,
      avgRating: entry.rated ? round2(entry.sum / entry.rated) : null,
      works: entry.works,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const seriesMap = new Map();
  for (const work of works.values()) {
    for (const entry of work.series) {
      const key = String(entry.hcId || entry.name);
      pushWorks(seriesMap, key, { seriesId: entry.hcId || null, name: entry.name }, work);
    }
  }
  const series = [...seriesMap.values()]
    .map((entry) => ({
      seriesId: entry.seriesId,
      name: entry.name,
      count: entry.count,
      avgRating: entry.rated ? round2(entry.sum / entry.rated) : null,
      works: entry.works,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const publisherMap = new Map();
  for (const work of works.values()) {
    if (!work.publisher) continue;
    pushWorks(publisherMap, work.publisher, { name: work.publisher }, work);
  }
  const publishers = [...publisherMap.values()]
    .map((entry) => ({
      name: entry.name,
      count: entry.count,
      avgRating: entry.rated ? round2(entry.sum / entry.rated) : null,
      works: entry.works,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const pagesHistogram = PAGE_BUCKETS.map((bucket) => {
    const list = [...works.values()].filter(
      (work) => work.pages != null && work.pages >= bucket.min && work.pages <= bucket.max
    );
    return {
      bucket: bucket.key,
      count: list.length,
      avgRating: mean(list.map((work) => work.rating10)),
    };
  });

  /* ---------------- timeline / calendar / streaks ---------------- */
  const monthMap = new Map();
  const dayMap = new Map();
  function monthBucket(month) {
    if (!monthMap.has(month)) {
      monthMap.set(month, {
        month,
        finished: 0,
        reRead: 0,
        livelib: 0,
        hardcover: 0,
        monthOnly: 0,
      });
    }
    return monthMap.get(month);
  }
  for (const event of monthOnlyEvents) {
    const bucket = monthBucket(String(event.readMonth).slice(0, 7));
    bucket.monthOnly++;
    bucket[event.source] = (bucket[event.source] || 0) + 1;
    if (event.reread) bucket.reRead++;
  }
  for (const event of finishedEvents) {
    const month = String(event.finishedAt).slice(0, 7);
    const day = String(event.finishedAt).slice(0, 10);
    const monthEntry = monthBucket(month);
    monthEntry.finished++;
    if (event.reread) monthEntry.reRead++;
    monthEntry[event.source] = (monthEntry[event.source] || 0) + 1;

    if (!dayMap.has(day)) {
      dayMap.set(day, { date: day, count: 0, reReadCount: 0, ids: [], sources: new Set() });
    }
    const dayEntry = dayMap.get(day);
    dayEntry.count++;
    if (event.reread) dayEntry.reReadCount++;
    if (!dayEntry.ids.includes(event.workId)) dayEntry.ids.push(event.workId);
    dayEntry.sources.add(event.source);
  }
  const timeline = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month));
  const readDays = [...dayMap.values()]
    .map((entry) => ({ ...entry, sources: [...entry.sources].sort() }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const streaks = computeStreaks(readDays);

  const recentlyFinished = [...finishedEvents]
    .sort((a, b) => {
      if (a.finishedAt !== b.finishedAt) return a.finishedAt < b.finishedAt ? 1 : -1;
      return String(a.id) < String(b.id) ? -1 : 1;
    })
    .slice(0, 15)
    .map((event) => {
      const work = works.get(event.workId);
      return {
        date: event.finishedAt,
        workId: event.workId,
        title: (work && work.title) || event.title,
        authors: (work && work.authors.length ? work.authors : event.authors) || [],
        source: event.source,
        reRead: event.reread,
        rating: (work && work.rating10) != null ? work.rating10 : event.rating10,
      };
    });

  /* ---------------- books index ---------------- */
  const booksIndex = {};
  for (const work of works.values()) {
    booksIndex[work.workId] = {
      workId: work.workId,
      title: work.title,
      titleRu: work.titleRu,
      authors: work.authors,
      rating: work.rating10,
      finishedDate: work.finishedDate,
      sources: work.sources,
      genres: work.genres,
      series: work.series.map((entry) => entry.name),
      publisher: work.publisher,
      pages: work.pages,
      year: work.year,
      coverUrl: work.coverUrl,
      isbn13: work.isbn13,
      isbn10: work.isbn10,
      metadataSources: work.metadataSources,
      mangaComics: work.mangaComics,
      ...(work.mangaComicsSource ? { mangaComicsSource: work.mangaComicsSource } : {}),
      ...(typeof work.mangaComicsOverride === 'boolean'
        ? { mangaComicsOverride: work.mangaComicsOverride }
        : {}),
      ...(work.mangaComicsUpdatedAt ? { mangaComicsUpdatedAt: work.mangaComicsUpdatedAt } : {}),
      ...(work.mergedWorkIds && work.mergedWorkIds.length > 1
        ? { mergedWorkIds: work.mergedWorkIds }
        : {}),
      links: work.links,
      unresolved: work.unresolved,
    };
  }

  const unmatched = [...works.values()]
    .filter((work) => work.unresolved)
    .map((work) => ({
      workId: work.workId,
      bookId: String(work.workId).replace(/^ll:/, ''),
      title: work.title,
      authors: work.authors,
      rating: work.rating10,
      finishedDate: work.finishedDate,
    }))
    .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));

  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

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
    authors,
    series,
    publishers,
    pagesHistogram,
    booksIndex,
    unmatchedCount: unmatched.length,
    unmatched,
    meta: {
      buildMs: Number(elapsedMs.toFixed(1)),
      statusFilter: {
        excluded: prepared.statusFilter.excluded,
        byStatus: prepared.statusFilter.byStatus,
        keepStatusIds: HARDCOVER_PROFILE_STATUS_IDS,
        legacyExcluded: prepared.statusFilter.missingStatusId,
      },
      profiles: profiles.map((entry) => {
        const audit = prepared.profileStatus.get(`${entry.source}:${entry.userKey}`) || {
          kept: entry.events.length,
          excluded: 0,
          missingStatusId: 0,
        };
        return {
          key: `${entry.source}-${entry.userKey}`,
          source: entry.source,
          userKey: entry.userKey,
          importedAt: entry.importedAt || null,
          events: entry.events.length,
          keptEvents: audit.kept,
          statusExcluded: audit.excluded,
          // Events without `statusId` come from imports made before the
          // journal schema learned the raw status; a Hardcover re-import
          // refresh is advised (the label fallback keeps the numbers honest
          // in the meantime).
          missingStatusId: audit.missingStatusId,
          needsReimport: entry.source === 'hardcover' && audit.missingStatusId > 0,
        };
      }),
      // Deep Scan progress of a LiveLib profile: the frontend shows it on the
      // "Обновить профиль" button without blocking the dashboard.
      deepScan: profile.deepScan || null,
    },
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
  const workIds = new Set(events.map((event) => event.workId));
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
  prepareEvents,
  workMetadata,
  canonicalKeyOf,
  dedupeWorks,
  mergeWorkGroup,
  propagateSeriesManga,
  applyManualMangaFlags,
  buildBooksStats,
  profileSummary,
  listUnmatched,
};
