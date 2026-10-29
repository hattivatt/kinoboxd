/* Books tab: import screen, import progress, dashboard and modals.
 *
 * One module owns the whole book namespace: `/api/books/*` payload
 * normalisation, the per-profile import flow (one source + one account per
 * profile — LiveLib and Hardcover statistics are never merged), every widget
 * and the book-specific link menu. Film code is not imported here except for
 * the generic primitives (donut, modal shell, toasts, icons).
 *
 * Design notes:
 *  - a profile is one source: `/api/books/stats?profile=livelib-Margaret`;
 *    the switcher changes the profile, and the payload is rebuilt from that
 *    profile's events only (no `?sources=` chip any more);
 *  - no IndexedDB cache for books in the MVP: a cold start either returns
 *    stats or opens the import screen;
 *  - a LiveLib profile is created and refreshed **from a livelib-backup export
 *    file** (28.10.2026 verdict): «Обновить» opens the file panel, and the merge
 *    → auto-resolve pipeline runs there with its own spinner/result. No scrape
 *    of livelib.ru is ever started from this module;
 *  - the payload is parsed tolerantly: the quick API contract (`score`,
 *    `finished`, `reReadCount`, `summary.sources: [names]`) and the fuller
 *    doc version (`rating`, `read`, `decades[].decade`, `sources.connected`)
 *    are both accepted.
 */

import {
  getBooksStats, startBooksImportHardcover, getBooksImportStatus,
  getBooksProfiles, setBookMangaFlag, clearBookMangaFlag, importBooksLivelibFile,
  setBookYearOverride,
} from './api.js';
import {
  $, el, clear, fmtInt, fmtPercent, fmtRating, fmtPeriod, plural, icon, serviceIcon,
  monthName, monthShort, toNum, emptyState, errorBox, showTooltip, moveTooltip, hideTooltip,
  debounce, toast, shortErrorMessage,
} from './ui.js';
import { renderDonut, renderYearBars } from './charts.js';
import { openModal } from './modal.js';
import {
  renderBooksTimeline, renderReadingCalendar, renderStreaks, normalizeStreaks,
  fmtDayRu, fmtDayShortRu,
} from './books-charts.js';
import { snapshotCounts, refreshToastMessage, metadataBadge, withPreservedScroll } from './books-refresh.js';
import {
  LEGACY_ACCOUNTS_KEY, MAX_PROFILES,
  loadRegistry, listProfiles as listBooksProfiles, saveProfile as saveBooksProfile,
  removeProfile as removeBooksProfile, getProfile as getRegistryProfile, setActiveId as setActiveBooksProfileId,
  migrateLegacyAccounts, adoptServerProfiles, normalizeProfile, profileKey,
  profileSourceNames, profileSummary, sourceAccount,
  normalizeSource, isValidLivelibUsername, isValidHardcoverUser, scopeSourceNames,
  isLivelibBlocked,
} from './books-profiles.js';

/* =========================================================
   constants
   ========================================================= */

const SOURCE_LABEL = { livelib: 'LiveLib', hardcover: 'Hardcover' };
const SOURCE_MARK = { livelib: 'LL', hardcover: 'HC' };
/* Bibliographic metadata providers carried by `booksIndex[].metadataSources`.
 * Short marks only: one badge per row, the full name lives in the title. */
const METADATA_LABEL = {
  hardcover: ['HC', 'Hardcover'],
  litres: ['ЛР', 'Литрес'],
  googlebooks: ['GB', 'Google Books'],
  openlibrary: ['OL', 'Open Library'],
  livelib: ['LL', 'LiveLib'],
  // The LiveLib card provider names itself `livelib-card` in details docs;
  // it is the same LiveLib source for the reader, so it shares the LL badge.
  'livelib-card': ['LL', 'LiveLib'],
};
const MANGA_STORAGE_KEY = 'kinoboxd.books.manga.v1';
const AUTHORS_INITIAL = 20;
const AUTHORS_BATCH = 60;
const AUTHORS_SEARCH_MIN = 30;
const JOBS_KEY = 'kinoboxd.books.jobs.v1';
const ACCOUNTS_KEY = LEGACY_ACCOUNTS_KEY;
const SORT_KEY = 'kinoboxd.books.sort.';
const POLL_INTERVAL = 1200;

const RATING_COLORS = [
  '#e8253f', '#f1553b', '#ff7a30', '#ffa42b', '#ffd23f',
  '#c9e64e', '#00e054', '#00c9a7', '#40bcf4', '#7b6bff',
];
const DECADE_COLORS = ['#00e054', '#40bcf4', '#ff8000', '#e8253f', '#b18cff', '#ffd166'];
const YEAR_COLORS = [
  '#00e054', '#40bcf4', '#ff8000', '#e8253f', '#b18cff', '#ffd166',
  '#00c9a7', '#f472b6', '#8ddb3f', '#7189ff', '#ff9e64', '#5eead4',
];

const STAGE_LABEL = {
  start: 'Запуск',
  init: 'Подготовка',
  prepare: 'Подготовка',
  queued: 'В очереди',
  scrape: 'Читаем страницы LiveLib',
  pages: 'Читаем страницы LiveLib',
  'livelib-bulk': 'Читаем полный список LiveLib',
  'livelib-rsc': 'Читаем дневник LiveLib',
  'livelib-deep': 'Датируем историю LiveLib',
  journal: 'Читаем журнал Hardcover',
  graphql: 'Читаем журнал Hardcover',
  'hardcover-journal': 'Читаем журнал Hardcover',
  fetch: 'Загружаем книги',
  resolve: 'Сопоставляем книги',
  match: 'Сопоставляем книги',
  enrich: 'Собираем метадату',
  details: 'Собираем метадату',
  done: 'Готово',
  failed: 'Ошибка',
};

/* =========================================================
   state
   ========================================================= */

const state = {
  active: false,
  loading: false,
  loaded: false,
  view: 'import', // import | progress | dashboard
  includeManga: false, // ?includeMangaComics=0|1, default off
  data: null,
  error: null,
  seq: 0,
  selectedDecade: null,
  jobs: {}, // source -> { jobId, status, failed, account, profileId }
  refresh: null, // { before, source, failures, startedAt } while "Обновить профиль" runs
  refreshStarting: false, // guards the profile fetch/baseline window before state.refresh exists
  starting: {},
  profiles: [],
  profilesReady: false,
  profile: null, // active local profile record
  profileMenuOpen: false,
  restoreCandidate: null, // server-side profiles adoptable (one per source)
  fileImport: { busy: false, result: null }, // livelib-backup export upload = LiveLib refresh
  pollTimer: 0,
  pollSeq: 0,
  metadataTimer: 0,
  mangaBusy: false,
  onActivate: null,
};

let openBookMenuClose = null;
let bookModalSeq = 0;
let inflightLoad = null;

/* Authors widget paging/search. Kept outside the payload so a refetch (manga
 * toggle) does not silently drop the user's query. */
const authorsState = { visible: AUTHORS_INITIAL, expanded: false, query: '' };

/* =========================================================
   small helpers
   ========================================================= */

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function firstString(...values) {
  for (const value of values) {
    const s = text(value);
    if (s) return s;
  }
  return '';
}

function safeStorageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode — the flow still works for this session */
  }
}

function safeStorageRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function readJson(key, fallback) {
  const raw = safeStorageGet(key);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function sourceLabel(source) {
  return SOURCE_LABEL[source] || 'Источник';
}

/* =========================================================
   payload normalisation
   ========================================================= */

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
  // Fallback for compact indexes that only keep the canonical work key:
  // `ll:<id>` / `ll-<id>` and `hc:<bookId>` are stable enough to build a link.
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

function normalizeEntry(workId, raw) {
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
  // `mangaComics` is tri-state: true / false / null (unknown). A missing field
  // (older payload) normalises to null too, so every consumer must treat
  // "no field" and "unknown" the same way instead of crashing.
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
    // Where `year` came from: `first` (provider first publication), `edition`
    // (honest fallback to the print run), `manual` (user correction) or null.
    yearSource: ['first', 'edition', 'manual'].includes(entry.yearSource) ? entry.yearSource : null,
    yearOverride: numOrNull(entry.yearOverride),
    firstPublishedYear: numOrNull(entry.firstPublishedYear),
    firstPublishedYearSource: text(entry.firstPublishedYearSource) || '',
    // The print run in hand (kept apart from the work's first publication).
    editionYear: numOrNull(entry.editionYear),
    // Which legacy channel supplied the edition year: `file` (the reader's own
    // «Год издания» column of the LiveLib export) or `details` (the print run
    // a metadata provider knows).
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

function normalizeBooks(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const summaryRaw = source.summary && typeof source.summary === 'object' ? source.summary : {};
  const connected = normalizeSources(source, summaryRaw);
  // Which profile documents did the server actually scope to? Kept separate
  // from `connected` (every profile cached on the server) so the header and the
  // sources metric describe *this* profile, not the whole cache.
  const profileSourcesScoped = scopeSourceNames(source.sources && source.sources.profiles);
  const ratingsRaw = source.ratings && typeof source.ratings === 'object' ? source.ratings : {};
  const booksIndexRaw = source.booksIndex && typeof source.booksIndex === 'object'
    ? source.booksIndex
    : {};
  // Compatibility probe: a payload from before the manga/comics round has no
  // `mangaComics` key at all. The toggle still renders, but its note says that
  // this import carries no such field instead of claiming "0 excluded".
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

  const publishers = arr(source.publishers).map((item) => ({
    name: text(item && item.name),
    count: Math.max(0, toNum(item && item.count)),
    works: normalizeWorksList(item && item.works),
  })).filter((item) => item.name && item.count > 0);

  const decades = arr(source.decades).map((item) => {
    const start = Math.round(toNum(item && (item.start ?? item.decade), 0));
    const label = firstString(item && item.label) || (start > 0 ? `${start}-е` : '');
    return {
      start,
      label,
      unknown: Boolean(item && item.unknown),
      ancient: Boolean(item && item.ancient),
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

  const years = arr(source.years).map((item) => ({
    year: Math.round(toNum(item && item.year, 0)),
    count: Math.max(0, toNum(item && item.count)),
    firstCount: Math.max(0, toNum(item && item.firstCount)),
    editionCount: Math.max(0, toNum(item && item.editionCount)),
    manualCount: Math.max(0, toNum(item && item.manualCount)),
  })).filter((item) => item.year > 0 && item.count > 0);

  const timeline = arr(source.timeline).map((item) => ({
    month: text(item && item.month),
    // The bar counts every read of that month: exact-day events plus
    // month-only ones (LiveLib stores only {year, month} for part of the
    // history). Days never enter the calendar/streaks.
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

  // «Читаю сейчас»: no finish date by design. The card carries only the start
  // date when the source knows it; the strip renders a badge instead of a date.
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

  // Metadata coverage of the active profile (resolve chain). `null` on a
  // legacy payload: the badge stays hidden instead of claiming 100%.
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

  // First-publication-year backfill progress (round 29.10.2026). `null` on a
  // legacy payload: the years note then keeps its old wording instead of
  // promising a queue that the server did not report.
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
  // Per-profile audit (one entry under the single-profile contract). Kept for
  // the «⚑ переимпорт HC» note: a journal saved before `statusId` existed.
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
    publishers: publishers.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru')),
    decades,
    years,
    timeline: timeline.sort((a, b) => a.month.localeCompare(b.month)),
    readDays,
    streaks: normalizeStreaks(source.streaks, readDays),
    recentlyFinished,
    recentlyReading,
    booksIndex,
    hasMangaField,
  };
}

/* =========================================================
   view switching inside the books section
   ========================================================= */

/**
 * Topbar refresh button visibility/busy state.
 *
 * Visible only on the books tab (the whole section is hidden on Films anyway)
 * when the *active local profile* has at least one source, and during its own
 * progress screen so the user still sees the spinner they started.
 *
 * The button is the *Hardcover* job entry point: a LiveLib profile has no
 * server job for its refresh, so the click opens the export-file panel and the
 * upload form's own spinner takes over.
 */
function updateRefreshButton() {
  const refresh = $('books-refresh');
  if (!refresh) return;
  const busy = Boolean(state.refresh || state.refreshStarting);
  const sources = activeProfileSources();
  const livelib = sources.includes('livelib') && !sources.includes('hardcover');
  const viewAllows = state.view === 'dashboard' || (state.view === 'progress' && busy);
  refresh.hidden = !(sources.length && viewAllows);
  refresh.disabled = busy;
  refresh.classList.toggle('is-busy', busy);
  refresh.setAttribute('aria-busy', busy ? 'true' : 'false');
  const spinner = $('books-refresh-spinner');
  if (spinner) spinner.hidden = !busy;
  const label = $('books-refresh-label');
  if (label) {
    label.textContent = busy ? 'Обновляем…' : livelib ? 'Обновить LiveLib' : 'Обновить профиль';
  }
  if (sources.length) {
    const scope = sources.map(sourceLabel).join('');
    refresh.title = sourceScopeTitle(sources);
    refresh.setAttribute('aria-label', `Обновить профиль: ${scope}`);
  }
  const reimport = $('books-reimport');
  if (reimport) reimport.hidden = state.view !== 'dashboard' || busy;
}

/** Honest tooltip for the scoped refresh (never promises the other source). */
function sourceScopeTitle(sources) {
  const hardcover = sources.includes('hardcover');
  const livelib = sources.includes('livelib');
  if (livelib) {
    return 'Обновить профиль LiveLib: загрузите свежую выгрузку livelib-backup. Скрейп livelib.ru не выполняется.';
  }
  if (hardcover) {
    return 'Обновить профиль Hardcover: только новое с прошлой синхронизации (~2 с). Shift+клик — полная перепроверка журнала.';
  }
  return 'Обновить профиль';
}

function showScreen(name) {
  const previous = state.view;
  state.view = name;
  const screens = {
    import: $('books-import'),
    progress: $('books-progress'),
    dashboard: $('books-dash'),
  };
  for (const [key, node] of Object.entries(screens)) {
    if (node) node.hidden = key !== name;
  }
  const bar = $('books-profile-bar');
  if (bar) bar.hidden = name === 'progress';
  if (name !== 'dashboard') stopMetadataPolling();
  updateRefreshButton();
  const back = $('books-progress-back');
  if (back) back.hidden = Boolean(state.refresh);
  // `onActivate` is main.js's `showView('books')`, which ends with
  // `window.scrollTo(0, 0)`. Calling it on every render made the metadata
  // poller (every ~5 s) throw the user back to the top of the dashboard
  // (user report, 28.10.2026). Only a real screen change may activate.
  if (previous !== name && state.active && state.onActivate) state.onActivate();
}

function showLoading(visible) {
  const node = $('books-loading');
  if (node) node.hidden = !visible;
}

function showError(error, options = {}) {
  const host = $('books-error');
  if (!host) return;
  state.error = error;
  clear(host);
  if (!error) {
    host.hidden = true;
    return;
  }
  host.append(errorBox({
    title: options.title || 'Не удалось загрузить книжную статистику',
    message: options.message || shortErrorMessage(error),
    actions: options.actions || [
      { label: 'Повторить', primary: true, onClick: () => loadStats({ force: true }) },
    ],
  }));
  host.hidden = false;
}

/* =========================================================
   data loading
   ========================================================= */

async function loadStats({ force = false, silent = false } = {}) {
  if (state.loading) {
    if (!force) return;
    // A forced reload (source chip / manga toggle) must not be swallowed by an
    // in-flight request: wait for it, then re-run with the newest state.
    if (inflightLoad) {
      try {
        await inflightLoad;
      } catch {
        /* the inner run reports its own errors */
      }
    }
  }
  const run = loadStatsRun({ force, silent });
  inflightLoad = run;
  try {
    return await run;
  } finally {
    if (inflightLoad === run) inflightLoad = null;
  }
}

async function loadStatsRun({ force = false, silent = false } = {}) {
  if (state.loaded && !force && !silent) return;
  const seq = ++state.seq;
  state.loading = true;
  state.error = null;
  if (!silent) showError(null);
  if (!silent && state.view !== 'dashboard') showLoading(true);

  if (!state.profile || !activeProfileSources().length) {
    // No local profile → no scope. Never fall back to "everything the server
    // has": that is exactly the cross-device leak this round removes.
    state.loading = false;
    state.loaded = false;
    state.data = null;
    showLoading(false);
    hideJobs();
    renderMetadataBadge(null);
    showScreen('import');
    updateRefreshButton();
    renderProfileSwitcher();
    return;
  }

  try {
    const raw = await getBooksStats({
      profile: activeProfileKey(),
      includeMangaComics: state.includeManga,
    });
    if (seq !== state.seq) return;
    state.data = normalizeBooks(raw);
    updateRefreshButton();
    state.loaded = true;
    state.selectedDecade = null;
    if (!state.data.summary.eventCount && !state.data.connected.length) {
      // Nothing imported (or every source is empty): the honest state is the
      // two import cards, not a dashboard full of zeroes.
      state.loaded = false;
      showScreen('import');
      return;
    }
    hideJobs();
    showScreen('dashboard');
    // A silent background re-render (metadata badge poller, deep scan finish)
    // must not move the page: the dashboard is rebuilt wholesale, so restore
    // the window scroll explicitly.
    if (silent) {
      withPreservedScroll(
        () => (typeof window !== 'undefined' ? window.scrollY || 0 : 0),
        (y) => window.scrollTo(0, y),
        () => renderDashboardBooks(state.data)
      );
    } else {
      renderDashboardBooks(state.data);
    }
  } catch (error) {
    if (seq !== state.seq) return;
    if (error && error.status === 401) return; // auth view takes over
    if (error && (error.status === 404 || error.status === 400)) {
      state.loaded = false;
      state.data = null;
      if (hasJobs()) {
        showScreen('progress');
        renderProgress();
        startPolling();
      } else {
        showScreen('import');
      }
      return;
    }
    if (state.data) {
      // Keep the last rendered dashboard but say the refresh failed.
      toast(shortErrorMessage(error), 'error', { duration: 7000 });
      return;
    }
    showScreen('import');
    showError(error);
  } finally {
    if (seq === state.seq) {
      state.loading = false;
      showLoading(false);
    }
  }
}

/* =========================================================
   local profile registry (one book profile per browser context)
   ========================================================= */

/** Source account from the active profile ('' when the source is detached). */
function profileAccount(source) {
  return sourceAccount(state.profile, source);
}

function activeProfileSources() {
  return state.profile ? profileSourceNames(state.profile) : [];
}

function activeProfileKey() {
  return state.profile ? profileKey(state.profile) : '';
}

function profileSavedLabel(savedAt) {
  const ts = Number(savedAt);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return 'сохранён только что';
  if (diff < 60 * 60 * 1000) {
    const minutes = Math.max(1, Math.round(diff / 60000));
    return `сохранён ${minutes} ${plural(minutes, ['минуту', 'минуты', 'минут'])} назад`;
  }
  if (diff < 24 * 60 * 60 * 1000) {
    const hours = Math.max(1, Math.round(diff / 3600000));
    return `сохранён ${hours} ${plural(hours, ['час', 'часа', 'часов'])} назад`;
  }
  const days = Math.max(1, Math.round(diff / 86400000));
  if (days < 8) return `сохранён ${days} ${plural(days, ['день', 'дня', 'дней'])} назад`;
  const date = new Date(ts);
  return `сохранён ${date.getDate()}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
}

/**
 * Fill the import inputs from the active profile. Empty profile → empty fields:
 * the old hardcoded `34748` / «Margaret» defaults are gone on purpose.
 */
function applyProfileToForms() {
  const livelibFile = $('books-livelib-file-user');
  if (livelibFile) livelibFile.value = profileAccount('livelib');
  const hardcover = $('books-hardcover-userid');
  if (hardcover) hardcover.value = profileAccount('hardcover');
}

function renderProfileMenuRow(profile) {
  const active = Boolean(state.profile && state.profile.id === profile.id);
  const item = el('div', {
    class: `profile-item${active ? ' is-active' : ''}`,
    role: 'option',
    'aria-selected': active ? 'true' : 'false',
    dataset: { profileId: profile.id },
  });
  const pick = el('button', {
    type: 'button',
    class: 'profile-pick',
    title: `${profile.label} · ${profileSummary(profile)}`,
  });
  const copy = el('span', { class: 'profile-copy' });
  copy.append(el('span', { class: 'profile-name', text: profile.label }));
  const saved = profileSavedLabel(profile.savedAt);
  const summary = profileSummary(profile);
  copy.append(el('span', {
    class: 'profile-meta',
    text: summary || saved,
    title: [summary, saved].filter(Boolean).join(' · '),
  }));
  pick.append(copy);
  if (active) pick.append(el('span', { class: 'profile-check', html: icon('check', 14) }));
  pick.addEventListener('click', () => {
    closeProfileMenu();
    switchProfile(profile.id);
  });

  const del = el('button', {
    type: 'button',
    class: 'profile-del',
    title: 'Удалить профиль',
    'aria-label': `Удалить профиль ${profile.label}`,
    html: icon('trash', 14),
  });
  del.addEventListener('click', (event) => {
    event.stopPropagation();
    deleteProfile(profile.id);
  });

  item.append(pick, del);
  return item;
}

function renderProfileSwitcher() {
  const switcher = $('books-profile-switcher');
  const label = $('books-profile-btn-label');
  const profiles = Array.isArray(state.profiles) ? state.profiles : [];
  if (label) {
    label.textContent = state.profile ? state.profile.label : 'Профиль';
    label.title = state.profile ? state.profile.label : 'Книжные профили на этом устройстве';
  }
  if (switcher) switcher.classList.toggle('has-active', Boolean(state.profile));

  const list = $('books-profile-list');
  if (list) {
    clear(list);
    if (!profiles.length) {
      list.append(el('div', { class: 'profile-empty', text: 'Пока нет книжных профилей' }));
    } else {
      for (const profile of profiles) list.append(renderProfileMenuRow(profile));
    }
  }
  const add = $('books-profile-add');
  if (add) add.disabled = profiles.length >= MAX_PROFILES;

  const empty = $('books-profile-empty');
  if (empty) {
    empty.hidden = profiles.length > 0;
    const previous = empty.querySelector('.books-profile-restore');
    if (previous) previous.remove();
    if (!profiles.length) {
      const candidates = Array.isArray(state.restoreCandidate) ? state.restoreCandidate : [];
      if (candidates.length) {
        const restore = el('button', {
          type: 'button',
          class: 'btn btn-ghost books-profile-restore',
          text: `Подключить серверные профили (${candidates.map((profile) => profileSummary(profile)).join(' · ')})`,
          title: 'На сервере уже есть импортированные профили — перенести их в этот браузер (каждый — отдельный профиль)',
        });
        restore.addEventListener('click', () => adoptRestoreCandidate());
        empty.append(restore);
      }
    }
  }

  const hint = $('books-profile-hint');
  if (hint) {
    const sources = activeProfileSources();
    hint.hidden = !sources.length;
    if (sources.length) {
      hint.textContent = `Запрос ограничен профилем: ${profileSummary(state.profile)}. Данные хранятся на сервере, профиль — в этом браузере.`;
    }
  }
  const bar = $('books-profile-bar');
  if (bar) bar.hidden = state.view === 'progress';
}

function setProfileMenuOpen(open) {
  state.profileMenuOpen = Boolean(open);
  const menu = $('books-profile-menu');
  const button = $('books-profile-btn');
  const switcher = $('books-profile-switcher');
  if (menu) menu.hidden = !state.profileMenuOpen;
  if (button) button.setAttribute('aria-expanded', state.profileMenuOpen ? 'true' : 'false');
  if (switcher) switcher.classList.toggle('is-open', state.profileMenuOpen);
}

function closeProfileMenu() {
  if (state.profileMenuOpen) setProfileMenuOpen(false);
}

/**
 * Load the local registry once per page (and re-read after create/delete).
 * First run migrates *real* remembered accounts from the old localStorage
 * blob (one profile per account); nothing is invented, and a server-only
 * install is offered as an explicit «Подключить серверные профили» action
 * instead of being adopted silently (a second laptop must stay empty).
 */
async function ensureProfiles({ reload = false } = {}) {
  if (state.profilesReady && !reload) return;
  let snapshot = { profiles: [], active: null };
  try {
    snapshot = await loadRegistry();
  } catch {
    snapshot = { profiles: [], active: null };
  }
  state.profiles = snapshot.profiles;
  state.profile = snapshot.active;

  if (!state.profiles.length) {
    const legacy = readJson(ACCOUNTS_KEY, null);
    const migrated = migrateLegacyAccounts(legacy);
    if (migrated.length) {
      let saved = null;
      for (const record of migrated) {
        saved = await saveBooksProfile(record);
      }
      state.profile = saved;
      setActiveBooksProfileId(saved.id);
      state.profiles = await listBooksProfiles();
      safeStorageRemove(ACCOUNTS_KEY);
      toast(
        migrated.length > 1
          ? `Книжные профили восстановлены: ${migrated.map((record) => record.label).join(', ')}`
          : `Книжный профиль восстановлен: ${saved.label}`,
        'info',
        { duration: 5200 }
      );
    }
  }
  if (!state.profiles.length) {
    try {
      const server = await getBooksProfiles();
      state.restoreCandidate = adoptServerProfiles(server && server.profiles);
    } catch {
      state.restoreCandidate = [];
    }
  } else {
    state.restoreCandidate = [];
  }

  state.profilesReady = true;
  applyProfileToForms();
  renderProfileSwitcher();
}

async function adoptRestoreCandidate() {
  const candidates = Array.isArray(state.restoreCandidate) ? state.restoreCandidate : [];
  if (!candidates.length) return;
  let saved = null;
  for (const candidate of candidates) {
    saved = await saveBooksProfile(candidate);
  }
  state.restoreCandidate = [];
  state.profile = saved;
  setActiveBooksProfileId(saved.id);
  await ensureProfiles({ reload: true });
  state.loaded = false;
  await loadStats({ force: true });
  toast(
    candidates.length > 1
      ? `Подключено профилей: ${candidates.length} (${candidates.map((record) => record.label).join(', ')})`
      : `Профиль подключён: ${saved.label}`,
    'success',
    { duration: 4600 }
  );
}

async function switchProfile(id) {
  const profile = state.profiles.find((item) => item.id === id) || await getRegistryProfile(id);
  if (!profile) return;
  if (state.profile && state.profile.id === profile.id) return;
  if (hasRunningJobs()) {
    toast('Дождитесь окончания импорта или обновите страницу', 'info', { duration: 5200 });
    return;
  }
  state.profile = profile;
  setActiveBooksProfileId(profile.id);
  state.data = null;
  state.loaded = false;
  state.selectedDecade = null;
  state.seq += 1; // drop any in-flight payload of the previous profile
  applyProfileToForms();
  renderProfileSwitcher();
  renderMetadataBadge(null);
  hideJobs();
  if (!activeProfileSources().length) {
    showScreen('import');
    return;
  }
  showScreen('import');
  await loadStats({ force: true });
}

async function deleteProfile(id) {
  const profile = state.profiles.find((item) => item.id === id);
  if (!profile) return;
  const running = jobList().filter(([, job]) => job && job.profileId === id && !job.failed &&
    !(job.status && (job.status.done || job.status.stage === 'done')));
  if (running.length) {
    toast('По этому профилю идёт импорт — дождитесь завершения', 'info', { duration: 5200 });
    return;
  }
  const question = `Удалить профиль «${profile.label}»? Данные источников останутся на сервере — профиль можно создать заново.`;
  if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(question)) return;
  await removeBooksProfile(id);
  const wasActive = Boolean(state.profile && state.profile.id === id);
  await ensureProfiles({ reload: true });
  if (wasActive) {
    state.profile = state.profiles[0] || null;
    setActiveBooksProfileId(state.profile ? state.profile.id : null);
    state.data = null;
    state.loaded = false;
    applyProfileToForms();
    renderProfileSwitcher();
    if (state.profile && activeProfileSources().length) await loadStats({ force: true });
    else showScreen('import');
  } else {
    renderProfileSwitcher();
  }
  toast(`Профиль «${profile.label}» удалён`, 'info', { duration: 4200 });
}

function hasRunningJobs() {
  return jobList().some(([, job]) => job && !job.failed &&
    !(job.status && (job.status.done || job.status.stage === 'done')));
}

/**
 * Create the profile lazily from a single import card. This is the "first
 * import without a profile" path: the label is derived from the account that
 * the user actually typed, so no default owner is ever implied.
 */
/**
 * Profile for an import: a profile is one source + one account, so this
 * returns the active profile when it already IS that account, and otherwise
 * creates (and activates) a separate profile. Importing Hardcover while a
 * LiveLib profile is active must never union the two.
 *
 * The label is derived from the account the user typed, so no default owner
 * is ever implied.
 */
async function ensureProfileForImport(source, account) {
  const entry = normalizeSource(source, account);
  if (!entry) return null;
  const key = entry.source === 'livelib' ? `livelib-${entry.username}` : `hardcover-${entry.userId}`;
  if (state.profile && profileKey(state.profile) === key) return state.profile;

  // Reuse an existing local profile for the same account instead of
  // duplicating switcher entries.
  const existing = (state.profiles || []).find((profile) => profileKey(profile) === key);
  const record = existing || normalizeProfile({
    label: entry.source === 'livelib' ? `LiveLib @${entry.username}` : `Hardcover ${entry.userId}`,
    sources: [entry],
  });
  const saved = existing
    ? existing
    : await saveBooksProfile(record);
  state.profile = saved;
  setActiveBooksProfileId(saved.id);
  await ensureProfiles({ reload: true });
  state.profile = state.profiles.find((profile) => profile.id === saved.id) || saved;
  applyProfileToForms();
  renderProfileSwitcher();
  return state.profile;
}

/* =========================================================
   profile creation modal
   ========================================================= */

function openProfileModal(draft = {}) {
  closeProfileMenu();
  const titleId = 'books-profile-modal-title';
  const head = el('div', { class: 'modal-head' },
    el('div', {},
      el('h2', { class: 'modal-title', id: titleId, text: 'Новый книжный профиль' }),
      el('span', { class: 'modal-note', text: 'Живёт в этом браузере; данные источников остаются на сервере' }),
    ),
  );
  const body = el('div', { class: 'modal-body' });
  const form = el('form', { class: 'books-profile-form', novalidate: true });

  const labelInput = el('input', {
    class: 'books-input',
    id: 'books-profile-label',
    type: 'text',
    maxlength: '48',
    autocomplete: 'off',
    placeholder: 'например, «Мой профиль»',
    value: draft.label || '',
  });
  form.append(el('label', { class: 'books-field', for: 'books-profile-label' },
    el('span', { class: 'books-field-label' }, 'Название', el('span', {}, 'как удобно')),
    labelInput,
  ));

  const sourcesBox = el('div', { class: 'books-profile-sources' });
  sourcesBox.append(el('div', {
    class: 'books-profile-sources-title',
    text: 'Источник (один на профиль)',
  }));
  sourcesBox.append(el('p', {
    class: 'books-profile-form-note',
    text: 'Профиль — это один аккаунт одного сервиса: статистика LiveLib и Hardcover не смешивается. ' +
      'Для второго аккаунта создайте отдельный профиль и переключайтесь между ними.',
  }));

  const livelibInput = el('input', {
    class: 'books-input',
    id: 'books-profile-livelib',
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'username, livelib.ru/reader/…',
    value: draft.livelib || '',
  });
  sourcesBox.append(el('label', { class: 'books-field', for: 'books-profile-livelib' },
    el('span', { class: 'books-field-label' }, 'LiveLib', el('span', {}, 'livelib.ru/reader/<username>')),
    livelibInput,
  ));

  const hardcoverInput = el('input', {
    class: 'books-input',
    id: 'books-profile-hardcover',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'числовой ID профиля',
    value: draft.hardcover || '',
  });
  sourcesBox.append(el('label', { class: 'books-field', for: 'books-profile-hardcover' },
    el('span', { class: 'books-field-label' }, 'Hardcover', el('span', {}, 'hardcover.app/@<username>')),
    hardcoverInput,
  ));
  sourcesBox.append(el('p', {
    class: 'books-profile-form-note',
    text: 'Аккаунт Hardcover — из ссылки профиля. Токен API уже настроен на сервере, вводить его не нужно.',
  }));
  form.append(sourcesBox);

  const error = el('div', { class: 'books-source-error', role: 'alert', hidden: true });
  form.append(error);

  const submit = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Создать профиль' });
  const cancel = el('button', { type: 'button', class: 'btn btn-link', text: 'Отмена' });
  form.append(el('div', { class: 'books-profile-form-actions' }, submit, cancel));
  body.append(form);

  const modal = openModal({ head, body, labelledBy: titleId, className: 'modal-films modal-books' });
  const close = () => {
    if (modal && typeof modal.close === 'function') modal.close();
  };
  cancel.addEventListener('click', close);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    const label = text(labelInput.value);
    const livelibRaw = text(livelibInput.value).replace(/^@/, '');
    const hardcoverRaw = text(hardcoverInput.value);
    const sources = [];
    if (livelibRaw) {
      const entry = normalizeSource('livelib', livelibRaw);
      if (!entry) {
        error.textContent = 'Имя пользователя LiveLib: латиница, цифры, «_», «.», «-» (или ссылка /reader/…).';
        error.hidden = false;
        livelibInput.focus();
        return;
      }
      sources.push(entry);
    }
    if (hardcoverRaw) {
      const entry = normalizeSource('hardcover', hardcoverRaw);
      if (!entry) {
        error.textContent = 'ID пользователя Hardcover — это число из ссылки профиля.';
        error.hidden = false;
        hardcoverInput.focus();
        return;
      }
      sources.push(entry);
    }
    if (!sources.length) {
      error.textContent = 'Укажите один источник: LiveLib или Hardcover.';
      error.hidden = false;
      livelibInput.focus();
      return;
    }
    if (sources.length > 1) {
      error.textContent =
        'Один профиль — один источник. Создайте отдельный профиль для LiveLib и для Hardcover: ' +
        'их статистика не смешивается.';
      error.hidden = false;
      hardcoverInput.focus();
      return;
    }
    if (!label) {
      // Never invent a profile name: normalizeProfile falls back to the
      // account itself (@name / id).
    }
    const record = normalizeProfile({ label, sources });
    submit.disabled = true;
    try {
      await saveBooksProfile(record);
      state.profile = record;
      setActiveBooksProfileId(record.id);
      await ensureProfiles({ reload: true });
      state.data = null;
      state.loaded = false;
      state.seq += 1;
      applyProfileToForms();
      renderProfileSwitcher();
      close();
      showScreen('import');
      toast(`Профиль «${record.label}» создан — запустите импорт источников`, 'success', { duration: 6000 });
      // If the server already has these sources (old install, cleared
      // localStorage), the dashboard can appear right away; otherwise the
      // request answers 404 and the import screen stays.
      await loadStats({ force: true });
    } catch (err) {
      error.textContent = shortErrorMessage(err);
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });

  window.setTimeout(() => labelInput.focus(), 30);
  return modal;
}

/* =========================================================
   LiveLib export FILE import (livelib-backup, safe path)
   ========================================================= */

/* The LiveLib 403 → cookie panel and the scrape form are gone (28.10.2026):
 * a LiveLib profile is imported and refreshed from a `livelib-backup` export
 * file, so the browser never waits on a scrape and the server never touches
 * livelib.ru. The server keeps the scrape endpoint for the job tests and as the
 * documented plan-B escape hatch of §9, but nothing here calls it. */

/** Same ceiling as the route's multer limit; the browser can refuse earlier. */
const FILE_IMPORT_MAX_BYTES = 24 * 1024 * 1024;

/** RU labels of the four exportable shelves. */
const SHELF_LABEL = {
  read: 'Прочитал',
  dnf: 'Не дочитал',
  reading: 'Читаю сейчас',
  wish: 'Хочу прочитать',
};

function setFileImportError(message) {
  const host = $('books-livelib-file-error');
  if (!host) return;
  if (!message) {
    host.textContent = '';
    host.hidden = true;
    return;
  }
  host.textContent = message;
  host.hidden = false;
}

function setFileImportBusy(busy) {
  state.fileImport.busy = Boolean(busy);
  const spinner = $('books-livelib-file-spinner');
  if (spinner) spinner.hidden = !busy;
  const button = $('books-livelib-file-submit');
  if (button) {
    button.disabled = Boolean(busy);
    button.classList.toggle('is-busy', Boolean(busy));
  }
}

function renderFileImportResult(result) {
  const host = $('books-livelib-file-result');
  if (!host) return;
  clear(host);
  if (!result) {
    host.hidden = true;
    return;
  }
  const shelf = SHELF_LABEL[result.shelf] || result.shelf || '';
  const head = el('div', { class: 'books-file-result-head' },
    el('span', { class: 'books-file-result-title', text: `Файл принят: ${fmtInt(result.imported)} ${plural(result.imported, ['книга', 'книги', 'книг'])}` }),
    shelf ? el('span', { class: 'books-file-result-shelf', text: `полка «${shelf}»` }) : null,
  );
  host.append(head);
  host.append(el('p', {
    class: 'books-file-result-meta',
    text: [
      `+${fmtInt(result.added)} ${plural(result.added, ['новая', 'новые', 'новых'])}`,
      `${fmtInt(result.enriched)} ${plural(result.enriched, ['обогащена', 'обогащены', 'обогащено'])}`,
      `${fmtInt(result.skipped)} без изменений`,
      `всего событий: ${fmtInt(result.events)}`,
      String(result.format || '').toUpperCase(),
    ].filter(Boolean).join(' · '),
  }));
  const shelves = result.shelves && typeof result.shelves === 'object' ? result.shelves : null;
  if (shelves) {
    const parts = ['read', 'dnf', 'reading', 'wish']
      .map((key) => `${SHELF_LABEL[key]} ${fmtInt(shelves[key] || 0)}`);
    host.append(el('p', { class: 'books-file-result-shelves', text: parts.join(' · ') }));
  }
  if (Array.isArray(result.warnings) && result.warnings.length) {
    const list = el('ul', { class: 'books-file-warnings' });
    for (const warning of result.warnings) list.append(el('li', { text: String(warning) }));
    host.append(list);
  }
  if (result.resolve) {
    host.append(el('p', {
      class: 'books-file-result-meta',
      text: 'Метадата догружается в фоне — прогресс виден в бейдже «Метадата».',
    }));
  }
  host.hidden = false;
}

/**
 * Upload one exported shelf. Multipart, one shot for the parse: the server
 * merges the file into `livelib-{username}` and answers 201 with the counts.
 * Nothing is scraped from livelib.ru, but the metadata chain (Hardcover /
 * Литрес / GB / OL) starts automatically after the merge — the same background
 * resolve job a scraped import runs. Its progress is the «Метадата: N%» badge,
 * and the stats poller re-renders quietly while it is alive.
 */
async function submitFileImport() {
  if (state.fileImport.busy) return;
  const input = $('books-livelib-file');
  const userInput = $('books-livelib-file-user');
  const shelfInput = $('books-livelib-file-shelf');
  const resolveInput = $('books-livelib-file-resolve');
  const file = input && input.files && input.files[0] ? input.files[0] : null;

  const username = text(userInput && userInput.value) || profileAccount('livelib');
  const fail = (message, focus) => {
    setFileImportError(message);
    if (focus && focus.focus) focus.focus();
  };
  setFileImportError('');
  renderFileImportResult(null);

  if (!username) {
    fail('Введите имя пользователя LiveLib — файл попадёт в этот профиль.', userInput);
    return;
  }
  if (!isValidLivelibUsername(username)) {
    fail('Имя пользователя LiveLib: латиница, цифры, «_», «.», «-».', userInput);
    return;
  }
  if (!file) {
    fail('Выберите файл экспорта (.json или .csv).', input);
    return;
  }
  if (!/\.(json|csv)$/i.test(file.name || '')) {
    fail('Нужен файл .json или .csv — так выгружает livelib-backup.', input);
    return;
  }
  if (file.size > FILE_IMPORT_MAX_BYTES) {
    fail('Файл больше 24 МБ — проверьте, что это одна страница полки, а не архив.', input);
    return;
  }

  setFileImportBusy(true);
  try {
    const result = await importBooksLivelibFile({
      file,
      username,
      shelf: text(shelfInput && shelfInput.value),
      // Default ON (the file import always enriches); the checkbox is the
      // explicit opt-out for an offline import.
      resolve: !resolveInput || resolveInput.checked,
    });
    renderFileImportResult(result);
    // The browser registry owns the switcher entry; the server owns the events.
    await ensureProfileForImport('livelib', username);
    if (input) input.value = '';
    const fileName = $('books-livelib-file-name');
    if (fileName) {
      fileName.textContent = 'Файл не выбран';
      fileName.classList.remove('is-set');
    }
    state.loaded = false;
    await loadStats({ force: true });
    const parts = [
      `Файл импортирован: ${fmtInt(result.imported)} ${plural(result.imported, ['книга', 'книги', 'книг'])}`,
      `+${fmtInt(result.added)} новых`,
    ];
    if (result.enriched) parts.push(`${fmtInt(result.enriched)} обогащено`);
    toast(parts.join(' · '), 'success', { duration: 6000 });
  } catch (error) {
    if (error && error.status === 401) return;
    // `shortErrorMessage` turns *any* 400 into "данные не готовы", which is the
    // film-payload wording. A file-import 400 is specific and useful (bad
    // columns, empty file, unknown shelf), so the server text is shown as is.
    const message = error && error.name === 'ApiError' && text(error.message)
      ? text(error.message)
      : shortErrorMessage(error);
    setFileImportError(message);
    toast(`Файл не импортирован: ${message}`, 'error', { duration: 8000 });
  } finally {
    setFileImportBusy(false);
  }
}

/* =========================================================
   import jobs
   ========================================================= */

function jobList() {
  return Object.entries(state.jobs).filter(([, job]) => job && job.jobId);
}

function hasJobs() {
  return jobList().length > 0;
}

function saveJobs() {
  const list = jobList().map(([source, job]) => ({
    source,
    jobId: job.jobId,
    account: job.account || '',
    profileId: job.profileId || (state.profile && state.profile.id) || '',
    startedAt: job.startedAt || Date.now(),
  }));
  if (!list.length) safeStorageRemove(JOBS_KEY);
  else safeStorageSet(JOBS_KEY, JSON.stringify(list));
}

function hydrateJobs() {
  if (hasJobs()) return;
  const saved = readJson(JOBS_KEY, null);
  if (!Array.isArray(saved)) return;
  for (const item of saved) {
    const source = text(item && item.source).toLowerCase();
    const jobId = text(item && item.jobId);
    if (!SOURCE_LABEL[source] || !jobId) continue;
    state.jobs[source] = {
      jobId,
      account: text(item.account),
      profileId: text(item.profileId),
      status: null,
      failed: null,
      startedAt: Number(item.startedAt) || Date.now(),
    };
  }
  // A job restored from localStorage belongs to the profile that started it.
  // Keeping a foreign job would attach its progress (and its "done" reload) to
  // whichever profile happens to be active after a reload.
  for (const [source, job] of Object.entries(state.jobs)) {
    if (job.profileId && (!state.profile || job.profileId !== state.profile.id)) {
      delete state.jobs[source];
    }
  }
  if (hasJobs()) saveJobs();
}

function hideJobs() {
  stopPolling();
  state.jobs = {};
  saveJobs();
}

function setSourceBusy(source, busy) {
  state.starting[source] = busy;
  const spinner = $(`books-${source}-spinner`);
  if (spinner) spinner.hidden = !busy;
  const button = $(`books-${source}-submit`);
  if (button) {
    button.disabled = busy;
    button.classList.toggle('is-busy', busy);
  }
}

function setSourceError(source, message) {
  const host = $(`books-${source}-error`);
  if (!host) return;
  if (!message) {
    host.textContent = '';
    host.hidden = true;
    return;
  }
  host.textContent = message;
  host.hidden = false;
}

/**
 * Start the Hardcover import *inside the active profile*.
 *
 * The account becomes the profile's only source (a profile is created or
 * activated lazily on the first import), so a fresh browser never imports into
 * "someone else's" record and the `profile=` scope keeps matching the request.
 *
 * LiveLib has no source-import job any more: its profile is created by the
 * export-file form (`submitFileImport`), which owns its own spinner/result.
 *
 * @returns {Promise<{ok:boolean}>}
 */
async function startImport(source, account) {
  if (state.starting[source]) return { ok: false };
  setSourceError(source, '');
  setSourceBusy(source, true);
  try {
    await ensureProfileForImport(source, account);

    const response = await startBooksImportHardcover(account);
    const jobId = text(response && (response.jobId || response.job_id || response.id || (response.job && response.job.id)));

    if (!jobId) {
      // Some server versions can answer "already done" without a job id.
      if (response && (response.done || response.stage === 'done')) {
        hideJobs();
        await loadStats({ force: true });
        return { ok: true };
      }
      throw new Error('Сервер не вернул идентификатор задачи импорта.');
    }

    state.jobs[source] = {
      jobId,
      account,
      profileId: state.profile ? state.profile.id : '',
      status: response && typeof response === 'object' ? response : null,
      failed: null,
      startedAt: Date.now(),
    };
    saveJobs();
    showScreen('progress');
    renderProgress();
    startPolling();
    return { ok: true };
  } catch (error) {
    if (error && error.status === 401) return { ok: false };
    setSourceError(source, shortErrorMessage(error));
    toast(`Не удалось запустить импорт ${sourceLabel(source)}`, 'error', { duration: 6500 });
    return { ok: false };
  } finally {
    setSourceBusy(source, false);
  }
}

function progressPercent(status) {
  if (!status) return 0;
  const doneFlag = status.done || status.stage === 'done';
  const percentValue = numOrNull(status.percent);
  if (percentValue != null) {
    return Math.max(doneFlag ? 100 : 2, Math.min(100, Math.round(percentValue)));
  }
  const page = numOrNull(status.page ?? status.current);
  const pageTotal = numOrNull(status.pageTotal ?? status.totalPages ?? status.pagesTotal ?? status.pages);
  if (page != null && pageTotal && pageTotal > 0) {
    return Math.max(2, Math.min(100, Math.round((page / pageTotal) * 100)));
  }
  const batch = numOrNull(status.batch ?? status.batchIndex);
  const batchTotal = numOrNull(status.batchTotal ?? status.batchesTotal ?? status.batches);
  if (batch != null && batchTotal && batchTotal > 0) {
    return Math.max(2, Math.min(100, Math.round((batch / batchTotal) * 100)));
  }
  return doneFlag ? 100 : 0;
}

function statusMeta(status) {
  if (!status) return '';
  const parts = [];
  const page = numOrNull(status.page ?? status.current);
  const pageTotal = numOrNull(status.pageTotal ?? status.totalPages ?? status.pagesTotal ?? status.pages);
  if (page != null && page > 0) {
    parts.push(pageTotal ? `страница ${fmtInt(page)} из ${fmtInt(pageTotal)}` : `страница ${fmtInt(page)}`);
  }
  const batch = numOrNull(status.batch ?? status.batchIndex);
  const batchTotal = numOrNull(status.batchTotal ?? status.batchesTotal ?? status.batches);
  if (batch != null && batch > 0) {
    parts.push(batchTotal ? `батч ${fmtInt(batch)} из ${fmtInt(batchTotal)}` : `батч ${fmtInt(batch)}`);
  }
  const events = Array.isArray(status.events) ? status.events.length : numOrNull(status.events);
  if (events != null) parts.push(`${fmtInt(events)} ${plural(events, ['событие', 'события', 'событий'])}`);
  return parts.join(' · ');
}

function stageText(source, job) {
  const status = job && job.status;
  if (job && job.failed) return 'Импорт прервался';
  if (!status) return 'Запускаем…';
  if (status.error) return text(status.error);
  if (status.done || status.stage === 'done') return 'Готово';
  const stage = text(status.stage).toLowerCase();
  return STAGE_LABEL[stage] || (stage ? `Этап: ${stage}` : 'Импорт идёт…');
}

function refreshStageText(source, job) {
  if (job && job.failed) return 'Обновление прервалось';
  const status = job && job.status;
  if (!status) return 'Запускаем…';
  if (status.error) return text(status.error);
  if (status.done || status.stage === 'done') return 'Готово';
  if (status.stage === 'resolve') {
    const done = numOrNull(status.resolved);
    const total = numOrNull(status.resolveTotal);
    return done != null && total
      ? `Догружаем метадату ${fmtInt(done)}/${fmtInt(total)}`
      : 'Догружаем метадату';
  }
  const page = numOrNull(status.page ?? status.current ?? status.batch ?? status.batchIndex);
  const pageTotal = numOrNull(
    status.pageTotal ?? status.totalPages ?? status.pagesTotal ?? status.batchTotal ?? status.batchesTotal
  );
  if (source === 'hardcover') {
    const sync = status.sync && typeof status.sync === 'object' ? status.sync : null;
    if (sync && sync.mode === 'incremental') {
      const changed = numOrNull(sync.changedRows);
      return changed != null
        ? `Проверяем новинки · изменено ${fmtInt(changed)}`
        : 'Проверяем новинки';
    }
    if (sync && sync.fallback === 'journal-shrank') return 'Журнал уменьшился — полная перепроверка';
    return page != null && page > 0
      ? `Читаем журнал ${fmtInt(page)}/${pageTotal ? fmtInt(pageTotal) : '?'}`
      : 'Читаем журнал';
  }
  if (source === 'livelib') {
    return page != null && page > 0 ? `LiveLib страница ${fmtInt(page)}/${pageTotal ? fmtInt(pageTotal) : '?'}` : 'LiveLib: полный скан';
  }
  return STAGE_LABEL[text(status.stage).toLowerCase()] || 'Обновляем…';
}

function refreshMeta(status) {
  if (!status) return '';
  const sync = status.sync && typeof status.sync === 'object' ? status.sync : null;
  if (sync && sync.mode === 'incremental' && sync.changedRows != null) {
    const changed = fmtInt(sync.changedRows);
    const total = sync.userBooksTotal != null ? ` · в журнале ${fmtInt(sync.userBooksTotal)}` : '';
    return `изменено ${changed} ${plural(sync.changedRows, ['книга', 'книги', 'книг'])}${total}`;
  }
  const events = Array.isArray(status.events) ? status.events.length : numOrNull(status.events);
  return events != null ? `${fmtInt(events)} ${plural(events, ['событие', 'события', 'событий'])}` : '';
}

function renderProgress() {
  const host = $('books-progress-jobs');
  const statusNode = $('books-progress-status');
  const kicker = $('books-progress-kicker');
  const title = $('books-progress-title');
  if (!host) return;
  clear(host);

  const refreshing = Boolean(state.refresh);
  const jobs = jobList();
  if (kicker) {
    const names = jobs.map(([source]) => SOURCE_LABEL[source]).join(' · ') || 'книжный импорт';
    kicker.textContent = refreshing ? `проверка источников · ${names}` : names;
  }
  if (title) title.textContent = refreshing ? 'Проверяем книжные профили' : 'Собираем книжный профиль';
  const footNote = $('books-progress-foot-note');
  if (footNote) {
    footNote.textContent = refreshing
      ? 'Обновление идёт на сервере — можно перейти на вкладку «Фильмы», прогресс не потеряется.'
      : 'Прогресс обновляется каждую секунду. Импорт идёт на сервере — вкладку можно свернуть.';
  }

  let totalEvents = 0;
  for (const [source, job] of jobs) {
    const status = job.status || {};
    const percent = progressPercent(status);
    const done = status.done || status.stage === 'done' || Boolean(job.failed);
    const row = el('div', { class: `books-job-row is-${source}${job.failed ? ' is-failed' : ''}` });
    const head = el('div', { class: 'books-job-head' });
    head.append(el('span', { class: `book-source-logo is-${source}`, text: SOURCE_MARK[source] }));
    const copy = el('div', { class: 'books-job-copy' });
    copy.append(el('div', { class: 'books-job-title', text: sourceLabel(source) }));
    copy.append(el('div', {
      class: 'books-job-account',
      text: job.account ? (source === 'livelib' ? `@${job.account}` : `user ${job.account}`) : '',
    }));
    head.append(copy);
    head.append(el('span', {
      class: `books-job-stage${job.failed ? ' is-error' : done ? ' is-done' : ''}`,
      text: refreshing ? refreshStageText(source, job) : stageText(source, job),
    }));
    row.append(head);

    const bar = el('div', {
      class: 'progress-bar books-job-bar',
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(percent),
    });
    const fill = el('div', { class: 'progress-fill' });
    fill.style.width = `${percent}%`;
    if (!done && percent === 0) bar.classList.add('is-indeterminate');
    bar.append(fill);
    row.append(bar);

    const meta = refreshing ? refreshMeta(status) : statusMeta(status);
    if (meta) row.append(el('div', { class: 'books-job-meta', text: meta }));
    totalEvents += Array.isArray(status.events) ? status.events.length : Math.max(0, toNum(status.events));
    host.append(row);
  }

  if (statusNode) {
    const failed = jobs.filter(([, job]) => job.failed || (job.status && job.status.error));
    if (failed.length) {
      statusNode.textContent = refreshing
        ? 'Часть источников не обновилась — второй источник и сохранённые данные в порядке.'
        : 'Часть импорта не удалась — можно повторить или открыть то, что уже собрано.';
    } else if (jobs.length && jobs.every(([, job]) => job.status && (job.status.done || job.status.stage === 'done'))) {
      statusNode.textContent = refreshing
        ? 'Проверка завершена — пересчитываем статистику…'
        : 'Импорт завершён — считаем статистику…';
    } else if (refreshing) {
      const resolving = jobs.some(([, job]) => job.status && job.status.stage === 'resolve');
      statusNode.textContent = resolving
        ? 'Журнал уже сохранён — метадата догружается в фоне, дашборд не ждёт.'
        : 'Проверяем только новое с прошлой синхронизации. Полная перепроверка — Shift+клик по «Обновить профиль».';
    } else {
      statusNode.textContent = totalEvents > 0
        ? `Собрано ${fmtInt(totalEvents)} ${plural(totalEvents, ['событие', 'события', 'событий'])}…`
        : 'Читаем профили источников…';
    }
  }

  renderProgressError(jobs);
}

function renderProgressError(jobs) {
  const host = $('books-progress-error');
  if (!host) return;
  clear(host);
  const failed = jobs.filter(([, job]) => job && (job.failed || (job.status && job.status.error)));
  if (!failed.length) {
    host.hidden = true;
    return;
  }
  const message = failed
    .map(([source, job]) => `${sourceLabel(source)}: ${job.failed || job.status.error}`)
    .join(' · ');
  if (state.refresh) {
    // Refresh is best-effort per source: the flow finalises itself and the
    // consolidated toast (success + failure) is the only action needed.
    host.append(errorBox({
      title: 'Часть источников не обновилась',
      message: `${message}. Остальные данные и статистика будут пересчитаны.`,
      actions: [],
    }));
    host.hidden = false;
    return;
  }
  const blockedJob = failed.find(([source, job]) => source === 'livelib' && isLivelibBlocked(job.failed || (job.status && job.status.error)));
  const actions = [
    {
      label: 'Повторить',
      primary: true,
      onClick: () => {
        for (const [source, job] of failed) {
          delete state.jobs[source];
          saveJobs();
          const account = job.account || profileAccount(source);
          if (account) startImport(source, account);
        }
      },
    },
    {
      label: 'Показать статистику',
      onClick: () => {
        hideJobs();
        loadStats({ force: true });
      },
    },
  ];
  if (blockedJob) {
    actions.unshift({
      label: 'Загрузить файл LiveLib',
      onClick: () => {
        showScreen('import');
        openFileRefresh();
      },
    });
  }
  host.append(errorBox({ title: 'Импорт не удался', message, actions }));
  host.hidden = false;
}

function stopPolling() {
  if (state.pollTimer) {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = 0;
  }
  state.pollSeq += 1;
}

function startPolling() {
  stopPolling();
  if (state.view !== 'progress') return;
  // A profile refresh keeps polling after the user switches to Films: the
  // server job must not be abandoned just because the tab is hidden.
  if (!state.active && !state.refresh) return;
  pollOnce(state.pollSeq);
}

async function pollOnce(pollId) {
  const stillPolling = () => pollId === state.pollSeq &&
    state.view === 'progress' &&
    (state.active || Boolean(state.refresh));
  if (!stillPolling()) return;
  const jobs = jobList();
  if (!jobs.length) {
    await finishImport();
    return;
  }

  const results = await Promise.allSettled(jobs.map(([source, job]) => getBooksImportStatus(job.jobId, { source })));
  if (!stillPolling()) return;

  let changed = false;
  results.forEach((result, index) => {
    const [source, job] = jobs[index];
    if (result.status === 'rejected') {
      const error = result.reason;
      if (error && (error.status === 404 || error.status === 410)) {
        delete state.jobs[source];
        changed = true;
        return;
      }
      if (error && error.status === 401) return;
      job.failed = shortErrorMessage(error);
      changed = true;
      return;
    }
    const status = result.value && typeof result.value === 'object' ? result.value : {};
    job.status = status;
    if (status.error) job.failed = text(status.error);
    if (status.done || status.stage === 'done') job.failed = null;
    changed = true;
  });

  if (changed) saveJobs();
  if (!stillPolling()) return;

  renderProgress();

  const pending = jobList().filter(([, job]) => !job.failed && !(job.status && (job.status.done || job.status.stage === 'done')));
  const failed = jobList().some(([, job]) => job.failed);
  // Manual refresh is best-effort per source: one failed source must not stop
  // the stats reload of the other one. Imports still wait for a manual retry.
  if (!pending.length && (!failed || state.refresh)) {
    await finishImport();
    return;
  }
  if (!pending.length && failed) return; // manual retry / show-stats buttons
  state.pollTimer = window.setTimeout(() => pollOnce(pollId), POLL_INTERVAL);
}

async function finishImport() {
  stopPolling();
  const refresh = state.refresh;
  if (refresh) {
    await finishRefresh(refresh);
    return;
  }
  const jobs = jobList();
  const failed = jobs.some(([, job]) => job.failed);
  if (failed) {
    renderProgress();
    return;
  }
  const names = jobs.map(([source]) => sourceLabel(source));
  hideJobs();
  await loadStats({ force: true });
  if (state.view === 'dashboard' && names.length) {
    toast(`Импорт завершён: ${names.join('')}`, 'success', { duration: 4600 });
  }
}

/* =========================================================
   manual profile refresh (only the source of the active profile)
   ========================================================= */

function refreshJobId(response) {
  return text(response && (response.id || response.jobId || response.job_id || (response.job && response.job.id)));
}

function attachRefreshJob(source, response, account) {
  const jobId = refreshJobId(response);
  if (!jobId) {
    // Hardcover always opens a job. A done-without-id answer here means a
    // contract drift.
    if (response && (response.done || response.stage === 'done')) return;
    throw new Error('Сервер не вернул идентификатор задачи обновления.');
  }
  state.jobs[source] = {
    jobId,
    account: account || '',
    profileId: state.profile ? state.profile.id : '',
    status: response && typeof response === 'object' ? response : null,
    failed: null,
    startedAt: Date.now(),
  };
}

function refreshJobFailure(job) {
  return job.failed || (job.status && job.status.error) || 'источник недоступен';
}

function refreshErrorMessage(error) {
  const message = error && typeof error.message === 'string' ? error.message.trim() : '';
  return message || shortErrorMessage(error);
}

async function finishRefresh(refresh) {
  const failures = { ...(refresh.failures || {}) };
  for (const [source, job] of jobList()) {
    if (job.failed || (job.status && job.status.error)) failures[source] = refreshJobFailure(job);
  }
  const source = refresh.source;
  const failure = failures[source] || '';
  const hadFailure = Boolean(failure);

  hideJobs();
  if (state.view === 'progress') showScreen('dashboard');

  let afterPayload = null;
  try {
    afterPayload = await getBooksStats({
      profile: activeProfileKey(),
      includeMangaComics: state.includeManga,
    });
  } catch {
    /* fall back to whatever loadStats renders below */
  }
  await loadStats({ force: true });
  state.refresh = null;
  updateRefreshButton();
  const after = snapshotCounts(afterPayload || state.data);
  if (!afterPayload && !state.data) {
    toast('Не удалось пересчитать статистику после обновления', 'error', { duration: 8000 });
    return;
  }
  const message = refreshToastMessage(refresh.before, after, { source, failure });
  toast(message, hadFailure ? 'error' : 'success', { duration: hadFailure ? 10000 : 6000 });
}

/**
 * Open the LiveLib refresh = file upload flow.
 *
 * A LiveLib profile is refreshed by uploading a fresh `livelib-backup` export;
 * nothing is scraped (user verdict, 28.10.2026). The upload form owns its own
 * progress — the button spinner + the result panel — so there is no fake
 * spinner and no polling: `POST /api/books/import/livelib-file` answers 201 with
 * the counts, and the metadata chain continues in the background behind the
 * «Метадата: N%» badge.
 */
function openFileRefresh() {
  if (state.fileImport.busy) {
    toast('Файл уже загружается — дождитесь ответа.', 'info', { duration: 5000 });
    return;
  }
  showScreen('import');
  const panel = $('books-livelib-file-panel');
  if (panel) {
    panel.classList.add('is-refresh-target');
    if (typeof panel.scrollIntoView === 'function') {
      try {
        panel.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch {
        /* older engines: the panel is simply visible already */
      }
    }
  }
  const note = $('books-livelib-file-refresh-note');
  if (note) note.hidden = false;
  const userInput = $('books-livelib-file-user');
  if (userInput && !text(userInput.value)) userInput.value = profileAccount('livelib');
  const input = $('books-livelib-file');
  if (input) {
    setFileImportError('');
    renderFileImportResult(null);
    // The click is a user gesture, so the picker opens right away. Cancelling
    // it leaves the user on the highlighted panel with the instruction.
    try {
      input.click();
    } catch {
      if (userInput) userInput.focus();
    }
  } else if (userInput) {
    userInput.focus();
  }
}

/**
 * "↻ Обновить профиль" for the ONE source of the active profile.
 *
 *  - Hardcover: `/api/books/import/hardcover` — incremental journal diff by
 *    default (one page, ~2 s); Shift+click = full re-read.
 *  - LiveLib: **no scrape**. The click opens the export-file upload panel; the
 *    merge → auto-resolve pipeline runs there with its own progress. A scrape
 *    refresh used to keep the button busy for the whole scan + resolve chain
 *    (minutes), which the user saw as a spinner that never ended.
 *
 * The Hardcover job runs on the server while the user may switch to Films;
 * polling keeps going.
 */
async function refreshProfiles(options = {}) {
  const sources = activeProfileSources();
  const source = sources[0] || '';
  if (!state.profile || !source) {
    toast('Нет активного книжного профиля — создайте профиль и импортируйте источник', 'info', { duration: 6000 });
    return;
  }
  if (source === 'livelib') {
    openFileRefresh();
    return;
  }
  if (state.refresh || state.refreshStarting || state.loading || state.starting.hardcover) return;
  state.refreshStarting = true;
  updateRefreshButton();
  try {
    await runRefreshProfiles(options);
  } finally {
    state.refreshStarting = false;
    updateRefreshButton();
  }
}

async function runRefreshProfiles(options = {}) {
  const profile = state.profile;
  const source = 'hardcover';
  if (!profile || !activeProfileSources().includes(source)) {
    toast('Нет активного книжного профиля — создайте профиль и импортируйте источник', 'info', { duration: 6000 });
    return;
  }

  // Baseline for the toast diff: the same profile scope.
  let baseline = null;
  try {
    baseline = await getBooksStats({
      profile: profileKey(profile),
      includeMangaComics: state.includeManga,
    });
  } catch {
    /* state.data below is still a usable snapshot */
  }

  state.refresh = {
    before: snapshotCounts(baseline || state.data),
    source,
    force: Boolean(options.force),
    failures: {},
    startedAt: Date.now(),
  };
  state.jobs = {};
  saveJobs();
  stopPolling();
  updateRefreshButton();
  showScreen('progress');
  renderProgress();

  // The profile owns the account: no token-owner fallback, no 34748.
  const userId = sourceAccount(profile, 'hardcover');
  if (!userId) {
    state.refresh.failures.hardcover = 'в профиле нет ID Hardcover';
  } else {
    try {
      const response = await startBooksImportHardcover(userId, {
        force: Boolean(state.refresh && state.refresh.force),
      });
      attachRefreshJob('hardcover', response, userId);
    } catch (error) {
      if (error && error.status === 401) return;
      state.refresh.failures.hardcover = refreshErrorMessage(error);
    }
  }
  saveJobs();

  if (!state.refresh) return; // 401 tore the view down
  if (!jobList().length) {
    await finishRefresh(state.refresh);
    return;
  }
  renderProgress();
  startPolling();
}

/* =========================================================
   dashboard
   ========================================================= */

function metric(iconName, label, valueNode, sub = '', title = '', extraClass = '') {
  const node = el('div', { class: `metric${extraClass ? ` ${extraClass}` : ''}` });
  const labelNode = el('div', { class: 'metric-label' });
  if (iconName) labelNode.innerHTML = icon(iconName, 12);
  labelNode.append(document.createTextNode(label));
  node.append(labelNode);
  node.append(valueNode);
  if (sub) node.append(el('div', { class: 'metric-sub', text: sub }));
  if (title) node.title = title;
  return node;
}

/* ---------------- metadata coverage badge ---------------- */

/**
 * Honest "metadata is still loading" badge.
 *
 * A LiveLib profile gets its genres/series/years from the resolve chain
 * (Litres → GB → OL → Hardcover → LiveLib card), which is budgeted (Litres:
 * 200 books per run) and therefore spreads over several profile refreshes.
 * Empty genres are not a bug there — the badge says how much is covered and
 * whether the resolve stage is running right now. 100% → no badge at all.
 * A Hardcover profile takes metadata from the journal, so it is ~100% and the
 * badge stays hidden too. The view model lives in `books-refresh.js` and is
 * unit-tested without a DOM.
 */
function renderMetadataBadge(data = state.data) {
  const badge = $('books-metadata-badge');
  const textNode = $('books-metadata-text');
  const spinner = $('books-metadata-spinner');
  if (!badge || !textNode) return;
  const meta = data && data.summary ? data.summary.metadata : null;
  const view = metadataBadge(meta);
  if (!view) {
    badge.hidden = true;
    badge.dataset.percent = '';
    if (spinner) spinner.hidden = true;
    stopMetadataPolling();
    return;
  }
  badge.hidden = false;
  badge.dataset.percent = String(view.percent);
  badge.classList.toggle('is-running', view.running);
  badge.title = view.hint;
  textNode.textContent = view.text;
  if (spinner) spinner.hidden = !view.running;
  badge.setAttribute('aria-label', `${view.text}. ${view.hint}`);
  startMetadataPolling(meta);
}

/**
 * While the resolve stage is alive, re-read the stats every few seconds and
 * re-render quietly when it changes. The existing deep-scan poller does the
 * same for dates; both stop as soon as the server reports no running stage.
 */
function startMetadataPolling(meta) {
  stopMetadataPolling();
  if (!meta || !meta.running) return;
  if (!state.active || state.view !== 'dashboard') return;
  state.metadataTimer = window.setTimeout(pollMetadataOnce, POLL_INTERVAL * 4);
}

function stopMetadataPolling() {
  if (state.metadataTimer) {
    window.clearTimeout(state.metadataTimer);
    state.metadataTimer = 0;
  }
}

async function pollMetadataOnce() {
  state.metadataTimer = 0;
  const meta = state.data && state.data.summary ? state.data.summary.metadata : null;
  if (!meta || !meta.running) return;
  try {
    // Silent: a background enrichment must not flash the loading screen or
    // steal focus; renderDashboardBooks re-evaluates the badge afterwards.
    await loadStats({ force: true, silent: true });
  } catch (error) {
    if (error && error.status === 401) return;
  }
}

function renderDashboardBooks(data) {
  renderHead(data);
  renderSummary(data);
  renderFilters(data);
  renderMetadataBadge(data);
  renderRecent(data);
  renderRatings(data);
  renderGenres(data);
  renderSeries(data);
  renderAuthors(data);
  renderPublishers(data);
  renderDecades(data);
  renderYears(data);
  renderYearBarsWidget(data);
  renderTimeline(data);
  renderCalendar(data);
}

function renderHead(data) {
  // Scope = the profile's single source (the payload says which document it
  // built). `connected` (everything cached) is only a fallback for old payloads.
  const scoped = Array.isArray(data.profileSources) && data.profileSources.length
    ? data.profileSources
    : data.connected.slice(0, 1);
  const kicker = $('books-kicker');
  if (kicker) {
    const scope = scoped.length ? `${scoped.map(sourceLabel).join('')} · сводка` : 'книжная полка · сводка';
    kicker.textContent = state.profile ? `${state.profile.label} · ${scope}` : scope;
  }
  const sub = $('books-sub');
  if (sub) {
    const parts = [];
    if (data.summary.bookCount) parts.push(`${fmtInt(data.summary.bookCount)} ${plural(data.summary.bookCount, ['книга', 'книги', 'книг'])}`);
    if (data.summary.eventCount) parts.push(`${fmtInt(data.summary.eventCount)} ${plural(data.summary.eventCount, ['прочтение', 'прочтения', 'прочтений'])}`);
    const reReads = data.summary.reReadCount > 0
      ? `, в том числе ${fmtInt(data.summary.reReadCount)} ${plural(data.summary.reReadCount, ['перечитка', 'перечитки', 'перечитываний'])}`
      : '';
    // «Читаю сейчас» is shelf state, not a finished read: a separate sentence,
    // never added to bookCount/eventCount.
    const readingNow = data.summary.readingNowCount > 0
      ? ` Сейчас читает ${fmtInt(data.summary.readingNowCount)} ${plural(data.summary.readingNowCount, ['книгу', 'книги', 'книг'])} (в статистику прочитанного не входят).`
      : '';
    const scopeNote = state.profile
      ? `Профиль «${state.profile.label}»: ${profileSummary(state.profile)}.`
      : '';
    // A profile is one source; metadata may come from the resolve chain.
    const metadata = Array.isArray(data.booksIndex)
      ? []
      : [...new Set(Object.values(data.booksIndex)
        .flatMap((entry) => entry.metadataSources || [])
        .filter((source) => !scoped.includes(source)))];
    const chain = metadata.length
      ? `, метадата — ${metadata.map((source) => (METADATA_LABEL[source] || [source])[1]).join(', ')}`
      : '';
    const undatedParts = [];
    if (data.summary.monthOnlyEventCount > 0) {
      undatedParts.push(
        `У ${fmtInt(data.summary.monthOnlyEventCount)} дата по месяцу — в таймлайне, но не в календаре и стриках`
      );
    }
    if (data.summary.undatedEventCount > 0) {
      undatedParts.push(`без даты: ${fmtInt(data.summary.undatedEventCount)}`);
    }
    const undated = undatedParts.length ? ` ${undatedParts.join('; ')}.` : '';
    const sourceNote = scoped.length
      ? `${scopeNote} Оценки и даты — только ${scoped.map(sourceLabel).join('')}${chain}.${undated}`
      : `${scopeNote} Подключите источник, чтобы увидеть оценки, жанры и календарь.`;
    sub.textContent = parts.length
      ? `${parts.join(' · ')}${reReads}.${readingNow} ${sourceNote}`
      : 'Подключите источник, чтобы увидеть оценки, жанры и календарь чтения.';
  }
}

function renderSummary(data) {
  const host = $('books-summary');
  if (!host) return;
  clear(host);
  const { summary } = data;
  const ratedTotal = data.ratings.merged.reduce((sum, item) => sum + item.count, 0);
  const ratedShare = summary.bookCount > 0 ? fmtPercent(ratedTotal, summary.bookCount) : '';
  const avgPages = summary.avgPages;

  host.append(metric('book', 'всего книг',
    el('div', { class: 'metric-value', text: fmtInt(summary.bookCount) }),
    summary.eventCount
      ? `${fmtInt(summary.eventCount)} ${plural(summary.eventCount, ['прочтение', 'прочтения', 'прочтений'])}`
      : 'по профилю чтения',
    summary.reReadCount > 0
      ? `${fmtInt(summary.bookCount)} уникальных книг · ${fmtInt(summary.eventCount)} событий, включая ${fmtInt(summary.reReadCount)} перечитываний`
      : `${fmtInt(summary.bookCount)} уникальных книг · ${fmtInt(summary.eventCount)} событий`,
  ));

  host.append(metric('star', 'с оценками',
    el('div', { class: 'metric-value', text: fmtInt(ratedTotal) }),
    ratedShare ? `${ratedShare} от всех` : 'оценок нет',
    data.summary.avgRating != null ? `Средняя оценка: ${fmtRating(data.summary.avgRating)} из 10` : '',
  ));

  const totalPages = summary.pageCount != null
    ? summary.pageCount
    : Object.values(data.booksIndex).reduce((sum, entry) => sum + (entry.pages || 0), 0);
  host.append(metric('book', 'страниц',
    el('div', { class: 'metric-value', text: totalPages > 0 ? fmtInt(totalPages) : '—' }),
    avgPages != null && avgPages > 0 ? `в среднем ${fmtInt(avgPages)} стр.` : 'объём известен не у всех',
    totalPages > 0 ? `Суммарный объём: ${fmtInt(totalPages)} страниц` : 'Нет данных о страницах',
  ));

  host.append(metric('calendar', 'период',
    el('div', { class: 'metric-value is-small', text: fmtPeriod(summary.dateFrom, summary.dateTo) }),
    'первая — последняя книга',
  ));

  host.append(renderSourcesMetric(data));

  if (summary.reReadCount > 0) {
    host.append(metric('refresh', 'перечитывания',
      el('div', { class: 'metric-value', text: fmtInt(summary.reReadCount) }),
      'отдельные события',
      `${fmtInt(summary.reReadCount)} ${plural(summary.reReadCount, ['перечитка', 'перечитки', 'перечитываний'])} — отдельные события, книги не дублируются`,
    ));
  } else if (summary.undatedEventCount > 0) {
    host.append(metric('alert', 'без дат',
      el('div', { class: 'metric-value', text: fmtInt(summary.undatedEventCount) }),
      'не в календаре',
      'События без даты прочтения не попадают в календарь, стрики и таймлайн',
      'metric-undated',
    ));
  } else {
    const seriesCount = data.series.filter((item) => item.count >= 2).length;
    host.append(metric('book', 'серии',
      el('div', { class: 'metric-value', text: fmtInt(seriesCount) }),
      seriesCount ? 'с двумя и более книгами' : 'серий нет',
      'Серия — книги одного цикла; показываются серии из двух и более книг',
    ));
  }
}

function renderSourcesMetric(data) {
  const node = el('div', { class: 'metric metric-source metric-books-source' });
  const labelNode = el('div', { class: 'metric-label' });
  labelNode.innerHTML = icon('book', 12);
  labelNode.append(document.createTextNode('источник'));
  node.append(labelNode);

  // One profile = one source. `connected` (every profile cached on the server)
  // is only a fallback for an old payload.
  const sources = Array.isArray(data.profileSources) && data.profileSources.length
    ? data.profileSources
    : data.connected.slice(0, 1);
  const value = el('div', { class: 'metric-value' });
  for (const source of sources) {
    const plate = el('span', { class: `book-source-plate is-${source}` });
    plate.append(el('span', { class: 'book-source-mark', text: SOURCE_MARK[source] }));
    const account = profileAccount(source);
    if (account) {
      plate.append(el('span', { class: 'src-uid', text: source === 'livelib' ? `@${account}` : account }));
    }
    value.append(plate);
  }
  if (!sources.length) value.append(el('span', { class: 'src-empty', text: 'не подключён' }));
  node.append(value);

  // Metadata providers of the works in THIS profile (resolve chain), not a
  // second event source: LiveLib dates stay LiveLib dates.
  const metadata = [...new Set(Object.values(data.booksIndex)
    .flatMap((entry) => entry.metadataSources || [])
    .filter((source) => !sources.includes(source)))];
  // A Hardcover profile imported before the journal schema carried
  // `statusId`: the label fallback keeps the numbers honest, but a re-import
  // refreshes the stored events (the import button always re-fetches HC).
  const staleHardcover = (Array.isArray(data.meta && data.meta.profiles) ? data.meta.profiles : [])
    .filter((profile) => profile && profile.source === 'hardcover' && profile.needsReimport);
  const subParts = [
    sources.length ? `${sourceLabel(sources[0])}: ${fmtInt(data.summary.eventCount)}` : 'не подключён',
    metadata.length ? `метадата: ${metadata.map((source) => (METADATA_LABEL[source] || [source])[0]).join(' ')}` : null,
    staleHardcover.length ? '⚑ переимпорт HC' : null,
  ].filter(Boolean);
  node.append(el('div', { class: 'metric-sub', text: subParts.join(' · ') }));

  node.addEventListener('pointerenter', (event) => {
    const primary = sources.map(sourceLabel).join('') || 'Источник не подключён';
    const details = sources.length
      ? `${fmtInt(data.summary.eventCount)} событий, ${fmtInt(data.summary.bookCount)} книг` +
        `${data.summary.avgRating != null ? `, средняя ${fmtRating(data.summary.avgRating)}` : ''}` +
        `${data.summary.undatedEventCount ? ` · без даты: ${fmtInt(data.summary.undatedEventCount)}` : ''}`
      : 'Импортируйте профиль LiveLib или Hardcover';
    const metaNote = metadata.length
      ? ` Метадата работ: ${metadata.map((source) => (METADATA_LABEL[source] || [source])[1]).join(', ')} (обогащение, не события).`
      : '';
    const statusNote = staleHardcover.length
      ? ' ⚑ Профиль Hardcover сохранён без statusId: статусы пересчитаны по меткам, повторный импорт Hardcover обновит схему событий.'
      : '';
    showTooltip(primary, `${details}.${metaNote}${statusNote}`);
    moveTooltip(event);
  });
  node.addEventListener('pointermove', moveTooltip);
  node.addEventListener('pointerleave', hideTooltip);
  return node;
}

function renderFilters(data) {
  const host = $('books-filters');
  if (!host) return;
  // No source chips any more: the active profile IS the scope. The pill only
  // names the source of the rendered payload.
  const sources = Array.isArray(data.profileSources) && data.profileSources.length
    ? data.profileSources
    : data.connected.slice(0, 1);
  const pill = $('books-source-badge');
  if (pill) {
    pill.hidden = !sources.length;
    pill.textContent = sources.length ? `Источник: ${sourceLabel(sources[0])}` : '';
    pill.className = `books-source-badge${sources.length ? ` is-${sources[0]}` : ''}`;
    pill.title = 'Профиль = один источник. Переключите профиль, чтобы увидеть второй.';
  }
  const note = $('books-filters-note');
  if (note) {
    note.textContent = 'фильтр применяется ко всем виджетам';
  }
  syncMangaToggle(data);
}

/** Keep the manga switch, its note and the request state in sync. */
function syncMangaToggle(data = state.data) {
  const input = $('books-manga-toggle');
  if (input) input.checked = state.includeManga;
  const wrap = $('books-manga-toggle-wrap');
  if (wrap) wrap.classList.toggle('is-on', state.includeManga);

  const note = $('books-manga-note');
  if (!note) return;
  let label = '';
  let hint = '';
  if (data && !state.includeManga && data.summary.mangaExcluded > 0) {
    const excluded = data.summary.mangaExcluded;
    label = `без манги и комиксов (−${fmtInt(excluded)} ${plural(excluded, ['книга', 'книги', 'книг'])})`;
    hint = `${fmtInt(excluded)} ${plural(excluded, ['работа', 'работы', 'работ'])} `
      + 'манги/комиксов исключены сервером. Включите переключатель, чтобы вернуть их в статистику.';
  } else if (data && !data.hasMangaField) {
    label = 'в этом импорте поля нет';
    hint = 'Сервер не отдал mangaComics: профиль собран до разметки манги и комиксов. '
      + 'Переключатель безопасен, но пока ничего не фильтрует.';
  }
  note.textContent = label;
  note.hidden = !label;
  note.title = hint;
}

async function setIncludeManga(next) {
  const value = Boolean(next);
  if (state.includeManga === value) {
    syncMangaToggle();
    return;
  }
  const previous = state.includeManga;
  state.includeManga = value;
  state.loaded = false;
  state.selectedDecade = null;
  const host = $('books-filters');
  if (host) host.classList.add('is-busy');
  try {
    await loadStats({ force: true, silent: true });
  } finally {
    if (host) host.classList.remove('is-busy');
  }
  if (!state.loaded) {
    // A failed refetch keeps the old dashboard: put the switch back where the
    // rendered payload actually is instead of lying about the scope.
    state.includeManga = previous;
  }
  if (state.data) renderFilters(state.data);
  else syncMangaToggle();
}

async function setSource(source) {
  // Legacy hook: the source chip UI is gone (a profile is one source). Kept as
  // a no-op so an old cached element handler cannot crash a stale page.
  return Boolean(source);
}

/* ---------------- recent strip ---------------- */

function bookCover(url, title, extraClass = '') {
  const cls = `film-poster book-cover${extraClass ? ` ${extraClass}` : ''}`;
  if (!url) {
    return el('div', { class: `film-poster poster-fallback${extraClass ? ` ${extraClass}` : ''}`, 'aria-hidden': 'true', text: initialOf(title) });
  }
  const img = el('img', {
    class: cls,
    src: url,
    alt: '',
    loading: 'lazy',
    decoding: 'async',
    referrerpolicy: 'no-referrer',
  });
  img.addEventListener('error', () => {
    img.replaceWith(el('div', {
      class: `film-poster poster-fallback${extraClass ? ` ${extraClass}` : ''}`,
      'aria-hidden': 'true',
      text: initialOf(title),
    }));
  });
  return img;
}

function initialOf(name) {
  const chars = Array.from(text(name));
  return chars.length ? chars[0].toUpperCase() : '?';
}

function sourceTags(sources) {
  const wrap = el('span', { class: 'book-source-tags' });
  for (const source of sources) {
    if (!SOURCE_LABEL[source]) continue;
    wrap.append(el('span', {
      class: `book-source-tag is-${source}`,
      text: SOURCE_MARK[source],
      title: sourceLabel(source),
    }));
  }
  return wrap;
}

/** One short badge for the bibliographic metadata provider of the work. */
function metadataTag(sources) {
  const key = arr(sources).find((item) => METADATA_LABEL[item]);
  if (!key) return null;
  const [mark, label] = METADATA_LABEL[key];
  return el('span', {
    class: `book-meta-tag is-${key}`,
    text: mark,
    title: `Метадата: ${label}`,
  });
}

function bookFromEntry(workId, entry) {
  return entry || normalizeEntry(workId, { title: workId });
}

function recentBookItem(item) {
  const entry = state.data && state.data.booksIndex[item.workId];
  if (entry) return entry;
  return normalizeEntry(item.workId, {
    title: item.title,
    coverUrl: item.coverUrl,
    sources: item.source ? [item.source] : [],
    finishedDate: item.date,
  });
}

function renderRecent(data) {
  const section = $('books-recent-widget');
  const host = $('books-recent-strip');
  const note = $('books-recent-note');
  if (!section || !host) return;
  clear(host);

  // The strip is one row of 15: «Читаю сейчас» first, then the finished books.
  // A reading card must never be crowded out by 15 finished ones, and the
  // strip must not disappear when the profile only has a current read.
  const reading = data.recentlyReading.slice(0, 15);
  const items = [...reading, ...data.recentlyFinished].slice(0, 15);
  if (!items.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  if (note) {
    const readingShown = items.filter((item) => item.reading).length;
    const suffix = readingShown ? ` · сейчас: ${fmtInt(readingShown)}` : '';
    note.textContent = `${fmtInt(items.length)} ${plural(items.length, ['книга', 'книги', 'книг'])}${suffix}`;
  }

  for (const item of items) {
    const isReading = item.reading === true;
    const book = recentBookItem(item);
    const title = book.title || 'Без названия';
    const monthOnly = !isReading && item.precision === 'month';
    const dateLabel = isReading
      ? 'читает сейчас'
      : monthOnly ? monthName(item.date) : fmtDayRu(item.date);
    const dateShort = isReading
      ? 'сейчас'
      : monthOnly ? monthShort(item.date) : fmtDayShortRu(item.date);
    const card = el('div', { class: 'recent-card' });
    const poster = el('div', {
      class: 'recent-poster',
      role: 'button',
      tabIndex: 0,
      'aria-label': `${title}: ссылки и действия`,
      title: isReading
        ? `${title}${book.year ? ` (${book.year})` : ''} · читает сейчас`
        : `${title}${book.year ? ` (${book.year})` : ''} · ${dateLabel}${monthOnly ? ' · точность: месяц' : ''}`,
    });
    poster.append(bookCover(book.coverUrl, title));

    const tags = el('span', { class: 'recent-book-tags' });
    if (book.sources.length) tags.append(sourceTags(book.sources));
    if (isReading) {
      tags.append(el('span', { class: 'tag recent-reading', text: 'читает сейчас' }));
    } else if (item.reRead || book.reReadCount > 0) {
      tags.append(el('span', { class: 'tag recent-rewatch', text: 'перечитано' }));
    }
    if (tags.childNodes.length) poster.append(tags);

    const menu = renderBookMenu(book);
    if (menu) {
      menu.classList.add('recent-film-menu');
      poster.append(menu);
    }

    const open = () => {
      const toggle = menu && menu.querySelector('.film-menu-toggle');
      if (toggle) {
        toggle.click();
        return;
      }
      openBookListModal({
        kicker: 'Недавно читал',
        title,
        subtitle: dateLabel,
        groupLabel: dateLabel,
        books: [book],
        sortScope: 'recent',
      });
    };
    poster.addEventListener('click', (event) => {
      if (event.target.closest('.film-menu')) return;
      hideTooltip();
      open();
    });
    poster.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      hideTooltip();
      open();
    });

    card.append(poster);
    card.append(el('div', {
      class: 'recent-date',
      text: dateShort,
      title: dateLabel,
    }));
    host.append(card);
  }
}

/* ---------------- ratings ---------------- */

function ratingFromEntry(entry) {
  return entry && entry.rating != null ? entry.rating : null;
}

function renderRatings(data) {
  const donutHost = $('books-ratings-donut');
  const legendHost = $('books-ratings-legend');
  const note = $('books-ratings-note');
  if (!donutHost || !legendHost) return;

  const counts = new Map();
  for (const item of data.ratings.merged) counts.set(item.score, item.count);
  const ratedTotal = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const unrated = Math.max(0, data.summary.bookCount - ratedTotal);
  const totalAll = ratedTotal + unrated;

  if (note) {
    note.textContent = totalAll > 0
      ? `${fmtInt(ratedTotal)} из ${fmtInt(totalAll)}`
      : 'нет оценок';
  }

  clear(legendHost);
  clear(donutHost);
  if (!totalAll) {
    donutHost.append(emptyState('Оценок в профиле нет'));
    return;
  }

  const segments = [];
  for (let score = 1; score <= 10; score += 1) {
    segments.push({
      key: `score-${score}`,
      label: String(score),
      value: counts.get(score) || 0,
      color: RATING_COLORS[score - 1],
      score,
    });
  }
  if (unrated > 0) {
    segments.push({ key: 'score-0', label: 'Без оценки', value: unrated, color: '#566675', score: 0 });
  }

  renderDonut(donutHost, {
    segments,
    legendHost,
    centerValue: fmtInt(ratedTotal),
    centerLabel: 'оценок',
    ariaLabel: `Распределение книг по оценкам, ${fmtInt(ratedTotal)} оценённых книг`,
    secondary: (seg) => {
      const pct = `${fmtPercent(seg.value, totalAll)} всех книг`;
      return seg.score === 0 ? `${fmtPercent(seg.value, totalAll)} без оценки` : pct;
    },
    onSelect: (seg) => {
      hideTooltip();
      openRatingModal(toNum(seg.score));
    },
  });
}

function openRatingModal(score) {
  const books = [];
  for (const entry of Object.values(state.data.booksIndex)) {
    const rating = ratingFromEntry(entry);
    if (score === 0 ? rating == null : rating === score) books.push(entry);
  }
  const count = books.length;
  const title = score === 0
    ? `Без оценки — ${fmtInt(count)} ${plural(count, ['книга', 'книги', 'книг'])}`
    : `${fmtInt(count)} ${plural(count, ['книга', 'книги', 'книг'])} с оценкой ${fmtInt(score)}`;
  openBookListModal({
    kicker: 'Оценки',
    title,
    subtitle: score === 0 ? 'Книги без вашей оценки' : `Ваша оценка ${fmtInt(score)} из 10`,
    hint: 'Единая 10-шкала: LiveLib уже 10-балльный, оценка Hardcover (0–5) удвоена. При конфликте приоритет у Hardcover.',
    groupLabel: score === 0 ? 'Без оценки' : `Оценка ${score}`,
    emptyText: score === 0 ? 'У всех книг есть оценка' : 'Нет книг с этой оценкой',
    books,
    sortScope: 'ratings',
    defaultSort: score === 0 ? 'title' : 'rating',
  });
}

/* ---------------- ranked bars: genres / series / authors / publishers ---------------- */

function renderBarRow(host, item, max, { kindLabel = 'жанр', rank = 0, onOpen = null } = {}) {
  const row = el('div', { class: `genre-row is-book-row${rank ? ' is-ranked' : ''}${onOpen ? ' is-clickable' : ''}` });
  if (rank) row.append(el('span', { class: 'rank-num', text: String(rank) }));

  const name = el('div', { class: 'genre-name' });
  name.append(el('span', { class: 'genre-label', text: item.name }));
  name.append(el('span', { class: 'genre-count', text: fmtInt(item.count) }));

  const track = el('div', { class: 'genre-track' });
  const fill = el('div', { class: 'genre-fill' });
  track.append(fill);

  const avg = item.avgRating != null ? fmtRating(item.avgRating) : '—';
  const avgNode = el('div', {
    class: 'genre-avg',
    text: avg,
    title: item.avgRating != null ? `Средняя оценка: ${fmtRating(item.avgRating)}` : 'Нет оценок в этой категории',
  });

  row.append(name, track, avgNode);
  host.append(row);

  requestAnimationFrame(() => {
    fill.style.width = `${Math.max(2, (item.count / max) * 100)}%`;
  });

  row.addEventListener('pointerenter', (event) => {
    showTooltip(
      `${item.name} — ${fmtInt(item.count)} ${plural(item.count, ['книга', 'книги', 'книг'])}`,
      item.avgRating != null
        ? `${kindLabel} · средняя оценка ${fmtRating(item.avgRating)}`
        : `${kindLabel} · средней оценки нет`,
    );
    moveTooltip(event);
  });
  row.addEventListener('pointermove', moveTooltip);
  row.addEventListener('pointerleave', hideTooltip);

  if (onOpen) {
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.setAttribute('aria-label', `${item.name}: ${fmtInt(item.count)} книг. Открыть список`);
    row.addEventListener('click', () => {
      hideTooltip();
      onOpen(item);
    });
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      hideTooltip();
      onOpen(item);
    });
  }
}

function renderBarList({ hostId, noteId, items, emptyText, kindLabel, unitLabel, limit = 0, onClick }) {
  const host = $(hostId);
  const note = $(noteId);
  if (!host) return;
  const list = items.slice().sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
  const shown = limit > 0 ? list.slice(0, limit) : list;

  if (note) {
    note.textContent = list.length
      ? `${fmtInt(list.length)} ${plural(list.length, unitLabel)}${limit > 0 && list.length > limit ? ` · топ-${limit}` : ''}`
      : '';
  }

  clear(host);
  if (!shown.length) {
    host.append(emptyState(emptyText));
    return;
  }
  const max = Math.max(1, ...shown.map((item) => item.count));
  shown.forEach((item, index) => {
    renderBarRow(host, item, max, {
      kindLabel,
      rank: index + 1,
      onOpen: onClick ? (rowItem) => onClick(rowItem) : null,
    });
  });
}

function booksFromWorks(works) {
  const list = [];
  const seen = new Set();
  for (const workId of works) {
    const id = text(workId);
    if (!id || seen.has(id)) continue;
    const entry = state.data.booksIndex[id];
    if (!entry) continue;
    seen.add(id);
    list.push(entry);
  }
  return list;
}

function openWorksModal({ workIds = null, books = null, kicker, title, subtitle, hint = '', groupLabel }) {
  const list = books || booksFromWorks(workIds);
  const count = list.length;
  openBookListModal({
    kicker,
    title: title || `${fmtInt(count)} ${plural(count, ['книга', 'книги', 'книг'])}`,
    subtitle: subtitle || `${fmtInt(count)} ${plural(count, ['книга', 'книги', 'книг'])}`,
    hint,
    groupLabel: groupLabel || title || 'Книги',
    emptyText: 'Нет книг с метадатой',
    books: list,
    sortScope: kicker ? `books-${kicker}` : 'books',
  });
}

function renderGenres(data) {
  renderBarList({
    hostId: 'books-genres-list',
    noteId: 'books-genres-note',
    items: data.genres,
    emptyText: 'Жанры появятся после импорта Hardcover',
    kindLabel: 'жанр',
    unitLabel: ['жанр', 'жанра', 'жанров'],
    onClick: (item) => {
      const avg = item.avgRating != null ? ` · средняя оценка ${fmtRating(item.avgRating)}` : '';
      openWorksModal({
        workIds: item.works,
        kicker: 'Жанр',
        title: item.name,
        subtitle: `${fmtInt(item.count)} ${plural(item.count, ['книга', 'книги', 'книг'])}${avg}`,
        groupLabel: item.name,
      });
    },
  });
}

function renderSeries(data) {
  const section = $('books-series-widget');
  const items = data.series.filter((item) => item.count >= 2);
  if (section) section.hidden = items.length === 0;
  renderBarList({
    hostId: 'books-series-list',
    noteId: 'books-series-note',
    items,
    emptyText: 'Серий с двумя и более книгами нет',
    kindLabel: 'серия',
    unitLabel: ['серия', 'серии', 'серий'],
    onClick: (item) => {
      openWorksModal({
        workIds: item.works,
        kicker: 'Серия',
        title: item.name,
        subtitle: `${fmtInt(item.count)} ${plural(item.count, ['книга', 'книги', 'книг'])} в серии`,
        groupLabel: item.name,
      });
    },
  });
}

function renderAuthors(data) {
  const host = $('books-authors-list');
  const note = $('books-authors-note');
  const searchWrap = $('books-authors-search-wrap');
  const search = $('books-authors-search');
  const moreHost = $('books-authors-more');
  if (!host) return;

  const all = data.authors.slice().sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
  const query = authorsState.query.trim().toLowerCase();
  const filtered = query ? all.filter((item) => item.name.toLowerCase().includes(query)) : all;

  if (note) {
    if (!all.length) note.textContent = '';
    else if (query) note.textContent = `${fmtInt(filtered.length)} из ${fmtInt(all.length)}`;
    else {
      const truncated = !authorsState.expanded && all.length > AUTHORS_INITIAL;
      note.textContent = `${fmtInt(all.length)} ${plural(all.length, ['автор', 'автора', 'авторов'])}`
        + (truncated ? ` · топ-${AUTHORS_INITIAL}` : '');
    }
  }

  // Search is only worth the space on a long author list; below the threshold
  // the top-20 list is already scannable and the note stays compact.
  if (searchWrap) searchWrap.hidden = all.length <= AUTHORS_SEARCH_MIN;
  if (search && search.value !== authorsState.query) search.value = authorsState.query;

  clear(host);
  if (moreHost) clear(moreHost);

  if (!filtered.length) {
    host.append(emptyState(all.length
      ? 'Никого не нашли — попробуйте другой запрос'
      : 'Авторы появятся после импорта'));
    return;
  }

  const visible = query ? Math.max(AUTHORS_BATCH, authorsState.visible) : authorsState.visible;
  const shown = filtered.slice(0, visible);
  const max = Math.max(1, ...shown.map((item) => item.count));
  shown.forEach((item, index) => {
    renderBarRow(host, item, max, {
      kindLabel: 'автор',
      rank: index + 1,
      onOpen: (rowItem) => {
        const avg = rowItem.avgRating != null ? ` · средняя ${fmtRating(rowItem.avgRating)}` : '';
        openWorksModal({
          workIds: rowItem.works,
          kicker: 'Автор',
          title: rowItem.name,
          subtitle: `${fmtInt(rowItem.count)} ${plural(rowItem.count, ['книга', 'книги', 'книг'])}${avg}`,
          groupLabel: rowItem.name,
        });
      },
    });
  });

  if (moreHost && shown.length < filtered.length) {
    const remaining = filtered.length - shown.length;
    const button = el('button', {
      type: 'button',
      class: 'btn btn-ghost',
      text: !authorsState.expanded && !query
        ? `Показать всех (${fmtInt(filtered.length)})`
        : `Показать ещё ${fmtInt(Math.min(AUTHORS_BATCH, remaining))}`,
    });
    button.addEventListener('click', () => {
      authorsState.expanded = true;
      authorsState.visible = shown.length + AUTHORS_BATCH;
      if (state.data) renderAuthors(state.data);
    });
    moreHost.append(button);
  }
}

function renderPublishers(data) {
  renderBarList({
    hostId: 'books-publishers-list',
    noteId: 'books-publishers-note',
    items: data.publishers,
    emptyText: 'Издательства появятся после enrich Hardcover',
    kindLabel: 'издательство',
    unitLabel: ['издательство', 'издательства', 'издательств'],
    limit: 12,
    onClick: (item) => {
      openWorksModal({
        workIds: item.works,
        kicker: 'Издательство',
        title: item.name,
        subtitle: `${fmtInt(item.count)} ${plural(item.count, ['книга', 'книги', 'книг'])}`,
        groupLabel: item.name,
      });
    },
  });
}

/* ---------------- decades / years ---------------- */

function decadeHint(message) {
  const box = el('div', { class: 'years-empty' });
  box.append(el('div', { class: 'years-empty-ring', 'aria-hidden': 'true' }));
  box.append(el('p', {
    class: 'years-empty-text',
    text: message || 'Выбери десятилетие слева — покажем годы издания книг',
  }));
  return box;
}

/**
 * «N книг без года» — the honest summary line of the year charts.
 *
 * Works with no year at all (no first publication, no edition year, no manual
 * correction) are NOT painted as a bar/slice: the pre-ef593a8 chart silently
 * dropped them, and the 29.10.2026 verdict is «make it look like before, but
 * say the number out loud». The count is a button that opens the drilldown
 * list, where every row has the «Исправить год» action (manual override).
 */
function unknownYearsButton(count) {
  const btn = el('button', {
    type: 'button',
    class: 'note-link',
    text: `${fmtInt(count)} ${plural(count, ['книга', 'книги', 'книг'])} без года`,
  });
  btn.title = 'Показать книги без года и исправить год вручную';
  btn.addEventListener('click', () => openUnknownYearModal());
  return btn;
}

/** Why the year is missing — the honest reason, never a fake verdict. */
function unknownYearsReason(backfill) {
  if (!backfill) return '';
  const fileColumn = backfill.fileColumn;
  if (backfill.open) {
    return (
      `бэкфилл идёт, осталось ~${fmtInt(backfill.runsLeft)} ` +
      `${plural(backfill.runsLeft, ['прогон', 'прогона', 'прогонов'])}` +
      `${backfill.unlinked > 0 ? ` (${fmtInt(backfill.unlinked)} ждут привязки к метаданным)` : ''}`
    );
  }
  // The root cause of the 28.10.2026 regression: the export file itself had no
  // «Год издания» column, so the legacy channel had nothing to read.
  if (fileColumn && fileColumn.rows > 0 && fileColumn.withYear === 0) {
    return (
      'в файле-выгрузке не было колонки «Год издания» — переэкспортируйте файл с ней, ' +
      'годы подхватятся при повторном импорте'
    );
  }
  if (backfill.unlinked > 0) {
    return (
      (backfill.honestUnknown > 0
        ? `${fmtInt(backfill.honestUnknown)} ` +
          `${plural(backfill.honestUnknown, ['книга', 'книги', 'книг'])}: провайдеры не знают, `
        : '') +
      `${fmtInt(backfill.unlinked)} ` +
      `${plural(backfill.unlinked, ['книга', 'книги', 'книг'])} ждут привязки к метаданным`
    );
  }
  return 'провайдеры не знают';
}

/** Drilldown of the year-less works; the row menu fixes a year manually. */
function openUnknownYearModal() {
  const data = state.data || {};
  const books = Object.values(data.booksIndex || {}).filter((entry) => entry.year == null);
  const backfill = data.summary && data.summary.yearBackfill;
  const hints = [];
  const fileColumn = backfill && backfill.fileColumn;
  if (fileColumn && fileColumn.rows > 0 && fileColumn.withYear === 0) {
    hints.push(
      'В файле-выгрузке не было колонки «Год издания»: переэкспортируйте его с этой колонкой ' +
        'и загрузите снова — годы подхватятся при повторном импорте.'
    );
  }
  hints.push('Год можно исправить вручную: меню «…» у книги → «Исправить год».');
  openWorksModal({
    books,
    kicker: 'Год неизвестен',
    title: 'Книги без года',
    subtitle:
      `${fmtInt(books.length)} ${plural(books.length, ['книга', 'книги', 'книг'])}: ` +
      'ни первоиздание, ни год издания не известны',
    hint: hints.join(' '),
    groupLabel: 'Без года',
    emptyText: 'У всех книг есть год',
  });
}

function renderDecades(data) {
  const donutHost = $('books-decades-donut');
  const legendHost = $('books-decades-legend');
  const note = $('books-decades-note');
  if (!donutHost || !legendHost) return;

  // Works without any year are not a decade: the chart paints real decades
  // only and the note carries the honest «…и N книг без года» line. That is
  // the pre-ef593a8 chart shape, minus its silent drop.
  const all = data.decades.slice();
  const decades = all.filter((item) => !item.unknown);
  const unknown = all
    .filter((item) => item.unknown)
    .reduce((sum, item) => sum + item.count, 0);
  const total = decades.reduce((sum, item) => sum + item.count, 0);
  const editionTotal = decades.reduce((sum, item) => sum + (item.editionCount || 0), 0);
  if (note) {
    note.textContent = decades.length
      ? `${fmtInt(decades.length)} ${plural(decades.length, ['десятилетие', 'десятилетия', 'десятилетий'])}` +
        (editionTotal > 0
          ? ` · * — год издания у ${fmtInt(editionTotal)} ${plural(editionTotal, ['книга', 'книги', 'книг'])}`
          : '')
      : '';
    if (unknown > 0) {
      if (note.textContent) note.append(document.createTextNode(' · '));
      note.append(unknownYearsButton(unknown));
    }
  }

  clear(legendHost);
  clear(donutHost);
  if (!total) {
    donutHost.append(emptyState('Нет данных по десятилетиям'));
    return;
  }

  const segments = decades.map((item, index) => ({
    key: `decade-${item.start}`,
    label: item.editionCount > 0 ? `${item.label}*` : item.label,
    value: item.count,
    color: DECADE_COLORS[index % DECADE_COLORS.length],
    decadeStart: item.start,
  }));

  renderDonut(donutHost, {
    segments,
    legendHost,
    selectedKey: state.selectedDecade ? `decade-${state.selectedDecade.start}` : null,
    centerValue: fmtInt(total),
    centerLabel: 'книг',
    ariaLabel: 'Распределение книг по десятилетиям издания. Выберите десятилетие, чтобы увидеть годы',
    secondary: (seg) => `${fmtPercent(seg.value, total)} всех книг с годом`,
    onSelect: (seg) => {
      const start = toNum(seg.decadeStart);
      if (!Number.isFinite(start) || start <= 0) return;
      state.selectedDecade = { start, label: seg.label };
      renderDecades(data);
      renderYears(data);
    },
  });
}

function renderYears(data) {
  const donutHost = $('books-years-donut');
  const legendHost = $('books-years-legend');
  const note = $('books-years-note');
  const titleText = $('books-years-title-text');
  if (!donutHost || !legendHost) return;

  clear(legendHost);
  clear(donutHost);

  const selected = state.selectedDecade;
  if (titleText) titleText.textContent = selected ? `Годы · ${selected.label}` : 'Годы';

  if (!selected) {
    if (note) note.textContent = '';
    donutHost.append(decadeHint());
    return;
  }

  const start = selected.start;
  if (start <= 0) {
    donutHost.append(decadeHint('Не удалось определить границы десятилетия'));
    return;
  }
  const years = data.years
    .filter((item) => item.year >= start && item.year <= start + 9)
    .sort((a, b) => b.year - a.year);
  const total = years.reduce((sum, item) => sum + item.count, 0);
  const editionTotal = years.reduce((sum, item) => sum + (item.editionCount || 0), 0);

  if (note) {
    note.textContent = total
      ? `${start}–${start + 9} · ${fmtInt(years.length)} ${plural(years.length, ['год', 'года', 'лет'])}` +
        (editionTotal > 0
          ? ` · * — год издания у ${fmtInt(editionTotal)} ${plural(editionTotal, ['книга', 'книги', 'книг'])}`
          : '')
      : 'нет книг';
  }

  if (!total) {
    donutHost.append(decadeHint(`В ${selected.label} нет книг`));
    return;
  }

  const segments = years.map((item, index) => ({
    key: `year-${item.year}`,
    label: item.editionCount > 0 ? `${item.year}*` : String(item.year),
    value: item.count,
    year: item.year,
    editionCount: item.editionCount || 0,
    color: YEAR_COLORS[index % YEAR_COLORS.length],
  }));

  renderDonut(donutHost, {
    segments,
    legendHost,
    centerValue: fmtInt(total),
    centerLabel: 'книг',
    ariaLabel: `Распределение книг по годам издания: ${selected.label}`,
    secondary: (seg) => `${fmtPercent(seg.value, total)} книг десятилетия`,
    onSelect: (seg) => {
      const year = Number(seg.year);
      if (!Number.isFinite(year) || year <= 0) return;
      hideTooltip();
      openYearModal(year);
    },
  });
}

function openYearModal(year) {
  const target = Math.round(toNum(year));
  const books = Object.values(state.data.booksIndex).filter((entry) => entry.year === target);
  const editionCount = books.filter((entry) => entry.yearSource === 'edition').length;
  const manualCount = books.filter((entry) => entry.yearSource === 'manual').length;
  const marks = [
    editionCount > 0
      ? `${fmtInt(editionCount)} ${plural(editionCount, ['книга', 'книги', 'книг'])}: год издания`
      : '',
    manualCount > 0
      ? `${fmtInt(manualCount)} ${plural(manualCount, ['книга', 'книги', 'книг'])}: ручная правка`
      : '',
  ].filter(Boolean);
  openWorksModal({
    books,
    kicker: 'Год книги',
    title: `${fmtInt(target)} год`,
    subtitle: `${fmtInt(books.length)} ${plural(books.length, ['книга', 'книги', 'книг'])} с годом ${target}` +
      (marks.length ? ` · ${marks.join(' · ')}` : ''),
    groupLabel: String(target),
  });
}

/* ---------------- publication-year bars (full width) ---------------- */

/**
 * Full-width bar chart of read books by publication year.
 *
 * The data is the server-aggregated `years` array, so the source chips and the
 * manga toggle apply automatically: the payload arrives already filtered and
 * the frontend only paints it. films reuse the same chart primitive with the
 * film wording kept by default.
 */
function renderYearBarsWidget(data) {
  const host = $('books-yearbars-chart');
  const note = $('books-yearbars-note');
  if (!host) return;

  if (host._booksYearResize) {
    host._booksYearResize.disconnect();
    host._booksYearResize = null;
  }

  const years = data.years.slice().sort((a, b) => a.year - b.year);
  const options = {
    onYearClick: openYearModal,
    unitForms: ['книга', 'книги', 'книг'],
    shareLabel: 'всех книг',
    emptyText: 'Нет данных по годам издания',
    ariaLabel: years.length
      ? `Книги по годам издания: ${years[0].year} — ${years[years.length - 1].year}`
      : 'Книги по годам издания',
    // Honest tooltip: a year taken from the print run is marked, never called
    // a first publication.
    yearNote: (year, item) =>
      item && item.editionCount > 0
        ? `${fmtInt(item.editionCount)} ${plural(item.editionCount, ['книга', 'книги', 'книг'])}: год издания`
        : '',
  };
  renderYearBars(host, years, options);

  if (note) {
    const total = years.reduce((sum, item) => sum + item.count, 0);
    const ancient = toNum(data.summary && data.summary.ancientBookCount);
    const unknown = toNum(data.summary && data.summary.yearUnknownCount);
    const editionCount = toNum(data.summary && data.summary.yearEditionCount);
    const manualCount = toNum(data.summary && data.summary.yearManualCount);
    const ancientNote = ancient > 0 ? ` · ${fmtInt(ancient)} ${plural(ancient, ['книга', 'книги', 'книг'])} до 1000 г.` : '';
    // Edition fallback: an honest substitute for a first-publication year.
    const editionNote = editionCount > 0
      ? ` · ${fmtInt(editionCount)} ${plural(editionCount, ['книга', 'книги', 'книг'])}: год издания вместо первоиздания`
      : '';
    const manualNote = manualCount > 0
      ? ` · ${fmtInt(manualCount)} ${plural(manualCount, ['книга', 'книги', 'книг'])}: ручная правка`
      : '';
    // «Год неизвестен» is three states in one bucket. While the year queue is
    // open it is a backfill snapshot; once it drains, the remainder is either
    // an honest «providers don't know» verdict, a work still waiting for the
    // metadata link (the resolve chain) or — the 28.10.2026 root cause — an
    // export file that simply had no «Год издания» column. Never call the whole
    // bucket «провайдеры не знают» while unlinked works are still in it.
    const backfill = data.summary && data.summary.yearBackfill;
    const base = !years.length
      ? `${ancient > 0 ? `до 1000 г. · ${fmtInt(ancient)}` : 'нет данных'}${editionNote}${manualNote}`
      : years.length === 1
        ? `${years[0].year} · ${fmtInt(total)} ${plural(total, ['книга', 'книги', 'книг'])}${ancientNote}${editionNote}${manualNote}`
        : `${years[0].year} — ${years[years.length - 1].year} · ${fmtInt(total)} ${plural(total, ['книга', 'книги', 'книг'])}${ancientNote}${editionNote}${manualNote}`;
    note.textContent = base;
    if (unknown > 0) {
      note.append(document.createTextNode(' · '));
      note.append(unknownYearsButton(unknown));
      const reason = unknownYearsReason(backfill);
      if (reason) note.append(document.createTextNode(` — ${reason}`));
    }
  }

  if (typeof ResizeObserver === 'function') {
    const rerender = debounce(() => {
      if (!host.clientWidth) return;
      renderYearBars(host, years, options);
    }, 160);
    const observer = new ResizeObserver(rerender);
    observer.observe(host);
    host._booksYearResize = observer;
  }
}

/* ---------------- timeline ---------------- */

function openMonthModal(month) {
  const prefix = text(month);
  if (!/^\d{4}-\d{2}$/.test(prefix)) return;
  const books = Object.values(state.data.booksIndex)
    .filter((entry) => entry.finishedDate && entry.finishedDate.startsWith(prefix));
  const label = monthName(prefix);
  const dayCount = state.data.readDays.filter((day) => day.date.startsWith(prefix))
    .reduce((sum, day) => sum + day.count, 0);
  const daysWithReRead = state.data.readDays.filter((day) => day.date.startsWith(prefix))
    .reduce((sum, day) => sum + day.reReadCount, 0);
  const suffix = dayCount > books.length
    ? ` · ${fmtInt(dayCount)} ${plural(dayCount, ['прочтение', 'прочтения', 'прочтений'])}`
    : '';
  const reReadSuffix = daysWithReRead > 0
    ? ` (в т.ч. ${fmtInt(daysWithReRead)} ${plural(daysWithReRead, ['перечитка', 'перечитки', 'перечитываний'])})`
    : '';
  openBookListModal({
    kicker: 'История чтения',
    title: `Прочитано: ${label}`,
    subtitle: `${fmtInt(books.length)} ${plural(books.length, ['книга', 'книги', 'книг'])} · ${label}${suffix}${reReadSuffix}`,
    groupLabel: label,
    emptyText: 'За этот месяц нет книг с датой прочтения',
    books,
    sortScope: 'month',
    defaultSort: 'date',
  });
}

function renderTimeline(data) {
  const host = $('books-timeline-chart');
  if (!host) return;
  if (host._booksResize) {
    host._booksResize.disconnect();
    host._booksResize = null;
  }

  const onMonthClick = (month) => openMonthModal(month);
  renderBooksTimeline(host, data.timeline, { onMonthClick });

  const months = data.timeline.filter((item) => /^\d{4}-\d{2}$/.test(item.month));
  const note = $('books-timeline-note');
  if (note) {
    if (!months.length) note.textContent = 'нет данных';
    else if (months.length === 1) note.textContent = monthShort(months[0].month);
    else note.textContent = `${monthShort(months[0].month)} — ${monthShort(months[months.length - 1].month)}`;
  }

  if (typeof ResizeObserver === 'function') {
    const rerender = debounce(() => {
      if (!host.clientWidth) return;
      renderBooksTimeline(host, data.timeline, { onMonthClick });
    }, 160);
    const observer = new ResizeObserver(rerender);
    observer.observe(host);
    host._booksResize = observer;
  }
}

/* ---------------- calendar + streaks ---------------- */

function openDayModal(day) {
  const counts = new Map();
  for (const workId of day.ids) counts.set(workId, (counts.get(workId) || 0) + 1);
  const books = [];
  for (const [workId, views] of counts) {
    const entry = state.data.booksIndex[workId];
    if (!entry) continue;
    books.push(views > 1 ? { ...entry, reReadHint: true } : entry);
  }
  const count = Math.max(day.count, books.length);
  const reReads = Math.max(0, day.reReadCount);
  openBookListModal({
    kicker: 'Календарь чтения',
    title: fmtDayRu(day.date),
    subtitle: `${fmtInt(count)} ${plural(count, ['прочтение', 'прочтения', 'прочтений'])} · `
      + `${fmtInt(books.length)} ${plural(books.length, ['книга', 'книги', 'книг'])}`
      + (reReads > 0
        ? ` · в т.ч. ${fmtInt(reReads)} ${plural(reReads, ['перечитка', 'перечитки', 'перечитываний'])}`
        : ''),
    groupLabel: fmtDayRu(day.date),
    emptyText: 'За этот день нет книг',
    books,
    sortScope: 'readday',
    defaultSort: 'rating',
  });
}

function renderCalendar(data) {
  const section = $('books-calendar-widget');
  const host = $('books-calendar-host');
  const note = $('books-calendar-note');
  if (!section || !host) return;

  if (!data.readDays.length) {
    section.hidden = true;
    clear(host);
    return;
  }
  section.hidden = false;

  renderStreaks($('books-streak-card'), data.streaks);
  renderReadingCalendar(host, data.readDays, { onDayClick: openDayModal });

  if (note) {
    const days = data.readDays;
    const total = days.reduce((sum, day) => sum + day.count, 0);
    const reReads = days.reduce((sum, day) => sum + day.reReadCount, 0);
    note.textContent = `${fmtInt(days.length)} ${plural(days.length, ['день', 'дня', 'дней'])} · `
      + `${fmtInt(total)} ${plural(total, ['книга', 'книги', 'книг'])}`
      + (reReads > 0
        ? ` · ${fmtInt(reReads)} ${plural(reReads, ['перечитка', 'перечитки', 'перечитываний'])}`
        : '');
  }
}

/* =========================================================
   book list modal
   ========================================================= */

const BOOK_SORT_OPTIONS = [
  { key: 'rating', label: 'По оценке', hint: 'оценка ↓' },
  { key: 'date', label: 'По дате прочтения', hint: 'дата ↓' },
  { key: 'title', label: 'По названию', hint: 'название А–Я' },
];

function sortBooks(books, sortKey) {
  const list = books.slice();
  const cmpTitle = (a, b) => a.title.localeCompare(b.title, 'ru');
  const value = (entry) => (entry.rating == null ? -1 : entry.rating);
  if (sortKey === 'date') {
    return list.sort((a, b) => {
      const ad = a.finishedDate || '';
      const bd = b.finishedDate || '';
      if (ad !== bd) {
        if (!ad) return 1;
        if (!bd) return -1;
        return bd.localeCompare(ad);
      }
      return value(b) - value(a) || cmpTitle(a, b);
    });
  }
  if (sortKey === 'title') return list.sort(cmpTitle);
  return list.sort((a, b) => value(b) - value(a) || cmpTitle(a, b));
}

function getBookSort(scope, fallback) {
  const saved = safeStorageGet(`${SORT_KEY}${scope || 'books'}`) || '';
  return BOOK_SORT_OPTIONS.some((option) => option.key === saved) ? saved : fallback;
}

function createBookSortSelect(scope, fallback, onChange) {
  const wrap = el('div', { class: 'modal-sort' });
  wrap.append(el('span', { class: 'modal-sort-label', text: 'Сортировка' }));
  const selectWrap = el('div', { class: 'select-wrap' });
  const select = el('select', { class: 'select select-sm', 'aria-label': 'Сортировка книг' });
  for (const option of BOOK_SORT_OPTIONS) {
    select.append(el('option', { value: option.key, text: option.label }));
  }
  select.value = getBookSort(scope, fallback || 'rating');
  select.addEventListener('change', () => {
    safeStorageSet(`${SORT_KEY}${scope || 'books'}`, select.value);
    onChange(select.value);
  });
  selectWrap.append(select);
  selectWrap.append(el('span', { class: 'select-chevron', html: icon('chevron', 14) }));
  wrap.append(selectWrap);
  return wrap;
}

function bookRatingNode(entry) {
  const node = el('div', { class: 'film-rating book-rating' });
  if (entry.rating == null) {
    node.textContent = '—';
    node.classList.add('is-empty');
    return node;
  }
  node.append(el('span', { class: 'film-rating-star', text: '★' }));
  node.append(el('span', { text: String(entry.rating) }));
  node.title = `Ваша оценка: ${entry.rating} из 10`;
  return node;
}

function bookYearLabel(entry) {
  if (!entry || !entry.year) return '';
  if (entry.yearSource === 'edition') return `${entry.year}*`;
  if (entry.yearSource === 'manual') return `${entry.year}✎`;
  return String(entry.year);
}

function bookYearTitle(entry) {
  if (!entry) return '';
  if (entry.yearSource === 'manual') {
    return `Ручная правка: ${entry.year}`;
  }
  if (entry.yearSource === 'edition') {
    const channel = entry.editionYearSource === 'file'
      ? 'год издания из выгрузки LiveLib'
      : 'год издания от провайдера';
    return `Год издания: ${entry.year} · ${channel} · первоиздание неизвестно`;
  }
  const edition = entry.editionYear && entry.editionYear !== entry.year
    ? ` · это издание: ${entry.editionYear}`
    : '';
  return `Первое издание: ${entry.year}${edition}`;
}

function bookRow(entry) {
  const row = el('div', { class: 'film-row film-row-static book-row' });
  const title = entry.title || 'Без названия';
  row.append(bookCover(entry.coverUrl, title));

  const info = el('div', { class: 'film-info' });
  const titleNode = el('div', { class: 'film-title', text: title });
  const yearLabel = bookYearLabel(entry);
  if (yearLabel) {
    const yearNode = el('span', {
      class: `film-year${entry.yearSource === 'edition' ? ' is-edition-year' : ''}` +
        `${entry.yearSource === 'manual' ? ' is-manual-year' : ''}`,
      text: yearLabel,
    });
    yearNode.title = bookYearTitle(entry);
    titleNode.append(yearNode);
    titleNode.title = bookYearTitle(entry);
  }
  if (entry.titleOriginal && entry.titleOriginal !== title) titleNode.title = entry.titleOriginal;
  info.append(titleNode);

  if (entry.authors.length) {
    info.append(el('div', { class: 'book-authors', text: entry.authors.join(', ') }));
  }

  const meta = el('div', { class: 'film-char book-meta' });
  if (entry.sources.length) meta.append(sourceTags(entry.sources));
  const metaTag = metadataTag(entry.metadataSources);
  if (metaTag) meta.append(metaTag);
  if (entry.mangaComics === true) {
    meta.append(el('span', { class: 'book-meta-item', text: 'манга/комикс' }));
  }
  if (entry.publisher) meta.append(el('span', { class: 'book-meta-item', text: entry.publisher }));
  if (entry.pages) meta.append(el('span', { class: 'book-meta-item', text: `${fmtInt(entry.pages)} стр.` }));
  if (entry.reReadHint) meta.append(el('span', { class: 'tag recent-rewatch', text: 'перечитано' }));
  if (meta.childNodes.length) info.append(meta);
  row.append(info);

  const controls = el('div', { class: 'film-row-controls' });
  controls.append(bookRatingNode(entry));
  const menu = renderBookMenu(entry);
  if (menu) controls.append(menu);
  row.append(controls);
  return row;
}

/**
 * Reusable book list modal (rating / genre / author / series / month / day).
 * Mirrors openFilmListModal: batched rows, sort selector, Escape/backdrop
 * handled by the shared modal shell.
 */
function openBookListModal({
  title,
  kicker = '',
  subtitle = '',
  hint = '',
  groupLabel = 'Книги',
  emptyText = 'Нет книг',
  batch = 60,
  books = [],
  sortScope = '',
  defaultSort = 'rating',
} = {}) {
  const head = el('div', { class: 'modal-head' });
  const copy = el('div', { class: 'modal-head-copy' });
  if (kicker) copy.append(el('div', { class: 'modal-role', text: kicker }));
  copy.append(el('h2', { class: 'modal-title', text: title || 'Книги' }));
  if (subtitle) copy.append(el('div', { class: 'modal-sub', text: subtitle }));
  if (hint) copy.append(el('p', { class: 'modal-hint', text: hint }));
  head.append(copy);

  bookModalSeq += 1;
  const titleId = `book-list-title-${bookModalSeq}`;
  copy.querySelector('.modal-title').id = titleId;

  const body = el('div', { class: 'modal-body' });
  const list = (Array.isArray(books) ? books : []).filter(Boolean);
  let sortKey = sortScope ? getBookSort(sortScope, defaultSort) : null;
  let ordered = sortKey ? sortBooks(list, sortKey) : list;
  let shown = Math.min(Math.max(10, Math.min(Number(batch) || 60, 200)), ordered.length);
  let renderVisible = null;
  let groupNoteNode = null;

  if (sortScope && list.length) {
    groupNoteNode = el('span', { text: '' });
    head.append(createBookSortSelect(sortScope, defaultSort, (value) => {
      sortKey = value;
      ordered = sortBooks(list, sortKey);
      const option = BOOK_SORT_OPTIONS.find((item) => item.key === sortKey);
      if (groupNoteNode) groupNoteNode.textContent = option ? option.hint : '';
      if (renderVisible) renderVisible();
    }));
    const option = BOOK_SORT_OPTIONS.find((item) => item.key === sortKey);
    groupNoteNode.textContent = option ? option.hint : '';
  }

  if (!list.length) {
    body.append(emptyState(emptyText));
  } else {
    const group = el('div', { class: 'film-group-label' });
    group.append(el('span', { text: groupLabel }));
    if (groupNoteNode) group.append(groupNoteNode);
    body.append(group);

    const listHost = el('div', { class: 'film-list' });
    const moreHost = el('div', { class: 'modal-more' });
    body.append(listHost, moreHost);

    renderVisible = () => {
      clear(listHost);
      clear(moreHost);
      for (const entry of ordered.slice(0, shown)) listHost.append(bookRow(entry));
      if (shown < ordered.length) {
        const more = el('button', {
          type: 'button',
          class: 'btn btn-ghost',
          text: `Показать ещё ${fmtInt(Math.min(batch, ordered.length - shown))}`,
        });
        more.addEventListener('click', () => {
          shown = Math.min(ordered.length, shown + batch);
          renderVisible();
        });
        moreHost.append(more);
      }
    };
    renderVisible();
  }

  return openModal({ head, body, labelledBy: titleId, className: 'modal-films modal-books' });
}

/* =========================================================
   book links menu (kebab)
   ========================================================= */

function closeBookMenu() {
  const close = openBookMenuClose;
  openBookMenuClose = null;
  if (close) close();
}

/**
 * Manual manga/comics override: hide a stubborn work or bring a wrongly
 * detected one back. The request is per workId, persists on the server in
 * `cache-book/flags/book-flags.json`, and the dashboard is refetched so every
 * widget (counts, calendar, authors) reflects the change at once.
 */
async function setMangaOverride(book, mangaComics, message) {
  if (!book || !book.workId || state.mangaBusy) return;
  state.mangaBusy = true;
  try {
    await setBookMangaFlag(book.workId, mangaComics);
    toast(message, 'success');
    await loadStats({ force: true, silent: true });
  } catch (error) {
    toast(shortErrorMessage(error), 'error', { duration: 7000 });
  } finally {
    state.mangaBusy = false;
  }
}

async function clearMangaOverride(book) {
  if (!book || !book.workId || state.mangaBusy) return;
  state.mangaBusy = true;
  try {
    await clearBookMangaFlag(book.workId);
    toast('Ручная метка сброшена: снова решает детектор', 'info');
    await loadStats({ force: true, silent: true });
  } catch (error) {
    toast(shortErrorMessage(error), 'error', { duration: 7000 });
  } finally {
    state.mangaBusy = false;
  }
}

const YEAR_PROVIDER_LABEL = {
  litres: 'Литрес',
  hardcover: 'Hardcover',
  openlibrary: 'Open Library',
  googlebooks: 'Google Books',
  'livelib-file': 'LiveLib-файл',
  livelib: 'LiveLib',
};

function bookYearSourceText(book) {
  if (!book) return '';
  if (book.yearSource === 'manual') return `Ручная правка: ${book.yearOverride ?? book.year}`;
  if (book.yearSource === 'edition') {
    const channel = book.editionYearSource === 'file'
      ? 'из выгрузки LiveLib'
      : 'от провайдера';
    return `Год издания ${book.editionYear ?? book.year} (${channel}) · первоиздание неизвестно`;
  }
  if (book.yearSource === 'first') {
    const source = book.firstPublishedYearSource
      ? YEAR_PROVIDER_LABEL[book.firstPublishedYearSource] || book.firstPublishedYearSource
      : '';
    return `Первоиздание ${book.firstPublishedYear ?? book.year}${source ? ` (${source})` : ''}`;
  }
  return 'Год неизвестен';
}

/**
 * Manual year correction from the book card / a year bucket list.
 *
 * The server stores the edit per profile and it outranks every provider
 * (`manual > first > edition > unknown`); after saving the dashboard is
 * refetched silently, so the decade/year charts move at once.
 */
function openYearEditModal(book) {
  if (!book || !book.workId) return;
  const profile = activeProfileKey();
  if (!profile) {
    toast('Сначала выберите профиль', 'error');
    return;
  }

  const head = el('div', { class: 'modal-head' });
  const copy = el('div', { class: 'modal-head-copy' });
  copy.append(el('div', { class: 'modal-role', text: 'Год книги' }));
  copy.append(el('h2', { class: 'modal-title', text: book.title || 'Без названия' }));
  head.append(copy);

  const body = el('div', { class: 'modal-body' });
  body.append(el('p', {
    class: 'modal-hint',
    text: `Сейчас: ${bookYearSourceText(book)}. Год можно исправить вручную — правка важнее провайдеров и не сбрасывается обновлением метаданных.`,
  }));

  const field = el('label', { class: 'field' });
  field.append(el('span', { class: 'field-label', text: 'Год' }));
  const input = el('input', {
    class: 'input',
    type: 'number',
    min: '-3000',
    max: '2100',
    step: '1',
    inputmode: 'numeric',
    'aria-label': 'Год книги',
  });
  const fallback = book.yearOverride ?? book.editionYear ?? book.firstPublishedYear ?? book.year ?? '';
  input.value = fallback === '' || fallback == null ? '' : String(fallback);
  field.append(input);
  body.append(field);

  const actions = el('div', { class: 'modal-actions' });
  const cancel = el('button', { type: 'button', class: 'btn btn-ghost', text: 'Отмена' });
  actions.append(cancel);
  if (book.yearOverride != null) {
    const reset = el('button', { type: 'button', class: 'btn btn-ghost', text: 'Сбросить правку' });
    reset.addEventListener('click', async () => {
      reset.disabled = true;
      try {
        await setBookYearOverride(profile, book.workId, null);
        toast('Ручная правка года сброшена', 'info');
        modal.close();
        await loadStats({ force: true, silent: true });
      } catch (error) {
        reset.disabled = false;
        toast(shortErrorMessage(error), 'error', { duration: 7000 });
      }
    });
    actions.append(reset);
  }
  const save = el('button', { type: 'button', class: 'btn btn-primary', text: 'Сохранить' });
  actions.append(save);
  body.append(actions);

  const modal = openModal({ head, body, className: 'modal-books' });
  cancel.addEventListener('click', () => modal.close());
  save.addEventListener('click', async () => {
    const raw = String(input.value || '').trim();
    const year = Number(raw);
    if (!raw || !Number.isInteger(year) || year < -3000 || year > 2100) {
      toast('Год должен быть целым числом от -3000 до 2100', 'error');
      input.focus();
      return;
    }
    save.disabled = true;
    try {
      await setBookYearOverride(profile, book.workId, year);
      toast('Год сохранён', 'success');
      modal.close();
      await loadStats({ force: true, silent: true });
    } catch (error) {
      save.disabled = false;
      toast(shortErrorMessage(error), 'error', { duration: 7000 });
    }
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save.click();
    }
  });
  input.focus();
  input.select();
}

/**
 * Kebab menu with the known source links and the manual manga/comics toggle.
 * Books MVP has no manual re-match, so unlike renderFilmMenu() there is no
 * "Исправить матч" item at all.
 */
export function renderBookMenu(book) {
  if (!book) return null;
  const items = [];
  if (book.links && book.links.livelib) {
    items.push({ kind: 'link', service: 'll', label: 'LiveLib', href: book.links.livelib });
  }
  if (book.links && book.links.hardcover) {
    items.push({ kind: 'link', service: 'hc', label: 'Hardcover', href: book.links.hardcover });
  }
  if (book.workId) {
    items.push({
      kind: 'action',
      icon: 'book',
      label: 'Исправить год',
      action: () => openYearEditModal(book),
    });
    // `mangaComics` is the effective flag (detector ∪ series ∪ manual);
    // `mangaComicsOverride` is only the user's own decision.
    if (book.mangaComics !== true) {
      items.push({
        kind: 'action',
        icon: 'book',
        label: 'Скрыть как манга/комикс',
        action: () => setMangaOverride(book, true, 'Скрыто как манга/комикс'),
      });
    }
    if (book.mangaComics === true) {
      items.push({
        kind: 'action',
        icon: 'check',
        label: 'Показать снова',
        action: () => setMangaOverride(book, false, 'Книга снова в статистике'),
      });
    }
    if (book.mangaComicsOverride != null) {
      items.push({
        kind: 'action',
        icon: 'refresh',
        label: 'Сбросить ручную метку',
        action: () => clearMangaOverride(book),
      });
    }
  }
  if (!items.length) return null;

  const wrap = el('div', { class: 'film-menu book-menu' });
  const toggle = el('button', {
    type: 'button',
    class: 'film-menu-toggle',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-label': 'Ссылки на книгу',
    title: 'Ссылки на книгу',
    html: icon('more', 16),
  });
  wrap.append(toggle);

  let popup = null;
  let openedAt = 0;

  function cleanup() {
    toggle.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onWindowChange, true);
    window.removeEventListener('resize', onWindowChange);
  }

  function close() {
    cleanup();
    if (popup) {
      popup.remove();
      popup = null;
    }
  }

  function onDocPointerDown(event) {
    if (popup && popup.contains(event.target)) return;
    if (wrap.contains(event.target)) return;
    closeBookMenu();
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    // Escape closes the menu layer only — the modal underneath stays open.
    event.preventDefault();
    event.stopPropagation();
    closeBookMenu();
  }

  function onWindowChange(event) {
    if (Date.now() - openedAt < 350) return;
    if (event && event.type === 'scroll' && popup && popup.contains(event.target)) return;
    closeBookMenu();
  }

  function open() {
    closeBookMenu();
    popup = el('div', {
      class: 'film-menu-popup book-menu-popup',
      role: 'menu',
      'aria-label': `Ссылки: ${book.title || 'книга'}`,
    });
    for (const item of items) {
      if (item.kind === 'action') {
        const button = el('button', {
          type: 'button',
          class: 'film-menu-item',
          role: 'menuitem',
        },
          el('span', { class: 'film-menu-icon', html: icon(item.icon || 'book', 14) }),
          el('span', { class: 'film-menu-label', text: item.label }),
        );
        button.addEventListener('click', () => {
          closeBookMenu();
          item.action();
        });
        popup.append(button);
        continue;
      }
      const anchor = el('a', {
        class: 'film-menu-item',
        role: 'menuitem',
        href: item.href,
        target: '_blank',
        rel: 'noopener noreferrer',
      },
        el('span', { class: 'film-menu-icon', html: serviceIcon(item.service, 14) }),
        el('span', { class: 'film-menu-label', text: item.label }),
      );
      anchor.addEventListener('click', () => closeBookMenu());
      popup.append(anchor);
    }

    document.body.append(popup);
    toggle.setAttribute('aria-expanded', 'true');

    const rect = toggle.getBoundingClientRect();
    popup.style.visibility = 'hidden';
    const popupRect = popup.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right - popupRect.width, window.innerWidth - popupRect.width - 8));
    let top = rect.bottom + 6;
    if (top + popupRect.height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - popupRect.height - 6);
    }
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
    popup.style.visibility = '';

    openBookMenuClose = close;
    openedAt = Date.now();
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onWindowChange, true);
    window.addEventListener('resize', onWindowChange);
  }

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    if (popup) {
      closeBookMenu();
      return;
    }
    open();
  });

  return wrap;
}

/* =========================================================
   public API used by main.js
   ========================================================= */

/**
 * Bind the books UI once. `onActivate` is called whenever the books module
 * wants its section to be the visible view (async loads, progress screen).
 */
export function initBooks({ onActivate } = {}) {
  state.onActivate = typeof onActivate === 'function' ? onActivate : null;
  state.includeManga = readJson(MANGA_STORAGE_KEY, false) === true;

  const hardcoverForm = $('books-hardcover-form');
  if (hardcoverForm) {
    hardcoverForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = $('books-hardcover-userid');
      const raw = text(input && input.value);
      if (!raw) {
        // No implicit token-owner default any more: the profile owns the id.
        setSourceError('hardcover', 'Введите числовой ID пользователя Hardcover.');
        if (input) input.focus();
        return;
      }
      if (!isValidHardcoverUser(raw)) {
        setSourceError('hardcover', 'ID пользователя Hardcover — это число.');
        if (input) input.focus();
        return;
      }
      startImport('hardcover', raw);
    });
  }

  const fileForm = $('books-livelib-file-form');
  if (fileForm) {
    fileForm.addEventListener('submit', (event) => {
      event.preventDefault();
      submitFileImport();
    });
  }
  const fileInput = $('books-livelib-file');
  if (fileInput) {
    // A new pick invalidates the previous result/error: the block always talks
    // about the file the user is looking at.
    fileInput.addEventListener('change', () => {
      const name = $('books-livelib-file-name');
      if (name) {
        const picked = fileInput.files && fileInput.files[0] ? fileInput.files[0].name : '';
        name.textContent = picked || 'Файл не выбран';
        name.classList.toggle('is-set', Boolean(picked));
      }
      setFileImportError('');
      renderFileImportResult(null);
    });
  }

  const profileBtn = $('books-profile-btn');
  if (profileBtn) {
    profileBtn.addEventListener('click', () => setProfileMenuOpen(!state.profileMenuOpen));
  }
  const profileAdd = $('books-profile-add');
  if (profileAdd) {
    profileAdd.addEventListener('click', () => openProfileModal());
  }
  const createFirst = $('books-profile-create-first');
  if (createFirst) {
    createFirst.addEventListener('click', () => openProfileModal());
  }
  const metadataBadgeNode = $('books-metadata-badge');
  if (metadataBadgeNode) {
    const show = (event) => {
      const meta = state.data && state.data.summary ? state.data.summary.metadata : null;
      const view = metadataBadge(meta);
      if (!view) return;
      showTooltip(view.text, view.hint);
      if (event) moveTooltip(event);
    };
    metadataBadgeNode.addEventListener('pointerenter', show);
    metadataBadgeNode.addEventListener('pointermove', moveTooltip);
    metadataBadgeNode.addEventListener('pointerleave', hideTooltip);
    // Touch/keyboard: a click shows the same hint (there is no hover).
    metadataBadgeNode.addEventListener('click', show);
  }
  document.addEventListener('click', (event) => {
    if (!state.profileMenuOpen) return;
    const switcher = $('books-profile-switcher');
    if (switcher && switcher.contains(event.target)) return;
    closeProfileMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (!state.profileMenuOpen || event.key !== 'Escape') return;
    closeProfileMenu();
    const trigger = $('books-profile-btn');
    if (trigger) trigger.focus();
  });

  const filters = $('books-filters');
  if (filters) {
    filters.addEventListener('click', (event) => {
      // The source chips are gone; a profile is one source. Ignore any stale
      // `.source-chip` markup instead of issuing a filtered request.
      const button = event.target.closest('.source-chip');
      if (button) event.preventDefault();
    });
  }

  const mangaToggle = $('books-manga-toggle');
  if (mangaToggle) {
    mangaToggle.checked = state.includeManga;
    mangaToggle.addEventListener('change', () => {
      safeStorageSet(MANGA_STORAGE_KEY, mangaToggle.checked ? 'true' : 'false');
      setIncludeManga(mangaToggle.checked);
    });
  }

  const authorSearch = $('books-authors-search');
  if (authorSearch) {
    authorSearch.addEventListener('input', () => {
      authorsState.query = authorSearch.value.trim();
      if (authorsState.query) authorsState.visible = Math.max(authorsState.visible, AUTHORS_BATCH);
      else if (!authorsState.expanded) authorsState.visible = AUTHORS_INITIAL;
      if (state.data) renderAuthors(state.data);
    });
  }

  const refresh = $('books-refresh');
  if (refresh) {
    refresh.addEventListener('click', (event) => {
      event.preventDefault();
      // Shift+click = full Hardcover journal re-read (the default is the
      // incremental `updated_at` diff, which is one query for one new book).
      refreshProfiles({ force: Boolean(event.shiftKey) });
    });
  }

  const reimport = $('books-reimport');
  if (reimport) {
    reimport.addEventListener('click', () => {
      stopPolling();
      hideJobs();
      showScreen('import');
    });
  }

  const back = $('books-progress-back');
  if (back) {
    back.addEventListener('click', () => {
      // Keep the running job in state/localStorage: the import screen lets the
      // user start the second source, and returning to progress resumes both.
      stopPolling();
      showScreen('import');
    });
  }
}

/**
 * Called by main.js when the books tab becomes active. Reuses the rendered
 * dashboard, resumes a pending import or loads the stats payload.
 */
export async function showBooks() {
  state.active = true;
  if (state.active && state.onActivate) state.onActivate();
  // The local registry is authoritative for scoping; load it before any
  // request so `profile=` can never be missing on the first paint.
  await ensureProfiles();
  if (state.refresh) {
    // The refresh keeps running while the user visits Films; returning to the
    // tab must re-attach the progress view, not load stale stats.
    if (state.onActivate) state.onActivate();
    showScreen('progress');
    renderProgress();
    startPolling();
    return;
  }
  if (state.view === 'dashboard' && state.data) {
    if (state.onActivate) state.onActivate();
    // Resume the metadata badge poller after a tab switch (the payload may
    // still report a running resolve stage).
    renderMetadataBadge(state.data);
    return;
  }
  if (state.view === 'progress' && hasJobs()) {
    if (state.onActivate) state.onActivate();
    startPolling();
    return;
  }
  if (state.loading) {
    if (state.onActivate) state.onActivate();
    return;
  }
  hydrateJobs();
  if (hasJobs()) {
    if (state.onActivate) state.onActivate();
    showScreen('progress');
    renderProgress();
    startPolling();
    return;
  }
  await loadStats({ force: true });
}

/** Called by main.js when another tab takes over. */
export function hideBooks() {
  state.active = false;
  // A manual refresh continues on the server and in the background poller;
  // only idle/import polling is paused while the tab is hidden.
  if (!state.refresh) stopPolling();
  stopMetadataPolling();
  closeBookMenu();
  closeProfileMenu();
}

/** Drop every in-memory book artefact (logout / different user session). */
export function resetBooks() {
  stopPolling();
  stopMetadataPolling();
  closeBookMenu();
  closeProfileMenu();
  state.loaded = false;
  state.data = null;
  state.jobs = {};
  state.refresh = null;
  state.refreshStarting = false;
  state.selectedDecade = null;
  // The registry itself is device-scoped (IndexedDB), not session-scoped: a
  // logout must not delete the user's book profiles, only the in-memory view.
  state.profilesReady = false;
  state.profile = null;
  state.profiles = [];
  authorsState.visible = AUTHORS_INITIAL;
  authorsState.expanded = false;
  authorsState.query = '';
  state.view = 'import';
  state.seq += 1; // abort any in-flight render
  saveJobs();
  showScreen('import');
  renderProfileSwitcher();
}
