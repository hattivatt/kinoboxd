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
import { arr, text, numOrNull, firstString } from './core/dom.js';
import { normalizeGameStreaks } from './core/streaks.js';
import {
  boolOrNull, hoursText, normalizeFranchiseRef, normalizeGenres, normalizeHours, normalizeHours2w,
  normalizeTagsList, resolveReviewBucket, reviewScaleEntry, STEAM_REVIEW_SCALE, toCount,
} from './games/normalize/common.js';
import {
  normalizeAchievementDays, normalizeDecades, normalizeFranchises, normalizeScores, normalizeStudios,
  normalizeTimeline, normalizeWeightItems, normalizeYears,
} from './games/normalize/buckets.js';
import { normalizeReviewScoreBlock } from './games/normalize/summary.js';
import {
  GAME_PLURAL, epochSeconds, formatDateRu, formatDateShortRu, percentNumber, percentText, shortDayText,
} from './games/labels.js';
import { secondaryWorkCardView } from './games/secondary-card.js';
import { gogSourcesView, gogStatusText } from './games/sources.js';
import {
  accountFromInput, gamesJobId, importErrorText, jobStageText, normalizeProfilesList,
} from './games/import-flow.js';
import { normalizeGameIndexEntry, normalizePersonGames } from './games/normalize/graph.js';
import { normalizeCardPersonnel } from './games/normalize/profile.js';
import {
  normalizeSecondaryWork, secondaryChartStatus,
} from './games/normalize/secondary.js';

export { normalizeGamesPayload } from './games/normalize/payload.js';
export { normalizeSecondaryWork, secondaryChartStatus } from './games/normalize/secondary.js';
export { MODE_DEFS } from './games/normalize/summary.js';
export { STEAM_REVIEW_SCALE, resolveReviewBucket, hoursText };
export { formatDateRu, formatDateShortRu, percentNumber, percentText };
export { secondaryWorkCardView } from './games/secondary-card.js';
export { gogSourcesView, gogStatusText } from './games/sources.js';
export {
  accountFromInput, gamesJobId, importErrorText, jobStageText, normalizeProfilesList,
} from './games/import-flow.js';

export { jobProgress } from './core/progress.js';

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
      const workKey = firstString(game.workKey);
      // M6 follow-up: a secondary-only work has no appid — its row lives in
      // `gamesIndex` under the `workKey` the personnel payload carries.
      if (appid == null && !workKey) return null;
      const entry = appid != null
        ? index[appid] || index[String(appid)] || null
        : index[workKey] || null;
      const row = entry
        ? normalizeGameIndexEntry(entry, appid)
        : normalizeGameIndexEntry(
            { appid, workKey, secondaryOnly: appid == null && Boolean(workKey) },
            appid
          );
      return {
        ...row,
        appid,
        workKey: workKey || row.workKey || null,
        secondaryOnly: row.secondaryOnly || (appid == null && Boolean(workKey)),
        name: firstString(game.name, row.name, appid != null ? `appid ${appid}` : workKey),
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
    // M7 store artwork: the card prefers the real `header_image` (and the
    // capsule as a secondary fallback) over a guessed legacy CDN path.
    headerImage: /^https?:\/\//i.test(text(raw.headerImage)) ? text(raw.headerImage) : '',
    capsuleImage: /^https?:\/\//i.test(text(raw.capsuleImage)) ? text(raw.capsuleImage) : '',
    // First store screenshot (1920×1080): a late landscape fallback when both
    // the header and the capsule are gone. Never the first choice — it is not
    // artwork.
    screenshot: /^https?:\/\//i.test(text(arr(raw.screenshots)[0]))
      ? text(arr(raw.screenshots)[0])
      : '',
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
    headerImage: (details && details.headerImage) || (
      /^https?:\/\//i.test(text(source.headerImage)) ? text(source.headerImage) : ''
    ),
    capsuleImage: (details && details.capsuleImage) || (
      /^https?:\/\//i.test(text(source.capsuleImage)) ? text(source.capsuleImage) : ''
    ),
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
    // New-schema Steam art: the server resolves the real vertical capsule once
    // (`verticalCapsule`) and says whether it exists at all
    // (`verticalCapsuleKnown`). The payload row wins; the index fills it.
    const headerImage = firstString(item.headerImage, entry.headerImage) || '';
    const verticalCapsule = firstString(item.verticalCapsule, entry.verticalCapsule) || '';
    const verticalCapsuleKnown =
      item.verticalCapsuleKnown ?? entry.verticalCapsuleKnown ?? null;
    const iconFallbackUrl = firstString(item.iconFallbackUrl, entry.iconFallbackUrl) || '';
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
        headerImage,
        verticalCapsule,
        verticalCapsuleKnown,
        iconFallbackUrl,
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
    if (!previous.headerImage && headerImage) previous.headerImage = headerImage;
    if (!previous.verticalCapsule && verticalCapsule) previous.verticalCapsule = verticalCapsule;
    if (previous.verticalCapsuleKnown == null && verticalCapsuleKnown != null) {
      previous.verticalCapsuleKnown = verticalCapsuleKnown;
    }
    if (!previous.iconFallbackUrl && iconFallbackUrl) previous.iconFallbackUrl = iconFallbackUrl;
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
      if (headerImage) previous.headerImage = headerImage;
      if (verticalCapsule) previous.verticalCapsule = verticalCapsule;
      if (verticalCapsuleKnown != null) previous.verticalCapsuleKnown = verticalCapsuleKnown;
      if (iconFallbackUrl) previous.iconFallbackUrl = iconFallbackUrl;
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
        // M7: the store header lets the card ask the proxy for the vertical
        // capsule in the same (new-schema) asset folder.
        headerImage: row.headerImage,
        // M7-resolve: the server-resolved poster (and «none known» verdict),
        // plus the small-capsule fallback for a broken 32×32 icon.
        verticalCapsule: row.verticalCapsule,
        verticalCapsuleKnown: row.verticalCapsuleKnown ?? null,
        iconFallbackUrl: row.iconFallbackUrl,
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
      workKeys: item.workKeys,
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
  const workKeys = new Set(ref.workKeys || []);
  const explicit = ids.size > 0 || workKeys.size > 0;
  const targetLabel = ref.label.toLowerCase();
  return gameRowsFromIndex(gamesIndex, (row) => {
    if (explicit) {
      // Explicit membership is authoritative: a Steam row matches by appid, a
      // secondary-only row by its work key (the merged edition row keeps
      // `canonicalWorkKey`, which is what `workKeys` names).
      if (row.appid != null && ids.has(Number(row.appid))) return true;
      const rowKeys = [row.workKey, row.canonicalWorkKey].filter(Boolean);
      return rowKeys.some((key) => workKeys.has(key));
    }
    if (!row.franchise) return false;
    return row.franchise.key === ref.key
      || row.franchise.label === ref.label
      || row.franchise.label.toLowerCase() === targetLabel;
  });
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
  const value = normalizeGameStreaks(streaks, normalizeAchievementDays(achievementDays));
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
