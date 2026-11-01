/* Games: achievement calendar heatmap + streak card (DOM only).
 *
 * The books tab has the same picture (`books-charts.js`), but the wording is
 * different in a way that matters: a book day is «прочитано», an achievement
 * day is «разблокировано», and the games calendar must never look like
 * «время в игре». Keeping a separate module (instead of a `labels` option in
 * books-charts) leaves the books widget untouched and makes the games wording
 * explicit here.
 *
 * The CSS classes are shared (`cal-*`, `streak-*`): same heatmap, same cells,
 * same hover behaviour — one visual language across tabs.
 */

import {
  el, clear, plural, toNum, fmtInt, showTooltip, moveTooltip, hideTooltip,
} from './ui.js';

const CAL_MONTHS = ['янв', 'февр', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сент', 'окт', 'нояб', 'дек'];
const ACHIEVEMENT_FORMS = ['достижение', 'достижения', 'достижений'];
const GAME_FORMS = ['игра', 'игры', 'игр'];
const DAY_FORMS = ['день', 'дня', 'дней'];

function pad2(value) {
  return String(value).padStart(2, '0');
}

function heatLevel(count) {
  const n = toNum(count);
  if (n <= 0) return 0;
  if (n === 1) return 1;
  if (n === 2) return 2;
  if (n === 3) return 3;
  return 4;
}

/** Game names for a day, from the light `gamesIndex` (never a heavy request). */
function gamesLabel(appids, nameOf) {
  const names = (Array.isArray(appids) ? appids : [])
    .map((appid) => (typeof nameOf === 'function' ? nameOf(appid) : ''))
    .filter(Boolean);
  if (!names.length) return '';
  const shown = names.slice(0, 3);
  const tail = names.length > shown.length ? ` и ещё ${names.length - shown.length}` : '';
  return `${shown.join(', ')}${tail}`;
}

function buildYearCalendar(year, byDate, { onDayClick, nameOf } = {}) {
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

/**
 * Multi-year achievement heatmap (one row per year, empty years included).
 *
 * @param {HTMLElement} host
 * @param {Array<{date:string,count:number,appids:number[]}>} days
 * @param {{onDayClick?: (day:object)=>void, nameOf?: (appid:number)=>string}} [opts]
 */
export function renderAchievementCalendar(host, days, { onDayClick, nameOf } = {}) {
  if (!host) return;
  clear(host);
  const list = (Array.isArray(days) ? days : [])
    .filter((day) => day && /^\d{4}-\d{2}-\d{2}$/.test(String(day.date || '').slice(0, 10)));
  if (!list.length) {
    host.append(el('div', { class: 'empty-state', text: 'Нет дат разблокировки достижений' }));
    return;
  }

  const byDate = new Map(list.map((day) => [String(day.date).slice(0, 10), day]));
  const years = [...new Set(list.map((day) => Number(String(day.date).slice(0, 4))))]
    .filter((year) => Number.isFinite(year) && year > 0)
    .sort((a, b) => a - b);

  for (let year = years[0]; year <= years[years.length - 1]; year += 1) {
    host.append(buildYearCalendar(year, byDate, { onDayClick, nameOf }));
  }
}

/**
 * Streak card: «Серия: 3 дня · Рекорд: 9 · Последняя разблокировка: 4 окт. 2026».
 * Hidden when there is no streak data at all.
 */
export function renderAchievementStreaks(host, streaks) {
  if (!host) return;
  clear(host);
  if (!streaks || !streaks.visible) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const current = Math.max(0, toNum(streaks.current));
  host.append(el('span', { class: 'streak-bolt', text: '⚡', 'aria-hidden': 'true' }));
  const main = el('span', { class: 'streak-main' });
  main.append(el('span', { class: 'streak-label', text: 'Серия:' }));
  main.append(el('b', { class: 'streak-num', text: fmtInt(current) }));
  main.append(el('span', { class: 'streak-unit', text: plural(current, DAY_FORMS) }));
  host.append(main);

  const meta = [streaks.metaText || ''].filter(Boolean).join(' · ');
  if (meta) host.append(el('span', { class: 'streak-meta', text: meta }));
  host.title = streaks.hint || '';
}
