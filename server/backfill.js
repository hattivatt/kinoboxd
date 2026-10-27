'use strict';

/*
 * Backfill cached TMDB details.
 *
 * Usage:
 *   npm run backfill:keywords              # keywords, credits untouched
 *   npm run backfill:imdb                  # IMDb ids for deep links
 *   npm run backfill:collections           # belongs_to_collection (franchises)
 *   npm run backfill:wikidata              # P136/P462/P135/P144 tags
 *   npm run backfill:mcu                   # MCU membership (cache/mcu.json)
 *   npm run rematch                        # re-evaluate cache/index.json
 *   BACKFILL_CONCURRENCY=4 npm run backfill:imdb   (default 8)
 *   node server/backfill.js collections
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
 * - collections: add `details.belongs_to_collection` to movie entries fetched
 *   before the field was normalized. A `null` value is meaningful (standalone
 *   film), so presence of the key is the idempotency marker; `collection_checked`
 *   is kept as an explicit marker for older runs. TV is skipped (TMDB does not
 *   expose collections for series).
 * - wikidata: query WDQS by IMDb id (P345), 450 ids per batch, with a P4947
 *   TMDB-id fallback for films without an IMDb id. Results are persisted in
 *   cache/wd-tags.json after every batch. Idempotent: already checked ids are
 *   skipped; WIKIDATA_REFRESH=1 forces a refetch.
 * - mcu: one WDQS query for the P179 membership of Q642878 (Marvel Cinematic
 *   Universe), persisted as cache/mcu.json. stats.js merges it over the
 *   built-in canonical film list, so a new MCU release can be picked up
 *   without a code change. Idempotent by nature (the file is replaced).
 *
 * All targets are idempotent: a valid `imdb_id` / `imdb_checked` marker or a
 * checked Wikidata id makes the entry a skip.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const cache = require('./cache');
const tmdb = require('./tmdb');
const wikidata = require('./wikidata');

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
  if (raw === 'wikidata' || raw === 'wd' || raw === 'wd-tags') return 'wikidata';
  if (raw === 'mcu' || raw === 'marvel') return 'mcu';
  if (raw === 'collections' || raw === 'collection' || raw === 'franchises') {
    return 'collections';
  }
  if (raw === 'rematch' || raw === 'rematch-index' || raw === 'match') {
    return 'rematch';
  }
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

/** True when a previous `collections` run (or the current normalizer) wrote
 *  the field. `null` is a valid, meaningful value for standalone films. */
function collectionChecked(entry) {
  const details = entry && entry.details;
  if (!details) return false;
  return Object.prototype.hasOwnProperty.call(details, 'belongs_to_collection')
    || details.collection_checked === true;
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
/* collections target                                                  */
/* ------------------------------------------------------------------ */

async function refreshCollections(item) {
  const { id } = item;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const details = await tmdb.tmdbGet(
        `/movie/${id}`,
        { language: 'ru-RU', append_to_response: 'keywords' }
      );
      if (!details) throw new Error('TMDB returned no details (404?)');
      const payload = tmdb.normalizeDetailsPayload(
        details,
        item.credits || { cast: [], crew: [] }
      );
      // Re-fetching through the normalizer must not erase markers written by
      // the other backfill targets.
      if (!payload.details.imdb_id && item.previousImdbId) {
        payload.details.imdb_id = item.previousImdbId;
      }
      if (item.imdbChecked) payload.details.imdb_checked = true;
      payload.details.collection_checked = true;
      await cache.saveDetails(id, payload);
      return { ok: true, collection: payload.details.belongs_to_collection };
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

function releaseYearOf(details) {
  const raw = String((details && (details.release_date || details.first_air_date)) || '');
  return /^\d{4}/.test(raw) ? Number(raw.slice(0, 4)) : null;
}

async function runWikidataTarget(files, names, unreadable) {
  const items = files.map((file) => ({
    tmdbId: Number(file.entry.details.id),
    kind: file.kind,
    imdbId: tmdb.normalizeImdbId(file.entry.details.imdb_id),
    title: file.entry.details.title || null,
    year: releaseYearOf(file.entry.details),
  }));
  const startedAt = Date.now();
  const result = await wikidata.backfill(items);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[backfill:wikidata] cache files=${names.length} unreadable=${unreadable} ` +
      `skipped-imdb=${result.skippedImdb} batches=${result.batches} ` +
      `failed-batches=${result.failedBatches} in ${seconds}s`
  );
  if (result.failedBatches > 0) {
    console.warn(
      '[backfill:wikidata] partial run: successful batches are already persisted; ' +
        'run `npm run backfill:wikidata` again to resume (idempotent).'
    );
  }
  return {
    updated: result.coverage.movie.covered + result.coverage.tv.covered,
    failed: result.failedBatches,
    skipped: result.skippedImdb,
    unreadable,
  };
}

async function main() {
  if (TARGET === 'rematch') {
    // Re-evaluate index.json only; it does not need the details scan.
    const { runRematch } = require('./rematch');
    return runRematch();
  }
  if (TARGET === 'mcu') {
    const mcu = require('./mcu');
    return mcu.backfill();
  }
  const { files, names, unreadable } = await readAllFiles();
  if (TARGET === 'wikidata') {
    return runWikidataTarget(files, names, unreadable);
  }
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
    } else if (TARGET === 'collections') {
      // TV details have no belongs_to_collection; only movies need a refetch.
      if (file.kind === 'tv' || collectionChecked(file.entry)) {
        skipped++;
        continue;
      }
      queue.push({
        id: Number(details.id),
        kind: file.kind,
        entry: file.entry,
        credits: file.entry.credits || null,
        previousImdbId: hasImdbId(details) ? details.imdb_id : null,
        imdbChecked: imdbChecked(details),
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
        : TARGET === 'collections'
          ? await refreshCollections(item)
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
