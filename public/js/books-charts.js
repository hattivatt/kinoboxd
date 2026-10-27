/* Book-specific charts: reading heatmap, streaks and the monthly timeline.
 *
 * The film dashboard's donut / year-bar primitives are reused as-is from
 * charts.js; only the pieces whose wording is domain-specific (просмотры →
 * книги, пересмотры → перечитывания) live here. No dependencies.
 */

import {
  el, clear, fmtInt, fmtPercent, monthName, monthShort, plural, toNum,
  showTooltip, moveTooltip, hideTooltip,
} from './ui.js';

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null) node.setAttribute(key, String(value));
  }
  return node;
}

function niceStep(raw) {
  if (raw <= 1) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / power;
  const base = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return Math.max(1, base * power);
}

/* =========================================================
   dates (shared with books.js)
   ========================================================= */

const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const MONTHS_SHORT_GEN = [
  'янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.',
  'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.',
];
const CAL_MONTHS = [
  'янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];

export function pad2(value) {
  return String(value).padStart(2, '0');
}

export function dateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** "25 октября 2026" */
export function fmtDayRu(value) {
  const parts = dateParts(value);
  if (!parts) return String(value || '');
  return `${parts.day} ${MONTHS_GEN[parts.month - 1]} ${parts.year}`;
}

/** "25 окт. 2026" */
export function fmtDayShortRu(value) {
  const parts = dateParts(value);
  if (!parts) return String(value || '');
  return `${parts.day} ${MONTHS_SHORT_GEN[parts.month - 1]} ${parts.year}`;
}

/** Days since epoch for a `YYYY-MM-DD` string (UTC, no DST). */
export function dayIndex(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').slice(0, 10));
  if (!match) return null;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000);
}

/** Days between today's local calendar date and a UTC `YYYY-MM-DD`. */
export function daysSince(value) {
  const parts = dateParts(value);
  if (!parts) return null;
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - Date.UTC(parts.year, parts.month - 1, parts.day)) / 86400000);
}

export function fmtDateRange(dates) {
  const list = Array.isArray(dates) ? dates.filter(dateParts) : [];
  if (!list.length) return '';
  const sorted = list.slice().sort();
  if (sorted.length === 1 || sorted[0] === sorted[sorted.length - 1]) {
    return fmtDayRu(sorted[0]);
  }
  const a = dateParts(sorted[0]);
  const b = dateParts(sorted[sorted.length - 1]);
  if (a.year === b.year && a.month === b.month) {
    return `${a.day}–${b.day} ${MONTHS_GEN[b.month - 1]} ${b.year}`;
  }
  if (a.year === b.year) {
    return `${a.day} ${MONTHS_GEN[a.month - 1]} — ${b.day} ${MONTHS_GEN[b.month - 1]} ${b.year}`;
  }
  return `${fmtDayRu(sorted[0])} — ${fmtDayRu(sorted[sorted.length - 1])}`;
}

/* =========================================================
   streak card
   ========================================================= */

/**
 * Server streaks, with a local fallback for payloads that only carry
 * `readDays`. The current run ends at the last reading day and does not
 * depend on today's date (same rule as the films dashboard).
 */
export function normalizeStreaks(raw, readDays = []) {
  const validDate = (value) => dayIndex(value) != null;
  if (raw && typeof raw === 'object') {
    const current = Math.max(0, toNum(raw.current));
    const best = Math.max(0, toNum(raw.best));
    const last = raw.lastReadDate || raw.last;
    const lastReadDate = validDate(last) ? String(last).slice(0, 10) : null;
    const bestDates = Array.isArray(raw.bestDates)
      ? raw.bestDates.map((date) => String(date).slice(0, 10)).filter(validDate)
      : [];
    if (best > 0 || lastReadDate) return { current, best, lastReadDate, bestDates };
  }

  const dates = (Array.isArray(readDays) ? readDays : [])
    .map((entry) => String((entry && entry.date) || '').slice(0, 10))
    .filter(validDate)
    .sort();
  if (!dates.length) return { current: 0, best: 0, lastReadDate: null, bestDates: [] };

  let best = 1;
  let bestFrom = dates[0];
  let bestTo = dates[0];
  let run = 1;
  let runStart = dates[0];
  for (let i = 1; i < dates.length; i += 1) {
    if (dayIndex(dates[i]) - dayIndex(dates[i - 1]) === 1) run += 1;
    else { run = 1; runStart = dates[i]; }
    if (run > best) { best = run; bestFrom = runStart; bestTo = dates[i]; }
  }
  let current = 1;
  for (let i = dates.length - 1; i > 0; i -= 1) {
    if (dayIndex(dates[i]) - dayIndex(dates[i - 1]) === 1) current += 1;
    else break;
  }
  return { current, best, lastReadDate: dates[dates.length - 1], bestDates: [bestFrom, bestTo] };
}

export function renderStreaks(host, streaks) {
  if (!host) return;
  clear(host);

  if (!streaks || !streaks.lastReadDate) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const current = Math.max(0, toNum(streaks.current));
  const best = Math.max(0, toNum(streaks.best));
  const currentWord = plural(current, ['день', 'дня', 'дней']);

  host.append(el('span', { class: 'streak-bolt', text: '⚡', 'aria-hidden': 'true' }));
  const main = el('span', { class: 'streak-main' });
  main.append(el('span', { class: 'streak-label', text: 'Серия:' }));
  main.append(el('b', { class: 'streak-num', text: fmtInt(current) }));
  main.append(el('span', { class: 'streak-unit', text: currentWord }));
  host.append(main);

  const meta = [];
  const range = fmtDateRange(streaks.bestDates);
  meta.push(`Рекорд: ${fmtInt(best)}${range ? ` (${range})` : ''}`);
  meta.push(`Последняя книга: ${fmtDayShortRu(streaks.lastReadDate)}`);
  host.append(el('span', { class: 'streak-meta', text: meta.join(' · ') }));

  const daysAgo = daysSince(streaks.lastReadDate);
  if (current > 0) {
    host.title = `Текущая серия: ${current} ${currentWord} подряд · последняя книга ${fmtDayRu(streaks.lastReadDate)}`;
  } else {
    host.title = daysAgo == null
      ? 'Нет данных о прочитанном'
      : `Последняя книга была ${daysAgo} ${plural(daysAgo, ['день', 'дня', 'дней'])} назад`;
  }
}

/* =========================================================
   reading heatmap
   ========================================================= */

function heatLevel(count) {
  const n = toNum(count);
  if (n <= 0) return 0;
  if (n === 1) return 1;
  if (n === 2) return 2;
  if (n === 3) return 3;
  return 4;
}

function buildYearCalendar(year, byDate, onDayClick) {
  const first = Date.UTC(year, 0, 1);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInYear = leap ? 366 : 365;
  const offset = (new Date(first).getUTCDay() + 6) % 7; // Monday = 0
  const columns = Math.ceil((offset + daysInYear) / 7);
  const pitch = 13; // 11px cell + 2px gap; keep in sync with CSS

  const row = el('div', { class: 'cal-year', dataset: { year: String(year) } });
  row.append(el('div', { class: 'cal-year-label', text: String(year) }));

  const scroll = el('div', { class: 'cal-scroll' });
  const months = el('div', {
    class: 'cal-months',
    style: { width: `${columns * pitch}px` },
    'aria-hidden': 'true',
  });

  let lastLabelColumn = -10;
  let monthStartDay = 0;
  for (let month = 0; month < 12; month += 1) {
    const column = Math.floor((offset + monthStartDay) / 7);
    if (column - lastLabelColumn >= 2) {
      months.append(el('span', {
        class: 'cal-month-label',
        text: CAL_MONTHS[month],
        style: { left: `${column * pitch}px` },
      }));
      lastLabelColumn = column;
    }
    monthStartDay += new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  }

  const grid = el('div', {
    class: 'cal-grid',
    role: 'grid',
    'aria-label': `Календарь чтения, ${year}`,
    style: { gridTemplateColumns: `repeat(${columns}, 11px)` },
  });

  const totalCells = columns * 7;
  for (let index = 0; index < totalCells; index += 1) {
    const dayOfYear = index - offset;
    if (dayOfYear < 0 || dayOfYear >= daysInYear) {
      grid.append(el('span', { class: 'cal-cell is-blank', 'aria-hidden': 'true' }));
      continue;
    }
    const dateObj = new Date(first + dayOfYear * 86400000);
    const date = `${year}-${pad2(dateObj.getUTCMonth() + 1)}-${pad2(dateObj.getUTCDate())}`;
    const day = byDate.get(date) || null;
    const count = day ? toNum(day.count) : 0;
    const reRead = day ? Math.max(0, toNum(day.reReadCount)) : 0;
    const countLabel = `${fmtInt(count)} ${plural(count, ['книга', 'книги', 'книг'])}`;
    const reReadLabel = `${fmtInt(reRead)} ${plural(reRead, ['перечитка', 'перечитки', 'перечитываний'])}`;
    const dayTitle = count > 0
      ? `${date} — ${countLabel}${reRead > 0 ? ` (в т.ч. ${reReadLabel})` : ''}`
      : `${date} — нет прочитанных книг`;
    const cell = el(day && count > 0 ? 'button' : 'span', {
      class: `cal-cell cal-level-${heatLevel(count)}${count > 0 ? ' is-active' : ''}${reRead > 0 ? ' has-rewatch' : ''}`,
      dataset: { date, count: String(count), reRead: String(reRead) },
      title: dayTitle,
      role: 'gridcell',
      'aria-label': dayTitle,
    });
    if (day && count > 0) {
      cell.type = 'button';
      cell.addEventListener('pointerenter', (event) => {
        showTooltip(
          dayTitle,
          reRead > 0 ? 'в том числе перечитывания · нажмите, чтобы увидеть книги' : 'нажмите, чтобы увидеть книги',
        );
        moveTooltip(event);
      });
      cell.addEventListener('pointermove', moveTooltip);
      cell.addEventListener('pointerleave', hideTooltip);
      cell.addEventListener('click', () => {
        hideTooltip();
        if (typeof onDayClick === 'function') onDayClick(day);
      });
    }
    grid.append(cell);
  }

  scroll.append(months, grid);
  row.append(scroll);
  return row;
}

/**
 * Multi-year reading heatmap.
 *
 * @param {HTMLElement} host
 * @param {Array<{date:string,count:number,reReadCount?:number}>} days
 * @param {{onDayClick?: (day:object)=>void}} [opts]
 */
export function renderReadingCalendar(host, days, { onDayClick } = {}) {
  if (!host) return;
  clear(host);
  const list = (Array.isArray(days) ? days : [])
    .filter((day) => day && /^\d{4}-\d{2}-\d{2}$/.test(String(day.date || '').slice(0, 10)));
  if (!list.length) {
    host.append(el('div', { class: 'empty-state', text: 'Нет дат прочтения в выбранных источниках' }));
    return;
  }

  const byDate = new Map(list.map((day) => [String(day.date).slice(0, 10), day]));
  const years = [...new Set(list.map((day) => Number(String(day.date).slice(0, 4))))]
    .filter((year) => Number.isFinite(year) && year > 0)
    .sort((a, b) => a - b);

  for (let year = years[0]; year <= years[years.length - 1]; year += 1) {
    host.append(buildYearCalendar(year, byDate, onDayClick));
  }
}

/* =========================================================
   monthly timeline
   ========================================================= */

/**
 * Monthly bar chart of finished books. Mirrors charts.js#renderTimeline but
 * uses book wording and shows the per-source split in the tooltip.
 *
 * @param {HTMLElement} host
 * @param {Array<{month:string,finished:number,reRead?:number,livelib?:number,hardcover?:number}>} timeline
 * @param {{onMonthClick?: (month:string)=>void}} [opts]
 */
export function renderBooksTimeline(host, timeline, { onMonthClick } = {}) {
  const data = (Array.isArray(timeline) ? timeline : [])
    .filter((item) => item && typeof item.month === 'string' && /^\d{4}-\d{2}$/.test(item.month))
    .map((item) => ({
      ...item,
      finished: Math.max(0, toNum(item.finished)),
      reRead: Math.max(0, toNum(item.reRead)),
      livelib: Math.max(0, toNum(item.livelib)),
      hardcover: Math.max(0, toNum(item.hardcover)),
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  clear(host);
  if (!data.length) {
    host.append(el('div', { class: 'empty-state', text: 'Нет прочитанных книг с датами' }));
    return;
  }

  const baseWidth = Math.max(host.clientWidth || 0, 320);
  const minStep = data.length > 80 ? 15 : 22;
  const width = Math.ceil(Math.max(baseWidth, data.length * minStep + 56));
  const height = 288;
  const pad = { left: 38, right: 12, top: 14, bottom: 34 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const stepX = plotW / data.length;
  const barW = Math.max(2.4, Math.min(20, stepX * 0.62));

  const maxValue = Math.max(1, ...data.map((d) => d.finished));
  const step = niceStep(maxValue / 4);
  let ticks = Math.ceil(maxValue / step);
  if (ticks < 2) ticks = 2;
  const scaleMax = step * ticks;

  const svg = svgEl('svg', {
    width, height,
    viewBox: `0 0 ${width} ${height}`,
    class: 'timeline-svg',
    role: 'img',
    'aria-label': `Прочитанные книги по месяцам: ${monthName(data[0].month)} — ${monthName(data[data.length - 1].month)}`,
  });

  for (let i = 0; i <= ticks; i += 1) {
    const value = i * step;
    const y = pad.top + plotH - (value / scaleMax) * plotH;
    svg.append(svgEl('line', {
      x1: pad.left, x2: width - pad.right, y1: y, y2: y,
      class: `tl-grid${i === 0 ? ' base' : ''}`,
    }));
    const label = svgEl('text', {
      x: pad.left - 8,
      y: y + 3,
      'text-anchor': 'end',
      class: 'tl-tick',
    });
    label.textContent = fmtInt(value);
    svg.append(label);
  }

  data.forEach((item, index) => {
    const x = pad.left + index * stepX + (stepX - barW) / 2;
    const h = (item.finished / scaleMax) * plotH;
    const y = pad.top + plotH - h;

    const bar = svgEl('rect', {
      x, y,
      width: barW,
      height: Math.max(h, 0),
      rx: Math.min(2.5, barW / 2),
      class: 'tl-bar',
    });
    bar.style.animationDelay = `${Math.min(index * 5, 260)}ms`;
    svg.append(bar);

    const hit = svgEl('rect', {
      x: pad.left + index * stepX,
      y: pad.top,
      width: stepX,
      height: plotH,
      class: 'tl-hit',
    });

    hit.addEventListener('pointerenter', (event) => {
      bar.classList.add('is-hot');
      const books = `${fmtInt(item.finished)} ${plural(item.finished, ['книга', 'книги', 'книг'])}`;
      const reReads = item.reRead > 0
        ? ` (в т.ч. ${fmtInt(item.reRead)} ${plural(item.reRead, ['перечитка', 'перечитки', 'перечитываний'])})`
        : '';
      const sources = [];
      if (item.livelib > 0) sources.push(`LiveLib ${fmtInt(item.livelib)}`);
      if (item.hardcover > 0) sources.push(`Hardcover ${fmtInt(item.hardcover)}`);
      showTooltip(
        `${monthName(item.month)} — ${books}${reReads}`,
        sources.length ? sources.join(' · ') : `${fmtPercent(item.finished, data.reduce((sum, d) => sum + d.finished, 0))} всех книг`,
      );
      moveTooltip(event);
    });
    hit.addEventListener('pointermove', moveTooltip);
    hit.addEventListener('pointerleave', () => {
      bar.classList.remove('is-hot');
      hideTooltip();
    });

    if (item.finished > 0 && typeof onMonthClick === 'function') {
      hit.classList.add('is-clickable');
      hit.setAttribute('data-month', item.month);
      hit.setAttribute('role', 'button');
      hit.setAttribute('tabindex', '0');
      hit.setAttribute('aria-label',
        `${monthName(item.month)}: ${fmtInt(item.finished)} ${plural(item.finished, ['книга', 'книги', 'книг'])} — открыть список`);
      const activate = () => {
        hideTooltip();
        onMonthClick(item.month);
      };
      hit.addEventListener('click', activate);
      hit.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activate();
      });
    }
    svg.append(hit);
  });

  const labels = [];
  if (data.length > 14) {
    data.forEach((item, index) => {
      if (item.month.endsWith('-01')) labels.push({ index, text: item.month.slice(0, 4) });
    });
    if (!labels.length) {
      const every = Math.max(1, Math.ceil(data.length / 6));
      for (let i = 0; i < data.length; i += every) labels.push({ index: i, text: monthShort(data[i].month) });
    }
  } else {
    const every = data.length > 8 ? 2 : 1;
    for (let i = 0; i < data.length; i += every) labels.push({ index: i, text: monthShort(data[i].month) });
  }

  const drawn = [];
  for (const label of labels) {
    const cx = pad.left + label.index * stepX + stepX / 2;
    if (drawn.length && cx - drawn[drawn.length - 1].cx < 34) continue;
    drawn.push({ cx, text: label.text });
  }

  for (const label of drawn) {
    const text = svgEl('text', {
      x: label.cx,
      y: height - 12,
      'text-anchor': 'middle',
      class: 'tl-xlabel',
    });
    text.textContent = label.text;
    svg.append(text);
  }

  host.append(svg);
}
