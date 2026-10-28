'use strict';

/**
 * Series blacklist («Книга на все времена» and future catalogue tags).
 *
 * User decision 28.10.2026: a publisher's shelf that Литрес/Эксмо publish in
 * the same «Серия» column as a real cycle is a TAG, not a literary series. The
 * tag must leave the series widget and every count that feeds it — regardless
 * of the source that brought it (литрес / file column / hardcover).
 *
 * Pinned here:
 *   - normalization (case, «ё», quotes, a trailing parenthetical);
 *   - a blacklisted series disappears from `stats.series` AND `summary.seriesCount`;
 *   - an ordinary series in the same profile is untouched;
 *   - the filter is source-independent (file column authority does not matter
 *     for the *kind* of the value).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-series-bl-'));

const bookCache = require('../server/books/book-cache');
const {
  SERIES_BLACKLIST,
  blacklistKey,
  isBlacklistedSeries,
  filterBlacklistedSeries,
} = require('../server/books/series-blacklist');
const { buildBooksStats } = require('../server/books/stats');

function profile(userKey, events) {
  return {
    schemaVersion: 1,
    source: 'livelib',
    userKey,
    sourceUserId: null,
    importedAt: '2026-10-28T00:00:00.000Z',
    events,
    warnings: [],
  };
}

function event(id, title, extra = {}) {
  return {
    id,
    source: 'livelib',
    sourceBookId: null,
    title,
    authors: extra.authors || ['Автор'],
    rating: null,
    ratingScale: 10,
    rating10: null,
    status: 'read',
    shelf: 'read',
    origin: 'livelib-file',
    finishedAt: null,
    readMonth: extra.readMonth || '2021-01',
    edition: {
      publisher: null,
      year: null,
      isbn: null,
      language: 'ru',
      series: extra.fileSeries || null,
    },
    genres: extra.genres || [],
    ...extra.raw,
  };
}

async function details(workId, doc) {
  await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), {
    schemaVersion: 2,
    workId,
    ...doc,
  });
}

test('the blacklist is a normalised set, not a string compare', () => {
  assert.ok(SERIES_BLACKLIST.includes('Книга на все времена'));
  for (const variant of [
    'Книга на все времена',
    'книга на все времена',
    'КНИГА НА ВСЕ ВРЕМЕНА',
    '«Книга на все времена»',
    'Книга на все времена (Эксмо)',
    '  Книга  на   все времена. ',
  ]) {
    assert.equal(isBlacklistedSeries(variant), true, variant);
    assert.equal(blacklistKey(variant), 'книга на все времена');
  }
  assert.equal(isBlacklistedSeries('Песнь Льда и Пламени'), false);
  assert.equal(isBlacklistedSeries(''), false);
  assert.equal(isBlacklistedSeries(null), false);
});

test('filterBlacklistedSeries drops only the tag and reports the count', () => {
  const { list, removed } = filterBlacklistedSeries([
    { name: 'Книга на все времена', hcId: null, position: null },
    { name: 'Настоящая серия', hcId: 42, position: 2 },
    { name: 'книга на все времена', hcId: 9, position: 1 },
  ]);
  assert.equal(removed, 2);
  assert.deepEqual(list.map((entry) => entry.name), ['Настоящая серия']);
});

test('a blacklisted series never reaches the payload, a real one stays', async () => {
  // Work A: Литрес pseudo-series that even carries a volume order, so the
  // older `filterDetailsSeries` rule alone would have kept it — only the
  // blacklist can drop this one.
  await details('hc:9001', {
    schemaVersion: 2,
    hcWorkId: 9001,
    title: 'Книга А',
    authors: [{ hcId: 1, name: 'Автор А' }],
    genres: ['Классика'],
    series: [{ name: 'Книга на все времена', position: 1, source: 'litres' }],
    metadataSources: ['litres'],
  });
  // Work B: the same tag but the FILE column names it (authority question).
  await details('hc:9002', {
    schemaVersion: 2,
    hcWorkId: 9002,
    title: 'Книга Б',
    authors: [{ hcId: 2, name: 'Автор Б' }],
    genres: ['Классика'],
    series: [],
    metadataSources: ['hardcover'],
  });
  // Work C: a real series with a volume order.
  await details('hc:9003', {
    schemaVersion: 2,
    hcWorkId: 9003,
    title: 'Книга В',
    authors: [{ hcId: 3, name: 'Автор В' }],
    genres: ['Фэнтези'],
    series: [{ hcId: 77, name: 'Хроники Амбера', position: 1 }],
    metadataSources: ['hardcover'],
  });

  for (const id of ['9001', '9002', '9003']) {
    await bookCache.saveLink(id, {
      schemaVersion: 2,
      livelibBookId: id,
      workId: `hc:${id}`,
      method: 'isbn',
      score: 1,
    });
  }

  await bookCache.saveProfile(
    'livelib',
    'Blacklist',
    profile('Blacklist', [
      event('ll:9001', 'Книга А', { raw: { sourceBookId: '9001' } }),
      event('ll:9002', 'Книга Б', {
        raw: { sourceBookId: '9002' },
        fileSeries: 'Книга на все времена',
      }),
      event('ll:9003', 'Книга В', { raw: { sourceBookId: '9003' } }),
    ])
  );

  const stats = buildBooksStats({ profile: 'livelib-Blacklist', includeMangaComics: true });
  const names = stats.series.map((entry) => entry.name);
  assert.deepEqual(names, ['Хроники Амбера']);
  assert.equal(stats.series.length, 1);
  assert.equal(stats.series[0].count, 1);
  assert.equal(stats.summary.seriesCount, 1);
  // Two works lost the tag (the Литрес one and the file-column one).
  assert.equal(stats.summary.seriesTagsFiltered, 2);
  // The tag is not hiding books: the works are still counted.
  assert.equal(stats.summary.bookCount, 3);
  // And no widget entry leaks the tag name.
  assert.ok(!JSON.stringify(stats).includes('Книга на все времена'));
});
