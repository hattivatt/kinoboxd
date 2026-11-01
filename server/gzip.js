'use strict';

/**
 * Hand-written gzip middleware for the heavy JSON payloads (`/api/games/*`).
 *
 * Why not just `compression()` everywhere: the games stats payload is ~200 KB
 * of JSON (the `gamesIndex` alone is ~88% of it) and is the single biggest
 * transfer on the tab; the brief for M4 asks for an explicit, dependency-free
 * gzip layer with a measured ratio. This module does exactly that with
 * `zlib.createGzip`'s one-shot sibling `zlib.gzip` (the payloads are fully
 * buffered by `res.json`, so streaming would only add complexity):
 *
 *   - only when the client sent `Accept-Encoding: gzip` (q-values honoured,
 *     `gzip;q=0` means no);
 *   - only for compressible bodies (JSON/text/svg) at least `threshold` bytes;
 *   - `HEAD`, `204`/`304`, an already-encoded response and empty bodies pass
 *     through untouched;
 *   - the identity body is buffered up to `maxBuffer` bytes; past that the
 *     middleware gives up and flushes the buffered bytes uncompressed (a huge
 *     response must never be lost or reordered);
 *   - sets `Content-Encoding: gzip`, `Vary: Accept-Encoding` and the
 *     compressed `Content-Length`; `ETag` (weak, Express default) stays.
 *
 * `compression()` keeps serving every other path — this middleware is mounted
 * on `/api/games` and `compression` is filtered away from that prefix, so a
 * response is never compressed twice.
 */

const zlib = require('zlib');

const COMPRESSIBLE = /^(?:application\/(?:json|javascript|x-ndjson)|text\/|image\/svg\+xml)/i;
const DEFAULT_THRESHOLD = 1024;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/** Does `Accept-Encoding` allow gzip? `*` counts, `q=0` does not. */
function acceptsGzip(header) {
  const value = String(header == null ? '' : header);
  if (!value) return false;
  for (const part of value.split(',')) {
    const pieces = part.trim().split(';');
    const name = String(pieces[0] || '').trim().toLowerCase();
    if (name !== 'gzip' && name !== '*') continue;
    let q = 1;
    for (const parameter of pieces.slice(1)) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(parameter);
      if (match) q = Number(match[1]);
    }
    if (Number.isFinite(q) && q > 0) return true;
  }
  return false;
}

function appendVary(current, value) {
  const existing = String(current == null ? '' : current)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!existing.some((entry) => entry.toLowerCase() === value.toLowerCase())) {
    existing.push(value);
  }
  return existing.join(', ');
}

/**
 * Wrap another compression filter so it never runs for `prefix`.
 *
 * `compression()` is mounted app-wide, this middleware only on `/api/games`;
 * without the wrapper a games response would be compressed twice (gzip of
 * gzip), which no client can read. `originalUrl` is used because Express
 * rewrites `req.url` inside mounted routers.
 */
function skipPrefix(prefix, filter) {
  return function filtered(req, res) {
    if (String((req && req.originalUrl) || '').startsWith(prefix)) return false;
    return typeof filter === 'function' ? filter(req, res) : true;
  };
}

/**
 * Create the middleware.
 *
 *   threshold — minimum identity body size to compress (default 1 KB)
 *   level     — zlib level (default zlib's default, 6)
 *   maxBuffer — identity bytes buffered before falling back to identity
 */
function createGzipMiddleware(options = {}) {
  const threshold =
    Number.isFinite(Number(options.threshold)) && Number(options.threshold) >= 0
      ? Number(options.threshold)
      : DEFAULT_THRESHOLD;
  const level = Number.isInteger(options.level) ? options.level : zlib.constants.Z_DEFAULT_COMPRESSION;
  const maxBuffer =
    Number.isFinite(Number(options.maxBuffer)) && Number(options.maxBuffer) > 0
      ? Number(options.maxBuffer)
      : DEFAULT_MAX_BUFFER;

  return function gzipMiddleware(req, res, next) {
    if (req.method === 'HEAD' || !acceptsGzip(req.headers['accept-encoding'])) return next();
    if (res.getHeader('Content-Encoding')) return next();

    const originalWrite = res.write;
    const originalEnd = res.end;
    const chunks = [];
    let size = 0;
    let buffering = true;

    function collect(chunk, encoding) {
      if (chunk == null || !buffering) return;
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
      chunks.push(buffer);
      size += buffer.length;
      if (size > maxBuffer) {
        // Too large to hold: replay what we have and stop intercepting. The
        // headers are still unsent, so this is safe and ordered.
        res.write = originalWrite;
        res.end = originalEnd;
        buffering = false;
        for (const buffered of chunks) originalWrite.call(res, buffered);
        chunks.length = 0;
      }
    }

    res.write = function write(chunk, encoding, callback) {
      let cb = callback;
      let enc = encoding;
      if (typeof enc === 'function') {
        cb = enc;
        enc = undefined;
      }
      if (!buffering) return originalWrite.call(res, chunk, enc, cb);
      collect(chunk, enc);
      if (!buffering) return true;
      if (cb) process.nextTick(cb);
      return true;
    };

    res.end = function end(chunk, encoding, callback) {
      let body = chunk;
      let cb = callback;
      let enc = encoding;
      if (typeof body === 'function') {
        cb = body;
        body = null;
        enc = undefined;
      } else if (typeof enc === 'function') {
        cb = enc;
        enc = undefined;
      }
      if (!buffering) return originalEnd.call(res, body, enc, cb);
      collect(body, enc);
      if (!buffering) {
        // `collect` hit `maxBuffer`: everything (including this final chunk)
        // was already written uncompressed; just finish the response.
        res.write = originalWrite;
        res.end = originalEnd;
        return originalEnd.call(res, null, cb);
      }
      res.write = originalWrite;
      res.end = originalEnd;
      const payload = Buffer.concat(chunks);
      chunks.length = 0;
      buffering = false;

      const status = Number(res.statusCode) || 200;
      const contentType = String(res.getHeader('Content-Type') || '');
      const skip =
        payload.length < threshold ||
        status === 204 ||
        status === 304 ||
        (contentType !== '' && !COMPRESSIBLE.test(contentType));
      if (skip) return originalEnd.call(res, payload, cb);

      zlib.gzip(payload, { level }, (err, zipped) => {
        if (err || !zipped || !zipped.length) {
          return originalEnd.call(res, payload, cb);
        }
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', appendVary(res.getHeader('Vary'), 'Accept-Encoding'));
        res.setHeader('Content-Length', zipped.length);
        return originalEnd.call(res, zipped, cb);
      });
      return undefined;
    };

    res.on('close', () => {
      // Client went away before the body was flushed: drop the buffers.
      if (buffering) {
        chunks.length = 0;
        buffering = false;
      }
    });

    next();
  };
}

module.exports = createGzipMiddleware;
module.exports.createGzipMiddleware = createGzipMiddleware;
module.exports.acceptsGzip = acceptsGzip;
module.exports.appendVary = appendVary;
module.exports.skipPrefix = skipPrefix;
module.exports.DEFAULT_THRESHOLD = DEFAULT_THRESHOLD;
module.exports.DEFAULT_MAX_BUFFER = DEFAULT_MAX_BUFFER;
