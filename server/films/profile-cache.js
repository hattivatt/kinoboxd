'use strict';

const fs = require('fs');
const path = require('path');

const cache = require('../cache');
const kp = require('../kp');
const { buildStats } = require('../stats');

const KP_DIR = path.join(cache.CACHE_DIR, 'kp');
const ATTACHMENT_DIR = path.join(cache.CACHE_DIR, 'profile-lb');

const STATS_TTL_MS = 60 * 1000;
const statsCache = new Map();

function normalizeUserId(value) {
  const text = String(value == null ? '' : value).trim();
  return /^\d+$/.test(text) ? text : null;
}

function profilePath(userId) {
  return path.join(KP_DIR, `${userId}.json`);
}

function fileStamp(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? `${stat.mtimeMs}:${stat.size}` : null;
  } catch {
    return null;
  }
}

function buildEphemeralJob(dataset) {
  const films = new Map();
  for (const film of dataset.films || []) {
    const kind = film.kind === 'tv' ? 'tv' : 'movie';
    const entry = cache.getIndexEntry(cache.makeKindKey(film.title, film.year, kind));
    if (entry && entry !== false) {
      const entryKind = entry.kind || kind;
      if (cache.hasDetails(entry.id, entryKind)) {
        films.set(film.slug, { tmdbId: entry.id, matched: true, kind: entryKind });
        continue;
      }
    }
    films.set(film.slug, { tmdbId: null, matched: false, kind });
  }
  return { done: true, films };
}

function buildCachedProfileStats(userId) {
  const id = normalizeUserId(userId);
  if (!id) return null;

  const profileStamp = fileStamp(profilePath(id));
  if (!profileStamp) return null;

  const attachmentStamp = fileStamp(path.join(ATTACHMENT_DIR, `${id}.json`)) || 'none';
  const cacheKey = `${id}:${profileStamp}:${attachmentStamp}`;
  const cached = statsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < STATS_TTL_MS) return cached.stats;

  const profile = kp.readKpCache(id);
  if (!profile) return null;

  const dataset = kp.buildDataset(id, profile);
  const job = buildEphemeralJob(dataset);
  const upload = {
    uploadId: `cached-${id}`,
    summary: dataset.summary,
    films: dataset.films,
    events: dataset.events,
  };
  const stats = buildStats(upload, job);
  if (!stats) return null;

  statsCache.set(cacheKey, { stats, at: Date.now() });
  if (statsCache.size > 8) {
    const oldest = statsCache.keys().next().value;
    statsCache.delete(oldest);
  }
  return stats;
}

module.exports = {
  normalizeUserId,
  buildEphemeralJob,
  buildCachedProfileStats,
};
