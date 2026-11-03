'use strict';

/**
 * Preprocessor of the `/api/games/stats` payload.
 *
 * S1 «распил god-функции»: one snapshot built once, then every payload section
 * is a pure function of it. It holds the inputs (library/profile/details/
 * secondary maps), the filtered library, the canonical works (editions), the
 * same-owner secondary union, the visible work rows (`chartWorks`), the
 * headline counters and the per-work metadata helpers. Sections receive it as
 * an explicit argument instead of closing over a 1 700-line function body.
 *
 * The returned context is the snapshot the payload is built from. Builders do
 * not mutate it, except for the pre-existing `work.completion` annotation that
 * the achievements block has always written onto a visible work row.
 */

const gameCache = require('../game-cache');
const config = require('../../config');
const editions = require('../editions');
const { round1, round2, round3, median } = require('./numeric');
const { normalizeMinHours, hoursFilterPass, applyDetailFilters } = require('./filters');
const { buildWorks } = require('./works');
const { buildSecondaryState } = require('./secondary');
const { buildWorkMeta } = require('./work-meta');
const { buildAchievements } = require('./achievements');

function buildContext(input = {}) {
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
  const { detailsCount, hasDetails, excluded, keptGames } = applyDetailFilters(games, details, {
    includeFree,
    includeDlc,
  });

  /* ---------------- canonical works (M5-B editions) ---------------- */
  const { editionDoc, canonicalOf, workMap, allWorks } = buildWorks({
    input,
    keptGames,
    details,
    links: linkDocs,
    profileKey,
    library,
  });

  /* ---------------- M6a/M6c: same-owner secondary libraries ---------------- */
  const secondary = buildSecondaryState({ input, allWorks, linkDocs });
  const {
    union,
    gogSnapshots,
    epicLayer,
    secondaryDetailsIndex,
    secondaryDetailTotal,
    secondaryDetailResolved,
    secondaryDetailPartial,
    secondaryDetailNoSlug,
    unionActive,
    gogUnion,
    gogConnected,
    gogHoursValue,
    gogOwnedValue,
    gogAccountView,
    gogSnapshotView,
    gogAuthState,
    gogNeedsReconnect,
    gogStatus,
    gogSource,
    epicSource,
    epicHoursValue,
    epicOwnedValue,
  } = secondary;

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

  const workMeta = buildWorkMeta({
    details,
    detailsBase,
    linkDocs,
    spyDocs,
    reviewDocs,
    unionOf,
    workByAppid,
  });

  const achievements = buildAchievements({
    achievements: input.achievements,
    visibleGames,
    visibleWorks,
    globals: input.globals,
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
    input,
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
    workMap,
    allWorks,
    union,
    gogSnapshots,
    epicLayer,
    secondaryDetailsIndex,
    secondaryDetailTotal,
    secondaryDetailResolved,
    secondaryDetailPartial,
    secondaryDetailNoSlug,
    unionActive,
    gogUnion,
    gogConnected,
    gogHoursValue,
    gogOwnedValue,
    gogAccountView,
    gogSnapshotView,
    gogAuthState,
    gogNeedsReconnect,
    gogStatus,
    gogSource,
    epicSource,
    epicHoursValue,
    epicOwnedValue,
    unionByWorkKey,
    unionOf,
    visibleWorks,
    excludedWorks,
    visibleGames,
    workByAppid,
    excludedByHours,
    secondaryVisible,
    secondaryExcludedByHours,
    chartWorks,
    minutesList,
    ownedCount,
    steamWorkCount,
    gameCount,
    totalMinutes,
    rawTotalHours,
    totalHours,
    totalMinutesAll,
    rawTotalHoursAll,
    totalHoursAll,
    secondaryOnlyMinutes,
    playedCount,
    hoursUnknownCount,
    unplayedCount,
    sortedWorkMinutes,
    topCount,
    topMinutes,
    top10HoursShare,
    medianHours,
    meanHours,
    recent2wMinutes,
    lastPlayedSeconds,
    hoursOf,
    workMeta,
    ...achievements,
    platformMinutes,
    editionsMeta,
    allProfileKeys: gameCache.listProfiles().map((entry) => entry.key),
    keyConfigured: Boolean(config.loadSteamKey()),
  };
}

module.exports = { buildContext };
