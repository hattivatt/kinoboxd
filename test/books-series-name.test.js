'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeSeriesName,
  seriesKeyOf,
  seriesEntryOf,
  seriesEntriesOf,
} = require('../server/books/providers/series-name');

const DIRTY = [
  'The Punisher (2004) (Single Issues)',
  'The Punisher (2004)',
  'Crossed (Collected Editions)',
  'Кристин, дочь Лавранса)  (Kristin Lavransdatter',
  'Хроники Нарнии (мягкая обложка)',
  'Дюны (изд.), ',
  'Серия (том 1',
];

describe('books-series-name', () => {
  describe('sanitizeSeriesName', () => {
    test('stacked bracket suffixes are stripped pass by pass', () => {
      assert.equal(sanitizeSeriesName('The Punisher (2004) (Single Issues)'), 'The Punisher');
      assert.equal(sanitizeSeriesName('The Punisher (2004)'), 'The Punisher');
      assert.equal(sanitizeSeriesName('The Punisher'), 'The Punisher');
      assert.equal(sanitizeSeriesName('Crossed (Collected Editions)'), 'Crossed');
    });

    test('an unmatched closing bracket cuts the rest of the label', () => {
      assert.equal(
        sanitizeSeriesName('Кристин, дочь Лавранса)  (Kristin Lavransdatter'),
        'Кристин, дочь Лавранса'
      );
      assert.equal(sanitizeSeriesName('Серия (том 1'), 'Серия');
      assert.equal(sanitizeSeriesName('Серия )'), 'Серия');
    });

    test('a bracketed edition note on a real series is presentation, not identity', () => {
      assert.equal(sanitizeSeriesName('Хроники Нарнии (мягкая обложка)'), 'Хроники Нарнии');
      assert.equal(sanitizeSeriesName('Crossed (Single Issues)'), 'Crossed');
    });

    test('names without bracket suffixes survive untouched', () => {
      assert.equal(sanitizeSeriesName('Pocket Book of Horror'), 'Pocket Book of Horror');
      assert.equal(sanitizeSeriesName('Зарубежная классика. XX век'), 'Зарубежная классика. XX век');
      assert.equal(sanitizeSeriesName('Хроники Амбера'), 'Хроники Амбера');
      assert.equal(sanitizeSeriesName('Дюны, том второй'), 'Дюны, том второй');
    });

    test('NFKC and whitespace are collapsed', () => {
      assert.equal(sanitizeSeriesName('Ｔｈｅ  Ｐｕｎｉｓｈｅｒ'), 'The Punisher');
      assert.equal(sanitizeSeriesName('Серия\u00a0\u00a0Продолжение'), 'Серия Продолжение');
      assert.equal(sanitizeSeriesName('  Дюны  '), 'Дюны');
    });

    test('trailing separators left by a stripped suffix go away', () => {
      assert.equal(sanitizeSeriesName('Дюны (изд.), '), 'Дюны');
      assert.equal(sanitizeSeriesName('Дюны -'), 'Дюны');
    });

    test('empty and non-string input is an empty name, never a throw', () => {
      assert.equal(sanitizeSeriesName(null), '');
      assert.equal(sanitizeSeriesName(undefined), '');
      assert.equal(sanitizeSeriesName('   '), '');
      assert.equal(sanitizeSeriesName('(Single Issues)'), '');
    });

    test('sanitizing is idempotent on the dirty live labels', () => {
      for (const raw of DIRTY) {
        const once = sanitizeSeriesName(raw);
        assert.equal(sanitizeSeriesName(once), once, raw);
      }
    });
  });

  describe('seriesKeyOf', () => {
    test('one series living under several spellings has one key', () => {
      const keys = [
        'The Punisher',
        'The Punisher (2004)',
        'The Punisher (2004) (Single Issues)',
      ].map(seriesKeyOf);
      assert.deepEqual([...new Set(keys)], ['the punisher']);
    });

    test('the RU/Latin duplicate of one series has one key', () => {
      assert.equal(
        seriesKeyOf('Кристин, дочь Лавранса'),
        seriesKeyOf('Кристин, дочь Лавранса)  (Kristin Lavransdatter')
      );
    });

    test('«ё» is «е», punctuation is a separator, case is irrelevant', () => {
      assert.equal(seriesKeyOf('Сёгун'), seriesKeyOf('Сегун'));
      assert.equal(seriesKeyOf('Хроники Амбера'), seriesKeyOf('Хроники: Амбера!'));
      assert.equal(seriesKeyOf('Зарубежная классика. XX век'), 'зарубежная классика xx век');
    });

    test('an empty name has an empty key', () => {
      assert.equal(seriesKeyOf(''), '');
      assert.equal(seriesKeyOf(null), '');
      assert.equal(seriesKeyOf('(2004)'), '');
    });
  });

  describe('seriesEntryOf', () => {
    test('a string with a volume number splits into name and position', () => {
      assert.deepEqual(seriesEntryOf('Discworld, 4', { source: 'openlibrary' }), {
        name: 'Discworld',
        position: 4,
        source: 'openlibrary',
      });
      assert.deepEqual(seriesEntryOf('The Chronicles of Narnia ; 2'), {
        name: 'The Chronicles of Narnia',
        position: 2,
      });
      assert.deepEqual(seriesEntryOf('Дискмир 3'), { name: 'Дискмир', position: 3 });
      assert.deepEqual(seriesEntryOf('Дюны (2)'), { name: 'Дюны', position: 2 });
      assert.deepEqual(seriesEntryOf('Discworld, 4.'), { name: 'Discworld', position: 4 });
      assert.deepEqual(seriesEntryOf('Зона Икс'), { name: 'Зона Икс', position: null });
    });

    test('a four-digit year is not a volume number', () => {
      assert.deepEqual(seriesEntryOf('1984'), { name: '1984', position: null });
      assert.deepEqual(seriesEntryOf('The Punisher (2004)'), {
        name: 'The Punisher',
        position: null,
      });
    });

    test('an object keeps its id, source and explicit position', () => {
      assert.deepEqual(seriesEntryOf({ hcId: 5, name: 'Дюны', position: 1 }), {
        name: 'Дюны',
        position: 1,
        hcId: 5,
      });
      assert.deepEqual(
        seriesEntryOf({ name: 'Зона Икс', position: 1 }, { source: 'litres' }),
        { name: 'Зона Икс', position: 1, source: 'litres' }
      );
      assert.deepEqual(
        seriesEntryOf({ name: 'Зона Икс', position: 1, source: 'litres' }, { source: 'openlibrary' }),
        { name: 'Зона Икс', position: 1, source: 'litres' }
      );
    });

    test('the object position wins over the number in the name', () => {
      assert.deepEqual(seriesEntryOf({ name: 'Discworld, 4', position: 2 }), {
        name: 'Discworld',
        position: 2,
      });
    });

    test('a zero or negative position from a badge is not a volume order', () => {
      assert.deepEqual(seriesEntryOf({ name: 'Дюны', position: 0 }), { name: 'Дюны', position: null });
      assert.deepEqual(seriesEntryOf({ name: 'Дюны', position: -1 }), { name: 'Дюны', position: null });
    });

    test('an entry without a usable name is null', () => {
      assert.equal(seriesEntryOf(null), null);
      assert.equal(seriesEntryOf(undefined), null);
      assert.equal(seriesEntryOf(''), null);
      assert.equal(seriesEntryOf('   '), null);
      assert.equal(seriesEntryOf('(Single Issues)'), null);
      assert.equal(seriesEntryOf({ position: 1 }), null);
      assert.equal(seriesEntryOf({ name: null }), null);
    });
  });

  describe('seriesEntriesOf', () => {
    test('maps a provider list, dropping unusable entries, keeping the order', () => {
      assert.deepEqual(
        seriesEntriesOf(['Discworld, 4', '', '(2004)'], { source: 'openlibrary' }),
        [{ name: 'Discworld', position: 4, source: 'openlibrary' }]
      );
      assert.deepEqual(seriesEntriesOf(null), []);
      assert.deepEqual(seriesEntriesOf('Discworld'), []);
    });
  });
});
