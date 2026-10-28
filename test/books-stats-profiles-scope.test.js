'use strict';

/**
 * Single-profile contract of /api/books/stats (`?profile=`).
 *
 * Model fixed by the user (28.10.2026): a books profile is ONE source + ONE
 * account — `livelib-Margaret` OR `hardcover-34748`. Two readers, and a reader
 * and a service account, never merge into one statistics payload.
 *
 * This suite pins:
 *   - `?profile=` is mandatory and single: missing / repeated / CSV → 400;
 *   - an unknown token → 400 with the list of available keys;
 *   - every widget is computed from that profile's events only;
 *   - `?sources=` is ignored and reported (`sourcesIgnored`), one release of
 *     compatibility;
 *   - `?profiles=` with ONE token is still accepted (deprecated, one release);
 *   - /api/books/profiles exposes the keys + per-profile summaries;
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
function statsFor(profileParam, extra = {}) {
  return buildBooksStats(
    Object.assign({ profileScope: resolveProfileScope(profileParam) }, extra)
  );
}

test('?profile= scopes every widget to exactly one profile document', async () => {
  await seed();

  const alpha = statsFor('livelib-Alpha');
  assert.equal(alpha.sources.filter.mode, 'profile');
  assert.deepEqual(alpha.sources.profiles.selected, ['livelib-Alpha']);
  assert.deepEqual(alpha.sources.selected, ['livelib']);
  assert.equal(alpha.sources.profile.key, 'livelib-Alpha');
  assert.equal(alpha.summary.eventCount, 2);
  assert.equal(alpha.summary.bookCount, 2); // hc:900 (linked) + ll:102

  // booksIndex: only the scoped works, never Beta's or the HC account's.
  assert.deepEqual(Object.keys(alpha.booksIndex).sort(), ['hc:900', 'll:102']);
  assert.equal(alpha.booksIndex['hc:900'].title, 'Alpha Book');
  assert.equal(alpha.booksIndex['hc:900'].rating, 7);
  assert.equal(alpha.booksIndex['hc:901'], undefined);

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

  // Ratings: one active source, identical to `merged`.
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
  assert.equal(alpha.timeline[0].hardcover, 0);
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

  // Hardcover profile: its work still gets shared metadata, but no LiveLib
  // event or rating from the Beta/Alpha accounts leaks in.
  const hc = statsFor('hardcover-34748');
  assert.equal(hc.summary.eventCount, 1);
  assert.equal(hc.summary.bookCount, 1);
  assert.equal(hc.booksIndex['hc:901'].rating, 10); // native 5 * 2
  assert.equal(hc.booksIndex['hc:901'].ratingsBySource.livelib, undefined);
  assert.equal(hc.summary.finishedCount, 1);
  assert.equal(hc.timeline[0].livelib, 0);

  // Profile keys are matched case-insensitively but resolve to the file's key.
  const lower = statsFor('LIVELIB-alpha');
  assert.deepEqual(lower.sources.profiles.selected, ['livelib-Alpha']);
  assert.equal(lower.summary.eventCount, 2);
});

test('any multi-profile scope is rejected instead of unioned', () => {
  const parsed = resolveProfileScope('livelib-Alpha,hardcover-34748');
  assert.equal(parsed.multi, true);
  assert.deepEqual(parsed.selected, []);
  // A repeated parameter is a multi too.
  assert.equal(resolveProfileScope(['livelib-Alpha', 'livelib-Beta']).multi, true);
  // ... but a repeated parameter with only one real token is still one profile.
  const single = resolveProfileScope(['livelib-Alpha', '']);
  assert.equal(single.multi, false);
  assert.deepEqual(single.selected.map((entry) => entry.key), ['livelib-Alpha']);
});

test('?sources= is ignored for books and reported honestly', async () => {
  await seed();
  const stats = statsFor('livelib-Beta', { sources: 'hardcover' });
  assert.equal(stats.sources.filter.mode, 'profile');
  assert.equal(stats.sources.filter.sourcesIgnored, true);
  assert.equal(stats.sources.filter.requestedSources, 'hardcover');
  assert.deepEqual(stats.sources.filter.requestedProfiles, ['livelib-Beta']);
  assert.deepEqual(stats.sources.selected, ['livelib']);
  assert.equal(stats.summary.eventCount, 2);

  // Without `sources=` the flag is false; there is no coarse "all of source"
  // mode any more.
  const plain = statsFor('hardcover-34748');
  assert.equal(plain.sources.filter.sourcesIgnored, false);
  assert.deepEqual(plain.sources.selected, ['hardcover']);
  assert.equal(plain.summary.eventCount, 1);
});

test('profile scope parsing rejects malformed tokens and reports unknown ones', () => {
  const empty = resolveProfileScope('');
  assert.equal(empty.explicit, true);
  assert.equal(empty.empty, true);
  assert.deepEqual(empty.selected, []);
  assert.deepEqual(empty.malformed, []);

  const malformed = resolveProfileScope('Margaret,nonsense,livelib-');
  assert.equal(malformed.multi, true);
  const singleMalformed = resolveProfileScope('Margaret');
  assert.deepEqual(singleMalformed.malformed, ['Margaret']);
  assert.deepEqual(singleMalformed.selected, []);

  const unknown = resolveProfileScope('livelib-Nobody');
  assert.deepEqual(unknown.unknown, ['livelib-Nobody']);
  assert.deepEqual(unknown.selected, []);

  // Dashes inside a LiveLib username are not a separator.
  const dashed = resolveProfileScope('livelib-my-reader');
  assert.deepEqual(dashed.unknown, ['livelib-my-reader']);
  assert.deepEqual(dashed.malformed, []);

  // Absent parameter = no explicit scope (the route turns that into a 400).
  const absent = resolveProfileScope(undefined);
  assert.equal(absent.explicit, false);
  assert.deepEqual(absent.selected, []);
  // Pass an explicit empty profile list to prove no implicit "all" selection.
  const noProfiles = resolveProfileScope('livelib-Alpha', []);
  assert.deepEqual(noProfiles.availableProfileKeys, []);
  assert.deepEqual(noProfiles.unknown, ['livelib-Alpha']);
});

test('profileSummary reports per-profile numbers for /api/books/profiles', async () => {
  await seed();
  const alpha = bookCache.getProfile('livelib', 'Alpha');
  const summary = profileSummary(alpha);
  assert.equal(summary.eventCount, 2);
  assert.equal(summary.bookCount, 2);
  assert.equal(summary.finishedCount, 2);
  assert.equal(summary.undatedEventCount, 0);
  assert.equal(summary.monthOnlyEventCount, 0);
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
    monthOnlyEventCount: 0,
    readCount: 0,
    reReadCount: 0,
    avgRating: null,
    dateFrom: null,
    dateTo: null,
  });
});

test('HTTP routes: profile= validation, sources compat, /profiles and /unmatched', async (t) => {
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

  const ok = await fetch(`${base}/stats?profile=livelib-Alpha`);
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.summary.eventCount, 2);
  assert.deepEqual(okBody.sources.profiles.selected, ['livelib-Alpha']);
  assert.equal(okBody.sources.filter.mode, 'profile');

  // Legacy single-token ?profiles= still answers (deprecated, one release).
  const legacy = await fetch(`${base}/stats?profiles=livelib-Alpha`);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.headers.get('x-books-legacy-profiles'), '1');
  assert.equal((await legacy.json()).summary.eventCount, 2);

  // Missing profile -> 400, never "everything".
  const missing = await fetch(`${base}/stats`);
  assert.equal(missing.status, 400);
  const missingBody = await missing.json();
  assert.equal(missingBody.code, 'profile_required');
  assert.match(missingBody.error, /livelib-Alpha/);

  // Empty, repeated and CSV scopes -> 400 invalid_profile.
  for (const query of [
    'profile=',
    'profile=livelib-Alpha&profile=livelib-Beta',
    'profile=livelib-Alpha,livelib-Beta',
  ]) {
    const response = await fetch(`${base}/stats?${query}`);
    assert.equal(response.status, 400, query);
    const body = await response.json();
    assert.equal(body.code === 'invalid_profile' || body.code === 'profile_required', true, query);
  }

  const malformed = await fetch(`${base}/stats?profile=Margaret`);
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, 'invalid_profile');

  const unknown = await fetch(`${base}/stats?profile=livelib-Nobody`);
  assert.equal(unknown.status, 400);
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.code, 'unknown_profile');
  assert.match(unknownBody.error, /livelib-Alpha/); // available list helps the client

  // A parallel sources= is ignored, not applied.
  const combo = await fetch(`${base}/stats?profile=livelib-Beta&sources=hardcover`);
  assert.equal(combo.status, 200);
  const comboBody = await combo.json();
  assert.equal(comboBody.summary.eventCount, 2);
  assert.deepEqual(comboBody.sources.selected, ['livelib']);
  assert.equal(comboBody.sources.filter.sourcesIgnored, true);

  // sources= without profile= is still a 400: no coarse mode.
  const badSources = await fetch(`${base}/stats?sources=letterboxd`);
  assert.equal(badSources.status, 400);
  assert.equal((await badSources.json()).code, 'profile_required');

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
  assert.equal(alphaEntry.deepScan, null);
  const hcEntry = listBody.profiles.find((entry) => entry.key === 'hardcover-34748');
  assert.equal(hcEntry.sourceKey, 'hardcover/34748');
  assert.equal(hcEntry.summary.avgRating, 10);

  // /unmatched follows the same single-profile contract.
  const scopedUnmatched = await fetch(`${base}/unmatched?profile=livelib-Alpha`);
  assert.equal(scopedUnmatched.status, 200);
  const scopedBody = await scopedUnmatched.json();
  assert.equal(scopedBody.count, 1);
  assert.equal(scopedBody.items[0].bookId, '102');
  assert.deepEqual(scopedBody.sources.profiles.selected, ['livelib-Alpha']);
  assert.equal(scopedBody.profile.key, 'livelib-Alpha');

  const missingUnmatched = await fetch(`${base}/unmatched`);
  assert.equal(missingUnmatched.status, 400);
  assert.equal((await missingUnmatched.json()).code, 'profile_required');

  const betaUnmatched = await (await fetch(`${base}/unmatched?profile=livelib-Beta`)).json();
  assert.equal(betaUnmatched.count, 1); // ll:202 only — Alpha's stub is not here
  assert.equal(betaUnmatched.items[0].bookId, '202');
});
