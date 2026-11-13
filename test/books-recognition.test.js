'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('./helpers/env');

const run = env.makeTmpCache('books-recognition', { budgets: false });
process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;
process.env.KINOBOXD_BOOKS_WIKIDATA = '1';

after(() => env.cleanupTmpDirs());
process.on('exit', () => env.cleanupTmpDirs());

const bookCache = require('../server/books/book-cache');
const { buildBooksStats } = require('../server/books/stats');
const yearsBackfill = require('../server/books/years-backfill');
const unlinkedYears = require('../server/books/unlinked-years');
const { isUnlinked } = require('../server/books/scheduled-resolve');
const { titleVariants, partVariants } = require('../server/books/providers/title-variants');
const { canOverrideClaim } = require('../server/books/providers/claim');
const wikidata = require('../server/books/providers/wikidata');
const openlibrary = require('../server/books/providers/openlibrary');
const { isChallengeableClaim, storedFirstClaim } = require('../server/books/providers/claim');
const { needsYearQuestion, storedPrintClaim } = require('../server/books/backfill-queue');

const noSleep = async () => {};

function cell(value) {
  return { value: String(value) };
}

function sparqlRow(spec) {
  const row = {};
  for (const [name, value] of Object.entries(spec)) {
    if (value != null) row[name] = cell(value);
  }
  return row;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    url: 'https://example.test/',
    headers: { get: () => null },
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

function wikidataFetch(rows) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), query: new URLSearchParams(String(init.body)).get('query') || '' });
    const first = calls.length === 1;
    return jsonResponse({ head: { vars: [] }, results: { bindings: first ? rows : [] } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

describe('books-recognition', () => {
  describe('wikidata author birth gate', () => {
    test('the search query projects the author birth it filters on', async () => {
      const fetchImpl = wikidataFetch([]);
      await wikidata.lookupTitles([{ key: 'k', title: 'Цыганка', authors: ['Агата Кристи'] }], {
        fetchImpl,
        sleep: noSleep,
        pauseMs: 0,
      });
      const select = fetchImpl.calls[0].query.split('WHERE')[0];
      assert.match(select, /\?authorBirth\b/);
    });

    test('a claim older than the author is dropped', async () => {
      wikidata.resetBreaker();
      const fetchImpl = wikidataFetch([
        sparqlRow({
          label: 'Цыганка',
          item: 'http://www.wikidata.org/entity/Q1',
          itemLabel: 'Цыганка',
          author: 'http://www.wikidata.org/entity/Q35064',
          authorLabel: 'Агата Кристи',
          authorBirth: '1890-09-15T00:00:00Z',
          sitelinks: 3,
          p577: '1850-01-01T00:00:00Z',
          p577Prec: 9,
        }),
      ]);
      const found = await wikidata.lookupTitles(
        [{ key: 'k', title: 'Цыганка', authors: ['Агата Кристи'] }],
        { fetchImpl, sleep: noSleep, pauseMs: 0 }
      );
      assert.equal(found.byKey.get('k'), null);
    });

    test('the earliest co-author birth is the bound', () => {
      const rows = [
        { item: 'Q1', itemLabel: 'X', authorLabel: 'A', author: 'QA', authorBirthYear: 1950, publication: { year: 1940, precision: 'year' } },
        { item: 'Q1', itemLabel: 'X', authorLabel: 'B', author: 'QB', authorBirthYear: 1900, publication: { year: 1940, precision: 'year' } },
      ];
      const [candidate] = wikidata.candidatesFor(rows, [], { title: 'X', authors: ['A'] });
      assert.equal(candidate.authorBirthYear, 1900);
    });
  });

  describe('open library work record', () => {
    test('first_publish_date of the work is the first-publication year', async () => {
      const fetchImpl = async (url) => {
        if (String(url).includes('/api/books')) {
          return jsonResponse({
            'ISBN:9785170000000': {
              key: '/books/OL12538881M',
              title: 'Doktor ZHivago',
              authors: [{ name: 'Boris Pasternak' }],
              publish_date: '2006',
              works: [{ key: '/works/OL258301W' }],
              identifiers: { isbn_13: ['9785170000000'] },
            },
          });
        }
        return jsonResponse({ title: 'Доктор Живаго', first_publish_date: 'March 1957' });
      };
      const found = await openlibrary.getWork(
        { isbn13: '9785170000000' },
        { fetchImpl, sleep: noSleep, requestDelayMs: 0 }
      );
      assert.equal(found.year, 2006);
      assert.equal(found.firstPublishedYear, 1957);
    });
  });

  describe('legacy claims without a source', () => {
    const legacy = { workId: 'ol:OL1W', title: 'Евгений Онегин', firstPublishedYear: 2023, publicationYear: 2023 };

    test('a claim without a source is challengeable, a wikidata one is not', () => {
      assert.equal(isChallengeableClaim(storedFirstClaim(legacy)), true);
      assert.equal(isChallengeableClaim({ year: 1833, source: 'wikidata' }), false);
      assert.equal(isChallengeableClaim({ year: 2001, source: 'litres' }), true);
      assert.equal(isChallengeableClaim(null), false);
    });

    test('the backfill queue asks about a legacy claim', () => {
      assert.ok(storedPrintClaim(legacy));
      assert.equal(needsYearQuestion(legacy), true);
    });

    test('a manual year stays out of the queue', () => {
      const manual = { ...legacy, yearSource: 'manual' };
      assert.equal(storedPrintClaim(manual), null);
      assert.equal(needsYearQuestion(manual), false);
    });
  });

  describe('title variants', () => {
    test('collection and kit markers are dropped, the sentence-case form is asked', () => {
      assert.ok(titleVariants('Бог Мелочей').includes('Бог мелочей'));
      assert.ok(titleVariants('Записки юного врача (сборник)').includes('Записки юного врача'));
      assert.ok(titleVariants('Унесенные ветром (комплект из 2 книг)').includes('Унесенные ветром'));
      assert.ok(titleVariants('Поле битвы - Земля').includes('Поле битвы — Земля'));
    });

    test('a bilingual row is asked by each half', () => {
      const variants = titleVariants('Зов Ктулху / The Call of Cthulhu (+ CD-ROM)');
      assert.ok(variants.includes('Зов Ктулху'));
    });

    test('a volume of a multi-volume edition maps to the whole work tier only', () => {
      const parts = partVariants('Сага о Форсайтах. В четырех книгах. Книга 3 (сборник)');
      assert.ok(parts.whole.includes('Сага о Форсайтах'));
      assert.ok(!titleVariants('Сага о Форсайтах. В четырех книгах. Книга 3 (сборник)').includes('Сага о Форсайтах'));
      assert.ok(partVariants('Поле битвы - Земля. Том 1').whole.includes('Поле битвы — Земля'));
    });

    test('a series prefix gives the subtitle tier, an author name is never a title', () => {
      const parts = partVariants('Волкодав. Право на поединок', ['Мария Семёнова']);
      assert.ok(parts.subtitle.includes('Право на поединок'));
      assert.ok(parts.whole.includes('Волкодав'));
      const sage = partVariants('Конфуций. Великие изречения', ['Конфуций']);
      assert.ok(!sage.whole.includes('Конфуций'));
      assert.ok(sage.subtitle.includes('Великие изречения'));
    });
  });

  describe('author name order', () => {
    test('surname-first spellings match the label', () => {
      assert.equal(wikidata.authorHit('Борис Леонидович Пастернак', ['Пастернак Б.Л.']), true);
      assert.equal(wikidata.authorHit('Жюльетта Бенцони', ['Бенцони Жюльетта']), true);
      assert.equal(wikidata.authorHit('Eiichiro Oda', ['Oda Eiichiro']), true);
    });

    test('a shared given name is not an author match', () => {
      assert.equal(wikidata.authorHit('О. Генри', ['Генри Хаггард']), false);
      assert.equal(wikidata.authorHit('Иван Тургенев', ['Юлия Яковлева']), false);
    });
  });

  describe('variant tiers', () => {
    const saga = (label, extra = {}) =>
      sparqlRow({
        label,
        item: 'http://www.wikidata.org/entity/Q735319',
        itemLabel: label,
        author: 'http://www.wikidata.org/entity/Q190379',
        authorLabel: 'Джон Голсуорси',
        sitelinks: 30,
        p577: '1906-01-01T00:00:00Z',
        p577Prec: 9,
        seriesLabel: 'Форсайты',
        ...extra,
      });

    test('a whole-work match fills a year but carries no identity or series', async () => {
      wikidata.resetBreaker();
      const fetchImpl = wikidataFetch([saga('Сага о Форсайтах')]);
      const found = await wikidata.lookupTitles(
        [{ key: 'k', title: 'Сага о Форсайтах. В четырех книгах. Книга 3', authors: ['Джон Голсуорси'] }],
        { fetchImpl, sleep: noSleep, pauseMs: 0 }
      );
      const result = found.byKey.get('k');
      assert.equal(result.firstPublishedYear, 1906);
      assert.equal(result.match.wholeWork, true);
      assert.equal(result.wikidataWorkId, null);
      assert.deepEqual(result.seriesAll, []);
      assert.equal(canOverrideClaim(result), false);
    });

    test('a part tier never accepts a candidate without the author', async () => {
      wikidata.resetBreaker();
      const fetchImpl = wikidataFetch([
        sparqlRow({
          label: 'Конфуций',
          item: 'http://www.wikidata.org/entity/Q19177244',
          itemLabel: 'Конфуций',
          sitelinks: 1,
          p577: '1898-01-01T00:00:00Z',
          p577Prec: 9,
        }),
      ]);
      const found = await wikidata.lookupTitles(
        [{ key: 'k', title: 'Волкодав. Конфуций', authors: ['Мария Семёнова'] }],
        { fetchImpl, sleep: noSleep, pauseMs: 0 }
      );
      assert.equal(found.byKey.get('k'), null);
    });

    test('an exact title match can still override a print claim', async () => {
      wikidata.resetBreaker();
      const fetchImpl = wikidataFetch([saga('Сага о Форсайтах')]);
      const found = await wikidata.lookupTitles(
        [{ key: 'k', title: 'Сага о Форсайтах', authors: ['Голсуорси Д.'] }],
        { fetchImpl, sleep: noSleep, pauseMs: 0 }
      );
      const result = found.byKey.get('k');
      assert.equal(result.match.wholeWork, false);
      assert.equal(result.wikidataWorkId, 'Q735319');
      assert.equal(canOverrideClaim(result), true);
    });
  });

  describe('unlinked works', () => {
    const NOW = '2026-11-13T00:00:00.000Z';

    function fakeProvider(claims) {
      const asked = [];
      return {
        asked,
        async lookupTitles(list) {
          asked.push(...list.map((entry) => entry.key));
          const byKey = new Map();
          for (const entry of list) {
            const claim = claims[entry.title];
            if (!claim) continue;
            byKey.set(entry.key, {
              source: 'wikidata',
              firstPublishedYear: claim,
              firstPublishedYearPrecision: 'year',
              firstPublishedYearKind: 'publication',
              wikidataWorkId: 'Q602288',
              wikidataAuthorIds: [{ name: 'Стивен Кинг', qid: 'Q39829' }],
              seriesAll: [],
              match: { authorHit: true, wholeWork: false },
            });
          }
          return { byKey, asked: new Set(list.map((entry) => entry.key)), skipped: null, queries: 1 };
        },
      };
    }

    const silent = (name) => ({ NAME: name, isBreakerOpen: () => false, async getWork() { return null; } });

    async function seedProfile() {
      await bookCache.saveProfile('livelib', 'Unlinked', {
        schemaVersion: 1,
        source: 'livelib',
        userKey: 'Unlinked',
        importedAt: NOW,
        events: [
          { sourceBookId: '7001', title: 'Оно', authors: ['Стивен Кинг'], status: 'read', shelf: 'read' },
          { sourceBookId: '7002', title: 'Неизвестная книга', authors: ['Никто'], status: 'read', shelf: 'read' },
          { sourceBookId: '7003', title: 'Отложенная', authors: ['Кто-то'], status: 'wish', shelf: 'wish' },
          { sourceBookId: '7004', title: 'Связанная', authors: ['Автор'], status: 'read', shelf: 'read' },
        ],
        warnings: [],
      });
      await bookCache.saveLink('7004', { schemaVersion: 2, livelibBookId: '7004', workId: 'hc:7004', method: 'isbn', score: 1 });
    }

    test('only read, unlinked events without card metadata are asked', async () => {
      await seedProfile();
      const keys = unlinkedYears.unlinkedTargets({ nowMs: Date.parse(NOW) }).map((entry) => entry.key);
      assert.ok(keys.includes('7001'));
      assert.ok(keys.includes('7002'));
      assert.ok(!keys.includes('7003'));
      assert.ok(!keys.includes('7004'));
    });

    test('the backfill writes year-only documents and the payload shows the year', async () => {
      await seedProfile();
      const provider = fakeProvider({ 'Оно': 1986 });
      const report = await yearsBackfill.backfill({
        wikidataProvider: provider,
        litresProvider: silent('litres'),
        hardcoverProvider: silent('hardcover'),
        openlibraryProvider: silent('openlibrary'),
        log: () => {},
        sleep: noSleep,
        pause: 0,
        now: NOW,
      });
      assert.equal(report.unlinked.claimed, 1);
      assert.equal(report.unlinked.missed, 1);
      const hit = bookCache.getWorkDetails('ll:7001');
      assert.equal(hit.yearOnly, true);
      assert.equal(hit.firstPublishedYear, 1986);
      assert.equal(hit.firstPublishedYearSource, 'wikidata');
      assert.equal(hit.title, 'Оно');
      assert.equal(hit.wikidataWorkId, 'Q602288');
      const miss = bookCache.getWorkDetails('ll:7002');
      assert.equal(miss.yearOnly, true);
      assert.equal(miss.firstPublishedYear, null);

      const payload = buildBooksStats({ profile: 'livelib-Unlinked' });
      const work = payload.booksIndex['ll:7001'];
      assert.equal(work.year, 1986);
      assert.equal(work.yearSource, 'first');
      assert.equal(work.title, 'Оно');
    });

    test('a year-only document does not stop the provider resolve', () => {
      assert.equal(isUnlinked({ sourceBookId: '7001', title: 'Оно' }), true);
    });

    test('a second run asks nobody until the recheck window passes', async () => {
      await seedProfile();
      const provider = fakeProvider({});
      await unlinkedYears.backfillUnlinkedYears({ wikidataProvider: provider, now: NOW, sleep: noSleep });
      assert.deepEqual(provider.asked, []);
      const later = '2026-12-20T00:00:00.000Z';
      await unlinkedYears.backfillUnlinkedYears({ wikidataProvider: provider, now: later, sleep: noSleep });
      assert.deepEqual(provider.asked, ['7002']);
    });

    test('the year-only document is not a challengeable claim in the main queue', () => {
      const keys = yearsBackfill.detailDocs().map((entry) => entry.doc.workId);
      assert.ok(!keys.includes('ll:7001'));
    });
  });
});
