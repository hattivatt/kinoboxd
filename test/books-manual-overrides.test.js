'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const express = require('express');

const env = require('./helpers/env');

const run = env.makeTmpCache('books-manual-overrides');

after(() => {
  env.cleanupTmpDirs();
});

process.on('exit', () => {
  env.cleanupTmpDirs();
});

process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

const bookCache = require('../server/books/book-cache');
const seriesOverrides = require('../server/books/series-overrides');
const manualRoutes = require('../server/books/routes-manual');
const resolve = require('../server/books/resolve');
const { buildBooksStats, resolveProfileScope } = require('../server/books/stats');
const { portFor } = require('./helpers/port');

const PORT = portFor(211);
const PROFILE_KEY = 'livelib-Manual';
const NO_NETWORK = async () => {
  throw new Error('network disabled in books-manual-overrides');
};

describe('books-manual-overrides', () => {
  function profileDoc(events) {
    return {
      schemaVersion: 1,
      source: 'livelib',
      userKey: 'Manual',
      importedAt: '2026-11-12T00:00:00.000Z',
      events,
      warnings: [],
    };
  }

  function stats() {
    return buildBooksStats({ profileScope: resolveProfileScope(PROFILE_KEY) });
  }

  async function seed() {
    await bookCache.saveDetails(950, {
      schemaVersion: 1,
      hcWorkId: 950,
      title: 'Хроники Акары. Том 1',
      authors: [{ hcId: 21, name: 'Масаси Кисимото' }],
      genres: ['Фэнтези'],
      series: [{ hcId: 11, name: 'Хроники Акары', position: 1 }],
      pages: 200,
      publicationYear: 2000,
      firstPublishedYear: 1999,
      publisher: 'Акара',
      partial: false,
    });
    await bookCache.saveLink('501', {
      schemaVersion: 2,
      livelibBookId: '501',
      workId: 'hc:950',
      method: 'title-author',
      score: 0.95,
      evidence: {},
    });
    await bookCache.saveLink('502', {
      schemaVersion: 2,
      livelibBookId: '502',
      workId: 'hc:951',
      method: 'googlebooks-isbn',
      score: 1,
      evidence: { isbn: '9785000000009' },
    });
    await bookCache.saveLink('999', {
      schemaVersion: 2,
      livelibBookId: '999',
      workId: 'hc:999',
      method: 'isbn',
      score: 1,
      evidence: {},
    });
    await bookCache.saveProfile(
      'livelib',
      'Manual',
      profileDoc([
        {
          id: 'll:501',
          sourceBookId: '501',
          title: 'Хроники Акары. Том 3',
          authors: ['Масаси Кисимото'],
          rating: 8,
          ratingScale: 10,
          status: 'read',
          finishedAt: '2024-02-02',
          edition: { isbn13: '9785000000001', year: 2010 },
        },
        {
          id: 'll:502',
          sourceBookId: '502',
          title: 'Одинокая книга',
          authors: ['Никто Неизвестный'],
          rating: 6,
          ratingScale: 10,
          status: 'read',
          finishedAt: '2024-03-03',
          edition: { isbn13: '9785000000001', year: 2012 },
        },
      ])
    );
  }

  async function startServer(t) {
    const app = express();
    app.use(express.json());
    app.use('/api/books', manualRoutes);
    app.use((err, req, res, next) => {
      res.status(err.status || err.statusCode || 500).json({ error: err.message, code: err.code });
    });
    const server = app.listen(PORT);
    await new Promise((done) => server.once('listening', done));
    t.after(() => new Promise((done) => server.close(done)));
    return `http://127.0.0.1:${PORT}/api/books`;
  }

  function jsonPost(base, path, body, method = 'POST') {
    return fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('POST /series-override replaces the series of a work, DELETE restores it', async (t) => {
    await seed();
    const base = await startServer(t);

    const before = stats();
    assert.deepEqual(before.booksIndex['hc:950'].series, ['Хроники Акары']);
    assert.deepEqual(before.series.map((entry) => entry.name), ['Хроники Акары']);

    const saved = await jsonPost(base, '/series-override', {
      profile: PROFILE_KEY,
      workId: 'hc:950',
      series: [{ name: 'Акара (цикл)', position: 2 }],
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), {
      ok: true,
      workId: 'hc:950',
      series: [{ hcId: null, name: 'Акара (цикл)', position: 2 }],
    });

    const applied = stats();
    assert.deepEqual(applied.booksIndex['hc:950'].series, ['Акара (цикл)']);
    assert.deepEqual(applied.series.map((entry) => entry.name), ['Акара (цикл)']);

    const stored = JSON.parse(fs.readFileSync(seriesOverrides.SERIES_OVERRIDES_PATH, 'utf8'));
    assert.equal(stored.schemaVersion, 1);
    assert.deepEqual(stored.works['hc:950'].series, [
      { hcId: null, name: 'Акара (цикл)', position: 2 },
    ]);
    assert.equal(typeof stored.works['hc:950'].updatedAt, 'string');

    const cleared = await jsonPost(base, '/series-override', { profile: PROFILE_KEY, workId: 'hc:950' }, 'DELETE');
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { ok: true, workId: 'hc:950', cleared: true });

    const restored = stats();
    assert.deepEqual(restored.booksIndex['hc:950'].series, ['Хроники Акары']);
    const afterClear = JSON.parse(fs.readFileSync(seriesOverrides.SERIES_OVERRIDES_PATH, 'utf8'));
    assert.equal(afterClear.works['hc:950'], undefined);
  });

  test('POST /series-override: an empty list drops every series, bad input is a 400', async (t) => {
    await seed();
    const base = await startServer(t);

    const emptied = await jsonPost(base, '/series-override', {
      profile: PROFILE_KEY,
      workId: 'hc:950',
      series: [],
    });
    assert.equal(emptied.status, 200);
    assert.deepEqual(await emptied.json(), { ok: true, workId: 'hc:950', series: [] });
    assert.deepEqual(stats().booksIndex['hc:950'].series, []);
    await seriesOverrides.clearSeriesOverrides('hc:950');

    const noArray = await jsonPost(base, '/series-override', {
      profile: PROFILE_KEY,
      workId: 'hc:950',
      series: 'Хроники Акары',
    });
    assert.equal(noArray.status, 400);
    assert.equal((await noArray.json()).code, 'invalid_series');

    const duplicate = await jsonPost(base, '/series-override', {
      profile: PROFILE_KEY,
      workId: 'hc:950',
      series: [{ name: 'Дубль' }, { name: ' дубль ' }],
    });
    assert.equal(duplicate.status, 400);
    assert.equal((await duplicate.json()).code, 'invalid_series');

    const badPosition = await jsonPost(base, '/series-override', {
      profile: PROFILE_KEY,
      workId: 'hc:950',
      series: [{ name: 'Цикл', position: -1 }],
    });
    assert.equal(badPosition.status, 400);
    assert.equal((await badPosition.json()).code, 'invalid_series');

    const longWorkId = await jsonPost(base, '/series-override', {
      profile: PROFILE_KEY,
      workId: `hc:${'9'.repeat(130)}`,
      series: [],
    });
    assert.equal(longWorkId.status, 400);
    assert.equal((await longWorkId.json()).code, 'invalid_work_id');

    const noProfile = await jsonPost(base, '/series-override', { workId: 'hc:950', series: [] });
    assert.equal(noProfile.status, 400);
    assert.equal((await noProfile.json()).code, 'profile_required');
  });

  test('POST /link writes a manual link, DELETE clears it, unknown book is a 404', async (t) => {
    await seed();
    const base = await startServer(t);

    const created = await jsonPost(base, '/link', {
      profile: PROFILE_KEY,
      bookId: '501',
      workId: 'hc:950',
    });
    assert.equal(created.status, 200);
    assert.deepEqual(await created.json(), { ok: true, bookId: '501', workId: 'hc:950' });
    const manual = bookCache.getLink('501');
    assert.equal(manual.method, 'manual');
    assert.equal(manual.score, 1);
    assert.deepEqual(manual.evidence, { manual: true });
    assert.equal(manual.livelibBookId, '501');

    const unknown = await jsonPost(base, '/link', {
      profile: PROFILE_KEY,
      bookId: '7777',
      workId: 'hc:950',
    });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).code, 'unknown_book');

    const badWorkId = await jsonPost(base, '/link', {
      profile: PROFILE_KEY,
      bookId: '501',
      workId: 'не-work-id',
    });
    assert.equal(badWorkId.status, 400);
    assert.equal((await badWorkId.json()).code, 'invalid_work_id');

    const deleted = await jsonPost(base, '/link', { profile: PROFILE_KEY, bookId: '501' }, 'DELETE');
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { ok: true, bookId: '501', cleared: true });
    assert.equal(bookCache.getLink('501'), null);
  });

  test('a manual link survives a force resolve pass', async () => {
    await seed();
    await bookCache.saveLink('501', {
      schemaVersion: 2,
      livelibBookId: '501',
      workId: 'hc:900',
      method: 'manual',
      score: 1,
      evidence: { manual: true },
    });
    const lookup = async () => ({
      byIsbn: new Map([
        ['9785000000001', { details: { hcWorkId: 555, title: 'Чужое произведение' }, editionId: 5550 }],
      ]),
      works: new Map([[555, { hcWorkId: 555, title: 'Чужое произведение' }]]),
      queries: [],
      requests: 1,
    });
    const report = await resolve.resolveProfile(
      profileDoc([
        {
          id: 'll:501',
          sourceBookId: '501',
          title: 'Хроники Акары. Том 3',
          authors: ['Масаси Кисимото'],
          status: 'read',
          finishedAt: '2024-02-02',
          edition: { isbn13: '9785000000001', year: 2010 },
        },
      ]),
      {
        force: true,
        providers: [],
        lookupIsbns: lookup,
        fetchImpl: NO_NETWORK,
        sleep: async () => {},
        requestDelayMs: 0,
        wikidataProvider: { lookupTitles: async () => ({ byKey: new Map(), skipped: null }) },
      }
    );

    assert.equal(report.resolvedIsbn, 1);
    const kept = bookCache.getLink('501');
    assert.equal(kept.workId, 'hc:900');
    assert.equal(kept.method, 'manual');
    assert.deepEqual(kept.evidence, { manual: true });
  });

  test('GET /audit lists volume-mismatch, orphan and the details/isbn problems', async (t) => {
    await seed();
    const base = await startServer(t);

    const response = await fetch(`${base}/audit?profile=${PROFILE_KEY}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.profile, PROFILE_KEY);
    assert.equal(body.count, 4);
    assert.deepEqual(
      body.items.map((item) => [item.kind, item.bookId]),
      [
        ['isbn-mismatch', '502'],
        ['missing-details', '502'],
        ['orphan', '999'],
        ['volume-mismatch', '501'],
      ]
    );
    const volume = body.items.find((item) => item.kind === 'volume-mismatch');
    assert.equal(volume.workId, 'hc:950');
    assert.equal(volume.workTitle, 'Хроники Акары. Том 1');
    assert.equal(volume.title, 'Хроники Акары. Том 3');
    const orphan = body.items.find((item) => item.kind === 'orphan');
    assert.equal(orphan.workId, 'hc:999');

    const extra = await fetch(`${base}/audit?profile=${PROFILE_KEY}&limit=5`);
    assert.equal(extra.status, 400);
    assert.equal((await extra.json()).code, 'unexpected_parameter');

    const missing = await fetch(`${base}/audit`);
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).code, 'profile_required');
  });
});
