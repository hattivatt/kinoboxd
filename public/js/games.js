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
} from './api.js';
import {
  $, el, clear, fmtInt, plural, icon, toast, errorBox, showTooltip, moveTooltip, hideTooltip,
  shortErrorMessage,
} from './ui.js';
import { withPreservedScroll } from './books-refresh.js';
import {
  normalizeGamesPayload, normalizeProfilesList, accountFromInput, profileCardView, summaryMetrics,
  paretoView, topHoursRows, backlogView, recentlyView, histogramView, lastPlayedInfo,
  importErrorText, jobStageText, jobProgress, gamesJobId, hoursText, HOURS_HINT,
} from './games-view.js';

const PROFILE_KEY = 'kinoboxd.games.profile.v1';
const JOB_KEY = 'kinoboxd.games.job.v1';
const POLL_INTERVAL = 1400;
const GAME_PLURAL = ['игра', 'игры', 'игр'];
const TOP_LIMIT = 10;
const BACKLOG_LIMIT = 24;

const state = {
  active: false,
  view: 'import', // import | progress | dashboard
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
  renderProfiles();
  await loadStats({ force: true });
}

async function ensureProfiles({ reload = false } = {}) {
  if (state.profilesLoaded && !reload) return state.profiles;
  try {
    const raw = await getGamesProfiles();
    state.profiles = normalizeProfilesList(raw);
    state.profilesLoaded = true;
    const flag = raw && typeof raw === 'object'
      ? (raw.steamKeyConfigured ?? raw.steamKey ?? null)
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
  if (!silent && state.view !== 'dashboard') showLoading(true);
  updateActions();
  try {
    const raw = await getGamesStats({ profile: state.profileKey });
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
    showScreen('dashboard');
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
      toast(shortErrorMessage(error), 'error', { duration: 7000 });
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
  renderHead(data);
  renderProfileCard(data);
  renderSummary(data);
  renderPartialNote(data);
  renderTopHours(data);
  renderPareto(data);
  renderBacklog(data);
  renderRecently(data);
  renderHistogram(data);
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
  const node = el('div', {
    class: `metric${descriptor.extraClass ? ` ${descriptor.extraClass}` : ''}`,
    title: descriptor.title || '',
  });
  const label = el('div', { class: 'metric-label' });
  label.innerHTML = icon(descriptor.icon || 'film', 12);
  label.append(document.createTextNode(` ${descriptor.label}`));
  node.append(label);
  node.append(el('div', { class: 'metric-value', text: descriptor.value }));
  if (descriptor.sub) node.append(el('div', { class: 'metric-sub', text: descriptor.sub }));
  return node;
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
    return;
  }
  host.hidden = false;
  for (const descriptor of metrics) host.append(metric(descriptor));
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
    const node = el('div', { class: 'genre-row is-ranked games-hours-row' });
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
      showTooltip(row.title, row.hint || HOURS_HINT);
      moveTooltip(event);
    });
    node.addEventListener('pointermove', moveTooltip);
    node.addEventListener('pointerleave', hideTooltip);
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
    const row = el('div', { class: 'games-list-row' });
    row.append(el('span', { class: 'games-list-name', text: item.name }));
    const meta = [item.yearText, item.genresText].filter(Boolean).join(' · ');
    row.append(el('span', { class: 'games-list-meta', text: meta }));
    host.append(row);
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
    const row = el('div', { class: 'games-recent-row', title: item.lastPlayedTitle });
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
      showTooltip(`${item.name} — ${item.hours2wText || 'нет часов'} за 2 недели`, item.hint);
      moveTooltip(event);
    });
    row.addEventListener('pointermove', moveTooltip);
    row.addEventListener('pointerleave', hideTooltip);
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
    const node = el('div', { class: 'genre-row games-hist-row', title: row.title });
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
      showTooltip(row.title, 'Бакеты по часам playtime_forever: длинный хвост библиотеки');
      moveTooltip(event);
    });
    node.addEventListener('pointermove', moveTooltip);
    node.addEventListener('pointerleave', hideTooltip);
  }
}

/* =========================================================
   wiring
   ========================================================= */

export function initGames({ onActivate } = {}) {
  state.onActivate = typeof onActivate === 'function' ? onActivate : null;
  state.profileKey = text(safeStorageGet(PROFILE_KEY));

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
  if (state.view === 'dashboard' && state.data) {
    renderProfiles();
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
  hideTooltip();
}

/** Drop every in-memory games artefact (logout / different session). */
export function resetGames() {
  stopPolling();
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
  saveJob();
  showScreen('import');
  renderProfiles();
  setKeyIndicator(null);
}
