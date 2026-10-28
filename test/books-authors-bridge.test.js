'use strict';

/**
 * Default-on Wikidata author bridge (`authors-bridge.js`).
 *
 * The offline rule (authors.js) cannot prove an exonym: «Уильям Сомерсет Моэм»
 * vs «W. Somerset Maugham». Until 28.10.2026 the bridge ran only from a manual
 * backfill, so a fresh deployment kept those duplicates. Now a stats build kicks
 * it automatically, for the *unresolved* spellings only, and the answer is
 * cached in authors.json.
 *
 * Pinned here:
 *   - only singleton (offline-unresolved) and not-yet-asked names go to WDQS;
 *   - the payload path never waits (buildBooksStats calls the bridge, the spy
 *     proves the arguments and that stats returns without it);
 *   - a repeat pass with a full cache issues ZERO requests;
 *   - 429 and a network error degrade without throwing and start a cooldown;
 *   - a manual edit in authors.json survives every automatic pass;
 *   - a label shared by two people (ambiguous QIDs) is not merged.
 *
 * Every fetch is mocked: this file never touches the network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-authors-br-'));

const bookCache = require('../server/books/book-cache');
const authors = require('../server/books/authors');
const bridge = require('../server/books/authors-bridge');
const { buildBooksStats } = require('../server/books/stats');

const MOEM_RU = 'Уильям Сомерсет Моэм';
const MOEM_EN = 'W. Somerset Maugham';

function jsonResponse(bindings) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ results: { bindings } }),
  };
}

/**
 * A fake WDQS: `labels` maps a spelling to its QIDs, `qids` maps a QID to all
 * the spellings it carries as a label/alias.
 */
function mockWikidata({ labels = {}, qids = {} } = {}) {
  const calls = { name: 0, item: 0, urls: [] };
  const fetchImpl = async (url, init) => {
    const decoded = decodeURIComponent(String((init && init.body) || url)).replace(/\+/g, ' ');
    calls.urls.push(decoded);
    if (/VALUES \?label/.test(decoded)) {
      calls.name++;
      const bindings = [];
      for (const [label, list] of Object.entries(labels)) {
        if (!decoded.includes(`"${label}"`)) continue;
        for (const qid of list) {
          bindings.push({
            item: { value: `http://www.wikidata.org/entity/${qid}` },
            label: { value: label },
          });
        }
      }
      return jsonResponse(bindings);
    }
    calls.item++;
    const bindings = [];
    for (const [qid, names] of Object.entries(qids)) {
      if (!decoded.includes(`wd:${qid}`)) continue;
      for (const name of names) {
        bindings.push({
          item: { value: `http://www.wikidata.org/entity/${qid}` },
          name: { value: name },
        });
      }
    }
    return jsonResponse(bindings);
  };
  return { fetchImpl, calls };
}

const exonymMock = () =>
  mockWikidata({
    labels: { [MOEM_RU]: ['Q1348'], [MOEM_EN]: ['Q1348'] },
    qids: { Q1348: [MOEM_RU, MOEM_EN] },
  });

const ENTRIES = [
  { name: MOEM_RU, workId: 'a' },
  { name: MOEM_EN, workId: 'b' },
  { name: 'Настоящий Автор', workId: 'c' },
];

test('pendingCandidates asks only for offline-unresolved, not-yet-checked names', () => {
  const entries = [
    { name: 'Агата Кристи' },
    { name: 'Agatha Christie' }, // offline rule merges these
    { name: 'Джоан Роулинг' }, // already asked in a previous pass
    { name: 'Моэм' },
  ];
  const persisted = {
    canonical: {},
    manual: {},
    wikidata: { checked: { 'джоан роулинг': true }, checkedAt: null, disabledUntil: null },
  };
  const pending = bridge.pendingCandidates(entries, persisted);
  assert.deepEqual(pending.sort(), ['Моэм'].sort());
  // A manually merged spelling is not a candidate either (the anchor must be
  // in the corpus for authors.js to union the group).
  const withManual = bridge.pendingCandidates(
    [{ name: 'Моэм' }, { name: 'Уильям Сомерсет Моэм' }],
    {
      manual: { 'моэм': 'Уильям Сомерсет Моэм' },
      canonical: {},
      wikidata: { checked: {}, checkedAt: null, disabledUntil: null },
    }
  );
  assert.deepEqual(withManual, []);
});
test('an exonym pair is merged by QID and the answer lands in authors.json', async () => {
  const { fetchImpl, calls } = exonymMock();
  const report = await bridge.resolveAuthorsWikidata(ENTRIES, {
    fetchImpl,
    sleep: async () => {},
    pauseMs: 0,
    now: () => Date.parse('2026-10-28T10:00:00Z'),
  });
  assert.equal(report.ran, true);
  assert.equal(report.reason, 'ok');
  assert.equal(report.merged, 1);
  assert.ok(calls.name >= 1 && calls.item >= 1);
  assert.ok(report.queries >= 2 && report.queries <= 4, `queries=${report.queries}`);

  const map = bookCache.getAuthorsMap();
  assert.equal(map.canonical[authors.normalizeAuthorName(MOEM_RU)], MOEM_EN);
  assert.equal(map.wikidata.checked[authors.normalizeAuthorName(MOEM_RU)], true);
  assert.equal(map.wikidata.checked[authors.normalizeAuthorName('Настоящий Автор')], true);
  assert.equal(map.wikidata.checkedAt, '2026-10-28T10:00:00.000Z');
  assert.equal(map.wikidata.disabledUntil, null);

  // The next payload applies the table: one author row, not two.
  const grouped = authors.groupAuthors(ENTRIES, bookCache.getAuthorsMap());
  assert.equal(grouped.groups.filter((group) => group.name === MOEM_EN).length, 1);
  assert.equal(grouped.groups.length, 2); // Моэм + Настоящий Автор
});

test('a full cache means zero WDQS requests on the next pass', async () => {
  const { fetchImpl, calls } = exonymMock();
  const report = await bridge.resolveAuthorsWikidata(ENTRIES, {
    fetchImpl,
    sleep: async () => {},
    pauseMs: 0,
  });
  assert.equal(report.ran, false);
  assert.equal(report.reason, 'nothing_to_do');
  assert.equal(report.pending, 0);
  assert.equal(calls.name + calls.item, 0);

  const kicked = bridge.kickAuthorsWikidata(ENTRIES, { fetchImpl });
  if (kicked) await kicked;
  assert.equal(calls.name + calls.item, 0);
});

test('429 degrades, keeps the duplicates and starts a cooldown instead of throwing', async () => {
  bookCache.clearMemory();
  fs.rmSync(bookCache.AUTHORS_PATH, { force: true });
  const blocked = {
    ok: false,
    status: 429,
    headers: { get: () => '120' },
    json: async () => ({}),
  };
  let calls = 0;
  const report = await bridge.resolveAuthorsWikidata(
    [{ name: 'Говард Лавкрафт' }, { name: 'H. P. Lovecraft' }],
    {
      fetchImpl: async () => {
        calls++;
        return blocked;
      },
      sleep: async () => {},
      pauseMs: 0,
      now: () => Date.parse('2026-10-28T10:00:00Z'),
    }
  );
  assert.equal(report.ran, true);
  assert.equal(report.reason, 'degraded');
  assert.equal(report.merged, 0);
  assert.equal(report.skipped, 'wikidata_429');
  assert.equal(calls, 1);

  const map = bookCache.getAuthorsMap();
  // Nothing merged, nothing remembered as checked: the pair stays unresolved
  // but is retried later (a transient block must not freeze the merge set).
  assert.deepEqual(map.wikidata.checked, {});
  assert.ok(map.wikidata.disabledUntil);
  const until = Date.parse(map.wikidata.disabledUntil);
  assert.ok(until >= Date.parse('2026-10-28T10:02:00Z'), map.wikidata.disabledUntil);

  // Cooldown: the next automatic pass costs nothing.
  const again = await bridge.resolveAuthorsWikidata(
    [{ name: 'Говард Лавкрафт' }, { name: 'H. P. Lovecraft' }],
    {
      fetchImpl: async () => {
        calls++;
        return blocked;
      },
      sleep: async () => {},
      pauseMs: 0,
      now: () => Date.parse('2026-10-28T10:05:00Z'),
    }
  );
  assert.equal(again.reason, 'cooldown');
  assert.equal(calls, 1);

  // …and `--force` (manual backfill) is not held by the cooldown.
  const forced = await bridge.resolveAuthorsWikidata(
    [{ name: 'Говард Лавкрафт' }, { name: 'H. P. Lovecraft' }],
    {
      fetchImpl: async () => {
        calls++;
        return blocked;
      },
      sleep: async () => {},
      pauseMs: 0,
      force: true,
      now: () => Date.parse('2026-10-28T10:05:00Z'),
    }
  );
  assert.equal(forced.reason, 'degraded');
  assert.equal(calls, 2);
});

test('a network failure degrades to the offline result (no throw into the payload)', async () => {
  bookCache.clearMemory();
  fs.rmSync(bookCache.AUTHORS_PATH, { force: true });
  const report = await bridge.resolveAuthorsWikidata(
    [{ name: 'Сьюзан Кинг' }, { name: 'Stephen King' }],
    {
      fetchImpl: async () => {
        throw new Error('EAI_AGAIN');
      },
      sleep: async () => {},
      pauseMs: 0,
    }
  );
  assert.equal(report.ran, false);
  assert.equal(report.reason, 'error');
  assert.match(report.error, /EAI_AGAIN/);
  const map = bookCache.getAuthorsMap();
  assert.ok(map.wikidata.disabledUntil);
  // The known false-merge traps stay apart: nothing was written.
  const grouped = authors.groupAuthors(
    [{ name: 'Сьюзан Кинг', workId: 'a' }, { name: 'Stephen King', workId: 'b' }],
    map
  );
  assert.equal(grouped.groups.length, 2);
});

test('a manual edit survives an automatic Wikidata pass', async () => {
  bookCache.clearMemory();
  fs.rmSync(bookCache.AUTHORS_PATH, { force: true });
  await bookCache.saveAuthorsMap({
    canonical: {},
    manual: { 'джоан роулинг': 'Джоан Роулинг' },
  });
  // «Роберт Гэлбрейт» is a real Wikidata alias of J. K. Rowling: a merge the
  // transliteration rule cannot prove.
  const { fetchImpl } = mockWikidata({
    labels: { 'Джоан Роулинг': ['Q34660'], 'Роберт Гэлбрейт': ['Q34660'] },
    qids: { Q34660: ['Джоан Роулинг', 'Роберт Гэлбрейт', 'J. K. Rowling'] },
  });
  const report = await bridge.resolveAuthorsWikidata(
    [{ name: 'Джоан Роулинг' }, { name: 'Роберт Гэлбрейт' }],
    { fetchImpl, sleep: async () => {}, pauseMs: 0 }
  );
  assert.equal(report.ran, true);
  assert.equal(report.merged, 1);
  const map = bookCache.getAuthorsMap();
  assert.equal(map.manual['джоан роулинг'], 'Джоан Роулинг');
  const grouped = authors.groupAuthors(
    [{ name: 'Джоан Роулинг', workId: 'a' }, { name: 'Роберт Гэлбрейт', workId: 'b' }],
    map
  );
  assert.equal(grouped.groups.length, 1);
  // The human decision beats both the English preference and the Wikidata
  // display pick.
  assert.equal(grouped.groups[0].name, 'Джоан Роулинг');
});

test('an ambiguous label (two QIDs) is not merged', async () => {
  bookCache.clearMemory();
  fs.rmSync(bookCache.AUTHORS_PATH, { force: true });
  // «Моэм» alone is a surname with no given name: the offline rule leaves it
  // apart from «Уильям Сомерсет Моэм», so both reach WDQS. WDQS knows two
  // people by that label, so nothing may be merged on its word alone.
  const { fetchImpl } = mockWikidata({
    labels: { 'Моэм': ['Q1348', 'Q9'], 'Уильям Сомерсет Моэм': ['Q1348'] },
    qids: {
      Q1348: ['Моэм', 'Уильям Сомерсет Моэм'],
      Q9: ['Моэм', 'Сомерсет Моэм'],
    },
  });
  const report = await bridge.resolveAuthorsWikidata(
    [{ name: 'Моэм' }, { name: 'Уильям Сомерсет Моэм' }],
    { fetchImpl, sleep: async () => {}, pauseMs: 0 }
  );
  assert.equal(report.ran, true);
  assert.equal(report.merged, 0);
  const map = bookCache.getAuthorsMap();
  assert.deepEqual(map.canonical, {});
});

test('buildBooksStats kicks the bridge without waiting for it', async () => {
  bookCache.clearMemory();
  fs.rmSync(bookCache.AUTHORS_PATH, { force: true });
  const profile = 'Kick';
  await bookCache.saveProfile('livelib', profile, {
    schemaVersion: 1,
    source: 'livelib',
    userKey: profile,
    sourceUserId: null,
    importedAt: '2026-10-28T00:00:00.000Z',
    warnings: [],
    events: [
      {
        id: 'll:1',
        source: 'livelib',
        sourceBookId: '1',
        title: 'Луна и грош',
        authors: [MOEM_RU],
        status: 'read',
        shelf: 'read',
        origin: 'livelib-file',
        finishedAt: '2020-01-02',
        edition: {},
        genres: [],
      },
    ],
  });
  let captured = null;
  const stats = buildBooksStats({
    profile: `livelib-${profile}`,
    includeMangaComics: true,
    authorBridge: (entries, options) => {
      captured = { entries, options };
      return Promise.resolve();
    },
  });
  assert.ok(stats && stats.summary, 'payload is returned even though the bridge would be async');
  assert.ok(captured, 'the bridge was called');
  assert.ok(captured.entries.some((entry) => entry.name === MOEM_RU));
  assert.ok(Array.isArray(captured.options.groups), 'the payload grouping is reused');
  assert.ok(captured.options.persisted && 'canonical' in captured.options.persisted);

  // A throwing bridge must not break the payload either.
  const safe = buildBooksStats({
    profile: `livelib-${profile}`,
    includeMangaComics: true,
    authorBridge: () => {
      throw new Error('bridge exploded');
    },
  });
  assert.equal(safe.summary.bookCount, 1);
});
