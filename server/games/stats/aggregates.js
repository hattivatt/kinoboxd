'use strict';

/**
 * Aggregate sections of the games payload: `years`/`decades`, the
 * playtime-weighted `genres` wall, SteamSpy `tags`, community `scores`,
 * DLC facts, Wikidata franchise coverage, the M2 mode/early-access/F2P/
 * platform blocks.
 *
 * S1 «распил god-функции»: pure over `chartWorks`/`visibleWorks` and the
 * per-work metadata helpers. Every bucket counts a canonical work once;
 * secondary-only works join the same buckets (M6c).
 */

const { UNKNOWN_YEAR_LABEL, TAG_LIMIT, REVIEW_SCORE_LABELS } = require('./constants');
const {
  round1,
  round2,
  round3,
  median,
  pushBucket,
} = require('./numeric');

function buildAggregates(ctx) {
  const {
    chartWorks,
    visibleWorks,
    hasDetails,
    secondaryVisible,
    rawTotalHours,
    gameCount,
    details,
    linkDocs,
    platformMinutes,
    totalMinutes,
    hoursOf,
  } = ctx;
  const {
    workYear,
    workGenres,
    workSpy,
    workReview,
    workDlc,
    workModeFlags,
    workHasFlag,
  } = ctx.workMeta;

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


  return {
    years,
    decades,
    realYears,
    genres,
    tags,
    scores,
    reviewScore,
    gamesWithTags,
    gamesWithReviews,
  };
}

module.exports = { buildAggregates };
