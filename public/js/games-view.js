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
  };
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
    completion: normalizeCompletion(summaryRaw.completion),
    achievements: normalizeAchievements(summaryRaw.achievements),
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
      gamesIndex[appid] = {
        appid: numOrNull(entry.appid) ?? numOrNull(appid),
        name: firstString(entry.name, entry.title),
        hours: normalizeHours(entry),
        lastPlayed: entry.lastPlayed ?? null,
        releaseYear: numOrNull(entry.releaseYear),
        genres: normalizeGenres(entry.genres),
        completion: numOrNull(entry.completion),
      };
    }
  }

  const histogram = normalizeHistogram(source.hoursHistogram ?? source.histogram);

  return {
    profile,
    summary,
    topGames,
    recentlyPlayed,
    backlog,
    histogram,
    gamesIndex,
    has: {
      profile: Boolean(profile),
      games: gameCount > 0 || ownedCount > 0,
      hours: summary.totalHours != null,
      topGames: topGames.length > 0,
      backlog: backlog.count > 0,
      recently: recentlyPlayed.length > 0,
      histogram: histogram.length > 0,
      completion: Boolean(summary.completion),
    },
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
