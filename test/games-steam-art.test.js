'use strict';

/**
 * Steam art CDN proxy (fix-round 02.11.2026).
 *
 * The owner's client is in Vietnam, where the ISP blocks the Steam CDN
 * (`media.steampowered.com`, `cdn.cloudflare.steampowered.com`) while the
 * kinoboxd server reaches it. These tests pin the security and cache contract
 * of `GET /api/games/steam-art/<type>/<appid>[?h=<hash>]`:
 *
 *   - only the five art types, digit appids and `[A-Za-z0-9]{1,64}` hashes;
 *   - the upstream URL is assembled from the allowlist, never from input;
 *   - 404/403/5xx/network failures walk the host fallback list;
 *   - a 200 is relayed with its content type and `max-age=604800`;
 *   - the disk cache (`cache-games/art/`) serves the second request without an
 *     upstream call, respects the 7-day TTL, serves stale art on an outage and
 *     prunes by `maxFiles`.
 *
 * No live request: `steamArtFetch` is injected. Port 7113 per the round brief.
 */

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-steam-art-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-steam-art-state-')
);
process.env.KINOBOXD_STEAM_KEY_FILE = path.join(
  process.env.KINOBOXD_STATE_DIR,
  'no-steam-token'
);

const art = require('../server/games/steam-art');
const { createRouter } = require('../server/games/routes');

const PORT = 7113;
const BASE = `http://127.0.0.1:${PORT}`;
const APPID = 292030;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

function response(status, body, contentType = 'image/jpeg') {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? contentType : null;
      },
    },
    async arrayBuffer() {
      return buffer;
    },
  };
}

function recordingFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(String(url));
    return handler(String(url), calls.length);
  };
  impl.calls = calls;
  return impl;
}

function clearArtDir() {
  for (const name of fs.readdirSync(art.ART_DIR)) {
    fs.rmSync(path.join(art.ART_DIR, name), { force: true });
  }
}

// One server for the file: rebinding the same port between cases leaves a
// stale keep-alive socket in undici's pool and the next case fails with
// `other side closed`. The upstream fetch is swapped per case instead.
let activeFetch = async () => response(404, 'no fake fetch', 'text/plain');
let server = null;

const app = express();
app.use('/api/games', createRouter({
  steamArtFetch: (url, init) => activeFetch(url, init),
  secondaryDetailsKick: false,
}));
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({
    error: err.code || 'error',
    message: err.message,
  });
});

before(async () => {
  server = app.listen(PORT, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function withServer(fetchImpl, run) {
  activeFetch = fetchImpl;
  return run();
}

/* =========================================================
   1. pure pieces: candidates, allowlist, cache key
   ========================================================= */

test('upstream candidates: every URL is on the allowlist', () => {
  for (const type of ['header', 'capsule', 'library', 'small_capsule']) {
    for (const url of art.upstreamCandidates(type, APPID, null)) {
      assert.equal(art.isAllowedArtUrl(url), true, url);
    }
    for (const url of art.upstreamCandidates(type, APPID, 'abc123')) {
      assert.equal(art.isAllowedArtUrl(url), true, url);
    }
  }
  const icon = art.upstreamCandidates('icon', APPID, 'abc123');
  assert.deepEqual(icon, [
    `https://media.steampowered.com/steamcommunity/public/images/apps/${APPID}/abc123.jpg`,
  ]);
  assert.equal(art.isAllowedArtUrl('https://evil.example/steam/apps/1/header.jpg'), false);
  assert.equal(art.isAllowedArtUrl('http://cdn.cloudflare.steamstatic.com/x'), false);
  assert.equal(art.isAllowedArtUrl('not a url'), false);
  assert.deepEqual(art.upstreamCandidates('icon', APPID, null), []);
  assert.deepEqual(art.upstreamCandidates('bogus', APPID, null), []);
});

test('new-schema hash tries store_item_assets first; legacy tries the CDN hosts', () => {
  const withHash = art.upstreamCandidates('header', APPID, 'deadbeef');
  assert.equal(
    withHash[0],
    `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${APPID}/deadbeef/header.jpg`
  );
  const legacy = art.upstreamCandidates('library', APPID, null);
  assert.equal(legacy[0], `https://cdn.cloudflare.steamstatic.com/steam/apps/${APPID}/library_600x900.jpg`);
  assert.ok(legacy.some((url) => url.includes('cdn.cloudflare.steampowered.com')));
  assert.ok(legacy.some((url) => url.includes('shared.akamai.steamstatic.com')));
});

test('cache key is stable per type/appid/hash', () => {
  assert.equal(art.artCacheKey('header', 70, null), 'header-70');
  assert.equal(art.artCacheKey('icon', 70, 'abc'), 'icon-70-abc');
});

/* =========================================================
   2. request validation (no upstream call)
   ========================================================= */

test('invalid requests are 400 and never touch the upstream', async () => {
  clearArtDir();
  const fetchImpl = recordingFetch(async () => response(200, JPEG));
  await withServer(fetchImpl, async () => {
    const cases = [
      ['/api/games/steam-art/bogus/292030', 'invalid_art_type'],
      ['/api/games/steam-art/header/abc', 'invalid_appid'],
      ['/api/games/steam-art/header/0', 'invalid_appid'],
      ['/api/games/steam-art/icon/292030', 'art_hash_required'],
      ['/api/games/steam-art/header/292030?h=..%2Fetc', 'invalid_art_hash'],
      ['/api/games/steam-art/header/292030?x=1', 'unexpected_parameter'],
    ];
    for (const [url, code] of cases) {
      const res = await fetch(`${BASE}${url}`);
      assert.equal(res.status, 400, url);
      const body = await res.json();
      assert.equal(body.error, code, url);
    }
    assert.equal(fetchImpl.calls.length, 0, 'no upstream request for rejected input');
  });
});

/* =========================================================
   3. relay, fallback, cache
   ========================================================= */

test('404 on the first host falls back; 200 is relayed and cached for 7 days', async () => {
  clearArtDir();
  const fetchImpl = recordingFetch(async (url, n) =>
    n === 1 ? response(404, 'not found', 'text/plain') : response(200, JPEG)
  );
  await withServer(fetchImpl, async () => {
    const first = await fetch(`${BASE}/api/games/steam-art/header/${APPID}`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'image/jpeg');
    assert.equal(first.headers.get('content-length'), String(JPEG.length));
    assert.equal(first.headers.get('cache-control'), 'public, max-age=604800');
    assert.equal(first.headers.get('x-steam-art-cache'), 'miss');
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), JPEG);
    assert.equal(fetchImpl.calls.length, 2, 'one 404 + one 200');
    assert.equal(fetchImpl.calls[0], art.upstreamCandidates('header', APPID, null)[0]);
    assert.equal(fetchImpl.calls[1], art.upstreamCandidates('header', APPID, null)[1]);

    const second = await fetch(`${BASE}/api/games/steam-art/header/${APPID}`);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('x-steam-art-cache'), 'hit');
    assert.deepEqual(Buffer.from(await second.arrayBuffer()), JPEG);
    assert.equal(fetchImpl.calls.length, 2, 'second request is served from disk');

    const files = fs.readdirSync(art.ART_DIR);
    assert.deepEqual(files.sort(), [`header-${APPID}.bin`, `header-${APPID}.json`]);
  });
});

test('403 falls through to the next host', async () => {
  clearArtDir();
  const fetchImpl = recordingFetch(async (url, n) =>
    n === 1 ? response(403, 'forbidden', 'text/html') : response(200, JPEG)
  );
  await withServer(fetchImpl, async () => {
    const res = await fetch(`${BASE}/api/games/steam-art/capsule/${APPID}`);
    assert.equal(res.status, 200);
    assert.equal(fetchImpl.calls.length, 2);
  });
});

test('every host 404 → 404 steam_art_not_found', async () => {
  clearArtDir();
  const fetchImpl = recordingFetch(async () => response(404, 'nope', 'text/plain'));
  await withServer(fetchImpl, async () => {
    const res = await fetch(`${BASE}/api/games/steam-art/library/999999`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'steam_art_not_found');
    assert.equal(fetchImpl.calls.length, art.upstreamCandidates('library', 999999, null).length);
  });
});

test('network errors everywhere → 502 steam_art_unreachable', async () => {
  clearArtDir();
  const fetchImpl = recordingFetch(async () => {
    throw new Error('ECONNREFUSED');
  });
  await withServer(fetchImpl, async () => {
    const res = await fetch(`${BASE}/api/games/steam-art/header/123`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'steam_art_unreachable');
  });
});

test('icon requires the hash and asks media.steampowered.com', async () => {
  clearArtDir();
  const fetchImpl = recordingFetch(async () => response(200, JPEG));
  await withServer(fetchImpl, async () => {
    const res = await fetch(`${BASE}/api/games/steam-art/icon/${APPID}?h=abc123`);
    assert.equal(res.status, 200);
    assert.deepEqual(fetchImpl.calls, [
      `https://media.steampowered.com/steamcommunity/public/images/apps/${APPID}/abc123.jpg`,
    ]);
    const files = fs.readdirSync(art.ART_DIR);
    assert.ok(files.includes(`icon-${APPID}-abc123.bin`));
  });
});

test('a store_item_assets hash is tried before the legacy path', async () => {
  clearArtDir();
  const fetchImpl = recordingFetch(async () => response(200, JPEG));
  await withServer(fetchImpl, async () => {
    const res = await fetch(`${BASE}/api/games/steam-art/header/937?h=deadbeef`);
    assert.equal(res.status, 200);
    assert.equal(
      fetchImpl.calls[0],
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/937/deadbeef/header.jpg'
    );
  });
});

/* =========================================================
   4. TTL + stale + LRU
   ========================================================= */

function rewindMeta(key, days) {
  const file = path.join(art.ART_DIR, `${key}.json`);
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  meta.fetchedAt = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(meta));
}

test('a 7-day-old entry is refetched from the upstream', async () => {
  clearArtDir();
  const fetchImpl = recordingFetch(async () => response(200, JPEG));
  await withServer(fetchImpl, async () => {
    await fetch(`${BASE}/api/games/steam-art/header/70`);
    assert.equal(fetchImpl.calls.length, 1);
    rewindMeta('header-70', 8);
    const res = await fetch(`${BASE}/api/games/steam-art/header/70`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-steam-art-cache'), 'miss');
    assert.equal(fetchImpl.calls.length, 2);
  });
});

test('stale art is served when the CDN is down', async () => {
  clearArtDir();
  let fail = false;
  const fetchImpl = recordingFetch(async () => {
    if (fail) throw new Error('ETIMEDOUT');
    return response(200, JPEG);
  });
  await withServer(fetchImpl, async () => {
    await fetch(`${BASE}/api/games/steam-art/header/70`);
    rewindMeta('header-70', 8);
    fail = true;
    const res = await fetch(`${BASE}/api/games/steam-art/header/70`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-steam-art-cache'), 'stale');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG);
  });
});

test('pruneArtCache keeps the newest entries within maxFiles', () => {
  clearArtDir();
  for (const id of [1, 2, 3]) {
    art.writeEntry(`header-${id}`, {
      url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`,
      buffer: JPEG,
      contentType: 'image/jpeg',
    });
    const metaFile = path.join(art.ART_DIR, `header-${id}.json`);
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    meta.fetchedAt = new Date(Date.now() + id * 1000).toISOString();
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    const stamp = new Date(Date.now() + id * 1000);
    fs.utimesSync(metaFile, stamp, stamp);
  }
  const result = art.pruneArtCache({ maxFiles: 2 });
  assert.equal(result.removed, 1);
  const left = fs.readdirSync(art.ART_DIR).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(left, ['header-2.json', 'header-3.json']);
});
