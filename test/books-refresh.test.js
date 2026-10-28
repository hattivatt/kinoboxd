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
  const { snapshotCounts, diffRefresh, refreshToastMessage, deepBadgeText } = await import(
    '../public/js/books-refresh.js'
  );

  const before = snapshotCounts({
    summary: { eventCount: 100, finishedCount: 40, undatedEventCount: 60 },
  });
  assert.equal(before.eventCount, 100);
  assert.equal(before.datedCount, 40);
  assert.equal(before.undatedCount, 60);

  const inserted = snapshotCounts({
    summary: { eventCount: 103, finishedCount: 42, undatedEventCount: 61 },
  });
  assert.deepEqual(diffRefresh(before, inserted), {
    eventDelta: 3,
    datedDelta: 2,
    undatedDelta: 1,
  });
  assert.equal(
    refreshToastMessage(before, inserted, { source: 'hardcover' }),
    'Профиль обновлён: Hardcover 103 (+3 новых событий)'
  );

  const deleted = snapshotCounts({
    summary: { eventCount: 98, finishedCount: 38, undatedEventCount: 60 },
  });
  assert.equal(diffRefresh(before, deleted).eventDelta, -2);
  assert.match(
    refreshToastMessage(before, deleted, { source: 'livelib' }),
    /^Профиль обновлён: LiveLib 98 \(−2 событий/
  );

  const same = snapshotCounts({
    summary: { eventCount: 100, finishedCount: 40, undatedEventCount: 60 },
  });
  assert.equal(
    refreshToastMessage(before, same, { source: 'livelib' }),
    'Профиль обновлён: LiveLib 100 (данных новых нет)'
  );

  // A deep scan changes dates without changing the event count.
  const dated = snapshotCounts({
    summary: { eventCount: 100, finishedCount: 95, undatedEventCount: 5 },
  });
  assert.equal(
    refreshToastMessage(before, dated, { source: 'livelib' }),
    'Профиль обновлён: LiveLib 100 (+55 событий с точной датой)'
  );
  assert.match(
    refreshToastMessage(before, same, {
      source: 'livelib',
      deep: { percent: 45, pageTotal: 63, done: false },
    }),
    /история датируется в фоне \(45%\)/
  );

  // A failure names the profile's single source instead of pretending a
  // second source was refreshed.
  const failed = refreshToastMessage(before, same, {
    source: 'livelib',
    failure: 'LiveLib ограничил доступ (HTTP 403)',
  });
  assert.equal(
    failed,
    'Не удалось обновить профиль LiveLib: LiveLib ограничил доступ (HTTP 403)'
  );

  // Badge: «История 45%» while the deep scan runs, gone when done/absent.
  assert.equal(deepBadgeText({ percent: 45, pageTotal: 63, done: false }), 'История 45%');
  assert.equal(deepBadgeText({ percent: 100, done: false }), '');
  assert.equal(deepBadgeText({ percent: 45, done: true }), '');
  assert.equal(deepBadgeText(null), '');
});

test('books markup wires the real profile-refresh button and tooltip', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'books.js'), 'utf8');

  assert.match(html, /id="books-refresh"[\s\S]*?Обновить профиль/);
  assert.match(html, /фоновый глубокий скан истории/);
  assert.match(html, /id="books-refresh-spinner"/);
  assert.match(html, /id="books-refresh-percent"/);

  assert.match(source, /getBooksProfiles/);
  assert.match(source, /startBooksImportLivelib\(username, \{ force: true, deep: 'auto' \}\)/);
  assert.match(source, /refreshToastMessage/);
  assert.match(source, /snapshotCounts/);
  assert.match(source, /deepBadgeText/);
  // One profile = one source: the stats request carries a single profile key.
  assert.match(source, /getBooksStats\(\{\s*profile: activeProfileKey\(\)/);
});

test('metadata badge view model: hidden at 100%, running suffix, budget hint', async () => {
  const { metadataBadge } = await import('../public/js/books-refresh.js');

  // LiveLib profile with 42% coverage and a live resolve stage.
  const running = metadataBadge({
    resolved: 502,
    total: 1211,
    percent: 42,
    running: true,
    budgetRemaining: 42,
  });
  assert.equal(running.percent, 42);
  assert.equal(running.pending, 709);
  assert.equal(running.running, true);
  assert.equal(running.text, 'Метадата: 42% · догружается…');
  assert.match(running.hint, /709 книг ждут метадату/);
  assert.match(running.hint, /502 из 1211/);
  assert.match(running.hint, /Литрес-бюджет на этот прогон: 42/);

  // Same coverage, no live job: no spinner, honest "next refresh" wording.
  const idle = metadataBadge({
    resolved: 502,
    total: 1211,
    percent: 42,
    running: false,
    budgetRemaining: null,
  });
  assert.equal(idle.text, 'Метадата: 42%');
  assert.equal(idle.running, false);
  assert.match(idle.hint, /Следующая порция — при обновлении профиля/);
  assert.doesNotMatch(idle.hint, /Литрес-бюджет/);

  // 100% / empty / legacy payloads hide the badge entirely.
  assert.equal(metadataBadge({ resolved: 132, total: 132, percent: 100, running: false }), null);
  assert.equal(metadataBadge({ resolved: 0, total: 0, percent: 100, running: false }), null);
  assert.equal(metadataBadge(null), null);

  // A one-book remainder gets the singular form (no «1 книги ждут»).
  const one = metadataBadge({ resolved: 9, total: 10, percent: 90, running: false });
  assert.match(one.hint, /^1 книга ждёт метадату/);

  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'books.js'), 'utf8');
  assert.match(html, /id="books-metadata-badge"/);
  assert.match(html, /id="books-metadata-spinner"/);
  assert.match(source, /metadataBadge\(/);
  assert.match(source, /renderMetadataBadge\(state\.data\)/);
});
