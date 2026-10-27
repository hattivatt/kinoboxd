'use strict';

/**
 * Books manga/comics round:
 *   - detector reads every provider corpus (OL subjects beyond 25, HC tags,
 *     series names, comics-only publishers);
 *   - stale `details.mangaComics:false` is re-detected on read;
 *   - manual per-work override (flags/book-flags.json) dominates detection and
 *     series propagation in both directions;
 *   - the flags file is fingerprint-revalidated (external edit, no restart);
 *   - HTTP POST/DELETE /api/books/work/flag.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-manga-flags-'));

const bookCache = require('../server/books/book-cache');
const { detectManga, isMangaPublisher } = require('../server/books/providers/manga');
const { mergeResults, resultToDetails } = require('../server/books/providers');
const { buildBooksStats } = require('../server/books/stats');
const backfill = require('../server/books/manga-backfill');

const PORT = 6011;

async function details(workId, doc) {
  await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), {
    schemaVersion: 2,
    workId,
    ...doc,
  });
}

function hcEvent(bookId, title) {
  return {
    id: `hc:read:${bookId}`,
    source: 'hardcover',
    sourceBookId: String(bookId),
    workId: `hc:${bookId}`,
    title,
    authors: ['Test Author'],
    status: 'read',
    statusId: 3,
    finishedAt: '2025-01-01',
    edition: {},
  };
}

async function resetFlags(raw = {}) {
  await bookCache.writeJsonAtomic(bookCache.FLAGS_PATH, raw);
  bookCache.getMangaFlags(); // force fingerprint re-read
}

test.before(async () => {
  await details('hc:900', {
    title: 'Дюна',
    authors: [{ name: 'Фрэнк Герберт' }],
    genres: ['Science Fiction'],
    publisher: 'АСТ',
    isbn13: '9780441013593',
    mangaComics: false,
  });
  // Stale `null` + a provider corpus that only arrived later.
  await details('hc:901', {
    title: 'Crossed',
    authors: [{ name: 'Garth Ennis' }],
    genres: [],
    series: [{ hcId: 14693, name: 'Crossed (Collected Editions)', position: 1 }],
    mangaComics: null,
    mangaTexts: ['Comics & graphic novels, horror'],
  });
  await details('hc:902', {
    title: 'Неизвестная книга',
    authors: [{ name: 'Никто' }],
    genres: [],
    mangaComics: null,
  });
  // Stale `false` from the old detector, clean-looking genres.
  await details('hc:903', {
    title: 'Наруто, том 1',
    authors: [{ name: 'Масаси Кисимото' }],
    genres: ['Manga'],
    mangaComics: false,
  });
  await details('hc:904', {
    title: 'Fables, Vol. 2',
    authors: [{ name: 'Bill Willingham' }],
    genres: ['Fantasy'],
    series: [{ hcId: 77, name: 'Fables', position: 2 }],
    mangaComics: false,
  });
  await details('hc:905', {
    title: 'Fables, Vol. 1',
    authors: [{ name: 'Bill Willingham' }],
    genres: ['Graphic Novels'],
    series: [{ hcId: 77, name: 'Fables', position: 1 }],
    mangaComics: true,
  });
  await details('hc:906', {
    title: 'Old Boy, Vol. 8',
    authors: [{ name: 'Garon Tsuchiya' }],
    genres: [],
    tags: ['Manga'],
    mangaComics: null,
  });

  await bookCache.saveProfile('hardcover', 'tester', {
    schemaVersion: 1,
    source: 'hardcover',
    userKey: 'tester',
    importedAt: '2026-10-27T00:00:00.000Z',
    events: [900, 901, 902, 903, 904, 905, 906].map((id) => hcEvent(id, `Book ${id}`)),
  });
  await resetFlags({});
});

test('detector collects text from every provider surface', () => {
  // Open Library: all subjects, not only the display 25.
  assert.equal(detectManga({ subjects: ['Comics & Graphic Novels - Manga'] }), true);
  // Hardcover: non-genre tag category.
  assert.equal(detectManga({ genres: [], tags: ['Manga'] }), true);
  assert.equal(detectManga({ genres: [], tags: ['Graphic Novels'] }), true);
  // Series names themselves.
  assert.equal(detectManga({ genres: [], series: ['Crossed (Single Issues)'] }), true);
  assert.equal(detectManga({ genres: [], series: ['Trigun (3 volumes)'] }), null);
  // Comics-only publishers, including the RU/French ones.
  assert.equal(isMangaPublisher('Image Comics'), true);
  assert.equal(isMangaPublisher('VIZ Media LLC'), true);
  assert.equal(isMangaPublisher('Комильфо'), true);
  assert.equal(isMangaPublisher('Эксмо'), false);
  assert.equal(isMangaPublisher('АСТ'), false);
  assert.equal(detectManga({ genres: [], publisher: 'Dark Horse Manga' }), true);
  // Broader keywords.
  assert.equal(detectManga({ texts: ['комиксы для взрослых'] }), true);
  assert.equal(detectManga({ texts: ['сёнэн'] }), true);
  assert.equal(detectManga({ genres: ['Fantasy'], publisher: 'АСТ' }), false);
  assert.equal(detectManga({}), null);
});

test('mergeResults unions provider corpora and upgrades a clean primary', () => {
  const primary = {
    source: 'hardcover',
    sourceId: '1',
    workId: 'hc:1',
    title: 'Crossed',
    authors: ['Garth Ennis'],
    genres: [],
    series: null,
    publisher: null,
    mangaComics: false,
    mangaTexts: [],
    links: {},
    confidence: 0.99,
  };
  const extra = {
    source: 'openlibrary',
    sourceId: 'OL1W',
    title: 'Crossed',
    authors: ['Garth Ennis'],
    genres: [],
    series: null,
    publisher: 'Avatar Press',
    mangaComics: null,
    mangaTexts: ['Comics & graphic novels, horror', 'Avatar Press'],
    links: {},
    confidence: 0.8,
  };
  const merged = mergeResults(primary, [extra]);
  assert.equal(merged.mangaComics, true);
  assert.ok(merged.mangaTexts.includes('Comics & graphic novels, horror'));
  const doc = resultToDetails(merged);
  assert.ok(Array.isArray(doc.mangaTexts));
  assert.equal(doc.mangaComics, true);
});

test('series propagation joins the same name across different Hardcover ids', () => {
  const { propagateSeriesManga } = require('../server/books/stats');
  const works = new Map([
    ['a', { workId: 'a', mangaComics: true, series: [{ hcId: 4443, name: 'Crossed' }] }],
    [
      'b',
      {
        workId: 'b',
        mangaComics: null,
        series: [{ hcId: 14693, name: 'Crossed (Collected Editions)' }],
      },
    ],
    [
      'c',
      {
        workId: 'c',
        mangaComics: null,
        series: [{ hcId: 14694, name: 'Crossed (Single Issues)' }],
      },
    ],
    ['d', { workId: 'd', mangaComics: false, series: [{ hcId: 9, name: 'Crossed Swords' }] }],
  ]);
  const propagated = propagateSeriesManga(works);
  assert.deepEqual([...propagated].sort(), ['b', 'c']);
  assert.equal(works.get('b').mangaComics, true);
  assert.equal(works.get('c').mangaComics, true);
  assert.equal(works.get('d').mangaComics, false);
});

test('stale details flags are re-detected on read', async () => {
  const { workMetadata } = require('../server/books/stats');
  const meta = (id) => workMetadata(`hc:${id}`, [hcEvent(id, `Book ${id}`)]);
  assert.equal(meta(900).mangaComics, false);
  assert.equal(meta(901).mangaComics, true); // null + mangaTexts -> true
  assert.equal(meta(902).mangaComics, null);
  assert.equal(meta(903).mangaComics, true); // stale false + Manga genre
  assert.equal(meta(906).mangaComics, true); // tags corpus
});

test('manual override dominates detection, series propagation and counts', async () => {
  await bookCache.setMangaFlag('hc:902', true);
  await bookCache.setMangaFlag('hc:903', false);

  const stats = buildBooksStats({});
  // 901, 903(series/self), 904(series), 905, 906 auto-excluded; 902 manual.
  assert.equal(stats.summary.mangaExcluded, 5);
  assert.equal(stats.summary.mangaManualExcluded, 1);
  assert.equal(stats.summary.mangaManualRestored, 1);
  assert.equal(stats.summary.mangaOverrides, 2);
  assert.equal(stats.booksIndex['hc:900'] !== undefined, true);
  assert.equal(stats.booksIndex['hc:902'], undefined);
  // Manual `false` beats both the detector and series propagation.
  assert.ok(stats.booksIndex['hc:903']);
  assert.equal(stats.booksIndex['hc:903'].mangaComics, false);
  assert.equal(stats.booksIndex['hc:904'], undefined);
  assert.equal(stats.booksIndex['hc:906'], undefined);

  const all = buildBooksStats({ includeMangaComics: true });
  assert.equal(all.summary.mangaExcluded, 0);
  assert.equal(all.booksIndex['hc:902'].mangaComics, true);
  assert.equal(all.booksIndex['hc:902'].mangaComicsSource, 'manual');
  assert.equal(all.booksIndex['hc:902'].mangaComicsOverride, true);
  assert.equal(all.booksIndex['hc:903'].mangaComicsOverride, false);
  assert.equal(all.booksIndex['hc:904'].mangaComicsSource, 'series');
});

test('flags file is fingerprint-revalidated (external write, no restart)', async () => {
  await resetFlags({ 'hc:900': { mangaComics: true, updatedAt: new Date().toISOString() } });
  const stats = buildBooksStats({});
  assert.equal(stats.booksIndex['hc:900'], undefined);
  assert.equal(stats.summary.mangaManualExcluded, 1);
  assert.equal(bookCache.getMangaFlag('hc:900').mangaComics, true);
  await resetFlags({});
});

test('HTTP POST/DELETE /api/books/work/flag upserts and resets', async (t) => {
  const express = require('express');
  const routes = require('../server/books/routes');
  const app = express();
  app.use(express.json());
  app.use('/api/books', routes);
  app.use((err, req, res, next) => {
    res.status(err.status || err.statusCode || 500).json({ code: err.code, error: err.message });
  });
  const server = app.listen(PORT);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${PORT}/api/books`;

  const bad = await fetch(`${base}/work/flag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workId: 'hc:900' }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'manga_flag_required');

  const created = await fetch(`${base}/work/flag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workId: 'hc:900', mangaComics: true }),
  });
  assert.equal(created.status, 200);
  const createdBody = await created.json();
  assert.equal(createdBody.workId, 'hc:900');
  assert.equal(createdBody.mangaComics, true);
  assert.ok(createdBody.updatedAt);

  const hidden = await (await fetch(`${base}/stats`)).json();
  assert.equal(hidden.booksIndex['hc:900'], undefined);

  const removed = await fetch(`${base}/work/flag?workId=${encodeURIComponent('hc:900')}`, {
    method: 'DELETE',
  });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).removed, true);

  const shown = await (await fetch(`${base}/stats`)).json();
  assert.ok(shown.booksIndex['hc:900']);
});

test('backfill helpers strip volume markers and target the 5 reported works', () => {
  assert.equal(backfill.baseTitle('Crossed, Vol. 14: Badlands'), 'Crossed');
  assert.equal(backfill.baseTitle('Southern Bastards: Book Two'), 'Southern Bastards');
  assert.equal(backfill.baseTitle('Desert Punk - L\'esprit du Désert - Tome 08'), "Desert Punk - L'esprit du Désert");
  assert.equal(backfill.baseTitle('Old Boy, Vol. 8'), 'Old Boy');
  assert.equal(backfill.seriesBase('Trigun (3 volumes)'), 'Trigun');
  for (const title of [
    'Desert Punk - L\'esprit du Désert - Tome 08',
    'Crossed, Vol. 14: Badlands',
    'Southern Bastards: Book Two',
    'Trigun, Vol. 1',
    'Old Boy, Vol. 8',
  ]) {
    assert.equal(backfill.isVolumeLike({ title }), true, title);
  }
  assert.equal(backfill.isVolumeLike({ title: 'Дюна' }), false);
});

test('backfill enrichDoc merges a provider publisher into mangaTexts', async () => {
  const fakeProvider = {
    source: 'fake',
    getWork: async () => ({
      source: 'fake',
      sourceId: 'x',
      title: 'Desert Punk',
      publisher: 'GLENAT',
      genres: [],
      series: null,
      mangaComics: true,
      mangaTexts: ['GLENAT'],
    }),
  };
  const doc = {
    title: "Desert Punk - L'esprit du Désert - Tome 08",
    authors: [{ name: 'Masatoshi Usune' }],
    genres: ['Science Fiction'],
    series: [{ hcId: 174534, name: 'Desert Punk' }],
    isbn13: null,
    isbn10: null,
    mangaComics: false,
  };
  const result = await backfill.enrichDoc(doc, {
    providers: [fakeProvider],
    pause: 0,
    sleep: async () => {},
  });
  assert.equal(result.mangaComics, true);
  assert.ok(result.texts.includes('GLENAT'));
});
