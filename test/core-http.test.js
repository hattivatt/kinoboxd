'use strict';

/**
 * `core/http.js` — transport + retry contract.
 *
 * No live network: `fetchOnce`/`fetchJson`/`postJson` take an injected
 * `fetchImpl`, and the two `nodeRequest` cases use a throwaway local server on
 * an ephemeral port (never 3000).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  HttpTransportError,
  fetchJson,
  fetchText,
  fetchOnce,
  postJson,
  nodeRequest,
  parseRetryAfter,
  backoffFor,
} = require('../server/core/http');

function jsonResponse(body, status = 200, headers = {}) {
  return {
    status,
    headers: {
      get: (name) => headers[String(name).toLowerCase()] || null,
      getSetCookie: () => [],
    },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    url: 'https://example.test/x',
  };
}

function callsOf() {
  const calls = [];
  const sleeps = [];
  return {
    calls,
    sleeps,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const next = calls.length - 1;
      return calls[next].response;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

test('fetchJson retries 429/5xx with Retry-After and succeeds', async () => {
  const queue = [
    jsonResponse({}, 429, { 'retry-after': '1' }),
    jsonResponse({}, 503),
    jsonResponse({ ok: true }),
  ];
  const calls = [];
  const sleeps = [];
  const fetchImpl = async () => {
    calls.push(1);
    return queue.shift();
  };
  const data = await fetchJson('https://example.test/json', {
    fetchImpl,
    sleep: async (ms) => sleeps.push(ms),
    label: 'test',
  });
  assert.deepEqual(data, { ok: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test('fetchJson gives up after the retry budget with the last transport error', async () => {
  const fetchImpl = async () => jsonResponse({}, 500);
  await assert.rejects(
    () => fetchJson('https://example.test/json', { fetchImpl, sleep: async () => {}, retries: 1, label: 'test' }),
    (err) => err instanceof HttpTransportError && err.code === 'provider_http_error' && err.status === 500
  );
});

test('fetchJson retries a network failure and a non-JSON 200', async () => {
  const queue = [
    () => {
      throw new Error('ECONNRESET');
    },
    () => jsonResponse('<html>not json</html>'),
    () => jsonResponse({ ok: 1 }),
  ];
  let index = 0;
  const fetchImpl = async () => queue[index++]();
  const data = await fetchJson('https://example.test/json', {
    fetchImpl,
    sleep: async () => {},
    retries: 2,
  });
  assert.deepEqual(data, { ok: 1 });
  assert.equal(index, 3);
});

test('fetchJson does not retry a 4xx (except 429)', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse({}, 404);
  };
  await assert.rejects(
    () => fetchJson('https://example.test/json', { fetchImpl, sleep: async () => {}, label: 'test' }),
    (err) => err.status === 404 && err.code === 'provider_http_error'
  );
  assert.equal(calls, 1);
});

test('fetchText returns the body as-is and passes the redirect mode through', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(options.redirect);
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => '<html>ok</html>',
      url,
    };
  };
  const body = await fetchText('https://example.test/html', {
    fetchImpl,
    redirect: 'manual',
    sleep: async () => {},
  });
  assert.equal(body, '<html>ok</html>');
  assert.deepEqual(seen, ['manual']);
});

test('fetchOnce caps the body when maxBytes is given', async () => {
  const fetchImpl = async () => jsonResponse('0123456789');
  await assert.rejects(
    () => fetchOnce('https://example.test/x', { fetchImpl, maxBytes: 5, label: 'test' }),
    (err) => err.code === 'response_too_large'
  );
});

test('postJson sends a POST with a JSON body', async () => {
  let request = null;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return jsonResponse({ data: 1 });
  };
  const data = await postJson(
    'https://example.test/graphql',
    { query: '{ x }' },
    { fetchImpl, headers: { authorization: 'Bearer ***' }, sleep: async () => {} }
  );
  assert.deepEqual(data, { data: 1 });
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.body, '{"query":"{ x }"}');
  assert.equal(request.options.headers.authorization, 'Bearer ***');
});

test('parseRetryAfter and backoffFor share the documented bounds', () => {
  assert.equal(parseRetryAfter({ headers: { get: () => '2' } }), 2000);
  assert.equal(parseRetryAfter({ headers: { get: () => null } }), null);
  assert.equal(parseRetryAfter({ headers: { get: () => 'nonsense' } }), null);
  assert.equal(backoffFor(0), 800);
  assert.equal(backoffFor(1), 2000);
  assert.equal(backoffFor(9), 2000);
});

test('nodeRequest follows redirects and reports a refused connection', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/final' });
      res.end('Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await nodeRequest(`http://127.0.0.1:${port}/start`, { maxRedirects: 3 });
    assert.equal(response.status, 200);
    assert.equal(response.body, 'ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  await assert.rejects(
    () => nodeRequest('http://127.0.0.1:1/', { timeoutMs: 2000 }),
    (err) => err.code === 'network_error'
  );
});

test('nodeRequest reports too many redirects and an invalid URL', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(302, { Location: '/again' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await assert.rejects(
      () => nodeRequest(`http://127.0.0.1:${port}/loop`, { maxRedirects: 1 }),
      (err) => err.code === 'too_many_redirects'
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  await assert.rejects(
    () => nodeRequest('not a url', {}),
    (err) => err.code === 'invalid_url'
  );
});
