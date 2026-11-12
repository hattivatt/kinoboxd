'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeSeriesName,
  seriesGroupsOf,
  seriesEntryKeys,
} = require('../server/books/stats/series');

function work(workId, title, series) {
  return { workId, title, titleRu: title, authors: ['Автор'], series };
}

test('normalizeSeriesName strips every parenthetical suffix, not just one', () => {
  assert.equal(normalizeSeriesName('The Punisher (2004) (Single Issues)'), 'the punisher');
  assert.equal(normalizeSeriesName('Crossed (Collected Editions)'), 'crossed');
  assert.equal(normalizeSeriesName('Хроники Нарнии (мягкая обложка)'), 'хроники нарнии');
  assert.equal(normalizeSeriesName('Crossed'), 'crossed');
  assert.equal(normalizeSeriesName('Pocket Book of Horror'), 'pocket book of horror');
  assert.equal(normalizeSeriesName('Зарубежная классика. XX век'), 'зарубежная классика. xx век');
});

test('normalizeSeriesName cuts an unbalanced parenthetical tail', () => {
  assert.equal(
    normalizeSeriesName('Кристин, дочь Лавранса)  (Kristin Lavransdatter'),
    'кристин, дочь лавранса'
  );
  assert.equal(normalizeSeriesName('Сапковский (Ведьмак'), 'сапковский');
  assert.equal(normalizeSeriesName('(без начала) Ведьмак'), '(без начала) ведьмак');
});

test('seriesEntryKeys keeps both the Hardcover id and the normalized name', () => {
  assert.deepEqual(seriesEntryKeys({ hcId: 1185, name: 'Harry Potter' }), [
    'id:1185',
    'name:harry potter',
  ]);
  assert.deepEqual(seriesEntryKeys({ name: 'Гарри Поттер' }), ['name:гарри поттер']);
  assert.deepEqual(seriesEntryKeys(null), []);
});

test('a resolved volume joins its Hardcover series with the file-only name of the rest', () => {
  const works = new Map([
    ['hc:1', work('hc:1', 'Гарри Поттер и Орден Феникса', [
      { hcId: 1185, name: 'Harry Potter', position: 5 },
      { hcId: null, name: 'Гарри Поттер', position: null },
    ])],
    ['hc:2', work('hc:2', 'Гарри Поттер и Принц-полукровка', [
      { hcId: null, name: 'Гарри Поттер', position: null },
    ])],
  ]);
  const groups = seriesGroupsOf(works);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].seriesId, 1185);
  assert.equal(groups[0].works.length, 2);
  assert.equal(groups[0].name, 'Гарри Поттер', 'the Cyrillic alias wins for a Russian profile');
});

test('the same name under two hardcover ids is one entry', () => {
  const works = new Map([
    ['hc:1', work('hc:1', 'Мор', [{ hcId: 900, name: 'Discworld', position: 1 }])],
    ['hc:2', work('hc:2', 'Цвет волшебства', [{ hcId: 901, name: 'Discworld', position: 2 }])],
  ]);
  const groups = seriesGroupsOf(works);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].works.length, 2);
});

test('one hardcover series split into display variants is one entry with positions', () => {
  const works = new Map([
    ['hc:1', work('hc:1', 'Crossed', [{ hcId: 4443, name: 'Crossed', position: 1 }])],
    [
      'hc:2',
      work('hc:2', 'Crossed: Family Values', [
        { hcId: 14693, name: 'Crossed (Collected Editions)', position: 2 },
      ]),
    ],
  ]);
  const groups = seriesGroupsOf(works);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'Crossed');
  assert.equal(groups[0].seriesId, 4443, 'the smallest id is the canonical one');
  assert.deepEqual(groups[0].works.map((item) => item.position), [1, 2]);
});

test('a work listed under several aliases of one series is counted once', () => {
  const works = new Map([
    ['hc:1', work('hc:1', 'The Last Wish', [
      { hcId: 16112, name: 'The Witcher', position: 0.5 },
      { hcId: 16112, name: 'The Witcher (Publication order)', position: 1 },
    ])],
  ]);
  const groups = seriesGroupsOf(works);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].works.length, 1);
  assert.equal(groups[0].works[0].position, 0.5, 'the earliest position of the work wins');
});

test('different series stay separate', () => {
  const works = new Map([
    ['hc:1', work('hc:1', 'Дюна', [{ hcId: 100, name: 'Dune', position: 1 }])],
    ['hc:2', work('hc:2', 'Мор', [{ hcId: 200, name: 'Discworld', position: 1 }])],
  ]);
  assert.equal(seriesGroupsOf(works).length, 2);
});

test('a work without a series contributes nothing', () => {
  const works = new Map([['hc:1', work('hc:1', 'Одиночная книга', [])]]);
  assert.deepEqual(seriesGroupsOf(works), []);
});
