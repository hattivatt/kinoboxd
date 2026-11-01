/* Games tab: Steam import screen, import progress and the M1 dashboard.
 *
 * One module owns the whole `/api/games/*` namespace:
 *   - import by steamid64 / vanity URL (`POST /api/games/import/steam`),
 *   - job polling (`GET /api/games/import/status`),
 *   - the dashboard built from `GET /api/games/stats?profile=steam-<steamid64>`.
 *
 * Design notes (ИГРЫ-АРХИТЕКТУРА §8.2, M1):
 *  - a games profile is ONE owner: one steamid64, one primary Steam journal.
 *    Two profiles are never summed — switching is the only way to see another;
 *  - «Импортировать» is always enabled: without `STEAM_API_KEY` the server
 *    still returns the profile, achievements and the three most recent games
 *    (`libraryPartial: true`), and the dashboard says so honestly instead of
 *    showing an empty page;
 *  - every block is rendered from `games-view.js` view models, which are
 *    DOM-free and unit-tested; a missing payload block hides its widget, it
 *    never renders a confident zero;
 *  - the dashboard is rebuilt wholesale on every render, so a silent refresh
 *    restores the window scroll (the books pattern) instead of jumping to top.
 */

import {
  getGamesStats, getGamesProfiles, startGamesImportSteam, getGamesImportStatus, startGamesRefresh,
  getGamesPersonnel,
} from './api.js';
import {
  $, el, clear, fmtInt, plural, icon, toast, errorBox, showTooltip, moveTooltip, hideTooltip,
  shortErrorMessage,
} from './ui.js';
import { withPreservedScroll } from './books-refresh.js';
import { renderYearBars } from './charts.js';
import {
  normalizeGamesPayload, normalizeProfilesList, accountFromInput, profileCardView, summaryMetrics,
  paretoView, topHoursRows, backlogView, recentlyView, histogramView, lastPlayedInfo,
  importErrorText, jobStageText, jobProgress, gamesJobId, hoursText, HOURS_HINT,
  decadesView, yearsView, genreChartView, modesView, accessView, metadataProgressView, filtersView,
  calendarView, achievementStreaksView, achievementsOverviewView, normalizePersonnel, personnelRows,
  studiosView, coverageBadge, PERSONNEL_ROLES, formatDateRu, normalizePersonnelRole,
  personnelRoleOptions, personnelRoleCountText, GENRE_CHART_LIMIT,
  gamesInYear, gamesInDecade, gamesWithoutYear, gamesWithoutType, gamesByGenre, gamesByMode,
  gamesByAccess, gamesInHoursBucket, gamesWithRecentHours, backlogGames, allGames, sortGameRows,
  yearsInDecade,
} from './games-view.js';
import {
  configureGamesModals, openGameCardModal, openGameListModal, openPersonModal, personAvatarEl,
} from './games-modal.js';
import { renderAchievementCalendar, renderAchievementStreaks } from './games-charts.js';

const PROFILE_KEY = 'kinoboxd.games.profile.v1';
const JOB_KEY = 'kinoboxd.games.job.v1';
const FILTERS_KEY = 'kinoboxd.games.filters.v1';
const WEIGHT_KEY = 'kinoboxd.games.weight.v1';
const ROLE_KEY = 'kinoboxd.games.role.v1';
// Legacy key name: the genre widget was a cloud, now it is a bar chart. The
// stored weight choice survives the change, so the string stays.
const GENRE_WEIGHT_KEY = 'kinoboxd.games.cloudweight.v1';
const POLL_INTERVAL = 1400;
const ENRICH_POLL_INTERVAL = 3500;
const ENRICH_POLL_LIMIT = 120;
const GAME_PLURAL = ['игра', 'игры', 'игр'];
const TOP_LIMIT = 10;
const BACKLOG_LIMIT = 24;
const PERSONS_INITIAL = 15;
const PERSONS_BATCH = 50;

const state = {
  active: false,
  view: 'import', // import | progress | dashboard | personnel
  loading: false,
  loaded: false,
  loadedAt: 0,
  data: null,
  error: null,
  seq: 0,
  profiles: [],
  profilesLoaded: false,
  profileKey: '',
  job: null, // { id, profile, status, failed, startedAt }
  pollTimer: 0,
  pollSeq: 0,
  importBusy: false,
  onActivate: null,
  // M2: includeFree/includeDlc are sent only when they differ from the server
  // defaults (free included, DLC excluded) — a default request stays clean.
  filters: { includeFree: true, includeDlc: false },
  // Genre bar chart: weight + «Показать все» (top 12 first).
  genreWeight: 'hours',
  genresExpanded: false,
  // M3: personnel weights + per-role cache (one owner, no cross-profile mix).
  weight: 'hours',
  role: 'developer',
  // Films parity: the years card is gated by a selected decade, and the
  // inline persons widget batches locally (the personnel route returns the
  // whole role — its `limit` is games per person, not persons).
  selectedDecade: null,
  personnel: {
    role: '', data: null, loading: false, error: null, cache: {}, openId: '',
    query: '', expanded: false, visible: PERSONS_INITIAL, rows: [],
  },
  enrichTimer: 0,
  enrichSeq: 0,
  enrichTicks: 0,
};

let inflightLoad = null;

/* =========================================================
   tiny helpers
   ========================================================= */

function text(value) {
  return value == null ? '' : String(value).trim();
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

function readJob() {
  const raw = safeStorageGet(JOB_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const profile = text(parsed.profile);
    const id = text(parsed.id);
    if (!profile && !id) return null;
    return { id, profile, status: null, failed: null, startedAt: Number(parsed.startedAt) || Date.now() };
  } catch {
    return null;
  }
}

function saveJob() {
  if (!state.job) {
    safeStorageRemove(JOB_KEY);
    return;
  }
  safeStorageSet(JOB_KEY, JSON.stringify({
    id: state.job.id || '',
    profile: state.job.profile || '',
    startedAt: state.job.startedAt || Date.now(),
  }));
}

/* =========================================================
   screens
   ========================================================= */

function showScreen(name) {
  const previous = state.view;
  state.view = name;
  const screens = {
    import: $('games-import'),
    progress: $('games-progress'),
    dashboard: $('games-dash'),
    personnel: $('games-personnel'),
  };
  for (const [key, node] of Object.entries(screens)) {
    if (node) node.hidden = key !== name;
  }
  const bar = $('games-profile-bar');
  if (bar) bar.hidden = name === 'progress';
  updateActions();
  const back = $('games-progress-back');
  if (back) back.hidden = false;
  // `onActivate` is main.js's `showView('games')`, which scrolls to top. Calling
  // it on every render would throw the user back to the top on each poll tick.
  if (previous !== name && state.active && state.onActivate) state.onActivate();
}

function updateActions() {
  const refresh = $('games-refresh');
  if (refresh) {
    const busy = Boolean(state.job) || state.loading;
    refresh.hidden = state.view === 'import' || !state.profileKey;
    refresh.disabled = busy;
    refresh.classList.toggle('is-busy', busy);
    refresh.setAttribute('aria-busy', busy ? 'true' : 'false');
    const spinner = $('games-refresh-spinner');
    if (spinner) spinner.hidden = !busy;
  }
  const reimport = $('games-reimport');
  if (reimport) reimport.hidden = state.view === 'progress';
}

function showLoading(visible) {
  const node = $('games-loading');
  if (node) node.hidden = !visible;
}

function showError(error, mapped = null) {
  const host = $('games-error');
  if (!host) return;
  state.error = error;
  clear(host);
  if (!error) {
    host.hidden = true;
    return;
  }
  const info = mapped || importErrorText(error);
  host.append(errorBox({
    title: info.title,
    message: info.message,
    actions: [{ label: 'Повторить', primary: true, onClick: () => loadStats({ force: true }) }],
  }));
  host.hidden = false;
}

function setImportError(message) {
  const host = $('games-import-error');
  if (!host) return;
  host.textContent = message ? String(message) : '';
  host.hidden = !message;
}

function setImportBusy(busy) {
  state.importBusy = busy;
  const button = $('games-import-submit');
  const spinner = $('games-import-spinner');
  if (button) {
    button.disabled = busy;
    button.classList.toggle('is-busy', busy);
  }
  if (spinner) spinner.hidden = !busy;
  const label = $('games-import-submit-label');
  if (label) label.textContent = busy ? 'Импортируем…' : 'Импортировать';
}

/** Honest boolean key indicator: «настроен / не настроен / неизвестно». */
function setKeyIndicator(configured) {
  const node = $('games-key-state');
  if (!node) return;
  if (configured === true) {
    node.textContent = 'ключ Steam Web API: настроен';
    node.className = 'games-key-state is-on';
    node.title = 'Сервер сообщил, что ключ есть. Значение ключа в браузер не передаётся.';
    return;
  }
  if (configured === false) {
    node.textContent = 'ключ Steam Web API: не настроен';
    node.className = 'games-key-state is-off';
    node.title = 'Без ключа Steam отдаёт профиль, достижения и три последних игры, но не библиотеку с часами. Ключ бесплатный: steamcommunity.com/dev/apikey';
    return;
  }
  node.textContent = 'ключ Steam Web API: неизвестно';
  node.className = 'games-key-state';
  node.title = 'Сервер не сообщил состояние ключа. Импорт всё равно попробует собрать профиль.';
}

/* =========================================================
   profiles (server-side catalogue, one owner per key)
   ========================================================= */

function renderProfiles() {
  const host = $('games-profile-list');
  const bar = $('games-profile-bar');
  if (!host) return;
  clear(host);
  if (!state.profiles.length) {
    if (bar) bar.hidden = state.view === 'progress';
    const note = $('games-profile-empty');
    if (note) note.hidden = Boolean(state.profileKey);
    return;
  }
  const empty = $('games-profile-empty');
  if (empty) empty.hidden = true;
  if (bar) bar.hidden = state.view === 'progress';

  for (const profile of state.profiles) {
    const active = profile.key === state.profileKey;
    const button = el('button', {
      type: 'button',
      class: `games-profile-chip${active ? ' is-active' : ''}`,
      'aria-pressed': active ? 'true' : 'false',
      title: `${profile.personaName}${profile.gameCount != null ? ` · ${fmtInt(profile.gameCount)} ${plural(profile.gameCount, GAME_PLURAL)}` : ''}`,
    });
    button.append(el('span', { class: 'games-profile-dot', 'aria-hidden': 'true' }));
    button.append(el('span', { class: 'games-profile-name', text: profile.personaName }));
    if (profile.gameCount != null) {
      button.append(el('span', { class: 'games-profile-count', text: fmtInt(profile.gameCount) }));
    }
    button.addEventListener('click', () => switchProfile(profile.key));
    host.append(button);
  }
}

async function switchProfile(key) {
  const next = text(key);
  if (!next || next === state.profileKey) return;
  state.profileKey = next;
  safeStorageSet(PROFILE_KEY, next);
  state.loaded = false;
  state.data = null;
  state.seq += 1;
  // One owner = one profile: the personnel cache of the previous steamid64
  // must never be shown for the new one (AGENTS §6, ИГРЫ §2.0).
  state.personnel = {
    role: state.role, data: null, loading: false, error: null, cache: {}, openId: '',
    query: '', expanded: false, visible: PERSONS_INITIAL, rows: [],
  };
  state.selectedDecade = null;
  renderProfiles();
  await loadStats({ force: true });
  if (state.view === 'personnel') await ensurePersonnel(state.role, { force: true });
}

async function ensureProfiles({ reload = false } = {}) {
  if (state.profilesLoaded && !reload) return state.profiles;
  try {
    const raw = await getGamesProfiles();
    state.profiles = normalizeProfilesList(raw);
    state.profilesLoaded = true;
    // `/profiles` reports `steamKey: { configured, source }` (a boolean and a
    // source label, never the value); an older draft used a bare boolean.
    const flag = raw && typeof raw === 'object'
      ? (raw.steamKeyConfigured
        ?? (raw.steamKey && typeof raw.steamKey === 'object' ? raw.steamKey.configured : raw.steamKey)
        ?? null)
      : null;
    if (typeof flag === 'boolean') setKeyIndicator(flag);
  } catch {
    // An older server without the games routes: keep whatever key is stored
    // locally and let `/stats` report the real state.
    state.profiles = state.profiles || [];
  }
  const stored = text(safeStorageGet(PROFILE_KEY));
  const keys = state.profiles.map((profile) => profile.key);
  if (stored && (!keys.length || keys.includes(stored))) state.profileKey = stored;
  else if (keys.length) state.profileKey = keys[0];
  else state.profileKey = stored;
  if (state.profileKey) safeStorageSet(PROFILE_KEY, state.profileKey);
  renderProfiles();
  return state.profiles;
}

/* =========================================================
   data loading
   ========================================================= */

async function loadStats({ force = false, silent = false } = {}) {
  if (state.loading) {
    if (!force) return;
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
  if (!state.profileKey) {
    state.loading = false;
    state.loaded = false;
    state.data = null;
    showLoading(false);
    showScreen('import');
    renderProfiles();
    return;
  }
  const seq = ++state.seq;
  state.loading = true;
  if (!silent) showError(null);
  if (!silent && state.view !== 'dashboard' && state.view !== 'personnel') showLoading(true);
  updateActions();
  try {
    // Filters are sent only when they differ from the server defaults
    // (`includeFree=1`, `includeDlc=0`): a default dashboard request stays
    // exactly `?profile=…`, and `meta.filters` tells us what was applied.
    const query = { profile: state.profileKey };
    if (state.filters.includeFree === false) query.includeFree = false;
    if (state.filters.includeDlc === true) query.includeDlc = true;
    const raw = await getGamesStats(query);
    if (seq !== state.seq) return;
    const data = normalizeGamesPayload(raw);
    state.data = data;
    state.loaded = true;
    state.loadedAt = Date.now();
    if (data.summary.steamKeyConfigured != null) setKeyIndicator(data.summary.steamKeyConfigured);
    if (!data.has.games && !data.has.profile) {
      // Nothing imported for this key: the honest screen is the import card.
      state.loaded = false;
      showScreen('import');
      renderProfiles();
      return;
    }
    showScreen(state.view === 'personnel' ? 'personnel' : 'dashboard');
    if (silent) {
      withPreservedScroll(
        () => (typeof window !== 'undefined' ? window.scrollY || 0 : 0),
        (y) => window.scrollTo(0, y),
        () => renderDashboard(data),
      );
    } else {
      renderDashboard(data);
    }
  } catch (error) {
    if (seq !== state.seq) return;
    if (error && error.status === 401) return; // the auth view takes over
    if (error && (error.status === 404 || error.status === 400)) {
      state.loaded = false;
      state.data = null;
      if (state.job) {
        showScreen('progress');
        renderProgress();
        startPolling();
      } else {
        showScreen('import');
        renderProfiles();
        // 404 = the profile is not imported yet (normal first run). A 400 is a
        // real answer from the server (`profile_private`, …) and must be shown.
        if (error.status === 400) showError(error, importErrorText(error));
      }
      return;
    }
    if (state.data) {
      // A background enrichment poll must not spam a toast every 3.5 s: it
      // just stops the poller and keeps the last good dashboard.
      if (!silent) toast(shortErrorMessage(error), 'error', { duration: 7000 });
      stopEnrichPoll();
      return;
    }
    showScreen('import');
    renderProfiles();
    showError(error, importErrorText(error));
  } finally {
    if (seq === state.seq) {
      state.loading = false;
      showLoading(false);
      updateActions();
    }
  }
}

/* =========================================================
   import
   ========================================================= */

async function submitImport(event) {
  if (event) event.preventDefault();
  if (state.importBusy) return;
  const input = $('games-import-account');
  const account = accountFromInput(input ? input.value : '');
  if (account.error) {
    setImportError(account.error);
    if (input) input.focus();
    return;
  }
  setImportError('');
  const labelInput = $('games-import-label');
  const label = labelInput ? labelInput.value.trim() : '';
  setImportBusy(true);
  try {
    const response = await startGamesImportSteam({
      steamid64: account.steamid64 || '',
      vanityUrl: account.vanityUrl || '',
      label,
    });
    const jobId = gamesJobId(response);
    const profile = text(response && typeof response === 'object'
      ? (typeof response.profile === 'string' ? response.profile : (response.profile && response.profile.key))
      : '');
    if (!jobId && !profile) {
      // Some server versions answer "already done" without a job id.
      if (response && (response.done === true || text(response.status) === 'done')) {
        await finishImport(null);
        return;
      }
      throw new Error('Сервер не вернул идентификатор задачи импорта.');
    }
    state.job = {
      id: jobId,
      profile: profile || state.profileKey,
      status: response && typeof response === 'object' ? response : null,
      failed: null,
      startedAt: Date.now(),
    };
    if (profile) {
      state.profileKey = profile;
      safeStorageSet(PROFILE_KEY, profile);
    }
    saveJob();
    showScreen('progress');
    renderProgress();
    startPolling();
  } catch (error) {
    if (error && error.status === 401) return;
    const info = importErrorText(error);
    setImportError(`${info.title}. ${info.message}`);
    toast(info.title, 'error', { duration: 6500 });
  } finally {
    setImportBusy(false);
  }
}

function stopPolling() {
  if (state.pollTimer) window.clearTimeout(state.pollTimer);
  state.pollTimer = 0;
  state.pollSeq += 1;
}

function startPolling() {
  stopPolling();
  const pollId = state.pollSeq;
  const tick = async () => {
    if (pollId !== state.pollSeq) return;
    if (!state.job) return;
    if (!state.active) {
      // Keep the job in localStorage; `showGames()` resumes the poller.
      state.pollTimer = 0;
      return;
    }
    await pollOnce();
    if (pollId !== state.pollSeq) return;
    if (!state.job) return;
    state.pollTimer = window.setTimeout(tick, POLL_INTERVAL);
  };
  state.pollTimer = window.setTimeout(tick, 320);
}

async function pollOnce() {
  if (!state.job) return;
  const job = state.job;
  try {
    const status = await getGamesImportStatus(job.id, { profile: job.profile });
    job.status = status && typeof status === 'object' ? status : job.status;
    if (isJobDone(job.status)) {
      await finishImport(job.status);
      return;
    }
    const failure = jobFailure(job.status);
    if (failure) {
      job.failed = failure;
      saveJob();
      renderProgress();
      return;
    }
    renderProgress();
  } catch (error) {
    if (error && error.status === 401) return;
    if (error && error.status === 404) {
      // The status route may not be mounted (or the job already left the
      // server's memory). Ask the stats endpoint directly: a payload means the
      // import finished.
      const done = await tryStatsAfterJob();
      if (done) return;
      job.failed = 'задача импорта не найдена на сервере (он мог перезапускаться)';
      saveJob();
      renderProgress();
      return;
    }
    job.failed = shortErrorMessage(error);
    renderProgress();
  }
}

async function tryStatsAfterJob() {
  const key = (state.job && state.job.profile) || state.profileKey;
  if (!key) return false;
  try {
    const raw = await getGamesStats({ profile: key });
    const data = normalizeGamesPayload(raw);
    if (!data.has.games && !data.has.profile) return false;
    state.profileKey = key;
    safeStorageSet(PROFILE_KEY, key);
    state.job = null;
    saveJob();
    stopPolling();
    state.data = data;
    state.loaded = true;
    showScreen('dashboard');
    renderDashboard(data);
    return true;
  } catch {
    return false;
  }
}

function isJobDone(status) {
  if (!status || typeof status !== 'object') return false;
  if (status.done === true) return true;
  const stage = text(status.stage || status.phase || status.status || status.state).toLowerCase();
  return stage === 'done' || stage === 'finished' || stage === 'complete' || stage === 'completed' || stage === 'ok';
}

function jobFailure(status) {
  if (!status || typeof status !== 'object') return '';
  const stage = text(status.stage || status.phase || status.status || status.state).toLowerCase();
  const error = status.error;
  if (error) {
    if (typeof error === 'object') return text(error.message || error.code) || 'импорт завершился ошибкой';
    return text(error) || 'импорт завершился ошибкой';
  }
  if (status.failed === true || stage === 'failed' || stage === 'error') {
    return text(status.message) || 'импорт завершился ошибкой';
  }
  return '';
}

async function finishImport(status) {
  const key = (state.job && state.job.profile) || state.profileKey;
  stopPolling();
  state.job = null;
  saveJob();
  if (key) {
    state.profileKey = key;
    safeStorageSet(PROFILE_KEY, key);
  }
  await ensureProfiles({ reload: true });
  state.loaded = false;
  await loadStats({ force: true });
  if (state.view === 'dashboard') {
    const partial = state.data && state.data.summary && state.data.summary.libraryPartial === true;
    toast(
      partial
        ? 'Профиль Steam импортирован: профиль, достижения и последние игры. Библиотеки с часами нет — нужен ключ Steam Web API.'
        : 'Профиль Steam импортирован',
      partial ? 'info' : 'success',
      { duration: 7000 },
    );
  } else if (status && jobFailure(status)) {
    toast(jobFailure(status), 'error', { duration: 7000 });
  }
}

function renderProgress() {
  const job = state.job;
  const status = job ? job.status : null;
  const percent = jobProgress(status);
  const fill = $('games-progress-fill');
  if (fill) fill.style.width = `${Math.max(3, percent)}%`;
  const pct = $('games-progress-percent');
  if (pct) pct.textContent = `${Math.round(percent)}%`;
  const bar = $('games-progress-bar');
  if (bar) bar.setAttribute('aria-valuenow', String(Math.round(percent)));
  const line = $('games-progress-status');
  if (line) {
    line.textContent = job && job.failed ? 'Импорт остановился' : jobStageText(status);
  }
  const host = $('games-progress-error');
  if (host) {
    clear(host);
    if (job && job.failed) {
      const info = importErrorText({ code: text(status && status.code), message: job.failed });
      host.append(errorBox({
        title: info.title,
        message: info.message,
        actions: [
          { label: 'Повторить импорт', primary: true, onClick: () => { state.job = null; saveJob(); showScreen('import'); } },
        ],
      }));
      host.hidden = false;
    } else {
      host.hidden = true;
    }
  }
  const elapsed = $('games-progress-elapsed');
  if (elapsed && job) {
    const seconds = Math.max(0, Math.round((Date.now() - (job.startedAt || Date.now())) / 1000));
    elapsed.textContent = seconds >= 60
      ? `${Math.floor(seconds / 60)} мин ${seconds % 60} с`
      : `${seconds} с`;
  }
  updateActions();
}

/* =========================================================
   dashboard
   ========================================================= */

function renderDashboard(data) {
  configureGamesModals({
    profile: (data.profile && data.profile.key) || state.profileKey,
    gamesIndex: data.gamesIndex,
  });
  renderHead(data);
  renderProfileCard(data);
  renderSummary(data);
  renderPartialNote(data);
  renderFilters(data);
  renderTopHours(data);
  renderPareto(data);
  renderBacklog(data);
  renderRecently(data);
  renderHistogram(data);
  // M2/M3 widgets: every one of them hides itself when its payload block is
  // missing, so an M1 server keeps a clean dashboard.
  renderDecades(data);
  renderYears(data);
  renderGenreChart(data);
  renderModes(data);
  renderAccess(data);
  renderMetadataProgress(data);
  renderAchievements(data);
  renderCalendar(data);
  renderPersonsWidget(data);
  // The credits route is lazy and cached per role; a dashboard without it
  // still renders, and the widget shows the honest «кредиты не собраны».
  if (!state.personnel.data && !state.personnel.loading) ensurePersonnel(state.role);
  scheduleEnrichPoll();
}

function renderHead(data) {
  const { summary, profile } = data;
  const kicker = $('games-kicker');
  if (kicker) {
    kicker.textContent = profile
      ? `${profile.personaName} · steam · сводка`
      : 'библиотека Steam · сводка';
  }
  const sub = $('games-sub');
  if (!sub) return;
  const parts = [];
  if (summary.gameCount) parts.push(`${fmtInt(summary.gameCount)} ${plural(summary.gameCount, GAME_PLURAL)}`);
  if (summary.totalHours != null) parts.push(hoursText(summary.totalHours, 0));
  if (summary.playedCount) parts.push(`${fmtInt(summary.playedCount)} с часами`);
  if (summary.unplayedCount) parts.push(`${fmtInt(summary.unplayedCount)} в backlog`);
  const tail = summary.libraryPartial === true
    ? ' Библиотека не собрана: сервер работает без ключа Steam Web API — показаны профиль, достижения и последние игры.'
    : ' Часы — по данным Steam (playtime_forever), это не хронометраж.';
  sub.textContent = parts.length
    ? `${parts.join(' · ')}.${tail}`
    : `Подключите профиль Steam, чтобы увидеть часы, backlog и топ игр.${tail}`;
}

function renderProfileCard(data) {
  const widget = $('games-profile-widget');
  const host = $('games-profile-body');
  const note = $('games-profile-note');
  if (!widget || !host) return;
  const view = profileCardView(data.profile);
  clear(host);
  if (!view) {
    widget.hidden = true;
    return;
  }
  widget.hidden = false;
  if (note) note.textContent = view.privacyText;

  const head = el('div', { class: 'games-profile-head' });
  if (view.avatarUrl) {
    const img = el('img', {
      class: 'games-avatar',
      src: view.avatarUrl,
      alt: '',
      loading: 'lazy',
      referrerpolicy: 'no-referrer',
    });
    img.addEventListener('error', () => {
      const fallback = el('span', { class: 'games-avatar is-fallback', text: view.initial });
      img.replaceWith(fallback);
    });
    head.append(img);
  } else {
    head.append(el('span', { class: 'games-avatar is-fallback', text: view.initial }));
  }
  const copy = el('div', { class: 'games-profile-copy' });
  copy.append(el('div', { class: 'games-persona', text: view.persona }));
  if (view.gameCount != null) {
    copy.append(el('div', {
      class: 'games-persona-sub',
      text: `${fmtInt(view.gameCount)} ${plural(view.gameCount, GAME_PLURAL)} в библиотеке`,
    }));
  }
  head.append(copy);
  host.append(head);

  if (view.facts.length) {
    const list = el('dl', { class: 'games-facts' });
    for (const fact of view.facts) {
      const row = el('div', { class: 'games-fact', title: fact.title || '' });
      row.append(el('dt', { text: fact.label }));
      row.append(el('dd', { text: fact.value }));
      list.append(row);
    }
    host.append(list);
  }

  const last = lastPlayedInfo(data.summary ? data.summary.lastPlayedAt : null);
  const lastRow = el('p', { class: 'games-last-played', title: last.title });
  lastRow.append(el('span', { class: 'games-last-label', text: 'последний запуск: ' }));
  lastRow.append(document.createTextNode(last.text));
  host.append(lastRow);
}

function metric(descriptor) {
  const clickable = typeof descriptor.onClick === 'function';
  const node = el(clickable ? 'button' : 'div', {
    type: clickable ? 'button' : null,
    class: `metric${descriptor.extraClass ? ` ${descriptor.extraClass}` : ''}${clickable ? ' metric-clickable' : ''}`,
    title: descriptor.title || '',
    'aria-label': clickable ? `${descriptor.label}: ${descriptor.value}. Открыть список` : null,
  });
  const label = el('div', { class: 'metric-label' });
  label.innerHTML = icon(descriptor.icon || 'film', 12);
  label.append(document.createTextNode(` ${descriptor.label}`));
  node.append(label);
  node.append(el('div', { class: 'metric-value', text: descriptor.value }));
  if (descriptor.sub) node.append(el('div', { class: 'metric-sub', text: descriptor.sub }));
  if (clickable) {
    node.addEventListener('click', () => {
      hideTooltip();
      descriptor.onClick();
    });
  }
  return node;
}

function showAllButton(label, onClick) {
  const wrap = el('div', { class: 'games-show-all' });
  const button = el('button', { type: 'button', class: 'btn btn-ghost', text: label });
  button.addEventListener('click', onClick);
  wrap.append(button);
  return wrap;
}

function openSummaryList(kind, data) {
  const index = data.gamesIndex || {};
  if (kind === 'backlog') {
    const games = sortGameRows(backlogGames(index), 'hours');
    openGameListModal({
      kicker: 'Backlog',
      title: `Backlog — ${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)}`,
      subtitle: `${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)} с playtime_forever = 0`,
      hint: 'Полный backlog: игры есть в библиотеке Steam, но ни разу не запускались по данным Steam. '
        + 'Бесплатные раздачи и софт могут его завышать.',
      groupLabel: 'Backlog',
      emptyText: 'Backlog пуст',
      games,
      sortScope: 'backlog',
      defaultSort: 'name',
    });
    return;
  }
  if (kind === 'recent') {
    const games = sortGameRows(gamesWithRecentHours(index), 'hours');
    openGameListModal({
      kicker: 'За 2 недели',
      title: `За 2 недели — ${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)}`,
      subtitle: 'Игры с playtime_2weeks > 0',
      hint: 'Часы за две недели — Σ playtime_2weeks по данным Steam. Это не сессии: Steam не отдаёт их.',
      groupLabel: 'За 2 недели',
      emptyText: 'За две недели Steam не зафиксировал активности',
      games,
      sortScope: 'recent',
      defaultSort: 'hours',
    });
    return;
  }
  if (kind === 'unmatched') {
    const games = sortGameRows(gamesWithoutType(index), 'name');
    const other = data.summary && data.summary.excluded ? data.summary.excluded.otherType : 0;
    openGameListModal({
      kicker: 'Не типизированы',
      title: `Не типизированы — ${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)}`,
      subtitle: other > 0 ? `${fmtInt(other)} записей отброшено как DLC/софт/демо` : 'нет appdetails',
      hint: 'У этих записей Steam Store ещё не отдал appdetails: тип, год и жанры неизвестны. '
        + 'Это не «ноль часов» и не удалённые игры — просто метадата не собрана. '
        + 'Кнопки «исправить матч» здесь нет: сопоставление идёт на сервере.',
      groupLabel: 'Без appdetails',
      emptyText: 'Все записи типизированы',
      games,
      sortScope: 'unmatched',
      defaultSort: 'name',
    });
  }
}

function renderSummary(data) {
  const host = $('games-summary');
  if (!host) return;
  clear(host);
  const metrics = summaryMetrics(data.summary, { profile: data.profile });
  // No metrics = the payload has no library numbers (or is a partial no-key
  // import). A summary strip full of dashes would be noise, so it is hidden —
  // the partial-library banner above already explains why.
  if (!metrics.length) {
    host.hidden = true;
    host.classList.remove('has-unmatched');
    return;
  }
  host.hidden = false;
  host.classList.add('games-summary');
  host.classList.toggle('has-unmatched', metrics.some((entry) => entry.key === 'unmatched'));
  const clickable = new Set(['backlog', 'recent', 'unmatched']);
  for (const descriptor of metrics) {
    host.append(metric(clickable.has(descriptor.key)
      ? { ...descriptor, onClick: () => openSummaryList(descriptor.key, data) }
      : descriptor));
  }
}

function renderPartialNote(data) {
  const host = $('games-partial-note');
  if (!host) return;
  clear(host);
  const partial = data.summary.libraryPartial === true;
  const noKey = data.summary.steamKeyConfigured === false;
  if (!partial && !noKey) {
    host.hidden = true;
    return;
  }
  const box = el('div', { class: 'games-partial' });
  box.append(el('strong', { text: partial ? 'Библиотека не собрана: нет ключа Steam Web API' : 'Ключ Steam Web API не настроен' }));
  box.append(el('p', {
    text: partial
      ? 'Профиль, достижения и последние игры собраны без ключа. Часы, backlog, топ и Pareto требуют библиотеку: Steam отдаёт её только через Web API с ключом.'
      : 'Без ключа библиотека и часы недоступны. Ключ бесплатный и выдаётся аккаунту Steam.',
  }));
  const link = el('a', {
    href: 'https://steamcommunity.com/dev/apikey',
    target: '_blank',
    rel: 'noopener noreferrer',
    class: 'btn btn-ghost',
    text: 'Получить ключ на steamcommunity.com/dev/apikey',
  });
  box.append(link);
  host.append(box);
  host.hidden = false;
}

function renderTopHours(data) {
  const widget = $('games-top-widget');
  const host = $('games-top-list');
  const note = $('games-top-note');
  if (!widget || !host) return;
  clear(host);
  const rows = topHoursRows(data.topGames, {
    limit: TOP_LIMIT,
    totalHours: data.summary.totalHours,
  });
  if (!rows.length) {
    widget.hidden = true;
    return;
  }
  widget.hidden = false;
  if (note) note.textContent = `топ-${rows.length} · по часам`;
  for (const row of rows) {
    const node = el('div', {
      class: 'genre-row is-ranked games-hours-row is-clickable',
      role: 'button',
      tabIndex: 0,
      'aria-label': `${row.name}: ${row.hoursText}. Открыть карточку игры`,
    });
    node.append(el('span', { class: 'rank-num', text: String(row.rank) }));
    const name = el('div', { class: 'genre-name' });
    name.append(el('span', { class: 'genre-label', text: row.name }));
    node.append(name);
    const track = el('div', { class: 'genre-track' });
    const fill = el('div', { class: 'genre-fill' });
    track.append(fill);
    node.append(track);
    node.append(el('div', { class: 'genre-avg games-hours-value', text: row.hoursText }));
    host.append(node);
    requestAnimationFrame(() => {
      fill.style.width = `${row.widthPercent}%`;
    });
    node.addEventListener('pointerenter', (event) => {
      showTooltip(row.title, `${row.hint || HOURS_HINT} · нажмите, чтобы открыть карточку`);
      moveTooltip(event);
    });
    node.addEventListener('pointermove', moveTooltip);
    node.addEventListener('pointerleave', hideTooltip);
    const activate = () => {
      hideTooltip();
      if (row.appid != null) openGameCardModal(row.appid, { fallback: row });
    };
    node.addEventListener('click', activate);
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate();
    });
  }
  const all = sortGameRows(allGames(data.gamesIndex), 'hours');
  if (all.length > rows.length) {
    host.append(showAllButton(`Показать все ${fmtInt(all.length)} игр`, () => {
      openGameListModal({
        kicker: 'Топ по часам',
        title: `Все игры — ${fmtInt(all.length)}`,
        subtitle: 'Отсортировано по часам Steam',
        hint: HOURS_HINT,
        groupLabel: 'По часам',
        games: all,
        sortScope: 'top',
        defaultSort: 'hours',
      });
    }));
  }
}

function renderPareto(data) {
  const widget = $('games-pareto-widget');
  const host = $('games-pareto-body');
  const note = $('games-pareto-note');
  if (!widget || !host) return;
  clear(host);
  const view = paretoView(data.summary);
  if (!view) {
    widget.hidden = true;
    return;
  }
  widget.hidden = false;
  if (note) note.textContent = `${view.shareText} часов в топ-${view.topPercent}%`;

  const track = el('div', {
    class: 'games-pareto-track',
    role: 'img',
    'aria-label': view.text,
    title: view.text,
  });
  const fill = el('span', { class: 'games-pareto-fill' });
  track.append(fill);
  host.append(track);
  requestAnimationFrame(() => {
    fill.style.width = `${view.sharePercent}%`;
  });
  track.addEventListener('pointerenter', (event) => {
    showTooltip(view.text, view.hint);
    moveTooltip(event);
  });
  track.addEventListener('pointermove', moveTooltip);
  track.addEventListener('pointerleave', hideTooltip);

  const legend = el('div', { class: 'games-pareto-legend' });
  const left = el('span');
  left.append(el('i', { class: 'swatch green' }));
  left.append(document.createTextNode(` топ-${view.topPercent}% игр — ${view.shareText} часов`));
  const right = el('span');
  right.append(el('i', { class: 'swatch muted' }));
  right.append(document.createTextNode(` остальные — ${Math.round(view.restPercent)}%`));
  legend.append(left, right);
  host.append(legend);

  host.append(el('p', { class: 'games-pareto-text', text: view.text }));
  host.append(el('p', { class: 'games-pareto-hint', text: view.hint }));
}

function renderBacklog(data) {
  const widget = $('games-backlog-widget');
  const host = $('games-backlog-list');
  const note = $('games-backlog-note');
  if (!widget || !host) return;
  clear(host);
  const view = backlogView(data.backlog, data.summary);
  if (!view) {
    widget.hidden = true;
    return;
  }
  widget.hidden = false;
  if (note) {
    note.textContent = `${view.countText} ${plural(view.count, GAME_PLURAL)}${view.shareText ? ` · ${view.shareText} библиотеки` : ''}`;
  }
  if (!view.hasItems) {
    host.append(el('p', { class: 'games-backlog-empty', text: `Состав backlog сервер не передал — известен только счётчик: ${view.countText}.` }));
    return;
  }
  for (const item of view.items.slice(0, BACKLOG_LIMIT)) {
    const row = el('div', {
      class: 'games-list-row is-clickable',
      role: 'button',
      tabIndex: 0,
      'aria-label': `${item.name}: открыть карточку игры`,
    });
    row.append(el('span', { class: 'games-list-name', text: item.name }));
    const meta = [item.yearText, item.genresText].filter(Boolean).join(' · ');
    row.append(el('span', { class: 'games-list-meta', text: meta }));
    host.append(row);
    const activate = () => {
      hideTooltip();
      if (item.appid != null) openGameCardModal(item.appid, { fallback: item });
    };
    row.addEventListener('click', activate);
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate();
    });
    row.addEventListener('pointerenter', (event) => {
      showTooltip(item.name, `${meta || 'метадата неизвестна'} · нажмите, чтобы открыть карточку`);
      moveTooltip(event);
    });
    row.addEventListener('pointermove', moveTooltip);
    row.addEventListener('pointerleave', hideTooltip);
  }
  const all = sortGameRows(backlogGames(data.gamesIndex), 'name');
  const total = Math.max(view.count, all.length);
  if (total > BACKLOG_LIMIT) {
    host.append(showAllButton(`Показать все ${fmtInt(total)} игр backlog`, () => openSummaryList('backlog', data)));
  }
}

function renderRecently(data) {
  const widget = $('games-recent-widget');
  const host = $('games-recent-list');
  const note = $('games-recent-note');
  if (!widget || !host) return;
  clear(host);
  const view = recentlyView(data.recentlyPlayed);
  if (!view.visible) {
    widget.hidden = true;
    return;
  }
  widget.hidden = false;
  if (note) note.textContent = `${view.total2wText} за две недели`;
  for (const item of view.items) {
    const row = el('div', {
      class: 'games-recent-row is-clickable',
      role: 'button',
      tabIndex: 0,
      title: item.lastPlayedTitle,
      'aria-label': `${item.name}: открыть карточку игры`,
    });
    row.append(el('span', { class: 'games-list-name', text: item.name }));
    row.append(el('span', {
      class: 'games-recent-hours',
      text: item.hours2wText || '—',
      title: item.hint,
    }));
    const last = el('span', {
      class: 'games-recent-last',
      text: item.lastPlayedText ? `последний раз ${item.lastPlayedText}` : 'последний запуск неизвестен',
      title: item.lastPlayedTitle,
    });
    row.append(last);
    host.append(row);
    row.addEventListener('pointerenter', (event) => {
      showTooltip(`${item.name} — ${item.hours2wText || 'нет часов'} за 2 недели`, `${item.hint} · нажмите, чтобы открыть карточку`);
      moveTooltip(event);
    });
    row.addEventListener('pointermove', moveTooltip);
    row.addEventListener('pointerleave', hideTooltip);
    const activate = () => {
      hideTooltip();
      if (item.appid != null) openGameCardModal(item.appid, { fallback: item });
    };
    row.addEventListener('click', activate);
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate();
    });
  }
}

function renderHistogram(data) {
  const widget = $('games-histogram-widget');
  const host = $('games-histogram');
  const note = $('games-histogram-note');
  if (!widget || !host) return;
  clear(host);
  const view = histogramView(data.histogram);
  if (!view) {
    widget.hidden = true;
    return;
  }
  widget.hidden = false;
  if (note) note.textContent = `${view.totalText} ${plural(view.total, GAME_PLURAL)}`;
  for (const row of view.rows) {
    const node = el('div', {
      class: 'genre-row games-hist-row is-clickable',
      title: row.title,
      role: 'button',
      tabIndex: 0,
      'aria-label': `${row.bucket} ч: ${row.countText} игр. Открыть список`,
    });
    node.append(el('span', { class: 'games-hist-bucket', text: row.bucket }));
    const track = el('div', { class: 'genre-track' });
    const fill = el('div', { class: 'genre-fill' });
    track.append(fill);
    node.append(track);
    node.append(el('span', { class: 'genre-avg', text: row.countText }));
    host.append(node);
    requestAnimationFrame(() => {
      fill.style.width = `${row.widthPercent}%`;
    });
    node.addEventListener('pointerenter', (event) => {
      showTooltip(row.title, 'Бакеты по часам playtime_forever · нажмите, чтобы открыть список');
      moveTooltip(event);
    });
    node.addEventListener('pointermove', moveTooltip);
    node.addEventListener('pointerleave', hideTooltip);
    const activate = () => {
      hideTooltip();
      const games = sortGameRows(gamesInHoursBucket(data.gamesIndex, row.bucket), 'hours');
      openGameListModal({
        kicker: 'Часы: длинный хвост',
        title: `${row.bucket} ч — ${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)}`,
        subtitle: 'Игры по бакету playtime_forever',
        hint: 'Границы бакетов совпадают с серверными: 0, <1, 1–5, 5–20, 20–50, 50–100, 100–500, 500+.',
        groupLabel: `${row.bucket} ч`,
        emptyText: 'В этом бакете нет игр',
        games,
        sortScope: 'histogram',
        defaultSort: 'hours',
      });
    };
    node.addEventListener('click', activate);
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate();
    });
  }
}

/* =========================================================
   M2: filters, decades, years, genres, modes, access, enrichment
   ========================================================= */

/** Requested-vs-applied is printed as-is: a silent filter would be a lie. */
function renderFilters(data) {
  const section = $('games-filters');
  const note = $('games-filter-note');
  const free = $('games-filter-free');
  const dlc = $('games-filter-dlc');
  if (!section) return;
  const view = filtersView(data.filters, {
    includeFree: state.filters.includeFree,
    includeDlc: state.filters.includeDlc,
  });
  // Keep the checkboxes in sync with what the server understood.
  if (free && free.checked !== (view.state.includeFree === false)) {
    free.checked = view.state.includeFree === false;
  }
  if (dlc && dlc.checked !== (view.state.includeDlc === true)) {
    dlc.checked = view.state.includeDlc === true;
  }
  if (note) {
    const texts = view.items
      .filter((item) => item.status === 'pending' || item.status === 'applied' || item.status === 'unknown')
      .map((item) => item.text);
    note.textContent = view.honest ? view.note : texts.join(' · ');
    note.classList.toggle('is-honest', view.honest);
  }
  section.hidden = false;
}

function applyFilters(next) {
  state.filters = {
    includeFree: next.includeFree !== false,
    includeDlc: next.includeDlc === true,
  };
  safeStorageSet(FILTERS_KEY, JSON.stringify(state.filters));
  state.loaded = false;
  loadStats({ force: true });
}

function selectDecade(data, row) {
  if (row.unknown) {
    openUnknownDecadeModal(data);
    return;
  }
  const same = state.selectedDecade && state.selectedDecade.start === row.decade;
  state.selectedDecade = same ? null : { start: row.decade, label: row.label };
  renderDecades(data);
  renderYears(data);
}

function openUnknownDecadeModal(data) {
  const games = sortGameRows(gamesWithoutYear(data.gamesIndex), 'name');
  openGameListModal({
    kicker: 'Десятилетия',
    title: `Год неизвестен — ${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)}`,
    subtitle: 'У этих записей нет releaseYear',
    hint: 'Год релиза берётся из Steam Store / Wikidata. Если appdetails ещё не собраны, '
      + 'игра честно попадает в «год неизвестен», а не в выдуманное десятилетие.',
    groupLabel: 'Без года',
    emptyText: 'Все игры с известным годом',
    games,
    sortScope: 'decade-unknown',
    defaultSort: 'name',
  });
}

function renderDecades(data) {
  const widget = $('games-decades-widget');
  const host = $('games-decades-list');
  const note = $('games-decades-note');
  if (!widget || !host) return;
  clear(host);
  const view = decadesView(data.decades);
  if (!view) {
    widget.hidden = true;
    return;
  }
  widget.hidden = false;
  if (note) {
    const selected = state.selectedDecade ? ` · выбрано: ${state.selectedDecade.label}` : '';
    note.textContent = `${view.note}${selected}`;
  }
  view.rows.forEach((row, index) => {
    const selected = Boolean(state.selectedDecade && !row.unknown
      && state.selectedDecade.start === row.decade);
    const node = el('div', {
      class: `genre-row is-ranked is-clickable${row.unknown ? ' is-unknown' : ''}${selected ? ' is-selected' : ''}`,
      title: row.hint,
      role: 'button',
      tabIndex: 0,
      'aria-pressed': selected ? 'true' : 'false',
      'aria-label': row.unknown
        ? `${row.label}: ${row.countText} игр без года. Открыть список`
        : `${row.label}: ${row.countText} игр. ${selected ? 'Снять выбор' : 'Показать годы десятилетия'}`,
    });
    node.append(el('span', { class: 'rank-num', text: String(index + 1) }));
    const name = el('div', { class: 'genre-name' });
    name.append(el('span', { class: 'genre-label', text: row.label }));
    name.append(el('span', { class: 'genre-count', text: row.countText }));
    node.append(name);
    const track = el('div', { class: 'genre-track' });
    const fill = el('div', { class: 'genre-fill' });
    track.append(fill);
    node.append(track);
    node.append(el('div', { class: 'genre-avg', text: row.hoursText || '—' }));
    host.append(node);
    requestAnimationFrame(() => {
      fill.style.width = `${row.widthPercent}%`;
    });
    node.addEventListener('pointerenter', (event) => {
      showTooltip(row.title, `${row.hint}${row.unknown ? ' · нажмите, чтобы открыть список' : ' · нажмите, чтобы показать годы'}`);
      moveTooltip(event);
    });
    node.addEventListener('pointermove', moveTooltip);
    node.addEventListener('pointerleave', hideTooltip);
    const activate = () => {
      hideTooltip();
      selectDecade(data, row);
    };
    node.addEventListener('click', activate);
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate();
    });
  });
}

function decadeHint(text = 'Выберите десятилетие слева, чтобы увидеть годы') {
  const box = el('div', { class: 'years-empty' });
  box.append(el('span', { class: 'years-empty-ring', 'aria-hidden': 'true' }));
  box.append(el('p', { class: 'years-empty-text', text }));
  return box;
}

function openYearModal(data, year) {
  const games = sortGameRows(gamesInYear(data.gamesIndex, year), 'hours');
  openGameListModal({
    kicker: 'Годы релиза',
    title: `${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)} ${year} года`,
    subtitle: `Год релиза ${year} · ${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)} в выгрузке`,
    hint: 'Год релиза игры (release_date из Steam Store / Wikidata), а не год, когда вы в неё играли.',
    groupLabel: String(year),
    emptyText: 'Для этого года нет игр с карточкой Steam Store',
    games,
    sortScope: 'year',
    defaultSort: 'hours',
  });
}

function renderYears(data) {
  const widget = $('games-years-widget');
  const host = $('games-years-chart');
  const note = $('games-years-note');
  if (!widget || !host) return;
  const view = yearsView(data.years);
  if (!view) {
    widget.hidden = true;
    clear(host);
    if (note) note.textContent = '';
    return;
  }
  widget.hidden = false;
  clear(host);

  // Films parity: the years card is gated by the decade selection. A bar
  // chart of every year at once duplicates the decades list and hides the
  // drilldown; the placeholder says how to unlock it.
  if (!state.selectedDecade) {
    if (note) note.textContent = '';
    host.append(decadeHint());
    return;
  }

  const start = Number(state.selectedDecade.start);
  const years = yearsInDecade(data.years, start);
  const total = years.reduce((sum, item) => sum + item.count, 0);
  if (note) {
    note.textContent = total
      ? `${start}–${start + 9} · ${fmtInt(years.length)} ${plural(years.length, ['год', 'года', 'лет'])} · ${fmtInt(total)} ${plural(total, GAME_PLURAL)}`
      : `${state.selectedDecade.label} · нет игр`;
  }
  if (!years.length) {
    host.append(decadeHint(`В ${state.selectedDecade.label} нет игр с известным годом`));
    return;
  }

  renderYearBars(host, years, {
    unitForms: GAME_PLURAL,
    shareLabel: 'игр десятилетия',
    emptyText: 'Нет данных по годам релиза',
    ariaLabel: `Игры по годам релиза: ${start} — ${start + 9}`,
    yearNote: () => 'год релиза из Steam Store / Wikidata',
    onYearClick: (year) => openYearModal(data, year),
  });
}

function renderGenreChart(data) {
  const widget = $('games-genres-widget');
  const host = $('games-genres-chart');
  const moreHost = $('games-genres-more');
  const note = $('games-genres-note');
  if (!widget || !host) return;
  clear(host);
  if (moreHost) clear(moreHost);
  const view = genreChartView(data.genres, {
    weight: state.genreWeight,
    limit: state.genresExpanded ? 0 : GENRE_CHART_LIMIT,
    // Fallback denominator only: the payload's `genres[].share` wins when set.
    totalHours: data.summary ? data.summary.totalHours : null,
  });
  if (!view) {
    widget.hidden = true;
    return;
  }
  widget.hidden = false;
  if (note) note.textContent = view.note;
  for (const row of view.rows) {
    const node = el('div', {
      class: 'genre-row games-genre-row is-clickable',
      title: row.title,
      role: 'button',
      tabIndex: 0,
      'aria-label': row.ariaLabel,
    });
    const name = el('div', { class: 'genre-name' });
    name.append(el('span', { class: 'genre-label', text: row.name }));
    node.append(name);
    const track = el('div', { class: 'genre-track' });
    const fill = el('div', { class: 'genre-fill' });
    track.append(fill);
    node.append(track);
    const value = el('div', { class: 'genre-avg games-genre-value' });
    value.append(el('span', { text: row.primaryText }));
    if (row.secondaryText) value.append(el('small', { text: row.secondaryText }));
    node.append(value);
    host.append(node);
    requestAnimationFrame(() => {
      fill.style.width = `${row.widthPercent}%`;
    });
    node.addEventListener('pointerenter', (event) => {
      showTooltip(row.title, row.hint);
      moveTooltip(event);
    });
    node.addEventListener('pointermove', moveTooltip);
    node.addEventListener('pointerleave', hideTooltip);
    const activate = () => {
      hideTooltip();
      const games = sortGameRows(gamesByGenre(data.gamesIndex, row.name), 'hours');
      openGameListModal({
        kicker: 'Жанр',
        title: `${row.name} — ${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)}`,
        subtitle: `${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)} · ${row.hoursText || 'часы неизвестны'}`,
        hint: 'Жанры Steam Store; одна игра может попадать в несколько жанров, поэтому сумма по жанрам больше числа игр.',
        groupLabel: row.name,
        emptyText: 'Нет игр этого жанра с карточкой Steam Store',
        games,
        sortScope: 'genre',
        defaultSort: 'hours',
      });
    };
    node.addEventListener('click', activate);
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate();
    });
  }
  if (moreHost) {
    if (view.hidden > 0) {
      const button = el('button', {
        type: 'button',
        class: 'btn games-genre-more-btn',
        text: `Показать все (${fmtInt(view.total)})`,
      });
      button.addEventListener('click', () => {
        state.genresExpanded = true;
        renderGenreChart(data);
      });
      moreHost.append(button);
    } else if (state.genresExpanded && view.total > GENRE_CHART_LIMIT) {
      const button = el('button', {
        type: 'button',
        class: 'btn btn-link games-genre-more-btn',
        text: 'Свернуть до топ-12',
      });
      button.addEventListener('click', () => {
        state.genresExpanded = false;
        renderGenreChart(data);
      });
      moreHost.append(button);
    }
  }
  for (const button of document.querySelectorAll('[data-games-genre-weight]')) {
    const active = button.dataset.gamesGenreWeight === view.weight;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function renderModes(data) {
  const widget = $('games-modes-widget');
  const host = $('games-modes-list');
  const note = $('games-modes-note');
  if (!widget || !host) return;
  clear(host);
  const view = modesView(data.summary.modes);
  if (!view) {
    widget.hidden = true;
    return;
  }
  widget.hidden = false;
  if (note) note.textContent = view.note;
  for (const row of view.rows) {
    const node = el('div', {
      class: 'genre-row is-clickable',
      title: row.title,
      role: 'button',
      tabIndex: 0,
      'aria-label': `${row.label}: ${row.countText} игр. Открыть список`,
    });
    const name = el('div', { class: 'genre-name' });
    name.append(el('span', { class: 'genre-label', text: row.label }));
    name.append(el('span', { class: 'genre-count', text: row.countText }));
    node.append(name);
    const track = el('div', { class: 'genre-track' });
    const fill = el('div', { class: 'genre-fill' });
    track.append(fill);
    node.append(track);
    node.append(el('div', { class: 'genre-avg', text: row.hoursText || row.shareText || '—' }));
    host.append(node);
    requestAnimationFrame(() => {
      fill.style.width = `${row.widthPercent}%`;
    });
    node.addEventListener('pointerenter', (event) => {
      showTooltip(row.title, `${row.hint} · нажмите, чтобы открыть список`);
      moveTooltip(event);
    });
    node.addEventListener('pointermove', moveTooltip);
    node.addEventListener('pointerleave', hideTooltip);
    const activate = () => {
      hideTooltip();
      const games = sortGameRows(gamesByMode(data.gamesIndex, row.key), 'hours');
      openGameListModal({
        kicker: 'Режимы',
        title: `${row.label} — ${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)}`,
        subtitle: `${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)} с категорией «${row.label}»`,
        hint: 'Категории Steam Store (categories[]): одна игра может быть и одиночной, и кооперативной. '
          + 'Счётчик совпадает с summary.modes, потому что клиент использует те же регулярные выражения.',
        groupLabel: row.label,
        emptyText: 'Нет игр с этой категорией',
        games,
        sortScope: 'mode',
        defaultSort: 'hours',
      });
    };
    node.addEventListener('click', activate);
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate();
    });
  }
}

function renderAccess(data) {
  const widget = $('games-access-widget');
  const host = $('games-access-body');
  const note = $('games-access-note');
  if (!widget || !host) return;
  clear(host);
  const view = accessView(data.summary);
  if (!view) {
    widget.hidden = true;
    return;
  }
  widget.hidden = false;
  if (note) note.textContent = view.note;
  for (const item of view.items) {
    const node = el('div', {
      class: 'games-access-item is-clickable',
      title: item.hint,
      role: 'button',
      tabIndex: 0,
      'aria-label': `${item.label}: ${item.countText} игр. Открыть список`,
    });
    node.append(el('span', { class: 'games-access-label', text: item.label }));
    node.append(el('span', { class: 'games-access-value', text: item.countText }));
    const sub = [
      item.hoursText ? `${item.hoursText}` : '',
      item.shareText ? `${item.shareText} библиотеки` : '',
    ].filter(Boolean).join(' · ');
    if (sub) node.append(el('span', { class: 'games-access-sub', text: sub }));
    host.append(node);
    node.addEventListener('pointerenter', (event) => {
      showTooltip(`${item.label} — ${item.countText} ${plural(item.count, GAME_PLURAL)}`, `${item.hint} · нажмите, чтобы открыть список`);
      moveTooltip(event);
    });
    node.addEventListener('pointermove', moveTooltip);
    node.addEventListener('pointerleave', hideTooltip);
    const activate = () => {
      hideTooltip();
      const games = sortGameRows(gamesByAccess(data.gamesIndex, item.key), 'hours');
      openGameListModal({
        kicker: 'Доступ',
        title: `${item.label} — ${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)}`,
        subtitle: `${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)} · ${item.shareText || 'доля неизвестна'} библиотеки`,
        hint: item.hint,
        groupLabel: item.label,
        emptyText: 'Нет игр с этим признаком',
        games,
        sortScope: 'access',
        defaultSort: 'hours',
      });
    };
    node.addEventListener('click', activate);
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate();
    });
  }
}

function renderMetadataProgress(data) {
  const widget = $('games-meta-widget');
  const host = $('games-meta-body');
  const note = $('games-meta-note');
  if (!widget || !host) return;
  clear(host);
  const view = metadataProgressView(data.summary.metadata);
  if (!view) {
    widget.hidden = true;
    return;
  }
  widget.hidden = false;
  if (note) {
    note.textContent = view.running ? 'обогащение идёт…' : '';
    note.classList.toggle('is-running', view.running === true);
  }
  const rows = [
    { part: view.details, className: 'is-details' },
    { part: view.credits, className: 'is-credits' },
  ];
  for (const { part, className } of rows) {
    if (!part || !part.visible) continue;
    const row = el('div', { class: `games-meta-row ${className}`, title: view.hint });
    const top = el('div', { class: 'games-meta-top' });
    top.append(el('span', { class: 'games-meta-label', text: part.text }));
    top.append(el('span', { class: 'games-meta-percent', text: part.percentText }));
    row.append(top);
    const track = el('div', { class: 'games-meta-track' });
    const fill = el('div', { class: 'games-meta-fill' });
    track.append(fill);
    row.append(track);
    host.append(row);
    requestAnimationFrame(() => {
      fill.style.width = `${Math.max(2, part.percent == null ? 2 : part.percent)}%`;
    });
    row.addEventListener('pointerenter', (event) => {
      showTooltip(`${part.text} · ${part.percentText}`, view.hint);
      moveTooltip(event);
    });
    row.addEventListener('pointermove', moveTooltip);
    row.addEventListener('pointerleave', hideTooltip);
  }
}

function renderAchievements(data) {
  const widget = $('games-achievements-widget');
  const host = $('games-achievements-body');
  const note = $('games-achievements-note');
  if (!widget || !host) return;
  clear(host);
  const view = achievementsOverviewView(data.summary);
  if (!view) {
    widget.hidden = true;
    return;
  }
  widget.hidden = false;
  if (note) note.textContent = view.totalText ? `${view.note} · ${view.totalText}` : view.note;
  for (const metric of view.metrics) {
    const node = el('div', { class: 'games-achievement-metric', title: metric.hint });
    node.append(el('div', { class: 'games-achievement-value', text: metric.value }));
    node.append(el('div', { class: 'games-achievement-label', text: metric.label }));
    host.append(node);
    node.addEventListener('pointerenter', (event) => {
      showTooltip(`${metric.label}: ${metric.value}`, metric.hint);
      moveTooltip(event);
    });
    node.addEventListener('pointermove', moveTooltip);
    node.addEventListener('pointerleave', hideTooltip);
  }
}

function gameNameOf(appid) {
  const index = state.data && state.data.gamesIndex ? state.data.gamesIndex : {};
  const entry = index[appid] || index[String(appid)];
  return entry && entry.name ? entry.name : '';
}

function openAchievementDayModal(day) {
  const index = state.data && state.data.gamesIndex ? state.data.gamesIndex : {};
  const rows = (day.appids || []).map((appid) => {
    const entry = index[appid] || index[String(appid)];
    return entry || {
      appid,
      name: `appid ${appid}`,
      hours: null,
      hours2w: null,
      completion: null,
      releaseYear: null,
      type: '',
      iconUrl: '',
    };
  });
  const games = sortGameRows(rows, 'hours');
  openGameListModal({
    kicker: 'Календарь достижений',
    title: `Достижения за ${formatDateRu(day.date)}`,
    subtitle: `${fmtInt(day.count)} ${plural(day.count, ['достижение', 'достижения', 'достижений'])} · `
      + `${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)}`,
    hint: 'Календарь построен по датам разблокировок (unlockTimestamp), а не по игровому времени. '
      + 'День с достижением ≠ день, когда вы играли.',
    groupLabel: formatDateRu(day.date),
    emptyText: 'Состав игр сервер не передал',
    games,
    sortScope: 'achievement-day',
    defaultSort: 'hours',
  });
}

function renderCalendar(data) {
  const widget = $('games-calendar-widget');
  const host = $('games-calendar-host');
  const note = $('games-calendar-note');
  const streakHost = $('games-streak-card');
  if (!widget || !host) return;
  const view = calendarView(data.achievementDays, data.timeline);
  const streaks = achievementStreaksView(data.streaks, data.achievementDays);
  if (!view) {
    widget.hidden = true;
    clear(host);
    if (streakHost) clear(streakHost);
    return;
  }
  widget.hidden = false;
  if (note) note.textContent = view.note;
  renderAchievementStreaks(streakHost, streaks);
  renderAchievementCalendar(host, view.days, {
    nameOf: gameNameOf,
    onDayClick: openAchievementDayModal,
  });
}

/* =========================================================
   M3: inline persons widget (films parity)
   ========================================================= */

/**
 * Role select options follow the payload: developers first, then only the
 * roles the payload reports (`coverage.byRole`), publishers when studio credits
 * exist. The static markup is the fallback until the first payload arrives, so
 * the select is never empty.
 */
function renderRoleOptions(payload) {
  const select = $('games-persons-role');
  if (!select) return;
  const options = personnelRoleOptions(payload);
  const signature = options.map((option) => option.key).join(',');
  if (select.dataset && select.dataset.gamesRoles === signature && select.children.length === options.length) {
    if (select.value !== state.role) select.value = state.role;
    return;
  }
  clear(select);
  for (const option of options) {
    const node = el('option', { value: option.key, text: option.label });
    node.title = option.hint || '';
    if (option.key === state.role) node.setAttribute('selected', 'selected');
    select.append(node);
  }
  if (select.dataset) select.dataset.gamesRoles = signature;
  select.value = state.role;
}

function widgetPersonRows(payload) {
  if (!payload) return [];
  const rows = personnelRows(payload, { weight: state.weight });
  const query = state.personnel.query;
  if (!query) return rows;
  return rows.filter((row) => `${row.name} ${row.aliasesText || ''}`.toLowerCase().includes(query));
}

function widgetPersonRow(row, index) {
  const node = el('div', {
    class: 'person-row',
    role: 'button',
    tabIndex: 0,
    'data-rank': String(index + 1),
    'aria-label': `${index + 1}. ${row.name}: ${personCountText(row)}. Открыть игры`,
  });
  node.append(el('span', { class: 'person-rank', text: String(index + 1) }));
  node.append(personAvatarEl(row));

  const info = el('div', { class: 'person-info' });
  info.append(el('div', { class: 'person-name', text: row.name }));
  const sub = [
    row.rolesText,
    row.aliasesText ? `также: ${row.aliasesText}` : '',
  ].filter(Boolean).join(' · ');
  if (sub) info.append(el('div', { class: 'person-sub', text: sub }));
  node.append(info);

  const stats = el('div', { class: 'person-stats' });
  const value = state.weight === 'count'
    ? `${row.countText} ${plural(row.count, GAME_PLURAL)}`
    : (row.hoursText || '—');
  stats.append(el('div', { class: 'person-count', text: value }));
  stats.append(el('div', {
    class: 'person-avg',
    text: state.weight === 'count' ? (row.hoursText || 'часы неизвестны') : `${row.countText} ${plural(row.count, GAME_PLURAL)}`,
  }));
  node.append(stats);

  node.addEventListener('pointerenter', (event) => {
    showTooltip(row.title, `${row.gamesHint || row.hint} · нажмите, чтобы открыть игры`);
    moveTooltip(event);
  });
  node.addEventListener('pointermove', moveTooltip);
  node.addEventListener('pointerleave', hideTooltip);

  const activate = () => {
    hideTooltip();
    openPersonModal({
      person: row,
      role: state.role,
      weight: state.weight,
      coverage: state.personnel.data && state.personnel.data.coverage,
    });
  };
  node.addEventListener('click', activate);
  node.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    activate();
  });
  return node;
}

function personCountText(row) {
  return state.weight === 'count'
    ? `${row.countText} ${plural(row.count, GAME_PLURAL)}`
    : `${row.hoursText || '—'} · ${row.countText} ${plural(row.count, GAME_PLURAL)}`;
}

function renderPersonsWidget(data) {
  const widget = $('games-persons-widget');
  const host = $('games-person-list');
  const moreHost = $('games-persons-more');
  const note = $('games-persons-note');
  const badge = $('games-persons-coverage');
  const loading = $('games-persons-loading');
  const errorHost = $('games-persons-error');
  const searchWrap = $('games-persons-search-wrap');
  const select = $('games-persons-role');
  if (!widget || !host) return;
  if (!data && !state.personnel.data) {
    widget.hidden = true;
    return;
  }
  widget.hidden = false;
  renderRoleOptions(state.personnel.data);
  if (select && select.value !== state.role) select.value = state.role;
  if (searchWrap) searchWrap.hidden = !(state.personnel.expanded || state.personnel.query);
  for (const button of document.querySelectorAll('[data-games-weight]')) {
    const active = button.dataset.gamesWeight === state.weight;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  const payload = state.personnel.data;
  const rows = widgetPersonRows(payload);
  state.personnel.rows = rows;

  const percent = payload && payload.coverage && payload.coverage.percent != null
    ? payload.coverage.percent
    : (data && data.summary && data.summary.metadata ? data.summary.metadata.creditsPercent : null);
  const badgeView = coverageBadge(percent);
  if (badge) {
    if (badgeView && badgeView.visible) {
      badge.hidden = false;
      badge.textContent = badgeView.text;
      badge.title = badgeView.title;
    } else {
      badge.hidden = true;
    }
  }
  if (note) {
    const parts = [];
    if (rows.length) {
      parts.push(personnelRoleCountText(rows.length, state.role));
    } else if (state.personnel.loading) {
      parts.push('собираем кредиты…');
    }
    parts.push(`по ${state.weight === 'count' ? 'числу игр' : 'часам'}`);
    if (payload && payload.coverage && payload.coverage.gamesWithCredits != null && payload.coverage.gamesTotal) {
      parts.push(`кредиты у ${fmtInt(payload.coverage.gamesWithCredits)} из ${fmtInt(payload.coverage.gamesTotal)} игр`);
    }
    note.textContent = parts.join(' · ');
  }
  if (loading) loading.hidden = !state.personnel.loading;

  clear(host);
  clear(moreHost);
  if (errorHost) {
    clear(errorHost);
    errorHost.hidden = true;
    if (state.personnel.error && !rows.length) {
      errorHost.append(errorBox({
        title: state.personnel.error.code === 'personnel_unavailable' ? 'Кредиты ещё не собраны' : 'Не удалось получить персоналии',
        message: state.personnel.error.message,
        actions: [{ label: 'Повторить', primary: true, onClick: () => ensurePersonnel(state.role, { force: true }) }],
      }));
      errorHost.hidden = false;
    }
  }
  if (state.personnel.loading && !payload) return;

  if (!rows.length) {
    host.append(el('div', {
      class: 'games-personnel-empty',
      text: payload
        ? payload.emptyText
        : 'Кредиты не собраны: раздел появится после обогащения библиотеки (MobyGames/Wikidata).',
    }));
    return;
  }

  const visible = Math.max(PERSONS_INITIAL, state.personnel.visible);
  rows.slice(0, visible).forEach((row, index) => host.append(widgetPersonRow(row, index)));

  const remaining = rows.length - visible;
  if (remaining > 0) {
    const button = el('button', {
      type: 'button',
      class: 'btn',
      text: !state.personnel.expanded && !state.personnel.query
        ? `Показать всех (${fmtInt(rows.length)})`
        : `Показать ещё ${fmtInt(Math.min(PERSONS_BATCH, remaining))}`,
    });
    button.addEventListener('click', () => {
      state.personnel.expanded = true;
      state.personnel.visible = Math.min(rows.length, visible + PERSONS_BATCH);
      if (searchWrap) searchWrap.hidden = false;
      renderPersonsWidget(state.data);
    });
    moreHost.append(button);
  }
}

/* =========================================================
   enrichment poll (progress bar stays honest while backfill runs)
   ========================================================= */

function stopEnrichPoll() {
  if (state.enrichTimer) window.clearTimeout(state.enrichTimer);
  state.enrichTimer = 0;
  state.enrichSeq += 1;
}

function scheduleEnrichPoll() {
  const metadata = state.data && state.data.summary && state.data.summary.metadata;
  const running = Boolean(metadata && metadata.running === true);
  if (!running || !state.active) {
    stopEnrichPoll();
    state.enrichTicks = 0;
    return;
  }
  if (state.enrichTimer) return;
  if (state.enrichTicks >= ENRICH_POLL_LIMIT) {
    stopEnrichPoll();
    return;
  }
  const seq = state.enrichSeq;
  state.enrichTimer = window.setTimeout(async () => {
    state.enrichTimer = 0;
    if (seq !== state.enrichSeq || !state.active) return;
    state.enrichTicks += 1;
    await loadStats({ force: true, silent: true });
  }, ENRICH_POLL_INTERVAL);
}

/* =========================================================
   M3: personnel screen
   ========================================================= */

function readViewParam() {
  try {
    const value = new URLSearchParams(window.location.search).get('view');
    return value === 'personnel' ? 'personnel' : '';
  } catch {
    return '';
  }
}

/** `?tab=games&view=personnel` — the sub-screen is addressable (like books). */
function writeViewParam(view, { push = true } = {}) {
  try {
    const url = new URL(window.location.href);
    if (view) url.searchParams.set('view', view);
    else url.searchParams.delete('view');
    const href = `${url.pathname}${url.search}${url.hash}`;
    const data = { tab: 'games', view: view || null };
    if (push) window.history.pushState(data, '', href);
    else window.history.replaceState(data, '', href);
  } catch {
    /* history can be unavailable in exotic embeds */
  }
}

function personnelCacheKey(role) {
  return `${state.profileKey}:${role}`;
}

/** One personnel request; an older server that only knows `studio` is retried. */
async function fetchPersonnel(role) {
  try {
    return await getGamesPersonnel({ profile: state.profileKey, role });
  } catch (error) {
    // `studio` is the pre-split key (developers + publishers mixed). A server
    // that rejects `developer` still answers it, so the UI never goes empty.
    if (role === 'developer' && error && error.code === 'invalid_role') {
      return getGamesPersonnel({ profile: state.profileKey, role: 'studio' });
    }
    throw error;
  }
}

async function ensurePersonnel(role, { force = false } = {}) {
  const nextRole = normalizePersonnelRole(role) || PERSONNEL_ROLES[0].key;
  if (!state.profileKey) return;
  const changed = state.role !== nextRole;
  state.role = nextRole;
  safeStorageSet(ROLE_KEY, nextRole);
  if (changed) {
    state.personnel.query = '';
    state.personnel.expanded = false;
    state.personnel.visible = PERSONS_INITIAL;
    const search = $('games-persons-search');
    if (search) search.value = '';
    const searchWrap = $('games-persons-search-wrap');
    if (searchWrap) searchWrap.hidden = true;
  }
  const key = personnelCacheKey(nextRole);
  const cached = state.personnel.cache[key];
  if (cached && !force) {
    state.personnel.role = nextRole;
    state.personnel.data = cached;
    state.personnel.error = null;
    state.personnel.loading = false;
    renderPersonnel();
    renderPersonsWidget(state.data);
    return;
  }
  state.personnel.role = nextRole;
  state.personnel.data = cached || null;
  state.personnel.loading = true;
  state.personnel.error = null;
  state.personnel.openId = '';
  renderPersonnel();
  renderPersonsWidget(state.data);
  try {
    const raw = await fetchPersonnel(nextRole);
    const data = normalizePersonnel(raw, nextRole);
    state.personnel.cache[key] = data;
    if (state.personnel.role === nextRole) {
      state.personnel.data = data;
      state.personnel.error = null;
    }
  } catch (error) {
    if (error && error.status === 401) return;
    const missing = error && (error.status === 404 || error.status === 400);
    state.personnel.cache[key] = normalizePersonnel({ items: [], role: nextRole }, nextRole);
    if (state.personnel.role === nextRole) {
      state.personnel.data = state.personnel.cache[key];
      state.personnel.error = missing
        ? {
          code: 'personnel_unavailable',
          message: 'Сервер ещё не отдаёт кредиты персоналий: раздел появится после обогащения (MobyGames/Wikidata).',
        }
        : { code: (error && error.code) || 'network', message: shortErrorMessage(error) };
    }
  } finally {
    state.personnel.loading = false;
    if (state.personnel.role === nextRole) {
      renderPersonnel();
      renderPersonsWidget(state.data);
    }
  }
}

function renderRoleChips() {
  const host = $('games-role-chips');
  if (!host) return;
  clear(host);
  for (const role of PERSONNEL_ROLES) {
    const cached = state.personnel.cache[personnelCacheKey(role.key)];
    const active = state.role === role.key;
    const button = el('button', {
      type: 'button',
      class: `games-role-chip${active ? ' is-active' : ''}${cached && !cached.hasItems ? ' is-empty' : ''}`,
      role: 'tab',
      'aria-selected': active ? 'true' : 'false',
      title: role.hint,
    });
    button.append(el('span', { text: role.label }));
    if (cached) {
      button.append(el('span', {
        class: 'games-role-count',
        text: cached.hasItems ? fmtInt(cached.items.length) : '0',
      }));
    }
    button.addEventListener('click', () => {
      if (state.role === role.key) return;
      ensurePersonnel(role.key);
    });
    host.append(button);
  }
}

function renderPersonnelToolbar() {
  const badge = $('games-personnel-coverage');
  const note = $('games-personnel-note');
  const data = state.personnel.data;
  const percent = data && data.coverage && data.coverage.percent != null
    ? data.coverage.percent
    : state.data && state.data.summary.metadata
    ? state.data.summary.metadata.creditsPercent
    : null;
  const view = coverageBadge(percent);
  if (badge) {
    if (view && view.visible) {
      badge.hidden = false;
      badge.textContent = view.text;
      badge.title = view.title;
    } else {
      badge.hidden = true;
    }
  }
  if (note) {
    const role = PERSONNEL_ROLES.find((entry) => entry.key === state.role);
    const parts = [];
    if (role) parts.push(role.hint);
    if (data && data.coverage && data.coverage.gamesWithCredits != null && data.coverage.gamesTotal) {
      parts.push(`кредиты у ${fmtInt(data.coverage.gamesWithCredits)} из ${fmtInt(data.coverage.gamesTotal)} игр`);
    }
    note.textContent = parts.join(' · ');
  }
  for (const button of document.querySelectorAll('[data-games-weight]')) {
    const active = button.dataset.gamesWeight === state.weight;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function personnelRowsFromStats() {
  // Tolerant fallback: an M2 server already sends `studios` in the stats
  // payload but may not mount `/api/games/personnel` yet.
  if (state.role !== 'developer' || !state.data) return null;
  const view = studiosView(state.data.studios, { weight: state.weight, limit: 0 });
  if (!view) return null;
  return { rows: view.rows, note: 'разработчики из Steam Store (stats)', source: 'stats' };
}

function renderPersonnel() {
  renderRoleChips();
  renderPersonnelToolbar();
  const host = $('games-personnel-body');
  const loading = $('games-personnel-loading');
  const errorHost = $('games-personnel-error');
  if (!host) return;
  clear(host);
  if (errorHost) {
    clear(errorHost);
    errorHost.hidden = true;
    if (state.personnel.error) {
      errorHost.append(errorBox({
        title: state.personnel.error.code === 'personnel_unavailable' ? 'Кредиты ещё не собраны' : 'Не удалось получить персоналии',
        message: state.personnel.error.message,
        actions: [{ label: 'Повторить', primary: true, onClick: () => ensurePersonnel(state.role, { force: true }) }],
      }));
      errorHost.hidden = false;
    }
  }
  if (loading) loading.hidden = !state.personnel.loading;
  if (state.personnel.loading && !state.personnel.data) return;

  const payload = state.personnel.data;
  let rows = payload ? personnelRows(payload, { weight: state.weight }) : [];
  let sourceNote = '';
  if (!rows.length) {
    const fallback = personnelRowsFromStats();
    if (fallback) {
      rows = fallback.rows;
      sourceNote = fallback.note;
    }
  }
  if (rows.length && errorHost) {
    // The route may be missing while `stats.studios` still answers: showing an
    // error next to real rows would be contradictory.
    clear(errorHost);
    errorHost.hidden = true;
  }
  if (!rows.length) {
    host.append(el('div', {
      class: 'games-personnel-empty',
      text: payload ? payload.emptyText : 'Кредиты не собраны: раздел появится после обогащения библиотеки.',
    }));
    return;
  }
  if (sourceNote) {
    host.append(el('p', { class: 'games-personnel-note', text: sourceNote }));
  }
  for (const row of rows) {
    const node = el('div', {
      class: 'games-personnel-row',
      role: 'button',
      tabIndex: 0,
      title: row.hint,
      'aria-label': `${row.rank}. ${row.name}: ${row.countText} игр. Открыть игры`,
    });
    node.append(el('span', { class: 'rank-num', text: String(row.rank) }));
    const name = el('div', { class: 'games-personnel-name' });
    name.append(el('span', { text: row.name }));
    const sub = [row.rolesText, row.aliasesText ? `также: ${row.aliasesText}` : '']
      .filter(Boolean).join(' · ');
    if (sub) name.append(el('span', { class: 'games-personnel-alias', text: sub }));
    node.append(name);
    const track = el('div', { class: 'games-personnel-track' });
    const fill = el('div', { class: 'games-personnel-fill' });
    track.append(fill);
    node.append(track);
    const value = el('div', { class: 'games-personnel-value' });
    value.append(el('span', {
      text: state.weight === 'count' ? `${row.countText} ${plural(row.count, GAME_PLURAL)}` : (row.hoursText || '—'),
    }));
    if (state.weight === 'count') {
      if (row.hoursText) value.append(el('small', { text: row.hoursText }));
    } else {
      value.append(el('small', { text: `${row.countText} ${plural(row.count, GAME_PLURAL)}` }));
    }
    node.append(value);
    host.append(node);
    requestAnimationFrame(() => {
      fill.style.width = `${row.widthPercent}%`;
    });
    const activate = () => {
      hideTooltip();
      openPersonModal({
      person: row,
      role: state.role,
      weight: state.weight,
      coverage: state.personnel.data && state.personnel.data.coverage,
    });
    };
    node.addEventListener('click', activate);
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate();
    });
    node.addEventListener('pointerenter', (event) => {
      showTooltip(row.title, `${row.gamesHint || row.hint} · нажмите, чтобы открыть игры`);
      moveTooltip(event);
    });
    node.addEventListener('pointermove', moveTooltip);
    node.addEventListener('pointerleave', hideTooltip);
  }
}

async function openPersonnel({ push = true } = {}) {
  if (!state.profileKey) return;
  if (state.view !== 'personnel') {
    showScreen('personnel');
    state.personnel.openId = '';
  }
  if (push) writeViewParam('personnel');
  renderPersonnel();
  if (!state.loaded) await loadStats({ force: false });
  await ensurePersonnel(state.role);
}

function closePersonnel({ push = true } = {}) {
  if (state.view !== 'personnel') return;
  state.personnel.openId = '';
  showScreen('dashboard');
  if (push) writeViewParam('');
  if (state.data) renderDashboard(state.data);
}

/* =========================================================
   wiring
   ========================================================= */

export function initGames({ onActivate } = {}) {
  state.onActivate = typeof onActivate === 'function' ? onActivate : null;
  state.profileKey = text(safeStorageGet(PROFILE_KEY));
  state.filters = readStoredFilters();
  const storedGenreWeight = text(safeStorageGet(GENRE_WEIGHT_KEY));
  state.genreWeight = storedGenreWeight === 'count' ? 'count' : 'hours';
  const storedWeight = text(safeStorageGet(WEIGHT_KEY));
  state.weight = storedWeight === 'count' ? 'count' : 'hours';
  const storedRole = text(safeStorageGet(ROLE_KEY));
  state.role = normalizePersonnelRole(storedRole) || PERSONNEL_ROLES[0].key;
  syncFilterInputs();

  const form = $('games-import-form');
  if (form) {
    form.addEventListener('submit', (event) => submitImport(event));
  }
  const account = $('games-import-account');
  if (account) {
    account.addEventListener('input', () => setImportError(''));
  }
  const back = $('games-progress-back');
  if (back) {
    back.addEventListener('click', () => {
      // The job keeps running on the server; dropping the local job means the
      // user starts a fresh import on purpose.
      stopPolling();
      state.job = null;
      saveJob();
      showScreen('import');
      renderProfiles();
    });
  }
  const reimport = $('games-reimport');
  if (reimport) {
    reimport.addEventListener('click', () => {
      stopPolling();
      showScreen('import');
      renderProfiles();
    });
  }
  const refresh = $('games-refresh');
  if (refresh) {
    refresh.addEventListener('click', () => refreshProfile());
  }

  /* M2: filters — requested-vs-applied is printed, never silently dropped. */
  const free = $('games-filter-free');
  if (free) {
    free.addEventListener('change', () => applyFilters({
      includeFree: !free.checked,
      includeDlc: Boolean($('games-filter-dlc') && $('games-filter-dlc').checked),
    }));
  }
  const dlc = $('games-filter-dlc');
  if (dlc) {
    dlc.addEventListener('change', () => applyFilters({
      includeFree: !($('games-filter-free') && $('games-filter-free').checked),
      includeDlc: dlc.checked,
    }));
  }

  /* M2: genre chart weight (local re-sort, no request). */
  for (const button of document.querySelectorAll('[data-games-genre-weight]')) {
    button.addEventListener('click', () => {
      const next = button.dataset.gamesGenreWeight === 'count' ? 'count' : 'hours';
      if (state.genreWeight === next) return;
      state.genreWeight = next;
      safeStorageSet(GENRE_WEIGHT_KEY, next);
      if (state.data) renderGenreChart(state.data);
    });
  }

  /* M3: personnel weights + navigation. */
  for (const button of document.querySelectorAll('[data-games-weight]')) {
    button.addEventListener('click', () => {
      const next = button.dataset.gamesWeight === 'count' ? 'count' : 'hours';
      if (state.weight === next) return;
      state.weight = next;
      safeStorageSet(WEIGHT_KEY, next);
      if (state.view === 'personnel') renderPersonnel();
      if (state.data && state.view !== 'personnel') renderDashboard(state.data);
      renderPersonsWidget(state.data);
    });
  }
  const closePersonnelButton = $('games-personnel-back');
  if (closePersonnelButton) {
    closePersonnelButton.addEventListener('click', () => closePersonnel({ push: true }));
  }

  /* M3 inline widget: role select (developers first), search and «все персоналии». */
  const roleSelect = $('games-persons-role');
  if (roleSelect) {
    roleSelect.value = state.role;
    roleSelect.addEventListener('change', () => {
      const next = normalizePersonnelRole(roleSelect.value) || PERSONNEL_ROLES[0].key;
      if (state.role === next) return;
      ensurePersonnel(next);
    });
  }
  const personsSearch = $('games-persons-search');
  if (personsSearch) {
    personsSearch.addEventListener('input', () => {
      state.personnel.query = personsSearch.value.trim().toLowerCase();
      state.personnel.visible = state.personnel.query
        ? Math.max(PERSONS_BATCH, state.personnel.visible)
        : (state.personnel.expanded ? Math.max(PERSONS_BATCH, state.personnel.visible) : PERSONS_INITIAL);
      renderPersonsWidget(state.data);
    });
  }
  const allPersons = $('games-persons-all');
  if (allPersons) {
    allPersons.addEventListener('click', () => openPersonnel({ push: true }));
  }
}

function readStoredFilters() {
  try {
    const raw = JSON.parse(safeStorageGet(FILTERS_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      return {
        includeFree: raw.includeFree !== false,
        includeDlc: raw.includeDlc === true,
      };
    }
  } catch {
    /* corrupted storage — fall back to the server defaults */
  }
  return { includeFree: true, includeDlc: false };
}

function syncFilterInputs() {
  const free = $('games-filter-free');
  const dlc = $('games-filter-dlc');
  if (free) free.checked = state.filters.includeFree === false;
  if (dlc) dlc.checked = state.filters.includeDlc === true;
}

async function refreshProfile() {
  if (!state.profileKey || state.job) return;
  const refresh = $('games-refresh');
  if (refresh) refresh.disabled = true;
  try {
    const response = await startGamesRefresh({ profile: state.profileKey });
    const jobId = gamesJobId(response);
    const profile = text(response && typeof response === 'object'
      ? (typeof response.profile === 'string' ? response.profile : (response.profile && response.profile.key))
      : '') || state.profileKey;
    if (jobId || (response && response.job)) {
      state.job = { id: jobId, profile, status: response, failed: null, startedAt: Date.now() };
      saveJob();
      showScreen('progress');
      renderProgress();
      startPolling();
      return;
    }
    state.loaded = false;
    await loadStats({ force: true });
    toast('Данные профиля обновлены', 'success');
  } catch (error) {
    if (error && error.status === 401) return;
    const info = importErrorText(error);
    toast(`${info.title}: ${info.message}`, 'error', { duration: 7000 });
  } finally {
    if (refresh) refresh.disabled = false;
  }
}

/** Called by main.js when the games tab becomes active. */
export async function showGames() {
  state.active = true;
  if (state.onActivate) state.onActivate();
  hydrateJob();
  if (state.job) {
    showScreen('progress');
    renderProgress();
    startPolling();
    return;
  }
  if (state.loading) return;
  await ensureProfiles();
  if (!state.profileKey) {
    showScreen('import');
    renderProfiles();
    return;
  }
  // `?tab=games&view=personnel` is addressable: a reload or a shared link
  // restores the sub-screen instead of silently dropping it.
  if (readViewParam() === 'personnel') {
    await openPersonnel({ push: false });
    return;
  }
  if (state.view === 'personnel') {
    showScreen('dashboard');
  }
  if (state.view === 'dashboard' && state.data) {
    renderProfiles();
    if (!state.personnel.data && !state.personnel.loading) ensurePersonnel(state.role);
    // A silent background refresh keeps a long-lived tab honest (the library
    // may have changed on another device). The dashboard is rebuilt wholesale,
    // so the window scroll is restored explicitly — the books pattern.
    if (Date.now() - (state.loadedAt || 0) > 60_000) {
      await loadStats({ force: true, silent: true });
    }
    return;
  }
  await loadStats({ force: true });
}

function hydrateJob() {
  if (state.job) return;
  const stored = readJob();
  if (!stored) return;
  state.job = stored;
  if (stored.profile) state.profileKey = stored.profile;
}

/** Called by main.js when another tab takes over. */
export function hideGames() {
  state.active = false;
  stopPolling();
  stopEnrichPoll();
  hideTooltip();
}

/** Drop every in-memory games artefact (logout / different session). */
export function resetGames() {
  stopPolling();
  stopEnrichPoll();
  state.data = null;
  state.loaded = false;
  state.loading = false;
  state.error = null;
  state.job = null;
  state.profiles = [];
  state.profilesLoaded = false;
  state.profileKey = '';
  state.view = 'import';
  state.seq += 1;
  state.selectedDecade = null;
  state.personnel = {
    role: '', data: null, loading: false, error: null, cache: {}, openId: '',
    query: '', expanded: false, visible: PERSONS_INITIAL, rows: [],
  };
  state.enrichTicks = 0;
  saveJob();
  showScreen('import');
  renderProfiles();
  setKeyIndicator(null);
  // A new session must not open on a stale personnel URL.
  if (readViewParam()) writeViewParam('', { push: false });
}
