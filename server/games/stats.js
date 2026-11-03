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
const {
  readDetailsIndex,
  runningFor: secondaryDetailsRunning,
} = require('./secondary-details');
const { readSecondaryLinks } = require('./secondary-identity');
const { buildEpicLayerSync } = require('./epic-layer');
const franchise = require('./franchise');
const editions = require('./editions');

const {
  RECENT_LIMIT,
  TOP_LIMIT,
  BACKLOG_LIMIT,
  TAG_LIMIT,
  TAG_INDEX_LIMIT,
  DLC_TOP_LIMIT,
  RARE_PERCENT,
  UNKNOWN_YEAR_LABEL,
  REVIEW_SCORE_LABELS,
  MODE_TESTS,
  HISTOGRAM_BUCKETS,
} = require('./stats/constants');
const {
  round1,
  round2,
  round3,
  minutesToHours,
  hoursBySourceOf,
  median,
  isoOfSeconds,
  iconUrlOf,
  headerImageOf,
  hoursHistogram,
  pushBucket,
} = require('./stats/numeric');
const {
  detailOf,
  spyOf,
  reviewsOf,
  linksOf,
  genreNamesOf,
  categoryNamesOf,
  modeFlagsOf,
  releaseYearOf,
} = require('./stats/documents');
const { normalizeMinHours, hoursFilterPass } = require('./stats/filters');
const { buildContext } = require('./stats/context');
const { buildSummary } = require('./stats/summary');
const { buildSources } = require('./stats/sources');
const { buildDetailsCoverage, buildMeta } = require('./stats/meta');

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
  const ctx = buildContext(input);
  const {
    library,
    profile,
    steamId64,
    profileKey,
    games,
    partial,
    minHours,
    details,
    detailsBase,
    spyDocs,
    reviewDocs,
    linkDocs,
    includeFree,
    includeDlc,
    detailsCount,
    hasDetails,
    excluded,
    keptGames,
    editionDoc,
    canonicalOf,
    union,
    gogSnapshots,
    epicLayer,
    unionActive,
    gogUnion,
    gogHoursValue,
    epicHoursValue,
    gogOwnedValue,
    epicOwnedValue,
    epicSource,
    gogStatus,
    unionOf,
    visibleWorks,
    excludedWorks,
    visibleGames,
    workByAppid,
    excludedByHours,
    secondaryVisible,
    secondaryExcludedByHours,
    chartWorks,
    achievementDocs,
    completionByAppid,
    chosenDocs,
    ownedCount,
    gameCount,
    totalMinutes,
    rawTotalHours,
    totalHours,
    totalHoursAll,
    rawTotalHoursAll,
    secondaryOnlyMinutes,
    playedCount,
    unplayedCount,
    hoursUnknownCount,
    meanHours,
    medianHours,
    top10HoursShare,
    topCount,
    recent2wMinutes,
    lastPlayedSeconds,
    hoursOf,
    workMeta,
    platformMinutes,
    editionsMeta,
    allProfileKeys,
    keyConfigured,
  } = ctx;
  const {
    workYear,
    yearOfAppid,
    workGenres,
    workCanonicalName,
    workDevelopers,
    workPublishers,
    workSpy,
    workReview,
    workDlc,
    workModeFlags,
    workHasFlag,
    baseDetailOfAppid,
  } = workMeta;

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

  const detailsCoverage = buildDetailsCoverage(ctx);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  return {
    sources: buildSources(ctx),
    // M1 has no `type` in GetOwnedGames: ownedCount is the honest number,
    // gameCount is an estimate until appdetails (M2) separates DLC/tools.
    libraryPartial: partial,
    summary: buildSummary(ctx, {
      realYears,
      modes,
      earlyAccess,
      freeToPlay,
      platforms,
      reviewScore,
      dlcSummary,
      metadata: detailsCoverage,
    }),
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
    meta: buildMeta(ctx, {
      elapsedMs,
      metadata: detailsCoverage,
      gamesWithTags,
      gamesWithReviews,
      franchiseCoverage,
      dlcSummary,
      linksResolved,
      chosenDocs,
      achievementDocs,
    }),
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
