'use strict';

/**
 * /api/books/stats payload (КНИГИ-АРХИТЕКТУРА.md §5, v3 + K1 refinements).
 *
 * Profile = union of independent sources. Events are never merged; only
 * "unique books" are deduplicated by workId (`hc:{books.id}`), and an
 * unresolved LiveLib book keeps its own stub id `ll:{sourceBookId}` so it is
 * still counted as a book while its events stay visible.
 *
 * Merge rules:
 *   - events are tagged by source, both dates remain in the calendar;
 *   - rating conflict = option A: Hardcover wins, LiveLib is the fallback;
 *     `ratings.bySource` is always present, no averaging between sources;
 *   - every rating in the payload is on the unified 1..10 scale
 *     (hardcover native 0..5 * 2, livelib native 0..10);
 *   - only events with `finishedAt` enter timeline/calendar/streaks;
 *     `summary.undatedEventCount` reports the rest honestly;
 *   - `sources=` filters events before aggregation, metadata may still come
 *     from Hardcover details.
 */

const bookCache = require('./book-cache');

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

/** Connected sources = profiles present on disk. */
function connectedProfiles() {
  return bookCache.listProfiles();
}

/**
 * Load all profiles of the requested sources. `requested` is a comma separated
 * string or an array; unknown/not-connected values are ignored (an explicit
 * unknown-only filter returns an empty profile rather than an error).
 */
function selectProfiles(requested) {
  const profiles = connectedProfiles();
  const connected = [...new Set(profiles.map((profile) => profile.source))];
  let selected = connected;
  if (requested != null && String(requested).trim() !== '') {
    const wanted = (Array.isArray(requested) ? requested : String(requested).split(','))
      .map((value) => String(value).trim().toLowerCase())
      .filter(Boolean);
    selected = connected.filter((source) => wanted.includes(source));
  }
  const loaded = [];
  for (const source of selected) {
    for (const meta of profiles.filter((profile) => profile.source === source)) {
      const data = bookCache.getProfile(source, meta.userKey);
      if (data && Array.isArray(data.events)) loaded.push(data);
    }
  }
  return { connected, selected, profiles: loaded };
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

/** Attach workId / reread flags to raw profile events. */
function prepareEvents(profiles) {
  const events = [];
  for (const profile of profiles) {
    const source = profile.source;
    for (const raw of profile.events) {
      if (!raw) continue;
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
        resolved: String(workId).startsWith('hc:'),
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

  return { events, reReadCounts };
}

function workMetadata(workId, events) {
  const hcEvents = events.filter((event) => event.source === 'hardcover');
  const llEvents = events.filter((event) => event.source === 'livelib');
  let details = null;
  if (String(workId).startsWith('hc:')) {
    details = bookCache.getDetails(String(workId).replace('hc:', ''));
  }

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

  const hcTitle = (details && details.title) || (hcEvents[0] && hcEvents[0].title) || null;
  const llTitle = (llEvents.find((event) => event.title) || {}).title || null;

  const authors = [];
  if (details && Array.isArray(details.authors) && details.authors.length) {
    for (const author of details.authors) {
      if (author && author.name) authors.push(author.name);
    }
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
  const pages = details && Number.isFinite(Number(details.pages)) ? Number(details.pages) : null;
  const genres = details && Array.isArray(details.genres) ? [...details.genres] : [];
  const series = details && Array.isArray(details.series) ? details.series : [];
  const coverUrl =
    (details && details.coverUrl) ||
    (displayEvent && displayEvent.coverUrl) ||
    null;

  const finishDates = events.map((event) => event.finishedAt).filter(Boolean);
  const finishedDate = finishDates.length
    ? finishDates.sort()[finishDates.length - 1]
    : null;

  const ratingsBySource = {};
  for (const source of ['livelib', 'hardcover']) {
    const list = events.filter((event) => event.source === source && event.rating10 != null);
    if (list.length) {
      const chosen = list.sort((a, b) =>
        String(b.finishedAt || '').localeCompare(String(a.finishedAt || ''))
      )[0];
      ratingsBySource[source] = {
        rating: Number(chosen.rating != null ? chosen.rating : chosen.rating10),
        scale: Number(chosen.ratingScale) || 10,
        rating10: chosen.rating10,
      };
    }
  }

  // Link menu (§6.3): LiveLib is derivable for every work with an LL event or
  // an LL link in links.json; Hardcover needs a slug we do not store.
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
    details,
    links,
    finishedDate,
    // Option A: Hardcover priority, LiveLib fallback.
    rating10: hcWithRating ? hcWithRating.rating10 : llEvents.find((e) => e.rating10 != null)?.rating10 ?? null,
    ratingsBySource,
    sources: [...new Set(events.map((event) => event.source))].sort(),
    unresolved: !String(workId).startsWith('hc:'),
  };
}

/* ------------------------------------------------------------------ */
/* Payload                                                             */
/* ------------------------------------------------------------------ */

/**
 * Build the whole /api/books/stats payload. `options.sources` is the raw
 * `?sources=` value (string or array); `options.now` is injectable for tests.
 */
function buildBooksStats(options = {}) {
  const startedAt = process.hrtime.bigint();
  const { connected, selected, profiles } = selectProfiles(options.sources);
  const { events: allEvents, reReadCounts } = prepareEvents(profiles);
  const events = allEvents.filter((event) => selected.includes(event.source));

  const byWork = new Map();
  for (const event of events) {
    if (!byWork.has(event.workId)) byWork.set(event.workId, []);
    byWork.get(event.workId).push(event);
  }
  const works = new Map();
  for (const [workId, list] of byWork) works.set(workId, workMetadata(workId, list));

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
  for (const [key, count] of reReadCounts) {
    if (selected.includes(key.split(':')[0])) reReadCount += count;
  }

  const finishedEvents = events.filter((event) => event.finishedAt);
  const llEvents = events.filter((event) => event.source === 'livelib');
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
    undatedEventCount: events.filter((event) => !event.finishedAt).length,
    // Reading period of the selected sources (film contract: dateFrom/dateTo).
    dateFrom: finishedDates.length ? finishedDates[0].slice(0, 10) : null,
    dateTo: finishedDates.length ? finishedDates[finishedDates.length - 1].slice(0, 10) : null,
    resolvedCount: llEvents.filter((event) => event.resolved).length,
    unresolvedCount: llEvents.filter((event) => !event.resolved).length,
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

  /* ---------------- per-source breakdown ---------------- */
  const sourceBreakdown = selected.map((source) => {
    const sourceEvents = events.filter((event) => event.source === source);
    const sourceWorks = new Map();
    for (const event of sourceEvents) {
      if (!sourceWorks.has(event.workId)) {
        sourceWorks.set(event.workId, works.get(event.workId) || null);
      }
    }
    const ratings = [];
    for (const work of sourceWorks.values()) {
      const entry = work && work.ratingsBySource ? work.ratingsBySource[source] : null;
      if (entry && entry.rating10 != null) ratings.push(entry.rating10);
    }
    return {
      source,
      events: sourceEvents.length,
      books: sourceWorks.size,
      avgRating: mean(ratings),
      finishedWithDate: sourceEvents.filter((event) => event.finishedAt).length,
      undated: sourceEvents.filter((event) => !event.finishedAt).length,
    };
  });

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

  const ratings = {
    scale: 10,
    merged: distribution([...works.values()].map((work) => work.rating10).filter((v) => v != null)),
    bySource: {
      livelib: distribution(
        [...works.values()]
          .map((work) => work.ratingsBySource.livelib)
          .filter(Boolean)
          .map((entry) => entry.rating10)
      ),
      hardcover: distribution(
        [...works.values()]
          .map((work) => work.ratingsBySource.hardcover)
          .filter(Boolean)
          .map((entry) => entry.rating10)
      ),
    },
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
  for (const event of finishedEvents) {
    const month = String(event.finishedAt).slice(0, 7);
    const day = String(event.finishedAt).slice(0, 10);
    if (!monthMap.has(month)) {
      monthMap.set(month, { month, finished: 0, reRead: 0, livelib: 0, hardcover: 0 });
    }
    const monthEntry = monthMap.get(month);
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
      ratingsBySource: work.ratingsBySource,
      finishedDate: work.finishedDate,
      sources: work.sources,
      genres: work.genres,
      series: work.series.map((entry) => entry.name),
      publisher: work.publisher,
      pages: work.pages,
      year: work.year,
      coverUrl: work.coverUrl,
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
    sources: {
      connected,
      selected,
    },
    summary,
    sourceBreakdown,
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
      profiles: profiles.map((profile) => ({
        source: profile.source,
        userKey: profile.userKey,
        importedAt: profile.importedAt || null,
        events: profile.events.length,
      })),
    },
  };
}

/** Unmatched list for GET /api/books/unmatched (livelib-only by contract). */
function listUnmatched(options = {}) {
  const stats = buildBooksStats(options);
  return {
    count: stats.unmatchedCount,
    items: stats.unmatched,
    sources: stats.sources,
  };
}

module.exports = {
  PAGE_BUCKETS,
  round2,
  mean,
  dayNumber,
  computeStreaks,
  connectedProfiles,
  selectProfiles,
  prepareEvents,
  workMetadata,
  buildBooksStats,
  listUnmatched,
};
