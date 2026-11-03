'use strict';

/**
 * Achievement timeline of the games payload: days (UTC) with at least one
 * unlock, the month timeline, and current/best streaks. This is "achievement
 * activity", not "days played" — the UI must say so.
 *
 * S1 «распил god-функции»: `calendarFromAchievements` moved out of
 * `games/stats.js` unchanged; `buildTimeline(ctx)` is the section builder the
 * assembly line calls. It counts one identity per work (`canonicalOf`), so two
 * editions of one game are not counted twice.
 */

/**
 * Days (UTC) with at least one achievement unlock, plus current/best streak.
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

/** The three timeline payload keys, built from the cached achievement docs. */
function buildTimeline(ctx) {
  const { achievementDocs, canonicalOf } = ctx;
  const calendar = calendarFromAchievements(
    achievementDocs,
    (doc) => canonicalOf(doc.appid).workKey
  );
  return {
    timeline: calendar.timeline,
    achievementDays: calendar.achievementDays,
    streaks: calendar.streaks,
  };
}

module.exports = { calendarFromAchievements, buildTimeline };
