'use strict';

/**
 * Pure numeric helpers of the films stats payload (S3 split).
 *
 * `round2`/dayNumber/computeStreaks come from `core/stats` (R15); the payload
 * keeps the `plain` rounding and the `lastWatchDate` streak field name, both
 * pinned by `test/core-numeric.test.js`. `releaseYear` prefers the TMDB
 * release date and falls back to the upload year.
 */

const { round2, dayNumber, computeStreaks } = require('../core/stats');

function runtimeBucket(runtime) {
  const minutes = Number(runtime);
  if (!Number.isFinite(minutes) || minutes <= 0) return 'unknown';
  if (minutes < 40) return '<40';
  if (minutes < 60) return '40-59';
  if (minutes < 90) return '60-89';
  if (minutes < 120) return '90-119';
  if (minutes < 150) return '120-149';
  if (minutes < 180) return '150-179';
  if (minutes < 240) return '180-239';
  return '240+';
}

function releaseYear(releaseDate, fallbackYear) {
  if (releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) {
    return parseInt(releaseDate.slice(0, 4), 10);
  }
  return Number.isFinite(fallbackYear) ? fallbackYear : null;
}

module.exports = {
  round2,
  runtimeBucket,
  dayNumber,
  computeStreaks,
  releaseYear,
};
