'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const env = require('./helpers/env');
const tmp = env.makeTmpCache('books-series-merge', { budgets: true });

const providers = require('../server/books/providers');
const openlibrary = require('../server/books/providers/openlibrary');
const litres = require('../server/books/providers/litres');
const hardcoverProvider = require('../server/books/providers/hardcover');
const livelibCard = require('../server/books/providers/livelib-card');

test.after(() => tmp.cleanup());

function hardcoverResult(seriesAll) {
  return {
    source: 'hardcover',
    sourceId: '100',
    workId: 'hc:100',
    title: 'Дюны',
    authors: ['Фрэнк Герберт'],
    year: 1965,
    publisher: null,
    series: seriesAll.length ? { name: seriesAll[0].name, position: seriesAll[0].position } : null,
    seriesAll,
    genres: ['Science Fiction'],
    pages: null,
    isbn13: null,
    isbn10: null,
    cover: null,
    links: { pageUrl: 'https://hardcover.app/books/dune' },
    confidence: 0.99,
    mangaComics: false,
  };
}

function litresResult(seriesAll) {
  return {
    source: 'litres',
    sourceId: '9001',
    workId: 'lr:9001',
    title: 'Дюны',
    authors: ['Фрэнк Герберт'],
    year: 2016,
    publisher: 'АСТ',
    series: seriesAll.length ? { ...seriesAll[0] } : null,
    seriesAll,
    genres: ['Научная фантастика'],
    pages: 704,
    isbn13: '9785170987654',
    isbn10: '5170987650',
    cover: null,
    links: { pageUrl: 'https://www.litres.ru/book/9001' },
    confidence: 0.95,
    mangaComics: false,
  };
}

describe('books-series-merge', () => {
  describe('mergeResults', () => {
    test('several series of several providers survive the merge', () => {
      const merged = providers.mergeResults(
        hardcoverResult([{ hcId: 5, name: 'Хроники Амбера', position: 1 }]),
        [
          litresResult([
            { name: 'Хроники Амбера', position: 1, source: 'litres' },
            { name: 'Книга на все времена', position: 2, source: 'litres' },
          ]),
        ]
      );
      assert.deepEqual(
        merged.seriesAll.map((entry) => entry.name),
        ['Хроники Амбера', 'Книга на все времена']
      );
      assert.deepEqual(merged.seriesAll[0], { name: 'Хроники Амбера', position: 1, hcId: 5 });
      assert.deepEqual(merged.seriesAll[1], {
        name: 'Книга на все времена',
        position: 2,
        source: 'litres',
      });
    });

    test('the single `series` field keeps the old primary-first rule', () => {
      const merged = providers.mergeResults(
        hardcoverResult([{ hcId: 5, name: 'Дюны', position: 1 }]),
        [litresResult([{ name: 'Зона Икс', position: 2, source: 'litres' }])]
      );
      assert.deepEqual(merged.series, { name: 'Дюны', position: 1 });
    });

    test('the same series under two spellings is one entry', () => {
      const merged = providers.mergeResults(
        hardcoverResult([{ hcId: 4443, name: 'Crossed' }]),
        [litresResult([{ name: 'Crossed (Collected Editions)', position: 3, source: 'litres' }])]
      );
      assert.deepEqual(merged.seriesAll, [{ name: 'Crossed', position: 3, hcId: 4443 }]);
    });

    test('the RU/Latin duplicate of one series is one entry', () => {
      const card = {
        source: 'livelib-card',
        sourceId: '77',
        workId: 'll:77',
        title: 'Кристин, дочь Лавранса',
        authors: ['Сигрид Унсет'],
        series: { name: 'Кристин, дочь Лавранса', position: null },
        seriesAll: [{ name: 'Кристин, дочь Лавранса', position: null }],
        genres: [],
        links: {},
        confidence: 1,
        mangaComics: false,
      };
      const openLibrary = {
        source: 'openlibrary',
        sourceId: 'OL1W',
        workId: 'ol:OL1W',
        title: 'Kristin Lavransdatter',
        authors: ['Sigrid Undset'],
        series: { name: 'Кристин, дочь Лавранса', position: null },
        seriesAll: [
          { name: 'Кристин, дочь Лавранса', position: null, source: 'openlibrary' },
        ],
        genres: [],
        links: {},
        confidence: 0.7,
        mangaComics: null,
      };
      const merged = providers.mergeResults(card, [openLibrary]);
      assert.equal(merged.seriesAll.length, 1);
      assert.equal(merged.seriesAll[0].name, 'Кристин, дочь Лавранса');
      assert.equal(merged.seriesAll[0].source, undefined);
    });

    test('a provider without seriesAll counts as an empty list', () => {
      const merged = providers.mergeResults({ source: 'googlebooks', sourceId: 'gb1', title: 'X' });
      assert.deepEqual(merged.series, null);
      assert.deepEqual(merged.seriesAll, []);
    });
  });

  describe('resultToDetails', () => {
    test('several merged series are written as the details array', () => {
      const merged = providers.mergeResults(
        hardcoverResult([{ hcId: 5, name: 'Дюны', position: 1 }]),
        [litresResult([{ name: 'Зона Икс', position: 2, source: 'litres' }])]
      );
      const doc = providers.resultToDetails(merged, { now: '2026-11-12T00:00:00.000Z' });
      assert.deepEqual(doc.series, [
        { hcId: 5, name: 'Дюны', position: 1 },
        { hcId: null, name: 'Зона Икс', position: 2, source: 'litres' },
      ]);
    });

    test('one series keeps the pre-existing document shape byte for byte', () => {
      const doc = providers.resultToDetails(
        {
          source: 'litres',
          sourceId: '9001',
          workId: 'lr:9001',
          title: 'Трудно быть богом',
          series: { name: 'Южный предел', position: 1 },
        },
        { now: '2026-11-12T00:00:00.000Z' }
      );
      assert.deepEqual(doc.series, [{ hcId: null, name: 'Южный предел', position: 1 }]);
    });

    test('one series keeps its provenance when the provider names it', () => {
      const doc = providers.resultToDetails({
        source: 'litres',
        sourceId: '1',
        workId: 'lr:1',
        title: 'Аннигиляция',
        series: { name: 'Зона Икс', position: 1, source: 'litres' },
      });
      assert.deepEqual(doc.series, [
        { hcId: null, name: 'Зона Икс', position: 1, source: 'litres' },
      ]);
    });

    test('a seriesAll entry is not duplicated by its own single `series` twin', () => {
      const doc = providers.resultToDetails({
        source: 'openlibrary',
        sourceId: 'OL1W',
        workId: 'ol:OL1W',
        title: 'The Colour of Magic',
        series: { name: 'Discworld', position: 4 },
        seriesAll: [{ name: 'Discworld', position: 4, source: 'openlibrary' }],
      });
      assert.deepEqual(doc.series, [
        { hcId: null, name: 'Discworld', position: 4, source: 'openlibrary' },
      ]);
    });

    test('a dirty series name is cleaned before it reaches the document', () => {
      const doc = providers.resultToDetails({
        source: 'livelib-card',
        sourceId: '9',
        workId: 'll:9',
        title: 'Кристин, дочь Лавранса',
        series: { name: 'Кристин, дочь Лавранса)  (Kristin Lavransdatter', position: null },
      });
      assert.deepEqual(doc.series, [
        { hcId: null, name: 'Кристин, дочь Лавранса', position: null },
      ]);
    });
  });

  describe('provider series', () => {
    test('Open Library search hits parse the series volume number', () => {
      const doc = openlibrary.normalizeSearchDoc(
        {
          key: '/works/OL1W',
          title: 'The Colour of Magic',
          author_name: ['Terry Pratchett'],
          first_publish_year: 1983,
          edition_count: 20,
          series: ['Discworld, 4', 'The Chronicles of Narnia ; 2'],
        },
        { title: 'The Colour of Magic', authors: ['Terry Pratchett'] }
      );
      assert.deepEqual(doc.series, { name: 'Discworld', position: 4 });
      assert.deepEqual(doc.seriesAll, [
        { name: 'Discworld', position: 4, source: 'openlibrary' },
        { name: 'The Chronicles of Narnia', position: 2, source: 'openlibrary' },
      ]);
    });

    test('an Open Library hit without series changes nothing', () => {
      const doc = openlibrary.normalizeSearchDoc(
        {
          key: '/works/OL1W',
          title: 'The Colour of Magic',
          author_name: ['Terry Pratchett'],
          first_publish_year: 1983,
          edition_count: 20,
        },
        { title: 'The Colour of Magic', authors: ['Terry Pratchett'] }
      );
      assert.equal(doc.series, null);
      assert.deepEqual(doc.seriesAll, []);
    });

    test('an Open Library edition carries a series string', () => {
      const edition = openlibrary.normalizeEdition(
        { key: '/books/OL1M', title: 'Dune', series: 'Dune Chronicles, 1' },
        {}
      );
      assert.deepEqual(edition.seriesAll, [
        { name: 'Dune Chronicles', position: 1, source: 'openlibrary' },
      ]);
    });

    test('Литрес keeps every series and cleans their names', () => {
      const result = litres.normalizeLitres(
        { id: 1, title: 'Аннигиляция', series: [{ name: 'Зона Икс', art_order: 1 }] },
        {
          id: 1,
          title: 'Аннигиляция',
          series: [
            { name: 'Южный предел', art_order: 1 },
            { name: 'Зона Икс (сборник)', art_order: 2 },
          ],
        },
        { title: 'Аннигиляция', authors: ['Джефф Вандермеер'] },
        { exact: true, score: 1, titleSim: 1, authorHit: true }
      );
      assert.deepEqual(result.series, { name: 'Южный предел', position: 1, source: 'litres' });
      assert.deepEqual(result.seriesAll, [
        { name: 'Южный предел', position: 1, source: 'litres' },
        { name: 'Зона Икс', position: 2, source: 'litres' },
      ]);
    });

    test('Hardcover details expose every series of the work', () => {
      const result = hardcoverProvider.normalizeDetails({
        hcWorkId: 7,
        title: 'Crossed',
        series: [
          { hcId: 14694, name: 'Crossed (Single Issues)', position: 3 },
          { hcId: 14693, name: 'Crossed (Collected Editions)', position: 1 },
        ],
      });
      assert.deepEqual(result.series, { name: 'Crossed', position: 3 });
      assert.deepEqual(result.seriesAll, [
        { name: 'Crossed', position: 3, hcId: 14694 },
        { name: 'Crossed', position: 1, hcId: 14693 },
      ]);
    });

    test('a LiveLib card cleans its «Серия» row', () => {
      const html =
        '<html><body><h1>Кристин, дочь Лавранса</h1>' +
        '<div class="DetailedInfo_DetailedInfoRow__x"><p>Серия: </p>' +
        '<p>Кристин, дочь Лавранса)  (Kristin Lavransdatter</p></div>' +
        '</body></html>';
      const card = livelibCard.parseCardHtml(html, { llBookId: '77' });
      assert.deepEqual(card.series, { name: 'Кристин, дочь Лавранса', position: null });
      assert.deepEqual(card.seriesAll, [{ name: 'Кристин, дочь Лавранса', position: null }]);
    });
  });
});
