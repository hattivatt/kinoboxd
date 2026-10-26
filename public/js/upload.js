/* Upload screen: the single «Профиль Кинопоиска» panel, optional
   «Прикрепить Letterboxd-архив» action and inline errors.

   Letterboxd is not a source anymore: its ZIP is attached to an already
   imported KinoPoisk profile (topbar button or the secondary action here). */

import { $, clear } from './ui.js';

const KP_URL_RE = /kinopoisk\.ru\/user\/(\d+)/i;

let handlers = { onImport: null, onBack: null, onAttach: null };
let bound = false;
let importBusy = false;

function refs() {
  return {
    kpForm: $('kp-form'),
    kpInput: $('kp-url'),
    kpError: $('kp-error'),
    kpSubmit: $('kp-submit'),
    kpSubmitLabel: $('kp-submit-label'),
    back: $('back-to-dash'),
    attach: $('upload-attach-lb'),
    attachHint: $('upload-attach-hint'),
  };
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

export function initUpload(nextHandlers = {}) {
  handlers = { ...handlers, ...nextHandlers };
  if (bound) return;
  bound = true;

  const r = refs();
  if (!r.kpForm) return;

  r.kpForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitImport();
  });

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

  if (r.attach) {
    r.attach.addEventListener('click', () => {
      if (r.attach.disabled) return;
      if (typeof handlers.onAttach === 'function') handlers.onAttach();
    });
  }
}

export function setHasSession(hasSession) {
  const r = refs();
  if (r.back) r.back.hidden = !hasSession;
}

/** The secondary attach action only works once an active KP upload exists. */
export function setAttachAvailable(available) {
  const r = refs();
  if (r.attach) {
    r.attach.disabled = !available;
    r.attach.classList.toggle('is-disabled', !available);
  }
  if (r.attachHint) {
    r.attachHint.textContent = available
      ? 'ZIP из Letterboxd → Settings → Data. Даты просмотра и пересмотры заменят прокси-даты оценок.'
      : 'Сначала импортируйте профиль Кинопоиска — архив прикрепляется к нему.';
  }
}

export function resetUpload() {
  const r = refs();
  if (r.kpInput) r.kpInput.value = '';
  clearKpError();
  setImportBusy(false);
  setAttachAvailable(false);
}
