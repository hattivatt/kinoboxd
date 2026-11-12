'use strict';

/**
 * Books: first-publication claims (`books/providers/claim.js`).
 *
 * The module is pure data rules shared by the provider registry (merge,
 * details) and the Wikidata provider, so every case here is a rule that a
 * payload number depends on:
 *
 *   - `firstYearOf` bounds a year to the band `-3000..2100` and truncates
 *     fractions; the band mirrors `stats.saneFirstYear`;
 *   - `earliestFirstClaim` — earliest sane year wins, precision breaks a year
 *     tie, kind breaks a precision tie (`earliestFirstYear` rule: a later
 *     claim is an edition year dressed as a first publication);
 *   - `saneFirstYearClaim` — the plausibility gate: print sources may not
 *     claim a positive year below 1000 or a negative year, a claim may not
 *     postdate the edition in hand nor predate the author's birth.
 *
 * Offline: no cache, no network, no ports.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  firstYearOf,
  earliestFirstYear,
  earliestFirstClaim,
  claimOf,
  claimWins,
  saneFirstYearClaim,
  mergedFirstClaim,
  precisionOf,
  kindOf,
  PRECISIONS,
  PRECISION_RANK,
  KINDS,
} = require('../server/books/providers/claim');

describe('books-year-claims', () => {
  describe('firstYearOf', () => {
    test('null, empty string, non-numeric and NaN are not years', () => {
      assert.equal(firstYearOf(null), null);
      assert.equal(firstYearOf(undefined), null);
      assert.equal(firstYearOf(''), null);
      assert.equal(firstYearOf(NaN), null);
      assert.equal(firstYearOf('фу'), null);
    });

    test('the band is -3000..2100, both ends inclusive', () => {
      assert.equal(firstYearOf(-3000), -3000);
      assert.equal(firstYearOf(-3500), null);
      assert.equal(firstYearOf(2100), 2100);
      assert.equal(firstYearOf(2200), null);
      assert.equal(firstYearOf(-500), -500);
    });

    test('fractions are truncated, numeric strings are accepted', () => {
      assert.equal(firstYearOf(1930.7), 1930);
      assert.equal(firstYearOf('1930'), 1930);
      assert.equal(firstYearOf(-1930.7), -1930);
      assert.equal(firstYearOf(3), 3);
    });

    test('zero survives this helper; the sanity gate rejects it', () => {
      assert.equal(firstYearOf(0), 0);
    });
  });

  describe('precisionOf / kindOf', () => {
    test('the vocabulary is lower case and trimmed', () => {
      assert.deepEqual(PRECISIONS, ['year', 'decade', 'century', 'millennium']);
      assert.deepEqual(KINDS, ['publication', 'composition']);
      assert.equal(precisionOf(' Century '), 'century');
      assert.equal(precisionOf('MILLENNIUM'), 'millennium');
      assert.equal(precisionOf('decade'), 'decade');
      assert.equal(kindOf(' Composition '), 'composition');
      assert.equal(kindOf('PUBLICATION'), 'publication');
    });

    test('anything outside the vocabulary is null, never a default', () => {
      assert.equal(precisionOf('фу'), null);
      assert.equal(precisionOf(''), null);
      assert.equal(precisionOf(null), null);
      assert.equal(precisionOf(undefined), null);
      assert.equal(kindOf('rewritten'), null);
      assert.equal(kindOf(''), null);
      assert.equal(kindOf(null), null);
    });

    test('the precision ranking matches the tie rule', () => {
      assert.ok(PRECISION_RANK.year > PRECISION_RANK.decade);
      assert.ok(PRECISION_RANK.decade > PRECISION_RANK.century);
      assert.ok(PRECISION_RANK.century > PRECISION_RANK.millennium);
    });
  });

  describe('claimOf', () => {
    test('a result without a claim is not a claim', () => {
      assert.equal(claimOf(null), null);
      assert.equal(claimOf({}), null);
      assert.equal(claimOf({ firstPublishedYear: null }), null);
      assert.equal(claimOf({ firstPublishedYear: '' }), null);
      assert.equal(claimOf({ firstPublishedYear: 3000 }), null);
    });

    test('a bare year reads as year/publication', () => {
      assert.deepEqual(claimOf({ firstPublishedYear: 1930 }), {
        year: 1930,
        source: null,
        precision: 'year',
        kind: 'publication',
      });
    });

    test('source, precision and kind travel with the claim', () => {
      assert.deepEqual(
        claimOf({
          firstPublishedYear: -800,
          source: 'wikidata',
          firstPublishedYearPrecision: ' Century ',
          firstPublishedYearKind: 'Composition',
        }),
        { year: -800, source: 'wikidata', precision: 'century', kind: 'composition' }
      );
    });

    test('garbage precision/kind fall back to the print-year case', () => {
      const claim = claimOf({
        firstPublishedYear: 1954,
        firstPublishedYearPrecision: 'фу',
        firstPublishedYearKind: 'фу',
      });
      assert.equal(claim.precision, 'year');
      assert.equal(claim.kind, 'publication');
    });
  });

  describe('earliestFirstClaim', () => {
    test('the earliest year wins, not the provider priority', () => {
      const claim = earliestFirstClaim([
        { firstPublishedYear: 1930, source: 'hardcover' },
        { firstPublishedYear: 1668, source: 'litres' },
      ]);
      assert.equal(claim.year, 1668);
      assert.equal(claim.source, 'litres');
    });

    test('entries without a sane claim are skipped', () => {
      const claim = earliestFirstClaim([
        null,
        {},
        { firstPublishedYear: 2200 },
        { firstPublishedYear: 1938, source: 'hardcover' },
      ]);
      assert.equal(claim.year, 1938);
      assert.equal(earliestFirstClaim([null, {}, { firstPublishedYear: 2200 }]), null);
      assert.equal(earliestFirstClaim([]), null);
    });

    test('on an equal year the more precise claim wins', () => {
      const claim = earliestFirstClaim([
        { firstPublishedYear: 1605, firstPublishedYearPrecision: 'century' },
        { firstPublishedYear: 1605, firstPublishedYearPrecision: 'year' },
      ]);
      assert.equal(claim.year, 1605);
      assert.equal(claim.precision, 'year');
    });

    test('on an equal year and precision `publication` beats `composition`', () => {
      const claim = earliestFirstClaim([
        { firstPublishedYear: 1668, firstPublishedYearKind: 'composition' },
        { firstPublishedYear: 1668, firstPublishedYearKind: 'publication' },
      ]);
      assert.equal(claim.kind, 'publication');
    });

    test('precision does not outvote an earlier year', () => {
      const claim = earliestFirstClaim([
        { firstPublishedYear: 1605, firstPublishedYearPrecision: 'century' },
        { firstPublishedYear: 1954, firstPublishedYearPrecision: 'year' },
      ]);
      assert.equal(claim.year, 1605);
      assert.equal(claim.precision, 'century');
    });
  });

  describe('claimWins / earliestFirstYear', () => {
    test('the first claim always wins over nothing', () => {
      assert.equal(claimWins({ year: 1930, precision: 'year', kind: 'publication' }, null), true);
    });

    test('earliestFirstYear keeps the old contract (a bare number)', () => {
      assert.equal(earliestFirstYear([{ firstPublishedYear: 1930 }, { firstPublishedYear: 1668 }]), 1668);
      assert.equal(earliestFirstYear([]), null);
      assert.equal(earliestFirstYear([{ firstPublishedYear: null }]), null);
    });
  });

  describe('saneFirstYearClaim', () => {
    test('a print source may not dress a field artefact as an ancient year', () => {
      assert.equal(
        saneFirstYearClaim({ year: 3, source: 'hardcover', precision: 'year' }),
        null
      );
      assert.equal(
        saneFirstYearClaim({ year: 300, source: 'hardcover', precision: 'year' }),
        null
      );
      assert.equal(
        saneFirstYearClaim({ year: 999, source: 'openlibrary', kind: 'publication' }),
        null
      );
    });

    test('a coarser precision or a `composition` kind makes an ancient claim honest', () => {
      const century = { year: 300, source: 'wikidata', precision: 'century' };
      assert.equal(saneFirstYearClaim(century), century);
      const composition = { year: 3, source: 'wikidata', precision: 'year', kind: 'composition' };
      assert.equal(saneFirstYearClaim(composition), composition);
      const millennium = { year: -800, source: 'wikidata', precision: 'millennium' };
      assert.equal(saneFirstYearClaim(millennium), millennium);
    });

    test('Литрес carries authentic ancient dates, so a negative year passes', () => {
      const ancient = { year: -500, source: 'litres' };
      assert.equal(saneFirstYearClaim(ancient), ancient);
    });

    test('a negative year from a print source does not pass', () => {
      assert.equal(saneFirstYearClaim({ year: -500, source: 'hardcover' }), null);
      assert.equal(saneFirstYearClaim({ year: -500, source: 'wikidata' }), null);
    });

    test('year zero is never a claim', () => {
      assert.equal(saneFirstYearClaim({ year: 0 }), null);
      assert.equal(saneFirstYearClaim({ year: 0, source: 'wikidata', precision: 'century' }), null);
    });

    test('a claim published before the author was born is impossible', () => {
      // A work cannot be published before its author exists; one year of
      // tolerance keeps a posthumous edition from tripping the rule.
      const beforeBirth = { year: 1950, source: 'wikidata', precision: 'year' };
      assert.equal(saneFirstYearClaim(beforeBirth, { authorBirthYear: 1970 }), null);
      const borderline = { year: 1969, source: 'wikidata', precision: 'year' };
      assert.equal(saneFirstYearClaim(borderline, { authorBirthYear: 1970 }), borderline);
      const sameYear = { year: 1970, source: 'wikidata', precision: 'year' };
      assert.equal(saneFirstYearClaim(sameYear, { authorBirthYear: 1970 }), sameYear);
    });

    test('a claim later than the edition in hand is an edition year', () => {
      assert.equal(saneFirstYearClaim({ year: 2022 }, { editionYear: 2012 }), null);
      const sameEra = { year: 1930 };
      assert.equal(saneFirstYearClaim(sameEra, { editionYear: 2012 }), sameEra);
      const nextYear = { year: 2013 };
      assert.equal(saneFirstYearClaim(nextYear, { editionYear: 2012 }), nextYear);
    });

    test('no claim at all stays null', () => {
      assert.equal(saneFirstYearClaim(null), null);
      assert.equal(saneFirstYearClaim(undefined), null);
    });
  });

  describe('mergedFirstClaim', () => {
    test('the earliest sane claim wins, with precision and kind', () => {
      const claim = mergedFirstClaim([
        { firstPublishedYear: 1938, source: 'hardcover', firstPublishedYearPrecision: 'year' },
        { firstPublishedYear: 1954, source: 'hardcover', firstPublishedYearPrecision: 'year' },
        { firstPublishedYear: 1900, source: 'litres', firstPublishedYearPrecision: 'century' },
      ]);
      assert.equal(claim.year, 1900);
      assert.equal(claim.precision, 'century');
      assert.equal(claim.kind, 'publication');
      assert.equal(claim.source, 'litres');
    });

    test('an artefact does not poison the merge: the gate runs per claim', () => {
      // Hardcover really reports `release_year: 3` for a 2019 manga volume. It
      // is filtered, and the honest 1938 next to it still wins.
      const claim = mergedFirstClaim(
        [
          { firstPublishedYear: 3, source: 'hardcover' },
          { firstPublishedYear: 1938, source: 'hardcover' },
        ],
        2019
      );
      assert.equal(claim.year, 1938);
      assert.equal(claim.source, 'hardcover');
    });

    test('a composition claim keeps its kind', () => {
      const claim = mergedFirstClaim([
        { firstPublishedYear: 1668, source: 'wikidata', firstPublishedYearKind: 'composition' },
      ]);
      assert.equal(claim.year, 1668);
      assert.equal(claim.kind, 'composition');
    });

    test('the author birth year of the merged entries rejects an impossible claim', () => {
      // The 1900 entry is older than its author; it is dropped, not averaged
      // into the result — the 1975 claim survives.
      const claim = mergedFirstClaim([
        { firstPublishedYear: 1900, source: 'wikidata', authorBirthYear: 1970 },
        { firstPublishedYear: 1975, source: 'hardcover' },
      ]);
      assert.equal(claim.year, 1975);
      assert.equal(claim.source, 'hardcover');
    });

    test('the edition year is an upper bound of the merged claim', () => {
      assert.equal(
        mergedFirstClaim([{ firstPublishedYear: 2022, source: 'hardcover' }], 2012),
        null
      );
      const early = mergedFirstClaim([{ firstPublishedYear: 1930, source: 'hardcover' }], 2012);
      assert.equal(early.year, 1930);
    });

    test('everything filtered means no claim', () => {
      assert.equal(mergedFirstClaim([{ firstPublishedYear: 3, source: 'hardcover' }]), null);
      assert.equal(mergedFirstClaim([]), null);
      assert.equal(mergedFirstClaim([null, {}]), null);
    });
  });
});
