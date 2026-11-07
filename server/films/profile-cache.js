'use strict';

/**
 * Read-only stats of a cached KinoPoisk profile.
 *
 * A KinoPoisk import lives in two places:
 *
 *   cache/kp/{userId}.json   the votes (persistent, survives restarts)
 *   an in-memory upload/job  the dashboard payload's working set (ephemeral)
 *
 * After a server restart the browser still knows the old `uploadId`, but the
 * server does not. The persistent cache is enough to rebuild the same payload:
 * `kp.buildDataset()` turns the votes into an upload-shaped dataset and a
 * synthetic enrich job resolves every film through the shared TMDB index
 * (exactly like `/api/compare` does). No live KinoPoisk or TMDB request is
 * made — a missing index entry simply means "unmatched".
 *
 * This is the fallback that keeps the dashboard and the Letterboxd attachment
 * working when the ephemeral upload is gone; a fresh import replaces it with
 * the real job again.
 */

const fs = require('fs');
const path = require('path');

const cache = require('../cache');
const kp = require('../kp');
const { buildStats } = require('../stats');

const KP_DIR = path.join(cache.CACHE_DIR, 'kp');
const ATTACHMENT_DIR = path.join(cache.CACHE_DIR, 'profile-lb');

// Rebuilding a couple of thousand counters is not free; keep the payload for
// as long as neither the profile file nor the attachment changes. The TTL
// bounds staleness when TMDB details/index change independently (a manual
// rematch); it matches the compare model cache.
const STATS_TTL_MS = 60 * 1000;
const statsCache = new Map();

/** Accept only a bare numeric KinoPoisk user id. */
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

/**
 * Resolve the cached TMDB match for every film of a dataset, using the same
 * index keys enrich.js uses. A stale index entry without cached details is
 * treated as unmatched, exactly like `/api/stats` does.
 */
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

/**
 * Build the `/api/stats` payload for one cached KinoPoisk profile.
 * Returns null when the profile is not cached (or is unreadable).
 */
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
  // Keep the map bounded even if many cached profiles are queried.
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
