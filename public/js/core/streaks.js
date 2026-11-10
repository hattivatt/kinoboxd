import { toNum } from '../ui.js';
import { dayIndex, dayNumber } from './date.js';

export function normalizeFilmStreaks(raw, watchDays) {
  const validDate = (value) => dayIndex(value) != null;
  if (raw && typeof raw === 'object') {
    const current = Math.max(0, toNum(raw.current));
    const best = Math.max(0, toNum(raw.best));
    const lastWatchDate = validDate(raw.lastWatchDate) ? String(raw.lastWatchDate).slice(0, 10) : null;
    const bestDates = Array.isArray(raw.bestDates)
      ? raw.bestDates.map((date) => String(date).slice(0, 10)).filter(validDate)
      : [];
    if (best > 0 || lastWatchDate) {
      return { current, best, lastWatchDate, bestDates };
    }
  }
  const dates = (Array.isArray(watchDays) ? watchDays : [])
    .map((entry) => String((entry && entry.date) || '').slice(0, 10))
    .filter(validDate)
    .sort();
  if (!dates.length) return { current: 0, best: 0, lastWatchDate: null, bestDates: [] };
  let best = 1;
  let bestFrom = dates[0];
  let bestTo = dates[0];
  let run = 1;
  let runStart = dates[0];
  for (let i = 1; i < dates.length; i++) {
    if (dayIndex(dates[i]) - dayIndex(dates[i - 1]) === 1) run++;
    else { run = 1; runStart = dates[i]; }
    if (run > best) { best = run; bestFrom = runStart; bestTo = dates[i]; }
  }
  let current = 1;
  for (let i = dates.length - 1; i > 0; i--) {
    if (dayIndex(dates[i]) - dayIndex(dates[i - 1]) === 1) current++;
    else break;
  }
  return {
    current,
    best,
    lastWatchDate: dates[dates.length - 1],
    bestDates: [bestFrom, bestTo],
  };
}

export function normalizeGameStreaks(raw, days) {
  const toCount = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  const text = (value) => (value == null ? '' : String(value).trim());
  const arr = (value) => (Array.isArray(value) ? value : []);
  const valid = (value) => dayNumber(value) != null;
  if (raw && typeof raw === 'object') {
    const current = Math.max(0, toCount(raw.current));
    const best = Math.max(0, toCount(raw.best));
    const lastRaw = raw.lastUnlockDate ?? raw.last ?? raw.lastDate;
    const lastUnlockDate = valid(lastRaw) ? text(lastRaw).slice(0, 10) : null;
    const bestDates = arr(raw.bestDates)
      .map((date) => text(date).slice(0, 10))
      .filter(valid);
    if (best > 0 || lastUnlockDate) return { current, best, lastUnlockDate, bestDates };
  }
  const dates = arr(days).map((day) => text(day && day.date).slice(0, 10)).filter(valid).sort();
  if (!dates.length) return null;
  let best = 1;
  let bestFrom = dates[0];
  let bestTo = dates[0];
  let run = 1;
  let runStart = dates[0];
  for (let index = 1; index < dates.length; index += 1) {
    if (dayNumber(dates[index]) - dayNumber(dates[index - 1]) === 1) run += 1;
    else {
      run = 1;
      runStart = dates[index];
    }
    if (run > best) {
      best = run;
      bestFrom = runStart;
      bestTo = dates[index];
    }
  }
  let current = 1;
  for (let index = dates.length - 1; index > 0; index -= 1) {
    if (dayNumber(dates[index]) - dayNumber(dates[index - 1]) === 1) current += 1;
    else break;
  }
  return { current, best, lastUnlockDate: dates[dates.length - 1], bestDates: [bestFrom, bestTo] };
}
