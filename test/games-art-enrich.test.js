'use strict';

/**
 * Details phase also resolves the vertical capsule once per appid
 * (`cache-games/art/resolved/<appid>.json`). No network: the store client and
 * the art fetch are injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-art-enrich-'));
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-art-enrich-state-')
);

const gameCache = require('../server/games/game-cache');
const enrich = require('../server/games/enrich');
const art = require('../server/games/steam-art');

const APPID = 3669870;
const HEADER_HASH = '1e0c76e4253d347bb1304c3f213570251d924edf';
const HEADER = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${APPID}/${HEADER_HASH}/header.jpg`;
const CAPSULE = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${APPID}/867a73afa5f21c28aaa14e9b0a4d895c540d4a0c/capsule_231x87.jpg`;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function detailDoc(appid, extra = {}) {
  return {
    appid,
    success: true,
    type: 'game',
    name: `Game ${appid}`,
    is_free: false,
    developers: ['Dev'],
    publishers: ['Pub'],
    genres: [{ id: '1', description: 'Action' }],
    categories: [{ id: '2', description: 'Single-player' }],
    release_date: { date: '1 Jan, 2015', coming_soon: false, year: 2015, precision: 'day' },
    releaseYear: 2015,
    dlc: [],
    dlcCount: 0,
    metacritic: null,
    platforms: { windows: true, mac: false, linux: false },
    screenshots: [],
    earlyAccess: false,
    metadataSource: 'steam-store',
    ...extra,
  };
}

function imageResponse(status) {
  const buffer = status === 200 ? JPEG : Buffer.from('not found');
  return {
    ok: status === 200,
    status,
    headers: { get: () => (status === 200 ? 'image/jpeg' : 'text/html') },
    async arrayBuffer() {
      return buffer;
    },
    async text() {
      return buffer.toString('utf8');
    },
  };
}

function recordingArtFetch() {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    if (String(url).includes(`${HEADER_HASH}/library_600x900.jpg`)) return imageResponse(200);
    return imageResponse(404);
  };
  impl.calls = calls;
  return impl;
}

async function seedProfile(id, appid) {
  const now = new Date().toISOString();
  await gameCache.saveProfile({
    userKey: id,
    personaName: `tester-${id.slice(-2)}`,
    privacy: 'public',
    importedAt: now,
    fetchedAt: now,
  });
  await gameCache.saveLibrary(id, {
    fetchedAt: now,
    partial: false,
    source: 'steam-webapi',
    game_count: 1,
    games: [{ appid, name: `Game ${appid}`, playtime_forever: 60, img_icon_url: '' }],
    totalMinutes: 60,
  });
}

function fakeStore(doc) {
  return {
    async getAppDetails() {
      return JSON.parse(JSON.stringify(doc));
    },
  };
}

async function run(profile, client, options) {
  const started = enrich.startEnrich(profile, { client, ...options });
  await enrich.whenIdle();
  return enrich.getStatus(started.jobId);
}

test('details phase resolves the vertical capsule once and writes art/resolved', async () => {
  const id = '76561198000000301';
  await seedProfile(id, APPID);
  const fetchImpl = recordingArtFetch();
  const status = await run(`steam-${id}`, fakeStore(detailDoc(APPID, {
    headerImage: HEADER,
    capsuleImage: CAPSULE,
  })), { budget: 10, fetch: fetchImpl });

  assert.equal(status.status, 'done');
  assert.equal(status.phases.details.artCandidates, 1);
  assert.equal(status.phases.details.artResolved, 1);
  assert.equal(status.phases.details.artNone, 0);
  const doc = art.readResolvedArt(APPID);
  assert.ok(doc, 'the resolve document is on disk');
  assert.equal(doc.kind, 'library-hashed');
  assert.equal(doc.h, HEADER_HASH);
  assert.equal(
    art.artProxyUrlFor(doc),
    `/api/games/steam-art/library/${APPID}?h=${HEADER_HASH}`
  );
  assert.ok(fetchImpl.calls.length >= 1, 'the CDN was probed');

  // Second run: details are TTL-fresh and the resolve document is fresh, so
  // the phase reports no art candidates and does not touch the CDN again.
  const before = fs.statSync(path.join(art.RESOLVED_DIR, `${APPID}.json`)).mtimeMs;
  const again = await run(`steam-${id}`, fakeStore(detailDoc(APPID, {
    headerImage: HEADER,
    capsuleImage: CAPSULE,
  })), { budget: 10, fetch: fetchImpl });
  assert.equal(again.phases.details.artCandidates, 0);
  const after = fs.statSync(path.join(art.RESOLVED_DIR, `${APPID}.json`)).mtimeMs;
  assert.equal(after, before, 'no rewrite of a fresh resolve document');
});

test('details without header_image never triggers the art resolver', async () => {
  const id = '76561198000000302';
  const appid = 620;
  await seedProfile(id, appid);
  let called = 0;
  const status = await run(`steam-${id}`, fakeStore(detailDoc(appid)), {
    budget: 10,
    artResolver: async () => {
      called++;
      return { kind: 'none' };
    },
  });
  assert.equal(status.phases.details.artCandidates, 0);
  assert.equal(called, 0);
  assert.equal(art.readResolvedArt(appid), null);
});

test('a deferred resolve is counted but not written (retried next run)', async () => {
  const id = '76561198000000303';
  const appid = 70;
  await seedProfile(id, appid);
  const status = await run(`steam-${id}`, fakeStore(detailDoc(appid, {
    headerImage: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
  })), {
    budget: 10,
    artResolver: async () => ({ kind: 'none', deferred: true }),
  });
  assert.equal(status.phases.details.artCandidates, 1);
  assert.equal(status.phases.details.artDeferred, 1);
  assert.equal(status.phases.details.artResolved, 0);
  assert.equal(art.readResolvedArt(appid), null);
});
