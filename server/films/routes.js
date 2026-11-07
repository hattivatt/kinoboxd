'use strict';

/**
 * `/api/*` film routes (P7): the film vertical used to live inline in
 * `server/index.js` (671 lines of bootstrap + 13 endpoints). It is now a
 * domain router mounted under the same auth gate, exactly like
 * `books/routes.js` and `games/routes.js`.
 *
 *   POST /api/upload                      Letterboxd ZIP → in-memory upload
 *   POST /api/enrich                      start the TMDB enrichment job
 *   GET  /api/enrich/status?uploadId=…    enrichment progress
 *   POST /api/import/kinopoisk            start a KinoPoisk profile import
 *   GET  /api/import/kinopoisk/status     import progress
 *   POST /api/attach/lbzip                attach a Letterboxd ZIP to a KinoPoisk import
 *   GET  /api/stats?uploadId=…            the dashboard payload (buildStats)
 *   GET  /api/profiles                    cached KinoPoisk profiles (flat array)
 *   GET  /api/compare?a=…&b=…             two cached profiles side by side
 *   GET  /api/tmdb/search?q=…&kind=…      manual TMDB search
 *   POST /api/match                       attach a chosen TMDB id to a film
 *
 * The film domain deliberately keeps its own inline validation: unlike books
 * and games it never rejected unknown query parameters, and adding
 * `assertOnlyParams` here would be a contract change (a 400 on parameters that
 * are currently ignored), not a refactor. The shared `core/params` helpers are
 * used only where the semantics match exactly.
 *
 * The router is mounted at `/api` AFTER the books/games routers, so the mount
 * order of the whole app is unchanged: gzip → auth gate → books → games →
 * films → static → 404/error.
 */

const express = require('express');
const multer = require('multer');

const { parseLetterboxdZip, createUpload, getUpload } = require('../upload');
const { HttpError } = require('../core/errors');
const enrich = require('../enrich');
const kp = require('../kp');
const attachment = require('../attachment');
const cache = require('../cache');
const tmdb = require('../tmdb');
const kpCompare = require('../compare');
const profileRegistry = require('../core/profile');
const { buildStats, listUnmatched } = require('../stats');
const { normalizeUserId: normalizeCachedUserId, buildCachedProfileStats } = require('./profile-cache');

const router = express.Router();

// Both ZIP endpoints accept one multipart field named "file", buffered in
// memory (the archive is parsed synchronously and never hits the disk).
const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
});

/** The shared multer error shape of /api/upload and /api/attach/lbzip. */
function singleFile(req, res, next) {
  uploadMiddleware.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: 'ZIP file is too large (limit: 100 MB).',
          code: 'file_too_large',
        });
      }
      return res.status(400).json({
        error: `Upload failed: ${err.message}`,
        code: 'upload_failed',
      });
    }
    next();
  });
}

/* ------------------------------------------------------------------ */
/* Letterboxd upload + enrichment                                      */
/* ------------------------------------------------------------------ */

router.post('/upload', singleFile, (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      throw new HttpError(
        400,
        'No file received. Send the Letterboxd export as multipart/form-data field "file".',
        'file_required'
      );
    }

    const dataset = parseLetterboxdZip(req.file.buffer);
    const upload = createUpload(dataset);

    res.status(200).json({
      uploadId: upload.uploadId,
      summary: upload.summary,
      films: upload.films.map((f) => ({
        slug: f.slug,
        title: f.title,
        year: f.year,
        rating: f.rating,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/enrich', (req, res, next) => {
  try {
    const uploadId = req.body && req.body.uploadId;
    if (!uploadId || typeof uploadId !== 'string') {
      throw new HttpError(400, 'Body must contain "uploadId".', 'upload_id_required');
    }
    const upload = getUpload(uploadId);
    if (!upload) {
      throw new HttpError(404, 'Unknown uploadId. Upload the ZIP again.', 'unknown_upload');
    }

    const result = enrich.startEnrich(upload);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/enrich/status', (req, res, next) => {
  try {
    const uploadId = req.query.uploadId;
    if (!uploadId || typeof uploadId !== 'string') {
      throw new HttpError(400, 'Query parameter "uploadId" is required.', 'upload_id_required');
    }
    const upload = getUpload(uploadId);
    if (!upload) {
      throw new HttpError(404, 'Unknown uploadId. Upload the ZIP again.', 'unknown_upload');
    }
    res.status(200).json(enrich.getStatus(uploadId, upload.films.length));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* KinoPoisk import                                                    */
/* ------------------------------------------------------------------ */

router.post('/import/kinopoisk', (req, res, next) => {
  try {
    const url = req.body && req.body.url;
    if (!url || typeof url !== 'string') {
      throw new HttpError(
        400,
        'Body must contain "url" (a KinoPoisk user profile or votes URL).',
        'url_required'
      );
    }
    const result = kp.startImport(url);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/import/kinopoisk/status', (req, res, next) => {
  try {
    const uploadId = req.query.uploadId;
    if (!uploadId || typeof uploadId !== 'string') {
      throw new HttpError(400, 'Query parameter "uploadId" is required.', 'upload_id_required');
    }
    const upload = getUpload(uploadId);
    if (!upload) {
      throw new HttpError(
        404,
        'Unknown uploadId. Start the KinoPoisk import again.',
        'unknown_upload'
      );
    }
    const status = kp.getStatus(uploadId);
    if (!status) {
      throw new HttpError(
        404,
        'This uploadId is not a KinoPoisk import.',
        'unknown_kinopoisk_import'
      );
    }
    res.status(200).json(status);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Letterboxd attachment on a KinoPoisk profile                        */
/* ------------------------------------------------------------------ */

/**
 * Attach a Letterboxd export to the active KinoPoisk import.
 *
 * multipart/form-data: field `file` (ZIP), `uploadId` query or body field.
 * The server resolves `kpUserId` from the KinoPoisk job, parses diary.csv /
 * watched.csv / watchlist.csv, matches every film through the shared TMDB
 * matcher and stores cache/profile-lb/{kpUserId}.json atomically. Repeating
 * the call replaces the whole attachment (idempotent) — no duplicate events.
 *
 * `kpUserId` is the persistent fallback of `uploadId`: the attachment belongs
 * to the owner (cache/profile-lb/{kpUserId}.json), not to the ephemeral
 * in-memory upload. After a server restart the browser still shows the cached
 * dashboard, so it sends the profile id together with the stale upload id and
 * the attach keeps working instead of answering 404.
 */
router.post('/attach/lbzip', singleFile, async (req, res, next) => {
  try {
    const uploadId = (req.body && req.body.uploadId) || req.query.uploadId;
    const rawKpUserId = (req.body && req.body.kpUserId) || req.query.kpUserId;
    if ((!uploadId || typeof uploadId !== 'string') &&
        (!rawKpUserId || typeof rawKpUserId !== 'string')) {
      throw new HttpError(400, 'Body must contain "uploadId".', 'upload_id_required');
    }

    const upload = uploadId ? getUpload(uploadId) : null;
    const job = uploadId ? kp.getJob(uploadId) : null;
    let kpUserId = job && job.userId ? String(job.userId) : null;

    if (!kpUserId) {
      // A live upload/job is gone (server restart, 30-upload window), but the
      // votes of the profile are persisted. Attaching to that profile is
      // exactly as valid: the attachment is keyed by kpUserId and read on
      // every stats build.
      const cachedId = normalizeCachedUserId(rawKpUserId);
      if (cachedId && kp.readKpCache(cachedId)) kpUserId = cachedId;
    }

    if (!kpUserId) {
      if (uploadId && !upload) {
        throw new HttpError(404, 'Unknown uploadId. Start the KinoPoisk import again.', 'unknown_upload');
      }
      if (rawKpUserId) {
        throw new HttpError(
          404,
          'No cached KinoPoisk profile for this kpUserId. Import the profile first.',
          'unknown_profile'
        );
      }
      throw new HttpError(
        400,
        'Letterboxd archives can only be attached to a KinoPoisk import.',
        'not_kinopoisk_import'
      );
    }

    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      throw new HttpError(
        400,
        'No file received. Send the Letterboxd ZIP as multipart/form-data field "file".',
        'file_required'
      );
    }

    const built = await attachment.buildAttachment(
      req.file.buffer,
      req.file.originalname || req.file.name || 'letterboxd-export.zip'
    );
    await attachment.writeAttachment(kpUserId, built.attachment);

    // Keep the in-memory job pointed at the fresh attachment; stats.js reads
    // the persisted file, so this is only metadata for status responses.
    if (upload) upload.attachment = built.attachment;
    if (job) {
      job.attachment = {
        fileName: built.attachment.fileName,
        attachedAt: built.attachment.attachedAt,
        events: built.stats.events,
        watchlist: built.stats.watchlist,
      };
    }

    console.log(
      `[attach ${kpUserId}] ${built.stats.events} events ` +
        `(${built.stats.diaryEvents} diary), matched ${built.stats.matched}, ` +
        `watchlist ${built.stats.watchlist}, rewatches ${built.stats.rewatchCount}`
    );

    res.status(200).json({
      attached: true,
      fileName: built.attachment.fileName,
      kpUserId,
      ...built.stats,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Dashboard payload                                                   */
/* ------------------------------------------------------------------ */

router.get('/stats', (req, res, next) => {
  try {
    const uploadId = req.query.uploadId;
    if (!uploadId || typeof uploadId !== 'string') {
      throw new HttpError(400, 'Query parameter "uploadId" is required.', 'upload_id_required');
    }
    const upload = getUpload(uploadId);
    if (!upload) {
      // The in-memory upload is gone after a restart (or was evicted from the
      // 30-upload window), but the KinoPoisk profile and its Letterboxd
      // attachment are on disk. The browser remembers the profile, so it can
      // send `kpUserId` and keep the cached dashboard fresh instead of being
      // stuck with a dead uploadId.
      const cachedStats = buildCachedProfileStats(req.query.kpUserId);
      if (cachedStats) return res.status(200).json(cachedStats);
      throw new HttpError(404, 'Unknown uploadId. Upload the ZIP again.', 'unknown_upload');
    }

    const stats = buildStats(upload);
    if (!stats) {
      const isKp = kp.getJob(uploadId) != null;
      return res.status(400).json({
        error: isKp
          ? 'Import is not finished yet. Poll /api/import/kinopoisk/status.'
          : 'Enrichment is not finished yet. Poll /api/enrich/status.',
        code: 'enrichment_not_finished',
        done: false,
      });
    }
    res.status(200).json(stats);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Cached profiles + comparison                                        */
/* ------------------------------------------------------------------ */

/**
 * Cached KinoPoisk profiles (one per cache/kp/{userId}.json). The list is
 * independent of the browser registry and survives server restarts, so the
 * comparison screen can always use it.
 *
 * The payload stays a flat array (the compare picker reads it as an array);
 * every entry also carries the unified owner fields of `core/profile`
 * (`id`/`label`/`primary`/`enrichers`/`metrics`). The domain registers itself
 * in `compare.js`, so the shape has one owner.
 */
router.get('/profiles', (req, res, next) => {
  try {
    res.status(200).json(profileRegistry.listOwners('films'));
  } catch (err) {
    next(err);
  }
});

/**
 * Read-only comparison of two cached KinoPoisk profiles. All numbers come
 * from the persistent caches (profile + TMDB details + Letterboxd
 * attachment); no live KinoPoisk request is made.
 */
router.get('/compare', (req, res, next) => {
  try {
    const startedAt = process.hrtime.bigint();
    const payload = kpCompare.compareProfiles(req.query.a, req.query.b);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    res.set('X-Compare-Ms', elapsedMs.toFixed(1));
    res.status(200).json(payload);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Manual TMDB matching                                                */
/* ------------------------------------------------------------------ */

router.get('/tmdb/search', async (req, res, next) => {
  try {
    const q = req.query.q;
    if (!q || typeof q !== 'string' || !q.trim()) {
      throw new HttpError(
        400,
        'Query parameter "q" is required.',
        'query_required'
      );
    }
    const kindRaw = req.query.kind;
    let kind;
    if (kindRaw === undefined || kindRaw === '' || kindRaw === 'all') {
      kind = undefined;
    } else if (kindRaw === 'movie' || kindRaw === 'tv') {
      kind = kindRaw;
    } else {
      throw new HttpError(
        400,
        'Query parameter "kind" must be "movie", "tv" or "all".',
        'invalid_kind'
      );
    }

    const payload = await tmdb.searchCatalog(q, kind);
    res.status(200).json(payload);
  } catch (err) {
    next(err);
  }
});

/**
 * Attach a TMDB id chosen by the user to a film.
 *
 * - Unmatched film: creates the match.
 * - Matched film with the same id/kind: idempotent 200 `alreadyMatched`.
 * - Matched film with a different id/kind: re-match (details are fetched
 *   when missing, the cache index key and the job entry are rewritten).
 */
router.post('/match', async (req, res, next) => {
  try {
    const body = req.body || {};
    const uploadId = body.uploadId;
    const slug = body.slug;
    const kind = body.kind;
    const tmdbId = Number(body.tmdbId);

    if (!uploadId || typeof uploadId !== 'string') {
      throw new HttpError(400, 'Body must contain "uploadId".', 'upload_id_required');
    }
    const upload = getUpload(uploadId);
    if (!upload) {
      throw new HttpError(404, 'Unknown uploadId. Upload the ZIP again.', 'unknown_upload');
    }
    if (!slug || typeof slug !== 'string') {
      throw new HttpError(400, 'Body must contain "slug".', 'slug_required');
    }
    if (kind !== 'movie' && kind !== 'tv') {
      throw new HttpError(
        400,
        'Body field "kind" must be "movie" or "tv".',
        'invalid_kind'
      );
    }
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
      throw new HttpError(
        400,
        'Body field "tmdbId" must be a positive integer.',
        'invalid_tmdb_id'
      );
    }

    const job = enrich.getJob(uploadId);
    if (!job || !job.done) {
      throw new HttpError(
        400,
        'Enrichment is not finished yet. Poll /api/enrich/status.',
        'enrichment_not_finished'
      );
    }

    const film = upload.films.find((f) => f.slug === slug) || null;
    if (!film) {
      throw new HttpError(404, 'Unknown film slug for this upload.', 'unknown_film');
    }

    const filmKind = film.kind === 'tv' ? 'tv' : 'movie';
    const existing = job.films.get(slug);
    const existingKind = existing && existing.kind ? existing.kind : filmKind;
    const alreadyMatched = Boolean(existing && existing.tmdbId != null);
    const previousKind = existing && existing.kind ? existing.kind : filmKind;

    if (alreadyMatched && existing.tmdbId === tmdbId && existingKind === kind) {
      // Idempotent repeat of the same match. Finish a pending details fetch
      // from an interrupted run so the response really is "ready".
      if (!cache.hasDetails(tmdbId, kind)) {
        const data =
          kind === 'tv' ? await tmdb.fetchTvData(tmdbId) : await tmdb.fetchMovieData(tmdbId);
        await cache.saveDetails(tmdbId, data);
      }
      return res.status(200).json({
        ok: true,
        alreadyMatched: true,
        rematched: false,
        slug,
        tmdbId,
        kind,
      });
    }

    const isRematch = alreadyMatched;

    if (!isRematch) {
      // Only a genuinely unmatched film can receive its first manual match.
      const unmatched = listUnmatched(upload) || [];
      if (!unmatched.some((entry) => entry.slug === slug)) {
        if (existing && existing.tmdbId != null) {
          throw new HttpError(
            409,
            'This film is already matched to another TMDB entry.',
            'already_matched'
          );
        }
        throw new HttpError(
          404,
          'This film is not in the unmatched list.',
          'not_unmatched'
        );
      }
    }

    // 1. Details/credits: reuse the cache whenever possible; a re-match to a
    //    new id/kind fetches and stores the missing entry first.
    if (!cache.hasDetails(tmdbId, kind)) {
      const data =
        kind === 'tv' ? await tmdb.fetchTvData(tmdbId) : await tmdb.fetchMovieData(tmdbId);
      await cache.saveDetails(tmdbId, data);
    }

    // 2. Index key: exactly the key enrich used for this upload entry
    //    ("normalized title|year", "tv|"-prefixed for TV entries). The value
    //    becomes an object so the media kind of a manual match survives.
    const indexKey = cache.makeKindKey(film.title, film.year, filmKind);
    cache.setIndexValue(indexKey, { id: tmdbId, kind });
    cache.flushIndex();

    // 3. Mark the job entry; buildStats() is computed on demand, so the next
    //    /api/stats request already reflects the match (or re-match).
    job.films.set(slug, {
      tmdbId,
      matched: true,
      kind,
      manual: true,
      ...(isRematch ? { rematched: true } : {}),
    });
    let matched = 0;
    for (const entry of job.films.values()) {
      if (entry.matched) matched++;
    }
    job.matched = matched;
    job.failed = Math.max(0, job.total - matched);

    // A manual (re)match on a Letterboxd upload is another chance to learn a
    // global TMDB <-> boxd.it pair, e.g. when the automatic match failed.
    if (film.lbUri && cache.setLbLink(tmdbId, film.lbUri, kind)) {
      cache.flushLbLinks();
      console.log(`[match] learned TMDB<->Letterboxd link ${kind}:${tmdbId} -> ${film.lbUri}`);
    }

    // Keep the KinoPoisk movie/TV counters consistent when a manual match
    // changes the media kind. Compare against the previous effective kind, not
    // the upload kind, so a re-match does not double-adjust the counters.
    if (
      previousKind !== kind &&
      upload.summary &&
      Number.isFinite(upload.summary.movieCount) &&
      Number.isFinite(upload.summary.tvCount)
    ) {
      if (kind === 'tv') {
        upload.summary.movieCount = Math.max(0, upload.summary.movieCount - 1);
        upload.summary.tvCount += 1;
      } else {
        upload.summary.tvCount = Math.max(0, upload.summary.tvCount - 1);
        upload.summary.movieCount += 1;
      }
    }

    console.log(
      `[match] ${uploadId} ${slug} -> ${kind}:${tmdbId} (${film.title})` +
        (isRematch ? ' [rematch]' : '')
    );
    res.status(200).json({
      ok: true,
      rematched: isRematch,
      alreadyMatched: false,
      slug,
      tmdbId,
      kind,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
