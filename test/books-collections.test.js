'use strict';

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

const BOOK_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-collections-'));
process.env.KINOBOXD_CACHE_BOOK_DIR = BOOK_CACHE_DIR;
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
