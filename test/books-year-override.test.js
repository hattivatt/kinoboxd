'use strict';

/**
 * Manual publication-year corrections (round 29.10.2026).
 *
 * User verdicts pinned here:
 *   - year priority is `manual > firstPublishedYear > editionYear > unknown`;
 *   - an edition year is an honest fallback, always marked
 *     (`yearSource: 'edition'`), never presented as a first publication;
 *   - a manual correction persists per profile in
 *     `cache-book/year-overrides/<profile>.json`, survives resolve/backfill
 *     (a details document rewrite) and a re-import of the same file export;
 *   - HTTP POST /api/books/year-override validates profile/workId/year, and
 *     `year: null` removes the correction.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-year-override-'));

const bookCache = require('../server/books/book-cache');
const { buildBooksStats, resolveWorkYear } = require('../server/books/stats');
const { buildFileEvent, mergeFileIntoProfile, normalizeRecord } = require('../server/books/livelib-file');

const PORT = 7025;

function profile(userKey, events) {
  return {
    schemaVersion: 1,
    source: 'livelib',
    userKey,
    sourceUserId: null,
    importedAt: '2026-10-29T00:00:00.000Z',
    events,
    warnings: [],
  };
}

test('year priority: manual > first > edition > unknown', () => {
  const details = { firstPublishedYear: 1564, publicationYear: 2005 };
  const manual = resolveWorkYear(details, null, {}, { year: 1700 });
  assert.equal(manual.year, 1700);
  assert.equal(manual.yearSource, 'manual');
  assert.equal(manual.yearOverride, 1700);
  assert.equal(manual.firstPublishedYear, 1564);
  assert.equal(manual.editionYear, 2005);

  const first = resolveWorkYear(details, null, {}, null);
  assert.equal(first.year, 1564);
  assert.equal(first.yearSource, 'first');

  const edition = resolveWorkYear({ publicationYear: 2005 }, null, {}, null);
  assert.equal(edition.year, 2005);
  assert.equal(edition.yearSource, 'edition');
  assert.equal(edition.firstPublishedYear, null);

  const unknown = resolveWorkYear({}, null, {}, null);
  assert.equal(unknown.year, null);
  assert.equal(unknown.yearSource, null);

  // An insane manual value is ignored, not written into the chart.
  const insane = resolveWorkYear(details, null, {}, { year: 9999 });
  assert.equal(insane.year, 1564);
  assert.equal(insane.yearSource, 'first');
});

test('a manual override survives resolve, backfill and a file re-import', async () => {
  const userKey = 'YearOverridePersist';
  const title = 'Гамлет, принц датский';
  const authors = [{ name: 'Уильям Шекспир' }];
  const row = {
    title,
    authors,
    bookHref: null,
    readDate: 'сентябрь 2026',
    rating: { user: '5' },
    details: { publishers: 'АСТ', year: '2005' },
  };
  const record = normalizeRecord(row);
  const event = buildFileEvent(record, 'read', 1);
  const fileKey = event.fileKey;
  assert.ok(fileKey && fileKey.startsWith('tk:'));
  const fileWorkId = `ll:file:${fileKey}`;

  await bookCache.saveProfile('livelib', userKey, profile(userKey, [event]));
  let stats = buildBooksStats({ profile: `livelib-${userKey}` });
  assert.equal(stats.booksIndex[fileWorkId].year, 2005);
  assert.equal(stats.booksIndex[fileWorkId].yearSource, 'edition');

  // Manual correction keyed by the workId the UI saw.
  await bookCache.setYearOverride('livelib', userKey, fileWorkId, 1700);
  stats = buildBooksStats({ profile: `livelib-${userKey}` });
  assert.equal(stats.booksIndex[fileWorkId].year, 1700);
  assert.equal(stats.booksIndex[fileWorkId].yearSource, 'manual');
  assert.equal(stats.booksIndex[fileWorkId].yearOverride, 1700);
  assert.equal(stats.summary.yearManualCount, 1);

  // Resolve links the file row to a Hardcover work: workId changes, the
  // override follows via the stable event key.
  await bookCache.saveDetails(9001, {
    schemaVersion: 2,
    hcWorkId: 9001,
    title,
    authors,
    publicationYear: 2005,
    firstPublishedYear: 1603,
  });
  await bookCache.saveLink(`file:${fileKey}`, {
    schemaVersion: 2,
    livelibBookId: null,
    workId: 'hc:9001',
    method: 'title',
    score: 1,
  });
  stats = buildBooksStats({ profile: `livelib-${userKey}` });
  assert.equal(stats.booksIndex['hc:9001'].year, 1700);
  assert.equal(stats.booksIndex['hc:9001'].yearSource, 'manual');
  assert.equal(stats.booksIndex['hc:9001'].firstPublishedYear, 1603);

  // Backfill rewrites the details document (first-publication claim); the
  // manual correction still wins.
  await bookCache.saveDetails(9001, {
    schemaVersion: 2,
    hcWorkId: 9001,
    title,
    authors,
    publicationYear: 2005,
    firstPublishedYear: 1603,
    firstPublishedYearCheckedAt: '2026-10-29T00:00:00.000Z',
  });
  stats = buildBooksStats({ profile: `livelib-${userKey}` });
  assert.equal(stats.booksIndex['hc:9001'].year, 1700);
  assert.equal(stats.booksIndex['hc:9001'].yearSource, 'manual');

  // Re-import of the same export (same title|surname key) does not lose it.
  const merged = mergeFileIntoProfile(bookCache.getProfile('livelib', userKey), {
    userKey,
    books: [record],
    shelf: 'read',
    now: '2026-10-29T01:00:00.000Z',
  });
  await bookCache.saveProfile('livelib', userKey, merged.profile);
  stats = buildBooksStats({ profile: `livelib-${userKey}` });
  assert.equal(stats.booksIndex['hc:9001'].year, 1700);
  assert.equal(stats.booksIndex['hc:9001'].yearSource, 'manual');

  // Reset restores the provider chain: first publication wins again.
  await bookCache.clearYearOverride('livelib', userKey, fileWorkId);
  stats = buildBooksStats({ profile: `livelib-${userKey}` });
  assert.equal(stats.booksIndex['hc:9001'].year, 1603);
  assert.equal(stats.booksIndex['hc:9001'].yearSource, 'first');
  assert.equal(stats.booksIndex['hc:9001'].yearOverride, null);
});

test('HTTP POST /api/books/year-override validates and is profile-scoped', async (t) => {
  const express = require('express');
  const routes = require('../server/books/routes');
  const app = express();
  app.use(express.json());
  app.use('/api/books', routes);
  app.use((err, req, res, next) => {
    res.status(err.status || err.statusCode || 500).json({ code: err.code, error: err.message });
  });
  const server = app.listen(PORT);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${PORT}/api/books`;

  const event = {
    id: 'll:9100',
    source: 'livelib',
    sourceBookId: '9100',
    title: 'Гаргантюа и Пантагрюэль',
    authors: ['Франсуа Рабле'],
    status: 'read',
    finishedAt: '2026-09-01',
  };
  await bookCache.saveDetails(9100, {
    schemaVersion: 2,
    hcWorkId: 9100,
    title: 'Гаргантюа и Пантагрюэль',
    authors: [{ name: 'Франсуа Рабле' }],
    publicationYear: 2026,
    firstPublishedYear: 1564,
    firstPublishedYearSource: 'litres',
  });
  await bookCache.saveLink('9100', {
    schemaVersion: 2,
    livelibBookId: '9100',
    workId: 'hc:9100',
    method: 'isbn',
    score: 1,
  });
  await bookCache.saveProfile('livelib', 'YearOverrideApi', profile('YearOverrideApi', [event]));
  await bookCache.saveProfile('livelib', 'YearOverrideApiOther', profile('YearOverrideApiOther', [event]));

  async function post(body) {
    const response = await fetch(`${base}/year-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  assert.equal((await post({ workId: 'hc:9100', year: 1700 })).body.code, 'profile_required');
  assert.equal(
    (await post({ profile: 'livelib-NoSuchProfile', workId: 'hc:9100', year: 1700 })).body.code,
    'unknown_profile'
  );
  assert.equal(
    (await post({ profile: 'livelib-YearOverrideApi', year: 1700 })).body.code,
    'work_id_required'
  );
  for (const year of ['abc', 0, 9999, 12.5]) {
    assert.equal(
      (await post({ profile: 'livelib-YearOverrideApi', workId: 'hc:9100', year })).body.code,
      'invalid_year',
      `year=${year}`
    );
  }
  assert.equal(
    (await post({ profile: 'livelib-YearOverrideApi', workId: 'hc:does-not-exist', year: 1700 })).body.code,
    'unknown_work'
  );

  const saved = await post({ profile: 'livelib-YearOverrideApi', workId: 'hc:9100', year: 1700 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.year, 1700);
  assert.equal(saved.body.removed, false);

  const stats = await (await fetch(`${base}/stats?profile=livelib-YearOverrideApi`)).json();
  assert.equal(stats.booksIndex['hc:9100'].year, 1700);
  assert.equal(stats.booksIndex['hc:9100'].yearSource, 'manual');
  assert.equal(stats.booksIndex['hc:9100'].yearOverride, 1700);

  // The same work in another profile is untouched: overrides are per profile.
  const other = await (await fetch(`${base}/stats?profile=livelib-YearOverrideApiOther`)).json();
  assert.equal(other.booksIndex['hc:9100'].year, 1564);
  assert.equal(other.booksIndex['hc:9100'].yearSource, 'first');

  const removed = await post({ profile: 'livelib-YearOverrideApi', workId: 'hc:9100', year: null });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.removed, true);
  const after = await (await fetch(`${base}/stats?profile=livelib-YearOverrideApi`)).json();
  assert.equal(after.booksIndex['hc:9100'].year, 1564);
  assert.equal(after.booksIndex['hc:9100'].yearSource, 'first');

  // Idempotent removal.
  const again = await post({ profile: 'livelib-YearOverrideApi', workId: 'hc:9100', year: null });
  assert.equal(again.status, 200);
  assert.equal(again.body.removed, false);
});

test('the override file is fingerprint-revalidated from disk', async () => {
  const userKey = 'YearOverrideFingerprint';
  const event = {
    id: 'll:9200',
    source: 'livelib',
    sourceBookId: '9200',
    title: 'Книга',
    authors: ['Автор'],
    status: 'read',
    finishedAt: '2026-09-01',
  };
  await bookCache.saveProfile('livelib', userKey, profile(userKey, [event]));
  await bookCache.saveDetails(9200, {
    schemaVersion: 2,
    hcWorkId: 9200,
    title: 'Книга',
    authors: [{ name: 'Автор' }],
    publicationYear: 2000,
  });
  await bookCache.saveLink('9200', {
    schemaVersion: 2,
    livelibBookId: '9200',
    workId: 'hc:9200',
    method: 'isbn',
    score: 1,
  });

  let stats = buildBooksStats({ profile: `livelib-${userKey}` });
  assert.equal(stats.booksIndex['hc:9200'].year, 2000);
  assert.equal(stats.booksIndex['hc:9200'].yearSource, 'edition');

  // External edit (another process) without a server restart.
  await bookCache.writeJsonAtomic(bookCache.yearOverridesPath('livelib', userKey), {
    schemaVersion: 1,
    profile: { source: 'livelib', userKey },
    overrides: { 'hc:9200': { year: 1950, updatedAt: '2026-10-29T00:00:00.000Z' } },
  });
  stats = buildBooksStats({ profile: `livelib-${userKey}` });
  assert.equal(stats.booksIndex['hc:9200'].year, 1950);
  assert.equal(stats.booksIndex['hc:9200'].yearSource, 'manual');
});

test('UI texts mark edition/manual years honestly and offer the correction', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const booksSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'books.js'), 'utf8');
  const apiSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'api.js'), 'utf8');
  const chartsSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'charts.js'), 'utf8');

  // The card marks an edition year with `*` and a manual correction with `✎`.
  assert.match(booksSource, /entry\.yearSource === 'edition'\) return `\$\{entry\.year\}\*`/);
  assert.match(booksSource, /entry\.yearSource === 'manual'\) return `\$\{entry\.year\}✎`/);
  assert.match(booksSource, /Год издания: \$\{entry\.year\} · первоиздание неизвестно/);
  // Kebab action + modal + source line + reset.
  assert.match(booksSource, /label: 'Исправить год'/);
  assert.match(booksSource, /function openYearEditModal\(book\)/);
  assert.match(booksSource, /Ручная правка: \$\{book\.yearOverride/);
  assert.match(booksSource, /Сбросить правку/);
  // Notes never call an edition year a first publication.
  assert.match(booksSource, /год издания вместо первоиздания/);
  assert.match(booksSource, /ручная правка/);
  assert.match(booksSource, /yearEditionCount/);
  // Year buckets carry the edition marker into the donut legend/tooltip.
  assert.match(booksSource, /item\.editionCount > 0 \? `\$\{item\.year\}\*`/);
  assert.match(chartsSource, /yearNote/);
  // API client.
  assert.match(apiSource, /export function setBookYearOverride\(profile, workId, year/);
  assert.match(apiSource, /\/api\/books\/year-override/);
});
