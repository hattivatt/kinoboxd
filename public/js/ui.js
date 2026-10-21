/* Small DOM / formatting / feedback helpers shared by all modules. */

const numberFmt = new Intl.NumberFormat('ru-RU');

const MONTHS_FULL = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];
const MONTHS_SHORT = [
  'янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.',
  'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.',
];

export const $ = (id) => document.getElementById(id);

export function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Tiny hyperscript helper: el('div', { class: 'x' }, child, 'text') */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value; // static markup only
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

export function fmtInt(value) {
  return numberFmt.format(Math.round(toNum(value)));
}

export function fmtRating(value) {
  if (value == null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(1).replace('.', ',');
}

export function fmtPercent(part, total) {
  const p = toNum(total) > 0 ? (toNum(part) / toNum(total)) * 100 : 0;
  if (p > 0 && p < 0.1) return '<0,1%';
  return `${p.toFixed(1).replace('.', ',')}%`;
}

/** Russian plural: plural(3, ['фильм','фильма','фильмов']) → 'фильма' */
export function plural(n, forms) {
  const abs = Math.abs(Math.round(toNum(n))) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

export function fmtWatchTime(minutes) {
  const total = Math.max(0, Math.round(toNum(minutes)));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days > 0) {
    return {
      value: `${fmtInt(days)} д ${hours} ч`,
      sub: `≈ ${fmtInt(total / 60)} ч всего`,
      title: `${fmtInt(total)} минут · ${fmtInt(days * 24 + hours)} ч ${mins} мин`,
    };
  }
  if (hours > 0) {
    return {
      value: `${hours} ч ${mins} м`,
      sub: `≈ ${fmtInt(total)} мин`,
      title: `${fmtInt(total)} минут`,
    };
  }
  return { value: `${mins} м`, sub: '', title: `${fmtInt(total)} минут` };
}

function parseDate(value) {
  if (!value || typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!year || month < 1 || month > 12) return null;
  return { year, month };
}

export function fmtPeriod(from, to) {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a && !b) return 'период неизвестен';
  if (a && b) {
    if (a.year === b.year && a.month === b.month) {
      return `${MONTHS_SHORT[a.month - 1]} ${a.year}`;
    }
    if (a.year === b.year) {
      return `${MONTHS_SHORT[a.month - 1]} — ${MONTHS_SHORT[b.month - 1]} ${b.year}`;
    }
    return `${MONTHS_SHORT[a.month - 1]} ${a.year} — ${MONTHS_SHORT[b.month - 1]} ${b.year}`;
  }
  const only = a || b;
  return `${MONTHS_SHORT[only.month - 1]} ${only.year}`;
}

export function monthName(value) {
  const parsed = parseDate(value);
  if (!parsed) return String(value || '');
  return `${MONTHS_FULL[parsed.month - 1]} ${parsed.year}`;
}

export function monthShort(value) {
  const parsed = parseDate(value);
  if (!parsed) return String(value || '');
  return `${MONTHS_SHORT[parsed.month - 1]} ${String(parsed.year).slice(2)}`;
}

export function fmtBytes(bytes) {
  const n = toNum(bytes);
  if (n <= 0) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} КБ`;
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
}

export function slugTitle(slug) {
  if (!slug) return 'Без названия';
  return String(slug).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function debounce(fn, wait = 150) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/* =========================================================
   icons (static trusted markup)
   ========================================================= */

const ICONS = {
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  star: '<path d="M12 3.6l2.6 5.2 5.8.9-4.2 4.1 1 5.7-5.2-2.7-5.2 2.7 1-5.7-4.2-4.1 5.8-.9z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V13M12 16.5v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.01"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.1"/><path d="M20 5v6h-6"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19v-1.4A4.1 4.1 0 0 1 7.6 13.5h2.8a4.1 4.1 0 0 1 4.1 4.1V19"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 13.6a4.1 4.1 0 0 1 3 4V19"/>',
  upload: '<path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  kp: '<path d="M6 4v16M19.5 4 8.5 12l11 8"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4.8h6V7"/><path d="M6.5 7l0.9 13h9.2l0.9-13"/><path d="M10 11v5M14 11v5"/>',
};

const FILLED = new Set(['star']);

export function icon(name, size = 16) {
  const body = ICONS[name] || '';
  const paint = FILLED.has(name)
    ? 'fill="currentColor" stroke="none"'
    : 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" ${paint} aria-hidden="true">${body}</svg>`;
}

/* =========================================================
   tooltip
   ========================================================= */

let tooltipEl = null;

function ensureTooltip() {
  if (!tooltipEl) tooltipEl = document.getElementById('tooltip');
  return tooltipEl;
}

export function showTooltip(primary, secondary) {
  const tip = ensureTooltip();
  if (!tip) return;
  clear(tip);
  tip.append(el('div', { class: 'tooltip-primary', text: primary }));
  if (secondary) tip.append(el('div', { class: 'tooltip-secondary', text: secondary }));
  tip.hidden = false;
}

export function moveTooltip(event) {
  const tip = ensureTooltip();
  if (!tip || tip.hidden) return;
  const point = event.touches ? event.touches[0] : event;
  if (!point) return;
  const pad = 14;
  const rect = tip.getBoundingClientRect();
  let left = point.clientX + pad;
  let top = point.clientY - rect.height - pad;
  if (left + rect.width > window.innerWidth - 8) left = point.clientX - rect.width - pad;
  if (left < 8) left = 8;
  if (top < 8) top = point.clientY + pad;
  if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8;
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

export function hideTooltip() {
  const tip = ensureTooltip();
  if (tip) tip.hidden = true;
}

/* =========================================================
   toasts
   ========================================================= */

const TOAST_ICON = { success: 'check', error: 'alert', info: 'info' };

export function toast(message, type = 'info', { duration = 5200 } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return () => {};
  const allow = new Set(['success', 'error', 'info']);
  const kind = allow.has(type) ? type : 'info';

  const node = el('div', { class: `toast is-${kind}`, role: 'status' });
  node.append(el('span', { class: 'toast-icon', html: icon(TOAST_ICON[kind], 15) }));
  node.append(el('span', { class: 'toast-message', text: message }));
  const close = el('button', { class: 'toast-close', type: 'button', 'aria-label': 'Закрыть уведомление', text: '×' });
  node.append(close);

  let removed = false;
  const dismiss = () => {
    if (removed) return;
    removed = true;
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 230);
  };
  close.addEventListener('click', dismiss);

  while (host.children.length >= 4) host.firstElementChild.remove();
  host.append(node);

  if (duration > 0) setTimeout(dismiss, duration);
  return dismiss;
}

/* =========================================================
   inline error block
   ========================================================= */

export function errorBox({ title, message, actions = [], tone = 'error' }) {
  const box = el('div', {
    class: `inline-error${tone === 'info' ? ' is-info' : ''}`,
    role: tone === 'info' ? 'status' : 'alert',
  });
  box.append(el('strong', { text: title || 'Что-то пошло не так' }));
  if (message) box.append(el('p', { text: message }));
  if (actions.length) {
    const row = el('div', { class: 'inline-actions' });
    for (const action of actions) {
      if (!action) continue;
      const button = el('button', {
        type: 'button',
        class: `btn ${action.primary ? 'btn-primary' : 'btn-ghost'}`,
        text: action.label || 'Повторить',
      });
      button.addEventListener('click', action.onClick);
      row.append(button);
    }
    box.append(row);
  }
  return box;
}

export function emptyState(text) {
  return el('div', { class: 'empty-state', text });
}

export function shortErrorMessage(error) {
  if (!error) return 'Неизвестная ошибка.';
  const message = typeof error.message === 'string' ? error.message.trim() : '';
  if (error.code === 'network') return 'Нет связи с сервером. Проверь, что он запущен, и попробуй ещё раз.';
  if (error.status === 413) return 'Архив слишком большой для загрузки.';
  if (error.status === 404) return 'Выгрузка не найдена на сервере — возможно, сервер перезапускался.';
  if (error.status === 400) return 'Данные ещё не готовы. Попробуй через пару секунд.';
  if (error.status >= 500) return 'Сервер не смог обработать запрос. Попробуй ещё раз.';
  if (message && message.length <= 220) return message;
  return 'Не удалось выполнить запрос.';
}
