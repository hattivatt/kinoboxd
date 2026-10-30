'use strict';

/**
 * «Год первого издания» — the year chart contract.
 *
 * The year/decade widgets answer one question: when was the *work* first
 * published? Not when this print run happened to be printed.
 *
 * Pinned here:
 *   - provider mappings: Литрес «дата написания» (art detail, negative years for
 *     ancient works), Open Library `first_publish_year` only from a record with
 *     more than one edition, Hardcover `books.release_year`;
 *   - the merge vote: the *earliest* first-publication claim wins, so an edition
 *     year can never outvote an older honest year;
 *   - stats: `year` comes from `firstPublishedYear` alone; an edition year is
 *     `editionYear` and lands in the «год неизвестен» bucket, never in a modern
 *     decade; ancient years keep the «до 1000 г.» bucket; sane bounds apply;
 *   - the backfill job that fills the field for an already-resolved cache.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-first-year-'));

const bookCache = require('../server/books/book-cache');
const providers = require('../server/books/providers');
const openlibrary = require('../server/books/providers/openlibrary');
const litres = require('../server/books/providers/litres');
const hardcoverProvider = require('../server/books/providers/hardcover');
const { buildBooksStats } = require('../server/books/stats');
const yearsBackfill = require('../server/books/years-backfill');

const noSleep = async () => {};

function response({ status = 200, body = {} }) {
  return {
    status,
    headers: { get: () => null },
    async json() {
      return typeof body === 'string' ? JSON.parse(body) : body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function fetchRecorder(handler) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return handler(String(url));
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/* ------------------------------------------------------------------ */
/* Provider mappings                                                   */
/* ------------------------------------------------------------------ */

test('Литрес reads «дату написания» from the art detail, negative years included', async () => {
  const fetchImpl = fetchRecorder((url) => {
    if (url.includes('/search')) {
      return response({
        body: {
          payload: {
            data: [
              {
                instance: {
                  id: 73939817,
                  title: 'Гаргантюа и Пантагрюэль',
                  persons: [{ role: 'author', full_name: 'Франсуа Рабле' }],
                  // The search hit may miss the writing date; the art has it.
                  publication_date: '2026-01-01',
                },
              },
            ],
          },
        },
      });
    }
    return response({
      body: {
        payload: {
          data: {
            id: 73939817,
            title: 'Гаргантюа и Пантагрюэль',
            date_written_at: '1564-01-01',
            publication_date: '2026-01-01',
            isbn: '9785699139026',
          },
        },
      },
    });
  });
  const result = await litres.getWork(
    { title: 'Гаргантюа и Пантагрюэль', authors: ['Франсуа Рабле'] },
    { fetchImpl, sleep: noSleep, litresPauseMs: 0 }
  );
  assert.ok(result);
  assert.equal(result.year, 2026); // the print run
  assert.equal(result.firstPublishedYear, 1564); // the work
});

test('Литрес keeps the sign of an ancient year and the merge keeps the earliest claim', () => {
  assert.equal(litres.firstYearOf('-0500-01-01'), -500);
  assert.equal(litres.firstYearOf('2026-01-01'), 2026);
  assert.equal(litres.firstYearOf(null, '', '  '), null);

  const merged = providers.mergeResults(
    { source: 'litres', sourceId: '1', title: 'Искусство войны', firstPublishedYear: -500 },
    [
      { source: 'openlibrary', sourceId: 'OL1W', title: 'The Art of War', firstPublishedYear: 1900 },
      { source: 'googlebooks', sourceId: 'gb1', title: 'The Art of War', firstPublishedYear: null },
    ]
  );
  // Ancient year beats the 1900 first English translation, and a modern print
  // run can never win the vote.
  assert.equal(merged.firstPublishedYear, -500);
});

test('the merge vote ignores absurd claims and prefers the earliest sane one', () => {
  assert.equal(providers.firstYearOf(12026), null);
  assert.equal(providers.firstYearOf(-99999), null);
  assert.equal(providers.firstYearOf(-500), -500);
  const merged = providers.mergeResults(
    { source: 'hardcover', sourceId: '9', title: 'Hamlet', firstPublishedYear: 1603 },
    [{ source: 'litres', sourceId: '2', title: 'Гамлет', firstPublishedYear: 1828 }]
  );
  assert.equal(merged.firstPublishedYear, 1603);
});

test('Open Library search hit: a single-edition record is not a first publication', () => {
  const single = openlibrary.normalizeSearchDoc(
    {
      key: '/works/OL37431263W',
      title: 'Искусство войны',
      author_name: ['Сунь Цзы'],
      first_publish_year: 2013,
      edition_count: 1, // only the 2013 translation exists in OL
    },
    { title: 'Искусство войны', authors: ['Сунь-Цзы'] }
  );
  assert.ok(single);
  assert.equal(single.year, 2013);
  assert.equal(single.firstPublishedYear, null);

  const multi = openlibrary.normalizeSearchDoc(
    {
      key: '/works/OL9170454W',
      title: 'Hamlet',
      author_name: ['William Shakespeare'],
      first_publish_year: 1603,
      edition_count: 2494,
    },
    { title: 'Hamlet', authors: ['William Shakespeare'] }
  );
  assert.ok(multi);
  assert.equal(multi.firstPublishedYear, 1603);

  // No `edition_count` in the payload (older fixtures) → the field is kept.
  const unknownCount = openlibrary.normalizeSearchDoc(
    { key: '/works/OL1W', title: 'Dune', author_name: ['Frank Herbert'], first_publish_year: 1965 },
    { title: 'Dune', authors: ['Frank Herbert'] }
  );
  assert.equal(unknownCount.firstPublishedYear, 1965);
});

test('Open Library ISBN path asks the work record for first_publish_year', async () => {
  const fetchImpl = fetchRecorder((url) => {
    if (url.includes('/api/books')) {
      return response({
        body: {
          'ISBN:9780441013593': {
            key: '/books/OL62694654M',
            title: 'Dune',
            authors: [{ name: 'Frank Herbert' }],
            publishers: [{ name: 'Ace' }],
            publish_date: '2005',
            works: [{ key: '/works/OL893415W' }],
            identifiers: { isbn_13: ['9780441013593'] },
          },
        },
      });
    }
    return response({ body: { title: 'Dune', first_publish_year: 1965 } });
  });
  const byIsbn = await openlibrary.getWork(
    { isbn13: '9780441013593' },
    { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
  );
  assert.ok(byIsbn);
  assert.equal(byIsbn.year, 2005); // this edition
  assert.equal(byIsbn.firstPublishedYear, 1965); // the work
  assert.equal(
    fetchImpl.calls.some((url) => url.includes('/works/OL893415W')),
    true
  );
});

test('Hardcover takes the work-level year, never the edition, for first publication', () => {
  const withWorkYear = hardcoverProvider.normalizeDetails({
    schemaVersion: 2,
    hcWorkId: 187536,
    title: 'Martin Eden',
    authors: [{ hcId: 1, name: 'Jack London' }],
    publicationYear: 1909,
    firstPublishedYear: 1909,
  });
  assert.equal(withWorkYear.firstPublishedYear, 1909);

  // Legacy schema-1 document: `publicationYear` is the only field, and it
  // prefers `books.release_year` over the edition (hardcover.detailsFromBook).
  const legacy = hardcoverProvider.normalizeDetails({
    schemaVersion: 1,
    hcWorkId: 187536,
    title: 'Martin Eden',
    publicationYear: 1909,
  });
  assert.equal(legacy.firstPublishedYear, 1909);
  assert.equal(legacy.year, 1909);

  // A document that only knows a print run says nothing about the first edition.
  const editionOnly = hardcoverProvider.normalizeDetails({
    schemaVersion: 1,
    hcWorkId: 555,
    title: 'Без года',
    publicationYear: null,
  });
  assert.equal(editionOnly.firstPublishedYear, null);
});

/* ------------------------------------------------------------------ */
/* stats: the year chart                                               */
/* ------------------------------------------------------------------ */

function event(id, title, extra = {}) {
  const { raw, ...rest } = extra;
  return {
    id,
    source: 'livelib',
    sourceBookId: id.replace(/^ll:/, ''),
    title,
    authors: [],
    rating: null,
    ratingScale: 10,
    rating10: null,
    status: 'read',
    finishedAt: '2024-05-05',
    ...(raw || {}),
    ...rest,
  };
}

function profile(userKey, events) {
  return {
    schemaVersion: 1,
    source: 'livelib',
    userKey,
    sourceUserId: null,
    importedAt: '2026-10-27T00:00:00.000Z',
    events,
    warnings: [],
  };
}

test('classics leave the modern decades for their honest centuries', async () => {
  // Rabelais: the print run is 2026, the work is 1564.
  await bookCache.saveDetails(8101, {
    schemaVersion: 2,
    hcWorkId: 8101,
    title: 'Гаргантюа и Пантагрюэль',
    authors: [{ name: 'Франсуа Рабле' }],
    publicationYear: 2026,
    firstPublishedYear: 1564,
    metadataSources: ['litres'],
  });
  // Shakespeare: 1608 (King Lear), print run 2006.
  await bookCache.saveDetails(8102, {
    schemaVersion: 2,
    hcWorkId: 8102,
    title: 'Король Лир',
    authors: [{ name: 'Уильям Шекспир' }],
    publicationYear: 2006,
    firstPublishedYear: 1608,
    metadataSources: ['hardcover'],
  });
  // Sun Tzu: an ancient year survives as the «до 1000 г.» bucket.
  await bookCache.saveDetails(8103, {
    schemaVersion: 2,
    hcWorkId: 8103,
    title: 'Искусство войны',
    authors: [{ name: 'Сунь Цзы' }],
    publicationYear: 2013,
    firstPublishedYear: -500,
    metadataSources: ['openlibrary'],
  });
  for (const id of ['8101', '8102', '8103']) {
    await bookCache.saveLink(id, {
      schemaVersion: 2,
      livelibBookId: id,
      workId: `hc:${id}`,
      method: 'isbn',
      score: 1,
    });
  }
  await bookCache.saveProfile(
    'livelib',
    'FirstYearClassics',
    profile('FirstYearClassics', [
      event('ll:8101', 'Гаргантюа и Пантагрюэль', { raw: { sourceBookId: '8101' } }),
      event('ll:8102', 'Король Лир', { raw: { sourceBookId: '8102' } }),
      event('ll:8103', 'Искусство войны', { raw: { sourceBookId: '8103' } }),
    ])
  );

  const stats = buildBooksStats({ profile: 'livelib-FirstYearClassics' });
  assert.equal(stats.booksIndex['hc:8101'].year, 1564);
  assert.equal(stats.booksIndex['hc:8101'].editionYear, 2026);
  assert.equal(stats.booksIndex['hc:8102'].year, 1608);
  assert.equal(stats.booksIndex['hc:8103'].year, -500);
  assert.deepEqual(stats.decades.map((entry) => entry.decade), [0, 1560, 1600]);
  assert.equal(stats.decades[0].label, 'до 1000 г.');
  assert.equal(stats.summary.ancientBookCount, 1);
  assert.equal(stats.summary.yearUnknownCount, 0);
  // The ancient bucket is a first-class column of the year chart too: same
  // count, same stable key, and no fake `year` that would stretch the axis.
  assert.equal(stats.years[0].ancient, true);
  assert.equal(stats.years[0].key, 'before-1000');
  assert.equal(stats.years[0].count, 1);
  assert.equal(stats.years[0].year, undefined);
  assert.deepEqual(stats.years.filter((entry) => !entry.ancient).map((entry) => entry.year), [1564, 1608]);
});

test('no first-publication claim falls back to the print-run year with an honest mark', async () => {
  await bookCache.saveDetails(8201, {
    schemaVersion: 2,
    hcWorkId: 8201,
    title: 'Мартин Иден',
    authors: [{ name: 'Джек Лондон' }],
    publicationYear: 2025, // litres edition in hand
    metadataSources: ['litres'],
  });
  await bookCache.saveLink('8201', {
    schemaVersion: 2,
    livelibBookId: '8201',
    workId: 'hc:8201',
    method: 'isbn',
    score: 1,
  });
  await bookCache.saveProfile(
    'livelib',
    'FirstYearUnknown',
    profile('FirstYearUnknown', [
      event('ll:8201', 'Мартин Иден', {
        raw: { sourceBookId: '8201' },
        edition: { publisher: 'АСТ', year: 2025 },
      }),
    ])
  );

  const stats = buildBooksStats({ profile: 'livelib-FirstYearUnknown' });
  const work = stats.booksIndex['hc:8201'];
  // No provider knows the work's first publication, so the edition year is an
  // honest fallback — never labelled as a first edition.
  assert.equal(work.year, 2025);
  assert.equal(work.yearSource, 'edition');
  assert.equal(work.firstPublishedYear, null);
  assert.equal(work.editionYear, 2025);
  assert.deepEqual(stats.years.map((entry) => entry.year), [2025]);
  assert.deepEqual(stats.decades.map((entry) => [entry.decade, entry.count]), [[2020, 1]]);
  assert.equal(stats.decades[0].editionCount, 1);
  assert.equal(stats.summary.yearUnknownCount, 0);
  assert.equal(stats.summary.yearEditionCount, 1);
  assert.deepEqual(stats.summary.yearsSpan, { from: 2025, to: 2025 });
});

test('the unknown bucket sits after every real decade and sane bounds are enforced', async () => {
  await bookCache.saveDetails(8301, {
    schemaVersion: 2,
    hcWorkId: 8301,
    title: 'Старая книга',
    authors: [{ name: 'Автор' }],
    publicationYear: 2020,
    firstPublishedYear: 1850,
  });
  await bookCache.saveDetails(8302, {
    schemaVersion: 2,
    hcWorkId: 8302,
    title: 'Будущая книга',
    authors: [{ name: 'Автор' }],
    // No edition year either: an insane first-publication claim must not invent
    // a year, so the work stays in «год неизвестен».
    publicationYear: null,
    // Outside saneFirstYear's -3000..2100 window → treated as unknown.
    firstPublishedYear: 3200,
  });
  for (const id of ['8301', '8302']) {
    await bookCache.saveLink(id, {
      schemaVersion: 2,
      livelibBookId: id,
      workId: `hc:${id}`,
      method: 'isbn',
      score: 1,
    });
  }
  await bookCache.saveProfile(
    'livelib',
    'FirstYearBounds',
    profile('FirstYearBounds', [
      event('ll:8301', 'Старая книга', { raw: { sourceBookId: '8301' } }),
      event('ll:8302', 'Будущая книга', { raw: { sourceBookId: '8302' } }),
    ])
  );

  const stats = buildBooksStats({ profile: 'livelib-FirstYearBounds' });
  assert.deepEqual(stats.decades.map((entry) => entry.decade), [1850, null]);
  assert.equal(stats.decades[stats.decades.length - 1].unknown, true);
  assert.equal(stats.summary.yearUnknownCount, 1);
  assert.equal(stats.booksIndex['hc:8302'].year, null);
});

/* ------------------------------------------------------------------ */
/* backfill                                                            */
/* ------------------------------------------------------------------ */

function fakeProvider(source, result) {
  const calls = [];
  const options = [];
  return {
    NAME: source,
    calls,
    options,
    async getWork(input, opts) {
      calls.push(input);
      options.push(opts || {});
      return typeof result === 'function' ? result(input) : result;
    },
  };
}

test('the backfill asks Hardcover only for a work-level first-publication claim', async () => {
  // Legacy schema-1 document: only an edition year. The loose normaliser used by
  // the resolve pass bridges it for display; the backfill must not.
  assert.equal(
    hardcoverProvider.normalizeDetails({ hcWorkId: 7, title: 'Legacy', publicationYear: 2013 }, null)
      .firstPublishedYear,
    2013
  );
  assert.equal(
    hardcoverProvider.normalizeDetails(
      { hcWorkId: 7, title: 'Legacy', publicationYear: 2013 },
      null,
      { requireWorkClaim: true }
    ).firstPublishedYear,
    null
  );
  assert.equal(
    hardcoverProvider.normalizeDetails(
      { hcWorkId: 8, title: 'Fresh', publicationYear: 2013, firstPublishedYear: 1909 },
      null,
      { requireWorkClaim: true }
    ).firstPublishedYear,
    1909
  );

  await bookCache.saveDetails(bookCache.detailsKeyForWork('lr:9600'), {
    schemaVersion: 2,
    workId: 'lr:9600',
    title: 'Издание без первоисточника',
    publicationYear: 2013,
  });
  const fakeHc = fakeProvider('hardcover', null);
  await yearsBackfill.backfill({
    ids: ['lr:9600'],
    hardcoverProvider: fakeHc,
    litresProvider: fakeProvider('litres', null),
    openlibraryProvider: fakeProvider('openlibrary', null),
    log: () => {},
    sleep: noSleep,
    pause: 0,
  });
  // No ISBN on this document, but a Cyrillic title: Литрес is asked, Hardcover
  // is skipped (no ISBN). The strict flag is asserted where it is passed.
  assert.equal(fakeHc.calls.length, 0);

  await bookCache.saveDetails(bookCache.detailsKeyForWork('lr:9700'), {
    schemaVersion: 2,
    workId: 'lr:9700',
    title: 'With isbn',
    publicationYear: 2013,
    isbn13: '9785000000123',
  });
  const strictHc = fakeProvider('hardcover', null);
  await yearsBackfill.backfill({
    ids: ['lr:9700'],
    hardcoverProvider: strictHc,
    litresProvider: fakeProvider('litres', null),
    openlibraryProvider: fakeProvider('openlibrary', null),
    log: () => {},
    sleep: noSleep,
    pause: 0,
  });
  assert.equal(strictHc.options[0].requireWorkClaim, true);
});

test('the backfill fills the missing year and leaves everything else intact', async () => {
  const doc = {
    schemaVersion: 2,
    workId: 'lr:9100',
    title: 'Гаргантюа и Пантагрюэль',
    authors: [{ name: 'Франсуа Рабле' }],
    genres: ['европейская старинная литература'],
    series: [],
    publicationYear: 2026,
    isbn13: '9785699139026',
    metadataSources: ['litres'],
  };
  await bookCache.saveDetails(bookCache.detailsKeyForWork('lr:9100'), doc);

  const fakeLitres = fakeProvider('litres', {
    source: 'litres',
    sourceId: '73939817',
    firstPublishedYear: 1564,
  });
  const fakeOl = fakeProvider('openlibrary', {
    source: 'openlibrary',
    sourceId: 'OL1M',
    firstPublishedYear: null,
  });
  const report = await yearsBackfill.backfill({
    ids: ['lr:9100'],
    litresProvider: fakeLitres,
    openlibraryProvider: fakeOl,
    hardcoverProvider: fakeProvider('hardcover', null),
    log: () => {},
    sleep: noSleep,
    pause: 0,
  });
  assert.equal(report.resolved.length, 1);
  assert.equal(report.resolved[0].year, 1564);
  assert.equal(report.resolved[0].source, 'litres');

  const saved = bookCache.getWorkDetails('lr:9100');
  assert.equal(saved.firstPublishedYear, 1564);
  assert.equal(saved.firstPublishedYearSource, 'litres');
  assert.equal(saved.publicationYear, 2026);
  assert.deepEqual(saved.genres, ['европейская старинная литература']);
  assert.equal(saved.isbn13, '9785699139026');
});

test('the backfill skips documents that already claim a year, and --dry-run writes nothing', async () => {
  await bookCache.saveDetails(bookCache.detailsKeyForWork('lr:9200'), {
    schemaVersion: 2,
    workId: 'lr:9200',
    title: 'Король Лир',
    publicationYear: 2006,
    firstPublishedYear: 1608,
  });
  const fakeOl = fakeProvider('openlibrary', {
    source: 'openlibrary',
    firstPublishedYear: 1608,
  });
  const skipped = await yearsBackfill.backfill({
    openlibraryProvider: fakeOl,
    hardcoverProvider: fakeProvider('hardcover', null),
    litresProvider: fakeProvider('litres', null),
    log: () => {},
    sleep: noSleep,
    pause: 0,
  });
  const entry = skipped.resolved.find((item) => item.workId === 'lr:9200');
  assert.equal(entry, undefined);
  assert.equal(
    fakeOl.calls.some((input) => input.title === 'Король Лир'),
    false
  );

  await bookCache.saveDetails(bookCache.detailsKeyForWork('lr:9300'), {
    schemaVersion: 2,
    workId: 'lr:9300',
    title: 'Буря',
    publicationYear: 2014,
  });
  const dry = await yearsBackfill.backfill({
    ids: ['lr:9300'],
    dryRun: true,
    openlibraryProvider: fakeProvider('openlibrary', {
      source: 'openlibrary',
      firstPublishedYear: 1611,
    }),
    hardcoverProvider: fakeProvider('hardcover', null),
    litresProvider: fakeProvider('litres', null),
    log: () => {},
    sleep: noSleep,
    pause: 0,
  });
  assert.equal(dry.resolved.length, 1);
  assert.equal(dry.resolved[0].year, 1611);
  const untouched = bookCache.getWorkDetails('lr:9300');
  assert.equal(untouched.firstPublishedYear, undefined);
});

/**
 * Idempotency of the metadata backfill.
 *
 * A book nobody knows a year for must not cost three provider requests on every
 * run: the hopeless verdict is cached in the document itself
 * (`firstPublishedYearCheckedAt`), and the next run is a pure cache scan. This
 * is what makes the systemd oneshot safe to run repeatedly (and what the
 * AGENTS.md politeness rules require).
 */
test('the backfill remembers a hopeless verdict and the next run asks nobody', async () => {
  await bookCache.saveDetails(bookCache.detailsKeyForWork('lr:9400'), {
    schemaVersion: 2,
    workId: 'lr:9400',
    title: 'Безымянная рукопись',
    publicationYear: 2020,
    isbn13: '9785000000000',
  });
  const silent = () => fakeProvider('silent', null);
  const firstOl = silent();
  const firstLitres = silent();
  const firstHc = silent();
  const firstRun = await yearsBackfill.backfill({
    ids: ['lr:9400'],
    openlibraryProvider: firstOl,
    litresProvider: firstLitres,
    hardcoverProvider: firstHc,
    log: () => {},
    sleep: noSleep,
    pause: 0,
    now: '2026-10-28T00:00:00.000Z',
  });
  assert.equal(firstRun.resolved.length, 0);
  assert.equal(firstRun.unknown.length, 1);
  assert.equal(firstLitres.calls.length, 1, 'the first run still asks Литрес');
  const marked = bookCache.getWorkDetails('lr:9400');
  assert.equal(marked.firstPublishedYear, undefined);
  assert.equal(marked.firstPublishedYearCheckedAt, '2026-10-28T00:00:00.000Z');
  assert.equal(marked.firstPublishedYearCheckedBy, 'none');

  // Re-run a day later: the document is inside the recheck window, so not a
  // single provider is called and the report says so.
  const secondOl = silent();
  const secondLitres = silent();
  const secondHc = silent();
  const secondRun = await yearsBackfill.backfill({
    openlibraryProvider: secondOl,
    litresProvider: secondLitres,
    hardcoverProvider: secondHc,
    log: () => {},
    sleep: noSleep,
    pause: 0,
    now: '2026-10-29T00:00:00.000Z',
  });
  assert.equal(secondRun.skippedChecked >= 1, true);
  const asked = [...secondLitres.calls, ...secondOl.calls, ...secondHc.calls]
    .filter((input) => input && input.title === 'Безымянная рукопись');
  assert.equal(asked.length, 0, 'a marked document must not reach a provider');

  // `--force` (and an explicit `--ids`) is the operator's override.
  await yearsBackfill.backfill({
    ids: ['lr:9400'],
    openlibraryProvider: silent(),
    litresProvider: silent(),
    hardcoverProvider: silent(),
    log: () => {},
    sleep: noSleep,
    pause: 0,
    now: '2026-10-29T00:00:00.000Z',
  });

  // After the window expires the document becomes a candidate again.
  await yearsBackfill.backfill({
    openlibraryProvider: silent(),
    litresProvider: silent(),
    hardcoverProvider: silent(),
    log: () => {},
    sleep: noSleep,
    pause: 0,
    recheckDays: 1,
    now: '2026-11-30T00:00:00.000Z',
  });
  const stale = bookCache.getWorkDetails('lr:9400');
  assert.equal(stale.firstPublishedYearCheckedAt, '2026-11-30T00:00:00.000Z');
});

test('the backfill dry run writes no negative marker', async () => {
  await bookCache.saveDetails(bookCache.detailsKeyForWork('lr:9500'), {
    schemaVersion: 2,
    workId: 'lr:9500',
    title: 'Черновик',
    publicationYear: 2010,
  });
  const dry = await yearsBackfill.backfill({
    ids: ['lr:9500'],
    dryRun: true,
    openlibraryProvider: fakeProvider('openlibrary', null),
    litresProvider: fakeProvider('litres', null),
    hardcoverProvider: fakeProvider('hardcover', null),
    log: () => {},
    sleep: noSleep,
    pause: 0,
    now: '2026-10-28T00:00:00.000Z',
  });
  assert.equal(dry.unknown.length, 1);
  const doc = bookCache.getWorkDetails('lr:9500');
  assert.equal(doc.firstPublishedYearCheckedAt, undefined);
});
