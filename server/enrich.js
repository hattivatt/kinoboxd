'use strict';

const cache = require('./cache');
const tmdb = require('./tmdb');

const jobs = new Map();
const inflight = new Map();

const CONCURRENCY = tmdb.MAX_CONCURRENCY;
const RETRY_DELAY_MS = 2000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* One film: cache first, network only when needed                     */
/* ------------------------------------------------------------------ */

async function resolveFilm(film) {
  const kind = film.kind === 'tv' ? 'tv' : 'movie';
  const indexKey = cache.makeKindKey(film.title, film.year, kind);

  const fetchDetails = async (tmdbId, mediaKind) => {
    const data =
      mediaKind === 'tv'
        ? await tmdb.fetchTvData(tmdbId)
        : await tmdb.fetchMovieData(tmdbId);
    await cache.saveDetails(tmdbId, data);
    return data;
  };

  const cachedEntry = cache.getIndexEntry(indexKey);
  if (cachedEntry === false) {
    return { tmdbId: null, kind, cached: true };
  }
  if (cachedEntry !== undefined) {
    // Manual matches store { id, kind }: trust their kind over the one
    // implied by the upload (e.g. a Letterboxd "movie" that is a TV show).
    const entryKind = cachedEntry.kind || kind;
    if (cache.hasDetails(cachedEntry.id, entryKind)) {
      return { tmdbId: cachedEntry.id, kind: entryKind, cached: true };
    }
    if (!cache.hasDetails(cachedEntry.id)) {
      // We know the id, but a previous run was interrupted before details
      // and credits were stored: finish the job without searching again.
      await fetchDetails(cachedEntry.id, entryKind);
      return { tmdbId: cachedEntry.id, kind: entryKind, cached: false };
    }
    // Details exist for the other media kind (stale index entry): fall
    // through and search again instead of fetching the wrong endpoint.
  }

  // Several uploads may contain the same title/year; share one lookup.
  if (inflight.has(indexKey)) {
    const shared = await inflight.get(indexKey);
    return { tmdbId: shared, kind, cached: true };
  }

  const promise = (async () => {
    const searchOptions = { language: film.searchLanguage || 'en-US' };
    if (film.titleRu) searchOptions.fallbackTitle = film.titleRu;
    const found =
      kind === 'tv'
        ? await tmdb.searchTv(film.title, film.year, searchOptions)
        : await tmdb.searchMovie(film.title, film.year, searchOptions);
    if (!found) {
      cache.setIndexValue(indexKey, false);
      return null;
    }
    cache.setIndexValue(indexKey, found.id);
    // The search may resolve to a TMDB id that is already cached (e.g. the
    // same film under a different localized title): do not re-fetch or
    // overwrite its details.
    if (cache.hasDetails(found.id, kind)) return found.id;
    await fetchDetails(found.id, kind);
    return found.id;
  })();

  inflight.set(indexKey, promise);
  try {
    const tmdbId = await promise;
    return { tmdbId, kind, cached: false };
  } finally {
    inflight.delete(indexKey);
  }
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

function countCached(films) {
  let count = 0;
  for (const film of films) {
    if (cache.isFilmCached(film.title, film.year, film.kind)) count++;
  }
  return count;
}

function startEnrich(upload) {
  const { uploadId, films } = upload;
  const existing = jobs.get(uploadId);
  if (existing) {
    return { accepted: true, total: existing.total, cached: existing.cached };
  }

  const job = {
    uploadId,
    total: films.length,
    matched: 0,
    failed: 0,
    done: films.length === 0,
    startedAt: Date.now(),
    finishedAt: null,
    cached: countCached(films),
    films: new Map(), // slug -> { tmdbId, matched }
    inFlight: 0,
  };
  jobs.set(uploadId, job);

  if (films.length === 0) {
    cache.flushIndex();
    return { accepted: true, total: 0, cached: 0 };
  }

  runJob(job, films).catch((err) => {
    console.error(`[enrich] Job ${uploadId} crashed unexpectedly:`, err);
    job.done = true;
    job.finishedAt = Date.now();
    cache.flushIndex();
  });

  return { accepted: true, total: job.total, cached: job.cached };
}

function logProgress(job, processed, startedAt) {
  const pct = Math.floor((processed / job.total) * 100);
  if (pct < job._nextLogPct) return;
  job._nextLogPct = Math.min(100, Math.floor(pct / 20) * 20 + 20);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[enrich ${job.uploadId}] ${processed}/${job.total} (${pct}%) ` +
      `matched=${job.matched} failed=${job.failed} elapsed=${elapsed}s`
  );
}

async function runJob(job, films) {
  const startedAt = Date.now();
  let cursor = 0;
  let processed = 0;
  job._nextLogPct = 20;

  const workerCount = Math.min(CONCURRENCY, films.length);

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= films.length) return;
      const film = films[index];

      try {
        const result = await resolveFilm(film);
        job.films.set(film.slug, {
          tmdbId: result.tmdbId,
          matched: result.tmdbId != null,
          kind: result.kind || null,
        });
        if (result.tmdbId != null) job.matched++;
        else job.failed++;
      } catch (err) {
        // Network/API failure: leave the film unmatched for this run but do
        // not poison the cache, so a later enrich can try again.
        job.failed++;
        job.films.set(film.slug, { tmdbId: null, matched: false, error: true });
        console.warn(
          `[enrich] ${film.slug} "${film.title}" (${film.year}) failed: ${err.message}`
        );
      }

      processed++;
      job.processed = processed;
      logProgress(job, processed, startedAt);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Transport failures (TMDB resets connections in some networks) leave no
  // index entry, so a single retry pass after the main run can rescue the
  // tail without poisoning the cache. Only films that failed with an error
  // are retried; genuine "not found" results stay false.
  const retryFilms = films.filter((film) => {
    const entry = job.films.get(film.slug);
    return entry && entry.error === true;
  });
  let retriedSuccesses = 0;
  if (retryFilms.length > 0) {
    console.log(
      `[enrich ${job.uploadId}] retrying ${retryFilms.length} transport failure(s) once ` +
        `in ${RETRY_DELAY_MS}ms`
    );
    await sleep(RETRY_DELAY_MS);
    let retryCursor = 0;
    const retryWorkers = Math.min(CONCURRENCY, retryFilms.length);
    async function retryWorker() {
      while (true) {
        const index = retryCursor++;
        if (index >= retryFilms.length) return;
        const film = retryFilms[index];
        try {
          const result = await resolveFilm(film);
          job.films.set(film.slug, {
            tmdbId: result.tmdbId,
            matched: result.tmdbId != null,
            kind: result.kind || null,
          });
          if (result.tmdbId != null) {
            job.matched++;
            retriedSuccesses++;
          } else {
            // Still a definitive miss; keep it counted as failed.
          }
        } catch (err) {
          console.warn(
            `[enrich] retry ${film.slug} "${film.title}" (${film.year}) failed again: ${err.message}`
          );
        }
      }
    }
    await Promise.all(Array.from({ length: retryWorkers }, () => retryWorker()));
    const recovered = retriedSuccesses;
    job.failed -= recovered;
    job.retriedSuccesses = retriedSuccesses;
    console.log(
      `[enrich ${job.uploadId}] retry pass: recovered=${recovered} ` +
        `still-failed=${job.failed}`
    );
  }

  cache.flushIndex();
  // Learn global TMDB <-> Letterboxd links from this job (Letterboxd uploads
  // only: those films carry an lbUri). KinoPoisk imports are a no-op here.
  const learned = cache.learnLbLinks(films, job.films);
  cache.flushLbLinks();
  if (learned.added > 0) {
    console.log(
      `[enrich ${job.uploadId}] learned ${learned.added} TMDB<->Letterboxd links ` +
        `(${learned.candidates} films had both ids, cache now ${cache.lbLinksStats().keys})`
    );
  }
  job.done = true;
  job.finishedAt = Date.now();
  const seconds = ((job.finishedAt - startedAt) / 1000).toFixed(1);
  console.log(
    `[enrich ${job.uploadId}] done: total=${job.total} matched=${job.matched} ` +
      `failed=${job.failed} retriedSuccesses=${job.retriedSuccesses || 0} in ${seconds}s ` +
      `(cache keys=${cache.cacheStats().keys}, tmdb requests=${tmdb.counters.requests} ` +
      `retries=${tmdb.counters.retries})`
  );
}

function getJob(uploadId) {
  return jobs.get(uploadId) || null;
}

function getStatus(uploadId, totalHint) {
  const job = jobs.get(uploadId);
  if (!job) {
    return {
      total: totalHint || 0,
      matched: 0,
      failed: 0,
      done: false,
      started: false,
    };
  }
  return {
    total: job.total,
    matched: job.matched,
    failed: job.failed,
    done: job.done,
    started: true,
  };
}

module.exports = {
  startEnrich,
  getJob,
  getStatus,
};
