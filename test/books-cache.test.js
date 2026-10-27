'use strict';

/**
 * Book cache: fingerprint invalidation + atomic writes.
 * A running server must observe files rewritten by an import/backfill process
 * without a restart (the f428493 lesson); memory entries are only trusted
 * while their file fingerprint is unchanged.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BOOK_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-book-cache-'));
process.env.KINOBOXD_CACHE_BOOK_DIR = BOOK_CACHE_DIR;

const bookCache = require('../server/books/book-cache');

function profile(events) {
  return {
    schemaVersion: 1,
    source: 'livelib',
    userKey: 'tester',
    importedAt: new Date().toISOString(),
    events,
    warnings: [],
  };
}

test('profile memory entry is invalidated by an external rewrite', () => {
  const first = profile([{ id: 'll:1', sourceBookId: '1', title: 'One' }]);
  return bookCache.saveProfile('livelib', 'tester', first).then(() => {
    assert.equal(bookCache.getProfile('livelib', 'tester').events.length, 1);

    // Simulate another process replacing the file atomically.
    const target = bookCache.profilePath('livelib', 'tester');
    const tmp = `${target}.other.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify(profile([
        { id: 'll:1', sourceBookId: '1', title: 'One' },
        { id: 'll:2', sourceBookId: '2', title: 'Two' },
      ])),
      'utf8'
    );
    fs.renameSync(tmp, target);

    const reloaded = bookCache.getProfile('livelib', 'tester');
    assert.equal(reloaded.events.length, 2);
    assert.equal(reloaded.events[1].title, 'Two');
  });
});

test('details and links memory entries follow the file fingerprint', async () => {
  await bookCache.saveDetails(42, { schemaVersion: 1, hcWorkId: 42, title: 'Alpha' });
  assert.equal(bookCache.getDetails(42).title, 'Alpha');

  const detailsFile = bookCache.detailsPath(42);
  fs.writeFileSync(detailsFile, JSON.stringify({ schemaVersion: 1, hcWorkId: 42, title: 'Alpha v2' }));
  assert.equal(bookCache.getDetails(42).title, 'Alpha v2');

  await bookCache.saveLink('100', { schemaVersion: 1, livelibBookId: '100', workId: 'hc:42' });
  assert.equal(bookCache.getLink('100').workId, 'hc:42');

  const linkFile = bookCache.linkPath('100');
  fs.writeFileSync(linkFile, JSON.stringify({ schemaVersion: 1, livelibBookId: '100', workId: null }));
  assert.equal(bookCache.getLink('100').workId, null);
});

test('listProfiles reports metadata from disk and tolerates corrupt files', async () => {
  await bookCache.saveProfile('hardcover', '34748', {
    schemaVersion: 1,
    source: 'hardcover',
    userKey: '34748',
    sourceUserId: 34748,
    importedAt: '2026-10-27T00:00:00.000Z',
    events: [
      { id: 'hc:read:1', sourceBookId: '7', finishedAt: '2024-01-01' },
      { id: 'hc:ub:2', sourceBookId: '8', finishedAt: null },
    ],
    warnings: [],
  });
  fs.writeFileSync(path.join(bookCache.PROFILES_DIR, 'broken.json'), '{not json', 'utf8');

  const profiles = bookCache.listProfiles();
  const hardcover = profiles.find((entry) => entry.source === 'hardcover');
  assert.ok(hardcover);
  assert.equal(hardcover.userKey, '34748');
  assert.equal(hardcover.eventCount, 2);
  assert.equal(hardcover.finishedCount, 1);
});

test('index.json merges local writes with an externally replaced file', async () => {
  const indexFile = bookCache.INDEX_PATH;
  fs.writeFileSync(indexFile, JSON.stringify({ 'll:1': 111 }), 'utf8');

  bookCache.setIndexValue('ll:2', 222);
  bookCache.flushIndex();
  assert.equal(bookCache.getIndexEntry('ll:2'), 222);

  // External process adds a key and keeps ours.
  fs.writeFileSync(indexFile, JSON.stringify({ 'll:1': 111, 'll:2': 222, 'll:3': 333 }), 'utf8');
  bookCache.setIndexValue('ll:4', 444);
  bookCache.flushIndex();

  assert.equal(bookCache.getIndexEntry('ll:1'), 111);
  assert.equal(bookCache.getIndexEntry('ll:3'), 333);
  assert.equal(bookCache.getIndexEntry('ll:4'), 444);
});

test('safeKey never escapes the cache directory', () => {
  assert.equal(bookCache.safeKey('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(bookCache.safeKey('Margaret'), 'Margaret');
});
