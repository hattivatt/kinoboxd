'use strict';

/**
 * Books: precision/kind of the first-publication year claim.
 *
 * `details/*.json` may carry `firstPublishedYearPrecision`
 * (`year|decade|century|millennium`) and `firstPublishedYearKind`
 * (`publication|composition`); both are optional and both default to the
 * plain value when a legacy document omits them. The fields describe the
 * *claim*, so `resolveWorkYear` fills them only when it actually returns a
 * `firstPublishedYear` (the `first` branch, and `manual` when the override
 * still echoes a claim) — an edition fallback or an unknown year carries
 * `null` for both, never a precision of a year it does not have.
 *
 * Offline: units on `books/stats/years` plus one seeded integration build
 * (`bookCache.saveDetails`/`saveLink`/`saveProfile` -> `buildBooksStats`);
 * no resolve, no network, no ports.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('./helpers/env');

const run = env.makeTmpCache('books-year-precision');

after(() => {
  env.cleanupTmpDirs();
});

process.on('exit', () => {
  env.cleanupTmpDirs();
});

describe('books-year-precision', () => {
  const years = require('../server/books/stats/years');
  const bookCache = require('../server/books/book-cache');
  const { buildBooksStats } = require('../server/books/stats');

  const {
    firstPublishedYearOf,
    firstPublishedYearPrecisionOf,
    firstPublishedYearKindOf,
    resolveWorkYear,
  } = years;

  function details(extra = {}) {
    return {
      schemaVersion: 2,
      hcWorkId: 9301,
      title: 'Книга',
      authors: [{ hcId: 1, name: 'Автор' }],
      series: [],
      genres: [],
      metadataSources: ['litres'],
      ...extra,
    };
  }

  describe('helpers', () => {
    test('a legacy document without the fields defaults to year/publication', () => {
      assert.equal(firstPublishedYearPrecisionOf(details()), 'year');
      assert.equal(firstPublishedYearKindOf(details()), 'publication');
      assert.equal(firstPublishedYearPrecisionOf(null), 'year');
      assert.equal(firstPublishedYearKindOf(null), 'publication');
    });

    test('valid values survive and are normalized to lower case', () => {
      assert.equal(firstPublishedYearPrecisionOf(details({ firstPublishedYearPrecision: 'Century' })), 'century');
      assert.equal(firstPublishedYearPrecisionOf(details({ firstPublishedYearPrecision: 'millennium' })), 'millennium');
      assert.equal(firstPublishedYearKindOf(details({ firstPublishedYearKind: 'COMPOSITION' })), 'composition');
    });

    test('garbage outside the vocabulary is null, not a default', () => {
      assert.equal(firstPublishedYearPrecisionOf(details({ firstPublishedYearPrecision: 'фу' })), null);
      assert.equal(firstPublishedYearKindOf(details({ firstPublishedYearKind: 'фу' })), null);
      assert.equal(firstPublishedYearPrecisionOf(details({ firstPublishedYearPrecision: '' })), null);
      assert.equal(firstPublishedYearKindOf(details({ firstPublishedYearKind: 'rewritten' })), null);
    });
  });

  describe('resolveWorkYear', () => {
    test('the first branch passes the claim through', () => {
      const yearInfo = resolveWorkYear(
        details({ firstPublishedYear: 1605, firstPublishedYearSource: 'litres', firstPublishedYearPrecision: 'decade', firstPublishedYearKind: 'composition' }),
        null,
        null,
        null
      );
      assert.equal(yearInfo.yearSource, 'first');
      assert.equal(firstPublishedYearOf(details({ firstPublishedYear: 1605 })), 1605);
      assert.equal(yearInfo.firstPublishedYear, 1605);
      assert.equal(yearInfo.firstPublishedYearPrecision, 'decade');
      assert.equal(yearInfo.firstPublishedYearKind, 'composition');
    });

    test('a legacy claim (no precision/kind fields) reads as year/publication', () => {
      const yearInfo = resolveWorkYear(details({ firstPublishedYear: 1954 }), null, null, null);
      assert.equal(yearInfo.yearSource, 'first');
      assert.equal(yearInfo.firstPublishedYearPrecision, 'year');
      assert.equal(yearInfo.firstPublishedYearKind, 'publication');
    });

    test('a garbage claim value yields null precision/kind, not a default', () => {
      const yearInfo = resolveWorkYear(
        details({ firstPublishedYear: 1954, firstPublishedYearPrecision: 'фу', firstPublishedYearKind: 'фу' }),
        null,
        null,
        null
      );
      assert.equal(yearInfo.firstPublishedYear, 1954);
      assert.equal(yearInfo.firstPublishedYearPrecision, null);
      assert.equal(yearInfo.firstPublishedYearKind, null);
    });

    test('the manual branch echoes the claim it still carries', () => {
      const withClaim = resolveWorkYear(
        details({ firstPublishedYear: 1605, firstPublishedYearPrecision: 'century', firstPublishedYearKind: 'publication' }),
        null,
        null,
        { year: 1990 }
      );
      assert.equal(withClaim.yearSource, 'manual');
      assert.equal(withClaim.year, 1990);
      assert.equal(withClaim.firstPublishedYear, 1605);
      assert.equal(withClaim.firstPublishedYearPrecision, 'century');
      assert.equal(withClaim.firstPublishedYearKind, 'publication');

      const withoutClaim = resolveWorkYear(details(), null, null, { year: 1990 });
      assert.equal(withoutClaim.yearSource, 'manual');
      assert.equal(withoutClaim.firstPublishedYear, null);
      assert.equal(withoutClaim.firstPublishedYearPrecision, null);
      assert.equal(withoutClaim.firstPublishedYearKind, null);
    });

    test('the edition and unknown branches carry no claim, so no precision/kind', () => {
      const edition = resolveWorkYear(details({ publicationYear: 1988 }), null, null, null);
      assert.equal(edition.yearSource, 'edition');
      assert.equal(edition.firstPublishedYear, null);
      assert.equal(edition.firstPublishedYearPrecision, null);
      assert.equal(edition.firstPublishedYearKind, null);

      const unknown = resolveWorkYear(details(), null, null, null);
      assert.equal(unknown.yearSource, null);
      assert.equal(unknown.firstPublishedYearPrecision, null);
      assert.equal(unknown.firstPublishedYearKind, null);
    });
  });

  describe('payload integration', () => {
    test('booksIndex exposes yearPrecision/yearKind next to firstPublishedYearSource', async () => {
      await bookCache.saveDetails(9301, details({
        hcWorkId: 9301,
        firstPublishedYear: 1605,
        firstPublishedYearSource: 'litres',
        firstPublishedYearPrecision: 'century',
        firstPublishedYearKind: 'composition',
      }));
      await bookCache.saveLink('9301', {
        schemaVersion: 2,
        livelibBookId: '9301',
        workId: 'hc:9301',
        method: 'isbn',
        score: 1,
      });
      await bookCache.saveDetails(9302, details({ hcWorkId: 9302, firstPublishedYear: 1954 }));
      await bookCache.saveLink('9302', {
        schemaVersion: 2,
        livelibBookId: '9302',
        workId: 'hc:9302',
        method: 'isbn',
        score: 1,
      });
      await bookCache.saveDetails(9303, details({ hcWorkId: 9303, publicationYear: 1988 }));
      await bookCache.saveLink('9303', {
        schemaVersion: 2,
        livelibBookId: '9303',
        workId: 'hc:9303',
        method: 'isbn',
        score: 1,
      });
      const event = (sourceBookId) => ({
        id: `ll:${sourceBookId}`,
        source: 'livelib',
        sourceBookId: String(sourceBookId),
        title: 'Книга',
        authors: ['Автор'],
        rating: null,
        ratingScale: 10,
        rating10: null,
        status: 'read',
        shelf: 'read',
        origin: 'livelib-file',
        finishedAt: '2024-01-01',
        readMonth: '2024-01',
        edition: { publisher: null, year: null, isbn: null, language: 'ru', series: null },
        genres: [],
      });
      await bookCache.saveProfile('livelib', 'YearInfo', {
        schemaVersion: 1,
        source: 'livelib',
        userKey: 'YearInfo',
        sourceUserId: null,
        importedAt: '2026-11-12T00:00:00.000Z',
        events: [event(9301), event(9302), event(9303)],
        warnings: [],
      });

      const stats = buildBooksStats({ profile: 'livelib-YearInfo' });

      const claim = stats.booksIndex['hc:9301'];
      assert.ok(claim, 'linked work must be in booksIndex');
      assert.equal(claim.firstPublishedYear, 1605);
      assert.equal(claim.firstPublishedYearSource, 'litres');
      assert.equal(claim.yearPrecision, 'century');
      assert.equal(claim.yearKind, 'composition');

      const legacy = stats.booksIndex['hc:9302'];
      assert.equal(legacy.firstPublishedYear, 1954);
      assert.equal(legacy.yearPrecision, 'year');
      assert.equal(legacy.yearKind, 'publication');

      const edition = stats.booksIndex['hc:9303'];
      assert.equal(edition.yearSource, 'edition');
      assert.equal(edition.firstPublishedYear, null);
      assert.equal(edition.yearPrecision, null);
      assert.equal(edition.yearKind, null);
    });
  });
});
