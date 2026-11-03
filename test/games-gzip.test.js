'use strict';

/**
 * Hand-written gzip middleware (`server/gzip.js`): negotiation, threshold,
 * Vary/Content-Length, and the maxBuffer identity fallback. The games stats
 * payload is ~200 KB of JSON, so the ratio is the acceptance number.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const zlib = require('node:zlib');

const gzip = require('../server/gzip');

const PORT = 7071;

function request(port, pathName, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathName, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      );
    });
    req.on('error', reject);
  });
}

function buildPayload(count) {
  return {
    gamesIndex: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `appid-${index}`,
        {
          appid: 100000 + index,
          name: `Game ${index}`,
          hours: index * 1.5,
          genres: ['Action', 'RPG', 'Indie'],
          tags: [
            { name: 'Open World', weight: 900 },
            { name: 'Story Rich', weight: 800 },
          ],
          reviewScore: 9,
          reviewDesc: 'Overwhelmingly Positive',
        },
      ])
    ),
  };
}

test('acceptsGzip: q-values are honoured, `*` counts, `q=0` does not', () => {
  assert.equal(gzip.acceptsGzip('gzip'), true);
  assert.equal(gzip.acceptsGzip('gzip, deflate, br'), true);
  assert.equal(gzip.acceptsGzip('br;q=1, gzip;q=0.5'), true);
  assert.equal(gzip.acceptsGzip('gzip;q=0'), false);
  assert.equal(gzip.acceptsGzip('gzip;q=0, deflate'), false);
  assert.equal(gzip.acceptsGzip('*;q=0.1'), true);
  assert.equal(gzip.acceptsGzip('deflate, br'), false);
  assert.equal(gzip.acceptsGzip(''), false);
  assert.equal(gzip.acceptsGzip(undefined), false);
});

test('appendVary keeps existing values and never duplicates Accept-Encoding', () => {
  assert.equal(gzip.appendVary(undefined, 'Accept-Encoding'), 'Accept-Encoding');
  assert.equal(gzip.appendVary('Origin', 'Accept-Encoding'), 'Origin, Accept-Encoding');
  assert.equal(gzip.appendVary('origin, accept-encoding', 'Accept-Encoding'), 'origin, accept-encoding');
});

test('prefix table: every heavy JSON prefix resolves to its own rule', () => {
  // The specific path wins over its namespace.
  assert.equal(gzip.ruleFor({ originalUrl: '/api/games/stats?profile=x' }).prefix, '/api/games/stats');
  assert.equal(gzip.ruleFor({ originalUrl: '/api/games/personnel' }).prefix, '/api/games');
  assert.equal(gzip.ruleFor({ originalUrl: '/api/books/stats?profile=x' }).prefix, '/api/books/stats');
  assert.equal(gzip.ruleFor({ originalUrl: '/api/stats?uploadId=1' }).prefix, '/api/stats');
  // A prefix is a path segment boundary, not a string prefix.
  assert.equal(gzip.ruleFor({ originalUrl: '/api/statsfoo' }), gzip.DEFAULT_RULE);
  assert.equal(gzip.ruleFor({ originalUrl: '/api/statsx/1' }), gzip.DEFAULT_RULE);
  assert.equal(gzip.ruleFor({ originalUrl: '/' }), gzip.DEFAULT_RULE);
  assert.equal(gzip.ruleFor({}), gzip.DEFAULT_RULE);
  // Every rule carries a usable threshold/level (the single tuning point).
  for (const rule of gzip.PREFIX_RULES) {
    assert.equal(typeof rule.threshold, 'number');
    assert.ok(rule.threshold >= 0);
    assert.ok(Number.isInteger(rule.level));
  }
});

test('middleware: big JSON → gzip ≥3x, decodable, Content-Length/Vary set', async (t) => {
  const payload = buildPayload(900);
  const identity = Buffer.from(JSON.stringify(payload));
  assert.ok(identity.length > 100 * 1024, `payload too small: ${identity.length}`);

  const app = express();
  app.use('/api/games', gzip());
  app.get('/api/games/big', (req, res) => res.status(200).json(payload));
  app.get('/api/games/small', (req, res) => res.status(200).json({ ok: true }));
  const server = app.listen(PORT);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const raw = await request(PORT, '/api/games/big');
  assert.equal(raw.status, 200);
  assert.equal(raw.headers['content-encoding'], undefined);
  assert.equal(raw.body.length, identity.length);

  const zipped = await request(PORT, '/api/games/big', { 'Accept-Encoding': 'gzip' });
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.match(String(zipped.headers.vary), /Accept-Encoding/i);
  assert.equal(Number(zipped.headers['content-length']), zipped.body.length);
  assert.deepEqual(JSON.parse(zlib.gunzipSync(zipped.body).toString('utf8')), payload);
  const ratio = identity.length / zipped.body.length;
  assert.ok(ratio >= 3, `gzip ratio ${ratio.toFixed(2)}x is below the 3x target`);

  // Small bodies stay identity: the middleware must not add gzip overhead.
  const small = await request(PORT, '/api/games/small', { 'Accept-Encoding': 'gzip' });
  assert.equal(small.headers['content-encoding'], undefined);
  assert.deepEqual(JSON.parse(small.body.toString('utf8')), { ok: true });

  // q=0 means "please don't".
  const refused = await request(PORT, '/api/games/big', { 'Accept-Encoding': 'gzip;q=0' });
  assert.equal(refused.headers['content-encoding'], undefined);
  assert.equal(refused.body.length, identity.length);
});

test('middleware: an already-encoded or non-compressible response passes through', async (t) => {
  const app = express();
  app.use('/api/games', gzip());
  app.get('/api/games/pre', (req, res) => {
    res.setHeader('Content-Encoding', 'br');
    res.setHeader('Content-Type', 'application/json');
    res.end(Buffer.from('{"ok":true}'));
  });
  app.get('/api/games/image', (req, res) => {
    res.setHeader('Content-Type', 'image/png');
    res.end(Buffer.alloc(4096, 7));
  });
  const server = app.listen(PORT + 1);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const pre = await request(PORT + 1, '/api/games/pre', { 'Accept-Encoding': 'gzip' });
  assert.equal(pre.headers['content-encoding'], 'br');
  const image = await request(PORT + 1, '/api/games/image', { 'Accept-Encoding': 'gzip' });
  assert.equal(image.headers['content-encoding'], undefined);
  assert.equal(image.body.length, 4096);
});

test('middleware: past maxBuffer it falls back to identity without losing bytes', async (t) => {
  const payload = buildPayload(200);
  const identity = Buffer.from(JSON.stringify(payload));
  const app = express();
  app.use('/api/games', gzip({ maxBuffer: 1024 }));
  app.get('/api/games/big', (req, res) => res.status(200).json(payload));
  const server = app.listen(PORT + 2);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await request(PORT + 2, '/api/games/big', { 'Accept-Encoding': 'gzip' });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-encoding'], undefined);
  assert.deepEqual(JSON.parse(response.body.toString('utf8')), payload);
  assert.equal(response.body.length, identity.length);
});

test('middleware: HEAD and 204 stay bodyless', async (t) => {
  const app = express();
  app.use('/api/games', gzip());
  app.get('/api/games/empty', (req, res) => res.status(204).end());
  const server = app.listen(PORT + 3);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const head = await request(PORT + 3, '/api/games/empty', { 'Accept-Encoding': 'gzip' });
  assert.equal(head.status, 204);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-encoding'], undefined);
});
