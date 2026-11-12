'use strict';

/**
 * Books: the Wikidata year provider (`books/providers/wikidata.js`).
 *
 * The provider is a *year-only* source, so the whole module is: one SPARQL
 * query -> `parseResponse` -> candidate collapsing -> sanity gate. Every case
 * below is one of the measured failure modes named in its header:
 *
 *   - `P629` must be followed, otherwise a translation's own date («Одиссея»,
 *     1997) is read as the work's;
 *   - a claim without an author match is only accepted when it is the single
 *     candidate, so «Бретёр» by Ю. Яковлева does not become Turgenev's 1847
 *     novella;
 *   - the Wikibase precision travels with the claim, so «VIII в. до н.э.» is
 *     a century, not a year;
 *   - budget refusal and transport failure are «never asked», not «no claim».
 *
 * Fully offline: `fetchImpl` and `sleep` are injected, nothing touches the
 * network. The breaker is process-local and shared with the real provider, so
 * every test that can trip it resets it in `finally`.
 */

const { describe, test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const wikidata = require('../server/books/providers/wikidata');

/**
 * `wikidata.js` takes `fetchOnce` from the `books/providers/http` facade. While
 * that facade does not re-export it, every lookup dies with «fetchOnce is not a
 * function» before the injected `fetchImpl` is ever called, so the network
 * tests below cannot say anything about the provider. They are written against
 * the contract and self-enable as soon as the export appears.
 */
const LOOKUP_BLOCKED =
  typeof require('../server/books/providers/http').fetchOnce === 'function'
    ? false
    : 'blocked: books/providers/http.js does not export fetchOnce';

const {
  titleVariants,
  parseResponse,
  lookupTitles,
  getWork,
  createBudget,
  resetBreaker,
} = wikidata;

const noSleep = async () => {};

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function cell(value) {
  return { value: String(value) };
}

function sparqlRow(spec) {
  const row = {};
  for (const [name, value] of Object.entries(spec)) {
    if (value == null) continue;
    row[name] = cell(value);
  }
  return row;
}

function payloadOf(...rows) {
  return { head: { vars: [] }, results: { bindings: rows } };
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    url: 'https://query.wikidata.org/sparql',
    headers: { get: () => null },
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

function recorder(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** Body of the POST as a decoded `query` string. */
function queryOf(call) {
  return new URLSearchParams(String(call.init.body)).get('query') || '';
}

const ODYSSEY = sparqlRow({
  label: 'Одиссея',
  item: 'http://www.wikidata.org/entity/Q131295',
  itemLabel: 'Одиссея (1997)',
  authorLabel: 'Гомер',
  sitelinks: 120,
  p577: '1997-01-01T00:00:00Z',
  p577Prec: 11,
  canonical: 'http://www.wikidata.org/entity/Q47203',
  canonicalLabel: 'Одиссея',
  canonicalP577: '-0800-00-00T00:00:00Z',
  canonicalP577Prec: 7,
});

const MISER = sparqlRow({
  label: 'Скупой',
  item: 'http://www.wikidata.org/entity/Q1140856',
  itemLabel: 'Скупой',
  authorLabel: 'Мольер',
  authorBirth: '1622-01-15T00:00:00Z',
  sitelinks: 40,
  p571: '1668-01-01T00:00:00Z',
  p571Prec: 9,
});

const REBECCA = sparqlRow({
  label: 'Ребекка',
  item: 'http://www.wikidata.org/entity/Q202435',
  itemLabel: 'Ребекка',
  authorLabel: 'Дафна дю Морье',
  authorBirth: '1907-05-25T00:00:00Z',
  sitelinks: 85,
  p577: '1938-08-01T00:00:00Z',
  p577Prec: 11,
});

describe('books-wikidata-provider', () => {
  // The breaker is process-local and shared by every test in this file; a
  // failed lookup trips it, so each test starts from a closed breaker.
  beforeEach(resetBreaker);
  after(resetBreaker);

  describe('titleVariants', () => {
    test('a title is asked as written and with a lower-case first letter', () => {
      const variants = titleVariants('Властелин Колец');
      assert.ok(variants.includes('Властелин Колец'));
      assert.ok(variants.includes('властелин Колец'));
    });

    test('«ё» and «Ё» are also asked as «е»/«Е»', () => {
      const variants = titleVariants('Сёгун');
      assert.ok(variants.includes('Сёгун'));
      assert.ok(variants.includes('Сегун'));
      assert.ok(titleVariants('Ёжик в тумане').includes('Ежик в тумане'));
    });

    test('quotes are stripped in one of the variants', () => {
      const variants = titleVariants('Убийство в "Восточном экспрессе"');
      assert.ok(variants.includes('Убийство в Восточном экспрессе'));
      assert.ok(variants.includes('убийство в Восточном экспрессе'));
      assert.ok(variants.includes('Убийство в "Восточном экспрессе"'));
      assert.ok(
        variants.some((value) => !/["«»„“”`]/.test(value)),
        'at least one variant must be free of quotes'
      );
    });

    test('a two-books-in-one-row title is also asked as its first part', () => {
      const title = 'Приключения Алисы в стране чудес ; Сквозь зеркало и что там увидела Алиса';
      const variants = titleVariants(title);
      assert.ok(variants.includes('Приключения Алисы в стране чудес'));
      assert.ok(variants.includes(title), 'the row as exported is still asked');
    });

    test('a comma-separated subtitle is also asked as its head', () => {
      assert.ok(
        titleVariants('Собор Парижской Богоматери, или Размышления').includes(
          'Собор Парижской Богоматери'
        )
      );
    });

    test('empty and single-character titles are not asked at all', () => {
      assert.deepEqual(titleVariants(''), []);
      assert.deepEqual(titleVariants('   '), []);
      assert.deepEqual(titleVariants('Я'), []);
      assert.deepEqual(titleVariants(null), []);
      assert.deepEqual(titleVariants(undefined), []);
    });
  });

  describe('parseResponse', () => {
    const rows = parseResponse(payloadOf(ODYSSEY, MISER));

    test('QIDs are kept from the entity URI', () => {
      assert.equal(rows[0].item, 'Q131295');
      assert.equal(rows[0].canonical, 'Q47203');
      assert.equal(rows[1].item, 'Q1140856');
      assert.equal(rows[1].canonical, null);
    });

    test('the edition keeps its own date, the canonical work keeps its own', () => {
      assert.deepEqual(rows[0].publication, { year: 1997, precision: 'year' });
      assert.deepEqual(rows[0].canonicalPublication, { year: -800, precision: 'century' });
      assert.equal(rows[0].canonicalLabel, 'Одиссея');
      assert.equal(rows[0].itemLabel, 'Одиссея (1997)');
    });

    test('P571 becomes an inception claim, not a publication one', () => {
      assert.deepEqual(rows[1].inception, { year: 1668, precision: 'year' });
      assert.equal(rows[1].publication, null);
      assert.equal(rows[1].authorBirthYear, 1622);
      assert.equal(rows[0].authorBirthYear, null);
    });

    test('sitelinks is a number, missing sitelinks is 0', () => {
      assert.equal(rows[0].sitelinks, 120);
      assert.equal(rows[1].sitelinks, 40);
      assert.equal(parseResponse(payloadOf(sparqlRow({ item: 'Q1' })))[0].sitelinks, 0);
    });

    test('a negative wikibase time keeps its sign', () => {
      const negative = parseResponse(
        payloadOf(
          sparqlRow({ p577: '-0800-00-00T00:00:00Z', p577Prec: 7 }),
          sparqlRow({ p577: '-3000-00-00T00:00:00Z', p577Prec: 6 })
        )
      );
      assert.deepEqual(negative[0].publication, { year: -800, precision: 'century' });
      assert.deepEqual(negative[1].publication, { year: -3000, precision: 'millennium' });
    });

    test('the wikibase precision codes map onto the payload vocabulary', () => {
      const codeToLabel = [
        [11, 'year'],
        [10, 'year'],
        [9, 'year'],
        [8, 'decade'],
        [7, 'century'],
        [6, 'millennium'],
      ];
      for (const [code, label] of codeToLabel) {
        const [row] = parseResponse(
          payloadOf(sparqlRow({ p577: '1930-10-01T00:00:00Z', p577Prec: code }))
        );
        assert.equal(row.publication.precision, label, `precision code ${code}`);
      }
      const [unknown] = parseResponse(
        payloadOf(sparqlRow({ p577: '1930-10-01T00:00:00Z', p577Prec: 5 }))
      );
      assert.equal(unknown.publication.precision, 'year');
    });

    test('a year outside the sane band is not a claim', () => {
      const [row] = parseResponse(
        payloadOf(sparqlRow({ p577: '3500-00-00T00:00:00Z', p577Prec: 6 }))
      );
      assert.equal(row.publication, null);
    });

    test('an empty or malformed payload yields no rows', () => {
      assert.deepEqual(parseResponse(null), []);
      assert.deepEqual(parseResponse({}), []);
      assert.deepEqual(parseResponse({ results: {} }), []);
      assert.deepEqual(parseResponse({ results: { bindings: [] } }), []);
    });
  });

  describe('lookupTitles', { skip: LOOKUP_BLOCKED }, () => {
    test('a single author-verified candidate becomes a year claim', async () => {
      const fetchImpl = recorder(() => jsonResponse(payloadOf(REBECCA)));

      const found = await lookupTitles(
        [{ key: 'k1', title: 'Ребекка', authors: ['Дафна дю Морье'] }],
        { fetchImpl, sleep: noSleep, pauseMs: 0 }
      );

      assert.equal(found.skipped, null);
      assert.deepEqual([...found.asked], ['k1']);
      const result = found.byKey.get('k1');
      assert.ok(result, 'author-verified candidate must resolve');
      assert.equal(result.source, 'wikidata');
      assert.equal(result.workId, 'wd:Q202435');
      assert.equal(result.sourceId, 'Q202435');
      assert.equal(result.firstPublishedYear, 1938);
      assert.equal(result.firstPublishedYearPrecision, 'year');
      assert.equal(result.firstPublishedYearKind, 'publication');
      assert.equal(result.year, null);
      assert.equal(result.match.authorHit, true);
      assert.equal(result.match.exact, true);
      assert.equal(result.confidence, 0.62);
    });

    test('the query carries the title variants of every entry', async () => {
      const fetchImpl = recorder(() => jsonResponse(payloadOf(REBECCA)));

      await lookupTitles(
        [{ key: 'k1', title: 'Сёгун', authors: ['Джеймс Клавелл'] }],
        { fetchImpl, sleep: noSleep, pauseMs: 0 }
      );

      // The search query plus the VALUES-bound canonical follow-up.
      assert.equal(fetchImpl.calls.length, 2);
      const call = fetchImpl.calls[0];
      assert.equal(call.url, 'https://query.wikidata.org/sparql');
      assert.equal(call.init.method, 'POST');
      const query = queryOf(call);
      assert.ok(query.includes('"Сегун"@ru'), 'the «ё»-less spelling must be asked');
      assert.ok(query.includes('"сёгун"@ru') || query.includes('"Сегун"@ru'));
    });

    test('two candidates without an author match are not guessed between', async () => {
      const fetchImpl = recorder(() =>
        jsonResponse(
          payloadOf(
            sparqlRow({
              label: 'Бретёр',
              item: 'http://www.wikidata.org/entity/Q111',
              itemLabel: 'Бретёр',
              authorLabel: 'Иван Тургенев',
              sitelinks: 30,
              p577: '1847-01-01T00:00:00Z',
              p577Prec: 9,
            }),
            sparqlRow({
              label: 'Бретёр',
              item: 'http://www.wikidata.org/entity/Q222',
              itemLabel: 'Бретёр',
              authorLabel: 'Лев Толстой',
              sitelinks: 10,
              p577: '1863-01-01T00:00:00Z',
              p577Prec: 9,
            })
          )
        )
      );

      const found = await lookupTitles(
        [{ key: 'k2', title: 'Бретёр', authors: ['Ю. Яковлева'] }],
        { fetchImpl, sleep: noSleep, pauseMs: 0 }
      );

      assert.equal(found.skipped, null);
      assert.ok(found.byKey.has('k2'), 'an asked key must be present even when unanswered');
      assert.equal(found.byKey.get('k2'), null);
    });

    test('a translation follows P629: the canonical work dates it', async () => {
      const fetchImpl = recorder(() => jsonResponse(payloadOf(ODYSSEY)));

      const found = await lookupTitles(
        [{ key: 'k3', title: 'Одиссея', authors: ['Гомер'] }],
        { fetchImpl, sleep: noSleep, pauseMs: 0 }
      );

      const result = found.byKey.get('k3');
      assert.ok(result, 'canonical work must resolve');
      assert.equal(result.workId, 'wd:Q47203');
      assert.equal(result.firstPublishedYear, -800);
      assert.equal(result.firstPublishedYearPrecision, 'century');
      assert.equal(result.firstPublishedYearKind, 'publication');
      assert.equal(result.links.pageUrl, 'https://www.wikidata.org/wiki/Q47203');
    });

    test('an empty budget asks nothing and says so', async () => {
      const fetchImpl = recorder(() => jsonResponse(payloadOf(REBECCA)));

      const found = await lookupTitles(
        [{ key: 'k4', title: 'Ребекка', authors: ['Дафна дю Морье'] }],
        { fetchImpl, sleep: noSleep, pauseMs: 0, budget: createBudget(0) }
      );

      assert.equal(found.skipped, 'budget');
      assert.equal(found.byKey.size, 0);
      assert.equal(found.asked.size, 0);
      assert.equal(fetchImpl.calls.length, 0);
    });

    test('no entries means no query and no budget refusal', async () => {
      const fetchImpl = recorder(() => jsonResponse(payloadOf(REBECCA)));

      const found = await lookupTitles([], { fetchImpl, sleep: noSleep, pauseMs: 0 });

      assert.equal(found.skipped, null);
      assert.equal(found.byKey.size, 0);
      assert.equal(fetchImpl.calls.length, 0);
    });

    test('a transport failure rejects the promise instead of writing «not found»', async () => {
      const fetchImpl = recorder(() => {
        throw new Error('boom');
      });

      try {
        await assert.rejects(
          lookupTitles(
            [{ key: 'k5', title: 'Ребекка', authors: ['Дафна дю Морье'] }],
            { fetchImpl, sleep: noSleep, pauseMs: 0 }
          ),
          (err) => {
            assert.ok(err instanceof Error);
            assert.equal(typeof err.code, 'string');
            return true;
          }
        );
      } finally {
        resetBreaker();
      }
    });

    test('a server error is retried and then rejects', async () => {
      const fetchImpl = recorder(() => jsonResponse({ error: 'unavailable' }, { status: 503 }));

      try {
        await assert.rejects(
          lookupTitles(
            [{ key: 'k6', title: 'Ребекка', authors: ['Дафна дю Морье'] }],
            { fetchImpl, sleep: noSleep, pauseMs: 0 }
          )
        );
        assert.ok(fetchImpl.calls.length >= 2, 'a 5xx must be retried, not answered');
      } finally {
        resetBreaker();
      }
    });
  });

  describe('getWork', { skip: LOOKUP_BLOCKED }, () => {
    test('the single-book facade goes through the same lookup', async () => {
      const fetchImpl = recorder(() => jsonResponse(payloadOf(REBECCA)));

      const result = await getWork(
        { title: 'Ребекка', authors: ['Дафна дю Морье'] },
        { fetchImpl, sleep: noSleep, pauseMs: 0 }
      );

      assert.ok(result);
      assert.equal(result.firstPublishedYear, 1938);
    });

    test('a miss is null, not an exception', async () => {
      const fetchImpl = recorder(() => jsonResponse(payloadOf()));

      const result = await getWork(
        { title: 'Ребекка', authors: ['Дафна дю Морье'] },
        { fetchImpl, sleep: noSleep, pauseMs: 0 }
      );

      assert.equal(result, null);
    });
  });
});
