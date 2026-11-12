'use strict';

/**
 * Books: metadata chain, years and provider wiring suite: the former standalone `*.test.js` files of this domain,
 * merged into one process (R19 test-suite consolidation).
 *
 * Each block below is its original file, kept verbatim inside its own
 * `describe()`:
 *
 *   - the describe title is the file stem, so every test stays greppable as
 *     `<file> > <original title>`;
 *   - the block scope keeps a file's helper names from colliding with its
 *     neighbours;
 *   - the hooks a file declared (`test.before`/`test.after`/
 *     `test.beforeEach`) stay scoped to that block instead of applying to the
 *     whole process.
 *
 * The tmp root is one `helpers/env` run for the whole suite, created BEFORE
 * any `server/**` require (every cache namespace reads its root once, at load
 * time). A file's own tmp setup folds into that root — the module singletons
 * are process-wide anyway, so a second root would only desynchronise a file
 * from the directory its assertions read. Tests keep apart by `userKey`/work
 * key, never by root.
 *
 * `env.cleanupTmpDirs()` removes every directory this run created.
 */

const { describe, after, before } = require('node:test');
const env = require('./helpers/env');

const run = env.makeTmpCache('books-metadata-suite', { budgets: false });

after(() => {
  env.cleanupTmpDirs();
});

process.on('exit', () => {
  env.cleanupTmpDirs();
});


describe('books-first-year', () => {
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

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

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

  /**
   * A silent Wikidata: the backfill asks it in one batched pass for the whole
   * slice, and a test that does not inject it would talk to the real WDQS.
   */
  function silentWikidata() {
    const calls = [];
    return {
      NAME: 'wikidata',
      calls,
      async lookupTitles(entries) {
        calls.push(entries);
        return { byKey: new Map(), asked: new Set(), skipped: null, queries: 0 };
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
      wikidataProvider: silentWikidata(),
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
      wikidataProvider: silentWikidata(),
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
      wikidataProvider: silentWikidata(),
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
      wikidataProvider: silentWikidata(),
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
      wikidataProvider: silentWikidata(),
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
      wikidataProvider: silentWikidata(),
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
    // The marker names every provider that was asked, so a provider added
    // later can re-open the verdict (Wikidata did exactly that).
    assert.equal(marked.firstPublishedYearCheckedBy, 'hardcover,litres,openlibrary,wikidata');

    // Re-run a day later: the document is inside the recheck window, so not a
    // single provider is called and the report says so.
    const secondOl = silent();
    const secondLitres = silent();
    const secondHc = silent();
    const secondRun = await yearsBackfill.backfill({
      wikidataProvider: silentWikidata(),
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
      wikidataProvider: silentWikidata(),
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
      wikidataProvider: silentWikidata(),
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
      wikidataProvider: silentWikidata(),
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
  after(() => env.resetMutableState());
});


describe('books-years-convergence', () => {
  /**
   * Convergence of the first-publication-year backfill (round 29.10.2026).
   *
   * The production symptom was «632 книги висят с „Год неизвестен“» after a
   * single `kinoboxd-backfill-books` run with a small Литрес budget. Two things
   * must hold for the queue to drain across runs:
   *
   *   1. A run that stops because the Литрес budget is gone (or because a
   *      provider errored) must NOT write `firstPublishedYearCheckedAt`. That
   *      marker means «everybody was asked and nobody knows» and hides the
   *      document for 30 days; writing it on a budget stop poisons the queue.
   *   2. The slice's Hardcover ISBNs are one batched lookup, not one request per
   *      book (free plan: one top-level GraphQL field per request, 60/min).
   *
   * Pinned here:
   *   - budget exhaustion → `deferred`, no negative marker, the next run asks
   *     Литрес again (the same document is a candidate);
   *   - a provider network error → `deferred`, no negative marker;
   *   - a real «nobody knows» (all providers answered) → negative marker;
   *   - Hardcover prefetch batches every ISBN of the slice into one call;
   *   - `summary.yearBackfill` tells the UI how much of the unknown bucket is
   *     still a queue (pending) vs honestly unknown (checked) vs unlinked.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const yearsBackfill = require('../server/books/years-backfill');
  const { buildBooksStats } = require('../server/books/stats');

  const noSleep = async () => {};

  function fakeProvider(source, handler) {
    const calls = [];
    return {
      NAME: source,
      calls,
      async getWork(input, options) {
        calls.push({ input, options: options || {} });
        return typeof handler === 'function' ? handler(input) : handler;
      },
    };
  }

  /**
   * A silent Wikidata: the backfill asks it in one batched pass for the whole
   * slice, and a test that does not inject it would talk to the real WDQS.
   */
  function silentWikidata() {
    const calls = [];
    return {
      NAME: 'wikidata',
      calls,
      async lookupTitles(entries) {
        calls.push(entries);
        return { byKey: new Map(), asked: new Set(), skipped: null, queries: 0 };
      },
    };
  }

  async function seed(workId, doc) {
    await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), {
      schemaVersion: 2,
      ...doc,
    });
  }

  test('an exhausted Литрес budget defers the document without poisoning the negative cache', async () => {
    await seed('lr:7001', {
      workId: 'lr:7001',
      title: 'Война и мир',
      authors: [{ name: 'Лев Толстой' }],
      publicationYear: 2020,
    });

    let budgetLeft = 0;
    let asked = 0;
    const budget = {
      get used() {
        return budgetLeft ? 0 : 1;
      },
      get remaining() {
        return budgetLeft;
      },
      take() {
        if (!budgetLeft) return false;
        budgetLeft--;
        return true;
      },
    };
    const litres = fakeProvider('litres', () => {
      asked++;
      // Real provider: `take()` fails before the request, returns null.
      return null;
    });
    litres.isBreakerOpen = () => false;

    const report = await yearsBackfill.backfill({
      wikidataProvider: silentWikidata(),
      ids: ['lr:7001'],
      budget,
      litresProvider: litres,
      hardcoverProvider: fakeProvider('hardcover', null),
      openlibraryProvider: fakeProvider('openlibrary', null),
      log: () => {},
      sleep: noSleep,
      pause: 0,
    });

    // The fake provider does not take() from the budget itself; the shared
    // counter staying put while `remaining === 0` is exactly how the real
    // provider signals «budget gone before the request». Either way no year is
    // written and no negative marker is allowed.
    assert.equal(asked, 1);
    assert.equal(report.deferred.length, 1);
    assert.deepEqual(report.deferred[0].reasons, ['litres-budget']);
    assert.equal(report.unknown.length, 0);
    const saved = bookCache.getWorkDetails('lr:7001');
    assert.equal(saved.firstPublishedYearCheckedAt, undefined);
    // Still a candidate for the next run: the pending queue did not shrink.
    assert.equal(report.pending, 1);

    // Next run: the budget is fresh, the same document is asked again.
    let secondRunAsked = 0;
    const freshBudget = { used: 0, remaining: 200, take() { this.used++; return true; } };
    const secondLitres = fakeProvider('litres', () => {
      secondRunAsked++;
      return { source: 'litres', sourceId: '1', firstPublishedYear: 1869 };
    });
    secondLitres.isBreakerOpen = () => false;
    const second = await yearsBackfill.backfill({
      wikidataProvider: silentWikidata(),
      ids: ['lr:7001'],
      budget: freshBudget,
      litresProvider: secondLitres,
      hardcoverProvider: fakeProvider('hardcover', null),
      openlibraryProvider: fakeProvider('openlibrary', null),
      log: () => {},
      sleep: noSleep,
      pause: 0,
    });
    assert.equal(secondRunAsked, 1);
    assert.equal(second.resolved.length, 1);
    assert.equal(bookCache.getWorkDetails('lr:7001').firstPublishedYear, 1869);
  });

  test('a provider network error is a deferral, not a verdict', async () => {
    await seed('lr:7002', {
      workId: 'lr:7002',
      title: 'Анна Каренина',
      authors: [{ name: 'Лев Толстой' }],
      publicationYear: 2019,
    });
    const litres = fakeProvider('litres', () => {
      const err = new Error('network down');
      err.code = 'provider_network_error';
      throw err;
    });
    litres.isBreakerOpen = () => false;
    const report = await yearsBackfill.backfill({
      wikidataProvider: silentWikidata(),
      ids: ['lr:7002'],
      budget: { used: 0, remaining: 200, take() { return true; } },
      litresProvider: litres,
      hardcoverProvider: fakeProvider('hardcover', null),
      openlibraryProvider: fakeProvider('openlibrary', null),
      log: () => {},
      sleep: noSleep,
      pause: 0,
    });
    assert.equal(report.deferred.length, 1);
    assert.deepEqual(report.deferred[0].reasons, ['litres-error']);
    assert.equal(bookCache.getWorkDetails('lr:7002').firstPublishedYearCheckedAt, undefined);
  });

  test('an open Литрес breaker is not asked and does not mark the document', async () => {
    await seed('lr:7003', {
      workId: 'lr:7003',
      title: 'Преступление и наказание',
      publicationYear: 2018,
    });
    const litres = fakeProvider('litres', { source: 'litres', firstPublishedYear: 1866 });
    litres.isBreakerOpen = () => true;
    const report = await yearsBackfill.backfill({
      wikidataProvider: silentWikidata(),
      ids: ['lr:7003'],
      budget: { used: 0, remaining: 200, take() { return true; } },
      litresProvider: litres,
      hardcoverProvider: fakeProvider('hardcover', null),
      openlibraryProvider: fakeProvider('openlibrary', null),
      log: () => {},
      sleep: noSleep,
      pause: 0,
    });
    assert.equal(litres.calls.length, 0);
    assert.deepEqual(report.deferred[0].reasons, ['litres-breaker']);
    assert.equal(bookCache.getWorkDetails('lr:7003').firstPublishedYearCheckedAt, undefined);
  });

  test('a failed batched Hardcover lookup defers instead of writing the negative cache', async () => {
    await seed('lr:7005', {
      workId: 'lr:7005',
      title: 'Some English Book',
      isbn13: '9780000000035',
    });
    const lookupIsbns = async () => {
      const err = new Error('hardcover down');
      err.code = 'hardcover_network_error';
      throw err;
    };
    const report = await yearsBackfill.backfill({
      wikidataProvider: silentWikidata(),
      ids: ['lr:7005'],
      lookupIsbns,
      budget: { used: 0, remaining: 200, take() { return true; } },
      litresProvider: fakeProvider('litres', null),
      openlibraryProvider: fakeProvider('openlibrary', null),
      log: () => {},
      sleep: noSleep,
      pause: 0,
    });
    assert.equal(report.deferred.length, 1);
    assert.deepEqual(report.deferred[0].reasons, ['hardcover-error']);
    assert.equal(bookCache.getWorkDetails('lr:7005').firstPublishedYearCheckedAt, undefined);
  });

  test('a real «nobody knows» writes the negative cache without a provider error', async () => {
    await seed('lr:7004', {
      workId: 'lr:7004',
      title: 'Совсем безымянная книга',
      publicationYear: 2017,
    });
    const litres = fakeProvider('litres', null);
    litres.isBreakerOpen = () => false;
    const report = await yearsBackfill.backfill({
      wikidataProvider: silentWikidata(),
      ids: ['lr:7004'],
      budget: { used: 0, remaining: 200, take() { return true; } },
      litresProvider: litres,
      hardcoverProvider: fakeProvider('hardcover', null),
      openlibraryProvider: fakeProvider('openlibrary', null),
      log: () => {},
      sleep: noSleep,
      pause: 0,
    });
    assert.equal(report.unknown.length, 1);
    assert.equal(report.unknown[0].asked, 'litres,openlibrary,wikidata');
    assert.equal(report.deferred.length, 0);
    const saved = bookCache.getWorkDetails('lr:7004');
    assert.ok(saved.firstPublishedYearCheckedAt);
    assert.equal(saved.firstPublishedYearCheckedBy, 'litres,openlibrary,wikidata');
  });

  test('the whole slice shares one batched Hardcover ISBN lookup', async () => {
    await seed('lr:7010', {
      workId: 'lr:7010',
      title: 'Book A',
      isbn13: '9780000000011',
    });
    await seed('lr:7011', {
      workId: 'lr:7011',
      title: 'Book B',
      isbn13: '9780000000028',
    });
    const lookups = [];
    const lookupIsbns = async (isbns) => {
      lookups.push([...isbns]);
      const byIsbn = new Map();
      for (const isbn of isbns) {
        byIsbn.set(isbn, {
          details: {
            hcWorkId: isbn.endsWith('1') ? 9001 : 9002,
            title: isbn.endsWith('1') ? 'Book A' : 'Book B',
            firstPublishedYear: isbn.endsWith('1') ? 1901 : 1902,
          },
          editionId: null,
        });
      }
      return { byIsbn, works: new Map(), requests: 1, queries: [] };
    };
    const report = await yearsBackfill.backfill({
      wikidataProvider: silentWikidata(),
      ids: ['lr:7010', 'lr:7011'],
      lookupIsbns,
      budget: { used: 0, remaining: 200, take() { return true; } },
      litresProvider: fakeProvider('litres', null),
      openlibraryProvider: fakeProvider('openlibrary', null),
      log: () => {},
      sleep: noSleep,
      pause: 0,
    });
    assert.equal(lookups.length, 1);
    assert.deepEqual(lookups[0].sort(), ['9780000000011', '9780000000028']);
    assert.equal(report.hardcoverRequests, 1);
    assert.deepEqual(
      report.resolved.map((entry) => [entry.workId, entry.year, entry.source]).sort(),
      [
        ['lr:7010', 1901, 'hardcover'],
        ['lr:7011', 1902, 'hardcover'],
      ]
    );
  });

  /* ------------------------------------------------------------------ */
  /* payload: how much of «год неизвестен» is still a queue              */
  /* ------------------------------------------------------------------ */

  function event(id) {
    return {
      id: `ll:${id}`,
      source: 'livelib',
      sourceBookId: String(id),
      title: `Book ${id}`,
      authors: [],
      status: 'read',
      finishedAt: '2024-05-05',
    };
  }

  test('summary.yearBackfill: edition fallback leaves only the unlinked work unknown', async () => {
    process.env.BOOKS_BACKFILL_LIMIT = '200';
    await seed('hc:8801', { hcWorkId: 8801, title: 'Known', firstPublishedYear: 1900 });
    await seed('hc:8802', { hcWorkId: 8802, title: 'Pending', publicationYear: 2020 });
    await seed('hc:8803', {
      hcWorkId: 8803,
      title: 'Honest unknown',
      publicationYear: 2020,
      firstPublishedYearCheckedAt: '2026-10-29T00:00:00.000Z',
      firstPublishedYearCheckedBy: 'none',
    });
    for (const id of ['8801', '8802', '8803']) {
      await bookCache.saveLink(id, {
        schemaVersion: 2,
        livelibBookId: id,
        workId: `hc:${id}`,
        method: 'isbn',
        score: 1,
      });
    }
    await bookCache.saveProfile('livelib', 'YearsProgress', {
      schemaVersion: 1,
      source: 'livelib',
      userKey: 'YearsProgress',
      importedAt: '2026-10-29T00:00:00.000Z',
      events: [event('8801'), event('8802'), event('8803'), event('8899')],
      warnings: [],
    });

    const stats = buildBooksStats({ profile: 'livelib-YearsProgress' });
    // 8802/8803 have no first-publication claim but do have a print-run year, so
    // they enter the chart marked as editions. Only the unlinked 8899 stays in
    // «год неизвестен».
    assert.equal(stats.summary.yearUnknownCount, 1);
    assert.equal(stats.summary.yearEditionCount, 2);
    assert.equal(stats.summary.yearFirstCount, 1);
    assert.deepEqual(stats.summary.yearBackfill, {
      known: 3,
      unknown: 1,
      pending: 0,
      honestUnknown: 0,
      unlinked: 1,
      sources: { first: 1, edition: 2, manual: 0 },
      // Both edition fallbacks came from the details document's print run.
      editionChannels: { file: 0, details: 2 },
      // This profile is not a file import: no export rows to inspect.
      fileColumn: { rows: 0, withYear: 0 },
      perRun: 200,
      runsLeft: 0,
      // Nothing left in the queue: the remaining unknown is an unlinked work.
      open: false,
    });
  });

  test('the years note never calls unlinked works an honest «providers do not know»', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'js', 'books.js'),
      'utf8'
    );
    // Queue still open: progress wording with the estimate and the unlinked tail.
    assert.match(source, /бэкфилл идёт, осталось ~/);
    assert.match(source, /ждут привязки к метаданным/);
    // Queue drained but unlinked works remain: the note must not collapse them
    // into «провайдеры не знают» (that branch requires honestUnknown > 0).
    assert.match(source, /backfill\.honestUnknown > 0/);
  });

  test('a fully filled cache reports no queue', async () => {
    process.env.BOOKS_BACKFILL_LIMIT = '200';
    const stats = buildBooksStats({ profile: 'livelib-YearsProgress' });
    // The previous test wrote the docs for the same profile; re-seed 8802 with a
    // year so only the honest-unknown and the unlinked work remain.
    await seed('hc:8802', { hcWorkId: 8802, title: 'Pending', firstPublishedYear: 1910 });
    const after = buildBooksStats({ profile: 'livelib-YearsProgress' });
    // 8801 first publication, 8802 first publication, 8803 edition fallback.
    assert.equal(after.summary.yearBackfill.known, 3);
    assert.equal(after.summary.yearBackfill.pending, 0);
    assert.equal(after.summary.yearBackfill.runsLeft, 0);
    assert.equal(after.summary.yearBackfill.open, false);
    void stats;
  });
  after(() => env.resetMutableState());
});


describe('books-series-blacklist', () => {
  /**
   * Series blacklist («Книга на все времена» and future catalogue tags).
   *
   * User decision 28.10.2026: a publisher's shelf that Литрес/Эксмо publish in
   * the same «Серия» column as a real cycle is a TAG, not a literary series. The
   * tag must leave the series widget and every count that feeds it — regardless
   * of the source that brought it (литрес / file column / hardcover).
   *
   * Pinned here:
   *   - normalization (case, «ё», quotes, a trailing parenthetical);
   *   - a blacklisted series disappears from `stats.series` AND `summary.seriesCount`;
   *   - an ordinary series in the same profile is untouched;
   *   - the filter is source-independent (file column authority does not matter
   *     for the *kind* of the value).
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const {
    SERIES_BLACKLIST,
    blacklistKey,
    isBlacklistedSeries,
    filterBlacklistedSeries,
  } = require('../server/books/series-blacklist');
  const { buildBooksStats } = require('../server/books/stats');

  function profile(userKey, events) {
    return {
      schemaVersion: 1,
      source: 'livelib',
      userKey,
      sourceUserId: null,
      importedAt: '2026-10-28T00:00:00.000Z',
      events,
      warnings: [],
    };
  }

  function event(id, title, extra = {}) {
    return {
      id,
      source: 'livelib',
      sourceBookId: null,
      title,
      authors: extra.authors || ['Автор'],
      rating: null,
      ratingScale: 10,
      rating10: null,
      status: 'read',
      shelf: 'read',
      origin: 'livelib-file',
      finishedAt: null,
      readMonth: extra.readMonth || '2021-01',
      edition: {
        publisher: null,
        year: null,
        isbn: null,
        language: 'ru',
        series: extra.fileSeries || null,
      },
      genres: extra.genres || [],
      ...extra.raw,
    };
  }

  async function details(workId, doc) {
    await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), {
      schemaVersion: 2,
      workId,
      ...doc,
    });
  }

  test('the blacklist is a normalised set, not a string compare', () => {
    assert.ok(SERIES_BLACKLIST.includes('Книга на все времена'));
    for (const variant of [
      'Книга на все времена',
      'книга на все времена',
      'КНИГА НА ВСЕ ВРЕМЕНА',
      '«Книга на все времена»',
      'Книга на все времена (Эксмо)',
      '  Книга  на   все времена. ',
    ]) {
      assert.equal(isBlacklistedSeries(variant), true, variant);
      assert.equal(blacklistKey(variant), 'книга на все времена');
    }
    assert.equal(isBlacklistedSeries('Песнь Льда и Пламени'), false);
    assert.equal(isBlacklistedSeries(''), false);
    assert.equal(isBlacklistedSeries(null), false);
  });

  test('every confirmed tag is filtered, whatever its spelling', () => {
    // Full list confirmed by the user 28.10.2026 (publisher catalogues/promo
    // shelves, not literary series). The canonical spelling lives in the module;
    // here we pin that each one actually bites in the spellings a Литрес/Эксмо
    // export produces.
    const confirmed = [
      'Книга на все времена',
      'Азбука-классика',
      'Эксклюзивная классика',
      'The Big Book',
      'Иностранная литература. Большие книги',
      'Женская библиотека',
      'Зарубежная классика',
      'Зачарованный мир',
      'Золотая серия фэнтези',
      'Классика',
      'Библиотека приключений',
      'Pocket book',
      'Классики и современники',
      'Прочесть обязательно!',
      'Русская классика',
      'Шорт-лист',
    ];
    for (const name of confirmed) {
      assert.ok(
        SERIES_BLACKLIST.includes(name),
        `missing from SERIES_BLACKLIST: ${name}`
      );
      for (const variant of [
        name,
        name.toLowerCase(),
        name.toUpperCase(),
        `«${name}»`,
        `${name} (Эксмо)`,
        `  ${name}. `,
      ]) {
        assert.equal(isBlacklistedSeries(variant), true, variant);
      }
    }
  });

  test('normalisation folds the pocket-book variant into «Азбука-классика»', () => {
    // «Азбука-классика (pocket-book)» is the same shelf; the parenthetical is
    // dropped by normalisation, so a second array entry would be a silent
    // duplicate of the same key. The real export carries both spellings.
    assert.equal(blacklistKey('Азбука-классика (pocket-book)'), 'азбука классика');
    assert.equal(blacklistKey('Азбука-классика'), 'азбука классика');
    assert.equal(isBlacklistedSeries('Азбука-классика (pocket-book)'), true);
    assert.equal(isBlacklistedSeries('АЗБУКА-КЛАССИКА (POCKET-BOOK)'), true);

    // …and the list itself must not carry two entries with one key: a duplicate
    // would be a change that does nothing, so it is banned explicitly.
    const keys = SERIES_BLACKLIST.map(blacklistKey);
    assert.equal(new Set(keys).size, keys.length, `duplicate keys: ${keys.join(', ')}`);
  });

  test('exact match only: real series with these words are not touched', () => {
    // Short, generic tags («Классика», «Pocket book») are the dangerous ones.
    // Matching is the whole normalized key, so a longer name that *contains* a
    // tag is a different series and must survive.
    for (const legit of [
      'Моэм — автор на все времена',
      'Зарубежная классика. XX век',
      'Иностранная литература. Современная классика',
      'Антиутопии. Классика',
      'Классика детектива',
      'Классика в школе',
      'Лениздат-классика',
      'Новые краски классики',
      'Всемирная детская классика',
      'Лучшая мировая классика',
      'Исторический роман. Классика',
      'Мировая классика',
      'Pocket Book of Horror',
      'The Big Book of Fantasy',
      'Золотая библиотека фантастики',
      'Школьная библиотека',
      'Библиотека всемирной литературы',
      'Хроники Амбера',
    ]) {
      assert.equal(isBlacklistedSeries(legit), false, legit);
    }
    // A tag glued to a subtitle is no longer the tag either (exact-match rule).
    assert.equal(isBlacklistedSeries('Классика. Подарочное издание'), false);
    assert.equal(isBlacklistedSeries('Шорт-лист 2024'), false);
  });

  test('filterBlacklistedSeries drops only the tag and reports the count', () => {
    const { list, removed } = filterBlacklistedSeries([
      { name: 'Книга на все времена', hcId: null, position: null },
      { name: 'Настоящая серия', hcId: 42, position: 2 },
      { name: 'книга на все времена', hcId: 9, position: 1 },
    ]);
    assert.equal(removed, 2);
    assert.deepEqual(list.map((entry) => entry.name), ['Настоящая серия']);
  });

  test('a blacklisted series never reaches the payload, a real one stays', async () => {
    // Work A: Литрес pseudo-series that even carries a volume order, so the
    // older `filterDetailsSeries` rule alone would have kept it — only the
    // blacklist can drop this one.
    await details('hc:9001', {
      schemaVersion: 2,
      hcWorkId: 9001,
      title: 'Книга А',
      authors: [{ hcId: 1, name: 'Автор А' }],
      genres: ['Классика'],
      series: [{ name: 'Книга на все времена', position: 1, source: 'litres' }],
      metadataSources: ['litres'],
    });
    // Work B: the same tag but the FILE column names it (authority question).
    await details('hc:9002', {
      schemaVersion: 2,
      hcWorkId: 9002,
      title: 'Книга Б',
      authors: [{ hcId: 2, name: 'Автор Б' }],
      genres: ['Классика'],
      series: [],
      metadataSources: ['hardcover'],
    });
    // Work C: a real series with a volume order.
    await details('hc:9003', {
      schemaVersion: 2,
      hcWorkId: 9003,
      title: 'Книга В',
      authors: [{ hcId: 3, name: 'Автор В' }],
      genres: ['Фэнтези'],
      series: [{ hcId: 77, name: 'Хроники Амбера', position: 1 }],
      metadataSources: ['hardcover'],
    });

    for (const id of ['9001', '9002', '9003']) {
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
      'Blacklist',
      profile('Blacklist', [
        event('ll:9001', 'Книга А', { raw: { sourceBookId: '9001' } }),
        event('ll:9002', 'Книга Б', {
          raw: { sourceBookId: '9002' },
          fileSeries: 'Книга на все времена',
        }),
        event('ll:9003', 'Книга В', { raw: { sourceBookId: '9003' } }),
      ])
    );

    const stats = buildBooksStats({ profile: 'livelib-Blacklist', includeMangaComics: true });
    const names = stats.series.map((entry) => entry.name);
    assert.deepEqual(names, ['Хроники Амбера']);
    assert.equal(stats.series.length, 1);
    assert.equal(stats.series[0].count, 1);
    assert.equal(stats.summary.seriesCount, 1);
    // Two works lost the tag (the Литрес one and the file-column one).
    assert.equal(stats.summary.seriesTagsFiltered, 2);
    // The tag is not hiding books: the works are still counted.
    assert.equal(stats.summary.bookCount, 3);
    // And no widget entry leaks the tag name.
    assert.ok(!JSON.stringify(stats).includes('Книга на все времена'));
  });

  test('the whole confirmed list is dropped from the payload, look-alikes stay', async () => {
    // One work per kind of evidence: a Литрес tag that even carries an order, three
    // file-column tags (the column is the authority for a value), and three real
    // series whose names merely *contain* a short tag.
    await details('hc:9101', {
      schemaVersion: 2,
      hcWorkId: 9101,
      title: 'Книга 1',
      authors: [{ hcId: 11, name: 'Автор 1' }],
      genres: ['Проза'],
      series: [{ name: 'Азбука-классика (pocket-book)', position: 1, source: 'litres' }],
      metadataSources: ['litres'],
    });
    await details('hc:9106', {
      schemaVersion: 2,
      hcWorkId: 9106,
      title: 'Книга 6',
      authors: [{ hcId: 16, name: 'Автор 6' }],
      genres: ['Ужасы'],
      series: [{ hcId: 616, name: 'Pocket Book of Horror', position: 1 }],
      metadataSources: ['hardcover'],
    });
    for (const id of ['9101', '9102', '9103', '9104', '9105', '9106', '9107']) {
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
      'Tags',
      profile('Tags', [
        event('ll:9101', 'Книга 1', { raw: { sourceBookId: '9101' }, genres: ['Проза'] }),
        event('ll:9102', 'Книга 2', {
          raw: { sourceBookId: '9102' },
          fileSeries: 'Классика',
          genres: ['Проза'],
        }),
        event('ll:9103', 'Книга 3', {
          raw: { sourceBookId: '9103' },
          fileSeries: 'Pocket Book',
          genres: ['Проза'],
        }),
        event('ll:9104', 'Книга 4', {
          raw: { sourceBookId: '9104' },
          fileSeries: 'Моэм — автор на все времена',
          genres: ['Проза'],
        }),
        event('ll:9105', 'Книга 5', {
          raw: { sourceBookId: '9105' },
          fileSeries: 'Антиутопии. Классика',
          genres: ['Антиутопия'],
        }),
        event('ll:9106', 'Книга 6', { raw: { sourceBookId: '9106' }, genres: ['Ужасы'] }),
        event('ll:9107', 'Книга 7', {
          raw: { sourceBookId: '9107' },
          fileSeries: 'Зарубежная классика. XX век',
          genres: ['Проза'],
        }),
      ])
    );

    const stats = buildBooksStats({ profile: 'livelib-Tags', includeMangaComics: true });
    const names = stats.series.map((entry) => entry.name).sort();
    assert.deepEqual(names, [
      'Pocket Book of Horror',
      'Антиутопии. Классика',
      'Зарубежная классика. XX век',
      'Моэм — автор на все времена',
    ]);
    assert.equal(stats.summary.seriesCount, 4);
    // Three works lost a tag: the Литрес shelf, «Классика» and «Pocket Book».
    assert.equal(stats.summary.seriesTagsFiltered, 3);
    // No book is hidden by the filter.
    assert.equal(stats.summary.bookCount, 7);
    // No widget entry leaks a tag name (series list only: a genre could legally
    // be called «Классика» and is not what this filter governs).
    for (const tag of ['Азбука-классика', 'Классика', 'Pocket Book']) {
      assert.ok(!names.includes(tag), tag);
    }
  });
  after(() => env.resetMutableState());
});


describe('books-profiles', () => {
  /* Pure helpers of the local books-profile registry.
   *
   * Model (28.10.2026): a profile is ONE source + ONE account. Hardcover-34748
   * and LiveLib-Margaret are different profiles and their statistics never
   * merge. Here we cover the logic that decides *what* is sent to the server and
   * what is accepted from the user:
   *  - profile normalisation (dedupe, ordering, no invented defaults);
   *  - single-token `profile=` building and the K6 two-source migration;
   *  - first-run migration from the old localStorage accounts;
   *  - cookie-header sanitising (the value must never be echoed/stored);
   *  - LiveLib 403 detection.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');

  const {
    normalizeProfile, profileKey, profileKeys, profileQuery, primarySource,
    profileSources, profileSummary, scopeSourceNames, withSource, sourceAccount,
    migrateLegacyAccounts, adoptServerProfiles, splitMultiSourceProfile,
    isValidLivelibUsername, isValidHardcoverUser, sanitizeCookieHeader,
    looksLikeCookieHeader, isLivelibBlocked, normalizeSource, MAX_PROFILES,
  } = require('../public/js/books-profiles.js');

  test('normalizeProfile keeps valid sources, dedupes and orders LiveLib → Hardcover', () => {
    // `normalizeProfile` is the tolerant reader: it preserves every source of a
    // legacy record so `loadRegistry` can split it. The *single-profile* view is
    // `primarySource` / `profileKey`.
    const profile = normalizeProfile({
      label: '  Дом  ',
      sources: [
        { source: 'hardcover', userId: '34748' },
        { source: 'livelib', username: '@Margaret' },
        { source: 'hardcover', userId: '999' }, // last wins
        { source: 'livelib', username: 'bad name with spaces' },
        { source: 'storygraph', username: 'x' },
        null,
      ],
    });
    assert.equal(profile.label, 'Дом');
    assert.deepEqual(profileSources(profile), [
      { source: 'livelib', username: 'Margaret' },
      { source: 'hardcover', userId: '999' }, // last valid hardcover wins
    ]);
    // The profile stands for ONE account: Hardcover wins on a legacy union.
    assert.deepEqual(primarySource(profile), { source: 'hardcover', userId: '999' });
    assert.equal(profileKey(profile), 'hardcover-999');
  });

  test('normalizeProfile never invents 34748/Margaret or an empty label', () => {
    const profile = normalizeProfile({ sources: [{ source: 'livelib', username: 'Vasya' }] });
    assert.equal(profile.label, '@Vasya');
    assert.deepEqual(profile.sources, [{ source: 'livelib', username: 'Vasya' }]);

    const empty = normalizeProfile();
    assert.equal(empty.label, 'Книжный профиль');
    assert.deepEqual(empty.sources, []);
    assert.match(empty.id, /^bk:/);
  });

  test('profileKey builds exactly ONE token for ?profile=', () => {
    const livelib = normalizeProfile({
      label: 'Жена',
      sources: [{ source: 'livelib', username: 'Margaret' }],
    });
    assert.equal(profileKey(livelib), 'livelib-Margaret');
    assert.deepEqual(profileKeys(livelib), ['livelib-Margaret']);
    assert.equal(profileQuery(livelib), 'livelib-Margaret'); // deprecated alias
    assert.equal(profileSummary(livelib), 'LiveLib @Margaret');

    const hardcover = normalizeProfile({
      label: 'Я',
      sources: [{ source: 'hardcover', userId: '34748' }],
    });
    assert.equal(profileKey(hardcover), 'hardcover-34748');
    assert.equal(profileSummary(hardcover), 'Hardcover 34748');

    assert.equal(profileKey({ sources: [] }), '');
    assert.equal(profileQuery({ sources: [] }), '');
    assert.equal(profileSummary({ sources: [] }), '');
  });

  test('withSource resets the profile to that one source (never unions)', () => {
    const base = normalizeProfile({
      label: 'Дом',
      sources: [
        { source: 'livelib', username: 'Margaret' },
        { source: 'hardcover', userId: '34748' },
      ],
    });
    const next = withSource(base, 'hardcover', '555');
    assert.equal(sourceAccount(next, 'hardcover'), '555');
    assert.equal(sourceAccount(next, 'livelib'), '');
    assert.deepEqual(profileSources(next), [{ source: 'hardcover', userId: '555' }]);
    assert.equal(sourceAccount(base, 'hardcover'), '34748', 'input record is not mutated');

    const rejected = withSource(base, 'livelib', '');
    assert.equal(sourceAccount(rejected, 'livelib'), 'Margaret');
  });

  test('splitMultiSourceProfile splits a K6 union into two labelled profiles', () => {
    const legacy = normalizeProfile({
      id: 'bk:legacy',
      label: 'Профиль чтения',
      sources: [
        { source: 'livelib', username: 'Margaret' },
        { source: 'hardcover', userId: '34748' },
      ],
      savedAt: 123,
    });
    const split = splitMultiSourceProfile(legacy);
    assert.equal(split.unchanged, false);
    assert.equal(split.records.length, 2);
    assert.equal(split.primaryId, 'bk:legacy');

    const primary = split.records.find((record) => record.id === 'bk:legacy');
    assert.deepEqual(profileSources(primary), [{ source: 'hardcover', userId: '34748' }]);
    assert.equal(primary.label, 'Профиль чтения'); // custom label survives
    assert.equal(primary.savedAt, 123);

    const second = split.records.find((record) => record.id !== 'bk:legacy');
    assert.match(second.id, /^bk:/);
    assert.deepEqual(profileSources(second), [{ source: 'livelib', username: 'Margaret' }]);
    assert.equal(second.label, 'LiveLib Margaret');

    // An auto-generated union label is replaced by account labels on both sides.
    const auto = normalizeProfile({
      id: 'bk:auto',
      label: '@Margaret + 34748',
      sources: [
        { source: 'livelib', username: 'Margaret' },
        { source: 'hardcover', userId: '34748' },
      ],
    });
    const autoSplit = splitMultiSourceProfile(auto);
    assert.deepEqual(
      autoSplit.records.map((record) => record.label).sort(),
      ['Hardcover 34748', 'LiveLib Margaret']
    );

    // A single-source record is returned untouched.
    const single = splitMultiSourceProfile(
      normalizeProfile({ id: 'bk:one', sources: [{ source: 'livelib', username: 'X' }] })
    );
    assert.equal(single.unchanged, true);
    assert.equal(single.records[0].id, 'bk:one');
  });

  test('account validators reject the values the old UI silently accepted', () => {
    assert.equal(isValidLivelibUsername('Margaret'), true);
    assert.equal(isValidLivelibUsername('margaret.1984_x'), true);
    assert.equal(isValidLivelibUsername('two words'), false);
    assert.equal(isValidLivelibUsername(''), false);
    assert.equal(isValidHardcoverUser('34748'), true);
    assert.equal(isValidHardcoverUser('me'), false);
    assert.equal(isValidHardcoverUser('12a'), false);
    assert.equal(normalizeSource('livelib', 'https://www.livelib.ru/reader/Margaret'), null,
      'the URL form is the server\'s job; the profile stores the username');
  });

  test('legacy accounts migration creates one profile per remembered account', () => {
    assert.deepEqual(migrateLegacyAccounts(null), []);
    assert.deepEqual(migrateLegacyAccounts({}), []);
    assert.deepEqual(migrateLegacyAccounts({ livelib: '  ', hardcover: '' }), []);
    assert.deepEqual(migrateLegacyAccounts({ hardcover: 'abc' }), []);

    const both = migrateLegacyAccounts({ livelib: 'Margaret', hardcover: '34748' });
    assert.equal(both.length, 2);
    assert.deepEqual(both.map(profileKey).sort(), ['hardcover-34748', 'livelib-Margaret']);
    assert.deepEqual(both.map((record) => record.label).sort(), [
      'Hardcover 34748',
      'LiveLib @Margaret',
    ]);

    const onlyLivelib = migrateLegacyAccounts({ livelib: 'Margaret' });
    assert.equal(onlyLivelib.length, 1);
    assert.equal(profileKey(onlyLivelib[0]), 'livelib-Margaret');
    assert.ok(!profileKey(onlyLivelib[0]).includes('34748'),
      'no hardcoded hardcover owner is invented');
  });

  test('adoptServerProfiles returns one local profile per server profile', () => {
    const adopted = adoptServerProfiles([
      { source: 'livelib', userKey: 'Margaret', eventCount: 1245 },
      { source: 'hardcover', userKey: '34748', eventCount: 681 },
      { source: 'livelib', userKey: 'other' }, // same source, latest wins
      { source: 'storygraph', userKey: 'sg' },
    ]);
    assert.equal(adopted.length, 2);
    assert.deepEqual(adopted.map(profileKey).sort(), ['hardcover-34748', 'livelib-other']);
    assert.deepEqual(adoptServerProfiles([]), []);
    assert.deepEqual(adoptServerProfiles([{ source: 'livelib', userKey: 'bad name' }]), []);
  });

  test('adoptServerProfiles prefers the latest import per source', () => {
    const adopted = adoptServerProfiles([
      { source: 'livelib', userKey: 'Margaret', importedAt: '2026-10-20T10:00:00.000Z' },
      { source: 'livelib', userKey: 'readingwitch', importedAt: '2026-10-27T09:00:00.000Z' },
      { source: 'hardcover', userKey: '34748', importedAt: '2026-10-25T10:00:00.000Z' },
    ]);
    assert.deepEqual(adopted.map(profileKey).sort(), ['hardcover-34748', 'livelib-readingwitch']);
  });

  test('scopeSourceNames reads the server profile scope, tolerates legacy payloads', () => {
    assert.deepEqual(
      scopeSourceNames({ selected: ['livelib-Margaret', 'hardcover-34748'] }),
      ['livelib', 'hardcover'],
    );
    // an Hardcover-only profile must not inherit LiveLib from the cache
    assert.deepEqual(scopeSourceNames({ selected: ['hardcover-34748'] }), ['hardcover']);
    // a dashed username stays one token (source is the first segment only)
    assert.deepEqual(scopeSourceNames({ selected: ['livelib-my-reader'] }), ['livelib']);
    assert.deepEqual(scopeSourceNames({ selected: ['livelib-A', 'livelib-B'] }), ['livelib']);
    assert.deepEqual(scopeSourceNames({ selected: ['storygraph-x'] }), []);
    assert.deepEqual(scopeSourceNames(null), []);
    assert.deepEqual(scopeSourceNames({}), []);
  });

  test('sanitizeCookieHeader strips the prefix, folds line breaks, rejects junk', () => {
    assert.equal(
      sanitizeCookieHeader('Cookie: __ddg1=abc; __ddg2=def'),
      '__ddg1=abc; __ddg2=def',
    );
    assert.equal(
      sanitizeCookieHeader('  __ddg1=abc;\n__ddg2=def;  '),
      '__ddg1=abc; __ddg2=def',
    );
    assert.equal(sanitizeCookieHeader('__ddg1=abc'), '__ddg1=abc');
    assert.equal(sanitizeCookieHeader(''), '');
    assert.equal(sanitizeCookieHeader('no equals sign'), '');
    assert.equal(sanitizeCookieHeader('{"cookie":"x=1"}'), '');
    assert.equal(sanitizeCookieHeader(`a=${'x'.repeat(9000)}`), '');
    assert.equal(looksLikeCookieHeader('__ddg1=abc'), true);
    assert.equal(looksLikeCookieHeader('__ddg1'), false);
  });

  test('isLivelibBlocked recognises the 403 contract without false positives', () => {
    assert.equal(isLivelibBlocked({ status: 429, code: 'livelib_blocked' }), true);
    assert.equal(isLivelibBlocked({ status: 502, code: 'livelib_http_error', message: 'LiveLib: 403 Forbidden' }), true);
    assert.equal(isLivelibBlocked('LiveLib заблокировал запросы (403)'), true);
    assert.equal(isLivelibBlocked({ status: 429, code: 'rate_limited' }), false);
    assert.equal(isLivelibBlocked({ status: 500, message: 'внутренняя ошибка' }), false);
    assert.equal(isLivelibBlocked(null), false);
    assert.equal(isLivelibBlocked(''), false);
  });

  test('registry limits are explicit', () => {
    assert.equal(MAX_PROFILES, 8);
  });
  after(() => env.resetMutableState());
});


describe('books-reading-now', () => {
  /**
   * «Читаю сейчас» in the «Недавно читал» strip.
   *
   * The strip used to be finished-only. This round adds the current-read shelf
   * from both sources, while keeping the reading statistics honest:
   *   - `recentlyReading` carries the current books (no invented finish date);
   *   - `summary.readingNowCount` counts them separately;
   *   - bookCount / eventCount / finishedCount / years / authors stay untouched;
   *   - a LiveLib reading shelf is parsed from the file name, the form or a
   *     per-row shelf/status token, and a re-upload stays idempotent;
   *   - Hardcover `status_id = 2` is a stored plan event, not a finished read.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { readPublicCss } = require('./helpers/css');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const hardcover = require('../server/books/hardcover');
  const livelibFile = require('../server/books/livelib-file');
  const { buildBooksStats } = require('../server/books/stats');

  const PUBLIC_DIR = path.join(__dirname, '..', 'public');

  function readPublic(name) {
    return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
  }

  function hcRead(id, bookId, title, finishedAt) {
    return {
      id: `hc:read:${id}`,
      source: 'hardcover',
      sourceBookId: String(bookId),
      workId: `hc:${bookId}`,
      title,
      authors: ['Jim Butcher'],
      status: 'read',
      statusId: 3,
      finishedAt,
      edition: {},
    };
  }

  function hcReadingRow() {
    return {
      id: 555,
      book_id: 777,
      edition_id: null,
      rating: null,
      status_id: 2,
      read_count: 0,
      first_read_date: null,
      last_read_date: null,
      date_added: '2026-09-01',
      book: {
        id: 777,
        title: 'Текущая книга',
        slug: 'tekushchaya-kniga',
        release_year: 2020,
        cached_image: { url: 'https://assets.hardcover.app/books/current.jpg' },
        contributions: [{ author: { id: 3, name: 'Иван Петров' }, contribution: 'Author' }],
      },
      edition: {},
      user_book_reads: [{ id: 31, started_at: '2026-10-25', finished_at: null }],
    };
  }

  test.before(async () => {
    const [reading] = hardcover.eventsFromRow(hcReadingRow());
    await bookCache.saveProfile('hardcover', 'reader-now', {
      schemaVersion: 1,
      source: 'hardcover',
      userKey: 'reader-now',
      importedAt: '2026-10-29T00:00:00.000Z',
      events: [
        hcRead(1, 11, 'Первая книга', '2024-01-10'),
        hcRead(2, 12, 'Вторая книга', '2024-02-20'),
        reading,
      ],
    });

    // A livelib-backup export of the «Читаю сейчас» page: the shelf comes from
    // the file name / form, the start date from an optional column.
    const parsed = livelibFile.parseExportFile(
      JSON.stringify([
        {
          title: 'Только прочитанная',
          authors: [{ name: 'Пётр Петров' }],
          readDate: 'Сентябрь 2026 г.',
          bookHref: 'https://www.livelib.ru/book/9001-read',
        },
        {
          title: 'Читается сейчас',
          authors: [{ name: 'Анна Иванова' }],
          startedAt: '2026-10-20',
          coverHref: 'https://s1.livelib.ru/boocover/9002/current.jpg',
          bookHref: 'https://www.livelib.ru/book/9002-reading',
        },
        {
          title: 'Открыта позже',
          authors: [{ name: 'Олег Сидоров' }],
          startedAt: '2026-10-22',
          bookHref: 'https://www.livelib.ru/book/9003-reading',
        },
      ]),
      { filename: 'livelib-margaret-reading-28.10.2026.json' }
    );
    const readBooks = parsed.books.filter((book) => book.bookId === '9001');
    const readingBooks = parsed.books.filter((book) => book.bookId !== '9001');
    let profile = livelibFile.mergeFileIntoProfile(null, {
      userKey: 'file-reader',
      books: readBooks,
      shelf: 'read',
      format: 'json',
    }).profile;
    profile = livelibFile.mergeFileIntoProfile(profile, {
      userKey: 'file-reader',
      books: readingBooks,
      shelf: parsed.shelf,
      format: 'json',
    }).profile;
    await bookCache.saveProfile('livelib', 'file-reader', profile);

    // A profile with nothing finished: the strip must still appear.
    const onlyReading = livelibFile.parseExportFile(
      JSON.stringify([
        {
          title: 'Единственная текущая',
          authors: [{ name: 'Мария Орлова' }],
          startedAt: '2026-10-27',
        },
      ]),
      { filename: 'livelib-margaret-reading-28.10.2026.json' }
    );
    const onlyProfile = livelibFile.mergeFileIntoProfile(null, {
      userKey: 'only-reading',
      books: onlyReading.books,
      shelf: onlyReading.shelf,
      format: 'json',
    }).profile;
    await bookCache.saveProfile('livelib', 'only-reading', onlyProfile);
  });

  test('livelib-backup reading shelf is parsed from the file name and a row token', () => {
    const byName = livelibFile.parseExportFile(
      JSON.stringify([{ title: 'Книга', startedAt: '2026-10-20' }]),
      { filename: 'livelib-margaret-reading-28.10.2026.json' }
    );
    assert.equal(byName.shelf, 'reading');
    assert.equal(byName.books[0].startedAt, '2026-10-20');
    assert.equal(byName.books[0].startMonth, null);

    // A hand-edited JSON row may carry the shelf/status token itself.
    const byRow = livelibFile.parseExportFile(
      JSON.stringify([{ title: 'Книга', status: 'Читаю сейчас' }]),
      { filename: 'export.json' }
    );
    assert.equal(byRow.shelf, 'reading');
    assert.equal(byRow.books[0].shelfHint, 'reading');

    const merged = livelibFile.mergeFileIntoProfile(null, {
      userKey: 'x',
      books: byName.books,
      shelf: byName.shelf,
      format: 'json',
    });
    const [event] = merged.profile.events;
    assert.equal(event.shelf, 'reading');
    assert.equal(event.status, 'reading');
    assert.equal(event.startedAt, '2026-10-20');
    assert.equal(event.finishedAt, null);
    assert.equal(merged.profile.shelves.reading, 1);

    // A repeated upload is a no-op, exactly like the read shelf.
    const again = livelibFile.mergeFileIntoProfile(merged.profile, {
      userKey: 'x',
      books: byName.books,
      shelf: byName.shelf,
      format: 'json',
    });
    assert.equal(again.added, 0);
    assert.equal(again.skipped, 1);
    assert.equal(again.profile.events.length, 1);
  });

  test('hardcover status_id=2 is a stored plan event with a start date', () => {
    const [event] = hardcover.eventsFromRow(hcReadingRow());
    assert.equal(event.status, 'reading');
    assert.equal(event.statusId, 2);
    assert.equal(event.finishedAt, null);
    assert.equal(event.startedAt, '2026-10-25');
    assert.equal(event.title, 'Текущая книга');
    assert.equal(event.coverUrl, 'https://assets.hardcover.app/books/current.jpg');
    assert.equal(hardcover.storeStatus(2), true);
    assert.equal(hardcover.keepStatus(2), false);
  });

  test('reading books lead the strip without inflating finished statistics', () => {
    const stats = buildBooksStats({ profile: 'hardcover-reader-now' });
    assert.equal(stats.summary.readingNowCount, 1);
    assert.equal(stats.summary.bookCount, 2);
    assert.equal(stats.summary.eventCount, 2);
    assert.equal(stats.summary.finishedCount, 2);
    assert.equal(stats.summary.dateTo, '2024-02-20');
    assert.equal(stats.booksIndex['hc:777'], undefined);

    assert.equal(stats.recentlyReading.length, 1);
    const [current] = stats.recentlyReading;
    assert.equal(current.workId, 'hc:777');
    assert.equal(current.title, 'Текущая книга');
    assert.deepEqual(current.authors, ['Иван Петров']);
    assert.equal(current.date, '2026-10-25');
    assert.equal(current.precision, 'day');
    assert.equal(current.status, 'reading');
    assert.equal(current.coverUrl, 'https://assets.hardcover.app/books/current.jpg');

    // The finished strip is unchanged: reading never enters it.
    assert.deepEqual(
      stats.recentlyFinished.map((item) => item.date),
      ['2024-02-20', '2024-01-10']
    );
  });

  test('livelib reading shelf: strip order, counters and honest bookCount', () => {
    const stats = buildBooksStats({ profile: 'livelib-file-reader' });
    assert.equal(stats.summary.bookCount, 1);
    assert.equal(stats.summary.eventCount, 1);
    assert.equal(stats.summary.readingNowCount, 2);
    assert.equal(stats.summary.shelfExcluded, 2);
    assert.deepEqual(stats.summary.shelves, { read: 1, dnf: 0, reading: 2, wish: 0 });
    assert.equal(stats.booksIndex['ll:9002'], undefined);

    // Newest start first; the finished list still has the read shelf only.
    assert.deepEqual(
      stats.recentlyReading.map((item) => [item.title, item.date]),
      [
        ['Открыта позже', '2026-10-22'],
        ['Читается сейчас', '2026-10-20'],
      ]
    );
    assert.equal(stats.recentlyReading[0].precision, 'day');
    assert.deepEqual(stats.recentlyReading[1].authors, ['Анна Иванова']);
    assert.equal(stats.recentlyFinished.length, 1);

    const only = buildBooksStats({ profile: 'livelib-only-reading' });
    assert.equal(only.summary.bookCount, 0);
    assert.equal(only.summary.readingNowCount, 1);
    assert.equal(only.recentlyFinished.length, 0);
    assert.equal(only.recentlyReading.length, 1);
  });

  test('public strip renders reading first with a badge and a date-less card', () => {
    const books = readPublic('js/books.js');
    assert.match(books, /recentlyReading/);
    assert.match(books, /const reading = data\.recentlyReading\.slice\(0, 15\)/);
    assert.match(books, /\[\.\.\.reading, \.\.\.data\.recentlyFinished\]\.slice\(0, 15\)/);
    assert.match(books, /recent-reading/);
    assert.match(books, /читает сейчас/);
    // The counter reaches the headline as a separate sentence.
    assert.match(books, /readingNowCount/);

    const css = readPublicCss();
    assert.match(css, /\.recent-book-tags \.recent-reading/);

    const html = readPublic('index.html');
    assert.match(html, /«Читаю сейчас» можно загрузить отдельным файлом/);
  });
  after(() => env.resetMutableState());
});


describe('books-providers', () => {
  /**
   * Metadata providers: normalisation fixtures, manga detection, merge and
   * budget rules. No network: every provider gets an injected fetch + sleep.
   */

  process.env.GB_API_KEY = 'AIzaSy_TEST_FIXTURE_KEY';

  const test = require('node:test');
  const assert = require('node:assert/strict');

  const googlebooks = require('../server/books/providers/googlebooks');
  const openlibrary = require('../server/books/providers/openlibrary');
  const livelibCard = require('../server/books/providers/livelib-card');
  const litres = require('../server/books/providers/litres');
  const { detectManga } = require('../server/books/providers/manga');
  const providers = require('../server/books/providers');

  const noSleep = async () => {};

  function response({ status = 200, body = {}, headers = {} }) {
    return {
      status,
      headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
      async json() {
        return typeof body === 'string' ? JSON.parse(body) : body;
      },
      async text() {
        return typeof body === 'string' ? body : JSON.stringify(body);
      },
    };
  }

  const GB_VOLUME = {
    id: 'vol-dune-ru',
    volumeInfo: {
      title: 'Дюна',
      authors: ['Фрэнк Герберт'],
      publisher: 'АСТ',
      publishedDate: '2016-05-01',
      categories: ['Fiction / Science Fiction / Space Opera'],
      pageCount: 704,
      industryIdentifiers: [
        { type: 'ISBN_13', identifier: '9785170987654' },
        { type: 'ISBN_10', identifier: '5170987650' },
      ],
      imageLinks: { thumbnail: 'http://books.google.com/books/content?id=1&edge=curl' },
      infoLink: 'https://books.google.com/books?id=vol-dune-ru',
      language: 'ru',
    },
  };

  function gbFetch(handler) {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return handler(String(url));
    };
    fetchImpl.calls = calls;
    return fetchImpl;
  }

  function cardHtml(overrides = {}) {
    const isbn = overrides.isbn === undefined ? '978-5-699-98967-6' : overrides.isbn;
    const genres = overrides.genres || ['Зарубежная фантастика', 'Научная фантастика'];
    const series = overrides.series === undefined ? 'Кинопремьера мирового масштаба' : overrides.series;
    const publisher = overrides.publisher === undefined ? 'Эксмо' : overrides.publisher;
    const year = overrides.year === undefined ? '2018' : overrides.year;
    const pages = overrides.pages === undefined ? '256' : overrides.pages;
    const rows = [
      publisher ? `<div class="DetailedInfo_DetailedInfoRow__x"><p>Издательство: </p><p>${publisher}</p></div>` : '',
      series ? `<div class="DetailedInfo_DetailedInfoRow__x"><p>Серия: </p><p>${series}</p></div>` : '',
      isbn ? `<div class="DetailedInfo_DetailedInfoRow__x"><p>ISBN: </p><p>${isbn}</p></div>` : '',
      year ? `<div class="DetailedInfo_DetailedInfoRow__x"><p>Год издания: </p><p>${year}</p></div>` : '',
      '<div class="DetailedInfo_DetailedInfoRow__x"><p>Язык: </p><p>Русский</p></div>',
      pages ? `<div class="DetailedInfo_DetailedInfoRow__x"><p>Страниц: ${pages}</p></div>` : '',
    ].join('');
    return `<!doctype html><html><head>
      <link rel="canonical" href="https://www.livelib.ru/book/1002745594-annigilyatsiya"/>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Book',
        name: overrides.title || 'Аннигиляция',
        author: { name: overrides.author || 'Джефф Вандермеер' },
        image: { url: 'https://s1.livelib.ru/boocover/1002745594/200x305/a33c/book.jpg' },
        inLanguage: 'ru',
        datePublished: year || undefined,
      })}</script>
    </head><body>
      <h1>${overrides.title || 'Аннигиляция'}</h1>
      <div class="DetailedInfo_DetailedInfoContent__y">${rows}</div>
      <section class="ShortInfo_ShortInfoGenres__x"><p>Жанры</p><div>
        ${genres.map((genre) => `<a href="https://www.livelib.ru/genre/${genre}"><span>${genre}</span></a>`).join('')}
      </div></section>
    </body></html>`;
  }

  test.beforeEach(() => {
    googlebooks.resetBreaker();
    livelibCard.resetBreaker();
    litres.resetBreaker();
  });

  test('googlebooks normalizes an ISBN hit', async () => {
    const fetchImpl = gbFetch(() => response({ body: { totalItems: 1, items: [GB_VOLUME] } }));
    const result = await googlebooks.getWork(
      { isbn13: '9785170987654', title: 'Дюна', authors: ['Фрэнк Герберт'] },
      { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
    );
    assert.ok(result);
    assert.equal(result.source, 'googlebooks');
    assert.equal(result.sourceId, 'vol-dune-ru');
    assert.equal(result.title, 'Дюна');
    assert.deepEqual(result.authors, ['Фрэнк Герберт']);
    assert.equal(result.year, 2016);
    assert.equal(result.publisher, 'АСТ');
    assert.equal(result.pages, 704);
    assert.equal(result.isbn13, '9785170987654');
    assert.equal(result.isbn10, '5170987650');
    assert.equal(result.cover.startsWith('https://'), true);
    assert.equal(result.cover.includes('edge=curl'), false);
    assert.equal(result.links.pageUrl, 'https://books.google.com/books?id=vol-dune-ru');
    assert.deepEqual(result.genres, ['Fiction', 'Science Fiction', 'Space Opera']);
    assert.equal(result.confidence, 0.96);
    assert.equal(result.mangaComics, false);
  });

  test('googlebooks title fallback keeps the author guard', async () => {
    const fetchImpl = gbFetch((url) => {
      if (/q=isbn%3A/.test(url)) return response({ body: { totalItems: 0 } });
      return response({
        body: {
          items: [
            {
              id: 'wrong',
              volumeInfo: { title: 'Дюна', authors: ['Другой Автор'], pageCount: 100 },
            },
            { ...GB_VOLUME, id: 'right' },
          ],
        },
      });
    });
    const result = await googlebooks.getWork(
      { isbn13: '9785170987654', title: 'Дюна', authors: ['Фрэнк Герберт'] },
      { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
    );
    assert.ok(result);
    assert.equal(result.sourceId, 'right');
    assert.ok(result.confidence < 0.96);
  });

  test('googlebooks title fallback rejects everything when the author differs', async () => {
    const fetchImpl = gbFetch((url) => {
      if (/q=isbn%3A/.test(url)) return response({ body: { totalItems: 0 } });
      return response({
        body: { items: [{ id: 'wrong', volumeInfo: { title: 'Дюна', authors: ['Другой Автор'] } }] },
      });
    });
    const result = await googlebooks.getWork(
      { title: 'Дюна', authors: ['Фрэнк Герберт'] },
      { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
    );
    assert.equal(result, null);
  });

  test('googlebooks 429 trips the breaker and stops further calls', async () => {
    const fetchImpl = gbFetch(() => response({ status: 429, body: { error: { code: 429 } } }));
    await assert.rejects(
      () =>
        googlebooks.getWork(
          { isbn13: '9785170987654' },
          { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
        ),
      /HTTP 429/
    );
    assert.equal(googlebooks.isBreakerOpen(), true);
    const callsAfterError = fetchImpl.calls.length;
    const second = await googlebooks.getWork(
      { isbn13: '9785170987655' },
      { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
    );
    assert.equal(second, null);
    assert.equal(fetchImpl.calls.length, callsAfterError);
  });

  test('openlibrary parses an ISBN edition and a search hit', async () => {
    const edition = {
      'ISBN:9780441013593': {
        url: 'https://openlibrary.org/books/OL62694654M/Dune',
        key: '/books/OL62694654M',
        title: 'Dune',
        authors: [{ name: 'Frank Herbert' }],
        number_of_pages: 896,
        publishers: [{ name: 'Ace' }],
        publish_date: '2005',
        subjects: [{ name: 'Science Fiction' }, { name: 'Accessible book' }],
        identifiers: { isbn_13: ['9780441013593'], isbn_10: ['0441013597'] },
        cover: { large: 'http://covers.openlibrary.org/b/id/1-L.jpg' },
      },
    };
    const fetchImpl = gbFetch((url) => {
      if (url.includes('/api/books')) return response({ body: edition });
      return response({
        body: {
          docs: [
            {
              key: '/works/OL1W',
              title: 'Dune',
              author_name: ['Frank Herbert'],
              first_publish_year: 1965,
              publisher: ['Chilton'],
              cover_i: 42,
              subject: ['Science Fiction', 'Protected DAISY'],
              isbn: ['9780441013593'],
              number_of_pages_median: 412,
            },
          ],
        },
      });
    });
    const byIsbn = await openlibrary.getWork(
      { isbn13: '9780441013593' },
      { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
    );
    assert.ok(byIsbn);
    assert.equal(byIsbn.source, 'openlibrary');
    assert.equal(byIsbn.sourceId, 'OL62694654M');
    assert.equal(byIsbn.year, 2005);
    assert.equal(byIsbn.pages, 896);
    assert.deepEqual(byIsbn.genres, ['Science Fiction']);
    assert.equal(byIsbn.cover.startsWith('https://'), true);
    assert.equal(byIsbn.confidence, 0.94);

    const byTitle = await openlibrary.getWork(
      { title: 'Dune', authors: ['Frank Herbert'] },
      { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
    );
    assert.ok(byTitle);
    assert.equal(byTitle.sourceId, 'OL1W');
    assert.equal(byTitle.year, 1965);
    assert.equal(byTitle.pages, 412);
    assert.ok(byTitle.confidence < byIsbn.confidence);
  });

  test('livelib card parses RU edition metadata and respects the per-run budget', async () => {
    const fetchImpl = gbFetch(() => response({ body: cardHtml() }));
    const budget = livelibCard.createBudget(1);
    const first = await livelibCard.getWork(
      { llBookId: '1002745594', title: 'Аннигиляция', authors: ['Джефф Вандермеер'] },
      { fetchImpl, sleep: noSleep, cardPauseMs: 0, budget }
    );
    assert.ok(first);
    assert.equal(first.source, 'livelib-card');
    assert.equal(first.isbn13, '9785699989676');
    assert.equal(first.publisher, 'Эксмо');
    assert.equal(first.year, 2018);
    assert.equal(first.pages, 256);
    assert.deepEqual(first.series, { name: 'Кинопремьера мирового масштаба', position: null });
    assert.deepEqual(first.genres, ['Зарубежная фантастика', 'Научная фантастика']);
    assert.equal(first.mangaComics, false);
    assert.equal(first.links.pageUrl, 'https://www.livelib.ru/book/1002745594-annigilyatsiya');
    assert.equal(budget.used, 1);

    const callsBefore = fetchImpl.calls.length;
    const second = await livelibCard.getWork(
      { llBookId: '2' },
      { fetchImpl, sleep: noSleep, cardPauseMs: 0, budget }
    );
    assert.equal(second, null);
    assert.equal(budget.used, 1);
    assert.equal(fetchImpl.calls.length, callsBefore);
  });

  test('livelib card marks manga genres', async () => {
    const fetchImpl = gbFetch(() =>
      response({ body: cardHtml({ genres: ['Манга', 'Фэнтези'], title: 'Наруто' }) })
    );
    const result = await livelibCard.getWork(
      { llBookId: '777' },
      { fetchImpl, sleep: noSleep, cardPauseMs: 0 }
    );
    assert.equal(result.mangaComics, true);
  });

  test('livelib card 403 trips a run breaker instead of retrying every book', async () => {
    const fetchImpl = gbFetch(() => response({ status: 403, body: '<html>DDoS-Guard</html>' }));
    const budget = livelibCard.createBudget(10);
    await assert.rejects(
      () =>
        livelibCard.getWork(
          { llBookId: '1' },
          { fetchImpl, sleep: noSleep, cardPauseMs: 0, budget }
        ),
      /ограничил доступ/
    );
    assert.equal(livelibCard.isBreakerOpen(), true);
    const callsAfterBlock = fetchImpl.calls.length;
    const second = await livelibCard.getWork(
      { llBookId: '2' },
      { fetchImpl, sleep: noSleep, cardPauseMs: 0, budget }
    );
    assert.equal(second, null);
    assert.equal(fetchImpl.calls.length, callsAfterBlock);
    assert.equal(budget.used, 1);
  });

  test('manga detection is tri-state', () => {
    assert.equal(detectManga({ genres: ['Manga'] }), true);
    assert.equal(detectManga({ genres: ['Комиксы'] }), true);
    assert.equal(detectManga({ series: ['Graphic Novel Series'] }), true);
    assert.equal(detectManga({ genres: ['Fantasy'], publisher: 'Манга-пресс' }), true);
    assert.equal(detectManga({ genres: ['Fantasy'] }), false);
    assert.equal(detectManga({}), null);
    assert.equal(detectManga({ publisher: 'Эксмо' }), null);
  });

  test('merge fills missing fields from extras and tracks metadataSources', () => {
    const primary = {
      source: 'hardcover',
      sourceId: '100',
      workId: 'hc:100',
      title: 'Дюна',
      authors: ['Фрэнк Герберт'],
      year: 1965,
      publisher: null,
      series: null,
      genres: ['Science Fiction'],
      pages: null,
      isbn13: null,
      isbn10: null,
      cover: null,
      links: { pageUrl: 'https://hardcover.app/books/dune' },
      confidence: 0.99,
      mangaComics: false,
    };
    const extra = {
      source: 'livelib-card',
      sourceId: '9001',
      title: 'Дюна',
      authors: ['Фрэнк Герберт'],
      year: 2016,
      publisher: 'АСТ',
      series: { name: 'Дюны', position: 1 },
      genres: ['Научная фантастика'],
      pages: 704,
      isbn13: '9785170987654',
      isbn10: '5170987650',
      cover: 'https://example.test/cover.jpg',
      links: { pageUrl: 'https://www.livelib.ru/book/9001' },
      confidence: 1,
      mangaComics: false,
    };
    const merged = providers.mergeResults(primary, [extra]);
    assert.equal(merged.title, 'Дюна');
    assert.equal(merged.publisher, 'АСТ');
    assert.equal(merged.pages, 704);
    assert.equal(merged.year, 1965);
    assert.equal(merged.series.name, 'Дюны');
    assert.deepEqual(merged.genres, ['Science Fiction']);
    assert.deepEqual(merged.metadataSources, ['hardcover', 'livelib-card']);
    assert.equal(merged.metadataSources.length, 2);

    const manga = providers.mergeResults(primary, [
      { ...extra, genres: ['Manga'], mangaComics: true },
    ]);
    assert.equal(manga.mangaComics, true);
  });

  test('details document keeps schema 2 fields and metadataSources', () => {
    const merged = providers.mergeResults(
      {
        source: 'googlebooks',
        sourceId: 'vol-1',
        workId: 'gb:vol-1',
        title: 'Дюна',
        authors: ['Фрэнк Герберт'],
        year: 2016,
        publisher: 'АСТ',
        series: null,
        genres: ['Science Fiction'],
        pages: 704,
        isbn13: '9785170987654',
        isbn10: '5170987650',
        cover: 'https://example.test/cover.jpg',
        links: { pageUrl: 'https://books.google.com/books?id=vol-1' },
        confidence: 0.96,
        mangaComics: false,
      },
      []
    );
    const doc = providers.resultToDetails(merged, { now: '2026-10-27T00:00:00.000Z' });
    assert.equal(doc.schemaVersion, 2);
    assert.equal(doc.workId, 'gb:vol-1');
    assert.deepEqual(doc.authors, [{ name: 'Фрэнк Герберт' }]);
    assert.deepEqual(doc.metadataSources, ['googlebooks']);
    assert.equal(doc.sources[0].source, 'googlebooks');
    assert.equal(doc.sources[0].url, 'https://books.google.com/books?id=vol-1');
    assert.equal(doc.publicationYear, 2016);
    assert.equal(doc.mangaComics, false);
    assert.equal(doc.fetchedAt, '2026-10-27T00:00:00.000Z');
  });

  test('negative memo prevents duplicate provider requests inside one run', async () => {
    const fetchImpl = gbFetch(() => response({ body: { totalItems: 0 } }));
    const memo = new Map();
    const first = await googlebooks.getWork(
      { isbn13: '9780000000001' },
      { fetchImpl, sleep: noSleep, requestDelayMs: 0, negativeMemo: memo }
    );
    assert.equal(first, null);
    assert.equal(fetchImpl.calls.length, 1);
    const second = await googlebooks.getWork(
      { isbn13: '9780000000001' },
      { fetchImpl, sleep: noSleep, requestDelayMs: 0, negativeMemo: memo }
    );
    assert.equal(second, null);
    assert.equal(fetchImpl.calls.length, 1);
  });

  const LITRES_ITEM = {
    id: 8981462,
    title: 'Аннигиляция',
    url: '/book/dzheff-vandermeer/annigilyaciya-8981462/',
    cover_url: '/pub/c/cover/8981462.jpg',
    language_code: 'ru',
    date_written_at: '2014-01-01',
    symbols_count: 266345,
    persons: [
      { full_name: 'Джефф Вандермеер', role: 'author' },
      { full_name: 'Михаил Молчанов', role: 'translator' },
    ],
    rating: { rated_avg: 4.35 },
    series: [{ name: 'Зона Икс', art_order: 1 }],
  };

  function litresDetail(overrides = {}) {
    return {
      id: 8981462,
      title: 'Аннигиляция',
      isbn: overrides.isbn === undefined ? '978-5-699-78049-5' : overrides.isbn,
      publisher: overrides.publisher === undefined ? null : overrides.publisher,
      publication_date: '2014-01-01',
      genres: overrides.genres || [
        { name: 'научная фантастика' },
        { name: 'зарубежная фантастика' },
      ],
      tags: overrides.tags || [{ name: 'хоррор' }],
      series: overrides.series || [{ name: 'Зона Икс', art_order: 1 }],
      paper_book: overrides.paper_book === undefined ? { pages: 256 } : overrides.paper_book,
      cover_url: '/pub/c/cover/8981462.jpg',
      url: '/book/dzheff-vandermeer/annigilyaciya-8981462/',
    };
  }

  function litresFetch({ items = [LITRES_ITEM], detail = litresDetail(), detailStatus = 200 } = {}) {
    return gbFetch((url) => {
      if (url.includes('/foundation/api/search')) {
        return response({ body: { payload: { data: items.map((item) => ({ type: 'text_book', instance: item })) } } });
      }
      if (url.includes('/foundation/api/arts/')) {
        if (detailStatus !== 200) return response({ status: detailStatus, body: {} });
        return response({ body: { payload: { data: detail } } });
      }
      return response({ status: 404, body: {} });
    });
  }

  test('litres normalizes a RU search hit with art detail', async () => {
    const fetchImpl = litresFetch();
    const result = await litres.getWork(
      { title: 'Аннигиляция', authors: ['Джефф Вандермеер'] },
      { fetchImpl, sleep: noSleep, litresPauseMs: 0 }
    );
    assert.ok(result);
    assert.equal(result.source, 'litres');
    assert.equal(result.workId, 'lr:8981462');
    assert.equal(result.title, 'Аннигиляция');
    assert.deepEqual(result.authors, ['Джефф Вандермеер']);
    assert.equal(result.isbn13, '9785699780495');
    assert.equal(result.isbn10, '5699780491');
    assert.equal(result.year, 2014);
    assert.deepEqual(result.genres, ['научная фантастика', 'зарубежная фантастика']);
    assert.deepEqual(result.series, { name: 'Зона Икс', position: 1, source: 'litres' });
    assert.equal(result.pages, 256);
    assert.equal(result.cover, 'https://www.litres.ru/pub/c/cover/8981462.jpg');
    assert.equal(
      result.links.pageUrl,
      'https://www.litres.ru/book/dzheff-vandermeer/annigilyaciya-8981462/'
    );
    assert.equal(result.confidence, 0.95);
    assert.equal(result.mangaComics, false);
    assert.equal(fetchImpl.calls.length, 2);
  });

  test('litres keeps the search card when the art detail fails', async () => {
    const fetchImpl = litresFetch({ detailStatus: 500 });
    const result = await litres.getWork(
      { title: 'Аннигиляция', authors: ['Джефф Вандермеер'] },
      { fetchImpl, sleep: noSleep, litresPauseMs: 0 }
    );
    assert.ok(result);
    assert.equal(result.isbn13, null);
    assert.deepEqual(result.genres, []);
    assert.equal(result.pages, null);
    assert.equal(result.links.pageUrl.includes('/book/dzheff-vandermeer/'), true);
  });

  test('litres search-only cards keep unknown pages/year as null', () => {
    const normalized = litres.normalizeLitres(
      LITRES_ITEM,
      null,
      { title: 'Аннигиляция', authors: ['Джефф Вандермеер'] },
      { exact: true, score: 1, titleSim: 1, authorHit: true }
    );
    assert.equal(normalized.pages, null);
    assert.deepEqual(normalized.genres, []);
    assert.equal(normalized.year, 2014);
    const doc = providers.resultToDetails(normalized, { now: '2026-10-27T00:00:00.000Z' });
    assert.equal(doc.pages, null);
    assert.equal(doc.publicationYear, 2014);
  });

  test('litres strips format suffixes and prefers text editions', () => {
    assert.equal(litres.cleanTitle('Игрок (epub)'), 'Игрок');
    assert.equal(litres.cleanTitle('Игрок (fb2, pdf)'), 'Игрок');
    assert.equal(litres.cleanTitle('Игрок (покетбук)'), 'Игрок (покетбук)');
  });

  test('litres rejects a candidate with a different author', async () => {
    const wrong = {
      ...LITRES_ITEM,
      persons: [{ full_name: 'Другой Автор', role: 'author' }],
    };
    const fetchImpl = litresFetch({ items: [wrong] });
    const result = await litres.getWork(
      { title: 'Аннигиляция', authors: ['Джефф Вандермеер'] },
      { fetchImpl, sleep: noSleep, litresPauseMs: 0 }
    );
    assert.equal(result, null);
    assert.equal(fetchImpl.calls.length, 1);
  });

  test('litres 403 trips the 30 min breaker', async () => {
    const fetchImpl = gbFetch(() => response({ status: 403, body: '<html>blocked</html>' }));
    const budget = litres.createBudget(10);
    await assert.rejects(
      () =>
        litres.getWork(
          { title: 'Аннигиляция', authors: ['Джефф Вандермеер'] },
          { fetchImpl, sleep: noSleep, litresPauseMs: 0, budget }
        ),
      /HTTP 403/
    );
    assert.equal(litres.isBreakerOpen(), true);
    const callsAfter = fetchImpl.calls.length;
    const second = await litres.getWork(
      { title: 'Игрок', authors: ['Фёдор Достоевский'] },
      { fetchImpl, sleep: noSleep, litresPauseMs: 0, budget }
    );
    assert.equal(second, null);
    assert.equal(fetchImpl.calls.length, callsAfter);
    assert.equal(budget.used, 1);
  });

  test('litres budget caps book lookups per run', async () => {
    const fetchImpl = litresFetch();
    const budget = litres.createBudget(1);
    const options = { fetchImpl, sleep: noSleep, litresPauseMs: 0, budget };
    const first = await litres.getWork(
      { title: 'Аннигиляция', authors: ['Джефф Вандермеер'] },
      options
    );
    assert.ok(first);
    const second = await litres.getWork(
      { title: 'Игрок', authors: ['Фёдор Достоевский'] },
      options
    );
    assert.equal(second, null);
    assert.equal(budget.used, 1);
    assert.equal(fetchImpl.calls.length, 2);
  });

  test('litres detects manga via its genre names', async () => {
    const fetchImpl = litresFetch({
      items: [{ ...LITRES_ITEM, title: 'Наруто. Том 1', persons: [{ full_name: 'Масаси Кисимото', role: 'author' }] }],
      detail: litresDetail({ genres: [{ name: 'манга' }, { name: 'фэнтези' }] }),
    });
    const result = await litres.getWork(
      { title: 'Наруто. Том 1', authors: ['Масаси Кисимото'] },
      { fetchImpl, sleep: noSleep, litresPauseMs: 0 }
    );
    assert.ok(result);
    assert.equal(result.mangaComics, true);
  });

  test('litres negative memo avoids duplicate searches in one run', async () => {
    const fetchImpl = litresFetch({ items: [] });
    const memo = new Map();
    const options = { fetchImpl, sleep: noSleep, litresPauseMs: 0, negativeMemo: memo };
    const first = await litres.getWork({ title: 'Неизвестная книга' }, options);
    assert.equal(first, null);
    const second = await litres.getWork({ title: 'Неизвестная книга' }, options);
    assert.equal(second, null);
    assert.equal(fetchImpl.calls.length, 1);
  });
  after(() => env.resetMutableState());
});


describe('books-metadata-coverage', () => {
  /**
   * `summary.metadata` — the honest "metadata is still loading" contract.
   *
   * A LiveLib profile gets genres/series/years from the shared resolve chain,
   * which is budgeted (Litres: 200 books per run) and therefore spreads over
   * several profile refreshes. The payload must say:
   *   - `resolved/total/percent` of the profile's works that already have a
   *     details document (LiveLib card metadata counts too);
   *   - `running` only while the resolve stage is alive, and only for LiveLib
   *     (a Hardcover profile's metadata arrives with the journal);
   *   - `budgetRemaining` only while that job is alive.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const { buildBooksStats } = require('../server/books/stats');
  const { resolveStateFromJobs } = require('../server/books/import');

  function event(bookId, extra = {}) {
    return Object.assign(
      {
        id: `ll:${bookId}`,
        sourceBookId: String(bookId),
        title: `Book ${bookId}`,
        authors: ['Author'],
        rating: 7,
        ratingScale: 10,
        status: 'read',
        finishedAt: '2024-01-02',
      },
      extra
    );
  }

  async function seed() {
    await bookCache.saveDetails(100, {
      schemaVersion: 1,
      hcWorkId: 100,
      title: 'Covered by Hardcover',
      authors: [{ hcId: 1, name: 'Author' }],
      genres: ['Fantasy'],
      partial: false,
    });
    // LiveLib-card metadata lives under the `ll-{bookId}` key and is just as
    // valid: the work is covered, it simply has no canonical Hardcover work.
    await bookCache.saveDetails(bookCache.detailsKeyForWork('ll:300'), {
      schemaVersion: 1,
      title: 'Covered by LiveLib card',
      authors: [{ name: 'Author' }],
      genres: ['Classics'],
      metadataSources: ['livelib-card'],
      partial: false,
    });
    await bookCache.saveLink('101', {
      schemaVersion: 1,
      livelibBookId: '101',
      workId: 'hc:100',
      method: 'isbn',
      score: 1,
      evidence: {},
    });

    await bookCache.saveProfile('livelib', 'Meta', {
      schemaVersion: 1,
      source: 'livelib',
      userKey: 'Meta',
      importedAt: '2026-10-27T00:00:00.000Z',
      events: [
        event(101, { workId: 'hc:100' }),
        event(200),
        event(300),
        event(400),
      ],
      warnings: [],
    });
    await bookCache.saveProfile('hardcover', '777', {
      schemaVersion: 1,
      source: 'hardcover',
      userKey: '777',
      importedAt: '2026-10-27T00:00:00.000Z',
      events: [
        {
          id: 'hc:read:1',
          source: 'hardcover',
          sourceBookId: '100',
          workId: 'hc:100',
          title: 'Covered by Hardcover',
          authors: ['Author'],
          rating: 4,
          ratingScale: 5,
          rating10: 8,
          status: 'read',
          statusId: 3,
          finishedAt: '2024-02-02',
        },
      ],
    });
  }

  test('metadata coverage counts works with a details document', async () => {
    await seed();
    const stats = buildBooksStats({ profile: 'livelib-Meta' });
    assert.deepEqual(stats.summary.metadata, {
      resolved: 2,
      total: 4,
      linked: 1,
      withDetails: 2,
      unlinked: 2,
      resolvable: 4,
      hopeless: 0,
      keyless: 0,
      percent: 50,
      done: false,
      running: false,
      budgetRemaining: null,
    });
  });

  test('running + budgetRemaining are forwarded only for a LiveLib profile', async () => {
    await seed();
    const live = buildBooksStats({
      profile: 'livelib-Meta',
      resolveState: { running: true, budgetRemaining: 42 },
    });
    assert.equal(live.summary.metadata.running, true);
    assert.equal(live.summary.metadata.budgetRemaining, 42);
    assert.equal(live.summary.metadata.percent, 50);

    // Hardcover: metadata comes from the journal, so a resolve pass of LiveLib
    // books must not make the journal look "half-loaded", and the budget is not
    // relevant to it.
    const hc = buildBooksStats({
      profile: 'hardcover-777',
      resolveState: { running: true, budgetRemaining: 42 },
    });
    assert.deepEqual(hc.summary.metadata, {
      resolved: 1,
      total: 1,
      linked: 1,
      withDetails: 1,
      unlinked: 0,
      resolvable: 1,
      hopeless: 0,
      keyless: 0,
      percent: 100,
      done: true,
      running: false,
      budgetRemaining: null,
    });
  });

  test('a fully enriched or empty profile reports 100% (badge hidden)', async () => {
    await bookCache.saveProfile('livelib', 'Empty', {
      schemaVersion: 1,
      source: 'livelib',
      userKey: 'Empty',
      importedAt: '2026-10-27T00:00:00.000Z',
      events: [],
      warnings: [],
    });
    const stats = buildBooksStats({ profile: 'livelib-Empty' });
    assert.equal(stats.summary.metadata.total, 0);
    assert.equal(stats.summary.metadata.percent, 100);
    assert.equal(stats.summary.metadata.running, false);
  });

  test('hopeless works leave the metadata denominator (99% -> 100%)', async () => {
    await seed();
    // The resolve pass asked the providers about 200 and 400 and got nothing.
    await bookCache.saveResolveState('livelib', 'Meta', {
      schemaVersion: 1,
      ranAt: '2026-10-28T00:00:00.000Z',
      total: 4,
      attempted: 2,
      matched: 0,
      skippedPlanShelf: 0,
      lookupErrors: [],
      unmatchedKeys: ['200', '400'],
    });

    const stats = buildBooksStats({ profile: 'livelib-Meta' });
    assert.deepEqual(stats.summary.metadata, {
      resolved: 2,
      total: 4,
      linked: 1,
      withDetails: 2,
      unlinked: 2,
      // 200 and 400 are dark for every provider -> not part of the pool, so the
      // badge can honestly read 100% instead of freezing at 99% forever.
      resolvable: 2,
      hopeless: 2,
      keyless: 0,
      percent: 100,
      done: true,
      running: false,
      budgetRemaining: null,
    });

    // Only one of them is hopeless: 2 of 3 resolvable = 67%, not done.
    await bookCache.saveResolveState('livelib', 'Meta', {
      schemaVersion: 1,
      ranAt: '2026-10-28T00:00:00.000Z',
      unmatchedKeys: ['200'],
    });
    const partial = buildBooksStats({ profile: 'livelib-Meta' });
    assert.deepEqual(partial.summary.metadata, {
      resolved: 2,
      total: 4,
      linked: 1,
      withDetails: 2,
      unlinked: 2,
      resolvable: 3,
      hopeless: 1,
      keyless: 0,
      percent: 67,
      done: false,
      running: false,
      budgetRemaining: null,
    });
  });

  test('plan shelves never inflate the metadata denominator', async () => {
    await seed();
    const profile = bookCache.getProfile('livelib', 'Meta');
    await bookCache.saveProfile('livelib', 'Meta', {
      ...profile,
      events: [...profile.events, event(500, { shelf: 'wish' }), event(501, { shelf: 'reading' })],
    });
    const stats = buildBooksStats({ profile: 'livelib-Meta' });
    // Same 4 history works; the two plans are not statistics and not metadata.
    assert.equal(stats.summary.metadata.total, 4);
    assert.equal(stats.summary.eventCount, 4);
  });

  test('resolveStateFromJobs recognises only a live LiveLib resolve stage', () => {
    const live = {
      id: 'job-1',
      source: 'livelib',
      stage: 'resolve',
      done: false,
      startedAt: 1000,
      resolved: 3,
      resolveTotal: 10,
      liveBudget: { litres: { limit: 200, used: 158, remaining: 42 } },
    };
    const state = resolveStateFromJobs([live], 'livelib');
    assert.equal(state.running, true);
    assert.equal(state.jobId, 'job-1');
    assert.equal(state.budgetRemaining, 42);

    // Journal fetch is not metadata loading for the LiveLib chain.
    assert.equal(resolveStateFromJobs([{ ...live, stage: 'livelib-bulk' }], 'livelib').running, false);
    // Done/failed jobs are never "running".
    assert.equal(resolveStateFromJobs([{ ...live, done: true }], 'livelib').running, false);
    // Hardcover profiles are never in the LiveLib resolve chain.
    assert.equal(resolveStateFromJobs([live], 'hardcover').running, false);
    // No budget snapshot yet -> null, not NaN.
    assert.equal(
      resolveStateFromJobs([{ ...live, liveBudget: null }], 'livelib').budgetRemaining,
      null
    );
    assert.equal(resolveStateFromJobs([], 'livelib').running, false);
  });

  test('file genres alone do not count as resolved metadata', async () => {
    await bookCache.saveProfile('livelib', 'GenresOnly', {
      schemaVersion: 1,
      source: 'livelib',
      userKey: 'GenresOnly',
      importedAt: '2026-10-27T00:00:00.000Z',
      events: [
        event(600, {
          genres: ['Фантастика'],
          edition: { publisher: 'Эксмо', year: 2020, isbn: null },
        }),
      ],
      warnings: [],
    });
    const stats = buildBooksStats({ profile: 'livelib-GenresOnly' });
    assert.equal(stats.summary.metadata.total, 1);
    // The file export has genres, but no provider link and no details document:
    // the old badge counted this as resolved (99% forever bug).
    assert.equal(stats.summary.metadata.resolved, 0);
    assert.equal(stats.summary.metadata.linked, 0);
    assert.equal(stats.summary.metadata.unlinked, 1);
    assert.equal(stats.summary.metadata.resolvable, 1);
    assert.equal(stats.summary.metadata.percent, 0);
    assert.equal(stats.summary.metadata.done, false);
  });

  test('a keyless work leaves the denominator instead of pinning it below 100%', async () => {
    await bookCache.saveProfile('livelib', 'Keyless', {
      schemaVersion: 1,
      source: 'livelib',
      userKey: 'Keyless',
      importedAt: '2026-10-27T00:00:00.000Z',
      events: [
        {
          id: 'll:orphan',
          source: 'livelib',
          title: 'Строка без ключа',
          authors: ['Автор'],
          rating: 7,
          ratingScale: 10,
          status: 'read',
          finishedAt: '2024-01-02',
        },
      ],
      warnings: [],
    });
    const stats = buildBooksStats({ profile: 'livelib-Keyless' });
    assert.equal(stats.summary.metadata.total, 1);
    assert.equal(stats.summary.metadata.unlinked, 1);
    assert.equal(stats.summary.metadata.keyless, 1);
    assert.equal(stats.summary.metadata.resolvable, 0);
    assert.equal(stats.summary.metadata.percent, 100);
    assert.equal(stats.summary.metadata.done, true);
  });
  after(() => env.resetMutableState());
});


describe('books-year-legacy', () => {
  /**
   * The legacy year channel of the decade/year charts (round 29.10.2026).
   *
   * Before ef593a8 the chart read, in order: `details.firstPublishedYear` →
   * `details.publicationYear` → the event/file `edition.year`. It also *silently
   * dropped* works with no year, which is why «год неизвестен» never appeared:
   * the chart simply showed fewer books than `bookCount`.
   *
   * Pinned here:
   *   - the legacy fallback is the print run: the export/file column
   *     (`edition.year`, the reader's own «Год издания») first, then the details
   *     document's `publicationYear`; both are marked `yearSource: 'edition'`
   *     and `editionYearSource: 'file' | 'details'`, never as a first edition;
   *   - an ancient `publicationYear` survives (the pre-ef593a8 code used the
   *     ancient bound for that field), a year 0 does not;
   *   - priority stays `manual > firstPublishedYear > edition`;
   *   - a re-import of an export that carries the year column enriches existing
   *     events (`mergeFileIntoProfile`) and the years appear in stats — no live
   *     request, the file is the data source;
   *   - works with no year at all stay out of the decade bars but are counted
   *     honestly: `years` sum + `summary.yearUnknownCount` = `bookCount`
   *     (the old chart's silent drop is what we must never reintroduce).
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { readPublicCss } = require('./helpers/css');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const { buildBooksStats, resolveWorkYear } = require('../server/books/stats');
  const { parseExportFile, mergeFileIntoProfile } = require('../server/books/livelib-file');

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

  function fileEvent({ id, title, year = null, isbn = null, shelf = 'read' }) {
    return {
      id: `llfile:id:${id}:${shelf}`,
      fileKey: `id:${id}`,
      source: 'livelib-file',
      origin: 'livelib-file',
      sourceBookId: String(id),
      sourceUrl: `https://www.livelib.ru/book/${id}`,
      workId: null,
      title,
      authors: ['Тестовый Автор'],
      rating: 4,
      ratingScale: 5,
      rating10: 8,
      status: 'read',
      shelf,
      startedAt: null,
      finishedAt: null,
      readMonth: '2026-09',
      readDateRaw: 'Сентябрь 2026 г.',
      reread: false,
      readIndex: 1,
      edition: {
        publisher: 'Тест',
        year,
        isbn: isbn || null,
        isbn13: isbn || null,
        isbn10: null,
        language: 'ru',
        series: null,
      },
      genres: ['Проза'],
      coverUrl: null,
      communityRating: null,
      bookStats: null,
    };
  }

  /* ------------------------------------------------------------------ */
  /* resolveWorkYear: the legacy channels                                */
  /* ------------------------------------------------------------------ */

  test('legacy year: the export/file column wins and is marked as a file edition year', () => {
    const info = resolveWorkYear({}, { edition: { year: 2019 } }, { year: 2019 }, null);
    assert.equal(info.year, 2019);
    assert.equal(info.yearSource, 'edition');
    assert.equal(info.editionYear, 2019);
    assert.equal(info.editionYearSource, 'file');
    assert.equal(info.firstPublishedYear, null);
  });

  test('legacy year: details.publicationYear is the second channel (provider print run)', () => {
    const info = resolveWorkYear({ publicationYear: 2005 }, null, {}, null);
    assert.equal(info.year, 2005);
    assert.equal(info.yearSource, 'edition');
    assert.equal(info.editionYearSource, 'details');
  });

  test('legacy year: the file column outranks the provider print run', () => {
    const info = resolveWorkYear(
      { publicationYear: 2005 },
      { edition: { year: 2019 } },
      { year: 2019 },
      null
    );
    assert.equal(info.year, 2019);
    assert.equal(info.yearSource, 'edition');
    assert.equal(info.editionYearSource, 'file');
    // Both claims are echoed so the card can show «это издание».
    assert.equal(info.editionYear, 2019);
  });

  test('legacy year: an ancient publicationYear survives, a year 0 does not', () => {
    const ancient = resolveWorkYear({ publicationYear: -500 }, null, {}, null);
    assert.equal(ancient.year, -500);
    assert.equal(ancient.yearSource, 'edition');
    assert.equal(ancient.editionYearSource, 'details');

    const zero = resolveWorkYear({ publicationYear: 0 }, null, {}, null);
    assert.equal(zero.year, null);
    assert.equal(zero.yearSource, null);
  });

  test('priority: manual > firstPublishedYear > legacy edition', () => {
    const details = { firstPublishedYear: 1603, publicationYear: 2005 };
    const event = { edition: { year: 2019 } };
    const first = resolveWorkYear(details, event, { year: 2019 }, null);
    assert.equal(first.year, 1603);
    assert.equal(first.yearSource, 'first');
    assert.equal(first.editionYear, 2019);
    assert.equal(first.editionYearSource, 'file');

    const manual = resolveWorkYear(details, event, { year: 2019 }, { year: 1700 });
    assert.equal(manual.year, 1700);
    assert.equal(manual.yearSource, 'manual');
  });

  /* ------------------------------------------------------------------ */
  /* stats: channels, re-import and the honest unknown accounting        */
  /* ------------------------------------------------------------------ */

  test('stats: the file year column restores years and reports its channel', async () => {
    const userKey = 'LegacyFileYear';
    const events = [
      fileEvent({ id: '7001', title: 'Книга с годом', year: 2011 }),
      fileEvent({ id: '7002', title: 'Книга без года' }),
    ];
    await bookCache.saveProfile('livelib', userKey, profile(userKey, events));
    const stats = buildBooksStats({ profile: `livelib-${userKey}` });

    const withYear = stats.booksIndex['ll:7001'];
    assert.equal(withYear.year, 2011);
    assert.equal(withYear.yearSource, 'edition');
    assert.equal(withYear.editionYearSource, 'file');
    assert.equal(stats.booksIndex['ll:7002'].year, null);

    assert.equal(stats.summary.yearEditionCount, 1);
    assert.equal(stats.summary.yearUnknownCount, 1);
    assert.equal(stats.summary.yearBackfill.editionChannels.file, 1);
    assert.deepEqual(stats.summary.yearBackfill.fileColumn, { rows: 2, withYear: 1 });

    // The known year is in a real decade; the year-less work is not painted as
    // a decade, it is only the honest tail bucket.
    const unknownBucket = stats.decades.find((entry) => entry.unknown);
    assert.equal(unknownBucket.count, 1);
    assert.equal(stats.decades.filter((entry) => !entry.unknown).reduce((sum, entry) => sum + entry.count, 0), 1);
  });

  test('stats: a re-import of an export with the year column heals existing events', async () => {
    const userKey = 'LegacyReimport';
    await bookCache.saveProfile(
      'livelib',
      userKey,
      profile(userKey, [fileEvent({ id: '7101', title: 'Аннигиляция' })])
    );

    let stats = buildBooksStats({ profile: `livelib-${userKey}` });
    assert.equal(stats.booksIndex['ll:7101'].year, null);
    assert.deepEqual(stats.summary.yearBackfill.fileColumn, { rows: 1, withYear: 0 });

    // Same file shape as the 29.10.2026 re-export: `details.year` present.
    const text = JSON.stringify([
      {
        bookHref: 'https://www.livelib.ru/book/7101-annigilyatsiya',
        title: 'Аннигиляция',
        readDate: 'Сентябрь 2026 г.',
        rating: { user: '4' },
        authors: [{ name: 'Тестовый Автор' }],
        genres: [{ name: 'Проза' }],
        details: { publishers: 'Тест', year: '2014', isbn: '9785699780495' },
      },
    ]);
    const parsed = parseExportFile(text, { shelf: 'read' });
    const merged = mergeFileIntoProfile(bookCache.getProfile('livelib', userKey), {
      userKey,
      books: parsed.books,
      shelf: 'read',
      format: parsed.format,
      filename: 'read-10_29_2026.json',
    });
    assert.equal(merged.added, 0);
    assert.equal(merged.enriched, 1);
    await bookCache.saveProfile('livelib', userKey, merged.profile);

    stats = buildBooksStats({ profile: `livelib-${userKey}` });
    assert.equal(stats.booksIndex['ll:7101'].year, 2014);
    assert.equal(stats.booksIndex['ll:7101'].yearSource, 'edition');
    assert.equal(stats.booksIndex['ll:7101'].editionYearSource, 'file');
    assert.equal(stats.summary.yearUnknownCount, 0);
    assert.deepEqual(stats.summary.yearBackfill.fileColumn, { rows: 1, withYear: 1 });
  });

  test('stats: unknown works are accounted for, never silently dropped', async () => {
    const userKey = 'LegacyUnknownAccounting';
    const events = [
      fileEvent({ id: '7201', title: 'С годом', year: 1999 }),
      fileEvent({ id: '7202', title: 'Без года' }),
      fileEvent({ id: '7203', title: 'Тоже без года' }),
    ];
    await bookCache.saveProfile('livelib', userKey, profile(userKey, events));
    const stats = buildBooksStats({ profile: `livelib-${userKey}` });

    const known = stats.years.reduce((sum, entry) => sum + entry.count, 0);
    const ancient = stats.summary.ancientBookCount || 0;
    // The old chart silently showed only `known` books out of `bookCount`.
    assert.equal(known + ancient + stats.summary.yearUnknownCount, stats.summary.bookCount);
    assert.equal(stats.summary.bookCount, 3);
    assert.equal(stats.summary.yearUnknownCount, 2);
  });

  test('UI: year-less works leave the donut and get a clickable summary line', () => {
    const booksSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'books.js'), 'utf8');
    const cssSource = readPublicCss();

    // The unknown slice is filtered out of the decade donut…
    assert.match(booksSource, /const decades = all\.filter\(\(item\) => !item\.unknown\)/);
    // …and the note carries a button that opens the drilldown list.
    assert.match(booksSource, /function unknownYearsButton\(count\)/);
    assert.match(booksSource, /function openUnknownYearModal\(\)/);
    assert.match(booksSource, /'Год можно исправить вручную: меню «…» у книги → «Исправить год»\.'/);
    // The honest reason names the missing export column, not a provider verdict.
    assert.match(booksSource, /в файле-выгрузке не было колонки «Год издания»/);
    assert.match(cssSource, /\.widget-note \.note-link/);
    // Labels no longer claim every bar is a first edition.
    assert.match(booksSource, /Книги по годам издания/);
  });
  after(() => env.resetMutableState());
});


describe('books-gbooks', () => {
  /**
   * Google Books as a first-class metadata source (round 29.10.2026).
   *
   * Covers: the key plumbing (env/file, never logged), `publishedDate` parsing,
   * the ISBN and Cyrillic-title paths, the author fuzzy guard against false
   * positives, the 30 min 403/429 breaker, network errors as deferrals (no
   * negative cache), the per-run `BOOKS_GB_BUDGET`, and the resolve/scheduled
   * chain wiring (own budget, order, budget skip is not a verdict).
   */

  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;
  // A fake key: the tests assert it never reaches the logs. Set before the first
  // `require` of the provider/config so the lazy loader sees it.
  const FAKE_KEY = 'AIzaSyTESTKEY_do_not_log_123456789';
  process.env.GB_API_KEY = FAKE_KEY;

  const test = require('node:test');
  const assert = require('node:assert/strict');

  const config = require('../server/config');
  const googlebooks = require('../server/books/providers/googlebooks');
  const bookCache = require('../server/books/book-cache');
  const resolve = require('../server/books/resolve');
  const scheduled = require('../server/books/scheduled-resolve');
  const { surnameSimilarity, authorsFuzzyOverlap } = require('../server/books/providers/match');

  const noSleep = async () => {};

  function response({ status = 200, body = {}, headers = {} }) {
    return {
      status,
      headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
      async json() {
        return typeof body === 'string' ? JSON.parse(body) : body;
      },
      async text() {
        return typeof body === 'string' ? body : JSON.stringify(body);
      },
    };
  }

  function volume(overrides = {}) {
    return {
      id: overrides.id || 'vol-1',
      volumeInfo: {
        title: overrides.title || 'Дюна',
        authors: overrides.authors === undefined ? ['Фрэнк Герберт'] : overrides.authors,
        publisher: 'АСТ',
        publishedDate: overrides.publishedDate === undefined ? '2016-05-01' : overrides.publishedDate,
        categories: ['Fiction / Science Fiction'],
        pageCount: 704,
        industryIdentifiers: overrides.industryIdentifiers || [
          { type: 'ISBN_13', identifier: '9785170987654' },
          { type: 'ISBN_10', identifier: '5170987650' },
        ],
        imageLinks: { thumbnail: 'http://books.google.com/books/content?id=1&edge=curl' },
        infoLink: `https://books.google.com/books?id=${overrides.id || 'vol-1'}`,
        language: overrides.language || 'ru',
      },
    };
  }

  function gbFetch(handler) {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return handler(String(url));
    };
    fetchImpl.calls = calls;
    return fetchImpl;
  }

  test.beforeEach(() => {
    googlebooks.resetBreaker();
  });

  /* ------------------------------------------------------------------ */
  /* Key plumbing                                                        */
  /* ------------------------------------------------------------------ */

  test('gbooks key: GB_API_KEY is the source and the value is never logged', async () => {
    assert.equal(config.gbooksKeySource(), 'GB_API_KEY');
    const logs = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...args) => logs.push(args.join(' '));
    console.warn = (...args) => logs.push(args.join(' '));
    console.error = (...args) => logs.push(args.join(' '));
    try {
      const fetchImpl = gbFetch(() => response({ body: { items: [volume()] } }));
      const result = await googlebooks.getWork(
        { isbn13: '9785170987654', title: 'Дюна', authors: ['Фрэнк Герберт'] },
        { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
      );
      assert.ok(result);
      assert.equal(fetchImpl.calls.length, 1);
      // The key is in the URL (that is how the API works) …
      assert.equal(fetchImpl.calls[0].includes(encodeURIComponent(FAKE_KEY)), true);
      // … but not in any log line.
      const joined = logs.join('\n');
      assert.equal(joined.includes(FAKE_KEY), false);
      assert.equal(joined.includes('AIzaSy'), false);
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    }
  });

  /* ------------------------------------------------------------------ */
  /* Parsing                                                             */
  /* ------------------------------------------------------------------ */

  test('gbooks parses every publishedDate shape into a sane year', () => {
    assert.equal(googlebooks.yearOf('2016-05-01'), 2016);
    assert.equal(googlebooks.yearOf('2016-05'), 2016);
    assert.equal(googlebooks.yearOf('2016'), 2016);
    assert.equal(googlebooks.yearOf('2016-05-01T00:00:00Z'), 2016);
    assert.equal(googlebooks.yearOf('-0500-01-01'), -500);
    assert.equal(googlebooks.yearOf('0'), null);
    assert.equal(googlebooks.yearOf(''), null);
    assert.equal(googlebooks.yearOf('n/a'), null);
    assert.equal(googlebooks.yearOf('9999-01-01'), null);
    assert.equal(googlebooks.yearOf(2016), 2016);
  });

  test('gbooks ISBN hit carries the edition year, never a first-publication claim', async () => {
    const fetchImpl = gbFetch(() => response({ body: { items: [volume()] } }));
    const result = await googlebooks.getWork(
      { isbn13: '9785170987654' },
      { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
    );
    assert.equal(result.source, 'googlebooks');
    assert.equal(result.year, 2016);
    assert.equal(result.firstPublishedYear, undefined);
    assert.equal(result.match.method, 'isbn');
    assert.equal(result.confidence, 0.96);
    assert.equal(result.isbn13, '9785170987654');
  });

  /* ------------------------------------------------------------------ */
  /* Title path + false-positive guard                                   */
  /* ------------------------------------------------------------------ */

  test('gbooks Cyrillic title uses the plain phrase query (fielded operators are dead)', async () => {
    const fetchImpl = gbFetch(() =>
      response({ body: { items: [volume({ id: 'vol-nemesis', title: 'Немезида', authors: ['Агата Кристи'], publishedDate: '2019-10-07' })] } })
    );
    const result = await googlebooks.getWork(
      { title: 'Немезида', authors: ['Agatha Christie'] },
      { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
    );
    assert.ok(result);
    assert.equal(fetchImpl.calls.length, 1);
    const url = decodeURIComponent(fetchImpl.calls[0]);
    assert.equal(url.includes('intitle:'), false);
    assert.equal(url.includes('q=Немезида Agatha Christie'), true);
    assert.equal(result.match.authorFuzzy, true);
    assert.equal(result.confidence, 0.95);
  });

  test('gbooks fuzzy surname matches transliterations, not unrelated names', () => {
    assert.ok(surnameSimilarity('кристи', 'christie') >= 0.6);
    assert.ok(surnameSimilarity('твен', 'twain') >= 0.6);
    assert.ok(surnameSimilarity('герберт', 'herbert') >= 0.6);
    assert.equal(surnameSimilarity('кристи', 'stark') >= 0.6, false);
    assert.equal(authorsFuzzyOverlap(['Agatha Christie'], ['Агата Кристи']), true);
    assert.equal(authorsFuzzyOverlap(['Agatha Christie'], ['Кристина Старк']), false);
  });

  test('gbooks title fallback rejects a different author and a different title', async () => {
    // Same title, different author: the author guard must reject it.
    let fetchImpl = gbFetch(() =>
      response({ body: { items: [volume({ id: 'wrong-author', title: 'Немезида', authors: ['Другой Автор'] })] } })
    );
    const wrongAuthor = await googlebooks.getWork(
      { title: 'Немезида', authors: ['Agatha Christie'] },
      { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
    );
    assert.equal(wrongAuthor, null);

    // Same author, different title: title similarity is too low.
    fetchImpl = gbFetch(() =>
      response({ body: { items: [volume({ id: 'wrong-title', title: 'Совсем другая книга', authors: ['Агата Кристи'] })] } })
    );
    const wrongTitle = await googlebooks.getWork(
      { title: 'Немезида', authors: ['Agatha Christie'] },
      { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
    );
    assert.equal(wrongTitle, null);
  });

  /* ------------------------------------------------------------------ */
  /* Breaker / errors / budget                                           */
  /* ------------------------------------------------------------------ */

  test('gbooks 403 and 429 trip a 30 minute breaker', async () => {
    assert.equal(googlebooks.BREAKER_MS, 30 * 60 * 1000);
    for (const status of [403, 429]) {
      googlebooks.resetBreaker();
      const fetchImpl = gbFetch(() => response({ status, body: {} }));
      await assert.rejects(
        googlebooks.getWork({ title: 'Дюна', authors: ['Фрэнк Герберт'] }, { fetchImpl, sleep: noSleep, requestDelayMs: 0 })
      );
      assert.equal(googlebooks.isBreakerOpen(), true);
      const before = fetchImpl.calls.length;
      const second = await googlebooks.getWork(
        { title: 'Дюна', authors: ['Фрэнк Герберт'] },
        { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
      );
      assert.equal(second, null);
      assert.equal(fetchImpl.calls.length, before);
    }
    googlebooks.resetBreaker();
  });

  test('gbooks network error is a deferral: it throws and writes no negative memo', async () => {
    const memo = new Map();
    const fetchImpl = gbFetch(() => {
      throw new Error('ECONNRESET');
    });
    await assert.rejects(
      googlebooks.getWork(
        { title: 'Дюна', authors: ['Фрэнк Герберт'] },
        { fetchImpl, sleep: noSleep, requestDelayMs: 0, negativeMemo: memo }
      )
    );
    assert.equal(memo.size, 0);
    assert.equal(googlebooks.isBreakerOpen(), false);
  });

  test('gbooks BOOKS_GB_BUDGET bounds the books per run, not the HTTP requests', async () => {
    const budget = googlebooks.createBudget(2);
    const fetchImpl = gbFetch(() => response({ body: { items: [] } }));
    for (const title of ['Одна', 'Две', 'Три']) {
      await googlebooks.getWork({ title, authors: ['Автор'] }, { fetchImpl, sleep: noSleep, requestDelayMs: 0, budget });
    }
    assert.equal(budget.used, 2);
    assert.equal(budget.remaining, 0);
    assert.equal(fetchImpl.calls.length, 2);
  });

  /* ------------------------------------------------------------------ */
  /* Chain wiring                                                        */
  /* ------------------------------------------------------------------ */

  function profile(events) {
    return { schemaVersion: 1, source: 'livelib', userKey: 'gb-tester', importedAt: '2026-10-29T00:00:00.000Z', events };
  }

  function event(bookId, overrides = {}) {
    return {
      id: `ll:${bookId}`,
      source: 'livelib',
      sourceBookId: String(bookId),
      title: overrides.title || 'Немезида',
      authors: overrides.authors || ['Agatha Christie'],
      rating: 8,
      ratingScale: 10,
      rating10: 8,
      edition: { isbn: overrides.isbn === undefined ? null : overrides.isbn, year: null },
    };
  }

  test('gbooks has its own budget in the chain (not the LiveLib card budget)', async () => {
    const fetchImpl = gbFetch(() => response({ body: { items: [] } }));
    const report = await resolve.resolveProfile(
      profile([event('7001'), event('7002')]),
      {
        providers: ['googlebooks'],
        lookupIsbns: async () => ({ byIsbn: new Map(), works: new Map(), queries: [], requests: 0 }),
        fetchImpl,
        sleep: noSleep,
        requestDelayMs: 0,
        gbBudget: googlebooks.createBudget(1),
        cardBudget: resolve.createCardBudget(10),
      }
    );
    assert.equal(report.gbBudget.used, 1);
    assert.equal(report.gbBudget.limit, 1);
    assert.equal(report.cardBudget.used, 0);
    // The second book was never asked: it must stay pending, not "hopeless".
    assert.deepEqual(report.unmatchedKeys, ['7001']);
    assert.equal(report.budgetPendingKeys.includes('7002'), true);
  });

  test('gbooks budget skip is a deferral in the scheduled resolve (no negative cache)', async () => {
    const fetchImpl = gbFetch(() => response({ body: { items: [] } }));
    await bookCache.saveProfile('livelib', 'gb-tester', profile([event('7101'), event('7102')]));
    const report = await scheduled.resolveOneProfile(bookCache.getProfile('livelib', 'gb-tester'), {
      providers: ['googlebooks'],
      fetchImpl,
      sleep: noSleep,
      requestDelayMs: 0,
      gbBudget: googlebooks.createBudget(1),
      cardBudget: resolve.createCardBudget(10),
      limit: 2,
      recheckDays: 90,
    });
    assert.equal(report.selected, 2);
    assert.equal(report.linked, 0);
    assert.equal(report.deferred, 1);
    assert.equal(report.misses, 1);
    const state = scheduled.loadCandidateState('livelib', 'gb-tester');
    assert.deepEqual(Object.keys(state.candidates), ['7101']);
  });

  test('gbooks is the second matcher for a Cyrillic title after litres', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (String(url).includes('api.litres.ru')) return response({ body: { payload: { data: [] } } });
      if (String(url).includes('googleapis')) {
        return response({ body: { items: [volume({ id: 'vol-igrok', title: 'Игрок', authors: ['Фёдор Достоевский'], publishedDate: '2014' })] } });
      }
      return response({ body: {} });
    };
    const report = await resolve.resolveProfile(
      profile([event('7201', { title: 'Игрок', authors: ['Фёдор Достоевский'] })]),
      {
        providers: ['litres', 'googlebooks', 'openlibrary'],
        lookupIsbns: async () => ({ byIsbn: new Map(), works: new Map(), queries: [], requests: 0 }),
        fetchImpl,
        sleep: noSleep,
        requestDelayMs: 0,
        litresPauseMs: 0,
      }
    );
    assert.equal(report.resolvedGoogle, 1);
    assert.equal(report.resolvedLitres, 0);
    assert.equal(calls.some((url) => url.includes('openlibrary')), false);
    const link = bookCache.getLink('7201');
    assert.equal(link.method, 'googlebooks-title');
    const details = bookCache.getWorkDetails('gb:vol-igrok');
    assert.equal(details.publicationYear, 2014);
    assert.equal(details.firstPublishedYear, null);
  });
  after(() => env.resetMutableState());
});


describe('books-ancient-bucket', () => {
  /**
   * The ancient bucket «до 1000 г.» is a first-class, clickable slot.
   *
   * User report (30.10.2026): the decade donut had the slice, but it was dead —
   * a click did nothing — and the year chart did not show the bucket at all
   * (`years[]` carried only real years ≥ 1000). The live profile had exactly one
   * such work (Kama Sutra, ~300 AD), so the bucket was invisible everywhere.
   *
   * Pinned here:
   *   - `decades[]` and `years[]` carry the same stable key (`before-1000`) and
   *     the same bound (`beforeYear: 1000`), and the same count — the one that
   *     `summary.ancientBookCount` reports;
   *   - the year bucket has no `year`: the x axis stays linear over real years,
   *     one ancient work never stretches it;
   *   - no double counting: the bucket is not a second copy of any year, so
   *     `years` sum + `yearUnknownCount` = `bookCount`;
   *   - a manual year correction moves the work out of the bucket into its real
   *     decade/year (the UI keeps «…» → «Исправить год» on every row);
   *   - both charts route the click by `ancient`/`beforeYear`, never by the
   *     label, and the bar chart paints the slot outside the year axis.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { readPublicCss } = require('./helpers/css');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const { buildBooksStats } = require('../server/books/stats');

  const PUBLIC_DIR = path.join(__dirname, '..', 'public');

  function event(id, title, extra = {}) {
    return {
      id,
      source: 'livelib',
      sourceBookId: String(id).replace(/^ll:/, ''),
      title,
      authors: [],
      rating: null,
      ratingScale: 10,
      rating10: null,
      status: 'read',
      finishedAt: '2026-05-05',
      ...extra,
    };
  }

  function profile(userKey, events) {
    return {
      schemaVersion: 1,
      source: 'livelib',
      userKey,
      sourceUserId: null,
      importedAt: '2026-10-30T00:00:00.000Z',
      events,
      warnings: [],
    };
  }

  async function linkedWork({ hcId, title, firstPublishedYear, publicationYear = null, yearSource = 'openlibrary' }) {
    await bookCache.saveDetails(hcId, {
      schemaVersion: 2,
      hcWorkId: hcId,
      title,
      authors: [{ name: 'Автор' }],
      publicationYear,
      firstPublishedYear,
      metadataSources: [yearSource],
    });
    await bookCache.saveLink(String(hcId), {
      schemaVersion: 2,
      livelibBookId: String(hcId),
      workId: `hc:${hcId}`,
      method: 'isbn',
      score: 1,
    });
  }

  test('payload: the ancient bucket is one slot on both charts, counted once', async () => {
    const userKey = 'AncientBucket';
    // Kama Sutra-ish work: the year is the work's own, not the print run's.
    await linkedWork({ hcId: 45230, title: 'The Kama Sutra of Vatsyayana', firstPublishedYear: 300, publicationYear: 2016 });
    await linkedWork({ hcId: 45231, title: 'Гамлет', firstPublishedYear: 1603, publicationYear: 2005 });
    await linkedWork({ hcId: 45232, title: 'Мартин Иден', firstPublishedYear: 1909 });
    await bookCache.saveProfile(
      'livelib',
      userKey,
      profile(userKey, [
        event('ll:45230', 'The Kama Sutra of Vatsyayana', { raw: { sourceBookId: '45230' } }),
        event('ll:45231', 'Гамлет', { raw: { sourceBookId: '45231' } }),
        event('ll:45232', 'Мартин Иден', { raw: { sourceBookId: '45232' } }),
      ])
    );

    const stats = buildBooksStats({ profile: `livelib-${userKey}` });
    const decadeBucket = stats.decades.find((entry) => entry.ancient);
    const yearBucket = stats.years.find((entry) => entry.ancient);

    assert.ok(decadeBucket, 'decades[] carries the ancient bucket');
    assert.ok(yearBucket, 'years[] carries the ancient bucket');
    assert.equal(decadeBucket.label, 'до 1000 г.');
    assert.equal(yearBucket.label, 'до 1000 г.');
    // Stable drilldown key + shared bound: the UI must not guess from the label.
    for (const bucket of [decadeBucket, yearBucket]) {
      assert.equal(bucket.key, 'before-1000');
      assert.equal(bucket.beforeYear, 1000);
      assert.equal(bucket.count, 1);
    }
    // One counter for all three places.
    assert.equal(decadeBucket.count, stats.summary.ancientBookCount);
    assert.equal(yearBucket.count, stats.summary.ancientBookCount);

    // The year bucket is not a year: no `year` that would land on the axis.
    assert.equal(yearBucket.year, undefined);
    // …and it is the first element, left of the real years.
    assert.equal(stats.years[0].ancient, true);
    assert.deepEqual(stats.years.filter((entry) => !entry.ancient).map((entry) => entry.year), [1603, 1909]);

    // No double counting: bucket + real years + unknown = all works.
    const known = stats.years.reduce((sum, entry) => sum + entry.count, 0);
    assert.equal(known, 3);
    assert.equal(known + stats.summary.yearUnknownCount, stats.summary.bookCount);
    assert.equal(stats.summary.yearsSpan.from, 1603);
  });

  test('manual year correction moves the work out of the ancient bucket', async () => {
    const userKey = 'AncientMove';
    await linkedWork({ hcId: 46001, title: 'The Kama Sutra of Vatsyayana', firstPublishedYear: 300, publicationYear: 2016 });
    await linkedWork({ hcId: 46002, title: 'Гамлет', firstPublishedYear: 1603 });
    await bookCache.saveProfile(
      'livelib',
      userKey,
      profile(userKey, [
        event('ll:46001', 'The Kama Sutra of Vatsyayana', { raw: { sourceBookId: '46001' } }),
        event('ll:46002', 'Гамлет', { raw: { sourceBookId: '46002' } }),
      ])
    );

    let stats = buildBooksStats({ profile: `livelib-${userKey}` });
    assert.equal(stats.decades.find((entry) => entry.ancient).count, 1);
    assert.equal(stats.years.find((entry) => entry.ancient).count, 1);
    assert.equal(stats.summary.ancientBookCount, 1);

    // The user's own correction (menu «…» → «Исправить год») outranks providers.
    await bookCache.setYearOverride('livelib', userKey, 'hc:46001', 1850);
    stats = buildBooksStats({ profile: `livelib-${userKey}` });
    const work = stats.booksIndex['hc:46001'];
    assert.equal(work.year, 1850);
    assert.equal(work.yearSource, 'manual');
    // The bucket is gone (not an empty leftover) and the work sits in 1850.
    assert.equal(stats.decades.some((entry) => entry.ancient), false);
    assert.equal(stats.years.some((entry) => entry.ancient), false);
    assert.equal(stats.summary.ancientBookCount, 0);
    assert.equal(stats.decades.find((entry) => entry.decade === 1850).count, 1);
    assert.equal(stats.years.find((entry) => entry.year === 1850).count, 1);
    assert.equal(stats.summary.yearManualCount, 1);
    const known = stats.years.reduce((sum, entry) => sum + entry.count, 0);
    assert.equal(known + stats.summary.yearUnknownCount, stats.summary.bookCount);

    // Reset brings the bucket back exactly as it was.
    await bookCache.clearYearOverride('livelib', userKey, 'hc:46001');
    stats = buildBooksStats({ profile: `livelib-${userKey}` });
    assert.equal(stats.years.find((entry) => entry.ancient).count, 1);
    assert.equal(stats.summary.ancientBookCount, 1);
  });

  test('a profile of nothing but ancient works keeps a valid (empty) year axis', async () => {
    const userKey = 'AncientOnly';
    await linkedWork({ hcId: 47001, title: 'Искусство войны', firstPublishedYear: -500 });
    await bookCache.saveProfile(
      'livelib',
      userKey,
      profile(userKey, [event('ll:47001', 'Искусство войны', { raw: { sourceBookId: '47001' } })])
    );

    const stats = buildBooksStats({ profile: `livelib-${userKey}` });
    // Only the bucket: the chart must not invent a year (an axis from -500).
    assert.deepEqual(stats.years.map((entry) => entry.ancient), [true]);
    assert.equal(stats.years[0].count, 1);
    assert.equal(stats.years[0].beforeYear, 1000);
    assert.equal(stats.summary.ancientBookCount, 1);
    assert.equal(stats.summary.yearUnknownCount, 0);
    assert.equal(stats.summary.yearsSpan, null);
  });

  test('UI: both charts open the same list and the bar slot stays off the year axis', () => {
    const booksSource = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'books.js'), 'utf8');
    const chartsSource = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'charts', 'year-bars.js'), 'utf8');
    const cssSource = readPublicCss();

    // One drilldown for the decade slice and the year column.
    assert.match(booksSource, /function openAncientYearModal\(bucket\)/);
    assert.match(booksSource, /entry\.year < beforeYear/);
    assert.match(booksSource, /меню «…» у книги → «Исправить год»/);
    // The decade slice routes by data (`ancient`), not by `start === 0`.
    assert.match(booksSource, /if \(seg\.ancient\) \{/);
    assert.match(booksSource, /openAncientYearModal\(seg\)/);
    // The year bars receive the same handler and keep the bucket out of the
    // real-year range/total in the note.
    assert.match(booksSource, /onAncientClick: \(bucket\) => openAncientYearModal\(bucket\)/);
    assert.match(booksSource, /const realYears = years\.filter\(\(item\) => !item\.ancient\)/);

    // charts/year-bars.js: the bucket is a separate slot with its own hit area.
    assert.match(chartsSource, /const ANCIENT_SLOT_W/);
    assert.match(chartsSource, /onAncientClick/);
    assert.match(chartsSource, /class: 'tl-bar is-ancient'/);
    assert.match(chartsSource, /tl-slot-ancient/);
    assert.match(chartsSource, /tl-separator/);
    // The year axis starts after the slot, so the slot never becomes a year.
    assert.match(chartsSource, /const axisLeft = pad\.left \+ slotW \+ slotGap/);
    // CSS separates it visually.
    assert.match(cssSource, /\.tl-bar\.is-ancient/);
    assert.match(cssSource, /\.tl-slot-ancient/);
    assert.match(cssSource, /\.tl-separator/);
  });
  after(() => env.resetMutableState());
});


describe('books-author-identity', () => {
  /**
   * Author identity (RU/EN spellings) — the offline rule and the persisted table.
   *
   * Pinned here:
   *   - a false merge is worse than a missed one: the four traps found on the
   *     real Margaret export stay apart;
   *   - normalisation (case/ё/diacritics) and the Hardcover author id merge;
   *   - the canonical English spelling wins when both spellings exist;
   *   - a persisted/manual alias survives a rebuild;
   *   - the Wikidata bridge is opt-in and mocks fetch (no network in tests).
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const CACHE = run.cacheBookDir;
  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const authors = require('../server/books/authors');
  const wd = require('../server/books/authors-wikidata');

  test('known surname traps are not merged without a matching given name', () => {
    assert.equal(authors.namesLookAlike('Сьюзан Кинг', 'Stephen King'), false);
    assert.equal(authors.namesLookAlike('Марджори Ролингс', 'J. K. Rowling'), false);
    assert.equal(authors.namesLookAlike('Георг Эберс', 'Giulia Enders'), false);
    assert.equal(authors.namesLookAlike('Шарль де Костер', 'G. B. Oster'), false);
  });

  test('transliteration connects the spellings it can prove', () => {
    assert.equal(authors.namesLookAlike('Агата Кристи', 'Agatha Christie'), true);
    assert.equal(authors.namesLookAlike('Джоан Роулинг', 'Joanne Rowling'), true);
    assert.equal(authors.namesLookAlike('Джон Р. Р. Толкин', 'J. R. R. Tolkien'), true);
    assert.equal(authors.namesLookAlike('Стивен Кинг', 'Stephen King'), true);
    assert.equal(authors.namesLookAlike('Хадзимэ Исаяма', 'Hajime Isayama'), true);
  });

  test('groupAuthors merges RU/EN into one canonical row and keeps the aliases', () => {
    const entries = [
      { name: 'Агата Кристи', workId: 'a' },
      { name: 'Agatha Christie', workId: 'b' },
      { name: 'Аґата Кристі', workId: 'c' },
      { name: 'Стивен Кинг', workId: 'd' },
      { name: 'Stephen King', workId: 'e' },
      { name: 'Сьюзан Кинг', workId: 'f' },
    ];
    const result = authors.groupAuthors(entries, {});
    assert.equal(result.groups.length, 3);
    const christie = result.groups.find((group) => group.name === 'Agatha Christie');
    assert.ok(christie);
    assert.deepEqual(christie.names.sort(), ['Agatha Christie', 'Агата Кристи', 'Аґата Кристі'].sort());
    assert.equal(result.canonicalOf.get('агата кристи'), 'Agatha Christie');
    assert.equal(result.mergedGroups, 2);
    assert.ok(!result.groups.some((group) => group.name === 'Сьюзан Кинг' && group.names.length > 1));
  });

  test('the Hardcover author id merges otherwise unrelated spellings', () => {
    const result = authors.groupAuthors(
      [
        { name: 'Ясунари Кавабата', id: '777', workId: 'a' },
        { name: 'Yasunari Kawabata', id: '777', workId: 'b' },
      ],
      {}
    );
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].name, 'Yasunari Kawabata');
  });

  test('a persisted/manual alias wins over the automatic preference', () => {
    const persisted = {
      canonical: { 'дж к роулинг': 'J. K. Rowling' },
      manual: { 'дж к роулинг': 'Джоан Роулинг' },
    };
    const result = authors.groupAuthors(
      [
        { name: 'Дж. К. Роулинг', workId: 'a' },
        { name: 'J. K. Rowling', workId: 'b' },
      ],
      persisted
    );
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].name, 'Джоан Роулинг');
  });

  test('authors.json is written and re-read (manual edits preserved)', async () => {
    const saved = await bookCache.saveAuthorsMap({
      fingerprint: 'fp-1',
      canonical: { 'агата кристи': 'Agatha Christie' },
      manual: { 'дж к роулинг': 'Джоан Роулинг' },
    });
    assert.equal(saved.canonical['агата кристи'], 'Agatha Christie');
    await bookCache.saveAuthorsMap({ fingerprint: 'fp-2', canonical: { 'стивен кинг': 'Stephen King' } });
    const read = bookCache.getAuthorsMap();
    assert.equal(read.canonical['агата кристи'], 'Agatha Christie');
    assert.equal(read.canonical['стивен кинг'], 'Stephen King');
    assert.equal(read.manual['дж к роулинг'], 'Джоан Роулинг');
    assert.equal(read.fingerprint, 'fp-2');
  });

  test('the Wikidata bridge merges an exonym by QID and respects 429', async () => {
    const responses = new Map();
    const fetchImpl = async (url, init) => {
      // The bridge POSTs the query (a 450-label batch does not fit a URL).
      const decoded = decodeURIComponent(String((init && init.body) || url)).replace(/\+/g, ' ');
      if (/VALUES \?label/.test(decoded)) {
        responses.searches = (responses.searches || 0) + 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: {
              bindings: [
                { item: { value: 'http://www.wikidata.org/entity/Q9352' }, label: { value: 'Агата Кристи' } },
              ],
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: {
            bindings: [
              { item: { value: 'http://www.wikidata.org/entity/Q9352' }, name: { value: 'Агата Кристи' } },
              { item: { value: 'http://www.wikidata.org/entity/Q9352' }, name: { value: 'Agatha Christie' } },
            ],
          },
        }),
      };
    };
    const result = await wd.resolveWikidataAliases(
      [
        { name: 'Агата Кристи', workId: 'a' },
        { name: 'Agatha Christie', workId: 'b' },
      ],
      { fetchImpl, sleep: async () => {}, pauseMs: 0 }
    );
    assert.equal(result.merged.length, 1);
    assert.equal(result.merged[0].qid, 'Q9352');
    assert.ok(result.canonical['agatha christie']);

    const blocked = await wd.resolveWikidataAliases(
      [{ name: 'Моэм', workId: 'a' }],
      {
        fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => '60' }, json: async () => ({}) }),
        sleep: async () => {},
        pauseMs: 0,
      }
    );
    assert.equal(blocked.skipped, 'wikidata_429');
    assert.deepEqual(blocked.merged, []);
  });
  after(() => env.resetMutableState());
});


describe('books-authors-bridge', () => {
  /**
   * Default-on Wikidata author bridge (`authors-bridge.js`).
   *
   * The offline rule (authors.js) cannot prove an exonym: «Уильям Сомерсет Моэм»
   * vs «W. Somerset Maugham». Until 28.10.2026 the bridge ran only from a manual
   * backfill, so a fresh deployment kept those duplicates. Now a stats build kicks
   * it automatically, for the *unresolved* spellings only, and the answer is
   * cached in authors.json.
   *
   * Pinned here:
   *   - only singleton (offline-unresolved) and not-yet-asked names go to WDQS;
   *   - the payload path never waits (buildBooksStats calls the bridge, the spy
   *     proves the arguments and that stats returns without it);
   *   - a repeat pass with a full cache issues ZERO requests;
   *   - 429 and a network error degrade without throwing and start a cooldown;
   *   - a manual edit in authors.json survives every automatic pass;
   *   - a label shared by two people (ambiguous QIDs) is not merged.
   *
   * Every fetch is mocked: this file never touches the network.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const authors = require('../server/books/authors');
  const bridge = require('../server/books/authors-bridge');
  const authorsWikidata = require('../server/books/authors-wikidata');
  const { buildBooksStats } = require('../server/books/stats');

  const MOEM_RU = 'Уильям Сомерсет Моэм';
  const MOEM_EN = 'W. Somerset Maugham';

  function jsonResponse(bindings) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: { bindings } }),
    };
  }

  /**
   * A fake WDQS: `labels` maps a spelling to its QIDs, `qids` maps a QID to all
   * the spellings it carries as a label/alias.
   */
  function mockWikidata({ labels = {}, qids = {} } = {}) {
    const calls = { name: 0, item: 0, urls: [] };
    const fetchImpl = async (url, init) => {
      const decoded = decodeURIComponent(String((init && init.body) || url)).replace(/\+/g, ' ');
      calls.urls.push(decoded);
      if (/VALUES \?label/.test(decoded)) {
        calls.name++;
        const bindings = [];
        for (const [label, list] of Object.entries(labels)) {
          if (!decoded.includes(`"${label}"`)) continue;
          for (const qid of list) {
            bindings.push({
              item: { value: `http://www.wikidata.org/entity/${qid}` },
              label: { value: label },
            });
          }
        }
        return jsonResponse(bindings);
      }
      calls.item++;
      const bindings = [];
      for (const [qid, names] of Object.entries(qids)) {
        if (!decoded.includes(`wd:${qid}`)) continue;
        for (const name of names) {
          bindings.push({
            item: { value: `http://www.wikidata.org/entity/${qid}` },
            name: { value: name },
          });
        }
      }
      return jsonResponse(bindings);
    };
    return { fetchImpl, calls };
  }

  const exonymMock = () =>
    mockWikidata({
      labels: { [MOEM_RU]: ['Q1348'], [MOEM_EN]: ['Q1348'] },
      qids: { Q1348: [MOEM_RU, MOEM_EN] },
    });

  const ENTRIES = [
    { name: MOEM_RU, workId: 'a' },
    { name: MOEM_EN, workId: 'b' },
    { name: 'Настоящий Автор', workId: 'c' },
  ];

  test('pendingCandidates asks only for offline-unresolved, not-yet-checked names', () => {
    const entries = [
      { name: 'Агата Кристи' },
      { name: 'Agatha Christie' }, // offline rule merges these
      { name: 'Джоан Роулинг' }, // already asked in a previous pass
      { name: 'Моэм' },
    ];
    const persisted = {
      canonical: {},
      manual: {},
      wikidata: { checked: { 'джоан роулинг': true }, checkedAt: null, disabledUntil: null },
    };
    const pending = bridge.pendingCandidates(entries, persisted);
    assert.deepEqual(pending.sort(), ['Моэм'].sort());
    // A manually merged spelling is not a candidate either (the anchor must be
    // in the corpus for authors.js to union the group).
    const withManual = bridge.pendingCandidates(
      [{ name: 'Моэм' }, { name: 'Уильям Сомерсет Моэм' }],
      {
        manual: { 'моэм': 'Уильям Сомерсет Моэм' },
        canonical: {},
        wikidata: { checked: {}, checkedAt: null, disabledUntil: null },
      }
    );
    assert.deepEqual(withManual, []);
  });
  test('an exonym pair is merged by QID and the answer lands in authors.json', async () => {
    const { fetchImpl, calls } = exonymMock();
    const report = await bridge.resolveAuthorsWikidata(ENTRIES, {
      fetchImpl,
      sleep: async () => {},
      pauseMs: 0,
      now: () => Date.parse('2026-10-28T10:00:00Z'),
    });
    assert.equal(report.ran, true);
    assert.equal(report.reason, 'ok');
    assert.equal(report.merged, 1);
    assert.ok(calls.name >= 1 && calls.item >= 1);
    assert.ok(report.queries >= 2 && report.queries <= 4, `queries=${report.queries}`);

    const map = bookCache.getAuthorsMap();
    assert.equal(map.canonical[authors.normalizeAuthorName(MOEM_RU)], MOEM_EN);
    assert.equal(map.wikidata.checked[authors.normalizeAuthorName(MOEM_RU)], true);
    assert.equal(map.wikidata.checked[authors.normalizeAuthorName('Настоящий Автор')], true);
    assert.equal(map.wikidata.checkedAt, '2026-10-28T10:00:00.000Z');
    assert.equal(map.wikidata.disabledUntil, null);

    // The next payload applies the table: one author row, not two.
    const grouped = authors.groupAuthors(ENTRIES, bookCache.getAuthorsMap());
    assert.equal(grouped.groups.filter((group) => group.name === MOEM_EN).length, 1);
    assert.equal(grouped.groups.length, 2); // Моэм + Настоящий Автор
  });

  test('a full cache means zero WDQS requests on the next pass', async () => {
    const { fetchImpl, calls } = exonymMock();
    const report = await bridge.resolveAuthorsWikidata(ENTRIES, {
      fetchImpl,
      sleep: async () => {},
      pauseMs: 0,
    });
    assert.equal(report.ran, false);
    assert.equal(report.reason, 'nothing_to_do');
    assert.equal(report.pending, 0);
    assert.equal(calls.name + calls.item, 0);

    const kicked = bridge.kickAuthorsWikidata(ENTRIES, { fetchImpl });
    if (kicked) await kicked;
    assert.equal(calls.name + calls.item, 0);
  });

  test('429 degrades, keeps the duplicates and starts a cooldown instead of throwing', async () => {
    bookCache.clearMemory();
    fs.rmSync(bookCache.AUTHORS_PATH, { force: true });
    const blocked = {
      ok: false,
      status: 429,
      headers: { get: () => '120' },
      json: async () => ({}),
    };
    let calls = 0;
    const report = await bridge.resolveAuthorsWikidata(
      [{ name: 'Говард Лавкрафт' }, { name: 'H. P. Lovecraft' }],
      {
        fetchImpl: async () => {
          calls++;
          return blocked;
        },
        sleep: async () => {},
        pauseMs: 0,
        now: () => Date.parse('2026-10-28T10:00:00Z'),
      }
    );
    assert.equal(report.ran, true);
    assert.equal(report.reason, 'degraded');
    assert.equal(report.merged, 0);
    assert.equal(report.skipped, 'wikidata_429');
    assert.equal(calls, 1);

    const map = bookCache.getAuthorsMap();
    // Nothing merged, nothing remembered as checked: the pair stays unresolved
    // but is retried later (a transient block must not freeze the merge set).
    assert.deepEqual(map.wikidata.checked, {});
    assert.ok(map.wikidata.disabledUntil);
    const until = Date.parse(map.wikidata.disabledUntil);
    assert.ok(until >= Date.parse('2026-10-28T10:02:00Z'), map.wikidata.disabledUntil);

    // Cooldown: the next automatic pass costs nothing.
    const again = await bridge.resolveAuthorsWikidata(
      [{ name: 'Говард Лавкрафт' }, { name: 'H. P. Lovecraft' }],
      {
        fetchImpl: async () => {
          calls++;
          return blocked;
        },
        sleep: async () => {},
        pauseMs: 0,
        now: () => Date.parse('2026-10-28T10:05:00Z'),
      }
    );
    assert.equal(again.reason, 'cooldown');
    assert.equal(calls, 1);

    // …and `--force` (manual backfill) is not held by the cooldown.
    const forced = await bridge.resolveAuthorsWikidata(
      [{ name: 'Говард Лавкрафт' }, { name: 'H. P. Lovecraft' }],
      {
        fetchImpl: async () => {
          calls++;
          return blocked;
        },
        sleep: async () => {},
        pauseMs: 0,
        force: true,
        now: () => Date.parse('2026-10-28T10:05:00Z'),
      }
    );
    assert.equal(forced.reason, 'degraded');
    assert.equal(calls, 2);
  });

  test('a network failure degrades to the offline result (no throw into the payload)', async () => {
    bookCache.clearMemory();
    fs.rmSync(bookCache.AUTHORS_PATH, { force: true });
    const report = await bridge.resolveAuthorsWikidata(
      [{ name: 'Сьюзан Кинг' }, { name: 'Stephen King' }],
      {
        fetchImpl: async () => {
          throw new Error('EAI_AGAIN');
        },
        sleep: async () => {},
        pauseMs: 0,
      }
    );
    assert.equal(report.ran, false);
    assert.equal(report.reason, 'error');
    assert.match(report.error, /EAI_AGAIN/);
    const map = bookCache.getAuthorsMap();
    assert.ok(map.wikidata.disabledUntil);
    // The known false-merge traps stay apart: nothing was written.
    const grouped = authors.groupAuthors(
      [{ name: 'Сьюзан Кинг', workId: 'a' }, { name: 'Stephen King', workId: 'b' }],
      map
    );
    assert.equal(grouped.groups.length, 2);
  });

  test('a manual edit survives an automatic Wikidata pass', async () => {
    bookCache.clearMemory();
    fs.rmSync(bookCache.AUTHORS_PATH, { force: true });
    await bookCache.saveAuthorsMap({
      canonical: {},
      manual: { 'джоан роулинг': 'Джоан Роулинг' },
    });
    // «Роберт Гэлбрейт» is a real Wikidata alias of J. K. Rowling: a merge the
    // transliteration rule cannot prove.
    const { fetchImpl } = mockWikidata({
      labels: { 'Джоан Роулинг': ['Q34660'], 'Роберт Гэлбрейт': ['Q34660'] },
      qids: { Q34660: ['Джоан Роулинг', 'Роберт Гэлбрейт', 'J. K. Rowling'] },
    });
    const report = await bridge.resolveAuthorsWikidata(
      [{ name: 'Джоан Роулинг' }, { name: 'Роберт Гэлбрейт' }],
      { fetchImpl, sleep: async () => {}, pauseMs: 0 }
    );
    assert.equal(report.ran, true);
    assert.equal(report.merged, 1);
    const map = bookCache.getAuthorsMap();
    assert.equal(map.manual['джоан роулинг'], 'Джоан Роулинг');
    const grouped = authors.groupAuthors(
      [{ name: 'Джоан Роулинг', workId: 'a' }, { name: 'Роберт Гэлбрейт', workId: 'b' }],
      map
    );
    assert.equal(grouped.groups.length, 1);
    // The human decision beats both the English preference and the Wikidata
    // display pick.
    assert.equal(grouped.groups[0].name, 'Джоан Роулинг');
  });

  test('an ambiguous label (two QIDs) is not merged', async () => {
    bookCache.clearMemory();
    fs.rmSync(bookCache.AUTHORS_PATH, { force: true });
    // «Моэм» alone is a surname with no given name: the offline rule leaves it
    // apart from «Уильям Сомерсет Моэм», so both reach WDQS. WDQS knows two
    // people by that label, so nothing may be merged on its word alone.
    const { fetchImpl } = mockWikidata({
      labels: { 'Моэм': ['Q1348', 'Q9'], 'Уильям Сомерсет Моэм': ['Q1348'] },
      qids: {
        Q1348: ['Моэм', 'Уильям Сомерсет Моэм'],
        Q9: ['Моэм', 'Сомерсет Моэм'],
      },
    });
    const report = await bridge.resolveAuthorsWikidata(
      [{ name: 'Моэм' }, { name: 'Уильям Сомерсет Моэм' }],
      { fetchImpl, sleep: async () => {}, pauseMs: 0 }
    );
    assert.equal(report.ran, true);
    assert.equal(report.merged, 0);
    const map = bookCache.getAuthorsMap();
    assert.deepEqual(map.canonical, {});
  });

  test('buildBooksStats kicks the bridge without waiting for it', async () => {
    bookCache.clearMemory();
    fs.rmSync(bookCache.AUTHORS_PATH, { force: true });
    const profile = 'Kick';
    await bookCache.saveProfile('livelib', profile, {
      schemaVersion: 1,
      source: 'livelib',
      userKey: profile,
      sourceUserId: null,
      importedAt: '2026-10-28T00:00:00.000Z',
      warnings: [],
      events: [
        {
          id: 'll:1',
          source: 'livelib',
          sourceBookId: '1',
          title: 'Луна и грош',
          authors: [MOEM_RU],
          status: 'read',
          shelf: 'read',
          origin: 'livelib-file',
          finishedAt: '2020-01-02',
          edition: {},
          genres: [],
        },
      ],
    });
    let captured = null;
    const stats = buildBooksStats({
      profile: `livelib-${profile}`,
      includeMangaComics: true,
      authorBridge: (entries, options) => {
        captured = { entries, options };
        return Promise.resolve();
      },
    });
    assert.ok(stats && stats.summary, 'payload is returned even though the bridge would be async');
    assert.ok(captured, 'the bridge was called');
    assert.ok(captured.entries.some((entry) => entry.name === MOEM_RU));
    assert.ok(Array.isArray(captured.options.groups), 'the payload grouping is reused');
    assert.ok(captured.options.persisted && 'canonical' in captured.options.persisted);

    // A throwing bridge must not break the payload either.
    const safe = buildBooksStats({
      profile: `livelib-${profile}`,
      includeMangaComics: true,
      authorBridge: () => {
        throw new Error('bridge exploded');
      },
    });
    assert.equal(safe.summary.bookCount, 1);
  });

  test('the author WDQS client asks without a deadline (timeoutMs: 0)', async () => {
    let init = null;
    const fetchImpl = async (url, options) => {
      init = options;
      return {
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({ results: { bindings: [] } }),
      };
    };
    await authorsWikidata.fetchNameQids(['Моэм'], { fetchImpl });
    assert.ok(init, 'WDQS was asked');
    assert.equal(init.signal, undefined, 'a 15 s default deadline must not be installed');
  });
  after(() => env.resetMutableState());
});
