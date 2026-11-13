'use strict';

const {
  round2: roundFinite,
  mean,
  dayNumber,
  computeStreaks: coreComputeStreaks,
} = require('../../core/stats');

const round2 = (value) => roundFinite(value, 'finite');

const computeStreaks = (readDays, field) => coreComputeStreaks(readDays, field || 'lastReadDate');

function saneYear(value) {
  const year = Number(value);
  if (!Number.isFinite(year)) return null;
  return year >= 1000 && year <= 2100 ? year : null;
}

module.exports = {
  round2,
  mean,
  dayNumber,
  computeStreaks,
  saneYear,
};
