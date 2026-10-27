'use strict';

/**
 * Books "↻ Обновить профиль" — force semantics + toast diff helpers.
 *
 * The manual refresh is only honest if it really re-reads both sources:
 *   - Hardcover has no reuse path (pinned by books-import-hardcover.test.js);
 *   - LiveLib reuses a < 12 h profile by default, but `force: true` (body
 *     boolean or `?force=1`) must bypass that guard and do a full re-scan.
 *
 * The frontend diff helper is tested numerically: deletions from a source must
 * produce a negative event delta, not a silent "all good".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BOOK_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-books-refresh-'));
process.env.KINOBOXD_CACHE_BOOK_DIR = BOOK_CACHE_DIR;

const bookCache = require('../server/books/book-cache');
const livelib = require('../server/books/livelib');
const resolve = require('../server/books/resolve');
const importJobs = require('../server/books/import');

const PORT = Number(process.env.BOOKS_REFRESH_TEST_PORT) || 6211;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

let importCalls = 0;
let importDelay = null;
const originalImport = livelib.importLivelib;
const originalResolve = resolve.resolveProfile;

function profile(username, titles, importedAt = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    source: 'livelib',
    userKey: username,
    importedAt,
    events: titles.map((title, index) => ({
      id: `ll:${username}:${index + 1}`,
      source: 'livelib',
      sourceBookId: String(index + 1),
      title,
      status: 'read',
    })),
    warnings: [],
  };
}

function fakeReport() {
  return {
    resolved: 0,
    withMetadata: 0,
    total: 0,
    resolvedIsbn: 0,
    resolvedTitle: 0,
    resolvedGoogle: 0,
    resolvedOpenLibrary: 0,
    resolvedLitres: 0,
    resolvedHardcoverFromLitres: 0,
    resolvedLivelibCard: 0,
    resolvedHardcoverCard: 0,
    enriched: 0,
    ambiguous: 0,
    unmatched: 0,
    requests: 0,
    providerChain: {},
  };
}

test.before(() => {
  livelib.importLivelib = async (username) => {
    importCalls += 1;
    if (importDelay) await importDelay;
    return {
      profile: profile(username, ['Only surviving book']),
      totals: { dated: 1 },
      requests: { total: 63 },
      warnings: [],
    };
  };
  resolve.resolveProfile = async () => fakeReport();
});

test.after(() => {
  livelib.importLivelib = originalImport;
  resolve.resolveProfile = originalResolve;
});

test('default LiveLib import still reuses a fresh cached profile', async () => {
  await bookCache.saveProfile('livelib', 'reuse-default', profile('reuse-default', ['A', 'B']));
  importCalls = 0;

  const job = importJobs.startLivelibImport('reuse-default');
  assert.equal(job.done, true);
  assert.equal(job.reused, true);
  assert.equal(job.force, false);
  assert.equal(job.events, 2);
  assert.equal(importCalls, 0, 'default must not scrape LiveLib');
});

test('force:true bypasses reuse, performs a full import and reflects a deletion', async () => {
  await bookCache.saveProfile('livelib', 'force-full', profile('force-full', ['Book A', 'Book B']));
  importCalls = 0;

  const started = importJobs.startLivelibImport('force-full', { force: true });
  assert.equal(started.reused, false);
  assert.equal(started.force, true);
  assert.equal(started.done, false);

  await importJobs.idle();
  const status = importJobs.getStatus(started.id);
  assert.equal(status.stage, 'done');
  assert.equal(status.reused, false);
  assert.equal(status.force, true);
  assert.equal(importCalls, 1, 'force must call the scraper');
  assert.equal(status.events, 1);
  assert.equal(status.requests.total, 63);

  // The cached profile was replaced, so stats now cannot see the deleted book.
  const cached = bookCache.getProfile('livelib', 'force-full');
  assert.equal(cached.events.length, 1);
  assert.equal(cached.events[0].title, 'Only surviving book');
});

test('a second request for a running source coalesces into the same job', async () => {
  let release = null;
  importDelay = new Promise((resolveDelay) => {
    release = resolveDelay;
  });
  const first = importJobs.startLivelibImport('coalesce-me', { force: true });
  await new Promise((resolveTick) => setImmediate(resolveTick));
  const second = importJobs.startLivelibImport('coalesce-me', { force: true });
  assert.equal(second.id, first.id);
  assert.equal(second.force, true);
  release();
  importDelay = null;
  await importJobs.idle();
  assert.equal(importJobs.getStatus(first.id).stage, 'done');
});

test('HTTP route: force via query/body, default preserved, invalid force rejected', async (t) => {
  const express = require('express');
  const routes = require('../server/books/routes');
  const app = express();
  app.use(express.json());
  app.use('/api/books', routes);
  app.use((err, req, res, next) => {
    res.status(err.status || err.statusCode || 500).json({ code: err.code, error: err.message });
  });
  const server = app.listen(PORT);
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const base = `http://127.0.0.1:${PORT}/api/books`;

  await bookCache.saveProfile('livelib', 'route-fresh', profile('route-fresh', ['Fresh']));

  const reused = await fetch(`${base}/import/livelib`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'route-fresh' }),
  });
  assert.equal(reused.status, 202);
  const reusedBody = await reused.json();
  assert.equal(reusedBody.reused, true);
  assert.equal(reusedBody.force, false);

  const viaQuery = await fetch(`${base}/import/livelib?force=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'route-fresh' }),
  });
  assert.equal(viaQuery.status, 202);
  const queryBody = await viaQuery.json();
  assert.equal(queryBody.force, true);
  assert.equal(queryBody.reused, false);

  const viaBody = await fetch(`${base}/import/livelib`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'route-fresh', force: true }),
  });
  assert.equal(viaBody.status, 202);
  assert.equal((await viaBody.json()).force, true);

  const badBody = await fetch(`${base}/import/livelib`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'route-fresh', force: 'yes' }),
  });
  assert.equal(badBody.status, 400);
  assert.equal((await badBody.json()).code, 'invalid_force');

  const badQuery = await fetch(`${base}/import/livelib?force=banana`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'route-fresh' }),
  });
  assert.equal(badQuery.status, 400);
  assert.equal((await badQuery.json()).code, 'invalid_force');

  const noName = await fetch(`${base}/import/livelib`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(noName.status, 400);
  assert.equal((await noName.json()).code, 'username_required');

  const unknownStatus = await fetch(`${base}/import/status?id=does-not-exist`);
  assert.equal(unknownStatus.status, 404);
  assert.equal((await unknownStatus.json()).code, 'unknown_job');

  await importJobs.idle();
});

test('frontend diff helper counts events numerically (including deletions)', async () => {
  const { snapshotCounts, diffRefresh, refreshToastMessage } = await import(
    '../public/js/books-refresh.js'
  );

  const before = snapshotCounts({
    summary: { eventCount: 100 },
    sourceBreakdown: [
      { source: 'hardcover', events: 90 },
      { source: 'livelib', events: 10 },
    ],
  });
  assert.equal(before.eventCount, 100);
  assert.equal(before.bySource.hardcover, 90);

  const inserted = snapshotCounts({
    summary: { eventCount: 103 },
    sourceBreakdown: [
      { source: 'hardcover', events: 91 },
      { source: 'livelib', events: 12 },
    ],
  });
  assert.deepEqual(diffRefresh(before, inserted), {
    eventDelta: 3,
    bySource: {
      hardcover: { before: 90, after: 91, delta: 1 },
      livelib: { before: 10, after: 12, delta: 2 },
    },
  });
  assert.equal(
    refreshToastMessage(before, inserted, { sources: ['hardcover', 'livelib'] }),
    'Профиль обновлён: hardcover 91 · livelib 12 (+3 новых событий)'
  );

  const deleted = snapshotCounts({
    summary: { eventCount: 98 },
    sourceBreakdown: [
      { source: 'hardcover', events: 88 },
      { source: 'livelib', events: 10 },
    ],
  });
  assert.equal(diffRefresh(before, deleted).eventDelta, -2);
  assert.match(
    refreshToastMessage(before, deleted),
    /^Профиль обновлён: hardcover 88 · livelib 10 \(−2 событий/
  );

  const same = snapshotCounts({
    summary: { eventCount: 100 },
    sourceBreakdown: [
      { source: 'hardcover', events: 90 },
      { source: 'livelib', events: 10 },
    ],
  });
  assert.equal(
    refreshToastMessage(before, same),
    'Профиль обновлён: hardcover 90 · livelib 10 (данных новых нет)'
  );

  // One source failed: the successful source is still reported, the failure is
  // named in the same toast.
  const partial = refreshToastMessage(before, same, {
    sources: ['hardcover', 'livelib'],
    failures: { livelib: 'LiveLib недоступен (blocked)' },
  });
  assert.match(partial, /^Профиль обновлён: hardcover 90/);
  assert.match(partial, /LiveLib: ошибка — LiveLib недоступен \(blocked\)/);

  const allFailed = refreshToastMessage(before, same, {
    sources: ['hardcover', 'livelib'],
    failures: { hardcover: 'boom', livelib: 'timeout' },
  });
  assert.match(allFailed, /^Не удалось обновить профиль: Hardcover: ошибка — boom · LiveLib: ошибка — timeout$/);
});

test('books markup wires the real profile-refresh button and tooltip', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'books.js'), 'utf8');

  assert.match(html, /id="books-refresh"[\s\S]*?Обновить профиль/);
  assert.match(html, /Полная проверка Hardcover \(всегда, ~10 с\) и LiveLib \(полный скан всех страниц, ~3 мин\)/);
  assert.match(html, /id="books-refresh-spinner"/);

  assert.match(source, /getBooksProfiles/);
  assert.match(source, /startBooksImportLivelib\(username, \{ force: true \}\)/);
  assert.match(source, /refreshToastMessage/);
  assert.match(source, /snapshotCounts/);
});
