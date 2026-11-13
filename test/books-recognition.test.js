'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const wikidata = require('../server/books/providers/wikidata');
const openlibrary = require('../server/books/providers/openlibrary');
const { isChallengeableClaim, storedFirstClaim } = require('../server/books/providers/claim');
const { needsYearQuestion, storedPrintClaim } = require('../server/books/backfill-queue');

const noSleep = async () => {};

function cell(value) {
  return { value: String(value) };
}

function sparqlRow(spec) {
  const row = {};
  for (const [name, value] of Object.entries(spec)) {
    if (value != null) row[name] = cell(value);
  }
  return row;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    url: 'https://example.test/',
    headers: { get: () => null },
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

function wikidataFetch(rows) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), query: new URLSearchParams(String(init.body)).get('query') || '' });
    const first = calls.length === 1;
    return jsonResponse({ head: { vars: [] }, results: { bindings: first ? rows : [] } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

describe('books-recognition', () => {
  describe('wikidata author birth gate', () => {
    test('the search query projects the author birth it filters on', async () => {
      const fetchImpl = wikidataFetch([]);
      await wikidata.lookupTitles([{ key: 'k', title: 'Цыганка', authors: ['Агата Кристи'] }], {
        fetchImpl,
        sleep: noSleep,
        pauseMs: 0,
      });
      const select = fetchImpl.calls[0].query.split('WHERE')[0];
      assert.match(select, /\?authorBirth\b/);
    });

    test('a claim older than the author is dropped', async () => {
      wikidata.resetBreaker();
      const fetchImpl = wikidataFetch([
        sparqlRow({
          label: 'Цыганка',
          item: 'http://www.wikidata.org/entity/Q1',
          itemLabel: 'Цыганка',
          author: 'http://www.wikidata.org/entity/Q35064',
          authorLabel: 'Агата Кристи',
          authorBirth: '1890-09-15T00:00:00Z',
          sitelinks: 3,
          p577: '1850-01-01T00:00:00Z',
          p577Prec: 9,
        }),
      ]);
      const found = await wikidata.lookupTitles(
        [{ key: 'k', title: 'Цыганка', authors: ['Агата Кристи'] }],
        { fetchImpl, sleep: noSleep, pauseMs: 0 }
      );
      assert.equal(found.byKey.get('k'), null);
    });

    test('the earliest co-author birth is the bound', () => {
      const rows = [
        { item: 'Q1', itemLabel: 'X', authorLabel: 'A', author: 'QA', authorBirthYear: 1950, publication: { year: 1940, precision: 'year' } },
        { item: 'Q1', itemLabel: 'X', authorLabel: 'B', author: 'QB', authorBirthYear: 1900, publication: { year: 1940, precision: 'year' } },
      ];
      const [candidate] = wikidata.candidatesFor(rows, [], { title: 'X', authors: ['A'] });
      assert.equal(candidate.authorBirthYear, 1900);
    });
  });

  describe('open library work record', () => {
    test('first_publish_date of the work is the first-publication year', async () => {
      const fetchImpl = async (url) => {
        if (String(url).includes('/api/books')) {
          return jsonResponse({
            'ISBN:9785170000000': {
              key: '/books/OL12538881M',
              title: 'Doktor ZHivago',
              authors: [{ name: 'Boris Pasternak' }],
              publish_date: '2006',
              works: [{ key: '/works/OL258301W' }],
              identifiers: { isbn_13: ['9785170000000'] },
            },
          });
        }
        return jsonResponse({ title: 'Доктор Живаго', first_publish_date: 'March 1957' });
      };
      const found = await openlibrary.getWork(
        { isbn13: '9785170000000' },
        { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
      );
      assert.equal(found.year, 2006);
      assert.equal(found.firstPublishedYear, 1957);
    });
  });

  describe('legacy claims without a source', () => {
    const legacy = { workId: 'ol:OL1W', title: 'Евгений Онегин', firstPublishedYear: 2023, publicationYear: 2023 };

    test('a claim without a source is challengeable, a wikidata one is not', () => {
      assert.equal(isChallengeableClaim(storedFirstClaim(legacy)), true);
      assert.equal(isChallengeableClaim({ year: 1833, source: 'wikidata' }), false);
      assert.equal(isChallengeableClaim({ year: 2001, source: 'litres' }), true);
      assert.equal(isChallengeableClaim(null), false);
    });

    test('the backfill queue asks about a legacy claim', () => {
      assert.ok(storedPrintClaim(legacy));
      assert.equal(needsYearQuestion(legacy), true);
    });

    test('a manual year stays out of the queue', () => {
      const manual = { ...legacy, yearSource: 'manual' };
      assert.equal(storedPrintClaim(manual), null);
      assert.equal(needsYearQuestion(manual), false);
    });
  });
});
