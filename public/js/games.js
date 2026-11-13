import {
  getGamesStats, getGamesProfiles, startGamesImportSteam, getGamesImportStatus, startGamesRefresh,
  getGamesPersonnel, getGamesFranchises,
  getGamesGogAuthUrl, connectGamesGog, getGamesGogStatus, startGamesGogImport,
  getGamesGogImportStatus, logoutGamesGog,
} from './api.js';
import {
  $, el, clear, fmtInt, fmtPercent, plural, icon, toast, errorBox, showTooltip, moveTooltip, hideTooltip,
  shortErrorMessage, debounce,
} from './ui.js';
import { text, safeStorageGet, safeStorageSet, safeStorageRemove, setLoadingVisible } from './core/dom.js';
import { createPoller } from './core/poll.js';
import {
  renderProfileBar, renderJobRows, renderSourceCards, mountConnectionsScreen,
} from './core/shell.js';
import { GAMES_SHELL } from './shell-descriptors.js';
import { withPreservedScroll } from './books-refresh.js';
import { renderYearBars, renderDonut } from './charts.js';
import {
  normalizeGamesPayload, normalizeProfilesList, accountFromInput, profileCardView, summaryMetrics,
  paretoView, topHoursRows, recentStripView, lastPlayedInfo,
  importErrorText, jobStageText, jobProgress, gamesJobId, hoursText, HOURS_HINT,
  decadesView, yearsView, genreChartView, metadataProgressView, filtersView,
  calendarView, achievementStreaksView, normalizePersonnel, personnelRows,
  studiosView, coverageBadge, PERSONNEL_ROLES, formatDateRu, normalizePersonnelRole,
  personnelRoleOptions, personnelRoleCountText, GENRE_CHART_LIMIT,
  gamesInDecade, gamesWithoutYear, gamesWithoutType, gamesByGenre,
  gamesWithRecentHours, allGames, sortGameRows,
  yearsInDecade, gamesInYearGenre, yearCountView, yearCountGenreOptions,
  tagsChartView, TAG_CHART_LIMIT, gamesByTag, scoresView, gamesByReviewBucket,
  franchisesView, gamesInFranchise, normalizeFranchisesResponse,
  gogSourcesView, gogStatusText,
} from './games-view.js';
import {
  configureGamesModals, openGameCardModal, openGameListModal, openPersonModal, personAvatarEl,
  openFranchiseModal, gameCoverVerticalEl, openSecondaryWorkCardModal,
} from './games-modal.js';
const CONNECTIONS_OPEN_EVENT = 'games:connections-open';

function requestEpicRefresh() {
  if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') return;
  document.dispatchEvent(new CustomEvent(CONNECTIONS_OPEN_EVENT));
}
import { renderAchievementCalendar, renderAchievementStreaks } from './games-charts.js';

const PROFILE_KEY = 'kinoboxd.games.profile.v1';
const JOB_KEY = 'kinoboxd.games.job.v1';
const FILTERS_KEY = 'kinoboxd.games.filters.v1';
const WEIGHT_KEY = 'kinoboxd.games.weight.v1';
const ROLE_KEY = 'kinoboxd.games.role.v1';
const GENRE_WEIGHT_KEY = 'kinoboxd.games.cloudweight.v1';
const TAG_WEIGHT_KEY = 'kinoboxd.games.tagweight.v1';
const POLL_INTERVAL = 1400;
const ENRICH_POLL_INTERVAL = 3500;
const ENRICH_POLL_LIMIT = 120;
const PROFILES_RELOAD_MS = 30_000;
const GAME_PLURAL = ['игра', 'игры', 'игр'];
const SECONDARY_WORK_PLURAL = ['работа', 'работы', 'работ'];
const DECADE_COLORS = ['#00e054', '#40bcf4', '#ff8000', '#e8253f', '#b18cff', '#ffd166'];
const YEAR_COLORS = [
  '#00e054', '#40bcf4', '#ff8000', '#e8253f', '#b18cff', '#ffd166',
  '#00c9a7', '#f472b6', '#8ddb3f', '#7189ff', '#ff9e64', '#5eead4',
];
const TOP_LIMIT = 10;
const PERSONS_INITIAL = 15;
const PERSONS_BATCH = 50;

const state = {
  active: false,
  view: 'import',
  loading: false,
  loaded: false,
  loadedAt: 0,
  data: null,
  error: null,
  seq: 0,
  profiles: [],
  profilesLoaded: false,
  profilesLoadedAt: 0,
  profileKey: '',
  job: null,
  importBusy: false,
  onActivate: null,
  filters: { includeFree: true, includeDlc: false, minHours: 0 },
  genreWeight: 'hours',
  genresExpanded: false,
  tagWeight: 'hours',
  tagsExpanded: false,
  franchises: { data: null, loading: false, error: null, profile: '' },
  weight: 'hours',
  role: 'developer',
  selectedDecade: null,
  yearCountGenre: null,
  personnel: {
    role: '', data: null, loading: false, error: null, cache: {}, openId: '',
    query: '', expanded: false, visible: PERSONS_INITIAL, rows: [],
  },
  enrichTimer: 0,
  enrichSeq: 0,
  enrichTicks: 0,
  gog: { status: null, loading: false, error: null, job: null, timer: 0, connected: false },
};

let inflightLoad = null;

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

function showScreen(name) {
  const previous = state.view;
  state.view = name;
  const screens = {
    import: $('games-import'),
    progress: $('games-progress'),
    dashboard: $('games-dash'),
    personnel: $('games-personnel'),
    connections: $('games-connections-screen'),
  };
  for (const [key, node] of Object.entries(screens)) {
    if (node) node.hidden = key !== name;
  }
  const bar = $('games-profile-bar');
  if (bar) bar.hidden = name === 'progress';
  updateActions();
  const back = $('games-progress-back');
  if (back) back.hidden = false;
  if (name === 'connections' && previous !== name) {
    ensureGogStatus();
    requestEpicRefresh();
  }
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
  const connections = $('games-connections-btn');
  if (connections) connections.hidden = state.view === 'progress' || !state.profileKey;
}

function showLoading(visible) {
  setLoadingVisible('games-loading', visible);
}

function markDashboardLoading(visible) {
  const dash = $('games-dash');
  if (dash && visible) dash.hidden = true;
  if (visible) showLoading(true);
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

function renderProfiles() {
  const host = $('games-profile-list');
  const bar = $('games-profile-bar');
  if (!host) return;
  if (!state.profiles.length) {
    renderProfileBar({ list: host, items: [], variant: 'flat' });
    if (bar) bar.hidden = state.view === 'progress';
    const note = $('games-profile-empty');
    if (note) note.hidden = Boolean(state.profileKey);
    return;
  }
  const empty = $('games-profile-empty');
  if (empty) empty.hidden = true;
  if (bar) bar.hidden = state.view === 'progress';

  const items = state.profiles.map((profile) => {
    const active = profile.key === state.profileKey;
    const chipName = text(profile.label) || text(profile.personaName) || profile.key;
    return {
      id: profile.key,
      label: chipName,
      active,
      count: profile.gameCount != null ? fmtInt(profile.gameCount) : null,
      title: `${chipName}${profile.personaName && profile.personaName !== chipName ? ` · ${profile.personaName}` : ''}${profile.gameCount != null ? ` · ${fmtInt(profile.gameCount)} ${plural(profile.gameCount, GAME_PLURAL)}` : ''}`,
      deletable: false,
    };
  });
  renderProfileBar({
    list: host,
    items,
    variant: 'flat',
    itemClass: 'games-profile-chip',
    onSelect: (key) => { switchProfile(key); },
  });
}

async function switchProfile(key) {
  const next = text(key);
  if (!next || next === state.profileKey) return;
  state.profileKey = next;
  safeStorageSet(PROFILE_KEY, next);
  state.loaded = false;
  state.data = null;
  state.seq += 1;
  state.personnel = {
    role: state.role, data: null, loading: false, error: null, cache: {}, openId: '',
    query: '', expanded: false, visible: PERSONS_INITIAL, rows: [],
  };
  state.filters = readStoredFilters(next);
  state.selectedDecade = null;
  state.franchises = { data: null, loading: false, error: null, profile: '' };
  state.yearCountGenre = null;
  state.genresExpanded = false;
  syncFilterInputs();
  markDashboardLoading(true);
  renderProfiles();
  await loadStats({ force: true });
  if (state.view === 'personnel') await ensurePersonnel(state.role, { force: true });
}

async function ensureProfiles({ reload = false, maxAgeMs = 0 } = {}) {
  if (state.profilesLoaded) {
    const age = Date.now() - (state.profilesLoadedAt || 0);
    const throttled = reload && maxAgeMs > 0 && age <= maxAgeMs;
    if (!reload || throttled) return state.profiles;
  }
  try {
    const raw = await getGamesProfiles();
    state.profiles = normalizeProfilesList(raw);
    state.profilesLoaded = true;
    state.profilesLoadedAt = Date.now();
    const flag = raw && typeof raw === 'object'
      ? (raw.steamKeyConfigured
        ?? (raw.steamKey && typeof raw.steamKey === 'object' ? raw.steamKey.configured : raw.steamKey)
        ?? null)
      : null;
    if (typeof flag === 'boolean') setKeyIndicator(flag);
  } catch {
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

async function loadStats({ force = false, silent = false } = {}) {
  if (state.loading) {
    if (!force) return;
    if (inflightLoad) {
      try {
        await inflightLoad;
      } catch {
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
  if (!silent && !state.data) markDashboardLoading(true);
  else if (!silent && state.view !== 'dashboard' && state.view !== 'personnel') showLoading(true);
  updateActions();
  try {
    const query = { profile: state.profileKey };
    if (state.filters.includeFree === false) query.includeFree = false;
    if (state.filters.includeDlc === true) query.includeDlc = true;
    if (state.filters.minHours !== 0) query.minHours = state.filters.minHours;
    const raw = await getGamesStats(query);
    if (seq !== state.seq) return;
    const data = normalizeGamesPayload(raw);
    state.data = data;
    state.loaded = true;
    state.loadedAt = Date.now();
    if (data.summary.steamKeyConfigured != null) setKeyIndicator(data.summary.steamKeyConfigured);
    if (!data.has.games && !data.has.profile) {
      state.loaded = false;
      showScreen('import');
      renderProfiles();
      return;
    }
    showScreen(
      state.view === 'personnel' || state.view === 'connections' ? state.view : 'dashboard'
    );
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
    if (error && error.status === 401) return;
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
        if (error.status === 400) showError(error, importErrorText(error));
      }
      return;
    }
    if (state.data) {
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
      if (response && (response.done === true || text(response.status) === 'done')) {
        await finishImport(null);
        return;
      }
      throw new Error('Сервер не вернул идентификатор задачи импорта.');
    }
    state.job = {
      id: jobId,
      profile: profile || '',
      status: response && typeof response === 'object' ? response : null,
      failed: null,
      startedAt: Date.now(),
    };
    if (profile) {
      state.profileKey = profile;
      safeStorageSet(PROFILE_KEY, profile);
      renderProfiles();
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

const poller = createPoller({
  intervalMs: POLL_INTERVAL,
  shouldContinue: () => Boolean(state.job) && state.active,
  tick: pollOnce,
});

function stopPolling() {
  poller.stop();
}

function startPolling() {
  poller.stop();
  poller.start(320);
}

async function pollOnce() {
  if (!state.job) return;
  const job = state.job;
  try {
    const status = await getGamesImportStatus(job.id, { profile: job.profile });
    job.status = status && typeof status === 'object' ? status : job.status;
    const resolved = text(status && status.profile);
    if (resolved && resolved !== job.profile) {
      job.profile = resolved;
      saveJob();
    }
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
      const done = await tryStatsAfterJob(job.status);
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

function jobProfileKey(status) {
  return text(status && status.profile) || text(state.job && state.job.profile) || state.profileKey;
}

async function tryStatsAfterJob(status) {
  const key = jobProfileKey(status);
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
    await ensureProfiles({ reload: true });
    state.profileKey = key;
    safeStorageSet(PROFILE_KEY, key);
    renderProfiles();
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
  const key = jobProfileKey(status);
  stopPolling();
  state.job = null;
  saveJob();
  if (key) {
    state.profileKey = key;
    safeStorageSet(PROFILE_KEY, key);
  }
  await ensureProfiles({ reload: true });
  if (key) {
    state.profileKey = key;
    safeStorageSet(PROFILE_KEY, key);
  }
  renderProfiles();
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
  const line = $('games-progress-status');
  if (line) {
    line.textContent = job && job.failed ? 'Импорт остановился' : jobStageText(status);
  }
  renderJobRows({
    host: $('games-progress-jobs'),
    jobs: job ? [{
      source: 'steam',
      mark: 'ST',
      title: 'Steam',
      account: job.account ? `@${job.account}` : '',
      stage: jobStageText(status),
      percent,
      failed: Boolean(job.failed),
      done: Boolean(status && (status.done || status.stage === 'done')),
    }] : [],
  });
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

function setGogError(message) {
  const host = $('games-gog-error');
  if (!host) return;
  host.textContent = message ? String(message) : '';
  host.hidden = !message;
}

function setGogBusy(busy) {
  const login = $('games-gog-login');
  const connect = $('games-gog-connect');
  const spinner = $('games-gog-login-spinner');
  const label = $('games-gog-login-label');
  if (login) {
    login.disabled = busy;
    login.classList.toggle('is-busy', busy);
  }
  if (connect) connect.disabled = busy;
  if (spinner) spinner.hidden = !busy;
  if (label) label.textContent = busy ? 'Подключаем…' : 'Войти через GOG';
}

function gogAccount() {
  const accounts = state.gog.status && Array.isArray(state.gog.status.accounts)
    ? state.gog.status.accounts
    : [];
  return accounts[0] || null;
}

function renderGogCard() {
  const node = $('games-gog-status');
  const account = gogAccount();
  const login = $('games-gog-login');
  const connect = $('games-gog-connect');
  const importBtn = $('games-gog-import');
  const logout = $('games-gog-logout');
  state.gog.connected = Boolean(account);
  if (node) {
    if (account) {
      const status = account.expired === true ? 'auth_expired' : account.stale ? 'stale' : 'ok';
      const who = account.username ? ` как ${account.username}` : '';
      node.textContent = `GOG: подключён${who} · ${gogStatusText(status, account.libraryFetchedAt)}`;
    } else {
      node.textContent = 'GOG: не подключён';
    }
  }
  if (login) login.hidden = Boolean(account);
  if (connect) connect.hidden = Boolean(account);
  if (importBtn) importBtn.hidden = !account;
  if (logout) logout.hidden = !account;
}

async function ensureGogStatus() {
  if (state.gog.loading) return;
  state.gog.loading = true;
  try {
    const status = await getGamesGogStatus();
    state.gog.status = status;
    state.gog.error = null;
    renderGogCard();
  } catch (error) {
    if (error && error.status === 401) return;
    state.gog.error = error;
    setGogError(importErrorText(error).message);
  } finally {
    state.gog.loading = false;
  }
}

function renderSources(data) {
  const widget = $('games-sources-widget');
  const host = $('games-sources-body');
  if (!widget || !host) return;
  const view = gogSourcesView(data);
  clear(host);
  const note = $('games-sources-note');
  if (note) {
    note.textContent = view.secondaryOnly > 0 && view.unionText
      ? view.unionText
      : view.worksTotal != null
        ? `${fmtInt(view.worksTotal)} ${plural(view.worksTotal, GAME_PLURAL)} в объединённой библиотеке`
        : '';
  }
  for (const row of view.rows) {
    const node = el('div', {
      class: `games-source-row is-${row.key}${row.journal ? ' is-journal' : ''}`,
    });
    node.append(el('span', { class: 'games-source-name', text: row.label }));
    const meta = el('span', { class: 'games-source-meta' });
    const parts = [];
    if (row.games != null) parts.push(`${fmtInt(row.games)} ${plural(row.games, GAME_PLURAL)}`);
    if (row.hours != null) parts.push(hoursText(row.hours, 1));
    if (parts.length) {
      meta.append(el('span', { class: 'games-source-numbers', text: parts.join(' · ') }));
    }
    if (row.statusText) {
      meta.append(el('span', { class: 'games-source-state', text: row.statusText }));
    }
    node.append(meta);
    const action = el('span', { class: 'games-source-action' });
    if ((row.key === 'gog' || row.key === 'epic') && row.canConnect) {
      const link = el('button', {
        type: 'button',
        class: 'btn btn-link games-source-connect',
        text: 'Подключить',
      });
      link.addEventListener('click', () => {
        showScreen('connections');
      });
      action.append(link);
    }
    node.append(action);
    host.append(node);
  }
  const secondary = $('games-sources-secondary');
  if (secondary) {
    clear(secondary);
    if (view.secondaryOnly > 0) {
      if (view.worksTotal == null) {
        secondary.append(el('div', {
          text: `Вне Steam: ${fmtInt(view.secondaryOnly)} ${plural(view.secondaryOnly, SECONDARY_WORK_PLURAL)} `
            + '— в часы и достижения Steam они не входят.',
        }));
      }
      if (view.secondaryHours.length) {
        secondary.append(el('div', {
          class: 'games-sources-secondary-hours',
          text: `Часы вне Steam: ${view.secondaryHours
            .map((row) => `${row.label} ${hoursText(row.hours, 1)}`)
            .join(' · ')} — отдельно от журнала Steam.`,
        }));
      }
      if (view.secondaryChart && view.secondaryChart.included) {
        secondary.append(el('div', {
          class: 'games-sources-secondary-charts',
          text: `Графики жанров, годов и десятилетий включают работы вне Steam`
            + `${view.secondaryChart.count != null ? `: ${fmtInt(view.secondaryChart.count)}` : ''}.`,
        }));
      } else {
        secondary.append(el('div', {
          class: 'games-sources-secondary-charts',
          text: 'Графики жанров, годов и десятилетий считаются по Steam — работы вне Steam в них не входят.',
        }));
      }
      secondary.hidden = false;
    } else {
      secondary.hidden = true;
    }
  }
  widget.hidden = false;
}

async function openGogLogin() {
  setGogError('');
  setGogBusy(true);
  const popup = typeof window !== 'undefined' ? window.open('about:blank', '_blank') : null;
  try {
    const info = await getGamesGogAuthUrl();
    const url = info && (info.url || info.authUrl);
    if (!url) throw new Error('сервер не вернул ссылку GOG');
    if (popup) {
      try {
        popup.opener = null;
      } catch (err) {
      }
      popup.location.href = url;
    } else {
      window.location.href = url;
    }
    setGogError('Войдите в GOG в новой вкладке. После входа скопируйте code из адресной строки — или адрес страницы целиком — и вставьте ниже.');
  } catch (error) {
    if (popup) popup.close();
    if (error && error.status === 401) return;
    setGogError(importErrorText(error).message);
  } finally {
    setGogBusy(false);
  }
}

async function connectGogAccount() {
  const input = $('games-gog-code');
  const code = input ? text(input.value) : '';
  if (!code) {
    setGogError('Вставьте code из адресной строки GOG или всю ссылку on_login_success?…&code=…');
    return;
  }
  setGogError('');
  setGogBusy(true);
  try {
    await connectGamesGog({ code, profile: state.profileKey });
    if (input) input.value = '';
    toast('GOG подключён', 'success');
    await ensureGogStatus();
    await startGogImport({ force: true });
  } catch (error) {
    if (error && error.status === 401) return;
    setGogError(importErrorText(error).message);
  } finally {
    setGogBusy(false);
  }
}

async function startGogImport({ force = false } = {}) {
  const account = gogAccount();
  if (!account) return;
  try {
    const response = await startGamesGogImport({
      account: account.key,
      profile: state.profileKey,
      force,
    });
    const jobId = gamesJobId(response);
    if (!jobId) {
      await ensureGogStatus();
      state.loaded = false;
      await loadStats({ force: true });
      return;
    }
    state.gog.job = { id: jobId, status: response };
    toast('Импорт библиотеки GOG запущен', 'info');
    pollGogJob();
  } catch (error) {
    if (error && error.status === 401) return;
    setGogError(importErrorText(error).message);
  }
}

async function pollGogJob() {
  if (state.gog.timer) clearTimeout(state.gog.timer);
  state.gog.timer = 0;
  const job = state.gog.job;
  if (!job || !job.id) return;
  try {
    const status = await getGamesGogImportStatus(job.id);
    state.gog.job = { ...job, status };
    if (status && status.done) {
      state.gog.job = null;
      if (status.status === 'failed') {
        setGogError(status.error || 'Импорт GOG не завершился');
      } else {
        toast(
          `GOG: ${fmtInt(status.libraryCount || 0)} ${plural(status.libraryCount || 0, GAME_PLURAL)} импортировано`,
          'success'
        );
      }
      await ensureGogStatus();
      state.loaded = false;
      await loadStats({ force: true });
      showScreen('dashboard');
      return;
    }
    state.gog.timer = setTimeout(pollGogJob, 1500);
  } catch (error) {
    if (error && error.status === 401) return;
    state.gog.timer = setTimeout(pollGogJob, 3000);
  }
}

async function logoutGogAccount() {
  const account = gogAccount();
  if (!account) return;
  try {
    await logoutGamesGog({ account: account.key, profile: state.profileKey });
    toast('GOG отключён: токен удалён, снимок библиотеки сохранён с датой', 'info');
    await ensureGogStatus();
    if (state.profileKey) {
      state.loaded = false;
      await loadStats({ force: true });
    }
  } catch (error) {
    if (error && error.status === 401) return;
    setGogError(importErrorText(error).message);
  }
}

function renderDashboard(data) {
  configureGamesModals({
    profile: (data.profile && data.profile.key) || state.profileKey,
    gamesIndex: data.gamesIndex,
    secondaryWorks: data.secondaryWorks,
  });
  renderHead(data);
  renderProfileCard(data);
  renderSources(data);
  renderSummary(data);
  renderPartialNote(data);
  renderFilters(data);
  renderRecentStrip(data);
  renderTopHours(data);
  renderPareto(data);
  renderDecades(data);
  renderYears(data);
  renderYearCount(data);
  renderTags(data);
  renderScores(data);
  renderGenreChart(data);
  renderFranchises(data);
  renderMetadataProgress(data);
  renderCalendar(data);
  renderPersonsWidget(data);
  if (!state.personnel.data && !state.personnel.loading) ensurePersonnel(state.role);
  scheduleEnrichPoll();
}

function secondaryChartSuffix(data) {
  const status = data && data.secondaryChart;
  return status && status.included ? status.text : '';
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
  if (!metrics.length) {
    host.hidden = true;
    host.classList.remove('has-unmatched');
    return;
  }
  host.hidden = false;
  host.classList.add('games-summary');
  host.classList.toggle('has-unmatched', metrics.some((entry) => entry.key === 'unmatched'));
  const clickable = new Set(['recent', 'unmatched']);
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

function openSecondaryWorkFor(data, row) {
  const key = row && (row.workKey || row.canonicalWorkKey);
  const works = Array.isArray(data && data.secondaryWorks) ? data.secondaryWorks : [];
  const match = key
    ? works.find((work) => work && (work.workKey === key || work.key === key))
    : works.find((work) => work && work.name === row.name);
  openSecondaryWorkCardModal(match || row);
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
      else if (row.workKey) openSecondaryWorkFor(data, row);
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

function renderRecentStrip(data) {
  const widget = $('games-recent-widget');
  const host = $('games-recent-strip');
  const note = $('games-recent-note');
  if (!widget || !host) return;
  clear(host);
  const view = recentStripView(data.recentlyPlayed, data.gamesIndex);
  if (!view.visible) {
    widget.hidden = true;
    return;
  }
  widget.hidden = false;
  if (note) note.textContent = view.note;
  for (const item of view.items) {
    const card = el('div', { class: 'games-recent-card' });
    const art = el('div', {
      class: 'games-recent-art',
      role: 'button',
      tabIndex: 0,
      title: `${item.name}${item.lastPlayedText ? ` · последний раз ${item.lastPlayedText}` : ''}`,
      'aria-label': `${item.name}: открыть карточку игры`,
    });
    art.append(gameCoverVerticalEl(
      {
        name: item.name,
        appid: item.appid,
        primaryAppid: item.primaryAppid,
        iconUrl: item.iconUrl,
        coverUrl: item.coverUrl,
        headerImage: item.headerImage,
        verticalCapsule: item.verticalCapsule,
        verticalCapsuleKnown: item.verticalCapsuleKnown,
        iconFallbackUrl: item.iconFallbackUrl,
      },
      { className: 'games-recent-icon' },
    ));
    const extraSources = (item.sources || []).filter((source) => source && source !== 'steam');
    if (extraSources.length) {
      art.append(el('span', {
        class: `games-recent-source is-${extraSources[0]}`,
        text: extraSources.map((source) => (source === 'gog' ? 'GOG' : source === 'epic' ? 'Epic' : source)).join(' · '),
        title: `также в: ${extraSources.join(', ')} — часы по источникам не суммируются`,
      }));
    }
    card.append(art);
    card.append(el('span', { class: 'games-recent-name', text: item.name, title: item.name }));
    card.append(el('span', {
      class: `games-recent-meta${item.fresh ? ' is-fresh' : ''}`,
      text: item.caption,
      title: item.hint,
    }));
    host.append(card);
    art.addEventListener('pointerenter', (event) => {
      showTooltip(item.name, `${item.hint} · нажмите, чтобы открыть карточку`);
      moveTooltip(event);
    });
    art.addEventListener('pointermove', moveTooltip);
    art.addEventListener('pointerleave', hideTooltip);
    const activate = () => {
      hideTooltip();
      if (item.appid != null) openGameCardModal(item.appid, { fallback: item });
    };
    art.addEventListener('click', activate);
    art.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate();
    });
  }
}

function renderFilters(data) {
  const section = $('games-filters');
  const note = $('games-filter-note');
  const free = $('games-filter-free');
  const dlc = $('games-filter-dlc');
  const hours = $('games-filter-hours');
  if (!section) return;
  const view = filtersView(data.filters, {
    includeFree: state.filters.includeFree,
    includeDlc: state.filters.includeDlc,
  });
  if (free && free.checked !== (view.state.includeFree === false)) {
    free.checked = view.state.includeFree === false;
  }
  if (dlc && dlc.checked !== (view.state.includeDlc === true)) {
    dlc.checked = view.state.includeDlc === true;
  }
  if (hours && String(hours.value) !== String(state.filters.minHours)) {
    hours.value = String(state.filters.minHours);
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

const MIN_HOURS_FLOOR = -1;

function normalizeMinHours(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const integer = Math.trunc(parsed);
  return integer < MIN_HOURS_FLOOR ? MIN_HOURS_FLOOR : integer;
}

function applyFilters(next) {
  state.filters = {
    includeFree: next.includeFree !== false,
    includeDlc: next.includeDlc === true,
    minHours: normalizeMinHours(next.minHours != null ? next.minHours : state.filters.minHours),
  };
  syncFilterInputs();
  safeStorageSet(filtersStorageKey(), JSON.stringify(state.filters));
  state.loaded = false;
  loadStats({ force: true });
}

function selectDecade(data, decade) {
  const same = state.selectedDecade && state.selectedDecade.start === decade.start;
  state.selectedDecade = same ? null : { start: decade.start, label: decade.label };
  renderDecades(data);
  renderYears(data);
}

function unknownYearsButton(count, data) {
  const btn = el('button', {
    type: 'button',
    class: 'note-link',
    text: `${fmtInt(count)} ${plural(count, GAME_PLURAL)} без года`,
  });
  btn.title = 'Показать игры без года релиза';
  btn.addEventListener('click', () => openUnknownDecadeModal(data));
  return btn;
}

function openUnknownDecadeModal(data) {
  const games = sortGameRows(gamesWithoutYear(data.gamesIndex), 'name');
  openGameListModal({
    kicker: 'Десятилетия',
    title: `Год неизвестен — ${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)}`,
    subtitle: 'У этих записей нет releaseYear',
    hint: 'Год релиза берётся из Steam Store / GOG / Epic / Wikidata. Если appdetails ещё не собраны, '
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
  const donutHost = $('games-decades-donut');
  const legendHost = $('games-decades-legend');
  const note = $('games-decades-note');
  if (!widget || !donutHost || !legendHost) return;

  const view = decadesView(data.decades);
  clear(donutHost);
  clear(legendHost);
  if (!view) {
    widget.hidden = true;
    if (note) note.textContent = '';
    return;
  }
  widget.hidden = false;

  const rows = view.rows.filter((row) => !row.unknown);
  const unknown = view.rows.find((row) => row.unknown) || null;
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const selected = state.selectedDecade;

  if (note) {
    const parts = [];
    if (rows.length) {
      parts.push(`${fmtInt(rows.length)} ${plural(rows.length, ['десятилетие', 'десятилетия', 'десятилетий'])}`);
    }
    if (selected) parts.push(`выбрано: ${selected.label}`);
    const chartSuffix = secondaryChartSuffix(data);
    if (chartSuffix) parts.push(chartSuffix);
    note.textContent = parts.join(' · ');
    if (unknown && unknown.count > 0) {
      if (note.textContent) note.append(document.createTextNode(' · '));
      note.append(unknownYearsButton(unknown.count, data));
    }
  }

  if (!total) {
    donutHost.append(decadeHint('Нет данных по десятилетиям'));
    return;
  }

  const segments = rows.map((row, index) => ({
    key: `decade-${row.decade}`,
    label: row.label,
    value: row.count,
    hours: row.hours,
    color: DECADE_COLORS[index % DECADE_COLORS.length],
    decadeStart: row.decade,
  }));

  renderDonut(donutHost, {
    segments,
    legendHost,
    selectedKey: selected ? `decade-${selected.start}` : null,
    centerValue: fmtInt(total),
    centerLabel: 'игр с годом',
    ariaLabel: 'Распределение игр по десятилетиям релиза. Выберите десятилетие, чтобы увидеть годы',
    primary: (seg) => `${seg.label} · ${fmtInt(seg.value)} ${plural(seg.value, GAME_PLURAL)}`,
    secondary: (seg) => [
      fmtPercent(seg.value, total),
      seg.hours != null ? `${hoursText(seg.hours)} по данным Steam` : '',
    ].filter(Boolean).join(' · '),
    onSelect: (seg) => {
      hideTooltip();
      const start = Number(seg.decadeStart);
      if (!Number.isFinite(start) || start <= 0) return;
      selectDecade(data, { start, label: seg.label });
    },
  });
}

function decadeHint(text = 'Нет данных по годам релиза') {
  const box = el('div', { class: 'years-empty' });
  box.append(el('span', { class: 'years-empty-ring', 'aria-hidden': 'true' }));
  box.append(el('p', { class: 'years-empty-text', text }));
  return box;
}

function openYearModal(data, year, { genre = null } = {}) {
  const filter = text(genre);
  const games = sortGameRows(gamesInYearGenre(data.gamesIndex, year, filter || null), 'hours');
  const countText = `${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)}`;
  const title = filter
    ? `${countText} ${year} года · фильтр: ${filter}`
    : `${countText} ${year} года`;
  const subtitle = filter
    ? `Год выхода ${year} · ${countText} · жанр ${filter}`
    : `Год релиза ${year} · ${countText} в выгрузке`;
  const hint = filter
    ? `Только игры жанра «${filter}» (Steam Store и вторые библиотеки). Год выхода — release_date, а не год, когда вы играли; `
      + 'одна игра может попадать в несколько жанров.'
    : 'Год релиза игры (release_date из Steam Store / GOG / Epic / Wikidata), а не год, когда вы в неё играли.';
  openGameListModal({
    kicker: 'Годы релиза',
    title,
    subtitle,
    hint,
    groupLabel: String(year),
    emptyText: filter
      ? 'Нет игр этого жанра за этот год'
      : 'Для этого года нет игр с известным годом',
    games,
    sortScope: 'year',
    defaultSort: 'hours',
  });
}

function renderYears(data) {
  const widget = $('games-years-widget');
  const donutHost = $('games-years-donut');
  const legendHost = $('games-years-legend');
  const note = $('games-years-note');
  const titleText = $('games-years-title-text');
  if (!widget || !donutHost || !legendHost) return;
  widget.hidden = false;
  clear(donutHost);
  clear(legendHost);

  const view = yearsView(data.years);
  const decade = state.selectedDecade;
  if (titleText) titleText.textContent = decade ? `Годы релиза · ${decade.label}` : 'Годы релиза';
  if (!view) {
    if (note) note.textContent = '';
    donutHost.append(decadeHint('Нет данных по годам релиза'));
    return;
  }

  const years = (decade ? yearsInDecade(data.years, decade.start) : view.years)
    .slice()
    .sort((a, b) => b.year - a.year);
  const total = years.reduce((sum, item) => sum + item.count, 0);
  const unknownCount = view.unknownCount || (data.unknownYear && data.unknownYear.count) || 0;
  if (note) {
    if (decade) {
      note.textContent = total
        ? `${decade.start}–${Number(decade.start) + 9} · ${fmtInt(years.length)} ${plural(years.length, ['год', 'года', 'лет'])} · ${fmtInt(total)} ${plural(total, GAME_PLURAL)}`
        : `${decade.label} · нет игр`;
    } else {
      note.textContent = unknownCount > 0
        ? `${view.note} · ${fmtInt(unknownCount)} без года`
        : view.note;
    }
    const chartSuffix = secondaryChartSuffix(data);
    if (chartSuffix) {
      note.textContent = note.textContent ? `${note.textContent} · ${chartSuffix}` : chartSuffix;
    }
  }
  if (!years.length) {
    donutHost.append(decadeHint(decade
      ? `В ${decade.label} нет игр с известным годом`
      : `Годы релиза неизвестны — ${fmtInt(unknownCount)} ${plural(unknownCount, GAME_PLURAL)}`));
    return;
  }

  const segments = years.map((item, index) => ({
    key: `year-${item.year}`,
    label: String(item.year),
    value: item.count,
    hours: item.hours,
    year: item.year,
    color: YEAR_COLORS[index % YEAR_COLORS.length],
  }));

  renderDonut(donutHost, {
    segments,
    legendHost,
    centerValue: fmtInt(total),
    centerLabel: decade ? 'игр десятилетия' : 'игр с годом',
    ariaLabel: decade
      ? `Игры по годам релиза: ${decade.start} — ${Number(decade.start) + 9}`
      : `Игры по годам релиза: ${view.minYear} — ${view.maxYear}`,
    primary: (seg) => `${seg.label} · ${fmtInt(seg.value)} ${plural(seg.value, GAME_PLURAL)}`,
    secondary: (seg) => [
      seg.hours != null ? hoursText(seg.hours) : '',
      `${fmtPercent(seg.value, total)} ${decade ? 'игр десятилетия' : 'игр с годом'}`,
    ].filter(Boolean).join(' · '),
    onSelect: (seg) => {
      hideTooltip();
      const year = Number(seg.year);
      if (!Number.isFinite(year) || year <= 0) return;
      openYearModal(data, year);
    },
  });
}

function renderYearCount(data) {
  const widget = $('games-yearcount-widget');
  const host = $('games-yearcount-chart');
  const note = $('games-yearcount-note');
  const hint = $('games-yearcount-hint');
  if (!widget || !host) return;

  if (host._gamesYearCountResize) {
    host._gamesYearCountResize.disconnect();
    host._gamesYearCountResize = null;
  }

  const options = yearCountGenreOptions(data.genres);
  if (state.yearCountGenre && !options.some((option) => option.name === state.yearCountGenre)) {
    state.yearCountGenre = null;
  }
  renderYearCountGenreFilter(options);

  const view = yearCountView(data.years, data.gamesIndex, {
    genre: state.yearCountGenre,
    unknownYear: data.unknownYear,
  });
  widget.hidden = false;
  clear(host);

  if (!view.hasData) {
    if (note) note.textContent = '';
    host.append(decadeHint('Нет данных по годам выхода'));
    return;
  }

  if (note) {
    note.textContent = [view.note, secondaryChartSuffix(data)].filter(Boolean).join(' · ');
  }
  if (hint) {
    hint.textContent = view.filtered
      ? `жанр ${view.genre}: клик по столбику — игры этого года и жанра`
      : 'наведи на столбик — счётчик и часы; клик — список игр года';
  }

  if (!view.series.length) {
    host.append(decadeHint(view.filtered
      ? `Нет игр жанра «${view.genre}» с известным годом выхода`
      : 'Годы выхода неизвестны'));
    return;
  }

  const paintOptions = {
    unitForms: GAME_PLURAL,
    shareLabel: view.filtered ? 'игр этого жанра' : 'игр с известным годом',
    emptyText: 'Нет данных по годам выхода',
    ariaLabel: view.filtered
      ? `Количество игр по году выхода: жанр ${view.genre}`
      : `Количество игр по году выхода: ${view.minYear} — ${view.maxYear}`,
    barLabels: true,
    yearNote: (year, item) => (item && item.hours != null
      ? `${hoursText(item.hours)} по данным Steam`
      : 'часы неизвестны'),
    onYearClick: (year) => openYearModal(data, year, { genre: view.genre }),
  };
  renderYearBars(host, view.series, paintOptions);

  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(debounce(() => {
      if (!host.clientWidth) return;
      renderYearBars(host, view.series, paintOptions);
    }, 160));
    observer.observe(host);
    host._gamesYearCountResize = observer;
  }
}

function renderYearCountGenreFilter(options) {
  const select = $('games-yearcount-genre');
  if (!select) return;
  const signature = options.map((option) => option.name).join('|');
  if (select.dataset && select.dataset.gamesYearCount === signature
    && select.children.length === options.length + 1) {
    if (select.value !== (state.yearCountGenre || '')) select.value = state.yearCountGenre || '';
    return;
  }
  clear(select);
  select.append(el('option', { value: '', text: 'Все' }));
  for (const option of options) {
    select.append(el('option', {
      value: option.name,
      text: `${option.name} (${fmtInt(option.count)})`,
    }));
  }
  if (select.dataset) select.dataset.gamesYearCount = signature;
  select.value = state.yearCountGenre || '';
  select.onchange = () => {
    state.yearCountGenre = select.value || null;
    if (state.data) renderYearCount(state.data);
  };
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
    totalHours: data.summary ? data.summary.totalHours : null,
  });
  if (!view) {
    widget.hidden = true;
    return;
  }
  widget.hidden = false;
  if (note) {
    note.textContent = [view.note, secondaryChartSuffix(data)].filter(Boolean).join(' · ');
  }
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
        hint: 'Жанры Steam Store и вторых библиотек; одна игра может попадать в несколько жанров, поэтому сумма по жанрам больше числа игр.',
        groupLabel: row.name,
        emptyText: 'Нет игр этого жанра',
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

function renderTags(data) {
  const widget = $('games-tags-widget');
  const host = $('games-tags-chart');
  const moreHost = $('games-tags-more');
  const note = $('games-tags-note');
  if (!widget || !host) return;
  clear(host);
  if (moreHost) clear(moreHost);
  const view = tagsChartView(data.tags, {
    weight: state.tagWeight,
    limit: state.tagsExpanded ? 0 : TAG_CHART_LIMIT,
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
      const games = sortGameRows(gamesByTag(data.gamesIndex, row.name), 'hours');
      openGameListModal({
        kicker: 'Тег',
        title: `${row.name} — ${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)}`,
        subtitle: `${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)} · ${row.hoursText || 'часы неизвестны'}`,
        hint: 'Теги SteamSpy; одна игра может иметь несколько тегов, поэтому сумма по тегам больше числа игр. '
          + 'Список собран по gamesIndex — игры без тегов в него не попадают.',
        groupLabel: row.name,
        emptyText: 'Нет игр с этим тегом в индексе',
        games,
        sortScope: 'tags',
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
        state.tagsExpanded = true;
        renderTags(data);
      });
      moreHost.append(button);
    } else if (state.tagsExpanded && view.total > TAG_CHART_LIMIT) {
      const button = el('button', {
        type: 'button',
        class: 'btn btn-link games-genre-more-btn',
        text: `Свернуть до топ-${TAG_CHART_LIMIT}`,
      });
      button.addEventListener('click', () => {
        state.tagsExpanded = false;
        renderTags(data);
      });
      moreHost.append(button);
    }
  }
  for (const button of document.querySelectorAll('[data-games-tag-weight]')) {
    const active = button.dataset.gamesTagWeight === view.weight;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function openScoreBucketModal(data, bucket) {
  const view = scoresView(data.scores, data.reviewScore);
  const seg = view ? view.segments.find((entry) => entry.bucket === Number(bucket)) : null;
  if (!seg) return;
  const games = sortGameRows(gamesByReviewBucket(data.gamesIndex, seg.bucket), 'hours');
  openGameListModal({
    kicker: 'Оценки Steam',
    title: `${seg.label} — ${fmtInt(games.length)} ${plural(games.length, GAME_PLURAL)}`,
    subtitle: `${seg.desc} · community score ${seg.bucket} из 9`,
    hint: 'Это community-оценка Steam (appreviews), а не ваша личная: личных оценок у Steam нет. '
      + 'Список собран по gamesIndex — игры без оценки в него не попадают.',
    groupLabel: seg.label,
    emptyText: 'Нет игр с этой оценкой в индексе',
    games,
    sortScope: 'scores',
    defaultSort: 'hours',
  });
}

function renderScores(data) {
  const widget = $('games-scores-widget');
  const donutHost = $('games-scores-donut');
  const legendHost = $('games-scores-legend');
  const note = $('games-scores-note');
  const honest = $('games-scores-honest');
  if (!widget || !donutHost || !legendHost) return;
  const view = scoresView(data.scores, data.reviewScore);
  if (!view) {
    widget.hidden = true;
    clear(donutHost);
    clear(legendHost);
    return;
  }
  widget.hidden = false;
  if (note) {
    const avg = view.avgText !== '—' ? ` · средняя ${view.avgText}` : '';
    note.textContent = `${view.note}${avg}`;
  }
  if (honest) honest.textContent = view.honestNote;
  renderDonut(donutHost, {
    segments: view.segments,
    legendHost,
    centerValue: fmtInt(view.total),
    centerLabel: 'игр с оценкой',
    ariaLabel: view.ariaLabel,
    secondary: (seg) => {
      const entry = view.segments.find((item) => item.key === seg.key);
      return entry ? `${entry.desc} · ${fmtInt(seg.value)} ${plural(seg.value, GAME_PLURAL)}` : '';
    },
    onSelect: (seg) => {
      hideTooltip();
      openScoreBucketModal(data, seg.bucket);
    },
  });
}

async function ensureFranchises({ force = false } = {}) {
  const profile = state.profileKey;
  if (!profile) return;
  if (state.franchises.loading) return;
  if (!force && state.franchises.profile === profile
    && (state.franchises.data || state.franchises.error)) return;
  state.franchises = {
    data: state.franchises.profile === profile ? state.franchises.data : null,
    loading: true,
    error: null,
    profile,
  };
  if (state.data) renderFranchises(state.data);
  try {
    const raw = await getGamesFranchises({ profile });
    if (profile !== state.profileKey) return;
    state.franchises = {
      data: normalizeFranchisesResponse(raw),
      loading: false,
      error: null,
      profile,
    };
  } catch (error) {
    if (profile !== state.profileKey) return;
    state.franchises = { data: null, loading: false, error: error || true, profile };
  }
  if (state.data && profile === state.profileKey) renderFranchises(state.data);
}

function renderFranchises(data) {
  const widget = $('games-franchises-widget');
  const host = $('games-franchises-list');
  const note = $('games-franchises-note');
  const loading = $('games-franchises-loading');
  if (!widget || !host) return;
  const fromPayload = data && Array.isArray(data.franchises) ? data.franchises : [];
  const cached = state.franchises.profile === state.profileKey ? state.franchises.data : null;
  const list = fromPayload.length ? fromPayload : (cached || []);
  const view = franchisesView(list);
  clear(host);
  if (loading) loading.hidden = true;

  if (!view) {
    const fetchedEmpty = state.franchises.profile === state.profileKey
      && Array.isArray(state.franchises.data) && !state.franchises.data.length;
    if (fetchedEmpty && !fromPayload.length) {
      widget.hidden = false;
      if (note) note.textContent = 'нет данных';
      host.append(el('div', {
        class: 'empty-state',
        text: 'Франшизы не собраны: IGDB/Wikidata ещё не дали связей, а эвристика не подтвердила ни одной серии. Это не «нет франшиз» — просто метадата не загружена.',
      }));
      return;
    }
    if (!fromPayload.length && !cached && !state.franchises.loading && !state.franchises.error) {
      widget.hidden = false;
      if (note) note.textContent = 'собираем…';
      if (loading) loading.hidden = false;
      ensureFranchises();
      return;
    }
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
    name.append(el('span', { class: 'genre-label', text: row.label }));
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
      const games = sortGameRows(
        gamesInFranchise(data.gamesIndex, {
          key: row.key,
          label: row.label,
          appids: row.appids,
          workKeys: row.workKeys,
        }),
        'year',
      );
      openFranchiseModal({
        franchise: {
          key: row.key,
          label: row.label,
          appids: row.appids,
          workKeys: row.workKeys,
        },
        games,
        hoursSum: row.hoursSum,
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

function readViewParam() {
  try {
    const value = new URLSearchParams(window.location.search).get('view');
    return value === 'personnel' ? 'personnel' : '';
  } catch {
    return '';
  }
}

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
  }
}

function personnelCacheKey(role) {
  return `${state.profileKey}:${role}`;
}

async function fetchPersonnel(role, profileKey = state.profileKey) {
  try {
    return await getGamesPersonnel({ profile: profileKey, role });
  } catch (error) {
    if (role === 'developer' && error && error.code === 'invalid_role') {
      return getGamesPersonnel({ profile: profileKey, role: 'studio' });
    }
    throw error;
  }
}

async function ensurePersonnel(role, { force = false } = {}) {
  const nextRole = normalizePersonnelRole(role) || PERSONNEL_ROLES[0].key;
  if (!state.profileKey) return;
  const requestProfile = state.profileKey;
  const sameOwner = () => state.profileKey === requestProfile;
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
  const key = `${requestProfile}:${nextRole}`;
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
    const raw = await fetchPersonnel(nextRole, requestProfile);
    const data = normalizePersonnel(raw, nextRole);
    if (!sameOwner()) return;
    state.personnel.cache[key] = data;
    if (state.personnel.role === nextRole) {
      state.personnel.data = data;
      state.personnel.error = null;
    }
  } catch (error) {
    if (error && error.status === 401) return;
    if (!sameOwner()) return;
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
    if (sameOwner()) {
      state.personnel.loading = false;
      if (state.personnel.role === nextRole) {
        renderPersonnel();
        renderPersonsWidget(state.data);
      }
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

export function initGames({ onActivate } = {}) {
  state.onActivate = typeof onActivate === 'function' ? onActivate : null;
  state.profileKey = text(safeStorageGet(PROFILE_KEY));
  state.filters = readStoredFilters();

  renderSourceCards({
    grid: $('games-import-grid'),
    sources: GAMES_SHELL.sources.filter((source) => source.id === 'steam'),
  });
  mountConnectionsScreen({
    screen: $('games-connections-screen'),
    hero: {
      kicker: 'подключения',
      title: 'Вторые библиотеки',
      sub: 'GOG и Epic — библиотеки того же владельца. Их игры и часы показываются отдельной строкой и никогда не складываются с журналом Steam: одна игра могла запускаться в двух магазинах, это два факта, а не одна сумма.',
    },
    back: { id: 'games-connections-back', label: '← к профилю Steam' },
    grid: $('games-connections-grid'),
    sources: GAMES_SHELL.sources.filter((source) => source.id === 'gog'),
  });

  const storedGenreWeight = text(safeStorageGet(GENRE_WEIGHT_KEY));
  state.genreWeight = storedGenreWeight === 'count' ? 'count' : 'hours';
  const storedTagWeight = text(safeStorageGet(TAG_WEIGHT_KEY));
  state.tagWeight = storedTagWeight === 'count' || storedTagWeight === 'weight' ? storedTagWeight : 'hours';
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

  const connections = $('games-connections-btn');
  if (connections) {
    connections.addEventListener('click', () => {
      showScreen('connections');
    });
  }
  const importConnections = $('games-import-connections-link');
  if (importConnections) {
    importConnections.addEventListener('click', () => {
      showScreen('connections');
    });
  }
  const connectionsBack = $('games-connections-back');
  if (connectionsBack) {
    connectionsBack.addEventListener('click', () => {
      showScreen(state.profileKey ? 'dashboard' : 'import');
    });
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('games:epic-changed', () => {
      if (!state.profileKey || !state.active) return;
      state.loaded = false;
      loadStats({ force: true });
    });
  }
  const gogLogin = $('games-gog-login');
  if (gogLogin) gogLogin.addEventListener('click', () => openGogLogin());
  const gogConnect = $('games-gog-connect');
  if (gogConnect) gogConnect.addEventListener('click', () => connectGogAccount());
  const gogCode = $('games-gog-code');
  if (gogCode) {
    gogCode.addEventListener('input', () => setGogError(''));
    gogCode.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        connectGogAccount();
      }
    });
  }
  const gogImport = $('games-gog-import');
  if (gogImport) gogImport.addEventListener('click', () => startGogImport({ force: true }));
  const gogLogout = $('games-gog-logout');
  if (gogLogout) gogLogout.addEventListener('click', () => logoutGogAccount());

  const free = $('games-filter-free');
  if (free) {
    free.addEventListener('change', () => applyFilters({
      includeFree: !free.checked,
      includeDlc: Boolean($('games-filter-dlc') && $('games-filter-dlc').checked),
      minHours: state.filters.minHours,
    }));
  }
  const dlc = $('games-filter-dlc');
  if (dlc) {
    dlc.addEventListener('change', () => applyFilters({
      includeFree: !($('games-filter-free') && $('games-filter-free').checked),
      includeDlc: dlc.checked,
      minHours: state.filters.minHours,
    }));
  }
  const hours = $('games-filter-hours');
  if (hours) {
    const commit = (value) => {
      const next = normalizeMinHours(value);
      hours.value = String(next);
      if (next === state.filters.minHours) return;
      applyFilters({ ...state.filters, minHours: next });
    };
    hours.addEventListener('change', () => commit(hours.value));
    hours.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      commit(hours.value);
    });
    const minus = $('games-filter-hours-minus');
    if (minus) {
      minus.addEventListener('click', () => commit(state.filters.minHours - 1));
    }
    const plus = $('games-filter-hours-plus');
    if (plus) {
      plus.addEventListener('click', () => commit(state.filters.minHours + 1));
    }
  }

  for (const button of document.querySelectorAll('[data-games-genre-weight]')) {
    button.addEventListener('click', () => {
      const next = button.dataset.gamesGenreWeight === 'count' ? 'count' : 'hours';
      if (state.genreWeight === next) return;
      state.genreWeight = next;
      safeStorageSet(GENRE_WEIGHT_KEY, next);
      if (state.data) renderGenreChart(state.data);
    });
  }

  for (const button of document.querySelectorAll('[data-games-tag-weight]')) {
    button.addEventListener('click', () => {
      const raw = button.dataset.gamesTagWeight;
      const next = raw === 'count' ? 'count' : raw === 'weight' ? 'weight' : 'hours';
      if (state.tagWeight === next) return;
      state.tagWeight = next;
      safeStorageSet(TAG_WEIGHT_KEY, next);
      if (state.data) renderTags(state.data);
    });
  }

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

function filtersStorageKey(profileKey = state.profileKey) {
  const key = text(profileKey);
  return key ? `kinoboxd.games.filters.${key}.v1` : FILTERS_KEY;
}

function readStoredFilters(profileKey = state.profileKey) {
  const raw = safeStorageGet(filtersStorageKey(profileKey)) ?? safeStorageGet(FILTERS_KEY);
  try {
    const parsed = JSON.parse(raw || 'null');
    if (parsed && typeof parsed === 'object') {
      return {
        includeFree: parsed.includeFree !== false,
        includeDlc: parsed.includeDlc === true,
        minHours: normalizeMinHours(parsed.minHours),
      };
    }
  } catch {
  }
  return { includeFree: true, includeDlc: false, minHours: 0 };
}

function syncFilterInputs() {
  const free = $('games-filter-free');
  const dlc = $('games-filter-dlc');
  const hours = $('games-filter-hours');
  if (free) free.checked = state.filters.includeFree === false;
  if (dlc) dlc.checked = state.filters.includeDlc === true;
  if (hours) hours.value = String(state.filters.minHours);
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

export async function showGames() {
  state.active = true;
  if (state.onActivate) state.onActivate();
  hydrateJob();
  if (state.job) {
    const owner = text(state.job.profile);
    if (owner && state.profileKey && owner !== state.profileKey) {
      state.job = null;
      saveJob();
    } else {
      showScreen('progress');
      renderProgress();
      startPolling();
      return;
    }
  }
  if (state.loading) return;
  await ensureProfiles({ reload: true, maxAgeMs: PROFILES_RELOAD_MS });
  await ensureGogStatus();
  if (!state.profileKey) {
    showScreen('import');
    renderProfiles();
    return;
  }
  if (readViewParam() === 'personnel') {
    await openPersonnel({ push: false });
    return;
  }
  if (state.view === 'personnel') {
    showScreen('dashboard');
  }
  if ((state.view === 'dashboard' || state.view === 'connections') && state.data) {
    renderProfiles();
    if (state.view === 'dashboard' && !state.personnel.data && !state.personnel.loading) {
      ensurePersonnel(state.role);
    }
    if (Date.now() - (state.loadedAt || 0) > 60_000) {
      await loadStats({ force: true, silent: true });
    }
    if (state.view === 'connections') requestEpicRefresh();
    return;
  }
  await loadStats({ force: true });
}

function hydrateJob() {
  if (state.job) return;
  const stored = readJob();
  if (!stored) return;
  if (stored.profile && state.profileKey && stored.profile !== state.profileKey) {
    safeStorageRemove(JOB_KEY);
    return;
  }
  state.job = stored;
  if (stored.profile && !state.profileKey) {
    state.profileKey = stored.profile;
    safeStorageSet(PROFILE_KEY, stored.profile);
  }
}

export function hideGames() {
  state.active = false;
  stopPolling();
  stopEnrichPoll();
  if (state.gog.timer) {
    clearTimeout(state.gog.timer);
    state.gog.timer = 0;
  }
  hideTooltip();
}

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
  state.franchises = { data: null, loading: false, error: null, profile: '' };
  state.personnel = {
    role: '', data: null, loading: false, error: null, cache: {}, openId: '',
    query: '', expanded: false, visible: PERSONS_INITIAL, rows: [],
  };
  state.enrichTicks = 0;
  if (state.gog.timer) clearTimeout(state.gog.timer);
  state.gog = { status: null, loading: false, error: null, job: null, timer: 0, connected: false };
  saveJob();
  showScreen('import');
  renderProfiles();
  setKeyIndicator(null);
  if (readViewParam()) writeViewParam('', { push: false });
}
