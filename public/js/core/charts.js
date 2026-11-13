import { el, fmtInt, plural, toNum, showTooltip, moveTooltip, hideTooltip } from '../ui.js';

const NS = 'http://www.w3.org/2000/svg';

const CAL_MONTHS_SHORT = [
  'янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];
const CAL_MONTHS_GAMES = ['янв', 'февр', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сент', 'окт', 'нояб', 'дек'];
const ACHIEVEMENT_FORMS = ['достижение', 'достижения', 'достижений'];
const GAME_FORMS = ['игра', 'игры', 'игр'];

export function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null) node.setAttribute(key, String(value));
  }
  return node;
}

export function niceStep(raw) {
  if (raw <= 1) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / power;
  const base = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return Math.max(1, base * power);
}

export function pad2(value) {
  return String(value).padStart(2, '0');
}

export function heatLevel(count) {
  const n = toNum(count);
  if (n <= 0) return 0;
  if (n === 1) return 1;
  if (n === 2) return 2;
  if (n === 3) return 3;
  return 4;
}

function gamesLabel(appids, nameOf) {
  const names = (Array.isArray(appids) ? appids : [])
    .map((appid) => (typeof nameOf === 'function' ? nameOf(appid) : ''))
    .filter(Boolean);
  if (!names.length) return '';
  const shown = names.slice(0, 3);
  const tail = names.length > shown.length ? ` и ещё ${names.length - shown.length}` : '';
  return `${shown.join(', ')}${tail}`;
}

export function buildYearCalendarFilm(year, byDate, { onDayClick } = {}) {
  const first = Date.UTC(year, 0, 1);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInYear = leap ? 366 : 365;
  const offset = (new Date(first).getUTCDay() + 6) % 7;
  const columns = Math.ceil((offset + daysInYear) / 7);
  const pitch = 13;

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
  for (let month = 0; month < 12; month++) {
    const column = Math.floor((offset + monthStartDay) / 7);
    if (column - lastLabelColumn >= 2) {
      months.append(el('span', {
        class: 'cal-month-label',
        text: CAL_MONTHS_SHORT[month],
        style: { left: `${column * pitch}px` },
      }));
      lastLabelColumn = column;
    }
    monthStartDay += new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  }

  const grid = el('div', {
    class: 'cal-grid',
    role: 'grid',
    'aria-label': `Календарь просмотров, ${year}`,
    style: { gridTemplateColumns: `repeat(${columns}, 11px)` },
  });

  const totalCells = columns * 7;
  for (let index = 0; index < totalCells; index++) {
    const dayOfYear = index - offset;
    if (dayOfYear < 0 || dayOfYear >= daysInYear) {
      grid.append(el('span', { class: 'cal-cell is-blank', 'aria-hidden': 'true' }));
      continue;
    }
    const dateObj = new Date(first + dayOfYear * 86400000);
    const date = `${year}-${pad2(dateObj.getUTCMonth() + 1)}-${pad2(dateObj.getUTCDate())}`;
    const day = byDate.get(date) || null;
    const count = day ? toNum(day.count) : 0;
    const rewatch = day ? Math.max(0, toNum(day.rewatchCount)) : 0;
    const countLabel = `${fmtInt(count)} ${plural(count, ['просмотр', 'просмотра', 'просмотров'])}`;
    const rewatchLabel = `${fmtInt(rewatch)} ${plural(rewatch, ['пересмотр', 'пересмотра', 'пересмотров'])}`;
    const dayTitle = count > 0
      ? `${date} — ${countLabel}${rewatch > 0 ? ` (в т.ч. ${rewatchLabel})` : ''}`
      : `${date} — нет просмотров`;
    const cell = el(day && count > 0 ? 'button' : 'span', {
      class: `cal-cell cal-level-${heatLevel(count)}${count > 0 ? ' is-active' : ''}${rewatch > 0 ? ' has-rewatch' : ''}`,
      dataset: { date, count: String(count), rewatch: String(rewatch) },
      title: dayTitle,
      role: 'gridcell',
      'aria-label': dayTitle,
    });
    if (day && count > 0) {
      if (cell.tagName === 'BUTTON') cell.type = 'button';
      cell.addEventListener('pointerenter', (event) => {
        showTooltip(
          dayTitle,
          rewatch > 0 ? 'в том числе пересмотры · нажмите, чтобы увидеть фильмы' : 'нажмите, чтобы увидеть фильмы'
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

export function buildYearCalendarBook(year, byDate, onDayClick) {
  const first = Date.UTC(year, 0, 1);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInYear = leap ? 366 : 365;
  const offset = (new Date(first).getUTCDay() + 6) % 7;
  const columns = Math.ceil((offset + daysInYear) / 7);
  const pitch = 13;

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
        text: CAL_MONTHS_SHORT[month],
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

export function buildYearCalendarGame(year, byDate, { onDayClick, nameOf } = {}) {
  const first = Date.UTC(year, 0, 1);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInYear = leap ? 366 : 365;
  const offset = (new Date(first).getUTCDay() + 6) % 7;
  const columns = Math.ceil((offset + daysInYear) / 7);
  const pitch = 13;

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
        text: CAL_MONTHS_GAMES[month],
        style: { left: `${column * pitch}px` },
      }));
      lastLabelColumn = column;
    }
    monthStartDay += new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  }

  const grid = el('div', {
    class: 'cal-grid',
    role: 'grid',
    'aria-label': `Календарь достижений, ${year}`,
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
    const games = day ? (day.appids || []).length : 0;
    const names = day ? gamesLabel(day.appids, nameOf) : '';
    const countLabel = `${fmtInt(count)} ${plural(count, ACHIEVEMENT_FORMS)}`;
    const gamesPart = games > 0 ? ` · ${fmtInt(games)} ${plural(games, GAME_FORMS)}` : '';
    const dayTitle = count > 0
      ? `${date} — ${countLabel}${gamesPart}${names ? `: ${names}` : ''}`
      : `${date} — достижений не разблокировано`;
    const cell = el(day && count > 0 ? 'button' : 'span', {
      class: `cal-cell cal-level-${heatLevel(count)}${count > 0 ? ' is-active' : ''}`,
      dataset: { date, count: String(count), games: String(games) },
      title: dayTitle,
      role: 'gridcell',
      'aria-label': dayTitle,
    });
    if (day && count > 0) {
      cell.type = 'button';
      cell.addEventListener('pointerenter', (event) => {
        showTooltip(
          dayTitle,
          names
            ? 'нажмите, чтобы увидеть день в списке игр'
            : 'день с разблокировкой достижений · это не игровое время',
        );
        moveTooltip(event);
      });
      cell.addEventListener('pointermove', moveTooltip);
      cell.addEventListener('pointerleave', hideTooltip);
      if (typeof onDayClick === 'function') {
        cell.addEventListener('click', () => {
          hideTooltip();
          onDayClick(day);
        });
      }
    }
    grid.append(cell);
  }

  scroll.append(months, grid);
  row.append(scroll);
  return row;
}
