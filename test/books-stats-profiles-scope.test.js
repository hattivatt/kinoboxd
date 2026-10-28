'use strict';

/**
 * K5 / task 1: `?profiles=` scoping of /api/books/stats.
 *
 * The book tab aggregates every profile document in `cache-book/profiles/`
 * (LiveLib Margaret + Hardcover 34748 + anyone else who was imported). This
 * suite pins:
 *   - profile selection by exact `source-userKey` tokens (case-insensitive,
 *     canonical userKey from the file),
 *   - `?profiles=` priority over `?sources=` and their combination,
 *   - *every* widget respects the scope (not only summary/booksIndex),
 *   - 400 validation: malformed token, unknown profile, empty scope,
 *   - /api/books/profiles exposes the tokens + per-profile summaries,
 *   - /api/books/unmatched is scoped the same way.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-book-scope-'));

const bookCache = require('../server/books/book-cache');
const { buildBooksStats, resolveProfileScope, profileSummary } = require('../server/books/stats');

function profile(source, userKey, events) {
  return {
    schemaVersion: 1,
    source,
    userKey,
    sourceUserId: /^\d+$/.test(userKey) ? Number(userKey) : null,
    importedAt: '2026-10-27T00:00:00.000Z',
    events,
    warnings: [],
  };
}

async function seed() {
  // Details are shared metadata for both sources (as in production).
  await bookCache.saveDetails(900, {
    schemaVersion: 1,
    hcWorkId: 900,
    title: 'Alpha Book',
    authors: [{ hcId: 1, name: 'Ann Alpha' }],
    genres: ['Fantasy'],
    series: [{ hcId: 5, name: 'AlphaSaga', position: 1 }],
    pages: 100,
    publicationYear: 2001,
    publisher: 'AlphaPub',
    partial: false,
  });
  await bookCache.saveDetails(901, {
    schemaVersion: 1,
    hcWorkId: 901,
    title: 'Beta Book',
    authors: [{ hcId: 2, name: 'Bob Beta' }],
    genres: ['Horror'],
    series: [{ hcId: 6, name: 'BetaSaga', position: 1 }],
    pages: 300,
    publicationYear: 1980,
    publisher: 'BetaPub',
    partial: false,
  });
  await bookCache.saveLink('101', {
    schemaVersion: 1,
    livelibBookId: '101',
    workId: 'hc:900',
    method: 'isbn',
    score: 1,
    evidence: {},
  });
  await bookCache.saveLink('201', {
    schemaVersion: 1,
    livelibBookId: '201',
    workId: 'hc:901',
    method: 'isbn',
    score: 1,
    evidence: {},
  });

  await bookCache.saveProfile(
    'livelib',
    'Alpha',
    profile('livelib', 'Alpha', [
      {
        id: 'll:101',
        sourceBookId: '101',
        title: 'Alpha Book',
        authors: ['Ann Alpha'],
        rating: 7,
        ratingScale: 10,
        status: 'read',
        finishedAt: '2024-01-01',
      },
      {
        id: 'll:102',
        sourceBookId: '102',
        title: 'Alpha Two',
        authors: ['Ann Alpha'],
        rating: 8,
        ratingScale: 10,
        status: 'read',
        finishedAt: '2024-01-02',
        edition: { publisher: 'AlphaPub', year: 2010 },
      },
    ])
  );
  await bookCache.saveProfile(
    'livelib',
    'Beta',
    profile('livelib', 'Beta', [
      {
        id: 'll:201',
        sourceBookId: '201',
        title: 'Beta Book',
        authors: ['Bob Beta'],
        rating: 6,
        ratingScale: 10,
        status: 'read',
        finishedAt: '2022-02-02',
      },
      {
        id: 'll:202',
        sourceBookId: '202',
        title: 'Beta Two',
        authors: ['Bob Beta'],
        rating: 4,
        ratingScale: 10,
        status: 'read',
        finishedAt: '2022-02-03',
        edition: { publisher: 'BetaPub', year: 1995 },
      },
    ])
  );
  await bookCache.saveProfile(
    'hardcover',
    '34748',
    profile('hardcover', '34748', [
      {
        id: 'hc:read:1',
        sourceBookId: '901',
        workId: 'hc:901',
        title: 'Beta Book',
        authors: ['Bob Beta'],
        rating: 5,
        ratingScale: 5,
        rating10: 10,
        status: 'read',
        statusId: 3,
        finishedAt: '2023-03-03',
      },
    ])
  );
}

/** Build the payload the way the route does (validated scope object). */
function statsFor(profilesParam, extra = {}) {
  return buildBooksStats(
    Object.assign({ profileScope: resolveProfileScope(profilesParam) }, extra)
  );
}

test('?profiles= scopes every widget to the named profile documents', async () => {
  await seed();

  const all = statsFor(undefined);
  assert.deepEqual(all.sources.connected, ['hardcover', 'livelib']);
  assert.deepEqual(all.sources.profiles.connected, [
    'hardcover-34748',
    'livelib-Alpha',
    'livelib-Beta',
  ]);
  assert.equal(all.sources.filter.mode, 'all');
  assert.equal(all.summary.eventCount, 5);
  assert.equal(all.summary.bookCount, 4); // hc:900, ll:102, hc:901, ll:202

  const alpha = statsFor('livelib-Alpha');
  assert.equal(alpha.sources.filter.mode, 'profiles');
  assert.deepEqual(alpha.sources.profiles.selected, ['livelib-Alpha']);
  assert.deepEqual(alpha.sources.selected, ['livelib']);
  assert.equal(alpha.summary.eventCount, 2);
  assert.equal(alpha.summary.bookCount, 2); // hc:900 (linked) + ll:102

  // booksIndex: only the scoped works, never Beta's.
  assert.deepEqual(Object.keys(alpha.booksIndex).sort(), ['hc:900', 'll:102']);
  assert.equal(alpha.booksIndex['hc:900'].title, 'Alpha Book');
  assert.equal(alpha.booksIndex['hc:900'].rating, 7);

  // Genres / series / publishers / years / pages — all from Alpha only.
  assert.deepEqual(alpha.genres.map((entry) => entry.name), ['Fantasy']);
  assert.deepEqual(alpha.series.map((entry) => entry.name), ['AlphaSaga']);
  assert.deepEqual(alpha.publishers.map((entry) => entry.name), ['AlphaPub']);
  assert.deepEqual(alpha.decades.map((entry) => entry.decade), [2000, 2010]);
  assert.deepEqual(alpha.years.map((entry) => entry.year), [2001, 2010]);
  assert.equal(alpha.summary.pagesTotal, 100);
  assert.equal(alpha.summary.authorsCount, 1);
  assert.deepEqual(alpha.authors.map((entry) => entry.name), ['Ann Alpha']);
  assert.equal(alpha.pagesHistogram.find((bucket) => bucket.bucket === '100-199').count, 1);

  // Ratings: merged and bySource from the scoped events.
  const merged = Object.fromEntries(alpha.ratings.merged.map((entry) => [entry.score, entry.count]));
  assert.deepEqual(merged, { 7: 1, 8: 1 });
  assert.deepEqual(alpha.ratings.bySource.hardcover, []);
  assert.deepEqual(
    alpha.ratings.bySource.livelib.map((entry) => entry.score).sort((a, b) => a - b),
    [7, 8]
  );

  // Calendar / timeline / streaks from the scoped events.
  assert.equal(alpha.timeline.length, 1);
  assert.equal(alpha.timeline[0].month, '2024-01');
  assert.equal(alpha.timeline[0].finished, 2);
  assert.equal(alpha.readDays.length, 2);
  assert.equal(alpha.streaks.current, 2);
  assert.equal(alpha.streaks.lastReadDate, '2024-01-02');
  assert.equal(alpha.summary.dateFrom, '2024-01-01');
  assert.equal(alpha.summary.dateTo, '2024-01-02');
  assert.deepEqual(
    alpha.recentlyFinished.map((entry) => entry.workId),
    ['ll:102', 'hc:900']
  );

  // Per-profile audit block follows the scope too.
  assert.deepEqual(alpha.meta.profiles.map((entry) => entry.key), ['livelib-Alpha']);

  // Hardcover-only scope: its work still gets shared metadata, Beta LiveLib
  // events stay out.
  const hc = statsFor('hardcover-34748');
  assert.equal(hc.summary.eventCount, 1);
  assert.equal(hc.summary.bookCount, 1);
  assert.equal(hc.booksIndex['hc:901'].rating, 10); // native 5 * 2
  assert.equal(hc.booksIndex['hc:901'].ratingsBySource.livelib, undefined);
  assert.equal(hc.summary.finishedCount, 1);

  // Union of two explicit profiles = Alpha + Hardcover.
  const pair = statsFor('livelib-Alpha,hardcover-34748');
  assert.deepEqual(pair.sources.profiles.selected.slice().sort(), [
    'hardcover-34748',
    'livelib-Alpha',
  ]);
  assert.equal(pair.summary.eventCount, 3);
  assert.deepEqual(pair.sources.selected, ['hardcover', 'livelib']);
  assert.equal(pair.summary.bookCount, 3); // hc:900, ll:102, hc:901
  assert.equal(pair.summary.bookCount, new Set(Object.keys(pair.booksIndex)).size);

  // Profile keys are matched case-insensitively but resolve to the file's key.
  const lower = statsFor('LIVELIB-alpha');
  assert.deepEqual(lower.sources.profiles.selected, ['livelib-Alpha']);
  assert.equal(lower.summary.eventCount, 2);
});

test('?profiles= beats ?sources= and is reported honestly', async () => {
  await seed();
  const stats = statsFor('livelib-Beta', { sources: 'hardcover' });
  assert.equal(stats.sources.filter.mode, 'profiles');
  assert.equal(stats.sources.filter.sourcesIgnored, true);
  assert.equal(stats.sources.filter.requestedSources, 'hardcover');
  assert.deepEqual(stats.sources.filter.requestedProfiles, ['livelib-Beta']);
  assert.deepEqual(stats.sources.selected, ['livelib']);
  assert.equal(stats.summary.eventCount, 2);

  // sources= alone keeps its old coarse behaviour (all profiles of a source).
  const hc = statsFor(undefined, { sources: 'hardcover' });
  assert.equal(hc.sources.filter.mode, 'sources');
  assert.equal(hc.sources.filter.sourcesIgnored, false);
  assert.deepEqual(hc.sources.profiles.selected, ['hardcover-34748']);
  assert.equal(hc.summary.eventCount, 1);

  // ... and it is reported as not ignored when no profiles= came in.
  assert.equal(hc.sources.filter.requestedProfiles.length, 0);
});

test('profile scope parsing rejects malformed tokens and reports unknown ones', () => {
  const empty = resolveProfileScope('');
  assert.equal(empty.explicit, true);
  assert.deepEqual(empty.selected, []);
  assert.deepEqual(empty.malformed, []);

  const malformed = resolveProfileScope('Margaret,nonsense,livelib-');
  assert.deepEqual(malformed.malformed.sort(), ['Margaret', 'livelib-', 'nonsense']);
  assert.deepEqual(malformed.selected, []);

  const unknown = resolveProfileScope('livelib-Nobody');
  assert.deepEqual(unknown.unknown, ['livelib-Nobody']);
  assert.deepEqual(unknown.selected, []);

  // Dashes inside a LiveLib username are not a separator.
  const dashed = resolveProfileScope('livelib-my-reader');
  assert.deepEqual(dashed.unknown, ['livelib-my-reader']);
  assert.deepEqual(dashed.malformed, []);

  // Absent parameter = no explicit scope.
  const absent = resolveProfileScope(undefined);
  assert.equal(absent.explicit, false);
  assert.equal(absent.selected.length, 3);
});

test('profileSummary reports per-profile numbers for /api/books/profiles', async () => {
  await seed();
  const alpha = bookCache.getProfile('livelib', 'Alpha');
  const summary = profileSummary(alpha);
  assert.equal(summary.eventCount, 2);
  assert.equal(summary.bookCount, 2);
  assert.equal(summary.finishedCount, 2);
  assert.equal(summary.undatedEventCount, 0);
  assert.equal(summary.readCount, 2);
  assert.equal(summary.avgRating, 7.5);
  assert.equal(summary.dateFrom, '2024-01-01');
  assert.equal(summary.dateTo, '2024-01-02');

  const hc = profileSummary(bookCache.getProfile('hardcover', '34748'));
  assert.equal(hc.eventCount, 1);
  assert.equal(hc.bookCount, 1);
  assert.equal(hc.avgRating, 10);

  assert.deepEqual(profileSummary(null), {
    eventCount: 0,
    bookCount: 0,
    finishedCount: 0,
    undatedEventCount: 0,
    readCount: 0,
    reReadCount: 0,
    avgRating: null,
    dateFrom: null,
    dateTo: null,
  });
});

test('HTTP routes: profiles= validation, combos, /profiles and /unmatched', async (t) => {
  await seed();
  const express = require('express');
  const routes = require('../server/books/routes');
  const app = express();
  app.use(express.json());
  app.use('/api/books', routes);
  app.use((err, req, res, next) => {
    res.status(err.status || err.statusCode || 500).json({ code: err.code, error: err.message });
  });
  const server = app.listen(6311);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:6311/api/books';

  const ok = await fetch(`${base}/stats?profiles=livelib-Alpha`);
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.summary.eventCount, 2);
  assert.deepEqual(okBody.sources.profiles.selected, ['livelib-Alpha']);
  assert.equal(okBody.sources.filter.mode, 'profiles');

  // Repeated parameters are merged.
  const repeated = await fetch(`${base}/stats?profiles=livelib-Alpha&profiles=livelib-Beta`);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).summary.eventCount, 4);

  // Empty scope -> 400, not "everything".
  const empty = await fetch(`${base}/stats?profiles=`);
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).code, 'invalid_profiles');

  const malformed = await fetch(`${base}/stats?profiles=Margaret`);
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, 'invalid_profiles');

  const unknown = await fetch(`${base}/stats?profiles=livelib-Nobody`);
  assert.equal(unknown.status, 400);
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.code, 'unknown_profile');
  assert.match(unknownBody.error, /livelib-Alpha/); // available list helps the client

  // profiles= wins over a parallel sources=.
  const combo = await fetch(`${base}/stats?profiles=livelib-Beta&sources=hardcover`);
  assert.equal(combo.status, 200);
  const comboBody = await combo.json();
  assert.equal(comboBody.summary.eventCount, 2);
  assert.deepEqual(comboBody.sources.selected, ['livelib']);
  assert.equal(comboBody.sources.filter.sourcesIgnored, true);

  // Invalid sources still rejected on the coarse axis.
  const badSources = await fetch(`${base}/stats?sources=letterboxd`);
  assert.equal(badSources.status, 400);
  assert.equal((await badSources.json()).code, 'invalid_sources');

  const list = await fetch(`${base}/profiles`);
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.deepEqual(listBody.availableProfileKeys, [
    'hardcover-34748',
    'livelib-Alpha',
    'livelib-Beta',
  ]);
  const alphaEntry = listBody.profiles.find((entry) => entry.key === 'livelib-Alpha');
  assert.equal(alphaEntry.sourceKey, 'livelib/Alpha');
  assert.equal(alphaEntry.summary.eventCount, 2);
  assert.equal(alphaEntry.summary.bookCount, 2);
  assert.deepEqual(alphaEntry.cookies, { present: false, savedAt: null, count: 0 });
  const hcEntry = listBody.profiles.find((entry) => entry.key === 'hardcover-34748');
  assert.equal(hcEntry.sourceKey, 'hardcover/34748');
  assert.equal(hcEntry.summary.avgRating, 10);

  // /unmatched follows the same scope.
  const scopedUnmatched = await fetch(`${base}/unmatched?profiles=livelib-Alpha`);
  assert.equal(scopedUnmatched.status, 200);
  const scopedBody = await scopedUnmatched.json();
  assert.equal(scopedBody.count, 1);
  assert.equal(scopedBody.items[0].bookId, '102');
  assert.deepEqual(scopedBody.sources.profiles.selected, ['livelib-Alpha']);

  const unionUnmatched = await (await fetch(`${base}/unmatched`)).json();
  assert.equal(unionUnmatched.count, 2); // ll:102 + ll:202
});
