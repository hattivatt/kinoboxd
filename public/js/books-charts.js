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

export function renderBooksTimeline(host, timeline, { onMonthClick } = {}) {
  renderTimeline(host, timeline, { ...BOOK_TIMELINE, onMonthClick });
}
