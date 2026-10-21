/* Entry point: boot → upload → enrich (poll) → dashboard. */

import {
  uploadZip, startEnrich, getEnrichStatus, getStats,
  startKinopoiskImport, getKinopoiskStatus,
} from './api.js';
import {
  initUpload, setUploadBusy, showUploadPreview, showUploadError, clearUploadError,
  resetUpload, setHasSession, setSource, showKpError, setImportBusy,
} from './upload.js';
import { renderDashboard } from './widgets.js';
import { $, clear, toast, errorBox, shortErrorMessage, toNum, fmtInt } from './ui.js';

const SESSION_KEY = 'kinoboxd.session.v1';
const LEGACY_SESSION_KEY = 'boxdstats.session.v1';
const POLL_INTERVAL = 1000;

const state = {
  view: 'boot',
  uploadId: null,
  uploadSummary: null,
  uploadFilms: null,
  stats: null,
  dashboardReady: false,
  currentFile: null,
  uploading: false,
  enrichStarting: false,
  importSource: 'letterboxd',
  importStarting: false,
  importStage: 'scrape',
  kp: null,
  importToast: null,
  pollTimer: 0,
  pollMode: null,
  idlePolls: 0,
  statusMisses: 0,
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
    if (parsed && typeof parsed.uploadId === 'string' && parsed.uploadId) return parsed;
  } catch {
    /* private mode / corrupted storage — ignore */
  }
  return null;
}

function saveSession() {
  if (!state.uploadId) return;
  try {
    const payload = {
      uploadId: state.uploadId,
      summary: state.uploadSummary || null,
      source: state.importSource,
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
  try {
    window.localStorage.removeItem(SESSION_KEY);
    window.localStorage.removeItem(LEGACY_SESSION_KEY);
  } catch {
    /* ignore */
  }
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
          state.uploadId = null;
          state.uploadSummary = null;
          state.uploadFilms = null;
          state.stats = null;
          state.dashboardReady = false;
          state.importSource = 'letterboxd';
          state.kp = null;
          resetUpload();
          setHasSession(false);
          showView('upload');
        },
      },
    ],
  }));
  host.hidden = false;
}

async function boot() {
  showView('boot');
  setBootMode('loading', 'Проверяем прошлую выгрузку…');
  const host = $('boot-error');
  if (host) {
    clear(host);
    host.hidden = true;
  }

  const saved = readSession();
  if (!saved) {
    state.uploadId = null;
    resetUpload();
    setHasSession(false);
    showView('upload');
    return;
  }

  state.uploadId = saved.uploadId;
  state.uploadSummary = saved.summary || null;
  state.importSource = saved.source === 'kinopoisk' ? 'kinopoisk' : 'letterboxd';
  state.kp = state.importSource === 'kinopoisk' && saved.kp && typeof saved.kp === 'object'
    ? saved.kp
    : null;

  if (state.importSource === 'kinopoisk' && await resumeKinopoiskIfRunning()) return;

  try {
    const stats = await getStats(state.uploadId);
    applyStats(stats);
  } catch (error) {
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
      clearSession();
      state.uploadId = null;
      state.uploadSummary = null;
      state.stats = null;
      state.dashboardReady = false;
      state.importSource = 'letterboxd';
      state.kp = null;
      resetUpload();
      setHasSession(false);
      showView('upload');
      toast('Прошлая выгрузка недоступна на сервере — загрузи архив или профиль заново.', 'info');
      return;
    }
    bootError(error);
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
    if (stage === 'enrich') {
      applyEnrichStage(status);
    } else {
      applyScrapeStage(status);
    }
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

function applyStats(stats) {
  if (!stats || typeof stats !== 'object') {
    bootError(new Error('Сервер вернул пустой ответ статистики.'));
    return;
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
  }
  state.stats = stats;
  state.dashboardReady = true;
  setHasSession(Boolean(state.uploadId));
  showView('dashboard');
  try {
    renderDashboard(stats);
  } catch (error) {
    console.error('[kinoboxd] dashboard render failed', error);
    toast('Не удалось отрисовать часть статистики. Попробуй обновить страницу.', 'error', { duration: 8000 });
  }
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

    saveSession();
    setHasSession(false);
    showUploadPreview(data, file);

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
  resetUpload();
  setHasSession(Boolean(state.stats && state.dashboardReady));
  showView('upload');
}

function newUploadFromScratch(source = 'letterboxd') {
  stopPolling();
  dismissImportToast();
  clearSession();
  state.uploadId = null;
  state.uploadSummary = null;
  state.uploadFilms = null;
  state.stats = null;
  state.dashboardReady = false;
  state.importSource = source === 'kinopoisk' ? 'kinopoisk' : 'letterboxd';
  state.kp = null;
  resetUpload();
  setSource(state.importSource);
  setHasSession(false);
  showView('upload');
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

function applyScrapeStage(status) {
  setStepper('scrape');
  state.importStage = 'scrape';

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

async function handleKinopoiskImport({ url, kpUserId } = {}) {
  if (state.importStarting || !url) return;
  state.importStarting = true;
  setImportBusy(true);

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

    saveSession();
    setHasSession(false);
    setImportBusy(false);
    resetUpload();

    showView('enrich');
    prepareKinopoiskProgress();
    if (data.stage === 'enrich' || (data.done && data.stage !== 'scrape')) {
      applyEnrichStage(data);
    }
    startKinopoiskPolling();
    state.importToast = toast('Импорт с Кинопоиска запущен', 'info', { duration: 5000 });
  } catch (error) {
    setImportBusy(false);
    showView('upload');
    setSource('kinopoisk');
    showKpError(importErrorMessage(error));
    toast('Не удалось начать импорт', 'error');
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

async function handleStartEnrich() {
  if (!state.uploadId || state.enrichStarting) return;
  state.enrichStarting = true;

  showView('enrich');
  prepareProgress();
  setProgressStatus('Запускаем обогащение…');

  try {
    const result = await startEnrich(state.uploadId);
    if (state.view !== 'enrich') return;

    if (result && typeof result === 'object') {
      const total = Number.isFinite(Number(result.total)) ? Number(result.total) : estimateTotal();
      const matched = Number.isFinite(Number(result.cached)) ? Number(result.cached) : 0;
      setProgress({ matched, total, failed: 0, done: false });
      if (total > 0) setProgressStatus(`Найдено ${fmtInt(Math.min(matched, total))} из ${fmtInt(total)}`);
    }
    startPolling();
  } catch (error) {
    if (state.view !== 'enrich') return;
    if (error && (error.status === 404 || error.status === 410)) {
      clearSession();
      state.uploadId = null;
      setProgressStatus('Выгрузка не найдена на сервере');
      showProgressError(shortErrorMessage(error), null);
      return;
    }
    setProgressStatus('Не удалось запустить обогащение');
    showProgressError(shortErrorMessage(error), handleStartEnrich);
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
      await finishStats(0);
      return;
    }

    if (stage === 'enrich') applyEnrichStage(status);
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
    toast('Статистика готова — приятного просмотра цифр.', 'success', { duration: 3400 });
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
  initUpload({
    onFile: handleFile,
    onEnrich: handleStartEnrich,
    onImport: handleKinopoiskImport,
    onBack: () => {
      if (state.stats && state.dashboardReady) showView('dashboard');
    },
  });

  const replace = $('replace-upload');
  if (replace) replace.addEventListener('click', openUploadScreen);

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
