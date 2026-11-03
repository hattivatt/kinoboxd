'use strict';

/**
 * Server-side vertical-art resolve (`server/games/steam-art.js`).
 *
 * Live evidence (03.11.2026, from the deploy host, public file CDN + store
 * frontend API):
 *
 *   CONTROL Resonant 3669870 — every legacy path 404s:
 *     /steam/apps/3669870/library_600x900.jpg       404
 *     /steam/apps/3669870/header.jpg                404
 *     /steam/apps/3669870/capsule_231x87.jpg        404
 *   the `appdetails` asset hashes only serve the files they name:
 *     <header-hash>/header.jpg                      200/42 KB
 *     <capsule-hash>/capsule_231x87.jpg             200/11 KB
 *     <header-hash>/library_600x900.jpg             404
 *   `IStoreBrowseService` publishes the real vertical capsule:
 *     assets.library_capsule = <hash>/library_capsule.jpg
 *     <hash>/library_capsule.jpg                    200/56 KB
 *
 * The resolver therefore probes one hashed `library_600x900.jpg` and, on a
 * 404, goes straight to the store-frontend asset map; the hash-less legacy
 * path is only kept for old-schema SKUs, where it is the primary source.
 * A negative answer is cached for 30 days.
 *
 * No live request: every `fetch` is injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-art-resolve-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-art-resolve-state-')
);

const art = require('../server/games/steam-art');

const APPID = 3669870;
const HEADER_HASH = '1e0c76e4253d347bb1304c3f213570251d924edf';
const CAPSULE_HASH = '867a73afa5f21c28aaa14e9b0a4d895c540d4a0c';
const LIBRARY_HASH = '7d4b4f430dc4d07e6562eb445456f9615cb52f77';
const HEADER = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${APPID}/${HEADER_HASH}/header.jpg?t=1793357289`;
const CAPSULE = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${APPID}/${CAPSULE_HASH}/capsule_231x87.jpg?t=1793357289`;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function binary(status, body = JPEG) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'image/jpeg' },
    async arrayBuffer() {
      return buffer;
    },
    async text() {
      return buffer.toString('utf8');
    },
  };
}

function json(status, body) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async text() {
      return text;
    },
    async arrayBuffer() {
      return Buffer.from(text);
    },
  };
}

function browsePayload(appid, assets) {
  return {
    response: {
      store_items: [
        {
          appid,
          success: 1,
          visible: true,
          assets,
        },
      ],
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

function clearResolved() {
  try {
    for (const name of fs.readdirSync(art.RESOLVED_DIR)) {
      fs.rmSync(path.join(art.RESOLVED_DIR, name), { force: true });
    }
  } catch (err) {
    /* the directory may not exist yet */
  }
}

const isBrowse = (url) => url.includes('IStoreBrowseService');
// The legacy hash-less path — the one the new schema must never spend a
// request on. A hashed URL contains `store_item_assets/steam/apps/<id>/<hash>/`
// and therefore cannot match.
const isLegacyLibrary = (url) => /\/steam\/apps\/\d+\/library_600x900\.jpg$/.test(url);

/* =========================================================
   1. hashed / legacy / store-frontend / none
   ========================================================= */

test('resolve: hashed library_600x900 under header_image wins (legacy SKUs in the new schema)', async () => {
  clearResolved();
  const fetchImpl = recordingFetch(async (url) => {
    if (isBrowse(url)) return json(500, {});
    return /library_600x900\.jpg$/.test(url) && url.includes(HEADER_HASH)
      ? binary(200)
      : binary(404, 'nope');
  });
  const doc = await art.resolveVerticalArt(APPID, {
    headerImage: HEADER,
    capsuleImage: CAPSULE,
    fetch: fetchImpl,
  });
  assert.equal(doc.kind, 'library-hashed');
  assert.equal(doc.h, HEADER_HASH);
  assert.equal(doc.file, 'library_600x900.jpg');
  assert.equal(doc.proxyType, 'library');
  assert.equal(doc.matchedBy, 'header-hash');
  assert.equal(fetchImpl.calls.length, 1, 'first 200 stops the chain (no GetItems)');
  assert.equal(
    art.artProxyUrlFor(doc),
    `/api/games/steam-art/library/${APPID}?h=${HEADER_HASH}`
  );
});

test('resolve: legacy-scheme header → legacy library_600x900.jpg, no GetItems', async () => {
  clearResolved();
  const legacyHeader = `https://cdn.cloudflare.steamstatic.com/steam/apps/${APPID}/header.jpg?t=1793357289`;
  const fetchImpl = recordingFetch(async (url) => {
    if (isBrowse(url)) return json(500, {});
    return isLegacyLibrary(url) ? binary(200) : binary(404, 'nope');
  });
  const doc = await art.resolveVerticalArt(APPID, {
    headerImage: legacyHeader,
    fetch: fetchImpl,
  });
  assert.equal(doc.kind, 'library-legacy');
  assert.equal(doc.h, null);
  assert.equal(doc.matchedBy, 'legacy');
  assert.equal(art.artProxyUrlFor(doc), `/api/games/steam-art/library/${APPID}`);
  assert.equal(fetchImpl.calls.length, 1, 'first legacy host 200, no hashed probe, no GetItems');
  assert.ok(!fetchImpl.calls.some(isBrowse), 'the legacy path never asks the store frontend');
});

test('resolve: GetItems library_capsule fixes CONTROL Resonant (no library_600x900 anywhere)', async () => {
  clearResolved();
  const fetchImpl = recordingFetch(async (url) => {
    if (isBrowse(url)) {
      return json(200, browsePayload(APPID, {
        library_capsule: `${LIBRARY_HASH}/library_capsule.jpg`,
        small_capsule: `${CAPSULE_HASH}/capsule_231x87.jpg`,
        community_icon: 'f9f541b67c42a9503467f44072ef9193c135ff33',
      }));
    }
    if (url.includes(`${LIBRARY_HASH}/library_capsule.jpg`)) return binary(200);
    if (url.includes(`${CAPSULE_HASH}/capsule_231x87.jpg`)) return binary(200);
    return binary(404, 'nope');
  });
  const doc = await art.resolveVerticalArt(APPID, {
    headerImage: HEADER,
    capsuleImage: CAPSULE,
    fetch: fetchImpl,
  });
  assert.equal(doc.kind, 'library-hashed');
  assert.equal(doc.h, LIBRARY_HASH);
  assert.equal(doc.file, 'library_capsule.jpg');
  assert.equal(doc.proxyType, 'library_capsule');
  assert.equal(doc.matchedBy, 'store-browse');
  assert.equal(
    art.artProxyUrlFor(doc),
    `/api/games/steam-art/library_capsule/${APPID}?h=${LIBRARY_HASH}`
  );
  assert.equal(
    doc.smallIconFallback,
    `/api/games/steam-art/capsule/${APPID}?h=${CAPSULE_HASH}`
  );
  assert.ok(fetchImpl.calls.some(isBrowse), 'the store-frontend asset map was asked');
  assert.ok(
    !fetchImpl.calls.some(isLegacyLibrary),
    'the new schema never probes the hash-less legacy path'
  );
  // One hashed `library_600x900.jpg` probe (single host), one GetItems call,
  // one 200 for the published capsule: the two guaranteed-404 legacy requests
  // are gone.
  assert.equal(fetchImpl.calls.length, 3);
});

test('resolve: every path 404 and GetItems without library_capsule → none, small icon still points at the capsule', async () => {
  clearResolved();
  const fetchImpl = recordingFetch(async (url) => {
    if (isBrowse(url)) return json(200, browsePayload(APPID, {}));
    return binary(404, 'nope');
  });
  const doc = await art.resolveVerticalArt(APPID, {
    headerImage: HEADER,
    capsuleImage: CAPSULE,
    fetch: fetchImpl,
  });
  assert.equal(doc.kind, 'none');
  assert.equal(doc.verticalCapsule, undefined);
  assert.equal(art.artProxyUrlFor(doc), null);
  assert.equal(
    doc.smallIconFallback,
    `/api/games/steam-art/capsule/${APPID}?h=${CAPSULE_HASH}`
  );
});

/* =========================================================
   2. TTL of the resolve document
   ========================================================= */

test('resolve: a positive document is reused for 180 days (no fetch)', async () => {
  clearResolved();
  const first = recordingFetch(async (url) =>
    url.includes(HEADER_HASH) ? binary(200) : binary(404, 'nope')
  );
  const doc = await art.resolveVerticalArt(APPID, { headerImage: HEADER, fetch: first });
  assert.equal(doc.kind, 'library-hashed');

  const second = recordingFetch(async () => binary(200));
  const again = await art.resolveVerticalArt(APPID, {
    headerImage: HEADER,
    fetch: second,
  });
  assert.equal(again.cached, true);
  assert.equal(second.calls.length, 0, 'fresh document served from disk');
  assert.equal(art.readResolvedArt(APPID).kind, 'library-hashed');
});

test('resolve: a negative document lives 30 days, then Steam is asked again', async () => {
  clearResolved();
  const writing = recordingFetch(async (url) => {
    if (isBrowse(url)) return json(200, browsePayload(APPID, {}));
    return binary(404, 'nope');
  });
  await art.resolveVerticalArt(APPID, {
    headerImage: HEADER,
    capsuleImage: CAPSULE,
    fetch: writing,
  });
  const file = path.join(art.RESOLVED_DIR, `${APPID}.json`);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));

  const fresh = recordingFetch(async () => binary(200));
  const cached = await art.resolveVerticalArt(APPID, { headerImage: HEADER, fetch: fresh });
  assert.equal(cached.cached, true);
  assert.equal(fresh.calls.length, 0, 'a 30-day-old negative is still fresh');

  saved.resolvedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(saved));
  const refetch = recordingFetch(async (url) => {
    if (isBrowse(url)) return json(200, browsePayload(APPID, {
      library_capsule: `${LIBRARY_HASH}/library_capsule.jpg`,
    }));
    return url.includes(`${LIBRARY_HASH}/library_capsule.jpg`)
      ? binary(200)
      : binary(404, 'nope');
  });
  const updated = await art.resolveVerticalArt(APPID, {
    headerImage: HEADER,
    fetch: refetch,
  });
  assert.equal(updated.kind, 'library-hashed');
  assert.ok(refetch.calls.length > 0, 'after 30 days the CDN is probed again');
});

/* =========================================================
   3. deferred, never a negative cache
   ========================================================= */

test('resolve: GetItems unreachable after CDN 404s → deferred and no document written', async () => {
  clearResolved();
  const fetchImpl = recordingFetch(async (url) => {
    if (isBrowse(url)) throw new Error('ECONNREFUSED');
    return binary(404, 'nope');
  });
  const doc = await art.resolveVerticalArt(APPID, {
    headerImage: HEADER,
    capsuleImage: CAPSULE,
    fetch: fetchImpl,
    retries: 0,
    sleep: async () => {},
  });
  assert.equal(doc.kind, 'none');
  assert.equal(doc.deferred, true);
  assert.equal(art.readResolvedArt(APPID), null, 'a network failure is not an answer');
});

test('resolve: a fully unreachable CDN is deferred too', async () => {
  clearResolved();
  const fetchImpl = recordingFetch(async () => {
    throw new Error('ETIMEDOUT');
  });
  const doc = await art.resolveVerticalArt(APPID, {
    headerImage: HEADER,
    fetch: fetchImpl,
    retries: 0,
    sleep: async () => {},
  });
  assert.equal(doc.deferred, true);
  assert.equal(art.readResolvedArt(APPID), null);
});

/* =========================================================
   4. small pieces
   ========================================================= */

test('assetHashFromUrl: only an allowlisted store_item_assets URL yields a hash', () => {
  assert.equal(art.assetHashFromUrl(HEADER), HEADER_HASH);
  assert.equal(
    art.assetHashFromUrl(`https://cdn.cloudflare.steamstatic.com/steam/apps/${APPID}/header.jpg`),
    null
  );
  assert.equal(
    art.assetHashFromUrl(`https://evil.example/store_item_assets/steam/apps/${APPID}/abc/header.jpg`),
    null
  );
});

test('artProxyUrlFor: hashed/legacy/SGDB/none', () => {
  assert.equal(
    art.artProxyUrlFor({ appid: 5, kind: 'library-hashed', h: 'abc', proxyType: 'library_capsule' }),
    '/api/games/steam-art/library_capsule/5?h=abc'
  );
  assert.equal(
    art.artProxyUrlFor({ appid: 5, kind: 'library-legacy' }),
    '/api/games/steam-art/library/5'
  );
  assert.equal(
    art.artProxyUrlFor({ appid: 5, kind: 'sgdb', url: 'https://cdn2.steamgriddb.com/grid/1.png' }),
    'https://cdn2.steamgriddb.com/grid/1.png'
  );
  assert.equal(art.artProxyUrlFor({ appid: 5, kind: 'none' }), null);
});

test('proxy type: library_capsule is an allowlisted type with its own file name', () => {
  assert.equal(art.FILE_BY_TYPE.library_capsule, 'library_capsule.jpg');
  const parsed = art.parseRequest({
    params: { type: 'library_capsule', appid: String(APPID) },
    query: { h: LIBRARY_HASH },
  });
  assert.deepEqual(parsed, { type: 'library_capsule', appid: APPID, hash: LIBRARY_HASH });
});
