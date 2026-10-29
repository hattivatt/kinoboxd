'use strict';

/**
 * `livelib-file` is a first-class resolve input (§3.3.2).
 *
 * What this file pins:
 *   - a file row WITHOUT «Ссылка на книгу» (no `sourceBookId`) is still in the
 *     resolve pool and gets a stable `file:tk:<sha1>` link key — and the stats
 *     payload gives it its own work id instead of collapsing every such row
 *     into one `ll:` book;
 *   - the ISBN column of the export goes straight into ONE batched Hardcover
 *     lookup (no LiveLib-card round-trip needed just to learn an ISBN);
 *   - Cyrillic titles are matched by Литрес first, Latin ones are not sent to
 *     Литрес at all (budget politeness);
 *   - plan shelves (`reading`/`wish`) are skipped by the chain: they never
 *     reach stats, so they must not spend the budget;
 *   - the payload unions the chain's genres/series with the file columns and
 *     `metadataSources` keeps BOTH provenances;
 *   - `POST /api/books/import/livelib-file` starts the resolve job by default
 *     and honours the explicit `resolve=0` opt-out (body and query).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BOOK_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-book-llfile-resolve-'));
process.env.KINOBOXD_CACHE_BOOK_DIR = BOOK_CACHE_DIR;

const bookCache = require('../server/books/book-cache');
const livelibFile = require('../server/books/livelib-file');
const resolve = require('../server/books/resolve');
const importJobs = require('../server/books/import');
const { buildBooksStats } = require('../server/books/stats');

const FIXTURES = path.join(__dirname, 'fixtures');

/** `livelib-backup` JSON rows: no «Ссылка на книгу» column at all. */
function exportWithoutLinks(rows) {
  return Buffer.from(JSON.stringify(rows), 'utf8');
}

function fileProfile(rows, shelf = 'read', userKey = 'NoLinkProbe') {
  const parsed = livelibFile.parseExportFile(exportWithoutLinks(rows), {
    filename: `livelib-${userKey.toLowerCase()}-${shelf}.json`,
  });
  const { profile } = livelibFile.mergeFileIntoProfile(null, {
    userKey,
    books: parsed.books,
    shelf,
    format: 'json',
    filename: `livelib-${userKey.toLowerCase()}-${shelf}.json`,
  });
  return profile;
}

function hcEntry({ hcWorkId, isbn13, title, authors = [], genres = [], pages = null, year = null, publisher = null }) {
  return {
    details: {
      schemaVersion: 1,
      hcWorkId,
      title,
      authors: authors.map((name, index) => ({ hcId: index + 1, name })),
      genres,
      series: [],
      pages,
      publicationYear: year,
      publisher,
      isbn13,
      isbn10: null,
      coverUrl: null,
      ratingsCount: 100,
      partial: false,
    },
    editionId: hcWorkId * 10,
  };
}

/** Hardcover bulk stub that records what was asked and answers from `entries`. */
function lookupStub(entries) {
  const byIsbn = new Map();
  const works = new Map();
  for (const entry of entries) {
    byIsbn.set(resolve.normalizeIsbn(entry.details.isbn13), entry);
    works.set(entry.details.hcWorkId, entry.details);
  }
  const calls = [];
  const fn = async (isbns) => {
    calls.push([...isbns]);
    return { byIsbn, works, queries: [...isbns], requests: 1 };
  };
  fn.calls = calls;
  return fn;
}

const ANNIHILATION = {
  title: 'Аннигиляция',
  readDate: 'Сентябрь 2026 г.',
  rating: { overall: '7.4', user: '4.5' },
  authors: [{ name: 'Джефф Вандермеер' }],
  details: { isbn: '978-5-699-98967-6', year: '2018 г.', publishers: 'Эксмо' },
};

/**
 * Resolve caches are keyed by title+author hash, so every test must use its own
 * titles: sharing one would let a link written by an earlier test short-circuit
 * the pass under test (and the shared cache dir is the point of the file).
 *
 * Unique title per test is enough — the hash is sha1(title|surname).
 */
function book(title, author, extra = {}) {
  return { title, readDate: 'сентябрь 2026', authors: [{ name: author }], ...extra };
}

test('a file row without a link column is resolved by its file key, not dropped', async () => {
  const profile = fileProfile([
    ANNIHILATION,
    { title: 'Мартин Иден', readDate: 'март 2023', authors: [{ name: 'Джек Лондон' }] },
    { title: 'Пикник на обочине', readDate: '2021 г.', authors: [{ name: 'Аркадий Стругацкий' }] },
  ]);
  assert.deepEqual(profile.events.map((event) => event.sourceBookId), [null, null, null]);
  assert.ok(profile.events.every((event) => event.fileKey));

  const lookup = lookupStub([
    hcEntry({ hcWorkId: 501, isbn13: '9785699989676', title: 'Annihilation', authors: ['Jeff VanderMeer'], pages: 320, year: 2014 }),
  ]);
  const report = await resolve.resolveProfile(profile, { providers: [], lookupIsbns: lookup });

  assert.equal(report.total, 3);
  assert.equal(report.resolvedIsbn, 1);
  assert.equal(report.skippedPlanShelf, 0);
  // One ISBN batch, one query — the export's own column is the key.
  assert.equal(lookup.calls.length, 1);
  assert.deepEqual(lookup.calls[0], ['9785699989676']);

  const key = `file:${profile.events[0].fileKey}`;
  const link = bookCache.getLink(key);
  assert.ok(link, 'link is cached under the synthetic file key');
  assert.equal(link.workId, 'hc:501');
  assert.equal(link.method, 'isbn');
});

test('stats give every linkless file row its own work and grow the badge after resolve', async () => {
  const rows = [
    book('Дюна (проверка бейджа)', 'Фрэнк Герберт'),
    book('Солярис (проверка бейджа)', 'Станислав Лем'),
    book('Сталкер (проверка бейджа)', 'Аркадий Стругацкий'),
  ];
  const profile = fileProfile(rows, 'read', 'BadgeProbe');
  await bookCache.saveProfile('livelib', 'BadgeProbe', profile);

  const before = buildBooksStats({ profile: 'livelib-BadgeProbe' });
  // The export rows carry no genres/series/year: honestly unresolved …
  assert.equal(before.summary.bookCount, 3, 'rows must not collapse into one ll: work');
  const beforePercent = before.summary.metadata.percent;
  assert.ok(beforePercent < 100, `file-only profile is not 100% (got ${beforePercent})`);

  const lookup = lookupStub([
    hcEntry({ hcWorkId: 551, isbn13: '9785699000001', title: 'Dune', authors: ['Frank Herbert'], genres: ['Science Fiction'], pages: 704, year: 1965 }),
    hcEntry({ hcWorkId: 552, isbn13: '9785699000002', title: 'Solaris', authors: ['Stanislaw Lem'], genres: ['Science Fiction'], pages: 224, year: 1961 }),
  ]);
  // A later export adds the ISBN column to the same rows (same file keys).
  const stored = bookCache.getProfile('livelib', 'BadgeProbe');
  stored.events[0].edition = { ...(stored.events[0].edition || {}), isbn: '9785699000001' };
  stored.events[1].edition = { ...(stored.events[1].edition || {}), isbn: '9785699000002' };
  await bookCache.saveProfile('livelib', 'BadgeProbe', stored);

  const report = await resolve.resolveProfile(bookCache.getProfile('livelib', 'BadgeProbe'), {
    providers: [],
    lookupIsbns: lookup,
  });
  assert.equal(report.resolvedIsbn, 2);

  const after = buildBooksStats({ profile: 'livelib-BadgeProbe' });
  assert.ok(
    after.summary.metadata.percent > beforePercent,
    `percent grows (${beforePercent}% -> ${after.summary.metadata.percent}%)`
  );
  assert.equal(after.summary.metadata.resolved, 2);
  assert.equal(after.summary.metadata.total, 3);
  // Two events now point at canonical works; event count is unchanged.
  assert.equal(after.summary.bookCount, 3);
  assert.equal(after.summary.eventCount, 3);
  assert.ok(Object.keys(after.booksIndex).some((workId) => workId === 'hc:551'));
  assert.ok(Object.keys(after.booksIndex).some((workId) => workId.startsWith('ll:file:')));
});

test('Cyrillic titles go to Литрес first, Latin titles never do', async () => {
  const litresCalls = [];
  const gbCalls = [];
  const order = [];
  const fakeLitres = {
    NAME: 'litres',
    getWork: async (input) => {
      litresCalls.push(input.title);
      order.push(`litres:${input.title}`);
      return {
        source: 'litres',
        sourceId: '9001',
        workId: 'lr:9001',
        title: input.title,
        authors: input.authors,
        year: 2018,
        publisher: 'Эксмо',
        pages: 256,
        genres: ['Зарубежное фэнтези'],
        isbn13: '9785699989676',
        isbn10: null,
        cover: null,
        language: 'ru',
        series: { name: 'Южный предел', position: 1 },
        confidence: 0.9,
        match: { method: 'title', score: 0.9 },
        links: { pageUrl: 'https://www.litres.ru/book/9001' },
      };
    },
  };
  const fakeGoogle = {
    NAME: 'googlebooks',
    getWork: async (input) => {
      gbCalls.push(input.title);
      order.push(`googlebooks:${input.title}`);
      return null;
    },
  };
  const fakeOpenLibrary = { NAME: 'openlibrary', getWork: async () => null };
  const fakeCard = { NAME: 'livelib-card', getWork: async () => null };

  const profile = fileProfile(
    [
      book('Трудно быть богом', 'Аркадий Стругацкий'),
      book('The Lathe of Heaven', 'Ursula Le Guin'),
    ],
    'read',
    'RusFirstProbe'
  );

  const report = await resolve.resolveProfile(profile, {
    providers: [fakeLitres, fakeGoogle, fakeOpenLibrary, fakeCard],
    lookupIsbns: lookupStub([]),
    sleep: async () => {},
  });

  assert.deepEqual(litresCalls, ['Трудно быть богом'], 'only the Cyrillic title hits Литрес');
  assert.equal(report.resolvedLitres, 1);
  // Литрес is asked before any title fallback for the Cyrillic book.
  assert.equal(order[0], 'litres:Трудно быть богом');
  // …and the Latin one is never sent to Литрес, it falls through to GB/OL.
  assert.ok(gbCalls.includes('The Lathe of Heaven'));
  assert.ok(!litresCalls.includes('The Lathe of Heaven'));

  const ruEvent = profile.events.find((event) => event.title === 'Трудно быть богом');
  const link = bookCache.getLink(`file:${ruEvent.fileKey}`);
  assert.equal(link.workId, 'lr:9001');
  const details = bookCache.getWorkDetails('lr:9001');
  assert.equal(details.pages, 256);
  assert.deepEqual(details.series, [{ hcId: null, name: 'Южный предел', position: 1 }]);
  assert.deepEqual(details.metadataSources, ['litres']);
});

test('plan shelves (reading/wish) are skipped: they must not spend the budget', async () => {
  const calls = [];
  const fakeLitres = {
    NAME: 'litres',
    getWork: async (input) => {
      calls.push(input.title);
      return null;
    },
  };
  const profile = fileProfile(
    [
      book('Обитаемый остров (план)', 'Аркадий Стругацкий'),
      book('Понедельник начинается в субботу (план)', 'Аркадий Стругацкий'),
    ],
    'wish',
    'PlanProbe'
  );
  const report = await resolve.resolveProfile(profile, {
    providers: [fakeLitres],
    lookupIsbns: lookupStub([]),
    sleep: async () => {},
  });
  assert.equal(report.total, 0);
  assert.equal(report.skippedPlanShelf, 2);
  assert.deepEqual(calls, []);
});

test('payload unions chain genres/series with the file columns and keeps both sources', async () => {
  const profile = fileProfile(
    [
      {
        title: 'Аннигиляция (union)',
        readDate: 'Сентябрь 2026 г.',
        authors: [{ name: 'Джефф Вандермеер' }],
        genres: [{ name: 'фэнтези' }, { name: 'ужасы' }],
        details: { isbn: '978-5-699-98967-1', year: '2018 г.', publishers: 'Эксмо', series: 'Южный предел' },
      },
    ],
    'read',
    'UnionProbe'
  );
  await bookCache.saveProfile('livelib', 'UnionProbe', profile);
  const key = `file:${profile.events[0].fileKey}`;

  // The chain resolved the SAME work, but knows a different genre vocabulary
  // and lacks the file's year/publisher.
  await bookCache.saveDetails('501', {
    schemaVersion: 2,
    hcWorkId: 501,
    title: 'Annihilation',
    authors: [{ hcId: 1, name: 'Jeff VanderMeer' }],
    genres: ['Science Fiction', 'Фэнтези'],
    series: [{ hcId: 77, name: 'Southern Reach', position: 1 }],
    pages: 320,
    publicationYear: null,
    publisher: null,
    isbn13: '9785699989676',
    metadataSources: ['hardcover'],
    sources: [{ source: 'hardcover', sourceId: '501' }],
    partial: false,
  });
  await bookCache.saveLink(key, {
    schemaVersion: 2,
    livelibBookId: key,
    workId: 'hc:501',
    method: 'isbn',
    score: 1,
    evidence: { isbn: '9785699989676' },
    resolvedAt: '2026-10-28T00:00:00.000Z',
  });

  const stats = buildBooksStats({ profile: 'livelib-UnionProbe' });
  const work = Object.values(stats.booksIndex)[0];
  assert.equal(work.workId, 'hc:501');
  // Union, deduped by normalized name: «Фэнтези» from HC and «фэнтези» from the
  // file are the same concept; the RU file labels survive the resolve.
  assert.deepEqual(work.genres, ['Science Fiction', 'Фэнтези', 'ужасы']);
  assert.deepEqual(work.series.slice().sort(), ['Southern Reach', 'Южный предел']);
  // File-only fields are not wiped by a details doc that does not know them.
  // The chart prefers a first publication, but no provider claims one here
  // (HC publicationYear is null); the file's print-run year is the honest
  // fallback and is marked as an edition year, not a first edition.
  assert.equal(work.year, 2018);
  assert.equal(work.yearSource, 'edition');
  assert.equal(work.firstPublishedYear, null);
  assert.equal(work.editionYear, 2018);
  assert.equal(work.publisher, 'Эксмо');
  assert.equal(work.pages, 320);
  assert.deepEqual(work.metadataSources, ['hardcover', 'livelib-file']);
  assert.equal(stats.summary.metadata.percent, 100);
});

test('Литрес genres drive the manga filter for a file profile', async () => {
  const profile = fileProfile(
    [{ title: 'Берсерк', readDate: 'сентябрь 2026', authors: [{ name: 'Кэнтаро Миура' }] }],
    'read',
    'MangaProbe'
  );
  await bookCache.saveProfile('livelib', 'MangaProbe', profile);
  const key = `file:${profile.events[0].fileKey}`;
  await bookCache.saveDetails('lr-4242', {
    schemaVersion: 2,
    workId: 'lr:4242',
    title: 'Берсерк',
    authors: [{ name: 'Кэнтаро Миура' }],
    genres: ['Манга', 'Тёмное фэнтези'],
    series: [{ hcId: null, name: 'Берсерк', position: 1 }],
    pages: null,
    metadataSources: ['litres'],
    sources: [{ source: 'litres', sourceId: '4242' }],
    partial: false,
  });
  await bookCache.saveLink(key, {
    schemaVersion: 2,
    livelibBookId: key,
    workId: 'lr:4242',
    method: 'litres-title',
    score: 0.9,
    evidence: {},
    resolvedAt: '2026-10-28T00:00:00.000Z',
  });

  const hidden = buildBooksStats({ profile: 'livelib-MangaProbe', includeMangaComics: false });
  assert.equal(hidden.summary.mangaExcluded, 1);
  assert.equal(hidden.summary.bookCount, 0);
  const shown = buildBooksStats({ profile: 'livelib-MangaProbe', includeMangaComics: true });
  assert.equal(shown.summary.bookCount, 1);
  const work = Object.values(shown.booksIndex)[0];
  assert.match(work.metadataSources.join(','), /livelib-file|litres/);
});

/* ------------------------------------------------------------------ */
/* Route: auto-resolve is the default, `resolve=0` is the opt-out      */
/* ------------------------------------------------------------------ */

test('POST /api/books/import/livelib-file starts the resolve job unless opted out', async (t) => {
  const express = require('express');
  const routes = require('../server/books/routes');
  const app = express();
  app.use(express.json());
  app.use('/api/books', routes);
  app.use((err, req, res, next) => {
    res.status(err.status || err.statusCode || 500).json({ code: err.code, error: err.message });
  });
  const server = app.listen(6933);
  await new Promise((done) => server.once('listening', done));
  const base = 'http://127.0.0.1:6933/api/books';
  t.after(() => new Promise((done) => server.close(done)));

  const fixture = fs.readFileSync(path.join(FIXTURES, 'livelib-file-export.json'));
  const upload = async (fields = {}, query = '') => {
    const body = new FormData();
    body.append('username', 'AutoResolveProbe');
    for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
    body.append('file', new Blob([fixture], { type: 'application/json' }), 'livelib-autoresolveprobe-read-28.10.2026.json');
    const response = await fetch(`${base}/import/livelib-file${query}`, { method: 'POST', body });
    return { status: response.status, body: await response.json() };
  };

  const realStart = importJobs.startResolveJob;
  const started = [];
  importJobs.startResolveJob = (options = {}) => {
    started.push(options);
    return { id: 'resolve-stub', stage: 'queued' };
  };
  t.after(() => {
    importJobs.startResolveJob = realStart;
  });

  const dflt = await upload();
  assert.equal(dflt.status, 201);
  assert.deepEqual(dflt.body.resolve, { jobId: 'resolve-stub', stage: 'queued' });
  assert.equal(started.length, 1);
  assert.equal(started[0].coalesce, false, 'a file merge needs a later pass, not the running one');
  assert.equal(started[0].allowLivelibCard, false, 'the safe path must never scrape livelib.ru');

  const optedOut = await upload({ resolve: '0' });
  assert.equal(optedOut.status, 201);
  assert.equal(optedOut.body.resolve, null);
  assert.equal(started.length, 1);

  const optedOutQuery = await upload({}, '?resolve=0');
  assert.equal(optedOutQuery.status, 201);
  assert.equal(optedOutQuery.body.resolve, null);
  assert.equal(started.length, 1);

  const explicitOn = await upload({ resolve: '1' });
  assert.equal(explicitOn.status, 201);
  assert.equal(started.length, 2);
});

test('allowLivelibCard: false keeps the card provider out of a file-import pass', async () => {
  const cardCalls = [];
  const fakeCard = {
    NAME: 'livelib-card',
    getWork: async (input) => {
      cardCalls.push(input.title);
      return null;
    },
  };
  const profile = fileProfile(
    [book('Карточка не нужна', 'Тестовый Автор', { bookHref: 'https://www.livelib.ru/book/1234567' })],
    'read',
    'NoCardProbe'
  );
  // The row knows its LiveLib page, so only the card provider could use it.
  assert.equal(profile.events[0].sourceBookId, '1234567');
  const report = await resolve.resolveProfile(profile, {
    providers: [fakeCard],
    lookupIsbns: lookupStub([]),
    allowLivelibCard: false,
    sleep: async () => {},
  });
  assert.deepEqual(cardCalls, [], 'no request to livelib.ru from the safe path');
  assert.equal(report.providerChain['livelib-card'], undefined);
});

test('a Hardcover ISBN-lookup failure degrades to a warning, not a dead pass', async () => {
  const calls = [];
  const fakeLitres = {
    NAME: 'litres',
    getWork: async (input) => {
      calls.push(input.title);
      return {
        source: 'litres',
        sourceId: '9100',
        workId: 'lr:9100',
        title: input.title,
        authors: input.authors,
        year: 2018,
        publisher: 'Эксмо',
        pages: 256,
        genres: ['Зарубежное фэнтези'],
        isbn13: '9785699000011',
        series: null,
        confidence: 0.9,
        match: { method: 'title', score: 0.9 },
        links: { pageUrl: 'https://www.litres.ru/book/9100' },
      };
    },
  };
  const profile = fileProfile(
    [
      book('Токен не настроен (тест)', 'Тестовый Автор', {
        details: { isbn: '9785699000011' },
      }),
    ],
    'read',
    'NoTokenProbe'
  );
  const failingLookup = async () => {
    const error = new Error('Hardcover-токен не настроен');
    error.code = 'hardcover_token_missing';
    throw error;
  };
  const report = await resolve.resolveProfile(profile, {
    providers: [fakeLitres],
    lookupIsbns: failingLookup,
    sleep: async () => {},
  });
  assert.deepEqual(report.lookupErrors, ['hardcover_token_missing']);
  assert.deepEqual(calls, ['Токен не настроен (тест)'], 'Литрес still runs');
  assert.equal(report.resolvedLitres, 1);
  assert.equal(report.withMetadata, 1);
});

test('a queued resolve-only job already reports the badge as running', () => {
  const queued = { id: 'resolve-livelib-x', source: 'livelib', done: false, stage: 'queued', startedAt: 1 };
  const scrapeQueued = { id: 'livelib-x-1', source: 'livelib', done: false, stage: 'queued', startedAt: 1 };
  assert.equal(importJobs.resolveStateFromJobs([queued], 'livelib').running, true);
  assert.equal(importJobs.resolveStateFromJobs([scrapeQueued], 'livelib').running, false);
  assert.equal(importJobs.resolveStateFromJobs([queued], 'hardcover').running, false);
});
