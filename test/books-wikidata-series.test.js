'use strict';

const { describe, after } = require('node:test');
const env = require('./helpers/env');

const run = env.makeTmpCache('books-wikidata-series', { budgets: false });

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
process.env.KINOBOXD_BOOKS_FANTLAB = '0';

const bookCache = require('../server/books/book-cache');
const wikidata = require('../server/books/providers/wikidata');
const yearsBackfill = require('../server/books/years-backfill');
const {
  hasSeries,
  seriesOfResult,
  needsSeriesQuestion,
  seriesPatch,
} = require('../server/books/series-stage');

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
    author: options.author ? entity(options.author) : undefined,
    authorLabel: text(options.authorLabel),
    sitelinks: text(options.sitelinks == null ? 10 : options.sitelinks),
    p577: text(options.p577),
    p577Prec: text(options.p577Prec),
    p571: text(options.p571),
    p571Prec: text(options.p571Prec),
    seriesLabel: text(options.seriesLabel),
    ordinal: text(options.ordinal),
    canonical: options.canonical ? entity(options.canonical) : undefined,
    canonicalLabel: text(options.canonicalLabel),
    canonicalP577: text(options.canonicalP577),
    canonicalP577Prec: text(options.canonicalP577Prec),
    canonicalP571: text(options.canonicalP571),
    canonicalP571Prec: text(options.canonicalP571Prec),
    canonicalSeriesLabel: text(options.canonicalSeriesLabel),
    canonicalOrdinal: text(options.canonicalOrdinal),
  };
}

function sparqlStub(batches) {
  let call = 0;
  return async (url) => {
    const rows = batches[Math.min(call, batches.length - 1)];
    call++;
    const payload = { results: { bindings: rows } };
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url,
      headers: { get: () => null },
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    };
  };
}

describe('wikidata series channel', () => {
  test('a P179 membership and its ordinal travel with the year claim', async () => {
    const fetchImpl = sparqlStub([
      [
        row({
          label: 'Объявлено убийство',
          item: 'Q745079',
          author: 'Q35064',
          authorLabel: 'Агата Кристи',
          p577: '1950-01-01T00:00:00Z',
          p577Prec: 9,
          seriesLabel: 'Мисс Марпл',
          ordinal: '4',
        }),
      ],
      [],
    ]);
    const found = await wikidata.lookupTitles(
      [{ key: 'w1', title: 'Объявлено убийство', authors: ['Агата Кристи'] }],
      { fetchImpl, sleep: noSleep, pauseMs: 0 }
    );
    const result = found.byKey.get('w1');
    assert.ok(result);
    assert.equal(result.firstPublishedYear, 1950);
    assert.deepEqual(result.seriesAll, [
      { name: 'Мисс Марпл', position: 4, source: 'wikidata' },
    ]);
    assert.equal(result.wikidataWorkId, 'Q745079');
    assert.deepEqual(result.wikidataAuthorIds, [{ name: 'Агата Кристи', qid: 'Q35064' }]);
  });

  test('an edition takes the series of its canonical work', async () => {
    const fetchImpl = sparqlStub([
      [
        row({
          label: 'Немезида',
          item: 'Q999',
          author: 'Q35064',
          authorLabel: 'Агата Кристи',
          p577: '2019-01-01T00:00:00Z',
          p577Prec: 9,
        }),
      ],
      [
        row({
          item: 'Q999',
          label: 'Немезида',
          canonical: 'Q1170245',
          canonicalLabel: 'Немезида',
          canonicalP577: '1972-01-01T00:00:00Z',
          canonicalP577Prec: 9,
          canonicalSeriesLabel: 'Мисс Марпл',
          canonicalOrdinal: '11',
        }),
      ],
    ]);
    const found = await wikidata.lookupTitles(
      [{ key: 'w2', title: 'Немезида', authors: ['Агата Кристи'] }],
      { fetchImpl, sleep: noSleep, pauseMs: 0 }
    );
    const result = found.byKey.get('w2');
    assert.ok(result);
    assert.equal(result.firstPublishedYear, 1972);
    assert.deepEqual(result.seriesAll, [
      { name: 'Мисс Марпл', position: 11, source: 'wikidata' },
    ]);
  });

  test('an item without P179 reports no series', async () => {
    const fetchImpl = sparqlStub([
      [
        row({
          label: 'Скотный двор',
          item: 'Q1396889',
          author: 'Q3335',
          authorLabel: 'Джордж Оруэлл',
          p577: '1945-01-01T00:00:00Z',
          p577Prec: 9,
        }),
      ],
      [],
    ]);
    const found = await wikidata.lookupTitles(
      [{ key: 'w3', title: 'Скотный двор', authors: ['Джордж Оруэлл'] }],
      { fetchImpl, sleep: noSleep, pauseMs: 0 }
    );
    assert.deepEqual(found.byKey.get('w3').seriesAll, []);
  });
});

describe('series fill rules', () => {
  const now = '2026-11-12T00:00:00.000Z';
  const withSeries = { series: [{ name: 'Своя серия', position: 1 }] };
  const withoutSeries = { title: 'Книга', series: [] };
  const result = { seriesAll: [{ name: 'Мисс Марпл', position: 4 }] };

  test('an existing series is never replaced', () => {
    assert.equal(hasSeries(withSeries), true);
    assert.equal(seriesPatch(withSeries, result, { now, asked: true }), null);
  });

  test('a series-less document takes the Wikidata series and a marker', () => {
    const patch = seriesPatch(withoutSeries, result, { now, asked: true });
    assert.deepEqual(patch.series, [
      { hcId: null, name: 'Мисс Марпл', position: 4, source: 'wikidata' },
    ]);
    assert.equal(patch.seriesCheckedBy, 'wikidata');
    assert.equal(patch.seriesCheckedAt, now);
  });

  test('asking without an answer marks the document, not the document body', () => {
    const patch = seriesPatch(withoutSeries, null, { now, asked: true });
    assert.equal(patch.series, undefined);
    assert.equal(patch.seriesCheckedAt, now);
  });

  test('a document that was not asked is left alone', () => {
    assert.equal(seriesPatch(withoutSeries, null, { now, asked: false }), null);
  });

  test('the marker keeps a hopeless document out of the queue for 30 days', () => {
    const doc = { series: [], seriesCheckedAt: now };
    const nowMs = Date.parse(now);
    assert.equal(needsSeriesQuestion(doc, nowMs + 1000, 30), false);
    assert.equal(needsSeriesQuestion(doc, nowMs + 31 * 24 * 60 * 60 * 1000, 30), true);
  });

  test('seriesOfResult ignores an entry without a name', () => {
    assert.equal(seriesOfResult({ seriesAll: [{ name: ' ' }] }), null);
    assert.deepEqual(seriesOfResult({ seriesAll: [{ name: 'Дюна', position: 0 }] }), {
      hcId: null,
      name: 'Дюна',
      position: null,
      source: 'wikidata',
    });
  });
});

describe('backfill fills a series without touching the year', () => {
  test('a dated work without a series is selected, gets the series, then rests for 30 days', async () => {
    await bookCache.saveDetails(bookCache.detailsKeyForWork('hc:9701'), {
      schemaVersion: 2,
      workId: 'hc:9701',
      hcWorkId: 9701,
      title: 'Объявлено убийство',
      authors: [{ name: 'Агата Кристи' }],
      series: [],
      genres: ['детектив'],
      publicationYear: 2011,
      firstPublishedYear: 1950,
      firstPublishedYearSource: 'wikidata',
      firstPublishedYearCheckedAt: '2026-10-01T00:00:00.000Z',
      firstPublishedYearCheckedBy: 'wikidata',
    });
    const provider = {
      async lookupTitles(list) {
        const byKey = new Map();
        const asked = new Set();
        for (const entry of list) {
          asked.add(String(entry.key));
          byKey.set(String(entry.key), {
            source: 'wikidata',
            sourceId: 'Q745079',
            workId: 'wd:Q745079',
            firstPublishedYear: 1950,
            firstPublishedYearPrecision: 'year',
            firstPublishedYearKind: 'publication',
            seriesAll: [{ name: 'Мисс Марпл', position: 4, source: 'wikidata' }],
            wikidataWorkId: 'Q745079',
            match: { method: 'title', exact: true, authorHit: true },
          });
        }
        return { byKey, asked, skipped: null, queries: 1 };
      },
    };
    const report = await yearsBackfill.backfill({
      limit: 5,
      dryRun: false,
      now: '2026-11-12T00:00:00.000Z',
      recheckDays: 30,
      wikidataProvider: provider,
      hardcoverProvider: { getWork: async () => null },
      litresProvider: { getWork: async () => null, isBreakerOpen: () => false },
      openlibraryProvider: { getWork: async () => null },
      budget: { take: () => true, used: 0, remaining: 0, limit: 0 },
      sleep: noSleep,
      log: () => {},
    });
    assert.equal(report.seriesFilled, 1);

    const saved = bookCache.getWorkDetails('hc:9701');
    assert.deepEqual(saved.series, [
      { hcId: null, name: 'Мисс Марпл', position: 4, source: 'wikidata' },
    ]);
    assert.equal(saved.seriesCheckedBy, 'wikidata');
    assert.equal(saved.firstPublishedYear, 1950, 'the year is not re-challenged');
    assert.deepEqual(saved.genres, ['детектив']);
    assert.equal(saved.publicationYear, 2011);

    const second = await yearsBackfill.backfill({
      limit: 5,
      dryRun: true,
      now: '2026-11-13T00:00:00.000Z',
      recheckDays: 30,
      wikidataProvider: provider,
      hardcoverProvider: { getWork: async () => null },
      litresProvider: { getWork: async () => null, isBreakerOpen: () => false },
      openlibraryProvider: { getWork: async () => null },
      budget: { take: () => true, used: 0, remaining: 0, limit: 0 },
      sleep: noSleep,
      log: () => {},
    });
    assert.equal(second.seriesFilled, 0);
    assert.equal(second.seriesMissed, 0);
  });
});
