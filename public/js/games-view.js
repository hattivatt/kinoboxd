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

function normalizeFilters(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {
    includeFree: normalizeFilterBlock(raw.includeFree),
    includeDlc: normalizeFilterBlock(raw.includeDlc),
  };
  return out.includeFree || out.includeDlc ? out : null;
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
 * One `gamesIndex` entry. The backend already ships the fields needed by the
 * client-side drilldowns (type, year, genres, developers/publishers,
 * categories, is_free, early_access, icon); the old normaliser kept only six
 * of them, which made «клик по жанру/году» impossible without a new request.
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
    achievements: normalizeIndexAchievements(item.achievements),
    metadataSources: arr(item.metadataSources).map((source) => text(source)).filter(Boolean),
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
    decades,
    years,
    unknownYear,
    studios,
    personnelTop,
    timeline,
    achievementDays,
    streaks,
    filters,
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
export function gameRowsFromIndex(gamesIndex, predicate = null) {
  const out = [];
  if (!gamesIndex || typeof gamesIndex !== 'object') return out;
  for (const [appid, entry] of Object.entries(gamesIndex)) {
    if (!entry || typeof entry !== 'object') continue;
    const row = normalizeGameIndexEntry(entry, appid);
    if (row.appid == null) continue;
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
  for (const entry of Object.values(gamesIndex || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (target) {
      const genres = arr(entry.genres);
      if (!genres.some((name) => text(name).toLowerCase() === target)) continue;
    }
    const year = numOrNull(entry.releaseYear ?? entry.year);
    const hours = numOrNull(entry.hours);
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

/** Mirrors `MODE_TESTS` in server/games/stats.js — counts must match. */
export const GAME_MODE_TESTS = {
  single: /^single-player$/i,
  multi: /multi-player/i,
  coop: /co-op/i,
  onlineCoop: /online co-op/i,
  localCoop: /local co-op|shared\/split screen/i,
  onlinePvp: /online pvp|^pvp$/i,
  mmo: /^mmo$/i,
  cloud: /steam cloud/i,
  controller: /full controller support/i,
};

export function gameMatchesMode(game, key) {
  const test = GAME_MODE_TESTS[key];
  if (!test) return false;
  return arr(game && game.categories).some((category) => test.test(text(category)));
}

export function gamesByMode(gamesIndex, key) {
  if (!GAME_MODE_TESTS[key]) return [];
  return gameRowsFromIndex(gamesIndex, (row) => gameMatchesMode(row, key));
}

export function gamesByAccess(gamesIndex, key) {
  if (key === 'earlyAccess') return gameRowsFromIndex(gamesIndex, (row) => row.earlyAccess === true);
  if (key === 'freeToPlay') return gameRowsFromIndex(gamesIndex, (row) => row.isFree === true);
  return [];
}

/** Same buckets as `HISTOGRAM_BUCKETS` in server/games/stats.js. */
export const HOURS_BUCKETS = [
  { bucket: '0', test: (hours) => hours === 0 },
  { bucket: '<1', test: (hours) => hours > 0 && hours < 1 },
  { bucket: '1-5', test: (hours) => hours >= 1 && hours < 5 },
  { bucket: '5-20', test: (hours) => hours >= 5 && hours < 20 },
  { bucket: '20-50', test: (hours) => hours >= 20 && hours < 50 },
  { bucket: '50-100', test: (hours) => hours >= 50 && hours < 100 },
  { bucket: '100-500', test: (hours) => hours >= 100 && hours < 500 },
  { bucket: '500+', test: (hours) => hours >= 500 },
];

export function hoursBucketOf(hours) {
  const value = numOrNull(hours);
  if (value == null || value < 0) return null;
  const found = HOURS_BUCKETS.find((entry) => entry.test(value));
  return found ? found.bucket : null;
}

export function gamesInHoursBucket(gamesIndex, bucket) {
  const target = text(bucket);
  const def = HOURS_BUCKETS.find((entry) => entry.bucket === target);
  if (!def) return [];
  return gameRowsFromIndex(gamesIndex, (row) => row.hours != null && def.test(row.hours));
}

/** Games with `playtime_2weeks > 0` — the «за 2 недели» tile drilldown. */
export function gamesWithRecentHours(gamesIndex) {
  return gameRowsFromIndex(gamesIndex, (row) => row.hours2w != null && row.hours2w > 0);
}

/** Backlog = playtime_forever = 0 (the server's definition). */
export function backlogGames(gamesIndex) {
  return gameRowsFromIndex(gamesIndex, (row) => row.hours === 0);
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
  const links = {
    steam: firstString(linksRaw.steam)
      || (appid != null ? `https://store.steampowered.com/app/${appid}` : ''),
    community: appid != null ? `https://steamcommunity.com/app/${appid}` : '',
    steamdb: firstString(linksRaw.steamdb)
      || (appid != null ? `https://steamdb.info/app/${appid}/` : ''),
  };
  return {
    appid,
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

/**
 * Backlog: counter + share + a few known items. The list may be empty (the
 * payload only promises the counter) — the caller then shows the honest note
 * instead of an empty widget.
 */
export function backlogView(backlog, summary) {
  const block = backlog && typeof backlog === 'object' ? backlog : {};
  const s = summary && typeof summary === 'object' ? summary : {};
  const count = block.present || block.count != null
    ? toCount(block.count)
    : toCount(s.unplayedCount);
  const games = toCount(s.gameCount) || toCount(s.ownedCount);
  const share = numOrNull(block.share) ?? (games > 0 ? count / games : null);
  const items = arr(block.items)
    .map((item) => (item && item.name ? item : null))
    .filter(Boolean)
    .map((item) => ({
      appid: item.appid,
      name: item.name,
      yearText: item.releaseYear ? String(item.releaseYear) : 'год неизвестен',
      genresText: item.genres && item.genres.length ? item.genres.join(', ') : '',
    }));
  if (count <= 0 && !items.length) return null;
  return {
    count,
    countText: fmtInt(count),
    shareText: share != null ? percentText(share) : '',
    items,
    hasItems: items.length > 0,
    note: items.length
      ? `${fmtInt(items.length)} ${plural(items.length, GAME_PLURAL)} с известной метадатой`
      : 'состав сервер не передал',
  };
}

/**
 * «За 2 недели»: recent plays with `playtime_2weeks` and the last-played stamp.
 * The stamp is a launch time, not a session — the tooltip says so.
 */
export function recentlyView(recentlyPlayed) {
  const items = arr(recentlyPlayed)
    .map((item) => (item && item.name ? item : null))
    .filter(Boolean)
    .map((item) => {
      const last = lastPlayedInfo(item.lastPlayed);
      return {
        appid: item.appid,
        name: item.name,
        hours2w: item.hours2w,
        hours2wText: item.hours2w != null ? hoursText(item.hours2w) : '',
        hoursTotalText: item.hoursTotal != null ? hoursText(item.hoursTotal) : '',
        lastPlayedText: last.text,
        lastPlayedTitle: last.title,
        hint: item.hours2w != null
          ? `${hoursText(item.hours2w)} за две недели${item.hoursTotal != null ? ` · ${hoursText(item.hoursTotal)} всего` : ''}`
          : 'часы за две недели Steam не передал',
      };
    });
  const total2w = items.reduce((sum, item) => sum + (item.hours2w || 0), 0);
  return {
    items,
    visible: items.length > 0,
    total2wText: items.length ? hoursText(total2w) : '',
  };
}

/** Hours histogram rows (long tail). `null` when the payload has no buckets. */
export function histogramView(hoursHistogram) {
  const rows = normalizeHistogram(hoursHistogram);
  if (!rows.length) return null;
  const max = Math.max(...rows.map((row) => row.count));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return {
    rows: rows.map((row) => ({
      bucket: row.bucket,
      count: row.count,
      countText: fmtInt(row.count),
      widthPercent: max > 0 ? Math.max(2, (row.count / max) * 100) : 2,
      title: `${row.bucket} ч — ${fmtInt(row.count)} ${plural(row.count, GAME_PLURAL)}`,
    })),
    total,
    totalText: fmtInt(total),
  };
}

/* =========================================================
   M2: decades / years / genres / modes / access / enrichment
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

/** `summary.modes` → rows with honest Steam-category labels. */
export function modesView(modes) {
  const block = modes && typeof modes === 'object' ? normalizeModes(modes) : null;
  if (!block) return null;
  const rows = [];
  for (const def of MODE_DEFS) {
    const entry = block[def.key];
    if (!entry || entry.count <= 0) continue;
    rows.push({
      key: def.key,
      label: def.label,
      count: entry.count,
      countText: fmtInt(entry.count),
      hours: entry.hours,
      hoursText: entry.hours != null ? hoursText(entry.hours) : '',
      title: def.title,
      hint: entry.hours != null
        ? `${fmtInt(entry.count)} ${plural(entry.count, GAME_PLURAL)} · ${hoursText(entry.hours)}`
        : `${fmtInt(entry.count)} ${plural(entry.count, GAME_PLURAL)} с этой категорией`,
    });
  }
  if (!rows.length) return null;
  const max = Math.max(...rows.map((row) => row.count));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return {
    rows: rows.map((row) => ({
      ...row,
      shareText: total > 0 ? percentText(row.count / total) : '',
      widthPercent: Math.max(2, (row.count / max) * 100),
    })),
    note: `${fmtInt(rows.length)} ${plural(rows.length, ['режим', 'режима', 'режимов'])}`,
    hint: 'Категории Steam Store (categories[]): одна игра может быть и одиночной, и кооперативной.',
  };
}

/** Early Access / F2P share. Each item exists only when the server sent it. */
export function accessView(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const items = [];
  const push = (key, label, block, hint) => {
    if (!block || block.count == null) return;
    items.push({
      key,
      label,
      count: block.count,
      countText: fmtInt(block.count),
      hours: block.hours,
      hoursText: block.hours != null ? hoursText(block.hours) : '',
      shareText: block.share != null ? percentText(block.share) : '',
      hint,
    });
  };
  push('earlyAccess', 'Early Access', s.earlyAccess,
    'Игры в раннем доступе: доля библиотеки и часов. Признак из Steam Store (genres/release_date).');
  push('freeToPlay', 'Бесплатные (F2P)', s.freeToPlay,
    'Игры с is_free = true. Без фильтра includeFree они входят в часы и backlog; с фильтром — исключаются.');
  if (!items.length) return null;
  return {
    items,
    note: items.map((item) => `${item.label}: ${item.countText}`).join(' · '),
    hint: 'Доли считаются от числа игр библиотеки (type=game), а не от всех записей Steam.',
  };
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
  const honest = free.status === 'pending' || dlc.status === 'pending';
  return {
    includeFree: free,
    includeDlc: dlc,
    items: [free, dlc],
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
