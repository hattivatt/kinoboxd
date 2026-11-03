'use strict';

/**
 * Visible-work selection of the games payload: `minHours` on the display
 * total, the secondary-only works that join every aggregate, one
 * `chartWorks` row per work (Steam + GOG + Epic hours), and the headline
 * counters (game/played/unplayed, Pareto, median/mean, recent 2-week, last
 * played).
 *
 * S1 «распил god-функции»: split out of `context.js` so the preprocessor and
 * every builder stay under the 300-line target. Pure over the canonical works
 * and the secondary union.
 */

const { hoursFilterPass } = require('./filters');
const { round1, round2, round3, median } = require('./numeric');

function buildVisible({ union, allWorks, minHours, games }) {
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

  return {
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
  };
}

module.exports = { buildVisible };
