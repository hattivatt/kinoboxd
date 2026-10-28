'use strict';

/**
 * POST /api/books/import/livelib-file — the "safe path" HTTP contract, and the
 * shelf filter it feeds into the stats payload.
 *
 * Pinned here:
 *   - a `livelib-backup` export is merged into `profiles/livelib-{userKey}.json`
 *     with `origin: 'livelib-file'`, `shelves` and `fileImports`;
 *   - the response is a single 201 (counts, shelves, warnings) — no job to poll,
 *     because nothing is scraped and nothing leaves the server;
 *   - a repeated upload is idempotent; a second shelf is additive;
 *   - 400s are explicit (`file_required`, `username_required`,
 *     `invalid_user_key`, `invalid_shelf`, `shelf_required`, parser errors) and
 *     a running scrape of the same profile is a 409;
 *   - stats keep `read`/`dnf` in the history and exclude `reading`/`wish`
 *     (`summary.shelfExcluded`, `meta.statusFilter.byShelf`);
 *   - the bibliographic columns of the file become metadata: genres, series,
 *     ISBN and language render with `metadataSources: ['livelib-file']` and
 *     `unresolved: false` — no network request involved.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BOOK_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-book-llfile-'));
process.env.KINOBOXD_CACHE_BOOK_DIR = BOOK_CACHE_DIR;

const bookCache = require('../server/books/book-cache');
const importJobs = require('../server/books/import');
const livelib = require('../server/books/livelib');
const { buildBooksStats } = require('../server/books/stats');

const PORT = 6721;
const FIXTURES = path.join(__dirname, 'fixtures');
const jsonFixture = fs.readFileSync(path.join(FIXTURES, 'livelib-file-export.json'));
const csvFixture = fs.readFileSync(path.join(FIXTURES, 'livelib-file-export.csv'));

function form({ file = jsonFixture, filename = 'livelib-routeprobe-read-28.10.2026.json', ...fields } = {}) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) body.append(key, String(value));
  }
  if (file) {
    const type = filename.endsWith('.csv') ? 'text/csv' : 'application/json';
    body.append('file', new Blob([file], { type }), filename);
  }
  return body;
}

/**
 * The route module and the stats payload share one cache directory, so a single
 * server process serves the whole file (one port, started once). The
 * `importLivelib` stub in the 409 case is the only place a scrape is touched —
 * and it never reaches the network.
 */
let server = null;
let base = '';

test.before(async () => {
  const express = require('express');
  const routes = require('../server/books/routes');
  const app = express();
  app.use(express.json());
  app.use('/api/books', routes);
  app.use((err, req, res, next) => {
    res.status(err.status || err.statusCode || 500).json({ code: err.code, error: err.message });
  });
  server = app.listen(PORT);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${PORT}/api/books`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test('livelib-file import: multipart upload, shelves, idempotency, stats', async () => {
  /* ---------------- first upload: «Прочитал», JSON ---------------- */
  const first = await fetch(`${base}/import/livelib-file`, {
    method: 'POST',
    body: form({ username: 'RouteProbe' }),
  });
  assert.equal(first.status, 201);
  const body = await first.json();
  assert.equal(body.ok, true);
  assert.equal(body.source, 'livelib');
  assert.equal(body.userKey, 'RouteProbe');
  assert.equal(body.profileKey, 'livelib-RouteProbe');
  assert.equal(body.origin, 'livelib-file');
  // The shelf is sniffed from `livelib-{user}-{pagename}-{date}.json`.
  assert.equal(body.shelf, 'read');
  assert.equal(body.format, 'json');
  assert.equal(body.imported, 3);
  assert.deepEqual(
    { added: body.added, enriched: body.enriched, skipped: body.skipped },
    { added: 3, enriched: 0, skipped: 0 }
  );
  assert.equal(body.events, 3);
  assert.deepEqual(body.shelves, { read: 3, dnf: 0, reading: 0, wish: 0 });
  assert.equal(body.stats.withIsbn, 1);
  assert.equal(body.warnings.length, 2);
  // No metadata job was requested, and no network call happened.
  assert.equal(body.resolve, null);

  // The document on disk is the profile the dashboard reads.
  const stored = bookCache.getProfile('livelib', 'RouteProbe');
  assert.equal(stored.origin, 'livelib-file');
  assert.equal(stored.source, 'livelib');
  assert.equal(stored.events.length, 3);
  assert.deepEqual(stored.shelves, { read: 3, dnf: 0, reading: 0, wish: 0 });
  assert.equal(stored.fileImports.length, 1);
  assert.equal(stored.fileImports[0].format, 'json');
  assert.equal(stored.fileImports[0].filename, 'livelib-routeprobe-read-28.10.2026.json');
  const raw = fs.readdirSync(path.join(BOOK_CACHE_DIR, 'imports'));
  assert.equal(raw.some((name) => name.startsWith('livelib-RouteProbe-')), true);

  // /profiles exposes the acquisition path and the shelf tallies.
  const profiles = await (await fetch(`${base}/profiles`)).json();
  const entry = profiles.profiles.find((profile) => profile.key === 'livelib-RouteProbe');
  assert.ok(entry);
  assert.equal(entry.origin, 'livelib-file');
  assert.deepEqual(entry.shelves, { read: 3, dnf: 0, reading: 0, wish: 0 });
  assert.equal(entry.fileImports, 1);

  /* ---------------- second upload of the same file: idempotent ---------------- */
  const again = await fetch(`${base}/import/livelib-file`, {
    method: 'POST',
    body: form({ username: '@RouteProbe' }),
  });
  assert.equal(again.status, 201);
  const againBody = await again.json();
  assert.deepEqual(
    { added: againBody.added, enriched: againBody.enriched, skipped: againBody.skipped },
    { added: 0, enriched: 0, skipped: 3 }
  );
  assert.equal(againBody.events, 3);
  assert.equal(bookCache.getProfile('livelib', 'RouteProbe').fileImports.length, 2);

  /* ---------------- CSV + explicit shelf: «Хочу прочитать» ---------------- */
  const wish = await fetch(`${base}/import/livelib-file`, {
    method: 'POST',
    body: form({ file: csvFixture, filename: 'export.csv', username: 'RouteProbe', shelf: 'Хочу прочитать' }),
  });
  assert.equal(wish.status, 201);
  const wishBody = await wish.json();
  assert.equal(wishBody.shelf, 'wish');
  assert.equal(wishBody.format, 'csv');
  assert.equal(wishBody.added, 3);
  assert.deepEqual(wishBody.shelves, { read: 3, dnf: 0, reading: 0, wish: 3 });
  // The CSV keeps the same books (same links), so the read shelf is untouched.
  assert.equal(bookCache.getProfile('livelib', 'RouteProbe').events.length, 6);

  /* ---------------- stats: plans never join the reading history ---------------- */
  const stats = buildBooksStats({ profile: 'livelib-RouteProbe' });
  assert.equal(stats.summary.eventCount, 3);
  assert.equal(stats.summary.bookCount, 3);
  assert.equal(stats.summary.shelfExcluded, 3);
  assert.deepEqual(stats.summary.shelves, { read: 3, dnf: 0, reading: 0, wish: 3 });
  assert.equal(stats.summary.hardcoverStatusExcluded, 0);
  assert.deepEqual(stats.meta.statusFilter.byShelf, { wish: 3 });
  assert.deepEqual(stats.meta.statusFilter.keepShelves, ['read', 'dnf']);
  assert.equal(stats.meta.profiles[0].origin, 'livelib-file');
  assert.equal(stats.meta.profiles[0].shelfExcluded, 3);
  assert.equal(stats.sources.profile.origin, 'livelib-file');

  // File columns are metadata: genres/series/ISBN render without the chain.
  const annihilation = Object.values(stats.booksIndex).find((work) => work.title === 'Аннигиляция');
  assert.ok(annihilation);
  assert.deepEqual(annihilation.genres, ['фэнтези', 'ужасы']);
  assert.deepEqual(annihilation.series, ['Южный предел']);
  assert.equal(annihilation.isbn13, '9785699989676');
  assert.deepEqual(annihilation.metadataSources, ['livelib-file']);
  assert.equal(annihilation.unresolved, false);
  // No plan shelf leaked into the work list.
  assert.equal(Object.keys(stats.booksIndex).length, 3);
});

test('livelib-file import: explicit 400/409 instead of a silent ignore', async (t) => {
  const noFile = await fetch(`${base}/import/livelib-file`, {
    method: 'POST',
    body: form({ username: 'RouteProbe', file: null }),
  });
  assert.equal(noFile.status, 400);
  assert.equal((await noFile.json()).code, 'file_required');

  const noUser = await fetch(`${base}/import/livelib-file`, {
    method: 'POST',
    body: form({ filename: 'livelib-nobody-read.json' }),
  });
  assert.equal(noUser.status, 400);
  assert.equal((await noUser.json()).code, 'username_required');

  for (const junk of ['../../etc/passwd', 'a b', 'x'.repeat(65)]) {
    const response = await fetch(`${base}/import/livelib-file`, {
      method: 'POST',
      body: form({ username: junk }),
    });
    assert.equal(response.status, 400, `username ${JSON.stringify(junk)}`);
    assert.equal((await response.json()).code, 'invalid_user_key');
  }

  const badShelf = await fetch(`${base}/import/livelib-file`, {
    method: 'POST',
    body: form({ username: 'RouteProbe', shelf: 'полка-мечты' }),
  });
  assert.equal(badShelf.status, 400);
  assert.equal((await badShelf.json()).code, 'invalid_shelf');

  // A file name the service itself could not have produced and no `shelf` field.
  const noShelf = await fetch(`${base}/import/livelib-file`, {
    method: 'POST',
    body: form({ username: 'RouteProbe', filename: 'export.json' }),
  });
  assert.equal(noShelf.status, 400);
  const noShelfBody = await noShelf.json();
  assert.equal(noShelfBody.code, 'shelf_required');
  assert.match(noShelfBody.error, /read\|dnf\|reading\|wish/);

  const brokenJson = await fetch(`${base}/import/livelib-file`, {
    method: 'POST',
    body: form({ username: 'RouteProbe', file: Buffer.from('{"title": "x"', 'utf8') }),
  });
  assert.equal(brokenJson.status, 400);
  assert.equal((await brokenJson.json()).code, 'livelib_file_invalid_json');

  const brokenCsv = await fetch(`${base}/import/livelib-file`, {
    method: 'POST',
    body: form({ username: 'RouteProbe', file: Buffer.from('foo;bar\n1;2\n', 'utf8'), filename: 'livelib-x-read.csv' }),
  });
  assert.equal(brokenCsv.status, 400);
  assert.equal((await brokenCsv.json()).code, 'livelib_file_unknown_columns');

  /* A scrape of the same profile in flight: 409, no merge. */
  const realImportLivelib = livelib.importLivelib;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  livelib.importLivelib = async () => {
    await gate;
    throw new livelib.LivelibError('LiveLib ограничил доступ (HTTP 403).', 'livelib_blocked');
  };
  t.after(() => {
    livelib.importLivelib = realImportLivelib;
  });

  const job = importJobs.startLivelibImport('BundleProbe', { force: true });
  assert.equal(job.done, false);
  const conflict = await fetch(`${base}/import/livelib-file`, {
    method: 'POST',
    body: form({ username: 'BundleProbe' }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'livelib_import_running');
  assert.equal(bookCache.getProfile('livelib', 'BundleProbe'), null);

  release();
  await importJobs.idle();
  assert.equal(importJobs.getStatus(job.id).stage, 'failed');
});
