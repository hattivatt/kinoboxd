'use strict';

/**
 * One HTTP client for every metadata source.
 *
 * Two transports live here and nowhere else:
 *
 *   - `fetchOnce` — the `fetch` path. It is the right one for sources that
 *     need a cookie jar and manual redirect hops (`books/livelib`, `kp`), for
 *     a POST body (`wikidata` SPARQL, `hardcover` GraphQL) and for anything
 *     that is tested by injecting `fetchImpl`. `fetchImpl` is resolved at
 *     CALL time, so a test that replaces `global.fetch` is honoured.
 *   - `nodeRequest` — the `node:http(s)` path. It is the only one that can use
 *     a custom DNS resolver (`lookup`), which Steam needs
 *     (`GAMES_STEAM_DNS_SERVERS`), and it caps the body while streaming. It
 *     reproduces the redirect/limit semantics the games sources had.
 *
 * On top of those, `fetchJson` / `fetchText` / `postJson` add the shared retry
 * policy (bounded retries for 429/5xx, `Retry-After` support). Sources whose
 * retry policy is genuinely different (TMDB's 4 transport retries + 5 rate
 * limit retries, WDQS' 8 attempts, Hardcover's rate gate) keep their own loop
 * but call `fetchOnce`/`nodeRequest`, so no module outside this file opens a
 * socket.
 *
 * Per-source politeness (pause, budget, breaker, TTL) is declared in
 * `server/core/sources.js`; this module only owns one request.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;
const BACKOFF_MS = [800, 2000];
const MAX_RETRY_AFTER_MS = 10000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_USER_AGENT = 'kinoboxd/1.0 (metadata)';

/** Transport failure with a stable code and the HTTP status when there was one. */
class HttpTransportError extends Error {
  constructor(message, code, status, retryAfterMs, cause) {
    super(message);
    this.name = 'ProviderHttpError';
    this.code = code || 'provider_http_error';
    this.status = status == null ? null : Number(status);
    this.retryAfterMs = retryAfterMs == null ? null : Number(retryAfterMs);
    if (cause) this.cause = cause;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function headerOf(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return value == null ? null : value;
  }
  const lower = String(name).toLowerCase();
  if (headers instanceof Map) return headers.get(lower) || headers.get(name) || null;
  if (typeof headers === 'object') return headers[lower] || headers[name] || null;
  return null;
}

function parseRetryAfter(response, maxMs = MAX_RETRY_AFTER_MS) {
  const raw = headerOf(response && response.headers, 'retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, maxMs);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), maxMs);
  return null;
}

function backoffFor(attempt) {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
}

/** Default UA only when the caller did not supply one under any casing. */
function withUserAgent(headers, userAgent) {
  const out = { ...(headers || {}) };
  const has = Object.keys(out).some((name) => name.toLowerCase() === 'user-agent');
  if (!has) out['user-agent'] = userAgent || DEFAULT_USER_AGENT;
  return out;
}

function byteLength(text) {
  return Buffer.byteLength(String(text == null ? '' : text), 'utf8');
}

/**
 * One `fetch` request. Returns `{ status, headers, body, url, response }`
 * with the body already read as text.
 *
 * Options: `fetchImpl`, `method`, `headers`, `body`, `redirect`
 * (`'follow'` default, `'manual'` returns the 3xx answer), `timeoutMs`,
 * `userAgent`, `maxBytes`, `label`.
 */
async function fetchOnce(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const label = options.label || 'provider';
  if (typeof fetchImpl !== 'function') {
    throw new HttpTransportError(`${label} fetch is not available`, 'provider_unavailable');
  }
  const headers = withUserAgent(options.headers, options.userAgent);
  const init = {
    method: options.method || 'GET',
    headers,
    redirect: options.redirect === 'manual' ? 'manual' : 'follow',
  };
  if (options.body != null) init.body = options.body;
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    init.signal = AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  }

  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (err) {
    throw new HttpTransportError(`${label} network error: ${err.message}`, 'provider_network_error', null, null, err);
  }

  let body;
  try {
    if (typeof response.text === 'function') {
      body = await response.text();
    } else if (typeof response.json === 'function') {
      // Test doubles in the tree expose `json()` only; normalise them here so
      // the transport stays the single reader of a response.
      body = JSON.stringify(await response.json());
    } else {
      body = '';
    }
  } catch (err) {
    throw new HttpTransportError(
      `${label} could not read the response body (HTTP ${response.status})`,
      'provider_bad_response',
      response.status,
      null,
      err
    );
  }
  const maxBytes = options.maxBytes == null ? null : Number(options.maxBytes);
  if (maxBytes != null && byteLength(body) > maxBytes) {
    throw new HttpTransportError(
      `${label} response is larger than ${maxBytes} bytes`,
      'response_too_large',
      response.status
    );
  }
  return {
    status: Number(response.status) || 0,
    headers: response.headers,
    body,
    url: response.url || url,
    response,
  };
}

/**
 * One `node:http(s)` request with streaming body cap and optional manual
 * redirects. Returns the same shape as `fetchOnce`.
 *
 * Options: `method`, `headers`, `body`, `timeoutMs`, `lookup`, `maxBytes`,
 * `followRedirect` (default true), `maxRedirects` (default 0), `label`.
 *
 * Error codes: `invalid_url`, `network_error`, `timeout`, `response_too_large`,
 * `too_many_redirects`.
 */
function nodeRequest(target, options = {}) {
  const label = options.label || 'provider';
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const redirectsLeft = options.maxRedirects == null ? 0 : Number(options.maxRedirects);
  const followRedirect = options.followRedirect !== false;
  const maxBytes = options.maxBytes == null ? DEFAULT_MAX_BYTES : Number(options.maxBytes);
  const method = options.method || 'GET';

  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(target);
    } catch (err) {
      reject(new HttpTransportError(`${label} invalid URL`, 'invalid_url', null, null, err));
      return;
    }
    const lib = parsed.protocol === 'http:' ? http : https;
    const headers = withUserAgent(
      {
        Accept: 'application/json, text/xml, application/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(options.headers || {}),
      },
      options.userAgent
    );
    const requestOptions = { method, headers };
    if (options.lookup) requestOptions.lookup = options.lookup;
    if (timeoutMs) requestOptions.timeout = timeoutMs;

    let req;
    try {
      req = lib.request(parsed, requestOptions, (res) => {
        const status = Number(res.statusCode) || 0;
        const location = res.headers && res.headers.location;
        if (followRedirect && status >= 300 && status < 400 && location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new HttpTransportError(`${label} too many redirects`, 'too_many_redirects', status));
            return;
          }
          let next;
          try {
            next = new URL(location, parsed).href;
          } catch (err) {
            reject(new HttpTransportError(`${label} invalid redirect`, 'too_many_redirects', status, null, err));
            return;
          }
          resolve(
            nodeRequest(next, {
              ...options,
              maxRedirects: redirectsLeft - 1,
              lookup: options.lookup,
            })
          );
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(
              new HttpTransportError(`${label} response is larger than ${maxBytes} bytes`, 'response_too_large', status)
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            status,
            headers: res.headers || {},
            body: Buffer.concat(chunks).toString('utf8'),
            url: target,
          });
        });
        res.on('error', (err) => {
          reject(new HttpTransportError(`${label} network error: ${err.message}`, 'network_error', status, null, err));
        });
      });
    } catch (err) {
      reject(new HttpTransportError(`${label} network error: ${err.message}`, 'network_error', null, null, err));
      return;
    }
    req.on('timeout', () => {
      req.destroy(
        new HttpTransportError(`${label} timeout after ${timeoutMs} ms`, 'timeout', null, null, {
          code: 'ETIMEDOUT',
        })
      );
    });
    req.on('error', (err) => {
      if (err instanceof HttpTransportError) {
        reject(err);
        return;
      }
      reject(new HttpTransportError(`${label} network error: ${err.message}`, 'network_error', null, null, err));
    });
    if (options.body != null) req.write(String(options.body));
    req.end();
  });
}

/**
 * GET a JSON document with bounded retries.
 * @returns {Promise<object>} parsed JSON body
 */
async function fetchJson(url, options = {}) {
  const sleep = options.sleep || defaultSleep;
  const retries = Number.isInteger(options.retries) ? options.retries : DEFAULT_RETRIES;
  const label = options.label || 'provider';
  const headers = withUserAgent(
    {
      accept: 'application/json',
      ...(options.headers || {}),
    },
    options.userAgent
  );
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let response = null;
    try {
      response = await fetchOnce(url, {
        fetchImpl: options.fetchImpl,
        method: 'GET',
        headers,
        redirect: options.redirect || 'follow',
        timeoutMs: options.timeoutMs,
        label,
      });
    } catch (err) {
      lastError = new HttpTransportError(`${label} network error: ${err.message}`, 'provider_network_error', err.status, err.retryAfterMs, err);
      if (attempt >= retries) throw lastError;
      await sleep(backoffFor(attempt));
      continue;
    }

    if (response.status === 200) {
      try {
        return JSON.parse(response.body);
      } catch (err) {
        lastError = new HttpTransportError(
          `${label} returned non-JSON (HTTP ${response.status})`,
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
      lastError = new HttpTransportError(
        `${label} HTTP ${response.status}`,
        response.status === 429 ? 'provider_rate_limited' : 'provider_http_error',
        response.status,
        retryAfterMs
      );
      if (attempt >= retries) throw lastError;
      await sleep(retryAfterMs == null ? backoffFor(attempt) : retryAfterMs);
      continue;
    }

    throw new HttpTransportError(`${label} HTTP ${response.status}`, 'provider_http_error', response.status);
  }

  throw lastError || new HttpTransportError(`${label} failed`, 'provider_error');
}

/**
 * GET a text document (HTML/XML/SPARQL results) with the same retry policy as
 * `fetchJson`. Returns the body as-is.
 */
async function fetchText(url, options = {}) {
  const sleep = options.sleep || defaultSleep;
  const retries = Number.isInteger(options.retries) ? options.retries : DEFAULT_RETRIES;
  const label = options.label || 'provider';
  const headers = withUserAgent(
    {
      accept: options.accept || 'text/html, application/xml, text/xml, */*',
      ...(options.headers || {}),
    },
    options.userAgent
  );
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let response = null;
    try {
      response = await fetchOnce(url, {
        fetchImpl: options.fetchImpl,
        method: 'GET',
        headers,
        redirect: options.redirect || 'follow',
        timeoutMs: options.timeoutMs,
        label,
      });
    } catch (err) {
      lastError = new HttpTransportError(`${label} network error: ${err.message}`, 'provider_network_error', err.status, err.retryAfterMs, err);
      if (attempt >= retries) throw lastError;
      await sleep(backoffFor(attempt));
      continue;
    }

    if (response.status === 200) return response.body;

    if (response.status === 429 || response.status >= 500) {
      const retryAfterMs = parseRetryAfter(response);
      lastError = new HttpTransportError(
        `${label} HTTP ${response.status}`,
        response.status === 429 ? 'provider_rate_limited' : 'provider_http_error',
        response.status,
        retryAfterMs
      );
      if (attempt >= retries) throw lastError;
      await sleep(retryAfterMs == null ? backoffFor(attempt) : retryAfterMs);
      continue;
    }

    throw new HttpTransportError(`${label} HTTP ${response.status}`, 'provider_http_error', response.status);
  }

  throw lastError || new HttpTransportError(`${label} failed`, 'provider_error');
}

/**
 * POST a JSON document and parse a JSON answer with the retry policy of
 * `fetchJson`.
 */
async function postJson(url, payload, options = {}) {
  const sleep = options.sleep || defaultSleep;
  const retries = Number.isInteger(options.retries) ? options.retries : DEFAULT_RETRIES;
  const label = options.label || 'provider';
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload == null ? {} : payload);
  const headers = withUserAgent(
    {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    options.userAgent
  );
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let response = null;
    try {
      response = await fetchOnce(url, {
        fetchImpl: options.fetchImpl,
        method: 'POST',
        headers,
        body,
        redirect: options.redirect || 'follow',
        timeoutMs: options.timeoutMs,
        label,
      });
    } catch (err) {
      lastError = new HttpTransportError(`${label} network error: ${err.message}`, 'provider_network_error', err.status, err.retryAfterMs, err);
      if (attempt >= retries) throw lastError;
      await sleep(backoffFor(attempt));
      continue;
    }

    if (response.status === 200) {
      try {
        return JSON.parse(response.body);
      } catch (err) {
        lastError = new HttpTransportError(
          `${label} returned non-JSON (HTTP ${response.status})`,
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
      lastError = new HttpTransportError(
        `${label} HTTP ${response.status}`,
        response.status === 429 ? 'provider_rate_limited' : 'provider_http_error',
        response.status,
        retryAfterMs
      );
      if (attempt >= retries) throw lastError;
      await sleep(retryAfterMs == null ? backoffFor(attempt) : retryAfterMs);
      continue;
    }

    throw new HttpTransportError(`${label} HTTP ${response.status}`, 'provider_http_error', response.status);
  }

  throw lastError || new HttpTransportError(`${label} failed`, 'provider_error');
}

/**
 * Bind the defaults of one source (`label`, headers, timeouts, injections).
 * Every method still accepts per-call overrides.
 */
function createHttpClient(defaults = {}) {
  return {
    fetchJson: (url, options = {}) => fetchJson(url, { ...defaults, ...options }),
    fetchText: (url, options = {}) => fetchText(url, { ...defaults, ...options }),
    postJson: (url, payload, options = {}) => postJson(url, payload, { ...defaults, ...options }),
    request: (url, options = {}) => fetchOnce(url, { ...defaults, ...options }),
    nodeRequest: (url, options = {}) => nodeRequest(url, { ...defaults, ...options }),
    parseRetryAfter,
  };
}

/**
 * One `fetch` request whose body is read as bytes (art relays, binary
 * downloads). Returns `{ status, headers, buffer, url, response }`.
 */
async function fetchBinary(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const label = options.label || 'provider';
  if (typeof fetchImpl !== 'function') {
    throw new HttpTransportError(`${label} fetch is not available`, 'provider_unavailable');
  }
  const headers = withUserAgent(options.headers, options.userAgent);
  const init = {
    method: options.method || 'GET',
    headers,
    redirect: options.redirect === 'manual' ? 'manual' : 'follow',
  };
  if (options.body != null) init.body = options.body;
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    init.signal = AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  }
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (err) {
    throw new HttpTransportError(`${label} network error: ${err.message}`, 'provider_network_error', null, null, err);
  }
  let buffer;
  try {
    if (typeof response.arrayBuffer === 'function') {
      buffer = Buffer.from(await response.arrayBuffer());
    } else if (typeof response.text === 'function') {
      buffer = Buffer.from(await response.text(), 'utf8');
    } else {
      buffer = Buffer.alloc(0);
    }
  } catch (err) {
    throw new HttpTransportError(
      `${label} could not read the response body (HTTP ${response.status})`,
      'provider_bad_response',
      response.status,
      null,
      err
    );
  }
  const maxBytes = options.maxBytes == null ? null : Number(options.maxBytes);
  if (maxBytes != null && buffer.length > maxBytes) {
    throw new HttpTransportError(
      `${label} response is larger than ${maxBytes} bytes`,
      'response_too_large',
      response.status
    );
  }
  return {
    status: Number(response.status) || 0,
    headers: response.headers,
    buffer,
    url: response.url || url,
    response,
  };
}

/**
 * Adapt a `fetchOnce` result to the small `Response` surface the legacy
 * SPARQL clients pass to their callers (`ok`, `status`, `headers`,
 * `text()`, `json()`). Used where a module owns its own retry loop but must
 * stop opening sockets itself.
 */
function responseFacade(result) {
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    headers: result.headers,
    url: result.url,
    body: result.body,
    text: async () => result.body,
    json: async () => JSON.parse(result.body),
  };
}

module.exports = {
  HttpTransportError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES,
  BACKOFF_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_USER_AGENT,
  parseRetryAfter,
  backoffFor,
  fetchOnce,
  nodeRequest,
  fetchJson,
  fetchText,
  postJson,
  fetchBinary,
  createHttpClient,
  defaultSleep,
  headerOf,
  responseFacade,
};
