'use strict';

/**
 * Books: identity, cache and stats payload suite: the former standalone `*.test.js` files of this domain,
 * merged into one process (R19 test-suite consolidation).
 *
 * Each block below is its original file, kept verbatim inside its own
 * `describe()`:
 *
 *   - the describe title is the file stem, so every test stays greppable as
 *     `<file> > <original title>`;
 *   - the block scope keeps a file's helper names from colliding with its
 *     neighbours;
 *   - the hooks a file declared (`test.before`/`test.after`/
 *     `test.beforeEach`) stay scoped to that block instead of applying to the
 *     whole process.
 *
 * The tmp root is one `helpers/env` run for the whole suite, created BEFORE
 * any `server/**` require (every cache namespace reads its root once, at load
 * time). A file's own tmp setup folds into that root — the module singletons
 * are process-wide anyway, so a second root would only desynchronise a file
 * from the directory its assertions read. Tests keep apart by `userKey`/work
 * key, never by root.
 *
 * `env.cleanupTmpDirs()` removes every directory this run created.
 */

const { describe, after, before } = require('node:test');
const env = require('./helpers/env');

const run = env.makeTmpCache('books-stats-suite', { budgets: false });

after(() => {
  env.cleanupTmpDirs();
});

process.on('exit', () => {
  env.cleanupTmpDirs();
});


describe('books-book-identity', () => {
  /**
   * Book counting after the 28.10.2026 user verdict:
   *   - every LiveLib export row is a book/volume, even when several rows share
   *     one `/work/…` page (manga volumes). `resolved workId` enriches metadata,
   *     it does not dedupe bookCount;
   *   - an exact-identical row with the same book id is an export artifact;
   *   - Литрес catalogue tags never become series;
   *   - sub-series with the same books collapse to the larger/plainer one;
   *   - the year chart uses the work's first publication (ancient bucket);
   *   - «Недавно читал» includes month-precision events.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const CACHE = run.cacheBookDir;
  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const livelibFile = require('../server/books/livelib-file');
  const { buildBooksStats, dedupeSeriesSubsets } = require('../server/books/stats');

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
      authors: extra.authors || ['Хадзимэ Исаяма'],
      rating: extra.rating == null ? null : extra.rating,
      ratingScale: 10,
      rating10: extra.rating == null ? null : extra.rating,
      status: 'read',
      shelf: 'read',
      origin: 'livelib-file',
      finishedAt: extra.finishedAt || null,
      readMonth: extra.readMonth || null,
      edition: { publisher: null, year: extra.year || null, isbn: null, language: 'ru', series: extra.series || null },
      genres: extra.genres || [],
      ...extra.raw,
    };
  }

  test('every export row counts as a separate volume, even under one work', async () => {
    // Six rows of one `/work/…` page with different ratings/dates: six books.
    const events = Array.from({ length: 6 }, (_, index) =>
      event(`llfile:tk:issayama:read#${index + 1}`, 'Вторжение гигантов', {
        rating: index % 2 === 0 ? 9 : 10,
        readMonth: index === 5 ? '2015-05' : '2014-12',
        raw: { sourceBookId: '9001' },
      })
    );
    await bookCache.saveProfile('livelib', 'Volumes', profile('Volumes', events));

    const stats = buildBooksStats({ profile: 'livelib-Volumes', includeMangaComics: true });
    assert.equal(stats.summary.eventCount, 6);
    assert.equal(stats.summary.bookCount, 6, 'volumes must not collapse into one resolved work');
    assert.equal(Object.keys(stats.booksIndex).length, 6);
    assert.equal(stats.summary.reReadCount, 0, 'LiveLib rows are never re-reads');
    const workIds = Object.keys(stats.booksIndex);
    assert.ok(workIds.includes('ll:9001'));
    assert.ok(workIds.includes('ll:9001#2'));
    // Metadata identity stays the canonical work for every volume.
    assert.ok(Object.values(stats.booksIndex).every((book) => book.workId.startsWith('ll:9001')));
  });

  test('exact-identical rows of one book id are dropped, rows without ids are volumes', () => {
    const row = {
      bookHref: 'https://www.livelib.ru/book/1000496048-unesennye-vetrom',
      title: 'Унесенные ветром',
      readDate: 'Ноябрь 2014 г.',
      rating: { user: '5' },
      authors: [{ name: 'Маргарет Митчелл' }],
    };
    const parsed = livelibFile.parseExportFile(JSON.stringify([row, row, { ...row, readDate: '2002 г.' }]), {
      filename: 'read.json',
    });
    assert.equal(parsed.stats.books, 2);
    assert.equal(parsed.stats.exactDuplicateRows, 1);

    // A `/work/…` row has no book id: byte-identical rows are volumes.
    const workRow = {
      bookHref: 'https://www.livelib.ru/work/1000321539-bolshoj-kush',
      title: 'Большой куш',
      readDate: 'Январь 2010 г.',
      rating: { user: '4.5' },
      authors: [{ name: 'Эйитиро Ода' }],
    };
    const volumes = livelibFile.parseExportFile(JSON.stringify([workRow, workRow, workRow]), {
      filename: 'read.json',
    });
    assert.equal(volumes.stats.books, 3);
    assert.equal(volumes.stats.exactDuplicateRows, 0);
  });

  test('a Литрес catalogue tag does not become a series, even when the file column names it', async () => {
    await bookCache.saveDetails(7101, {
      schemaVersion: 2,
      hcWorkId: 7101,
      title: 'Книга',
      authors: [{ hcId: 1, name: 'Автор' }],
      series: [{ name: 'Книга на все времена', position: null, source: 'litres' }],
      genres: [],
      metadataSources: ['litres'],
    });
    await bookCache.saveLink('7101', { schemaVersion: 2, livelibBookId: '7101', workId: 'hc:7101', method: 'isbn', score: 1 });
    await bookCache.saveProfile(
      'livelib',
      'PseudoSeries',
      profile('PseudoSeries', [
        event('ll:7101', 'Книга', { raw: { sourceBookId: '7101' }, readMonth: '2020-01' }),
      ])
    );
    const noSeries = buildBooksStats({ profile: 'livelib-PseudoSeries', includeMangaComics: true });
    assert.deepEqual(noSeries.series, []);

    await bookCache.saveDetails(7101, {
      schemaVersion: 2,
      hcWorkId: 7101,
      title: 'Книга',
      authors: [{ hcId: 1, name: 'Автор' }],
      series: [{ name: 'Книга на все времена', position: null, source: 'litres' }],
      genres: [],
      metadataSources: ['litres'],
    });
    const withFileSeriesProfile = profile('FileSeries', [
      event('ll:7101', 'Книга', {
        raw: { sourceBookId: '7101' },
        readMonth: '2020-01',
        series: 'Книга на все времена',
      }),
    ]);
    await bookCache.saveProfile('livelib', 'FileSeries', withFileSeriesProfile);
    const withFileSeries = buildBooksStats({ profile: 'livelib-FileSeries', includeMangaComics: true });
    // 28.10.2026 (user decision): the export column is the authority for a
    // bibliographic *value*, not for the *kind* of the value. This is a
    // publisher's tag, so the blacklist removes it even when the file names it
    // (series-blacklist.js).
    assert.deepEqual(withFileSeries.series.map((entry) => entry.name), []);
    assert.equal(withFileSeries.summary.seriesTagsFiltered, 1);
    assert.equal(withFileSeries.summary.seriesCount, 0);

    await bookCache.saveDetails(7101, {
      schemaVersion: 2,
      hcWorkId: 7101,
      title: 'Книга',
      authors: [{ hcId: 1, name: 'Автор' }],
      series: [{ name: 'Настоящая серия', position: 3, source: 'litres' }],
      genres: [],
      metadataSources: ['litres'],
    });
    const ordered = buildBooksStats({ profile: 'livelib-PseudoSeries', includeMangaComics: true });
    assert.deepEqual(ordered.series.map((entry) => entry.name), ['Настоящая серия']);
  });

  test('series with the same books collapse to the larger/plainer one', () => {
    const list = [
      { name: 'The Witcher (Publication order)', count: 2, works: [{ workId: 'a' }, { workId: 'b' }] },
      { name: 'The Witcher', count: 2, works: [{ workId: 'a' }, { workId: 'b' }] },
      { name: 'Ведьмак. Сага', count: 1, works: [{ workId: 'a' }] },
      { name: 'Другая серия', count: 1, works: [{ workId: 'c' }] },
    ];
    assert.deepEqual(dedupeSeriesSubsets(list).map((entry) => entry.name), ['The Witcher', 'Другая серия']);
  });

  test('the year chart uses first publication and buckets ancient works', async () => {
    await bookCache.saveDetails(7201, {
      schemaVersion: 2,
      hcWorkId: 7201,
      title: 'Искусство войны',
      authors: [{ hcId: 2, name: 'Сунь Цзы' }],
      series: [],
      genres: [],
      publicationYear: 2013, // the print edition in hand
      firstPublishedYear: -500, // the work itself
      metadataSources: ['openlibrary'],
    });
    await bookCache.saveLink('7201', { schemaVersion: 2, livelibBookId: '7201', workId: 'hc:7201', method: 'isbn', score: 1 });
    await bookCache.saveProfile(
      'livelib',
      'Ancient',
      profile('Ancient', [
        event('ll:7201', 'Искусство войны', {
          raw: { sourceBookId: '7201' },
          authors: ['Сунь-Цзы'],
          year: 2019,
          readMonth: '2021-05',
        }),
      ])
    );
    const stats = buildBooksStats({ profile: 'livelib-Ancient', includeMangaComics: true });
    const book = Object.values(stats.booksIndex)[0];
    assert.equal(book.year, -500);
    assert.equal(stats.summary.ancientBookCount, 1);
    // The ancient work is not a year on the axis; it is the «до 1000 г.» column
    // of the year chart, with the same stable key as the decade bucket.
    assert.deepEqual(stats.years.map((entry) => [entry.key, entry.ancient, entry.count]), [
      ['before-1000', true, 1],
    ]);
    assert.ok(stats.decades.some((entry) => entry.label === 'до 1000 г.' && entry.count === 1));
    assert.equal(stats.decades.find((entry) => entry.ancient).key, 'before-1000');
    assert.equal(stats.decades.find((entry) => entry.ancient).beforeYear, 1000);
  });

  test('recently read includes month-precision file events', async () => {
    await bookCache.saveProfile(
      'livelib',
      'RecentMonths',
      profile('RecentMonths', [
        event('ll:1', 'Мартин Иден', { readMonth: '2023-03' }),
        event('ll:2', 'Стезя смерти', { readMonth: '2024-01' }),
        event('ll:3', 'Без даты'),
      ])
    );
    const stats = buildBooksStats({ profile: 'livelib-RecentMonths', includeMangaComics: true });
    assert.equal(stats.recentlyFinished.length, 2);
    assert.deepEqual(
      stats.recentlyFinished.map((entry) => [entry.date, entry.precision]),
      [['2024-01', 'month'], ['2023-03', 'month']]
    );
  });
  after(() => env.resetMutableState());
});


describe('books-cache', () => {
  /**
   * Book cache: fingerprint invalidation + atomic writes.
   * A running server must observe files rewritten by an import/backfill process
   * without a restart (the f428493 lesson); memory entries are only trusted
   * while their file fingerprint is unchanged.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const BOOK_CACHE_DIR = run.cacheBookDir;
  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');

  function profile(events) {
    return {
      schemaVersion: 1,
      source: 'livelib',
      userKey: 'tester',
      importedAt: new Date().toISOString(),
      events,
      warnings: [],
    };
  }

  test('profile memory entry is invalidated by an external rewrite', () => {
    const first = profile([{ id: 'll:1', sourceBookId: '1', title: 'One' }]);
    return bookCache.saveProfile('livelib', 'tester', first).then(() => {
      assert.equal(bookCache.getProfile('livelib', 'tester').events.length, 1);

      // Simulate another process replacing the file atomically.
      const target = bookCache.profilePath('livelib', 'tester');
      const tmp = `${target}.other.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify(profile([
          { id: 'll:1', sourceBookId: '1', title: 'One' },
          { id: 'll:2', sourceBookId: '2', title: 'Two' },
        ])),
        'utf8'
      );
      fs.renameSync(tmp, target);

      const reloaded = bookCache.getProfile('livelib', 'tester');
      assert.equal(reloaded.events.length, 2);
      assert.equal(reloaded.events[1].title, 'Two');
    });
  });

  test('details and links memory entries follow the file fingerprint', async () => {
    await bookCache.saveDetails(42, { schemaVersion: 1, hcWorkId: 42, title: 'Alpha' });
    assert.equal(bookCache.getDetails(42).title, 'Alpha');

    const detailsFile = bookCache.detailsPath(42);
    fs.writeFileSync(detailsFile, JSON.stringify({ schemaVersion: 1, hcWorkId: 42, title: 'Alpha v2' }));
    assert.equal(bookCache.getDetails(42).title, 'Alpha v2');

    await bookCache.saveLink('100', { schemaVersion: 1, livelibBookId: '100', workId: 'hc:42' });
    assert.equal(bookCache.getLink('100').workId, 'hc:42');

    const linkFile = bookCache.linkPath('100');
    fs.writeFileSync(linkFile, JSON.stringify({ schemaVersion: 1, livelibBookId: '100', workId: null }));
    assert.equal(bookCache.getLink('100').workId, null);
  });

  test('listProfiles reports metadata from disk and tolerates corrupt files', async () => {
    await bookCache.saveProfile('hardcover', '34748', {
      schemaVersion: 1,
      source: 'hardcover',
      userKey: '34748',
      sourceUserId: 34748,
      importedAt: '2026-10-27T00:00:00.000Z',
      events: [
        { id: 'hc:read:1', sourceBookId: '7', finishedAt: '2024-01-01' },
        { id: 'hc:ub:2', sourceBookId: '8', finishedAt: null },
      ],
      warnings: [],
    });
    fs.writeFileSync(path.join(bookCache.PROFILES_DIR, 'broken.json'), '{not json', 'utf8');

    const profiles = bookCache.listProfiles();
    const hardcover = profiles.find((entry) => entry.source === 'hardcover');
    assert.ok(hardcover);
    assert.equal(hardcover.userKey, '34748');
    assert.equal(hardcover.eventCount, 2);
    assert.equal(hardcover.finishedCount, 1);
  });

  test('index.json merges local writes with an externally replaced file', async () => {
    const indexFile = bookCache.INDEX_PATH;
    fs.writeFileSync(indexFile, JSON.stringify({ 'll:1': 111 }), 'utf8');

    bookCache.setIndexValue('ll:2', 222);
    bookCache.flushIndex();
    assert.equal(bookCache.getIndexEntry('ll:2'), 222);

    // External process adds a key and keeps ours.
    fs.writeFileSync(indexFile, JSON.stringify({ 'll:1': 111, 'll:2': 222, 'll:3': 333 }), 'utf8');
    bookCache.setIndexValue('ll:4', 444);
    bookCache.flushIndex();

    assert.equal(bookCache.getIndexEntry('ll:1'), 111);
    assert.equal(bookCache.getIndexEntry('ll:3'), 333);
    assert.equal(bookCache.getIndexEntry('ll:4'), 444);
  });

  test('safeKey never escapes the cache directory', () => {
    assert.equal(bookCache.safeKey('../../etc/passwd'), '.._.._etc_passwd');
    assert.equal(bookCache.safeKey('Margaret'), 'Margaret');
  });
  after(() => env.resetMutableState());
});


describe('books-collections', () => {
  /**
   * Collection / omnibus rows -> separate works (СБОРНИКИ-ЭВРИСТИКА §2/§5).
   *
   * Pinned here:
   *   - the conservative splitter (`. ` only, initials/`Vol.`/`Р.И.К.` survive,
   *     the final period never makes an empty tail);
   *   - «no structural marker -> one book» and the volume-subtitle guard (§2.3/§2.4);
   *   - the catalogue line (`catalogSeries`) is not a work;
   *   - the record keeps its own title and keys; segments are additive fields;
   *   - a re-import does not duplicate segments;
   *   - stats semantics: a collection row counts its PROVEN works (not the
   *     anthology), the rating is not spread, the date is inherited, the
   *     timeline still counts the row once;
   *   - author gate and the `medium` opt-in;
   *   - a row already decided as one book (link / manual year) is never re-opened.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const BOOK_CACHE_DIR = run.cacheBookDir;
  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;
  process.env.GB_API_KEY = 'AIzaSy_TEST_FIXTURE_KEY';

  const bookCache = require('../server/books/book-cache');
  const segments = require('../server/books/segments');
  const livelibFile = require('../server/books/livelib-file');
  const resolve = require('../server/books/resolve');
  const scheduledResolve = require('../server/books/scheduled-resolve');
  const googlebooks = require('../server/books/providers/googlebooks');
  const { buildBooksStats } = require('../server/books/stats');

  const USER_TITLE =
    'Американская фантастика. Комплект из 14 томов. Том 8. Планета изгнания. ' +
    'Слово для «леса» и «мира» одно. Рассказы (сборник)';

  const HARDY_TITLE = "Том 2. В краю лесов. Тесс из рода д'Эрбервиллей (сборник)";

  /* ------------------------------------------------------------------ */
  /* Parser (the reference examples of §2)                               */
  /* ------------------------------------------------------------------ */

  test('user example: two works, catalogue line and three junk parts', () => {
    const parsed = segments.parseCollectionTitle(USER_TITLE);
    assert.equal(parsed.isCollection, true);
    assert.equal(parsed.catalog, 'Американская фантастика');
    assert.deepEqual(parsed.works.map((work) => work.title), [
      'Планета изгнания',
      'Слово для «леса» и «мира» одно',
    ]);
    assert.deepEqual(parsed.junk.map((item) => item.text), [
      'Комплект из 14 томов',
      'Том 8',
      'Рассказы (сборник)',
    ]);
  });

  test('split is on ". " only: initials, Vol. and the final period survive', () => {
    assert.deepEqual(segments.splitTitleSegments('Eyeshield 21, Vol. 2'), ['Eyeshield 21, Vol. 2']);
    assert.deepEqual(segments.splitTitleSegments('Дж. Р. Р. Толкин. Хоббит'), ['Дж. Р. Р. Толкин', 'Хоббит']);
    assert.deepEqual(segments.splitTitleSegments('Р.И.К.'), ['Р.И.К.']);
  });

  test('an ordinary book with a subtitle is NOT a collection', () => {
    for (const title of [
      'Дьюи. Кот из библиотеки, который потряс весь мир',
      'Геймдизайн. Рецепты успеха…',
      'Философские повести. Орлеанская девственница',
    ]) {
      const parsed = segments.parseCollectionTitle(title);
      assert.equal(parsed.isCollection, false, title);
      assert.equal(parsed.works.length, 1, title);
    }
  });

  test('series + volume + subtitle is one book, not two works', () => {
    for (const title of [
      'Кафе "Таро". Том 4',
      'Диагностика кармы. Книга 2. Чистая карма',
      'Сага о Форсайтах. В четырех томах. Том 2 (сборник)',
      'Хеллсинг. Все 10 томов',
    ]) {
      const parsed = segments.parseCollectionTitle(title);
      assert.equal(parsed.isCollection, false, title);
      assert.equal(parsed.works.length, 1, title);
    }
  });

  test('leading volume marker: the works after it are separate', () => {
    const parsed = segments.parseCollectionTitle(HARDY_TITLE);
    assert.equal(parsed.isCollection, true);
    assert.deepEqual(parsed.works.map((work) => work.title), [
      'В краю лесов',
      "Тесс из рода д'Эрбервиллей",
    ]);
    assert.deepEqual(parsed.junk.map((item) => item.text), ['Том 2']);
  });

  test('a bare «Собрание сочинений» with a volume stays a single book', () => {
    const parsed = segments.parseCollectionTitle('Собрание сочинений. В 8 т. Том 3');
    assert.equal(parsed.isCollection, false);
    assert.equal(parsed.works.length, 1);
  });

  test('empty / junk-only titles never throw', () => {
    for (const value of ['', '   ', null, undefined, 'Том 4', '(сборник)', 'Все 10 томов']) {
      const parsed = segments.parseCollectionTitle(value);
      assert.equal(parsed.isCollection, false);
      assert.ok(Array.isArray(parsed.works));
    }
  });

  test('catalogue line repeats at the head -> dropped, works kept', () => {
    const titles = [
      'Американская фантастика. Комплект из 14 томов. Том 1. Первая вещь',
      'Американская фантастика. Комплект из 14 томов. Том 2. Вторая вещь',
      'Американская фантастика. Комплект из 14 томов. Том 3. Третья вещь',
    ];
    const counts = segments.firstSegmentCounts(titles);
    const parsed = segments.parseCollectionTitle(
      'Американская фантастика. Комплект из 14 томов. Том 4. Четвёртая вещь. Пятая вещь',
      { firstCounts: counts }
    );
    assert.equal(parsed.catalog, 'Американская фантастика');
    assert.deepEqual(parsed.works.map((work) => work.title), ['Четвёртая вещь', 'Пятая вещь']);
  });

  test('segment keys are stable and derived from the work title only', () => {
    const a = segments.collectionFieldsOf(HARDY_TITLE);
    const b = segments.collectionFieldsOf(HARDY_TITLE);
    assert.deepEqual(a, b);
    assert.deepEqual(a.segmentTitles, ['В краю лесов', "Тесс из рода д'Эрбервиллей"]);
    assert.match(a.collectionSegments[0].key, /^[0-9a-f]{10}$/);
    assert.equal(segments.collectionFieldsOf('Дьюи. Кот из библиотеки'), null);
  });

  /* ------------------------------------------------------------------ */
  /* File import: additive fields, keys untouched, idempotent           */
  /* ------------------------------------------------------------------ */

  function collectionExport() {
    return JSON.stringify([
      {
        title: HARDY_TITLE,
        bookHref: 'https://www.livelib.ru/book/555-tom-2',
        readDate: 'Май 2024 г.',
        rating: { user: '5' },
        authors: [{ name: 'Томас Гарди' }],
        details: { year: '2001', publishers: 'Эксмо', series: 'Библиотека классики' },
        genres: [{ name: 'Классика' }],
      },
      {
        title: 'Аннигиляция',
        bookHref: 'https://www.livelib.ru/book/556-annigilyatsiya',
        readDate: 'Июнь 2024 г.',
        authors: [{ name: 'Джефф Вандермеер' }],
      },
    ]);
  }

  test('normalizeRecord adds segments without touching the title or its key', () => {
    const parsed = livelibFile.parseExportFile(collectionExport(), {
      filename: 'livelib-coll-read-29.10.2026.json',
    });
    const [row, plain] = parsed.books;
    assert.equal(row.title, HARDY_TITLE, 'the record keeps the publisher title');
    assert.deepEqual(row.segmentTitles, ['В краю лесов', "Тесс из рода д'Эрбервиллей"]);
    assert.equal(row.collectionSegments.length, 2);
    // The identity key is the same as it would be without segmentation: the
    // segments never enter `titleKey` (state/cache keys must not move).
    const keyWithout = livelibFile.normalizeRecord({ title: HARDY_TITLE, authors: ['Томас Гарди'] });
    assert.equal(row.titleKey, keyWithout.titleKey);
    assert.equal(plain.collectionSegments, undefined);
    assert.equal(parsed.stats.collections, 1);
    assert.equal(parsed.stats.collectionWorks, 2);
  });

  test('a repeated import does not duplicate segments', () => {
    const parsed = livelibFile.parseExportFile(collectionExport(), { filename: 'livelib-coll-read.json' });
    const first = livelibFile.mergeFileIntoProfile(null, {
      userKey: 'CollReimport',
      books: parsed.books,
      shelf: 'read',
      format: 'json',
      now: '2026-10-30T00:00:00.000Z',
    });
    assert.equal(first.added, 2);
    const stored = first.profile.events.find((event) => event.title === HARDY_TITLE);
    assert.equal(stored.collectionSegments.length, 2);

    const again = livelibFile.mergeFileIntoProfile(first.profile, {
      userKey: 'CollReimport',
      books: parsed.books,
      shelf: 'read',
      format: 'json',
      now: '2026-10-30T01:00:00.000Z',
    });
    assert.equal(again.added, 0);
    assert.equal(again.profile.events.length, 2);
    const after = again.profile.events.find((event) => event.title === HARDY_TITLE);
    assert.equal(after.collectionSegments.length, 2);
    assert.deepEqual(after.collectionSegments, stored.collectionSegments);

    // A newer export of the same row (year column added) enriches, never re-splits.
    const enriched = livelibFile.parseExportFile(
      collectionExport().replace('"year":"2001"', '"year":"2002"'),
      { filename: 'livelib-coll-read-30.10.2026.json' }
    );
    const third = livelibFile.mergeFileIntoProfile(again.profile, {
      userKey: 'CollReimport',
      books: enriched.books,
      shelf: 'read',
      format: 'json',
      now: '2026-10-30T02:00:00.000Z',
    });
    assert.equal(third.added, 0);
    const row = third.profile.events.find((event) => event.title === HARDY_TITLE);
    assert.equal(row.collectionSegments.length, 2);
  });

  /* ------------------------------------------------------------------ */
  /* Stats semantics                                                     */
  /* ------------------------------------------------------------------ */

  function hardyParent(overrides = {}) {
    return {
      id: 'llfile:id:555:read',
      fileKey: 'id:555',
      source: 'livelib-file',
      origin: 'livelib-file',
      sourceBookId: '555',
      sourceUrl: 'https://www.livelib.ru/book/555-tom-2',
      workId: null,
      title: HARDY_TITLE,
      authors: ['Томас Гарди'],
      rating: 5,
      ratingScale: 5,
      rating10: 10,
      status: 'read',
      shelf: 'read',
      startedAt: null,
      startMonth: null,
      finishedAt: null,
      readMonth: '2024-05',
      readDateRaw: 'Май 2024 г.',
      reread: false,
      readIndex: 1,
      edition: { publisher: 'Эксмо', year: 2001, series: 'Библиотека классики' },
      genres: ['Классика'],
      coverUrl: null,
      communityRating: null,
      bookStats: null,
      ...segments.collectionFieldsOf(HARDY_TITLE),
      ...overrides,
    };
  }

  function profileOf(events, userKey = 'Coll') {
    return {
      schemaVersion: 1,
      source: 'livelib',
      userKey,
      origin: 'livelib-file',
      importedAt: '2026-10-30T00:00:00.000Z',
      events,
    };
  }

  async function saveHardyDetails() {
    await bookCache.saveDetails(9001, {
      schemaVersion: 1,
      hcWorkId: 9001,
      title: 'Under the Greenwood Tree',
      authors: [{ hcId: 1, name: 'Thomas Hardy' }],
      genres: ['Classics'],
      series: [],
      pages: 320,
      firstPublishedYear: 1872,
      publicationYear: 1872,
      partial: false,
    });
    await bookCache.saveDetails(9002, {
      schemaVersion: 1,
      hcWorkId: 9002,
      title: "Tess of the d'Urbervilles",
      authors: [{ hcId: 1, name: 'Thomas Hardy' }],
      genres: ['Classics'],
      series: [],
      pages: 592,
      firstPublishedYear: 1891,
      publicationYear: 1891,
      partial: false,
    });
  }

  test('a collection row counts its proven works, not the anthology', async () => {
    await saveHardyDetails();
    const parent = hardyParent();
    const [s1, s2] = parent.collectionSegments;
    await bookCache.saveLink(`file:id:555::seg:${s1.key}`, {
      schemaVersion: 2,
      livelibBookId: `file:id:555::seg:${s1.key}`,
      workId: 'hc:9001',
      method: 'litres-title',
      score: 0.95,
    });
    await bookCache.saveLink(`file:id:555::seg:${s2.key}`, {
      schemaVersion: 2,
      livelibBookId: `file:id:555::seg:${s2.key}`,
      workId: 'hc:9002',
      method: 'litres-title',
      score: 0.95,
    });
    await bookCache.saveProfile('livelib', 'Coll', profileOf([parent]));

    const stats = buildBooksStats({ profile: 'livelib-Coll' });
    assert.equal(stats.summary.bookCount, 2, 'two works, not one anthology');
    assert.equal(stats.summary.eventCount, 1, 'one record');
    assert.equal(stats.summary.monthOnlyEventCount, 1, 'the row stays one dated event');
    assert.equal(stats.timeline.length, 1);
    assert.equal(stats.timeline[0].monthOnly, 1, 'the month is not tripled');
    // The anthology's 10/10 is not spread over the works.
    assert.deepEqual(stats.ratings.merged, []);
    assert.equal(stats.summary.avgRating, null);
    // Both works are in the index with their own metadata and the parent link.
    const ids = Object.keys(stats.booksIndex).sort();
    assert.deepEqual(ids, ['hc:9001', 'hc:9002']);
    const first = stats.booksIndex['hc:9001'];
    assert.equal(first.title, 'Under the Greenwood Tree');
    assert.equal(first.year, 1872);
    assert.equal(first.rating, null);
    assert.equal(first.finishedDate, null, 'no day invented');
    assert.deepEqual(first.collection, {
      workId: 'll:555',
      title: HARDY_TITLE,
      catalogSeries: null,
      parentUrl: 'https://www.livelib.ru/book/555-tom-2',
    });
    // Authors/years payload carries the works (their own resolved metadata:
    // the record's «Томас Гарди» becomes the canonical «Thomas Hardy»).
    const hardy = stats.authors.find((author) => /hardy/i.test(author.name));
    assert.equal(hardy.count, 2);
    assert.deepEqual(stats.years.map((entry) => entry.year), [1872, 1891]);
    assert.deepEqual(stats.summary.collections, {
      rows: 1,
      parsedWorks: 2,
      linkedWorks: 2,
      visibleWorks: 2,
      dedupedWorks: 0,
      fallbackRows: 0,
      catalogRows: 0,
      noAuthorWorks: 0,
      blockedRows: 0,
      blockedByReason: { linked: 0, details: 0, manual_year: 0 },
      includeMedium: false,
    });
  });

  test('medium links need the explicit opt-in; otherwise the row stays one book', async () => {
    await saveHardyDetails();
    const parent = hardyParent({ id: 'llfile:id:557:read', fileKey: 'id:557', sourceBookId: '557' });
    const [s1, s2] = parent.collectionSegments;
    for (const [segment, workId] of [[s1, 'hc:9001'], [s2, 'hc:9002']]) {
      await bookCache.saveLink(`file:id:557::seg:${segment.key}`, {
        schemaVersion: 2,
        livelibBookId: `file:id:557::seg:${segment.key}`,
        workId,
        method: 'googlebooks-title',
        score: 0.85,
      });
    }
    await bookCache.saveProfile('livelib', 'CollMedium', profileOf([parent], 'CollMedium'));

    const strict = buildBooksStats({ profile: 'livelib-CollMedium' });
    assert.equal(strict.summary.bookCount, 1);
    assert.equal(strict.summary.collections.linkedWorks, 0);
    assert.equal(strict.summary.collections.fallbackRows, 1);
    assert.equal(strict.booksIndex['ll:557'].title, HARDY_TITLE);

    const relaxed = buildBooksStats({ profile: 'livelib-CollMedium', includeMediumSegments: true });
    assert.equal(relaxed.summary.bookCount, 2);
    assert.equal(relaxed.summary.collections.includeMedium, true);
  });

  test('two segments of one row that resolve to the same work are one book', async () => {
    await saveHardyDetails();
    const parent = hardyParent({ id: 'llfile:id:558:read', fileKey: 'id:558', sourceBookId: '558' });
    const [s1, s2] = parent.collectionSegments;
    for (const segment of [s1, s2]) {
      await bookCache.saveLink(`file:id:558::seg:${segment.key}`, {
        schemaVersion: 2,
        livelibBookId: `file:id:558::seg:${segment.key}`,
        workId: 'hc:9001',
        method: 'isbn',
        score: 1,
      });
    }
    await bookCache.saveProfile('livelib', 'CollDedupe', profileOf([parent], 'CollDedupe'));

    const stats = buildBooksStats({ profile: 'livelib-CollDedupe' });
    assert.equal(stats.summary.bookCount, 1);
    assert.equal(stats.summary.collections.dedupedWorks, 1);
    assert.equal(stats.summary.collections.visibleWorks, 1);
  });

  test('a row already linked as one book is never re-opened', async () => {
    await bookCache.saveLink('559', {
      schemaVersion: 2,
      livelibBookId: '559',
      workId: 'hc:9001',
      method: 'isbn',
      score: 1,
    });
    const parent = hardyParent({ id: 'llfile:id:559:read', fileKey: 'id:559', sourceBookId: '559' });
    await bookCache.saveProfile('livelib', 'CollGuard', profileOf([parent], 'CollGuard'));

    const stats = buildBooksStats({ profile: 'livelib-CollGuard' });
    assert.equal(stats.summary.bookCount, 1);
    assert.equal(stats.summary.collections.rows, 0);
    assert.equal(stats.summary.collections.blockedRows, 1);
    assert.equal(stats.summary.collections.blockedByReason.linked, 1);
    assert.ok(stats.booksIndex['hc:9001']);
  });

  test('a manual year edit on the row also wins over segmentation', async () => {
    const parent = hardyParent({ id: 'llfile:id:560:read', fileKey: 'id:560', sourceBookId: '560' });
    await bookCache.saveProfile('livelib', 'CollYear', profileOf([parent], 'CollYear'));
    await bookCache.setYearOverride('livelib', 'CollYear', 'll:560', 1900);

    const stats = buildBooksStats({ profile: 'livelib-CollYear' });
    assert.equal(stats.summary.bookCount, 1);
    assert.equal(stats.summary.collections.blockedByReason.manual_year, 1);
    assert.equal(stats.booksIndex['ll:560'].year, 1900);
  });

  test('a segment without authors is never searched (no blind title search)', () => {
    const parent = hardyParent({ authors: [] });
    const events = segments.segmentEventsOf({ ...parent, workId: 'll:555' });
    assert.equal(events.length, 2);
    for (const event of events) assert.deepEqual(event.authors, []);
    // The author gate itself: no record author can confirm any provider author.
    assert.equal(segments.segmentAuthorConfirmed([], ['Thomas Hardy']), false);
    assert.equal(segments.segmentAuthorConfirmed(['Томас Гарди'], ['Thomas Hardy']), true);
    assert.equal(segments.segmentAuthorConfirmed(['Томас Гарди'], ['Лев Толстой']), false);
  });

  /* ------------------------------------------------------------------ */
  /* Resolve: segments are the pool, the parent is not matched           */
  /* ------------------------------------------------------------------ */

  function gbResponse(items) {
    return {
      status: 200,
      headers: { get: () => null },
      async json() {
        return { items };
      },
      async text() {
        return JSON.stringify({ items });
      },
    };
  }

  function gbItem(id, title, authors) {
    return {
      id,
      volumeInfo: {
        title,
        authors,
        publishedDate: '2001',
        pageCount: 300,
        industryIdentifiers: [],
      },
    };
  }

  test('resolve expands a collection row into works and gates them by author', async () => {
    const parent = hardyParent({ id: 'llfile:id:777:read', fileKey: 'id:777', sourceBookId: '777' });
    const profile = profileOf([parent]);
    const requests = [];
    const fetchImpl = async (url) => {
      const text = decodeURIComponent(String(url));
      requests.push(text);
      if (text.includes('В краю лесов')) {
        return gbResponse([gbItem('gb1', 'В краю лесов', ['Томас Гарди'])]);
      }
      if (text.includes('Тесс из рода')) {
        // Right title, wrong author: the author gate must reject it.
        return gbResponse([gbItem('gb2', "Тесс из рода д'Эрбервиллей", ['Лев Толстой'])]);
      }
      return gbResponse([]);
    };
    const report = await resolve.resolveProfile(profile, {
      providers: ['googlebooks'],
      fetchImpl,
      sleep: async () => {},
      requestDelayMs: 0,
      gbBudget: googlebooks.createBudget(10),
    });
    assert.equal(report.total, 2, 'the parent row is not a resolve input');
    const first = parent.collectionSegments[0];
    const second = parent.collectionSegments[1];
    const link = bookCache.getLink(`file:id:777::seg:${first.key}`);
    assert.ok(link, 'the confirmed work got a link');
    assert.equal(link.workId, 'gb:gb1');
    assert.equal(bookCache.getLink(`file:id:777::seg:${second.key}`), null);
    assert.equal(bookCache.getLink('file:id:777'), null, 'the anthology itself was not searched');
    // Two requests: one per work, none for the parent.
    assert.equal(requests.filter((text) => text.includes('googleapis.com/books')).length, 2);
  });

  test('the scheduled resolve walks the works of a visible collection row, not the anthology', async () => {
    const parent = hardyParent({ id: 'llfile:id:561:read', fileKey: 'id:561', sourceBookId: '561' });
    await bookCache.saveProfile('livelib', 'CollPool', profileOf([parent], 'CollPool'));
    const stats = buildBooksStats({ profile: 'livelib-CollPool' });
    assert.equal(stats.summary.bookCount, 1, 'no proven work -> the row itself');

    const pool = scheduledResolve.candidatePool(
      bookCache.getProfile('livelib', 'CollPool'),
      { allowedWorkIds: new Set(Object.keys(stats.booksIndex)) }
    );
    assert.equal(pool.length, 2);
    assert.ok(pool.every((entry) => entry.key.includes('::seg:')));
    assert.deepEqual(
      pool.map((entry) => entry.event.title).sort(),
      ['В краю лесов', "Тесс из рода д'Эрбервиллей"].sort()
    );
  });
  after(() => env.resetMutableState());
});


describe('books-stats-sections', () => {
  /**
   * Section builders of the books stats payload (S2 split).
   *
   * These are *unit* checks of the pure builders that came out of the
   * `buildBooksStats` god-function (`server/books/stats/*`). They do not replace
   * the golden snapshot (`test/golden.test.js`) — the payload contract is
   * covered there byte-for-byte. Here only the two rules that are easy to break
   * when a section moves to its own file are pinned:
   *
   *   - the year buckets keep the ancient slot OFF the `years[]` axis and
   *     «год неизвестен» last on `decades[]`;
   *   - the pages histogram follows `PAGE_BUCKETS` bounds (inclusive) and
   *     `avgRating` ignores unrated works.
   *
   * The builders are pure reads of a context, so no cache, no tmp dirs and no
   * network are involved: a hand-built `{ works }` map is the whole fixture.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');

  const { buildYearBuckets, buildPagesHistogram } = require('../server/books/stats/widgets');

  function makeWork(overrides = {}) {
    return {
      workId: 'll:1',
      title: 'Книга',
      authors: ['Автор'],
      rating10: null,
      year: null,
      yearSource: null,
      genres: [],
      series: [],
      publisher: null,
      pages: null,
      ...overrides,
    };
  }

  function contextOf(works) {
    return { works: new Map(works.map((work) => [work.workId, work])) };
  }

  test('widgets: year buckets keep the ancient slot off the years axis', () => {
    const ctx = contextOf([
      makeWork({ workId: 'll:1', year: 2019, yearSource: 'first', rating10: 8 }),
      makeWork({ workId: 'll:2', year: 2019, yearSource: 'edition', rating10: 6 }),
      makeWork({ workId: 'll:3', year: 950, yearSource: 'first', rating10: 10 }),
      makeWork({ workId: 'll:4', year: null }),
    ]);

    const { decades, years } = buildYearBuckets(ctx);

    assert.deepEqual(
      decades.map((entry) => entry.key || entry.decade),
      ['before-1000', 2010, null],
      'ancient first, real decades in order, «год неизвестен» last'
    );
    assert.equal(decades[0].count, 1);
    assert.equal(decades[1].count, 2);
    assert.equal(decades[1].firstCount, 1);
    assert.equal(decades[1].editionCount, 1);
    assert.equal(decades[1].avgRating, 7);
    assert.equal(decades[2].unknown, true);

    // Ancient works never enter `years[]` (they are one bucket, not a year), and
    // the year bucket carries the same counters as the decade bucket.
    assert.deepEqual(
      years.map((entry) => entry.year || entry.key),
      ['before-1000', 2019]
    );
    assert.equal(years[0].count, 1);
    assert.equal(years[1].count, 2);
    assert.equal(years[1].avgRating, 7);
  });

  test('widgets: pages histogram uses the PAGE_BUCKETS bounds, avgRating skips unrated', () => {
    const ctx = contextOf([
      makeWork({ workId: 'll:1', pages: 50, rating10: 8 }),
      makeWork({ workId: 'll:2', pages: 99, rating10: 6 }),
      makeWork({ workId: 'll:3', pages: 100 }),
      makeWork({ workId: 'll:4', pages: 1000, rating10: 9 }),
      makeWork({ workId: 'll:5', pages: null, rating10: 10 }),
    ]);

    const histogram = buildPagesHistogram(ctx);

    assert.deepEqual(
      histogram.map((bucket) => [bucket.bucket, bucket.count, bucket.avgRating]),
      [
        ['<100', 2, 7],
        ['100-199', 1, null],
        ['200-299', 0, null],
        ['300-399', 0, null],
        ['400-499', 0, null],
        ['500-699', 0, null],
        ['700-999', 0, null],
        ['1000+', 1, 9],
      ]
    );
  });
  after(() => env.resetMutableState());
});


describe('books-stats-series-manga', () => {
  /**
   * Books stats: series-level manga/comics propagation.
   *
   * Hardcover tags are inconsistent inside one series (comics on some volumes,
   * plain "Fantasy" or no genres on others). A single comics volume must mark
   * the whole series as comics for the default filter — and only for that
   * series: standalone works keep their own tri-state flag.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const { buildBooksStats, propagateSeriesManga } = require('../server/books/stats');

  async function details(workId, doc) {
    await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), {
      schemaVersion: 2,
      workId,
      ...doc,
    });
  }

  function hcEvent(bookId, title, finishedAt) {
    return {
      id: `hc:read:${bookId}`,
      source: 'hardcover',
      sourceBookId: String(bookId),
      workId: `hc:${bookId}`,
      title,
      authors: ['Bill Willingham'],
      status: 'read',
      statusId: 3,
      finishedAt,
      edition: {},
    };
  }

  test.before(async () => {
    // Fables: vol A explicit comics, vol B explicit clean genres, vol C no genres.
    await details('hc:701', {
      title: 'Fables, Vol. 6',
      authors: [{ name: 'Bill Willingham' }],
      genres: ['Graphic Novels', 'Fantasy'],
      series: [{ hcId: 2700, name: 'Fables', position: 6 }],
      mangaComics: true,
    });
    await details('hc:702', {
      title: 'Fables, Vol. 14',
      authors: [{ name: 'Bill Willingham' }],
      genres: ['Fantasy', 'Adventure'],
      series: [{ hcId: 2700, name: 'Fables', position: 14 }],
      mangaComics: false,
    });
    await details('hc:703', {
      title: 'Fables, Vol. 22',
      authors: [{ name: 'Bill Willingham' }],
      genres: [],
      series: [{ hcId: 2700, name: 'Fables', position: 22 }],
      mangaComics: null,
    });

    // Name-only series (LiveLib-shaped strings) with case/spacing differences.
    await details('hc:810', {
      title: 'Homunculus 1',
      authors: [{ name: 'Hideo Yamamoto' }],
      genres: ['Comics'],
      series: [{ name: 'Homunculus' }],
      mangaComics: true,
    });
    await details('hc:811', {
      title: 'Homunculus 2',
      authors: [{ name: 'Hideo Yamamoto' }],
      genres: [],
      series: [{ name: '  homunculus ' }],
      mangaComics: null,
    });

    // Standalone works and a clean series must not be touched.
    await details('hc:801', {
      title: 'Обычный роман',
      authors: [{ name: 'Иван Петров' }],
      genres: ['Fantasy'],
      series: [],
      mangaComics: false,
    });
    await details('hc:802', {
      title: 'Неизвестная книга',
      authors: [{ name: 'Иван Петров' }],
      genres: [],
      series: [],
      mangaComics: null,
    });
    await details('hc:820', {
      title: 'Цикл A',
      authors: [{ name: 'Иван Петров' }],
      genres: ['Fantasy'],
      series: [{ hcId: 500, name: 'Чистый цикл', position: 1 }],
      mangaComics: false,
    });
    await details('hc:821', {
      title: 'Цикл B',
      authors: [{ name: 'Иван Петров' }],
      genres: ['Fantasy'],
      series: [{ hcId: 500, name: 'Чистый цикл', position: 2 }],
      mangaComics: false,
    });

    await bookCache.saveProfile('hardcover', '34748', {
      schemaVersion: 1,
      source: 'hardcover',
      userKey: '34748',
      importedAt: '2026-10-27T00:00:00.000Z',
      events: [
        hcEvent(701, 'Fables, Vol. 6', '2025-01-01'),
        hcEvent(702, 'Fables, Vol. 14', '2025-01-02'),
        hcEvent(703, 'Fables, Vol. 22', '2025-01-03'),
        hcEvent(810, 'Homunculus 1', '2025-02-01'),
        hcEvent(811, 'Homunculus 2', '2025-02-02'),
        hcEvent(801, 'Обычный роман', '2025-03-01'),
        hcEvent(802, 'Неизвестная книга', '2025-03-02'),
        hcEvent(820, 'Цикл A', '2025-04-01'),
        hcEvent(821, 'Цикл B', '2025-04-02'),
      ],
    });
    bookCache.flushLinks();
  });

  test('propagateSeriesManga flags every volume of a comics series only', () => {
    const works = new Map([
      ['a', { workId: 'a', mangaComics: true, series: [{ hcId: 1, name: 'S' }] }],
      ['b', { workId: 'b', mangaComics: false, series: [{ hcId: 1, name: 'S' }] }],
      ['c', { workId: 'c', mangaComics: null, series: [{ hcId: 1, name: 'S' }] }],
      ['d', { workId: 'd', mangaComics: false, series: [{ hcId: 2, name: 'Other' }] }],
      ['e', { workId: 'e', mangaComics: null, series: [] }],
    ]);
    const propagated = propagateSeriesManga(works);
    assert.deepEqual([...propagated].sort(), ['b', 'c']);
    assert.equal(works.get('a').mangaComics, true);
    assert.equal(works.get('b').mangaComics, true);
    assert.equal(works.get('b').mangaComicsSource, 'series');
    assert.equal(works.get('c').mangaComics, true);
    // The clean series and the standalone works keep their own flags.
    assert.equal(works.get('d').mangaComics, false);
    assert.equal(works.get('e').mangaComics, null);
  });

  test('default payload excludes all Fables/Homunculus volumes', () => {
    const stats = buildBooksStats({ profile: 'hardcover-34748' });
    assert.equal(stats.summary.includeMangaComics, false);
    // 5 excluded (3 Fables + 2 Homunculus), 4 kept (2 standalone + 2 clean).
    assert.equal(stats.summary.mangaExcluded, 5);
    assert.equal(stats.summary.mangaSeriesExcluded, 3); // all but the own-flag-true 701/810
    assert.equal(stats.summary.mangaSeriesPropagated, 3);
    assert.equal(stats.summary.bookCount, 4);
    assert.equal(stats.summary.eventCount, 4);

    for (const workId of ['hc:701', 'hc:702', 'hc:703', 'hc:810', 'hc:811']) {
      assert.equal(stats.booksIndex[workId], undefined, workId);
    }
    assert.ok(stats.booksIndex['hc:801']);
    assert.ok(stats.booksIndex['hc:802']);
    assert.ok(stats.booksIndex['hc:820']);
    assert.ok(stats.booksIndex['hc:821']);

    assert.equal(stats.series.some((entry) => entry.name === 'Fables'), false);
    assert.equal(stats.series.some((entry) => /homunculus/i.test(entry.name)), false);
    assert.ok(stats.series.some((entry) => entry.name === 'Чистый цикл'));

    // Series/genre/author/timeline sums exclude the propagated works.
    assert.equal(stats.genres.some((entry) => entry.name === 'Graphic Novels'), false);
    assert.equal(stats.authors.some((entry) => entry.name === 'Bill Willingham'), false);
    assert.equal(stats.authors.some((entry) => entry.name === 'Hideo Yamamoto'), false);
    assert.equal(stats.readDays.some((day) => day.date === '2025-01-02'), false);
    assert.equal(stats.readDays.some((day) => day.date === '2025-01-01'), false);
    assert.ok(stats.readDays.some((day) => day.date === '2025-03-01'));
  });

  test('includeMangaComics=1 restores them and marks the series provenance', () => {
    const stats = buildBooksStats({ profile: 'hardcover-34748', includeMangaComics: true });
    assert.equal(stats.summary.bookCount, 9);
    assert.equal(stats.summary.eventCount, 9);
    assert.equal(stats.summary.mangaExcluded, 0);
    assert.equal(stats.summary.mangaSeriesExcluded, 0);
    assert.equal(stats.summary.mangaSeriesPropagated, 3);

    assert.equal(stats.booksIndex['hc:702'].mangaComics, true);
    assert.equal(stats.booksIndex['hc:702'].mangaComicsSource, 'series');
    assert.equal(stats.booksIndex['hc:703'].mangaComics, true);
    assert.equal(stats.booksIndex['hc:811'].mangaComics, true);
    // own flag true -> no series provenance marker
    assert.equal(stats.booksIndex['hc:701'].mangaComics, true);
    assert.equal(stats.booksIndex['hc:701'].mangaComicsSource, undefined);
    // standalone null survives untouched
    assert.equal(stats.booksIndex['hc:802'].mangaComics, null);
    assert.equal(stats.booksIndex['hc:820'].mangaComics, false);
  });
  after(() => env.resetMutableState());
});


describe('books-stats-status-filter', () => {
  /**
   * Books stats: Hardcover journal status filter at the aggregation level.
   *
   * Profiles imported before the import-time status filter (commit ca6efc1)
   * persisted wish/reading/paused events. Those events must not count in any
   * widget — bookCount, series, timeline — even though the file on disk still
   * contains them. New profiles carry `statusId`; legacy ones fall back to the
   * `status` label.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const { buildBooksStats, keepHardcoverProfileEvent } = require('../server/books/stats');

  function hcEvent(id, bookId, extra = {}) {
    return {
      id: `hc:read:${id}`,
      source: 'hardcover',
      sourceBookId: String(bookId),
      workId: `hc:${bookId}`,
      title: `Book ${bookId}`,
      authors: ['Jim Butcher'],
      rating: 4,
      ratingScale: 5,
      rating10: 8,
      status: 'read',
      statusId: 3,
      finishedAt: '2025-01-02',
      edition: {},
      ...extra,
    };
  }

  test.before(async () => {
    for (let position = 1; position <= 9; position++) {
      const bookId = 1000 + position;
      await bookCache.saveDetails(bookCache.detailsKeyForWork(`hc:${bookId}`), {
        schemaVersion: 2,
        workId: `hc:${bookId}`,
        title: `Dresden ${position}`,
        authors: [{ name: 'Jim Butcher' }],
        genres: ['Fantasy'],
        series: [{ hcId: 990, name: 'The Dresden Files', position }],
        mangaComics: false,
      });
    }

    const read = [];
    for (let position = 1; position <= 9; position++) {
      read.push(hcEvent(position, 1000 + position));
    }
    await bookCache.saveProfile('hardcover', '34748', {
      schemaVersion: 1,
      source: 'hardcover',
      userKey: '34748',
      importedAt: '2026-10-27T13:03:47.585Z',
      events: [
        ...read,
        // Currently reading + wishlist: leaked by the pre-filter import.
        hcEvent(90, 2001, { status: 'reading', statusId: 2, finishedAt: '2025-02-01', rating: null, rating10: null }),
        hcEvent(91, 2002, { status: 'wish', statusId: 1, finishedAt: null, rating: null, rating10: null }),
        hcEvent(92, 2003, { status: 'wish', statusId: 1, finishedAt: null, rating: null, rating10: null }),
        // dnf (5) stays in the profile but never dates a book.
        hcEvent(93, 2004, { status: 'dnf', statusId: 5, finishedAt: null }),
        // Legacy schema (no statusId): the label is the only available signal.
        hcEvent(94, 2005, { statusId: undefined }),
        hcEvent(95, 2006, {
          status: 'wish',
          statusId: undefined,
          finishedAt: '2025-03-03',
          rating: null,
          rating10: null,
        }),
        // Unknown schema: neither key, must survive (no silent data loss).
        hcEvent(96, 2007, { status: undefined, statusId: undefined }),
      ],
    });

    await bookCache.saveProfile('livelib', 'tester', {
      schemaVersion: 1,
      source: 'livelib',
      userKey: 'tester',
      importedAt: '2026-10-27T00:00:00.000Z',
      events: [
        {
          id: 'll:7001',
          source: 'livelib',
          sourceBookId: '7001',
          title: 'Любимая книга',
          authors: ['Иван Петров'],
          rating: 9,
          ratingScale: 10,
          rating10: 9,
          status: 'read',
          finishedAt: '2024-05-01',
          edition: {},
        },
      ],
    });
    bookCache.flushLinks();
  });

  test('keepHardcoverProfileEvent prefers statusId, falls back to the label', () => {
    assert.equal(keepHardcoverProfileEvent({ statusId: 3, status: 'read' }), true);
    assert.equal(keepHardcoverProfileEvent({ statusId: 5, status: 'dnf' }), true);
    assert.equal(keepHardcoverProfileEvent({ statusId: 1, status: 'wish' }), false);
    assert.equal(keepHardcoverProfileEvent({ statusId: 2, status: 'reading' }), false);
    assert.equal(keepHardcoverProfileEvent({ statusId: 4, status: 'paused' }), false);
    // statusId wins over a contradictory label.
    assert.equal(keepHardcoverProfileEvent({ statusId: 1, status: 'read' }), false);
    // Legacy labels.
    assert.equal(keepHardcoverProfileEvent({ status: 'read' }), true);
    assert.equal(keepHardcoverProfileEvent({ status: 'dnf' }), true);
    assert.equal(keepHardcoverProfileEvent({ status: 'wish' }), false);
    assert.equal(keepHardcoverProfileEvent({ status: 'paused' }), false);
    // Unknown schema survives.
    assert.equal(keepHardcoverProfileEvent({}), true);
  });

  test('stale wish/reading events are dropped from every aggregate', () => {
    const stats = buildBooksStats({ profile: 'hardcover-34748' });
    const summary = stats.summary;

    // 9 read + dnf(5) + legacy read + unknown-schema = 12 Hardcover events.
    // Wish/reading never enter; the LiveLib profile is a different profile and
    // its event is not part of this payload.
    assert.equal(summary.hardcoverStatusExcluded, 4);
    assert.equal(summary.eventCount, 12);
    assert.equal(summary.bookCount, 12);
    assert.equal(summary.finishedCount, 11); // 9 read + legacy read + unknown
    assert.equal(summary.undatedEventCount, 1); // dnf only
    assert.equal(stats.meta.statusFilter.excluded, 4);
    assert.deepEqual(stats.meta.statusFilter.keepStatusIds, [3, 5]);
    assert.equal(stats.meta.statusFilter.byStatus['1:wish'], 2);
    assert.equal(stats.meta.statusFilter.byStatus['2:reading'], 1);
    assert.equal(stats.meta.statusFilter.byStatus['legacy:wish'], 1);

    // «Читаю сейчас» is excluded from the read statistics but feeds the strip.
    assert.equal(summary.readingNowCount, 1);
    assert.equal(stats.recentlyReading.length, 1);
    assert.equal(stats.recentlyReading[0].workId, 'hc:2001');
    assert.equal(stats.recentlyReading[0].title, 'Book 2001');
    assert.equal(stats.recentlyReading[0].status, 'reading');
    assert.equal(stats.recentlyReading[0].date, null);

    // Dresden replay: 17 journal rows on disk, 9 read in the payload.
    assert.equal(stats.meta.profiles.find((profile) => profile.source === 'hardcover').events, 16);
    const dresden = stats.series.find((entry) => entry.name === 'The Dresden Files');
    assert.ok(dresden);
    assert.equal(dresden.count, 9);

    // Timeline/calendar: stale events with a fabricated date are gone.
    assert.equal(stats.readDays.some((day) => day.date === '2025-02-01'), false);
    assert.equal(stats.readDays.some((day) => day.date === '2025-03-03'), false);
    assert.ok(stats.readDays.some((day) => day.date === '2025-01-02'));

    // dnf keeps a book but no date; legacy/unknown-schema events stay.
    assert.ok(stats.booksIndex['hc:2004']);
    assert.ok(stats.booksIndex['hc:2005']);
    assert.ok(stats.booksIndex['hc:2007']);
    assert.equal(stats.booksIndex['hc:2001'], undefined);
    assert.equal(stats.booksIndex['hc:2002'], undefined);
    assert.equal(stats.booksIndex['hc:2006'], undefined);
    // The LiveLib profile's event does not leak into the Hardcover payload.
    assert.equal(stats.booksIndex['ll:7001'], undefined);
    assert.equal(stats.meta.profiles.length, 1);

    const hardcover = stats.meta.profiles.find((profile) => profile.source === 'hardcover');
    assert.equal(hardcover.keptEvents, 12);
    assert.equal(hardcover.statusExcluded, 4);
    assert.equal(hardcover.missingStatusId, 3); // legacy read + legacy wish + unknown
    assert.equal(hardcover.needsReimport, true);
  });

  test('LiveLib profile: no Hardcover status filter, own counters only', () => {
    const stats = buildBooksStats({ profile: 'livelib-tester' });
    assert.equal(stats.summary.hardcoverStatusExcluded, 0);
    assert.equal(stats.summary.eventCount, 1);
    assert.ok(stats.booksIndex['ll:7001']);
    const livelib = stats.meta.profiles.find((profile) => profile.source === 'livelib');
    assert.equal(livelib.statusExcluded, 0);
    assert.equal(livelib.needsReimport, false);
  });

  test('summary counters stay consistent with the dropped events', () => {
    const stats = buildBooksStats({ profile: 'hardcover-34748' });
    // No double counting: the work-level and event-level totals agree.
    assert.equal(Object.keys(stats.booksIndex).length, stats.summary.bookCount);
    assert.equal(stats.summary.finishedCount + stats.summary.undatedEventCount, stats.summary.eventCount);
    assert.equal(
      stats.timeline.reduce((sum, entry) => sum + entry.finished, 0),
      stats.summary.finishedCount
    );
  });
  after(() => env.resetMutableState());
});


describe('books-stats', () => {
  /**
   * /api/books/stats aggregation under the single-profile contract:
   *   - a profile is ONE source + ONE account (`livelib-tester` / `hardcover-34748`);
   *   - events of another profile never leak into the payload (no union);
   *   - work metadata may still come from the shared metadata chain (Hardcover
   *     details resolved for a LiveLib book) — that is metadata, not an event merge;
   *   - the payload has no `ratings.bySource` / `sources.filter` any more;
   *   - calendar/timeline/streaks only use dated events.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const { buildBooksStats } = require('../server/books/stats');

  async function seed() {
    await bookCache.saveDetails(100, {
      schemaVersion: 1,
      hcWorkId: 100,
      title: 'Дюна',
      authors: [{ hcId: 1, name: 'Фрэнк Герберт' }],
      genres: ['Science Fiction'],
      series: [{ hcId: 5, name: 'Дюны', position: 1 }],
      pages: 512,
      publicationYear: 1965,
      publisher: 'Chilton',
      coverUrl: 'https://example.test/dune.jpg',
      ratingsCount: 5000,
      partial: false,
    });
    await bookCache.saveDetails(101, {
      schemaVersion: 1,
      hcWorkId: 101,
      title: 'Мартин Иден',
      authors: [{ hcId: 2, name: 'Джек Лондон' }],
      genres: ['Classics'],
      series: [],
      pages: 400,
      publicationYear: 1909,
      publisher: 'Penguin',
      partial: false,
    });
    await bookCache.saveLink('9001', {
      schemaVersion: 1,
      livelibBookId: '9001',
      workId: 'hc:100',
      method: 'isbn',
      score: 1,
      evidence: { isbn: '9780441013593' },
    });
    bookCache.setWorkLink('hc:100', { livelib: ['9001'] });
    bookCache.flushLinks();

    await bookCache.saveProfile('hardcover', '34748', {
      schemaVersion: 1,
      source: 'hardcover',
      userKey: '34748',
      sourceUserId: 34748,
      importedAt: '2026-10-27T00:00:00.000Z',
      events: [
        {
          id: 'hc:read:1',
          source: 'hardcover',
          sourceBookId: '100',
          workId: 'hc:100',
          title: 'Дюна',
          authors: ['Фрэнк Герберт'],
          rating: 4.5,
          ratingScale: 5,
          rating10: 9,
          status: 'read',
          finishedAt: '2024-03-02',
          readCount: 1,
          edition: { publisher: 'Chilton', year: 1965, isbn: '9780441013593', language: 'English' },
        },
        {
          id: 'hc:read:2',
          source: 'hardcover',
          sourceBookId: '101',
          workId: 'hc:101',
          title: 'Мартин Иден',
          authors: ['Джек Лондон'],
          rating: 4,
          ratingScale: 5,
          rating10: 8,
          status: 'read',
          finishedAt: '2024-03-03',
          readCount: 1,
          edition: { publisher: 'Penguin', year: 1909, isbn: null, language: 'English' },
        },
      ],
      warnings: [],
    });

    await bookCache.saveProfile('livelib', 'tester', {
      schemaVersion: 1,
      source: 'livelib',
      userKey: 'tester',
      importedAt: '2026-10-27T00:00:00.000Z',
      events: [
        {
          id: 'll:1',
          source: 'livelib',
          sourceBookId: '9001',
          sourceUserBookId: '1',
          title: 'Дюна',
          authors: ['Фрэнк Герберт'],
          rating: 7,
          ratingScale: 10,
          rating10: 7,
          status: 'read',
          finishedAt: '2024-03-02',
          edition: { publisher: 'АСТ', year: 2015, isbn: '9785170863174', language: 'Русский' },
        },
        {
          id: 'll:2',
          source: 'livelib',
          sourceBookId: '9002',
          sourceUserBookId: '2',
          title: 'Неизвестная книга',
          authors: ['Автор Один'],
          rating: 6,
          ratingScale: 10,
          rating10: 6,
          status: 'read',
          finishedAt: '2024-04-01',
          edition: { publisher: 'Эксмо', year: 2020, isbn: null, language: 'Русский' },
        },
        {
          id: 'll:3',
          source: 'livelib',
          sourceBookId: '9003',
          sourceUserBookId: '3',
          title: 'Без даты',
          authors: ['Автор Два'],
          rating: null,
          ratingScale: 10,
          rating10: null,
          status: 'read',
          finishedAt: null,
          edition: { publisher: null, year: null, isbn: null, language: null },
        },
      ],
      warnings: [],
    });
  }

  test('a LiveLib profile aggregates only its own events (metadata may come from Hardcover)', async () => {
    await seed();
    const stats = buildBooksStats({ profile: 'livelib-tester' });

    assert.deepEqual(stats.sources.selected, ['livelib']);
    assert.deepEqual(stats.sources.profile, {
      key: 'livelib-tester',
      source: 'livelib',
      userKey: 'tester',
      // Acquisition path: a scraped profile reports its source as origin.
      origin: 'livelib',
      importedAt: '2026-10-27T00:00:00.000Z',
      eventCount: 3,
    });
    // `connected` still lists every profile on the server: it is the switcher's
    // catalogue, not the scope.
    assert.deepEqual(stats.sources.connected.sort(), ['hardcover', 'livelib']);

    assert.equal(stats.summary.eventCount, 3);
    // hc:100 (via the LL link), ll:9002, ll:9003 (unresolved stub).
    assert.equal(stats.summary.bookCount, 3);
    assert.equal(stats.summary.finishedCount, 2);
    assert.equal(stats.summary.undatedEventCount, 1);
    assert.equal(stats.summary.resolvedCount, 1);
    assert.equal(stats.summary.unresolvedCount, 2);
    assert.deepEqual(stats.summary.sources, ['livelib']);

    // The LiveLib rating is the one shown; the Hardcover account's 9/10 for the
    // same work belongs to a different profile and must not appear.
    const dune = stats.booksIndex['hc:100'];
    assert.equal(dune.rating, 7);
    assert.equal('ratingsBySource' in dune, false);
    assert.deepEqual(dune.sources, ['livelib']);

    const merged = Object.fromEntries(stats.ratings.merged.map((entry) => [entry.score, entry.count]));
    assert.deepEqual(merged, { 6: 1, 7: 1 });
    assert.equal('bySource' in stats.ratings, false);

    // Metadata coverage: one resolved work (hc:100 via the link), two stubs.
    assert.deepEqual(stats.summary.metadata, {
      resolved: 1,
      total: 3,
      linked: 1,
      withDetails: 1,
      unlinked: 2,
      resolvable: 3,
      hopeless: 0,
      keyless: 0,
      percent: 33,
      done: false,
      running: false,
      budgetRemaining: null,
    });

    // Calendar/timeline/streaks only for this profile's dated events.
    const timelineSum = stats.timeline.reduce((sum, entry) => sum + entry.finished, 0);
    assert.equal(timelineSum, stats.summary.finishedCount);
    assert.deepEqual(
      stats.timeline.map((entry) => [entry.month, entry.finished, entry.livelib, entry.hardcover]),
      [
        ['2024-03', 1, 1, 0],
        ['2024-04', 1, 1, 0],
      ]
    );
    assert.equal(stats.readDays.length, 2);
    assert.equal(stats.streaks.lastReadDate, '2024-04-01');

    // Metadata for the resolved work still comes from the details chain.
    assert.equal(dune.title, 'Дюна');
    assert.equal(stats.genres.find((genre) => genre.name === 'Science Fiction').count, 1);
    const herbert = stats.authors.find((author) => author.name === 'Фрэнк Герберт');
    assert.equal(herbert.count, 1);
    assert.equal(herbert.avgRating, 7);
    assert.equal(stats.series.find((entry) => entry.name === 'Дюны').count, 1);
    assert.equal(stats.summary.pagesTotal, 512);
    assert.equal(stats.summary.avgPages, 512);
    assert.equal(stats.summary.pageCount, stats.summary.pagesTotal);
    assert.equal(stats.summary.dateFrom, '2024-03-02');
    assert.equal(stats.summary.dateTo, '2024-04-01');
    assert.equal(stats.booksIndex['hc:100'].links.livelib, 'https://www.livelib.ru/book/9001');
    assert.equal(stats.unmatchedCount, 2);
    assert.equal(stats.recentlyFinished.length, 2);
    assert.equal(stats.recentlyFinished[0].date, '2024-04-01');
  });

  test('a Hardcover profile aggregates only the journal events', async () => {
    await seed();
    const stats = buildBooksStats({ profile: 'hardcover-34748' });

    assert.deepEqual(stats.sources.selected, ['hardcover']);
    assert.equal(stats.summary.eventCount, 2);
    assert.equal(stats.summary.bookCount, 2);
    assert.equal(stats.summary.unresolvedCount, 0);
    assert.deepEqual(
      Object.fromEntries(stats.ratings.merged.map((entry) => [entry.score, entry.count])),
      { 8: 1, 9: 1 }
    );
    // The journal carries its own metadata: coverage is 100%, badge hidden.
    assert.equal(stats.summary.metadata.resolved, 2);
    assert.equal(stats.summary.metadata.total, 2);
    assert.equal(stats.summary.metadata.percent, 100);
    assert.equal(stats.summary.metadata.running, false);
    assert.equal(stats.booksIndex['hc:100'].rating, 9);
    assert.deepEqual(stats.booksIndex['hc:100'].sources, ['hardcover']);
    assert.equal(stats.timeline.length, 1);
    assert.equal(stats.timeline[0].hardcover, 2);
    assert.equal(stats.summary.pagesTotal, 912);
    assert.equal(stats.summary.avgPages, 456);
    assert.equal(stats.summary.dateFrom, '2024-03-02');
    assert.equal(stats.summary.dateTo, '2024-03-03');
  });

  test('the payload carries no source-filter block any more', async () => {
    await seed();
    const stats = buildBooksStats({ profile: 'livelib-tester' });
    assert.deepEqual(stats.sources.selected, ['livelib']);
    assert.equal('filter' in stats.sources, false);
    assert.equal(stats.summary.eventCount, 3);

    // An old option object cannot re-introduce a filter: the field is gone.
    const withLegacyOption = buildBooksStats({ profile: 'livelib-tester', sources: 'hardcover' });
    assert.deepEqual(withLegacyOption.sources.selected, ['livelib']);
    assert.equal(withLegacyOption.summary.eventCount, 3);
  });

  test('a missing or ambiguous profile is a 400-shaped error, never a union', () => {
    assert.throws(
      () => buildBooksStats({}),
      (error) => error.code === 'profile_required' && error.status === 400
    );
    assert.throws(
      () => buildBooksStats({ profile: 'livelib-tester,hardcover-34748' }),
      (error) => error.code === 'profile_required' && /Exactly one/.test(error.message)
    );
  });

  test('empty profile returns a stable empty payload', async () => {
    await bookCache.saveProfile('livelib', 'nobody', {
      schemaVersion: 1,
      source: 'livelib',
      userKey: 'nobody',
      importedAt: '2026-10-27T00:00:00.000Z',
      events: [],
      warnings: [],
    });
    const stats = buildBooksStats({ profile: 'livelib-nobody' });
    assert.equal(stats.summary.bookCount, 0);
    assert.equal(stats.summary.eventCount, 0);
    assert.equal(stats.summary.undatedEventCount, 0);
    assert.deepEqual(stats.timeline, []);
    assert.equal(stats.streaks.current, 0);
    assert.deepEqual(stats.booksIndex, {});
  });
  after(() => env.resetMutableState());
});


describe('books-ui-authors', () => {
  /**
   * Books dashboard: authors ("Персоналии · авторы") contract.
   *
   * Two things are pinned here, because both have already caused a
   * "виджета не видно" report:
   *
   *   1. The payload really exposes `authors` (name/count/works) and
   *      `summary.authorsCount` — the backend side of the widget.
   *   2. public/index.html keeps the authors widget *and* labels it the way the
   *      films tab labels its people widget ("Персоналии"), so the user can
   *      find it by the same name. books.js must keep reading `data.authors`
   *      (the field name in the payload).
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const { buildBooksStats } = require('../server/books/stats');

  const PUBLIC_DIR = path.join(__dirname, '..', 'public');

  function readPublic(name) {
    return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
  }

  async function details(workId, doc) {
    await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), {
      schemaVersion: 2,
      workId,
      ...doc,
    });
  }

  function hcEvent(bookId, title, authors, finishedAt) {
    return {
      id: `hc:read:${bookId}`,
      source: 'hardcover',
      sourceBookId: String(bookId),
      workId: `hc:${bookId}`,
      title,
      authors,
      status: 'read',
      statusId: 3,
      finishedAt,
      edition: {},
    };
  }

  test.before(async () => {
    await details('hc:11', {
      title: 'The Anubis Gates',
      authors: [{ name: 'Tim Powers' }],
      genres: ['Fantasy'],
      metadataSources: ['hardcover'],
      mangaComics: false,
    });
    await details('hc:12', {
      title: 'The Stress of Her Regard',
      authors: [{ name: 'Tim Powers' }, { name: 'James Blaylock' }],
      genres: ['Fantasy'],
      metadataSources: ['hardcover'],
      mangaComics: false,
    });
    await bookCache.saveProfile('hardcover', 'authors-test', {
      schemaVersion: 1,
      source: 'hardcover',
      userKey: 'authors-test',
      importedAt: '2026-10-27T00:00:00.000Z',
      events: [
        hcEvent('11', 'The Anubis Gates', ['Tim Powers'], '2024-01-02'),
        hcEvent('12', 'The Stress of Her Regard', ['Tim Powers'], '2024-02-03'),
      ],
    });
  });

  test('payload exposes authors with counts, works and summary.authorsCount', () => {
    const stats = buildBooksStats({ profile: 'hardcover-authors-test' });

    assert.ok(Array.isArray(stats.authors), 'authors must be an array');
    assert.equal(stats.authors.length, 2);
    assert.equal(stats.summary.authorsCount, 2);

    const tim = stats.authors.find((entry) => entry.name === 'Tim Powers');
    assert.ok(tim, 'Tim Powers must be present');
    assert.equal(tim.count, 2);
    assert.deepEqual(tim.works.map((work) => work.workId).sort(), ['hc:11', 'hc:12']);
    assert.ok(tim.works.every((work) => typeof work.title === 'string' && work.title.length > 0));

    const james = stats.authors.find((entry) => entry.name === 'James Blaylock');
    assert.equal(james.count, 1);

    // Stable order: count desc inside the same payload.
    assert.deepEqual(stats.authors.map((entry) => entry.name), ['Tim Powers', 'James Blaylock']);

    // booksIndex carries the same author names as plain strings (modal + cards).
    assert.deepEqual(stats.booksIndex['hc:11'].authors, ['Tim Powers']);
    assert.deepEqual(stats.booksIndex['hc:12'].authors, ['Tim Powers', 'James Blaylock']);
  });

  test('books markup keeps the authors widget under the films label', () => {
    const html = readPublic('index.html');

    assert.match(html, /id="books-authors-widget"/);
    assert.match(
      html,
      /id="books-authors-title"[^>]*>[^<]*<span[^>]*><\/span>Персоналии · авторы</,
      'authors widget must be titled "Персоналии · авторы"'
    );
    assert.match(
      html,
      /id="books-authors-widget"[^>]*aria-label="Персоналии · авторы"/,
      'authors widget must expose the same aria-label'
    );
    // The films widget keeps its own label: the books rename must not leak.
    assert.match(html, /id="w-persons-title"[^>]*>[^<]*<span[^>]*><\/span>Персоналии</);
  });

  test('books.js renders the payload field the backend actually sends', () => {
    const js = readPublic('js/books.js');
    assert.match(js, /function renderAuthors\(data\)/);
    assert.match(js, /const all = data\.authors\.slice\(\)/, 'renderAuthors must read data.authors');
    assert.match(js, /renderAuthors\(data\);/, 'renderAuthors must be wired into the dashboard');
    assert.match(js, /\$\('books-authors-list'\)/, 'renderAuthors must target the markup host');
  });
  after(() => env.resetMutableState());
});


describe('books-ui-dashboard', () => {
  /**
   * Books dashboard: the pruned widget set and the even grid.
   *
   * The 04.11.2026 cosmetic round removed two widgets that only stretched the
   * page — «Календарь чтения» (its day heatmap never matched the film calendar)
   * and «Издательства» (publishers are metadata, not a reading statistic).
   * The server payload keeps both sections byte-for-byte; this test only pins
   * the browser side, so a future round cannot re-introduce the dead markup or
   * leave a hole in the 12-column grid.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');

  const PUBLIC_DIR = path.join(__dirname, '..', 'public');
  const readPublic = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');

  test('books markup no longer mounts the calendar or the publishers widget', () => {
    const html = readPublic('index.html');

    for (const id of [
      'books-calendar-widget', 'books-calendar-host', 'books-calendar-title',
      'books-publishers-widget', 'books-publishers-list', 'books-publishers-title',
      'books-streak-card',
    ]) {
      assert.doesNotMatch(html, new RegExp(`id="${id}"`), `#${id} must stay removed`);
    }
    // The wrapper only existed to stack series above publishers.
    assert.doesNotMatch(html, /books-side-stack/);
  });

  test('books controller drops the calendar/publishers render paths and view models', () => {
    const js = readPublic('js/books.js');

    assert.doesNotMatch(js, /renderCalendar\(/);
    assert.doesNotMatch(js, /renderPublishers\(/);
    assert.doesNotMatch(js, /normalizeStreaks/);
    assert.doesNotMatch(js, /data\.publishers/);
    // The per-work publisher field stays: book cards still show the imprint.
    assert.match(js, /publisher: text\(entry\.publisher\)/);
    // The monthly timeline still owns the day counts of its drilldown.
    assert.match(js, /state\.data\.readDays\.filter/);
  });

  test('remaining books widgets keep their mounts', () => {
    const html = readPublic('index.html');

    for (const id of [
      'books-recent-widget', 'books-ratings-title', 'books-genres-list',
      'books-series-widget', 'books-authors-widget', 'books-decades-donut',
      'books-years-donut', 'books-yearbars-chart', 'books-timeline-chart',
    ]) {
      assert.match(html, new RegExp(`id="${id}"`), `#${id} must stay mounted`);
    }
  });

  test('books grid pairs every row and stretches cards to one height', () => {
    const css = readPublic('books.css');

    // Cards in a row share the same top/bottom edge again.
    assert.match(css, /\.books-dash \.widgets \{ align-items: stretch; \}/);
    // Ratings + genres are an even 6+6 pair (the old 7+5 left uneven widths).
    assert.match(css, /\.books-dash \.w-ratings,\s*\n\.books-dash \.w-genres,/);
    assert.match(css, /\.w-books-series,\s*\n\.w-books-authors \{ grid-column: span 6; \}/);
    // An empty series card is hidden, so authors widen instead of leaving a hole.
    assert.match(css, /\.books-dash \.w-books-authors\.is-wide \{ grid-column: span 12; \}/);
    assert.match(readPublic('js/books.js'), /authors\.classList\.toggle\('is-wide', items\.length === 0\)/);
    assert.match(css, /\.w-books-yearbars \{ grid-column: span 12; \}/);
    // No orphan rules for the removed widgets.
    assert.doesNotMatch(css, /books-side-stack/);
    assert.doesNotMatch(css, /w-books-publishers/);
  });
  after(() => env.resetMutableState());
});


describe('books-import-activation', () => {
  /**
   * Books: a `livelib-backup` file import (201) activates `livelib-<user>`.
   *
   * `submitFileImport()` calls `ensureProfileForImport('livelib', username)`
   * after the server accepts the file. That helper creates the local profile on
   * the first import and must keep an already-active one active on a repeat
   * upload (idempotent) — the bug this test pins is the early return that left
   * the switcher unhighlighted when the active id had been cleared.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const { installDom, textById } = require('./helpers/dom-shim');

  const { nodeFor, storage } = installDom({ search: '?tab=books', href: 'http://localhost/?tab=books' });

  const routes = [];
  const __realFetch = globalThis.fetch;
  before(() => {
    globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    routes.push(`${options.method || 'GET'} ${target}`);
    let payload = {};
    let status = 200;

    if (target.startsWith('/api/books/profiles')) payload = { profiles: [] };
    else if (target.startsWith('/api/books/import/livelib-file')) {
      status = 201;
      payload = {
        imported: 12,
        added: 12,
        enriched: 0,
        skipped: 0,
        events: 12,
        format: 'json',
        shelf: 'read',
        shelves: { read: 12 },
        resolve: null,
      };
    } else if (target.startsWith('/api/books/stats')) {
      // The payload is irrelevant here: the import screen is fine after 201.
      status = 404;
      payload = { error: 'profile_not_found' };
    } else if (target.startsWith('/api/books/import/status')) {
      payload = { done: true, stage: 'done' };
    }

    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      async json() { return payload; },
      async text() { return JSON.stringify(payload); },
    };
  };;
  });
  after(() => {
    globalThis.fetch = __realFetch;
  });

  function rows() {
    return nodeFor('books-profile-list').children
      .filter((node) => node.classList && node.classList.contains('profile-item'));
  }
  function activeRows() {
    return rows().filter((node) => node.classList.contains('is-active'));
  }
  async function wait(ms = 0) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function submitExportFile() {
    nodeFor('books-livelib-file-user').value = 'Margaret';
    nodeFor('books-livelib-file').files = [
      new File([JSON.stringify({ books: [] })], 'livelib-backup.json', { type: 'application/json' }),
    ];
    nodeFor('books-livelib-file-form').dispatch('submit');
  }

  test('books file import: 201 makes livelib-Margaret the active profile', async () => {
    const books = await import('../public/js/books.js');
    books.initBooks({ onActivate() {} });
    await books.showBooks();
    await wait(40);

    assert.equal(rows().length, 0, 'a fresh browser has no book profiles');

    submitExportFile();
    await wait(200);

    assert.ok(routes.some((route) => route === 'POST /api/books/import/livelib-file'));
    assert.ok(
      routes.some((route) => route.startsWith('GET /api/books/stats?profile=livelib-Margaret')),
      'the stats request is scoped to the imported profile',
    );
    assert.ok(storage.get('kinoboxd.books.profile.v1'), 'the active id is persisted');
    assert.ok(nodeFor('books-profile-switcher').classList.contains('has-active'));
    assert.equal(rows().length, 1);
    assert.equal(activeRows().length, 1, 'the imported profile is highlighted');
    assert.match(textById(nodeFor, 'books-profile-list'), /LiveLib @Margaret/);
  });

  test('books re-import of the same account stays on one active row', async () => {
    // A cleared active-id key (privacy cleanup / manual localStorage edit) must
    // not leave the repeat import attached to an unhighlighted profile: the
    // idempotent path re-asserts the active id and repaints the switcher.
    storage.delete('kinoboxd.books.profile.v1');
    submitExportFile();
    await wait(200);

    assert.equal(rows().length, 1, 'no duplicate profile row');
    assert.equal(activeRows().length, 1);
    assert.ok(storage.get('kinoboxd.books.profile.v1'), 'the active id is restored');
  });
  after(() => env.resetMutableState());
});
