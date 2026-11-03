'use strict';

/**
 * Works-based payload sections: ratings, genres, decades/years, authors,
 * series, publishers, pages histogram.
 *
 * S2 «распил god-функции»: every builder is a pure read of `ctx.works` (plus
 * the author merge table for aliases) and returns exactly the sub-structure
 * the payload used to build inline. `pushWorks` is the shared accumulator —
 * it is the one place that decides what a `works[]` row looks like.
 *
 * Sorting rules are part of the contract (`localeCompare`, count desc) and
 * must not be "tidied": ICU collation decides the byte order of the payload.
 */

const { round2, mean } = require('./numeric');
const { PAGE_BUCKETS, ANCIENT_BEFORE_YEAR, ANCIENT_BUCKET_KEY } = require('./constants');

function pushWorks(map, key, payload, work) {
  if (!map.has(key)) {
    map.set(key, {
      ...payload,
      works: [],
      sum: 0,
      rated: 0,
      count: 0,
      yearSources: { first: 0, edition: 0, manual: 0 },
    });
  }
  const entry = map.get(key);
  entry.count++;
  if (work.yearSource && entry.yearSources[work.yearSource] != null) {
    entry.yearSources[work.yearSource]++;
  }
  if (work.rating10 != null) {
    entry.sum += work.rating10;
    entry.rated++;
  }
  entry.works.push({
    workId: work.workId,
    title: work.title,
    rating: work.rating10,
    year: work.year,
    yearSource: work.yearSource || null,
  });
  return entry;
}

/**
 * One profile = one rating scale. There is no per-source split on the wire:
 * `merged` IS the profile's distribution.
 */
function buildRatings(ctx) {
  const { works } = ctx;
  function distribution(list) {
    const counts = new Map();
    for (const value of list) {
      if (!Number.isFinite(value) || value < 1 || value > 10) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([score, count]) => ({ score, count }));
  }
  return {
    scale: 10,
    merged: distribution(
      [...works.values()].map((work) => work.rating10).filter((v) => v != null)
    ),
  };
}

function buildGenres(ctx) {
  const { works } = ctx;
  const genreMap = new Map();
  for (const work of works.values()) {
    for (const genre of work.genres) {
      pushWorks(genreMap, genre, { name: genre }, work);
    }
  }
  return [...genreMap.values()]
    .map((entry) => ({
      name: entry.name,
      count: entry.count,
      avgRating: entry.rated ? round2(entry.sum / entry.rated) : null,
      works: entry.works,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function buildYearBuckets(ctx) {
  const { works } = ctx;
  const decadeMap = new Map();
  const yearMap = new Map();
  const ANCIENT_LABEL = `до ${ANCIENT_BEFORE_YEAR} г.`;
  const UNKNOWN_YEAR_LABEL = 'год неизвестен';
  for (const work of works.values()) {
    if (!Number.isFinite(work.year)) {
      // No provider knows the work's first publication. The chart says so
      // instead of painting the print run's year («Эксмо, 2026») as a first
      // publication; the edition year survives on `work.editionYear`.
      pushWorks(decadeMap, 'unknown', { decade: null, label: UNKNOWN_YEAR_LABEL, unknown: true }, work);
      continue;
    }
    if (work.year < ANCIENT_BEFORE_YEAR) {
      // Ancient works (Сунь Цзы, античные авторы) get one honest bucket instead
      // of being silently dropped by the old `year > 0` filter. The bucket is
      // addressable: `key`/`beforeYear` are the drilldown contract shared with
      // the same bucket on `years[]`.
      pushWorks(decadeMap, 'ancient', {
        decade: 0,
        key: ANCIENT_BUCKET_KEY,
        beforeYear: ANCIENT_BEFORE_YEAR,
        label: ANCIENT_LABEL,
        ancient: true,
      }, work);
      continue;
    }
    const decade = Math.floor(work.year / 10) * 10;
    pushWorks(decadeMap, decade, { decade }, work);
    pushWorks(yearMap, work.year, { year: work.year }, work);
  }
  const decades = [...decadeMap.values()]
    .map((entry) => ({
      decade: entry.decade,
      ...(entry.key ? { key: entry.key } : {}),
      ...(entry.beforeYear ? { beforeYear: entry.beforeYear } : {}),
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.ancient ? { ancient: true } : {}),
      ...(entry.unknown ? { unknown: true } : {}),
      count: entry.count,
      firstCount: entry.yearSources.first,
      editionCount: entry.yearSources.edition,
      manualCount: entry.yearSources.manual,
      avgRating: entry.rated ? round2(entry.sum / entry.rated) : null,
    }))
    // Ancient first, real decades in order, «год неизвестен» last.
    .sort((a, b) => {
      if (a.unknown) return 1;
      if (b.unknown) return -1;
      return a.decade - b.decade;
    });
  // The ancient bucket is a first-class column of the year chart, not a line in
  // the note: it is painted in its own slot (never on the year axis) and opens
  // the same list as the decade bucket. Its counters are taken from the decade
  // bucket above, so the two charts and `summary.ancientBookCount` cannot drift
  // apart. Ancient works are never pushed into `yearMap`, so the bucket is not
  // a second copy of any year: `years` sum + `yearUnknownCount` = `bookCount`.
  const ancientDecade = decadeMap.get('ancient');
  const ancientYearBucket = ancientDecade
    ? {
        label: ANCIENT_LABEL,
        key: ANCIENT_BUCKET_KEY,
        beforeYear: ANCIENT_BEFORE_YEAR,
        ancient: true,
        count: ancientDecade.count,
        firstCount: ancientDecade.yearSources.first,
        editionCount: ancientDecade.yearSources.edition,
        manualCount: ancientDecade.yearSources.manual,
        avgRating: ancientDecade.rated ? round2(ancientDecade.sum / ancientDecade.rated) : null,
      }
    : null;
  const yearsList = [
    ...(ancientYearBucket ? [ancientYearBucket] : []),
    ...[...yearMap.values()]
      .map((entry) => ({
        year: entry.year,
        count: entry.count,
        firstCount: entry.yearSources.first,
        editionCount: entry.yearSources.edition,
        manualCount: entry.yearSources.manual,
        avgRating: entry.rated ? round2(entry.sum / entry.rated) : null,
      }))
      .sort((a, b) => a.year - b.year),
  ];
  return { decades, years: yearsList };
}

function buildAuthors(ctx) {
  const { works, authorMerge } = ctx;
  const authorMap = new Map();
  for (const work of works.values()) {
    for (const name of work.authors) {
      pushWorks(authorMap, name.toLowerCase(), { name }, work);
    }
  }
  return [...authorMap.values()]
    .map((entry) => {
      const aliases = authorMerge.aliases[entry.name] || [];
      return {
        name: entry.name,
        count: entry.count,
        avgRating: entry.rated ? round2(entry.sum / entry.rated) : null,
        works: entry.works,
        ...(aliases.length ? { aliases, merged: true } : {}),
      };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function buildSeries(ctx, deps) {
  const { works } = ctx;
  const { dedupeSeriesSubsets } = deps;
  const seriesMap = new Map();
  for (const work of works.values()) {
    for (const entry of work.series) {
      const key = String(entry.hcId || entry.name);
      pushWorks(seriesMap, key, { seriesId: entry.hcId || null, name: entry.name }, work);
    }
  }
  return dedupeSeriesSubsets(
    [...seriesMap.values()]
      .map((entry) => ({
        seriesId: entry.seriesId,
        name: entry.name,
        count: entry.count,
        avgRating: entry.rated ? round2(entry.sum / entry.rated) : null,
        works: entry.works,
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  );
}

function buildPublishers(ctx) {
  const { works } = ctx;
  const publisherMap = new Map();
  for (const work of works.values()) {
    if (!work.publisher) continue;
    pushWorks(publisherMap, work.publisher, { name: work.publisher }, work);
  }
  return [...publisherMap.values()]
    .map((entry) => ({
      name: entry.name,
      count: entry.count,
      avgRating: entry.rated ? round2(entry.sum / entry.rated) : null,
      works: entry.works,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function buildPagesHistogram(ctx) {
  const { works } = ctx;
  return PAGE_BUCKETS.map((bucket) => {
    const list = [...works.values()].filter(
      (work) => work.pages != null && work.pages >= bucket.min && work.pages <= bucket.max
    );
    return {
      bucket: bucket.key,
      count: list.length,
      avgRating: mean(list.map((work) => work.rating10)),
    };
  });
}

module.exports = {
  buildRatings,
  buildGenres,
  buildYearBuckets,
  buildAuthors,
  buildSeries,
  buildPublishers,
  buildPagesHistogram,
};
