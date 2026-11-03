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

import { el, clear, plural, toNum, fmtInt } from './ui.js';
import { buildYearCalendarGame } from './core/charts.js';

const DAY_FORMS = ['день', 'дня', 'дней'];

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
    host.append(buildYearCalendarGame(year, byDate, { onDayClick, nameOf }));
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
