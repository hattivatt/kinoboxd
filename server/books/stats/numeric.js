'use strict';

/**
 * Numeric primitives of the books stats payload.
 *
 * Extracted from `books/stats.js` unchanged (S2 «распил god-функции»); R15
 * moved the implementations to `core/stats` and left this module as the books
 * policy layer. `books/stats.js` re-exports every name below — the public
 * surface is unchanged.
 *
 * Contract notes (the payload hash is byte-sensitive):
 *   - `round2` is the `finite` policy: a non-finite value is `null`, never NaN;
 *   - `mean` ignores non-finite values and returns `null` for an empty list;
 *   - `computeStreaks` names its last-date field `lastReadDate` by default.
 */

const {
  round2: roundFinite,
  mean,
  dayNumber,
  computeStreaks: coreComputeStreaks,
} = require('../../core/stats');

const round2 = (value) => roundFinite(value, 'finite');

const computeStreaks = (readDays, field) => coreComputeStreaks(readDays, field || 'lastReadDate');

/** An edition year: the physical book cannot be older than the printed codex. */
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
