'use strict';

const { hoursFilterPass } = require('./filters');
const { round1, round2, round3, median } = require('./numeric');

function buildVisible({ union, allWorks, minHours, games }) {
  const unionByWorkKey = union.byWorkKey;
  const unionOf = (work) => (work ? unionByWorkKey.get(work.workKey) || null : null);
  const visibleWorks = [];
  const excludedWorks = [];
  for (const work of allWorks) {
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
  const gameCount = chartWorks.length;
  const totalMinutes = minutesList.reduce((sum, minutes) => sum + minutes, 0);
  const rawTotalHours = totalMinutes / 60;
  const totalHours = round1(rawTotalHours);
  const totalMinutesAll = chartWorks.reduce((sum, work) => sum + (Number(work.minutes) || 0), 0);
  const rawTotalHoursAll = totalMinutesAll / 60;
  const totalHoursAll = round1(rawTotalHoursAll);
  const secondaryOnlyMinutes = secondaryVisible.reduce(
    (sum, entry) => sum + (Number(entry.secondaryMinutes) || 0),
    0
  );
  const playedCount = chartWorks.filter((work) => work.minutes > 0).length;
  const hoursUnknownCount = chartWorks.filter(
    (work) => work.union && work.union.hoursUnknown
  ).length;
  const unplayedCount = chartWorks.filter(
    (work) => work.minutes === 0 && !(work.union && work.union.hoursUnknown)
  ).length;

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
