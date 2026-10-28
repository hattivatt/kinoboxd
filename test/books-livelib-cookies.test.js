'use strict';

/**
 * K5 / task 2: LiveLib cookie store (plan B persistence).
 *
 * Pinned here:
 *   - only `(source, userKey)` = livelib profile files are addressable,
 *   - the file is written 0600 inside a 0700 directory,
 *   - a header is normalised (`Cookie:` prefix, pairs object, whitespace) and
 *     validated (control chars / junk rejected, no value echoed in the error),
 *   - memory is invalidated by file fingerprint (external rotation is visible),
 *   - the API-facing status is masked: `{ present, savedAt, count }` only,
 *   - the HTTP route accepts `cookieHeader`, persists it and reports only the
 *     masked `cookies` block,
 *   - a supplied header turns off the LiveLib reuse window (the user is
 *     explicitly retrying) and never reaches logs/job status.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BOOK_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-book-cookies-'));
process.env.KINOBOXD_CACHE_BOOK_DIR = BOOK_CACHE_DIR;

const bookCache = require('../server/books/book-cache');
const cookies = require('../server/books/livelib-cookies');
const livelib = require('../server/books/livelib');
const importJobs = require('../server/books/import');

const HEADER = 'Cookie: __ddg1_=abc123; __ddg2_=def456';

/*
 * No network in this suite: starting a real LiveLib job would scrape the live
 * site (AGENTS.md forbids using live sources to "check the parser"). The fake
 * importer captures the jar it was given and fails as a blocked source — which
 * is also the state we want the cookie store to survive.
 */
const realImportLivelib = livelib.importLivelib;
let lastImport = null;
livelib.importLivelib = async (username, options = {}) => {
  lastImport = {
    username,
    cookieHeader: livelib.cookieHeaderOf(options.jar),
    seeded: options.jar ? options.jar.size : 0,
  };
  throw new livelib.LivelibError(
    'LiveLib ограничил доступ (HTTP 403) — DDoS-Guard/анти-бот; импорт остановлен.',
    'livelib_blocked'
  );
};
test.after(() => {
  livelib.importLivelib = realImportLivelib;
});

test('normaliseCookieHeader accepts the shapes a browser paste produces', () => {
  assert.equal(cookies.normalizeCookieHeader(HEADER), '__ddg1_=abc123; __ddg2_=def456');
  assert.equal(
    cookies.normalizeCookieHeader('  __ddg1_=abc123 ;__ddg2_=def456  '),
    '__ddg1_=abc123; __ddg2_=def456'
  );
  assert.equal(
    cookies.normalizeCookieHeader({ __ddg1_: 'abc123', __ddg2_: 'def456' }),
    '__ddg1_=abc123; __ddg2_=def456'
  );
  assert.equal(cookies.countCookies(HEADER), 2);
  assert.deepEqual(
    [...cookies.parseCookieHeader(HEADER).entries()],
    [
      ['__ddg1_', 'abc123'],
      ['__ddg2_', 'def456'],
    ]
  );
});

test('normaliseCookieHeader rejects junk without echoing the value', () => {
  const cases = [
    ['', /пустой/],
    ['   ', /пустой/],
    ['__ddg1_=abc123\nEvil: injected', /управляющие/],
    ['not-a-pair', /name=value/],
    ['=novalue', /name=value/],
    ['bad name=x', /имя cookie/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(
      () => cookies.normalizeCookieHeader(input),
      (err) => {
        assert.equal(err.code, 'invalid_cookie_header');
        assert.match(err.message, pattern);
        // Never echo the payload (the whole point of the validation).
        assert.equal(err.message.includes('abc123'), false);
        assert.equal(err.message.includes('Evil'), false);
        return true;
      },
      `input ${JSON.stringify(input)}`
    );
  }

  const long = `a=${'x'.repeat(cookies.MAX_HEADER_LENGTH)}`;
  assert.throws(() => cookies.normalizeCookieHeader(long), /длиннее/);
});

test('saveCookies writes 0600 into a 0700 dir and reports masked status', async () => {
  const saved = await cookies.saveCookies('livelib', 'Margaret', HEADER, {
    now: '2026-10-28T10:00:00.000Z',
  });
  assert.equal(saved.present, true);
  assert.equal(saved.count, 2);
  assert.equal(saved.savedAt, '2026-10-28T10:00:00.000Z');

  const filePath = cookies.cookiePath('livelib', 'Margaret');
  assert.equal(filePath, path.join(BOOK_CACHE_DIR, 'cookies', 'livelib-Margaret.json'));
  const stat = fs.statSync(filePath);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);

  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.source, 'livelib');
  assert.equal(stored.userKey, 'Margaret');
  assert.equal(stored.cookieHeader, '__ddg1_=abc123; __ddg2_=def456');

  // API-facing status is masked: presence + count, no header, no names.
  const status = cookies.cookieStatus('livelib', 'Margaret');
  assert.deepEqual(status, { present: true, savedAt: '2026-10-28T10:00:00.000Z', count: 2 });
  assert.equal(JSON.stringify(status).includes('__ddg'), false);
  assert.equal(JSON.stringify(status).includes('abc123'), false);

  const got = cookies.getCookies('livelib', 'Margaret');
  assert.equal(got.cookieHeader, '__ddg1_=abc123; __ddg2_=def456');
});

test('the store is scoped per profile and never crosses users', async () => {
  await cookies.saveCookies('livelib', 'Alpha', '__ddg1_=alpha');
  assert.equal(cookies.cookieStatus('livelib', 'Alpha').present, true);
  assert.equal(cookies.cookieStatus('livelib', 'Margaret').present, true);
  assert.equal(cookies.cookieStatus('livelib', 'Nobody').present, false);
  assert.deepEqual(cookies.cookieStatus('livelib', 'Nobody'), {
    present: false,
    savedAt: null,
    count: 0,
  });
  // Another source is not supported (only LiveLib is crawled).
  await assert.rejects(
    () => cookies.saveCookies('hardcover', '34748', '__ddg1_=x'),
    (err) => err.code === 'unsupported_cookie_source'
  );
});

test('memory is fingerprint-invalidated: an external rotation is visible', async () => {
  const userKey = 'Rotating';
  const saved = await cookies.saveCookies('livelib', userKey, '__ddg1_=first');
  assert.equal(cookies.getCookies('livelib', userKey).cookieHeader, '__ddg1_=first');

  // Another process (or the user) rewrites the file with a fresh header.
  const filePath = saved.path;
  const rotated = {
    schemaVersion: 1,
    source: 'livelib',
    userKey,
    cookieHeader: '__ddg1_=second',
    savedAt: '2026-10-29T00:00:00.000Z',
  };
  fs.writeFileSync(filePath, JSON.stringify(rotated), 'utf8');
  fs.chmodSync(filePath, 0o600);

  const after = cookies.getCookies('livelib', userKey);
  assert.equal(after.cookieHeader, '__ddg1_=second');
  assert.equal(after.savedAt, '2026-10-29T00:00:00.000Z');

  // clearCookies is idempotent and drops the memory entry too.
  assert.equal(await cookies.clearCookies('livelib', userKey), true);
  assert.equal(await cookies.clearCookies('livelib', userKey), false);
  assert.equal(cookies.getCookies('livelib', userKey), null);
});

test('startLivelibImport: a cookie paste forces a fresh job and is stored masked', async () => {
  // A fresh cached profile would normally be reused; the paste must override.
  await bookCache.saveProfile('livelib', 'Pasted', {
    schemaVersion: 1,
    source: 'livelib',
    userKey: 'Pasted',
    importedAt: new Date().toISOString(),
    events: [
      { id: 'll:1', sourceBookId: '1', title: 'One', status: 'read', finishedAt: '2024-01-01' },
    ],
    warnings: [],
  });

  const job = importJobs.startLivelibImport('Pasted', {
    cookieHeader: 'Cookie: __ddg1_=pasted',
  });
  assert.equal(job.reused, false);
  assert.equal(job.force, true);
  assert.deepEqual(job.cookies, {
    provided: true,
    stored: false,
    present: true,
    savedAt: null,
  });
  // No header anywhere in the public job status.
  assert.equal(JSON.stringify(job).includes('__ddg'), false);
  assert.equal(JSON.stringify(job).includes('pasted'), false);

  await importJobs.idle();

  const status = importJobs.getStatus(job.id);
  assert.equal(status.cookies.provided, true);
  assert.equal(status.cookies.stored, true);
  assert.equal(status.cookies.count, 1);
  assert.ok(status.cookies.savedAt);
  assert.equal(JSON.stringify(status.cookies).includes('__ddg'), false);
  // The stored header reached the importer's jar …
  assert.equal(lastImport.username, 'Pasted');
  assert.equal(lastImport.cookieHeader, '__ddg1_=pasted');
  // … and was kept for the retry: a valid paste survives a failed import.
  assert.equal(status.stage, 'failed');
  assert.equal(status.code, 'livelib_blocked');
  assert.deepEqual(status.blocked, {
    code: 'livelib_blocked',
    planB: 'cookieHeader',
    cookiesPresent: true,
  });
  assert.equal(cookies.cookieStatus('livelib', 'Pasted').present, true);
  assert.equal(
    cookies.getCookies('livelib', 'Pasted').cookieHeader,
    '__ddg1_=pasted'
  );
});

/**
 * DELETE /api/books/import/livelib/cookies — the other half of plan B.
 *
 * The stored header is a secret the user lent us for one retry, so it must be
 * removable through the API (no shell into the cache dir). Pinned here:
 *   - 200 + masked `{present:false}` after a delete, file really gone,
 *     `/profiles` reports `cookies.present === false`;
 *   - a second delete is a 404 `cookies_not_found` (not a silent 200);
 *   - a missing/odd `userKey` is a 400 and touches nothing;
 *   - a delete during a running import of that profile is 409 rather than a
 *     claim the job would contradict;
 *   - the response never echoes the header value or cookie names.
 */
test('DELETE cookies: removes the file, 404 when absent, 400 on junk, 409 while importing', async (t) => {
  const express = require('express');
  const routes = require('../server/books/routes');
  const app = express();
  app.use(express.json());
  app.use('/api/books', routes);
  app.use((err, req, res, next) => {
    res.status(err.status || err.statusCode || 500).json({ code: err.code, error: err.message });
  });
  const server = app.listen(6313);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:6313/api/books';

  await cookies.saveCookies('livelib', 'Deletable', '__ddg1_=secret1; __ddg2_=secret2', {
    now: '2026-10-28T11:00:00.000Z',
  });
  // The profile document is what /profiles lists; cookies are a side store.
  await bookCache.saveProfile('livelib', 'Deletable', {
    schemaVersion: 1,
    source: 'livelib',
    userKey: 'Deletable',
    importedAt: new Date().toISOString(),
    events: [{ id: 'll:1', sourceBookId: '1', title: 'One', status: 'read', finishedAt: '2024-01-01' }],
    warnings: [],
  });
  const filePath = cookies.cookiePath('livelib', 'Deletable');
  assert.equal(fs.existsSync(filePath), true);

  const removed = await fetch(`${base}/import/livelib/cookies?userKey=Deletable`, {
    method: 'DELETE',
  });
  assert.equal(removed.status, 200);
  const removedBody = await removed.json();
  assert.equal(removedBody.removed, true);
  assert.equal(removedBody.source, 'livelib');
  assert.equal(removedBody.userKey, 'Deletable');
  assert.deepEqual(removedBody.cookies, { present: false, savedAt: null, count: 0 });
  assert.equal(JSON.stringify(removedBody).includes('secret1'), false);
  assert.equal(JSON.stringify(removedBody).includes('__ddg'), false);
  assert.equal(fs.existsSync(filePath), false);
  // In-memory entry is gone too (no stale re-read).
  assert.equal(cookies.getCookies('livelib', 'Deletable'), null);

  // The profile survives, its cookie flag does not.
  const profiles = await (await fetch(`${base}/profiles`)).json();
  const entry = profiles.profiles.find((profile) => profile.key === 'livelib-Deletable');
  assert.ok(entry, 'profile document must not be deleted together with its cookies');
  assert.deepEqual(entry.cookies, { present: false, savedAt: null, count: 0 });

  // Second delete: explicitly 404, so the UI can tell "already gone".
  const again = await fetch(`${base}/import/livelib/cookies?userKey=Deletable`, {
    method: 'DELETE',
  });
  assert.equal(again.status, 404);
  assert.equal((await again.json()).code, 'cookies_not_found');

  // Missing / malformed userKey: 400, and the store of another profile is intact.
  await cookies.saveCookies('livelib', 'Untouched', '__ddg1_=keepme');
  const missing = await fetch(`${base}/import/livelib/cookies`, { method: 'DELETE' });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, 'user_key_required');
  for (const junk of ['../../etc/passwd', 'a b', 'x'.repeat(121)]) {
    const bad = await fetch(
      `${base}/import/livelib/cookies?userKey=${encodeURIComponent(junk)}`,
      { method: 'DELETE' }
    );
    assert.equal(bad.status, 400, `userKey ${JSON.stringify(junk)}`);
    assert.equal((await bad.json()).code, 'invalid_user_key');
  }
  assert.equal(cookies.cookieStatus('livelib', 'Untouched').present, true);

  // A delete while this profile's import is in flight is a 409.
  await cookies.saveCookies('livelib', 'Deleting', '__ddg1_=busy');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  livelib.importLivelib = async () => {
    await gate;
    throw new livelib.LivelibError('LiveLib ограничил доступ (HTTP 403).', 'livelib_blocked');
  };
  const job = importJobs.startLivelibImport('Deleting', { force: true });
  assert.equal(job.done, false);
  const conflict = await fetch(`${base}/import/livelib/cookies?userKey=Deleting`, {
    method: 'DELETE',
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'livelib_import_running');
  assert.equal(cookies.cookieStatus('livelib', 'Deleting').present, true);

  release();
  await importJobs.idle();
  assert.equal(importJobs.getStatus(job.id).stage, 'failed');
  // …and after the job finished the delete goes through.
  const after = await fetch(`${base}/import/livelib/cookies?userKey=Deleting`, { method: 'DELETE' });
  assert.equal(after.status, 200);
  assert.equal(cookies.cookieStatus('livelib', 'Deleting').present, false);
});

test('startLivelibImport rejects a malformed paste synchronously', () => {
  assert.throws(
    () => importJobs.startLivelibImport('Broken', { cookieHeader: 'no-equals-sign' }),
    (err) => err.code === 'invalid_cookie_header'
  );
  assert.equal(cookies.cookieStatus('livelib', 'Broken').present, false);
});

test('a paste during a running import is a 409, not a silent drop', async () => {
  // Hold one import open, then try to paste cookies for the same profile.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  livelib.importLivelib = async () => {
    await gate;
    throw new livelib.LivelibError('LiveLib ограничил доступ (HTTP 403).', 'livelib_blocked');
  };

  const job = importJobs.startLivelibImport('Busy', { force: true });
  assert.equal(job.done, false);
  assert.throws(
    () => importJobs.startLivelibImport('Busy', { cookieHeader: '__ddg1_=late' }),
    (err) => {
      assert.equal(err.code, 'livelib_import_running');
      return true;
    }
  );
  // The late paste was not written: it was never applied.
  assert.equal(cookies.cookieStatus('livelib', 'Busy').present, false);

  release();
  await importJobs.idle();
  assert.equal(importJobs.getStatus(job.id).stage, 'failed');
});

test('HTTP route accepts cookieHeader, stores it 0600 and masks the response', async (t) => {
  const express = require('express');
  const routes = require('../server/books/routes');
  const app = express();
  app.use(express.json());
  app.use('/api/books', routes);
  app.use((err, req, res, next) => {
    res.status(err.status || err.statusCode || 500).json({ code: err.code, error: err.message });
  });
  const server = app.listen(6312);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:6312/api/books';

  const accepted = await fetch(`${base}/import/livelib`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'RoutePaste', cookieHeader: HEADER }),
  });
  assert.equal(accepted.status, 202);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.cookies.provided, true);
  assert.equal(JSON.stringify(acceptedBody).includes('abc123'), false);

  await importJobs.idle();
  const filePath = cookies.cookiePath('livelib', 'RoutePaste');
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(fs.readFileSync(filePath, 'utf8')).cookieHeader,
    '__ddg1_=abc123; __ddg2_=def456'
  );

  // /profiles exposes only the mask (the paste job failed, so seed a profile
  // document the way a successful import would).
  await bookCache.saveProfile('livelib', 'RoutePaste', {
    schemaVersion: 1,
    source: 'livelib',
    userKey: 'RoutePaste',
    importedAt: new Date().toISOString(),
    events: [
      { id: 'll:1', sourceBookId: '1', title: 'One', status: 'read', finishedAt: '2024-01-01' },
    ],
    warnings: [],
  });
  const profiles = await (await fetch(`${base}/profiles`)).json();
  const entry = profiles.profiles.find((profile) => profile.key === 'livelib-RoutePaste');
  assert.equal(entry.cookies.present, true);
  assert.equal(entry.cookies.count, 2);
  assert.equal(entry.cookies.savedAt.length > 0, true);
  assert.equal(JSON.stringify(entry).includes('abc123'), false);

  // Junk is a 400 with a code, nothing written.
  const rejected = await fetch(`${base}/import/livelib`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'RouteJunk', cookieHeader: 'not-a-cookie\nx: y' }),
  });
  assert.equal(rejected.status, 400);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.code, 'invalid_cookie_header');
  assert.equal(cookies.cookieStatus('livelib', 'RouteJunk').present, false);
});
