'use strict';

/**
 * Books: HTTP routes, LiveLib scraping plan B and profile scoping suite: the former standalone `*.test.js` files of this domain,
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

const run = env.makeTmpCache('books-routes-suite', { budgets: false });

after(() => {
  env.cleanupTmpDirs();
});

process.on('exit', () => {
  env.cleanupTmpDirs();
});


describe('books-stats-profiles-scope', () => {
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
   *   - extra query parameters (retired `?sources=`, `?profiles=`) are a 400
   *     `unexpected_parameter`;
   *   - /api/books/profiles exposes the keys + per-profile summaries;
   *   - /api/books/unmatched is scoped the same way.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const { buildBooksStats, resolveProfileScope, profileSummary } = require('../server/books/stats');
  const { portFor } = require('./helpers/port');

  const PORT = portFor(80);

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
      firstPublishedYear: 2001,
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
      firstPublishedYear: 1980,
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
    assert.equal('filter' in alpha.sources, false);
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

    // Genres / series / years / pages — all from Alpha only.
    assert.deepEqual(alpha.genres.map((entry) => entry.name), ['Fantasy']);
    assert.deepEqual(alpha.series.map((entry) => entry.name), ['AlphaSaga']);
    // The chart year is the *work's first publication*: hc:900 knows 2001, while
    // ll:102 has only a 2010 print run and no first-publication claim. Since the
    // 29.10.2026 verdict the print-run year is an honest fallback marked
    // `yearSource: 'edition'` (never a first edition), so it is a 2010 bucket.
    assert.deepEqual(alpha.decades.map((entry) => entry.decade), [2000, 2010]);
    assert.deepEqual(alpha.decades.map((entry) => entry.count), [1, 1]);
    assert.equal(alpha.decades[1].unknown, undefined);
    assert.equal(alpha.decades[1].editionCount, 1);
    assert.equal(alpha.summary.yearUnknownCount, 0);
    assert.deepEqual(alpha.years.map((entry) => entry.year), [2001, 2010]);
    assert.equal(alpha.booksIndex['ll:102'].editionYear, 2010);
    assert.equal(alpha.booksIndex['ll:102'].yearSource, 'edition');
    assert.equal(alpha.summary.pagesTotal, 100);
    assert.equal(alpha.summary.authorsCount, 1);
    assert.deepEqual(alpha.authors.map((entry) => entry.name), ['Ann Alpha']);
    assert.equal(alpha.pagesHistogram.find((bucket) => bucket.bucket === '100-199').count, 1);

    // Ratings: one active source, identical to `merged`.
    const merged = Object.fromEntries(alpha.ratings.merged.map((entry) => [entry.score, entry.count]));
    assert.deepEqual(merged, { 7: 1, 8: 1 });
    assert.equal('bySource' in alpha.ratings, false);

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
    assert.equal('ratingsBySource' in hc.booksIndex['hc:901'], false);
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

  test('the payload has no source-filter block any more', async () => {
    await seed();
    const stats = statsFor('livelib-Beta');
    assert.equal('filter' in stats.sources, false);
    assert.deepEqual(stats.sources.selected, ['livelib']);
    assert.equal(stats.summary.eventCount, 2);

    const plain = statsFor('hardcover-34748');
    assert.deepEqual(plain.sources.selected, ['hardcover']);
    assert.equal(plain.summary.eventCount, 1);
    assert.equal(plain.summary.metadata.percent, 100);
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

  test('HTTP routes: strict profile= validation, /profiles and /unmatched', async (t) => {
    await seed();
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

    const ok = await fetch(`${base}/stats?profile=livelib-Alpha`);
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.summary.eventCount, 2);
    assert.deepEqual(okBody.sources.profiles.selected, ['livelib-Alpha']);
    assert.equal('filter' in okBody.sources, false);
    assert.equal('bySource' in okBody.ratings, false);
    assert.equal(okBody.summary.metadata.percent, 50);

    // Retired ?profiles= alias is an unexpected parameter now (strict contract).
    const legacy = await fetch(`${base}/stats?profiles=livelib-Alpha`);
    assert.equal(legacy.status, 400);
    assert.equal((await legacy.json()).code, 'unexpected_parameter');

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

    // A stale client sending ?sources= gets a 400, not a silently ignored filter.
    const combo = await fetch(`${base}/stats?profile=livelib-Beta&sources=hardcover`);
    assert.equal(combo.status, 400);
    const comboBody = await combo.json();
    assert.equal(comboBody.code, 'unexpected_parameter');
    assert.match(comboBody.error, /"sources"/);

    const badSources = await fetch(`${base}/stats?sources=letterboxd`);
    assert.equal(badSources.status, 400);
    assert.equal((await badSources.json()).code, 'unexpected_parameter');

    // /unmatched accepts exactly profile too.
    const unmatchedExtra = await fetch(`${base}/unmatched?profile=livelib-Alpha&sources=livelib`);
    assert.equal(unmatchedExtra.status, 400);
    assert.equal((await unmatchedExtra.json()).code, 'unexpected_parameter');

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
  after(() => env.resetMutableState());
});


describe('books-livelib-cookies', () => {
  /**
   * K5 / task 2: LiveLib cookie store (plan B persistence).
   *
   * Pinned here:
   *   - only `(source, userKey)` = livelib profile files are addressable,
   *   - the file is written 0600 inside a 0700 directory,
   *   - a header is normalised (`Cookie:` prefix, pairs object, whitespace) and
   *     validated (control chars / junk rejected, no value echoed in the error),
   *   - memory is invalidated by file fingerprint (external rotation is visible),
   *   - the API-facing status is masked: `{ present, savedAt, count }` only,
   *   - the HTTP route accepts `cookieHeader`, persists it and reports only the
   *     masked `cookies` block,
   *   - a supplied header turns off the LiveLib reuse window (the user is
   *     explicitly retrying) and never reaches logs/job status.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const BOOK_CACHE_DIR = run.cacheBookDir;
  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const cookies = require('../server/books/livelib-cookies');
  const livelib = require('../server/books/livelib');
  const importJobs = require('../server/books/import');
  const { portFor } = require('./helpers/port');

  const PORT_PASTE = portFor(10);
  const PORT_DELETE = portFor(11);
  const HEADER = 'Cookie: __ddg1_=abc123; __ddg2_=def456';

  /*
   * No network in this suite: starting a real LiveLib job would scrape the live
   * site (AGENTS.md forbids using live sources to "check the parser"). The fake
   * importer captures the jar it was given and fails as a blocked source — which
   * is also the state we want the cookie store to survive.
   */
  const realImportLivelib = livelib.importLivelib;
  let lastImport = null;
  livelib.importLivelib = async (username, options = {}) => {
    lastImport = {
      username,
      cookieHeader: livelib.cookieHeaderOf(options.jar),
      seeded: options.jar ? options.jar.size : 0,
    };
    throw new livelib.LivelibError(
      'LiveLib ограничил доступ (HTTP 403) — DDoS-Guard/анти-бот; импорт остановлен.',
      'livelib_blocked'
    );
  };
  test.after(() => {
    livelib.importLivelib = realImportLivelib;
  });

  test('normaliseCookieHeader accepts the shapes a browser paste produces', () => {
    assert.equal(cookies.normalizeCookieHeader(HEADER), '__ddg1_=abc123; __ddg2_=def456');
    assert.equal(
      cookies.normalizeCookieHeader('  __ddg1_=abc123 ;__ddg2_=def456  '),
      '__ddg1_=abc123; __ddg2_=def456'
    );
    assert.equal(
      cookies.normalizeCookieHeader({ __ddg1_: 'abc123', __ddg2_: 'def456' }),
      '__ddg1_=abc123; __ddg2_=def456'
    );
    assert.equal(cookies.countCookies(HEADER), 2);
    assert.deepEqual(
      [...cookies.parseCookieHeader(HEADER).entries()],
      [
        ['__ddg1_', 'abc123'],
        ['__ddg2_', 'def456'],
      ]
    );
  });

  test('normaliseCookieHeader rejects junk without echoing the value', () => {
    const cases = [
      ['', /пустой/],
      ['   ', /пустой/],
      ['__ddg1_=abc123\nEvil: injected', /управляющие/],
      ['not-a-pair', /name=value/],
      ['=novalue', /name=value/],
      ['bad name=x', /имя cookie/],
    ];
    for (const [input, pattern] of cases) {
      assert.throws(
        () => cookies.normalizeCookieHeader(input),
        (err) => {
          assert.equal(err.code, 'invalid_cookie_header');
          assert.match(err.message, pattern);
          // Never echo the payload (the whole point of the validation).
          assert.equal(err.message.includes('abc123'), false);
          assert.equal(err.message.includes('Evil'), false);
          return true;
        },
        `input ${JSON.stringify(input)}`
      );
    }

    const long = `a=${'x'.repeat(cookies.MAX_HEADER_LENGTH)}`;
    assert.throws(() => cookies.normalizeCookieHeader(long), /длиннее/);
  });

  test('saveCookies writes 0600 into a 0700 dir and reports masked status', async () => {
    const saved = await cookies.saveCookies('livelib', 'Margaret', HEADER, {
      now: '2026-10-28T10:00:00.000Z',
    });
    assert.equal(saved.present, true);
    assert.equal(saved.count, 2);
    assert.equal(saved.savedAt, '2026-10-28T10:00:00.000Z');

    const filePath = cookies.cookiePath('livelib', 'Margaret');
    assert.equal(filePath, path.join(BOOK_CACHE_DIR, 'cookies', 'livelib-Margaret.json'));
    const stat = fs.statSync(filePath);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);

    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(stored.schemaVersion, 1);
    assert.equal(stored.source, 'livelib');
    assert.equal(stored.userKey, 'Margaret');
    assert.equal(stored.cookieHeader, '__ddg1_=abc123; __ddg2_=def456');

    // API-facing status is masked: presence + count, no header, no names.
    const status = cookies.cookieStatus('livelib', 'Margaret');
    assert.deepEqual(status, { present: true, savedAt: '2026-10-28T10:00:00.000Z', count: 2 });
    assert.equal(JSON.stringify(status).includes('__ddg'), false);
    assert.equal(JSON.stringify(status).includes('abc123'), false);

    const got = cookies.getCookies('livelib', 'Margaret');
    assert.equal(got.cookieHeader, '__ddg1_=abc123; __ddg2_=def456');
  });

  test('the store is scoped per profile and never crosses users', async () => {
    await cookies.saveCookies('livelib', 'Alpha', '__ddg1_=alpha');
    assert.equal(cookies.cookieStatus('livelib', 'Alpha').present, true);
    assert.equal(cookies.cookieStatus('livelib', 'Margaret').present, true);
    assert.equal(cookies.cookieStatus('livelib', 'Nobody').present, false);
    assert.deepEqual(cookies.cookieStatus('livelib', 'Nobody'), {
      present: false,
      savedAt: null,
      count: 0,
    });
    // Another source is not supported (only LiveLib is crawled).
    await assert.rejects(
      () => cookies.saveCookies('hardcover', '34748', '__ddg1_=x'),
      (err) => err.code === 'unsupported_cookie_source'
    );
  });

  test('memory is fingerprint-invalidated: an external rotation is visible', async () => {
    const userKey = 'Rotating';
    const saved = await cookies.saveCookies('livelib', userKey, '__ddg1_=first');
    assert.equal(cookies.getCookies('livelib', userKey).cookieHeader, '__ddg1_=first');

    // Another process (or the user) rewrites the file with a fresh header.
    const filePath = saved.path;
    const rotated = {
      schemaVersion: 1,
      source: 'livelib',
      userKey,
      cookieHeader: '__ddg1_=second',
      savedAt: '2026-10-29T00:00:00.000Z',
    };
    fs.writeFileSync(filePath, JSON.stringify(rotated), 'utf8');
    fs.chmodSync(filePath, 0o600);

    const after = cookies.getCookies('livelib', userKey);
    assert.equal(after.cookieHeader, '__ddg1_=second');
    assert.equal(after.savedAt, '2026-10-29T00:00:00.000Z');

    // clearCookies is idempotent and drops the memory entry too.
    assert.equal(await cookies.clearCookies('livelib', userKey), true);
    assert.equal(await cookies.clearCookies('livelib', userKey), false);
    assert.equal(cookies.getCookies('livelib', userKey), null);
  });

  test('startLivelibImport: a cookie paste forces a fresh job and is stored masked', async () => {
    // A fresh cached profile would normally be reused; the paste must override.
    await bookCache.saveProfile('livelib', 'Pasted', {
      schemaVersion: 1,
      source: 'livelib',
      userKey: 'Pasted',
      importedAt: new Date().toISOString(),
      events: [
        { id: 'll:1', sourceBookId: '1', title: 'One', status: 'read', finishedAt: '2024-01-01' },
      ],
      warnings: [],
    });

    const job = importJobs.startLivelibImport('Pasted', {
      cookieHeader: 'Cookie: __ddg1_=pasted',
    });
    assert.equal(job.reused, false);
    assert.equal(job.force, true);
    assert.deepEqual(job.cookies, {
      provided: true,
      stored: false,
      present: true,
      savedAt: null,
    });
    // No header anywhere in the public job status.
    assert.equal(JSON.stringify(job).includes('__ddg'), false);
    assert.equal(JSON.stringify(job).includes('pasted'), false);

    await importJobs.idle();

    const status = importJobs.getStatus(job.id);
    assert.equal(status.cookies.provided, true);
    assert.equal(status.cookies.stored, true);
    assert.equal(status.cookies.count, 1);
    assert.ok(status.cookies.savedAt);
    assert.equal(JSON.stringify(status.cookies).includes('__ddg'), false);
    // The stored header reached the importer's jar …
    assert.equal(lastImport.username, 'Pasted');
    assert.equal(lastImport.cookieHeader, '__ddg1_=pasted');
    // … and was kept for the retry: a valid paste survives a failed import.
    assert.equal(status.stage, 'failed');
    assert.equal(status.code, 'livelib_blocked');
    assert.deepEqual(status.blocked, {
      code: 'livelib_blocked',
      planB: 'cookieHeader',
      cookiesPresent: true,
    });
    assert.equal(cookies.cookieStatus('livelib', 'Pasted').present, true);
    assert.equal(
      cookies.getCookies('livelib', 'Pasted').cookieHeader,
      '__ddg1_=pasted'
    );
  });

  /**
   * DELETE /api/books/import/livelib/cookies — the other half of plan B.
   *
   * The stored header is a secret the user lent us for one retry, so it must be
   * removable through the API (no shell into the cache dir). Pinned here:
   *   - 200 + masked `{present:false}` after a delete, file really gone,
   *     `/profiles` reports `cookies.present === false`;
   *   - a second delete is a 404 `cookies_not_found` (not a silent 200);
   *   - a missing/odd `userKey` is a 400 and touches nothing;
   *   - a delete during a running import of that profile is 409 rather than a
   *     claim the job would contradict;
   *   - the response never echoes the header value or cookie names.
   */
  test('DELETE cookies: removes the file, 404 when absent, 400 on junk, 409 while importing', async (t) => {
    const express = require('express');
    const routes = require('../server/books/routes');
    const app = express();
    app.use(express.json());
    app.use('/api/books', routes);
    app.use((err, req, res, next) => {
      res.status(err.status || err.statusCode || 500).json({ code: err.code, error: err.message });
    });
    const server = app.listen(PORT_DELETE);
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${PORT_DELETE}/api/books`;

    await cookies.saveCookies('livelib', 'Deletable', '__ddg1_=secret1; __ddg2_=secret2', {
      now: '2026-10-28T11:00:00.000Z',
    });
    // The profile document is what /profiles lists; cookies are a side store.
    await bookCache.saveProfile('livelib', 'Deletable', {
      schemaVersion: 1,
      source: 'livelib',
      userKey: 'Deletable',
      importedAt: new Date().toISOString(),
      events: [{ id: 'll:1', sourceBookId: '1', title: 'One', status: 'read', finishedAt: '2024-01-01' }],
      warnings: [],
    });
    const filePath = cookies.cookiePath('livelib', 'Deletable');
    assert.equal(fs.existsSync(filePath), true);

    const removed = await fetch(`${base}/import/livelib/cookies?userKey=Deletable`, {
      method: 'DELETE',
    });
    assert.equal(removed.status, 200);
    const removedBody = await removed.json();
    assert.equal(removedBody.removed, true);
    assert.equal(removedBody.source, 'livelib');
    assert.equal(removedBody.userKey, 'Deletable');
    assert.deepEqual(removedBody.cookies, { present: false, savedAt: null, count: 0 });
    assert.equal(JSON.stringify(removedBody).includes('secret1'), false);
    assert.equal(JSON.stringify(removedBody).includes('__ddg'), false);
    assert.equal(fs.existsSync(filePath), false);
    // In-memory entry is gone too (no stale re-read).
    assert.equal(cookies.getCookies('livelib', 'Deletable'), null);

    // The profile survives, its cookie flag does not.
    const profiles = await (await fetch(`${base}/profiles`)).json();
    const entry = profiles.profiles.find((profile) => profile.key === 'livelib-Deletable');
    assert.ok(entry, 'profile document must not be deleted together with its cookies');
    assert.deepEqual(entry.cookies, { present: false, savedAt: null, count: 0 });

    // Second delete: explicitly 404, so the UI can tell "already gone".
    const again = await fetch(`${base}/import/livelib/cookies?userKey=Deletable`, {
      method: 'DELETE',
    });
    assert.equal(again.status, 404);
    assert.equal((await again.json()).code, 'cookies_not_found');

    // Missing / malformed userKey: 400, and the store of another profile is intact.
    await cookies.saveCookies('livelib', 'Untouched', '__ddg1_=keepme');
    const missing = await fetch(`${base}/import/livelib/cookies`, { method: 'DELETE' });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).code, 'user_key_required');
    for (const junk of ['../../etc/passwd', 'a b', 'x'.repeat(121)]) {
      const bad = await fetch(
        `${base}/import/livelib/cookies?userKey=${encodeURIComponent(junk)}`,
        { method: 'DELETE' }
      );
      assert.equal(bad.status, 400, `userKey ${JSON.stringify(junk)}`);
      assert.equal((await bad.json()).code, 'invalid_user_key');
    }
    assert.equal(cookies.cookieStatus('livelib', 'Untouched').present, true);

    // A delete while this profile's import is in flight is a 409.
    await cookies.saveCookies('livelib', 'Deleting', '__ddg1_=busy');
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    livelib.importLivelib = async () => {
      await gate;
      throw new livelib.LivelibError('LiveLib ограничил доступ (HTTP 403).', 'livelib_blocked');
    };
    const job = importJobs.startLivelibImport('Deleting', { force: true });
    assert.equal(job.done, false);
    const conflict = await fetch(`${base}/import/livelib/cookies?userKey=Deleting`, {
      method: 'DELETE',
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, 'livelib_import_running');
    assert.equal(cookies.cookieStatus('livelib', 'Deleting').present, true);

    release();
    await importJobs.idle();
    assert.equal(importJobs.getStatus(job.id).stage, 'failed');
    // …and after the job finished the delete goes through.
    const after = await fetch(`${base}/import/livelib/cookies?userKey=Deleting`, { method: 'DELETE' });
    assert.equal(after.status, 200);
    assert.equal(cookies.cookieStatus('livelib', 'Deleting').present, false);
  });

  test('startLivelibImport rejects a malformed paste synchronously', () => {
    assert.throws(
      () => importJobs.startLivelibImport('Broken', { cookieHeader: 'no-equals-sign' }),
      (err) => err.code === 'invalid_cookie_header'
    );
    assert.equal(cookies.cookieStatus('livelib', 'Broken').present, false);
  });

  test('a paste during a running import is a 409, not a silent drop', async () => {
    // Hold one import open, then try to paste cookies for the same profile.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    livelib.importLivelib = async () => {
      await gate;
      throw new livelib.LivelibError('LiveLib ограничил доступ (HTTP 403).', 'livelib_blocked');
    };

    const job = importJobs.startLivelibImport('Busy', { force: true });
    assert.equal(job.done, false);
    assert.throws(
      () => importJobs.startLivelibImport('Busy', { cookieHeader: '__ddg1_=late' }),
      (err) => {
        assert.equal(err.code, 'livelib_import_running');
        return true;
      }
    );
    // The late paste was not written: it was never applied.
    assert.equal(cookies.cookieStatus('livelib', 'Busy').present, false);

    release();
    await importJobs.idle();
    assert.equal(importJobs.getStatus(job.id).stage, 'failed');
  });

  test('HTTP route accepts cookieHeader, stores it 0600 and masks the response', async (t) => {
    const express = require('express');
    const routes = require('../server/books/routes');
    const app = express();
    app.use(express.json());
    app.use('/api/books', routes);
    app.use((err, req, res, next) => {
      res.status(err.status || err.statusCode || 500).json({ code: err.code, error: err.message });
    });
    const server = app.listen(PORT_PASTE);
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${PORT_PASTE}/api/books`;

    const accepted = await fetch(`${base}/import/livelib`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'RoutePaste', cookieHeader: HEADER }),
    });
    assert.equal(accepted.status, 202);
    const acceptedBody = await accepted.json();
    assert.equal(acceptedBody.cookies.provided, true);
    assert.equal(JSON.stringify(acceptedBody).includes('abc123'), false);

    await importJobs.idle();
    const filePath = cookies.cookiePath('livelib', 'RoutePaste');
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.equal(
      JSON.parse(fs.readFileSync(filePath, 'utf8')).cookieHeader,
      '__ddg1_=abc123; __ddg2_=def456'
    );

    // /profiles exposes only the mask (the paste job failed, so seed a profile
    // document the way a successful import would).
    await bookCache.saveProfile('livelib', 'RoutePaste', {
      schemaVersion: 1,
      source: 'livelib',
      userKey: 'RoutePaste',
      importedAt: new Date().toISOString(),
      events: [
        { id: 'll:1', sourceBookId: '1', title: 'One', status: 'read', finishedAt: '2024-01-01' },
      ],
      warnings: [],
    });
    const profiles = await (await fetch(`${base}/profiles`)).json();
    const entry = profiles.profiles.find((profile) => profile.key === 'livelib-RoutePaste');
    assert.equal(entry.cookies.present, true);
    assert.equal(entry.cookies.count, 2);
    assert.equal(entry.cookies.savedAt.length > 0, true);
    assert.equal(JSON.stringify(entry).includes('abc123'), false);

    // Junk is a 400 with a code, nothing written.
    const rejected = await fetch(`${base}/import/livelib`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'RouteJunk', cookieHeader: 'not-a-cookie\nx: y' }),
    });
    assert.equal(rejected.status, 400);
    const rejectedBody = await rejected.json();
    assert.equal(rejectedBody.code, 'invalid_cookie_header');
    assert.equal(cookies.cookieStatus('livelib', 'RouteJunk').present, false);
  });
  after(() => env.resetMutableState());
});


describe('books-livelib-file-import', () => {
  /**
   * POST /api/books/import/livelib-file — the "safe path" HTTP contract, and the
   * shelf filter it feeds into the stats payload.
   *
   * Pinned here:
   *   - a `livelib-backup` export is merged into `profiles/livelib-{userKey}.json`
   *     with `origin: 'livelib-file'`, `shelves` and `fileImports`;
   *   - the response is a single 201 (counts, shelves, warnings) — no job to poll,
   *     because nothing is scraped and nothing leaves the server;
   *   - a repeated upload is idempotent; a second shelf is additive;
   *   - 400s are explicit (`file_required`, `username_required`,
   *     `invalid_user_key`, `invalid_shelf`, `shelf_required`, parser errors) and
   *     a running scrape of the same profile is a 409;
   *   - stats keep `read`/`dnf` in the history and exclude `reading`/`wish`
   *     (`summary.shelfExcluded`, `meta.statusFilter.byShelf`);
   *   - the bibliographic columns of the file become metadata: genres, series,
   *     ISBN and language render with `metadataSources: ['livelib-file']` and
   *     `unresolved: false` — no network request involved.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const BOOK_CACHE_DIR = run.cacheBookDir;
  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const importJobs = require('../server/books/import');
  const livelib = require('../server/books/livelib');
  const { buildBooksStats } = require('../server/books/stats');

  const { portFor } = require('./helpers/port');
  const PORT = portFor(20);
  const FIXTURES = path.join(__dirname, 'fixtures');
  const jsonFixture = fs.readFileSync(path.join(FIXTURES, 'livelib-file-export.json'));
  const csvFixture = fs.readFileSync(path.join(FIXTURES, 'livelib-file-export.csv'));

  function form({ file = jsonFixture, filename = 'livelib-routeprobe-read-28.10.2026.json', ...fields } = {}) {
    const body = new FormData();
    // These tests pin the pure parse path: opt out of the (now default) network
    // resolve job unless a test asks for it explicitly.
    if (fields.resolve === undefined) fields.resolve = "0";
    for (const [key, value] of Object.entries(fields)) {
      if (value != null) body.append(key, String(value));
    }
    if (file) {
      const type = filename.endsWith('.csv') ? 'text/csv' : 'application/json';
      body.append('file', new Blob([file], { type }), filename);
    }
    return body;
  }

  /**
   * The route module and the stats payload share one cache directory, so a single
   * server process serves the whole file (one port, started once). The
   * `importLivelib` stub in the 409 case is the only place a scrape is touched —
   * and it never reaches the network.
   */
  let server = null;
  let base = '';

  test.before(async () => {
    const express = require('express');
    const routes = require('../server/books/routes');
    const app = express();
    app.use(express.json());
    app.use('/api/books', routes);
    app.use((err, req, res, next) => {
      res.status(err.status || err.statusCode || 500).json({ code: err.code, error: err.message });
    });
    server = app.listen(PORT);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${PORT}/api/books`;
  });

  test.after(() => new Promise((resolve) => server.close(resolve)));

  test('livelib-file import: multipart upload, shelves, idempotency, stats', async () => {
    /* ---------------- first upload: «Прочитал», JSON ---------------- */
    const first = await fetch(`${base}/import/livelib-file`, {
      method: 'POST',
      body: form({ username: 'RouteProbe' }),
    });
    assert.equal(first.status, 201);
    const body = await first.json();
    assert.equal(body.ok, true);
    assert.equal(body.source, 'livelib');
    assert.equal(body.userKey, 'RouteProbe');
    assert.equal(body.profileKey, 'livelib-RouteProbe');
    assert.equal(body.origin, 'livelib-file');
    // The shelf is sniffed from `livelib-{user}-{pagename}-{date}.json`.
    assert.equal(body.shelf, 'read');
    assert.equal(body.format, 'json');
    assert.equal(body.imported, 3);
    assert.deepEqual(
      { added: body.added, enriched: body.enriched, skipped: body.skipped },
      { added: 3, enriched: 0, skipped: 0 }
    );
    assert.equal(body.events, 3);
    assert.deepEqual(body.shelves, { read: 3, dnf: 0, reading: 0, wish: 0 });
    assert.equal(body.stats.withIsbn, 1);
    assert.equal(body.warnings.length, 2);
    // No metadata job was requested, and no network call happened.
    assert.equal(body.resolve, null);

    // The document on disk is the profile the dashboard reads.
    const stored = bookCache.getProfile('livelib', 'RouteProbe');
    assert.equal(stored.origin, 'livelib-file');
    assert.equal(stored.source, 'livelib');
    assert.equal(stored.events.length, 3);
    assert.deepEqual(stored.shelves, { read: 3, dnf: 0, reading: 0, wish: 0 });
    assert.equal(stored.fileImports.length, 1);
    assert.equal(stored.fileImports[0].format, 'json');
    assert.equal(stored.fileImports[0].filename, 'livelib-routeprobe-read-28.10.2026.json');
    const raw = fs.readdirSync(path.join(BOOK_CACHE_DIR, 'imports'));
    assert.equal(raw.some((name) => name.startsWith('livelib-RouteProbe-')), true);

    // /profiles exposes the acquisition path and the shelf tallies.
    const profiles = await (await fetch(`${base}/profiles`)).json();
    const entry = profiles.profiles.find((profile) => profile.key === 'livelib-RouteProbe');
    assert.ok(entry);
    assert.equal(entry.origin, 'livelib-file');
    assert.deepEqual(entry.shelves, { read: 3, dnf: 0, reading: 0, wish: 0 });
    assert.equal(entry.fileImports, 1);

    /* ---------------- second upload of the same file: idempotent ---------------- */
    const again = await fetch(`${base}/import/livelib-file`, {
      method: 'POST',
      body: form({ username: '@RouteProbe' }),
    });
    assert.equal(again.status, 201);
    const againBody = await again.json();
    assert.deepEqual(
      { added: againBody.added, enriched: againBody.enriched, skipped: againBody.skipped },
      { added: 0, enriched: 0, skipped: 3 }
    );
    assert.equal(againBody.events, 3);
    assert.equal(bookCache.getProfile('livelib', 'RouteProbe').fileImports.length, 2);

    /* ---------------- CSV + explicit shelf: «Хочу прочитать» ---------------- */
    const wish = await fetch(`${base}/import/livelib-file`, {
      method: 'POST',
      body: form({ file: csvFixture, filename: 'export.csv', username: 'RouteProbe', shelf: 'Хочу прочитать' }),
    });
    assert.equal(wish.status, 201);
    const wishBody = await wish.json();
    assert.equal(wishBody.shelf, 'wish');
    assert.equal(wishBody.format, 'csv');
    assert.equal(wishBody.added, 3);
    assert.deepEqual(wishBody.shelves, { read: 3, dnf: 0, reading: 0, wish: 3 });
    // The CSV keeps the same books (same links), so the read shelf is untouched.
    assert.equal(bookCache.getProfile('livelib', 'RouteProbe').events.length, 6);

    /* ---------------- stats: plans never join the reading history ---------------- */
    const stats = buildBooksStats({ profile: 'livelib-RouteProbe' });
    assert.equal(stats.summary.eventCount, 3);
    assert.equal(stats.summary.bookCount, 3);
    assert.equal(stats.summary.shelfExcluded, 3);
    assert.deepEqual(stats.summary.shelves, { read: 3, dnf: 0, reading: 0, wish: 3 });
    assert.equal(stats.summary.hardcoverStatusExcluded, 0);
    assert.deepEqual(stats.meta.statusFilter.byShelf, { wish: 3 });
    assert.deepEqual(stats.meta.statusFilter.keepShelves, ['read', 'dnf']);
    assert.equal(stats.meta.profiles[0].origin, 'livelib-file');
    assert.equal(stats.meta.profiles[0].shelfExcluded, 3);
    assert.equal(stats.sources.profile.origin, 'livelib-file');

    // File columns are metadata: genres/series/ISBN render without the chain.
    const annihilation = Object.values(stats.booksIndex).find((work) => work.title === 'Аннигиляция');
    assert.ok(annihilation);
    assert.deepEqual(annihilation.genres, ['фэнтези', 'ужасы']);
    assert.deepEqual(annihilation.series, ['Южный предел']);
    assert.equal(annihilation.isbn13, '9785699989676');
    assert.deepEqual(annihilation.metadataSources, ['livelib-file']);
    assert.equal(annihilation.unresolved, false);
    // No plan shelf leaked into the work list.
    assert.equal(Object.keys(stats.booksIndex).length, 3);
  });

  test('livelib-file import: explicit 400/409 instead of a silent ignore', async (t) => {
    const noFile = await fetch(`${base}/import/livelib-file`, {
      method: 'POST',
      body: form({ username: 'RouteProbe', file: null }),
    });
    assert.equal(noFile.status, 400);
    assert.equal((await noFile.json()).code, 'file_required');

    const noUser = await fetch(`${base}/import/livelib-file`, {
      method: 'POST',
      body: form({ filename: 'livelib-nobody-read.json' }),
    });
    assert.equal(noUser.status, 400);
    assert.equal((await noUser.json()).code, 'username_required');

    for (const junk of ['../../etc/passwd', 'a b', 'x'.repeat(65)]) {
      const response = await fetch(`${base}/import/livelib-file`, {
        method: 'POST',
        body: form({ username: junk }),
      });
      assert.equal(response.status, 400, `username ${JSON.stringify(junk)}`);
      assert.equal((await response.json()).code, 'invalid_user_key');
    }

    const badShelf = await fetch(`${base}/import/livelib-file`, {
      method: 'POST',
      body: form({ username: 'RouteProbe', shelf: 'полка-мечты' }),
    });
    assert.equal(badShelf.status, 400);
    assert.equal((await badShelf.json()).code, 'invalid_shelf');

    // A file name the service itself could not have produced and no `shelf` field.
    const noShelf = await fetch(`${base}/import/livelib-file`, {
      method: 'POST',
      body: form({ username: 'RouteProbe', filename: 'export.json' }),
    });
    assert.equal(noShelf.status, 400);
    const noShelfBody = await noShelf.json();
    assert.equal(noShelfBody.code, 'shelf_required');
    assert.match(noShelfBody.error, /read\|dnf\|reading\|wish/);

    const brokenJson = await fetch(`${base}/import/livelib-file`, {
      method: 'POST',
      body: form({ username: 'RouteProbe', file: Buffer.from('{"title": "x"', 'utf8') }),
    });
    assert.equal(brokenJson.status, 400);
    assert.equal((await brokenJson.json()).code, 'livelib_file_invalid_json');

    const brokenCsv = await fetch(`${base}/import/livelib-file`, {
      method: 'POST',
      body: form({ username: 'RouteProbe', file: Buffer.from('foo;bar\n1;2\n', 'utf8'), filename: 'livelib-x-read.csv' }),
    });
    assert.equal(brokenCsv.status, 400);
    assert.equal((await brokenCsv.json()).code, 'livelib_file_unknown_columns');

    /* A scrape of the same profile in flight: 409, no merge. */
    const realImportLivelib = livelib.importLivelib;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    livelib.importLivelib = async () => {
      await gate;
      throw new livelib.LivelibError('LiveLib ограничил доступ (HTTP 403).', 'livelib_blocked');
    };
    t.after(() => {
      livelib.importLivelib = realImportLivelib;
    });

    const job = importJobs.startLivelibImport('BundleProbe', { force: true });
    assert.equal(job.done, false);
    const conflict = await fetch(`${base}/import/livelib-file`, {
      method: 'POST',
      body: form({ username: 'BundleProbe' }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, 'livelib_import_running');
    assert.equal(bookCache.getProfile('livelib', 'BundleProbe'), null);

    release();
    await importJobs.idle();
    assert.equal(importJobs.getStatus(job.id).stage, 'failed');
  });

  /**
   * «Обновить» for a LiveLib profile is a re-upload, so the interesting case is a
   * *changed* export: new rows appear, and the events that are already there keep
   * their resolved work link, exact date and curated columns. A second upload of
   * the same document must stay a no-op (`added: 0`), which is what makes the
   * button safe to press twice.
   */
  test('livelib-file refresh: a newer export adds rows without touching resolved events', async () => {
    const rows = JSON.parse(jsonFixture.toString('utf8'));
    const first = await fetch(`${base}/import/livelib-file`, {
      method: 'POST',
      body: form({ username: 'RefreshProbe', file: Buffer.from(JSON.stringify(rows), 'utf8') }),
    });
    assert.equal(first.status, 201);
    assert.equal((await first.json()).added, 3);

    // Simulate the resolve pass: the first book is linked to a work and got an
    // exact reading day from an older scrape.
    const before = bookCache.getProfile('livelib', 'RefreshProbe');
    const annihilation = before.events.find((event) => event.title === 'Аннигиляция');
    annihilation.workId = 'hc:777';
    annihilation.finishedAt = '2026-09-14';
    annihilation.rating10 = 9;
    await bookCache.saveProfile('livelib', 'RefreshProbe', before);

    // The user reads two more books and exports again: same three rows + 2 new.
    const newer = rows.concat([
      {
        title: 'Пикник на обочине (переиздание)',
        bookHref: 'https://www.livelib.ru/book/1000999999-piknik-pereizdanie',
        readDate: "Октябрь 2026 г.",
        rating: { overall: '8.0', user: '4' },
        authors: [{ name: 'Аркадий Стругацкий' }],
      },
      {
        title: 'Трудно быть богом',
        bookHref: 'https://www.livelib.ru/book/1000999998-trudno-byt-bogom',
        readDate: '2019 г.',
        rating: { overall: '9.0', user: '5' },
        authors: [{ name: 'Аркадий Стругацкий' }],
      },
    ]);
    const refresh = await fetch(`${base}/import/livelib-file`, {
      method: 'POST',
      body: form({
        username: 'RefreshProbe',
        file: Buffer.from(JSON.stringify(newer), 'utf8'),
        filename: 'livelib-refreshprobe-read-29.10.2026.json',
      }),
    });
    assert.equal(refresh.status, 201);
    const refreshBody = await refresh.json();
    assert.equal(refreshBody.imported, 5);
    assert.deepEqual(
      { added: refreshBody.added, skipped: refreshBody.skipped },
      { added: 2, skipped: 3 }
    );
    assert.equal(refreshBody.events, 5);

    const after = bookCache.getProfile('livelib', 'RefreshProbe');
    const kept = after.events.find((event) => event.title === 'Аннигиляция');
    assert.equal(kept.workId, 'hc:777', 'the resolved link must survive a refresh');
    assert.equal(kept.finishedAt, '2026-09-14', 'an exact day must not be replaced by a month');
    assert.equal(kept.rating10, 9);
    assert.equal(after.fileImports.length, 2);
    assert.equal(after.events.filter((event) => event.shelf === 'read').length, 5);

    /* The same file again: nothing duplicates. */
    const repeat = await fetch(`${base}/import/livelib-file`, {
      method: 'POST',
      body: form({
        username: 'RefreshProbe',
        file: Buffer.from(JSON.stringify(newer), 'utf8'),
        filename: 'livelib-refreshprobe-read-29.10.2026.json',
      }),
    });
    assert.equal(repeat.status, 201);
    const repeatBody = await repeat.json();
    assert.deepEqual(
      { added: repeatBody.added, skipped: repeatBody.skipped },
      { added: 0, skipped: 5 }
    );
    assert.equal(bookCache.getProfile('livelib', 'RefreshProbe').events.length, 5);
  });

  /**
   * Two overlapping uploads of ONE profile must not both merge: the second write
   * would drop the first upload's rows. The route answers 409 instead.
   */
  test('livelib-file refresh: a concurrent upload of the same profile is a 409', async (t) => {
    const realSave = bookCache.saveProfile;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    bookCache.saveProfile = async (...args) => {
      if (args[1] === 'ConcurrentProbe') await gate;
      return realSave.apply(bookCache, args);
    };
    t.after(() => {
      bookCache.saveProfile = realSave;
      release();
    });

    const slow = fetch(`${base}/import/livelib-file`, {
      method: 'POST',
      body: form({ username: 'ConcurrentProbe' }),
    });
    // Give the first request time to pass validation and reach the merge lock.
    await new Promise((resolve) => setTimeout(resolve, 80));

    const second = await fetch(`${base}/import/livelib-file`, {
      method: 'POST',
      body: form({ username: 'ConcurrentProbe' }),
    });
    assert.equal(second.status, 409);
    assert.equal((await second.json()).code, 'livelib_import_running');

    release();
    const first = await slow;
    assert.equal(first.status, 201);
    assert.equal((await first.json()).added, 3);
    // The lock is released: the next upload is accepted, not stuck behind it.
    const third = await fetch(`${base}/import/livelib-file`, {
      method: 'POST',
      body: form({ username: 'ConcurrentProbe' }),
    });
    assert.equal(third.status, 201);
    assert.equal((await third.json()).added, 0);
  });
  after(() => env.resetMutableState());
});


describe('books-livelib-file-resolve', () => {
  /**
   * `livelib-file` is a first-class resolve input (§3.3.2).
   *
   * What this file pins:
   *   - a file row WITHOUT «Ссылка на книгу» (no `sourceBookId`) is still in the
   *     resolve pool and gets a stable `file:tk:<sha1>` link key — and the stats
   *     payload gives it its own work id instead of collapsing every such row
   *     into one `ll:` book;
   *   - the ISBN column of the export goes straight into ONE batched Hardcover
   *     lookup (no LiveLib-card round-trip needed just to learn an ISBN);
   *   - Cyrillic titles are matched by Литрес first, Latin ones are not sent to
   *     Литрес at all (budget politeness);
   *   - plan shelves (`reading`/`wish`) are skipped by the chain: they never
   *     reach stats, so they must not spend the budget;
   *   - the payload unions the chain's genres/series with the file columns and
   *     `metadataSources` keeps BOTH provenances;
   *   - `POST /api/books/import/livelib-file` starts the resolve job by default
   *     and honours the explicit `resolve=0` opt-out (body and query).
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const BOOK_CACHE_DIR = run.cacheBookDir;
  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const livelibFile = require('../server/books/livelib-file');
  const resolve = require('../server/books/resolve');
  const importJobs = require('../server/books/import');
  const { buildBooksStats } = require('../server/books/stats');
  const { portFor } = require('./helpers/port');

  const PORT = portFor(40);
  const FIXTURES = path.join(__dirname, 'fixtures');

  /** `livelib-backup` JSON rows: no «Ссылка на книгу» column at all. */
  function exportWithoutLinks(rows) {
    return Buffer.from(JSON.stringify(rows), 'utf8');
  }

  function fileProfile(rows, shelf = 'read', userKey = 'NoLinkProbe') {
    const parsed = livelibFile.parseExportFile(exportWithoutLinks(rows), {
      filename: `livelib-${userKey.toLowerCase()}-${shelf}.json`,
    });
    const { profile } = livelibFile.mergeFileIntoProfile(null, {
      userKey,
      books: parsed.books,
      shelf,
      format: 'json',
      filename: `livelib-${userKey.toLowerCase()}-${shelf}.json`,
    });
    return profile;
  }

  function hcEntry({ hcWorkId, isbn13, title, authors = [], genres = [], pages = null, year = null, publisher = null }) {
    return {
      details: {
        schemaVersion: 1,
        hcWorkId,
        title,
        authors: authors.map((name, index) => ({ hcId: index + 1, name })),
        genres,
        series: [],
        pages,
        publicationYear: year,
        publisher,
        isbn13,
        isbn10: null,
        coverUrl: null,
        ratingsCount: 100,
        partial: false,
      },
      editionId: hcWorkId * 10,
    };
  }

  /** Hardcover bulk stub that records what was asked and answers from `entries`. */
  function lookupStub(entries) {
    const byIsbn = new Map();
    const works = new Map();
    for (const entry of entries) {
      byIsbn.set(resolve.normalizeIsbn(entry.details.isbn13), entry);
      works.set(entry.details.hcWorkId, entry.details);
    }
    const calls = [];
    const fn = async (isbns) => {
      calls.push([...isbns]);
      return { byIsbn, works, queries: [...isbns], requests: 1 };
    };
    fn.calls = calls;
    return fn;
  }

  const ANNIHILATION = {
    title: 'Аннигиляция',
    readDate: 'Сентябрь 2026 г.',
    rating: { overall: '7.4', user: '4.5' },
    authors: [{ name: 'Джефф Вандермеер' }],
    details: { isbn: '978-5-699-98967-6', year: '2018 г.', publishers: 'Эксмо' },
  };

  /**
   * Resolve caches are keyed by title+author hash, so every test must use its own
   * titles: sharing one would let a link written by an earlier test short-circuit
   * the pass under test (and the shared cache dir is the point of the file).
   *
   * Unique title per test is enough — the hash is sha1(title|surname).
   */
  function book(title, author, extra = {}) {
    return { title, readDate: 'сентябрь 2026', authors: [{ name: author }], ...extra };
  }

  test('a file row without a link column is resolved by its file key, not dropped', async () => {
    const profile = fileProfile([
      ANNIHILATION,
      { title: 'Мартин Иден', readDate: 'март 2023', authors: [{ name: 'Джек Лондон' }] },
      { title: 'Пикник на обочине', readDate: '2021 г.', authors: [{ name: 'Аркадий Стругацкий' }] },
    ]);
    assert.deepEqual(profile.events.map((event) => event.sourceBookId), [null, null, null]);
    assert.ok(profile.events.every((event) => event.fileKey));

    const lookup = lookupStub([
      hcEntry({ hcWorkId: 501, isbn13: '9785699989676', title: 'Annihilation', authors: ['Jeff VanderMeer'], pages: 320, year: 2014 }),
    ]);
    const report = await resolve.resolveProfile(profile, { providers: [], lookupIsbns: lookup });

    assert.equal(report.total, 3);
    assert.equal(report.resolvedIsbn, 1);
    assert.equal(report.skippedPlanShelf, 0);
    // One ISBN batch, one query — the export's own column is the key.
    assert.equal(lookup.calls.length, 1);
    assert.deepEqual(lookup.calls[0], ['9785699989676']);

    const key = `file:${profile.events[0].fileKey}`;
    const link = bookCache.getLink(key);
    assert.ok(link, 'link is cached under the synthetic file key');
    assert.equal(link.workId, 'hc:501');
    assert.equal(link.method, 'isbn');
  });

  test('stats give every linkless file row its own work and grow the badge after resolve', async () => {
    const rows = [
      book('Дюна (проверка бейджа)', 'Фрэнк Герберт'),
      book('Солярис (проверка бейджа)', 'Станислав Лем'),
      book('Сталкер (проверка бейджа)', 'Аркадий Стругацкий'),
    ];
    const profile = fileProfile(rows, 'read', 'BadgeProbe');
    await bookCache.saveProfile('livelib', 'BadgeProbe', profile);

    const before = buildBooksStats({ profile: 'livelib-BadgeProbe' });
    // The export rows carry no genres/series/year: honestly unresolved …
    assert.equal(before.summary.bookCount, 3, 'rows must not collapse into one ll: work');
    const beforePercent = before.summary.metadata.percent;
    assert.ok(beforePercent < 100, `file-only profile is not 100% (got ${beforePercent})`);

    const lookup = lookupStub([
      hcEntry({ hcWorkId: 551, isbn13: '9785699000001', title: 'Dune', authors: ['Frank Herbert'], genres: ['Science Fiction'], pages: 704, year: 1965 }),
      hcEntry({ hcWorkId: 552, isbn13: '9785699000002', title: 'Solaris', authors: ['Stanislaw Lem'], genres: ['Science Fiction'], pages: 224, year: 1961 }),
    ]);
    // A later export adds the ISBN column to the same rows (same file keys).
    const stored = bookCache.getProfile('livelib', 'BadgeProbe');
    stored.events[0].edition = { ...(stored.events[0].edition || {}), isbn: '9785699000001' };
    stored.events[1].edition = { ...(stored.events[1].edition || {}), isbn: '9785699000002' };
    await bookCache.saveProfile('livelib', 'BadgeProbe', stored);

    const report = await resolve.resolveProfile(bookCache.getProfile('livelib', 'BadgeProbe'), {
      providers: [],
      lookupIsbns: lookup,
    });
    assert.equal(report.resolvedIsbn, 2);

    const after = buildBooksStats({ profile: 'livelib-BadgeProbe' });
    assert.ok(
      after.summary.metadata.percent > beforePercent,
      `percent grows (${beforePercent}% -> ${after.summary.metadata.percent}%)`
    );
    assert.equal(after.summary.metadata.resolved, 2);
    assert.equal(after.summary.metadata.total, 3);
    // Two events now point at canonical works; event count is unchanged.
    assert.equal(after.summary.bookCount, 3);
    assert.equal(after.summary.eventCount, 3);
    assert.ok(Object.keys(after.booksIndex).some((workId) => workId === 'hc:551'));
    assert.ok(Object.keys(after.booksIndex).some((workId) => workId.startsWith('ll:file:')));
  });

  test('Cyrillic titles go to Литрес first, Latin titles never do', async () => {
    const litresCalls = [];
    const gbCalls = [];
    const order = [];
    const fakeLitres = {
      NAME: 'litres',
      getWork: async (input) => {
        litresCalls.push(input.title);
        order.push(`litres:${input.title}`);
        return {
          source: 'litres',
          sourceId: '9001',
          workId: 'lr:9001',
          title: input.title,
          authors: input.authors,
          year: 2018,
          publisher: 'Эксмо',
          pages: 256,
          genres: ['Зарубежное фэнтези'],
          isbn13: '9785699989676',
          isbn10: null,
          cover: null,
          language: 'ru',
          series: { name: 'Южный предел', position: 1 },
          confidence: 0.9,
          match: { method: 'title', score: 0.9 },
          links: { pageUrl: 'https://www.litres.ru/book/9001' },
        };
      },
    };
    const fakeGoogle = {
      NAME: 'googlebooks',
      getWork: async (input) => {
        gbCalls.push(input.title);
        order.push(`googlebooks:${input.title}`);
        return null;
      },
    };
    const fakeOpenLibrary = { NAME: 'openlibrary', getWork: async () => null };
    const fakeCard = { NAME: 'livelib-card', getWork: async () => null };

    const profile = fileProfile(
      [
        book('Трудно быть богом', 'Аркадий Стругацкий'),
        book('The Lathe of Heaven', 'Ursula Le Guin'),
      ],
      'read',
      'RusFirstProbe'
    );

    const report = await resolve.resolveProfile(profile, {
      providers: [fakeLitres, fakeGoogle, fakeOpenLibrary, fakeCard],
      lookupIsbns: lookupStub([]),
      sleep: async () => {},
    });

    assert.deepEqual(litresCalls, ['Трудно быть богом'], 'only the Cyrillic title hits Литрес');
    assert.equal(report.resolvedLitres, 1);
    // Литрес is asked before any title fallback for the Cyrillic book.
    assert.equal(order[0], 'litres:Трудно быть богом');
    // …and the Latin one is never sent to Литрес, it falls through to GB/OL.
    assert.ok(gbCalls.includes('The Lathe of Heaven'));
    assert.ok(!litresCalls.includes('The Lathe of Heaven'));

    const ruEvent = profile.events.find((event) => event.title === 'Трудно быть богом');
    const link = bookCache.getLink(`file:${ruEvent.fileKey}`);
    assert.equal(link.workId, 'lr:9001');
    const details = bookCache.getWorkDetails('lr:9001');
    assert.equal(details.pages, 256);
    assert.deepEqual(details.series, [{ hcId: null, name: 'Южный предел', position: 1 }]);
    assert.deepEqual(details.metadataSources, ['litres']);
  });

  test('plan shelves (reading/wish) are skipped: they must not spend the budget', async () => {
    const calls = [];
    const fakeLitres = {
      NAME: 'litres',
      getWork: async (input) => {
        calls.push(input.title);
        return null;
      },
    };
    const profile = fileProfile(
      [
        book('Обитаемый остров (план)', 'Аркадий Стругацкий'),
        book('Понедельник начинается в субботу (план)', 'Аркадий Стругацкий'),
      ],
      'wish',
      'PlanProbe'
    );
    const report = await resolve.resolveProfile(profile, {
      providers: [fakeLitres],
      lookupIsbns: lookupStub([]),
      sleep: async () => {},
    });
    assert.equal(report.total, 0);
    assert.equal(report.skippedPlanShelf, 2);
    assert.deepEqual(calls, []);
  });

  test('payload unions chain genres/series with the file columns and keeps both sources', async () => {
    const profile = fileProfile(
      [
        {
          title: 'Аннигиляция (union)',
          readDate: 'Сентябрь 2026 г.',
          authors: [{ name: 'Джефф Вандермеер' }],
          genres: [{ name: 'фэнтези' }, { name: 'ужасы' }],
          details: { isbn: '978-5-699-98967-1', year: '2018 г.', publishers: 'Эксмо', series: 'Южный предел' },
        },
      ],
      'read',
      'UnionProbe'
    );
    await bookCache.saveProfile('livelib', 'UnionProbe', profile);
    const key = `file:${profile.events[0].fileKey}`;

    // The chain resolved the SAME work, but knows a different genre vocabulary
    // and lacks the file's year/publisher.
    await bookCache.saveDetails('501', {
      schemaVersion: 2,
      hcWorkId: 501,
      title: 'Annihilation',
      authors: [{ hcId: 1, name: 'Jeff VanderMeer' }],
      genres: ['Science Fiction', 'Фэнтези'],
      series: [{ hcId: 77, name: 'Southern Reach', position: 1 }],
      pages: 320,
      publicationYear: null,
      publisher: null,
      isbn13: '9785699989676',
      metadataSources: ['hardcover'],
      sources: [{ source: 'hardcover', sourceId: '501' }],
      partial: false,
    });
    await bookCache.saveLink(key, {
      schemaVersion: 2,
      livelibBookId: key,
      workId: 'hc:501',
      method: 'isbn',
      score: 1,
      evidence: { isbn: '9785699989676' },
      resolvedAt: '2026-10-28T00:00:00.000Z',
    });

    const stats = buildBooksStats({ profile: 'livelib-UnionProbe' });
    const work = Object.values(stats.booksIndex)[0];
    assert.equal(work.workId, 'hc:501');
    // Union, deduped by normalized name: «Фэнтези» from HC and «фэнтези» from the
    // file are the same concept; the RU file labels survive the resolve.
    assert.deepEqual(work.genres, ['Science Fiction', 'Фэнтези', 'ужасы']);
    assert.deepEqual(work.series.slice().sort(), ['Southern Reach', 'Южный предел']);
    // File-only fields are not wiped by a details doc that does not know them.
    // The chart prefers a first publication, but no provider claims one here
    // (HC publicationYear is null); the file's print-run year is the honest
    // fallback and is marked as an edition year, not a first edition.
    assert.equal(work.year, 2018);
    assert.equal(work.yearSource, 'edition');
    assert.equal(work.firstPublishedYear, null);
    assert.equal(work.editionYear, 2018);
    assert.equal(work.publisher, 'Эксмо');
    assert.equal(work.pages, 320);
    assert.deepEqual(work.metadataSources, ['hardcover', 'livelib-file']);
    assert.equal(stats.summary.metadata.percent, 100);
  });

  test('Литрес genres drive the manga filter for a file profile', async () => {
    const profile = fileProfile(
      [{ title: 'Берсерк', readDate: 'сентябрь 2026', authors: [{ name: 'Кэнтаро Миура' }] }],
      'read',
      'MangaProbe'
    );
    await bookCache.saveProfile('livelib', 'MangaProbe', profile);
    const key = `file:${profile.events[0].fileKey}`;
    await bookCache.saveDetails('lr-4242', {
      schemaVersion: 2,
      workId: 'lr:4242',
      title: 'Берсерк',
      authors: [{ name: 'Кэнтаро Миура' }],
      genres: ['Манга', 'Тёмное фэнтези'],
      series: [{ hcId: null, name: 'Берсерк', position: 1 }],
      pages: null,
      metadataSources: ['litres'],
      sources: [{ source: 'litres', sourceId: '4242' }],
      partial: false,
    });
    await bookCache.saveLink(key, {
      schemaVersion: 2,
      livelibBookId: key,
      workId: 'lr:4242',
      method: 'litres-title',
      score: 0.9,
      evidence: {},
      resolvedAt: '2026-10-28T00:00:00.000Z',
    });

    const hidden = buildBooksStats({ profile: 'livelib-MangaProbe', includeMangaComics: false });
    assert.equal(hidden.summary.mangaExcluded, 1);
    assert.equal(hidden.summary.bookCount, 0);
    const shown = buildBooksStats({ profile: 'livelib-MangaProbe', includeMangaComics: true });
    assert.equal(shown.summary.bookCount, 1);
    const work = Object.values(shown.booksIndex)[0];
    assert.match(work.metadataSources.join(','), /livelib-file|litres/);
  });

  /* ------------------------------------------------------------------ */
  /* Route: auto-resolve is the default, `resolve=0` is the opt-out      */
  /* ------------------------------------------------------------------ */

  test('POST /api/books/import/livelib-file starts the resolve job unless opted out', async (t) => {
    const express = require('express');
    const routes = require('../server/books/routes');
    const app = express();
    app.use(express.json());
    app.use('/api/books', routes);
    app.use((err, req, res, next) => {
      res.status(err.status || err.statusCode || 500).json({ code: err.code, error: err.message });
    });
    const server = app.listen(PORT);
    await new Promise((done) => server.once('listening', done));
    const base = `http://127.0.0.1:${PORT}/api/books`;
    t.after(() => new Promise((done) => server.close(done)));

    const fixture = fs.readFileSync(path.join(FIXTURES, 'livelib-file-export.json'));
    const upload = async (fields = {}, query = '') => {
      const body = new FormData();
      body.append('username', 'AutoResolveProbe');
      for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
      body.append('file', new Blob([fixture], { type: 'application/json' }), 'livelib-autoresolveprobe-read-28.10.2026.json');
      const response = await fetch(`${base}/import/livelib-file${query}`, { method: 'POST', body });
      return { status: response.status, body: await response.json() };
    };

    const realStart = importJobs.startResolveJob;
    const started = [];
    importJobs.startResolveJob = (options = {}) => {
      started.push(options);
      return { id: 'resolve-stub', stage: 'queued' };
    };
    t.after(() => {
      importJobs.startResolveJob = realStart;
    });

    const dflt = await upload();
    assert.equal(dflt.status, 201);
    assert.deepEqual(dflt.body.resolve, { jobId: 'resolve-stub', stage: 'queued' });
    assert.equal(started.length, 1);
    assert.equal(started[0].coalesce, false, 'a file merge needs a later pass, not the running one');
    assert.equal(started[0].allowLivelibCard, false, 'the safe path must never scrape livelib.ru');

    const optedOut = await upload({ resolve: '0' });
    assert.equal(optedOut.status, 201);
    assert.equal(optedOut.body.resolve, null);
    assert.equal(started.length, 1);

    const optedOutQuery = await upload({}, '?resolve=0');
    assert.equal(optedOutQuery.status, 201);
    assert.equal(optedOutQuery.body.resolve, null);
    assert.equal(started.length, 1);

    const explicitOn = await upload({ resolve: '1' });
    assert.equal(explicitOn.status, 201);
    assert.equal(started.length, 2);
  });

  test('allowLivelibCard: false keeps the card provider out of a file-import pass', async () => {
    const cardCalls = [];
    const fakeCard = {
      NAME: 'livelib-card',
      getWork: async (input) => {
        cardCalls.push(input.title);
        return null;
      },
    };
    const profile = fileProfile(
      [book('Карточка не нужна', 'Тестовый Автор', { bookHref: 'https://www.livelib.ru/book/1234567' })],
      'read',
      'NoCardProbe'
    );
    // The row knows its LiveLib page, so only the card provider could use it.
    assert.equal(profile.events[0].sourceBookId, '1234567');
    const report = await resolve.resolveProfile(profile, {
      providers: [fakeCard],
      lookupIsbns: lookupStub([]),
      allowLivelibCard: false,
      sleep: async () => {},
    });
    assert.deepEqual(cardCalls, [], 'no request to livelib.ru from the safe path');
    assert.equal(report.providerChain['livelib-card'], undefined);
  });

  test('a Hardcover ISBN-lookup failure degrades to a warning, not a dead pass', async () => {
    const calls = [];
    const fakeLitres = {
      NAME: 'litres',
      getWork: async (input) => {
        calls.push(input.title);
        return {
          source: 'litres',
          sourceId: '9100',
          workId: 'lr:9100',
          title: input.title,
          authors: input.authors,
          year: 2018,
          publisher: 'Эксмо',
          pages: 256,
          genres: ['Зарубежное фэнтези'],
          isbn13: '9785699000011',
          series: null,
          confidence: 0.9,
          match: { method: 'title', score: 0.9 },
          links: { pageUrl: 'https://www.litres.ru/book/9100' },
        };
      },
    };
    const profile = fileProfile(
      [
        book('Токен не настроен (тест)', 'Тестовый Автор', {
          details: { isbn: '9785699000011' },
        }),
      ],
      'read',
      'NoTokenProbe'
    );
    const failingLookup = async () => {
      const error = new Error('Hardcover-токен не настроен');
      error.code = 'hardcover_token_missing';
      throw error;
    };
    const report = await resolve.resolveProfile(profile, {
      providers: [fakeLitres],
      lookupIsbns: failingLookup,
      sleep: async () => {},
    });
    assert.deepEqual(report.lookupErrors, ['hardcover_token_missing']);
    assert.deepEqual(calls, ['Токен не настроен (тест)'], 'Литрес still runs');
    assert.equal(report.resolvedLitres, 1);
    assert.equal(report.withMetadata, 1);
  });

  test('a queued resolve-only job already reports the badge as running', () => {
    const queued = { id: 'resolve-livelib-x', source: 'livelib', done: false, stage: 'queued', startedAt: 1 };
    const scrapeQueued = { id: 'livelib-x-1', source: 'livelib', done: false, stage: 'queued', startedAt: 1 };
    assert.equal(importJobs.resolveStateFromJobs([queued], 'livelib').running, true);
    assert.equal(importJobs.resolveStateFromJobs([scrapeQueued], 'livelib').running, false);
    assert.equal(importJobs.resolveStateFromJobs([queued], 'hardcover').running, false);
  });
  after(() => env.resetMutableState());
});


describe('books-manga-flags', () => {
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

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const { detectManga, isMangaPublisher } = require('../server/books/providers/manga');
  const { mergeResults, resultToDetails } = require('../server/books/providers');
  const { buildBooksStats } = require('../server/books/stats');
  const backfill = require('../server/books/manga-backfill');

  const { portFor } = require('./helpers/port');
  const PORT = portFor(50);

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

    const stats = buildBooksStats({ profile: 'hardcover-tester' });
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

    const all = buildBooksStats({ profile: 'hardcover-tester', includeMangaComics: true });
    assert.equal(all.summary.mangaExcluded, 0);
    assert.equal(all.booksIndex['hc:902'].mangaComics, true);
    assert.equal(all.booksIndex['hc:902'].mangaComicsSource, 'manual');
    assert.equal(all.booksIndex['hc:902'].mangaComicsOverride, true);
    assert.equal(all.booksIndex['hc:903'].mangaComicsOverride, false);
    assert.equal(all.booksIndex['hc:904'].mangaComicsSource, 'series');
  });

  test('flags file is fingerprint-revalidated (external write, no restart)', async () => {
    await resetFlags({ 'hc:900': { mangaComics: true, updatedAt: new Date().toISOString() } });
    const stats = buildBooksStats({ profile: 'hardcover-tester' });
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

    const hidden = await (await fetch(`${base}/stats?profile=hardcover-tester`)).json();
    assert.equal(hidden.booksIndex['hc:900'], undefined);

    const removed = await fetch(`${base}/work/flag?workId=${encodeURIComponent('hc:900')}`, {
      method: 'DELETE',
    });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).removed, true);

    const shown = await (await fetch(`${base}/stats?profile=hardcover-tester`)).json();
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
  after(() => env.resetMutableState());
});


describe('books-year-override', () => {
  /**
   * Manual publication-year corrections (round 29.10.2026).
   *
   * User verdicts pinned here:
   *   - year priority is `manual > firstPublishedYear > editionYear > unknown`;
   *   - an edition year is an honest fallback, always marked
   *     (`yearSource: 'edition'`), never presented as a first publication;
   *   - a manual correction persists per profile in
   *     `cache-book/year-overrides/<profile>.json`, survives resolve/backfill
   *     (a details document rewrite) and a re-import of the same file export;
   *   - HTTP POST /api/books/year-override validates profile/workId/year, and
   *     `year: null` removes the correction.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const { buildBooksStats, resolveWorkYear } = require('../server/books/stats');
  const { buildFileEvent, mergeFileIntoProfile, normalizeRecord } = require('../server/books/livelib-file');

  const { portFor } = require('./helpers/port');
  const PORT = portFor(90);

  function profile(userKey, events) {
    return {
      schemaVersion: 1,
      source: 'livelib',
      userKey,
      sourceUserId: null,
      importedAt: '2026-10-29T00:00:00.000Z',
      events,
      warnings: [],
    };
  }

  test('year priority: manual > first > edition > unknown', () => {
    const details = { firstPublishedYear: 1564, publicationYear: 2005 };
    const manual = resolveWorkYear(details, null, {}, { year: 1700 });
    assert.equal(manual.year, 1700);
    assert.equal(manual.yearSource, 'manual');
    assert.equal(manual.yearOverride, 1700);
    assert.equal(manual.firstPublishedYear, 1564);
    assert.equal(manual.editionYear, 2005);

    const first = resolveWorkYear(details, null, {}, null);
    assert.equal(first.year, 1564);
    assert.equal(first.yearSource, 'first');

    const edition = resolveWorkYear({ publicationYear: 2005 }, null, {}, null);
    assert.equal(edition.year, 2005);
    assert.equal(edition.yearSource, 'edition');
    assert.equal(edition.firstPublishedYear, null);

    const unknown = resolveWorkYear({}, null, {}, null);
    assert.equal(unknown.year, null);
    assert.equal(unknown.yearSource, null);

    // An insane manual value is ignored, not written into the chart.
    const insane = resolveWorkYear(details, null, {}, { year: 9999 });
    assert.equal(insane.year, 1564);
    assert.equal(insane.yearSource, 'first');
  });

  test('a manual override survives resolve, backfill and a file re-import', async () => {
    const userKey = 'YearOverridePersist';
    const title = 'Гамлет, принц датский';
    const authors = [{ name: 'Уильям Шекспир' }];
    const row = {
      title,
      authors,
      bookHref: null,
      readDate: 'сентябрь 2026',
      rating: { user: '5' },
      details: { publishers: 'АСТ', year: '2005' },
    };
    const record = normalizeRecord(row);
    const event = buildFileEvent(record, 'read', 1);
    const fileKey = event.fileKey;
    assert.ok(fileKey && fileKey.startsWith('tk:'));
    const fileWorkId = `ll:file:${fileKey}`;

    await bookCache.saveProfile('livelib', userKey, profile(userKey, [event]));
    let stats = buildBooksStats({ profile: `livelib-${userKey}` });
    assert.equal(stats.booksIndex[fileWorkId].year, 2005);
    assert.equal(stats.booksIndex[fileWorkId].yearSource, 'edition');

    // Manual correction keyed by the workId the UI saw.
    await bookCache.setYearOverride('livelib', userKey, fileWorkId, 1700);
    stats = buildBooksStats({ profile: `livelib-${userKey}` });
    assert.equal(stats.booksIndex[fileWorkId].year, 1700);
    assert.equal(stats.booksIndex[fileWorkId].yearSource, 'manual');
    assert.equal(stats.booksIndex[fileWorkId].yearOverride, 1700);
    assert.equal(stats.summary.yearManualCount, 1);

    // Resolve links the file row to a Hardcover work: workId changes, the
    // override follows via the stable event key.
    await bookCache.saveDetails(9001, {
      schemaVersion: 2,
      hcWorkId: 9001,
      title,
      authors,
      publicationYear: 2005,
      firstPublishedYear: 1603,
    });
    await bookCache.saveLink(`file:${fileKey}`, {
      schemaVersion: 2,
      livelibBookId: null,
      workId: 'hc:9001',
      method: 'title',
      score: 1,
    });
    stats = buildBooksStats({ profile: `livelib-${userKey}` });
    assert.equal(stats.booksIndex['hc:9001'].year, 1700);
    assert.equal(stats.booksIndex['hc:9001'].yearSource, 'manual');
    assert.equal(stats.booksIndex['hc:9001'].firstPublishedYear, 1603);

    // Backfill rewrites the details document (first-publication claim); the
    // manual correction still wins.
    await bookCache.saveDetails(9001, {
      schemaVersion: 2,
      hcWorkId: 9001,
      title,
      authors,
      publicationYear: 2005,
      firstPublishedYear: 1603,
      firstPublishedYearCheckedAt: '2026-10-29T00:00:00.000Z',
    });
    stats = buildBooksStats({ profile: `livelib-${userKey}` });
    assert.equal(stats.booksIndex['hc:9001'].year, 1700);
    assert.equal(stats.booksIndex['hc:9001'].yearSource, 'manual');

    // Re-import of the same export (same title|surname key) does not lose it.
    const merged = mergeFileIntoProfile(bookCache.getProfile('livelib', userKey), {
      userKey,
      books: [record],
      shelf: 'read',
      now: '2026-10-29T01:00:00.000Z',
    });
    await bookCache.saveProfile('livelib', userKey, merged.profile);
    stats = buildBooksStats({ profile: `livelib-${userKey}` });
    assert.equal(stats.booksIndex['hc:9001'].year, 1700);
    assert.equal(stats.booksIndex['hc:9001'].yearSource, 'manual');

    // Reset restores the provider chain: first publication wins again.
    await bookCache.clearYearOverride('livelib', userKey, fileWorkId);
    stats = buildBooksStats({ profile: `livelib-${userKey}` });
    assert.equal(stats.booksIndex['hc:9001'].year, 1603);
    assert.equal(stats.booksIndex['hc:9001'].yearSource, 'first');
    assert.equal(stats.booksIndex['hc:9001'].yearOverride, null);
  });

  test('HTTP POST /api/books/year-override validates and is profile-scoped', async (t) => {
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

    const event = {
      id: 'll:9100',
      source: 'livelib',
      sourceBookId: '9100',
      title: 'Гаргантюа и Пантагрюэль',
      authors: ['Франсуа Рабле'],
      status: 'read',
      finishedAt: '2026-09-01',
    };
    await bookCache.saveDetails(9100, {
      schemaVersion: 2,
      hcWorkId: 9100,
      title: 'Гаргантюа и Пантагрюэль',
      authors: [{ name: 'Франсуа Рабле' }],
      publicationYear: 2026,
      firstPublishedYear: 1564,
      firstPublishedYearSource: 'litres',
    });
    await bookCache.saveLink('9100', {
      schemaVersion: 2,
      livelibBookId: '9100',
      workId: 'hc:9100',
      method: 'isbn',
      score: 1,
    });
    await bookCache.saveProfile('livelib', 'YearOverrideApi', profile('YearOverrideApi', [event]));
    await bookCache.saveProfile('livelib', 'YearOverrideApiOther', profile('YearOverrideApiOther', [event]));

    async function post(body) {
      const response = await fetch(`${base}/year-override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    }

    assert.equal((await post({ workId: 'hc:9100', year: 1700 })).body.code, 'profile_required');
    assert.equal(
      (await post({ profile: 'livelib-NoSuchProfile', workId: 'hc:9100', year: 1700 })).body.code,
      'unknown_profile'
    );
    assert.equal(
      (await post({ profile: 'livelib-YearOverrideApi', year: 1700 })).body.code,
      'work_id_required'
    );
    for (const year of ['abc', 0, 9999, 12.5]) {
      assert.equal(
        (await post({ profile: 'livelib-YearOverrideApi', workId: 'hc:9100', year })).body.code,
        'invalid_year',
        `year=${year}`
      );
    }
    assert.equal(
      (await post({ profile: 'livelib-YearOverrideApi', workId: 'hc:does-not-exist', year: 1700 })).body.code,
      'unknown_work'
    );

    const saved = await post({ profile: 'livelib-YearOverrideApi', workId: 'hc:9100', year: 1700 });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.year, 1700);
    assert.equal(saved.body.removed, false);

    const stats = await (await fetch(`${base}/stats?profile=livelib-YearOverrideApi`)).json();
    assert.equal(stats.booksIndex['hc:9100'].year, 1700);
    assert.equal(stats.booksIndex['hc:9100'].yearSource, 'manual');
    assert.equal(stats.booksIndex['hc:9100'].yearOverride, 1700);

    // The same work in another profile is untouched: overrides are per profile.
    const other = await (await fetch(`${base}/stats?profile=livelib-YearOverrideApiOther`)).json();
    assert.equal(other.booksIndex['hc:9100'].year, 1564);
    assert.equal(other.booksIndex['hc:9100'].yearSource, 'first');

    const removed = await post({ profile: 'livelib-YearOverrideApi', workId: 'hc:9100', year: null });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, true);
    const after = await (await fetch(`${base}/stats?profile=livelib-YearOverrideApi`)).json();
    assert.equal(after.booksIndex['hc:9100'].year, 1564);
    assert.equal(after.booksIndex['hc:9100'].yearSource, 'first');

    // Idempotent removal.
    const again = await post({ profile: 'livelib-YearOverrideApi', workId: 'hc:9100', year: null });
    assert.equal(again.status, 200);
    assert.equal(again.body.removed, false);
  });

  test('the override file is fingerprint-revalidated from disk', async () => {
    const userKey = 'YearOverrideFingerprint';
    const event = {
      id: 'll:9200',
      source: 'livelib',
      sourceBookId: '9200',
      title: 'Книга',
      authors: ['Автор'],
      status: 'read',
      finishedAt: '2026-09-01',
    };
    await bookCache.saveProfile('livelib', userKey, profile(userKey, [event]));
    await bookCache.saveDetails(9200, {
      schemaVersion: 2,
      hcWorkId: 9200,
      title: 'Книга',
      authors: [{ name: 'Автор' }],
      publicationYear: 2000,
    });
    await bookCache.saveLink('9200', {
      schemaVersion: 2,
      livelibBookId: '9200',
      workId: 'hc:9200',
      method: 'isbn',
      score: 1,
    });

    let stats = buildBooksStats({ profile: `livelib-${userKey}` });
    assert.equal(stats.booksIndex['hc:9200'].year, 2000);
    assert.equal(stats.booksIndex['hc:9200'].yearSource, 'edition');

    // External edit (another process) without a server restart.
    await bookCache.writeJsonAtomic(bookCache.yearOverridesPath('livelib', userKey), {
      schemaVersion: 1,
      profile: { source: 'livelib', userKey },
      overrides: { 'hc:9200': { year: 1950, updatedAt: '2026-10-29T00:00:00.000Z' } },
    });
    stats = buildBooksStats({ profile: `livelib-${userKey}` });
    assert.equal(stats.booksIndex['hc:9200'].year, 1950);
    assert.equal(stats.booksIndex['hc:9200'].yearSource, 'manual');
  });

  test('UI texts mark edition/manual years honestly and offer the correction', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const booksSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'books.js'), 'utf8');
    const apiSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'api.js'), 'utf8');
    const chartsSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'charts', 'year-bars.js'), 'utf8');

    // The card marks an edition year with `*` and a manual correction with `✎`.
    assert.match(booksSource, /entry\.yearSource === 'edition'\) return `\$\{entry\.year\}\*`/);
    assert.match(booksSource, /entry\.yearSource === 'manual'\) return `\$\{entry\.year\}✎`/);
    assert.match(booksSource, /Год издания: \$\{entry\.year\} · \$\{channel\} · первоиздание неизвестно/);
    // Kebab action + modal + source line + reset.
    assert.match(booksSource, /label: 'Исправить год'/);
    assert.match(booksSource, /function openYearEditModal\(book\)/);
    assert.match(booksSource, /Ручная правка: \$\{book\.yearOverride/);
    assert.match(booksSource, /Сбросить правку/);
    // Notes never call an edition year a first publication.
    assert.match(booksSource, /год издания вместо первоиздания/);
    assert.match(booksSource, /ручная правка/);
    assert.match(booksSource, /yearEditionCount/);
    // Year buckets carry the edition marker into the donut legend/tooltip.
    assert.match(booksSource, /item\.editionCount > 0 \? `\$\{item\.year\}\*`/);
    assert.match(chartsSource, /yearNote/);
    // API client.
    assert.match(apiSource, /export function setBookYearOverride\(profile, workId, year/);
    assert.match(apiSource, /\/api\/books\/year-override/);
  });
  after(() => env.resetMutableState());
});


describe('books-stats-manga', () => {
  /**
   * Books stats: manga/comics filter (default OFF), tri-state null survival,
   * cross-source dedupe (LiveLib + Google Books = one work) and schema
   * compatibility of the existing payload.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

  const bookCache = require('../server/books/book-cache');
  const { buildBooksStats } = require('../server/books/stats');
  const { portFor } = require('./helpers/port');

  const PORT = portFor(70);

  async function details(workId, doc) {
    await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), {
      schemaVersion: 2,
      workId,
      ...doc,
    });
  }

  async function link(bookId, workId) {
    await bookCache.saveLink(bookId, {
      schemaVersion: 2,
      livelibBookId: String(bookId),
      workId,
      method: 'isbn',
      score: 1,
      evidence: { isbn: '9780441013593' },
    });
  }

  test.before(async () => {
    await details('hc:100', {
      title: 'Дюна',
      authors: [{ name: 'Фрэнк Герберт' }],
      genres: ['Science Fiction'],
      series: [{ hcId: 5, name: 'Дюны', position: 1 }],
      pages: 512,
      publicationYear: 1965,
      publisher: 'Chilton',
      coverUrl: 'https://example.test/dune.jpg',
      metadataSources: ['hardcover'],
      sources: [{ source: 'hardcover', sourceId: '100', url: 'https://hardcover.app/books/dune' }],
      mangaComics: false,
    });
    await details('gb:vol-dupe', {
      title: 'Дюна',
      authors: [{ name: 'Фрэнк Герберт' }],
      genres: ['Science Fiction', 'Adventure'],
      pages: 704,
      publicationYear: 2016,
      publisher: 'АСТ',
      metadataSources: ['googlebooks'],
      sources: [
        { source: 'googlebooks', sourceId: 'vol-dupe', url: 'https://books.google.com/books?id=vol-dupe' },
      ],
      mangaComics: false,
    });
    await details('gb:vol-naruto', {
      title: 'Наруто',
      authors: [{ name: 'Масаси Кисимото' }],
      genres: ['Manga', 'Action'],
      series: [{ hcId: null, name: 'Наруто', position: 1 }],
      pages: 192,
      publicationYear: 1999,
      publisher: 'Jump',
      metadataSources: ['googlebooks'],
      mangaComics: true,
    });

    await link('9001', 'hc:100');
    await link('9002', 'gb:vol-dupe');
    await link('9004', 'gb:vol-naruto');

    await bookCache.saveProfile('livelib', 'tester', {
      schemaVersion: 1,
      source: 'livelib',
      userKey: 'tester',
      importedAt: '2026-10-27T00:00:00.000Z',
      events: [
        {
          id: 'll:9001',
          source: 'livelib',
          sourceBookId: '9001',
          workId: null,
          title: 'Дюна',
          authors: ['Фрэнк Герберт'],
          rating: 9,
          ratingScale: 10,
          rating10: 9,
          status: 'read',
          finishedAt: '2024-03-02',
          edition: { publisher: null, year: 2016, isbn: '9780441013593' },
        },
        {
          id: 'll:9002',
          source: 'livelib',
          sourceBookId: '9002',
          workId: null,
          title: 'Дюна',
          authors: ['Фрэнк Герберт'],
          rating: 8,
          ratingScale: 10,
          rating10: 8,
          status: 'read',
          finishedAt: '2024-03-02',
          edition: { publisher: null, year: 2016, isbn: null },
        },
        {
          id: 'll:9003',
          source: 'livelib',
          sourceBookId: '9003',
          workId: null,
          title: 'Неизвестная книга',
          authors: ['Никто Никтович'],
          rating: 5,
          ratingScale: 10,
          rating10: 5,
          status: 'read',
          finishedAt: '2024-03-04',
          edition: { publisher: null, year: 2020, isbn: null },
        },
        {
          id: 'll:9004',
          source: 'livelib',
          sourceBookId: '9004',
          workId: null,
          title: 'Наруто',
          authors: ['Масаси Кисимото'],
          rating: 7,
          ratingScale: 10,
          rating10: 7,
          status: 'read',
          finishedAt: '2024-03-03',
          edition: { publisher: null, year: 1999, isbn: null },
        },
      ],
    });

    await bookCache.saveProfile('hardcover', '34748', {
      schemaVersion: 1,
      source: 'hardcover',
      userKey: '34748',
      importedAt: '2026-10-27T00:00:00.000Z',
      events: [
        {
          id: 'hc:read:1',
          source: 'hardcover',
          sourceBookId: '100',
          workId: 'hc:100',
          title: 'Dune',
          authors: ['Фрэнк Герберт'],
          rating: 4.5,
          ratingScale: 5,
          rating10: 9,
          status: 'read',
          finishedAt: '2023-01-10',
          edition: { publisher: null, year: 1965, isbn: null },
        },
      ],
    });
    bookCache.flushLinks();
  });

  test('default payload excludes manga works but keeps unknown flags', () => {
    const stats = buildBooksStats({ profile: 'livelib-tester' });
    assert.equal(stats.summary.includeMangaComics, false);
    assert.equal(stats.summary.mangaExcluded, 1);
    assert.equal(stats.summary.bookCount, 3);
    assert.equal(stats.summary.eventCount, 3);
    assert.equal(Object.keys(stats.booksIndex).length, stats.summary.bookCount);

    assert.equal(stats.booksIndex['gb:vol-naruto'], undefined);
    assert.equal(stats.booksIndex['ll:9003'] !== undefined, true);

    assert.equal(stats.genres.some((entry) => entry.name === 'Manga'), false);
    assert.equal(stats.authors.some((entry) => entry.name === 'Масаси Кисимото'), false);
    assert.equal(stats.series.some((entry) => entry.name === 'Наруто'), false);
    assert.equal(stats.years.some((entry) => entry.year === 1999), false);
    assert.equal(stats.readDays.some((entry) => entry.date === '2024-03-03'), false);

    // LL stub with mangaComics=null survives the default filter.
    assert.equal(stats.booksIndex['ll:9003'].mangaComics, null);
    assert.equal(stats.unmatchedCount, 1);
    // Metadata resolved counts: 9001 (hc), 9002 (gb, deduped into hc), 9004 is
    // filtered out with its manga work; 9003 has no metadata.
    assert.equal(stats.summary.resolvedCount, 2);
    assert.equal(stats.summary.unresolvedCount, 1);
  });

  test('includeMangaComics=1 brings manga back into every widget', () => {
    const stats = buildBooksStats({ profile: 'livelib-tester', includeMangaComics: true });
    assert.equal(stats.summary.includeMangaComics, true);
    assert.equal(stats.summary.mangaExcluded, 0);
    assert.equal(stats.summary.bookCount, 4);
    assert.equal(stats.summary.eventCount, 4);
    assert.equal(Object.keys(stats.booksIndex).length, 4);
    assert.ok(stats.genres.some((entry) => entry.name === 'Manga'));
    assert.ok(stats.authors.some((entry) => entry.name === 'Масаси Кисимото'));
    assert.ok(stats.readDays.some((entry) => entry.date === '2024-03-03'));
  });

  test('works linked to different metadata docs stay separate (no stats-level union)', () => {
    for (const options of [{}, { includeMangaComics: true }]) {
      const stats = buildBooksStats({ profile: 'livelib-tester', ...options });
      // Two LiveLib books resolved by the metadata chain to different works are
      // two works. Stats must not re-merge them by title — that was the union
      // model's job and it is gone.
      const dune = stats.booksIndex['hc:100'];
      const gbDune = stats.booksIndex['gb:vol-dupe'];
      assert.ok(dune);
      assert.ok(gbDune);
      assert.equal(dune.mergedWorkIds, undefined);
      assert.deepEqual(dune.sources, ['livelib']);
      assert.deepEqual(dune.metadataSources, ['hardcover']);
      assert.deepEqual(gbDune.metadataSources, ['googlebooks']);
      assert.equal(dune.pages, 512);
      assert.equal(gbDune.pages, 704);
      assert.equal(stats.genres.find((entry) => entry.name === 'Science Fiction').count, 2);
    }
  });

  test('HTTP route: includeMangaComics default off, 1 includes, invalid rejected', async (t) => {
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
    const base = `http://127.0.0.1:${PORT}/api/books/stats?profile=livelib-tester`;

    const off = await fetch(base);
    assert.equal(off.status, 200);
    const offBody = await off.json();
    assert.equal(offBody.summary.includeMangaComics, false);
    assert.equal(offBody.summary.mangaExcluded, 1);
    assert.equal(offBody.booksIndex['gb:vol-naruto'], undefined);

    const on = await fetch(`${base}&includeMangaComics=1`);
    assert.equal(on.status, 200);
    const onBody = await on.json();
    assert.equal(onBody.summary.includeMangaComics, true);
    assert.ok(onBody.booksIndex['gb:vol-naruto']);

    const bad = await fetch(`${base}&includeMangaComics=2`);
    assert.equal(bad.status, 400);
    const badBody = await bad.json();
    assert.equal(badBody.code, 'invalid_include_manga');
  });

  test('volume markers keep different books apart in the dedupe key', () => {
    const { canonicalKeyOf } = require('../server/books/stats');
    const base = { authors: ['Масаси Кисимото'] };
    const volume1 = canonicalKeyOf({ ...base, title: 'Наруто. Том 1' });
    const volume2 = canonicalKeyOf({ ...base, title: 'Наруто. Том 2' });
    assert.notEqual(volume1, volume2);
    const volume1en = canonicalKeyOf({ ...base, title: 'Naruto, Vol. 1' });
    const volume1long = canonicalKeyOf({ ...base, title: 'Naruto, Volume 1' });
    assert.equal(volume1en, volume1long);
    assert.notEqual(
      canonicalKeyOf({ ...base, title: 'Naruto, Volume 1' }),
      canonicalKeyOf({ ...base, title: 'Naruto, Volume 2' })
    );
    assert.equal(
      canonicalKeyOf({ title: 'Дюна', authors: ['Фрэнк Герберт'] }),
      canonicalKeyOf({ title: 'Дюна', authors: ['Фрэнк Герберт'] })
    );
  });

  test('litres works are metadata-resolved and outrank Google/OL in dedupe', async () => {
    const { workMetadata, mergeWorkGroup } = require('../server/books/stats');
    await details('lr:500', {
      title: 'Игрок',
      authors: [{ name: 'Фёдор Достоевский' }],
      genres: ['классическая литература'],
      series: [],
      pages: 256,
      publicationYear: 2014,
      publisher: 'АСТ',
      metadataSources: ['litres'],
      sources: [{ source: 'litres', sourceId: '500', url: 'https://www.litres.ru/book/igrok-500/' }],
      mangaComics: false,
    });
    const meta = workMetadata('lr:500', [
      {
        id: 'll:500',
        source: 'livelib',
        sourceBookId: '500',
        workId: 'lr:500',
        title: 'Игрок',
        authors: ['Фёдор Достоевский'],
        rating10: 9,
        ratingScale: 10,
        finishedAt: '2024-05-01',
      },
    ]);
    assert.equal(meta.unresolved, false);
    assert.deepEqual(meta.metadataSources, ['litres']);
    assert.equal(meta.links.litres, 'https://www.litres.ru/book/igrok-500/');
    assert.equal(meta.mangaComics, false);
    assert.equal(meta.pages, 256);

    const gb = { workId: 'gb:1', title: 'Игрок', authors: ['Фёдор Достоевский'], unresolved: false };
    const lr = { workId: 'lr:500', title: 'Игрок', authors: ['Фёдор Достоевский'], unresolved: false };
    assert.equal(mergeWorkGroup([gb, lr]).workId, 'lr:500');
  });

  test('payload schema stays compatible: single-profile fields keep their place', () => {
    const stats = buildBooksStats({ profile: 'livelib-tester' });
    for (const key of [
      'sources',
      'summary',
      'ratings',
      'genres',
      'decades',
      'years',
      'timeline',
      'readDays',
      'streaks',
      'recentlyFinished',
      'authors',
      'series',
      'pagesHistogram',
      'booksIndex',
      'unmatchedCount',
      'unmatched',
      'meta',
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(stats, key), `missing ${key}`);
    }
    assert.equal(stats.ratings.scale, 10);
    assert.deepEqual(stats.sources.connected.sort(), ['hardcover', 'livelib']);
    assert.deepEqual(stats.sources.selected, ['livelib']);
    assert.equal(stats.sources.profile.key, 'livelib-tester');
    assert.equal('filter' in stats.sources, false);
    assert.equal('bySource' in stats.ratings, false);
    assert.deepEqual(stats.summary.sources, ['livelib']);
    assert.equal(stats.sourceBreakdown, undefined);
    assert.equal(stats.ratings.merged.length > 0, true);
    // Extension only: new fields are additive.
    assert.equal(typeof stats.summary.mangaExcluded, 'number');
    assert.equal(typeof stats.summary.canonicalResolvedCount, 'number');
    const dune = stats.booksIndex['hc:100'];
    assert.equal(Array.isArray(dune.metadataSources), true);
    assert.equal(dune.mangaComics, false);
  });
  after(() => env.resetMutableState());
});
