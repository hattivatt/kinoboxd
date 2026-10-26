/* Entry point: boot → upload → enrich (poll) → dashboard. */

import {
  uploadZip, startEnrich, getEnrichStatus, getStats,
  startKinopoiskImport, getKinopoiskStatus, getAuthSession,
} from './api.js';
import {
  initUpload, setUploadBusy, showUploadPreview, showUploadError, clearUploadError,
  resetUpload, setHasSession, setSource, showKpError, setImportBusy,
} from './upload.js';
import { renderDashboard, resetYearBarsFilters } from './widgets.js';
import { initAuth, setAuthUi, prepareLogin } from './auth.js';
import { closeAllModals } from './modal.js';
import {
  ready as initProfiles, listProfiles, getProfile, saveProfile, removeProfile,
  getStatsCache, saveStatsCache, saveFile, getFile, setActiveId,
} from './profiles.js';
import {
  initProfileSwitcher, renderProfileSwitcher, closeProfileSwitcher,
} from './switcher.js';
import { $, clear, toast, dismissToasts, errorBox, shortErrorMessage, toNum, fmtInt } from './ui.js';

const SESSION_KEY = 'kinoboxd.session.v1';
const LEGACY_SESSION_KEY = 'boxdstats.session.v1';
const POLL_INTERVAL = 1000;

let lastRenderedUploadId = null;

const state = {
  view: 'boot',
  uploadId: null,
  uploadSummary: null,
  uploadFilms: null,
  stats: null,
  dashboardReady: false,
  currentFile: null,
  lbFileName: null,
  profileId: null,
  profiles: [],
  staleProfileId: null,
  flowSeq: 0,
  flowAbort: null,
  uploading: false,
  enrichStarting: false,
  importSource: 'letterboxd',
  importStarting: false,
  importStage: 'scrape',
  refreshing: false,
  refreshContext: null,
  kp: null,
  importToast: null,
  pollTimer: 0,
  pollMode: null,
  idlePolls: 0,
  statusMisses: 0,
  authRequired: false,
  authed: true,
};

const views = new Map(
  Array.from(document.querySelectorAll('.view[data-view]')).map((node) => [node.dataset.view, node]),
);

/* =========================================================
   view switching + persistence
   ========================================================= */

function showView(name) {
  for (const [key, node] of views) node.hidden = key !== name;
  state.view = name;
  document.body.dataset.view = name;
  if (name !== 'enrich') stopPolling();
  window.scrollTo(0, 0);
}

function readSession() {
  try {
    const raw =
      window.localStorage.getItem(SESSION_KEY) ||
      window.localStorage.getItem(LEGACY_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const hasUpload = parsed && typeof parsed.uploadId === 'string' && parsed.uploadId;
    const hasProfile = parsed && typeof parsed.profileId === 'string' && parsed.profileId;
    if (hasUpload || hasProfile) return parsed;
  } catch {
    /* private mode / corrupted storage — ignore */
  }
  return null;
}

function saveSession(profile = null) {
  const profileId = profile && profile.id ? profile.id : state.profileId;
  if (!state.uploadId && !profileId) return;
  try {
    const payload = {
      uploadId: state.uploadId || null,
      profileId: profileId || null,
      summary: state.uploadSummary || null,
      source: state.importSource,
      lbFileName: state.lbFileName || null,
      savedAt: Date.now(),
    };
    if (state.importSource === 'kinopoisk' && state.kp) {
      payload.kp = {
        url: state.kp.url || null,
        kpUserId: state.kp.kpUserId || null,
        kpNick: state.kp.kpNick || null,
      };
    }
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    window.localStorage.removeItem(LEGACY_SESSION_KEY);
  } catch {
    /* storage can be unavailable; the page still works for this session */
  }
}

function clearSession() {
  state.profileId = null;
  setActiveId(null);
  try {
    window.localStorage.removeItem(SESSION_KEY);
    window.localStorage.removeItem(LEGACY_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/* =========================================================
   flow cancellation (profile switches / recovery)
   ========================================================= */

function beginFlow() {
  stopPolling();
  if (state.flowAbort) {
    try { state.flowAbort.abort(); } catch { /* ignore */ }
  }
  state.flowSeq += 1;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  state.flowAbort = controller;
  return { token: state.flowSeq, signal: controller ? controller.signal : undefined };
}

function isFlow(flow) {
  return Boolean(flow) && flow.token === state.flowSeq;
}

/* =========================================================
   local registry helpers
   ========================================================= */

async function refreshProfiles() {
  try {
    state.profiles = await listProfiles();
  } catch {
    state.profiles = [];
  }
  renderProfiles();
}

function renderProfiles() {
  renderProfileSwitcher({
    profiles: state.profiles,
    activeId: state.profileId,
  });
  updateProfileRefreshButton();
}

/* =========================================================
   «Обновить профиль» — delta refresh of the active KP profile
   ========================================================= */

function activeProfileRecord() {
  if (!state.profileId) return null;
  return state.profiles.find((profile) => profile.id === state.profileId) || null;
}

/** The button only exists for KinoPoisk profiles that still know their URL. */
function updateProfileRefreshButton() {
  const button = $('profile-refresh');
  if (!button) return;
  const profile = activeProfileRecord();
  const canRefresh = Boolean(profile && profile.type === 'kp' && profile.kpUrl);
  const busy = state.refreshing;

  button.hidden = !canRefresh;
  button.disabled = busy;
  button.classList.toggle('is-busy', busy);
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
  button.title = busy
    ? 'Обновление профиля идёт…'
    : 'Проверить новые оценки на Кинопоиске';
  button.setAttribute('aria-label', busy ? 'Обновление профиля идёт' : 'Обновить профиль Кинопоиска');

  const spinner = $('profile-refresh-spinner');
  if (spinner) spinner.hidden = !busy;
  const glyph = button.querySelector('.profile-refresh-icon');
  if (glyph) glyph.hidden = busy;
}

function resetProfileRefresh() {
  if (!state.refreshing && !state.refreshContext) return;
  state.refreshing = false;
  state.refreshContext = null;
  updateProfileRefreshButton();
}

function statsFilmCount(stats) {
  const value = stats && stats.summary ? Number(stats.summary.filmCount) : NaN;
  return Number.isFinite(value) ? value : null;
}

/** Toast + busy reset once a profile refresh finished successfully. */
function completeProfileRefresh(stats) {
  const ctx = state.refreshContext;
  state.refreshing = false;
  state.refreshContext = null;
  updateProfileRefreshButton();
  if (!ctx) return;

  const next = statsFilmCount(stats);
  const added = ctx.prevFilms != null && next != null
    ? Math.max(0, Math.round(next - ctx.prevFilms))
    : null;

  let message = 'Профиль обновлён';
  if (added != null) {
    message += added > 0
      ? `: +${fmtInt(added)} ${pluralFilms(added)}`
      : ' — новых фильмов нет';
  }
  toast(message, 'success', { duration: 5200 });
}

/** Kick off the existing KinoPoisk import flow in delta-refresh mode. */
async function refreshActiveProfile() {
  if (state.refreshing) return;
  const profile = activeProfileRecord()
    || (state.profileId ? await getProfile(state.profileId) : null);
  if (!profile || profile.type !== 'kp' || !profile.kpUrl) return;

  state.refreshing = true;
  state.refreshContext = {
    profileId: profile.id,
    prevFilms: statsFilmCount(state.stats),
  };
  dismissToasts();
  updateProfileRefreshButton();

  const started = await handleKinopoiskImport({
    url: profile.kpUrl,
    kpUserId: profile.kpUserId,
    refresh: true,
  });
  if (!started) resetProfileRefresh();
}

async function ensureProfileForSession(saved) {
  const wantedId = typeof saved.profileId === 'string' && saved.profileId ? saved.profileId : null;
  if (wantedId) {
    const existing = await getProfile(wantedId);
    if (existing) return existing;
  }

  // Migrate a pre-registry session (or recover a record that vanished): build
  // an id from the stable source key so a future re-import dedupes into it.
  const type = saved.source === 'kinopoisk' ? 'kp' : 'lb';
  const kpUserId = saved.kp && saved.kp.kpUserId ? String(saved.kp.kpUserId) : null;
  const kpNick = saved.kp && saved.kp.kpNick ? String(saved.kp.kpNick) : null;
  const lbFileName = typeof saved.lbFileName === 'string' && saved.lbFileName ? saved.lbFileName : null;

  let id;
  let label;
  if (type === 'kp' && kpUserId) {
    id = `kp:${kpUserId}`;
    label = `Кинопоиск · ${kpNick || `user ${kpUserId}`}`;
  } else if (type === 'lb' && lbFileName) {
    id = `lb:${lbFileName}`;
    label = `Letterboxd · ${lbFileName}`;
  } else {
    id = `${type === 'kp' ? 'kp' : 'lb'}:legacy:${saved.uploadId}`;
    label = type === 'kp' ? 'Кинопоиск (импорт)' : 'Letterboxd (выгрузка)';
  }

  const record = await saveProfile({
    id,
    type,
    label,
    kpUrl: saved.kp && saved.kp.url ? saved.kp.url : null,
    kpUserId,
    kpNick,
    lbFileName,
    uploadId: saved.uploadId || null,
    savedAt: saved.savedAt || Date.now(),
    source: { type: type === 'kp' ? 'kinopoisk' : 'letterboxd', migrated: true },
  }, { keepId: id });

  state.profileId = record.id;
  setActiveId(record.id);
  saveSession(record);
  return record;
}

async function persistActiveProfile(stats) {
  if (!stats || typeof stats !== 'object') return;
  try {
    const src = stats.summary && stats.summary.source && typeof stats.summary.source === 'object'
      ? stats.summary.source
      : null;
    const isKp = Boolean(src && src.type === 'kinopoisk') || state.importSource === 'kinopoisk';
    const kpUserId = src && src.kpUserId != null
      ? String(src.kpUserId)
      : (state.kp && state.kp.kpUserId ? String(state.kp.kpUserId) : null);
    const kpNick = src && src.kpNick ? String(src.kpNick) : ((state.kp && state.kp.kpNick) || null);
    const lbFileName = state.lbFileName || (state.currentFile && state.currentFile.name ? state.currentFile.name : null);

    let id;
    let type;
    if (isKp) {
      if (!kpUserId) return;
      // A delta refresh of the active profile must update that registry record
      // in place, even if its id predates the `kp:<userId>` convention.
      const active = state.profileId ? await getProfile(state.profileId) : null;
      id = active
        && active.type === 'kp'
        && String(active.kpUserId || '') === String(kpUserId)
        ? active.id
        : `kp:${kpUserId}`;
      type = 'kp';
    } else {
      if (lbFileName) id = `lb:${lbFileName}`;
      else if (state.profileId && state.profileId.startsWith('lb:')) id = state.profileId;
      else return;
      type = 'lb';
    }

    const previous = await getProfile(id);
    const record = await saveProfile({
      ...(previous || {}),
      id,
      type,
      label: type === 'kp'
        ? `Кинопоиск · ${kpNick || `user ${kpUserId}`}`
        : (lbFileName
          ? `Letterboxd · ${lbFileName}`
          : ((previous && previous.label) || 'Letterboxd (выгрузка)')),
      kpUrl: type === 'kp' ? ((state.kp && state.kp.url) || (previous && previous.kpUrl) || null) : null,
      kpUserId: type === 'kp' ? kpUserId : null,
      kpNick: type === 'kp' ? kpNick : null,
      lbFileName: type === 'lb' ? (lbFileName || (previous && previous.lbFileName) || null) : null,
      uploadId: state.uploadId || (previous && previous.uploadId) || null,
      savedAt: Date.now(),
      source: {
        type: type === 'kp' ? 'kinopoisk' : 'letterboxd',
        ...(src || {}),
      },
    }, { keepId: id });

    state.profileId = record.id;
    setActiveId(record.id);
    saveSession(record);
    await saveStatsCache(record.id, stats);
    await refreshProfiles();
  } catch {
    /* registry persistence must never break the dashboard */
  }
}

/* =========================================================
   stale-data banner
   ========================================================= */

function formatSavedAt(value) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    }).format(date);
  } catch {
    return '';
  }
}

function showStaleBanner(profile, savedAt) {
  const banner = $('stale-banner');
  if (!banner) return;
  state.staleProfileId = profile && profile.id ? profile.id : state.profileId;
  const meta = $('stale-meta');
  const stamp = formatSavedAt(savedAt);
  if (meta) {
    meta.textContent = stamp
      ? `Показаны сохранённые данные от ${stamp}. Обновите профиль, чтобы получить свежую статистику.`
      : 'Показаны сохранённые данные. Обновите профиль, чтобы получить свежую статистику.';
  }
  banner.hidden = false;
}

function hideStaleBanner() {
  state.staleProfileId = null;
  const banner = $('stale-banner');
  if (banner) banner.hidden = true;
}


/* =========================================================
   boot
   ========================================================= */

function setBootMode(mode, text) {
  const spinner = $('boot-spinner');
  const label = $('boot-text');
  if (spinner) spinner.hidden = mode !== 'loading';
  if (label) label.textContent = text || '';
}

function bootError(error) {
  setBootMode('error', 'Не удалось загрузить статистику');
  const host = $('boot-error');
  if (!host) return;
  clear(host);
  host.append(errorBox({
    title: 'Сервер не ответил как ожидалось',
    message: shortErrorMessage(error),
    actions: [
      { label: 'Повторить', primary: true, onClick: boot },
      {
        label: 'Загрузить новую выгрузку',
        onClick: () => {
          clearSession();
          beginFlow();
          state.uploadId = null;
          state.uploadSummary = null;
          state.uploadFilms = null;
          state.stats = null;
          state.dashboardReady = false;
          state.importSource = 'letterboxd';
          state.kp = null;
          state.lbFileName = null;
          resetUpload();
          setHasSession(false);
          showView('upload');
          refreshProfiles();
        },
      },
    ],
  }));
  host.hidden = false;
}

async function boot() {
  const host = $('boot-error');
  const flow = beginFlow();
  showView('boot');
  setBootMode('loading', 'Проверяем доступ…');
  if (host) {
    clear(host);
    host.hidden = true;
  }

  await initProfiles();

  await checkAuth();
  if (!isFlow(flow)) return;
  if (state.authRequired && !state.authed) {
    showLoginScreen();
    return;
  }

  setBootMode('loading', 'Проверяем прошлую выгрузку…');

  const saved = readSession();
  if (!saved) {
    state.uploadId = null;
    state.profileId = null;
    state.lbFileName = null;
    setActiveId(null);
    resetUpload();
    setHasSession(false);
    showView('upload');
    await refreshProfiles();
    return;
  }

  // Keep the old-session values visible to ensureProfileForSession()'s first
  // session write (it may create and persist a migrated registry record).
  state.uploadId = saved.uploadId || null;
  state.uploadSummary = saved.summary || null;
  state.importSource = saved.source === 'kinopoisk' ? 'kinopoisk' : 'letterboxd';
  state.lbFileName = saved.lbFileName || null;

  const profile = await ensureProfileForSession(saved);
  if (!isFlow(flow)) return;
  state.profileId = profile.id;
  setActiveId(profile.id);
  state.staleProfileId = null;

  state.uploadId = saved.uploadId || profile.uploadId || null;
  state.uploadSummary = saved.summary || null;
  state.lbFileName = profile.lbFileName || saved.lbFileName || null;
  state.importSource = (saved.source === 'kinopoisk' || profile.type === 'kp') ? 'kinopoisk' : 'letterboxd';
  const savedKp = saved.kp && typeof saved.kp === 'object' ? saved.kp : null;
  state.kp = state.importSource === 'kinopoisk'
    ? {
      url: (savedKp && savedKp.url) || profile.kpUrl || null,
      kpUserId: (savedKp && savedKp.kpUserId) || profile.kpUserId || null,
      kpNick: (savedKp && savedKp.kpNick) || profile.kpNick || null,
    }
    : null;
  saveSession(profile);

  await refreshProfiles();
  if (!isFlow(flow)) return;

  if (state.importSource === 'kinopoisk' && await resumeKinopoiskIfRunning()) return;
  if (!isFlow(flow)) return;

  if (!state.uploadId) {
    await handleUnknownUpload(profile, { flow });
    return;
  }

  try {
    const stats = await getStats(state.uploadId, { signal: flow.signal });
    if (!isFlow(flow)) return;
    applyStats(stats);
  } catch (error) {
    if (!isFlow(flow) || (error && error.code === 'aborted')) return;
    if (error && error.status === 401) return; // login view already opened by the auth event
    if (error && error.status === 400) {
      if (state.importSource === 'kinopoisk') {
        // The import is still running on the server — resume its two-stage progress.
        showView('enrich');
        prepareKinopoiskProgress();
        setProgressStatus('Продолжаем импорт с Кинопоиска…');
        startKinopoiskPolling();
        return;
      }
      // The backend knows this upload but stats aren't ready yet — resume enrichment view.
      showView('enrich');
      prepareProgress();
      setProgressStatus('Продолжаем обогащение…');
      startPolling();
      return;
    }
    if (error && (error.status === 404 || error.status === 410)) {
      // Server restarted and forgot the uploadId. Prefer the local stats cache,
      // otherwise silently replay the import instead of showing an error.
      await handleUnknownUpload(profile, { flow });
      return;
    }
    bootError(error);
  }
}

async function checkAuth() {
  try {
    const session = await getAuthSession();
    if (session && typeof session === 'object') {
      state.authRequired = Boolean(session.authRequired);
      // When auth is disabled we are always "logged in".
      state.authed = state.authRequired ? Boolean(session.authed) : true;
    } else {
      state.authRequired = false;
      state.authed = true;
    }
  } catch {
    // Old backend (404) or a transient network error: don't block the app.
    // Any protected request will dispatch auth-required and show login.
    state.authRequired = false;
    state.authed = true;
  }
  setAuthUi({ authRequired: state.authRequired });
}

function showLoginScreen({ resetInput = false } = {}) {
  stopPolling();
  resetProfileRefresh();
  prepareLogin({ resetInput });
  showView('login');
}

function handleLoggedOut() {
  state.authed = false;
  closeAllModals();
  showLoginScreen({ resetInput: true });
}

function handleAuthRequired() {
  state.authRequired = true;
  state.authed = false;
  setAuthUi({ authRequired: true });
  closeAllModals();
  if (state.view === 'login') return;
  showLoginScreen();
}

/* =========================================================
   stats refresh (used after a manual TMDB match)
   ========================================================= */

const dashboardHooks = {
  getUploadId: () => state.uploadId,
  refreshStats: () => refreshStats(),
};

async function refreshStats() {
  if (!state.uploadId) return null;
  try {
    const stats = await getStats(state.uploadId);
    state.stats = stats;
    state.dashboardReady = true;
    renderDashboard(stats, dashboardHooks);
    void persistActiveProfile(stats);
    return stats;
  } catch (error) {
    if (error && error.status === 401) return null; // auth-required flow takes over
    toast('Фильм сматчен, но статистику обновить не удалось — обнови страницу.', 'error', { duration: 7000 });
    return null;
  }
}

async function resumeKinopoiskIfRunning() {
  try {
    const status = await getKinopoiskStatus(state.uploadId);
    if (!status || typeof status !== 'object') return false;

    const stage = typeof status.stage === 'string' ? status.stage : 'scrape';
    if (stage === 'failed') {
      state.importStage = status.total != null ? 'enrich' : 'scrape';
      showView('enrich');
      prepareKinopoiskProgress();
      setStepper('failed');
      setProgressStatus('Импорт прервался');
      showKinopoiskError(
        typeof status.error === 'string' && status.error.trim()
          ? status.error.trim()
          : 'Сервер не смог собрать оценки с Кинопоиска.',
        retryKinopoiskImport,
      );
      return true;
    }

    if (status.done || stage === 'done') return false;

    showView('enrich');
    prepareKinopoiskProgress();
    if (stage === 'refresh') applyRefreshStage(status);
    else if (stage === 'enrich') applyEnrichStage(status);
    else applyScrapeStage(status);
    startKinopoiskPolling();
    return true;
  } catch {
    // No live import job (server restarted / cache hit) — let /api/stats decide.
    return false;
  }
}

function dismissImportToast() {
  if (typeof state.importToast === 'function') {
    state.importToast();
    state.importToast = null;
  }
}

function applyStats(stats, { fromCache = false, profile = null } = {}) {
  if (!stats || typeof stats !== 'object') {
    bootError(new Error('Сервер вернул пустой ответ статистики.'));
    return;
  }
  // A different dataset means the country and genre/style filters no longer
  // apply. A stats refresh for the same upload (manual match) keeps both.
  if (lastRenderedUploadId && state.uploadId && state.uploadId !== lastRenderedUploadId) {
    resetYearBarsFilters();
  }
  lastRenderedUploadId = state.uploadId || lastRenderedUploadId;
  if (profile && profile.id) {
    state.profileId = profile.id;
    setActiveId(profile.id);
  }
  const source = stats.summary && stats.summary.source;
  dismissImportToast();
  if (source && source.type === 'kinopoisk') {
    state.importSource = 'kinopoisk';
    state.kp = {
      ...(state.kp || {}),
      kpUserId: source.kpUserId != null ? String(source.kpUserId) : (state.kp && state.kp.kpUserId) || null,
      kpNick: source.kpNick || (state.kp && state.kp.kpNick) || null,
    };
  } else if (source && source.type === 'letterboxd') {
    state.importSource = 'letterboxd';
    state.kp = null;
  }
  state.stats = stats;
  state.dashboardReady = true;
  if (!fromCache) hideStaleBanner();
  setHasSession(Boolean(state.uploadId));
  showView('dashboard');
  try {
    renderDashboard(stats, dashboardHooks);
  } catch (error) {
    console.error('[kinoboxd] dashboard render failed', error);
    toast('Не удалось отрисовать часть статистики. Попробуй обновить страницу.', 'error', { duration: 8000 });
  }
  renderProfiles();
  if (!fromCache) void persistActiveProfile(stats);
}

/* =========================================================
   profile switching + recovery after a server restart
   ========================================================= */

function clearBootError() {
  const host = $('boot-error');
  if (!host) return;
  clear(host);
  host.hidden = true;
}

function showUnrecoverableProfile(profile, message) {
  clearSession();
  beginFlow();
  state.profileId = null;
  state.uploadId = null;
  state.uploadSummary = null;
  state.uploadFilms = null;
  state.stats = null;
  state.dashboardReady = false;
  state.lbFileName = null;
  state.kp = null;
  state.importSource = profile && profile.type === 'kp' ? 'kinopoisk' : 'letterboxd';
  hideStaleBanner();
  resetUpload();
  setHasSession(false);
  setSource(state.importSource);
  showView('upload');
  renderProfiles();
  toast(message || 'Сервер перезапустился — загрузите выгрузку заново.', 'info', { duration: 7000 });
}

async function handleUnknownUpload(profile, { flow = null } = {}) {
  const current = flow || beginFlow();
  const cached = await getStatsCache(profile.id);
  if (!isFlow(current)) return;

  if (cached && cached.stats) {
    if (profile.uploadId) state.uploadId = profile.uploadId;
    state.profileId = profile.id;
    setActiveId(profile.id);
    applyStats(cached.stats, { fromCache: true, profile });
    showStaleBanner(profile, cached.savedAt);
    toast('Сервер перезапустился — показаны сохранённые данные профиля.', 'info', { duration: 6500 });
    return;
  }

  // No local payload yet: silently replay the import and show the normal
  // processing screen instead of a scary 404.
  await recoverProfile(profile, { flow: current });
}

async function recoverProfile(profile, { flow = null } = {}) {
  const current = flow || beginFlow();
  if (!profile || !isFlow(current)) return false;

  hideStaleBanner();
  state.profileId = profile.id;
  setActiveId(profile.id);
  state.uploadId = profile.uploadId || null;
  state.uploadSummary = null;
  state.uploadFilms = null;
  state.stats = null;
  state.dashboardReady = false;
  state.lbFileName = profile.lbFileName || null;
  renderProfiles();

  if (profile.type === 'kp') {
    const url = profile.kpUrl || (state.kp && state.kp.url) || null;
    if (!url) {
      showUnrecoverableProfile(profile, 'Сервер перезапустился, а ссылка на Кинопоиск не сохранена — импортируйте профиль заново.');
      return false;
    }

    state.importSource = 'kinopoisk';
    state.kp = {
      url,
      kpUserId: profile.kpUserId || null,
      kpNick: profile.kpNick || null,
    };
    showView('enrich');
    prepareKinopoiskProgress();
    setProgressStatus('Сервер перезапустился — повторяем импорт с Кинопоиска…');

    try {
      const data = await startKinopoiskImport(url, { signal: current.signal });
      if (!isFlow(current)) return true;
      if (!data || typeof data !== 'object' || !data.uploadId) {
        throw new Error('Сервер вернул неожиданный ответ: в нём нет uploadId.');
      }

      state.uploadId = data.uploadId;
      state.kp = {
        ...state.kp,
        kpUserId: data.userId != null ? String(data.userId) : state.kp.kpUserId,
      };
      saveSession();

      await saveProfile({
        ...profile,
        uploadId: data.uploadId,
        kpUserId: state.kp.kpUserId,
        kpNick: state.kp.kpNick,
        label: `Кинопоиск · ${state.kp.kpNick || (state.kp.kpUserId ? `user ${state.kp.kpUserId}` : 'профиль')}`,
        savedAt: Date.now(),
        source: { ...(profile.source || {}), recoveredAt: Date.now() },
      }, { keepId: profile.id });
      if (!isFlow(current)) return true;
      await refreshProfiles();
      if (!isFlow(current)) return true;

      prepareKinopoiskProgress();
      setProgressStatus('Повторный импорт запущен — сервер снова собирает оценки…');
      if (data.stage === 'enrich' || (data.done && data.stage !== 'scrape')) applyEnrichStage(data);
      else applyScrapeStage(data);
      startKinopoiskPolling();
      toast('Восстанавливаем профиль после перезапуска сервера.', 'info', { duration: 5200 });
      return true;
    } catch (error) {
      if (!isFlow(current) || (error && error.code === 'aborted')) return true;
      showKinopoiskError(shortErrorMessage(error), () => {
        const retryFlow = beginFlow();
        recoverProfile(profile, { flow: retryFlow });
      });
      return true;
    }
  }

  // Letterboxd: replay the stored ZIP bytes through upload → enrich.
  state.importSource = 'letterboxd';
  state.kp = null;
  showView('enrich');
  prepareProgress();
  setProgressStatus('Сервер перезапустился — загружаем сохранённый архив заново…');

  try {
    const file = await getFile(profile.id);
    if (!isFlow(current)) return true;
    if (!file) {
      showUnrecoverableProfile(profile, 'ZIP-архив этого профиля не сохранён в браузере — загрузите выгрузку Letterboxd заново.');
      return false;
    }

    state.lbFileName = profile.lbFileName || file.name || null;
    const data = await uploadZip(file, { signal: current.signal });
    if (!isFlow(current)) return true;
    if (!data || typeof data !== 'object' || !data.uploadId) {
      throw new Error('Сервер вернул неожиданный ответ: в нём нет uploadId.');
    }

    state.uploadId = data.uploadId;
    state.uploadSummary = data.summary && typeof data.summary === 'object' ? data.summary : null;
    state.uploadFilms = Array.isArray(data.films) ? data.films : null;
    saveSession();

    await saveProfile({
      ...profile,
      uploadId: data.uploadId,
      lbFileName: state.lbFileName,
      savedAt: Date.now(),
      source: { ...(profile.source || {}), recoveredAt: Date.now() },
    }, { keepId: profile.id });
    if (!isFlow(current)) return true;
    await refreshProfiles();
    if (!isFlow(current)) return true;

    await handleStartEnrich(current);
    toast('Архив загружен заново — восстанавливаем профиль.', 'info', { duration: 5200 });
    return true;
  } catch (error) {
    if (!isFlow(current) || (error && error.code === 'aborted')) return true;
    showProgressError(shortErrorMessage(error), () => {
      const retryFlow = beginFlow();
      recoverProfile(profile, { flow: retryFlow });
    });
    return true;
  }
}

async function switchProfile(id) {
  closeProfileSwitcher();
  if (!id) return;
  resetProfileRefresh();

  const profile = await getProfile(id);
  if (!profile) {
    await refreshProfiles();
    toast('Профиль не найден в локальном реестре.', 'error');
    return;
  }
  if (id === state.profileId && state.dashboardReady) return;

  // A country/genre filter belongs to the profile it was picked on.
  resetYearBarsFilters();

  const flow = beginFlow();
  hideStaleBanner();

  state.profileId = id;
  setActiveId(id);
  state.uploadId = profile.uploadId || null;
  state.uploadSummary = null;
  state.uploadFilms = null;
  state.lbFileName = profile.lbFileName || null;
  state.importSource = profile.type === 'kp' ? 'kinopoisk' : 'letterboxd';
  state.kp = profile.type === 'kp'
    ? { url: profile.kpUrl || null, kpUserId: profile.kpUserId || null, kpNick: profile.kpNick || null }
    : null;
  state.stats = null;
  state.dashboardReady = false;
  saveSession(profile);
  renderProfiles();

  const cached = await getStatsCache(id);
  if (!isFlow(flow)) return;

  if (cached && cached.stats) {
    // Instant switch from the local payload; the fresh request below quietly
    // replaces it when the server still knows this upload.
    applyStats(cached.stats, { fromCache: true, profile });
  } else {
    clearBootError();
    setBootMode('loading', 'Загружаю статистику…');
    showView('boot');
  }

  if (!state.uploadId) {
    await handleUnknownUpload(profile, { flow });
    return;
  }

  try {
    const stats = await getStats(state.uploadId, { signal: flow.signal });
    if (!isFlow(flow)) return;
    applyStats(stats, { profile });
  } catch (error) {
    if (!isFlow(flow) || (error && error.code === 'aborted')) return;
    if (error && error.status === 401) return;

    if (error && (error.status === 404 || error.status === 410)) {
      await handleUnknownUpload(profile, { flow });
      return;
    }

    if (error && error.status === 400) {
      if (profile.type === 'kp') {
        showView('enrich');
        prepareKinopoiskProgress();
        setProgressStatus('Продолжаем импорт с Кинопоиска…');
        startKinopoiskPolling();
      } else {
        showView('enrich');
        prepareProgress();
        setProgressStatus('Продолжаем обогащение…');
        startPolling();
      }
      return;
    }

    if (cached && cached.stats) {
      toast('Не удалось обновить статистику — показаны сохранённые данные профиля.', 'error', { duration: 7000 });
      return;
    }
    bootError(error);
  }
}

async function deleteSavedProfile(id) {
  const profile = await getProfile(id);
  if (!profile) {
    await refreshProfiles();
    return;
  }
  const wasActive = id === state.profileId;
  await removeProfile(id);

  if (wasActive) {
    resetProfileRefresh();
    clearSession();
    beginFlow();
    state.uploadId = null;
    state.uploadSummary = null;
    state.uploadFilms = null;
    state.stats = null;
    state.dashboardReady = false;
    state.lbFileName = null;
    state.kp = null;
    state.importSource = profile.type === 'kp' ? 'kinopoisk' : 'letterboxd';
    hideStaleBanner();
    resetUpload();
    setHasSession(false);
    setSource(state.importSource);
    showView('upload');
    toast('Профиль удалён. Выберите источник статистики.', 'info');
  } else {
    toast('Профиль удалён', 'info');
  }
  await refreshProfiles();
}

/* =========================================================
   upload
   ========================================================= */

function isZip(file) {
  if (!file) return false;
  const byName = /\.zip$/i.test(file.name || '');
  const byType = ['application/zip', 'application/x-zip-compressed', 'multipart/x-zip'].includes(file.type || '');
  return byName || byType;
}

async function handleFile(file) {
  if (state.uploading || !file) return;

  if (!isZip(file)) {
    showUploadError('Letterboxd отдаёт статистику в ZIP-архиве. Выбери файл с расширением .zip.', {});
    toast('Нужен ZIP-архив Letterboxd', 'error');
    return;
  }
  if (file.size === 0) {
    showUploadError('Файл пустой — похоже, архив не скачался до конца.', {});
    toast('Архив пустой', 'error');
    return;
  }

  state.currentFile = file;
  state.uploading = true;
  clearUploadError();
  setUploadBusy(true, file.name);
  beginFlow();

  try {
    const data = await uploadZip(file);
    if (!data || typeof data !== 'object' || !data.uploadId) {
      throw new Error('Сервер вернул неожиданный ответ: в нём нет uploadId.');
    }

    state.uploadId = data.uploadId;
    state.uploadSummary = data.summary && typeof data.summary === 'object' ? data.summary : null;
    state.uploadFilms = Array.isArray(data.films) ? data.films : null;
    state.stats = null;
    state.dashboardReady = false;
    state.importSource = 'letterboxd';
    state.kp = null;
    state.lbFileName = file.name || null;
    state.profileId = null;
    setActiveId(null);

    // Keep the ZIP bytes so this profile can be re-imported after a server
    // restart even when its stats payload is too large to cache.
    if (state.lbFileName) await saveFile(`lb:${state.lbFileName}`, file);

    saveSession();
    setHasSession(false);
    showUploadPreview(data, file);
    renderProfiles();

    const filmCount = state.uploadSummary && Number.isFinite(Number(state.uploadSummary.films))
      ? Number(state.uploadSummary.films)
      : (state.uploadFilms ? state.uploadFilms.length : 0);
    toast(`Архив распакован: ${fmtInt(filmCount)} ${pluralFilms(filmCount)}.`, 'success');
  } catch (error) {
    showUploadError(shortErrorMessage(error), {
      onRetry: () => handleFile(file),
    });
    toast('Не удалось загрузить архив', 'error');
  } finally {
    state.uploading = false;
    setUploadBusy(false);
  }
}

function pluralFilms(count) {
  const n = Math.abs(Math.round(toNum(count))) % 100;
  const last = n % 10;
  if (n > 10 && n < 20) return 'фильмов';
  if (last > 1 && last < 5) return 'фильма';
  if (last === 1) return 'фильм';
  return 'фильмов';
}

function openUploadScreen() {
  closeProfileSwitcher();
  resetProfileRefresh();
  resetUpload();
  setHasSession(Boolean(state.stats && state.dashboardReady));
  showView('upload');
}

function newUploadFromScratch(source = 'letterboxd') {
  beginFlow();
  resetProfileRefresh();
  dismissImportToast();
  clearSession();
  hideStaleBanner();
  state.uploadId = null;
  state.uploadSummary = null;
  state.uploadFilms = null;
  state.stats = null;
  state.dashboardReady = false;
  state.lbFileName = null;
  state.importSource = source === 'kinopoisk' ? 'kinopoisk' : 'letterboxd';
  state.kp = null;
  resetUpload();
  setSource(state.importSource);
  setHasSession(false);
  showView('upload');
  renderProfiles();
}

/* =========================================================
   enrich + polling
   ========================================================= */

function estimateTotal() {
  const fromSummary = state.uploadSummary ? Number(state.uploadSummary.films) : 0;
  if (Number.isFinite(fromSummary) && fromSummary > 0) return fromSummary;
  return state.uploadFilms ? state.uploadFilms.length : 0;
}

function setProgress({ matched, total, failed, done } = {}) {
  const totalValue = Math.max(0, toNum(total));
  const matchedValue = Math.min(totalValue || Infinity, Math.max(0, toNum(matched)));
  const failedValue = Math.max(0, toNum(failed));
  const percent = done ? 100 : (totalValue > 0 ? Math.min(100, Math.round((matchedValue / totalValue) * 100)) : 0);

  const fill = $('enrich-fill');
  const bar = $('enrich-progressbar');
  const matchedNode = $('enrich-matched');
  const totalNode = $('enrich-total');
  const failedNode = $('enrich-failed');
  const pctNode = $('enrich-pct');

  if (fill) fill.style.width = `${percent}%`;
  if (bar) bar.setAttribute('aria-valuenow', String(percent));
  if (matchedNode) matchedNode.textContent = fmtInt(matchedValue);
  if (totalNode) totalNode.textContent = fmtInt(totalValue);
  if (failedNode) failedNode.textContent = fmtInt(failedValue);
  if (pctNode) pctNode.textContent = `${percent}%`;
}

function setProgressStatus(text) {
  const node = $('enrich-status');
  if (node) node.textContent = text;
}

function prepareProgress() {
  hideProgressError();
  resetProgressMode('letterboxd');
  const total = estimateTotal();
  setProgress({ matched: 0, total, failed: 0, done: false });
  setProgressStatus('Запускаем обогащение…');
}

/* =========================================================
   Kinopoisk import progress (two stages)
   ========================================================= */

function stageNode(name) {
  return document.querySelector(`.stage-step[data-stage="${name}"]`);
}

function paintStage(name, stateName, number) {
  const node = stageNode(name);
  if (!node) return;
  node.classList.toggle('is-active', stateName === 'active');
  node.classList.toggle('is-done', stateName === 'done');
  node.classList.toggle('is-failed', stateName === 'failed');
  const num = node.querySelector('.stage-num');
  if (num) {
    num.textContent = stateName === 'done' ? '✓' : stateName === 'failed' ? '!' : String(number);
  }
}

function setStepper(phase) {
  if (phase === 'failed') {
    const failedAt = state.importStage === 'enrich' ? 'enrich' : 'scrape';
    if (failedAt === 'scrape') {
      paintStage('scrape', 'failed', 1);
      paintStage('enrich', 'idle', 2);
    } else {
      paintStage('scrape', 'done', 1);
      paintStage('enrich', 'failed', 2);
    }
    return;
  }
  if (phase === 'scrape') {
    paintStage('scrape', 'active', 1);
    paintStage('enrich', 'idle', 2);
  } else if (phase === 'enrich') {
    paintStage('scrape', 'done', 1);
    paintStage('enrich', 'active', 2);
  } else if (phase === 'done') {
    paintStage('scrape', 'done', 1);
    paintStage('enrich', 'done', 2);
  }
}

const STAGE_COPY = {
  scrape: { title: 'Сбор оценок', sub: 'Кинопоиск' },
  refresh: { title: 'Проверка обновлений', sub: 'Кинопоиск' },
  enrich: { title: 'Матчинг', sub: 'TMDB' },
};

/** Update the label of the numbered step in the import stepper. */
function setStageCopy(name, title, sub) {
  const node = stageNode(name);
  if (!node) return;
  const titleNode = node.querySelector('.stage-copy b');
  const subNode = node.querySelector('.stage-copy > span');
  if (titleNode && title) titleNode.textContent = title;
  if (subNode && sub) subNode.textContent = sub;
}

function resetScrapeProgress() {
  const bar = $('scrape-progressbar');
  const fill = $('scrape-fill');
  const page = $('scrape-page');
  if (bar) {
    bar.classList.remove('is-indeterminate');
    bar.setAttribute('aria-valuenow', '0');
  }
  if (fill) fill.style.width = '0%';
  if (page) page.textContent = 'Страница —';
}

function setProgressFoot(text) {
  const node = $('progress-foot-text');
  if (node) node.textContent = text;
}

function resetProgressMode(mode) {
  const steps = $('stage-steps');
  const scrapeBlock = $('scrape-block');
  const enrichBlock = $('enrich-block');
  const kicker = $('progress-kicker');
  const title = $('progress-title');

  if (mode === 'kinopoisk') {
    setProgressFoot('Прогресс обновляется каждую секунду. Вкладку можно свернуть — импорт идёт на сервере.');
    if (steps) steps.hidden = false;
    setStageCopy('scrape', STAGE_COPY.scrape.title, STAGE_COPY.scrape.sub);
    if (scrapeBlock) scrapeBlock.hidden = false;
    if (enrichBlock) enrichBlock.hidden = true;
    if (kicker) {
      kicker.textContent = state.kp && state.kp.kpUserId
        ? `Кинопоиск · user ${state.kp.kpUserId}`
        : 'Кинопоиск · импорт';
    }
    if (title) title.textContent = 'Собираю ваш список оценок';
    resetScrapeProgress();
    state.importStage = 'scrape';
    setStepper('scrape');
    setProgress({ matched: 0, total: 0, failed: 0, done: false });
  } else {
    setProgressFoot('Прогресс обновляется каждую секунду. Вкладку можно свернуть — обогащение идёт на сервере.');
    if (steps) steps.hidden = true;
    if (scrapeBlock) scrapeBlock.hidden = true;
    if (enrichBlock) enrichBlock.hidden = false;
    if (kicker) kicker.textContent = 'TMDB · обогащение';
    if (title) title.textContent = 'Собираем детали фильмов';
    const bar = $('scrape-progressbar');
    if (bar) bar.classList.remove('is-indeterminate');
  }
}

function prepareKinopoiskProgress() {
  hideProgressError();
  resetProgressMode('kinopoisk');
  setProgressStatus('Готовим запрос…');
}

/**
 * Delta refresh of an already cached KinoPoisk profile (stage 'refresh'):
 * only the newest page(s) are checked, so this is not a full scrape. The
 * import may still fall back to 'scrape' when the cache and KinoPoisk do not
 * overlap — the next poll then repaints this screen as a regular scrape.
 */
function applyRefreshStage(status) {
  setStepper('scrape');
  state.importStage = 'refresh';
  setStageCopy('scrape', STAGE_COPY.refresh.title, STAGE_COPY.refresh.sub);

  const steps = $('stage-steps');
  const scrapeBlock = $('scrape-block');
  const enrichBlock = $('enrich-block');
  const kicker = $('progress-kicker');
  const title = $('progress-title');
  if (steps) steps.hidden = false;
  if (scrapeBlock) scrapeBlock.hidden = false;
  if (enrichBlock) enrichBlock.hidden = true;
  if (kicker) {
    kicker.textContent = state.kp && state.kp.kpUserId
      ? `Кинопоиск · обновление профиля · user ${state.kp.kpUserId}`
      : 'Кинопоиск · обновление профиля';
  }
  if (title) title.textContent = 'Проверяю обновления профиля на Кинопоиске…';

  const pageRaw = status && status.page != null && Number.isFinite(Number(status.page))
    ? Math.max(0, Number(status.page))
    : null;
  const page = pageRaw != null && pageRaw > 0 ? pageRaw : null;
  const pageTotalRaw = status && status.pageTotal != null && Number.isFinite(Number(status.pageTotal))
    ? Math.max(0, Number(status.pageTotal))
    : null;
  const pageTotal = pageTotalRaw != null && pageTotalRaw > 0 ? pageTotalRaw : null;

  const pageNode = $('scrape-page');
  const bar = $('scrape-progressbar');
  const fill = $('scrape-fill');

  const pageText = page == null
    ? ''
    : pageTotal
      ? `страница ${fmtInt(page)} из ${fmtInt(pageTotal)}`
      : `страница ${fmtInt(page)}`;

  if (pageNode) {
    const text = page == null ? 'Проверка обновлений' : pageText;
    pageNode.textContent = text.charAt(0).toUpperCase() + text.slice(1);
  }

  if (bar && fill) {
    if (page != null && pageTotal && pageTotal > 1) {
      const percent = Math.max(2, Math.min(100, Math.round((page / pageTotal) * 100)));
      bar.classList.remove('is-indeterminate');
      bar.setAttribute('aria-valuenow', String(percent));
      fill.style.width = `${percent}%`;
    } else {
      // One page is the normal case for a delta refresh — don't pretend to
      // have a meaningful percentage.
      bar.classList.add('is-indeterminate');
      bar.setAttribute('aria-valuenow', '0');
      fill.style.width = '';
    }
  }

  if (page != null && pageTotal && pageTotal > 1) {
    setProgressStatus(`Проверяю обновления профиля на Кинопоиске… — ${pageText}`);
  } else {
    setProgressStatus('Проверяю обновления профиля на Кинопоиске…');
  }
}

function applyScrapeStage(status) {
  setStepper('scrape');
  state.importStage = 'scrape';
  setStageCopy('scrape', STAGE_COPY.scrape.title, STAGE_COPY.scrape.sub);

  const steps = $('stage-steps');
  const scrapeBlock = $('scrape-block');
  const enrichBlock = $('enrich-block');
  const kicker = $('progress-kicker');
  const title = $('progress-title');
  if (steps) steps.hidden = false;
  if (scrapeBlock) scrapeBlock.hidden = false;
  if (enrichBlock) enrichBlock.hidden = true;
  if (kicker) {
    kicker.textContent = state.kp && state.kp.kpUserId
      ? `Кинопоиск · user ${state.kp.kpUserId}`
      : 'Кинопоиск · импорт';
  }
  if (title) title.textContent = 'Собираю ваш список оценок';

  const pageRaw = status && status.page != null && Number.isFinite(Number(status.page))
    ? Math.max(0, Number(status.page))
    : null;
  const page = pageRaw != null && pageRaw > 0 ? pageRaw : null;
  const pageTotalRaw = status && status.pageTotal != null && Number.isFinite(Number(status.pageTotal))
    ? Math.max(0, Number(status.pageTotal))
    : null;
  const pageTotal = pageTotalRaw != null && pageTotalRaw > 0 ? pageTotalRaw : null;

  const pageNode = $('scrape-page');
  const bar = $('scrape-progressbar');
  const fill = $('scrape-fill');

  const pageText = page == null
    ? ''
    : pageTotal
      ? `страница ${fmtInt(page)} из ${fmtInt(pageTotal)}`
      : `страница ${fmtInt(page)}`;

  if (pageNode) pageNode.textContent = page == null ? 'Страница —' : pageText.charAt(0).toUpperCase() + pageText.slice(1);

  if (bar && fill) {
    if (page != null && pageTotal) {
      const percent = Math.max(2, Math.min(100, Math.round((page / pageTotal) * 100)));
      bar.classList.remove('is-indeterminate');
      bar.setAttribute('aria-valuenow', String(percent));
      fill.style.width = `${percent}%`;
    } else {
      bar.classList.add('is-indeterminate');
      bar.setAttribute('aria-valuenow', '0');
      fill.style.width = '';
    }
  }

  if (page != null) {
    setProgressStatus(pageTotal
      ? `Собираю ваш список оценок Кинопоиска — ${pageText}`
      : `Собираю ваш список оценок Кинопоиска — ${pageText}, всего страниц пока неизвестно`);
  } else {
    setProgressStatus('Читаю профиль Кинопоиска…');
  }
}

function applyEnrichStage(status) {
  setStepper('enrich');
  state.importStage = 'enrich';

  const steps = $('stage-steps');
  const scrapeBlock = $('scrape-block');
  const enrichBlock = $('enrich-block');
  const kicker = $('progress-kicker');
  const title = $('progress-title');
  if (steps) steps.hidden = false;
  if (scrapeBlock) scrapeBlock.hidden = true;
  if (enrichBlock) enrichBlock.hidden = false;
  if (kicker) kicker.textContent = 'TMDB · матчинг';
  if (title) title.textContent = 'Сопоставляем фильмы';

  const matched = status ? toNum(status.matched) : 0;
  const total = status ? toNum(status.total) : 0;
  const failed = status ? toNum(status.failed) : 0;
  setProgress({ matched, total, failed, done: false });

  if (total > 0) {
    const failedPart = failed > 0 ? ` · ${fmtInt(failed)} без пары` : '';
    setProgressStatus(`Матчинг с TMDB · ${fmtInt(Math.min(matched, total))} из ${fmtInt(total)}${failedPart}`);
  } else {
    setProgressStatus('Матчинг с TMDB…');
  }
}

function importErrorMessage(error) {
  const message = error && typeof error.message === 'string' ? error.message.trim() : '';
  if (error && error.status === 400 && message) return message;
  return shortErrorMessage(error);
}

function showKinopoiskError(message, retry) {
  const host = $('enrich-error');
  if (!host) return;
  // A failed refresh must leave the topbar button usable again.
  if (state.refreshing) resetProfileRefresh();
  dismissImportToast();
  setProgressFoot('Импорт остановлен. Можно повторить попытку или выбрать ZIP-выгрузку.');
  clear(host);
  host.append(errorBox({
    title: 'Импорт не удался',
    message: message || 'Сервер не смог собрать оценки с Кинопоиска.',
    actions: [
      retry ? { label: 'Повторить', primary: true, onClick: retry } : null,
      { label: 'Загрузить ZIP вместо этого', onClick: () => newUploadFromScratch('letterboxd') },
    ].filter(Boolean),
  }));
  host.hidden = false;
}

async function handleKinopoiskImport({ url, kpUserId, refresh = false } = {}) {
  if (state.importStarting || !url) return false;
  state.importStarting = true;
  setImportBusy(true);
  beginFlow();
  hideStaleBanner();

  try {
    const data = await startKinopoiskImport(url);
    if (!data || typeof data !== 'object' || !data.uploadId) {
      throw new Error('Сервер вернул неожиданный ответ: в нём нет uploadId.');
    }

    state.uploadId = data.uploadId;
    state.importSource = 'kinopoisk';
    state.kp = {
      url,
      kpUserId: data.userId != null ? String(data.userId) : String(kpUserId || ''),
      kpNick: null,
    };
    state.uploadSummary = null;
    state.uploadFilms = null;
    state.stats = null;
    state.dashboardReady = false;
    state.lbFileName = null;
    if (!refresh) {
      // A brand-new import registers itself through persistActiveProfile().
      // A refresh keeps the active profile so the registry record is updated
      // in place instead of being replaced by a duplicate.
      state.profileId = null;
      setActiveId(null);
    }

    saveSession();
    setHasSession(false);
    setImportBusy(false);
    resetUpload();
    renderProfiles();

    showView('enrich');
    prepareKinopoiskProgress();
    if (data.stage === 'refresh') {
      applyRefreshStage(data);
    } else if (data.stage === 'enrich' || (data.done && data.stage !== 'scrape')) {
      applyEnrichStage(data);
    }
    startKinopoiskPolling();
    if (!refresh) {
      state.importToast = toast('Импорт с Кинопоиска запущен', 'info', { duration: 5000 });
    }
    return true;
  } catch (error) {
    setImportBusy(false);
    if (refresh) {
      resetProfileRefresh();
      showView('dashboard');
      toast(importErrorMessage(error), 'error', { duration: 7000 });
      return false;
    }
    showView('upload');
    setSource('kinopoisk');
    showKpError(importErrorMessage(error));
    toast('Не удалось начать импорт', 'error');
    return false;
  } finally {
    state.importStarting = false;
  }
}

function hideProgressError() {
  const host = $('enrich-error');
  if (!host) return;
  clear(host);
  host.hidden = true;
}

function showProgressError(message, retry) {
  const host = $('enrich-error');
  if (!host) return;
  clear(host);
  host.append(errorBox({
    title: 'Обогащение прервалось',
    message,
    actions: [
      retry ? { label: 'Повторить', primary: true, onClick: retry } : null,
      { label: 'Другая выгрузка', onClick: newUploadFromScratch },
    ].filter(Boolean),
  }));
  host.hidden = false;
}

async function handleStartEnrich(flow = null) {
  if (!state.uploadId || state.enrichStarting) return;
  const uploadId = state.uploadId;
  state.enrichStarting = true;

  showView('enrich');
  prepareProgress();
  setProgressStatus('Запускаем обогащение…');

  try {
    const result = await startEnrich(uploadId);
    if (flow && !isFlow(flow)) return;
    if (state.view !== 'enrich' || state.uploadId !== uploadId) return;

    if (result && typeof result === 'object') {
      const total = Number.isFinite(Number(result.total)) ? Number(result.total) : estimateTotal();
      const matched = Number.isFinite(Number(result.cached)) ? Number(result.cached) : 0;
      setProgress({ matched, total, failed: 0, done: false });
      if (total > 0) setProgressStatus(`Найдено ${fmtInt(Math.min(matched, total))} из ${fmtInt(total)}`);
    }
    startPolling();
  } catch (error) {
    if (flow && !isFlow(flow)) return;
    if (state.view !== 'enrich' || state.uploadId !== uploadId) return;
    if (error && (error.status === 404 || error.status === 410)) {
      clearSession();
      state.uploadId = null;
      setProgressStatus('Выгрузка не найдена на сервере');
      showProgressError(shortErrorMessage(error), null);
      return;
    }
    setProgressStatus('Не удалось запустить обогащение');
    showProgressError(shortErrorMessage(error), () => handleStartEnrich(flow));
  } finally {
    state.enrichStarting = false;
  }
}

function stopPolling() {
  if (state.pollTimer) {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = 0;
  }
  state.pollMode = null;
}

function startPolling() {
  stopPolling();
  state.pollMode = 'letterboxd';
  state.idlePolls = 0;
  state.statusMisses = 0;
  if (!state.uploadId) return;
  pollOnce();
}

function startKinopoiskPolling() {
  stopPolling();
  state.pollMode = 'kinopoisk';
  state.idlePolls = 0;
  state.statusMisses = 0;
  if (!state.uploadId) return;
  pollKinopoiskOnce();
}

function showEnrichNotStarted() {
  const host = $('enrich-error');
  if (!host) return;
  clear(host);
  host.append(errorBox({
    tone: 'info',
    title: 'Обогащение ещё не запущено',
    message: 'Выгрузка загружена, но поиск в TMDB не стартовал. Запусти его — и вернёшься к прогрессу.',
    actions: [
      {
        label: 'Начать обогащение',
        primary: true,
        onClick: () => {
          hideProgressError();
          handleStartEnrich();
        },
      },
      { label: 'Другая выгрузка', onClick: newUploadFromScratch },
    ],
  }));
  host.hidden = false;
}

async function pollOnce() {
  if (!state.uploadId || state.view !== 'enrich' || state.pollMode !== 'letterboxd') return;

  try {
    const status = await getEnrichStatus(state.uploadId);
    if (state.view !== 'enrich' || state.pollMode !== 'letterboxd') return;
    state.statusMisses = 0;

    const done = Boolean(status && status.done);
    const matched = status ? toNum(status.matched) : 0;
    const total = status ? toNum(status.total) : estimateTotal();
    const failed = status ? toNum(status.failed) : 0;

    setProgress({ matched, total, failed, done });

    if (done) {
      setProgressStatus('Готово! Собираем статистику…');
      await finishStats(0);
      return;
    }

    if (total === 0 && matched === 0) {
      state.idlePolls += 1;
      if (state.idlePolls >= 3) {
        setProgressStatus('Обогащение ещё не запущено');
        showEnrichNotStarted();
        return;
      }
    } else {
      state.idlePolls = 0;
    }

    setProgressStatus(total > 0
      ? `Обогащаем карточки TMDB · ${fmtInt(matched)} из ${fmtInt(total)}`
      : 'Готовим список фильмов…');

    state.pollTimer = window.setTimeout(pollOnce, POLL_INTERVAL);
  } catch (error) {
    if (state.view !== 'enrich' || state.pollMode !== 'letterboxd') return;
    if (error && (error.status === 404 || error.status === 410)) {
      // A freshly started background job can become visible a moment later.
      state.statusMisses += 1;
      if (state.statusMisses <= 4) {
        setProgressStatus('Ждём статус обогащения…');
        state.pollTimer = window.setTimeout(pollOnce, POLL_INTERVAL);
        return;
      }
      clearSession();
      state.uploadId = null;
      setProgressStatus('Выгрузка не найдена на сервере');
      showProgressError(shortErrorMessage(error), null);
      return;
    }
    setProgressStatus('Связь с сервером потеряна');
    showProgressError(shortErrorMessage(error), () => {
      hideProgressError();
      startPolling();
    });
  }
}

async function pollKinopoiskOnce() {
  if (!state.uploadId || state.view !== 'enrich' || state.pollMode !== 'kinopoisk') return;

  try {
    const status = await getKinopoiskStatus(state.uploadId);
    if (state.view !== 'enrich' || state.pollMode !== 'kinopoisk') return;
    state.statusMisses = 0;

    const stage = status && typeof status.stage === 'string' ? status.stage : 'scrape';

    if (stage === 'failed') {
      setStepper('failed');
      setProgressStatus('Импорт прервался');
      const message = status && typeof status.error === 'string' && status.error.trim()
        ? status.error.trim()
        : 'Сервер не смог собрать оценки с Кинопоиска.';
      showKinopoiskError(message, retryKinopoiskImport);
      return;
    }

    if ((status && status.done) || stage === 'done') {
      setStepper('done');
      if (status) {
        setProgress({
          matched: status.matched,
          total: status.total,
          failed: status.failed,
          done: true,
        });
      }
      setProgressStatus('Готово! Собираем статистику…');
      setProgressFoot('Импорт завершён — считаем статистику.');
      // A delta refresh that could not reach KinoPoisk still succeeds using
      // the cached data — surface that in a neutral (non-error) toast.
      const warning = status && typeof status.warning === 'string' ? status.warning.trim() : '';
      if (warning) toast(warning, 'info', { duration: 12000 });
      await finishStats(0);
      return;
    }

    if (stage === 'enrich') applyEnrichStage(status);
    else if (stage === 'refresh') applyRefreshStage(status);
    else applyScrapeStage(status);

    state.pollTimer = window.setTimeout(pollKinopoiskOnce, POLL_INTERVAL);
  } catch (error) {
    if (state.view !== 'enrich' || state.pollMode !== 'kinopoisk') return;
    if (error && (error.status === 404 || error.status === 410)) {
      // A freshly started import can become visible a moment later.
      state.statusMisses += 1;
      if (state.statusMisses <= 4) {
        setProgressStatus('Ждём статус импорта…');
        state.pollTimer = window.setTimeout(pollKinopoiskOnce, POLL_INTERVAL);
        return;
      }
      clearSession();
      state.uploadId = null;
      setProgressStatus('Импорт не найден на сервере');
      showKinopoiskError(shortErrorMessage(error), retryKinopoiskImport);
      return;
    }
    setProgressStatus('Связь с сервером потеряна');
    showKinopoiskError(shortErrorMessage(error), () => {
      hideProgressError();
      startKinopoiskPolling();
    });
  }
}

function retryKinopoiskImport() {
  hideProgressError();
  if (state.kp && state.kp.url) {
    handleKinopoiskImport({ url: state.kp.url, kpUserId: state.kp.kpUserId });
    return;
  }
  newUploadFromScratch('kinopoisk');
}

async function finishStats(attempt = 0) {
  if (state.view !== 'enrich' || !state.uploadId) return;
  const isKinopoisk = state.importSource === 'kinopoisk';
  try {
    const stats = await getStats(state.uploadId);
    if (state.view !== 'enrich') return;
    applyStats(stats);
    if (state.refreshContext) {
      completeProfileRefresh(stats);
    } else {
      toast('Статистика готова — приятного просмотра цифр.', 'success', { duration: 3400 });
    }
  } catch (error) {
    if (error && error.status === 400 && attempt < 7) {
      setProgressStatus(isKinopoisk ? 'Импорт завершён, считаем статистику…' : 'TMDB закончил, считаем статистику…');
      state.pollTimer = window.setTimeout(() => finishStats(attempt + 1), 600 + attempt * 350);
      return;
    }
    if (state.view !== 'enrich') return;
    setProgressStatus('Статистика ещё не готова');
    const retry = () => {
      hideProgressError();
      finishStats(attempt + 1);
    };
    if (isKinopoisk) showKinopoiskError(shortErrorMessage(error), retry);
    else showProgressError(shortErrorMessage(error), retry);
  }
}

/* =========================================================
   wiring
   ========================================================= */

function bindUi() {
  initAuth({ onSuccess: boot, onLoggedOut: handleLoggedOut });
  window.addEventListener('kinoboxd:auth-required', handleAuthRequired);

  initProfileSwitcher({
    onOpen: () => { refreshProfiles(); },
    onSelect: (id) => { switchProfile(id); },
    onDelete: (id) => { deleteSavedProfile(id); },
    onAdd: () => {
      closeProfileSwitcher();
      openUploadScreen();
    },
  });

  initUpload({
    onFile: handleFile,
    onEnrich: handleStartEnrich,
    onImport: handleKinopoiskImport,
    onBack: () => {
      closeProfileSwitcher();
      if (state.stats && state.dashboardReady) showView('dashboard');
    },
  });

  const replace = $('replace-upload');
  if (replace) replace.addEventListener('click', openUploadScreen);

  const refresh = $('profile-refresh');
  if (refresh) refresh.addEventListener('click', () => { refreshActiveProfile(); });

  const staleRefresh = $('stale-refresh');
  if (staleRefresh) {
    staleRefresh.addEventListener('click', async () => {
      const id = state.staleProfileId || state.profileId;
      if (!id) return;
      const profile = await getProfile(id);
      if (!profile) {
        hideStaleBanner();
        return;
      }
      const flow = beginFlow();
      await recoverProfile(profile, { flow });
    });
  }

  const restart = $('enrich-restart');
  if (restart) {
    restart.addEventListener('click', () => {
      stopPolling();
      newUploadFromScratch();
    });
  }

  // Prevent the browser from opening a ZIP when dropped outside the dropzone.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
}

bindUi();
boot();
