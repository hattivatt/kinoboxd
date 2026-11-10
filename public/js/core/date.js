const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const MONTHS_SHORT_GEN = [
  'янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.',
  'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.',
];

function anchoredOption(options) {
  if (options === true) return true;
  if (options && typeof options === 'object') {
    return !!(options.anchored || options.strict || options.exact);
  }
  return false;
}

function regexFor(options) {
  return anchoredOption(options)
    ? /^(\d{4})-(\d{2})-(\d{2})$/
    : /^(\d{4})-(\d{2})-(\d{2})/;
}

export function dateParts(value, options) {
  const match = regexFor(options).exec(String(value || ''));
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function fmtDayRu(value, options) {
  const parts = dateParts(value, options);
  if (!parts) return String(value || '');
  return `${parts.day} ${MONTHS_GEN[parts.month - 1]} ${parts.year}`;
}

export function fmtDayShortRu(value, options) {
  const parts = dateParts(value, options);
  if (!parts) return String(value || '');
  return `${parts.day} ${MONTHS_SHORT_GEN[parts.month - 1]} ${parts.year}`;
}

export function dayIndex(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!match) return null;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000);
}

export function dayNumber(date) {
  const text = (value) => (value == null ? '' : String(value).trim());
  const parsed = Date.parse(`${text(date).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 86400000) : null;
}

const MONTHS_SHORT_RU = MONTHS_SHORT_GEN;

function parseDate(raw) {
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}

export function formatDateRu(value) {
  const date = parseDate(value);
  if (!date) return '';
  return `${date.getUTCDate()} ${MONTHS_SHORT_RU[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function formatDateShortRu(value) {
  const date = parseDate(value);
  if (!date) return '';
  return `${date.getUTCDate()} ${MONTHS_SHORT_RU[date.getUTCMonth()]}`;
}
