'use strict';

const { describe, after } = require('node:test');
const env = require('./helpers/env');

const run = env.makeTmpCache('books-year-challenger', { budgets: false });

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
const wikidata = require('../server/books/providers/wikidata');
const yearsBackfill = require('../server/books/years-backfill');
const { surnameSimilarity } = require('../server/books/providers/match');
const {
  yearTargets,
  patchYearClaims,
} = require('../server/books/resolve-stages/year-stage');
const { keepYearClaim } = require('../server/books/resolve-stages/chain');

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
    sitelinks: text(options.sitelinks == null ? 10 : options.sitelinks),
    p577: text(options.p577),
    p577Prec: text(options.p577Prec),
    p571: text(options.p571),
    p571Prec: text(options.p571Prec),
  };
}

function sparqlStub(rows) {
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    url,
    headers: { get: () => null },
    text: async () => JSON.stringify({ results: { bindings: rows } }),
    json: async () => ({ results: { bindings: rows } }),
  });
  return fetchImpl;
}

function yearProvider(claims) {
  const entries = [];
  return {
    entries,
    async lookupTitles(list) {
      entries.push(...list);
      const byKey = new Map();
      const asked = new Set();
      for (const entry of list) {
        const key = String(entry.key);
        asked.add(key);
        const claim = claims[key];
        if (!claim) continue;
        byKey.set(key, {
          source: 'wikidata',
          sourceId: `Q${key.length}`,
          firstPublishedYear: claim.year,
          firstPublishedYearPrecision: claim.precision || 'year',
          firstPublishedYearKind: claim.kind || 'publication',
          authorBirthYear: claim.authorBirthYear == null ? null : claim.authorBirthYear,
          match: claim.match || { method: 'title', exact: true, authorHit: true },
        });
      }
      return { byKey, asked, skipped: null, queries: 1 };
    },
  };
}

function silentProvider(name) {
  const calls = [];
  const options = [];
  return {
    NAME: name,
    calls,
    options,
    isBreakerOpen: () => false,
    async getWork(input, opts) {
      calls.push(input);
      options.push(opts || {});
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

function planOf(workId, event) {
  return {
    events: [event],
    links: new Map([[String(event.sourceBookId), { workId }]]),
  };
}

function ctxFor(plan, provider) {
  return {
    plan,
    cache: bookCache,
    now: '2026-11-12T00:00:00.000Z',
    budget: { wikidata: { limit: 10, used: 0, take: () => true } },
    report: {},
    options: { wikidataProvider: provider, sleep: noSleep },
  };
}

describe('books-year-challenger', () => {
  describe('cross-language author gate', () => {
    test('the surname similarity of the measured pairs clears the threshold', () => {
      assert.equal(surnameSimilarity('Tolstoy', 'Толстой'), 1);
      assert.equal(surnameSimilarity('Orwell', 'Оруэлл'), 0.75);
      assert.equal(surnameSimilarity('Chekhov', 'Чехов'), 1);
      assert.equal(surnameSimilarity('Gallico', 'Гэллико'), 0.75);
    });

    test('a Latin author matches the Russian Wikidata label', () => {
      assert.equal(wikidata.authorHit('Лев Николаевич Толстой', ['Leo Tolstoy']), true);
      assert.equal(wikidata.authorHit('Джордж Оруэлл', ['George Orwell']), true);
      assert.equal(wikidata.authorHit('Антон Павлович Чехов', ['Anton Chekhov']), true);
      assert.equal(wikidata.authorHit('Пол Гэллико', ['Paul Gallico']), true);
    });

    test('the fuzzy path does not turn a foreign author into a match', () => {
      assert.equal(wikidata.authorHit('Иван Тургенев', ['Ю. Яковлева']), false);
      assert.equal(wikidata.authorHit('Лев Толстой', ['Ю. Яковлева']), false);
    });

    test('a cross-language candidate survives the whole lookup', async () => {
      const fetchImpl = sparqlStub([
        row({
          label: 'Война и мир',
          item: 'Q161227',
          authorLabel: 'Лев Николаевич Толстой',
          p577: '1869-01-01T00:00:00Z',
          p577Prec: 9,
        }),
      ]);
      const found = await wikidata.lookupTitles(
        [{ key: 'w1', title: 'Война и мир', authors: ['Leo Tolstoy'] }],
        { fetchImpl, sleep: noSleep, pauseMs: 0 }
      );
      const result = found.byKey.get('w1');
      assert.ok(result);
      assert.equal(result.firstPublishedYear, 1869);
      assert.equal(result.match.authorHit, true);
    });

    test('a single candidate owned by another author is still rejected', async () => {
      const fetchImpl = sparqlStub([
        row({
          label: 'Бретёр',
          item: 'Q111',
          authorLabel: 'Иван Тургенев',
          p577: '1847-01-01T00:00:00Z',
          p577Prec: 9,
        }),
      ]);
      const found = await wikidata.lookupTitles(
        [{ key: 'w2', title: 'Бретёр', authors: ['Ю. Яковлева'] }],
        { fetchImpl, sleep: noSleep, pauseMs: 0 }
      );
      assert.equal(found.byKey.get('w2'), null);
    });
  });

  describe('year stage challenges a print-run claim', () => {
    test('a hardcover 1998 claim is replaced by the 1970 Wikidata year', async () => {
      await seed('hc:9901', {
        title: 'Чайка Джонатан Ливингстон',
        authors: [{ name: 'Ричард Бах' }],
        genres: ['проза'],
        publicationYear: 1998,
        firstPublishedYear: 1998,
        firstPublishedYearSource: 'hardcover',
        firstPublishedYearPrecision: 'year',
        firstPublishedYearKind: 'publication',
      });
      const provider = yearProvider({ 'hc:9901': { year: 1970 } });
      const ctx = ctxFor(
        planOf('hc:9901', {
          sourceBookId: '901',
          title: 'Чайка Джонатан Ливингстон',
          authors: ['Ричард Бах'],
        }),
        provider
      );

      assert.equal(yearTargets(ctx).length, 1);
      await patchYearClaims(ctx);

      const saved = bookCache.getWorkDetails('hc:9901');
      assert.equal(saved.firstPublishedYear, 1970);
      assert.equal(saved.firstPublishedYearSource, 'wikidata');
      assert.equal(saved.firstPublishedYearChallengedBy, 'hardcover');
      assert.equal(saved.firstPublishedYearPrevious, 1998);
      assert.equal(saved.firstPublishedYearCheckedBy, 'wikidata');
      assert.equal(saved.firstPublishedYearCheckedAt, '2026-11-12T00:00:00.000Z');
      assert.deepEqual(saved.genres, ['проза']);
      assert.equal(saved.publicationYear, 1998);
      assert.equal(ctx.report.yearCandidates, 1);
      assert.equal(ctx.report.yearChallenged, 1);
      assert.equal(ctx.report.yearCorrected, 1);
      assert.equal(ctx.report.yearClaims, 1);
    });

    test('an equal year only wins by a more precise claim', async () => {
      await seed('hc:9902', {
        title: 'Занавес',
        authors: [{ name: 'Агата Кристи' }],
        publicationYear: 1975,
        firstPublishedYear: 1970,
        firstPublishedYearSource: 'litres',
        firstPublishedYearPrecision: 'decade',
        firstPublishedYearKind: 'publication',
      });
      const provider = yearProvider({ 'hc:9902': { year: 1970, precision: 'year' } });
      const ctx = ctxFor(
        planOf('hc:9902', { sourceBookId: '902', title: 'Занавес', authors: ['Агата Кристи'] }),
        provider
      );

      await patchYearClaims(ctx);

      const saved = bookCache.getWorkDetails('hc:9902');
      assert.equal(saved.firstPublishedYear, 1970);
      assert.equal(saved.firstPublishedYearSource, 'wikidata');
      assert.equal(saved.firstPublishedYearPrecision, 'year');
      assert.equal(saved.firstPublishedYearChallengedBy, 'litres');
      assert.equal(saved.firstPublishedYearPrevious, 1970);
      assert.equal(ctx.report.yearCorrected, 1);
    });

    test('a later claim is noise and is not written', async () => {
      await seed('hc:9903', {
        title: 'Агнес Грей',
        authors: [{ name: 'Энн Бронте' }],
        publicationYear: 1998,
        firstPublishedYear: 1847,
        firstPublishedYearSource: 'openlibrary',
        firstPublishedYearPrecision: 'year',
      });
      const provider = yearProvider({ 'hc:9903': { year: 1998 } });
      const ctx = ctxFor(
        planOf('hc:9903', { sourceBookId: '903', title: 'Агнес Грей', authors: ['Энн Бронте'] }),
        provider
      );

      await patchYearClaims(ctx);

      const saved = bookCache.getWorkDetails('hc:9903');
      assert.equal(saved.firstPublishedYear, 1847);
      assert.equal(saved.firstPublishedYearSource, 'openlibrary');
      assert.equal(saved.firstPublishedYearChallengedBy, undefined);
      assert.equal(saved.firstPublishedYearPrevious, undefined);
      assert.equal(ctx.report.yearChallenged, 1);
      assert.equal(ctx.report.yearCorrected, 0);
      assert.equal(ctx.report.yearClaims, 0);
    });

    test('a challenge without author confirmation is rejected', async () => {
      await seed('hc:9906', {
        title: 'Цыганка',
        authors: [{ name: 'Агата Кристи' }],
        publicationYear: 2022,
        firstPublishedYear: 2022,
        firstPublishedYearSource: 'hardcover',
        firstPublishedYearPrecision: 'year',
      });
      const provider = yearProvider({
        'hc:9906': { year: 1850, match: { method: 'title', exact: true, authorHit: false } },
      });
      const ctx = ctxFor(
        planOf('hc:9906', { sourceBookId: '906', title: 'Цыганка', authors: ['Агата Кристи'] }),
        provider
      );

      await patchYearClaims(ctx);

      const saved = bookCache.getWorkDetails('hc:9906');
      assert.equal(saved.firstPublishedYear, 2022);
      assert.equal(saved.firstPublishedYearSource, 'hardcover');
      assert.equal(saved.firstPublishedYearChallengedBy, undefined);
      assert.equal(ctx.report.yearCorrected, 0);
    });

    test('an unconfirmed claim may still fill an empty year', async () => {
      await seed('hc:9907', {
        title: 'Цыганка',
        authors: [{ name: 'Агата Кристи' }],
        publicationYear: 2022,
      });
      const provider = yearProvider({
        'hc:9907': { year: 1850, match: { method: 'title', exact: true, authorHit: false } },
      });
      const ctx = ctxFor(
        planOf('hc:9907', { sourceBookId: '907', title: 'Цыганка', authors: ['Агата Кристи'] }),
        provider
      );

      await patchYearClaims(ctx);

      const saved = bookCache.getWorkDetails('hc:9907');
      assert.equal(saved.firstPublishedYear, 1850);
      assert.equal(saved.firstPublishedYearSource, 'wikidata');
    });

    test('a wikidata claim is never re-asked', async () => {
      await seed('hc:9904', {
        title: 'Ребекка',
        authors: [{ name: 'Дафна дю Морье' }],
        publicationYear: 2010,
        firstPublishedYear: 1938,
        firstPublishedYearSource: 'wikidata',
        firstPublishedYearPrecision: 'year',
      });
      const provider = yearProvider({ 'hc:9904': { year: 1900 } });
      const ctx = ctxFor(
        planOf('hc:9904', { sourceBookId: '904', title: 'Ребекка', authors: ['Дафна дю Морье'] }),
        provider
      );

      assert.equal(yearTargets(ctx).length, 0);
      await patchYearClaims(ctx);

      assert.equal(provider.entries.length, 0);
      assert.equal(ctx.report.yearCandidates, 0);
      assert.equal(ctx.report.yearChallenged, 0);
      const saved = bookCache.getWorkDetails('hc:9904');
      assert.equal(saved.firstPublishedYear, 1938);
      assert.equal(saved.firstPublishedYearSource, 'wikidata');
    });

    test('a manual year is never re-asked', async () => {
      await seed('hc:9905', {
        title: 'Своя дата',
        authors: [{ name: 'Автор' }],
        publicationYear: 2001,
        yearSource: 'manual',
        firstPublishedYear: 2001,
        firstPublishedYearSource: 'hardcover',
        firstPublishedYearPrecision: 'year',
      });
      const ctx = ctxFor(
        planOf('hc:9905', { sourceBookId: '905', title: 'Своя дата', authors: ['Автор'] }),
        yearProvider({})
      );

      assert.equal(yearTargets(ctx).length, 0);
    });

    test('a re-resolve that knows nothing keeps the challenge audit', () => {
      const kept = keepYearClaim(
        {
          firstPublishedYear: 1970,
          firstPublishedYearSource: 'wikidata',
          firstPublishedYearChallengedBy: 'hardcover',
          firstPublishedYearPrevious: 1998,
        },
        { title: 'Чайка Джонатан Ливингстон', firstPublishedYear: null }
      );
      assert.equal(kept.firstPublishedYear, 1970);
      assert.equal(kept.firstPublishedYearPrevious, 1998);
      assert.equal(kept.firstPublishedYearChallengedBy, 'hardcover');
    });
  });

  describe('years backfill', () => {
    test('the Wikidata question carries the event author, not the provider spelling', async () => {
      await seed('hc:9906', {
        title: 'Степной волк',
        authors: [{ name: 'Khoffman' }],
        publicationYear: 2015,
      });
      await bookCache.saveProfile('livelib', 'Challenger', {
        schemaVersion: 1,
        source: 'livelib',
        userKey: 'Challenger',
        importedAt: '2026-11-12T00:00:00.000Z',
        events: [
          {
            sourceBookId: '906',
            title: 'Степной волк',
            authors: ['Герман Гессе'],
            status: 'read',
          },
        ],
        warnings: [],
      });
      await bookCache.saveLink('906', {
        schemaVersion: 2,
        livelibBookId: '906',
        workId: 'hc:9906',
        method: 'isbn',
        score: 1,
      });

      const provider = yearProvider({ 'hc:9906': { year: 1927 } });
      const litres = silentProvider('litres');
      const report = await yearsBackfill.backfill({
        ids: ['hc:9906'],
        wikidataProvider: provider,
        litresProvider: litres,
        hardcoverProvider: silentProvider('hardcover'),
        openlibraryProvider: silentProvider('openlibrary'),
        log: () => {},
        sleep: noSleep,
        pause: 0,
        now: '2026-11-12T00:00:00.000Z',
      });

      const entry = provider.entries.find((item) => item.key === 'hc:9906');
      assert.deepEqual(entry.authors, ['Герман Гессе']);
      assert.deepEqual(litres.calls[0].authors, ['Герман Гессе']);
      assert.equal(report.resolved.length, 1);
      assert.equal(report.resolved[0].year, 1927);
      assert.equal(bookCache.getWorkDetails('hc:9906').firstPublishedYear, 1927);
    });

    test('a stored print claim loses to an earlier provider year', async () => {
      await seed('hc:9907', {
        title: 'Чайка Джонатан Ливингстон',
        authors: [{ name: 'Ричард Бах' }],
        genres: ['проза'],
        publicationYear: 1998,
        firstPublishedYear: 1998,
        firstPublishedYearSource: 'hardcover',
        firstPublishedYearPrecision: 'year',
        firstPublishedYearKind: 'publication',
      });
      const provider = yearProvider({ 'hc:9907': { year: 1970 } });
      const report = await yearsBackfill.backfill({
        ids: ['hc:9907'],
        wikidataProvider: provider,
        litresProvider: silentProvider('litres'),
        hardcoverProvider: silentProvider('hardcover'),
        openlibraryProvider: silentProvider('openlibrary'),
        log: () => {},
        sleep: noSleep,
        pause: 0,
        now: '2026-11-12T00:00:00.000Z',
      });

      const saved = bookCache.getWorkDetails('hc:9907');
      assert.equal(saved.firstPublishedYear, 1970);
      assert.equal(saved.firstPublishedYearSource, 'wikidata');
      assert.equal(saved.firstPublishedYearChallengedBy, 'hardcover');
      assert.equal(saved.firstPublishedYearPrevious, 1998);
      assert.deepEqual(saved.genres, ['проза']);
      assert.equal(report.yearChallenged, 1);
      assert.equal(report.yearCorrected, 1);
    });

    test('a print claim with nothing earlier keeps its year and gets the marker', async () => {
      await seed('hc:9908', {
        title: 'Агнес Грей',
        authors: [{ name: 'Энн Бронте' }],
        publicationYear: 1998,
        firstPublishedYear: 1847,
        firstPublishedYearSource: 'openlibrary',
        firstPublishedYearPrecision: 'year',
      });
      const provider = yearProvider({ 'hc:9908': { year: 1900 } });
      const report = await yearsBackfill.backfill({
        ids: ['hc:9908'],
        wikidataProvider: provider,
        litresProvider: silentProvider('litres'),
        hardcoverProvider: silentProvider('hardcover'),
        openlibraryProvider: silentProvider('openlibrary'),
        log: () => {},
        sleep: noSleep,
        pause: 0,
        now: '2026-11-12T00:00:00.000Z',
      });

      const saved = bookCache.getWorkDetails('hc:9908');
      assert.equal(saved.firstPublishedYear, 1847);
      assert.equal(saved.firstPublishedYearSource, 'openlibrary');
      assert.equal(saved.firstPublishedYearChallengedBy, undefined);
      assert.equal(saved.firstPublishedYearCheckedAt, '2026-11-12T00:00:00.000Z');
      assert.equal(saved.firstPublishedYearCheckedBy, 'litres,openlibrary,wikidata');
      assert.equal(report.yearChallenged, 1);
      assert.equal(report.yearCorrected, 0);
      assert.equal(report.resolved.length, 0);
    });
  });
});
