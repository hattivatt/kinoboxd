'use strict';

/**
 * Profile comparison backend.
 *
 * Two KinoPoisk profiles are compared from their persistent caches
 * (cache/kp/{userId}.json) plus the shared TMDB details/credits cache and the
 * optional Letterboxd attachment. No live KinoPoisk requests are made, so the
 * endpoint keeps working after a server restart.
 *
 * The heavy lifting (rating histogram, genres, persons, runtime, real watch
 * dates from an attachment) is exactly the same code path as /api/stats:
 * kp.buildDataset() turns the cached profile into an upload-shaped dataset,
 * an ephemeral enrich job resolves the TMDB ids from the cache index, and
 * stats.buildStats() computes the counters. stats.buildStats() accepts the
 * injected job so nothing is registered in the live enrich job registry and
 * the regular /api/stats flow is untouched.
 */

const fs = require('fs');
const path = require('path');

const cache = require('./cache');
const kp = require('./kp');
const { HttpError } = require('./upload');
const { buildStats } = require('./stats');

const KP_DIR = path.join(cache.CACHE_DIR, 'kp');
const ATTACHMENT_DIR = path.join(cache.CACHE_DIR, 'profile-lb');

// A compare request rebuilds a couple of thousand counters per side. Cache the
// derived model for as long as the profile file does not change; the cache is
// small (one entry per profile) and is invalidated by mtime/size. A short TTL
// bounds staleness if TMDB details/index change without a profile re-import
// (e.g. a manual rematch on the active dashboard).
const MODEL_TTL_MS = 60 * 1000;
const modelCache = new Map();

function normalizeUserId(value) {
  const text = String(value == null ? '' : value).trim();
  return /^\d+$/.test(text) ? text : null;
}

function profilePath(userId) {
  return path.join(KP_DIR, `${userId}.json`);
}

function profileFileStat(userId) {
  try {
    const stat = fs.statSync(profilePath(userId));
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function hasAttachment(userId) {
  try {
    return fs.statSync(path.join(ATTACHMENT_DIR, `${userId}.json`)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the cached TMDB match for every film of a dataset, using the same
 * index keys enrich.js uses. Details are required too: a stale index entry
 * without cached details is treated as unmatched exactly like /api/stats does
 * (cache.getDetails() returns null there).
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

function round2(value) {
  return Math.round(value * 100) / 100;
}

function averageRating(films) {
  let sum = 0;
  let count = 0;
  for (const film of films || []) {
    if (film && Number.isFinite(film.rating)) {
      sum += Number(film.rating);
      count++;
    }
  }
  return count > 0 ? round2(sum / count) : null;
}

/**
 * Build the per-profile compare model:
 *   { summary, tmdbIds, genres: Map(name -> count), actors, directors,
 *     ratings: Map(score -> count) }
 */
function buildModel(userId) {
  const stat = profileFileStat(userId);
  if (!stat) return null;

  const cacheKey = `${userId}:${stat.mtimeMs}:${stat.size}`;
  const cached = modelCache.get(cacheKey);
  if (cached && Date.now() - cached.at < MODEL_TTL_MS) return cached.model;

  const profile = kp.readKpCache(userId);
  if (!profile) return null;

  const dataset = kp.buildDataset(userId, profile);
  const job = buildEphemeralJob(dataset);
  const upload = {
    uploadId: `compare-${userId}`,
    summary: dataset.summary,
    films: dataset.films,
    events: dataset.events,
  };
  const stats = buildStats(upload, job);

  const tmdbIds = new Set();
  for (const film of dataset.films) {
    const entry = job.films.get(film.slug);
    if (entry && entry.tmdbId != null) tmdbIds.add(Number(entry.tmdbId));
  }

  const genreCounts = new Map();
  for (const genre of stats.genres || []) {
    if (!genre || !genre.name) continue;
    genreCounts.set(genre.name, Number(genre.count) || 0);
  }

  const actorCounts = new Map();
  for (const person of stats.persons.actor || []) {
    if (!person || !person.name) continue;
    const counted = Number(person.counted) || 0;
    if (counted <= 0) continue;
    actorCounts.set(person.name, counted);
  }

  const directorCounts = new Map();
  for (const person of stats.persons.director || []) {
    if (!person || !person.name) continue;
    const counted = Number(person.counted) || 0;
    if (counted <= 0) continue;
    directorCounts.set(person.name, counted);
  }

  const ratingCounts = new Map();
  for (const bucket of stats.ratings || []) {
    const score = Number(bucket && bucket.score);
    if (Number.isInteger(score) && score >= 1 && score <= 10) {
      ratingCounts.set(score, Number(bucket.count) || 0);
    }
  }

  const model = {
    kpUserId: String(userId),
    nick: dataset.summary.source.kpNick || null,
    summary: stats.summary,
    films: dataset.films,
    tmdbIds,
    genreCounts,
    actorCounts,
    directorCounts,
    ratingCounts,
  };

  modelCache.set(cacheKey, { model, at: Date.now() });
  // Keep the map bounded even if profiles are re-imported repeatedly.
  if (modelCache.size > 12) {
    const oldest = modelCache.keys().next().value;
    modelCache.delete(oldest);
  }
  return model;
}

function compareSide(userId, model) {
  const filmCount = model.summary.filmCount;
  const viewCount = Number.isFinite(model.summary.viewCount)
    ? model.summary.viewCount
    : filmCount;
  const rewatchCount = Math.max(0, Number(model.summary.rewatchCount) || 0);
  return {
    kpUserId: String(userId),
    nick: model.nick,
    filmCount,
    // Total viewings, rewatches included. Without an attachment this is the
    // one-viewing-per-film KinoPoisk rating-date proxy and equals filmCount.
    viewCount,
    rewatchCount,
    hasAttachment: Boolean(model.summary.attachedLb),
    ratedCount: model.summary.ratedCount,
    avgRating: averageRating(model.films),
    totalMinutes: model.summary.totalMinutes,
    dateFrom: model.summary.dateFrom || null,
    dateTo: model.summary.dateTo || null,
  };
}

function mergeCounts(countA, countB, limit) {
  const names = new Set([...countA.keys(), ...countB.keys()]);
  const rows = [];
  for (const name of names) {
    const a = countA.get(name) || 0;
    const b = countB.get(name) || 0;
    rows.push({ name, countA: a, countB: b, delta: a - b });
  }
  rows.sort(
    (left, right) =>
      right.countA + right.countB - (left.countA + left.countB) ||
      left.name.localeCompare(right.name, 'ru')
  );
  return rows.slice(0, limit);
}

/**
 * List every cached KinoPoisk profile. `entries` is the number of cached votes
 * (one per distinct kpId), `ratedCount` the number of them with a 1..10 rating.
 */
function listProfiles() {
  let files = [];
  try {
    files = fs.readdirSync(KP_DIR);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return [];
  }

  const profiles = [];
  for (const file of files) {
    const match = /^(\d+)\.json$/.exec(file);
    if (!match) continue;
    const userId = match[1];
    let data;
    try {
      data = kp.readKpCache(userId);
    } catch {
      data = null;
    }
    if (!data || !Array.isArray(data.entries)) continue;

    const seen = new Set();
    let ratedCount = 0;
    for (const entry of data.entries) {
      if (!entry || entry.kpId == null) continue;
      const kpId = Number(entry.kpId);
      if (!Number.isFinite(kpId) || seen.has(kpId)) continue;
      seen.add(kpId);
      if (
        Number.isFinite(entry.rating) &&
        entry.rating >= 1 &&
        entry.rating <= 10
      ) {
        ratedCount++;
      }
    }

    profiles.push({
      kpUserId: userId,
      nick: data.kpNick || null,
      entries: seen.size,
      attachedLb: hasAttachment(userId),
      ratedCount,
    });
  }

  profiles.sort(
    (left, right) =>
      right.entries - left.entries ||
      String(left.kpUserId).localeCompare(String(right.kpUserId))
  );
  return profiles;
}

/**
 * Build the comparison payload for two cached profiles.
 * Throws HttpError(400) for a missing/same pair and HttpError(404) for ids
 * that have no usable cached profile.
 */
function compareProfiles(rawA, rawB) {
  const a = normalizeUserId(rawA);
  const b = normalizeUserId(rawB);
  if (!a || !b) {
    throw new HttpError(
      400,
      'Query parameters "a" and "b" must be KinoPoisk user ids.',
      'compare_ids_required'
    );
  }
  if (a === b) {
    throw new HttpError(
      400,
      'Choose two different KinoPoisk profiles to compare.',
      'compare_same_profile'
    );
  }

  const modelA = buildModel(a);
  const modelB = buildModel(b);
  if (!modelA) {
    throw new HttpError(
      404,
      `No cached KinoPoisk profile for user ${a}. Import it first.`,
      'compare_profile_not_found'
    );
  }
  if (!modelB) {
    throw new HttpError(
      404,
      `No cached KinoPoisk profile for user ${b}. Import it first.`,
      'compare_profile_not_found'
    );
  }

  let intersection = 0;
  for (const id of modelA.tmdbIds) {
    if (modelB.tmdbIds.has(id)) intersection++;
  }
  const uniqueA = Math.max(0, modelA.summary.filmCount - intersection);
  const uniqueB = Math.max(0, modelB.summary.filmCount - intersection);

  const ratings = [];
  for (let score = 1; score <= 10; score++) {
    const countA = modelA.ratingCounts.get(score) || 0;
    const countB = modelB.ratingCounts.get(score) || 0;
    ratings.push({ score, countA, countB });
  }

  return {
    a: compareSide(a, modelA),
    b: compareSide(b, modelB),
    intersection,
    uniqueA,
    uniqueB,
    genres: mergeCounts(modelA.genreCounts, modelB.genreCounts, 12),
    actors: mergeCounts(modelA.actorCounts, modelB.actorCounts, 10),
    directors: mergeCounts(modelA.directorCounts, modelB.directorCounts, 10),
    ratings,
  };
}

module.exports = {
  listProfiles,
  compareProfiles,
  // exported for tests / diagnostics
  buildModel,
};
