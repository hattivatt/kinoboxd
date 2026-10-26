'use strict';

/*
 * Re-evaluate every automatic TMDB match in cache/index.json.
 *
 * Usage:
 *   node server/rematch.js                 # full run
 *   npm run rematch                        # same
 *   kinoboxd-backfill rematch              # NixOS wrapper
 *   REMATCH_DRY_RUN=1 node server/rematch.js
 *   REMATCH_CONCURRENCY=8 node server/rematch.js
 *
 * Rules:
 *  - manual matches are values like { id, kind } and are NEVER touched;
 *  - integer values are automatic matches and are re-searched;
 *  - false values (known misses) are retried;
 *  - a changed result updates the index atomically; details are fetched for
 *    the new id when they are not in the cache yet;
 *  - transport errors keep the existing value (nothing is written), so a
 *    flaky network never turns a good match into false.
 *
 * The key itself (`normalized title|year`, optionally prefixed with `tv|`)
 * is the only source of the title/year. A lookup into the cached KinoPoisk
 * profiles supplies the localized title and the real media kind, which is
 * important for romanized titles (`Hilreo` -> `Хилер`) and TV entries stored
 * under an unscoped legacy key.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const cache = require('./cache');
const tmdb = require('./tmdb');

const CONCURRENCY = Math.max(
  1,
  Math.min(16, Number(process.env.REMATCH_CONCURRENCY) || 8)
);
const DRY_RUN = process.env.REMATCH_DRY_RUN === '1';
const LOG_EVERY = 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isCyrillic(value) {
  return /[\u0400-\u04FF]/.test(String(value || ''));
}

function parseIndexKey(key) {
  let scope = 'movie';
  let rest = key;
  if (key.startsWith('tv|')) {
    scope = 'tv';
    rest = key.slice(3);
  }
  const split = rest.lastIndexOf('|');
  if (split <= 0) return null;
  const title = rest.slice(0, split);
  const rawYear = rest.slice(split + 1);
  const year = /^\d{4}$/.test(rawYear) ? Number(rawYear) : null;
  return { title, year, scope };
}

/** Keys from the cached KinoPoisk profiles: title+year -> localized info. */
async function loadKpLookup() {
  const lookup = new Map();
  const dir = path.join(cache.CACHE_DIR, 'kp');
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    return lookup;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let data;
    try {
      data = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
    } catch (err) {
      continue;
    }
    for (const entry of (data && data.entries) || []) {
      if (!entry || entry.kpId == null) continue;
      const kind = entry.type === 'tv' ? 'tv' : 'movie';
      const titleEn = entry.titleEn ? String(entry.titleEn) : '';
      const titleRu = entry.titleRu ? String(entry.titleRu) : '';
      const year = Number.isFinite(entry.year) ? Number(entry.year) : null;
      const info = { titleEn, titleRu, year, kind };
      for (const title of [titleEn, titleRu]) {
        if (!title) continue;
        const key = cache.makeKindKey(title, year, kind);
        if (!lookup.has(key)) lookup.set(key, info);
      }
    }
  }
  return lookup;
}

function lookupInfo(lookup, parsed) {
  const direct = cache.makeKindKey(parsed.title, parsed.year, parsed.scope);
  if (lookup.has(direct)) return lookup.get(direct);
  // Legacy unscoped TV keys: the source profile knows it is a series even
  // though the index key has no `tv|` prefix.
  const unscopedTv = cache.makeKindKey(
    parsed.title,
    parsed.year,
    parsed.scope === 'tv' ? 'movie' : 'tv'
  );
  return lookup.get(unscopedTv) || null;
}

function readIndexFile() {
  const file = path.join(cache.CACHE_DIR, 'index.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('cache/index.json is not an object');
  }
  return parsed;
}

function isManualValue(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.id != null);
}

async function resolveEntry(key, value, lookup) {
  const parsed = parseIndexKey(key);
  if (!parsed) return { status: 'skip', reason: 'unparsable-key' };
  if (isManualValue(value)) return { status: 'manual' };

  const info = lookupInfo(lookup, parsed);
  let kind = parsed.scope;
  if (info) kind = info.kind;
  else if (typeof value === 'number') {
    const details = cache.getDetails(value);
    if (details && details.kind === 'tv') kind = 'tv';
  }

  const primary = (info && (info.titleEn || info.titleRu)) || parsed.title;
  const fallback =
    info && info.titleRu && info.titleRu !== primary ? info.titleRu : undefined;
  const language = isCyrillic(primary) ? 'ru-RU' : 'en-US';
  const options = { language };
  if (fallback) options.fallbackTitle = fallback;

  let found = null;
  try {
    found =
      kind === 'tv'
        ? await tmdb.searchTv(primary, parsed.year, options)
        : await tmdb.searchMovie(primary, parsed.year, options);
  } catch (err) {
    return { status: 'error', error: err };
  }

  const current = typeof value === 'number' ? value : null;
  const next = found ? Number(found.id) : null;

  if (next === current) {
    return { status: current == null ? 'still-failed' : 'unchanged' };
  }

  // A year-less exact search can return a recent film with the same name
  // ("Healer" 2025 for a 2014 entry, "Akahige" 1997 for the 1965 classic).
  // Keep an existing match when it already has a plausible year; for a false
  // entry simply stay false. Both are reported as `guarded`, not as a change.
  if (next != null && parsed.year) {
    const candidateYear = tmdb.releaseYear(found);
    const delta =
      candidateYear != null ? Math.abs(candidateYear - parsed.year) : null;
    const voteCount = Number(found.vote_count) || 0;

    // Two obscure same-name entries with almost no votes: do not churn a
    // working match just because the new candidate has one extra vote.
    if (current != null && voteCount < 10) {
      const oldDetails = cache.getDetails(current);
      const oldYear = oldDetails ? tmdb.releaseYear(oldDetails.details) : null;
      if (oldYear != null && Math.abs(oldYear - parsed.year) <= 2) {
        return {
          status: 'guarded',
          reason: 'low-votes',
          from: current,
          candidate: next,
          candidateYear,
        };
      }
    }

    const hardGuard = delta != null && delta > 2;
    const softGuard = delta === 2 && voteCount < 100;
    if (hardGuard || softGuard) {
      let oldYear = null;
      if (current != null) {
        const oldDetails = cache.getDetails(current);
        oldYear = oldDetails ? tmdb.releaseYear(oldDetails.details) : null;
      }
      const oldPlausible =
        oldYear != null && Math.abs(oldYear - parsed.year) <= 2;
      // Far outside the release window is never an improvement. A 2-year
      // gap is only tolerated when it replaces an already implausible or
      // missing entry (festival vs wide release).
      if (hardGuard || current == null || oldPlausible || oldYear == null) {
        return {
          status: 'guarded',
          reason: hardGuard ? 'year' : 'year+low-votes',
          from: current,
          candidate: next,
          candidateYear,
        };
      }
    }
  }

  if (next == null) {
    // No confident match. Never downgrade an existing automatic id to false
    // based only on the title/year key: the id may have come from a
    // localized search context that the key no longer carries.
    if (current != null) {
      return { status: 'unconfirmed', keep: current };
    }
    return { status: 'still-failed' };
  }

  let detailsFetched = false;
  if (next != null && !DRY_RUN && !cache.hasDetails(next, kind)) {
    try {
      const data =
        kind === 'tv'
          ? await tmdb.fetchTvData(next)
          : await tmdb.fetchMovieData(next);
      await cache.saveDetails(next, data);
      detailsFetched = true;
    } catch (err) {
      // The new id is still valid; a later enrich/backfill can fetch details.
      if (process.env.DEBUG_REMATCH) {
        console.warn(`[rematch] details fetch failed for ${kind} ${next}: ${err.message}`);
      }
    }
  }

  if (DRY_RUN) {
    return { status: current == null ? 'changed' : 'changed', from: current, to: next, kind, detailsFetched, dry: true };
  }
  cache.setIndexValue(key, next == null ? false : next);
  return { status: 'changed', from: current, to: next, kind, detailsFetched };
}

async function runRematch() {
  const startedAt = Date.now();
  const index = readIndexFile();
  const lookup = await loadKpLookup();
  const keys = Object.keys(index).sort();
  const stats = {
    total: keys.length,
    manual: 0,
    reevaluated: 0,
    changed: 0,
    unchanged: 0,
    stillFailed: 0,
    unconfirmed: 0,
    guarded: 0,
    retriedMatched: 0,
    errors: 0,
    detailsRefetched: 0,
    skipped: 0,
  };

  console.log(
    `[rematch] keys=${stats.total} kp-lookups=${lookup.size} concurrency=${CONCURRENCY}` +
      `${DRY_RUN ? ' dry-run=1' : ''}`
  );

  let cursor = 0;
  let processed = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= keys.length) return;
      const key = keys[i];
      const value = index[key];
      const result = await resolveEntry(key, value, lookup);
      processed++;
      if (result.status === 'manual') {
        stats.manual++;
      } else if (result.status === 'skip') {
        stats.skipped++;
      } else if (result.status === 'error') {
        stats.errors++;
        console.warn(`[rematch] "${key}" search failed, keeping ${JSON.stringify(value)}: ${result.error.message}`);
      } else {
        stats.reevaluated++;
        if (result.status === 'changed') {
          stats.changed++;
          if (result.from == null && result.to != null) stats.retriedMatched++;
          if (result.detailsFetched) stats.detailsRefetched++;
          console.log(
            `[rematch] "${key}" ${result.from == null ? 'false' : result.from} -> ` +
              `${result.to == null ? 'false' : result.to}` +
              `${result.detailsFetched ? ' (details fetched)' : ''}` +
              `${result.dry ? ' [dry-run]' : ''}`
          );
        } else if (result.status === 'still-failed') {
          stats.stillFailed++;
        } else if (result.status === 'unconfirmed') {
          stats.unconfirmed++;
          if (process.env.DEBUG_REMATCH) {
            console.log(`[rematch] "${key}" ${result.keep} -> keep (no confident match)`);
          }
        } else if (result.status === 'guarded') {
          stats.guarded++;
          if (process.env.DEBUG_REMATCH) {
            console.log(
              `[rematch] "${key}" ${result.from == null ? 'false' : result.from} -> ` +
                `keep (${result.reason} guard: candidate ${result.candidate} is ${result.candidateYear})`
            );
          }
        } else {
          stats.unchanged++;
        }
      }
      if (processed % LOG_EVERY === 0 || processed === keys.length) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(
          `[rematch] ${processed}/${keys.length} changed=${stats.changed} ` +
            `manual-skipped=${stats.manual} errors=${stats.errors} elapsed=${elapsed}s`
        );
      }
    }
  }

  const workers = Math.min(CONCURRENCY, keys.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  if (!DRY_RUN) {
    cache.flushIndex();
    // Give the debounced writer a chance to settle before the process exits.
    await sleep(50);
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[rematch] done: total=${stats.total} skipped-manual=${stats.manual} ` +
      `reevaluated=${stats.reevaluated} changed=${stats.changed} ` +
      `unchanged=${stats.unchanged} still-failed=${stats.stillFailed} ` +
      `unconfirmed=${stats.unconfirmed} year-guarded=${stats.guarded} ` +
      `retried-matched=${stats.retriedMatched} errors=${stats.errors} ` +
      `details-refetched=${stats.detailsRefetched} in ${seconds}s ` +
      `(tmdb requests=${tmdb.counters.requests} retries=${tmdb.counters.retries} ` +
      `transport=${tmdb.counters.transportRetries} server=${tmdb.counters.serverRetries} ` +
      `429=${tmdb.counters.rateLimitRetries})` +
      `${DRY_RUN ? ' [dry-run: index not written]' : ''}`
  );

  return stats;
}

module.exports = { runRematch, parseIndexKey };

if (require.main === module) {
  runRematch()
    .then((stats) => {
      if (stats.errors > 0) process.exitCode = 1;
    })
    .catch((err) => {
      console.error('[rematch] crashed:', err);
      process.exitCode = 1;
    });
}
