'use strict';

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
