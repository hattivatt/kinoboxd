'use strict';

/**
 * Books: the Wikidata year channel, end to end.
 *
 * The unit rules of `providers/claim.js` and the query shape of
 * `providers/wikidata.js` have their own files. This one pins the wiring that
 * the live cache exposed:
 *
 *   - a document with no first-publication claim gets one from a batched WDQS
 *     pass, and the claim carries its precision and kind;
 *   - the negative-cache marker names every provider that was asked, so a
 *     provider added later can re-open the verdict (Wikidata did: 201 documents
 *     were marked `none` and could never be re-asked);
 *   - the resolve pass fills a year for works the chain closed without one;
 *   - a re-resolve never deletes a year that was backfilled earlier.
 */

const { describe, after } = require('node:test');
const env = require('./helpers/env');

const run = env.makeTmpCache('books-wikidata-years', { budgets: false });

after(() => {
  env.cleanupTmpDirs();
});

process.on('exit', () => {
  env.cleanupTmpDirs();
});

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;
process.env.KINOBOXD_BOOKS_WIKIDATA = '1';

const bookCache = require('../server/books/book-cache');
const yearsBackfill = require('../server/books/years-backfill');
const wikidata = require('../server/books/providers/wikidata');
const { keepYearClaim } = require('../server/books/resolve-stages/chain');
const { yearTargets, applyClaim, patchYearClaims } = require('../server/books/resolve-stages/year-stage');

const noSleep = async () => {};

function entity(id) {
  return { value: `http://www.wikidata.org/entity/${id}` };
}

function text(value) {
  return value == null ? undefined : { value: String(value) };
}

function row(options) {
  return {
    label: text(options.label),
    item: entity(options.item),
    itemLabel: text(options.itemLabel || options.label),
    authorLabel: text(options.authorLabel),
    sitelinks: options.sitelinks == null ? undefined : text(options.sitelinks),
    p577: text(options.p577),
    p577Prec: text(options.p577Prec),
    p571: text(options.p571),
    p571Prec: text(options.p571Prec),
    canonical: options.canonical ? entity(options.canonical) : undefined,
    canonicalLabel: text(options.canonicalLabel),
    canonicalP577: text(options.canonicalP577),
    canonicalP577Prec: text(options.canonicalP577Prec),
    canonicalP571: text(options.canonicalP571),
    canonicalP571Prec: text(options.canonicalP571Prec),
  };
}

function sparqlStub(rows) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init && init.body ? String(init.body) : '' });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url,
      headers: { get: () => null },
      text: async () => JSON.stringify({ results: { bindings: rows } }),
      json: async () => ({ results: { bindings: rows } }),
    };
  };
  return { fetchImpl, calls };
}

function silentProvider(name) {
  const calls = [];
  return {
    NAME: name,
    calls,
    isBreakerOpen: () => false,
    async getWork(input) {
      calls.push(input);
      return null;
    },
  };
}

async function seed(workId, doc) {
  await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), {
    schemaVersion: 2,
    ...doc,
    workId,
  });
}

describe('books-wikidata-years', () => {
  test('a composition date is written with its kind, and the marker names Wikidata', async () => {
    await seed('lr:8201', {
      title: 'Слово о полку Игореве',
      authors: [{ name: 'Неизвестный автор' }],
      publicationYear: 1984,
    });
    const stub = sparqlStub([
      row({
        label: 'Слово о полку Игореве',
        item: 'Q47504',
        itemLabel: 'Слово о полку Игореве',
        sitelinks: 30,
        p571: '1187-01-01T00:00:00Z',
        p571Prec: 9,
      }),
    ]);
    const report = await yearsBackfill.backfill({
      ids: ['lr:8201'],
      hardcoverProvider: silentProvider('hardcover'),
      litresProvider: silentProvider('litres'),
      openlibraryProvider: silentProvider('openlibrary'),
      wikidataProvider: wikidata,
      fetchImpl: stub.fetchImpl,
      sleep: noSleep,
      pause: 0,
      wikidataPauseMs: 0,
      log: () => {},
      now: '2026-11-12T00:00:00.000Z',
    });

    // Two queries per batch: the label search and the VALUES-bound canonical
    // follow-up (one combined query times out server-side, see the module).
    assert.equal(stub.calls.length, 2, 'two queries per batch, not one per book');
    assert.equal(report.resolved.length, 1);
    assert.equal(report.resolved[0].year, 1187);
    assert.equal(report.resolved[0].source, 'wikidata');
    assert.equal(report.byProvider.wikidata, 1);

    const saved = bookCache.getWorkDetails('lr:8201');
    assert.equal(saved.firstPublishedYear, 1187);
    assert.equal(saved.firstPublishedYearSource, 'wikidata');
    assert.equal(saved.firstPublishedYearPrecision, 'year');
    assert.equal(saved.firstPublishedYearKind, 'composition');
    // A found claim records its own source as the marker; the provider list is
    // only written for the «nobody knows» verdict below.
    assert.equal(saved.firstPublishedYearCheckedBy, 'wikidata');
  });

  test('a century claim keeps its precision instead of faking an exact year', async () => {
    await seed('lr:8202', {
      title: 'Илиада',
      authors: [{ name: 'Гомер' }],
      publicationYear: 2010,
    });
    const stub = sparqlStub([
      row({
        label: 'Илиада',
        item: 'Q8275',
        itemLabel: 'Илиада',
        authorLabel: 'Гомер',
        sitelinks: 90,
        p571: '-0800-00-00T00:00:00Z',
        p571Prec: 7,
      }),
    ]);
    const report = await yearsBackfill.backfill({
      ids: ['lr:8202'],
      hardcoverProvider: silentProvider('hardcover'),
      litresProvider: silentProvider('litres'),
      openlibraryProvider: silentProvider('openlibrary'),
      wikidataProvider: wikidata,
      fetchImpl: stub.fetchImpl,
      sleep: noSleep,
      pause: 0,
      wikidataPauseMs: 0,
      log: () => {},
    });

    assert.equal(report.resolved[0].year, -800);
    const saved = bookCache.getWorkDetails('lr:8202');
    assert.equal(saved.firstPublishedYear, -800);
    assert.equal(saved.firstPublishedYearPrecision, 'century');
    assert.equal(saved.firstPublishedYearKind, 'composition');
  });

  test('a translation is dated by its canonical work, not by its own print run', async () => {
    await seed('lr:8203', {
      title: 'Одиссея',
      authors: [{ name: 'Гомер' }],
      publicationYear: 1997,
    });
    const stub = sparqlStub([
      row({
        label: 'Одиссея',
        item: 'Q697203',
        itemLabel: 'Одиссея',
        authorLabel: 'Гомер',
        sitelinks: 2,
        p577: '1997-01-01T00:00:00Z',
        p577Prec: 9,
        canonical: 'Q35160',
        canonicalLabel: 'Одиссея',
        canonicalP571: '-0700-00-00T00:00:00Z',
        canonicalP571Prec: 7,
      }),
    ]);
    await yearsBackfill.backfill({
      ids: ['lr:8203'],
      hardcoverProvider: silentProvider('hardcover'),
      litresProvider: silentProvider('litres'),
      openlibraryProvider: silentProvider('openlibrary'),
      wikidataProvider: wikidata,
      fetchImpl: stub.fetchImpl,
      sleep: noSleep,
      pause: 0,
      wikidataPauseMs: 0,
      log: () => {},
    });

    const saved = bookCache.getWorkDetails('lr:8203');
    assert.equal(saved.firstPublishedYear, -700, 'P629 date, not the 1997 edition');
    assert.equal(saved.firstPublishedYearPrecision, 'century');
  });

  test('an ambiguous title without an author match stays unanswered', async () => {
    await seed('lr:8204', {
      title: 'Скупой',
      authors: [{ name: 'Неизвестный Николай' }],
      publicationYear: 2018,
    });
    const stub = sparqlStub([
      row({ label: 'Скупой', item: 'Q389933', itemLabel: 'Скупой', authorLabel: 'Мольер', sitelinks: 20, p577: '1668-01-01T00:00:00Z', p577Prec: 9 }),
      row({ label: 'Скупой', item: 'Q19219527', itemLabel: 'Скупой', authorLabel: 'Иван Андреевич Крылов', sitelinks: 1, p577: '1827-01-01T00:00:00Z', p577Prec: 9 }),
    ]);
    const report = await yearsBackfill.backfill({
      ids: ['lr:8204'],
      hardcoverProvider: silentProvider('hardcover'),
      litresProvider: silentProvider('litres'),
      openlibraryProvider: silentProvider('openlibrary'),
      wikidataProvider: wikidata,
      fetchImpl: stub.fetchImpl,
      sleep: noSleep,
      pause: 0,
      wikidataPauseMs: 0,
      log: () => {},
    });

    assert.equal(report.resolved.length, 0);
    assert.equal(report.unknown.length, 1);
    const saved = bookCache.getWorkDetails('lr:8204');
    assert.equal(saved.firstPublishedYear, undefined);
    assert.ok(saved.firstPublishedYearCheckedAt, 'the verdict is still «nobody knows»');
  });

  test('the author match disambiguates a title shared by two works', async () => {
    await seed('lr:8205', {
      title: 'Скупой',
      authors: [{ name: 'Жан-Батист Мольер' }],
      publicationYear: 2018,
    });
    const stub = sparqlStub([
      row({ label: 'Скупой', item: 'Q389933', itemLabel: 'Скупой', authorLabel: 'Мольер', sitelinks: 20, p577: '1668-01-01T00:00:00Z', p577Prec: 9 }),
      row({ label: 'Скупой', item: 'Q19219527', itemLabel: 'Скупой', authorLabel: 'Иван Андреевич Крылов', sitelinks: 1, p577: '1827-01-01T00:00:00Z', p577Prec: 9 }),
    ]);
    const report = await yearsBackfill.backfill({
      ids: ['lr:8205'],
      hardcoverProvider: silentProvider('hardcover'),
      litresProvider: silentProvider('litres'),
      openlibraryProvider: silentProvider('openlibrary'),
      wikidataProvider: wikidata,
      fetchImpl: stub.fetchImpl,
      sleep: noSleep,
      pause: 0,
      wikidataPauseMs: 0,
      log: () => {},
    });
    assert.equal(report.resolved.length, 1);
    assert.equal(report.resolved[0].year, 1668);
  });

  test('the marker re-opens a document when the provider set grows', async () => {
    await seed('lr:8206', {
      title: 'Безымянная рукопись',
      publicationYear: 2020,
      firstPublishedYearCheckedAt: '2026-11-01T00:00:00.000Z',
      firstPublishedYearCheckedBy: 'none',
    });
    const stub = sparqlStub([]);
    const report = await yearsBackfill.backfill({
      now: '2026-11-12T00:00:00.000Z',
      hardcoverProvider: silentProvider('hardcover'),
      litresProvider: silentProvider('litres'),
      openlibraryProvider: silentProvider('openlibrary'),
      wikidataProvider: wikidata,
      fetchImpl: stub.fetchImpl,
      sleep: noSleep,
      pause: 0,
      wikidataPauseMs: 0,
      log: () => {},
    });
    assert.ok(
      report.checked >= 1,
      'a marker that predates Wikidata is not a verdict for it'
    );
    assert.equal(stub.calls.length >= 1, true);
  });

  test('keepYearClaim keeps a backfilled year when a re-resolve knows nothing', () => {
    const previous = {
      title: 'Ребекка',
      publicationYear: 2010,
      firstPublishedYear: 1938,
      firstPublishedYearSource: 'wikidata',
      firstPublishedYearPrecision: 'year',
      firstPublishedYearKind: 'publication',
      firstPublishedYearCheckedAt: '2026-11-12T00:00:00.000Z',
      firstPublishedYearCheckedBy: 'wikidata',
    };
    const fresh = { title: 'Ребекка', publicationYear: 2010, firstPublishedYear: null };
    const kept = keepYearClaim(previous, fresh);
    assert.equal(kept.firstPublishedYear, 1938);
    assert.equal(kept.firstPublishedYearPrecision, 'year');
    assert.equal(kept.firstPublishedYearCheckedBy, 'wikidata');

    const newer = keepYearClaim(previous, { ...fresh, firstPublishedYear: 1938 });
    assert.equal(newer.firstPublishedYearSource, undefined, 'a fresh claim is not overwritten');
    assert.equal(keepYearClaim(null, fresh), fresh);
  });

  test('the resolve pass dates a work the chain closed without a claim', async () => {
    await seed('lr:8301', {
      title: 'Malenʹkie zhenshchiny zamuzhem',
      authors: [{ name: 'Louisa May Alcott' }],
      publicationYear: 2009,
    });
    const ctx = {
      plan: {
        events: [{ sourceBookId: '501', title: 'Маленькие женщины замужем', authors: ['Луиза Мэй Олкотт'] }],
        links: new Map([['501', { workId: 'lr:8301' }]]),
      },
      cache: bookCache,
      now: '2026-11-12T00:00:00.000Z',
      budget: { wikidata: { limit: 10, used: 0, take() { return true; } } },
      report: {},
      options: {},
    };
    const targets = yearTargets(ctx);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].title, 'Маленькие женщины замужем', 'the reader spelling, not the OL one');

    const stub = sparqlStub([
      row({ label: 'Маленькие женщины замужем', item: 'Q1700263', itemLabel: 'Маленькие женщины замужем', authorLabel: 'Луиза Мэй Олкотт', sitelinks: 12, p577: '1869-01-01T00:00:00Z', p577Prec: 9 }),
    ]);
    ctx.options = { wikidataProvider: wikidata, fetchImpl: stub.fetchImpl, sleep: noSleep };
    await patchYearClaims(ctx);

    assert.equal(ctx.report.yearCandidates, 1);
    assert.equal(ctx.report.yearClaims, 1);
    const saved = bookCache.getWorkDetails('lr:8301');
    assert.equal(saved.firstPublishedYear, 1869);
    assert.equal(saved.firstPublishedYearSource, 'wikidata');
    assert.equal(saved.firstPublishedYearPrecision, 'year');
  });

  test('a disabled phase writes nothing and does not claim Wikidata was asked', async () => {
    process.env.KINOBOXD_BOOKS_WIKIDATA = '0';
    try {
      await seed('lr:8401', { title: 'Тихая книга', publicationYear: 2015 });
      const stub = sparqlStub([]);
      const report = await yearsBackfill.backfill({
        ids: ['lr:8401'],
        hardcoverProvider: silentProvider('hardcover'),
        litresProvider: silentProvider('litres'),
        openlibraryProvider: silentProvider('openlibrary'),
        wikidataProvider: wikidata,
        fetchImpl: stub.fetchImpl,
        sleep: noSleep,
        pause: 0,
        log: () => {},
      });
      assert.equal(stub.calls.length, 0, 'no WDQS request when the phase is off');
      const saved = bookCache.getWorkDetails('lr:8401');
      assert.equal(saved.firstPublishedYearCheckedBy, 'litres,openlibrary');
      assert.equal(report.wikidataSkipped, 'disabled');
    } finally {
      process.env.KINOBOXD_BOOKS_WIKIDATA = '1';
    }
  });

  test('applyClaim keeps the rest of the document intact', async () => {
    await seed('lr:8501', {
      title: 'Пиковая дама',
      authors: [{ name: 'Александр Пушкин' }],
      publicationYear: 2019,
      genres: ['Классика'],
      isbn13: '9785000000010',
    });
    const details = bookCache.getWorkDetails('lr:8501');
    await applyClaim(
      { cache: bookCache, now: '2026-11-12T00:00:00.000Z' },
      { workId: 'lr:8501', details },
      {
        source: 'wikidata',
        firstPublishedYear: 1834,
        firstPublishedYearPrecision: 'year',
        firstPublishedYearKind: 'publication',
      }
    );
    const saved = bookCache.getWorkDetails('lr:8501');
    assert.equal(saved.firstPublishedYear, 1834);
    assert.deepEqual(saved.genres, ['Классика']);
    assert.equal(saved.isbn13, '9785000000010');
    assert.equal(saved.publicationYear, 2019);
  });
});
