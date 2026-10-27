'use strict';

const express = require('express');
const multer = require('multer');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  HttpError,
  parseLetterboxdZip,
  createUpload,
  getUpload,
} = require('./upload');
const enrich = require('./enrich');
const kp = require('./kp');
const attachment = require('./attachment');
const config = require('./config');
const cache = require('./cache');
const tmdb = require('./tmdb');
const auth = require('./auth');
const kpCompare = require('./compare');
const { buildStats, listUnmatched } = require('./stats');
const booksRouter = require('./books/routes');

// Fail fast, before the HTTP server starts, if TMDB credentials are missing.
// Missing config is an expected condition: print one clean line and exit 1
// without a stack trace.
try {
  config.loadTmdbToken();
} catch (err) {
  if (err && err.code === 'TMDB_TOKEN_MISSING') {
    console.error(`[server] ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
});

app.disable('x-powered-by');
// /api/stats is several megabytes of JSON; gzip cuts it by ~85% and is the
// single biggest transfer win. Also compresses static JS/CSS.
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// Password protection (KINOBOXD_PASSWORD). When the env var is missing the
// whole API stays open. /api/auth/* is always reachable; everything else
// under /api is gated. Static files are deliberately not protected.
app.use(auth.attachCookies);
app.use('/api/auth', auth.router);
app.use('/api', auth.requireAuth);

// Books live in their own namespace and cache (cache-book/). Mounted after the
// auth gate, before the film routes; the film payload is untouched.
app.use('/api/books', booksRouter);

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

app.post('/api/upload', (req, res, next) => {
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
}, (req, res, next) => {
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

app.post('/api/enrich', (req, res, next) => {
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

app.get('/api/enrich/status', (req, res, next) => {
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

app.post('/api/import/kinopoisk', (req, res, next) => {
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

app.get('/api/import/kinopoisk/status', (req, res, next) => {
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
 */
app.post('/api/attach/lbzip', (req, res, next) => {
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
}, async (req, res, next) => {
  try {
    const uploadId = (req.body && req.body.uploadId) || req.query.uploadId;
    if (!uploadId || typeof uploadId !== 'string') {
      throw new HttpError(400, 'Body must contain "uploadId".', 'upload_id_required');
    }
    const upload = getUpload(uploadId);
    if (!upload) {
      throw new HttpError(404, 'Unknown uploadId. Start the KinoPoisk import again.', 'unknown_upload');
    }
    const job = kp.getJob(uploadId);
    if (!job || !job.userId) {
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
    await attachment.writeAttachment(job.userId, built.attachment);

    // Keep the in-memory job pointed at the fresh attachment; stats.js reads
    // the persisted file, so this is only metadata for status responses.
    upload.attachment = built.attachment;
    job.attachment = {
      fileName: built.attachment.fileName,
      attachedAt: built.attachment.attachedAt,
      events: built.stats.events,
      watchlist: built.stats.watchlist,
    };

    console.log(
      `[attach ${job.userId}] ${built.stats.events} events ` +
        `(${built.stats.diaryEvents} diary), matched ${built.stats.matched}, ` +
        `watchlist ${built.stats.watchlist}, rewatches ${built.stats.rewatchCount}`
    );

    res.status(200).json({
      attached: true,
      fileName: built.attachment.fileName,
      ...built.stats,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/stats', (req, res, next) => {
  try {
    const uploadId = req.query.uploadId;
    if (!uploadId || typeof uploadId !== 'string') {
      throw new HttpError(400, 'Query parameter "uploadId" is required.', 'upload_id_required');
    }
    const upload = getUpload(uploadId);
    if (!upload) {
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
 */
app.get('/api/profiles', (req, res, next) => {
  try {
    res.status(200).json(kpCompare.listProfiles());
  } catch (err) {
    next(err);
  }
});

/**
 * Read-only comparison of two cached KinoPoisk profiles. All numbers come
 * from the persistent caches (profile + TMDB details + Letterboxd
 * attachment); no live KinoPoisk request is made.
 */
app.get('/api/compare', (req, res, next) => {
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

app.get('/api/tmdb/search', async (req, res, next) => {
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
app.post('/api/match', async (req, res, next) => {
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

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Static frontend                                                     */
/* ------------------------------------------------------------------ */

app.use(
  express.static(PUBLIC_DIR, {
    index: 'index.html',
    extensions: ['html'],
    setHeaders(res, filePath) {
      // The HTML spec's current JS type; Express/mime-types still emits
      // application/javascript. Both work in browsers, but be explicit.
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.js' || ext === '.mjs') {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      }
    },
  })
);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  return res
    .status(404)
    .json({ error: 'Frontend not built yet (app/public/index.html is missing).' });
});

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

app.use((req, res) => {
  res.status(404).json({ error: 'Not found.', code: 'not_found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON body.', code: 'invalid_json' });
  }
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.', code: 'internal_error' });
});

// Non-internal IPv4 addresses of this machine, so the startup log shows the
// exact URLs to open from another device on the same network.
function getLanAddresses() {
  const result = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      const isIpv4 = info.family === 'IPv4' || info.family === 4;
      if (isIpv4 && !info.internal) {
        result.push({ name, address: info.address });
      }
    }
  }
  return result;
}

const server = app.listen(PORT, () => {
  const lanAddresses = getLanAddresses();
  console.log(`[server] Слушаю на http://localhost:${PORT} (локально) и в локальной сети:`);
  if (lanAddresses.length === 0) {
    console.log('[server]   → IPv4-адреса не найдены (нет активных сетевых интерфейсов)');
  } else {
    for (const { name, address } of lanAddresses) {
      console.log(`[server]   → http://${address}:${PORT}  (${name})`);
    }
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `Порт ${PORT} занят. Возможно, сервер уже запущен на http://localhost:${PORT}, ` +
        `либо запусти с другим портом: PORT=${PORT + 1} npm start`
    );
  } else {
    console.error('[server] Failed to start:', err);
  }
  // Nothing is listening, so the event loop drains and Node exits with this
  // code on its own — no stack trace, and stderr is flushed even when piped.
  process.exitCode = 1;
});

module.exports = { app, server };
