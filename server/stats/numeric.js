'use strict';

/**
 * Pure numeric helpers of the films stats payload (S3 split).
 *
 * `round2`/dayNumber/computeStreaks are the same formulas the payload has
 * always used — the golden hash is byte-sensitive, so they were moved without
 * a rewrite. `releaseYear` prefers the TMDB release date and falls back to the
 * upload year.
 */

function round2(value) {
  return Math.round(value * 100) / 100;
}

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

/** UTC day number for a `YYYY-MM-DD` string (no DST, no local timezone). */
function dayNumber(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!match) return null;
  return Math.floor(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000
  );
}

/**
 * Consecutive calendar-day streaks over `watchDays` ([{ date, count }]).
 *
 * `current` is the run that ends at the most recent viewing, regardless of
 * today's date: "3 days in a row" from 23→25 Oct stays valid on the 26th.
 * The UI is responsible for the softer "last watch was N days ago" hint.
 * Dates are UTC strings; watching at 00:30 MSK is stored as the previous UTC
 * day by the KinoPoisk scraped `ratedAt` and Letterboxd diary dates alike.
 */
function computeStreaks(watchDays) {
  const dates = (Array.isArray(watchDays) ? watchDays : [])
    .map((entry) => (entry && entry.date ? String(entry.date) : ''))
    .filter((date) => dayNumber(date) != null)
    .sort();
  if (!dates.length) {
    return { current: 0, best: 0, lastWatchDate: null, bestDates: [] };
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

  return {
    current,
    best,
    lastWatchDate: dates[dates.length - 1],
    bestDates: [bestFrom, bestTo],
  };
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
