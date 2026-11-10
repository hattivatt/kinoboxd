/* Payload → year series for the release-year bar chart. */

import { toNum } from '../ui.js';

export function collectYearBuckets(years) {
  const counts = new Map();
  // The ancient bucket is not a year: it is collected apart so it can be
  // drawn in its own slot. More than one such entry is summed, never doubled.
  let ancient = null;
  for (const item of Array.isArray(years) ? years : []) {
    const count = Math.max(0, toNum(item && item.count));
    if (!(count > 0)) continue;
    if (item && item.ancient) {
      if (!ancient) {
        ancient = {
          count: 0,
          editionCount: 0,
          manualCount: 0,
          label: item.label || 'до 1000 г.',
          beforeYear: Math.round(toNum(item.beforeYear)) || null,
          key: item.key || 'before-1000',
          ancient: true,
        };
      }
      ancient.count += count;
      ancient.editionCount += Math.max(0, toNum(item.editionCount));
      ancient.manualCount += Math.max(0, toNum(item.manualCount));
      continue;
    }
    const year = Math.round(toNum(item && item.year));
    if (!(year > 0)) continue;
    const current = counts.get(year) || { count: 0, editionCount: 0, manualCount: 0 };
    current.count += count;
    current.editionCount += Math.max(0, toNum(item && item.editionCount));
    current.manualCount += Math.max(0, toNum(item && item.manualCount));
    counts.set(year, current);
  }
  return { counts, ancient };
}

export function fillYearRange(counts) {
  const data = [];
  if (!counts.size) return data;
  const minYear = Math.min(...counts.keys());
  const maxYear = Math.max(...counts.keys());
  for (let year = minYear; year <= maxYear; year += 1) {
    const entry = counts.get(year) || { count: 0, editionCount: 0, manualCount: 0 };
    data.push({ year, ...entry });
  }
  return data;
}
