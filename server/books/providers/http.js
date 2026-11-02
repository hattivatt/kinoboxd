'use strict';

/**
 * Facade over `server/core/http.js`.
 *
 * The transport (timeout, retry/backoff for 429/5xx, Retry-After, injectable
 * `fetchImpl`/`sleep`) is shared with the games sources now; the provider
 * modules and their tests keep importing it from here.
 */

const {
  HttpTransportError,
  DEFAULT_TIMEOUT_MS,
  fetchJson,
  parseRetryAfter,
  defaultSleep,
} = require('../../core/http');

module.exports = {
  ProviderHttpError: HttpTransportError,
  DEFAULT_TIMEOUT_MS,
  fetchJson,
  parseRetryAfter,
  defaultSleep,
};
