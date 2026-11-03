'use strict';

/**
 * `summary` of the games payload: the headline counters, per-source hours,
 * completion/achievements, platform hours, the M2 mode/platform blocks, the
 * review grade and the DLC facts.
 *
 * S1 «распил god-функции»: the literal `buildGamesStats` used to build inline.
 * The key order is the payload contract — the golden hash is byte-sensitive.
 * Values that come from the aggregate/timeline sections (`realYears`,
 * `reviewScore`, `dlc`, `metadata`, `modes`…) arrive through `extra` so the
 * assembly line can slot this section first while the aggregates are computed
 * in their own module.
 */

const { round1, round2, round3, minutesToHours, median, isoOfSeconds } = require('./numeric');
const { RARE_PERCENT } = require('./constants');

function buildSummary(ctx, extra = {}) {
  const {
    gameCount,
    detailsCount,
    games,
    ownedCount,
    playedCount,
    unplayedCount,
    hoursUnknownCount,
    totalHoursAll,
    totalHours,
    unionActive,
    gogHoursValue,
    epicHoursValue,
    gogOwnedValue,
    epicOwnedValue,
    union,
    secondaryOnlyMinutes,
    secondaryVisible,
    meanHours,
    medianHours,
    top10HoursShare,
    topCount,
    recent2wMinutes,
    lastPlayedSeconds,
    chosenDocs,
    percentList,
    unlockedTotal,
    achievementsTotal,
    rareUnlocked,
    platformMinutes,
    totalMinutes,
  } = ctx;
  const { realYears, modes, earlyAccess, freeToPlay, platforms, reviewScore, dlcSummary, metadata } =
    extra;

  return {
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
  };
}

module.exports = { buildSummary };
