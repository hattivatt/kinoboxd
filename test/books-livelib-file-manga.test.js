'use strict';

/**
 * Manga/comics detection for `livelib-backup` **file** profiles.
 *
 * A file-imported profile has no details document until the resolve chain runs
 * (and on the safe path it never runs at all). The bibliographic columns of the
 * export — «Жанры», «Серия», «Издатель» — are the only classification signal
 * there, so the detector must read them. Pinned here:
 *
 *   - a file row with RU manga/comics genres (`манга`, `Комиксы и манга`,
 *     `сёнэн`) is excluded at the default `includeMangaComics=0` and visible at
 *     `=1`;
 *   - a file row with **no** genres and no comics publisher keeps the tri-state
 *     `null` and therefore survives the filter (a missing signal never hides a
 *     regular book);
 *   - a clean genre list gives an honest `false`;
 *   - series propagation works over a *file* series: one manga volume hides the
 *     whole series, even when the sibling volume's own genres are clean;
 *   - the provider flag is never overridden: `true` from either corpus wins,
 *     and a stored `details.mangaComics:true` survives a clean re-detection;
 *   - `summary.metadata` counts genres/series/year (not "the file was parsed"),
 *     so a minimal export is honestly below 100% and the «Метадата: N%» badge
 *     becomes visible; a fully covered file profile stays at 100% (badge
 *     hidden by design).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-file-manga-'));
process.env.KINOBOXD_CACHE_DIR = process.env.KINOBOXD_CACHE_BOOK_DIR;
process.env.KINOBOXD_STATE_DIR = process.env.KINOBOXD_CACHE_BOOK_DIR;

const bookCache = require('../server/books/book-cache');
const { buildBooksStats, workMetadata } = require('../server/books/stats');

/** The badge view model is a browser ESM module; load it per test. */
async function badgeOf(meta) {
  const { metadataBadge } = await import('../public/js/books-refresh.js');
  return metadataBadge(meta);
}

const PORT = 6811;
const FIXTURES = path.join(__dirname, 'fixtures');
const mangaFixture = fs.readFileSync(path.join(FIXTURES, 'livelib-file-export-manga.json'));

let server = null;
let base = '';

function form({ file = mangaFixture, filename = 'livelib-file-manga-read-28.10.2026.json', ...fields } = {}) {
  const body = new FormData();
  // Opt out of the (now default) metadata chain: this file pins the parse +
  // filter contract and must not touch the network.
  if (fields.resolve === undefined) fields.resolve = '0';
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) body.append(key, String(value));
  }
  if (file) body.append('file', new Blob([file], { type: 'application/json' }), filename);
  return body;
}

async function upload(username, options = {}) {
  const response = await fetch(`${base}/import/livelib-file`, {
    method: 'POST',
    body: form({ username, ...options }),
  });
  return { status: response.status, body: await response.json() };
}

function statsFor(profile, includeMangaComics) {
  return buildBooksStats({ profile, includeMangaComics, profilesOnDisk: bookCache.listProfiles() });
}

function workByTitle(stats, title) {
  return Object.values(stats.booksIndex).find((work) => work.title === title) || null;
}

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

test('file import: RU manga/comics genres are filtered by default', async () => {
  const { status, body } = await upload('MangaFile');
  assert.equal(status, 201);
  assert.equal(body.imported, 6);
  assert.equal(body.shelves.read, 6);

  /* ---------------- default: includeMangaComics=0 ---------------- */
  const off = statsFor('livelib-MangaFile', false);
  assert.equal(off.summary.bookCount, 3);
  assert.equal(off.summary.eventCount, 3);
  assert.equal(off.summary.mangaExcluded, 3);
  // Exactly one work was hidden only through its sibling volume of the series.
  assert.equal(off.summary.mangaSeriesPropagated, 1);
  assert.equal(off.summary.mangaSeriesExcluded, 1);
  assert.equal(workByTitle(off, 'Desert Punk. Том 1'), null);
  assert.equal(workByTitle(off, 'Триган'), null);

  // A row without any genre/publisher signal is `null`, not `false` and not
  // `true`: it survives the filter (missing signal never hides a book).
  const plain = workByTitle(off, 'Без жанров и издателя');
  assert.ok(plain);
  assert.equal(plain.mangaComics, null);
  assert.equal(plain.unresolved, true);

  // A clean RU genre list is an honest `false` (known and not comics).
  const clean = workByTitle(off, 'Пикник на обочине');
  assert.ok(clean);
  assert.equal(clean.mangaComics, false);

  /* ---------------- opt-in: includeMangaComics=1 ---------------- */
  const on = statsFor('livelib-MangaFile', true);
  assert.equal(on.summary.bookCount, 6);
  assert.equal(on.summary.mangaExcluded, 0);
  const desert = workByTitle(on, 'Desert Punk. Том 1');
  assert.ok(desert);
  assert.equal(desert.mangaComics, true);
  // Genre «манга» wins even though the publisher is only displayed, not
  // re-detected: the signal came from the event's own genre column.
  assert.deepEqual(desert.genres, ['манга', 'приключения']);
  assert.deepEqual(desert.series, ['Desert Punk']);

  const trigan = workByTitle(on, 'Триган');
  assert.ok(trigan);
  assert.equal(trigan.mangaComics, true);
  assert.deepEqual(trigan.metadataSources, ['livelib-file']);
});

test('file import: series propagation hides every volume of a file series', async () => {
  const on = statsFor('livelib-MangaFile', true);
  const first = workByTitle(on, 'Desert Punk. Том 1');
  const second = workByTitle(on, 'Desert Punk. Том 2');
  assert.ok(first && second);
  // The sibling volume has a clean genre («фантастика») on its own...
  assert.deepEqual(second.genres, ['фантастика']);
  // ...but belongs to a series with a manga volume, so it is comics too.
  assert.equal(second.mangaComics, true);
  assert.equal(second.mangaComicsSource, 'series');
  // The first volume was detected on its own, not through the series.
  assert.notEqual(first.mangaComicsSource, 'series');

  const off = statsFor('livelib-MangaFile', false);
  assert.equal(workByTitle(off, 'Desert Punk. Том 2'), null);
});

test('file import: metadata coverage counts real columns, not "the file was parsed"', async () => {
  // 6 rows: 4 with genres and/or a series, 1 with a publisher only, 1 with
  // nothing but title/author/date.
  const on = statsFor('livelib-MangaFile', true);
  assert.deepEqual(on.summary.metadata, {
    resolved: 4,
    total: 6,
    resolvable: 6,
    hopeless: 0,
    percent: 67,
    done: false,
    running: false,
    budgetRemaining: null,
  });
  // Publisher alone is not "жанры/серии/год" — the badge hint must not lie.
  const bare = workByTitle(on, 'Тёмная башня. Стрелок');
  assert.equal(bare.publisher, 'АСТ');
  assert.equal(bare.unresolved, true);
  // ...but the file still explains where the publisher came from.
  assert.deepEqual(bare.metadataSources, ['livelib-file']);

  // The default view hides the manga works, so the share is computed over the
  // works that actually reach the dashboard (same rule as before this round).
  const off = statsFor('livelib-MangaFile', false);
  assert.deepEqual(off.summary.metadata, {
    resolved: 1,
    total: 3,
    resolvable: 3,
    hopeless: 0,
    percent: 33,
    done: false,
    running: false,
    budgetRemaining: null,
  });

  /* ---------------- badge behaviour ---------------- */
  const partial = await badgeOf(on.summary.metadata);
  assert.ok(partial, 'a 67% file profile must show the pill');
  assert.equal(partial.percent, 67);
  assert.equal(partial.pending, 2);
  assert.equal(partial.text, 'Метадата: 67%');
  assert.match(partial.hint, /2 книги ждут метадату/);

  // A file profile whose export carried every column stays at 100 % and the
  // pill is hidden by design (nothing to apologise for).
  const complete = await badgeOf({ resolved: 6, total: 6, percent: 100, running: false });
  assert.equal(complete, null);
});

test('file import: a minimal export keeps the filter open and the badge honest', async () => {
  const minimal = JSON.stringify([
    {
      title: 'Просто книга',
      bookHref: 'https://www.livelib.ru/book/9000201-prosto-kniga',
      readDate: 'Май 2023 г.',
      authors: [{ name: 'Простой Автор' }],
    },
    {
      title: 'Ещё одна книга',
      bookHref: 'https://www.livelib.ru/book/9000202-eshche-odna',
      readDate: 'Июнь 2023 г.',
      authors: [{ name: 'Простой Автор' }],
    },
  ]);
  const { status } = await upload('MinimalFile', {
    file: Buffer.from(minimal),
    filename: 'livelib-minimal-read-28.10.2026.json',
  });
  assert.equal(status, 201);

  const stats = statsFor('livelib-MinimalFile', false);
  // No genres column → no classification signal → nothing is hidden.
  assert.equal(stats.summary.bookCount, 2);
  assert.equal(stats.summary.mangaExcluded, 0);
  for (const work of Object.values(stats.booksIndex)) assert.equal(work.mangaComics, null);

  // And the profile is NOT reported as fully enriched.
  assert.deepEqual(stats.summary.metadata, {
    resolved: 0,
    total: 2,
    resolvable: 2,
    hopeless: 0,
    percent: 0,
    done: false,
    running: false,
    budgetRemaining: null,
  });
  const badge = await badgeOf(stats.summary.metadata);
  assert.ok(badge, '0% file profile must show the pill');
  assert.equal(badge.text, 'Метадата: 0%');
  assert.match(badge.hint, /2 книги ждут метадату/);
});

test('detector: file signals never override a provider verdict', async () => {
  // Unit level: details (provider) + file (columns) are unioned, `true` wins.
  const workId = 'll:9900001';
  const baseEvent = {
    id: 'llfile:id:9900001:read',
    source: 'livelib-file',
    origin: 'livelib-file',
    sourceBookId: '9900001',
    title: 'Спорный том',
    authors: ['Автор'],
    status: 'read',
    shelf: 'read',
    finishedAt: '2024-02-03',
    edition: {},
  };

  await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), {
    schemaVersion: 2,
    workId,
    title: 'Спорный том',
    genres: ['Science Fiction'],
    mangaComics: false,
  });

  // Provider says clean, the file genre says «манга» → comics.
  const fromFile = workMetadata(workId, [
    { ...baseEvent, genres: ['манга'], edition: { series: 'Спорный том' } },
  ]);
  assert.equal(fromFile.mangaComics, true);

  // Provider says true (stored), the file genre list is clean → still comics.
  await bookCache.saveDetails(bookCache.detailsKeyForWork('ll:9900002'), {
    schemaVersion: 2,
    workId: 'll:9900002',
    title: 'Том с тегом',
    genres: ['Fantasy'],
    mangaComics: true,
  });
  const fromProvider = workMetadata('ll:9900002', [
    {
      ...baseEvent,
      id: 'llfile:id:9900002:read',
      sourceBookId: '9900002',
      title: 'Том с тегом',
      genres: ['фэнтези'],
    },
  ]);
  assert.equal(fromProvider.mangaComics, true);

  // No details, no file columns at all → null (never filtered).
  const unknown = workMetadata('ll:9900003', [
    { ...baseEvent, id: 'llfile:id:9900003:read', sourceBookId: '9900003', genres: [] },
  ]);
  assert.equal(unknown.mangaComics, null);
});

test('detector: RU genre/publisher vocabulary of a file export', async () => {
  const { detectManga } = require('../server/books/providers/manga');
  const cases = [
    [{ genres: ['манга'] }, true],
    [{ genres: ['Манга', 'приключения'] }, true],
    [{ genres: ['Комиксы'] }, true],
    [{ genres: ['Комиксы и манга'] }, true],
    [{ genres: ['манхва'] }, true],
    [{ genres: ['манхуа'] }, true],
    [{ genres: ['вебтун'] }, true],
    [{ genres: ['сёнэн'] }, true],
    [{ genres: ['сёдзё'] }, true],
    [{ genres: ['сэйнэн'] }, true],
    [{ genres: ['графический роман'] }, true],
    [{ publisher: 'Истари Комикс' }, true],
    [{ publisher: 'Комильфо' }, true],
    [{ publisher: 'Komilfo' }, true],
    // Mixed prose houses stay neutral: they print novels too.
    [{ publisher: 'Эксмо' }, null],
    [{ publisher: 'АСТ' }, null],
    [{ publisher: 'Азбука' }, null],
    [{ genres: ['Фантастика'] }, false],
    [{ genres: ['Современная русская проза'] }, false],
    [{ genres: ['Детективы'], publisher: 'Азбука' }, false],
    [{ genres: [] }, null],
    [{}, null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(detectManga(input), expected, JSON.stringify(input));
  }
});
