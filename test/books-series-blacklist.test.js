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

test('every confirmed tag is filtered, whatever its spelling', () => {
  // Full list confirmed by the user 28.10.2026 (publisher catalogues/promo
  // shelves, not literary series). The canonical spelling lives in the module;
  // here we pin that each one actually bites in the spellings a Литрес/Эксмо
  // export produces.
  const confirmed = [
    'Книга на все времена',
    'Азбука-классика',
    'Эксклюзивная классика',
    'The Big Book',
    'Иностранная литература. Большие книги',
    'Женская библиотека',
    'Зарубежная классика',
    'Зачарованный мир',
    'Золотая серия фэнтези',
    'Классика',
    'Библиотека приключений',
    'Pocket book',
    'Классики и современники',
    'Прочесть обязательно!',
    'Русская классика',
    'Шорт-лист',
  ];
  for (const name of confirmed) {
    assert.ok(
      SERIES_BLACKLIST.includes(name),
      `missing from SERIES_BLACKLIST: ${name}`
    );
    for (const variant of [
      name,
      name.toLowerCase(),
      name.toUpperCase(),
      `«${name}»`,
      `${name} (Эксмо)`,
      `  ${name}. `,
    ]) {
      assert.equal(isBlacklistedSeries(variant), true, variant);
    }
  }
});

test('normalisation folds the pocket-book variant into «Азбука-классика»', () => {
  // «Азбука-классика (pocket-book)» is the same shelf; the parenthetical is
  // dropped by normalisation, so a second array entry would be a silent
  // duplicate of the same key. The real export carries both spellings.
  assert.equal(blacklistKey('Азбука-классика (pocket-book)'), 'азбука классика');
  assert.equal(blacklistKey('Азбука-классика'), 'азбука классика');
  assert.equal(isBlacklistedSeries('Азбука-классика (pocket-book)'), true);
  assert.equal(isBlacklistedSeries('АЗБУКА-КЛАССИКА (POCKET-BOOK)'), true);

  // …and the list itself must not carry two entries with one key: a duplicate
  // would be a change that does nothing, so it is banned explicitly.
  const keys = SERIES_BLACKLIST.map(blacklistKey);
  assert.equal(new Set(keys).size, keys.length, `duplicate keys: ${keys.join(', ')}`);
});

test('exact match only: real series with these words are not touched', () => {
  // Short, generic tags («Классика», «Pocket book») are the dangerous ones.
  // Matching is the whole normalized key, so a longer name that *contains* a
  // tag is a different series and must survive.
  for (const legit of [
    'Моэм — автор на все времена',
    'Зарубежная классика. XX век',
    'Иностранная литература. Современная классика',
    'Антиутопии. Классика',
    'Классика детектива',
    'Классика в школе',
    'Лениздат-классика',
    'Новые краски классики',
    'Всемирная детская классика',
    'Лучшая мировая классика',
    'Исторический роман. Классика',
    'Мировая классика',
    'Pocket Book of Horror',
    'The Big Book of Fantasy',
    'Золотая библиотека фантастики',
    'Школьная библиотека',
    'Библиотека всемирной литературы',
    'Хроники Амбера',
  ]) {
    assert.equal(isBlacklistedSeries(legit), false, legit);
  }
  // A tag glued to a subtitle is no longer the tag either (exact-match rule).
  assert.equal(isBlacklistedSeries('Классика. Подарочное издание'), false);
  assert.equal(isBlacklistedSeries('Шорт-лист 2024'), false);
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

test('the whole confirmed list is dropped from the payload, look-alikes stay', async () => {
  // One work per kind of evidence: a Литрес tag that even carries an order, three
  // file-column tags (the column is the authority for a value), and three real
  // series whose names merely *contain* a short tag.
  await details('hc:9101', {
    schemaVersion: 2,
    hcWorkId: 9101,
    title: 'Книга 1',
    authors: [{ hcId: 11, name: 'Автор 1' }],
    genres: ['Проза'],
    series: [{ name: 'Азбука-классика (pocket-book)', position: 1, source: 'litres' }],
    metadataSources: ['litres'],
  });
  await details('hc:9106', {
    schemaVersion: 2,
    hcWorkId: 9106,
    title: 'Книга 6',
    authors: [{ hcId: 16, name: 'Автор 6' }],
    genres: ['Ужасы'],
    series: [{ hcId: 616, name: 'Pocket Book of Horror', position: 1 }],
    metadataSources: ['hardcover'],
  });
  for (const id of ['9101', '9102', '9103', '9104', '9105', '9106', '9107']) {
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
    'Tags',
    profile('Tags', [
      event('ll:9101', 'Книга 1', { raw: { sourceBookId: '9101' }, genres: ['Проза'] }),
      event('ll:9102', 'Книга 2', {
        raw: { sourceBookId: '9102' },
        fileSeries: 'Классика',
        genres: ['Проза'],
      }),
      event('ll:9103', 'Книга 3', {
        raw: { sourceBookId: '9103' },
        fileSeries: 'Pocket Book',
        genres: ['Проза'],
      }),
      event('ll:9104', 'Книга 4', {
        raw: { sourceBookId: '9104' },
        fileSeries: 'Моэм — автор на все времена',
        genres: ['Проза'],
      }),
      event('ll:9105', 'Книга 5', {
        raw: { sourceBookId: '9105' },
        fileSeries: 'Антиутопии. Классика',
        genres: ['Антиутопия'],
      }),
      event('ll:9106', 'Книга 6', { raw: { sourceBookId: '9106' }, genres: ['Ужасы'] }),
      event('ll:9107', 'Книга 7', {
        raw: { sourceBookId: '9107' },
        fileSeries: 'Зарубежная классика. XX век',
        genres: ['Проза'],
      }),
    ])
  );

  const stats = buildBooksStats({ profile: 'livelib-Tags', includeMangaComics: true });
  const names = stats.series.map((entry) => entry.name).sort();
  assert.deepEqual(names, [
    'Pocket Book of Horror',
    'Антиутопии. Классика',
    'Зарубежная классика. XX век',
    'Моэм — автор на все времена',
  ]);
  assert.equal(stats.summary.seriesCount, 4);
  // Three works lost a tag: the Литрес shelf, «Классика» and «Pocket Book».
  assert.equal(stats.summary.seriesTagsFiltered, 3);
  // No book is hidden by the filter.
  assert.equal(stats.summary.bookCount, 7);
  // No widget entry leaks a tag name (series list only: a genre could legally
  // be called «Классика» and is not what this filter governs).
  for (const tag of ['Азбука-классика', 'Классика', 'Pocket Book']) {
    assert.ok(!names.includes(tag), tag);
  }
});
