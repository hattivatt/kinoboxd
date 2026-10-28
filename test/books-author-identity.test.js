'use strict';

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

const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-book-authors-'));
process.env.KINOBOXD_CACHE_BOOK_DIR = CACHE;

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
  const fetchImpl = async (url) => {
    const decoded = decodeURIComponent(url);
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
