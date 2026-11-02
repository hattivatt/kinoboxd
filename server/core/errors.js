'use strict';

/**
 * HTTP errors and response helpers shared by every router.
 *
 * `HttpError` used to live in `server/upload.js`, so every router imported the
 * ZIP parser just to throw a 400. It is defined here; `upload.js` re-exports it
 * while the remaining importers migrate.
 *
 * Contract:
 *   - `status` is the HTTP status, `code` a stable machine token
 *     (`unexpected_parameter`, `profile_required`, ...). The client renders
 *     `message` and switches on `code`.
 *   - The error body is always `{ error, code }`.
 *   - A domain error that is not an `HttpError` is returned unchanged by
 *     `fromStatus`, so the central middleware logs it as a 500 and never
 *     leaks an internal message.
 */

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

function isHttpError(err) {
  return err instanceof HttpError;
}

/**
 * Wrap an error that already carries an explicit status (`err.status`) into an
 * `HttpError`. Job starters throw such plain errors instead of importing the
 * HTTP layer.
 */
function fromStatus(err, fallbackCode = 'error') {
  if (err instanceof HttpError) return err;
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) {
    return new HttpError(err.status, err.message, err.code || fallbackCode);
  }
  return err;
}

/** Send one error response in the documented shape. */
function respondError(res, err) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error('[server] Unhandled error:', err);
  return res.status(500).json({ error: 'Internal server error.', code: 'internal_error' });
}

/** Express error middleware: the last handler mounted in `server/index.js`. */
function errorMiddleware(err, req, res, next) {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON body.', code: 'invalid_json' });
  }
  return respondError(res, err);
}

module.exports = {
  HttpError,
  isHttpError,
  fromStatus,
  respondError,
  errorMiddleware,
};
