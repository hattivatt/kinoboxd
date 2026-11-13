import { toNum } from './ui.js';
import { text, firstString, arr, numOrNull } from './core/dom.js';
import { scopeSourceNames } from './books-profiles.js';

export const SOURCE_LABEL = { livelib: 'LiveLib', hardcover: 'Hardcover' };
export const SOURCE_MARK = { livelib: 'LL', hardcover: 'HC' };

export const METADATA_LABEL = {
  hardcover: ['HC', 'Hardcover'],
  litres: ['ЛР', 'Литрес'],
  googlebooks: ['GB', 'Google Books'],
  openlibrary: ['OL', 'Open Library'],
  livelib: ['LL', 'LiveLib'],
  'livelib-card': ['LL', 'LiveLib'],
};

function normalizeRatingBucket(item) {
  if (!item || typeof item !== 'object') return null;
  const score = Math.round(toNum(item.score ?? item.rating ?? item.rating10, -1));
  const count = Math.max(0, toNum(item.count));
  if (score < 1 || score > 10) return null;
  return { score, count };
}

function normalizeRatingList(raw) {
  const byScore = new Map();
  for (const item of arr(raw)) {
    const bucket = normalizeRatingBucket(item);
    if (!bucket) continue;
    byScore.set(bucket.score, (byScore.get(bucket.score) || 0) + bucket.count);
  }
  return [...byScore.entries()]
    .map(([score, count]) => ({ score, count }))
    .filter((item) => item.count > 0)
    .sort((a, b) => a.score - b.score);
}

function normalizeSources(raw, summaryRaw) {
  const top = raw && raw.sources && typeof raw.sources === 'object' && !Array.isArray(raw.sources)
    ? raw.sources
    : null;
  const list = arr(top && top.connected).length
    ? arr(top.connected)
    : (Array.isArray(raw && raw.sources) ? raw.sources : arr(summaryRaw.sources));
  const names = [];
  for (const item of list) {
    const name = text(typeof item === 'object' && item ? (item.source || item.name) : item).toLowerCase();
    if (SOURCE_LABEL[name] && !names.includes(name)) names.push(name);
  }
  return names;
}

function normalizeLinks(raw, workId) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const links = {};
  for (const key of ['livelib', 'hardcover']) {
    const href = text(source[key]);
    if (/^https?:\/\//i.test(href)) links[key] = href;
  }
  const key = text(workId);
  if (!links.livelib) {
    const match = /^ll[:_-]?(\d+)$/i.exec(key);
    if (match) links.livelib = `https://www.livelib.ru/book/${match[1]}`;
  }
  return links;
}

function pickRating10(entry) {
  const direct = numOrNull(entry && entry.rating);
  return direct != null ? Math.round(direct) : null;
}

function normalizeMetadataSources(raw) {
  const out = [];
  for (const item of arr(raw)) {
    const source = text(typeof item === 'object' && item ? (item.source || item.name) : item).toLowerCase();
    if (METADATA_LABEL[source] && !out.includes(source)) out.push(source);
  }
  return out;
}

export function normalizeEntry(workId, raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const sources = arr(entry.sources)
    .map((item) => text(typeof item === 'object' && item ? item.source : item).toLowerCase())
    .filter((item) => SOURCE_LABEL[item]);
  const genreNames = arr(entry.genreNames || entry.genres)
    .map((item) => text(typeof item === 'object' && item ? (item.name || item.label) : item))
    .filter(Boolean);
  const authors = arr(entry.authors)
    .map((item) => text(typeof item === 'object' && item ? (item.name || item.author) : item))
    .filter(Boolean);
  const links = normalizeLinks(entry.links, workId);
  const collection = entry.collection && typeof entry.collection === 'object'
    ? {
        parentTitle: text(entry.collection.title),
        parentWorkId: text(entry.collection.workId),
        parentUrl: text(entry.collection.parentUrl),
        catalogSeries: text(entry.collection.catalogSeries),
      }
    : null;
  const mangaComics = entry.mangaComics === true ? true : entry.mangaComics === false ? false : null;
  const mangaComicsOverride = entry.mangaComicsOverride === true
    ? true
    : entry.mangaComicsOverride === false
    ? false
    : null;
  return {
    workId: text(workId),
    title: firstString(entry.titleRu, entry.title) || text(workId),
    titleOriginal: entry.titleRu ? text(entry.title) : '',
    authors,
    publisher: text(entry.publisher),
    year: numOrNull(entry.year),
    yearSource: ['first', 'edition', 'manual'].includes(entry.yearSource) ? entry.yearSource : null,
    yearOverride: numOrNull(entry.yearOverride),
    firstPublishedYear: numOrNull(entry.firstPublishedYear),
    firstPublishedYearSource: text(entry.firstPublishedYearSource) || '',
    editionYear: numOrNull(entry.editionYear),
    editionYearSource: ['file', 'details'].includes(entry.editionYearSource)
      ? entry.editionYearSource
      : null,
    pages: numOrNull(entry.pages != null ? entry.pages : entry.pagesOfEdition),
    genres: genreNames,
    series: text(entry.series),
    coverUrl: text(entry.coverUrl || entry.cover),
    rating: pickRating10(entry),
    sources: sources.length ? sources : [],
    metadataSources: normalizeMetadataSources(entry.metadataSources),
    mangaComics,
    mangaComicsOverride,
    finishedDate: /^\d{4}-\d{2}-\d{2}/.test(text(entry.finishedDate)) ? text(entry.finishedDate).slice(0, 10) : null,
    reReadCount: Math.max(0, toNum(entry.reReadCount)),
    links,
    collection,
  };
}

function normalizeBooksIndex(raw) {
  const index = {};
  if (!raw || typeof raw !== 'object') return index;
  for (const [workId, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    index[workId] = normalizeEntry(workId, entry);
  }
  return index;
}

function normalizeWorksList(raw) {
  const out = [];
  for (const item of arr(raw)) {
    const id = text(typeof item === 'object' && item ? (item.workId || item.id) : item);
    if (id) out.push(id);
  }
  return out;
}

export function normalizeBooks(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const summaryRaw = source.summary && typeof source.summary === 'object' ? source.summary : {};
  const connected = normalizeSources(source, summaryRaw);
  const profileSourcesScoped = scopeSourceNames(source.sources && source.sources.profiles);
  const ratingsRaw = source.ratings && typeof source.ratings === 'object' ? source.ratings : {};
  const booksIndexRaw = source.booksIndex && typeof source.booksIndex === 'object'
    ? source.booksIndex
    : {};
  const hasMangaField = Object.values(booksIndexRaw)
    .some((entry) => entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'mangaComics'));
  const booksIndex = normalizeBooksIndex(source.booksIndex);

  const genres = arr(source.genres).map((item) => ({
    name: firstString(item && item.name, item && item.label, item && item.key),
    key: text(item && item.key),
    count: Math.max(0, toNum(item && item.count)),
    avgRating: numOrNull(item && item.avgRating),
    works: normalizeWorksList(item && item.works),
  })).filter((item) => item.name && item.count > 0);

  const authors = arr(source.authors).map((item) => ({
    authorId: item && item.authorId != null ? item.authorId : null,
    name: text(item && item.name),
    count: Math.max(0, toNum(item && item.count)),
    avgRating: numOrNull(item && item.avgRating),
    works: normalizeWorksList(item && item.works),
  })).filter((item) => item.name && item.count > 0);

  const series = arr(source.series).map((item) => ({
    seriesId: item && item.seriesId != null ? item.seriesId : null,
    name: text(item && item.name),
    count: Math.max(0, toNum(item && item.count)),
    avgRating: numOrNull(item && item.avgRating),
    works: normalizeWorksList(item && item.works),
  })).filter((item) => item.name && item.count > 0);

  const decades = arr(source.decades).map((item) => {
    const start = Math.round(toNum(item && (item.start ?? item.decade), 0));
    const ancient = Boolean(item && item.ancient);
    const beforeYear = Math.round(toNum(item && item.beforeYear, 0));
    const label = firstString(item && item.label) || (start > 0 ? `${start}-е` : '');
    return {
      start,
      label,
      unknown: Boolean(item && item.unknown),
      ancient,
      key: text(item && item.key) || (ancient ? 'before-1000' : ''),
      beforeYear: beforeYear > 0 ? beforeYear : ancient ? 1000 : null,
      count: Math.max(0, toNum(item && item.count)),
      firstCount: Math.max(0, toNum(item && item.firstCount)),
      editionCount: Math.max(0, toNum(item && item.editionCount)),
      manualCount: Math.max(0, toNum(item && item.manualCount)),
    };
  }).filter((item) => item.label && item.count > 0)
    .sort((a, b) => {
      if (a.unknown) return 1;
      if (b.unknown) return -1;
      return b.start - a.start || b.label.localeCompare(a.label, 'ru');
    });

  const years = arr(source.years).map((item) => {
    const ancient = Boolean(item && item.ancient);
    const beforeYear = Math.round(toNum(item && item.beforeYear, 0));
    return {
      year: ancient ? null : Math.round(toNum(item && item.year, 0)),
      ancient,
      beforeYear: beforeYear > 0 ? beforeYear : ancient ? 1000 : null,
      key: text(item && item.key) || (ancient ? 'before-1000' : ''),
      label: ancient ? firstString(item && item.label) || 'до 1000 г.' : '',
      count: Math.max(0, toNum(item && item.count)),
      firstCount: Math.max(0, toNum(item && item.firstCount)),
      editionCount: Math.max(0, toNum(item && item.editionCount)),
      manualCount: Math.max(0, toNum(item && item.manualCount)),
      avgRating: numOrNull(item && item.avgRating),
    };
  }).filter((item) => item.count > 0 && (item.ancient || item.year > 0))
    .sort((a, b) => {
      if (a.ancient || b.ancient) return a.ancient ? -1 : 1;
      return a.year - b.year;
    });

  const timeline = arr(source.timeline).map((item) => ({
    month: text(item && item.month),
    finished: Math.max(0, toNum(item && (item.finished ?? item.read ?? item.watched)))
      + Math.max(0, toNum(item && item.monthOnly)),
    monthOnly: Math.max(0, toNum(item && item.monthOnly)),
    reRead: Math.max(0, toNum(item && (item.reRead ?? item.reReadCount))),
    livelib: Math.max(0, toNum(item && item.livelib)),
    hardcover: Math.max(0, toNum(item && item.hardcover)),
  })).filter((item) => /^\d{4}-\d{2}$/.test(item.month));

  const readDays = arr(source.readDays).map((item) => {
    const date = text(item && item.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const reReadCount = Math.max(0, toNum(item && (item.reReadCount ?? item.reRead)));
    return {
      date,
      count: Math.max(0, toNum(item && item.count)),
      reReadCount,
      ids: arr(item && (item.ids || item.works || item.slugs)).map((id) => text(id)).filter(Boolean),
      sources: arr(item && item.sources).map((s) => text(s)),
    };
  }).filter((item) => item && item.count > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const recentlyFinished = arr(source.recentlyFinished || source.recentlyRead)
    .map((item) => {
      const entry = booksIndex[text(item && item.workId)];
      const rawDate = text(item && (item.date || item.finishedAt));
      const date = rawDate.slice(0, 10);
      const precision = text(item && item.precision) || (/^\d{4}-\d{2}-\d{2}/.test(rawDate) ? 'day' : 'month');
      if (!/^\d{4}-\d{2}(?:-\d{2})?$/.test(date)) return null;
      return {
        date,
        precision,
        workId: text(item && item.workId),
        source: text(item && item.source).toLowerCase(),
        reRead: Boolean(item && (item.reRead || item.reread)),
        title: firstString(item && item.title, entry && entry.title),
        coverUrl: firstString(item && item.coverUrl, entry && entry.coverUrl),
      };
    })
    .filter((item) => item && item.workId)
    .sort((a, b) => b.date.localeCompare(a.date));

  const recentlyReading = arr(source.recentlyReading)
    .map((item) => {
      const workId = text(item && item.workId);
      if (!workId) return null;
      const entry = booksIndex[workId];
      const rawDate = text(item && (item.date || item.startedAt));
      const date = rawDate.slice(0, 10);
      const knownDate = /^\d{4}-\d{2}(?:-\d{2})?$/.test(date) ? date : null;
      return {
        date: knownDate,
        precision: knownDate
          ? text(item && item.precision) || (knownDate.length === 10 ? 'day' : 'month')
          : null,
        workId,
        source: text(item && item.source).toLowerCase(),
        title: firstString(item && item.title, entry && entry.title),
        authors: arr(item && item.authors).map((name) => text(name)).filter(Boolean),
        coverUrl: firstString(item && item.coverUrl, entry && entry.coverUrl),
        reading: true,
      };
    })
    .filter(Boolean);

  const ratings = {
    merged: normalizeRatingList(ratingsRaw.merged),
  };

  const metadataRaw = summaryRaw.metadata && typeof summaryRaw.metadata === 'object'
    ? summaryRaw.metadata
    : null;
  const metadata = metadataRaw
    ? {
        resolved: Math.max(0, toNum(metadataRaw.resolved)),
        total: Math.max(0, toNum(metadataRaw.total)),
        linked: Math.max(0, toNum(metadataRaw.linked)),
        withDetails: Math.max(0, toNum(metadataRaw.withDetails)),
        unlinked: Math.max(0, toNum(metadataRaw.unlinked)),
        resolvable: Math.max(0, toNum(metadataRaw.resolvable)),
        hopeless: Math.max(0, toNum(metadataRaw.hopeless)),
        keyless: Math.max(0, toNum(metadataRaw.keyless)),
        percent: Math.max(0, Math.min(100, Math.round(toNum(metadataRaw.percent)))),
        running: metadataRaw.running === true,
        budgetRemaining: numOrNull(metadataRaw.budgetRemaining),
      }
    : null;

  const yearBackfillRaw = summaryRaw.yearBackfill && typeof summaryRaw.yearBackfill === 'object'
    ? summaryRaw.yearBackfill
    : null;
  const yearBackfill = yearBackfillRaw
    ? {
        known: Math.max(0, toNum(yearBackfillRaw.known)),
        unknown: Math.max(0, toNum(yearBackfillRaw.unknown)),
        pending: Math.max(0, toNum(yearBackfillRaw.pending)),
        honestUnknown: Math.max(0, toNum(yearBackfillRaw.honestUnknown)),
        unlinked: Math.max(0, toNum(yearBackfillRaw.unlinked)),
        perRun: Math.max(1, toNum(yearBackfillRaw.perRun, 200)),
        runsLeft: Math.max(0, toNum(yearBackfillRaw.runsLeft)),
        open: yearBackfillRaw.open === true,
      }
    : null;

  const summary = {
    bookCount: Math.max(0, toNum(summaryRaw.bookCount)),
    eventCount: Math.max(0, toNum(summaryRaw.eventCount ?? summaryRaw.readCount)),
    finishedCount: Math.max(0, toNum(summaryRaw.finishedCount)),
    readingNowCount: Math.max(0, toNum(summaryRaw.readingNowCount)),
    reReadCount: Math.max(0, toNum(summaryRaw.reReadCount)),
    undatedEventCount: Math.max(0, toNum(summaryRaw.undatedEventCount)),
    monthOnlyEventCount: Math.max(0, toNum(summaryRaw.monthOnlyEventCount)),
    readCount: Math.max(0, toNum(summaryRaw.readCount)),
    pageCount: numOrNull(summaryRaw.pageCount),
    avgPages: numOrNull(summaryRaw.avgPages),
    avgRating: numOrNull(summaryRaw.avgRating),
    dateFrom: text(summaryRaw.dateFrom) || null,
    dateTo: text(summaryRaw.dateTo) || null,
    mangaExcluded: Math.max(0, toNum(summaryRaw.mangaExcluded)),
    metadata,
    yearBackfill,
  };
  if (!summary.eventCount) summary.eventCount = summary.finishedCount;
  if (!summary.bookCount) summary.bookCount = Object.keys(booksIndex).length;

  const profileBlock = (source.sources && typeof source.sources === 'object'
    ? source.sources.profile
    : null) || null;
  const payloadProfile = profileBlock && typeof profileBlock === 'object'
    ? {
        key: text(profileBlock.key),
        source: text(profileBlock.source).toLowerCase(),
        userKey: text(profileBlock.userKey),
        importedAt: text(profileBlock.importedAt) || null,
        eventCount: Math.max(0, toNum(profileBlock.eventCount)),
      }
    : null;
  const metaRaw = source.meta && typeof source.meta === 'object' ? source.meta : {};
  const deepScan = metaRaw.deepScan && typeof metaRaw.deepScan === 'object'
    ? {
        pageTotal: numOrNull(metaRaw.deepScan.pageTotal),
        lastPage: numOrNull(metaRaw.deepScan.lastPage),
        dated: numOrNull(metaRaw.deepScan.dated),
        total: numOrNull(metaRaw.deepScan.total),
        done: metaRaw.deepScan.done === true,
      }
    : null;
  const meta = {
    profiles: arr(metaRaw.profiles).map((entry) => ({
      key: text(entry && entry.key),
      source: text(entry && entry.source).toLowerCase(),
      userKey: text(entry && entry.userKey),
      events: Math.max(0, toNum(entry && entry.events)),
      keptEvents: Math.max(0, toNum(entry && entry.keptEvents)),
      statusExcluded: Math.max(0, toNum(entry && entry.statusExcluded)),
      missingStatusId: Math.max(0, toNum(entry && entry.missingStatusId)),
      needsReimport: Boolean(entry && entry.needsReimport),
    })).filter((entry) => entry.source),
    statusFilter: metaRaw.statusFilter && typeof metaRaw.statusFilter === 'object'
      ? metaRaw.statusFilter
      : null,
  };

  return {
    connected: connected.length ? connected : [],
    profile: payloadProfile,
    profileSources: profileSourcesScoped,
    deepScan,
    meta,
    summary,
    ratings,
    genres,
    authors,
    series: series.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru')),
    decades,
    years,
    timeline: timeline.sort((a, b) => a.month.localeCompare(b.month)),
    readDays,
    recentlyFinished,
    recentlyReading,
    booksIndex,
    hasMangaField,
  };
}
