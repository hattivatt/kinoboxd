'use strict';

const { round1, round2, round3 } = require('../../core/stats');
const { HISTOGRAM_BUCKETS } = require('./constants');

function minutesToHours(minutes) {
  return round1((Number(minutes) || 0) / 60);
}

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

function headerImageOf(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const url = doc.headerImage;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

const STEAM_ART_PATH = '/api/games/steam-art';

function verticalCapsuleUrlOf(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (doc.kind === 'sgdb') {
    return typeof doc.url === 'string' && /^https:\/\//i.test(doc.url) ? doc.url : null;
  }
  const appid = Number(doc.appid);
  if (!Number.isSafeInteger(appid) || appid <= 0) return null;
  if (doc.kind === 'library-legacy') return `${STEAM_ART_PATH}/library/${appid}`;
  if (doc.kind === 'library-hashed') {
    const hash = typeof doc.h === 'string' ? doc.h : '';
    if (!/^[A-Za-z0-9]{1,64}$/.test(hash)) return null;
    const type = doc.proxyType === 'library_capsule' ? 'library_capsule' : 'library';
    return `${STEAM_ART_PATH}/${type}/${appid}?h=${hash}`;
  }
  return null;
}

function artFieldsOf(doc) {
  if (!doc || typeof doc !== 'object' || !doc.kind) return {};
  const verticalCapsule = verticalCapsuleUrlOf(doc);
  return {
    verticalCapsule,
    verticalCapsuleKnown: Boolean(verticalCapsule),
    iconFallbackUrl:
      typeof doc.smallIconFallback === 'string' && doc.smallIconFallback
        ? doc.smallIconFallback
        : null,
  };
}

function hoursHistogram(hoursList) {
  const counts = HISTOGRAM_BUCKETS.map((entry) => ({ bucket: entry.bucket, count: 0 }));
  for (const hours of hoursList) {
    const index = HISTOGRAM_BUCKETS.findIndex((entry) => entry.test(hours));
    if (index >= 0) counts[index].count++;
  }
  return counts;
}

function pushBucket(map, key, hours, secondary = false) {
  const entry = map.get(key) || { count: 0, hours: 0, secondaryCount: 0 };
  entry.count++;
  entry.hours += hours;
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
  verticalCapsuleUrlOf,
  artFieldsOf,
  hoursHistogram,
  pushBucket,
};
