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
const config = require('./config');
const { buildStats } = require('./stats');

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
