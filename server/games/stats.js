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
 * M5-B (editions + hours filter):
 *   - every aggregate counts a **canonical work** once
 *     (`cache-games/editions.json`): `The Elder Scrolls V: Skyrim` + `…
 *     Special Edition`, `GTA V Legacy` + `GTA V Enhanced`, regional cards and
 *     catalog duplicates (`Wasteland 2` / `… Director's Cut`) are one game;
 *   - `gamesIndex` still keeps every appid (the library table must not lose
 *     rows) and adds `canonicalWorkKey`/`primaryAppid`/`isPrimary`/
 *     `editionCount`/`canonicalHours`;
 *   - `minHours` (-1 all, 0 played only, N≥1 at least N hours) runs after the
 *     type/free filters and after the edition merge, so a work with a 0-hour
 *     edition and a played edition stays when its canonical hours pass.
 *
 * Hours come only from `GetOwnedGames` (`playtime_forever`, minutes).
 * `<stats><hoursPlayed>` from the achievements XML is never aggregated: it is
 * "time under stats tracking", not full playtime (§2.1 п. 3).
 *
 * M6c (GOG/Epic as same-owner secondary libraries, 01.11.2026):
 *   - the union (`secondary-union.js`) joins GOG/Epic products to Steam works
 *     by `workKey` (Wikidata P2725/P6278 → P1733, then an exact title match);
 *   - a work that exists **only** outside Steam is a real owned game: it is
 *     counted in `gameCount`/`worksTotal`, its hours go into `totalHours`,
 *     its release year into `years`/`decades`, its genres into `genres` (when
 *     the store knows one), and it gets its own row in `topGames`/`backlog`/
 *     `gamesIndex` (`appid: null`, `secondaryOnly: true`);
 *   - `summary.hoursBySource` keeps one number per store (`steam` = the Steam
 *     journal total) and `all` = the display sum (Steam + GOG + Epic of the
 *     same works). Steam-only facts (achievements, `lastPlayed`, SteamSpy
 *     tags, review scores, completion) stay Steam-only — no invented data;
 *   - `minHours` never drops a secondary work whose hours the store never
 *     answered for (`hoursUnknown`, `hoursStatus: pending|unknown`); a real
 *     0-hour secondary work is filtered exactly like a Steam work.
 */

const gameCache = require('./game-cache');
const gogCache = require('./gog-cache');
const { buildSecondaryUnion } = require('./secondary-union');
const {
  readDetailsIndex,
  enrichUnionWithDetails,
  runningFor: secondaryDetailsRunning,
} = require('./secondary-details');
const { readSecondaryLinks } = require('./secondary-identity');
const { buildEpicLayerSync, epicSourceBlock } = require('./epic-layer');
const franchise = require('./franchise');
const editions = require('./editions');
const config = require('../config');

const RECENT_LIMIT = 10;
const TOP_LIMIT = 20;
const BACKLOG_LIMIT = 200;
const TAG_LIMIT = 50;
const TAG_INDEX_LIMIT = 5;
const DLC_TOP_LIMIT = 10;
const RARE_PERCENT = 5;
const UNKNOWN_YEAR_LABEL = 'год неизвестен';

/**
 * Steam's nine review-score levels (`review_score` 1..9 → the `desc` Steam
 * prints on the store page). The bucket label is the canonical English text so
 * the frontend can localize it instead of re-deriving it from a number.
 */
const REVIEW_SCORE_LABELS = {
  1: 'Overwhelmingly Negative',
  2: 'Very Negative',
  3: 'Negative',
  4: 'Mostly Negative',
  5: 'Mixed',
  6: 'Mostly Positive',
  7: 'Positive',
  8: 'Very Positive',
  9: 'Overwhelmingly Positive',
};

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

/** A successful SteamSpy document (tags/owners/ccu) for one appid. */
function spyOf(spyDocs, appid) {
  if (!spyDocs || typeof spyDocs !== 'object') return null;
  const doc = spyDocs[String(appid)];
  return doc && doc.success ? doc : null;
}

/** A successful review summary for one appid (score may still be null). */
function reviewsOf(reviewDocs, appid) {
  if (!reviewDocs || typeof reviewDocs !== 'object') return null;
  const doc = reviewDocs[String(appid)];
  return doc && doc.success ? doc : null;
}

/**
 * Wikidata links view of one appid (`franchise.readLinks`), or null when the
 * WD pass has not written `cache-games/links/<appid>.json` yet.
 */
function linksOf(linkDocs, appid) {
  if (!linkDocs || typeof linkDocs !== 'object') return null;
  const doc = linkDocs[String(appid)];
  return doc && typeof doc === 'object' ? doc : null;
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
function pushBucket(map, key, hours, secondary = false) {
  const entry = map.get(key) || { count: 0, hours: 0, secondaryCount: 0 };
  entry.count++;
  entry.hours += hours;
  // M6c contract: how many of this bucket's works exist only outside Steam.
  if (secondary) entry.secondaryCount++;
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

/**
 * M6c payload contract (integration round, 01.11.2026): every
 * `hoursBySource` object the API returns is in **hours**, never minutes.
 * `null` stays `null` — an unknown answer is not a zero. The union itself
 * keeps minutes (`steamMinutes`/`displayMinutes`) for exact arithmetic; this
 * helper is the only place where a per-source number crosses into the payload.
 */
function hoursBySourceOf(entry) {
  const source = entry && entry.hoursBySource && typeof entry.hoursBySource === 'object'
    ? entry.hoursBySource
    : {};
  const convert = (value) => (value == null ? null : round1((Number(value) || 0) / 60));
  return {
    steam: convert(source.steam),
    gog: convert(source.gog),
    epic: convert(source.epic),
  };
}

/**
 * `minHours`: -1 = every game (0-hour backlog included), 0 = only played
 * works, N≥1 = works with at least N hours. Invalid values fall back to the
 * caller's default (the route rejects them before this point).
 */
function normalizeMinHours(raw, fallback = -1) {
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < -1) return fallback;
  return value;
}

/** Does a canonical work (raw minutes) pass the hours filter? */
function hoursFilterPass(minutes, minHours) {
  if (minHours < 0) return true;
  if (minHours === 0) return minutes > 0;
  return minutes >= minHours * 60;
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

/**
 * Store artwork URL from an `appdetails` cache document (M7). Only an absolute
 * http(s) string is accepted; a missing/unavailable document has no art, and
 * the card falls back to the old CDN chain instead of inventing a URL.
 */
function headerImageOf(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const url = doc.headerImage;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
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
 *
 * `keyOf(doc)` maps a document to the identity counted in `timeline.games`;
 * the stats builder passes the canonical work key so two editions of one game
 * are not counted twice. Defaults to the appid (the M1 behaviour).
 */
function calendarFromAchievements(docs, keyOf) {
  const identityOf = typeof keyOf === 'function' ? keyOf : (doc) => doc.appid;
  const dayCounts = new Map();
  const dayAppids = new Map();
  const dayWorks = new Map();
  for (const doc of docs) {
    for (const entry of doc.achievements || []) {
      if (!entry.achieved || !entry.unlockTimestamp) continue;
      const iso = new Date(entry.unlockTimestamp * 1000).toISOString();
      const day = iso.slice(0, 10);
      dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
      const set = dayAppids.get(day) || new Set();
      if (doc.appid != null) set.add(doc.appid);
      dayAppids.set(day, set);
      const works = dayWorks.get(day) || new Set();
      works.add(identityOf(doc));
      dayWorks.set(day, works);
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
    for (const work of dayWorks.get(day.date) || []) entry.games.add(work);
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
 *
 * Edition aggregation (M5-B): the payload counts **canonical works**, not
 * appids. `input.editions` is the persisted `cache-games/editions.json`
 * document (see `editions.js`); when it is missing or does not cover the
 * library rows, the index is rebuilt here so the builder stays pure. Every
 * aggregate (gameCount, hours, Pareto, genres, years/decades, tags, scores,
 * DLC, completion, franchises) iterates works once. `gamesIndex` still has
 * every owned appid (the library table must not lose rows); each entry carries
 * `canonicalWorkKey` / `primaryAppid` / `isPrimary` / `canonicalHours` so the
 * frontend can group without re-deriving anything.
 *
 * `minHours` (M5-B): -1 = every game (including 0-hour backlog), 0 = only
 * works with >0 hours, N≥1 = works with at least N hours. The HTTP route
 * defaults to 0; the pure builder defaults to -1 so internal callers that do
 * not care about the filter keep the full payload.
 */
function buildGamesStats(input = {}) {
  const startedAt = process.hrtime.bigint();
  const library = input.library || { games: [], partial: true, game_count: null };
  const profile = input.profile || null;
  const steamId64 = input.steamId64 || (profile && profile.userKey) || library.userKey;
  const profileKey = gameCache.profileKeyOf(steamId64);
  const games = Array.isArray(library.games) ? library.games : [];
  const partial = Boolean(library.partial);
  const minHours = normalizeMinHours(input.minHours, -1);

  /* ---------------- details + filters (M2) ---------------- */
  // `details` is the `{ [appid]: details/<appid>.json }` map. With no details
  // at all the payload must stay exactly M1: every game is kept, every M2
  // bucket stays empty and `meta.pending` says why.
  const details = input.details && typeof input.details === 'object' ? input.details : {};
  // B6: appdetails of the **base** version of a regional SKU
  // (`details-base/<baseAppid>.json`). Used only as a metadata fallback
  // (name/year/genres/studios) — never for DLC lists, ownership flags or
  // completion, which belong to the owned edition.
  const detailsBase =
    input.detailsBase && typeof input.detailsBase === 'object' ? input.detailsBase : {};
  const spyDocs = input.spy && typeof input.spy === 'object' ? input.spy : {};
  const reviewDocs = input.reviews && typeof input.reviews === 'object' ? input.reviews : {};
  // M4-B: `franchise.readLinks` views keyed by appid (optional input, so the
  // builder stays pure and every M1..M4 unit test keeps working unchanged).
  const linkDocs = input.links && typeof input.links === 'object' ? input.links : {};
  const includeFree = input.includeFree !== false;
  const includeDlc = Boolean(input.includeDlc);
  const detailsCount = games.filter((game) => detailOf(details, game.appid)).length;
  const hasDetails = detailsCount > 0;

  // Filter semantics (M2): DLC/demo/software/video are not games; a DLC is
  // included only with `includeDlc=1`. Unknown type (no details yet) is kept —
  // it must never be silently dropped. `includeFree=0` removes F2P games.
  // These run BEFORE edition grouping and `minHours` (the order is part of the
  // contract: `includeFree=1&minHours=1` means "paid-or-free works with ≥1 h",
  // not "paid works + every free work with ≥1 h").
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

  /* ---------------- canonical works (M5-B editions) ---------------- */
  const editionDoc =
    input.editions &&
    (!input.editions.algorithmVersion ||
      Number(input.editions.algorithmVersion) === editions.ALGORITHM_VERSION) &&
    editions.covers(input.editions, keptGames) &&
    input.editions.canonical &&
    typeof input.editions.canonical === 'object'
      ? input.editions
      : editions.buildEditionIndex({
          games: keptGames,
          details,
          links: linkDocs,
          manual: input.editions && input.editions.manual,
          profileKey,
          libraryFingerprint: library.fingerprint,
        });
  const canonicalOf = (appid) =>
    editionDoc.canonical[String(appid)] || {
      workKey: `steam:${appid}`,
      primaryAppid: appid,
      appids: [appid],
      editionCount: 1,
      confidence: 'single',
    };

  const workMap = new Map();
  for (const game of keptGames) {
    const canon = canonicalOf(game.appid);
    let work = workMap.get(canon.workKey);
    if (!work) {
      work = {
        workKey: canon.workKey,
        canonical: canon,
        games: [],
        minutes: 0,
        minutes2w: 0,
        rtime: 0,
      };
      workMap.set(canon.workKey, work);
    }
    work.games.push(game);
    work.minutes += Number(game.playtime_forever) || 0;
    work.minutes2w += Number(game.playtime_2weeks) || 0;
    work.rtime = Math.max(work.rtime, Number(game.rtime_last_played) || 0);
  }

  const allWorks = [...workMap.values()];
  for (const work of allWorks) {
    const persistedPrimary = work.canonical.primaryAppid;
    work.games.sort((left, right) => {
      const minutes =
        (Number(right.playtime_forever) || 0) - (Number(left.playtime_forever) || 0);
      if (minutes) return minutes;
      if (left.appid === persistedPrimary) return -1;
      if (right.appid === persistedPrimary) return 1;
      return Number(left.appid) - Number(right.appid);
    });
    // Effective primary: the edition the owner actually played (the persisted
    // primary can be an edition dropped by `includeFree=0`).
    work.primary = work.games[0];
    work.hours = work.minutes / 60;
  }

  /* ---------------- M6a/M6c: same-owner secondary libraries ---------------- */
  // GOG and Epic are **libraries of the same owner**, never a second journal
  // (§14.4). The union merges their products into the Steam works by
  // `workKey` (Wikidata P2725/P6278 → P1733, then title); a game that exists
  // only outside Steam becomes a secondary-only work. Hours are reported per
  // source (`hoursBySource`) **and** as a display sum (`displayMinutes`), the
  // 01.11.2026 product decision: an owned work shows Steam + GOG + Epic hours,
  // the breakdown stays visible.
  const gogAccounts = Array.isArray(input.gogAccounts) ? input.gogAccounts : [];
  const gogSnapshots = Array.isArray(input.gogSnapshots) ? input.gogSnapshots : [];
  const epicLayer =
    input.epic && typeof input.epic === 'object' && input.epic.accountId ? input.epic : null;
  const union = buildSecondaryUnion({
    works: allWorks,
    gogSnapshots,
    epicLayer,
    links: linkDocs,
    secondaryLinks: input.secondaryLinks,
  });
  // M6d: store metadata (genres/year/vertical poster) of secondary-only works.
  // The index is read from the cache by `buildGamesStatsFromCache`; the pure
  // builder stays pure (no disk read) and only applies what it was given.
  const secondaryDetailsIndex =
    input.secondaryDetails && typeof input.secondaryDetails === 'object'
      ? input.secondaryDetails
      : {};
  enrichUnionWithDetails(union, secondaryDetailsIndex);
  const secondaryDetailTotal = union.works.filter(
    (entry) => (entry.gog && entry.gog.gogGameId) || (entry.epic && entry.epic.slug)
  ).length;
  const secondaryDetailResolved = union.works.filter((entry) => {
    if (
      !entry.secondaryDetails ||
      entry.secondaryDetails.catalogPending === true ||
      entry.secondaryDetails.needsCatalog === true
    ) {
      return false;
    }
    // Epic details are only «resolved» when the **facts** arrived (year and
    // genres), not when a file exists: a settled negative is `unavailable` in
    // the secondary-details status, never a fake 1/1 coverage. GOG keeps its
    // previous «detail exists» contract.
    if (entry.secondaryDetails.source === 'epic') {
      return (
        entry.secondaryDetails.yearHas === true &&
        entry.secondaryDetails.genresOk === true
      );
    }
    return true;
  }).length;
  // Epic works that have no store slug at all (`productmapping`, catalog and
  // the validated title probe all failed): «library-only» — title + hours, no
  // genres/year/poster. Reported honestly instead of being silently dropped.
  const secondaryDetailNoSlug = union.works.filter(
    (entry) => entry.epic && !entry.epic.slug
  ).length;
  // Legacy alias: the GOG block below and the per-appid annotations read the
  // same union object (it exposes `byAppid`/`secondaryWorks`/`summary`).
  // Annotate Steam rows with cross-store fields only when a secondary library
  // is actually connected — a Steam-only payload stays byte-identical.
  const unionActive = gogSnapshots.length > 0 || Boolean(epicLayer);
  const gogUnion = unionActive ? union : null;
  const gogConnected = input.gogConnected === true;
  // GOG-specific numbers exist only when a GOG snapshot is attached to this
  // owner: an Epic-only owner must see `gog: null`, never a zero.
  const gogHoursValue = gogSnapshots.length ? union.summary.gogHours : null;
  const gogOwnedValue = gogSnapshots.length ? union.summary.gogProducts : null;
  const gogAccountView = gogAccounts[0] || null;
  const gogSnapshotView = gogSnapshots[0] || null;
  // Auth state, not the ~1 h access-token lifetime, decides «подключите GOG
  // заново» (01.11.2026 auth-loop): a token with a working refresh token is
  // refreshed silently by the importer and must never be reported as expired.
  const gogAuthState = gogAccountView && gogAccountView.authState
    ? gogAccountView.authState
    : gogAccountView && gogAccountView.expired === true
      ? { needsReconnect: true, status: 'refresh_failed', refreshable: false }
      : null;
  const gogNeedsReconnect = Boolean(gogAuthState && gogAuthState.needsReconnect === true);
  const gogStatus = !gogConnected
    ? gogSnapshots.length
      ? 'snapshot_only'
      : 'not_connected'
    : gogNeedsReconnect
      ? 'auth_expired'
      : gogSnapshotView && gogSnapshotView.library
        ? gogCache.isFresh(gogSnapshotView.library, gogCache.libraryTtlMs())
          ? 'ok'
          : 'stale'
        : 'connected_no_import';
  const gogSource = {
    configured: gogConnected,
    connected: gogConnected,
    status: gogStatus,
    userKey: gogAccountView ? gogAccountView.userKey : null,
    key: gogAccountView ? gogAccountView.key : null,
    username: gogAccountView ? gogAccountView.username : null,
    ownerProfile: gogAccountView ? gogAccountView.ownerProfile : null,
    // Additive diagnostic block: presence booleans and dates only, never a
    // token value (the UI ignores unknown fields).
    auth: gogAuthState
      ? {
          status: gogAuthState.status || null,
          hasRefreshToken: Boolean(gogAuthState.hasRefreshToken),
          expiresAt: gogAuthState.expiresAt || null,
          expiresInMs: gogAuthState.expiresInMs == null ? null : gogAuthState.expiresInMs,
          expired: gogAuthState.expired === true,
          refreshable: gogAuthState.refreshable === true,
          needsReconnect: gogNeedsReconnect,
          refreshedAt: gogAuthState.refreshedAt || null,
          lastRefreshError: gogAuthState.lastRefreshError || null,
          lastError: gogAuthState.lastError || null,
          binding: gogAuthState.binding || null,
        }
      : null,
    binding: gogAccountView ? gogAccountView.binding || (gogAccountView.ownerProfile ? 'bound' : 'unbound') : null,
    lastImportAt:
      gogSnapshotView && gogSnapshotView.library
        ? gogSnapshotView.library.fetchedAt || null
        : null,
    libraryFetchedAt:
      gogSnapshotView && gogSnapshotView.library
        ? gogSnapshotView.library.fetchedAt || null
        : null,
    playtimeFetchedAt:
      gogSnapshotView && gogSnapshotView.playtime
        ? gogSnapshotView.playtime.fetchedAt || null
        : null,
    productCount: gogOwnedValue,
    hours: gogHoursValue,
    playtimeGames:
      gogSnapshotView && gogSnapshotView.playtime
        ? gogSnapshotView.playtime.fetchedGames == null
          ? null
          : gogSnapshotView.playtime.fetchedGames
        : null,
    budgetExceeded: Boolean(
      gogSnapshotView && gogSnapshotView.playtime && gogSnapshotView.playtime.budgetExceeded
    ),
    // A snapshot older than the TTL is still shown with its date, never as 0.
    stale:
      gogStatus === 'stale' || gogStatus === 'auth_expired' || gogStatus === 'connected_no_import',
  };

  /* ---------------- M6b/M6c: Epic same-owner secondary library ------------ */
  // The Epic read model is assembled by `epic-layer.js` (status, catalog
  // coverage, playtime). M6c joins its games into the union above: a game with
  // a Wikidata `P6278`/title match becomes part of the Steam work, the rest is
  // a secondary-only work (`epic:<catalogItemId>`). These constants only feed
  // the `sources.epic` block and the Epic summary, never a Steam journal field
  // (achievements, `lastPlayed`, completion).
  const epicSource = epicSourceBlock(epicLayer);
  const epicHoursValue =
    epicLayer && epicLayer.summary && epicLayer.summary.hours != null
      ? epicLayer.summary.hours
      : null;
  const epicOwnedValue =
    epicLayer && epicLayer.summary && epicLayer.summary.ownedCount != null
      ? epicLayer.summary.ownedCount
      : null;

  const unionByWorkKey = union.byWorkKey;
  const unionOf = (work) => (work ? unionByWorkKey.get(work.workKey) || null : null);
  const visibleWorks = [];
  const excludedWorks = [];
  for (const work of allWorks) {
    // M6c: one work = one hours number. A Steam work that was never played on
    // Steam but has GOG/Epic hours passes the filter on the display total.
    const entry = unionOf(work);
    const minutes = entry ? entry.displayMinutes : work.minutes;
    if (hoursFilterPass(minutes, minHours)) visibleWorks.push(work);
    else excludedWorks.push(work);
  }
  const visibleGames = [];
  const workByAppid = new Map();
  for (const work of visibleWorks) {
    for (const game of work.games) {
      visibleGames.push(game);
      workByAppid.set(game.appid, work);
    }
  }
  const excludedByHours = excludedWorks.length;

  /* ---------------- M6c: secondary-only works join every aggregate -------- */
  // A work that exists only in GOG/Epic is a real owned game: it must be
  // counted in `gameCount`, contribute its hours to `totalHours` and appear in
  // years/decades/genres/histogram/backlog. It is NOT given a Steam identity it
  // does not have (`primaryAppid: null`, no achievements, no `lastPlayed`).
  //
  // `minHours` semantics for a secondary-only work:
  //   - hours known and > 0 → the same filter as a Steam work;
  //   - hours known and 0    → dropped by `minHours=0` exactly like Steam;
  //   - hours **unknown** (playtime never received: budget/404/Epic gap) →
  //     never dropped, marked `hoursUnknown` + `hoursStatus`, so a failed
  //     playtime phase cannot silently erase a game from the library.
  const secondaryVisible = [];
  const secondaryExcludedByHours = [];
  for (const entry of union.secondaryOnly) {
    if (entry.hoursUnknown) {
      secondaryVisible.push(entry);
      continue;
    }
    if (hoursFilterPass(entry.secondaryMinutes, minHours)) secondaryVisible.push(entry);
    else secondaryExcludedByHours.push(entry);
  }

  /**
   * One row per work for every chart: a Steam work carries its display hours
   * (Steam + secondary of the same work), a secondary-only entry is a row of
   * its own with `games: []` so every Steam-only helper stays empty and honest.
   */
  const chartWorks = [
    ...visibleWorks.map((work) => {
      const entry = unionOf(work);
      return {
        workKey: work.workKey,
        primary: work.primary,
        games: work.games,
        minutes: entry ? entry.displayMinutes : work.minutes,
        minutes2w: work.minutes2w,
        rtime: work.rtime,
        hours: (entry ? entry.displayMinutes : work.minutes) / 60,
        union: entry,
        steamWork: work,
        secondaryOnly: false,
      };
    }),
    ...secondaryVisible.map((entry) => ({
      workKey: entry.workKey,
      primary: {
        appid: null,
        name: entry.name || null,
        img_icon_url: null,
      },
      games: [],
      minutes: entry.secondaryMinutes,
      minutes2w: 0,
      rtime: 0,
      hours: entry.secondaryMinutes / 60,
      union: entry,
      steamWork: null,
      secondaryOnly: true,
    })),
  ];

  const minutesList = visibleGames.map((game) => Number(game.playtime_forever) || 0);
  const ownedCount = games.length;
  const steamWorkCount = visibleWorks.length;
  // One canonical work per game **across the owner's stores** (M6c).
  const gameCount = chartWorks.length;
  const totalMinutes = minutesList.reduce((sum, minutes) => sum + minutes, 0);
  const rawTotalHours = totalMinutes / 60;
  // Steam journal hours (the number `hoursBySource.steam` reports) — unchanged.
  const totalHours = round1(rawTotalHours);
  // Display total: Steam + GOG + Epic of the visible works (M6c decision).
  const totalMinutesAll = chartWorks.reduce((sum, work) => sum + (Number(work.minutes) || 0), 0);
  const rawTotalHoursAll = totalMinutesAll / 60;
  const totalHoursAll = round1(rawTotalHoursAll);
  const secondaryOnlyMinutes = secondaryVisible.reduce(
    (sum, entry) => sum + (Number(entry.secondaryMinutes) || 0),
    0
  );
  const playedCount = chartWorks.filter((work) => work.minutes > 0).length;
  // A work whose hours the store never answered for is neither «played» nor
  // «backlog»: it is an honest third bucket (`hoursUnknown`), so the backlog
  // count never claims a game was not played when nobody knows.
  const hoursUnknownCount = chartWorks.filter(
    (work) => work.union && work.union.hoursUnknown
  ).length;
  const unplayedCount = chartWorks.filter(
    (work) => work.minutes === 0 && !(work.union && work.union.hoursUnknown)
  ).length;

  // Pareto: the share of hours held by the top 10% of works (by hours).
  const sortedWorkMinutes = chartWorks
    .map((work) => work.minutes)
    .sort((a, b) => b - a);
  const topCount = Math.max(1, Math.ceil(gameCount * 0.1));
  const topMinutes = sortedWorkMinutes.slice(0, topCount).reduce((sum, minutes) => sum + minutes, 0);
  const top10HoursShare = totalMinutesAll > 0 ? round3(topMinutes / totalMinutesAll) : 0;

  const medianHours = round1((median(sortedWorkMinutes) || 0) / 60);
  const meanHours = gameCount ? round2(totalHoursAll / gameCount) : 0;

  const recent2wMinutes = visibleWorks.reduce((sum, work) => sum + work.minutes2w, 0);
  const lastPlayedSeconds = visibleWorks.reduce((max, work) => Math.max(max, work.rtime), 0);

  const hoursOf = (work) => work.minutes / 60;

  /* ---------------- per-work metadata helpers ---------------- */
  /**
   * B6: the base-version document of an owned row, or null. `links` carries
   * `baseAppid` (written by the Wikidata label bridge); the document itself
   * lives in `details-base/` because the owner does not own that card.
   */
  const baseDetailOfAppid = (appid) => {
    const link = linksOf(linkDocs, appid);
    if (!link || !link.baseAppid) return null;
    const doc = detailsBase[String(link.baseAppid)];
    return doc && doc.success ? doc : null;
  };
  const baseDetailOfWork = (work) => {
    for (const game of work.games) {
      const doc = baseDetailOfAppid(game.appid);
      if (doc) return doc;
    }
    return null;
  };
  /**
   * The year of one owned row from **its own** metadata, strongest first:
   *   1. store `appdetails.releaseYear` (the edition's own date);
   *   2. Wikidata `P577` of the SKU (`links.releaseYear`, M4-B).
   * Nothing else: a base-version year is not this row's year.
   */
  const ownYearOfAppid = (appid) => {
    const detailYear = releaseYearOf(detailOf(details, appid));
    if (detailYear != null) return detailYear;
    const link = linksOf(linkDocs, appid);
    if (link) {
      const linkYear = releaseYearOf({ releaseYear: link.releaseYear });
      if (linkYear != null) return linkYear;
    }
    return null;
  };
  /**
   * B6 last resort: the year of the **base version** — a regional SKU has no
   * item of its own, its work does (`links.baseReleaseYear`, then the base
   * card's `appdetails` in `details-base/`). Used only when nothing else knows
   * the year, so a re-release never moves a work that already has a year
   * (`Grand Theft Auto III` stays 2008, not the 2001 original).
   */
  const baseYearOfAppid = (appid) => {
    const link = linksOf(linkDocs, appid);
    if (link) {
      const baseYear = releaseYearOf({ releaseYear: link.baseReleaseYear });
      if (baseYear != null) return baseYear;
    }
    return releaseYearOf(baseDetailOfAppid(appid));
  };
  const workYear = (work) => {
    let year = null;
    for (const game of work.games) {
      const value = ownYearOfAppid(game.appid);
      if (value == null) continue;
      year = year == null ? value : Math.min(year, value);
    }
    if (year != null) return year;
    for (const game of work.games) {
      const value = baseYearOfAppid(game.appid);
      if (value == null) continue;
      year = year == null ? value : Math.min(year, value);
    }
    if (year != null) return year;
    // M6c: a work that exists only outside Steam has no `appdetails`; the
    // store catalogue's own release date is the honest year (GOG
    // `getFilteredProducts.releaseDate`, Epic catalog `releaseInfo.date`).
    const entry = work.union || unionOf(work);
    return entry && entry.releaseYear != null ? entry.releaseYear : null;
  };
  /**
   * Per-appid year for `gamesIndex`. A row with no year of its own inherits
   * the work year, so the frontend's canonical recount (`min` over editions)
   * lands on exactly the same number as `years[]`.
   */
  const yearOfAppid = (appid) => {
    const own = ownYearOfAppid(appid);
    if (own != null) return own;
    const work = workByAppid.get(appid);
    return work ? workYear(work) : baseYearOfAppid(appid);
  };
  const workGenres = (work) => {
    const out = [];
    for (const game of work.games) {
      for (const name of genreNamesOf(detailOf(details, game.appid))) {
        if (!out.includes(name)) out.push(name);
      }
    }
    if (!out.length) {
      // B6: a regional SKU has no store page — the work still has genres.
      for (const name of genreNamesOf(baseDetailOfWork(work))) {
        if (!out.includes(name)) out.push(name);
      }
    }
    if (!out.length) {
      // M6c: GOG/Epic catalogue genres when the snapshot carries them. A store
      // that has no genre field contributes nothing (honest gap, no guessing
      // from tags).
      const entry = work.union || unionOf(work);
      for (const name of (entry && Array.isArray(entry.genres) ? entry.genres : [])) {
        if (!out.includes(name)) out.push(name);
      }
    }
    return out;
  };
  /** B6: canonical (base-version) name of a work, when it differs. */
  const workCanonicalName = (work) => {
    const base = baseDetailOfWork(work);
    if (base && base.name) return String(base.name);
    for (const game of work.games) {
      const link = linksOf(linkDocs, game.appid);
      if (link && link.baseName) return String(link.baseName);
    }
    return null;
  };
  const workDevelopers = (work) => {
    for (const game of work.games) {
      const doc = detailOf(details, game.appid);
      if (doc && Array.isArray(doc.developers) && doc.developers.length) return [...doc.developers];
    }
    const base = baseDetailOfWork(work);
    if (base && Array.isArray(base.developers) && base.developers.length) {
      return [...base.developers];
    }
    // M6c: a secondary-only work takes the store catalogue's developers.
    const entry = work.union || unionOf(work);
    return entry && Array.isArray(entry.developers) ? [...entry.developers] : [];
  };
  const workPublishers = (work) => {
    for (const game of work.games) {
      const doc = detailOf(details, game.appid);
      if (doc && Array.isArray(doc.publishers) && doc.publishers.length) return [...doc.publishers];
    }
    const base = baseDetailOfWork(work);
    if (base && Array.isArray(base.publishers) && base.publishers.length) {
      return [...base.publishers];
    }
    const entry = work.union || unionOf(work);
    return entry && Array.isArray(entry.publishers) ? [...entry.publishers] : [];
  };
  const workSpy = (work) => {
    for (const game of work.games) {
      const doc = spyOf(spyDocs, game.appid);
      if (doc && Array.isArray(doc.tags) && doc.tags.length) return doc;
    }
    return null;
  };
  const workReview = (work) => {
    for (const game of work.games) {
      const doc = reviewsOf(reviewDocs, game.appid);
      if (doc && doc.score != null) return doc;
    }
    return null;
  };
  const workDlc = (work) => {
    let maxCount = 0;
    const ids = new Set();
    for (const game of work.games) {
      const doc = detailOf(details, game.appid);
      if (!doc) continue;
      if (Array.isArray(doc.dlc)) {
        for (const id of doc.dlc) ids.add(Number(id));
      }
      const count = Number(doc.dlcCount);
      if (Number.isFinite(count)) maxCount = Math.max(maxCount, count);
    }
    return {
      hasDetails: work.games.some((game) => detailOf(details, game.appid)),
      // Union of edition DLC appids; a document that only has `dlcCount`
      // (no array) still contributes its count.
      count: Math.max(ids.size, maxCount),
    };
  };
  const workModeFlags = (work) => {
    const flags = {};
    for (const game of work.games) {
      const doc = detailOf(details, game.appid);
      if (!doc) continue;
      const own = modeFlagsOf(doc);
      for (const key of Object.keys(own)) if (own[key]) flags[key] = true;
    }
    return flags;
  };
  const workHasFlag = (work, predicate) =>
    work.games.some((game) => {
      const doc = detailOf(details, game.appid);
      return Boolean(doc && predicate(doc));
    });

  /* ---------------- achievements (one document per work) ---------------- */
  const visibleAppids = new Set(visibleGames.map((game) => game.appid));
  const achievementDocs = (input.achievements || []).filter(
    (doc) => doc && doc.totalCount > 0 && visibleAppids.has(doc.appid)
  );
  const achievementByAppid = new Map(achievementDocs.map((doc) => [doc.appid, doc]));
  const completionByAppid = new Map();
  for (const doc of achievementDocs) {
    completionByAppid.set(doc.appid, {
      unlocked: doc.unlockedCount,
      total: doc.totalCount,
      percent: round1((doc.unlockedCount / doc.totalCount) * 100),
    });
  }

  // One achievement document per work: the effective primary's, otherwise the
  // first edition that has stats. Two editions must not double the counters.
  const workAchievement = new Map();
  for (const work of visibleWorks) {
    let chosen = null;
    for (const game of work.games) {
      const doc = achievementByAppid.get(game.appid);
      if (doc) {
        chosen = doc;
        break;
      }
    }
    workAchievement.set(work.workKey, chosen);
    work.completion = chosen
      ? {
          unlocked: chosen.unlockedCount,
          total: chosen.totalCount,
          percent: round1((chosen.unlockedCount / chosen.totalCount) * 100),
        }
      : null;
  }

  const chosenDocs = [...workAchievement.values()].filter(Boolean);
  const percentList = chosenDocs.map((doc) => (doc.unlockedCount / doc.totalCount) * 100);
  const unlockedTotal = chosenDocs.reduce((sum, doc) => sum + doc.unlockedCount, 0);
  const achievementsTotal = chosenDocs.reduce((sum, doc) => sum + doc.totalCount, 0);

  // Rare = unlocked with a global percent below 5. Global percentages are
  // matched case-insensitively (XML apiname is lowercase, the official API
  // returns uppercase names).
  const globalByAppid = input.globals || new Map();
  let rareUnlocked = 0;
  for (const doc of chosenDocs) {
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

  const calendar = calendarFromAchievements(
    achievementDocs,
    (doc) => canonicalOf(doc.appid).workKey
  );

  /* ---------------- per-appid index (keeps every edition) ---------------- */
  const gamesIndex = {};
  for (const game of visibleGames) {
    const appid = game.appid;
    if (appid == null) continue;
    const completion = completionByAppid.get(appid) || null;
    const doc = detailOf(details, game.appid);
    const baseDoc = baseDetailOfAppid(appid);
    // B6: the same year chain `workYear` uses, so the frontend's canonical
    // recount (min year over a work's editions) matches `years[]` exactly.
    const year = yearOfAppid(appid);
    const spyDoc = spyOf(spyDocs, appid);
    const reviewDoc = reviewsOf(reviewDocs, appid);
    const linkDoc = linksOf(linkDocs, appid);
    const work = workByAppid.get(appid) || null;
    // M7 artwork: the canonical (primary) edition's `header_image` wins so two
    // editions of one work paint the same cover; an unavailable primary doc
    // falls back to this edition's own document, never to a guessed URL.
    const primaryDoc = work ? detailOf(details, work.primary.appid) : null;
    const genres = genreNamesOf(doc);
    const developers = doc && Array.isArray(doc.developers) ? [...doc.developers] : [];
    const publishers = doc && Array.isArray(doc.publishers) ? [...doc.publishers] : [];
    gamesIndex[appid] = {
      appid,
      name: game.name || null,
      // Per-edition hours stay per-edition; the canonical total is additive.
      hours: minutesToHours(game.playtime_forever),
      hours2w: game.playtime_2weeks ? minutesToHours(game.playtime_2weeks) : 0,
      rtime: Number(game.rtime_last_played) || 0,
      lastPlayed: isoOfSeconds(game.rtime_last_played),
      iconUrl: iconUrlOf(appid, game.img_icon_url),
      // M7 (additive): the store header from `appdetails`, primary edition
      // first. `null` means «details not fetched yet» — the client then walks
      // the legacy CDN chain (header.jpg → capsule → icon → initials).
      headerImage: headerImageOf(primaryDoc) || headerImageOf(doc) || null,
      // M5-B: edition identity (additive; `hours` above is still this row's).
      canonicalWorkKey: work ? work.workKey : `steam:${appid}`,
      primaryAppid: work ? work.primary.appid : appid,
      isPrimary: Boolean(work && work.primary.appid === appid),
      editionCount: work ? work.games.length : 1,
      canonicalHours: work ? round1(work.hours) : minutesToHours(game.playtime_forever),
      // M6a/M6c: cross-store identity — only when a secondary library is
      // connected. `hoursBySource` is in **hours** (payload contract), the
      // union keeps minutes internally. A Steam-only payload stays additive
      // (no empty cross-store fields).
      ...(gogUnion && gogUnion.byAppid[String(appid)]
        ? {
            sources: gogUnion.byAppid[String(appid)].sources,
            storeIds: gogUnion.byAppid[String(appid)].storeIds,
            hoursBySource: hoursBySourceOf(gogUnion.byAppid[String(appid)]),
            ownedOn: gogUnion.byAppid[String(appid)].ownedOn,
            crossStoreMatchedBy: gogUnion.byAppid[String(appid)].matchedBy,
          }
        : {}),
      // M2 (appdetails) — null/[] while details are missing, never invented.
      type: doc ? doc.type : null,
      year,
      releaseYear: year,
      genres: genres.length ? genres : genreNamesOf(baseDoc),
      developers: developers.length
        ? developers
        : baseDoc && Array.isArray(baseDoc.developers)
          ? [...baseDoc.developers]
          : [],
      publishers: publishers.length
        ? publishers
        : baseDoc && Array.isArray(baseDoc.publishers)
          ? [...baseDoc.publishers]
          : [],
      categories: categoryNamesOf(doc),
      dlcCount:
        doc && Number.isFinite(Number(doc.dlcCount)) ? Number(doc.dlcCount) : null,
      metacritic:
        doc && doc.metacritic && Number.isFinite(Number(doc.metacritic.score))
          ? Number(doc.metacritic.score)
          : null,
      isFree: doc && typeof doc.is_free === 'boolean' ? doc.is_free : null,
      earlyAccess: doc ? Boolean(doc.earlyAccess) : null,
      metadataSources: [
        ...(doc ? ['steam-store'] : []),
        ...(!doc && baseDoc ? ['steam-store:base'] : []),
        ...(spyDoc ? ['steamspy'] : []),
        ...(reviewDoc ? ['steam-reviews'] : []),
        ...(linkDoc && (linkDoc.qid || linkDoc.baseQid) ? ['wikidata'] : []),
      ],
      // M4: the five heaviest SteamSpy tags of this game (the full list stays
      // in `cache-games/spy/<appid>.json`; the index is already the biggest
      // part of the payload) + the community review grade.
      tags: spyDoc && Array.isArray(spyDoc.tags)
        ? spyDoc.tags
            .slice()
            .sort((left, right) => (Number(right.weight) || 0) - (Number(left.weight) || 0))
            .slice(0, TAG_INDEX_LIMIT)
            .map((tag) => ({ name: tag.name, weight: Number(tag.weight) || 0 }))
        : [],
      reviewScore: reviewDoc && reviewDoc.score != null ? Number(reviewDoc.score) : null,
      reviewDesc: reviewDoc && reviewDoc.desc != null ? String(reviewDoc.desc) : null,
      // M4-B (additive): the Wikidata series this game belongs to and the P577
      // year. `null` means «Wikidata has not answered yet», not «no franchise»
      // — the dedicated `/api/games/franchises` route owns coverage/grouping.
      franchise: linkDoc && linkDoc.franchiseKey
        ? {
            key: linkDoc.franchiseKey,
            label:
              (linkDoc.franchise && (linkDoc.franchise.labelEn || linkDoc.franchise.labelRu)) || null,
            labelRu: (linkDoc.franchise && linkDoc.franchise.labelRu) || null,
          }
        : null,
      releaseYearWikidata:
        linkDoc && Number.isInteger(Number(linkDoc.releaseYear)) && Number(linkDoc.releaseYear) > 0
          ? Number(linkDoc.releaseYear)
          : null,
      // B6 (additive): the base version of a regional SKU. `canonicalName` is
      // the work's own title (`Dishonored` for `Dishonored RHCP`); `name`
      // above stays the owned edition. Absent keys mean «no bridge», never
      // «unknown».
      ...(linkDoc && linkDoc.baseAppid
        ? { baseAppid: linkDoc.baseAppid, baseQid: linkDoc.baseQid || null }
        : {}),
      ...(baseDoc && baseDoc.name ? { canonicalName: String(baseDoc.name) } : {}),
      completion: completion ? completion.percent : null,
      achievements: completion,
    };
  }

  /* --------- M6c: secondary-only works in the client-side index ---------- */
  // The frontend recounts charts from `gamesIndex`; a secondary-only work has
  // no appid, so it is keyed by its own `workKey` (`gog:<id>` / `epic:<id>`)
  // with `appid: null`, `secondaryOnly: true` and the same field names. A
  // client that only knows appids skips these rows (they stay additive); a
  // client that renders the union counts exactly what the server counts.
  for (const entry of secondaryVisible) {
    const key = entry.workKey;
    if (gamesIndex[key]) continue;
    const source = entry.sources.includes('gog') ? 'gog' : 'epic';
    gamesIndex[key] = {
      appid: null,
      workKey: key,
      secondaryOnly: true,
      source,
      name: entry.name || null,
      hours: round1(entry.secondaryMinutes / 60),
      hours2w: 0,
      rtime: 0,
      lastPlayed: null,
      iconUrl: null,
      canonicalWorkKey: key,
      primaryAppid: null,
      isPrimary: true,
      editionCount: 1,
      canonicalHours: round1(entry.secondaryMinutes / 60),
      sources: [...entry.sources],
      storeIds: { ...entry.storeIds },
      hoursBySource: hoursBySourceOf(entry),
      hoursUnknown: Boolean(entry.hoursUnknown),
      hoursStatus: { ...entry.hoursStatus },
      type: 'game',
      year: entry.releaseYear == null ? null : entry.releaseYear,
      releaseYear: entry.releaseYear == null ? null : entry.releaseYear,
      genres: [...entry.genres],
      developers: [...entry.developers],
      publishers: [...entry.publishers],
      categories: [],
      dlcCount: null,
      metacritic: null,
      isFree: null,
      earlyAccess: null,
      metadataSources: [...entry.metadataSources],
      tags: [],
      reviewScore: null,
      reviewDesc: null,
      franchise: null,
      releaseYearWikidata: null,
      completion: null,
      achievements: null,
    };
  }

  const byHoursDesc = [...chartWorks].sort(
    (left, right) =>
      right.minutes - left.minutes ||
      String(left.primary.name || '').localeCompare(String(right.primary.name || ''))
  );

  const topGames = byHoursDesc.slice(0, TOP_LIMIT).map((work) => {
    const game = work.primary;
    // M6c: a work that exists only outside Steam has no appid — the card keeps
    // `appid: null` and points at its own work key instead of inventing a Steam
    // identity. `hours` is the display total of the work (Steam + GOG + Epic).
    if (work.secondaryOnly) {
      const entry = work.union;
      return {
        appid: null,
        workKey: work.workKey,
        name: entry.name || null,
        hours: round1(work.hours),
        hours2w: 0,
        lastPlayed: null,
        releaseYear: workYear(work),
        genres: workGenres(work),
        type: 'game',
        isFree: null,
        completion: null,
        cover: null,
        iconUrl: null,
        canonicalWorkKey: work.workKey,
        editionCount: 1,
        sources: [...entry.sources],
        hoursBySource: hoursBySourceOf(entry),
        hoursUnknown: Boolean(entry.hoursUnknown),
        source: entry.sources.includes('gog') ? 'gog' : 'epic',
        ...(entry.developers.length ? { developers: [...entry.developers] } : {}),
        ...(entry.publishers.length ? { publishers: [...entry.publishers] } : {}),
      };
    }
    const doc = detailOf(details, game.appid);
    const entry = {
      appid: game.appid,
      name: game.name || null,
      hours: round1(work.hours),
      hours2w: work.minutes2w ? minutesToHours(work.minutes2w) : 0,
      lastPlayed: isoOfSeconds(work.rtime),
      releaseYear: workYear(work),
      genres: workGenres(work),
      type: doc ? doc.type : null,
      isFree: doc && typeof doc.is_free === 'boolean' ? doc.is_free : null,
      completion: work.completion ? work.completion.percent : null,
      cover: null,
      iconUrl: iconUrlOf(game.appid, game.img_icon_url),
      headerImage: headerImageOf(doc),
      canonicalWorkKey: work.workKey,
      editionCount: work.games.length,
    };
    // M6c: a Steam work that is also owned on GOG/Epic shows the display total
    // (`hours`) plus the per-source breakdown.
    if (work.union && work.union.sources.length > 1) {
      entry.sources = [...work.union.sources];
      entry.hoursBySource = hoursBySourceOf(work.union);
      entry.hoursSteam = round1((Number(work.union.steamMinutes) || 0) / 60);
    }
    // B6: the work's own metadata (base version) when the owned row is a
    // regional SKU without a store page. Additive: `name` stays the edition.
    const canonicalName = workCanonicalName(work);
    if (canonicalName) entry.canonicalName = canonicalName;
    if (work.games.length > 1 || canonicalName) {
      const developers = workDevelopers(work);
      const publishers = workPublishers(work);
      if (developers.length) entry.developers = developers;
      if (publishers.length) entry.publishers = publishers;
    }
    if (work.games.length > 1) {
      entry.editions = work.games.map((edition) => ({
        appid: edition.appid,
        name: edition.name || null,
        hours: minutesToHours(edition.playtime_forever),
        isPrimary: edition.appid === game.appid,
      }));
    }
    return entry;
  });

  const recentlyPlayed = [...visibleWorks]
    .filter((work) => work.rtime > 0)
    .sort((left, right) => right.rtime - left.rtime)
    .slice(0, RECENT_LIMIT)
    .map((work) => ({
      appid: work.primary.appid,
      name: work.primary.name || null,
      hours2w: work.minutes2w ? minutesToHours(work.minutes2w) : 0,
      hoursTotal: round1(work.hours),
      lastPlayed: isoOfSeconds(work.rtime),
      iconUrl: iconUrlOf(work.primary.appid, work.primary.img_icon_url),
      headerImage: headerImageOf(detailOf(details, work.primary.appid)),
      canonicalWorkKey: work.workKey,
      editionCount: work.games.length,
      // M6c: when the same work is owned outside Steam, the strip card can say
      // so (a small «GOG» badge) and show per-source hours. Additive: a
      // Steam-only payload keeps exactly the M1 shape.
      ...(gogUnion && gogUnion.byAppid[String(work.primary.appid)]
        ? {
            sources: gogUnion.byAppid[String(work.primary.appid)].sources,
            hoursBySource: hoursBySourceOf(gogUnion.byAppid[String(work.primary.appid)]),
          }
        : {}),
    }));

  const recently2w = [...visibleWorks]
    .filter((work) => work.minutes2w > 0)
    .sort((left, right) => right.minutes2w - left.minutes2w)
    .map((work) => ({
      appid: work.primary.appid,
      name: work.primary.name || null,
      hours2w: minutesToHours(work.minutes2w),
      hoursTotal: round1(work.hours),
      lastPlayed: isoOfSeconds(work.rtime),
      iconUrl: iconUrlOf(work.primary.appid, work.primary.img_icon_url),
      headerImage: headerImageOf(detailOf(details, work.primary.appid)),
      canonicalWorkKey: work.workKey,
      editionCount: work.games.length,
    }));

  const backlogItems = [...chartWorks]
    .filter((work) => work.minutes === 0 && !(work.union && work.union.hoursUnknown))
    .sort((left, right) =>
      String(left.primary.name || '').localeCompare(String(right.primary.name || ''))
    )
    .slice(0, BACKLOG_LIMIT)
    .map((work) => {
      if (work.secondaryOnly) {
        const entry = work.union;
        return {
          appid: null,
          workKey: work.workKey,
          name: entry.name || null,
          iconUrl: null,
          year: workYear(work),
          releaseYear: workYear(work),
          genres: workGenres(work),
          canonicalWorkKey: work.workKey,
          editionCount: 1,
          sources: [...entry.sources],
          source: entry.sources.includes('gog') ? 'gog' : 'epic',
          hoursUnknown: Boolean(entry.hoursUnknown),
        };
      }
      const game = work.primary;
      const year = workYear(work);
      const entry = {
        appid: game.appid,
        name: game.name || null,
        iconUrl: iconUrlOf(game.appid, game.img_icon_url),
        year,
        releaseYear: year,
        genres: workGenres(work),
        canonicalWorkKey: work.workKey,
        editionCount: work.games.length,
      };
      const canonicalName = workCanonicalName(work);
      if (canonicalName) entry.canonicalName = canonicalName;
      return entry;
    });

  // Platform hours are in the library snapshot (playtime_*_forever). Deck hours
  // are a subset of Linux hours and are reported separately, never added.
  const platformMinutes = visibleGames.reduce(
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
  let unknownYearSecondary = 0;
  for (const work of chartWorks) {
    const year = workYear(work);
    const hours = hoursOf(work);
    if (year == null) {
      unknownYearCount++;
      unknownYearHours += hours;
      if (work.secondaryOnly) unknownYearSecondary++;
      continue;
    }
    pushBucket(yearMap, year, hours, work.secondaryOnly);
    pushBucket(decadeMap, Math.floor(year / 10) * 10, hours, work.secondaryOnly);
  }

  // M6c: a secondary-only work carries a release year from its store catalogue,
  // so the year chart is meaningful even before Steam details exist.
  const chartsHaveData = hasDetails || secondaryVisible.length > 0;
  const years = chartsHaveData
    ? [...yearMap.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([year, entry]) => ({
          year,
          count: entry.count,
          hours: round1(entry.hours),
          secondaryCount: entry.secondaryCount || 0,
        }))
    : [];
  const decades = chartsHaveData
    ? [...decadeMap.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([decade, entry]) => ({
          decade,
          count: entry.count,
          hours: round1(entry.hours),
          secondaryCount: entry.secondaryCount || 0,
        }))
    : [];
  if (chartsHaveData && unknownYearCount > 0) {
    const unknown = {
      key: 'unknown',
      label: UNKNOWN_YEAR_LABEL,
      unknown: true,
      count: unknownYearCount,
      hours: round1(unknownYearHours),
      secondaryCount: unknownYearSecondary,
    };
    years.push({ year: null, ...unknown });
    decades.push({ decade: null, ...unknown });
  }

  const realYears = years.filter((entry) => entry.year != null);

  // Genres: the wall is playtime-weighted, so `hours` (and `weight`, kept for
  // the frontend) drives the size; `count`/`share` stay available. One work
  // counts once even when two editions carry the same genre.
  const genreMap = new Map();
  for (const work of chartWorks) {
    const hours = hoursOf(work);
    for (const name of workGenres(work)) {
      const entry = genreMap.get(name) || { name, count: 0, hours: 0, secondaryCount: 0 };
      entry.count++;
      entry.hours += hours;
      if (work.secondaryOnly) entry.secondaryCount++;
      genreMap.set(name, entry);
    }
  }
  const genres = hasDetails || genreMap.size > 0
    ? [...genreMap.values()]
        .map((entry) => ({
          name: entry.name,
          count: entry.count,
          hours: round1(entry.hours),
          weight: round1(entry.hours),
          share: rawTotalHours > 0 ? round3(entry.hours / rawTotalHours) : 0,
          secondaryCount: entry.secondaryCount || 0,
        }))
        .sort(
          (left, right) =>
            right.hours - left.hours ||
            right.count - left.count ||
            left.name.localeCompare(right.name)
        )
    : [];

  /* ---------------- M4: SteamSpy tags ---------------- */
  // `count` = how many works of this library carry the tag, `hours` = their
  // playtime, `weight` = the summed SteamSpy popularity weight (the same
  // number the store tag cloud uses). Tags are metadata, not owner events:
  // one game can carry 20 of them and none of them is invented.
  const tagMap = new Map();
  let gamesWithTags = 0;
  for (const work of visibleWorks) {
    const doc = workSpy(work);
    if (!doc) continue;
    gamesWithTags++;
    const hours = hoursOf(work);
    for (const tag of doc.tags) {
      const name = tag && tag.name ? String(tag.name) : null;
      if (!name) continue;
      const entry = tagMap.get(name) || { name, count: 0, hours: 0, weight: 0 };
      entry.count++;
      entry.hours += hours;
      entry.weight += Number(tag.weight) || 0;
      tagMap.set(name, entry);
    }
  }
  const tags = gamesWithTags
    ? [...tagMap.values()]
        .map((entry) => ({
          name: entry.name,
          count: entry.count,
          hours: round1(entry.hours),
          weight: Math.round(entry.weight),
        }))
        .sort(
          (left, right) =>
            right.hours - left.hours ||
            right.count - left.count ||
            right.weight - left.weight ||
            left.name.localeCompare(right.name)
        )
        .slice(0, TAG_LIMIT)
    : [];

  /* ---------------- M4: community review scores ---------------- */
  // Steam's `review_score` is a 1..9 community grade, never a personal rating
  // (ИГРЫ §1.2). Buckets are the nine store levels; only `count`/`hours` are
  // serialized — the per-game score lives in `gamesIndex`.
  const scoreCounts = new Map();
  const scoreValues = [];
  let gamesWithReviews = 0;
  for (const work of visibleWorks) {
    const doc = workReview(work);
    if (!doc || doc.score == null) continue;
    const score = Number(doc.score);
    if (!Number.isInteger(score) || score < 1 || score > 9) continue;
    const hours = hoursOf(work);
    gamesWithReviews++;
    scoreValues.push(score);
    const entry = scoreCounts.get(score) || { score, count: 0, hours: 0 };
    entry.count++;
    entry.hours += hours;
    scoreCounts.set(score, entry);
  }
  const scores = gamesWithReviews
    ? Object.keys(REVIEW_SCORE_LABELS)
        .map(Number)
        .sort((left, right) => left - right)
        .map((score) => {
          const entry = scoreCounts.get(score) || { score, count: 0, hours: 0 };
          return {
            score,
            bucket: REVIEW_SCORE_LABELS[score],
            count: entry.count,
            hours: round1(entry.hours),
          };
        })
    : [];
  const reviewScore = gamesWithReviews
    ? {
        avg: round2(scoreValues.reduce((sum, value) => sum + value, 0) / scoreValues.length),
        median: round1(median(scoreValues)),
      }
    : null;

  /* ---------------- M4: DLC facts ---------------- */
  // `dlcCount` already lives in the details document (`dlc[]` length); the
  // widget only needs the facts, not the DLC appids. Editions share DLCs, so
  // the work's count is the union of its editions' DLC appids.
  let dlcSummary = null;
  if (hasDetails) {
    const dlcGames = [];
    let dlcTotal = 0;
    for (const work of visibleWorks) {
      const info = workDlc(work);
      if (!info.hasDetails) continue;
      dlcTotal += info.count;
      dlcGames.push({
        appid: work.primary.appid,
        name: work.primary.name || null,
        dlcCount: info.count,
      });
    }
    const withDlc = dlcGames.filter((entry) => entry.dlcCount > 0);
    dlcSummary = {
      gamesWithDlc: withDlc.length,
      dlcTotal,
      avgCount: dlcGames.length ? round2(dlcTotal / dlcGames.length) : 0,
      max: [...withDlc]
        .sort(
          (left, right) =>
            right.dlcCount - left.dlcCount || String(left.name || '').localeCompare(String(right.name || ''))
        )
        .slice(0, DLC_TOP_LIMIT),
    };
  }

  /* ---------------- M4-B: Wikidata links (franchise / P577 year) ---------------- */
  // Per-game assignment lives in `gamesIndex`; this block only counts what the
  // WD pass answered so `summary` and `meta.pending` stay honest. The grouping
  // (and the low-confidence title heuristic) belongs to `/api/games/franchises`
  // — `summary.coverage.franchises` is therefore Wikidata-only on purpose.
  let gamesWithFranchiseLinks = 0;
  let linksResolved = 0;
  for (const work of visibleWorks) {
    let answered = false;
    let franchise = false;
    for (const game of work.games) {
      const links = linksOf(linkDocs, game.appid);
      if (!links) continue;
      if (links.resolved) answered = true;
      if (links.franchiseKey) franchise = true;
    }
    if (answered) linksResolved++;
    if (franchise) gamesWithFranchiseLinks++;
  }
  const franchiseCoverage = {
    source: 'wikidata',
    includesHeuristic: false,
    gamesWithFranchise: gamesWithFranchiseLinks,
    gamesAnswered: linksResolved,
    gamesTotal: gameCount,
    percent: gameCount ? round1((gamesWithFranchiseLinks / gameCount) * 100) : 0,
  };

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
    for (const work of visibleWorks) {
      const hours = hoursOf(work);
      const flags = workModeFlags(work);
      for (const key of Object.keys(modes)) {
        if (flags[key]) modes[key]++;
      }
      if (workHasFlag(work, (doc) => doc.earlyAccess)) {
        earlyCount++;
        earlyHours += hours;
      }
      let workFree = false;
      for (const game of work.games) {
        const doc = detailOf(details, game.appid);
        if (!doc || doc.is_free !== true) continue;
        workFree = true;
        freeHours += (Number(game.playtime_forever) || 0) / 60;
      }
      if (workFree) freeCount++;
      if (workHasFlag(work, (doc) => doc.platforms && doc.platforms.windows)) platformGames.windows++;
      if (workHasFlag(work, (doc) => doc.platforms && doc.platforms.mac)) platformGames.mac++;
      if (workHasFlag(work, (doc) => doc.platforms && doc.platforms.linux)) platformGames.linux++;
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
  // `running` closes the UX loop with the auto-enrich kick: right after an
  // import the UI has no enrich job id, it only sees this flag in
  // `summary.metadata` and starts polling. It is also why metadata exists
  // before the first detail lands (detailsResolved = 0).
  const enrichRunning = input.enrichRunning === true;
  const metadata = hasDetails || enrichRunning
    ? {
        detailsResolved: detailsCount,
        detailsTotal: games.length,
        detailsPercent: games.length
          ? round1((detailsCount / games.length) * 100)
          : 0,
        detailsUnavailable,
        detailsMissing,
        lastEnrichedAt,
        running: enrichRunning,
      }
    : null;

  const keyConfigured = Boolean(config.loadSteamKey());
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  const allProfileKeys = gameCache.listProfiles().map((entry) => entry.key);

  const mergedWorks = visibleWorks.filter((work) => work.games.length > 1);
  const editionsMeta = {
    source: 'cache-games/editions.json',
    algorithmVersion: editionDoc.algorithmVersion || editions.ALGORITHM_VERSION,
    fromCache: editionDoc === input.editions,
    appids: visibleGames.length,
    works: visibleWorks.length,
    // User-facing number: how many rows the edition merge removed.
    groups: mergedWorks.length,
    gamesMerged: mergedWorks.reduce((sum, work) => sum + work.games.length, 0),
    savedCount: visibleGames.length - visibleWorks.length,
  };

  return {
    sources: {
      connected: [profileKey],
      selected: [profileKey],
      profile: {
        key: profileKey,
        source: 'steam',
        userKey: steamId64,
        personaName: (profile && profile.personaName) || null,
        label: (profile && profile.ownerLabel) || null,
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
      // M6a: per-source state. `steam` is the journal (the only source of
      // achievements and `totalHours`); `gog` is a same-owner secondary
      // library. A missing token is `not_connected`/`auth_expired`, never 0.
      steam: {
        configured: keyConfigured,
        status: partial ? 'partial' : 'ok',
        lastImportAt: library.fetchedAt || null,
        gameCount: library.game_count == null ? ownedCount : library.game_count,
      },
      gog: gogSource,
      // M6c: Epic read-model state. Same shape as `gog`, so the «Источники»
      // widget and the «Подключения» screen render both through one contract.
      epic: epicSource,
    },
    // M1 has no `type` in GetOwnedGames: ownedCount is the honest number,
    // gameCount is an estimate until appdetails (M2) separates DLC/tools.
    libraryPartial: partial,
    summary: {
      // M5-B/M6c: one canonical work per game **across stores**, not per store
      // edition. Includes works that exist only in GOG/Epic.
      gameCount,
      // Honest: with no details (or with unavailable/unknown types) the type
      // split is still an estimate; a fully enriched library flips it to false.
      gameCountEstimated: detailsCount < games.length,
      ownedCount,
      playedCount,
      unplayedCount,
      // Works whose hours no store answered for (never counted as backlog).
      hoursUnknownCount,
      backlogShare: gameCount ? round3(unplayedCount / gameCount) : 0,
      // Display total of the owner's visible works: Steam + GOG + Epic
      // (M6c product decision). `hoursBySource.steam` below stays the Steam
      // journal number, so the breakdown never disappears.
      totalHours: totalHoursAll,
      totalHoursSteam: totalHours,
      // Per-source numbers (never merged into one number by themselves):
      // `steam` is the Steam journal total, `gog`/`epic` are null when that
      // library is not connected and 0 when connected but empty. `all` is the
      // display sum above (Steam + GOG + Epic of the same works).
      hoursBySource: unionActive
        ? {
            steam: totalHours,
            gog: gogHoursValue,
            epic: epicHoursValue,
            all: totalHoursAll,
          }
        : { steam: totalHours, gog: gogHoursValue, epic: epicHoursValue },
      ownedBySource: { steam: ownedCount, gog: gogOwnedValue, epic: epicOwnedValue },
      // Union over canonical works (`workKey`): Steam + GOG + Epic, one row per
      // work. With a secondary library connected `worksTotal` is the full
      // union (filters aside); a Steam-only owner keeps the pre-M6c number
      // (`gameCount`, i.e. after type/free/minHours), so an existing profile
      // does not suddenly see 320 works instead of 210 at `minHours=0`.
      worksTotal: unionActive ? union.summary.worksTotal : gameCount,
      secondaryOnlyWorks: union.summary.secondaryOnlyWorks,
      // Epic entries that could not be joined to a Steam/GOG work: counted as
      // their own secondary works (they are real owned games).
      epicSecondaryGames: union.summary.secondaryOnlyEpic,
      secondaryWorksTotal: union.summary.secondaryOnlyWorks,
      // Hours that exist only outside Steam, and works whose hours the store
      // never answered for (`minHours` must not drop them).
      secondaryHours: round1(secondaryOnlyMinutes / 60),
      secondaryHoursUnknown: union.summary.hoursUnknownWorks,
      secondaryWorksVisible: secondaryVisible.length,
      // M6c chart contract (integration round): the year/decade/genre buckets
      // count secondary-only works. The UI reads these flags instead of
      // guessing from the bucket shape; a Steam-only payload reports `false`.
      chartsIncludeSecondary: secondaryVisible.length > 0,
      secondaryWorksInCharts: secondaryVisible.length,
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
        gamesWithStats: chosenDocs.length,
        gamesTotal: gameCount,
      },
      achievements: {
        unlocked: unlockedTotal,
        total: achievementsTotal,
        rareUnlocked,
        rareThresholdPercent: RARE_PERCENT,
        coverage: { gamesWithStats: chosenDocs.length, gamesTotal: gameCount },
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
      // M4: community review grade (null until a review summary is cached) and
      // DLC facts from the details documents.
      reviewScore,
      dlc: dlcSummary,
      metadata,
    },
    hoursHistogram: hoursHistogram(chartWorks.map((work) => work.hours)),
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
    tags,
    // M4: nine Steam review-score levels, `[]` until a summary is cached.
    scores,
    decades,
    years,
    franchises: [],
    studios: [],
    personnelTop: null,
    timeline: calendar.timeline,
    achievementDays: calendar.achievementDays,
    streaks: calendar.streaks,
    gamesIndex,
    // M6a/M6c: entries that exist only outside Steam — GOG works (union by
    // `workKey`) followed by Epic games (`workKey: null`, no identity yet).
    // The list is capped for payload size; `summary.secondaryWorksTotal` is
    // the full count. Never merged into the Steam journal aggregates.
    // Payload contract (integration round): `hoursBySource` is in **hours**,
    // the display total is `displayHours`; the union's minute fields
    // (`steamMinutes`/`secondaryMinutes`/`displayMinutes`) stay internal and
    // never leak into the API. `null` means «the store did not answer».
    secondaryWorks: secondaryVisible.slice(0, 200).map((entry) => ({
      workKey: entry.workKey,
      name: entry.name || null,
      sources: [...entry.sources],
      ownedOn: [...entry.ownedOn],
      storeIds: { ...entry.storeIds },
      hoursBySource: hoursBySourceOf(entry),
      primaryAppid: entry.primaryAppid == null ? null : entry.primaryAppid,
      gog: entry.gog ? { ...entry.gog } : null,
      epic: entry.epic ? { ...entry.epic } : null,
      matchedBy: entry.matchedBy,
      confidence: entry.confidence,
      releaseYear: entry.releaseYear == null ? null : entry.releaseYear,
      releaseYearSource: entry.releaseYearSource || null,
      releaseDate: entry.releaseDate || null,
      // M6d: vertical poster from the store product page (GOG box art,
      // Epic CMS portrait). `null` when the detail is not cached yet — the UI
      // falls back to the horizontal `gog.image`/`epic.image`.
      verticalCover: entry.verticalCover || null,
      image:
        entry.image ||
        (entry.gog && entry.gog.image) ||
        (entry.epic && entry.epic.image) ||
        null,
      genres: [...entry.genres],
      developers: [...entry.developers],
      publishers: [...entry.publishers],
      metadataSources: [...entry.metadataSources],
      hours: round1(entry.secondaryMinutes / 60),
      secondaryHours: round1(entry.secondaryMinutes / 60),
      displayHours: round1(entry.displayMinutes / 60),
      hoursUnknown: Boolean(entry.hoursUnknown),
      hoursStatus: { ...entry.hoursStatus },
      secondaryOnly: true,
      // The UI's «Вне Steam» list reads `source` for the badge.
      source: entry.sources.includes('gog') ? 'gog' : 'epic',
    })),
    gog: gogSnapshots.length ? { ...union.summary, status: gogStatus } : null,
    // M6c: the Epic read model without per-game arrays (they are already in
    // `secondaryWorks`). `null` when no Epic account is bound to this owner.
    epic: epicLayer
      ? {
          contractVersion: epicLayer.contractVersion,
          status: epicSource.status,
          accountId: epicLayer.accountId || null,
          summary: epicLayer.summary,
          // Inside this payload the Steam side must be the **journal** total
          // (`summary.hoursBySource.steam`, games only), not the raw library
          // sum the layer computes on its own (`/api/games/epic/status`).
          hoursBySource: { steam: totalHours, epic: epicHoursValue },
          ownedBySource: { steam: ownedCount, epic: epicOwnedValue },
          meta: epicLayer.meta,
        }
      : null,
    // Works of the visible (filtered) set with no successful details.
    unmatchedCount: visibleWorks.filter((work) =>
      work.games.every((game) => !detailOf(details, game.appid))
    ).length,
    meta: {
      buildMs: Number(elapsedMs.toFixed(1)),
      // M6d: how many secondary works already have store metadata cached
      // (genres/year/poster) and whether the details job is running right now.
      // `total` counts works with a store id; `resolved` those with a detail
      // document — never a percentage of an empty set.
      secondaryDetails: {
        resolved: secondaryDetailResolved,
        total: secondaryDetailTotal,
        // Epic works with no store slug: «library-only» (title + hours), the
        // store metadata job cannot address them at all.
        noSlug: secondaryDetailNoSlug,
        running:
          input.secondaryDetailsRunning === true
            ? true
            : secondaryDetailsRunning(profileKey),
      },
      libraryFingerprint: library.fingerprint || null,
      libraryFetchedAt: library.fetchedAt || null,
      libraryStale: !gameCache.isFresh(library, gameCache.libraryTtlMs()),
      libraryTtlHours: Math.round(gameCache.libraryTtlMs() / 3600000),
      achievementsCachedGames: chosenDocs.length,
      calendarAvailable: achievementDocs.length > 0,
      keyConfigured,
      keySource: keyConfigured ? config.steamKeySource() : null,
      details: metadata,
      // M5-B: canonical-work merge facts (additive, UI-safe).
      editions: editionsMeta,
      // M4 coverage: how much of the visible library has tags / a review grade.
      // `percent` is honest: 0 with no documents, never a fake 100.
      tags: {
        source: 'steamspy',
        gamesWithTags,
        gamesTotal: gameCount,
        percent: gameCount ? round1((gamesWithTags / gameCount) * 100) : 0,
      },
      reviews: {
        source: 'steam-reviews',
        gamesWithReviews,
        gamesTotal: gameCount,
        percent: gameCount ? round1((gamesWithReviews / gameCount) * 100) : 0,
      },
      // M4-B coverage of the Wikidata links pass. Wikidata-only by design: the
      // low-confidence title heuristic and the grouping live in
      // `/api/games/franchises` (`coverage.bySource`), never in this payload.
      franchises: franchiseCoverage,
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
        // M5-B: the hours filter runs after type/free filters and after the
        // edition merge (one canonical work, one decision).
        minHours: {
          requested: minHours,
          applied: true,
          excluded: excludedByHours,
          excludedAppids: excludedWorks.reduce((sum, work) => sum + work.games.length, 0),
          // M6c: secondary-only works the filter dropped. Works whose hours the
          // store never answered for are **kept** (`hoursUnknown`), never
          // counted here — a failed playtime phase must not hide a game.
          excludedSecondary: secondaryExcludedByHours.length,
          keptSecondaryUnknownHours: secondaryVisible.filter((entry) => entry.hoursUnknown).length,
        },
      },
      pending: [
        ...(hasDetails
          ? []
          : ['genres', 'years', 'decades', 'modes', 'earlyAccess', 'freeToPlay', 'platforms']),
        ...(gamesWithTags ? [] : ['tags']),
        ...(gamesWithReviews ? [] : ['reviews']),
        ...(dlcSummary ? [] : ['dlc']),
        ...(linksResolved ? [] : ['franchises']),
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
  // M4-B: Wikidata links (franchise key + P577 year) for the games index.
  const links = franchise.readLinksMap(appids);
  // B6: appdetails of the base versions the label bridge resolved (the owner
  // does not own those cards — they live in `details-base/`).
  const baseAppids = [];
  for (const link of Object.values(links)) {
    if (link && link.baseAppid && !baseAppids.includes(link.baseAppid)) {
      baseAppids.push(link.baseAppid);
    }
  }
  const detailsBase = gameCache.listDetailsBase(baseAppids);
  // M5-B: canonical edition index. Persisted in `cache-games/editions.json`
  // (manual overrides survive); a read-only cache (worktree) still works —
  // the index is then rebuilt in memory for this request.
  let editionDoc = null;
  try {
    editionDoc = editions.ensureEditions(profileKey, {
      library,
      games: Array.isArray(library.games) ? library.games : [],
      details,
      links,
    }).doc;
  } catch (err) {
    console.warn(`[games-stats] editions index not persisted: ${err.message}`);
    editionDoc = editions.buildEditionIndex({
      games: Array.isArray(library.games) ? library.games : [],
      details,
      links,
      profileKey,
      libraryFingerprint: library.fingerprint,
    });
  }
  // M6a: GOG is a same-owner secondary library. Only accounts explicitly
  // attached to THIS Steam owner are read — never another owner's token.
  // A disconnected account keeps its dated snapshot: the UI says «данные от
  // <дата>, требуется переподключение» instead of showing zeroes (§14.4 п. 7).
  const gogTokenAccounts = gogCache.accountsForOwner(profileKey);
  if (!gogTokenAccounts.length) {
    // A token written before the «one owner» rule (or restored from a backup)
    // has no `ownerProfile`; the library snapshot it wrote does. Adopting it
    // here is read-only and safe (an unbound token claims no other owner) and
    // stops the false «снимок от <дата> — подключите GOG заново» after a
    // successful import. The next import persists the binding for good.
    for (const library of gogCache.listLibraries()) {
      if (!library || library.ownerProfile !== profileKey) continue;
      const view = gogCache.publicTokenView(gogCache.getToken(library.userKey));
      if (view && !view.ownerProfile) {
        gogTokenAccounts.push({ ...view, binding: 'unbound' });
      }
    }
  }
  const gogAccounts = [...gogTokenAccounts];
  const gogSnapshots = [];
  for (const account of gogTokenAccounts) {
    const gogLibrary = gogCache.getLibrary(account.userKey);
    if (!gogLibrary) continue;
    gogSnapshots.push({
      account,
      library: gogLibrary,
      playtime: gogCache.getPlaytime(account.userKey),
    });
  }
  if (!gogTokenAccounts.length) {
    for (const gogLibrary of gogCache.listLibraries()) {
      if (!gogLibrary || gogLibrary.ownerProfile !== profileKey) continue;
      const synthetic = {
        source: 'gog',
        userKey: String(gogLibrary.userKey),
        key: gogCache.profileKeyOf(gogLibrary.userKey),
        username: (gogLibrary.account && gogLibrary.account.username) || null,
        ownerProfile: profileKey,
        connected: false,
        expired: null,
      };
      gogAccounts.push(synthetic);
      gogSnapshots.push({
        account: synthetic,
        library: gogLibrary,
        playtime: gogCache.getPlaytime(gogLibrary.userKey),
      });
    }
  }
  // M6d: store metadata of the secondary works (public GOG/Epic product pages,
  // cached 30 days). Collected from the same snapshots the union will read, so
  // the index never asks for a product that is not in the library.
  const epicLayerView = buildEpicLayerSync({ ownerKey: profileKey });
  const detailGogIds = [];
  for (const snapshot of gogSnapshots) {
    for (const product of (snapshot.library && snapshot.library.products) || []) {
      if (product && product.gogGameId) detailGogIds.push(String(product.gogGameId));
    }
  }
  const detailEpicSlugs = [];
  for (const game of (epicLayerView && epicLayerView.games) || []) {
    if (game && game.slug) detailEpicSlugs.push(game.slug);
  }
  const secondaryDetailsIndex = readDetailsIndex({
    gogIds: detailGogIds,
    epicSlugs: detailEpicSlugs,
  });
  return buildGamesStats({
    steamId64: parsed.userKey,
    profile,
    library,
    achievements,
    globals,
    details,
    // M4 metadata: global per appid, no owner dimension.
    spy: gameCache.listSpy(appids),
    reviews: gameCache.listReviews(appids),
    links,
    // B6: base-version metadata for regional SKUs (year/genres/studios/name).
    detailsBase,
    // M6a: GOG secondary library (ownership + its own hours, never summed).
    gogAccounts,
    gogSnapshots,
    gogConnected: gogTokenAccounts.length > 0,
    // M6c: the cached Wikidata bridge (`links/secondary.json`) written by the
    // import jobs. A read-only lookup — `/stats` never calls WDQS (§14.5).
    // Stale entries are still valid identity (a QID does not expire); an
    // absent file is `{}` and the union falls back to title/slug matching.
    secondaryLinks: readSecondaryLinks({ allowStale: true }),
    // M6b/M6c: Epic read model of the same owner. Built synchronously from the
    // cache (`buildEpicLayerSync`) because the stats route is synchronous and
    // polled; it reads only the redacted token summary, never a token value.
    // `null` when no Epic account is bound — `sources.epic` then reports
    // `not_connected` and `hoursBySource.epic` stays `null` (not 0).
    epic: epicLayerView,
    // M6d: cached store metadata for secondary-only works (genres/year/poster).
    secondaryDetails: secondaryDetailsIndex,
    secondaryDetailsRunning: secondaryDetailsRunning(profileKey),
    // M5-B: canonical works (one game per owner-visible title).
    editions: editionDoc,
    includeFree: options.includeFree !== false,
    includeDlc: Boolean(options.includeDlc),
    // M5-B: the route defaults to 0 (played games only); the pure builder
    // defaults to -1 (no filter) for internal callers.
    minHours: options.minHours,
    // Set by the route from the enrich job registry (no live request).
    enrichRunning: options.enrichRunning === true,
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
    // Additive: the owner-facing name from the import form (§5.4 `label`).
    label: profile.ownerLabel || null,
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
  REVIEW_SCORE_LABELS,
  TAG_LIMIT,
  TAG_INDEX_LIMIT,
  DLC_TOP_LIMIT,
  detailOf,
  spyOf,
  reviewsOf,
  linksOf,
  genreNamesOf,
  categoryNamesOf,
  modeFlagsOf,
  releaseYearOf,
  round1,
  round2,
  round3,
  minutesToHours,
  median,
  normalizeMinHours,
  hoursFilterPass,
  hoursHistogram,
  calendarFromAchievements,
  buildGamesStats,
  buildGamesStatsFromCache,
  profileSummary,
};
