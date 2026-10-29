'use strict';

/**
 * Scheduled resolve (kinoboxd-resolve-books): candidate pool, per-candidate
 * negative state, keying of file-only rows, budget and the cross-process lock.
 *
 * The real CLI is exercised through `resolveOneProfile`/`runScheduledResolve`
 * with injected providers, so no test ever touches litres.ru, Hardcover or
 * LiveLib.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-scheduled-resolve-'));

const bookCache = require('../server/books/book-cache');
const resolve = require('../server/books/resolve');
const scheduled = require('../server/books/scheduled-resolve');
const resolveLock = require('../server/books/resolve-lock');
const { buildBooksStats } = require('../server/books/stats');

const DAY = 24 * 60 * 60 * 1000;

function fileEvent(fileKey, title, extra = {}) {
  return {
    id: `llfile:${fileKey}:read`,
    fileKey,
    source: 'livelib-file',
    origin: 'livelib-file',
    title,
    authors: ['Автор'],
    rating: 4,
    ratingScale: 5,
    rating10: 8,
    status: 'read',
    shelf: 'read',
    finishedAt: '2024-01-02',
    edition: { isbn: null, isbn13: null, isbn10: null, year: null },
    genres: [],
    ...extra,
  };
}

function profile(userKey, events) {
  return {
    schemaVersion: 1,
    source: 'livelib',
    userKey,
    importedAt: '2026-10-28T00:00:00.000Z',
    events,
    warnings: [],
  };
}

/** Provider that records calls and always answers "nothing". */
function missProvider(name = 'googlebooks') {
  const calls = [];
  return {
    NAME: name,
    calls,
    getWork: async (input) => {
      calls.push(input.eventKey || input.llBookId || null);
      return null;
    },
  };
}

function statsFor(keys) {
  const booksIndex = {};
  for (const key of keys) booksIndex[`ll:${key}`] = { workId: `ll:${key}`, unresolved: true };
  return { booksIndex };
}

test('file-only rows are keyed by file:<fileKey> in attempted/unmatched', async () => {
  const data = profile('FileKey', [fileEvent('tk:abc123', 'Неизвестная книга')]);
  const miss = missProvider('googlebooks');
  const report = await resolve.resolveProfile(data, {
    providers: [miss],
    allowLivelibCard: false,
    litresBudget: { limit: 0, used: 0, remaining: 0, take: () => false },
  });
  assert.deepEqual(report.attemptedKeys, ['file:tk:abc123']);
  assert.deepEqual(report.unmatchedKeys, ['file:tk:abc123']);
  assert.deepEqual(report.missedByKey, { 'file:tk:abc123': ['googlebooks'] });
  assert.deepEqual(miss.calls, ['file:tk:abc123']);
});

test('a provider miss is remembered and not re-asked inside the window', async () => {
  const data = profile('Window', [
    fileEvent('tk:one', 'Первая книга'),
    fileEvent('tk:two', 'Вторая книга'),
  ]);
  const stats = statsFor(['file:tk:one', 'file:tk:two']);
  const now = Date.parse('2026-10-29T12:00:00.000Z');

  const first = missProvider('googlebooks');
  const run1 = await scheduled.resolveOneProfile(data, {
    stats,
    providers: [first],
    limit: 1,
    now,
    nowIso: new Date(now).toISOString(),
    litresBudget: { limit: 0, used: 0, remaining: 0, take: () => false },
  });
  assert.equal(run1.selected, 1);
  assert.equal(run1.misses, 1);
  assert.deepEqual(first.calls, ['file:tk:one']);
  const state = scheduled.loadCandidateState('livelib', 'Window');
  assert.equal(state.candidates['file:tk:one'].outcome, 'miss');
  assert.equal(state.candidates['file:tk:one'].askedAt, new Date(now).toISOString());

  // Next hour: the first row is inside the 90-day window, only the second is
  // selected; the provider must not see the missed key again.
  const second = missProvider('googlebooks');
  const run2 = await scheduled.resolveOneProfile(data, {
    stats,
    providers: [second],
    limit: 5,
    now: now + 60 * 60 * 1000,
    nowIso: new Date(now + 60 * 60 * 1000).toISOString(),
    litresBudget: { limit: 0, used: 0, remaining: 0, take: () => false },
  });
  assert.equal(run2.selected, 1);
  assert.deepEqual(second.calls, ['file:tk:two']);
  assert.equal(run2.activeRemaining, 0);

  // After the window (default 90 days) both are candidates again.
  const third = missProvider('googlebooks');
  const run3 = await scheduled.resolveOneProfile(data, {
    stats,
    providers: [third],
    limit: 5,
    now: now + 91 * DAY,
    nowIso: new Date(now + 91 * DAY).toISOString(),
    litresBudget: { limit: 0, used: 0, remaining: 0, take: () => false },
  });
  assert.equal(run3.selected, 2);
  assert.deepEqual(third.calls.sort(), ['file:tk:one', 'file:tk:two']);

  // `--force` ignores the negative cache entirely.
  const forced = missProvider('googlebooks');
  await scheduled.resolveOneProfile(data, {
    stats,
    providers: [forced],
    limit: 5,
    force: true,
    now: now + 92 * DAY,
    nowIso: new Date(now + 92 * DAY).toISOString(),
    litresBudget: { limit: 0, used: 0, remaining: 0, take: () => false },
  });
  assert.equal(forced.calls.length, 2);
});

test('a budget-starved provider is a deferral, not a negative verdict', async () => {
  const data = profile('Budget', [fileEvent('tk:budget', 'Неизвестная книга')]);
  const stats = statsFor(['file:tk:budget']);
  const calls = [];
  const starved = {
    NAME: 'litres',
    // Mirrors the real provider: `take()` fails before any request.
    getWork: async (input, options) => {
      if (options.budget && typeof options.budget.take === 'function' && !options.budget.take()) {
        return null;
      }
      calls.push(input.eventKey);
      return null;
    },
  };
  const run = await scheduled.resolveOneProfile(data, {
    stats,
    providers: [starved],
    limit: 5,
    now: Date.parse('2026-10-29T12:00:00.000Z'),
    nowIso: '2026-10-29T12:00:00.000Z',
    litresBudget: { limit: 0, used: 0, remaining: 0, take: () => false },
  });
  assert.equal(run.selected, 1);
  assert.equal(run.misses, 0);
  assert.equal(run.deferred, 1);
  assert.equal(calls.length, 0);
  const state = scheduled.loadCandidateState('livelib', 'Budget');
  assert.deepEqual(state.candidates, {});
});

test('empty pool exits without provider calls', async () => {
  const data = profile('Linked', [fileEvent('tk:linked', 'Уже привязана')]);
  await bookCache.saveLink('file:tk:linked', {
    schemaVersion: 1,
    livelibBookId: 'file:tk:linked',
    workId: 'hc:999',
    method: 'isbn',
    score: 1,
    evidence: {},
  });
  const miss = missProvider('googlebooks');
  const run = await scheduled.resolveOneProfile(data, {
    stats: statsFor(['file:tk:linked']),
    providers: [miss],
    limit: 5,
  });
  assert.equal(run.pool, 0);
  assert.equal(run.selected, 0);
  assert.equal(miss.calls.length, 0);
  assert.equal(run.reason, 'pool-empty');
});

test('the resolve lock is shared with an in-process/import pass', async () => {
  const data = profile('Locked', [fileEvent('tk:lock', 'Книга под замком')]);
  await bookCache.saveProfile('livelib', 'Locked', data);
  const stats = statsFor(['file:tk:lock']);
  const held = await resolveLock.acquireLock({ owner: 'test-import' });
  assert.equal(held.ok, true);
  try {
    const miss = missProvider('googlebooks');
    const summary = await scheduled.runScheduledResolve({
      profile: 'livelib-Locked',
      statsFor: () => stats,
      providers: [miss],
      limit: 5,
      lockWaitMs: 0,
    });
    assert.deepEqual(summary.skippedProfiles, ['Locked']);
    assert.equal(miss.calls.length, 0);
    assert.equal(summary.requests, 0);
  } finally {
    resolveLock.releaseLock(held.token);
  }
  // The same lock is released properly: the next pass can run.
  assert.equal(resolveLock.isLocked(), false);
});

test('scheduled pass links a candidate and updates the honest badge counters', async () => {
  const data = profile('Links', [
    fileEvent('tk:linkme', 'Книга с жанром', { genres: ['Фантастика'] }),
  ]);
  await bookCache.saveProfile('livelib', 'Links', data);
  const stats = statsFor(['file:tk:linkme']);
  const hit = {
    NAME: 'googlebooks',
    calls: 0,
    getWork: async (input) => {
      hit.calls++;
      return {
        source: 'googlebooks',
        sourceId: 'gb-1',
        workId: 'gb:gb-1',
        title: input.title,
        authors: input.authors,
        genres: ['Science Fiction'],
        confidence: 1,
        match: { method: 'title' },
      };
    },
  };
  const before = buildBooksStats({ profile: 'livelib-Links' });
  assert.equal(before.summary.metadata.resolved, 0);
  assert.equal(before.summary.metadata.unlinked, 1);
  assert.equal(before.summary.metadata.percent, 0);
  assert.equal(before.summary.metadata.done, false);

  const run = await scheduled.resolveOneProfile(data, {
    stats,
    providers: [hit],
    limit: 5,
    now: Date.parse('2026-10-29T12:00:00.000Z'),
    nowIso: '2026-10-29T12:00:00.000Z',
    litresBudget: { limit: 0, used: 0, remaining: 0, take: () => false },
  });
  assert.equal(run.linked, 1);
  assert.equal(hit.calls, 1);

  const after = buildBooksStats({ profile: 'livelib-Links' });
  assert.equal(after.summary.metadata.resolved, 1);
  assert.equal(after.summary.metadata.linked, 1);
  assert.equal(after.summary.metadata.unlinked, 0);
  assert.equal(after.summary.metadata.percent, 100);
  assert.equal(after.summary.metadata.done, true);

  // The resolve-state records the asked key with the file: prefix.
  const state = bookCache.getResolveState('livelib', 'Links');
  assert.deepEqual(state.askedKeys, ['file:tk:linkme']);
  assert.equal(state.attempted, 1);
  assert.deepEqual(state.unmatchedKeys, []);
});

test('a Литрес verdict survives a supplementary provider outage', async () => {
  const data = profile('LitresVerdict', [fileEvent('tk:ru', 'Неизвестная русская книга')]);
  const stats = statsFor(['file:tk:ru']);
  const calls = [];
  const litresMiss = {
    NAME: 'litres',
    getWork: async (input) => {
      calls.push(`litres:${input.eventKey}`);
      return null;
    },
  };
  const googleError = {
    NAME: 'googlebooks',
    getWork: async () => {
      calls.push('googlebooks');
      const err = new Error('rate limited');
      err.status = 429;
      err.code = 'provider_rate_limited';
      throw err;
    },
  };
  const run = await scheduled.resolveOneProfile(data, {
    stats,
    providers: [litresMiss, googleError],
    limit: 5,
    now: Date.parse('2026-10-29T12:00:00.000Z'),
    nowIso: '2026-10-29T12:00:00.000Z',
    litresBudget: { limit: 5, used: 0, remaining: 5, take: () => true },
  });
  assert.equal(run.linked, 0);
  assert.equal(run.misses, 1);
  assert.equal(run.deferred, 0);
  assert.deepEqual(calls.sort(), ['googlebooks', 'litres:file:tk:ru']);

  const state = scheduled.loadCandidateState('livelib', 'LitresVerdict');
  assert.equal(state.candidates['file:tk:ru'].outcome, 'miss');
  assert.deepEqual(state.candidates['file:tk:ru'].providers, ['litres']);

  // The badge denominator must see this verdict too; otherwise the candidate
  // is not re-asked for 90 days but still pins the percent below 100.
  const resolveState = bookCache.getResolveState('livelib', 'LitresVerdict');
  assert.ok(resolveState.unmatchedKeys.includes('file:tk:ru'));
  assert.equal(resolveState.attempted, 1);
});
