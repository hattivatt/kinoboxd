import { $, icon, plural } from './ui.js';
import { renderProfileBar } from './core/shell.js';

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

function profileItems(profiles, activeId) {
  return profiles.map((profile) => {
    const active = profile.id === activeId;
    return {
      id: profile.id,
      label: profile.label || 'Профиль',
      title: profile.label || '',
      active,
      badgeHtml: icon(profile.type === 'kp' ? 'kp' : 'film', 13),
      badgeClass: `profile-kind${profile.type === 'kp' ? ' is-kp' : ' is-lb'}`,
      meta: `${profile.type === 'kp' ? 'Кинопоиск' : 'Letterboxd'} · ${formatSavedAt(profile.savedAt)}`,
      checkHtml: icon('check', 14),
      deleteHtml: icon('trash', 14),
      deleteLabel: `Удалить профиль ${profile.label || ''}`.trim(),
    };
  });
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
  renderProfileBar({
    list,
    add: $('profile-add'),
    items: profileItems(profiles, activeId),
    emptyText: profiles.length ? '' : 'Пока нет сохранённых профилей',
    onSelect: (id) => {
      if (typeof handlers.onSelect === 'function') handlers.onSelect(id);
    },
    onDelete: (id) => {
      if (typeof handlers.onDelete === 'function') handlers.onDelete(id);
    },
  });
}

export function setProfileSwitcherBusy(busy, text = '') {
  const host = root();
  if (!host) return;
  host.classList.toggle('is-busy', Boolean(busy));
  const label = $('profile-btn-label');
  if (label && text) label.textContent = text;
}
