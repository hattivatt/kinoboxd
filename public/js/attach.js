/* Letterboxd attachment modal for the active KinoPoisk profile.
 *
 * The archive is not a profile: it enriches the KinoPoisk dashboard with real
 * diary watch dates, rewatches and (stored for later) the watchlist. The
 * server persists it per kpUserId, so a browser reload or a server restart
 * keeps it attached.
 */

import { openModal } from './modal.js';
import { attachLbZip } from './api.js';
import { $, el, clear, icon, fmtInt, plural, toast, shortErrorMessage } from './ui.js';

let handlers = {
  getUploadId: null,
  getAttachment: null,
  onAttached: null,
};
let bound = false;

export function initAttach(nextHandlers = {}) {
  handlers = { ...handlers, ...nextHandlers };
  if (bound) return;
  bound = true;
  const button = $('attach-lb');
  if (!button) return;
  button.addEventListener('click', () => openAttachModal());
}

/** Show the topbar action only for a KP profile with a live upload. */
export function updateAttachButton({ active = false, attachment = null } = {}) {
  const button = $('attach-lb');
  if (!button) return;
  button.hidden = !active;
  button.classList.toggle('has-attachment', Boolean(attachment));
  const label = $('attach-lb-label');
  if (label) label.textContent = attachment ? 'Letterboxd прикреплён' : 'Прикрепить Letterboxd';
  button.title = attachment
    ? `Прикреплён ${attachment.fileName || 'ZIP-архив'} — заменить архив`
    : 'Прикрепить ZIP-архив Letterboxd к профилю Кинопоиска';
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
    }).format(date);
  } catch {
    return '';
  }
}

function isZip(file) {
  if (!file) return false;
  return /\.zip$/i.test(file.name || '')
    || ['application/zip', 'application/x-zip-compressed', 'multipart/x-zip'].includes(file.type || '');
}

function pluralEvents(count) {
  return plural(count, ['событие', 'события', 'событий']);
}

export function openAttachModal() {
  const uploadId = typeof handlers.getUploadId === 'function' ? handlers.getUploadId() : null;
  if (!uploadId) {
    toast('Сначала импортируйте профиль Кинопоиска — архив прикрепляется к нему.', 'info');
    return;
  }
  const attachment = typeof handlers.getAttachment === 'function'
    ? handlers.getAttachment()
    : null;

  const head = el('div', { class: 'modal-head' });
  head.append(el('div', { class: 'kicker', text: 'Letterboxd' }));
  head.append(el('h3', { class: 'modal-title', text: attachment ? 'Letterboxd-архив прикреплён' : 'Прикрепить Letterboxd-архив' }));

  const body = el('div', { class: 'modal-body attach-body' });

  if (attachment) {
    const card = el('div', { class: 'attach-current' });
    card.append(el('div', { class: 'attach-current-icon', html: icon('check', 18) }));
    const copy = el('div', { class: 'attach-current-copy' });
    copy.append(el('div', { class: 'attach-current-file', text: attachment.fileName || 'ZIP-архив' }));
    const when = formatDate(attachment.attachedAt);
    const parts = [
      when ? `прикреплён ${when}` : '',
      `${fmtInt(attachment.events)} ${pluralEvents(attachment.events)}`,
      `${fmtInt(attachment.ratedEvents)} с оценкой КП`,
    ].filter(Boolean);
    copy.append(el('div', { class: 'attach-current-meta', text: parts.join(' · ') }));
    card.append(copy);
    body.append(card);

    body.append(el('p', { class: 'attach-note', text: 'Новый архив заменит текущий целиком: старые события и пересмотры будут перезаписаны.' }));
  } else {
    body.append(el('p', { class: 'attach-note', text: 'ZIP из Letterboxd → Settings → Data. Даты просмотра из diary.csv заменят прокси-даты оценок Кинопоиска, а пересмотры попадут в статистику. Watchlist сохранится на сервере.' }));
  }

  const drop = el('div', {
    class: 'attach-drop',
    role: 'button',
    tabindex: '0',
    'aria-label': 'Выбрать ZIP-архив Letterboxd',
  });
  const dropIcon = el('div', { class: 'attach-drop-icon', html: icon('upload', 24) });
  const dropTitle = el('div', { class: 'attach-drop-title', text: attachment ? 'Перетащи новый архив' : 'Перетащи ZIP-архив сюда' });
  const dropHint = el('div', { class: 'attach-drop-hint', text: 'или нажми, чтобы выбрать файл · только .zip' });
  drop.append(dropIcon, dropTitle, dropHint);

  const input = el('input', {
    type: 'file',
    accept: '.zip,application/zip,application/x-zip-compressed',
    hidden: true,
  });

  const errorHost = el('div', { class: 'attach-error', hidden: true });

  const actions = el('div', { class: 'attach-actions' });
  const pick = el('button', {
    type: 'button',
    class: 'btn btn-primary',
    text: attachment ? 'Заменить архив' : 'Выбрать архив',
  });
  const cancel = el('button', { type: 'button', class: 'btn btn-ghost', text: 'Закрыть' });
  actions.append(pick, cancel);

  const spinner = el('span', { class: 'spinner spinner-sm attach-spinner', hidden: true, 'aria-hidden': 'true' });

  body.append(drop, input, errorHost, actions);

  let closed = false;
  let busy = false;
  let handle = null;

  const setBusy = (on, text = '') => {
    busy = Boolean(on);
    drop.classList.toggle('is-busy', busy);
    pick.disabled = busy;
    cancel.disabled = busy;
    dropTitle.textContent = busy
      ? (text || 'Прикрепляем архив…')
      : (attachment ? 'Перетащи новый архив' : 'Перетащи ZIP-архив сюда');
    dropHint.hidden = busy;
    spinner.hidden = !busy;
    if (!busy) return;
    drop.append(spinner);
  };

  const showError = (message) => {
    clear(errorHost);
    errorHost.append(el('p', { text: message }));
    errorHost.hidden = false;
  };

  const upload = async (file) => {
    if (busy || !file || closed) return;
    if (!isZip(file)) {
      showError('Нужен ZIP-архив Letterboxd (.zip).');
      return;
    }
    if (file.size === 0) {
      showError('Файл пустой — похоже, архив не скачался до конца.');
      return;
    }
    errorHost.hidden = true;
    setBusy(true, `Прикрепляем «${file.name}»…`);
    try {
      const result = await attachLbZip(uploadId, file);
      if (closed) return;
      const events = Number(result && result.events) || 0;
      const rewatches = Number(result && result.rewatchCount) || 0;
      toast(
        `Letterboxd-архив прикреплён: ${fmtInt(events)} ${pluralEvents(events)}, ` +
          `${fmtInt(rewatches)} ${plural(rewatches, ['пересмотр', 'пересмотра', 'пересмотров'])}.`,
        'success',
        { duration: 7000 }
      );
      if (handle) handle.close();
      if (typeof handlers.onAttached === 'function') await handlers.onAttached(result);
    } catch (error) {
      if (closed) return;
      showError(shortErrorMessage(error));
      setBusy(false);
    }
  };

  pick.addEventListener('click', () => {
    if (!busy) input.click();
  });
  drop.addEventListener('click', () => {
    if (!busy) input.click();
  });
  drop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!busy) input.click();
    }
  });
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (file) upload(file);
  });
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (!busy) drop.classList.add('is-dragover');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-dragover'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('is-dragover');
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) upload(file);
  });
  cancel.addEventListener('click', () => {
    if (handle) handle.close();
  });

  handle = openModal({
    head,
    body,
    className: 'attach-modal',
    onClose: () => {
      closed = true;
      document.removeEventListener('keydown', onEscape);
    },
  });

  // openModal already handles Escape; this only stops an in-flight upload
  // from touching a detached DOM.
  function onEscape(event) {
    if (event.key === 'Escape') closed = true;
  }
  document.addEventListener('keydown', onEscape);
}
