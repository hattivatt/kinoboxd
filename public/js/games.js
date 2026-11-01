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
  getGamesPersonnel, getGamesFranchises,
  getGamesGogAuthUrl, connectGamesGog, getGamesGogStatus, startGamesGogImport,
  getGamesGogImportStatus, logoutGamesGog,
} from './api.js';
import {
  $, el, clear, fmtInt, fmtPercent, plural, icon, toast, errorBox, showTooltip, moveTooltip, hideTooltip,
  shortErrorMessage, debounce,
} from './ui.js';
import { withPreservedScroll } from './books-refresh.js';
import { renderYearBars, renderDonut } from './charts.js';
import {
  normalizeGamesPayload, normalizeProfilesList, accountFromInput, profileCardView, summaryMetrics,
  paretoView, topHoursRows, recentStripView, lastPlayedInfo,
  importErrorText, jobStageText, jobProgress, gamesJobId, hoursText, HOURS_HINT,
  decadesView, yearsView, genreChartView, metadataProgressView, filtersView,
  calendarView, achievementStreaksView, achievementsOverviewView, normalizePersonnel, personnelRows,
  studiosView, coverageBadge, PERSONNEL_ROLES, formatDateRu, normalizePersonnelRole,
  personnelRoleOptions, personnelRoleCountText, GENRE_CHART_LIMIT,
  gamesInDecade, gamesWithoutYear, gamesWithoutType, gamesByGenre,
  gamesWithRecentHours, allGames, sortGameRows,
  yearsInDecade, gamesInYearGenre, yearCountView, yearCountGenreOptions,
  tagsChartView, TAG_CHART_LIMIT, gamesByTag, scoresView, gamesByReviewBucket,
  franchisesView, gamesInFranchise, dlcView, normalizeFranchisesResponse,
  gogSourcesView, gogStatusText,
} from './games-view.js';
import {
  configureGamesModals, openGameCardModal, openGameListModal, openPersonModal, personAvatarEl,
  openFranchiseModal, gameCoverVerticalEl,
} from './games-modal.js';
// M6c: the Epic slot is a self-contained module loaded by index.html. games.js
// never imports it (that would drag its DOM/timers into DOM-free tests); it
// asks for a refresh through a DOM event instead.
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
// Legacy key name: the genre widget was a cloud, now it is a bar chart. The
// stored weight choice survives the change, so the string stays.
const GENRE_WEIGHT_KEY = 'kinoboxd.games.cloudweight.v1';
// Tags share the bar-chart idea but keep their own weight (hours/count/weight).
const TAG_WEIGHT_KEY = 'kinoboxd.games.tagweight.v1';
const POLL_INTERVAL = 1400;
const ENRICH_POLL_INTERVAL = 3500;
const ENRICH_POLL_LIMIT = 120;
// The profile catalogue is server state (another browser may import a profile).
// Re-reading it on every tab activation keeps the switcher honest; the throttle
// keeps a quick tab flip-flop from spamming `/api/games/profiles`.
const PROFILES_RELOAD_MS = 30_000;
const GAME_PLURAL = ['игра', 'игры', 'игр'];
// Donut palettes: the same two arrays films/books use (DECADE_COLORS /
// YEAR_COLORS in widgets.js / books.js), so «Десятилетия» and «Годы» read as
// the same charts across tabs. Kept local: the games tab must not import a
// films/books module just for six hex strings.
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
  view: 'import', // import | progress | dashboard | personnel
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
  job: null, // { id, profile, status, failed, startedAt }
  pollTimer: 0,
  pollSeq: 0,
  importBusy: false,
  onActivate: null,
  // M2: includeFree/includeDlc are sent only when they differ from the server
  // defaults (free included, DLC excluded) — a default request stays clean.
  // The min-hours filter follows the same rule: -1 = every game (including
  // 0-hour ones), 0 = the server default (only games with >0 hours), N = ≥N h.
  filters: { includeFree: true, includeDlc: false, minHours: 0 },
  // Genre bar chart: weight + «Показать все» (top 12 first).
  genreWeight: 'hours',
  genresExpanded: false,
  // M4 tag bars: own weight (hours/count/weight) and fold state.
  tagWeight: 'hours',
  tagsExpanded: false,
  // M4 franchises come from their own route, cached per profile (one owner).
  franchises: { data: null, loading: false, error: null, profile: '' },
  // M3: personnel weights + per-role cache (one owner, no cross-profile mix).
  weight: 'hours',
  role: 'developer',
  // The years card is permanent: it paints every release year by default and
  // a selected decade narrows the chart (clicking it again restores the full
  // range). The inline persons widget batches locally (the personnel route
  // returns the whole role — its `limit` is games per person, not persons).
  selectedDecade: null,
  // «Количество игр по году выхода»: an independent full-width chart. The
  // decade above never narrows it; only this genre filter does (client-side).
  yearCountGenre: null,
  personnel: {
    role: '', data: null, loading: false, error: null, cache: {}, openId: '',
    query: '', expanded: false, visible: PERSONS_INITIAL, rows: [],
  },
  enrichTimer: 0,
  enrichSeq: 0,
  enrichTicks: 0,
  // M6a: GOG connection state. `status` is the sanitized `/gog/status`
  // payload; `job` is the running GOG import. Tokens never reach the browser.
  gog: { status: null, loading: false, error: null, job: null, timer: 0, connected: false },
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
    // M6c: one screen for every secondary library (GOG + Epic). It is a real
    // screen, not a section glued to the dashboard, so the Epic slot and the
    // GOG card are never painted twice.
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
  // M6c: opening «Подключения» refreshes both slots (GOG status + Epic slot).
  if (name === 'connections' && previous !== name) {
    ensureGogStatus();
    requestEpicRefresh();
  }
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
  const connections = $('games-connections-btn');
  // M6c: «Подключения» is offered only when there is an owner to attach a
  // library to (a secondary library needs a Steam profile) and never on the
  // import-progress screen.
  if (connections) connections.hidden = state.view === 'progress' || !state.profileKey;
}

function showLoading(visible) {
  const node = $('games-loading');
  if (node) node.hidden = !visible;
}

/**
 * A profile switch empties `state.data` but leaves the previous owner's numbers
 * in the DOM until the new payload lands. Hide the dashboard and show the
 * loader instead: a stale summary under a new chip is a lie (§2.0).
 */
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
    // `label` is the owner-facing name typed at import; the persona is what
    // Steam says. Two owners of one account are told apart by the label, so it
    // wins in the chip and the persona stays as the tooltip.
    const chipName = text(profile.label) || text(profile.personaName) || profile.key;
    const button = el('button', {
      type: 'button',
      class: `games-profile-chip${active ? ' is-active' : ''}`,
      'aria-pressed': active ? 'true' : 'false',
      title: `${chipName}${profile.personaName && profile.personaName !== chipName ? ` · ${profile.personaName}` : ''}${profile.gameCount != null ? ` · ${fmtInt(profile.gameCount)} ${plural(profile.gameCount, GAME_PLURAL)}` : ''}`,
    });
    button.append(el('span', { class: 'games-profile-dot', 'aria-hidden': 'true' }));
    button.append(el('span', { class: 'games-profile-name', text: chipName }));
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
  // Filters are per owner (§8.5: «сброс при смене профиля»): the new profile
  // starts from ITS stored choice (or the server defaults), never from the
  // previous owner's F2P/DLC switches.
  state.filters = readStoredFilters(next);
  state.selectedDecade = null;
  // Franchises belong to one owner too: never reuse the previous cache.
  state.franchises = { data: null, loading: false, error: null, profile: '' };
  state.yearCountGenre = null;
  state.genresExpanded = false;
  syncFilterInputs();
  // The old owner's numbers are already out of `state.data`; hide the DOM too,
  // so the switch shows the loader instead of a stale dashboard.
  markDashboardLoading(true);
  renderProfiles();
  await loadStats({ force: true });
  if (state.view === 'personnel') await ensurePersonnel(state.role, { force: true });
}

async function ensureProfiles({ reload = false, maxAgeMs = 0 } = {}) {
  if (state.profilesLoaded) {
    const age = Date.now() - (state.profilesLoadedAt || 0);
    // `reload` alone is a hard reload (finishImport needs the new chip); with
    // `maxAgeMs` it is throttled (tab activation: a quick flip-flop is cheap).
    const throttled = reload && maxAgeMs > 0 && age <= maxAgeMs;
    if (!reload || throttled) return state.profiles;
  }
  try {
    const raw = await getGamesProfiles();
    state.profiles = normalizeProfilesList(raw);
    state.profilesLoaded = true;
    state.profilesLoadedAt = Date.now();
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
  // Without a payload for the selected profile there is nothing honest to
  // show: hide the (previous owner's) dashboard and paint the loader.
  if (!silent && !state.data) markDashboardLoading(true);
  else if (!silent && state.view !== 'dashboard' && state.view !== 'personnel') showLoading(true);
  updateActions();
  try {
    // Filters are sent only when they differ from the server defaults
    // (`includeFree=1`, `includeDlc=0`): a default dashboard request stays
    // exactly `?profile=…`, and `meta.filters` tells us what was applied.
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
      // Nothing imported for this key: the honest screen is the import card.
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
      // A vanity import resolves the owner on the server: `profile` is null
      // until then. Never seed the job with the previously selected key — that
      // is how the tab kept activating the OLD profile after a second person's
      // import (P0). The job's owner arrives with the first status poll.
      profile: profile || '',
      status: response && typeof response === 'object' ? response : null,
      failed: null,
      startedAt: Date.now(),
    };
    if (profile) {
      state.profileKey = profile;
      safeStorageSet(PROFILE_KEY, profile);
      // The job owns this profile from now on: highlight its chip immediately
      // (the progress screen hides the bar, but a reload/resume must agree).
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
    // P0: a vanity import names its owner only after the profile XML resolves.
    // The status carries that key — adopt it, so `finishImport`/resume stop
    // reading the profile that was selected before the import started.
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
      // The status route may not be mounted (or the job already left the
      // server's memory). Ask the stats endpoint directly: a payload means the
      // import finished.
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

/** The profile a finished job activates: its own resolved key first (P0). */
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
    // The status route may be missing while the payload already exists: the
    // finished job still owns the profile switch, so repaint the chips here
    // too (otherwise the new profile stays unhighlighted until a reload).
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
  // P0: the job's own resolved profile wins over whatever was selected before
  // the import (a vanity import has no key at submit time at all).
  const key = jobProfileKey(status);
  stopPolling();
  state.job = null;
  saveJob();
  if (key) {
    state.profileKey = key;
    safeStorageSet(PROFILE_KEY, key);
  }
  await ensureProfiles({ reload: true });
  // `/api/games/profiles` can lag behind a finished job (or an older server
  // may not list the profile yet). Never let that reload silently move the
  // tab back to a previous profile: the job named the profile that just
  // became active, so re-assert it and repaint the switcher chips.
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

/* =========================================================
   M6a: GOG — same-owner secondary library
   ========================================================= */

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

/** Paint the connect card from the sanitized `/gog/status` payload. */
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

/** «Источники»: Steam journal + GOG + Epic secondary, never summed. */
function renderSources(data) {
  const widget = $('games-sources-widget');
  const host = $('games-sources-body');
  if (!widget || !host) return;
  const view = gogSourcesView(data);
  clear(host);
  const note = $('games-sources-note');
  if (note) {
    note.textContent = view.worksTotal != null
      ? `${fmtInt(view.worksTotal)} ${plural(view.worksTotal, GAME_PLURAL)} в объединённой библиотеке`
      : '';
  }
  for (const row of view.rows) {
    const node = el('div', {
      class: `games-source-row is-${row.key}${row.journal ? ' is-journal' : ''}`,
    });
    node.append(el('span', { class: 'games-source-name', text: row.label }));
    const parts = [];
    if (row.games != null) parts.push(`${fmtInt(row.games)} ${plural(row.games, GAME_PLURAL)}`);
    if (row.hours != null) parts.push(hoursText(row.hours, 1));
    node.append(el('span', {
      class: 'games-source-numbers',
      text: parts.length ? parts.join(' · ') : '—',
    }));
    const stateNode = el('span', { class: 'games-source-state' });
    stateNode.append(document.createTextNode(row.statusText));
    // M6c: both secondary libraries connect on the «Подключения» screen; the
    // row only links there, it never grows a second connect form.
    if ((row.key === 'gog' || row.key === 'epic') && row.canConnect) {
      const link = el('button', { type: 'button', class: 'btn btn-link', text: 'Подключить' });
      link.addEventListener('click', () => {
        showScreen('connections');
      });
      stateNode.append(document.createTextNode(' · '));
      stateNode.append(link);
    }
    node.append(stateNode);
    host.append(node);
  }
  const secondary = $('games-sources-secondary');
  if (secondary) {
    clear(secondary);
    if (view.secondaryOnly > 0) {
      secondary.append(el('div', {
        text: `Вне Steam: ${fmtInt(view.secondaryOnly)} ${plural(view.secondaryOnly, GAME_PLURAL)} `
          + 'есть только во второй библиотеке — в часы и достижения Steam они не входят.',
      }));
      if (view.secondaryWorks.length) {
        const chips = el('div', { class: 'games-sources-secondary-list' });
        for (const work of view.secondaryWorks.slice(0, 8)) {
          const hours = work.hours != null ? ` · ${hoursText(work.hours, 1)}` : '';
          const label = work.source === 'epic' ? 'Epic' : work.source === 'gog' ? 'GOG' : '';
          chips.append(el('span', {
            class: `games-sources-chip is-${work.source || 'unknown'}`,
            text: `${label ? `${label} · ` : ''}${work.name}${hours}`,
            title: work.gogGameId
              ? `GOG id ${work.gogGameId}`
              : work.epicId
                ? `Epic ${work.epicId}`
                : '',
          }));
        }
        secondary.append(chips);
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
  // Open the tab synchronously (inside the click) so the popup blocker does
  // not swallow it while the auth URL is being fetched.
  const popup = typeof window !== 'undefined' ? window.open('about:blank', '_blank') : null;
  try {
    const info = await getGamesGogAuthUrl();
    const url = info && (info.url || info.authUrl);
    if (!url) throw new Error('сервер не вернул ссылку GOG');
    if (popup) {
      try {
        popup.opener = null;
      } catch (err) {
        /* cross-origin guard; the tab is still usable */
      }
      popup.location.href = url;
    } else {
      window.location.href = url;
    }
    setGogError('Войдите в GOG в новой вкладке. После входа скопируйте параметр code из адресной строки и вставьте его ниже.');
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
    setGogError('Вставьте code из адресной строки GOG.');
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
  });
  renderHead(data);
  renderProfileCard(data);
  // M6a: sources (Steam journal + GOG secondary + Epic «скоро»). Hides itself
  // only when there is no payload at all; a Steam-only profile still shows the
  // GOG row with a «Подключить» link.
  renderSources(data);
  renderSummary(data);
  renderPartialNote(data);
  renderFilters(data);
  // The top strip is first in the grid (films/books pattern): newest launches
  // first, then the rest of the dashboard.
  renderRecentStrip(data);
  renderTopHours(data);
  renderPareto(data);
  // M2/M3 widgets: every one of them hides itself when its payload block is
  // missing, so an M1 server keeps a clean dashboard.
  renderDecades(data);
  renderYears(data);
  renderYearCount(data);
  // M4: tags + Steam scores, then genres (paired with Pareto), franchises and
  // DLC. Every widget hides itself when its block is absent.
  renderTags(data);
  renderScores(data);
  renderGenreChart(data);
  renderFranchises(data);
  renderDlc(data);
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
  // The backlog tile stays a number: its list widget is gone, so a drilldown
  // would open a list the dashboard no longer shows.
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
      },
      { className: 'games-recent-icon' },
    ));
    // M6c: the same work can be owned in another store; the badge says so
    // without touching the Steam hours printed below.
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

/* =========================================================
   M2: filters, decades, years, genres, enrichment
   ========================================================= */

/** Requested-vs-applied is printed as-is: a silent filter would be a lie. */
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
  // Keep the checkboxes in sync with what the server understood.
  if (free && free.checked !== (view.state.includeFree === false)) {
    free.checked = view.state.includeFree === false;
  }
  if (dlc && dlc.checked !== (view.state.includeDlc === true)) {
    dlc.checked = view.state.includeDlc === true;
  }
  // The stepper shows the stored per-profile value; it is not a checkbox, so
  // it is only overwritten when it differs (never mid-typing).
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

/** Clamp the «мин. часов» value: integer, never below -1. */
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
  // Selection, not navigation: a click narrows the years donut to the decade,
  // a second click on the same slice brings the full range back (films/books
  // semantics, widgets.js `selectDecade`). The list itself opens from the
  // «N игр без года» note, not from a slice.
  const same = state.selectedDecade && state.selectedDecade.start === decade.start;
  state.selectedDecade = same ? null : { start: decade.start, label: decade.label };
  renderDecades(data);
  renderYears(data);
}

/** «N игр без года» — the honest note line under the decade donut. */
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

  // «Год неизвестен» is a bucket, not a decade: it never becomes a slice
  // (books parity). It is reported as a clickable note line instead, so the
  // 29 year-less games are visible without inventing a decade for them.
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
    ? `Только игры жанра «${filter}» (Steam Store). Год выхода — release_date, а не год, когда вы играли; `
      + 'одна игра может попадать в несколько жанров.'
    : 'Год релиза игры (release_date из Steam Store / Wikidata), а не год, когда вы в неё играли.';
  openGameListModal({
    kicker: 'Годы релиза',
    title,
    subtitle,
    hint,
    groupLabel: String(year),
    emptyText: filter
      ? 'Нет игр этого жанра за этот год'
      : 'Для этого года нет игр с карточкой Steam Store',
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
  // The years card is a permanent block: it is never hidden. A hidden card
  // looked like a lost feature (the 01.11 regression), so the widget stays and
  // an empty payload gets an honest placeholder instead.
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

  // Default: every release year in one donut (no decade click required — the
  // «график всегда есть» requirement). A selected decade narrows the chart to
  // its ten years; clicking the same decade again restores the full range.
  const years = (decade ? yearsInDecade(data.years, decade.start) : view.years)
    .slice()
    .sort((a, b) => b.year - a.year);
  const total = years.reduce((sum, item) => sum + item.count, 0);
  // The normalised payload keeps the unknown-year bucket aside (`unknownYear`),
  // so the note stays honest: 303 known + 29 without a year.
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

/* «Количество игр по году выхода» — the permanent full-width count chart.
 *
 * Independent of `state.selectedDecade` on purpose: the card above («Годы
 * релиза») narrows to a decade when one is clicked, this one always paints
 * every release year. The only filter is the genre select, applied locally
 * from `gamesIndex` (films year-chart parity: no extra request, one select).
 * Unknown years never become a bar — the note says «и ещё N игр без года».
 */
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
  // A profile switch or a refresh can remove the genre the user picked:
  // fall back to «Все» instead of showing a silently empty chart.
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

  if (note) note.textContent = view.note;
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
    // The column height is the game count, so the count is printed above the
    // bar and the tooltip adds the hours: «34 игры» vs «450 ч» is exactly the
    // «игры, а не время» distinction the card is about.
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

/** Genre select of the year-count chart; «Все» clears the client-side filter. */
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

/* =========================================================
   M4: tags / Steam scores / franchises / DLC
   ========================================================= */

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
    // Same fallback denominator as genres: the payload share wins.
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

/**
 * Franchises: the block may arrive in `/stats` (tolerant) or from the
 * dedicated `/api/games/franchises` route, which is asked once per profile.
 * A 404 (backend round not merged yet) hides the widget instead of polling.
 */
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
    // A successful but empty answer is shown honestly, not hidden: «нет» is
    // data too (IGDB/Wikidata have no links and the heuristic confirmed none).
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
    // Either loading is already in flight, or the route is absent/failed.
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
        gamesInFranchise(data.gamesIndex, { key: row.key, label: row.label, appids: row.appids }),
        'year',
      );
      openFranchiseModal({
        franchise: { key: row.key, label: row.label, appids: row.appids },
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

function findAppidByName(gamesIndex, name) {
  const target = String(name || '').trim().toLowerCase();
  if (!target || !gamesIndex || typeof gamesIndex !== 'object') return null;
  for (const entry of Object.values(gamesIndex)) {
    if (entry && String(entry.name || '').trim().toLowerCase() === target) return entry.appid;
  }
  return null;
}

function renderDlc(data) {
  const widget = $('games-dlc-widget');
  const summary = $('games-dlc-summary');
  const host = $('games-dlc-list');
  const note = $('games-dlc-note');
  if (!widget || !host) return;
  clear(host);
  const view = dlcView(data.dlc);
  if (!view) {
    widget.hidden = true;
    if (summary) summary.textContent = '';
    return;
  }
  widget.hidden = false;
  if (summary) summary.textContent = view.summaryText;
  if (note) note.textContent = view.note;
  if (!view.rows.length) {
    host.append(el('div', { class: 'empty-state', text: 'Список игр с DLC сервер не передал' }));
    return;
  }
  for (const row of view.rows) {
    const appid = row.appid != null ? row.appid : findAppidByName(data.gamesIndex, row.name);
    const node = el('div', {
      class: `genre-row games-dlc-row${appid != null ? ' is-clickable' : ''}`,
      title: appid != null
        ? `${row.name} — ${row.countText} · нажмите, чтобы открыть карточку`
        : `${row.name} — ${row.countText}`,
      role: appid != null ? 'button' : null,
      tabIndex: appid != null ? 0 : null,
      'aria-label': appid != null ? `${row.name}: ${row.countText} — открыть карточку игры` : null,
    });
    const name = el('div', { class: 'genre-name' });
    name.append(el('span', { class: 'genre-label', text: row.name }));
    node.append(name);
    node.append(el('div', { class: 'games-dlc-row-count', text: row.countText }));
    host.append(node);
    if (appid != null) {
      const activate = () => {
        hideTooltip();
        openGameCardModal(appid, { fallback: { name: row.name } });
      };
      node.addEventListener('click', activate);
      node.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activate();
      });
    }
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
async function fetchPersonnel(role, profileKey = state.profileKey) {
  try {
    return await getGamesPersonnel({ profile: profileKey, role });
  } catch (error) {
    // `studio` is the pre-split key (developers + publishers mixed). A server
    // that rejects `developer` still answers it, so the UI never goes empty.
    if (role === 'developer' && error && error.code === 'invalid_role') {
      return getGamesPersonnel({ profile: profileKey, role: 'studio' });
    }
    throw error;
  }
}

async function ensurePersonnel(role, { force = false } = {}) {
  const nextRole = normalizePersonnelRole(role) || PERSONNEL_ROLES[0].key;
  if (!state.profileKey) return;
  // P2: a request started for one owner must never paint another owner's
  // credits. Capture the profile at request start; every write below is gated
  // on it still being the selected one (the cache key already names it, but
  // `state.personnel` is replaced wholesale on a switch, so the role check
  // alone used to let an in-flight old answer through).
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
    if (!sameOwner()) return; // the tab switched owners while this was in flight
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

  /* M6c: «Подключения» — one screen for GOG + Epic. The GOG token never
     reaches the browser (the code is exchanged server-side); the Epic slot
     lives in the same screen and refreshes itself. */
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
  /* M6c: an Epic connect/import/disconnect changes `hoursBySource.epic` and
     `secondaryWorks` in the stats payload — rebuild it once, silently. */
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

  /* M2: filters — requested-vs-applied is printed, never silently dropped. */
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
  /* «мин. часов»: a numeric field with −/+ steppers (step 1 hour).
     -1 = every game, 0 = default (only >0 h), N = ≥N h. Per-profile storage. */
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

  /* M4: tag bars weight (hours / count / SteamSpy weight). */
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

/**
 * Filter state is per owner (§8.5): the F2P/DLC switches of one profile must
 * not leak into another's dashboard. The legacy shared key is still read as a
 * fallback so an existing choice survives the migration.
 */
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
    /* corrupted storage — fall back to the server defaults */
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

/** Called by main.js when the games tab becomes active. */
export async function showGames() {
  state.active = true;
  if (state.onActivate) state.onActivate();
  hydrateJob();
  if (state.job) {
    // Progress is only honest while the job is the selected profile's job (or
    // has not resolved its owner yet). Otherwise the tab would open on an old
    // import instead of the profile the user is looking at.
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
  // The catalogue is server state (another browser can import a profile):
  // re-read it on activation, throttled so a tab flip-flop is cheap (P1a).
  await ensureProfiles({ reload: true, maxAgeMs: PROFILES_RELOAD_MS });
  // M6a: sanitized GOG status for the connect card (never a token).
  await ensureGogStatus();
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
  if ((state.view === 'dashboard' || state.view === 'connections') && state.data) {
    renderProfiles();
    if (state.view === 'dashboard' && !state.personnel.data && !state.personnel.loading) {
      ensurePersonnel(state.role);
    }
    // A silent background refresh keeps a long-lived tab honest (the library
    // may have changed on another device). The dashboard is rebuilt wholesale,
    // so the window scroll is restored explicitly — the books pattern.
    if (Date.now() - (state.loadedAt || 0) > 60_000) {
      await loadStats({ force: true, silent: true });
    }
    // M6c: the Epic slot is on its own 15 s timer; a tab activation is a good
    // moment to ask once more (the owner may have changed elsewhere).
    if (state.view === 'connections') requestEpicRefresh();
    return;
  }
  await loadStats({ force: true });
}

function hydrateJob() {
  if (state.job) return;
  const stored = readJob();
  if (!stored) return;
  // A resumed job may only speak for the owner it names. A stored job whose
  // profile is not the selected one is stale (the user switched, or another
  // profile was imported meanwhile): drop it instead of letting it drag the
  // tab onto an old import and overwrite `kinoboxd.games.profile.v1`.
  // An unresolved job (vanity import, `profile: ''`) belongs to the flow that
  // started it, so it is kept.
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

/** Called by main.js when another tab takes over. */
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
  // A new session must not open on a stale personnel URL.
  if (readViewParam()) writeViewParam('', { push: false });
}
