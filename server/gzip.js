'use strict';

/**
 * The single gzip layer of the server (U11).
 *
 * History: `compression()` was mounted app-wide and a second, hand-written
 * zlib middleware (`server/gzip.js`) covered only `/api/games` — with a
 * `skipPrefix` filter that had to keep the two away from each other. That is
 * now one middleware: `app.use(gzip())` compresses everything (heavy JSON,
 * static JS/CSS, the SPA HTML) and the per-prefix table below is the single
 * place where threshold/level are tuned. A response is compressed exactly
 * once because there is only one layer.
 *
 * How it works (`zlib.gzip`'s one-shot form; the payloads are fully buffered
 * by `res.json`, so streaming would only add complexity):
 *
 *   - only when the client sent `Accept-Encoding: gzip` (q-values honoured,
 *     `gzip;q=0` means no);
 *   - only for compressible bodies (JSON/text/svg) at least `threshold` bytes;
 *   - `HEAD`, `204`/`304`, `Cache-Control: no-transform`, an already-encoded
 *     response and empty bodies pass through untouched;
 *   - the identity body is buffered up to `maxBuffer` bytes; past that the
 *     middleware gives up and flushes the buffered bytes uncompressed (a huge
 *     response must never be lost or reordered);
 *   - sets `Content-Encoding: gzip`, `Vary: Accept-Encoding` and the
 *     compressed `Content-Length`; `ETag` (weak, Express default) stays.
 */

const zlib = require('zlib');

const COMPRESSIBLE = /^(?:application\/(?:json|javascript|x-ndjson)|text\/|image\/svg\+xml)/i;
const DEFAULT_THRESHOLD = 1024;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_LEVEL = 6;

/**
 * Prefix → { threshold, level }. The first match wins, so a specific path
 * must come before its namespace (`/api/books/stats` before `/api/books`).
 *
 * All entries currently share the same numbers (that is the behaviour the
 * frozen smoke/golden numbers were measured with); the table exists so a
 * heavy payload can be tuned in one place instead of adding another layer.
 */
const PREFIX_RULES = Object.freeze([
  Object.freeze({ prefix: '/api/stats', threshold: DEFAULT_THRESHOLD, level: DEFAULT_LEVEL }),
  Object.freeze({ prefix: '/api/books/stats', threshold: DEFAULT_THRESHOLD, level: DEFAULT_LEVEL }),
  Object.freeze({ prefix: '/api/games/stats', threshold: DEFAULT_THRESHOLD, level: DEFAULT_LEVEL }),
  Object.freeze({ prefix: '/api/games', threshold: DEFAULT_THRESHOLD, level: DEFAULT_LEVEL }),
]);

const DEFAULT_RULE = Object.freeze({
  prefix: '*',
  threshold: DEFAULT_THRESHOLD,
  level: DEFAULT_LEVEL,
});

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

/** Path of the request without the query string (`originalUrl` wins). */
function requestPath(req) {
  const raw = String((req && req.originalUrl) || (req && req.url) || '');
  const query = raw.indexOf('?');
  return query === -1 ? raw : raw.slice(0, query);
}

/** `/api/stats` matches itself and its sub-paths, never `/api/statsfoo`. */
function matchesPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The rule of the prefix table that applies to this request. */
function ruleFor(req) {
  const pathname = requestPath(req);
  for (const rule of PREFIX_RULES) {
    if (matchesPrefix(pathname, rule.prefix)) return rule;
  }
  return DEFAULT_RULE;
}

/** `Cache-Control: no-transform` means "do not touch the body". */
function noTransform(res) {
  const value = String(res.getHeader('Cache-Control') || '');
  return /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(value);
}

/**
 * Create the middleware.
 *
 * `threshold`/`level` override the prefix table for every request (tests and
 * diagnostics); `maxBuffer` is the identity buffer limit.
 */
function createGzipMiddleware(options = {}) {
  const hasThreshold = options.threshold !== undefined && Number(options.threshold) >= 0;
  const forcedThreshold = hasThreshold ? Number(options.threshold) : null;
  const forcedLevel = Number.isInteger(options.level) ? options.level : null;
  const maxBuffer =
    Number.isFinite(Number(options.maxBuffer)) && Number(options.maxBuffer) > 0
      ? Number(options.maxBuffer)
      : DEFAULT_MAX_BUFFER;

  return function gzipMiddleware(req, res, next) {
    if (req.method === 'HEAD' || !acceptsGzip(req.headers['accept-encoding'])) return next();
    if (res.getHeader('Content-Encoding') || noTransform(res)) return next();

    const rule = ruleFor(req);
    const threshold = forcedThreshold != null ? forcedThreshold : rule.threshold;
    const level = forcedLevel != null ? forcedLevel : rule.level;

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
module.exports.requestPath = requestPath;
module.exports.matchesPrefix = matchesPrefix;
module.exports.ruleFor = ruleFor;
module.exports.PREFIX_RULES = PREFIX_RULES;
module.exports.DEFAULT_RULE = DEFAULT_RULE;
module.exports.DEFAULT_THRESHOLD = DEFAULT_THRESHOLD;
module.exports.DEFAULT_MAX_BUFFER = DEFAULT_MAX_BUFFER;
module.exports.DEFAULT_LEVEL = DEFAULT_LEVEL;
