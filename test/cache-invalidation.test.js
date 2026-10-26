'use strict';

/**
 * Cross-process cache invalidation.
 *
 * The live server keeps index.json / lb-links.json / details in memory. A
 * backfill or rematch is a separate process that rewrites those files; the
 * server must observe the new content on the next read without a restart.
 * These tests simulate the external process with plain fs writes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-cache-inv-'));
const DETAILS_DIR = path.join(CACHE_DIR, 'details');
const INDEX_PATH = path.join(CACHE_DIR, 'index.json');
const LB_PATH = path.join(CACHE_DIR, 'lb-links.json');
fs.mkdirSync(DETAILS_DIR, { recursive: true });

fs.writeFileSync(INDEX_PATH, JSON.stringify({ 'alpha|2000': 1 }), 'utf8');
fs.writeFileSync(
  LB_PATH,
  JSON.stringify({ 1: { lbUri: 'https://boxd.it/aaa', kind: 'movie' } }),
  'utf8'
);
fs.writeFileSync(
  path.join(DETAILS_DIR, '1.json'),
  JSON.stringify({
    kind: 'movie',
    details: {
      id: 1,
      title: 'Alpha',
      belongs_to_collection: { id: 9, name: 'Alpha Collection' },
    },
    credits: { cast: [] },
  }),
  'utf8'
);

process.env.KINOBOXD_CACHE_DIR = CACHE_DIR;
process.env.TMDB_API_TOKEN = 'test-token';

const cache = require('../server/cache');

function detailsFile(id, title, collection) {
  return JSON.stringify({
    kind: 'movie',
    details: {
      id,
      title,
      ...(collection ? { belongs_to_collection: collection } : {}),
    },
    credits: { cast: [] },
  });
}

/** Replace a file the way backfill/rematch do: tmp + rename changes the inode. */
function replaceFile(filePath, contents) {
  const tmp = `${filePath}.test.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, filePath);
}

test('getDetails revalidates its memory entry against the file', () => {
  const first = cache.getDetails(1, 'movie');
  assert.equal(first.details.title, 'Alpha');
  assert.deepEqual(first.details.belongs_to_collection, { id: 9, name: 'Alpha Collection' });

  // Backfill drops the collection in a separate process.
  replaceFile(
    path.join(DETAILS_DIR, '1.json'),
    detailsFile(1, 'Alpha (remastered)', null)
  );

  const second = cache.getDetails(1, 'movie');
  assert.equal(second.details.title, 'Alpha (remastered)');
  assert.equal(second.details.belongs_to_collection, undefined);

  // External removal: memory must not keep serving the old payload.
  fs.unlinkSync(path.join(DETAILS_DIR, '1.json'));
  assert.equal(cache.getDetails(1, 'movie'), null);
  assert.equal(cache.hasDetails(1, 'movie'), false);

  // Re-created by another backfill process: visible again immediately.
  replaceFile(
    path.join(DETAILS_DIR, '1.json'),
    detailsFile(1, 'Alpha restored', { id: 9, name: 'Alpha Collection' })
  );
  assert.equal(cache.hasDetails(1, 'movie'), true);
  assert.equal(cache.getDetails(1, 'movie').details.title, 'Alpha restored');
});

test('hasDetails revalidates too and handles the tv-collision path', () => {
  replaceFile(path.join(DETAILS_DIR, '2.json'), detailsFile(2, 'Shared id movie', null));
  replaceFile(
    path.join(DETAILS_DIR, 'tv-2.json'),
    JSON.stringify({
      kind: 'tv',
      details: { id: 2, name: 'Shared id series' },
      credits: { cast: [] },
    })
  );

  assert.equal(cache.getDetails(2, 'movie').details.title, 'Shared id movie');
  assert.equal(cache.getDetails(2, 'tv').details.name, 'Shared id series');
  assert.equal(cache.hasDetails(2, 'tv'), true);

  // The movie file changes; the tv entry must stay mapped to tv-2.json.
  replaceFile(path.join(DETAILS_DIR, '2.json'), detailsFile(2, 'Movie v2', null));
  assert.equal(cache.getDetails(2, 'movie').details.title, 'Movie v2');
  assert.equal(cache.getDetails(2, 'tv').details.name, 'Shared id series');
});

test('index.json is reloaded after an external write and pending local writes survive', () => {
  assert.equal(cache.getIndexValue('alpha|2000'), 1);

  replaceFile(
    INDEX_PATH,
    JSON.stringify({ 'alpha|2000': 2, 'beta|2001': false })
  );
  assert.equal(cache.getIndexValue('alpha|2000'), 2);
  assert.equal(cache.getIndexValue('beta|2001'), false);
  assert.equal(cache.hasKey('beta|2001'), true);

  // Local (server) write while another process still holds the file.
  cache.setIndexValue('gamma|2002', 3);
  assert.equal(cache.getIndexValue('gamma|2002'), 3);

  // External process adds a key; the pending local key must not be lost.
  replaceFile(
    INDEX_PATH,
    JSON.stringify({ 'alpha|2000': 2, 'beta|2001': false, 'delta|2003': 4 })
  );
  assert.equal(cache.getIndexValue('delta|2003'), 4);
  assert.equal(cache.getIndexValue('gamma|2002'), 3);

  cache.flushIndex();
  const onDisk = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  assert.equal(onDisk['delta|2003'], 4);
  assert.equal(onDisk['gamma|2002'], 3);
  assert.equal(onDisk['alpha|2000'], 2);
});

test('lb-links.json is reloaded after an external write and pending links survive', () => {
  assert.equal(cache.getLbLink(1, 'movie'), 'https://boxd.it/aaa');

  replaceFile(
    LB_PATH,
    JSON.stringify({
      1: { lbUri: 'https://boxd.it/aaa', kind: 'movie' },
      2: { lbUri: 'https://boxd.it/bbb', kind: 'movie' },
    })
  );
  assert.equal(cache.getLbLink(2, 'movie'), 'https://boxd.it/bbb');

  assert.equal(cache.setLbLink(3, 'https://boxd.it/ccc', 'tv'), true);

  replaceFile(
    LB_PATH,
    JSON.stringify({
      1: { lbUri: 'https://boxd.it/aaa', kind: 'movie' },
      2: { lbUri: 'https://boxd.it/bbb', kind: 'movie' },
      4: { lbUri: 'https://boxd.it/ddd', kind: 'movie' },
    })
  );
  assert.equal(cache.getLbLink(4, 'movie'), 'https://boxd.it/ddd');
  assert.equal(cache.getLbLink(3, 'tv'), 'https://boxd.it/ccc');

  cache.flushLbLinks();
  const onDisk = JSON.parse(fs.readFileSync(LB_PATH, 'utf8'));
  assert.equal(onDisk[3].lbUri, 'https://boxd.it/ccc');
  assert.equal(onDisk[4].lbUri, 'https://boxd.it/ddd');
  assert.equal(cache.lbLinksStats().keys, 4);
});
