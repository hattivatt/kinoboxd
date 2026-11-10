import { arr, firstString, numOrNull, text } from '../../core/dom.js';
import { toNum } from '../../ui.js';

export function toCount(value) {
  const n = numOrNull(value);
  if (n == null || n < 0) return 0;
  return Math.floor(n);
}

export function boolOrNull(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

/**
 * Hours, always signed with «ч»: `hoursText(1054.4)` → «1 054,4 ч».
 * `decimals: 0` is used for the big total («5 863 ч»), one decimal for a game
 * row and for the median. Steam reports minutes; the caller converts once.
 */
export function hoursText(value, decimals = 1) {
  const n = numOrNull(value);
  if (n == null) return '—';
  const digits = Math.max(0, Math.min(2, Math.round(toNum(decimals, 1))));
  const formatted = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
  return `${formatted} ч`;
}

export function normalizeGenres(raw) {
  return arr(raw)
    .map((item) => text(typeof item === 'object' && item ? (item.name || item.label) : item))
    .filter(Boolean);
}

/** Minutes in the Web API, hours in the payload — both spellings accepted. */
export function normalizeHours(item) {
  const direct = numOrNull(item && (item.hours ?? item.playtimeHours ?? item.hoursTotal));
  if (direct != null) return direct;
  const minutes = numOrNull(item && (item.playtime_forever ?? item.playtimeForever ?? item.minutes));
  return minutes != null ? minutes / 60 : null;
}

export function normalizeHours2w(item) {
  const direct = numOrNull(item && (item.hours2w ?? item.hours2Weeks ?? item.playtime2wHours));
  if (direct != null) return direct;
  const minutes = numOrNull(item && (item.playtime_2weeks ?? item.playtime2weeks ?? item.playtime2Weeks));
  return minutes != null ? minutes / 60 : null;
}

/**
 * Tag list on a `gamesIndex` entry (and on a game card). SteamSpy tags arrive
 * as an array of names, an array of `{name, weight}` or a `{ tag: weight }`
 * map depending on the cache generation; all three are accepted and reduced to
 * plain names, because the drilldown only needs «does this game have the tag».
 */
export function normalizeTagsList(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => text(typeof item === 'object' && item ? (item.name || item.label || item.tag) : item))
      .filter(Boolean);
  }
  if (raw && typeof raw === 'object') {
    return Object.keys(raw).map((key) => text(key)).filter(Boolean);
  }
  return [];
}

/**
 * Steam community review score (M4). It is NOT a personal rating: Steam does
 * not have those, and the UI must say so wherever the number appears. The
 * canonical scale is 1–9 with an English description (`review_score_desc`);
 * `bucket` in `scores[]` may carry either the number or the description.
 */
export const STEAM_REVIEW_SCALE = [
  { score: 1, desc: 'Overwhelmingly Negative', label: 'Крайне отрицательные', color: '#a33a4a' },
  { score: 2, desc: 'Very Negative', label: 'Очень отрицательные', color: '#b44a3a' },
  { score: 3, desc: 'Negative', label: 'Отрицательные', color: '#b96b3d' },
  { score: 4, desc: 'Mostly Negative', label: 'В основном отрицательные', color: '#b8933f' },
  { score: 5, desc: 'Mixed', label: 'Смешанные', color: '#9aa04e' },
  { score: 6, desc: 'Mostly Positive', label: 'В основном положительные', color: '#7fa85a' },
  { score: 7, desc: 'Positive', label: 'Положительные', color: '#4fae5f' },
  { score: 8, desc: 'Very Positive', label: 'Очень положительные', color: '#2fb56a' },
  { score: 9, desc: 'Overwhelmingly Positive', label: 'Крайне положительные', color: '#00c46a' },
];

const REVIEW_BY_SCORE = new Map(STEAM_REVIEW_SCALE.map((entry) => [entry.score, entry]));
const REVIEW_BY_KEY = new Map();
for (const entry of STEAM_REVIEW_SCALE) {
  for (const key of [entry.desc, entry.label]) {
    REVIEW_BY_KEY.set(key.toLowerCase().replace(/[^a-zа-я0-9]+/gi, ''), entry.score);
  }
}

/** `1`, `"7"`, `"Very Positive"`, `"very_positive"` → a 1–9 score or null. */
export function resolveReviewBucket(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(text(value))) {
    const score = Number(value);
    return REVIEW_BY_SCORE.has(score) ? score : null;
  }
  const key = text(value).toLowerCase().replace(/[^a-zа-я0-9]+/gi, '');
  return REVIEW_BY_KEY.get(key) ?? null;
}

export function reviewScaleEntry(score) {
  return REVIEW_BY_SCORE.get(Number(score)) || null;
}

/** Franchise reference: `"The Witcher"` or `{ key, label, appids }`. */
export function normalizeFranchiseRef(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const label = text(raw);
    return label ? { key: label, label, appids: [] } : null;
  }
  if (typeof raw !== 'object') return null;
  const label = firstString(raw.label, raw.name, raw.title, raw.key);
  if (!label) return null;
  return {
    key: text(raw.key) || label,
    label,
    appids: arr(raw.appids).map((value) => numOrNull(value)).filter((value) => value != null),
    // M6 follow-up: identity of secondary-only members (`gog:<id>` /
    // `epic:<id>`). A franchise can therefore contain Steam rows *and* store
    // exclusives; `appids` alone would silently drop the latter.
    workKeys: arr(raw.workKeys).map((value) => text(value)).filter(Boolean),
  };
}
