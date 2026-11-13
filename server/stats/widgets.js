'use strict';

const mcu = require('../mcu');
const { round2, runtimeBucket } = require('./numeric');
const { cleanCollectionName } = require('./documents');
const { RUNTIME_BUCKET_ORDER } = require('./constants');

function buildRatings(ctx) {
  const ratings = [];
  for (let score = 1; score <= 10; score++) {
    ratings.push({ score, count: ctx.ratingCounts[score] || 0 });
  }
  ratings.push({ score: 0, count: ctx.ratingCounts[0] || 0 });
  return ratings;
}

function buildGenres(ctx) {
  return [...ctx.genreMap.values()]
    .map((g) => ({
      key: g.key,
      name: g.name.charAt(0).toUpperCase() + g.name.slice(1),
      count: g.count,
      avgRating: g.ratingCount > 0 ? round2(g.ratingSum / g.ratingCount) : null,
      films: g.films.slice().sort(),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
}

function buildDecades(ctx) {
  return [...ctx.decadeMap.entries()]
    .map(([start, count]) => ({ label: `${start}-е`, start, count }))
    .sort((a, b) => a.start - b.start);
}

function buildFranchises(ctx) {
  const franchises = [...ctx.franchiseMap.values()]
    .filter((franchise) => franchise.films.length >= 2)
    .map((franchise) => {
      const ordered = franchise.films.slice().sort((a, b) => {
        const yearA = Number.isFinite(a.year) ? a.year : Infinity;
        const yearB = Number.isFinite(b.year) ? b.year : Infinity;
        if (yearA !== yearB) return yearA - yearB;
        return String(a.title).localeCompare(String(b.title), 'ru');
      });
      return {
        collectionId: franchise.collectionId,
        name: cleanCollectionName(franchise.name)
          || `Коллекция ${franchise.collectionId}`,
        posterPath: franchise.posterPath,
        count: franchise.films.length,
        avgRating: franchise.ratingCount > 0
          ? round2(franchise.ratingSum / franchise.ratingCount)
          : null,
        films: ordered.map((film) => film.slug),
      };
    });

  if (ctx.mcuFilms.size >= 2) {
    const ordered = [...ctx.mcuFilms.values()].sort((a, b) => {
      const yearA = Number.isFinite(a.year) ? a.year : Infinity;
      const yearB = Number.isFinite(b.year) ? b.year : Infinity;
      if (yearA !== yearB) return yearA - yearB;
      return String(a.title).localeCompare(String(b.title), 'ru');
    });
    let ratingSum = 0;
    let ratingCount = 0;
    for (const film of ordered) {
      if (film.rating !== null && film.rating !== undefined) {
        ratingSum += film.rating;
        ratingCount++;
      }
    }
    franchises.push({
      collectionId: null,
      key: 'mcu',
      name: mcu.MCU_NAME,
      posterPath: null,
      count: ordered.length,
      avgRating: ratingCount > 0 ? round2(ratingSum / ratingCount) : null,
      films: ordered.map((film) => film.slug),
    });
  }

  franchises.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
  return franchises;
}

function buildRuntimeHistogram(ctx) {
  const runtimeHistogramMap = new Map();
  for (const bucket of RUNTIME_BUCKET_ORDER) {
    runtimeHistogramMap.set(bucket, { bucket, count: 0, ratingSum: 0, ratingCount: 0 });
  }
  for (const entry of Object.values(ctx.filmsIndex)) {
    if (!entry || typeof entry !== 'object') continue;
    const bucket = runtimeBucket(entry.runtime);
    const item = runtimeHistogramMap.get(bucket);
    item.count++;
    if (entry.rating != null && Number.isFinite(Number(entry.rating))) {
      item.ratingSum += Number(entry.rating);
      item.ratingCount++;
    }
  }
  return RUNTIME_BUCKET_ORDER
    .map((bucket) => runtimeHistogramMap.get(bucket))
    .filter((item) => item.count > 0)
    .map((item) => ({
      bucket: item.bucket,
      count: item.count,
      avgRating: item.ratingCount > 0 ? round2(item.ratingSum / item.ratingCount) : null,
    }));
}

function buildDecadeRatings(ctx, decades) {
  return decades.map((decade) => {
    const counts = ctx.decadeScoreMap.get(decade.start) || new Array(11).fill(0);
    const scores = [];
    for (let score = 1; score <= 10; score++) {
      scores.push({ score, count: counts[score] || 0 });
    }
    return { decadeLabel: decade.label, scores };
  });
}

function buildYears(ctx) {
  return [...ctx.yearMap.entries()]
    .map(([year, count]) => ({ year, count }))
    .sort((a, b) => a.year - b.year);
}

module.exports = {
  buildRatings,
  buildGenres,
  buildDecades,
  buildFranchises,
  buildRuntimeHistogram,
  buildDecadeRatings,
  buildYears,
};
