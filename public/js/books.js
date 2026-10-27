/* Books tab: import screen, import progress, dashboard and modals.
 *
 * One module owns the whole book namespace: `/api/books/*` payload
 * normalisation, the LiveLib ∪ Hardcover import flow, every widget and the
 * book-specific link menu. Film code is not imported here except for the
 * generic primitives (donut, modal shell, toasts, icons).
 *
 * Design notes:
 *  - the source filter is a *server-side* filter (`?sources=`), because the
 *    payload is aggregated per source and merging on the client would fight
 *    the "profile = union" contract;
 *  - no IndexedDB cache for books in the MVP: a cold start either returns
 *    stats or opens the import screen;
 *  - the payload is parsed tolerantly: the quick API contract (`score`,
 *    `finished`, `reReadCount`, `summary.sources: [names]`) and the fuller
 *    doc version (`rating`, `read`, `decades[].decade`, `sources.connected`)
 *    are both accepted.
 */

import {
  getBooksStats, startBooksImportLivelib, startBooksImportHardcover, getBooksImportStatus,
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
const ACCOUNTS_KEY = 'kinoboxd.books.accounts.v1';
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
  source: '', // '' (all) | livelib | hardcover
  includeManga: false, // ?includeMangaComics=0|1, default off
  data: null,
  error: null,
  seq: 0,
  connected: [],
  selectedDecade: null,
  jobs: {}, // source -> { jobId, status, failed, account }
  starting: {},
  accounts: {},
  pollTimer: 0,
  pollSeq: 0,
  onActivate: null,
};

let openBookMenuClose = null;
let bookModalSeq = 0;
let inflightLoad = null;

/* Authors widget paging/search. Kept outside the payload so a refetch (source
 * chip or manga toggle) does not silently drop the user's query. */
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
  if (direct != null) return Math.round(direct);
  const bySource = entry && entry.ratingsBySource && typeof entry.ratingsBySource === 'object'
    ? entry.ratingsBySource
    : {};
  const convert = (value, scale) => {
    const n = numOrNull(value);
    const s = numOrNull(scale);
    if (n == null) return null;
    if (s && s > 0 && s !== 10) return Math.round((n * 10) / s);
    return Math.round(n);
  };
  const hardcover = bySource.hardcover && typeof bySource.hardcover === 'object'
    ? bySource.hardcover
    : null;
  const livelib = bySource.livelib && typeof bySource.livelib === 'object'
    ? bySource.livelib
    : null;
  const hc = hardcover
    ? convert(hardcover.rating10 != null ? hardcover.rating10 : hardcover.rating,
      hardcover.rating10 != null ? 10 : hardcover.scale)
    : null;
  if (hc != null) return hc;
  return livelib
    ? convert(livelib.rating10 != null ? livelib.rating10 : livelib.rating,
      livelib.rating10 != null ? 10 : livelib.scale)
    : null;
}

function normalizeRatingsBySource(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of ['livelib', 'hardcover']) {
    const item = source[key] && typeof source[key] === 'object' ? source[key] : null;
    if (!item) continue;
    const native = numOrNull(item.rating);
    const scale = numOrNull(item.scale);
    const rating10 = item.rating10 != null
      ? Math.round(toNum(item.rating10))
      : (native != null && scale ? Math.round((native * 10) / scale) : null);
    out[key] = { rating: native, scale, rating10 };
  }
  return out;
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
  return {
    workId: text(workId),
    title: firstString(entry.titleRu, entry.title) || text(workId),
    titleOriginal: entry.titleRu ? text(entry.title) : '',
    authors,
    publisher: text(entry.publisher),
    year: numOrNull(entry.year),
    pages: numOrNull(entry.pages != null ? entry.pages : entry.pagesOfEdition),
    genres: genreNames,
    series: text(entry.series),
    coverUrl: text(entry.coverUrl || entry.cover),
    rating: pickRating10(entry),
    ratingsBySource: normalizeRatingsBySource(entry.ratingsBySource),
    sources: sources.length
      ? sources
      : Object.keys(normalizeRatingsBySource(entry.ratingsBySource)),
    metadataSources: normalizeMetadataSources(entry.metadataSources),
    mangaComics,
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
  const ratingsRaw = source.ratings && typeof source.ratings === 'object' ? source.ratings : {};
  const bySourceRaw = ratingsRaw.bySource && typeof ratingsRaw.bySource === 'object'
    ? ratingsRaw.bySource
    : {};
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
      count: Math.max(0, toNum(item && item.count)),
    };
  }).filter((item) => item.label && item.count > 0)
    .sort((a, b) => b.start - a.start || b.label.localeCompare(a.label, 'ru'));

  const years = arr(source.years).map((item) => ({
    year: Math.round(toNum(item && item.year, 0)),
    count: Math.max(0, toNum(item && item.count)),
  })).filter((item) => item.year > 0 && item.count > 0);

  const timeline = arr(source.timeline).map((item) => ({
    month: text(item && item.month),
    finished: Math.max(0, toNum(item && (item.finished ?? item.read ?? item.watched))),
    reRead: Math.max(0, toNum(item && (item.reRead ?? item.reReadCount))),
    livelib: Math.max(0, toNum(item && (item.livelib ?? (item.bySource && item.bySource.livelib)))),
    hardcover: Math.max(0, toNum(item && (item.hardcover ?? (item.bySource && item.bySource.hardcover)))),
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
      const date = text(item && (item.date || item.finishedAt)).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      return {
        date,
        workId: text(item && item.workId),
        source: text(item && item.source).toLowerCase(),
        reRead: Boolean(item && (item.reRead || item.reread)),
        title: firstString(item && item.title, entry && entry.title),
        coverUrl: firstString(item && item.coverUrl, entry && entry.coverUrl),
      };
    })
    .filter((item) => item && item.workId)
    .sort((a, b) => b.date.localeCompare(a.date));

  const ratings = {
    merged: normalizeRatingList(ratingsRaw.merged),
    bySource: {
      livelib: normalizeRatingList(bySourceRaw.livelib),
      hardcover: normalizeRatingList(bySourceRaw.hardcover),
    },
  };

  const summary = {
    bookCount: Math.max(0, toNum(summaryRaw.bookCount)),
    eventCount: Math.max(0, toNum(summaryRaw.eventCount ?? summaryRaw.readCount)),
    finishedCount: Math.max(0, toNum(summaryRaw.finishedCount)),
    reReadCount: Math.max(0, toNum(summaryRaw.reReadCount)),
    undatedEventCount: Math.max(0, toNum(summaryRaw.undatedEventCount)),
    readCount: Math.max(0, toNum(summaryRaw.readCount)),
    pageCount: numOrNull(summaryRaw.pageCount),
    avgPages: numOrNull(summaryRaw.avgPages),
    avgRating: numOrNull(summaryRaw.avgRating),
    dateFrom: text(summaryRaw.dateFrom) || null,
    dateTo: text(summaryRaw.dateTo) || null,
    mangaExcluded: Math.max(0, toNum(summaryRaw.mangaExcluded)),
  };
  if (!summary.eventCount) summary.eventCount = summary.finishedCount;
  if (!summary.bookCount) summary.bookCount = Object.keys(booksIndex).length;

  const sourceBreakdown = arr(source.sourceBreakdown).map((item) => ({
    source: text(item && item.source).toLowerCase(),
    events: Math.max(0, toNum(item && item.events)),
    books: Math.max(0, toNum(item && item.books)),
    avgRating: numOrNull(item && item.avgRating),
    finishedWithDate: Math.max(0, toNum(item && item.finishedWithDate)),
  })).filter((item) => SOURCE_LABEL[item.source]);

  return {
    connected: connected.length
      ? connected
      : [...new Set([...sourceBreakdown.map((item) => item.source), ...Object.keys(bySourceRaw)])]
        .filter((item) => SOURCE_LABEL[item]),
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
    booksIndex,
    hasMangaField,
    sourceBreakdown,
  };
}

/* =========================================================
   view switching inside the books section
   ========================================================= */

function showScreen(name) {
  state.view = name;
  const screens = {
    import: $('books-import'),
    progress: $('books-progress'),
    dashboard: $('books-dash'),
  };
  for (const [key, node] of Object.entries(screens)) {
    if (node) node.hidden = key !== name;
  }
  const refresh = $('books-refresh');
  if (refresh) refresh.hidden = name !== 'dashboard';
  const reimport = $('books-reimport');
  if (reimport) reimport.hidden = name !== 'dashboard';
  if (state.active && state.onActivate) state.onActivate();
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

  try {
    const raw = await getBooksStats({
      sources: state.source,
      includeMangaComics: state.includeManga,
    });
    if (seq !== state.seq) return;
    state.data = normalizeBooks(raw);
    state.connected = state.data.connected;
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
    renderDashboardBooks(state.data);
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
   import: start, progress, polling
   ========================================================= */

function readAccounts() {
  const saved = readJson(ACCOUNTS_KEY, null);
  if (saved && typeof saved === 'object') {
    for (const key of ['livelib', 'hardcover']) {
      const value = text(saved[key]);
      if (value) state.accounts[key] = value;
    }
  }
  const livelib = $('books-livelib-username');
  if (livelib && state.accounts.livelib) livelib.value = state.accounts.livelib;
  const hardcover = $('books-hardcover-userid');
  if (hardcover && state.accounts.hardcover) hardcover.value = state.accounts.hardcover;
}

function saveAccounts() {
  safeStorageSet(ACCOUNTS_KEY, JSON.stringify(state.accounts));
}

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
      status: null,
      failed: null,
      startedAt: Number(item.startedAt) || Date.now(),
    };
    if (item.account) state.accounts[source] = text(item.account);
  }
  if (hasJobs()) saveAccounts();
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

async function startImport(source, account) {
  if (state.starting[source]) return;
  setSourceError(source, '');
  setSourceBusy(source, true);
  try {
    const response = source === 'livelib'
      ? await startBooksImportLivelib(account)
      : await startBooksImportHardcover(account);
    const jobId = text(response && (response.jobId || response.job_id || response.id || (response.job && response.job.id)));
    state.accounts[source] = account;
    saveAccounts();

    if (!jobId) {
      // Some server versions can answer "already done" without a job id.
      if (response && (response.done || response.stage === 'done')) {
        hideJobs();
        await loadStats({ force: true });
        return;
      }
      throw new Error('Сервер не вернул идентификатор задачи импорта.');
    }

    state.jobs[source] = {
      jobId,
      account,
      status: response && typeof response === 'object' ? response : null,
      failed: null,
      startedAt: Date.now(),
    };
    saveJobs();
    showScreen('progress');
    renderProgress();
    startPolling();
  } catch (error) {
    if (error && error.status === 401) return;
    setSourceError(source, shortErrorMessage(error));
    toast(`Не удалось запустить импорт ${sourceLabel(source)}`, 'error', { duration: 6500 });
  } finally {
    setSourceBusy(source, false);
  }
}

function progressPercent(status) {
  if (!status) return 0;
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
  const done = status.done || status.stage === 'done';
  return done ? 100 : 0;
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

function renderProgress() {
  const host = $('books-progress-jobs');
  const statusNode = $('books-progress-status');
  const kicker = $('books-progress-kicker');
  const title = $('books-progress-title');
  if (!host) return;
  clear(host);

  const jobs = jobList();
  if (kicker) {
    kicker.textContent = jobs
      .map(([source]) => SOURCE_LABEL[source])
      .join(' ∪ ') || 'книжный импорт';
  }
  if (title) title.textContent = 'Собираем книжный профиль';

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
      text: stageText(source, job),
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

    const meta = statusMeta(status);
    if (meta) row.append(el('div', { class: 'books-job-meta', text: meta }));
    totalEvents += Array.isArray(status.events) ? status.events.length : Math.max(0, toNum(status.events));
    host.append(row);
  }

  if (statusNode) {
    const failed = jobs.filter(([, job]) => job.failed || (job.status && job.status.error));
    if (failed.length) {
      statusNode.textContent = 'Часть импорта не удалась — можно повторить или открыть то, что уже собрано.';
    } else if (jobs.every(([, job]) => job.status && (job.status.done || job.status.stage === 'done'))) {
      statusNode.textContent = 'Импорт завершён — считаем статистику…';
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
  host.append(errorBox({
    title: 'Импорт не удался',
    message,
    actions: [
      {
        label: 'Повторить',
        primary: true,
        onClick: () => {
          for (const [source, job] of failed) {
            delete state.jobs[source];
            saveJobs();
            const account = job.account || state.accounts[source];
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
    ],
  }));
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
  if (!state.active || state.view !== 'progress') return;
  pollOnce(state.pollSeq);
}

async function pollOnce(pollId) {
  if (!state.active || state.view !== 'progress' || pollId !== state.pollSeq) return;
  const jobs = jobList();
  if (!jobs.length) {
    await finishImport();
    return;
  }

  const results = await Promise.allSettled(jobs.map(([source, job]) => getBooksImportStatus(job.jobId, { source })));
  if (!state.active || state.view !== 'progress' || pollId !== state.pollSeq) return;

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
    changed = true;
  });

  if (changed) saveJobs();
  if (!state.active || state.view !== 'progress') return;
  renderProgress();

  const pending = jobList().filter(([, job]) => !job.failed && !(job.status && (job.status.done || job.status.stage === 'done')));
  const failed = jobList().some(([, job]) => job.failed);
  if (!pending.length && !failed) {
    await finishImport();
    return;
  }
  if (!pending.length && failed) return; // manual retry / show-stats buttons
  state.pollTimer = window.setTimeout(() => pollOnce(pollId), POLL_INTERVAL);
}

async function finishImport() {
  stopPolling();
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
    toast(`Импорт завершён: ${names.join(' ∪ ')}`, 'success', { duration: 4600 });
  }
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

function renderDashboardBooks(data) {
  renderHead(data);
  renderSummary(data);
  renderFilters(data);
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
  const activeSources = state.source ? [state.source] : data.connected;
  const kicker = $('books-kicker');
  if (kicker) {
    kicker.textContent = activeSources.length
      ? `${activeSources.map(sourceLabel).join(' ∪ ')} · сводка`
      : 'книжная полка · сводка';
  }
  const sub = $('books-sub');
  if (sub) {
    const parts = [];
    if (data.summary.bookCount) parts.push(`${fmtInt(data.summary.bookCount)} ${plural(data.summary.bookCount, ['книга', 'книги', 'книг'])}`);
    if (data.summary.eventCount) parts.push(`${fmtInt(data.summary.eventCount)} ${plural(data.summary.eventCount, ['прочтение', 'прочтения', 'прочтений'])}`);
    const reReads = data.summary.reReadCount > 0
      ? `, в том числе ${fmtInt(data.summary.reReadCount)} ${plural(data.summary.reReadCount, ['перечитка', 'перечитки', 'перечитываний'])}`
      : '';
    const sourceNote = state.source
      ? `Показан только источник ${sourceLabel(state.source)}.`
      : 'Оценки и даты — LiveLib ∪ Hardcover, метадата — Hardcover.';
    sub.textContent = parts.length
      ? `${parts.join(' · ')}${reReads}. ${sourceNote}`
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
  labelNode.append(document.createTextNode('источники'));
  node.append(labelNode);

  const value = el('div', { class: 'metric-value' });
  for (const source of data.connected) {
    const plate = el('span', { class: `book-source-plate is-${source}` });
    plate.append(el('span', { class: 'book-source-mark', text: SOURCE_MARK[source] }));
    const account = state.accounts[source];
    if (account) {
      plate.append(el('span', { class: 'src-uid', text: source === 'livelib' ? `@${account}` : account }));
    }
    value.append(plate);
  }
  if (!data.connected.length) value.append(el('span', { class: 'src-empty', text: 'не подключены' }));
  node.append(value);

  const breakdown = data.sourceBreakdown;
  const subParts = data.connected.map((source) => {
    const item = breakdown.find((entry) => entry.source === source);
    return item
      ? `${sourceLabel(source)}: ${fmtInt(item.events)}`
      : sourceLabel(source);
  });
  node.append(el('div', { class: 'metric-sub', text: subParts.join(' · ') || 'LiveLib ∪ Hardcover' }));

  node.addEventListener('pointerenter', (event) => {
    const primary = data.connected.map(sourceLabel).join(' ∪ ') || 'Источники не подключены';
    const secondary = breakdown.length
      ? breakdown.map((item) => `${sourceLabel(item.source)}: ${fmtInt(item.events)} событий, ${fmtInt(item.books)} книг${item.avgRating != null ? `, средняя ${fmtRating(item.avgRating)}` : ''}`).join(' · ')
      : 'Импортируйте профиль LiveLib и/или Hardcover';
    showTooltip(primary, secondary);
    moveTooltip(event);
  });
  node.addEventListener('pointermove', moveTooltip);
  node.addEventListener('pointerleave', hideTooltip);
  return node;
}

function renderFilters(data) {
  const host = $('books-filters');
  if (!host) return;
  for (const button of host.querySelectorAll('.source-chip')) {
    const source = button.dataset.source || '';
    const enabled = !source || !data.connected.length || data.connected.includes(source);
    button.disabled = !enabled;
    button.classList.toggle('is-active', state.source === source);
    button.setAttribute('aria-pressed', state.source === source ? 'true' : 'false');
    button.title = enabled ? '' : `${sourceLabel(source)} не подключён`;
  }
  const note = $('books-filters-note');
  if (note) {
    note.textContent = state.source
      ? `только ${sourceLabel(state.source)} · фильтр на сервере применяется ко всем виджетам`
      : 'фильтр применяется ко всем виджетам';
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
  const next = SOURCE_LABEL[source] ? source : '';
  if (state.source === next || state.loading) return;
  const previous = state.source;
  state.source = next;
  state.loaded = false;
  state.selectedDecade = null;
  const host = $('books-filters');
  if (host) host.classList.add('is-busy');
  await loadStats({ force: true, silent: true });
  if (host) host.classList.remove('is-busy');
  if (!state.loaded) {
    // A failed refetch keeps the old dashboard: restore the filter that
    // matches the rendered payload instead of lying about the selection.
    state.source = previous;
  }
  if (state.data) renderFilters(state.data);
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

  const items = data.recentlyFinished.slice(0, 15);
  if (!items.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  if (note) {
    note.textContent = `${fmtInt(items.length)} ${plural(items.length, ['книга', 'книги', 'книг'])}`;
  }

  for (const item of items) {
    const book = recentBookItem(item);
    const title = book.title || 'Без названия';
    const card = el('div', { class: 'recent-card' });
    const poster = el('div', {
      class: 'recent-poster',
      role: 'button',
      tabIndex: 0,
      'aria-label': `${title}: ссылки и действия`,
      title: `${title}${book.year ? ` (${book.year})` : ''} · ${fmtDayRu(item.date)}`,
    });
    poster.append(bookCover(book.coverUrl, title));

    const tags = el('span', { class: 'recent-book-tags' });
    if (book.sources.length) tags.append(sourceTags(book.sources));
    if (item.reRead || book.reReadCount > 0) {
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
        subtitle: fmtDayRu(item.date),
        groupLabel: fmtDayRu(item.date),
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
      text: fmtDayShortRu(item.date),
      title: fmtDayRu(item.date),
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

  const llByScore = new Map(data.ratings.bySource.livelib.map((item) => [item.score, item.count]));
  const hcByScore = new Map(data.ratings.bySource.hardcover.map((item) => [item.score, item.count]));

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
      if (seg.score === 0) return `${fmtPercent(seg.value, totalAll)} без оценки`;
      const ll = llByScore.get(seg.score) || 0;
      const hc = hcByScore.get(seg.score) || 0;
      const split = [];
      if (ll) split.push(`LiveLib ${fmtInt(ll)}`);
      if (hc) split.push(`Hardcover ${fmtInt(hc)}`);
      const pct = `${fmtPercent(seg.value, totalAll)} всех книг`;
      return split.length ? `${pct} · ${split.join(' · ')}` : pct;
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

function renderDecades(data) {
  const donutHost = $('books-decades-donut');
  const legendHost = $('books-decades-legend');
  const note = $('books-decades-note');
  if (!donutHost || !legendHost) return;

  const decades = data.decades.slice();
  const total = decades.reduce((sum, item) => sum + item.count, 0);
  if (note) {
    note.textContent = decades.length
      ? `${fmtInt(decades.length)} ${plural(decades.length, ['десятилетие', 'десятилетия', 'десятилетий'])}`
      : '';
  }

  clear(legendHost);
  clear(donutHost);
  if (!total) {
    donutHost.append(emptyState('Нет данных по десятилетиям'));
    return;
  }

  const segments = decades.map((item, index) => ({
    key: `decade-${item.start}`,
    label: item.label,
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
    secondary: (seg) => `${fmtPercent(seg.value, total)} всех книг`,
    onSelect: (seg) => {
      const start = toNum(seg.decadeStart);
      state.selectedDecade = start > 0 ? { start, label: seg.label } : null;
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

  if (note) {
    note.textContent = total
      ? `${start}–${start + 9} · ${fmtInt(years.length)} ${plural(years.length, ['год', 'года', 'лет'])}`
      : 'нет книг';
  }

  if (!total) {
    donutHost.append(decadeHint(`В ${selected.label} нет книг`));
    return;
  }

  const segments = years.map((item, index) => ({
    key: `year-${item.year}`,
    label: String(item.year),
    value: item.count,
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
      const year = Number(seg.label);
      if (!Number.isFinite(year) || year <= 0) return;
      hideTooltip();
      openYearModal(year);
    },
  });
}

function openYearModal(year) {
  const target = Math.round(toNum(year));
  const books = Object.values(state.data.booksIndex).filter((entry) => entry.year === target);
  openWorksModal({
    books,
    kicker: 'Годы издания',
    title: `${fmtInt(target)} год`,
    subtitle: `${fmtInt(books.length)} ${plural(books.length, ['книга', 'книги', 'книг'])} издано в ${target} году`,
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
  };
  renderYearBars(host, years, options);

  if (note) {
    const total = years.reduce((sum, item) => sum + item.count, 0);
    if (!years.length) note.textContent = 'нет данных';
    else if (years.length === 1) note.textContent = `${years[0].year} · ${fmtInt(total)} ${plural(total, ['книга', 'книги', 'книг'])}`;
    else note.textContent = `${years[0].year} — ${years[years.length - 1].year} · ${fmtInt(total)} ${plural(total, ['книга', 'книги', 'книг'])}`;
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

  const parts = [];
  const ll = entry.ratingsBySource.livelib;
  const hc = entry.ratingsBySource.hardcover;
  if (hc && hc.rating != null) {
    parts.push(`Hardcover ${fmtRating(hc.rating)}/${hc.scale || 5} → ${hc.rating10}/10`);
  }
  if (ll && ll.rating != null) {
    parts.push(`LiveLib ${fmtRating(ll.rating)}/${ll.scale || 10}`);
  }
  node.title = parts.length
    ? `Оценка по правилу приоритета Hardcover: ${parts.join(' · ')}`
    : `Ваша оценка: ${entry.rating} из 10`;
  return node;
}

function bookRow(entry) {
  const row = el('div', { class: 'film-row film-row-static book-row' });
  const title = entry.title || 'Без названия';
  row.append(bookCover(entry.coverUrl, title));

  const info = el('div', { class: 'film-info' });
  const titleNode = el('div', { class: 'film-title', text: title });
  if (entry.year) titleNode.append(el('span', { class: 'film-year', text: String(entry.year) }));
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
 * Kebab menu with the known source links. Books MVP has no manual re-match,
 * so unlike renderFilmMenu() there is no "Исправить матч" item at all.
 */
export function renderBookMenu(book) {
  if (!book) return null;
  const items = [];
  if (book.links && book.links.livelib) {
    items.push({ service: 'll', label: 'LiveLib', href: book.links.livelib });
  }
  if (book.links && book.links.hardcover) {
    items.push({ service: 'hc', label: 'Hardcover', href: book.links.hardcover });
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
  readAccounts();

  const livelibForm = $('books-livelib-form');
  if (livelibForm) {
    livelibForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = $('books-livelib-username');
      const username = text(input && input.value).replace(/^@/, '');
      if (!username) {
        setSourceError('livelib', 'Введите имя пользователя LiveLib.');
        if (input) input.focus();
        return;
      }
      startImport('livelib', username);
    });
  }

  const hardcoverForm = $('books-hardcover-form');
  if (hardcoverForm) {
    hardcoverForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = $('books-hardcover-userid');
      const raw = text(input && input.value);
      if (raw && !/^\d+$/.test(raw)) {
        setSourceError('hardcover', 'ID пользователя Hardcover — это число.');
        if (input) input.focus();
        return;
      }
      startImport('hardcover', raw || '34748');
    });
  }

  const filters = $('books-filters');
  if (filters) {
    filters.addEventListener('click', (event) => {
      const button = event.target.closest('.source-chip');
      if (!button || button.disabled) return;
      setSource(button.dataset.source || '');
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
    refresh.addEventListener('click', () => {
      if (state.loading) return;
      refresh.classList.add('is-busy');
      loadStats({ force: true }).finally(() => refresh.classList.remove('is-busy'));
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
  if (state.view === 'dashboard' && state.data) {
    if (state.onActivate) state.onActivate();
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
  stopPolling();
  closeBookMenu();
}

/** Drop every in-memory book artefact (logout / different user session). */
export function resetBooks() {
  stopPolling();
  closeBookMenu();
  state.loaded = false;
  state.data = null;
  state.jobs = {};
  state.source = '';
  state.selectedDecade = null;
  authorsState.visible = AUTHORS_INITIAL;
  authorsState.expanded = false;
  authorsState.query = '';
  state.view = 'import';
  state.seq += 1; // abort any in-flight render
  saveJobs();
  showScreen('import');
}
