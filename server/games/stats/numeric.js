'use strict';

/**
 * Numeric primitives of the games payload: rounding, hours conversion, median,
 * ISO timestamps, artwork URLs and the hours histogram.
 *
 * S1 «распил god-функции»: these helpers are games-specific. The shared
 * `round2`/`median` copies between books and games are deliberately **not**
 * merged here — that is U9's separate migration with its own behaviour test
 * (the brief: «НЕ выноси общее between books/games ещё»).
 */

const { HISTOGRAM_BUCKETS } = require('./constants');

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function minutesToHours(minutes) {
  return round1((Number(minutes) || 0) / 60);
}

/**
 * M6c payload contract (integration round, 01.11.2026): every
 * `hoursBySource` object the API returns is in **hours**, never minutes.
 * `null` stays `null` — an unknown answer is not a zero. The union itself
 * keeps minutes (`steamMinutes`/`displayMinutes`) for exact arithmetic; this
 * helper is the only place where a per-source number crosses into the payload.
 */
function hoursBySourceOf(entry) {
  const source = entry && entry.hoursBySource && typeof entry.hoursBySource === 'object'
    ? entry.hoursBySource
    : {};
  const convert = (value) => (value == null ? null : round1((Number(value) || 0) / 60));
  return {
    steam: convert(source.steam),
    gog: convert(source.gog),
    epic: convert(source.epic),
  };
}

function median(values) {
  const list = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value));
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function isoOfSeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

function iconUrlOf(appid, hash) {
  if (!appid || !hash) return null;
  return (
    `https://media.steampowered.com/steamcommunity/public/images/apps/${appid}/${hash}.jpg`
  );
}

/**
 * Store artwork URL from an `appdetails` cache document (M7). Only an absolute
 * http(s) string is accepted; a missing/unavailable document has no art, and
 * the card falls back to the old CDN chain instead of inventing a URL.
 */
function headerImageOf(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const url = doc.headerImage;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

function hoursHistogram(hoursList) {
  const counts = HISTOGRAM_BUCKETS.map((entry) => ({ bucket: entry.bucket, count: 0 }));
  for (const hours of hoursList) {
    const index = HISTOGRAM_BUCKETS.findIndex((entry) => entry.test(hours));
    if (index >= 0) counts[index].count++;
  }
  return counts;
}

/** Sum `count`/`hours` into a decade/year bucket. */
function pushBucket(map, key, hours, secondary = false) {
  const entry = map.get(key) || { count: 0, hours: 0, secondaryCount: 0 };
  entry.count++;
  entry.hours += hours;
  // M6c contract: how many of this bucket's works exist only outside Steam.
  if (secondary) entry.secondaryCount++;
  map.set(key, entry);
}

module.exports = {
  round1,
  round2,
  round3,
  minutesToHours,
  hoursBySourceOf,
  median,
  isoOfSeconds,
  iconUrlOf,
  headerImageOf,
  hoursHistogram,
  pushBucket,
};
