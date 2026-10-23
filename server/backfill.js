'use strict';

/*
 * Backfill cached TMDB details.
 *
 * Usage:
 *   npm run backfill:keywords              # keywords, credits untouched
 *   npm run backfill:imdb                  # IMDb ids for deep links
 *   BACKFILL_CONCURRENCY=4 npm run backfill:imdb   (default 8)
 *   node server/backfill.js imdb
 *   BACKFILL_TARGET=imdb node server/backfill.js
 *
 * Targets
 * - keywords: refresh every entry whose `details.keywords` is not an array
 *   (empty array counts as done).
 * - imdb: add `details.imdb_id`.
 *     * movie: re-fetch GET /movie/{id}?language=ru-RU&append_to_response=keywords
 *       through the normal normalizer, so the whole card is refreshed;
 *     * tv: GET /tv/{id}/external_ids (details do not carry imdb_id) and patch
 *       the existing file, keeping aggregated credits/docs untouched.
 *   Idempotent in both cases: a valid `imdb_id` or the `imdb_checked` marker
 *   set by a previous run makes the file a skip.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const cache = require('./cache');
const tmdb = require('./tmdb');

const CONCURRENCY = Math.max(
  1,
  Math.min(16, Number(process.env.BACKFILL_CONCURRENCY) || 8)
);
const MAX_ATTEMPTS = 3;
const LOG_EVERY = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeTarget(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'imdb' || raw === 'imdb_id' || raw === 'imdb-id') return 'imdb';
  return 'keywords';
}

const TARGET = normalizeTarget(process.argv[2] || process.env.BACKFILL_TARGET);

function kindOf(fileName, entry) {
  if (entry && entry.kind === 'tv') return 'tv';
  if (fileName.startsWith('tv-')) return 'tv';
  return 'movie';
}

async function readEntry(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function hasImdbId(details) {
  return Boolean(details && tmdb.normalizeImdbId(details.imdb_id));
}

/** True when a previous `imdb` run already looked at this file. */
function imdbChecked(details) {
  return Boolean(details && details.imdb_checked === true);
}

/* ------------------------------------------------------------------ */
/* keyword target                                                      */
/* ------------------------------------------------------------------ */

async function refreshKeywords(item) {
  const { id, kind, credits } = item;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const details = await tmdb.tmdbGet(
        kind === 'tv' ? `/tv/${id}` : `/movie/${id}`,
        { language: 'ru-RU', append_to_response: 'keywords' }
      );
      if (!details) throw new Error('TMDB returned no details (404?)');
      const payload =
        kind === 'tv'
          ? tmdb.normalizeTvPayload(details, credits || { cast: [], crew: [] })
          : tmdb.normalizeDetailsPayload(details, credits || { cast: [], crew: [] });
      // Never drop an IMDb id that a previous imdb run already stored (the
      // TV normalizer has no external_ids in this code path).
      if (!payload.details.imdb_id && item.previousImdbId) {
        payload.details.imdb_id = item.previousImdbId;
      }
      if (item.imdbChecked) payload.details.imdb_checked = true;
      await cache.saveDetails(id, payload);
      return { ok: true };
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(750 * attempt);
      }
    }
  }
  return { ok: false, error: lastError };
}

/* ------------------------------------------------------------------ */
/* imdb target                                                         */
/* ------------------------------------------------------------------ */

async function refreshImdb(item) {
  const { id, kind } = item;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (kind === 'tv') {
        const external = await tmdb.tmdbGet(`/tv/${id}/external_ids`, {});
        if (!external) throw new Error('TMDB returned no external ids (404?)');
        const entry = item.entry;
        entry.details.imdb_id = tmdb.normalizeImdbId(external.imdb_id);
        entry.details.imdb_checked = true;
        await cache.saveDetails(id, entry);
        return { ok: true, imdb: entry.details.imdb_id };
      }

      const details = await tmdb.tmdbGet(
        `/movie/${id}`,
        { language: 'ru-RU', append_to_response: 'keywords' }
      );
      if (!details) throw new Error('TMDB returned no details (404?)');
      const payload = tmdb.normalizeDetailsPayload(
        details,
        item.credits || { cast: [], crew: [] }
      );
      payload.details.imdb_checked = true;
      await cache.saveDetails(id, payload);
      return { ok: true, imdb: payload.details.imdb_id };
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(750 * attempt);
      }
    }
  }
  return { ok: false, error: lastError };
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function readAllFiles() {
  const detailsDir = path.join(cache.CACHE_DIR, 'details');
  let names;
  try {
    names = await fsp.readdir(detailsDir);
  } catch (err) {
    console.error(`[backfill] cannot read ${detailsDir}: ${err.message}`);
    process.exit(1);
  }

  const files = [];
  let unreadable = 0;
  for (const fileName of names.sort()) {
    if (!fileName.endsWith('.json')) continue;
    const filePath = path.join(detailsDir, fileName);
    let entry;
    try {
      entry = await readEntry(filePath);
    } catch (err) {
      unreadable++;
      console.warn(`[backfill] skip unreadable ${fileName}: ${err.message}`);
      continue;
    }
    const details = entry && entry.details;
    if (!details || !Number.isFinite(Number(details.id))) {
      unreadable++;
      console.warn(`[backfill] skip malformed ${fileName}`);
      continue;
    }
    files.push({ fileName, entry, kind: kindOf(fileName, entry) });
  }
  return { files, names, unreadable };
}

function coverage(files) {
  const out = { movie: { total: 0, withId: 0 }, tv: { total: 0, withId: 0 } };
  for (const file of files) {
    const bucket = out[file.kind === 'tv' ? 'tv' : 'movie'];
    bucket.total++;
    if (hasImdbId(file.entry.details)) bucket.withId++;
  }
  return out;
}

function pct(part, total) {
  if (!total) return '0.0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

async function main() {
  const { files, names, unreadable } = await readAllFiles();
  const queue = [];
  let skipped = 0;

  for (const file of files) {
    const details = file.entry.details;
    if (TARGET === 'imdb') {
      if (hasImdbId(details) || imdbChecked(details)) {
        skipped++;
        continue;
      }
      queue.push({
        id: Number(details.id),
        kind: file.kind,
        entry: file.entry,
        credits: file.entry.credits || null,
      });
    } else {
      if (Array.isArray(details.keywords)) {
        skipped++;
        continue;
      }
      queue.push({
        id: Number(details.id),
        kind: file.kind,
        credits: file.entry.credits || null,
        previousImdbId: hasImdbId(details) ? details.imdb_id : null,
        imdbChecked: imdbChecked(details),
      });
    }
  }

  const total = queue.length;
  console.log(
    `[backfill:${TARGET}] cache files=${names.length} to-refresh=${total} ` +
      `already-done=${skipped} unreadable=${unreadable} concurrency=${CONCURRENCY}`
  );

  if (total === 0) {
    console.log('[backfill] nothing to do');
    if (TARGET === 'imdb') {
      const cov = coverage(files);
      console.log(
        `[backfill:imdb] coverage movies=${cov.movie.withId}/${cov.movie.total} ` +
          `(${pct(cov.movie.withId, cov.movie.total)}) ` +
          `tv=${cov.tv.withId}/${cov.tv.total} (${pct(cov.tv.withId, cov.tv.total)})`
      );
    }
    return { updated: 0, failed: 0, skipped, unreadable };
  }

  const startedAt = Date.now();
  let cursor = 0;
  let processed = 0;
  let updated = 0;
  let failed = 0;
  const failures = [];

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= queue.length) return;
      const item = queue[index];
      const result = TARGET === 'imdb'
        ? await refreshImdb(item)
        : await refreshKeywords(item);
      processed++;
      if (result.ok) {
        updated++;
      } else {
        failed++;
        failures.push({ id: item.id, kind: item.kind, error: result.error });
        console.warn(
          `[backfill] ${item.kind} ${item.id} failed: ${result.error && result.error.message}`
        );
      }
      if (processed % LOG_EVERY === 0 || processed === total) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        const rate = (processed / Math.max(0.001, elapsed)).toFixed(1);
        console.log(
          `[backfill] ${processed}/${total} updated=${updated} failed=${failed} ` +
            `elapsed=${elapsed}s (${rate}/s)`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()));

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[backfill:${TARGET}] done: updated=${updated} failed=${failed} skipped=${skipped} ` +
      `unreadable=${unreadable} in ${seconds}s ` +
      `tmdb requests=${tmdb.counters.requests} retries=${tmdb.counters.retries} errors=${tmdb.counters.errors}`
  );

  if (TARGET === 'imdb') {
    // Re-read from disk so the numbers reflect what was actually persisted.
    const fresh = await readAllFiles();
    const cov = coverage(fresh.files);
    console.log(
      `[backfill:imdb] coverage movies=${cov.movie.withId}/${cov.movie.total} ` +
        `(${pct(cov.movie.withId, cov.movie.total)}) ` +
        `tv=${cov.tv.withId}/${cov.tv.total} (${pct(cov.tv.withId, cov.tv.total)})`
    );
  }

  for (const failure of failures) {
    console.warn(
      `[backfill] failed ${failure.kind} ${failure.id}: ${failure.error && failure.error.message}`
    );
  }
  return { updated, failed, skipped, unreadable, failures };
}

main()
  .then((result) => {
    if (result && result.failed > 0) process.exitCode = 1;
  })
  .catch((err) => {
    console.error('[backfill] crashed:', err);
    process.exitCode = 1;
  });
