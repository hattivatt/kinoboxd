/* Games tab: pure view-model helpers (no DOM, no network, no globals).
 *
 * Everything the «Игры» dashboard prints about a `GET /api/games/stats`
 * payload is computed here, so the numbers can be pinned by `node --test`
 * without a browser. `games.js` owns the DOM and the `/api/games/*` calls and
 * only asks this module "what should be on the screen".
 *
 * The payload is a DRAFT contract (ИГРЫ-АРХИТЕКТУРА.md §5.1) and the backend
 * was still being written next to this UI, so normalisation is deliberately
 * tolerant:
 *
 *   - a missing block returns `null`/`[]` and the caller hides the widget
 *     instead of rendering a confident zero;
 *   - field names accept the doc spelling and the obvious alternates
 *     (`hours` / `playtimeHours` / `playtime_forever` in minutes);
 *   - nothing here throws on a malformed payload — a broken widget is worse
 *     than a hidden one, and a hidden one is worse than an honest «нет данных».
 *
 * Nothing in this module reads `window`/`document`, which is what makes the
 * headless smoke test (`test/games-ui.test.js`) possible.
 */

import { fmtInt, plural, toNum } from './ui.js';

const MONTHS_SHORT_RU = [
  'янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.',
  'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.',
];

const GAME_PLURAL = ['игра', 'игры', 'игр'];
// M6c: secondary works are «работы», not Steam games — the union library is
// wider than the journal, and the UI must not pretend every row is a Steam
// game. Kept local so the existing GAME_PLURAL wording stays untouched.
const SECONDARY_WORK_PLURAL = ['работа', 'работы', 'работ'];
const SECONDARY_SOURCE_ORDER = ['steam', 'gog', 'epic'];
const SECONDARY_SOURCE_LABELS = { steam: 'Steam', gog: 'GOG', epic: 'Epic' };

/* =========================================================
   primitive coercion
   ========================================================= */

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toCount(value) {
  const n = numOrNull(value);
  if (n == null || n < 0) return 0;
  return Math.floor(n);
}

function firstString(...values) {
  for (const value of values) {
    const s = text(value);
    if (s) return s;
  }
  return '';
}

function boolOrNull(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

/* =========================================================
   formatting
   ========================================================= */

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

/**
 * Share → percent text. Accepts both the contract's fraction (`0.746`) and an
 * already-multiplied number (`74.6`), because both spellings appeared in the
 * doc while the backend was being written.
 */
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

/** `0.746` (or `74.6`) → `74.6`, clamped to 0…100. Used for bar widths. */
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
  // Steam Community XML uses «February 19, 2011» (a calendar date, no time and
  // no zone). `Date.parse` would read it as local midnight and shift the day
  // for every timezone west of UTC, so the month name is mapped explicitly.
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
  // Unknown format: keep the calendar day the string implies on this machine.
  const date = new Date(parsed);
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}

/** Tolerant date label: ISO, `YYYY-MM`, `YYYY` or «February 19, 2011» → «19 февр. 2011». */
export function formatDateRu(value) {
  const date = parseDate(value);
  if (!date) return '';
  return `${date.getUTCDate()} ${MONTHS_SHORT_RU[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Short label without the year: «4 окт.» (streak cards, «последняя разблокировка»). */
export function formatDateShortRu(value) {
  const date = parseDate(value);
  if (!date) return '';
  return `${date.getUTCDate()} ${MONTHS_SHORT_RU[date.getUTCMonth()]}`;
}

/* =========================================================
   honest labels
   ========================================================= */

export const LAST_PLAYED_HINT =
  'Дата последнего запуска по данным Steam (rtime_last_played). Это не игровая сессия: Steam не отдаёт ни сессии, ни часы по дням.';

export const HOURS_HINT =
  'Часы — сумма playtime_forever из Steam Web API, переведённая из минут. Steam считает время с запущенным клиентом (включая простой и свёрнутое окно), поэтому это «по данным Steam», а не хронометраж.';

/**
 * «Последний раз»: text for the row plus the honest tooltip. `rtime_last_played`
 * may arrive as unix seconds (Web API) or as an ISO string (normalised payload).
 */
export function lastPlayedInfo(value) {
  if (value == null || value === '') {
    return {
      text: 'не запускал',
      title: 'Steam не передал дату последнего запуска: rtime_last_played = 0.',
      unknown: true,
    };
  }
  if (typeof value === 'number' || /^\d+$/.test(text(value))) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return {
        text: 'не запускал',
        title: 'Steam не передал дату последнего запуска: rtime_last_played = 0.',
        unknown: true,
      };
    }
    return {
      text: formatDateRu(new Date(seconds * 1000).toISOString()),
      title: LAST_PLAYED_HINT,
      unknown: false,
    };
  }
  const formatted = formatDateRu(value);
  if (!formatted) {
    return {
      text: 'не запускал',
      title: 'Steam не передал дату последнего запуска.',
      unknown: true,
    };
  }
  return { text: formatted, title: LAST_PLAYED_HINT, unknown: false };
}

/* =========================================================
   payload normalisation
   ========================================================= */

function normalizeGenres(raw) {
  return arr(raw)
    .map((item) => text(typeof item === 'object' && item ? (item.name || item.label) : item))
    .filter(Boolean);
}

/** Minutes in the Web API, hours in the payload — both spellings accepted. */
function normalizeHours(item) {
  const direct = numOrNull(item && (item.hours ?? item.playtimeHours ?? item.hoursTotal));
  if (direct != null) return direct;
  const minutes = numOrNull(item && (item.playtime_forever ?? item.playtimeForever ?? item.minutes));
  return minutes != null ? minutes / 60 : null;
}

function normalizeHours2w(item) {
  const direct = numOrNull(item && (item.hours2w ?? item.hours2Weeks ?? item.playtime2wHours));
  if (direct != null) return direct;
  const minutes = numOrNull(item && (item.playtime_2weeks ?? item.playtime2weeks ?? item.playtime2Weeks));
  return minutes != null ? minutes / 60 : null;
}

function normalizeTopGame(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const name = firstString(item.name, item.title);
  if (!name) return null;
  return {
    appid: numOrNull(item.appid),
    name,
    hours: normalizeHours(item),
    lastPlayed: item.lastPlayed ?? item.rtime_last_played ?? null,
    releaseYear: numOrNull(item.releaseYear),
    completion: numOrNull(item.completion),
    genres: normalizeGenres(item.genres),
    cover: text(item.cover || item.coverUrl || item.headerImage),
    icon: text(item.icon || item.iconUrl || item.img_icon_url),
  };
}

function normalizeRecent(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const name = firstString(item.name, item.title);
  if (!name) return null;
  return {
    appid: numOrNull(item.appid),
    name,
    hours2w: normalizeHours2w(item),
    hoursTotal: normalizeHours(item),
    lastPlayed: item.lastPlayed ?? item.rtime_last_played ?? null,
    // The top strip paints the Steam capsule icon; the index may not have it
    // for entries the payload already carries.
    iconUrl: firstString(item.iconUrl, item.icon) || '',
    // M6c: cross-store ownership of the same work (GOG today) and an optional
    // store-provided poster for rows that are not on the Steam CDN.
    sources: arr(item.sources).map((value) => String(value)).filter(Boolean),
    hoursBySource:
      item.hoursBySource && typeof item.hoursBySource === 'object' ? item.hoursBySource : null,
    coverUrl: firstString(item.verticalCoverUrl, item.coverUrl) || '',
  };
}

function normalizeBacklogItem(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const name = firstString(item.name, item.title);
  if (!name) return null;
  return {
    appid: numOrNull(item.appid),
    name,
    releaseYear: numOrNull(item.releaseYear ?? item.year),
    genres: normalizeGenres(item.genres),
  };
}

function normalizeHistogram(raw) {
  return arr(raw)
    .map((item) => {
      const bucket = firstString(item && (item.bucket ?? item.label ?? item.key));
      if (!bucket) return null;
      return {
        bucket,
        count: toCount(item && item.count),
        hours: numOrNull(item && item.hours),
      };
    })
    .filter((item) => item && item.count > 0);
}

function normalizeCompletion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const avgPercent = numOrNull(raw.avgPercent ?? raw.averagePercent);
  if (avgPercent == null) return null;
  return {
    avgPercent,
    medianPercent: numOrNull(raw.medianPercent),
    perfectCount: toCount(raw.perfectCount),
    gamesWithStats: toCount(raw.gamesWithStats),
    gamesTotal: toCount(raw.gamesTotal),
  };
}

function normalizeAchievements(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const unlocked = numOrNull(raw.unlocked);
  const total = numOrNull(raw.total);
  if (unlocked == null && total == null) return null;
  return {
    unlocked: unlocked == null ? null : Math.max(0, unlocked),
    total: total == null ? null : Math.max(0, total),
    rareUnlocked: numOrNull(raw.rareUnlocked),
    coverage: raw.coverage && typeof raw.coverage === 'object'
      ? {
        gamesWithStats: numOrNull(raw.coverage.gamesWithStats),
        gamesTotal: numOrNull(raw.coverage.gamesTotal),
      }
      : null,
  };
}

/* =========================================================
   M2/M3 blocks (ИГРЫ-АРХИТЕКТУРА §5.1, §6)
   ========================================================= */

/**
 * Steam categories → the six mode counters the dashboard prints. The backend
 * (appdetails → `categories[]`) folds them; the spellings below cover the doc
 * (`onlinePvp`) and the obvious snake/kebab variants so a contract drift does
 * not hide the widget.
 */
export const MODE_DEFS = [
  { key: 'single', label: 'одиночная', title: 'Категория Steam Single-player' },
  { key: 'multi', label: 'мультиплеер', title: 'Категория Steam Multi-player' },
  { key: 'coop', label: 'кооператив', title: 'Категория Steam Co-op' },
  { key: 'onlinePvp', label: 'PvP онлайн', title: 'Категория Steam Online PvP' },
  { key: 'localCoop', label: 'кооп локально', title: 'Категория Steam Shared/Split Screen Co-op' },
  { key: 'mmo', label: 'MMO', title: 'Категория Steam MMO' },
];

const MODE_ALIASES = {
  single: ['singleplayer', 'single_player', 'single-player', 'singlePlayer'],
  multi: ['multiplayer', 'multi_player', 'multi-player', 'multiPlayer'],
  coop: ['coOp', 'co-op', 'co_op', 'cooperative'],
  onlinePvp: ['online_pvp', 'online-pvp', 'onlinePVP', 'pvp'],
  localCoop: ['local_coop', 'local-coop', 'localCoop', 'sharedSplitScreen'],
  mmo: ['massivelyMultiplayer', 'mmo', 'massively_multiplayer'],
};

function normalizeModes(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = Array.isArray(raw)
    ? raw.reduce((acc, item) => {
      if (!item || typeof item !== 'object') return acc;
      const key = firstString(item.key, item.name, item.label);
      if (key) acc[key] = item;
      return acc;
    }, {})
    : raw;
  const out = {};
  let any = false;
  for (const def of MODE_DEFS) {
    let value = null;
    for (const name of [def.key, ...MODE_ALIASES[def.key]]) {
      if (source[name] != null) {
        value = source[name];
        break;
      }
    }
    if (value == null) continue;
    any = true;
    out[def.key] = value && typeof value === 'object'
      ? { count: toCount(value.count), hours: numOrNull(value.hours) }
      : { count: toCount(value), hours: null };
  }
  return any ? out : null;
}

/** `earlyAccess` / `freeToPlay`: `{ count, hours, share }`, share derived if absent. */
function normalizeAccessBlock(raw, summary) {
  if (!raw || typeof raw !== 'object') return null;
  const count = numOrNull(raw.count);
  const hours = numOrNull(raw.hours);
  if (count == null && hours == null) return null;
  const games = toCount(summary && (summary.gameCount || summary.ownedCount));
  const share = numOrNull(raw.share) ?? (count != null && games > 0 ? count / games : null);
  return {
    count: count == null ? null : Math.max(0, count),
    hours,
    share,
  };
}

/** `summary.metadata`: honest enrichment coverage, never a fake 100%. */
function normalizeMetadata(raw, summary) {
  if (!raw || typeof raw !== 'object') return null;
  const games = numOrNull(summary && (summary.gameCount || summary.ownedCount));
  const detailsResolved = numOrNull(raw.detailsResolved ?? raw.resolvedDetails);
  const detailsTotal = numOrNull(raw.detailsTotal ?? raw.totalDetails)
    ?? (detailsResolved != null ? games : null);
  const creditsResolved = numOrNull(raw.creditsResolved ?? raw.resolvedCredits);
  const creditsTotal = numOrNull(raw.creditsTotal ?? raw.totalCredits)
    ?? (creditsResolved != null ? games : null);
  const running = boolOrNull(raw.running ?? raw.enriching);
  if (detailsResolved == null && creditsResolved == null && running !== true) return null;
  const percentOf = (resolved, total, direct) => {
    const explicit = numOrNull(direct);
    if (explicit != null) return explicit;
    return resolved != null && total ? (resolved / total) * 100 : null;
  };
  return {
    detailsResolved,
    detailsTotal,
    detailsPercent: percentOf(detailsResolved, detailsTotal, raw.detailsPercent),
    creditsResolved,
    creditsTotal,
    creditsPercent: percentOf(creditsResolved, creditsTotal, raw.creditsPercent),
    running,
    budgetRemaining: numOrNull(raw.budgetRemaining),
  };
}

/** `meta.excluded`: why records were dropped (DLC, other type, unknown type). */
function normalizeExcluded(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    dlc: toCount(raw.dlc),
    otherType: toCount(raw.otherType ?? raw.other_type),
    free: toCount(raw.free),
    unknownType: toCount(raw.unknownType ?? raw.unknown_type),
  };
}

/**
 * `meta.filters` (§5.4): what was REQUESTED vs what the server could APPLY.
 * The UI must show the difference — a silent filter is a lie.
 */
function normalizeFilterBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const requested = boolOrNull(raw.requested);
  const applied = boolOrNull(raw.applied);
  if (requested == null && applied == null) return null;
  return { requested, applied, reason: text(raw.reason) };
}

/**
 * `meta.filters.minHours` (M5-B) is numeric, so it gets its own block:
 * `requested` is the integer the server understood (-1 all / 0 played only /
 * N hours), `excluded` counts the canonical works the filter dropped.
 */
function normalizeMinHoursFilter(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const requested = numOrNull(raw.requested);
  if (requested == null) return null;
  return {
    requested: Math.trunc(requested),
    applied: raw.applied == null ? null : Boolean(raw.applied),
    excluded: toCount(raw.excluded),
    excludedAppids: toCount(raw.excludedAppids ?? raw.excluded_appids),
  };
}

function normalizeFilters(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {
    includeFree: normalizeFilterBlock(raw.includeFree),
    includeDlc: normalizeFilterBlock(raw.includeDlc),
    minHours: normalizeMinHoursFilter(raw.minHours),
  };
  return out.includeFree || out.includeDlc || out.minHours ? out : null;
}

/**
 * Tag list on a `gamesIndex` entry (and on a game card). SteamSpy tags arrive
 * as an array of names, an array of `{name, weight}` or a `{ tag: weight }`
 * map depending on the cache generation; all three are accepted and reduced to
 * plain names, because the drilldown only needs «does this game have the tag».
 */
function normalizeTagsList(raw) {
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

/** Weighted buckets (genres, tags): `{ name, count, hours, share, weight }`. */
function normalizeWeightItems(raw) {
  return arr(raw)
    .map((item) => {
      if (!item || typeof item !== 'object') {
        const name = text(item);
        return name ? { name, count: 0, hours: null, share: null, weight: null, source: '' } : null;
      }
      const name = firstString(item.name, item.label, item.title, item.genre, item.tag);
      if (!name) return null;
      return {
        name,
        count: toCount(item.count ?? item.games ?? item.gameCount),
        hours: numOrNull(item.hours ?? item.playtimeHours ?? item.hoursTotal),
        share: numOrNull(item.share),
        weight: numOrNull(item.weight),
        source: text(item.source),
      };
    })
    .filter(Boolean);
}

/** `decades[]`: `{ decade: 2010 }` or the explicit «год неизвестен» bucket. */
function normalizeDecades(raw) {
  return arr(raw)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const decadeRaw = numOrNull(item.decade ?? item.value ?? item.start);
      const key = text(item.key);
      const unknown = decadeRaw == null && (key === 'unknown' || item.unknown === true || !key);
      const decade = unknown ? null : decadeRaw;
      const label = firstString(item.label)
        || (decade != null ? `${decade}-е` : 'год неизвестен');
      return {
        decade,
        key: key || (decade != null ? String(decade) : 'unknown'),
        label,
        count: toCount(item.count),
        hours: numOrNull(item.hours),
        unknown,
      };
    })
    .filter(Boolean);
}

function normalizeYears(raw) {
  return arr(raw)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const year = numOrNull(item.year ?? item.value);
      if (year == null || year <= 0) return null;
      return {
        year: Math.round(year),
        count: toCount(item.count),
        hours: numOrNull(item.hours),
      };
    })
    .filter(Boolean);
}

/** The «год неизвестен» bucket of `years[]`, summed; null when absent. */
function normalizeUnknownYear(raw) {
  const unknown = arr(raw).filter((item) => item && typeof item === 'object' && item.unknown);
  if (!unknown.length) return null;
  const count = unknown.reduce((sum, item) => sum + toCount(item.count), 0);
  const hours = unknown.map((item) => numOrNull(item.hours)).filter((value) => value != null);
  return {
    count,
    hours: hours.length ? hours.reduce((sum, value) => sum + value, 0) : null,
  };
}

function normalizePersonGames(raw) {
  return arr(raw)
    .map((item) => {
      if (item == null) return null;
      if (typeof item === 'number' || /^\d+$/.test(text(item))) {
        const appid = Number(item);
        return Number.isFinite(appid) ? { appid, name: '', hours: null, completion: null, roles: [] } : null;
      }
      if (typeof item !== 'object') return null;
      const name = firstString(item.name, item.title);
      const appid = numOrNull(item.appid);
      if (!name && appid == null) return null;
      return {
        appid,
        name,
        hours: numOrNull(item.hours ?? item.playtimeHours),
        completion: numOrNull(item.completion),
        roles: arr(item.roles).map((role) => text(role)).filter(Boolean),
      };
    })
    .filter(Boolean);
}

/** `gamesIndex[appid].achievements`: `{ unlocked, total, percent }`. */
function normalizeIndexAchievements(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const unlocked = numOrNull(raw.unlocked);
  const total = numOrNull(raw.total);
  const percent = numOrNull(raw.percent);
  if (unlocked == null && total == null && percent == null) return null;
  return { unlocked, total, percent };
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

function reviewScaleEntry(score) {
  return REVIEW_BY_SCORE.get(Number(score)) || null;
}

/** `summary.reviewScore` → `{ avg, median }` (null when the block is absent). */
function normalizeReviewScoreBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const avg = numOrNull(raw.avg ?? raw.mean ?? raw.average);
  const median = numOrNull(raw.median);
  if (avg == null && median == null) return null;
  return { avg, median };
}

/** `scores[]` → `[{ bucket, count, hours }]`, duplicate buckets summed. */
function normalizeScores(raw) {
  const merged = new Map();
  for (const item of arr(raw)) {
    if (!item || typeof item !== 'object') continue;
    const bucket = resolveReviewBucket(
      item.bucket ?? item.score ?? item.key ?? item.reviewScore ?? item.desc ?? item.label,
    );
    if (bucket == null) continue;
    const prev = merged.get(bucket) || { bucket, count: 0, hours: null };
    prev.count += toCount(item.count);
    const hours = numOrNull(item.hours);
    if (hours != null) prev.hours = (prev.hours || 0) + hours;
    merged.set(bucket, prev);
  }
  return [...merged.values()].sort((a, b) => b.bucket - a.bucket);
}

/** `summary.dlc` → `{ gamesWithDlc, avgCount, max: [{ name, dlcCount, appid }] }`. */
function normalizeDlcSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const gamesWithDlc = numOrNull(raw.gamesWithDlc ?? raw.games ?? raw.count);
  const avgCount = numOrNull(raw.avgCount ?? raw.avg ?? raw.average);
  const top = arr(raw.max ?? raw.top ?? raw.items ?? raw.topGames)
    .map((item) => {
      if (item == null) return null;
      if (typeof item === 'string') return { name: text(item), dlcCount: null, appid: null };
      if (typeof item !== 'object') return null;
      const name = firstString(item.name, item.title, item.label);
      const appid = numOrNull(item.appid);
      if (!name && appid == null) return null;
      return {
        name: name || (appid != null ? `appid ${appid}` : ''),
        dlcCount: numOrNull(item.dlcCount ?? item.count ?? item.dlc),
        appid,
      };
    })
    .filter(Boolean);
  if (gamesWithDlc == null && avgCount == null && !top.length) return null;
  return { gamesWithDlc, avgCount, max: top };
}

/** Franchise reference: `"The Witcher"` or `{ key, label, appids }`. */
function normalizeFranchiseRef(raw) {
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
  };
}

/** `franchises[]` from the dedicated endpoint (array or `{ franchises: [] }`). */
function normalizeFranchises(raw) {
  const list = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' && Array.isArray(raw.franchises) ? raw.franchises : []);
  return list
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const label = firstString(item.label, item.name, item.title, item.key);
      if (!label) return null;
      const appids = arr(item.appids)
        .map((value) => numOrNull(value))
        .filter((value) => value != null);
      // `yearsSpread` is `{min, max, span}` from `/api/games/franchises`
      // (M4-B) and a plain number in older payloads/tests — accept both.
      const spreadRaw = item.yearsSpread ?? item.years;
      const yearsSpread = spreadRaw && typeof spreadRaw === 'object'
        ? numOrNull(spreadRaw.span)
        : numOrNull(spreadRaw);
      return {
        key: text(item.key) || label,
        label,
        gamesCount: toCount(item.gamesCount ?? item.count ?? item.games),
        hoursSum: numOrNull(item.hoursSum ?? item.hours ?? item.totalHours),
        yearsSpread,
        appids,
      };
    })
    .filter(Boolean);
}

/**
 * One `gamesIndex` entry. The backend already ships the fields needed by the
 * client-side drilldowns (type, year, genres, developers/publishers,
 * categories, is_free, early_access, icon); the old normaliser kept only six
 * of them, which made «клик по жанру/году» impossible without a new request.
 * M4 adds tags / review score / franchise for the new widgets and the card.
 */
function normalizeGameIndexEntry(entry, appid) {
  const item = entry && typeof entry === 'object' ? entry : {};
  const releaseYear = numOrNull(item.releaseYear ?? item.year);
  return {
    appid: numOrNull(item.appid) ?? numOrNull(appid),
    name: firstString(item.name, item.title),
    hours: normalizeHours(item),
    hours2w: normalizeHours2w(item),
    lastPlayed: item.lastPlayed ?? item.rtime_last_played ?? null,
    iconUrl: /^https?:\/\//i.test(text(item.iconUrl)) ? text(item.iconUrl) : '',
    type: text(item.type).toLowerCase(),
    releaseYear,
    year: releaseYear,
    genres: normalizeGenres(item.genres),
    developers: normalizeGenres(item.developers),
    publishers: normalizeGenres(item.publishers),
    categories: normalizeGenres(item.categories),
    isFree: boolOrNull(item.isFree),
    earlyAccess: boolOrNull(item.earlyAccess),
    metacritic: numOrNull(item.metacritic),
    dlcCount: numOrNull(item.dlcCount),
    completion: numOrNull(item.completion),
    // M4: tags strip / review badge / franchise label on the card and the
    // three new drilldowns. Missing fields stay null — the widgets hide.
    tags: normalizeTagsList(item.tags),
    reviewScore: resolveReviewBucket(
      item.reviewScore ?? item.review_score ?? item.review?.score
      ?? item.reviewDesc ?? item.review_score_desc ?? item.review?.desc,
    ),
    reviewDesc: firstString(item.reviewDesc, item.review_score_desc, item.review?.desc),
    franchise: normalizeFranchiseRef(item.franchise ?? item.collection ?? arr(item.franchises)[0]),
    achievements: normalizeIndexAchievements(item.achievements),
    metadataSources: arr(item.metadataSources).map((source) => text(source)).filter(Boolean),
    // M5-B editions: identity of the canonical work. Absent on older payloads,
    // in which case every appid stays its own row (the pre-edition behaviour).
    canonicalWorkKey: firstString(item.canonicalWorkKey, item.canonical_work_key),
    primaryAppid: numOrNull(item.primaryAppid ?? item.primary_appid),
    isPrimary: item.isPrimary == null && item.is_primary == null
      ? null
      : Boolean(item.isPrimary ?? item.is_primary),
    editionCount: toCount(item.editionCount ?? item.edition_count) || 1,
    canonicalHours: numOrNull(item.canonicalHours ?? item.canonical_hours),
    // M6c: cross-store ownership of this appid's work (`['steam','gog']`) and
    // its per-source minutes. Absent on a Steam-only payload.
    sources: arr(item.sources).map((value) => text(value)).filter(Boolean),
    storeIds: item.storeIds && typeof item.storeIds === 'object' ? item.storeIds : null,
    hoursBySource:
      item.hoursBySource && typeof item.hoursBySource === 'object' ? item.hoursBySource : null,
    // M6c: secondary-only rows live in `gamesIndex` under their own `workKey`
    // (`appid: null`, `secondaryOnly: true`). Keeping the raw source blocks
    // lets a drilldown row open the same union card as the chart payload.
    workKey: firstString(item.workKey, item.work_key),
    secondaryOnly: item.secondaryOnly === true,
    source: normalizeSourceKey(item.source),
    gog: item.gog && typeof item.gog === 'object' ? item.gog : null,
    epic: item.epic && typeof item.epic === 'object' ? item.epic : null,
    releaseDate: firstString(item.releaseDate, item.release_date),
    hoursUnknown: item.hoursUnknown == null ? null : Boolean(item.hoursUnknown),
    hoursStatus: item.hoursStatus && typeof item.hoursStatus === 'object' ? item.hoursStatus : null,
  };
}

/* =========================================================
   M6c: secondary (non-Steam) works
   ========================================================= */

function normalizeSourceKey(value) {
  const key = text(value).toLowerCase();
  if (key === 'steam' || key === 'gog' || key === 'epic') return key;
  return '';
}

/** Protocol-relative GOG URLs (`//images.gog.com/…`) become https. */
function normalizeHttpUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  if (raw.startsWith('//')) return `https:${raw}`;
  return /^https?:\/\//i.test(raw) ? raw : '';
}

/** The four leading digits of an ISO date / year-ish string, else null. */
function yearFromDate(value) {
  const match = /(^|[^\d])(\d{4})([^\d]|$)/.exec(text(value));
  if (!match) return null;
  const year = Number(match[2]);
  return Number.isFinite(year) && year > 0 ? year : null;
}

/**
 * One `hoursBySource` value in **hours**. Integration contract (01.11.2026):
 * the `/stats` payload sends hours there, not minutes (the union converts
 * once, server-side). For robustness the normaliser still accepts an object
 * (`{ minutes }` / `{ hours }`) from an older/newer backend, but a plain
 * number is read as hours — never divided again (double conversion was the
 * M6a/M6c integration risk).
 */
function sourceHours(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    const hours = numOrNull(value.hours ?? value.hoursTotal ?? value.playtimeHours);
    if (hours != null) return hours;
    const minutes = numOrNull(value.minutes ?? value.totalMinutes ?? value.playtime_forever);
    return minutes != null ? minutes / 60 : null;
  }
  return numOrNull(value);
}

function secondaryHoursBySource(entry, gog, epic) {
  const raw = entry.hoursBySource && typeof entry.hoursBySource === 'object'
    ? entry.hoursBySource
    : {};
  // A future contract may move hours into `entry.hours` (hours, not minutes).
  const direct = entry.hours && typeof entry.hours === 'object' ? entry.hours : null;
  const directHours = numOrNull(entry.hours);
  const out = {};
  for (const source of SECONDARY_SOURCE_ORDER) {
    const value = direct && direct[source] != null ? direct[source] : raw[source];
    let hours = sourceHours(value);
    if (hours == null && directHours != null && source === normalizeSourceKey(entry.source)) {
      hours = directHours;
    }
    out[source] = hours;
  }
  // GOG's library row is the historical source of the poster; keep the block
  // shape so callers can still read `work.gog`.
  if (out.gog == null && gog && gog.hours != null) out.gog = numOrNull(gog.hours);
  if (out.epic == null && epic && epic.hours != null) out.epic = numOrNull(epic.hours);
  return out;
}

/**
 * Normalise one `secondaryWorks[]` entry (GOG work or Epic game).
 *
 * The list is deliberately independent from `gamesIndex`: these rows are not
 * Steam games, they have no appid and no `/api/games/game/:appid` card. The
 * view model therefore carries everything the client-side card needs.
 */
export function normalizeSecondaryWork(entry, context = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const gog = entry.gog && typeof entry.gog === 'object' ? entry.gog : {};
  const epic = entry.epic && typeof entry.epic === 'object' ? entry.epic : {};
  const storeIds = entry.storeIds && typeof entry.storeIds === 'object' ? entry.storeIds : {};
  const gogId = firstString(storeIds.gog, gog.gogGameId, gog.gogProductId);
  const epicId = firstString(storeIds.epic, epic.catalogItemId);
  const explicitSource = normalizeSourceKey(entry.source);
  const sources = [];
  for (const value of [...arr(entry.sources), ...arr(entry.ownedOn)]) {
    const key = normalizeSourceKey(value);
    if (key && !sources.includes(key)) sources.push(key);
  }
  if (!sources.length && explicitSource) sources.push(explicitSource);
  if (!sources.length && gogId) sources.push('gog');
  if (!sources.length && epicId) sources.push('epic');
  if (!sources.length && storeIds.steam) sources.push('steam');
  sources.sort((left, right) => {
    const li = SECONDARY_SOURCE_ORDER.indexOf(left);
    const ri = SECONDARY_SOURCE_ORDER.indexOf(right);
    return (li < 0 ? 99 : li) - (ri < 0 ? 99 : ri);
  });
  const source = explicitSource || sources.find((key) => key !== 'steam') || sources[0] || '';
  const name = firstString(entry.name, gog.title, epic.name, epic.title, entry.title);
  if (!name) return null;
  const hoursBySource = secondaryHoursBySource(entry, gog, epic);
  const hoursKnownFlag = boolOrNull(
    entry.hoursKnown ?? entry.playtimeKnown
    ?? gog.playtimeKnown ?? epic.playtimeKnown
  );
  const knownHours = SECONDARY_SOURCE_ORDER
    .map((key) => hoursBySource[key])
    .filter((value) => value != null);
  let hoursKnown = hoursKnownFlag == null ? knownHours.length > 0 : hoursKnownFlag;
  // The server's playtime snapshot is the only honest way to tell «never
  // launched» (0) from «playtime not fetched yet» (also 0). `playtimeFetchedAt`
  // is present but null while the GOG/Epic playtime snapshot is missing.
  if (hoursKnownFlag == null) {
    const sourceZero = (key) => hoursBySource[key] == null || hoursBySource[key] === 0;
    if (sources.includes('gog') && context.gogPlaytimeKnown === false && sourceZero('gog')) {
      hoursKnown = false;
    }
    if (sources.includes('epic') && context.epicPlaytimeKnown === false && sourceZero('epic')) {
      hoursKnown = false;
    }
  }
  let hours = null;
  let hoursSource = '';
  for (const key of SECONDARY_SOURCE_ORDER) {
    const value = hoursBySource[key];
    if (value == null) continue;
    if (hours == null || value > hours) {
      hours = value;
      hoursSource = key;
    }
  }
  const hoursParts = SECONDARY_SOURCE_ORDER
    .filter((key) => hoursKnown && hoursBySource[key] != null)
    .map((key) => ({
      source: key,
      label: SECONDARY_SOURCE_LABELS[key] || key,
      hours: hoursBySource[key],
      hoursText: hoursText(hoursBySource[key]),
    }));
  const hoursTextValue = hoursParts.length === 1
    ? hoursParts[0].hoursText
    : hoursParts.map((part) => `${part.label} ${part.hoursText}`).join(' · ');
  const image = normalizeHttpUrl(
    entry.verticalCoverUrl || entry.coverUrl || entry.image
    || gog.verticalCoverUrl || gog.coverUrl || gog.image
    || epic.verticalCoverUrl || epic.coverUrl || epic.image
  );
  const coverUrl = normalizeHttpUrl(entry.verticalCoverUrl || entry.coverUrl) || image;
  const releaseYear = numOrNull(entry.releaseYear ?? entry.year)
    ?? yearFromDate(entry.releaseDate)
    ?? yearFromDate(gog.releaseDate)
    ?? yearFromDate(epic.releaseDate);
  const genres = normalizeGenres(entry.genres ?? epic.genres ?? gog.genres);
  const slug = firstString(entry.slug, gog.slug, epic.slug);
  const gogSlug = firstString(gog.slug, entry.slug);
  const epicSlug = firstString(epic.slug, entry.slug);
  const storeLinks = [];
  if (gogSlug && (sources.includes('gog') || source === 'gog')) {
    storeLinks.push({ source: 'gog', label: 'GOG', href: `https://www.gog.com/game/${gogSlug}` });
  }
  if (epicSlug && (sources.includes('epic') || source === 'epic')) {
    storeLinks.push({ source: 'epic', label: 'Epic Games Store', href: `https://store.epicgames.com/p/${epicSlug}` });
  }
  return {
    workKey: text(entry.workKey) || null,
    key: text(entry.workKey) || (gogId ? `gog:${gogId}` : epicId ? `epic:${epicId}` : name),
    source,
    sources,
    sourceLabels: sources.map((key) => SECONDARY_SOURCE_LABELS[key] || key),
    sourceChips: sources.map((key) => ({
      source: key,
      label: SECONDARY_SOURCE_LABELS[key] || key,
    })),
    name,
    gogGameId: gogId,
    epicId,
    slug: slug || null,
    image: image || null,
    coverUrl: coverUrl || null,
    releaseDate: text(entry.releaseDate) || text(gog.releaseDate) || text(epic.releaseDate) || null,
    releaseYear: releaseYear != null ? Math.round(releaseYear) : null,
    genres,
    hoursBySource,
    hoursKnown,
    hours,
    hoursSource,
    hoursParts,
    hoursText: hoursTextValue,
    hoursUnknown: !hoursKnown || hours == null,
    notPlayed: hoursKnown && hours === 0,
    storeLinks,
    // Backward-compatible flat aliases used by the old «Источники» chips.
    gog,
    epic,
  };
}

function asSecondaryWork(work) {
  if (!work || typeof work !== 'object') return null;
  if (work.sourceLabels && work.hoursBySource && work.name) return work;
  return normalizeSecondaryWork(work);
}

/**
 * Client-side card for a secondary work. No network: Steam has no card for a
 * GOG/Epic-only game, and inventing one would be a lie. Every source gets its
 * own hours row, never a combined total.
 */
export function secondaryWorkCardView(work) {
  const row = asSecondaryWork(work);
  if (!row) return null;
  const hourRows = SECONDARY_SOURCE_ORDER.map((source) => {
    const present = row.sources.includes(source) || row.hoursBySource[source] != null;
    const hours = row.hoursBySource[source];
    const known = row.hoursKnown !== false;
    let status = '';
    if (!present) status = 'нет в библиотеке';
    else if (!known || hours == null) status = 'часы не получены';
    else if (hours === 0) status = 'не запущена';
    return {
      source,
      label: SECONDARY_SOURCE_LABELS[source] || source,
      present,
      hours: known ? hours : null,
      hoursText: known && hours != null ? hoursText(hours) : '',
      status,
    };
  });
  return {
    ...row,
    hourRows,
    hasKnownHours: hourRows.some((item) => item.hours != null),
    title: row.name,
    subtitle: [
      row.releaseYear ? String(row.releaseYear) : '',
      row.hoursText,
    ].filter(Boolean).join(' · '),
    note: 'Игра есть только вне Steam: карточка Steam Store, достижения и кредиты для неё не запрашиваются. '
      + 'Данные взяты из объединённой модели источников.',
  };
}

/**
 * Whether the chart buckets (`genres` / `years` / `decades`) include
 * secondary-only works. The M6c backend contract is additive; until it lands,
 * this returns `{ included: false }` and the widgets simply do not claim
 * anything. Both a summary flag and per-bucket counters are accepted.
 */
export function secondaryChartStatus(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const summary = p.summary && typeof p.summary === 'object' ? p.summary : {};
  const charts = summary.charts && typeof summary.charts === 'object' ? summary.charts : {};
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const explicit = boolOrNull(
    summary.chartsIncludeSecondary
    ?? summary.includeSecondaryInCharts
    ?? charts.includeSecondary
    ?? charts.includesSecondary
    ?? meta.chartsIncludeSecondary
    ?? p.chartsIncludeSecondary
  );
  let bucketFlag = false;
  for (const key of ['genres', 'years', 'decades']) {
    for (const item of arr(p[key])) {
      if (!item || typeof item !== 'object') continue;
      if (item.includesSecondary === true || item.secondary === true) bucketFlag = true;
      const count = numOrNull(
        item.secondaryCount ?? item.secondaryOnlyCount
        ?? item.secondaryWorks ?? item.secondary
      );
      if (count != null && count > 0) bucketFlag = true;
    }
  }
  const count = numOrNull(
    summary.secondaryWorksInCharts
    ?? summary.secondaryChartsWorks
    ?? summary.secondaryChartWorks
    ?? charts.secondaryWorks
    ?? charts.count
  );
  const included = (explicit === true && (count == null || count > 0))
    || bucketFlag
    || (count != null && count > 0);
  if (!included) return { included: false, count: null, text: '' };
  return {
    included: true,
    count: count != null ? count : null,
    text: count != null
      ? `включая вне Steam: ${fmtInt(count)}`
      : 'включая работы вне Steam',
  };
}

function normalizeStudios(raw) {
  return arr(raw)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const name = firstString(item.name, item.studio, item.label);
      if (!name) return null;
      const roles = arr(item.roles).map((role) => text(role)).filter(Boolean);
      const single = text(item.role);
      return {
        id: firstString(item.id, item.qid, item.key),
        name,
        qid: firstString(item.qid),
        roles: roles.length ? roles : (single ? [single] : []),
        count: toCount(item.count ?? item.gameCount),
        hours: numOrNull(item.hours ?? item.playtimeHours),
        avgCompletion: numOrNull(item.avgCompletion),
        games: normalizePersonGames(item.games),
        sources: arr(item.sources).map((source) => text(source)).filter(Boolean),
      };
    })
    .filter(Boolean);
}

function normalizePersonnelTop(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  let any = false;
  for (const [role, items] of Object.entries(raw)) {
    const list = arr(items)
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const name = firstString(item.name, item.label);
        if (!name) return null;
        return {
          id: firstString(item.id, item.qid),
          name,
          count: toCount(item.count),
          hours: numOrNull(item.hours),
        };
      })
      .filter(Boolean);
    if (list.length) any = true;
    out[role] = list;
  }
  return any ? out : null;
}

function normalizeAchievementDays(raw) {
  return arr(raw)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const date = text(item.date).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      return {
        date,
        count: toCount(item.count),
        appids: arr(item.appids).map((appid) => numOrNull(appid)).filter((appid) => appid != null),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function normalizeTimeline(raw) {
  return arr(raw)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const month = text(item.month).slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) return null;
      return {
        month,
        unlocked: toCount(item.unlocked ?? item.count),
        games: toCount(item.games),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.month.localeCompare(b.month));
}

function dayNumber(date) {
  const parsed = Date.parse(`${text(date).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 86400000) : null;
}

/** Server streaks, with a local fallback computed from `achievementDays`. */
function normalizeStreaks(raw, days) {
  const valid = (value) => dayNumber(value) != null;
  if (raw && typeof raw === 'object') {
    const current = Math.max(0, toCount(raw.current));
    const best = Math.max(0, toCount(raw.best));
    const lastRaw = raw.lastUnlockDate ?? raw.last ?? raw.lastDate;
    const lastUnlockDate = valid(lastRaw) ? text(lastRaw).slice(0, 10) : null;
    const bestDates = arr(raw.bestDates)
      .map((date) => text(date).slice(0, 10))
      .filter(valid);
    if (best > 0 || lastUnlockDate) return { current, best, lastUnlockDate, bestDates };
  }
  const dates = arr(days).map((day) => text(day && day.date).slice(0, 10)).filter(valid).sort();
  if (!dates.length) return null;
  let best = 1;
  let bestFrom = dates[0];
  let bestTo = dates[0];
  let run = 1;
  let runStart = dates[0];
  for (let index = 1; index < dates.length; index += 1) {
    if (dayNumber(dates[index]) - dayNumber(dates[index - 1]) === 1) run += 1;
    else {
      run = 1;
      runStart = dates[index];
    }
    if (run > best) {
      best = run;
      bestFrom = runStart;
      bestTo = dates[index];
    }
  }
  let current = 1;
  for (let index = dates.length - 1; index > 0; index -= 1) {
    if (dayNumber(dates[index]) - dayNumber(dates[index - 1]) === 1) current += 1;
    else break;
  }
  return { current, best, lastUnlockDate: dates[dates.length - 1], bestDates: [bestFrom, bestTo] };
}

function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const persona = firstString(raw.personaName, raw.persona, raw.name, raw.userKey, raw.key);
  if (!persona) return null;
  // `sources.profile.timeCreated` is unix seconds in the real payload (§5.1);
  // a bare number must not reach `formatDateRu`, which only understands dates.
  const memberSinceRaw = raw.memberSince ?? raw.timeCreated ?? null;
  const memberSinceSeconds = numOrNull(memberSinceRaw);
  const memberSince =
    memberSinceSeconds != null && memberSinceSeconds >= 100000000
      ? new Date(memberSinceSeconds * 1000).toISOString()
      : memberSinceRaw;
  return {
    key: text(raw.key),
    source: text(raw.source) || 'steam',
    userKey: text(raw.userKey),
    personaName: persona,
    avatarUrl: /^https?:\/\//i.test(text(raw.avatarUrl)) ? text(raw.avatarUrl) : '',
    privacy: text(raw.privacy).toLowerCase(),
    importedAt: text(raw.importedAt) || null,
    memberSince,
    gameCount: numOrNull(raw.gameCount),
    libraryPartial: boolOrNull(raw.libraryPartial),
  };
}

/**
 * `GET /api/games/stats` → the view model `games.js` renders.
 *
 * Keeps the raw-ish numbers next to their labels so the dashboard can decide
 * what to hide. `summary.has*` flags are derived, not assumed: a payload
 * without `topGames` must not produce an empty «Топ по часам» widget.
 */
export function normalizeGamesPayload(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const sourcesBlock = source.sources && typeof source.sources === 'object' ? source.sources : {};
  const profileRaw = sourcesBlock.profile && typeof sourcesBlock.profile === 'object'
    ? sourcesBlock.profile
    : (source.profile && typeof source.profile === 'object' ? source.profile : null);
  const summaryRaw = source.summary && typeof source.summary === 'object' ? source.summary : {};

  const profile = normalizeProfile(profileRaw);
  const gameCount = toCount(summaryRaw.gameCount);
  const ownedCount = toCount(summaryRaw.ownedCount);
  const playedCount = toCount(summaryRaw.playedCount);
  const unplayedCount = toCount(summaryRaw.unplayedCount);

  // The backend puts `libraryPartial` at the top level (§5.1); older drafts
  // nested it under `summary`/`sources`. Accept all three spellings.
  const libraryPartial = boolOrNull(summaryRaw.libraryPartial)
    ?? boolOrNull(source.libraryPartial)
    ?? boolOrNull(sourcesBlock.libraryPartial)
    ?? boolOrNull(profileRaw && profileRaw.libraryPartial)
    ?? null;
  // «ключ настроен?» is a boolean indicator only — the value never leaves the
  // server, and the UI prints «настроен / не настроен», never the token.
  // `/api/games/stats` reports it as `meta.keyConfigured`, `/profiles` as
  // `steamKey: { configured }`.
  const steamKeyConfigured = boolOrNull(summaryRaw.steamKeyConfigured)
    ?? boolOrNull(summaryRaw.steamKey)
    ?? boolOrNull(sourcesBlock.steamKeyConfigured)
    ?? boolOrNull(source.meta && source.meta.keyConfigured)
    ?? boolOrNull(source.steamKey && source.steamKey.configured)
    ?? boolOrNull(source.steamKeyConfigured);

  const summary = {
    gameCount,
    ownedCount: ownedCount || gameCount,
    playedCount,
    unplayedCount,
    totalHours: numOrNull(summaryRaw.totalHours),
    meanHours: numOrNull(summaryRaw.meanHours),
    medianHours: numOrNull(summaryRaw.medianHours),
    top10HoursShare: numOrNull(summaryRaw.top10HoursShare),
    recent2wHours: numOrNull(summaryRaw.recent2wHours ?? summaryRaw.recent2w),
    lastPlayedAt: summaryRaw.lastPlayedAt ?? null,
    libraryPartial,
    steamKeyConfigured,
    // «Не типизированы» (unmatched): Steam отдал запись библиотеки, но
    // appdetails ещё нет, поэтому тип/год/жанры неизвестны. `meta.excluded`
    // говорит, сколько записей отброшено как не-игры — это не то же число.
    unmatchedCount: toCount(source.unmatchedCount),
    excluded: normalizeExcluded(source.meta && source.meta.excluded),
    completion: normalizeCompletion(summaryRaw.completion),
    achievements: normalizeAchievements(summaryRaw.achievements),
    // M2 blocks (§5.1). Each stays `null` when the server did not send it:
    // the widget is hidden instead of printing an invented zero.
    modes: normalizeModes(summaryRaw.modes),
    earlyAccess: normalizeAccessBlock(summaryRaw.earlyAccess, summaryRaw),
    freeToPlay: normalizeAccessBlock(summaryRaw.freeToPlay, summaryRaw),
    metadata: normalizeMetadata(summaryRaw.metadata, summaryRaw),
    // M6a: per-source numbers (never summed). Kept raw-tolerant: a Steam-only
    // payload has no GOG keys and the widget simply does not print GOG rows.
    hoursBySource:
      summaryRaw.hoursBySource && typeof summaryRaw.hoursBySource === 'object'
        ? summaryRaw.hoursBySource
        : null,
    ownedBySource:
      summaryRaw.ownedBySource && typeof summaryRaw.ownedBySource === 'object'
        ? summaryRaw.ownedBySource
        : null,
    worksTotal: numOrNull(summaryRaw.worksTotal),
    secondaryOnlyWorks: toCount(summaryRaw.secondaryOnlyWorks),
    // Which counters the server actually sent. A missing field and a real
    // zero look identical after `toCount`, so the UI must not print «0 игр»
    // for a payload that simply has no `gameCount`.
    present: {
      gameCount: numOrNull(summaryRaw.gameCount) != null || numOrNull(summaryRaw.ownedCount) != null,
      playedCount: numOrNull(summaryRaw.playedCount) != null,
      unplayedCount: numOrNull(summaryRaw.unplayedCount) != null,
      totalHours: numOrNull(summaryRaw.totalHours) != null,
      meanHours: numOrNull(summaryRaw.meanHours) != null,
      medianHours: numOrNull(summaryRaw.medianHours) != null,
      top10HoursShare: numOrNull(summaryRaw.top10HoursShare) != null,
      recent2wHours: numOrNull(summaryRaw.recent2wHours ?? summaryRaw.recent2w) != null,
      completion: Boolean(normalizeCompletion(summaryRaw.completion)),
      modes: Boolean(normalizeModes(summaryRaw.modes)),
      access: Boolean(summaryRaw.earlyAccess || summaryRaw.freeToPlay),
      metadata: Boolean(normalizeMetadata(summaryRaw.metadata, summaryRaw)),
      unmatched: numOrNull(source.unmatchedCount) != null,
    },
  };

  const topGames = arr(source.topGames)
    .map(normalizeTopGame)
    .filter(Boolean)
    .sort((a, b) => (b.hours || 0) - (a.hours || 0));

  const recentlyPlayed = arr(source.recentlyPlayed ?? source.recent)
    .map(normalizeRecent)
    .filter(Boolean);

  const backlogRaw = source.backlog && typeof source.backlog === 'object' ? source.backlog : null;
  const backlog = {
    count: backlogRaw ? toCount(backlogRaw.count) : unplayedCount,
    share: numOrNull(backlogRaw && backlogRaw.share),
    items: arr(backlogRaw && backlogRaw.items).map(normalizeBacklogItem).filter(Boolean),
    present: Boolean(backlogRaw),
  };

  const gamesIndex = {};
  if (source.gamesIndex && typeof source.gamesIndex === 'object' && !Array.isArray(source.gamesIndex)) {
    for (const [appid, entry] of Object.entries(source.gamesIndex)) {
      if (!entry || typeof entry !== 'object') continue;
      gamesIndex[appid] = normalizeGameIndexEntry(entry, appid);
    }
  }

  const histogram = normalizeHistogram(source.hoursHistogram ?? source.histogram);

  // M2/M3 buckets. Empty arrays from an M1 server are normal: the widgets
  // disappear, the dashboard keeps working.
  const genres = normalizeWeightItems(source.genres);
  const tags = normalizeWeightItems(source.tags);
  // M4: Steam community scores (NOT personal), DLC summary and franchises.
  // `franchises` normally comes from `/api/games/franchises`, but a payload
  // that already carries the block is accepted instead of ignored.
  const scores = normalizeScores(source.scores);
  const reviewScore = normalizeReviewScoreBlock(summaryRaw.reviewScore ?? source.reviewScore);
  const dlc = normalizeDlcSummary(summaryRaw.dlc ?? source.dlc);
  const franchises = normalizeFranchises(source.franchises);
  const decades = normalizeDecades(source.decades);
  const years = normalizeYears(source.years);
  // «Год неизвестен» is a payload bucket, not a year: kept aside so the years
  // card can print «29 без года» after normalisation drops the null-year entry.
  const unknownYear = normalizeUnknownYear(source.years);
  const studios = normalizeStudios(source.studios);
  const personnelTop = normalizePersonnelTop(source.personnelTop);
  const timeline = normalizeTimeline(source.timeline);
  const achievementDays = normalizeAchievementDays(source.achievementDays);
  const streaks = normalizeStreaks(source.streaks, achievementDays);
  const filters = normalizeFilters(source.meta && source.meta.filters)
    || normalizeFilters(summaryRaw.filters);
  // `playtimeFetchedAt` is present-but-null when a secondary library was
  // imported without its playtime snapshot; that is what lets 0 h mean
  // «часы не получены» instead of a confident «не запущена».
  const playtimeFlag = (block) => {
    if (!block || typeof block !== 'object') return null;
    if (!Object.prototype.hasOwnProperty.call(block, 'playtimeFetchedAt')) return null;
    return Boolean(block.playtimeFetchedAt);
  };
  const secondaryContext = {
    gogPlaytimeKnown: playtimeFlag(sourcesBlock.gog),
    epicPlaytimeKnown: playtimeFlag(sourcesBlock.epic),
  };

  return {
    profile,
    summary,
    topGames,
    recentlyPlayed,
    backlog,
    histogram,
    gamesIndex,
    genres,
    tags,
    scores,
    reviewScore,
    dlc,
    franchises,
    decades,
    years,
    unknownYear,
    studios,
    personnelTop,
    timeline,
    achievementDays,
    streaks,
    filters,
    // M6a: raw source state + GOG/Epic-only works (chart drilldowns and the
    // client-side union card). Both stay empty for a Steam-only payload, so
    // existing widgets are unchanged.
    sources: sourcesBlock,
    secondaryWorks: arr(source.secondaryWorks)
      .map((entry) => normalizeSecondaryWork(entry, secondaryContext))
      .filter(Boolean),
    // Whether the server counted secondary-only works in genres/years/decades.
    // The raw buckets are read here because normalisation drops unknown flags.
    secondaryChart: secondaryChartStatus(source),
    has: {
      profile: Boolean(profile),
      games: gameCount > 0 || ownedCount > 0,
      hours: summary.totalHours != null,
      topGames: topGames.length > 0,
      backlog: backlog.count > 0,
      recently: recentlyPlayed.length > 0,
      histogram: histogram.length > 0,
      completion: Boolean(summary.completion),
      genres: genres.length > 0,
      tags: tags.length > 0,
      scores: scores.length > 0,
      reviewScore: Boolean(reviewScore),
      dlc: Boolean(dlc),
      franchises: franchises.length > 0,
      decades: decades.length > 0,
      years: years.length > 0,
      modes: Boolean(summary.modes),
      access: Boolean(summary.earlyAccess || summary.freeToPlay),
      metadata: Boolean(summary.metadata),
      filters: Boolean(filters),
      studios: studios.length > 0,
      personnelTop: Boolean(personnelTop),
      calendar: achievementDays.length > 0,
      streaks: Boolean(streaks && (streaks.best > 0 || streaks.lastUnlockDate)),
      unmatched: summary.unmatchedCount > 0,
      gamesIndex: Object.keys(gamesIndex).length > 0,
    },
  };
}

/* =========================================================
   client-side drilldowns (films parity: every row is a list)
   ========================================================= */

/**
 * Steam `type` → Russian label. A missing type is the honest «тип неизвестен»,
 * not «игра»: the library record exists but appdetails has not arrived yet.
 */
export function gameTypeLabel(type) {
  const key = text(type).toLowerCase();
  if (key === 'game') return 'игра';
  if (key === 'dlc') return 'DLC';
  if (key === 'demo') return 'демо';
  if (key === 'music') return 'саундтрек';
  if (key === 'tool') return 'софт';
  if (key === 'video') return 'видео';
  if (key === 'advertising') return 'реклама';
  return '';
}

/** Sort keys shared by every games list modal (persisted by games-modal.js). */
export const GAME_SORT_OPTIONS = [
  { key: 'hours', label: 'По часам', hint: 'часы ↓' },
  { key: 'completion', label: 'По completion', hint: 'completion ↓' },
  { key: 'year', label: 'По году релиза', hint: 'год ↓' },
  { key: 'name', label: 'По названию', hint: 'А → Я' },
];

function cmpGameName(a, b) {
  return String(a && a.name ? a.name : '').localeCompare(String(b && b.name ? b.name : ''), 'ru');
}

/** Return a new array ordered by the selected games-list sort. */
export function sortGameRows(rows, sortKey = 'hours') {
  const list = arr(rows).slice();
  const num = (value) => (value == null || !Number.isFinite(Number(value)) ? -1 : Number(value));
  const comparator = sortKey === 'completion'
    ? (a, b) => (num(b.completion) - num(a.completion)) || (num(b.hours) - num(a.hours)) || cmpGameName(a, b)
    : sortKey === 'year'
    ? (a, b) => (num(b.releaseYear) - num(a.releaseYear)) || (num(b.hours) - num(a.hours)) || cmpGameName(a, b)
    : sortKey === 'name'
    ? cmpGameName
    : (a, b) => (num(b.hours) - num(a.hours)) || cmpGameName(a, b);
  return list.sort(comparator);
}

/** Every `gamesIndex` entry that matches `predicate`, as normalised rows. */
/** Case-insensitive union of two name lists (edition merge). */
function unionNames(left, right) {
  const out = arr(left).slice();
  for (const name of arr(right)) {
    if (!out.some((value) => text(value).toLowerCase() === text(name).toLowerCase())) out.push(name);
  }
  return out;
}

/**
 * Two store editions of one game are **one canonical work** (M5-B): the same
 * rules `stats.js` uses for its aggregates, so a drilldown list always matches
 * the bar it was opened from.
 *
 * - the primary edition keeps the face (name/appid/icon → the card opens it);
 * - `hours` is the canonical total, `hours2w` adds up across editions;
 * - the release year is the earliest edition's (`workYear` = min) and
 *   genres/tags are the union (`workGenres`).
 */
function mergeEditionRows(previous, row) {
  const face = row.isPrimary === true && previous.isPrimary !== true ? row : previous;
  const other = face === previous ? row : previous;
  const canonical = [previous.canonicalHours, row.canonicalHours].filter((value) => value != null);
  const hours = canonical.length
    ? Math.max(...canonical)
    : (previous.hours || 0) + (row.hours || 0);
  const years = [previous.releaseYear, row.releaseYear].filter((value) => value != null);
  const releaseYear = years.length ? Math.min(...years) : null;
  return {
    ...face,
    hours,
    hours2w: (previous.hours2w || 0) + (row.hours2w || 0),
    releaseYear,
    year: releaseYear,
    genres: unionNames(face.genres, other.genres),
    tags: unionNames(face.tags, other.tags),
    editionCount: Math.max(previous.editionCount || 1, row.editionCount || 1),
    canonicalHours: canonical.length ? hours : face.canonicalHours,
  };
}

export function gameRowsFromIndex(gamesIndex, predicate = null) {
  const out = [];
  if (!gamesIndex || typeof gamesIndex !== 'object') return out;
  // M5-B: group by canonical work first, so every list/drilldown counts one
  // row per game — the same unit as `summary.gameCount` and the charts.
  const works = new Map();
  for (const [appid, entry] of Object.entries(gamesIndex)) {
    if (!entry || typeof entry !== 'object') continue;
    const row = normalizeGameIndexEntry(entry, appid);
    // M6c: a secondary-only work has no appid but is still a real owned work.
    // It must appear in the same drilldowns as the chart buckets that count it
    // (years/decades/genres), and its row opens the union card.
    const secondary = row.secondaryOnly === true || (row.appid == null && Boolean(row.workKey));
    if (row.appid == null && !secondary) continue;
    const key = row.canonicalWorkKey
      ? `work:${row.canonicalWorkKey}`
      : row.appid != null
        ? `appid:${row.appid}`
        : `work:${row.workKey || appid}`;
    const previous = works.get(key);
    works.set(key, previous ? mergeEditionRows(previous, row) : row);
  }
  for (const row of works.values()) {
    if (predicate && !predicate(row)) continue;
    out.push(row);
  }
  return out;
}

export function allGames(gamesIndex) {
  return gameRowsFromIndex(gamesIndex);
}

export function gamesInYear(gamesIndex, year) {
  const target = numOrNull(year);
  if (target == null) return [];
  return gameRowsFromIndex(gamesIndex, (row) => row.releaseYear === target);
}

/** Games of one release year that carry `genre` (Steam Store, case-insensitive). */
export function gamesInYearGenre(gamesIndex, year, genre) {
  const rows = gamesInYear(gamesIndex, year);
  const target = text(genre).toLowerCase();
  if (!target) return rows;
  return rows.filter((row) => arr(row.genres).some((name) => text(name).toLowerCase() === target));
}

/**
 * Release-year counts recomputed from `gamesIndex` for an optional genre.
 *
 * The unfiltered chart uses the server's `years[]` (already normalised), but
 * a genre filter has to be applied client-side — exactly like the films year
 * chart: no extra request, one pass over the index. Games without a release
 * year are counted apart (`unknown`) so they can be reported honestly instead
 * of being silently dropped or parked on a fake year.
 */
export function yearCountSeries(gamesIndex, genre = null) {
  const target = text(genre).toLowerCase();
  const map = new Map();
  let unknown = 0;
  let unknownHours = 0;
  // Canonical rows (M5-B): one row per work, canonical hours — otherwise the
  // client recount drifts from the server's `years[]` whenever a game has two
  // store editions with different release years.
  const rows = gameRowsFromIndex(
    gamesIndex,
    target
      ? (row) => arr(row.genres).some((name) => text(name).toLowerCase() === target)
      : null,
  );
  for (const row of rows) {
    const year = row.releaseYear;
    const hours = row.hours;
    if (year == null || year <= 0) {
      unknown += 1;
      if (hours != null) unknownHours += hours;
      continue;
    }
    const key = Math.round(year);
    const current = map.get(key) || { year: key, count: 0, hours: 0 };
    current.count += 1;
    if (hours != null) current.hours += hours;
    map.set(key, current);
  }
  const series = [...map.values()].sort((a, b) => a.year - b.year);
  return {
    series,
    total: series.reduce((sum, item) => sum + item.count, 0),
    unknown,
    unknownHours,
  };
}

export function gamesInDecade(gamesIndex, start) {
  const decade = numOrNull(start);
  if (decade == null) return [];
  return gameRowsFromIndex(gamesIndex, (row) => row.releaseYear != null
    && row.releaseYear >= decade && row.releaseYear <= decade + 9);
}

/** Records without a release year: the honest «год неизвестен» bucket. */
export function gamesWithoutYear(gamesIndex) {
  return gameRowsFromIndex(gamesIndex, (row) => row.releaseYear == null);
}

/** Records Steam never typed (no appdetails): type/year/genres are unknown. */
export function gamesWithoutType(gamesIndex) {
  return gameRowsFromIndex(gamesIndex, (row) => !row.type);
}

export function gamesByGenre(gamesIndex, name) {
  const target = text(name).toLowerCase();
  if (!target) return [];
  return gameRowsFromIndex(gamesIndex, (row) =>
    arr(row.genres).some((genre) => text(genre).toLowerCase() === target));
}

/** Games with `playtime_2weeks > 0` — the «за 2 недели» tile drilldown. */
export function gamesWithRecentHours(gamesIndex) {
  return gameRowsFromIndex(gamesIndex, (row) => row.hours2w != null && row.hours2w > 0);
}

/** `years[]` limited to one decade, ascending (the years card is gated). */
export function yearsInDecade(years, start) {
  const decade = numOrNull(start);
  if (decade == null) return [];
  return normalizeYears(years)
    .filter((item) => item.year >= decade && item.year <= decade + 9)
    .sort((a, b) => a.year - b.year);
}

/** «N игр · X ч» — the person row / modal subtitle. */
export function personSummaryText(person) {
  const count = toCount(person && person.count);
  const hours = numOrNull(person && person.hours);
  return `${fmtInt(count)} ${plural(count, GAME_PLURAL)}${hours != null ? ` · ${hoursText(hours)}` : ''}`;
}

/**
 * One person's games joined with `gamesIndex` (completion/year/icon live only
 * in the index; the personnel payload carries appid/name/hours).
 */
export function personGames(person, gamesIndex) {
  const index = gamesIndex && typeof gamesIndex === 'object' ? gamesIndex : {};
  return arr(person && person.games)
    .map((game) => {
      if (!game || typeof game !== 'object') return null;
      const appid = numOrNull(game.appid);
      if (appid == null) return null;
      const entry = index[appid] || index[String(appid)] || null;
      const row = entry
        ? normalizeGameIndexEntry(entry, appid)
        : normalizeGameIndexEntry({ appid }, appid);
      return {
        ...row,
        appid,
        name: firstString(game.name, row.name, `appid ${appid}`),
        hours: numOrNull(game.hours) ?? row.hours,
        completion: row.completion ?? numOrNull(game.completion),
        roles: arr(game.roles).map((role) => text(role)).filter(Boolean),
      };
    })
    .filter(Boolean);
}

/* =========================================================
   game card (`GET /api/games/game/:appid`)
   ========================================================= */

/** Card review badge: `{score, desc, label, color}` from a number or object. */
function normalizeCardReview(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number' || typeof raw === 'string') {
    const score = resolveReviewBucket(raw);
    if (score == null) return null;
    const entry = reviewScaleEntry(score);
    return { score, desc: entry.desc, label: entry.label, color: entry.color };
  }
  if (typeof raw !== 'object') return null;
  const score = resolveReviewBucket(raw.score ?? raw.bucket ?? raw.review_score ?? raw.desc ?? raw.review_score_desc);
  const desc = firstString(raw.desc, raw.review_score_desc, raw.description);
  if (score == null && !desc) return null;
  const entry = score != null ? reviewScaleEntry(score) : null;
  return {
    score: score ?? null,
    desc: desc || (entry ? entry.desc : ''),
    label: entry ? entry.label : '',
    color: entry ? entry.color : '#8f9464',
  };
}

function normalizeCardDetails(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    type: text(raw.type).toLowerCase(),
    name: firstString(raw.name),
    isFree: boolOrNull(raw.isFree),
    earlyAccess: boolOrNull(raw.earlyAccess),
    developers: normalizeGenres(raw.developers),
    publishers: normalizeGenres(raw.publishers),
    genres: normalizeGenres(raw.genres),
    categories: normalizeGenres(raw.categories),
    releaseDate: text(raw.releaseDate),
    releaseYear: numOrNull(raw.releaseYear),
    metacritic: numOrNull(raw.metacritic),
    dlcCount: numOrNull(raw.dlcCount),
    // M4 card extras: tag strip, review badge, franchise label.
    tags: normalizeTagsList(raw.tags),
    reviewScore: normalizeCardReview(raw.reviewScore ?? raw.review),
    franchise: normalizeFranchiseRef(raw.franchise ?? raw.collection),
    platforms: raw.platforms && typeof raw.platforms === 'object'
      ? {
        windows: raw.platforms.windows === true,
        mac: raw.platforms.mac === true,
        linux: raw.platforms.linux === true,
      }
      : null,
    metadataSource: text(raw.metadataSource),
  };
}

function normalizeCardAchievements(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const items = arr(raw.items)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const name = firstString(item.name, item.apiname);
      if (!name) return null;
      return {
        apiname: text(item.apiname),
        name,
        description: text(item.description),
        achieved: item.achieved === true || item.achieved === 1 || item.achieved === '1',
        unlockTimestamp: numOrNull(item.unlockTimestamp),
        unlockAt: text(item.unlockAt) || null,
      };
    })
    .filter(Boolean);
  const unlocked = numOrNull(raw.unlocked);
  const total = numOrNull(raw.total);
  const percent = numOrNull(raw.percent);
  if (unlocked == null && total == null && !items.length) return null;
  return {
    unlocked,
    total,
    percent,
    fetchedAt: text(raw.fetchedAt) || null,
    items,
  };
}

function normalizeCardPersonnel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const people = arr(raw.people)
    .map((person) => {
      if (!person || typeof person !== 'object') return null;
      const name = firstString(person.name, person.label);
      if (!name) return null;
      return {
        name,
        roles: arr(person.roles).map((role) => text(role)).filter(Boolean),
        qid: text(person.qid) || null,
        sources: arr(person.sources).map((source) => text(source)).filter(Boolean),
      };
    })
    .filter(Boolean);
  const studios = arr(raw.studios)
    .map((studio) => {
      if (!studio || typeof studio !== 'object') return null;
      const name = firstString(studio.name, studio.label);
      if (!name) return null;
      return {
        name,
        roles: arr(studio.roles).map((role) => text(role)).filter(Boolean),
        qid: text(studio.qid) || null,
        sources: arr(studio.sources).map((source) => text(source)).filter(Boolean),
      };
    })
    .filter(Boolean);
  const coverage = raw.coverage && typeof raw.coverage === 'object'
    ? {
      people: toCount(raw.coverage.people),
      studios: toCount(raw.coverage.studios),
      roles: arr(raw.coverage.roles).map((role) => text(role)).filter(Boolean),
    }
    : null;
  if (!people.length && !studios.length && !coverage) return null;
  return {
    people,
    studios,
    coverage,
    pending: arr(raw.pending).map((entry) => text(entry)).filter(Boolean),
    sources: arr(raw.sources).map((source) => text(source)).filter(Boolean),
  };
}

/**
 * `GET /api/games/game/:appid` → the card view model. Links are completed on
 * the client when the server has not cached them yet (the URL shape is fixed
 * by Steam, no request is made).
 */
export function normalizeGameCard(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const appid = numOrNull(source.appid);
  const details = normalizeCardDetails(source.details);
  const achievements = normalizeCardAchievements(source.achievements);
  const personnel = normalizeCardPersonnel(source.personnel);
  const last = lastPlayedInfo(source.lastPlayed);
  const linksRaw = source.links && typeof source.links === 'object' ? source.links : {};
  // A card may carry these at the top level or inside `details` (the server
  // is free to keep them next to the store document).
  const tags = (details && details.tags && details.tags.length)
    ? details.tags
    : normalizeTagsList(source.tags);
  const reviewScore = (details && details.reviewScore)
    || normalizeCardReview(source.reviewScore ?? source.review);
  const franchise = (details && details.franchise)
    || normalizeFranchiseRef(source.franchise ?? source.collection ?? arr(source.franchises)[0]);
  const links = {
    steam: firstString(linksRaw.steam)
      || (appid != null ? `https://store.steampowered.com/app/${appid}` : ''),
    community: appid != null ? `https://steamcommunity.com/app/${appid}` : '',
    steamdb: firstString(linksRaw.steamdb)
      || (appid != null ? `https://steamdb.info/app/${appid}/` : ''),
  };
  return {
    appid,
    // Canonical edition of the work (M5-B payload); the cover prefers it so
    // both editions of one game show the same header.
    primaryAppid: numOrNull(source.primaryAppid ?? source.primary_appid),
    name: firstString(source.name, details && details.name, appid != null ? `appid ${appid}` : ''),
    iconUrl: /^https?:\/\//i.test(text(source.iconUrl)) ? text(source.iconUrl) : '',
    hours: normalizeHours(source),
    hours2w: normalizeHours2w(source),
    lastPlayed: source.lastPlayed ?? null,
    lastPlayedText: last.text,
    lastPlayedTitle: last.title,
    type: text(details && details.type || source.type).toLowerCase(),
    typeLabel: gameTypeLabel(details && details.type || source.type),
    releaseYear: numOrNull(details && details.releaseYear),
    releaseDate: text(details && details.releaseDate),
    completion: numOrNull(source.completion) ?? (achievements && achievements.percent != null
      ? achievements.percent
      : null),
    tags,
    reviewScore,
    franchise,
    achievements,
    details,
    personnel,
    links,
    meta: source.meta && typeof source.meta === 'object' ? source.meta : null,
  };
}

/* =========================================================
   widgets
   ========================================================= */

/**
 * Profile card («Профиль Steam»): persona, avatar, member since, import date.
 * Returns `null` when the payload carries no profile block — the widget is
 * then hidden instead of showing a nameless card.
 */
export function profileCardView(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const persona = firstString(profile.personaName, profile.persona, profile.userKey, profile.key);
  if (!persona) return null;
  const memberSince = formatDateRu(profile.memberSince);
  const importedAt = formatDateRu(profile.importedAt);
  const privacy = text(profile.privacy).toLowerCase();
  const privacyText = privacy === 'public'
    ? 'профиль открыт'
    : privacy
    ? `приватность: ${privacy}`
    : '';
  const facts = [];
  if (memberSince) {
    facts.push({ label: 'в Steam с', value: memberSince, title: 'memberSince / timecreated профиля Steam' });
  }
  if (importedAt) {
    facts.push({ label: 'импорт', value: importedAt, title: 'Дата последнего импорта этого профиля в kinoboxd' });
  }
  if (profile.userKey) {
    facts.push({
      label: 'steamid64',
      value: String(profile.userKey),
      title: 'Постоянный идентификатор владельца профиля в Steam. Второй steamid64 — другой профиль, статистика не суммируется.',
    });
  }
  return {
    persona,
    initial: persona.slice(0, 1).toUpperCase(),
    avatarUrl: /^https?:\/\//i.test(text(profile.avatarUrl)) ? text(profile.avatarUrl) : '',
    privacy,
    privacyText,
    memberSince,
    importedAt,
    gameCount: numOrNull(profile.gameCount),
    facts,
  };
}

/**
 * Summary-strip metrics. Each entry exists only when its number exists:
 * `{ key, icon, label, value, sub, title }`.
 */
export function summaryMetrics(summary, { profile = null } = {}) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const present = s.present && typeof s.present === 'object' ? s.present : {};
  const out = [];
  // Without a Steam key the server still answers, but the library numbers are
  // unknown rather than zero: printing «0 игр / 0 ч» would be a lie, so the
  // strip keeps only what does not depend on the library (completion).
  const libraryKnown = s.libraryPartial !== true;

  const games = toCount(s.gameCount) || toCount(s.ownedCount);
  if (libraryKnown && present.gameCount) {
    const parts = [];
    if (s.playedCount > 0) parts.push(`${fmtInt(s.playedCount)} с часами`);
    if (s.unplayedCount > 0) parts.push(`${fmtInt(s.unplayedCount)} без часов`);
    out.push({
      key: 'games',
      icon: 'gamepad',
      label: 'игр',
      value: fmtInt(games),
      sub: parts.join(' · ') || 'в библиотеке Steam',
      title: `Игр в библиотеке: ${fmtInt(s.gameCount)}. Записей всего: ${fmtInt(s.ownedCount)}. `
        + 'DLC, демо и софт в статистику часов не входят (когда сервер умеет их отличать).',
    });
  }
  if (libraryKnown && present.totalHours) {
    out.push({
      key: 'hours',
      icon: 'clock',
      label: 'часов',
      value: hoursText(s.totalHours, 0),
      sub: s.meanHours != null ? `в среднем ${hoursText(s.meanHours)}` : 'Σ часов по Steam',
      title: HOURS_HINT,
    });
  }
  if (libraryKnown && present.unplayedCount) {
    const share = games > 0 ? s.unplayedCount / games : null;
    out.push({
      key: 'backlog',
      icon: 'book',
      label: 'backlog',
      value: fmtInt(s.unplayedCount),
      sub: share != null ? `${percentText(share)} библиотеки` : 'без часов',
      title: 'Игры с playtime_forever = 0: есть в библиотеке, но ни разу не запускались по данным Steam.',
    });
  }
  if (libraryKnown && present.medianHours) {
    out.push({
      key: 'median',
      icon: 'clock',
      label: 'медиана',
      value: hoursText(s.medianHours),
      sub: 'часов на игру',
      title: 'Половина игр библиотеки имеет меньше часов, половина — больше. Медиана не боится «тысячи часов в одной игре».',
    });
  }
  if (libraryKnown && present.top10HoursShare) {
    out.push({
      key: 'pareto',
      icon: 'star',
      label: 'топ-10%',
      value: percentText(s.top10HoursShare),
      sub: 'всех часов',
      title: 'Доля всех часов, которая приходится на 10% самых игранных игр библиотеки (принцип Парето).',
    });
  }
  if (libraryKnown && present.recent2wHours) {
    const last = lastPlayedInfo(s.lastPlayedAt);
    out.push({
      key: 'recent',
      icon: 'calendar',
      label: 'за 2 недели',
      value: hoursText(s.recent2wHours),
      sub: last.unknown ? 'недавней активности нет' : `последний запуск ${last.text}`,
      title: `${last.title} Часы за 2 недели — Σ playtime_2weeks по данным Steam.`,
    });
  }
  if (s.completion && s.completion.avgPercent != null) {
    out.push({
      key: 'completion',
      icon: 'check',
      label: 'completion',
      value: percentText(s.completion.avgPercent, 0),
      sub: s.completion.gamesWithStats > 0
        ? `средний по ${fmtInt(s.completion.gamesWithStats)} ${plural(s.completion.gamesWithStats, ['игре', 'играм', 'играм'])} с достижениями`
        : 'средний процент достижений',
      title: 'Средний процент полученных достижений. Считается только по играм, у которых есть статистика достижений — недоступные не считаются нулём.',
    });
  }
  if (s.unmatchedCount > 0) {
    const excluded = s.excluded && typeof s.excluded === 'object' ? s.excluded : null;
    const otherType = excluded ? toCount(excluded.otherType) : 0;
    out.push({
      key: 'unmatched',
      icon: 'alert',
      label: 'не типизированы',
      extraClass: 'metric-unmatched',
      value: fmtInt(s.unmatchedCount),
      sub: otherType > 0 ? `${fmtInt(otherType)} записей — не игры` : 'нет appdetails',
      title: 'Записи библиотеки Steam без карточки Steam Store: тип, год и жанры неизвестны. '
        + 'Это не «ноль часов» и не удалённые игры — сервер просто ещё не получил appdetails. '
        + (otherType > 0 ? `${fmtInt(otherType)} записей отброшено как DLC/софт/демо.` : ''),
    });
  }
  // M4: community review score. It is deliberately labelled «Steam», because
  // Steam has no personal ratings and this must not look like one.
  if (s.reviewScore && (s.reviewScore.avg != null || s.reviewScore.median != null)) {
    const fmtScore = (value) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value);
    const avg = s.reviewScore.avg;
    const median = s.reviewScore.median;
    out.push({
      key: 'review',
      icon: 'star',
      label: 'оценка Steam',
      value: avg != null ? `${fmtScore(avg)}/9` : '—',
      sub: median != null ? `медиана ${fmtScore(median)}` : 'community score',
      title: 'Средняя community-оценка игр библиотеки по шкале Steam 1–9 (appreviews). '
        + 'Это оценки сообщества Steam, а не ваши личные: личных оценок у Steam нет.',
    });
  }
  return out;
}

/**
 * Pareto lane: «топ-10% игр = X% часов». `sharePercent` drives the bar, `rest`
 * is what remains for the long tail. `null` when the payload has no share.
 */
export function paretoView(summary, { topPercent = 10 } = {}) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const sharePercent = percentNumber(s.top10HoursShare);
  if (sharePercent == null) return null;
  const total = toCount(s.gameCount) || toCount(s.ownedCount);
  const topCount = total > 0 ? Math.max(1, Math.round((total * topPercent) / 100)) : null;
  return {
    topPercent,
    sharePercent,
    restPercent: Math.max(0, 100 - sharePercent),
    topCount,
    total,
    shareText: percentText(s.top10HoursShare),
    text: topCount
      ? `Топ-${topPercent}% игр (${fmtInt(topCount)} из ${fmtInt(total)}) дают ${percentText(s.top10HoursShare)} всех часов`
      : `Топ-${topPercent}% игр дают ${percentText(s.top10HoursShare)} всех часов`,
    hint: '«Топ-10%» — самые игранные игры библиотеки; остальные 90% делят оставшиеся часы. Часы — по данным Steam.',
  };
}

/**
 * Top-by-hours rows (bar lane). `totalHours` (the library total) turns each
 * row's tooltip into an honest share of all hours.
 */
export function topHoursRows(topGames, { limit = 10, totalHours = null } = {}) {
  const list = arr(topGames)
    .map((item) => (item && item.name && item.hours != null ? item : null))
    .filter(Boolean)
    .sort((a, b) => b.hours - a.hours);
  const shown = limit > 0 ? list.slice(0, limit) : list;
  const max = shown.length ? Math.max(...shown.map((item) => item.hours)) : 0;
  return shown.map((game, index) => {
    const last = game.lastPlayed != null ? lastPlayedInfo(game.lastPlayed) : null;
    const share = totalHours != null && totalHours > 0 ? (game.hours / totalHours) * 100 : null;
    return {
      rank: index + 1,
      appid: game.appid,
      // M6c: a secondary-only work has no appid; its own `workKey` opens the
      // client-side union card instead of a Steam card.
      workKey: game.workKey ?? game.canonicalWorkKey ?? null,
      secondaryOnly: Boolean(game.secondaryOnly || game.appid == null),
      name: game.name,
      hours: game.hours,
      hoursText: hoursText(game.hours),
      widthPercent: max > 0 ? Math.max(2, (game.hours / max) * 100) : 2,
      sharePercent: share,
      lastPlayedText: last ? last.text : '',
      title: `${game.name} — ${hoursText(game.hours)}`,
      hint: share != null
        ? `${percentText(share / 100)} всех часов библиотеки${last ? ` · последний запуск ${last.text}` : ''}`
        : last
        ? `последний запуск ${last.text}`
        : '',
    };
  });
}

/** Unix seconds from an ISO stamp, a unix-seconds number or a Date. */
function epochSeconds(value) {
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

function shortDayText(seconds) {
  if (!seconds) return '';
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getUTCDate()} ${MONTHS_SHORT_RU[date.getUTCMonth()]}`;
}

export const RECENT_STRIP_LIMIT = 15;
/** A launch without 2-week hours still counts as «recently played» this long. */
export const RECENT_STRIP_WINDOW_DAYS = 30;

/**
 * «Недавно играл» top strip (the films/books «Недавно смотрел» pattern).
 *
 * Cards are the first `limit` games by `rtime_last_played` desc. Recent ones
 * (2-week hours > 0 OR last launch inside `RECENT_STRIP_WINDOW_DAYS`) come
 * first; older launches fill the remaining slots in the same rtime order, so
 * the strip is never half-empty. The payload's `recentlyPlayed` is the primary
 * source; `gamesIndex` is the tolerant fallback (and fills the icon/date for
 * entries the payload trimmed), so an older server that only sends the index
 * still paints an honest strip. `now` is injectable for tests.
 *
 * M5-B editions: two store editions of one game (GTA III vs GTA III
 * re-release, BioShock vs Remastered) are **one canonical work** in every
 * other widget, so they are one card here too. `canonicalWorkKey` from the
 * payload/index is the merge key (fallback: appid, then the index's
 * appid→work map so a payload row without the key still merges); 2-week hours
 * add up across editions. The server's `recentlyPlayed` row is the canonical
 * one (primary edition, aggregated hours) and keeps the card face when both
 * sources describe the same work; the index fills the gaps (icon/date) and
 * wins the face only among its own rows.
 */
export function recentStripView(recentlyPlayed, gamesIndex, { limit = RECENT_STRIP_LIMIT, now = Date.now() } = {}) {
  const index = gamesIndex && typeof gamesIndex === 'object' ? gamesIndex : {};
  const max = Math.max(1, toCount(limit) || RECENT_STRIP_LIMIT);
  const cutoff = Math.floor(toNum(now, Date.now()) / 1000) - RECENT_STRIP_WINDOW_DAYS * 86400;
  /** merge key → { face fields, hours2wByAppid, hoursTotal, fresh, recent } */
  const rows = new Map();

  // appid → canonical work key, taken from the index once. A payload row that
  // predates `canonicalWorkKey` (or a test fixture without it) then lands in
  // the same card as its editions instead of painting the work twice.
  const workByAppid = new Map();
  for (const entry of Object.values(index)) {
    if (!entry || typeof entry !== 'object') continue;
    const key = firstString(entry.canonicalWorkKey);
    const appid = numOrNull(entry.appid);
    if (key && appid != null) workByAppid.set(`appid:${appid}`, key);
  }

  const push = (raw, fallbackEntry, { server = false } = {}) => {
    const item = raw && typeof raw === 'object' ? raw : {};
    const entry = fallbackEntry && typeof fallbackEntry === 'object' ? fallbackEntry : {};
    const name = firstString(item.name, item.title, entry.name);
    if (!name) return;
    const appid = numOrNull(item.appid ?? entry.appid);
    const appidKey = appid != null ? `appid:${appid}` : `name:${name}`;
    const workKey = firstString(item.canonicalWorkKey, entry.canonicalWorkKey)
      || workByAppid.get(appidKey)
      || '';
    // Canonical work first: editions of one game share a card (M5-B).
    const key = workKey ? `work:${workKey}` : appidKey;
    const primaryAppid = numOrNull(item.primaryAppid ?? entry.primaryAppid) ?? appid;
    const hours2w = numOrNull(item.hours2w ?? item.playtime_2weeks ?? entry.hours2w);
    const hoursTotal = numOrNull(
      item.hoursTotal ?? item.canonicalHours ?? item.hours ?? entry.canonicalHours ?? entry.hours
    );
    const lastPlayed = item.lastPlayed ?? item.rtime_last_played
      ?? entry.lastPlayed ?? entry.rtime ?? null;
    const rtime = epochSeconds(lastPlayed);
    const fresh = hours2w != null && hours2w > 0;
    const recent = rtime > 0 && rtime >= cutoff;
    // A never-launched game with no 2-week hours has nothing to say here.
    if (!fresh && rtime <= 0) return;
    const iconUrl = firstString(item.iconUrl, item.icon, entry.iconUrl) || '';
    // M6c: cross-store facts travel with the card face (GOG badge, own poster).
    const sources = arr(item.sources ?? entry.sources)
      .map((value) => String(value))
      .filter(Boolean);
    const coverUrl = firstString(item.coverUrl, entry.coverUrl) || '';
    const previous = rows.get(key);
    if (!previous) {
      const hours2wByAppid = new Map();
      if (fresh) hours2wByAppid.set(appidKey, hours2w);
      rows.set(key, {
        appid,
        primaryAppid,
        name,
        rtime,
        lastPlayed,
        iconUrl,
        coverUrl,
        sources,
        hours2wByAppid,
        hoursTotal,
        fresh,
        // «Недавно» = 2-week hours or a launch inside the window. Older launches
        // still fill the strip after them (the limit is what keeps it short).
        recent: fresh || recent,
        // Card-face provenance: `true` for the payload's canonical row.
        fromServer: server,
        faceRtime: rtime,
        faceFresh: fresh,
      });
      return;
    }
    // Same canonical work (or the payload row re-seen in the index): 2-week
    // hours are additive per edition and never double-count one appid.
    if (fresh) previous.hours2wByAppid.set(appidKey, hours2w);
    for (const source of sources) {
      if (!previous.sources.includes(source)) previous.sources.push(source);
    }
    if (!previous.coverUrl && coverUrl) previous.coverUrl = coverUrl;
    if (hoursTotal != null) {
      previous.hoursTotal =
        previous.hoursTotal == null ? hoursTotal : Math.max(previous.hoursTotal, hoursTotal);
    }
    previous.fresh = previous.fresh || fresh;
    previous.recent = previous.recent || (fresh || recent);
    // The launch stamp is the work's newest one, whatever the source: the
    // index knows a launch the trimmed payload row may have missed.
    if (rtime > previous.rtime) {
      previous.rtime = rtime;
      previous.lastPlayed = lastPlayed;
    }
    // The face (name/appid that opens the card) follows the canonical rule:
    // server row over index row; inside one source, the newest launch wins.
    const winsFace = previous.fromServer === server
      ? rtime > previous.faceRtime || (rtime === previous.faceRtime && fresh && !previous.faceFresh)
      : server;
    if (winsFace) {
      previous.appid = appid;
      previous.primaryAppid = primaryAppid ?? previous.primaryAppid;
      previous.name = name;
      previous.fromServer = server;
      previous.faceRtime = rtime;
      previous.faceFresh = fresh;
      if (iconUrl) previous.iconUrl = iconUrl;
    } else if (!previous.iconUrl && iconUrl) {
      // The server row may arrive without an icon (trimmed payload): the
      // index is allowed to fill it without touching the face.
      previous.iconUrl = iconUrl;
    }
  };

  for (const item of arr(recentlyPlayed)) push(item, null, { server: true });
  for (const entry of Object.values(index)) push(entry, entry);

  const byRecent = (left, right) =>
    (right.rtime - left.rtime)
    || ((right.hours2w || 0) - (left.hours2w || 0))
    || left.name.localeCompare(right.name);
  const all = [...rows.values()].sort(byRecent);
  // Recent launches first; when there are fewer than `limit`, the older ones
  // fill the strip in the same rtime order instead of leaving it half-empty.
  const ordered = [
    ...all.filter((row) => row.recent),
    ...all.filter((row) => !row.recent),
  ].slice(0, max);
  const items = ordered
    .map((row) => {
      const hours2w = [...row.hours2wByAppid.values()].reduce((sum, value) => sum + value, 0);
      const fresh = hours2w > 0;
      const hours2wText = fresh ? hoursText(hours2w) : '';
      const hoursTotalText = row.hoursTotal != null ? hoursText(row.hoursTotal) : '';
      return {
        appid: row.appid,
        // The cover is built from the canonical primary edition's appid; the
        // card still opens on the face appid.
        primaryAppid: row.primaryAppid ?? row.appid,
        name: row.name,
        hours2w,
        hours2wText,
        hoursTotalText,
        rtime: row.rtime,
        lastPlayedText: shortDayText(row.rtime),
        lastPlayedTitle: lastPlayedInfo(row.lastPlayed).title,
        iconUrl: row.iconUrl,
        // M6c: the card face can carry a non-Steam poster and a store badge.
        coverUrl: row.coverUrl,
        sources: row.sources,
        fresh,
        recent: row.recent,
        caption: fresh
          ? `${hours2wText} за 2 недели`
          : row.rtime
          ? `последний раз: ${shortDayText(row.rtime)}`
          : 'недавняя активность',
        hint: [
          fresh ? `${hours2wText} за 2 недели` : 'за 2 недели часов нет',
          hoursTotalText ? `${hoursTotalText} всего` : '',
          row.rtime ? `последний запуск ${shortDayText(row.rtime)}` : '',
        ].filter(Boolean).join(' · '),
      };
    });

  const total2w = items.reduce((sum, item) => sum + (item.hours2w || 0), 0);
  return {
    items,
    visible: items.length > 0,
    total2wText: total2w > 0 ? hoursText(total2w) : '',
    note: items.length
      ? `${fmtInt(items.length)} ${plural(items.length, GAME_PLURAL)}${total2w > 0 ? ` · ${hoursText(total2w)} за 2 недели` : ''}`
      : '',
  };
}

/* =========================================================
   M2: decades / years / genres / enrichment
   ========================================================= */

const YEAR_NOTE = 'Год релиза игры (release_date из Steam Store / Wikidata), а не год, когда вы в неё играли.';

/** `decades[]` → ranked rows, «год неизвестен» always last. */
export function decadesView(decades) {
  const list = normalizeDecades(decades).filter((item) => item.count > 0);
  if (!list.length) return null;
  const sorted = list.slice().sort((a, b) => {
    if (a.unknown || b.unknown) return a.unknown ? 1 : -1;
    return (a.decade || 0) - (b.decade || 0);
  });
  const total = sorted.reduce((sum, item) => sum + item.count, 0);
  const max = Math.max(1, ...sorted.map((item) => item.count));
  const known = sorted.filter((item) => !item.unknown);
  const unknown = sorted.find((item) => item.unknown) || null;
  return {
    rows: sorted.map((item) => ({
      key: item.key,
      label: item.label,
      decade: item.decade,
      unknown: item.unknown,
      count: item.count,
      countText: fmtInt(item.count),
      hours: item.hours,
      hoursText: item.hours != null ? hoursText(item.hours) : '',
      shareText: total > 0 ? percentText(item.count / total) : '',
      widthPercent: Math.max(2, (item.count / max) * 100),
      title: item.unknown
        ? `год неизвестен — ${fmtInt(item.count)} ${plural(item.count, GAME_PLURAL)}`
        : `${item.label} — ${fmtInt(item.count)} ${plural(item.count, GAME_PLURAL)}`,
      hint: item.hours != null
        ? `${hoursText(item.hours)} по данным Steam · ${YEAR_NOTE}`
        : YEAR_NOTE,
    })),
    total,
    totalText: fmtInt(total),
    knownCount: known.reduce((sum, item) => sum + item.count, 0),
    unknownCount: unknown ? unknown.count : 0,
    note: known.length === 1
      ? `${known[0].label}${unknown && unknown.count > 0 ? ` · ${fmtInt(unknown.count)} без года` : ''}`
      : known.length
      ? `${known[0].label} — ${known[known.length - 1].label}`
        + (unknown && unknown.count > 0 ? ` · ${fmtInt(unknown.count)} без года` : '')
      : unknown
      ? `год неизвестен · ${fmtInt(unknown.count)}`
      : '',
  };
}

/**
 * `years[]` → ascending bars; the caller paints them with `renderYearBars`.
 *
 * «Год неизвестен» is a real payload bucket (`{ year: null, unknown: true }`)
 * but not a year on the axis: it is reported apart (`unknownCount`) so the note
 * can say «29 без года» instead of silently dropping those games. A payload
 * with only unknown entries still returns a view — the card shows an honest
 * empty state rather than disappearing.
 */
export function yearsView(years) {
  const list = normalizeYears(years);
  const unknown = arr(years).filter((item) => item && typeof item === 'object' && item.unknown);
  const unknownCount = unknown.reduce((sum, item) => sum + toCount(item.count), 0);
  const unknownHours = unknown
    .map((item) => numOrNull(item.hours))
    .filter((value) => value != null);
  if (!list.length && !unknownCount) return null;
  const sorted = list.slice().sort((a, b) => a.year - b.year);
  const total = sorted.reduce((sum, item) => sum + item.count, 0);
  const withHours = sorted.filter((item) => item.hours != null);
  return {
    years: sorted,
    total,
    totalText: fmtInt(total),
    minYear: sorted.length ? sorted[0].year : null,
    maxYear: sorted.length ? sorted[sorted.length - 1].year : null,
    hoursTotal: withHours.length
      ? withHours.reduce((sum, item) => sum + item.hours, 0)
      : null,
    unknownCount,
    unknownHours: unknownHours.length
      ? unknownHours.reduce((sum, value) => sum + value, 0)
      : null,
    note: !sorted.length
      ? ''
      : sorted.length === 1
      ? `${sorted[0].year} · ${fmtInt(total)} ${plural(total, GAME_PLURAL)}`
      : `${sorted[0].year} — ${sorted[sorted.length - 1].year} · ${fmtInt(total)} ${plural(total, GAME_PLURAL)}`,
    hint: YEAR_NOTE,
  };
}

/**
 * «Количество игр по году выхода»: the permanent count chart.
 *
 * Unlike `yearsView` (which feeds the decade-gated «Годы релиза» card), this
 * view is never narrowed by a decade. It paints every release year in the
 * payload and, when a genre is selected, recomputes the counts from
 * `gamesIndex` — the films year-chart parity (a select, no extra request).
 *
 * «Год неизвестен» stays off the axis: it is reported as `unknown` so the
 * widget can say «и ещё 29 игр без года» instead of inventing a column.
 */
export function yearCountView(years, gamesIndex, { genre = null, unknownYear = null } = {}) {
  const base = yearsView(years);
  const genreName = text(genre);
  const filtered = Boolean(genreName);
  const local = yearCountSeries(gamesIndex, genreName || null);

  let series;
  let unknown;
  if (filtered) {
    series = local.series;
    unknown = local.unknown;
  } else if (base) {
    // Server-aggregated counts win when they exist: they are the payload
    // contract, and a client recount would only mask a backend drift.
    series = base.years.map((item) => ({ year: item.year, count: item.count, hours: item.hours }));
    // `normalizeGamesPayload` keeps «год неизвестен» in `unknownYear`, so the
    // normalized `years[]` no longer carries the null-year entry itself.
    unknown = base.unknownCount || toCount(unknownYear && unknownYear.count);
  } else {
    series = local.series;
    unknown = local.unknown || toCount(unknownYear && unknownYear.count);
  }

  const total = series.reduce((sum, item) => sum + item.count, 0);
  const minYear = series.length ? series[0].year : null;
  const maxYear = series.length ? series[series.length - 1].year : null;
  const parts = [];
  if (filtered) {
    parts.push(`${fmtInt(total)} ${plural(total, GAME_PLURAL)}`);
    parts.push(`жанр: ${genreName}`);
  } else if (series.length) {
    parts.push(minYear === maxYear ? String(minYear) : `${minYear} — ${maxYear}`);
    parts.push(`${fmtInt(total)} ${plural(total, GAME_PLURAL)}`);
  }
  const unknownText = unknown > 0
    ? `и ещё ${fmtInt(unknown)} ${plural(unknown, GAME_PLURAL)} без года`
    : '';
  if (unknownText) parts.push(unknownText);

  return {
    series,
    total,
    totalText: fmtInt(total),
    minYear,
    maxYear,
    unknown,
    unknownText,
    filtered,
    genre: filtered ? genreName : null,
    note: parts.join(' · '),
    // A payload without real years is still shown when games are known:
    // the card reports «все игры без года» rather than pretending to be empty.
    hasData: series.length > 0 || unknown > 0,
  };
}

/**
 * Genre options for the year-count filter: `genres[]` is `{ name, count,
 * hours }` (no `key`, unlike films), so the name doubles as the value.
 */
export function yearCountGenreOptions(genres) {
  return arr(genres)
    .filter((item) => item && typeof item === 'object' && text(item.name) && toCount(item.count) > 0)
    .map((item) => ({ name: text(item.name), count: toCount(item.count) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
}

/** «68%» for a share ≥10%, «0,4%» below it, «<0,1%» for a sliver. */
function sharePercentText(share) {
  const value = percentNumber(share);
  if (value == null) return '—';
  if (value > 0 && value < 0.1) return '<0,1%';
  return percentText(value / 100, value >= 10 ? 0 : 1);
}

/** Genres past this many are folded behind «Показать все (N)». */
export const GENRE_CHART_LIMIT = 12;

/**
 * Genre bar chart: one horizontal bar per genre, length = its share of the
 * library playtime (`hours`, default) or of the genre marks (`count`). Both
 * weights are in the payload, so the toggle is local — no extra request.
 *
 * The bar length *is* the printed share (RPG 68% → 68% of the track), which is
 * what makes the numbers readable: «97 игр · 68% часов» is the count подпись,
 * and the drilldown stays the existing genre modal.
 *
 * The hours share comes from the payload (`genres[].share`, the backend divides
 * by the library total — 3977.2 h of 5862.6 h = 68%). When it is missing the
 * share is derived from `totalHours` (or the sum of the genre hours, the only
 * denominator left). Genres overlap, so the shares do not add up to 100% — the
 * hint says so instead of hiding it.
 */
export function genreChartView(genres, {
  weight = 'hours',
  limit = GENRE_CHART_LIMIT,
  totalHours = null,
} = {}) {
  const list = normalizeWeightItems(genres).filter((item) => item.count > 0 || (item.hours || 0) > 0);
  if (!list.length) return null;
  const mode = weight === 'count' ? 'count' : 'hours';
  const value = (item) => (mode === 'count' ? item.count : (item.hours || 0));
  const sorted = list.slice().sort((a, b) => value(b) - value(a) || a.name.localeCompare(b.name, 'ru'));
  const shown = limit > 0 ? sorted.slice(0, limit) : sorted;
  const genreHours = list.reduce((sum, item) => sum + (item.hours || 0), 0);
  const libraryHours = numOrNull(totalHours);
  const hoursDenominator = libraryHours && libraryHours > 0 ? libraryHours : genreHours;
  const totalMarks = list.reduce((sum, item) => sum + item.count, 0);
  const shareOf = (item) => {
    if (mode === 'count') return totalMarks > 0 ? item.count / totalMarks : 0;
    const declared = item.share != null ? percentNumber(item.share) : null;
    if (declared != null && declared > 0) return declared / 100;
    return item.hours != null && hoursDenominator > 0 ? item.hours / hoursDenominator : 0;
  };
  const rows = shown.map((item) => {
    const share = shareOf(item);
    const countText = fmtInt(item.count);
    const gamesText = `${countText} ${plural(item.count, GAME_PLURAL)}`;
    const itemHours = item.hours != null ? hoursText(item.hours) : '';
    const shareLabel = mode === 'count'
      ? (totalMarks > 0 ? `${sharePercentText(share)} отметок` : '')
      : (share > 0 ? `${sharePercentText(share)} часов` : 'часы неизвестны');
    return {
      name: item.name,
      count: item.count,
      hours: item.hours,
      countText,
      hoursText: itemHours,
      shareText: shareLabel,
      // Bar length = printed share, so the chart and the label never disagree.
      widthPercent: Math.max(2, Math.min(100, Math.round(share * 1000) / 10)),
      primaryText: mode === 'count' ? gamesText : (itemHours || '—'),
      secondaryText: mode === 'count'
        ? [itemHours, shareLabel].filter(Boolean).join(' · ')
        : [gamesText, shareLabel].filter(Boolean).join(' · '),
      title: itemHours
        ? `${item.name} — ${gamesText} · ${itemHours}`
        : `${item.name} — ${gamesText}`,
      hint: mode === 'count'
        ? `${totalMarks > 0 ? `${sharePercentText(share)} всех жанровых отметок` : 'число игр по жанру'} · нажмите, чтобы открыть список`
        : `${share > 0 ? `${sharePercentText(share)} часов игр этого жанра` : 'часы по жанру сервер не передал'} · нажмите, чтобы открыть список`,
      ariaLabel: `${item.name}: ${gamesText}${itemHours ? `, ${itemHours}` : ''}${shareLabel ? `, ${shareLabel}` : ''} — открыть список`,
    };
  });
  return {
    weight: mode,
    rows,
    total: list.length,
    shown: shown.length,
    hidden: Math.max(0, list.length - shown.length),
    note: `${fmtInt(list.length)} ${plural(list.length, ['жанр', 'жанра', 'жанров'])} · по ${mode === 'hours' ? 'часам' : 'числу игр'}`,
    hint: 'Жанры Steam Store; одна игра может попадать в несколько жанров, поэтому доли не складываются в 100%.',
  };
}

/* =========================================================
   M4 widgets: tags, Steam review scores, franchises, DLC
   ========================================================= */

const TAG_PLURAL = ['тег', 'тега', 'тегов'];
const FRANCHISE_PLURAL = ['франшиза', 'франшизы', 'франшиз'];

/** Tags past this many are folded behind «Показать все (N)». */
export const TAG_CHART_LIMIT = 12;

/**
 * Tag bars, the same visual language as the genre chart (U3): bar length is
 * the share of library hours (`hours`), of tag marks (`count`) or of the
 * SteamSpy tag weight (`weight`).
 *
 * `hours`/`count` reuse `genreChartView` — the item shape is identical, so the
 * chart, the fallback denominator and the fold behaviour stay one
 * implementation. Only the wording («тег», not «жанр») and the extra `weight`
 * mode are tags-specific.
 */
export function tagsChartView(tags, {
  weight = 'hours',
  limit = TAG_CHART_LIMIT,
  totalHours = null,
} = {}) {
  const list = normalizeWeightItems(tags)
    .filter((item) => item.count > 0 || (item.hours || 0) > 0 || (item.weight || 0) > 0);
  if (!list.length) return null;
  const mode = weight === 'count' ? 'count' : weight === 'weight' ? 'weight' : 'hours';

  if (mode !== 'weight') {
    const base = genreChartView(list, { weight: mode, limit, totalHours });
    if (!base) return null;
    return {
      weight: mode,
      rows: base.rows.map((row) => ({
        ...row,
        hint: mode === 'count'
          ? row.hint.replace('жанровых отметок', 'теговых отметок')
          : row.hint.replace('этого жанра', 'этим тегом'),
      })),
      total: base.total,
      shown: base.shown,
      hidden: base.hidden,
      note: `${fmtInt(base.total)} ${plural(base.total, TAG_PLURAL)} · по ${mode === 'hours' ? 'часам' : 'числу игр'}`,
      hint: 'Теги SteamSpy; одна игра может иметь несколько тегов, поэтому доли не складываются в 100%.',
    };
  }

  const sorted = list.slice().sort((a, b) => (b.weight || 0) - (a.weight || 0) || a.name.localeCompare(b.name, 'ru'));
  const shown = limit > 0 ? sorted.slice(0, limit) : sorted;
  const totalWeight = list.reduce((sum, item) => sum + (item.weight || 0), 0);
  const fmtWeight = (value) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
  const rows = shown.map((item) => {
    const value = item.weight || 0;
    const share = totalWeight > 0 ? value / totalWeight : 0;
    const countText = fmtInt(item.count);
    const gamesText = `${countText} ${plural(item.count, GAME_PLURAL)}`;
    const itemHours = item.hours != null ? hoursText(item.hours) : '';
    const shareLabel = share > 0 ? `${sharePercentText(share)} веса` : 'вес неизвестен';
    return {
      name: item.name,
      count: item.count,
      hours: item.hours,
      countText,
      hoursText: itemHours,
      shareText: shareLabel,
      widthPercent: Math.max(2, Math.min(100, Math.round(share * 1000) / 10)),
      primaryText: value > 0 ? fmtWeight(value) : '—',
      secondaryText: [gamesText, itemHours].filter(Boolean).join(' · '),
      title: itemHours ? `${item.name} — ${gamesText} · ${itemHours}` : `${item.name} — ${gamesText}`,
      hint: share > 0
        ? `${sharePercentText(share)} суммарного веса тегов · нажмите, чтобы открыть список`
        : 'вес тега сервер не передал · нажмите, чтобы открыть список',
      ariaLabel: `${item.name}: ${gamesText}${itemHours ? `, ${itemHours}` : ''}, ${shareLabel} — открыть список`,
    };
  });
  return {
    weight: 'weight',
    rows,
    total: list.length,
    shown: shown.length,
    hidden: Math.max(0, list.length - shown.length),
    note: `${fmtInt(list.length)} ${plural(list.length, TAG_PLURAL)} · по весу`,
    hint: 'Теги SteamSpy и их вес; одна игра может иметь несколько тегов.',
  };
}

/** Games of one tag from the light `gamesIndex` (case-insensitive). */
export function gamesByTag(gamesIndex, name) {
  const target = text(name).toLowerCase();
  if (!target) return [];
  return gameRowsFromIndex(gamesIndex, (row) => arr(row.tags).some((tag) => text(tag).toLowerCase() === target));
}

/**
 * Steam community score distribution (1–9) as donut segments, highest first.
 * The block is explicitly community data: `honestNote` is what the UI prints
 * so the widget is never mistaken for a personal rating.
 */
export function scoresView(scores, reviewScore = null) {
  const rows = normalizeScores(scores);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (!rows.length || total <= 0) return null;
  const byBucket = new Map(rows.map((row) => [row.bucket, row]));
  const segments = STEAM_REVIEW_SCALE
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((entry) => {
      const row = byBucket.get(entry.score) || { count: 0, hours: null };
      return {
        key: `score-${entry.score}`,
        bucket: entry.score,
        label: entry.label,
        desc: entry.desc,
        color: entry.color,
        value: row.count,
        count: row.count,
        hours: row.hours,
      };
    });
  const block = normalizeReviewScoreBlock(reviewScore) || {};
  const fmtScore = (value) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value);
  const totalHours = rows
    .map((row) => row.hours)
    .filter((value) => value != null)
    .reduce((sum, value) => sum + value, 0);
  return {
    segments,
    total,
    totalHours: totalHours > 0 ? totalHours : null,
    avg: block.avg ?? null,
    median: block.median ?? null,
    avgText: block.avg != null ? `${fmtScore(block.avg)}/9` : '—',
    medianText: block.median != null ? fmtScore(block.median) : '—',
    note: `${fmtInt(total)} ${plural(total, GAME_PLURAL)} с оценкой Steam`,
    honestNote: 'оценки Steam, не личные',
    ariaLabel: `Распределение community-оценок Steam, ${fmtInt(total)} игр`,
  };
}

/** Games of one review bucket, from the index (`reviewScore` / `reviewDesc`). */
export function gamesByReviewBucket(gamesIndex, bucket) {
  const target = resolveReviewBucket(bucket);
  if (target == null) return [];
  return gameRowsFromIndex(gamesIndex, (row) => {
    if (row.reviewScore != null) return row.reviewScore === target;
    return resolveReviewBucket(row.reviewDesc) === target;
  });
}

/** Franchise ranked list (dedicated endpoint): label + games + hours. */
export function franchisesView(franchises) {
  const list = normalizeFranchises(franchises)
    .filter((item) => item.gamesCount > 0 || item.hoursSum != null || item.appids.length > 0);
  if (!list.length) return null;
  const sorted = list.slice().sort((a, b) => {
    const hours = (b.hoursSum ?? -1) - (a.hoursSum ?? -1);
    if (hours) return hours;
    if (b.gamesCount !== a.gamesCount) return b.gamesCount - a.gamesCount;
    return a.label.localeCompare(b.label, 'ru');
  });
  const maxHours = Math.max(0, ...sorted.map((item) => item.hoursSum || 0));
  const rows = sorted.map((item) => {
    const share = maxHours > 0 && item.hoursSum != null ? item.hoursSum / maxHours : null;
    const countText = `${fmtInt(item.gamesCount)} ${plural(item.gamesCount, GAME_PLURAL)}`;
    const itemHours = item.hoursSum != null ? hoursText(item.hoursSum) : 'часы неизвестны';
    const yearsText = item.yearsSpread != null ? String(item.yearsSpread) : '';
    return {
      key: item.key,
      label: item.label,
      gamesCount: item.gamesCount,
      hoursSum: item.hoursSum,
      appids: item.appids,
      countText,
      hoursText: itemHours,
      yearsText,
      widthPercent: share != null ? Math.max(2, Math.min(100, Math.round(share * 1000) / 10)) : 2,
      primaryText: itemHours,
      secondaryText: [countText, yearsText ? `${yearsText} лет` : ''].filter(Boolean).join(' · '),
      title: `${item.label} — ${countText} · ${itemHours}${yearsText ? ` · ${yearsText} лет` : ''}`,
      hint: 'Игры одной франшизы (IGDB/Wikidata или эвристика). Нажмите, чтобы открыть список по годам.',
      ariaLabel: `${item.label}: ${countText}, ${itemHours} — открыть список игр`,
    };
  });
  return {
    rows,
    total: list.length,
    note: `${fmtInt(list.length)} ${plural(list.length, FRANCHISE_PLURAL)} · по часам`,
    hint: 'Франшизы — справочная метадата; игры без франшизы в список не попадают.',
  };
}

/**
 * Games of one franchise. Explicit `appids` are authoritative (the endpoint
 * knows the membership); only when the payload has none does the index's
 * `franchise` label decide — that is the tolerant fallback for an older
 * payload and for the game card.
 */
export function gamesInFranchise(gamesIndex, franchise) {
  const ref = normalizeFranchiseRef(franchise);
  if (!ref) return [];
  const ids = new Set(ref.appids.map((value) => Number(value)));
  const targetLabel = ref.label.toLowerCase();
  return gameRowsFromIndex(gamesIndex, (row) => {
    if (ids.size > 0) return row.appid != null && ids.has(Number(row.appid));
    if (!row.franchise) return false;
    return row.franchise.key === ref.key
      || row.franchise.label === ref.label
      || row.franchise.label.toLowerCase() === targetLabel;
  });
}

/** `summary.dlc` → summary line + top-10 rows (click → game card). */
export function dlcView(dlc) {
  const block = normalizeDlcSummary(dlc);
  if (!block) return null;
  const fmtNumber = (value) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
  const rows = block.max.slice(0, 10).map((item) => ({
    name: item.name,
    appid: item.appid,
    dlcCount: item.dlcCount,
    countText: item.dlcCount != null ? `${fmtInt(item.dlcCount)} DLC` : 'DLC: ?',
  }));
  const countText = block.gamesWithDlc != null
    ? `${fmtInt(block.gamesWithDlc)} ${plural(block.gamesWithDlc, GAME_PLURAL)}`
    : '—';
  const avgPart = block.avgCount != null ? `в среднем ${fmtNumber(block.avgCount)}` : 'среднее неизвестно';
  return {
    gamesWithDlc: block.gamesWithDlc,
    avgCount: block.avgCount,
    avgText: block.avgCount != null ? fmtNumber(block.avgCount) : '—',
    rows,
    note: block.gamesWithDlc != null ? `${countText} с DLC` : 'DLC не посчитаны',
    summaryText: block.gamesWithDlc != null
      ? `Игры с DLC: ${countText} (${avgPart})`
      : 'Сводка DLC не собрана',
    summaryParts: { gamesText: countText, avgPart },
  };
}

/** Response of `/api/games/franchises` (array or `{ franchises: [] }`). */
export function normalizeFranchisesResponse(raw) {
  return normalizeFranchises(raw);
}

function progressPart(label, resolved, total, percent) {
  if (resolved == null && total == null) return null;
  const resolvedText = resolved == null ? '?' : fmtInt(resolved);
  const totalText = total == null ? '?' : fmtInt(total);
  const derived = percent == null && resolved != null && total
    ? (resolved / total) * 100
    : percent;
  const value = derived == null ? null : Math.max(0, Math.min(100, derived));
  return {
    label,
    resolved,
    total,
    percent: value,
    percentText: value == null ? '' : `${Math.round(value)}%`,
    text: `${label} ${resolvedText}/${totalText}`,
    // §8.3: a 100% badge is noise — the widget hides that part.
    visible: value == null || value < 100,
    complete: value != null && value >= 100,
  };
}

/**
 * Enrichment coverage (`summary.metadata`): «детали 312/340», «кредиты 187/340».
 * The widget is the honest answer to «почему жанров меньше, чем игр».
 */
export function metadataProgressView(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const details = progressPart(
    'детали', metadata.detailsResolved, metadata.detailsTotal, metadata.detailsPercent,
  );
  const credits = progressPart(
    'кредиты', metadata.creditsResolved, metadata.creditsTotal, metadata.creditsPercent,
  );
  const running = metadata.running === true;
  if (!details && !credits && !running) return null;
  const visibleParts = [details, credits].filter((part) => part && part.visible);
  if (!visibleParts.length && !running) return null;
  return {
    details,
    credits,
    running,
    note: running ? 'обогащение идёт…' : '',
    hint: 'Детали — Steam Store (жанры, годы, режимы, студии), кредиты — Wikidata/MobyGames. '
      + 'Пока покрытие не 100%, виджеты жанров и годов описывают только известные игры.',
  };
}

const FILTER_REASONS = {
  details_not_imported: 'детали игр ещё не собраны',
  no_details: 'метадата игр не собрана',
  details_pending: 'метадата ещё догружается',
  type_unknown: 'тип игры неизвестен (нет appdetails)',
  dlc_not_in_library: 'DLC в библиотеке не найдены',
  unsupported: 'сервер не умеет применять этот фильтр',
};

function filterReasonText(reason) {
  const key = text(reason).toLowerCase();
  return FILTER_REASONS[key] || (key ? `причина: ${key}` : 'причина не сообщена');
}

/**
 * `meta.filters` → the honest checkbox state + what actually happened.
 *
 * Requested ≠ applied is the whole point: the server may accept
 * `includeFree=0` but still count free games because `details` are not
 * imported yet. The UI says so instead of silently showing the same numbers.
 */
export function filtersView(filters, { includeFree = true, includeDlc = false } = {}) {
  const block = filters && typeof filters === 'object' ? filters : null;
  // `requested` in §5.4 is the VALUE of the include flag, not «filter is on»:
  // includeFree=true means free games are included (no exclusion), includeDlc
  // =true means DLC are requested. The filter is actually doing something when
  // the requested value differs from the default (free: on, DLC: off).
  const make = (key, label, requestedFallback, filterOn, onText, offText) => {
    const entry = block && block[key] && typeof block[key] === 'object' ? block[key] : null;
    const requested = entry && entry.requested != null ? entry.requested : requestedFallback;
    const applied = entry ? entry.applied : null;
    const active = filterOn(requested);
    let status = 'unknown';
    let textValue = `${label}: сервер не сообщил, применён ли фильтр`;
    if (entry) {
      if (applied === true) {
        status = 'applied';
        textValue = active
          ? `${label}: ${onText} (фильтр применён)`
          : `${label}: ${offText} (без фильтра)`;
      } else if (applied === false && active) {
        status = 'pending';
        textValue = `${label}: запрошено «${onText}», но не применено — ${filterReasonText(entry.reason)}`;
      } else if (applied === false) {
        status = 'off';
        textValue = `${label}: ${offText}, фильтр не требуется`;
      }
    }
    return { key, label, requested, applied, active, status, text: textValue, reason: entry ? entry.reason : '' };
  };
  const free = make(
    'includeFree', 'бесплатные игры', includeFree,
    (requested) => requested === false, 'исключить', 'включены',
  );
  const dlc = make(
    'includeDlc', 'DLC', includeDlc,
    (requested) => requested === true, 'включить', 'исключены',
  );
  // M5-B «мин. часов»: numeric, always applied once the payload exists, but
  // the excluded count is printed so the user sees why the totals moved.
  const minHoursRaw =
    block && block.minHours && typeof block.minHours === 'object' ? block.minHours : null;
  let minHours = null;
  if (minHoursRaw && minHoursRaw.requested != null) {
    const requested = Math.trunc(Number(minHoursRaw.requested)) || 0;
    const excluded = minHoursRaw.excluded || 0;
    const tail = excluded > 0
      ? `исключено ${fmtInt(excluded)} ${plural(excluded, GAME_PLURAL)}`
      : 'ничего не исключено';
    const valueText = requested < 0
      ? 'все игры, включая 0 ч'
      : requested === 0
      ? 'только с часами'
      : `≥${fmtInt(requested)} ч`;
    minHours = {
      key: 'minHours',
      label: 'мин. часов',
      requested,
      applied: minHoursRaw.applied !== false,
      excluded,
      excludedAppids: minHoursRaw.excludedAppids || 0,
      status: minHoursRaw.applied === false ? 'pending' : 'applied',
      text: `мин. часов: ${valueText} — ${tail}`,
    };
  }
  const honest = free.status === 'pending' || dlc.status === 'pending';
  return {
    includeFree: free,
    includeDlc: dlc,
    minHours,
    items: minHours ? [free, dlc, minHours] : [free, dlc],
    // A checkbox may be on/off; `requested` is what the server understood.
    state: { includeFree: free.requested !== false, includeDlc: dlc.requested === true },
    honest,
    note: honest
      ? 'Сервер честно сообщает: фильтр запрошен, но пока не применён — цифры выше всё ещё включают эти игры.'
      : block
      ? ''
      : 'Сервер не передал состояние фильтров: переключатели работают, но применились ли они — неизвестно.',
    visible: Boolean(block) || free.status !== 'unknown' || dlc.status !== 'unknown',
  };
}

/* =========================================================
   M2: achievements calendar + streaks
   ========================================================= */

export const CALENDAR_HINT =
  'Календарь по датам разблокировок достижений (unlockTimestamp), а не по игровому времени: '
  + 'Steam не отдаёт сессии и часы по дням. День с достижением ≠ день, когда вы играли.';

/** `achievementDays[]` + `timeline[]` → the calendar widget view. */
export function calendarView(achievementDays, timeline = []) {
  const days = normalizeAchievementDays(achievementDays);
  if (!days.length) return null;
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const games = new Set();
  for (const day of days) for (const appid of day.appids) games.add(appid);
  const years = [...new Set(days.map((day) => Number(day.date.slice(0, 4))))]
    .filter((year) => Number.isFinite(year) && year > 0)
    .sort((a, b) => a - b);
  const months = normalizeTimeline(timeline);
  return {
    days,
    total,
    totalText: fmtInt(total),
    activeDays: days.length,
    activeDaysText: fmtInt(days.length),
    gamesCount: games.size,
    first: days[0].date,
    last: days[days.length - 1].date,
    years,
    fromYear: years.length ? years[0] : null,
    toYear: years.length ? years[years.length - 1] : null,
    months,
    note: `${fmtInt(days.length)} ${plural(days.length, ['день', 'дня', 'дней'])}`
      + ` · ${fmtInt(total)} ${plural(total, ['достижение', 'достижения', 'достижений'])}`,
    hint: CALENDAR_HINT,
  };
}

/** Achievement streak card, with a local fallback from the calendar days. */
export function achievementStreaksView(streaks, achievementDays = []) {
  const value = normalizeStreaks(streaks, normalizeAchievementDays(achievementDays));
  if (!value) return null;
  const bestRange = arr(value.bestDates)
    .map((date) => formatDateRu(date))
    .filter(Boolean);
  const lastText = value.lastUnlockDate ? formatDateRu(value.lastUnlockDate) : '';
  return {
    current: value.current,
    best: value.best,
    lastUnlockDate: value.lastUnlockDate,
    lastText,
    bestDates: value.bestDates,
    bestRangeText: bestRange.length === 2 ? `${bestRange[0]} — ${bestRange[1]}` : (bestRange[0] || ''),
    currentText: `${fmtInt(value.current)} ${plural(value.current, ['день', 'дня', 'дней'])}`,
    bestText: `${fmtInt(value.best)} ${plural(value.best, ['день', 'дня', 'дней'])}`,
    metaText: [
      `Рекорд: ${fmtInt(value.best)}${bestRange.length ? ` (${bestRange.length === 2 ? `${bestRange[0]} — ${bestRange[1]}` : bestRange[0]})` : ''}`,
      lastText ? `Последняя разблокировка: ${lastText}` : '',
    ].filter(Boolean).join(' · '),
    hint: 'Серия — дни подряд с хотя бы одним достижением. Это активность достижений, а не игровое время.',
    visible: value.best > 0 || Boolean(value.lastUnlockDate),
  };
}

/**
 * Completion / rare-achievements overview (§6.2). `perfectCount` is exactly
 * 100%; games without achievement stats are never counted as zero.
 */
export function achievementsOverviewView(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const completion = s.completion && typeof s.completion === 'object' ? s.completion : null;
  const achievements = s.achievements && typeof s.achievements === 'object' ? s.achievements : null;
  if (!completion && !achievements) return null;
  const metrics = [];
  if (completion && completion.avgPercent != null) {
    metrics.push({
      key: 'avg',
      label: 'средний completion',
      value: percentText(completion.avgPercent, 0),
      hint: 'Средний процент полученных достижений по играм, у которых есть статистика достижений.',
    });
  }
  if (completion && completion.medianPercent != null) {
    metrics.push({
      key: 'median',
      label: 'медианный completion',
      value: percentText(completion.medianPercent, 0),
      hint: 'Половина игр с достижениями имеет меньший процент, половина — больший.',
    });
  }
  if (completion && completion.perfectCount != null) {
    metrics.push({
      key: 'perfect',
      label: 'идеальных игр',
      value: fmtInt(completion.perfectCount),
      hint: 'Игры ровно со 100% достижений.',
    });
  }
  if (achievements && achievements.rareUnlocked != null) {
    metrics.push({
      key: 'rare',
      label: 'редких разблокировано',
      value: fmtInt(achievements.rareUnlocked),
      hint: 'Разблокированные достижения с глобальным процентом ниже 5% (Steam global achievements).',
    });
  }
  const coverage = achievements && achievements.coverage
    ? achievements.coverage
    : completion && completion.gamesWithStats != null
    ? { gamesWithStats: completion.gamesWithStats, gamesTotal: completion.gamesTotal }
    : null;
  if (coverage && coverage.gamesWithStats != null && coverage.gamesTotal) {
    metrics.push({
      key: 'coverage',
      label: 'игр с достижениями',
      value: `${fmtInt(coverage.gamesWithStats)}/${fmtInt(coverage.gamesTotal)}`,
      hint: 'Игры без публичной статистики достижений не считаются нулём — они просто вне completion-метрик.',
    });
  }
  if (!metrics.length) return null;
  const unlocked = achievements && achievements.unlocked != null ? achievements.unlocked : null;
  const total = achievements && achievements.total != null ? achievements.total : null;
  return {
    metrics,
    unlocked,
    total,
    totalText: unlocked != null && total != null
      ? `${fmtInt(unlocked)} из ${fmtInt(total)} ${plural(total, ['достижение', 'достижения', 'достижений'])}`
      : '',
    note: 'по достижениям, не по игровому времени',
    hint: 'Completion = полученные достижения / все достижения игры. Игры без статистики не входят в средние.',
  };
}

/* =========================================================
   M3: personnel
   ========================================================= */

/**
 * Role order: the developer block first (§7.1), then the people roles by
 * priority. `studio` is kept as an alias: an older server still answers
 * `role=studio` (developers + publishers mixed), and the label stays
 * «Разработчики» — publishers have their own category now.
 */
export const PERSONNEL_ROLES = [
  {
    key: 'developer',
    apiRole: 'developer',
    aliases: ['studio'],
    label: 'Разработчики',
    forms: ['разработчик', 'разработчика', 'разработчиков'],
    hint: 'developers[] из Steam Store; издатели — отдельной категорией.',
  },
  {
    key: 'publisher',
    apiRole: 'publisher',
    label: 'Издатели',
    forms: ['издатель', 'издателя', 'издателей'],
    hint: 'publishers[] из Steam Store; Wikidata шумит региональными издателями.',
  },
  {
    key: 'composer',
    apiRole: 'composer',
    label: 'Композиторы',
    forms: ['композитор', 'композитора', 'композиторов'],
    hint: 'MobyGames / Wikidata P86.',
  },
  {
    key: 'designer',
    apiRole: 'designer',
    label: 'Геймдизайнеры',
    forms: ['геймдизайнер', 'геймдизайнера', 'геймдизайнеров'],
    hint: 'MobyGames Game Design / Wikidata P287. Покрытие хуже, чем у студий.',
  },
  {
    key: 'writer',
    apiRole: 'writer',
    label: 'Сценаристы',
    forms: ['сценарист', 'сценариста', 'сценаристов'],
    hint: 'MobyGames Writing; Wikidata P58 применим не всегда.',
  },
  {
    key: 'artist',
    apiRole: 'artist',
    label: 'Художники',
    forms: ['художник', 'художника', 'художников'],
    hint: 'MobyGames Art/Graphics — самый неровный источник.',
  },
  {
    key: 'programmer',
    apiRole: 'programmer',
    label: 'Программисты',
    forms: ['программист', 'программиста', 'программистов'],
    hint: 'MobyGames Programming / Wikidata P943.',
  },
  {
    key: 'producer',
    apiRole: 'producer',
    label: 'Продюсеры',
    forms: ['продюсер', 'продюсера', 'продюсеров'],
    hint: 'MobyGames Production / Wikidata P162.',
  },
];

const PERSON_ROLE_LABELS = {
  developer: 'разработчик',
  publisher: 'издатель',
  studio: 'разработчик',
  composer: 'композитор',
  music: 'композитор',
  designer: 'геймдизайнер',
  'game design': 'геймдизайнер',
  writer: 'сценарист',
  writing: 'сценарист',
  artist: 'художник',
  art: 'художник',
  programmer: 'программист',
  programming: 'программист',
  producer: 'продюсер',
  production: 'продюсер',
  voice: 'озвучка',
  'voice actor': 'озвучка',
};

/**
 * Any role spelling the payload/URL may carry → the UI key. `studio` (the old
 * server key that mixed developers and publishers) maps to `developer`, so the
 * select keeps one entry labelled «Разработчики». Unknown roles return ''.
 */
export function normalizePersonnelRole(role) {
  const key = text(role).toLowerCase();
  if (!key) return '';
  const found = PERSONNEL_ROLES.find((entry) => entry.key === key
    || entry.apiRole === key
    || (entry.aliases || []).includes(key));
  return found ? found.key : '';
}

export function personnelRoleLabel(role) {
  const key = normalizePersonnelRole(role) || text(role).toLowerCase();
  const found = PERSONNEL_ROLES.find((entry) => entry.key === key);
  if (found) return found.label;
  return PERSON_ROLE_LABELS[key] || key || 'персоналии';
}

function rolesText(roles) {
  const list = arr(roles)
    .map((role) => text(role))
    .filter(Boolean)
    .map((role) => PERSON_ROLE_LABELS[role.toLowerCase()] || role);
  return [...new Set(list)].join(' · ');
}

function normalizePersonItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = firstString(raw.name, raw.label, raw.title);
  if (!name) return null;
  const aliases = arr(raw.aliases).map((alias) => text(alias)).filter(Boolean);
  const games = normalizePersonGames(raw.games)
    .map((game) => ({ ...game, hoursText: game.hours != null ? hoursText(game.hours) : '' }))
    .sort((a, b) => (b.hours || 0) - (a.hours || 0));
  return {
    id: firstString(raw.id, raw.qid, raw.mobyId),
    name,
    aliases,
    aliasesText: aliases.join(', '),
    qid: firstString(raw.qid),
    mobyId: numOrNull(raw.mobyId),
    roles: arr(raw.roles).map((role) => text(role)).filter(Boolean),
    rolesText: rolesText(raw.roles),
    count: toCount(raw.count ?? raw.gameCount),
    hours: numOrNull(raw.hours ?? raw.playtimeHours),
    hoursShare: numOrNull(raw.hoursShare),
    avgCompletion: numOrNull(raw.avgCompletion),
    games,
    gamesText: games.map((game) => game.name).filter(Boolean).join(', '),
    ambiguous: raw.ambiguous === true,
    sources: arr(raw.sources).map((source) => text(source)).filter(Boolean),
  };
}

/**
 * `GET /api/games/personnel?role=…` → view model. The endpoint is M3 and may
 * be absent on an M1/M2 server; an empty body is a valid «кредитов нет».
 *
 * `coverage.byRole` is kept: the role select is built from what the payload
 * actually has instead of hard-coding eight categories.
 */
export function normalizePersonnel(raw, fallbackRole = '') {
  const source = raw && typeof raw === 'object' ? raw : {};
  const items = arr(source.items).map(normalizePersonItem).filter(Boolean);
  const coverageRaw = source.coverage && typeof source.coverage === 'object' ? source.coverage : null;
  const byRoleRaw = coverageRaw && coverageRaw.byRole && typeof coverageRaw.byRole === 'object'
    ? coverageRaw.byRole
    : null;
  const byRole = {};
  if (byRoleRaw) {
    for (const [key, value] of Object.entries(byRoleRaw)) {
      const name = text(key).toLowerCase();
      if (name) byRole[name] = toCount(value);
    }
  }
  const coverage = coverageRaw
    ? {
      gamesWithCredits: numOrNull(coverageRaw.gamesWithCredits),
      gamesTotal: numOrNull(coverageRaw.gamesTotal),
      percent: numOrNull(coverageRaw.percent),
      gamesWithStudios: numOrNull(coverageRaw.gamesWithStudios),
      studioPercent: numOrNull(coverageRaw.studioPercent),
      byRole: Object.keys(byRole).length ? byRole : null,
    }
    : null;
  const role = text(source.role) || text(fallbackRole);
  const roleKey = normalizePersonnelRole(role) || normalizePersonnelRole(fallbackRole);
  return {
    role,
    roleKey,
    roleLabel: personnelRoleLabel(roleKey || role),
    items,
    coverage,
    hasItems: items.length > 0,
    emptyText: `Кредиты «${personnelRoleLabel(roleKey || role).toLowerCase()}» не собраны: MobyGames/Wikidata ещё не отдали данные для игр этой библиотеки.`,
  };
}

/**
 * Role options for the inline select, in `PERSONNEL_ROLES` order: developers
 * first (always), publishers when the payload has studio credits, people roles
 * only when `coverage.byRole` reports at least one game. A payload without
 * `byRole` keeps the full list, so an older server never collapses the select.
 */
export function personnelRoleOptions(payload) {
  const data = payload && payload.roleLabel && Array.isArray(payload.items)
    ? payload
    : normalizePersonnel(payload);
  const coverage = data.coverage || {};
  const byRole = coverage.byRole || null;
  const hasStudios = !byRole
    || coverage.gamesWithStudios == null
    || coverage.gamesWithStudios > 0;
  const current = data.roleKey || normalizePersonnelRole(data.role);
  const options = [];
  for (const role of PERSONNEL_ROLES) {
    if (role.key === 'developer') {
      options.push(role);
    } else if (role.key === 'publisher') {
      if (hasStudios) options.push(role);
    } else if (!byRole || (byRole[role.key] || 0) > 0) {
      options.push(role);
    }
  }
  // The selected role must stay selectable even when its block is empty.
  if (current && !options.some((role) => role.key === current)) {
    const extra = PERSONNEL_ROLES.find((role) => role.key === current);
    if (extra) options.splice(1, 0, extra);
  }
  return options.map((role) => ({ key: role.key, label: role.label, hint: role.hint }));
}

/** «399 разработчиков» — the role-aware plural used by the widget note. */
export function personnelRoleCountText(count, role) {
  const key = normalizePersonnelRole(role) || PERSONNEL_ROLES[0].key;
  const entry = PERSONNEL_ROLES.find((item) => item.key === key) || PERSONNEL_ROLES[0];
  return `${fmtInt(count)} ${plural(count, entry.forms)}`;
}

function sortByWeight(items, weight) {
  const mode = weight === 'count' ? 'count' : 'hours';
  return items.slice().sort((a, b) => {
    const diff = mode === 'count'
      ? (b.count || 0) - (a.count || 0)
      : (b.hours || 0) - (a.hours || 0);
    return diff || a.name.localeCompare(b.name, 'ru');
  });
}

function personRows(items, { weight = 'hours', limit = 0 } = {}) {
  const mode = weight === 'count' ? 'count' : 'hours';
  const sorted = sortByWeight(items, mode);
  const shown = limit > 0 ? sorted.slice(0, limit) : sorted;
  const max = Math.max(1, ...shown.map((item) => (mode === 'count' ? item.count : (item.hours || 0))));
  return shown.map((item, index) => ({
    ...item,
    rank: index + 1,
    countText: fmtInt(item.count),
    hoursText: item.hours != null ? hoursText(item.hours) : '',
    shareText: item.hoursShare != null ? percentText(item.hoursShare) : '',
    completionText: item.avgCompletion != null ? percentText(item.avgCompletion, 0) : '',
    widthPercent: Math.max(2, ((mode === 'count' ? item.count : (item.hours || 0)) / max) * 100),
    title: `${item.name} — ${fmtInt(item.count)} ${plural(item.count, GAME_PLURAL)}`
      + (item.hours != null ? ` · ${hoursText(item.hours)}` : ''),
    hint: [
      item.rolesText,
      item.qid ? `QID ${item.qid}` : '',
      item.aliasesText ? `также: ${item.aliasesText}` : '',
      item.sources.length ? `источник: ${item.sources.join(', ')}` : '',
    ].filter(Boolean).join(' · '),
    gamesHint: item.games.length
      ? item.games.slice(0, 8).map((game) => `${game.name || `appid ${game.appid}`}${game.hours != null ? ` — ${hoursText(game.hours)}` : ''}`).join(' · ')
      : '',
  }));
}

/** Personnel screen rows for one role, sorted by hours (default) or count. */
export function personnelRows(payload, { weight = 'hours', limit = 0 } = {}) {
  const data = payload && payload.roleLabel && Array.isArray(payload.items)
    ? payload
    : normalizePersonnel(payload);
  if (!data.items.length) return [];
  return personRows(data.items, { weight, limit });
}

/** Dashboard studios strip (`stats.studios`), same weights, shorter list. */
export function studiosView(studios, { weight = 'hours', limit = 8 } = {}) {
  const items = normalizeStudios(studios);
  if (!items.length) return null;
  const rows = personRows(items.map((item) => ({
    ...item,
    aliases: [],
    aliasesText: '',
    rolesText: rolesText(item.roles),
    gamesText: item.games.map((game) => game.name).filter(Boolean).join(', '),
    games: item.games.map((game) => ({
      ...game,
      hoursText: game.hours != null ? hoursText(game.hours) : '',
    })),
    sources: item.sources,
    ambiguous: false,
    hoursShare: null,
  })), { weight, limit });
  return {
    rows,
    weight: weight === 'count' ? 'count' : 'hours',
    total: items.length,
    note: `${fmtInt(items.length)} ${plural(items.length, ['разработчик', 'разработчика', 'разработчиков'])} · по ${weight === 'count' ? 'числу игр' : 'часам'}`,
    hint: 'Разработчики из Steam Store (developers). Нажмите на строку, чтобы увидеть игры.',
  };
}

/** «кредиты: 55%» — hidden at 100% (§8.3). */
export function coverageBadge(percent) {
  const value = percentNumber(percent);
  if (value == null) return null;
  return {
    percent: value,
    text: `кредиты: ${Math.round(value)}%`,
    visible: value < 100,
    title: 'Доля игр библиотеки, для которых собраны люди (MobyGames/Wikidata). 100% — бейдж скрывается.',
  };
}

/* =========================================================
   import flow
   ========================================================= */

/**
 * Accepts «76561198038369983», a `profiles/<id64>` URL, `id/<vanity>`, a bare
 * vanity or the full steamcommunity URL. Returns exactly one of
 * `steamid64` / `vanityUrl`, or `{ error }` with a human sentence.
 */
export function accountFromInput(value) {
  const raw = text(value);
  if (!raw) {
    return { error: 'Введите steamid64 (17 цифр) или имя профиля из steamcommunity.com/id/<имя>.' };
  }
  const cleaned = raw
    .replace(/^https?:\/\/(?:www\.)?steamcommunity\.com\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/^(?:id|profiles)\//i, '')
    .trim();
  if (!cleaned) {
    return { error: 'В ссылке нет имени профиля: нужен steamcommunity.com/id/<имя> или steamcommunity.com/profiles/<17 цифр>.' };
  }
  if (/^\d{17}$/.test(cleaned)) return { steamid64: cleaned };
  if (/^\d+$/.test(cleaned)) {
    return { error: 'steamid64 — это ровно 17 цифр. Число из «SteamID»/«SteamID3» (32-битный) не подойдёт: возьмите профиль-ссылку steamcommunity.com/profiles/<17 цифр>.' };
  }
  if (/^[A-Za-z0-9_-]{2,64}$/.test(cleaned)) return { vanityUrl: cleaned };
  return { error: 'Это не похоже ни на steamid64 (17 цифр), ни на имя профиля (латиница, цифры, «_» и «-»).' };
}

/**
 * Import error → honest Russian text with the next step. Codes come from the
 * contract (§5.4); anything unknown keeps the server sentence.
 */
const IMPORT_ERRORS = {
  profile_private: {
    title: 'Профиль Steam закрыт',
    message: 'Steam отвечает, что профиль приватный. Откройте «Мой профиль» → «Редактировать профиль» → «Приватность» и поставьте «Открытый», затем повторите импорт. Приватный профиль — не «0 игр».',
  },
  library_private: {
    title: 'Библиотека недоступна',
    message: 'Профиль открыт, но библиотеку Steam не отдал. Проверьте, что «Сведения об играх» в приватности профиля — «Открытые», и что ключ Steam Web API действует.',
  },
  stats_private: {
    title: 'Достижения скрыты',
    message: 'Профиль открыт, но статистика достижений закрыта: импорт продолжится без достижений, часы и библиотека остаются.',
  },
  invalid_steamid: {
    title: 'Профиль не найден',
    message: 'Steam не нашёл такой vanity URL. Проверьте имя в ссылке steamcommunity.com/id/<имя> или вставьте steamid64 (17 цифр).',
  },
  steamid_mismatch: {
    title: 'Steam вернул другой профиль',
    message: 'Steam ответил другим steamid64, чем запрошенный. Библиотеку нельзя приписать этому владельцу, поэтому импорт остановлен и ничего не сохранено. Проверьте ссылку профиля (steamcommunity.com/profiles/<17 цифр>) и повторите.',
  },
  steam_key_missing: {
    title: 'Нет ключа Steam Web API',
    message: 'Без ключа Steam отдаёт только профиль, достижения и три последних игры — библиотеки с часами нет. Ключ бесплатный: steamcommunity.com/dev/apikey, затем добавьте его на сервере (STEAM_API_KEY).',
  },
  steam_key_invalid: {
    title: 'Ключ Steam Web API отклонён',
    message: 'Steam ответил 401 на ключ: он отозван, истёк или скопирован с ошибкой. Выпустите новый на steamcommunity.com/dev/apikey и замените STEAM_API_KEY на сервере. Значение ключа нигде не печатается.',
  },
  steam_unreachable: {
    title: 'Steam недоступен с сервера',
    message: 'Сеть сервера не достучалась до steamcommunity.com (DNS/TLS/таймаут). Это не «источник мёртв»: проверьте резолвер или прокси на хосте и повторите импорт.',
  },
  steam_rate_limited: {
    title: 'Steam просит подождать',
    message: 'Steam ограничил частоту запросов (429) или включил паузу после ошибок. Подождите несколько минут и повторите импорт — данные в кэше не потеряны.',
  },
  steam_http_error: {
    title: 'Steam ответил ошибкой',
    message: 'Steam Web API вернул ошибку на запрос библиотеки. Повторите импорт через пару минут; если повторяется — проверьте состояние api.steampowered.com.',
  },
  games_import_failed: {
    title: 'Импорт не удался',
    message: 'Задача импорта завершилась ошибкой на стороне сервера. Повторите импорт; подробности — в логе сервера.',
  },
  target_required: {
    title: 'Не указан профиль',
    message: 'Введите vanity URL (steamcommunity.com/id/<имя>) или steamid64 (17 цифр).',
  },
  profile_required: {
    title: 'Не выбран профиль',
    message: 'Сначала импортируйте профиль Steam — статистика строится ровно по одному профилю.',
  },
  unexpected_parameter: {
    title: 'Сервер не принял запрос',
    message: 'Сервер отклонил лишний параметр запроса. Обновите страницу (UI и сервер разошлись по версии) и повторите.',
  },
  auth_required: {
    title: 'Нужен вход',
    message: 'Сессия истекла — войдите заново и повторите импорт.',
  },
};

export function importErrorText(error) {
  const code = text(error && error.code).toLowerCase();
  const status = numOrNull(error && error.status);
  const raw = text(error && error.message);
  if (IMPORT_ERRORS[code]) return { ...IMPORT_ERRORS[code], code };
  if (code === 'network' || status === 0) {
    return {
      title: 'Нет связи с сервером',
      message: 'Сервер не ответил. Проверьте, что он запущен, и повторите импорт.',
      code: code || 'network',
    };
  }
  if (status === 401) return { ...IMPORT_ERRORS.auth_required, code: 'auth_required' };
  return {
    title: 'Не удалось импортировать профиль',
    message: raw || 'Сервер ответил ошибкой. Попробуйте ещё раз.',
    code,
  };
}

const STAGE_LABEL = {
  start: 'Запуск импорта',
  init: 'Подготовка',
  queued: 'В очереди',
  bootstrap: 'Открываем Steam',
  profile: 'Читаем профиль Steam',
  'steam-profile': 'Читаем профиль Steam',
  community: 'Читаем профиль Steam',
  library: 'Загружаем библиотеку',
  'owned-games': 'Загружаем библиотеку',
  games: 'Загружаем библиотеку',
  summaries: 'Уточняем профиль',
  achievements: 'Собираем достижения',
  global: 'Считаем редкость достижений',
  stats: 'Считаем статистику',
  done: 'Готово',
  failed: 'Ошибка',
};

/** Human stage sentence for the import progress card. */
export function jobStageText(status) {
  if (!status || typeof status !== 'object') return 'Готовим импорт…';
  const message = text(status.message || status.detail);
  if (message) return message;
  const stage = text(status.stage || status.phase || status.status).toLowerCase();
  return STAGE_LABEL[stage] || 'Импортируем библиотеку…';
}

/** 0…100 for the progress bar: explicit `percent`/`progress`, else stage weights. */
export function jobProgress(status) {
  if (!status || typeof status !== 'object') return 0;
  const explicit = numOrNull(status.percent ?? status.progress ?? status.pct);
  if (explicit != null) return Math.max(0, Math.min(100, explicit));
  const stage = text(status.stage || status.phase || status.status).toLowerCase();
  if (stage === 'done' || status.done === true) return 100;
  if (stage === 'failed' || status.failed === true) return 100;
  const weights = {
    start: 4, init: 8, queued: 6, bootstrap: 10, profile: 18, 'steam-profile': 18, community: 18,
    library: 52, 'owned-games': 52, games: 52, summaries: 62, achievements: 74, global: 84, stats: 92, done: 100,
  };
  return weights[stage] != null ? weights[stage] : 10;
}

/**
 * Tolerant job id reader: `{ id }`, `{ jobId }` or `{ job: { id } }`.
 *
 * A bare `job: "games-import"` is the job TYPE in the contract (§5.4), not an
 * id — treating it as an id would poll `/status?id=games-import` forever.
 * When the server returns no id, the caller polls by `profile` instead.
 */
export function gamesJobId(response) {
  if (!response || typeof response !== 'object') return '';
  const nested = response.job && typeof response.job === 'object' ? response.job : null;
  return firstString(
    response.id,
    response.jobId,
    response.job_id,
    nested && nested.id,
  );
}

/** `GET /api/games/profiles` → `[{ key, userKey, personaName, label, gameCount, importedAt }]`. */
export function normalizeProfilesList(raw) {
  const list = Array.isArray(raw) ? raw : arr(raw && (raw.profiles || raw.items));
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const userKey = firstString(item.userKey, item.steamid64, item.id);
    const key = firstString(item.key, userKey ? `steam-${userKey}` : '');
    if (!key) continue;
    out.push({
      key,
      userKey,
      personaName: firstString(item.personaName, item.persona, item.label, userKey, key),
      label: firstString(item.label),
      gameCount: numOrNull(item.gameCount),
      importedAt: text(item.importedAt) || null,
      source: text(item.source) || 'steam',
    });
  }
  return out;
}

/* =========================================================
   M6a: sources («Подключения» / «Вне Steam»)
   ========================================================= */

const GOG_STATUS_LABEL = {
  ok: 'подключён',
  stale: 'данные устарели',
  auth_expired: 'требуется переподключение',
  connected_no_import: 'подключён, библиотека не импортирована',
  not_connected: 'не подключён',
  snapshot_only: 'GOG отключён — показан сохранённый снимок',
};

/** Human status of the GOG source: never a bare `status` code in the UI. */
export function gogStatusText(status, fetchedAt = null) {
  const key = text(status) || 'not_connected';
  const base = GOG_STATUS_LABEL[key] || key;
  const date = formatDateRu(fetchedAt);
  if (key === 'ok' && date) return `данные от ${date}`;
  if (key === 'snapshot_only' && date) return `снимок от ${date} — подключите GOG заново`;
  if (key === 'stale' && date) return `данные от ${date} — обновим`;
  return base;
}

/**
 * View model for the «Источники» widget. Steam is the journal (its hours are
 * the headline); GOG and Epic are same-owner secondary libraries and their
 * hours are **separate** numbers — the view model never adds them together
 * (§14.4 п. 2). A library that is not connected shows a connect hint instead
 * of a fake zero.
 */
export function gogSourcesView(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const summary = p.summary && typeof p.summary === 'object' ? p.summary : {};
  const sources = p.sources && typeof p.sources === 'object' ? p.sources : {};
  const gog = sources.gog && typeof sources.gog === 'object' ? sources.gog : {};
  const epic = sources.epic && typeof sources.epic === 'object' ? sources.epic : {};
  const hoursBySource = summary.hoursBySource && typeof summary.hoursBySource === 'object'
    ? summary.hoursBySource
    : {};
  const ownedBySource = summary.ownedBySource && typeof summary.ownedBySource === 'object'
    ? summary.ownedBySource
    : {};
  const gogConnected = gog.connected === true || gog.configured === true;
  const gogHasData = gogConnected || numOrNull(gog.productCount) != null;
  const gogStatus = gogConnected ? text(gog.status) || 'ok' : text(gog.status) || 'not_connected';
  const gogFetchedAt = gog.libraryFetchedAt || gog.lastImportAt || null;
  const epicConnected = epic.connected === true || epic.configured === true;
  const epicHasData = epicConnected || numOrNull(epic.productCount) != null;
  const epicStatus = epicConnected ? text(epic.status) || 'ok' : text(epic.status) || 'not_connected';
  const epicFetchedAt = epic.libraryFetchedAt || epic.lastImportAt || null;
  // A disconnected Epic account keeps its dated snapshot (the layer reports
  // `not_connected` with a summary, never zeros) — say «снимок», not «не
  // подключён», while numbers are on screen.
  const epicSnapshot = !epicConnected && numOrNull(epic.productCount) != null;
  const epicStatusText = epicSnapshot
    ? (formatDateRu(epicFetchedAt)
        ? `снимок от ${formatDateRu(epicFetchedAt)} — подключите Epic заново`
        : 'снимок — подключите Epic заново')
    : gogStatusText(epicStatus, epicFetchedAt);
  const secondaryWorks = arr(p.secondaryWorks).map(asSecondaryWork).filter(Boolean);
  const secondaryOnly =
    toCount(summary.secondaryWorksTotal)
    || toCount(summary.secondaryOnlyWorks)
    || secondaryWorks.length;
  // `summary.worksTotal` is the union over `workKey`; when a backend has not
  // sent it yet, the honest fallback is Steam works + secondary-only works
  // (overlapping GOG/Epic rows are already excluded from `secondaryOnly`).
  const steamWorks = numOrNull(summary.gameCount);
  const worksTotal = numOrNull(summary.worksTotal)
    ?? (steamWorks != null ? steamWorks + secondaryOnly : null);
  // `normalizeGamesPayload` keeps the raw chart flags on the top-level
  // `secondaryChart`; a raw `/stats` payload is read directly.
  const secondaryChart = p.secondaryChart && typeof p.secondaryChart === 'object'
    ? p.secondaryChart
    : secondaryChartStatus(p);
  // Per-source hours for the compact «Вне Steam» summary line. They are never
  // added together: GOG and Epic are separate libraries.
  const secondaryHours = [
    { source: 'gog', label: 'GOG', hours: numOrNull(hoursBySource.gog) },
    { source: 'epic', label: 'Epic', hours: numOrNull(hoursBySource.epic) },
  ].filter((row) => row.hours != null);

  const rows = [
    {
      key: 'steam',
      label: 'Steam',
      games: numOrNull(ownedBySource.steam) ?? numOrNull(summary.ownedCount),
      hours: numOrNull(hoursBySource.steam) ?? numOrNull(summary.totalHours),
      status: 'ok',
      statusText: 'журнал',
      journal: true,
      canConnect: false,
    },
    {
      key: 'gog',
      label: 'GOG',
      games: gogHasData ? numOrNull(ownedBySource.gog) ?? numOrNull(gog.productCount) : null,
      hours: gogHasData ? numOrNull(hoursBySource.gog) ?? numOrNull(gog.hours) : null,
      status: gogStatus,
      statusText: gogStatusText(gogStatus, gogFetchedAt),
      fetchedAt: gogFetchedAt,
      username: text(gog.username) || null,
      journal: false,
      canConnect: !gogConnected,
    },
    {
      key: 'epic',
      label: 'Epic Games Store',
      games: epicHasData ? numOrNull(ownedBySource.epic) ?? numOrNull(epic.productCount) : null,
      hours: epicHasData ? numOrNull(hoursBySource.epic) ?? numOrNull(epic.hours) : null,
      status: epicStatus,
      statusText: epicStatusText,
      fetchedAt: epicFetchedAt,
      username: text(epic.displayName) || null,
      journal: false,
      // The Epic card itself lives in «Подключения»; the row only links there
      // (no second connect form), so an unconnected Epic still offers the link.
      canConnect: !epicConnected,
    },
  ];

  return {
    rows,
    gogConnected,
    gogStatus,
    gogStatusText: gogStatusText(gogStatus, gogFetchedAt),
    epicConnected,
    epicStatus,
    epicStatusText,
    secondaryOnly,
    secondaryWorks,
    secondaryHours,
    secondaryChart,
    worksTotal,
    unionText: worksTotal != null
      ? `${fmtInt(worksTotal)} ${plural(worksTotal, SECONDARY_WORK_PLURAL)} в объединённой библиотеке`
        + (secondaryOnly > 0 ? ` (включая вне Steam: ${fmtInt(secondaryOnly)})` : '')
      : '',
  };
}
