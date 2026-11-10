/* Book-specific charts: the monthly reading timeline.
 *
 * The charts primitives are reused as-is from charts.js; only the pieces whose
 * wording is domain-specific (просмотры → книги, пересмотры → перечитывания,
 * plus the per-source split) live here. No dependencies.
 */

import { fmtInt, fmtPercent } from './ui.js';
import { renderTimeline } from './charts/timeline.js';

export { dateParts, fmtDayRu, fmtDayShortRu } from './core/date.js';

export { pad2 } from './core/charts.js';

const BOOK_VALUE_FORMS = ['книга', 'книги', 'книг'];
const BOOK_REWATCH_FORMS = ['перечитка', 'перечитки', 'перечитываний'];

function bookBreakdown(item) {
  const sources = [];
  if (item.livelib > 0) sources.push(`LiveLib ${fmtInt(item.livelib)}`);
  if (item.hardcover > 0) sources.push(`Hardcover ${fmtInt(item.hardcover)}`);
  return sources;
}

const BOOK_TIMELINE = {
  emptyText: 'Нет прочитанных книг с датами',
  ariaPrefix: 'Прочитанные книги по месяцам',
  valueKey: 'finished',
  rewatchKey: 'reRead',
  valueForms: BOOK_VALUE_FORMS,
  rewatchForms: BOOK_REWATCH_FORMS,
  numericKeys: ['finished', 'reRead', 'livelib', 'hardcover'],
  secondary: (item, total) => {
    const sources = bookBreakdown(item);
    return sources.length ? sources.join(' · ') : `${fmtPercent(item.finished, total)} всех книг`;
  },
};

/**
 * Monthly bar chart of finished books. The geometry is shared with
 * charts.js#renderTimeline; only the wording and the per-source tooltip split
 * are book-specific.
 *
 * @param {HTMLElement} host
 * @param {Array<{month:string,finished:number,reRead?:number,livelib?:number,hardcover?:number}>} timeline
 * @param {{onMonthClick?: (month:string)=>void}} [opts]
 */
export function renderBooksTimeline(host, timeline, { onMonthClick } = {}) {
  renderTimeline(host, timeline, { ...BOOK_TIMELINE, onMonthClick });
}
