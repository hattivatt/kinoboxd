'use strict';

/**
 * `/api/games/stats` payload (M1 + M2).
 *
 * One profile = one owner (one steamid64). Nothing is ever summed across two
 * Steam accounts (AGENTS.md §6, ИГРЫ §2.0): the route requires exactly one
 * `?profile=steam-<steamid64>` token and this module builds the payload from
 * that profile's library snapshot only.
 *
 * M1 fields are exactly the ones the imported data supports:
 *   - summary: owned/played/backlog counts, total/mean/median hours, Pareto
 *     top-10% share, 2-week hours, last-played timestamp;
 *   - gamesIndex: a light `appid → entry` map (as `booksIndex` in the books
 *     payload — the frontend reads it with `Object.values`);
 *   - topGames / recentlyPlayed / recently2w / backlog / hoursHistogram;
 *   - achievements: completion and rare unlocked counts from the achievements
 *     cache; timeline/achievementDays/streaks appear as soon as at least one
 *     game's XML was cached (the per-game endpoint fills it lazily).
 *
 * M2 (after `POST /api/games/enrich` has written `details/<appid>.json`):
 *   - `type` separates games from DLC/demo/software/video, so `gameCount` is
 *     real (`gameCountEstimated` flips to false once every appid has details);
 *   - `years`/`decades` bucket by `releaseYear` (unknown year is an explicit
 *     last bucket, never a fake 0; no ancient bucket — games are 1970..2100);
 *   - `genres` is the playtime-weighted wall (`count`/`hours`/`weight`/`share`);
 *   - `summary.modes`/`earlyAccess`/`freeToPlay`/`platforms`/`metadata` from
 *     categories/is_free/platforms and the details coverage;
 *   - `includeFree`/`includeDlc` are REAL filters (`meta.filters.applied:true`):
 *     includeDlc=0 drops `type!=="game"` (DLC/demo/software/video),
 *     includeFree=0 drops `is_free===true`. Unknown type is always kept.
 *
 * Without details every M2 bucket stays empty/null and `meta.pending` says
 * why — the payload is exactly M1, never invented data.
 *
 * Hours come only from `GetOwnedGames` (`playtime_forever`, minutes).
 * `<stats><hoursPlayed>` from the achievements XML is never aggregated: it is
 * "time under stats tracking", not full playtime (§2.1 п. 3).
 */

const gameCache = require('./game-cache');
const config = require('../config');

const RECENT_LIMIT = 10;
const TOP_LIMIT = 20;
const BACKLOG_LIMIT = 200;
const RARE_PERCENT = 5;
const UNKNOWN_YEAR_LABEL = 'год неизвестен';

// Steam category descriptions (`l=english`) → the mode counters of the
// payload. Kept as regexes because Steam occasionally rewords a label.
const MODE_TESTS = {
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

function detailOf(details, appid) {
  if (!details || typeof details !== 'object') return null;
  const doc = details[String(appid)];
  return doc && doc.success ? doc : null;
}

function genreNamesOf(doc) {
  return (doc && Array.isArray(doc.genres) ? doc.genres : [])
    .map((entry) => (entry && entry.description ? String(entry.description) : null))
    .filter(Boolean);
}

function categoryNamesOf(doc) {
  return (doc && Array.isArray(doc.categories) ? doc.categories : [])
    .map((entry) => (entry && entry.description ? String(entry.description) : null))
    .filter(Boolean);
}

function modeFlagsOf(doc) {
  const flags = {};
  const categories = categoryNamesOf(doc);
  for (const [key, test] of Object.entries(MODE_TESTS)) {
    flags[key] = categories.some((name) => test.test(name));
  }
  return flags;
}

function releaseYearOf(doc) {
  if (!doc) return null;
  const year = Number(doc.releaseYear);
  return Number.isInteger(year) && year >= 1970 && year <= 2100 ? year : null;
}

/** Sum `count`/`hours` into a decade/year bucket. */
function pushBucket(map, key, hours) {
  const entry = map.get(key) || { count: 0, hours: 0 };
  entry.count++;
  entry.hours += hours;
  map.set(key, entry);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function minutesToHours(minutes) {
  return round1((Number(minutes) || 0) / 60);
}

function median(values) {
  const list = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value));
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function isoOfSeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

function iconUrlOf(appid, hash) {
  if (!appid || !hash) return null;
  return (
    `https://media.steampowered.com/steamcommunity/public/images/apps/${appid}/${hash}.jpg`
  );
}

const HISTOGRAM_BUCKETS = [
  { bucket: '0', test: (hours) => hours === 0 },
  { bucket: '<1', test: (hours) => hours > 0 && hours < 1 },
  { bucket: '1-5', test: (hours) => hours >= 1 && hours < 5 },
  { bucket: '5-20', test: (hours) => hours >= 5 && hours < 20 },
  { bucket: '20-50', test: (hours) => hours >= 20 && hours < 50 },
  { bucket: '50-100', test: (hours) => hours >= 50 && hours < 100 },
  { bucket: '100-500', test: (hours) => hours >= 100 && hours < 500 },
  { bucket: '500+', test: (hours) => hours >= 500 },
];

function hoursHistogram(hoursList) {
  const counts = HISTOGRAM_BUCKETS.map((entry) => ({ bucket: entry.bucket, count: 0 }));
  for (const hours of hoursList) {
    const index = HISTOGRAM_BUCKETS.findIndex((entry) => entry.test(hours));
    if (index >= 0) counts[index].count++;
  }
  return counts;
}

/**
 * Days (UTC) with at least one achievement unlock, plus current/best streak.
 * This is "achievement activity", not "days played" — the UI must say so.
 */
function calendarFromAchievements(docs) {
  const dayCounts = new Map();
  const dayAppids = new Map();
  for (const doc of docs) {
    for (const entry of doc.achievements || []) {
      if (!entry.achieved || !entry.unlockTimestamp) continue;
      const iso = new Date(entry.unlockTimestamp * 1000).toISOString();
      const day = iso.slice(0, 10);
      dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
      const set = dayAppids.get(day) || new Set();
      if (doc.appid != null) set.add(doc.appid);
      dayAppids.set(day, set);
    }
  }
  const days = [...dayCounts.keys()].sort();
  const achievementDays = days.map((date) => ({
    date,
    count: dayCounts.get(date),
    appids: [...(dayAppids.get(date) || [])].sort((a, b) => a - b),
  }));
  const months = new Map();
  for (const day of achievementDays) {
    const month = day.date.slice(0, 7);
    const entry = months.get(month) || { month, unlocked: 0, games: new Set() };
    entry.unlocked += day.count;
    for (const appid of day.appids) entry.games.add(appid);
    months.set(month, entry);
  }
  const timeline = [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((entry) => ({ month: entry.month, unlocked: entry.unlocked, games: entry.games.size }));

  // Streaks over consecutive calendar days with unlocks (UTC).
  let best = 0;
  let bestDates = [];
  let run = 0;
  let runStart = 0;
  const dayNumbers = days.map((date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000));
  for (let index = 0; index < dayNumbers.length; index++) {
    if (index > 0 && dayNumbers[index] === dayNumbers[index - 1] + 1) {
      run++;
    } else {
      run = 1;
      runStart = index;
    }
    if (run > best) {
      best = run;
      bestDates = days.slice(runStart, index + 1);
    }
  }
  let current = 0;
  if (dayNumbers.length) {
    const today = Math.floor(Date.now() / 86400000);
    const last = dayNumbers[dayNumbers.length - 1];
    if (last === today || last === today - 1) {
      current = 1;
      for (let index = dayNumbers.length - 1; index > 0; index--) {
        if (dayNumbers[index] === dayNumbers[index - 1] + 1) current++;
        else break;
      }
    }
  }
  return {
    timeline,
    achievementDays,
    streaks: {
      current,
      best,
      lastUnlockDate: days.length ? days[days.length - 1] : null,
      bestDates,
    },
  };
}

/**
 * Build the payload. Pure: the caller supplies the library snapshot, the
 * profile document, cached achievement documents and global percentages.
 */
function buildGamesStats(input = {}) {
  const startedAt = process.hrtime.bigint();
  const library = input.library || { games: [], partial: true, game_count: null };
  const profile = input.profile || null;
  const steamId64 = input.steamId64 || (profile && profile.userKey) || library.userKey;
  const profileKey = gameCache.profileKeyOf(steamId64);
  const games = Array.isArray(library.games) ? library.games : [];
  const partial = Boolean(library.partial);

  /* ---------------- details + filters (M2) ---------------- */
  // `details` is the `{ [appid]: details/<appid>.json }` map. With no details
  // at all the payload must stay exactly M1: every game is kept, every M2
  // bucket stays empty and `meta.pending` says why.
  const details = input.details && typeof input.details === 'object' ? input.details : {};
  const includeFree = input.includeFree !== false;
  const includeDlc = Boolean(input.includeDlc);
  const detailsCount = games.filter((game) => detailOf(details, game.appid)).length;
  const hasDetails = detailsCount > 0;

  // Filter semantics (M2): DLC/demo/software/video are not games; a DLC is
  // included only with `includeDlc=1`. Unknown type (no details yet) is kept —
  // it must never be silently dropped. `includeFree=0` removes F2P games.
  const excluded = { dlc: 0, otherType: 0, free: 0, unknownType: 0 };
  const keptGames = [];
  for (const game of games) {
    const doc = detailOf(details, game.appid);
    const type = doc && doc.type ? String(doc.type) : null;
    const isFree = doc && typeof doc.is_free === 'boolean' ? doc.is_free : null;
    if (type && type !== 'game') {
      const keepAsDlc = includeDlc && type === 'dlc';
      if (!keepAsDlc) {
        if (type === 'dlc') excluded.dlc++;
        else excluded.otherType++;
        continue;
      }
    }
    if (isFree === null) excluded.unknownType++;
    if (!includeFree && isFree === true) {
      excluded.free++;
      continue;
    }
    keptGames.push(game);
  }

  const minutesList = keptGames.map((game) => Number(game.playtime_forever) || 0);
  const hoursList = minutesList.map((minutes) => minutes / 60);
  const ownedCount = games.length;
  const gameCount = keptGames.length;
  const totalMinutes = minutesList.reduce((sum, minutes) => sum + minutes, 0);
  const rawTotalHours = totalMinutes / 60;
  const totalHours = round1(rawTotalHours);
  const playedCount = minutesList.filter((minutes) => minutes > 0).length;
  const unplayedCount = minutesList.filter((minutes) => minutes === 0).length;

  // Pareto: the share of hours held by the top 10% of games (by hours).
  const sortedMinutes = [...minutesList].sort((a, b) => b - a);
  const topCount = Math.max(1, Math.ceil(gameCount * 0.1));
  const topMinutes = sortedMinutes.slice(0, topCount).reduce((sum, minutes) => sum + minutes, 0);
  const top10HoursShare = totalMinutes > 0 ? round3(topMinutes / totalMinutes) : 0;

  const medianHours = round1((median(minutesList) || 0) / 60);
  const meanHours = gameCount ? round2(totalHours / gameCount) : 0;

  const recent2wMinutes = keptGames.reduce(
    (sum, game) => sum + (Number(game.playtime_2weeks) || 0),
    0
  );
  const lastPlayedSeconds = keptGames.reduce(
    (max, game) => Math.max(max, Number(game.rtime_last_played) || 0),
    0
  );

  const hoursOf = (game) => (Number(game.playtime_forever) || 0) / 60;

  // Per-game completion from the achievements cache (only games with stats).
  const achievementDocs = (input.achievements || []).filter(
    (doc) => doc && doc.totalCount > 0 && keptGames.some((game) => game.appid === doc.appid)
  );
  const completionByAppid = new Map();
  for (const doc of achievementDocs) {
    completionByAppid.set(doc.appid, {
      unlocked: doc.unlockedCount,
      total: doc.totalCount,
      percent: round1((doc.unlockedCount / doc.totalCount) * 100),
    });
  }

  const percentList = achievementDocs.map(
    (doc) => (doc.unlockedCount / doc.totalCount) * 100
  );
  const unlockedTotal = achievementDocs.reduce((sum, doc) => sum + doc.unlockedCount, 0);
  const achievementsTotal = achievementDocs.reduce((sum, doc) => sum + doc.totalCount, 0);

  // Rare = unlocked with a global percent below 5. Global percentages are
  // matched case-insensitively (XML apiname is lowercase, the official API
  // returns uppercase names).
  const globalByAppid = input.globals || new Map();
  let rareUnlocked = 0;
  for (const doc of achievementDocs) {
    const global = globalByAppid.get ? globalByAppid.get(doc.appid) : null;
    if (!global || !global.byName) continue;
    for (const entry of doc.achievements || []) {
      if (!entry.achieved || !entry.apiname) continue;
      const percent =
        global.byName[entry.apiname] != null
          ? global.byName[entry.apiname]
          : global.byName[entry.apiname.toLowerCase()];
      if (percent != null && percent < RARE_PERCENT) rareUnlocked++;
    }
  }

  const calendar = calendarFromAchievements(achievementDocs);

  /* ---------------- per-game index ---------------- */
  const gamesIndex = {};
  for (const game of keptGames) {
    const appid = game.appid;
    if (appid == null) continue;
    const completion = completionByAppid.get(appid) || null;
    const doc = detailOf(details, game.appid);
    const year = releaseYearOf(doc);
    gamesIndex[appid] = {
      appid,
      name: game.name || null,
      hours: minutesToHours(game.playtime_forever),
      hours2w: game.playtime_2weeks ? minutesToHours(game.playtime_2weeks) : 0,
      rtime: Number(game.rtime_last_played) || 0,
      lastPlayed: isoOfSeconds(game.rtime_last_played),
      iconUrl: iconUrlOf(appid, game.img_icon_url),
      // M2 (appdetails) — null/[] while details are missing, never invented.
      type: doc ? doc.type : null,
      year,
      releaseYear: year,
      genres: genreNamesOf(doc),
      developers: doc && Array.isArray(doc.developers) ? [...doc.developers] : [],
      publishers: doc && Array.isArray(doc.publishers) ? [...doc.publishers] : [],
      categories: categoryNamesOf(doc),
      dlcCount:
        doc && Number.isFinite(Number(doc.dlcCount)) ? Number(doc.dlcCount) : null,
      metacritic:
        doc && doc.metacritic && Number.isFinite(Number(doc.metacritic.score))
          ? Number(doc.metacritic.score)
          : null,
      isFree: doc && typeof doc.is_free === 'boolean' ? doc.is_free : null,
      earlyAccess: doc ? Boolean(doc.earlyAccess) : null,
      metadataSources: doc ? ['steam-store'] : [],
      completion: completion ? completion.percent : null,
      achievements: completion,
    };
  }

  const byHoursDesc = [...keptGames].sort(
    (left, right) =>
      (Number(right.playtime_forever) || 0) - (Number(left.playtime_forever) || 0) ||
      String(left.name || '').localeCompare(String(right.name || ''))
  );

  const topGames = byHoursDesc.slice(0, TOP_LIMIT).map((game) => {
    const doc = detailOf(details, game.appid);
    return {
      appid: game.appid,
      name: game.name || null,
      hours: minutesToHours(game.playtime_forever),
      hours2w: game.playtime_2weeks ? minutesToHours(game.playtime_2weeks) : 0,
      lastPlayed: isoOfSeconds(game.rtime_last_played),
      releaseYear: releaseYearOf(doc),
      genres: genreNamesOf(doc),
      type: doc ? doc.type : null,
      isFree: doc && typeof doc.is_free === 'boolean' ? doc.is_free : null,
      completion: completionByAppid.has(game.appid)
        ? completionByAppid.get(game.appid).percent
        : null,
      cover: null,
      iconUrl: iconUrlOf(game.appid, game.img_icon_url),
    };
  });

  const recentlyPlayed = [...keptGames]
    .filter((game) => Number(game.rtime_last_played) > 0)
    .sort((left, right) => Number(right.rtime_last_played) - Number(left.rtime_last_played))
    .slice(0, RECENT_LIMIT)
    .map((game) => ({
      appid: game.appid,
      name: game.name || null,
      hours2w: game.playtime_2weeks ? minutesToHours(game.playtime_2weeks) : 0,
      hoursTotal: minutesToHours(game.playtime_forever),
      lastPlayed: isoOfSeconds(game.rtime_last_played),
      iconUrl: iconUrlOf(game.appid, game.img_icon_url),
    }));

  const recently2w = [...keptGames]
    .filter((game) => Number(game.playtime_2weeks) > 0)
    .sort((left, right) => Number(right.playtime_2weeks) - Number(left.playtime_2weeks))
    .map((game) => ({
      appid: game.appid,
      name: game.name || null,
      hours2w: minutesToHours(game.playtime_2weeks),
      hoursTotal: minutesToHours(game.playtime_forever),
      lastPlayed: isoOfSeconds(game.rtime_last_played),
      iconUrl: iconUrlOf(game.appid, game.img_icon_url),
    }));

  const backlogItems = [...keptGames]
    .filter((game) => (Number(game.playtime_forever) || 0) === 0)
    .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')))
    .slice(0, BACKLOG_LIMIT)
    .map((game) => {
      const doc = detailOf(details, game.appid);
      const year = releaseYearOf(doc);
      return {
        appid: game.appid,
        name: game.name || null,
        iconUrl: iconUrlOf(game.appid, game.img_icon_url),
        year,
        releaseYear: year,
        genres: genreNamesOf(doc),
      };
    });

  // Platform hours are in the library snapshot (playtime_*_forever). Deck hours
  // are a subset of Linux hours and are reported separately, never added.
  const platformMinutes = keptGames.reduce(
    (acc, game) => {
      acc.windows += Number(game.playtime_windows_forever) || 0;
      acc.mac += Number(game.playtime_mac_forever) || 0;
      acc.linux += Number(game.playtime_linux_forever) || 0;
      acc.deck += Number(game.playtime_deck_forever) || 0;
      return acc;
    },
    { windows: 0, mac: 0, linux: 0, deck: 0 }
  );

  /* ---------------- M2 aggregates (only when details exist) ---------------- */
  const yearMap = new Map();
  const decadeMap = new Map();
  let unknownYearCount = 0;
  let unknownYearHours = 0;
  for (const game of keptGames) {
    const doc = detailOf(details, game.appid);
    const year = releaseYearOf(doc);
    const hours = hoursOf(game);
    if (year == null) {
      unknownYearCount++;
      unknownYearHours += hours;
      continue;
    }
    pushBucket(yearMap, year, hours);
    pushBucket(decadeMap, Math.floor(year / 10) * 10, hours);
  }

  const years = hasDetails
    ? [...yearMap.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([year, entry]) => ({ year, count: entry.count, hours: round1(entry.hours) }))
    : [];
  const decades = hasDetails
    ? [...decadeMap.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([decade, entry]) => ({ decade, count: entry.count, hours: round1(entry.hours) }))
    : [];
  if (hasDetails && unknownYearCount > 0) {
    const unknown = {
      key: 'unknown',
      label: UNKNOWN_YEAR_LABEL,
      unknown: true,
      count: unknownYearCount,
      hours: round1(unknownYearHours),
    };
    years.push({ year: null, ...unknown });
    decades.push({ decade: null, ...unknown });
  }

  const realYears = years.filter((entry) => entry.year != null);

  // Genres: the wall is playtime-weighted, so `hours` (and `weight`, kept for
  // the frontend) drives the size; `count`/`share` stay available.
  const genreMap = new Map();
  for (const game of keptGames) {
    const doc = detailOf(details, game.appid);
    if (!doc) continue;
    const hours = hoursOf(game);
    for (const name of genreNamesOf(doc)) {
      const entry = genreMap.get(name) || { name, count: 0, hours: 0 };
      entry.count++;
      entry.hours += hours;
      genreMap.set(name, entry);
    }
  }
  const genres = hasDetails
    ? [...genreMap.values()]
        .map((entry) => ({
          name: entry.name,
          count: entry.count,
          hours: round1(entry.hours),
          weight: round1(entry.hours),
          share: rawTotalHours > 0 ? round3(entry.hours / rawTotalHours) : 0,
        }))
        .sort(
          (left, right) =>
            right.hours - left.hours ||
            right.count - left.count ||
            left.name.localeCompare(right.name)
        )
    : [];

  const modes = hasDetails
    ? {
        single: 0,
        multi: 0,
        coop: 0,
        onlineCoop: 0,
        localCoop: 0,
        onlinePvp: 0,
        mmo: 0,
        cloud: 0,
        controller: 0,
      }
    : null;
  let earlyCount = 0;
  let earlyHours = 0;
  let freeCount = 0;
  let freeHours = 0;
  const platformGames = { windows: 0, mac: 0, linux: 0 };
  if (hasDetails) {
    for (const game of keptGames) {
      const doc = detailOf(details, game.appid);
      if (!doc) continue;
      const hours = hoursOf(game);
      const flags = modeFlagsOf(doc);
      for (const key of Object.keys(modes)) {
        if (flags[key]) modes[key]++;
      }
      if (doc.earlyAccess) {
        earlyCount++;
        earlyHours += hours;
      }
      if (doc.is_free === true) {
        freeCount++;
        freeHours += hours;
      }
      if (doc.platforms && typeof doc.platforms === 'object') {
        if (doc.platforms.windows) platformGames.windows++;
        if (doc.platforms.mac) platformGames.mac++;
        if (doc.platforms.linux) platformGames.linux++;
      }
    }
  }
  const earlyAccess = hasDetails
    ? {
        count: earlyCount,
        hours: round1(earlyHours),
        share: rawTotalHours > 0 ? round3(earlyHours / rawTotalHours) : 0,
      }
    : null;
  const freeToPlay = hasDetails
    ? {
        count: freeCount,
        hours: round1(freeHours),
        share: rawTotalHours > 0 ? round3(freeHours / rawTotalHours) : 0,
      }
    : null;
  const platforms = hasDetails
    ? {
        windows: platformGames.windows,
        mac: platformGames.mac,
        linux: platformGames.linux,
        deckHours: minutesToHours(platformMinutes.deck),
        deckHoursShare: totalMinutes ? round3(platformMinutes.deck / totalMinutes) : 0,
      }
    : null;

  const detailDocs = games
    .map((game) => details[String(game.appid)])
    .filter((doc) => doc && typeof doc === 'object');
  const detailsUnavailable = detailDocs.filter((doc) => doc.success === false).length;
  const detailsMissing = Math.max(0, games.length - detailsCount - detailsUnavailable);
  let lastEnrichedMs = 0;
  for (const doc of detailDocs) {
    const ts = Date.parse(String(doc.fetchedAt || ''));
    if (Number.isFinite(ts) && ts > lastEnrichedMs) lastEnrichedMs = ts;
  }
  const lastEnrichedAt = lastEnrichedMs ? new Date(lastEnrichedMs).toISOString() : null;
  const metadata = hasDetails
    ? {
        detailsResolved: detailsCount,
        detailsTotal: games.length,
        detailsPercent: games.length
          ? round1((detailsCount / games.length) * 100)
          : 0,
        detailsUnavailable,
        detailsMissing,
        lastEnrichedAt,
      }
    : null;

  const keyConfigured = Boolean(config.loadSteamKey());
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  const allProfileKeys = gameCache.listProfiles().map((entry) => entry.key);

  return {
    sources: {
      connected: [profileKey],
      selected: [profileKey],
      profile: {
        key: profileKey,
        source: 'steam',
        userKey: steamId64,
        personaName: (profile && profile.personaName) || null,
        avatarUrl: (profile && profile.avatarUrl) || null,
        profileUrl:
          (profile && profile.profileUrl) ||
          `https://steamcommunity.com/profiles/${steamId64}`,
        privacy: (profile && profile.privacy) || null,
        importedAt: (profile && profile.importedAt) || null,
        timeCreated: (profile && profile.timeCreated) || null,
        lastLogOff: (profile && profile.lastLogOff) || null,
        gameCount: library.game_count == null ? ownedCount : library.game_count,
      },
      profiles: { connected: allProfileKeys, selected: [profileKey] },
    },
    // M1 has no `type` in GetOwnedGames: ownedCount is the honest number,
    // gameCount is an estimate until appdetails (M2) separates DLC/tools.
    libraryPartial: partial,
    summary: {
      gameCount,
      // Honest: with no details (or with unavailable/unknown types) the type
      // split is still an estimate; a fully enriched library flips it to false.
      gameCountEstimated: detailsCount < games.length,
      ownedCount,
      playedCount,
      unplayedCount,
      backlogShare: gameCount ? round3(unplayedCount / gameCount) : 0,
      totalHours,
      meanHours,
      medianHours,
      top10HoursShare,
      top10Count: gameCount ? topCount : 0,
      recent2wHours: round1(recent2wMinutes / 60),
      lastPlayedAt: isoOfSeconds(lastPlayedSeconds),
      releaseYearFrom: realYears.length ? realYears[0].year : null,
      releaseYearTo: realYears.length ? realYears[realYears.length - 1].year : null,
      completion: {
        avgPercent: percentList.length ? round1(percentList.reduce((a, b) => a + b, 0) / percentList.length) : null,
        medianPercent: percentList.length ? round1(median(percentList)) : null,
        perfectCount: percentList.filter((percent) => percent >= 100).length,
        gamesWithStats: achievementDocs.length,
        gamesTotal: gameCount,
      },
      achievements: {
        unlocked: unlockedTotal,
        total: achievementsTotal,
        rareUnlocked,
        rareThresholdPercent: RARE_PERCENT,
        coverage: { gamesWithStats: achievementDocs.length, gamesTotal: gameCount },
      },
      platformHours: {
        windows: minutesToHours(platformMinutes.windows),
        mac: minutesToHours(platformMinutes.mac),
        linux: minutesToHours(platformMinutes.linux),
        deck: minutesToHours(platformMinutes.deck),
        deckShare: totalMinutes ? round3(platformMinutes.deck / totalMinutes) : 0,
      },
      // M2 (appdetails): null until at least one details document exists.
      modes,
      earlyAccess,
      freeToPlay,
      platforms,
      metadata,
    },
    hoursHistogram: hoursHistogram(hoursList),
    topGames,
    recentlyPlayed,
    recently2w,
    backlog: {
      count: unplayedCount,
      share: gameCount ? round3(unplayedCount / gameCount) : 0,
      items: backlogItems,
      truncated: unplayedCount > backlogItems.length,
    },
    // M2/M3 buckets — present as empty arrays so the frontend never has to
    // guess, but never filled with invented data.
    genres,
    tags: [],
    decades,
    years,
    franchises: [],
    studios: [],
    personnelTop: null,
    timeline: calendar.timeline,
    achievementDays: calendar.achievementDays,
    streaks: calendar.streaks,
    gamesIndex,
    // Games of the visible (filtered) set with no successful details.
    unmatchedCount: keptGames.filter((game) => !detailOf(details, game.appid)).length,
    meta: {
      buildMs: Number(elapsedMs.toFixed(1)),
      libraryFingerprint: library.fingerprint || null,
      libraryFetchedAt: library.fetchedAt || null,
      libraryStale: !gameCache.isFresh(library, gameCache.libraryTtlMs()),
      libraryTtlHours: Math.round(gameCache.libraryTtlMs() / 3600000),
      achievementsCachedGames: achievementDocs.length,
      calendarAvailable: achievementDocs.length > 0,
      keyConfigured,
      keySource: keyConfigured ? config.steamKeySource() : null,
      details: metadata,
      excluded,
      filters: {
        includeFree: {
          requested: includeFree,
          // `applied` means "the filter could actually run": at least one
          // details document answered `is_free`. With no details it stays
          // false and the reason is explicit, never a silent no-op.
          applied: hasDetails,
          excluded: excluded.free,
          reason: hasDetails ? null : 'details_not_imported',
        },
        includeDlc: {
          requested: includeDlc,
          applied: hasDetails,
          excluded: excluded.dlc,
          excludedTypes: excluded.otherType,
          reason: hasDetails ? null : 'details_not_imported',
        },
      },
      pending: [
        ...(hasDetails
          ? []
          : ['genres', 'years', 'decades', 'modes', 'earlyAccess', 'freeToPlay', 'platforms']),
        'tags',
        'franchises',
        'studios',
        'personnelTop',
      ],
    },
  };
}

/**
 * Load one profile from cache and build the payload.
 * Returns null when the token names no cached profile/library.
 */
function buildGamesStatsFromCache(profileKey, options = {}) {
  const parsed = gameCache.parseProfileToken(profileKey);
  if (!parsed) return null;
  const profile = gameCache.getProfile(parsed.userKey);
  const library = gameCache.getLibrary(parsed.userKey);
  if (!profile || !library) return null;
  const achievements = gameCache.listAchievements(parsed.userKey);
  const globals = new Map();
  for (const doc of achievements) {
    const global = gameCache.getGlobal(doc.appid);
    if (global) globals.set(doc.appid, global);
  }
  const appids = (Array.isArray(library.games) ? library.games : []).map((game) => game.appid);
  const details = gameCache.listDetails(appids);
  return buildGamesStats({
    steamId64: parsed.userKey,
    profile,
    library,
    achievements,
    globals,
    details,
    includeFree: options.includeFree !== false,
    includeDlc: Boolean(options.includeDlc),
  });
}

/** Compact profile card for `/api/games/profiles`. */
function profileSummary(profile, library) {
  if (!profile) return null;
  const games = (library && Array.isArray(library.games) && library.games) || [];
  const minutes = games.reduce((sum, game) => sum + (Number(game.playtime_forever) || 0), 0);
  return {
    key: gameCache.profileKeyOf(profile.userKey),
    source: 'steam',
    userKey: profile.userKey,
    personaName: profile.personaName || null,
    avatarUrl: profile.avatarUrl || null,
    privacy: profile.privacy || null,
    importedAt: profile.importedAt || null,
    libraryPartial: Boolean(library && library.partial),
    gameCount: library ? library.game_count : null,
    ownedCount: games.length,
    totalHours: round1(minutes / 60),
    playedCount: games.filter((game) => (Number(game.playtime_forever) || 0) > 0).length,
  };
}

module.exports = {
  RARE_PERCENT,
  HISTOGRAM_BUCKETS,
  UNKNOWN_YEAR_LABEL,
  MODE_TESTS,
  detailOf,
  genreNamesOf,
  categoryNamesOf,
  modeFlagsOf,
  releaseYearOf,
  round1,
  round2,
  round3,
  minutesToHours,
  median,
  hoursHistogram,
  calendarFromAchievements,
  buildGamesStats,
  buildGamesStatsFromCache,
  profileSummary,
};
