'use strict';

/**
 * Numeric primitives shared by every domain payload (R15).
 *
 * The domains never shared one rounding policy — the golden hash is
 * byte-sensitive — so the policy is an explicit third argument instead of a
 * silent default:
 *   - `plain`   — `Math.round(value * factor) / factor`; NaN/Infinity pass
 *                 through, `null` rounds to 0 (`*` coerces);
 *   - `finite`  — anything non-finite is `null`, and a numeric *string* counts
 *                 as non-finite (books);
 *   - `numeric` — `Number(value)` is applied first, so `null` rounds to 0 and
 *                 `undefined` stays NaN (games personnel).
 *
 * `mean` is the books average (finite values only, `null` for an empty list);
 * `dayNumber` accepts only `YYYY-MM-DD` — a month-only event is not a day;
 * `computeStreaks` sorts dates as strings and counts consecutive UTC days,
 * with the last-date field name chosen by the domain (`lastWatchDate` for the
 * film calendar, `lastReadDate` for the reading calendar).
 */

function round(value, digits, mode) {
  const factor = 10 ** digits;
  if (mode === 'numeric') return Math.round(Number(value) * factor) / factor;
  if (mode === 'finite') {
    return Number.isFinite(value) ? Math.round(value * factor) / factor : null;
  }
  return Math.round(value * factor) / factor;
}

function round1(value, mode = 'plain') {
  return round(value, 1, mode);
}

function round2(value, mode = 'plain') {
  return round(value, 2, mode);
}

function round3(value, mode = 'plain') {
  return round(value, 3, mode);
}

function round4(value, mode = 'plain') {
  return round(value, 4, mode);
}

function mean(values) {
  const list = values.filter((value) => Number.isFinite(value));
  if (list.length === 0) return null;
  return round2(list.reduce((sum, value) => sum + value, 0) / list.length, 'finite');
}

function dayNumber(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!match) return null;
  return Math.floor(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000
  );
}

/**
 * `current` is the run that ends at the most recent entry, regardless of
 * today's date: "3 days in a row" from 23→25 Oct stays valid on the 26th.
 * The UI is responsible for the softer "last watch was N days ago" hint.
 * Dates are UTC strings; watching at 00:30 MSK is stored as the previous UTC
 * day by the KinoPoisk scraped `ratedAt` and Letterboxd diary dates alike.
 */
function computeStreaks(days, lastDateField) {
  const field = lastDateField || 'lastWatchDate';
  const dates = (Array.isArray(days) ? days : [])
    .map((entry) => (entry && entry.date ? String(entry.date) : ''))
    .filter((date) => dayNumber(date) != null)
    .sort();
  if (!dates.length) {
    return { current: 0, best: 0, [field]: null, bestDates: [] };
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

  return { current, best, [field]: dates[dates.length - 1], bestDates: [bestFrom, bestTo] };
}

module.exports = {
  round,
  round1,
  round2,
  round3,
  round4,
  mean,
  dayNumber,
  computeStreaks,
};
