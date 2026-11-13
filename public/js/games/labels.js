import { text, numOrNull } from '../core/dom.js';
import { toNum } from '../ui.js';

const MONTHS_SHORT_RU = [
  'янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.',
  'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.',
];

const GAME_PLURAL = ['игра', 'игры', 'игр'];
const SECONDARY_WORK_PLURAL = ['работа', 'работы', 'работ'];

export function percentText(value, decimals = 1) {
  const n = numOrNull(value);
  if (n == null) return '—';
  const percent = Math.abs(n) <= 1.0000001 ? n * 100 : n;
  const digits = Math.max(0, Math.min(2, Math.round(toNum(decimals, 1))));
  return `${new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(percent)}%`;
}

export function percentNumber(value) {
  const n = numOrNull(value);
  if (n == null) return null;
  const percent = Math.abs(n) <= 1.0000001 ? n * 100 : n;
  return Math.max(0, Math.min(100, percent));
}

const EN_MONTHS = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

function parseDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const raw = text(value);
  if (!raw) return null;
  let match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (match) return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  match = /^(\d{4})-(\d{2})$/.exec(raw);
  if (match) return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  match = /^(\d{4})$/.exec(raw);
  if (match) return new Date(Date.UTC(Number(match[1]), 0, 1));
  match = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(raw);
  if (match) {
    const month = EN_MONTHS[match[1].toLowerCase()];
    if (month != null) return new Date(Date.UTC(Number(match[3]), month, Number(match[2])));
  }
  match = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(raw);
  if (match) {
    const month = EN_MONTHS[match[2].toLowerCase()];
    if (month != null) return new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
  }
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

export function epochSeconds(value) {
  if (value == null || value === '') return 0;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? Math.floor(value.getTime() / 1000) : 0;
  }
  if (typeof value === 'number' || /^\d+$/.test(text(value))) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  }
  const date = parseDate(value);
  return date ? Math.floor(date.getTime() / 1000) : 0;
}

export function shortDayText(seconds) {
  if (!seconds) return '';
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getUTCDate()} ${MONTHS_SHORT_RU[date.getUTCMonth()]}`;
}

export { GAME_PLURAL, SECONDARY_WORK_PLURAL };
