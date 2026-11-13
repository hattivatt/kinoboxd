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
const { volumeNumberOf } = require('../server/books/normalize');
const { scoreCandidate } = require('../server/books/providers/match');
const { hardcoverEntryConflict, guardReject } = require('../server/books/resolve-stages/matching');
const { staleLinkKeys } = require('../server/books/resolve-stages/link-health');
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

  describe('volume gate', () => {
    test('one volume reader for Russian and English markers', () => {
      assert.equal(volumeNumberOf('Eyeshield 21, Vol. 10'), 10);
      assert.equal(volumeNumberOf('Атака на титанов. Том 6'), 6);
      assert.equal(volumeNumberOf('Сёгун. В 3 книгах. Книга 2'), 2);
      assert.equal(volumeNumberOf('Hell\'s Paradise: Jigokuraku. Volume 4'), 4);
      assert.equal(volumeNumberOf('The Book Thief'), null);
      assert.equal(volumeNumberOf('1984'), null);
    });

    test('a title search never pairs different volumes', () => {
      const query = { title: 'Атака на титанов. Том 6', authors: ['Хадзимэ Исаяма'] };
      assert.equal(scoreCandidate(query, { title: 'Атака на титанов. Книга 1', authors: ['Хадзимэ Исаяма'] }), null);
      assert.ok(scoreCandidate(query, { title: 'Атака на титанов. Книга 6', authors: ['Хадзимэ Исаяма'] }));
      assert.equal(
        guardReject({ title: 'Eyeshield 21, Vol. 10' }, { title: 'Eyeshield 21, Vol. 1: The Boy With the Golden Legs' }),
        'series-position'
      );
    });

    const eyeshield = {
      details: { hcWorkId: 7137, title: 'Eyeshield 21, Vol. 1: The Boy With the Golden Legs', series: [{ name: 'Eyeshield 21', position: 1 }] },
      editionTitle: 'Eyeshield 21, Volume 10',
    };
    const chocolate = {
      details: { hcWorkId: 964993, title: 'The Chocolate Box', series: [] },
      editionTitle: 'Дама под вуалью',
    };

    test('a Hardcover edition hung on another volume is refused', () => {
      assert.equal(hardcoverEntryConflict('Eyeshield 21, Vol. 10', eyeshield), 'volume');
      assert.equal(hardcoverEntryConflict(null, eyeshield), 'volume');
      assert.equal(
        hardcoverEntryConflict('Eyeshield 21, Vol. 1', { ...eyeshield, editionTitle: 'Eyeshield 21, Volume 1' }),
        null
      );
    });

    test('a derived ISBN must name the same book', () => {
      assert.equal(hardcoverEntryConflict('Тайна смерти итальянского графа', chocolate, { derived: true }), 'edition-title');
      assert.equal(hardcoverEntryConflict('Дама под вуалью', chocolate, { derived: true }), null);
      assert.equal(hardcoverEntryConflict('Тайна смерти итальянского графа', chocolate), null);
    });

    function cacheOf(links, works) {
      return {
        getLink: (key) => links[key] || null,
        getWorkDetails: (workId) => works[workId] || null,
      };
    }

    test('stored links to another volume or a shared collection ISBN are re-resolved', () => {
      const events = [
        { sourceBookId: '1', title: 'Eyeshield 21, Vol. 10', edition: { isbn13: '9781421506395' } },
        { sourceBookId: '2', title: 'Eyeshield 21, Vol. 1', edition: { isbn13: '9781591167525' } },
        { fileKey: 'tk:a', title: 'Двойной грех' },
        { fileKey: 'tk:b', title: 'Осиное гнездо' },
        { sourceBookId: '3', title: 'Сёгун. Книга 2', edition: {} },
        { sourceBookId: '4', title: 'Атака на титанов. Том 6' },
      ];
      const links = {
        1: { workId: 'hc:7137', method: 'isbn', evidence: { isbn: '9781421506395' } },
        2: { workId: 'hc:7137', method: 'isbn', evidence: { isbn: '9781591167525' } },
        'file:tk:a': { workId: 'hc:964993', method: 'isbn', evidence: { isbn: '9785699278060' } },
        'file:tk:b': { workId: 'hc:964993', method: 'isbn', evidence: { isbn: '9785699278060' } },
        3: { workId: 'hc:1', method: 'manual' },
        4: { workId: 'lr:1', method: 'litres-title' },
      };
      const works = {
        'hc:7137': eyeshield.details,
        'hc:964993': chocolate.details,
        'hc:1': { title: 'Shōgun', series: [{ position: 1 }] },
        'lr:1': { title: 'Атака на титанов. Книга 1' },
      };
      const stale = staleLinkKeys(events, cacheOf(links, works));
      assert.deepEqual([...stale].sort(), ['1', '4', 'file:tk:a', 'file:tk:b']);
    });
  });

  describe('author works channel', () => {
    const authorWorks = require('../server/books/providers/wikidata-author-works');

    function routedFetch(routes) {
      const calls = [];
      const fetchImpl = async (url, init) => {
        const query = new URLSearchParams(String(init.body)).get('query') || '';
        calls.push(query);
        const route = routes.find((item) => query.includes(item.marker));
        return jsonResponse({ head: { vars: [] }, results: { bindings: route ? route.rows : [] } });
      };
      fetchImpl.calls = calls;
      return fetchImpl;
    }

    const christie = [
      { marker: 'FILTER EXISTS { ?anyWork', rows: [
        sparqlRow({ name: 'Агата Кристи', human: 'http://www.wikidata.org/entity/Q35064', sitelinks: 150 }),
      ] },
      { marker: 'VALUES ?human', rows: [
        sparqlRow({ human: 'http://www.wikidata.org/entity/Q35064', humanBirth: '1890-09-15T00:00:00Z', work: 'http://www.wikidata.org/entity/Q1247314', label: 'Багдадские встречи', p577: '1951-03-05T00:00:00Z', p577Prec: 11 }),
        sparqlRow({ human: 'http://www.wikidata.org/entity/Q35064', humanBirth: '1890-09-15T00:00:00Z', work: 'http://www.wikidata.org/entity/Q752432', label: 'Тринадцать Сотрапезников', p577: '1933-01-01T00:00:00Z', p577Prec: 9 }),
        sparqlRow({ human: 'http://www.wikidata.org/entity/Q35064', humanBirth: '1890-09-15T00:00:00Z', work: 'http://www.wikidata.org/entity/Q1', label: 'Цыганка', p577: '1850-01-01T00:00:00Z', p577Prec: 9 }),
      ] },
    ];

    test('title similarity ignores case, ё and word endings', () => {
      assert.equal(authorWorks.titleSimilarity('Багдадская встреча', 'Багдадские встречи'), 1);
      assert.equal(authorWorks.titleSimilarity('Тринадцать сотрапезников', 'Тринадцать Сотрапезников'), 1);
      assert.ok(authorWorks.titleSimilarity('Коробка шоколада', 'Коробка конфет') < 0.75);
    });

    test('a label miss is found among the author works, fuzzy and fill-only', async () => {
      wikidata.resetBreaker();
      const fetchImpl = routedFetch(christie);
      const found = await wikidata.lookupTitles(
        [
          { key: 'a', title: 'Багдадская встреча', authors: ['Агата Кристи'] },
          { key: 'b', title: 'Тринадцать сотрапезников', authors: ['Агата Кристи'] },
          { key: 'c', title: 'Цыганка', authors: ['Агата Кристи'] },
          { key: 'd', title: 'Коробка шоколада', authors: ['Агата Кристи'] },
        ],
        { fetchImpl, sleep: noSleep, pauseMs: 0 }
      );
      const baghdad = found.byKey.get('a');
      assert.equal(baghdad.firstPublishedYear, 1951);
      assert.equal(baghdad.match.method, 'author-works');
      assert.equal(baghdad.wikidataWorkId, 'Q1247314');
      assert.deepEqual(baghdad.wikidataAuthorIds, [{ name: 'Агата Кристи', qid: 'Q35064' }]);
      assert.equal(baghdad.match.fuzzy, false);
      assert.equal(found.byKey.get('b').firstPublishedYear, 1933);
      assert.equal(found.byKey.get('c'), null);
      assert.equal(found.byKey.get('d'), null);
      assert.equal(found.asked.has('d'), true);
    });

    test('a fuzzy author-works match never overrides a stored claim', () => {
      assert.equal(canOverrideClaim({ match: { authorHit: true, fuzzy: true } }), false);
      assert.equal(canOverrideClaim({ match: { authorHit: true, fuzzy: false } }), true);
    });

    test('a failed author pass leaves its titles unasked', async () => {
      wikidata.resetBreaker();
      let call = 0;
      const fetchImpl = async () => {
        call++;
        if (call === 1) return jsonResponse({ head: { vars: [] }, results: { bindings: [] } });
        return jsonResponse({}, 503);
      };
      const found = await wikidata.lookupTitles(
        [{ key: 'a', title: 'Багдадская встреча', authors: ['Агата Кристи'] }],
        { fetchImpl, sleep: noSleep, pauseMs: 0 }
      );
      assert.equal(found.asked.has('a'), false);
      assert.ok(!found.byKey.get('a'));
      assert.equal(found.skipped, 'breaker');
      wikidata.resetBreaker();
    });
  });

  describe('stale link lifecycle', () => {
    const { persistLinks } = require('../server/books/resolve-stages/persist');
    const { tryProvider } = require('../server/books/resolve-stages/chain');

    test('a stale link without a replacement is dropped, a replaced one is rewritten', async () => {
      await bookCache.saveLink('8801', { schemaVersion: 2, livelibBookId: '8801', workId: 'lr:1', method: 'litres-title', score: 0.95 });
      await bookCache.saveLink('8802', { schemaVersion: 2, livelibBookId: '8802', workId: 'hc:7137', method: 'isbn', score: 1 });
      const replacement = { schemaVersion: 2, livelibBookId: '8802', workId: 'gb:X', method: 'googlebooks-isbn', score: 0.9 };
      const ctx = {
        plan: { links: new Map([['8802', replacement]]), stale: new Set(['8801', '8802']) },
        report: { methods: {} },
        cache: bookCache,
        force: false,
      };
      await persistLinks(ctx);
      assert.equal(bookCache.getLink('8801'), null);
      assert.equal(bookCache.getLink('8802').workId, 'gb:X');
      assert.equal(ctx.report.dropped, 1);
    });

    test('a provider answer for another volume counts as a miss', async () => {
      const provider = { NAME: 'litres', getWork: async () => ({ source: 'litres', title: 'Атака на титанов. Книга 1' }) };
      const ctx = {
        chain: { report: { litres: { calls: 0, hits: 0, skipped: 0, methods: {} } } },
        budget: {},
        options: {},
      };
      assert.equal(await tryProvider(provider, { title: 'Атака на титанов. Том 6' }, ctx), null);
      const same = await tryProvider(provider, { title: 'Атака на титанов. Книга 1' }, ctx);
      assert.equal(same.title, 'Атака на титанов. Книга 1');
    });
  });
});
