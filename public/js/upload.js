/* Upload screen: source picker (Letterboxd ZIP / Kinopoisk profile),
   dropzone, upload spinner, preview card and inline errors. */

import {
  $, el, clear, fmtInt, fmtPeriod, fmtBytes, plural, icon, errorBox,
} from './ui.js';

const KP_URL_RE = /kinopoisk\.ru\/user\/(\d+)/i;
const SOURCES = ['letterboxd', 'kinopoisk'];

let handlers = { onFile: null, onEnrich: null, onBack: null, onImport: null };
let bound = false;
let busy = false;
let importBusy = false;
let source = 'letterboxd';

function refs() {
  return {
    sourceBlock: $('upload-source'),
    tabs: Array.from(document.querySelectorAll('[data-source-tab]')),
    panels: Array.from(document.querySelectorAll('[data-source-panel]')),
    dropzone: $('dropzone'),
    content: $('dz-content'),
    busy: $('dz-busy'),
    busyName: $('dz-busy-name'),
    input: $('file-input'),
    preview: $('upload-preview'),
    error: $('upload-error'),
    back: $('back-to-dash'),
    kpForm: $('kp-form'),
    kpInput: $('kp-url'),
    kpError: $('kp-error'),
    kpSubmit: $('kp-submit'),
    kpSubmitLabel: $('kp-submit-label'),
  };
}

/* =========================================================
   source picker
   ========================================================= */

export function setSource(next) {
  if (!SOURCES.includes(next)) next = 'letterboxd';
  source = next;
  const r = refs();

  for (const tab of r.tabs) {
    const active = tab.dataset.sourceTab === next;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.tabIndex = active ? 0 : -1;
  }
  for (const panel of r.panels) {
    panel.hidden = panel.dataset.sourcePanel !== next;
  }
  if (next !== 'letterboxd' && r.dropzone) r.dropzone.classList.remove('is-dragover');
  return source;
}

export function clearKpError() {
  const r = refs();
  if (!r.kpError) return;
  clear(r.kpError);
  r.kpError.hidden = true;
  if (r.kpInput) r.kpInput.classList.remove('is-invalid');
}

export function showKpError(message) {
  const r = refs();
  if (!r.kpError) return;
  clear(r.kpError);
  r.kpError.textContent = message;
  r.kpError.hidden = false;
  if (r.kpInput) r.kpInput.classList.add('is-invalid');
}

export function setImportBusy(on) {
  importBusy = Boolean(on);
  const r = refs();
  if (r.kpSubmit) {
    r.kpSubmit.disabled = importBusy;
    r.kpSubmit.classList.toggle('is-busy', importBusy);
  }
  if (r.kpSubmitLabel) r.kpSubmitLabel.textContent = importBusy ? 'Запускаем импорт…' : 'Импорт';
  if (r.kpInput) r.kpInput.disabled = importBusy;
}

function submitImport() {
  if (importBusy) return;
  const r = refs();
  if (!r.kpInput) return;

  const raw = String(r.kpInput.value || '').trim();
  const match = raw.match(KP_URL_RE);
  if (!match) {
    showKpError('Не похоже на ссылку на профиль Кинопоиска. Пример: https://www.kinopoisk.ru/user/15702206/');
    r.kpInput.focus();
    return;
  }

  clearKpError();
  const kpUserId = match[1];
  const url = `https://www.kinopoisk.ru/user/${kpUserId}/`;
  if (typeof handlers.onImport === 'function') handlers.onImport({ url, kpUserId });
}

/* =========================================================
   init
   ========================================================= */

export function initUpload(nextHandlers = {}) {
  handlers = { ...handlers, ...nextHandlers };
  if (bound) return;
  bound = true;

  const r = refs();
  if (!r.dropzone || !r.input) return;

  for (const tab of r.tabs) {
    tab.addEventListener('click', () => {
      if (busy || importBusy) return;
      setSource(tab.dataset.sourceTab);
    });
    tab.addEventListener('keydown', (event) => {
      if (busy || importBusy) return;
      const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const index = SOURCES.indexOf(source);
      let next = index;
      if (event.key === 'ArrowRight') next = (index + 1) % SOURCES.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + SOURCES.length) % SOURCES.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = SOURCES.length - 1;
      const target = r.tabs.find((tab) => tab.dataset.sourceTab === SOURCES[next]);
      setSource(SOURCES[next]);
      if (target) target.focus();
    });
  }

  r.dropzone.addEventListener('click', () => {
    if (busy) return;
    r.input.click();
  });

  r.dropzone.addEventListener('keydown', (event) => {
    if (busy) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      r.input.click();
    }
  });

  r.input.addEventListener('change', () => {
    const file = r.input.files && r.input.files[0];
    // allow re-selecting the same file later
    r.input.value = '';
    if (file && typeof handlers.onFile === 'function') handlers.onFile(file);
  });

  r.dropzone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    if (busy) return;
    r.dropzone.classList.add('is-dragover');
  });
  r.dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    if (!busy) r.dropzone.classList.add('is-dragover');
  });
  r.dropzone.addEventListener('dragleave', (event) => {
    if (event.relatedTarget && r.dropzone.contains(event.relatedTarget)) return;
    r.dropzone.classList.remove('is-dragover');
  });
  r.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    r.dropzone.classList.remove('is-dragover');
    if (busy) return;
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file && typeof handlers.onFile === 'function') handlers.onFile(file);
  });

  if (r.kpForm) {
    r.kpForm.addEventListener('submit', (event) => {
      event.preventDefault();
      submitImport();
    });
  }

  if (r.kpInput) {
    r.kpInput.addEventListener('input', () => {
      if (!r.kpError || r.kpError.hidden) return;
      clearKpError();
    });
  }

  if (r.back) {
    r.back.addEventListener('click', () => {
      if (typeof handlers.onBack === 'function') handlers.onBack();
    });
  }

  setSource('letterboxd');
}

export function setHasSession(hasSession) {
  const r = refs();
  if (r.back) r.back.hidden = !hasSession;
}

export function setUploadBusy(on, fileName = '') {
  busy = Boolean(on);
  const r = refs();
  if (!r.dropzone || !r.content || !r.busy) return;

  for (const tab of r.tabs) tab.disabled = busy;
  if (r.kpInput) r.kpInput.disabled = busy || importBusy;
  if (r.kpSubmit) r.kpSubmit.disabled = busy || importBusy;

  if (on) {
    if (r.sourceBlock) r.sourceBlock.hidden = false;
    r.preview.hidden = true;
    r.error.hidden = true;
  }

  r.content.hidden = Boolean(on);
  r.busy.hidden = !on;
  r.dropzone.classList.toggle('is-busy', Boolean(on));
  r.dropzone.setAttribute('aria-busy', on ? 'true' : 'false');
  if (r.busyName) r.busyName.textContent = fileName || '';

  if (!on) {
    r.dropzone.classList.remove('is-dragover');
    // keep the source picker hidden when a successful preview replaced it
    r.dropzone.hidden = !r.preview.hidden;
    if (r.sourceBlock) r.sourceBlock.hidden = !r.preview.hidden;
  }
}

export function showUploadPreview(data, file) {
  const r = refs();
  if (!r.preview || !r.dropzone) return;

  const summary = data && data.summary && typeof data.summary === 'object' ? data.summary : {};
  const filmsArray = Array.isArray(data && data.films) ? data.films : [];
  const summaryFilms = Number(summary.films);
  const summaryRated = Number(summary.ratedFilms);
  const filmCount = Number.isFinite(summaryFilms) && summaryFilms > 0
    ? summaryFilms
    : filmsArray.length;
  const ratedCount = Number.isFinite(summaryRated) && summaryRated > 0
    ? summaryRated
    : filmsArray.filter((film) => film && film.rating != null).length;
  const diaryCount = Number.isFinite(Number(summary.diaryEntries)) ? Number(summary.diaryEntries) : null;

  clear(r.preview);

  const card = el('div', { class: 'result-card' });
  card.append(el('div', { class: 'result-check', html: icon('check', 23) }));
  card.append(el('div', { class: 'result-title', text: 'Архив распакован' }));

  const fileLine = el('div', { class: 'result-file' });
  fileLine.innerHTML = icon('film', 13);
  const fileName = file && file.name ? file.name : 'letterboxd-export.zip';
  const sizeLabel = file && file.size ? fmtBytes(file.size) : '';
  fileLine.append(el('span', {
    text: sizeLabel ? `${fileName} · ${sizeLabel}` : fileName,
    title: fileName,
  }));
  card.append(fileLine);

  const chips = el('div', { class: 'result-chips' });
  const chip = (value, label) => {
    const node = el('div', { class: 'result-chip' });
    node.append(el('b', { text: fmtInt(value) }));
    node.append(el('span', { text: label }));
    return node;
  };
  chips.append(chip(filmCount, plural(filmCount, ['фильм', 'фильма', 'фильмов'])));
  chips.append(chip(ratedCount, plural(ratedCount, ['оценка', 'оценки', 'оценок'])));
  if (diaryCount != null && diaryCount > 0) {
    chips.append(chip(diaryCount, plural(diaryCount, ['запись', 'записи', 'записей'])));
  }
  card.append(chips);

  const period = el('div', { class: 'result-period' });
  period.append(document.createTextNode('Период: '));
  period.append(el('b', { text: fmtPeriod(summary.dateFrom, summary.dateTo) }));
  card.append(period);

  const actions = el('div', { class: 'result-actions' });
  const start = el('button', { type: 'button', class: 'btn btn-primary', text: 'Начать обогащение' });
  start.addEventListener('click', () => {
    if (typeof handlers.onEnrich === 'function') handlers.onEnrich();
  });
  const another = el('button', { type: 'button', class: 'btn btn-ghost', text: 'Выбрать другой файл' });
  another.addEventListener('click', () => {
    const input = $('file-input');
    if (input) input.click();
  });
  actions.append(start, another);
  card.append(actions);

  card.append(el('p', {
    class: 'result-fine',
    text: 'Дальше сервер подтянет постеры, жанры и персоналии из TMDB. Обычно это занимает минуту-другую.',
  }));

  r.preview.append(card);
  r.preview.hidden = false;
  r.dropzone.hidden = true;
  if (r.sourceBlock) r.sourceBlock.hidden = true;
  r.error.hidden = true;
  if (r.busy) r.busy.hidden = true;
}

export function showUploadError(message, { onRetry, retryLabel = 'Повторить загрузку' } = {}) {
  const r = refs();
  if (!r.error) return;
  clear(r.error);

  setSource('letterboxd');

  const actions = [];
  if (onRetry) actions.push({ label: retryLabel, primary: true, onClick: onRetry });
  actions.push({
    label: 'Выбрать другой файл',
    onClick: () => {
      const input = $('file-input');
      if (input) input.click();
    },
  });

  r.error.append(errorBox({
    title: 'Не удалось обработать архив',
    message,
    actions,
  }));
  r.error.hidden = false;
  if (r.preview) r.preview.hidden = true;
  if (r.sourceBlock) r.sourceBlock.hidden = false;
  if (r.dropzone) {
    r.dropzone.hidden = false;
    if (r.content) r.content.hidden = false;
  }
}

export function clearUploadError() {
  const r = refs();
  if (!r.error) return;
  clear(r.error);
  r.error.hidden = true;
}

export function resetUpload() {
  const r = refs();
  busy = false;
  if (r.input) r.input.value = '';
  if (r.preview) {
    clear(r.preview);
    r.preview.hidden = true;
  }
  if (r.error) {
    clear(r.error);
    r.error.hidden = true;
  }
  if (r.sourceBlock) r.sourceBlock.hidden = false;
  if (r.dropzone) {
    r.dropzone.hidden = false;
    r.dropzone.classList.remove('is-busy', 'is-dragover');
    r.dropzone.setAttribute('aria-busy', 'false');
  }
  if (r.content) r.content.hidden = false;
  if (r.busy) r.busy.hidden = true;
  if (r.busyName) r.busyName.textContent = '';
  for (const tab of r.tabs) tab.disabled = false;
  if (r.kpInput) r.kpInput.value = '';
  clearKpError();
  setImportBusy(false);
  setSource('letterboxd');
}
