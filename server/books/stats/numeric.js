'use strict';

/**
 * Numeric primitives of the books stats payload.
 *
 * Extracted from `books/stats.js` unchanged (S2 «распил god-функции»): the
 * rounding, mean, day-number and streak rules are shared by several payload
 * sections, so they live in one place instead of being copied per builder.
 * `books/stats.js` re-exports every name below — the public surface of the
 * module is unchanged.
 *
 * Contract notes (the payload hash is byte-sensitive):
 *   - `round2` is `Math.round(value * 100) / 100`, NOT `toFixed(2)`;
 *   - `mean` ignores non-finite values and returns `null` for an empty list;
 *   - `dayNumber` accepts only `YYYY-MM-DD` (a month-only event is not a day);
 *   - `computeStreaks` sorts dates as strings and counts consecutive days;
 *   - `saneYear` is the edition-year window 1000..2100.
 */

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function mean(values) {
  const list = values.filter((value) => Number.isFinite(value));
  if (list.length === 0) return null;
  return round2(list.reduce((sum, value) => sum + value, 0) / list.length);
}

function dayNumber(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!match) return null;
  return Math.floor(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000
  );
}

/** Same contract as the film calendar: `current` ends at the latest reading day. */
function computeStreaks(readDays, field) {
  const lastField = field || 'lastReadDate';
  const dates = (Array.isArray(readDays) ? readDays : [])
    .map((entry) => (entry && entry.date ? String(entry.date) : ''))
    .filter((date) => dayNumber(date) != null)
    .sort();
  if (!dates.length) {
    return { current: 0, best: 0, [lastField]: null, bestDates: [] };
  }
  let best = 1;
  let bestFrom = dates[0];
  let bestTo = dates[0];
  let run = 1;
  let runStart = dates[0];
  for (let i = 1; i < dates.length; i++) {
    if (dayNumber(dates[i]) - dayNumber(dates[i - 1]) === 1) {
      run++;
    } else {
      run = 1;
      runStart = dates[i];
    }
    if (run > best) {
      best = run;
      bestFrom = runStart;
      bestTo = dates[i];
    }
  }
  let current = 1;
  for (let i = dates.length - 1; i > 0; i--) {
    if (dayNumber(dates[i]) - dayNumber(dates[i - 1]) === 1) current++;
    else break;
  }
  return { current, best, [lastField]: dates[dates.length - 1], bestDates: [bestFrom, bestTo] };
}

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
