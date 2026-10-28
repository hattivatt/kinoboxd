'use strict';

/**
 * Two-phase LiveLib import (light + deep) and the deep-scan progress mechanism.
 *
 * No network: the fake fetch replays the captured fixtures —
 *   - bulk page 1 (100 books, month headers),
 *   - RSC page 1/2/3 (20 distinct user_books with exact read dates each).
 *
 * Contract under test:
 *   - light: 3 requests, every book imported, only page 1 dated;
 *   - deep: exact dates for the rest, persisted every 5 pages, `percent` in the
 *     job status, resumable from `deepScan.lastPage`;
 *   - light re-check keeps the dates a previous deep scan collected;
 *   - `deep: 'auto'` runs deep only while undated events remain.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const BOOK_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-book-two-phase-'));
process.env.KINOBOXD_CACHE_BOOK_DIR = BOOK_CACHE_DIR;

const bookCache = require('../server/books/book-cache');
const livelib = require('../server/books/livelib');
const importJobs = require('../server/books/import');

const FIXTURES = path.join(__dirname, 'fixtures');
const page1 = zlib
  .gunzipSync(fs.readFileSync(path.join(FIXTURES, 'livelib-read-page1.html.gz')))
  .toString('utf8');
const page2 = zlib
  .gunzipSync(fs.readFileSync(path.join(FIXTURES, 'livelib-read-page2.html.gz')))
  .toString('utf8');
const page3 = zlib
  .gunzipSync(fs.readFileSync(path.join(FIXTURES, 'livelib-read-page3.html.gz')))
  .toString('utf8');
const bulkJson = JSON.parse(
  zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, 'livelib-bulk-page1.json.gz'))).toString('utf8')
);

function htmlResponse(html, url) {
  return {
    status: 200,
    url,
    headers: new Map(),
    text: async () => html,
  };
}

function jsonResponse(payload, url) {
  return {
    status: 200,
    url,
    headers: new Map(),
    text: async () => JSON.stringify(payload),
  };
}

/**
 * Fake LiveLib: bootstrap page, bulk JSON, RSC pages 1..3. Page 4+ repeats
 * page 3 so the scan stops there exactly like a shrunk collection.
 */
function fakeLivelib({ pageLimit = 3 } = {}) {
  const calls = [];
  const rscPages = [];
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    calls.push({ url: href, method: (options.method || 'GET').toUpperCase() });
    if (href.includes('biglist')) {
      // The captured fixture says `last_page: false` (it was page 1 of several);
      // the fake serves one page and declares it the last.
      return jsonResponse({ ...bulkJson, last_page: true }, href);
    }
    if (href.includes('/reader/') && !href.includes('ordering=')) {
      return htmlResponse('<html><body>bootstrap</body></html>', href);
    }
    const parsed = new URL(href);
    const page = Number(parsed.searchParams.get('page') || 1);
    rscPages.push(page);
    const body = page === 1 ? page1 : page === 2 ? page2 : page3;
    const finalUrl = 'https://www.livelib.ru/users/50064/books/read?ordering=read_at_desc' +
      (page > 1 ? `&page=${page}` : '');
    if (page > pageLimit) return htmlResponse(page3, finalUrl);
    return htmlResponse(body, finalUrl);
  };
  return { fetchImpl, calls, rscPages };
}

async function freshCache() {
  for (const name of fs.readdirSync(bookCache.PROFILES_DIR)) {
    fs.unlinkSync(path.join(bookCache.PROFILES_DIR, name));
  }
  bookCache.clearMemory();
}

test('light import: bootstrap + bulk + one RSC page, only page 1 dated', async () => {
  await freshCache();
  const fake = fakeLivelib();
  const result = await livelib.importLivelib('tester', {
    fetchImpl: fake.fetchImpl,
    bootstrapDelayMs: 0,
    delayMs: 0,
  });

  assert.equal(result.totals.events, 100); // bulk page 1 = 100 books
  assert.equal(result.totals.dated, 20); // RSC page 1 only
  assert.equal(result.totals.undated, 0); // every other book has at least a month
  assert.equal(result.totals.monthOnly, 80);
  assert.equal(result.requests.total, 2); // bulk + one RSC page (bootstrap excluded)
  assert.equal(fake.calls.length, 3); // bootstrap GET + bulk POST + RSC page 1
  assert.equal(fake.rscPages.length, 1);
  assert.equal(result.profile.deepScan, undefined);

  // Every page-1 book is in the events with its exact date; the rest honestly
  // has no `finishedAt`.
  const first = result.profile.events.find((event) => event.id === 'll:53103775');
  assert.equal(first.finishedAt, '2026-09-14');
  const undated = result.profile.events.filter((event) => !event.finishedAt);
  assert.equal(undated.length, 80);
  assert.ok(undated.every((event) => event.readMonth == null || /^\d{4}-\d{2}$/.test(event.readMonth)));
});

test('deep scan dates the imported events, persists batches and resumes', async () => {
  await freshCache();
  const light = await livelib.importLivelib('tester', {
    fetchImpl: fakeLivelib().fetchImpl,
    bootstrapDelayMs: 0,
    delayMs: 0,
  });
  const profile = light.profile;
  await bookCache.saveProfile('livelib', 'tester', profile);

  const fake = fakeLivelib();
  const batches = [];
  const progress = [];
  const deep = await livelib.deepScanProfile('tester', profile, {
    fetchImpl: fake.fetchImpl,
    delayMs: 0,
    onProgress: (entry) => progress.push(entry),
    onBatch: async (draft, state) => {
      batches.push({ lastPage: state.lastPage, dated: state.dated });
      await bookCache.saveProfile('livelib', 'tester', draft);
    },
  });

  // Page 1 is already fresh, so the scan requests 2 and 3, then page 4 comes
  // back with the offset:0 payload — the parser refuses it and stops instead
  // of writing page-1 dates twice.
  assert.deepEqual(fake.rscPages, [2, 3, 4]);
  assert.equal(deep.dated, 60); // 20 (light) + 20 + 20
  assert.equal(deep.total, 100);
  assert.equal(deep.skipped, false);
  assert.equal(deep.startPage, 2);
  assert.ok(progress.some((entry) => entry.page === 3 && entry.dated === 60));
  assert.ok(deep.warnings.some((warning) => /returned the payload for offset 0/.test(warning)));

  // Progress is persisted: a stored profile can be read mid-scan.
  const stored = bookCache.getProfile('livelib', 'tester');
  assert.equal(stored.deepScan.lastPage, 3);
  assert.equal(stored.deepScan.pageTotal, 63);
  assert.equal(stored.deepScan.dated, 60);
  assert.equal(stored.deepScan.done, false);
  assert.ok(batches.length >= 1);

  // Resume: the next run starts after the persisted page, not from page 1,
  // and an unparsable page leaves the collected dates untouched.
  const fake2 = fakeLivelib({ pageLimit: 6 });
  const resumed = await livelib.deepScanProfile('tester', stored, {
    fetchImpl: fake2.fetchImpl,
    delayMs: 0,
  });
  assert.equal(resumed.startPage, 4);
  assert.equal(fake2.rscPages[0], 4);
  assert.equal(resumed.dated, 60);
});

test('a completed deep scan is skipped instead of re-reading 63 pages', async () => {
  await freshCache();
  const profile = {
    schemaVersion: 1,
    source: 'livelib',
    userKey: 'done',
    events: [{ id: 'll:1', sourceUserBookId: '1', finishedAt: '2024-01-01' }],
    deepScan: { pageTotal: 63, lastPage: 63, done: true, dated: 1, total: 1 },
  };
  await bookCache.saveProfile('livelib', 'done', profile);
  const fake = fakeLivelib();
  const result = await livelib.deepScanProfile('done', profile, { fetchImpl: fake.fetchImpl });
  assert.equal(result.skipped, true);
  assert.equal(fake.calls.length, 0);
});

test('light re-check keeps deep-scan dates instead of throwing them away', () => {
  const existing = {
    events: [
      { id: 'll:1', finishedAt: '2022-05-06', rating10: 8 },
      { id: 'll:2', finishedAt: '2022-05-07', rating10: 9 },
    ],
  };
  const fresh = [
    { id: 'll:1', finishedAt: null, rating10: 8, readMonth: '2022-05' },
    { id: 'll:2', finishedAt: null, rating10: null },
    { id: 'll:3', finishedAt: '2026-09-01', rating10: 6 },
  ];
  assert.equal(livelib.mergeExistingDates(fresh, existing), 2);
  assert.equal(fresh[0].finishedAt, '2022-05-06');
  assert.equal(fresh[1].finishedAt, '2022-05-07');
  assert.equal(fresh[1].rating10, 9); // rating restored too
  assert.equal(fresh[0].readMonth, null);
  assert.equal(fresh[2].finishedAt, '2026-09-01'); // new event untouched
  // No existing profile = no-op.
  assert.equal(livelib.mergeExistingDates(fresh, null), 0);
});

test('job status exposes deep percent; auto-deep runs while dates are missing', async () => {
  await freshCache();
  global.fetch = fakeLivelib().fetchImpl;
  try {
    const job = importJobs.startLivelibImport('jobtester', { force: true, deep: 'auto' });
    await importJobs.idle();
    const status = importJobs.getStatus(job.id);

    assert.equal(status.done, true);
    assert.equal(status.stage, 'done');
    assert.equal(status.percent, 100);
    assert.ok(status.deep, 'deep block is reported');
    assert.equal(status.deep.pageTotal, 63);
    assert.equal(status.deep.percent, Math.round((3 / 63) * 100));
    assert.equal(status.deep.dated, 60);
    assert.equal(status.deep.done, false);
    // Every event now has at least a month from the bulk pass: nothing is
    // "undated", even though only page 1-3 books carry an exact day.
    assert.equal(status.undatedEventCount, 0);
    assert.equal(status.deep.monthOnly, 40);
  } finally {
    delete global.fetch;
  }
});
