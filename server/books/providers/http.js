'use strict';

/**
 * Thin HTTP layer for the metadata providers: timeout, retry/backoff for
 * 429/5xx, Retry-After support. `fetchImpl`/`sleep` are injectable so the unit
 * tests never touch the network.
 */

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;
const BACKOFF_MS = [800, 2000];
const MAX_RETRY_AFTER_MS = 10000;

class ProviderHttpError extends Error {
  constructor(message, code, status, retryAfterMs) {
    super(message);
    this.name = 'ProviderHttpError';
    this.code = code || 'provider_http_error';
    this.status = status == null ? null : Number(status);
    this.retryAfterMs = retryAfterMs == null ? null : Number(retryAfterMs);
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseRetryAfter(response) {
  const raw = response && response.headers && response.headers.get
    ? response.headers.get('retry-after')
    : null;
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
  return null;
}

function backoffFor(attempt) {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
}

/**
 * GET a JSON document with bounded retries.
 * @returns {Promise<object>} parsed JSON body
 */
async function fetchJson(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleep = options.sleep || defaultSleep;
  const retries = Number.isInteger(options.retries) ? options.retries : DEFAULT_RETRIES;
  const headers = {
    accept: 'application/json',
    'user-agent': 'kinoboxd/1.0 (books metadata)',
    ...(options.headers || {}),
  };
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let response = null;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal:
          typeof AbortSignal !== 'undefined' && AbortSignal.timeout
            ? AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS)
            : undefined,
      });
    } catch (err) {
      lastError = new ProviderHttpError(
        `${options.label || 'provider'} network error: ${err.message}`,
        'provider_network_error'
      );
      if (attempt >= retries) throw lastError;
      await sleep(backoffFor(attempt));
      continue;
    }

    if (response.status === 200) {
      try {
        return await response.json();
      } catch (err) {
        lastError = new ProviderHttpError(
          `${options.label || 'provider'} returned non-JSON (HTTP ${response.status})`,
          'provider_bad_response',
          response.status
        );
        if (attempt >= retries) throw lastError;
        await sleep(backoffFor(attempt));
        continue;
      }
    }

    if (response.status === 429 || response.status >= 500) {
      const retryAfterMs = parseRetryAfter(response);
      lastError = new ProviderHttpError(
        `${options.label || 'provider'} HTTP ${response.status}`,
        response.status === 429 ? 'provider_rate_limited' : 'provider_http_error',
        response.status,
        retryAfterMs
      );
      if (attempt >= retries) throw lastError;
      await sleep(retryAfterMs == null ? backoffFor(attempt) : retryAfterMs);
      continue;
    }

    throw new ProviderHttpError(
      `${options.label || 'provider'} HTTP ${response.status}`,
      'provider_http_error',
      response.status
    );
  }

  throw lastError || new ProviderHttpError(`${options.label || 'provider'} failed`, 'provider_error');
}

module.exports = {
  ProviderHttpError,
  DEFAULT_TIMEOUT_MS,
  fetchJson,
  parseRetryAfter,
};
