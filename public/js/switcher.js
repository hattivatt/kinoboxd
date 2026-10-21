/* Topbar profile switcher: current local profile, saved profiles list,
 * relative "updated" timestamps and per-row delete.
 */

import { $, el, clear, icon, plural } from './ui.js';

const MONTHS_SHORT = [
  'янв', 'фев', 'мар', 'апр', 'мая', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];

let bound = false;
let isOpen = false;
let handlers = { onSelect: null, onDelete: null, onAdd: null, onOpen: null };

function root() {
  return $('profile-switcher');
}

function menu() {
  return $('profile-menu');
}

function formatSavedAt(value) {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return 'дата неизвестна';
  const diff = Date.now() - ts;
  if (diff < 45 * 1000) return 'обновлён только что';
  if (diff < 60 * 60 * 1000) {
    const minutes = Math.max(1, Math.round(diff / 60000));
    return `обновлён ${minutes} ${plural(minutes, ['минуту', 'минуты', 'минут'])} назад`;
  }
  if (diff < 24 * 60 * 60 * 1000) {
    const hours = Math.max(1, Math.round(diff / 3600000));
    return `обновлён ${hours} ${plural(hours, ['час', 'часа', 'часов'])} назад`;
  }
  if (diff < 7 * 24 * 60 * 60 * 1000) {
    const days = Math.max(1, Math.round(diff / 86400000));
    return `обновлён ${days} ${plural(days, ['день', 'дня', 'дней'])} назад`;
  }
  const date = new Date(ts);
  return `обновлён ${date.getDate()} ${MONTHS_SHORT[date.getMonth()]} ${date.getFullYear()}`;
}

function setOpen(next) {
  isOpen = Boolean(next);
  const host = root();
  const panel = menu();
  const button = $('profile-btn');
  if (host) host.classList.toggle('is-open', isOpen);
  if (panel) panel.hidden = !isOpen;
  if (button) button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

export function closeProfileSwitcher() {
  if (isOpen) setOpen(false);
}

export function initProfileSwitcher(nextHandlers = {}) {
  handlers = { ...handlers, ...nextHandlers };
  if (bound) return;
  bound = true;

  const button = $('profile-btn');
  if (button) {
    button.addEventListener('click', () => {
      const willOpen = !isOpen;
      if (willOpen && typeof handlers.onOpen === 'function') handlers.onOpen();
      setOpen(willOpen);
    });
  }

  const add = $('profile-add');
  if (add) {
    add.addEventListener('click', () => {
      setOpen(false);
      if (typeof handlers.onAdd === 'function') handlers.onAdd();
    });
  }

  document.addEventListener('click', (event) => {
    const host = root();
    if (!isOpen || !host) return;
    if (host.contains(event.target)) return;
    setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (!isOpen || event.key !== 'Escape') return;
    setOpen(false);
    const trigger = $('profile-btn');
    if (trigger) trigger.focus();
  });
}

function buildRow(profile, active) {
  const item = el('div', {
    class: `profile-item${active ? ' is-active' : ''}`,
    role: 'option',
    'aria-selected': active ? 'true' : 'false',
    dataset: { profileId: profile.id },
  });

  const pick = el('button', {
    type: 'button',
    class: 'profile-pick',
    title: profile.label || '',
  });

  const badge = el('span', {
    class: `profile-kind${profile.type === 'kp' ? ' is-kp' : ' is-lb'}`,
    html: icon(profile.type === 'kp' ? 'kp' : 'film', 13),
  });

  const copy = el('span', { class: 'profile-copy' });
  copy.append(el('span', { class: 'profile-name', text: profile.label || 'Профиль' }));
  copy.append(el('span', {
    class: 'profile-meta',
    text: `${profile.type === 'kp' ? 'Кинопоиск' : 'Letterboxd'} · ${formatSavedAt(profile.savedAt)}`,
  }));

  pick.append(badge, copy);
  if (active) {
    pick.append(el('span', { class: 'profile-check', html: icon('check', 14) }));
  }
  pick.addEventListener('click', () => {
    if (typeof handlers.onSelect === 'function') handlers.onSelect(profile.id);
  });

  const del = el('button', {
    type: 'button',
    class: 'profile-del',
    title: 'Удалить профиль',
    'aria-label': `Удалить профиль ${profile.label || ''}`.trim(),
    html: icon('trash', 14),
  });
  del.addEventListener('click', (event) => {
    event.stopPropagation();
    if (typeof handlers.onDelete === 'function') handlers.onDelete(profile.id);
  });

  item.append(pick, del);
  return item;
}

export function renderProfileSwitcher({ profiles = [], activeId = null } = {}) {
  const host = root();
  if (!host) return;

  const active = profiles.find((profile) => profile.id === activeId) || null;
  const trigger = $('profile-btn-label');
  if (trigger) {
    trigger.textContent = active ? active.label : 'Профиль';
    trigger.title = active ? active.label : 'Сохранённые профили на этом устройстве';
  }
  host.classList.toggle('has-active', Boolean(active));

  const list = $('profile-list');
  if (!list) return;
  clear(list);

  if (!profiles.length) {
    list.append(el('div', { class: 'profile-empty', text: 'Пока нет сохранённых профилей' }));
    return;
  }

  for (const profile of profiles) {
    list.append(buildRow(profile, profile.id === activeId));
  }
}

export function setProfileSwitcherBusy(busy, text = '') {
  const host = root();
  if (!host) return;
  host.classList.toggle('is-busy', Boolean(busy));
  const label = $('profile-btn-label');
  if (label && text) label.textContent = text;
}
