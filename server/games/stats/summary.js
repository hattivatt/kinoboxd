'use strict';

const { round1, round3, minutesToHours, median, isoOfSeconds } = require('./numeric');
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
    gameCount,
    gameCountEstimated: detailsCount < games.length,
    ownedCount,
    playedCount,
    unplayedCount,
    hoursUnknownCount,
    backlogShare: gameCount ? round3(unplayedCount / gameCount) : 0,
    totalHours: totalHoursAll,
    totalHoursSteam: totalHours,
    hoursBySource: unionActive
      ? {
          steam: totalHours,
          gog: gogHoursValue,
          epic: epicHoursValue,
          all: totalHoursAll,
        }
      : { steam: totalHours, gog: gogHoursValue, epic: epicHoursValue },
    ownedBySource: { steam: ownedCount, gog: gogOwnedValue, epic: epicOwnedValue },
    worksTotal: unionActive ? union.summary.worksTotal : gameCount,
    secondaryOnlyWorks: union.summary.secondaryOnlyWorks,
    epicSecondaryGames: union.summary.secondaryOnlyEpic,
    secondaryWorksTotal: union.summary.secondaryOnlyWorks,
    secondaryHours: round1(secondaryOnlyMinutes / 60),
    secondaryHoursUnknown: union.summary.hoursUnknownWorks,
    secondaryWorksVisible: secondaryVisible.length,
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
    modes,
    earlyAccess,
    freeToPlay,
    platforms,
    reviewScore,
    dlc: dlcSummary,
    metadata,
  };
}

module.exports = { buildSummary };
