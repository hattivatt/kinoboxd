'use strict';

/*
 * Backfill TMDB keywords for every cached details file.
 *
 * Usage:
 *   npm run backfill:keywords
 *   BACKFILL_CONCURRENCY=4 npm run backfill:keywords   (default 8)
 *
 * The script is idempotent: entries whose `details.keywords` is already an
 * array (including an empty one) are skipped, so a second run performs no
 * network requests. Details are refreshed via the normal normalizers, which
 * keeps production countries/companies and the already cached credits.
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

function kindOf(fileName, entry) {
  if (entry && entry.kind === 'tv') return 'tv';
  if (fileName.startsWith('tv-')) return 'tv';
  return 'movie';
}

async function readEntry(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function refreshOne(item) {
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

async function main() {
  const detailsDir = path.join(cache.CACHE_DIR, 'details');
  let names;
  try {
    names = await fsp.readdir(detailsDir);
  } catch (err) {
    console.error(`[backfill] cannot read ${detailsDir}: ${err.message}`);
    process.exit(1);
  }

  const queue = [];
  let skipped = 0;
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
    if (Array.isArray(details.keywords)) {
      skipped++;
      continue;
    }
    queue.push({
      id: Number(details.id),
      kind: kindOf(fileName, entry),
      credits: entry.credits || null,
    });
  }

  const total = queue.length;
  console.log(
    `[backfill] cache files=${names.length} to-refresh=${total} ` +
      `already-done=${skipped} unreadable=${unreadable} concurrency=${CONCURRENCY}`
  );

  if (total === 0) {
    console.log('[backfill] nothing to do');
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
      const result = await refreshOne(item);
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
    `[backfill] done: updated=${updated} failed=${failed} skipped=${skipped} ` +
      `unreadable=${unreadable} in ${seconds}s ` +
      `tmdb requests=${tmdb.counters.requests} retries=${tmdb.counters.retries} errors=${tmdb.counters.errors}`
  );
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
