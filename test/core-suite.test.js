'use strict';

/**
 * Core modules, films and cross-domain helpers suite: the former standalone `*.test.js` files of this domain,
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

const run = env.makeTmpCache('core-suite', { budgets: false });

after(() => {
  env.cleanupTmpDirs();
});

process.on('exit', () => {
  env.cleanupTmpDirs();
});


describe('profiles-unified-form', () => {
  /**
   * U8 contract: `GET /api/{films,books,games}/profiles` return ONE owner shape.
   *
   * The round is additive by design: the three legacy payloads were frozen by
   * their own tests and clients, so nothing is removed or renamed. Every profile
   * entry gains
   *
   *     id, label, primary { source, userKey, status, updatedAt },
   *     enrichers[], metrics
   *
   * and the object-shaped endpoints (books, games) gain a top-level `sources`
   * table. The films endpoint stays a flat array (`public/js/compare.js` reads it
   * as an array), so its sources are visible per entry only.
   *
   * The test boots the real `server/index.js` on a free port over a fresh tmp
   * cache: this is also the boot smoke for the three endpoints (no live source,
   * no token value — the TMDB token is a fake env value, the Steam key is
   * `/dev/null`).
   *
   * Assertions are exact for the legacy values (the point of the round) and
   * structural for the new ones (type + derivation), never "approximately".
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');

  // 1. Tmp caches + inert budgets BEFORE any `server/**` module is required.
  const env = require('./helpers/env');
  const { portFor } = require('./helpers/port');
  const PORT = portFor(270);
  const tmp = env.currentDirs();
  process.env.TMDB_API_TOKEN = 'fake-tmdb-token-for-tests';
  delete process.env.KINOBOXD_PASSWORD;
  delete process.env.STEAM_API_KEY;
  process.env.PORT = String(PORT);

  // 2. Only now the modules under test.
  const seed = require('./golden/seed');
  const cache = require('../server/cache');
  const bookCache = require('../server/books/book-cache');
  const gameCache = require('../server/games/game-cache');
  const gogCache = require('../server/games/gog-cache');

  const BASE = `http://127.0.0.1:${PORT}`;

  const FILMS_USER = '7654321';
  const FILMS_PROFILE_KEY = `kinopoisk-${FILMS_USER}`;

  function writeJson(filePath, doc) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(doc), 'utf8');
  }

  function assertIsoOrNull(value, label) {
    if (value == null) return;
    assert.equal(typeof value, 'string', `${label} must be a string or null`);
    assert.equal(Number.isNaN(Date.parse(value)), false, `${label} must be a date: ${value}`);
  }

  /** Structural check of the unified owner fields on one entry. */
  function assertOwnerShape(entry, label) {
    assert.equal(typeof entry.id, 'string', `${label}.id`);
    assert.ok(entry.id.length > 0, `${label}.id is empty`);
    assert.ok(entry.label === null || typeof entry.label === 'string', `${label}.label`);

    assert.equal(typeof entry.primary, 'object', `${label}.primary`);
    assert.equal(typeof entry.primary.source, 'string', `${label}.primary.source`);
    assert.ok(
      entry.primary.userKey === null || typeof entry.primary.userKey === 'string',
      `${label}.primary.userKey`
    );
    assert.ok(['connected', 'expired'].includes(entry.primary.status), `${label}.primary.status`);
    assertIsoOrNull(entry.primary.updatedAt, `${label}.primary.updatedAt`);

    assert.ok(Array.isArray(entry.enrichers), `${label}.enrichers`);
    for (const [index, enricher] of entry.enrichers.entries()) {
      assert.equal(typeof enricher.source, 'string', `${label}.enrichers[${index}].source`);
      assert.ok(['connected', 'expired'].includes(enricher.status), `${label}.enrichers[${index}].status`);
      assertIsoOrNull(enricher.updatedAt, `${label}.enrichers[${index}].updatedAt`);
    }

    assert.equal(typeof entry.metrics, 'object', `${label}.metrics`);
    assert.ok(entry.metrics !== null && !Array.isArray(entry.metrics), `${label}.metrics`);
  }

  function assertSourceTable(sources, expected) {
    assert.ok(Array.isArray(sources), 'sources must be an array');
    const byId = new Map(sources.map((source) => [source.id, source]));
    for (const [id, role] of Object.entries(expected)) {
      const source = byId.get(id);
      assert.ok(source, `sources must list "${id}"`);
      assert.equal(source.role, role, `sources["${id}"].role`);
      assert.equal(typeof source.connected, 'boolean', `sources["${id}"].connected`);
      assert.ok(['ready', 'expired', 'missing'].includes(source.state), `sources["${id}"].state`);
    }
    return byId;
  }

  test('the three /profiles endpoints share one owner shape and keep their legacy fields', async (t) => {
    /* ----------------------------- seeds ----------------------------- */

    // Films: one cached KP profile + a Letterboxd attachment (the enricher).
    writeJson(path.join(cache.CACHE_DIR, 'kp', `${FILMS_USER}.json`), {
      kpNick: 'kp-tester',
      entries: [
        { kpId: 1, rating: 8 },
        { kpId: 2, rating: null },
        { kpId: 1, rating: 9 }, // duplicate kpId: counted once, rating kept
      ],
    });
    writeJson(path.join(cache.CACHE_DIR, 'profile-lb', `${FILMS_USER}.json`), { films: [] });

    // Books: the golden LiveLib profile (a real document, one owner = one source).
    const booksSeed = await seed.seedBooks(bookCache);

    // Games: the golden Steam profile + library, plus a GOG account bound to it.
    const gamesSeed = await seed.seedGames(gameCache);
    const gamesOwnerKey = gamesSeed.profileKey;
    const gogUserKey = '1234567890';
    gogCache.saveToken(gogUserKey, {
      accessToken: 'gog-secret-access-token',
      refreshToken: 'gog-secret-refresh-token',
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      ownerProfile: gamesOwnerKey,
      connectedAt: '2026-10-30T10:00:00.000Z',
      username: 'gog-tester',
    });

    /* ----------------------------- boot ------------------------------ */

    const { server } = require('../server/index');
    await new Promise((resolve, reject) => {
      if (server.listening) return resolve();
      server.once('listening', resolve);
      server.once('error', reject);
    });
    t.after(async () => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      tmp.cleanup();
    });

    /* ----------------------------- films ----------------------------- */

    const filmsResponse = await fetch(`${BASE}/api/profiles`);
    assert.equal(filmsResponse.status, 200);
    const films = await filmsResponse.json();
    assert.ok(Array.isArray(films), 'GET /api/profiles stays a flat array');

    assert.equal(films.length, 1);
    const film = films[0];
    // Legacy fields, exact values.
    assert.deepEqual(
      {
        kpUserId: film.kpUserId,
        nick: film.nick,
        entries: film.entries,
        attachedLb: film.attachedLb,
        ratedCount: film.ratedCount,
      },
      { kpUserId: FILMS_USER, nick: 'kp-tester', entries: 2, attachedLb: true, ratedCount: 1 }
    );
    // Unified fields.
    assertOwnerShape(film, 'films[0]');
    assert.equal(film.id, FILMS_PROFILE_KEY);
    assert.equal(film.label, null, 'the server has never stored a film label');
    assert.equal(film.primary.source, 'kinopoisk');
    assert.equal(film.primary.userKey, FILMS_USER);
    assert.equal(film.primary.status, 'connected');
    assert.ok(film.primary.updatedAt, 'the kp cache file mtime is the honest updatedAt');
    assert.deepEqual(film.enrichers.map((entry) => entry.source), ['letterboxd']);
    assert.deepEqual(film.metrics, { entries: 2, ratedCount: 1 });

    /* ----------------------------- books ----------------------------- */

    const booksResponse = await fetch(`${BASE}/api/books/profiles`);
    assert.equal(booksResponse.status, 200);
    const books = await booksResponse.json();

    // Legacy fields.
    assert.equal(books.profiles.length, 1);
    assert.deepEqual(books.connected, ['livelib']);
    assert.deepEqual(books.availableProfileKeys, [booksSeed.profile]);
    assert.equal(typeof books.hardcoverToken, 'object');
    assert.equal(typeof books.hardcoverToken.configured, 'boolean');
    assert.equal(books.cacheDir, bookCache.BOOK_CACHE_DIR);
    const bookProfile = books.profiles[0];
    assert.equal(bookProfile.key, booksSeed.profile);
    assert.equal(bookProfile.sourceKey, 'livelib/golden');
    assert.equal(typeof bookProfile.summary, 'object');
    assert.equal(typeof bookProfile.summary.eventCount, 'number');
    assert.equal(bookProfile.deepScan, null);
    assert.deepEqual(bookProfile.cookies, { present: false, savedAt: null, count: 0 });

    // Unified fields.
    assertOwnerShape(bookProfile, 'books.profiles[0]');
    assert.equal(bookProfile.id, booksSeed.profile, 'the books id is the ?profile= token');
    assert.equal(bookProfile.label, null, 'book labels live in the browser registry only');
    assert.equal(bookProfile.primary.source, 'livelib');
    assert.equal(bookProfile.primary.userKey, 'golden');
    assert.equal(bookProfile.primary.updatedAt, bookProfile.importedAt);
    assert.deepEqual(bookProfile.enrichers, [], 'one owner = one journal, no merged events');
    assert.deepEqual(bookProfile.metrics, bookProfile.summary, 'metrics carries the summary numbers');

    const bookSources = assertSourceTable(books.sources, { livelib: 'primary', hardcover: 'primary' });
    assert.equal(bookSources.get('livelib').connected, true);
    assert.equal(bookSources.get('livelib').state, 'ready');
    assert.equal(bookSources.get('hardcover').connected, false);
    assert.equal(bookSources.get('hardcover').state, 'missing');

    /* ----------------------------- games ----------------------------- */

    const gamesResponse = await fetch(`${BASE}/api/games/profiles`);
    assert.equal(gamesResponse.status, 200);
    const games = await gamesResponse.json();

    // Legacy fields.
    assert.deepEqual(games.connected, ['steam', 'gog']);
    assert.deepEqual(games.availableProfileKeys, [gamesOwnerKey]);
    assert.deepEqual(games.steamKey, { configured: false, source: null });
    assert.equal(games.gog.accounts, 1);
    assert.equal(games.cacheDir, gameCache.GAMES_CACHE_DIR);
    assert.equal(typeof games.libraryTtlHours, 'number');
    const gameProfile = games.profiles[0];
    assert.equal(gameProfile.key, gamesOwnerKey);
    assert.equal(typeof gameProfile.summary.gameCount, 'number');
    assert.equal(gameProfile.libraries.length, 1);
    assert.equal(gameProfile.libraries[0].source, 'gog');
    assert.equal(gameProfile.libraries[0].userKey, gogUserKey);

    // Unified fields.
    assertOwnerShape(gameProfile, 'games.profiles[0]');
    assert.equal(gameProfile.id, gamesOwnerKey);
    assert.equal(gameProfile.label, null, 'the golden profile was imported without a label');
    assert.equal(gameProfile.primary.source, 'steam');
    assert.equal(gameProfile.primary.userKey, gameProfile.userKey);
    assert.equal(gameProfile.primary.updatedAt, gameProfile.importedAt);
    assert.deepEqual(
      gameProfile.enrichers.map((entry) => [entry.source, entry.userKey, entry.status]),
      [['gog', gogUserKey, 'connected']]
    );
    assert.deepEqual(gameProfile.metrics, gameProfile.summary);

    const gameSources = assertSourceTable(games.sources, {
      steam: 'primary',
      gog: 'enricher',
      epic: 'enricher',
    });
    assert.equal(gameSources.get('gog').connected, true);
    assert.equal(gameSources.get('gog').state, 'ready');
    assert.equal(gameSources.get('epic').connected, false);
    assert.equal(gameSources.get('epic').state, 'missing');

    /* ------------------- no secret value in any payload ---------------- */

    const serialized = JSON.stringify({ films, books, games });
    assert.equal(serialized.includes('gog-secret-access-token'), false);
    assert.equal(serialized.includes('gog-secret-refresh-token'), false);
  });
  after(() => env.resetMutableState());
});


describe('core-breaker', () => {
  /**
   * `core/breaker.js` — the one breaker implementation.
   *
   * Two contracts are pinned:
   *   - memory mode (book providers): trip/isOpen/reset with an injectable clock;
   *   - persisted mode (games): the on-disk entry shape does not change, an
   *     expired entry is pruned and written back, and the custom ISO
   *     `{ until, at, code, status }` shape of secondary-details round-trips.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');

  const { createBreaker, toEpoch } = require('../server/core/breaker');

  test('memory breaker: trip opens it for the cooldown, reset closes it', () => {
    let clock = 1_000_000;
    const breaker = createBreaker({ now: () => clock, cooldownMs: 1000 });
    assert.equal(breaker.isOpen('x'), false);
    const entry = breaker.trip('x', 'HTTP 429');
    assert.equal(entry.until, clock + 1000);
    assert.equal(entry.reason, 'HTTP 429');
    assert.equal(breaker.isOpen('x'), true);
    assert.equal(breaker.entry('x').until, clock + 1000);

    clock += 999;
    assert.equal(breaker.isOpen('x'), true);
    clock += 1;
    assert.equal(breaker.isOpen('x'), false);
    assert.equal(breaker.entry('x'), null);

    breaker.trip('x', 'blocked');
    breaker.reset('x');
    assert.equal(breaker.isOpen('x'), false);
  });

  test('memory breaker: cooldown can be a function and per-trip untilMs wins', () => {
    let clock = 0;
    let windowMs = 500;
    const breaker = createBreaker({ now: () => clock, cooldownMs: () => windowMs });
    breaker.trip('a');
    assert.equal(breaker.entry('a').until, 500);
    windowMs = 2000;
    breaker.trip('b', { untilMs: 100 });
    assert.equal(breaker.entry('b').until, 100);
  });

  test('a zero window expires immediately (0 = breaker off)', () => {
    let clock = 1000;
    const breaker = createBreaker({ now: () => clock, cooldownMs: 0 });
    const entry = breaker.trip('x');
    assert.equal(entry.until, clock);
    assert.equal(breaker.isOpen('x'), false, 'until == now is already expired');

    // A per-trip zero overrides a positive default too.
    const other = createBreaker({ now: () => clock, cooldownMs: 5000 });
    other.trip('y', { untilMs: 0 });
    assert.equal(other.isOpen('y'), false);
    other.trip('z');
    assert.equal(other.isOpen('z'), true);
  });

  test('persisted breaker keeps the epoch {until, reason, at} format', () => {
    let clock = 5_000;
    let disk = {};
    const writes = [];
    const breaker = createBreaker({
      now: () => clock,
      cooldownMs: 30 * 60 * 1000,
      read: () => disk,
      write: (state) => {
        disk = JSON.parse(JSON.stringify(state));
        writes.push(disk);
      },
    });

    breaker.trip('steamcommunity.com', 'HTTP 403');
    assert.deepEqual(disk, {
      'steamcommunity.com': {
        until: clock + 30 * 60 * 1000,
        reason: 'HTTP 403',
        at: clock,
      },
    });
    assert.equal(breaker.isOpen('steamcommunity.com'), true);

    // An expired entry is pruned and the pruning is persisted.
    clock += 30 * 60 * 1000;
    assert.equal(breaker.isOpen('steamcommunity.com'), false);
    assert.deepEqual(disk, {});
    assert.equal(writes.length, 2);
  });

  test('persisted breaker: replace/reset/state use raw state', () => {
    let disk = {};
    const breaker = createBreaker({
      now: () => 1000,
      read: () => disk,
      write: (state) => {
        disk = state;
      },
    });
    breaker.replace({ host: { until: 2000, reason: 'HTTP 429', at: 10 } });
    assert.deepEqual(breaker.state(), {
      host: { until: 2000, at: 10, reason: 'HTTP 429', code: null, status: null },
    });
    breaker.reset();
    assert.deepEqual(disk, {});
  });

  test('secondary-details ISO format round-trips code and status', () => {
    let disk = {};
    const isoEncode = (entry) => ({
      until: new Date(entry.until).toISOString(),
      at: new Date(entry.at).toISOString(),
      code: entry.code || 'blocked',
      status: entry.status == null ? null : entry.status,
    });
    const isoDecode = (raw) => {
      const until = toEpoch(raw && raw.until);
      if (until == null) return null;
      return {
        until,
        at: toEpoch(raw.at),
        reason: raw.code || null,
        code: raw.code || null,
        status: raw.status == null ? null : raw.status,
      };
    };
    let clock = Date.UTC(2026, 10, 3);
    const breaker = createBreaker({
      now: () => clock,
      cooldownMs: 30 * 60 * 1000,
      read: () => disk,
      write: (state) => {
        disk = state;
      },
      encode: isoEncode,
      decode: isoDecode,
    });
    breaker.trip('epic', { code: 'cms_blocked', status: 403 });
    assert.equal(typeof disk.epic.until, 'string');
    assert.equal(disk.epic.code, 'cms_blocked');
    assert.equal(disk.epic.status, 403);
    assert.equal(breaker.entry('epic').code, 'cms_blocked');
    assert.equal(breaker.entry('epic').until, clock + 30 * 60 * 1000);
  });

  test('toEpoch accepts epoch numbers, numeric strings and ISO strings', () => {
    assert.equal(toEpoch(1234), 1234);
    assert.equal(toEpoch('1234'), 1234);
    assert.equal(toEpoch('2026-11-03T00:00:00.000Z'), Date.UTC(2026, 10, 3));
    assert.equal(toEpoch(null), null);
    assert.equal(toEpoch('nonsense'), null);
  });
  after(() => env.resetMutableState());
});


describe('core-budget', () => {
  /**
   * `core/budget.js` — one counter implementation for every source.
   *
   * The old copies in the three book providers and `games/enrich.js` were
   * byte-identical; this test pins the contract they shared (limit parsing,
   * `take()` idempotence, `remaining`) plus the two env readers.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');

  const {
    createBudget,
    budgetLimitFromEnv,
    budgetFromEnv,
    usedOf,
    budgetRefused,
  } = require('../server/core/budget');

  test('createBudget: parses the limit, floors fractions and stops at zero', () => {
    const budget = createBudget('2.9');
    assert.equal(budget.limit, 2);
    assert.equal(budget.used, 0);
    assert.equal(budget.remaining, 2);
    assert.equal(budget.take(), true);
    assert.equal(budget.take(), true);
    assert.equal(budget.take(), false);
    assert.equal(budget.used, 2);
    assert.equal(budget.remaining, 0);
  });

  test('createBudget: a missing/junk limit falls back to the caller default', () => {
    assert.equal(createBudget(undefined, 300).limit, 300);
    assert.equal(createBudget('nope', 200).limit, 200);
    assert.equal(createBudget(-1, 340).limit, 340);
    assert.equal(createBudget(0, 300).limit, 0);
    assert.equal(createBudget(0, 300).take(), false);
  });

  test('budgetLimitFromEnv reads a finite non-negative number at call time', () => {
    const previous = process.env.BOOKS_GB_BUDGET;
    try {
      process.env.BOOKS_GB_BUDGET = '7';
      assert.equal(budgetLimitFromEnv('BOOKS_GB_BUDGET', 300), 7);
      process.env.BOOKS_GB_BUDGET = '0';
      assert.equal(budgetLimitFromEnv('BOOKS_GB_BUDGET', 300), 0);
      process.env.BOOKS_GB_BUDGET = 'oops';
      assert.equal(budgetLimitFromEnv('BOOKS_GB_BUDGET', 300), 300);
      delete process.env.BOOKS_GB_BUDGET;
      assert.equal(budgetLimitFromEnv('BOOKS_GB_BUDGET', 300), 300);
    } finally {
      if (previous == null) delete process.env.BOOKS_GB_BUDGET;
      else process.env.BOOKS_GB_BUDGET = previous;
    }
  });

  test('budgetRefused separates "no match" from "budget is gone"', () => {
    const budget = createBudget(1);
    assert.equal(usedOf(null), null);
    assert.equal(usedOf(budget), 0);
    assert.equal(budgetRefused(budget, 0), false);
    budget.take();
    // The call consumed the unit: a null answer is a real miss, not a refusal.
    assert.equal(budgetRefused(budget, 0), false);
    // The next call sees `used` unchanged and `remaining === 0`: it was refused.
    assert.equal(budgetRefused(budget, 1), true);
    assert.equal(budgetRefused(null, 0), false);
  });

  test('budgetFromEnv returns a fresh counter with the env limit', () => {
    const previous = process.env.BOOKS_LITRES_BUDGET;
    try {
      process.env.BOOKS_LITRES_BUDGET = '3';
      const budget = budgetFromEnv('BOOKS_LITRES_BUDGET', 200);
      assert.equal(budget.limit, 3);
      assert.equal(budget.take(), true);
      assert.equal(budget.used, 1);
    } finally {
      if (previous == null) delete process.env.BOOKS_LITRES_BUDGET;
      else process.env.BOOKS_LITRES_BUDGET = previous;
    }
  });
  after(() => env.resetMutableState());
});


describe('core-date', () => {
  const test = require('node:test');
  const assert = require('node:assert/strict');

  test('dateParts: unanchored (default) accepts a date prefix in a timestamp', async () => {
    const { dateParts } = await import('../public/js/core/date.js');
    assert.deepEqual(dateParts('2024-05-06'), { year: 2024, month: 5, day: 6 });
    assert.deepEqual(dateParts('2024-05-06T10:00:00Z'), { year: 2024, month: 5, day: 6 });
    assert.equal(dateParts(''), null);
    assert.equal(dateParts(null), null);
    assert.equal(dateParts('garbage'), null);
  });

  test('dateParts: anchored mode rejects trailing characters', async () => {
    const { dateParts } = await import('../public/js/core/date.js');
    assert.deepEqual(dateParts('2024-05-06', true), { year: 2024, month: 5, day: 6 });
    assert.deepEqual(dateParts('2024-05-06', { anchored: true }), { year: 2024, month: 5, day: 6 });
    assert.equal(dateParts('2024-05-06T10:00:00Z', true), null);
    assert.equal(dateParts('2024-05-06T10:00:00Z', { anchored: true }), null);
    assert.equal(dateParts('', true), null);
    assert.equal(dateParts(null, true), null);
    assert.equal(dateParts('garbage', true), null);
  });

  test('fmtDayRu / fmtDayShortRu follow anchoring', async () => {
    const { fmtDayRu, fmtDayShortRu } = await import('../public/js/core/date.js');
    assert.equal(fmtDayRu('2024-05-06'), '6 мая 2024');
    assert.equal(fmtDayRu('2024-05-06T10:00:00Z'), '6 мая 2024');
    assert.equal(fmtDayRu('2024-05-06T10:00:00Z', true), '2024-05-06T10:00:00Z');
    assert.equal(fmtDayShortRu('2024-05-06'), '6 мая 2024');
    assert.equal(fmtDayShortRu('garbage'), 'garbage');
  });

  test('dayIndex and dayNumber numeric values', async () => {
    const { dayIndex, dayNumber } = await import('../public/js/core/date.js');
    assert.equal(dayIndex('2024-05-06'), 19849);
    assert.equal(dayNumber('2024-05-06'), 19849);
    assert.equal(dayNumber('2024-05-06T10:00:00Z'), 19849);
    assert.equal(dayIndex('2024-05-06T10:00:00Z'), null);
  });

  test('normalizeFilmStreaks: empty input', async () => {
    const { normalizeFilmStreaks } = await import('../public/js/core/streaks.js');
    assert.deepEqual(normalizeFilmStreaks(null, []), { current: 0, best: 0, lastWatchDate: null, bestDates: [] });
    assert.deepEqual(normalizeFilmStreaks({}, []), { current: 0, best: 0, lastWatchDate: null, bestDates: [] });
  });

  test('normalizeFilmStreaks: single streak', async () => {
    const { normalizeFilmStreaks } = await import('../public/js/core/streaks.js');
    const r = normalizeFilmStreaks(null, [{ date: '2024-05-06' }]);
    assert.equal(r.current, 1);
    assert.equal(r.best, 1);
    assert.equal(r.lastWatchDate, '2024-05-06');
  });

  test('normalizeFilmStreaks: gaps', async () => {
    const { normalizeFilmStreaks } = await import('../public/js/core/streaks.js');
    const r = normalizeFilmStreaks(null, [{ date: '2024-05-06' }, { date: '2024-05-07' }, { date: '2024-05-10' }]);
    assert.equal(r.best, 2);
    assert.equal(r.current, 1);
  });

  test('normalizeGameStreaks: empty input returns null', async () => {
    const { normalizeGameStreaks } = await import('../public/js/core/streaks.js');
    assert.equal(normalizeGameStreaks(null, []), null);
    assert.equal(normalizeGameStreaks(null, null), null);
  });

  test('normalizeGameStreaks: single streak', async () => {
    const { normalizeGameStreaks } = await import('../public/js/core/streaks.js');
    const r = normalizeGameStreaks(null, [{ date: '2024-05-06' }]);
    assert.equal(r.current, 1);
    assert.equal(r.best, 1);
    assert.equal(r.lastUnlockDate, '2024-05-06');
  });

  test('normalizeGameStreaks: gaps', async () => {
    const { normalizeGameStreaks } = await import('../public/js/core/streaks.js');
    const r = normalizeGameStreaks(null, [{ date: '2024-05-06' }, { date: '2024-05-07' }, { date: '2024-05-10' }]);
    assert.equal(r.best, 2);
    assert.equal(r.current, 1);
  });
  after(() => env.resetMutableState());
});


describe('core-error-mapping', () => {
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { once } = require('node:events');
  const express = require('express');

  const CACHE_DIR = run.cacheGamesDir;
  const BOOK_CACHE_DIR = run.cacheBookDir;
  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;
  process.env.KINOBOXD_GAMES_WD = 'off';
  process.env.KINOBOXD_STEAM_KEY_FILE = path.join(process.env.KINOBOXD_STATE_DIR, 'no-steam-token');
  process.env.KINOBOXD_MOBY_KEY_FILE = path.join(process.env.KINOBOXD_STATE_DIR, 'no-moby-token');

  const { HttpError, errorMiddleware } = require('../server/core/errors');

  const booksImport = require('../server/books/import');
  const livelibCookies = require('../server/books/livelib-cookies');
  const { LivelibError } = require('../server/books/livelib');
  const { HardcoverError } = require('../server/books/hardcover');
  const booksRoutes = require('../server/books/routes');

  const gameCache = require('../server/games/game-cache');
  const steam = require('../server/games/steam');
  const store = require('../server/games/store');
  const spy = require('../server/games/spy');
  const epic = require('../server/games/epic');
  const gog = require('../server/games/gog');
  const franchise = require('../server/games/franchise');
  const { PersonnelError } = require('../server/games/personnel/identity');
  const gamesRoutes = require('../server/games/routes');
  const epicRoutes = require('../server/games/routes-epic');
  const gogRoutes = require('../server/games/routes-gog');
  const franchiseRoutes = require('../server/games/routes-franchise');
  const personnelRoutes = require('../server/games/personnel/routes-personnel');

  const ID = '76561198000000021';
  const PROFILE = `steam-${ID}`;
  const APPID = 620;

  let seeded = null;

  function ensureSeed() {
    if (!seeded) {
      const now = new Date().toISOString();
      seeded = (async () => {
        await gameCache.saveProfile({
          userKey: ID,
          personaName: 'error mapping',
          privacy: 'public',
          importedAt: now,
          fetchedAt: now,
        });
        await gameCache.saveLibrary(ID, {
          fetchedAt: now,
          partial: false,
          game_count: 1,
          games: [{ appid: APPID, name: 'Portal 2', playtime_forever: 600 }],
        });
      })();
    }
    return seeded;
  }

  async function mount(t, prefix, router) {
    const app = express();
    app.use(express.json());
    app.use(prefix, router);
    app.use(errorMiddleware);
    const server = app.listen(0);
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}${prefix}`;
  }

  function patch(target, key, value) {
    const original = target[key];
    target[key] = value;
    return () => {
      target[key] = original;
    };
  }

  async function expectError(t, response, status, code, message) {
    assert.equal(response.status, status);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['code', 'error']);
    assert.equal(body.code, code);
    if (message !== undefined) assert.equal(body.error, message);
    else assert.equal(typeof body.error, 'string');
    return body;
  }

  function throwingClient(err) {
    return { getAchievements: async () => { throw err; } };
  }

  async function gamesApp(t, client, importer) {
    return mount(t, '/api/games', gamesRoutes.createRouter({ client, importer }));
  }

  /* --------------------------------- books ---------------------------------- */

  test('books: HttpError passes through unchanged', async (t) => {
    const base = await mount(t, '/api/books', booksRoutes);
    const body = await expectError(
      t,
      await fetch(`${base}/import/status`),
      400,
      'job_id_required'
    );
    assert.match(body.error, /"id" is required/);
  });

  test('books: LivelibFileError is a 400 with its own code and message', async (t) => {
    const base = await mount(t, '/api/books', booksRoutes);
    const form = new FormData();
    form.append('filename', 'livelib-probe-read-28.10.2026.json');
    form.append('username', 'routeprobe');
    form.append('resolve', '0');
    form.append(
      'file',
      new Blob(['{'], { type: 'application/json' }),
      'livelib-probe-read-28.10.2026.json'
    );
    const body = await expectError(
      t,
      await fetch(`${base}/import/livelib-file`, { method: 'POST', body: form }),
      400,
      'livelib_file_invalid_json'
    );
    assert.ok(body.error.length > 0);
  });

  test('books: LivelibError code table', async (t) => {
    const base = await mount(t, '/api/books', booksRoutes);
    const cases = [
      ['livelib_invalid_username', 400],
      ['livelib_import_running', 409],
      ['livelib_blocked', 429],
      ['livelib_bulk_error', 404],
      ['livelib_error', 502],
      ['livelib_something_else', 502],
    ];
    for (const [code, status] of cases) {
      const restore = patch(booksImport, 'startLivelibImport', () => {
        throw new LivelibError(`livelib says ${code}`, code);
      });
      t.after(restore);
      const response = await fetch(`${base}/import/livelib`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'routeprobe' }),
      });
      await expectError(t, response, status, code, `livelib says ${code}`);
    }
  });

  test('books: HardcoverError maps token/foreign codes to 400, the rest to 502', async (t) => {
    const base = await mount(t, '/api/books', booksRoutes);
    const cases = [
      ['hardcover_token_missing', 400],
      ['hardcover_foreign_user', 400],
      ['hardcover_rate_limited', 502],
      ['hardcover_error', 502],
    ];
    for (const [code, status] of cases) {
      const restore = patch(booksImport, 'startHardcoverImport', () => {
        throw new HardcoverError(`hardcover says ${code}`, code);
      });
      t.after(restore);
      const response = await fetch(`${base}/import/hardcover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await expectError(t, response, status, code, `hardcover says ${code}`);
    }
  });

  test('books: CookieError is a 400 with its own code and message', async (t) => {
    const base = await mount(t, '/api/books', booksRoutes);
    const restore = patch(livelibCookies, 'clearCookies', async () => {
      throw new livelibCookies.CookieError('Некорректный cookie header.', 'invalid_cookie_header');
    });
    t.after(restore);
    const body = await expectError(
      t,
      await fetch(`${base}/import/livelib/cookies?userKey=routeprobe`, { method: 'DELETE' }),
      400,
      'invalid_cookie_header',
      'Некорректный cookie header.'
    );
    assert.ok(body.error.length > 0);
  });

  test('books: a plain error with a status is NOT mapped and stays a 500', async (t) => {
    const base = await mount(t, '/api/books', booksRoutes);
    const restore = patch(booksImport, 'startLivelibImport', () => {
      throw Object.assign(new Error('plain failure'), { status: 418, code: 'teapot' });
    });
    t.after(restore);
    const originalError = console.error;
    console.error = () => {};
    t.after(() => {
      console.error = originalError;
    });
    const body = await expectError(
      t,
      await fetch(`${base}/import/livelib`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'routeprobe' }),
      }),
      500,
      'internal_error'
    );
    assert.equal(body.error, 'Internal server error.');
  });

  /* --------------------------------- games ---------------------------------- */

  test('games: HttpError passes through unchanged', async (t) => {
    const base = await gamesApp(t, throwingClient(new Error('unused')));
    const body = await expectError(
      t,
      await fetch(`${base}/stats?profile=steam-nope`),
      400,
      'invalid_profile'
    );
    assert.match(body.error, /expected "steam-<steamid64>"/);
  });

  test('games: SteamError/StoreError/SpyError share one code table', async (t) => {
    await ensureSeed();
    const cases = [
      [new steam.SteamError('steam rate limited', 'steam_rate_limited'), 429],
      [new steam.SteamError('steam private', 'stats_private'), 400],
      [new steam.SteamError('steam missing', 'stats_not_found'), 404],
      [new steam.SteamError('steam unreachable', 'steam_unreachable'), 502],
      [new steam.SteamError('steam strange', 'steam_something_else'), 502],
      [new store.StoreError('store rate limited', 'store_rate_limited'), 429],
      [new store.StoreError('store invalid', 'store_invalid_appid'), 400],
      [new store.StoreError('store strange', 'store_something_else'), 502],
      [new spy.SpyError('spy rate limited', 'spy_rate_limited'), 429],
      [new spy.SpyError('spy invalid', 'spy_invalid_appid'), 400],
      [new spy.SpyError('spy strange', 'spy_something_else'), 502],
    ];
    for (const [err, status] of cases) {
      const base = await gamesApp(t, throwingClient(err));
      const response = await fetch(`${base}/achievements?profile=${PROFILE}&appid=${APPID}`);
      await expectError(t, response, status, err.code, err.message);
    }
  });

  test('games: a plain error with a status keeps its code or falls back to games_error', async (t) => {
    const withCode = await gamesApp(t, throwingClient(new Error('unused')), {
      startImport: () => {
        throw Object.assign(new Error('profile is broken'), { status: 422, code: 'invalid_profile' });
      },
    });
    await expectError(
      t,
      await fetch(`${withCode}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vanityOrId64: '76561198000000021' }),
      }),
      422,
      'invalid_profile',
      'profile is broken'
    );

    const withoutCode = await gamesApp(t, throwingClient(new Error('unused')), {
      startImport: () => {
        throw Object.assign(new Error('profile is broken'), { status: 422 });
      },
    });
    await expectError(
      t,
      await fetch(`${withoutCode}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vanityOrId64: '76561198000000021' }),
      }),
      422,
      'games_error',
      'profile is broken'
    );
  });

  /* ---------------------------------- epic ---------------------------------- */

  async function epicApp(t, err) {
    return mount(t, '/api/games', epicRoutes.createRouter({
      auth: {
        connectWithCode: async () => {
          throw err;
        },
      },
    }));
  }

  function epicConnect(base) {
    return fetch(`${base}/epic/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'probe' }),
    });
  }

  test('epic: HttpError passes through unchanged', async (t) => {
    const base = await mount(t, '/api/games', epicRoutes.createRouter({
      auth: { connectWithCode: async () => ({}) },
    }));
    await expectError(
      t,
      await fetch(`${base}/epic/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      400,
      'epic_code_required'
    );
  });

  test('epic: EpicError code table, explicit status and default 502', async (t) => {
    const cases = [
      [new epic.EpicError('epic pending', 'epic_auth_pending'), 409],
      [new epic.EpicError('epic expired', 'epic_auth_expired'), 401],
      [new epic.EpicError('epic rate limited', 'epic_rate_limited'), 429],
      [new epic.EpicError('epic strange', 'epic_something_else'), 502],
      [new epic.EpicError('epic explicit', 'epic_rate_limited', { status: 503 }), 503],
      [new epic.EpicError('epic token store', 'epic_token_store_error'), 500],
    ];
    for (const [err, status] of cases) {
      const base = await epicApp(t, err);
      await expectError(t, await epicConnect(base), status, err.code, err.message);
    }
  });

  test('epic: message is masked and an empty message becomes "Epic error"', async (t) => {
    const masked = await epicApp(
      t,
      new epic.EpicError('failed: bearer eg1~TOPSECRET', 'epic_import_failed')
    );
    const body = await expectError(t, await epicConnect(masked), 502, 'epic_import_failed');
    assert.equal(body.error.includes('TOPSECRET'), false);
    assert.match(body.error, /bearer \*\*\*/);

    const empty = await epicApp(t, new epic.EpicError('', 'epic_import_failed'));
    await expectError(t, await epicConnect(empty), 502, 'epic_import_failed', 'Epic error');
  });

  test('epic: a non-EpicError carrying a known code is mapped by that code', async (t) => {
    const err = Object.assign(new Error('auth still pending'), { code: 'epic_auth_pending' });
    const base = await epicApp(t, err);
    await expectError(t, await epicConnect(base), 409, 'epic_auth_pending', 'auth still pending');
  });

  test('epic: a plain error with a status is mapped and masked', async (t) => {
    const withCode = await epicApp(
      t,
      Object.assign(new Error('redirect https://api.epicgames.dev/x?code=ABC123 failed'), {
        status: 418,
        code: 'probe_code',
      })
    );
    await expectError(
      t,
      await epicConnect(withCode),
      418,
      'probe_code',
      'redirect https://api.epicgames.dev/x?code=*** failed'
    );

    const withoutCode = await epicApp(t, Object.assign(new Error('no code'), { status: 418 }));
    await expectError(t, await epicConnect(withoutCode), 418, 'error', 'no code');
  });

  /* ----------------------------------- gog ---------------------------------- */

  async function gogApp(t, err) {
    return mount(t, '/api/games/gog', gogRoutes.createRouter({
      client: {
        exchangeCode: async () => {
          throw err;
        },
      },
    }));
  }

  function gogAuth(base) {
    return fetch(`${base}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'probe' }),
    });
  }

  test('gog: HttpError passes through unchanged', async (t) => {
    const base = await gogApp(t, new gog.GogError('unused', 'gog_error'));
    await expectError(
      t,
      await fetch(`${base}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      400,
      'gog_code_required'
    );
  });

  test('gog: GogError code table, explicit status wins, default 502', async (t) => {
    const cases = [
      [new gog.GogError('gog expired', 'gog_auth_expired'), 401],
      [new gog.GogError('gog invalid code', 'gog_invalid_code'), 400],
      [new gog.GogError('gog rate limited', 'gog_rate_limited'), 429],
      [new gog.GogError('gog strange', 'gog_something_else'), 502],
      [new gog.GogError('gog explicit', 'gog_invalid_code', { status: 503 }), 503],
    ];
    for (const [err, status] of cases) {
      const base = await gogApp(t, err);
      await expectError(t, await gogAuth(base), status, err.code, err.message);
    }
  });

  test('gog: a plain error with a status keeps its code or falls back to games_gog_error', async (t) => {
    const withCode = await gogApp(
      t,
      Object.assign(new Error('gog probe failed'), { status: 422, code: 'probe_code' })
    );
    await expectError(t, await gogAuth(withCode), 422, 'probe_code', 'gog probe failed');

    const withoutCode = await gogApp(
      t,
      Object.assign(new Error('gog probe failed'), { status: 422 })
    );
    await expectError(t, await gogAuth(withoutCode), 422, 'games_gog_error', 'gog probe failed');
  });

  /* -------------------------------- franchise -------------------------------- */

  async function franchiseApp(t, err) {
    return mount(t, '/api/games', franchiseRoutes.createRouter({
      buildFranchises: () => {
        throw err;
      },
      autoFranchise: false,
    }));
  }

  test('franchise: HttpError passes through unchanged', async (t) => {
    await ensureSeed();
    const base = await franchiseApp(t, new Error('unused'));
    await expectError(t, await fetch(`${base}/franchises`), 400, 'profile_required');
  });

  test('franchise: FranchiseError defaults to 400 and honours its own status', async (t) => {
    await ensureSeed();
    const cases = [
      [new franchise.FranchiseError('franchise invalid', 'franchise_invalid_year'), 400],
      [new franchise.FranchiseError('franchise busy', 'franchise_busy', 409), 409],
    ];
    for (const [err, status] of cases) {
      const base = await franchiseApp(t, err);
      const response = await fetch(`${base}/franchises?profile=${PROFILE}`);
      await expectError(t, response, status, err.code, err.message);
    }
  });

  test('franchise: a plain error with a status keeps its code or falls back to games_franchise_error', async (t) => {
    await ensureSeed();
    const withCode = await franchiseApp(
      t,
      Object.assign(new Error('franchise probe failed'), { status: 422, code: 'probe_code' })
    );
    await expectError(
      t,
      await fetch(`${withCode}/franchises?profile=${PROFILE}`),
      422,
      'probe_code',
      'franchise probe failed'
    );

    const withoutCode = await franchiseApp(
      t,
      Object.assign(new Error('franchise probe failed'), { status: 422 })
    );
    await expectError(
      t,
      await fetch(`${withoutCode}/franchises?profile=${PROFILE}`),
      422,
      'games_franchise_error',
      'franchise probe failed'
    );
  });

  /* -------------------------------- personnel -------------------------------- */

  async function personnelApp(t, err) {
    return mount(t, '/api/games', personnelRoutes.createRouter({
      applyOverride: async () => {
        throw err;
      },
    }));
  }

  function overridden(base) {
    return fetch(`${base}/override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  }

  test('personnel: HttpError passes through unchanged', async (t) => {
    const base = await personnelApp(t, new Error('unused'));
    await expectError(t, await fetch(`${base}/personnel`), 400, 'profile_required');
  });

  test('personnel: PersonnelError defaults to 400 and honours its own status', async (t) => {
    const cases = [
      [new PersonnelError('personnel invalid', 'invalid_override_type'), 400],
      [new PersonnelError('personnel busy', 'personnel_busy', 409), 409],
    ];
    for (const [err, status] of cases) {
      const base = await personnelApp(t, err);
      await expectError(t, await overridden(base), status, err.code, err.message);
    }
  });

  test('personnel: a plain error with a status keeps its code or falls back to games_personnel_error', async (t) => {
    const withCode = await personnelApp(
      t,
      Object.assign(new Error('personnel probe failed'), { status: 422, code: 'probe_code' })
    );
    await expectError(t, await overridden(withCode), 422, 'probe_code', 'personnel probe failed');

    const withoutCode = await personnelApp(
      t,
      Object.assign(new Error('personnel probe failed'), { status: 422 })
    );
    await expectError(
      t,
      await overridden(withoutCode),
      422,
      'games_personnel_error',
      'personnel probe failed'
    );
  });

  /* ----------------------------- full code tables ---------------------------- */

  const STEAM_CODE_STATUS = [
    ['invalid_steamid', 400],
    ['steamid_mismatch', 400],
    ['profile_private', 400],
    ['library_private', 400],
    ['steam_key_missing', 400],
    ['stats_private', 400],
    ['stats_not_found', 404],
    ['steam_unreachable', 502],
    ['steam_rate_limited', 429],
    ['steam_key_invalid', 502],
    ['steam_forbidden', 502],
    ['steam_http_error', 502],
    ['steam_invalid_url', 400],
    ['store_rate_limited', 429],
    ['store_unreachable', 502],
    ['store_http_error', 502],
    ['store_invalid_appid', 400],
    ['spy_rate_limited', 429],
    ['spy_unreachable', 502],
    ['spy_http_error', 502],
    ['spy_invalid_appid', 400],
    ['reviews_rate_limited', 429],
    ['reviews_unreachable', 502],
    ['reviews_http_error', 502],
    ['reviews_invalid_appid', 400],
  ];

  const EPIC_CODE_STATUS = [
    ['invalid_owner', 400],
    ['unknown_owner', 400],
    ['epic_account_required', 400],
    ['epic_not_connected', 400],
    ['owner_mismatch', 400],
    ['epic_invalid_account', 400],
    ['epic_auth_failed', 400],
    ['epic_auth_cancelled', 400],
    ['epic_auth_pending', 409],
    ['epic_auth_expired', 401],
    ['epic_rate_limited', 429],
    ['epic_unreachable', 502],
    ['epic_http_error', 502],
    ['epic_invalid_url', 400],
    ['epic_client_invalid', 502],
    ['epic_device_grant_unavailable', 400],
    ['epic_code_required', 400],
    ['epic_invalid_code', 400],
    ['epic_library_empty', 400],
    ['epic_token_store_error', 500],
    ['epic_invalid_catalog_item', 400],
    ['epic_import_failed', 502],
    ['unknown_auth', 404],
  ];

  const GOG_CODE_STATUS = [
    ['gog_auth_required', 401],
    ['gog_auth_expired', 401],
    ['gog_not_connected', 400],
    ['gog_invalid_code', 400],
    ['gog_invalid_request', 400],
    ['gog_code_required', 400],
    ['gog_client_rejected', 502],
    ['gog_invalid_user', 400],
    ['gog_invalid_url', 400],
    ['gog_rate_limited', 429],
    ['gog_unreachable', 502],
    ['gog_http_error', 502],
    ['unknown_profile', 400],
    ['steam_profile_required', 400],
    ['owner_required', 400],
    ['owner_mismatch', 400],
    ['gog_already_connected', 400],
    ['account_required', 400],
    ['gog_owner_mismatch', 400],
  ];

  function gamesErrorFor(code) {
    if (code.startsWith('store_') || code.startsWith('reviews_')) {
      return new store.StoreError(`store says ${code}`, code);
    }
    if (code.startsWith('spy_')) return new spy.SpyError(`spy says ${code}`, code);
    return new steam.SteamError(`steam says ${code}`, code);
  }

  test('games: every games code in the table maps to its status', async (t) => {
    await ensureSeed();
    for (const [code, status] of STEAM_CODE_STATUS) {
      const err = gamesErrorFor(code);
      const base = await gamesApp(t, throwingClient(err));
      const response = await fetch(`${base}/achievements?profile=${PROFILE}&appid=${APPID}`);
      await expectError(t, response, status, code, err.message);
    }
  });

  test('epic: every Epic code in the table maps to its status', async (t) => {
    for (const [code, status] of EPIC_CODE_STATUS) {
      const err = new epic.EpicError(`epic says ${code}`, code);
      const base = await epicApp(t, err);
      await expectError(t, await epicConnect(base), status, code, err.message);
    }
  });

  test('gog: every GOG code in the table maps to its status', async (t) => {
    for (const [code, status] of GOG_CODE_STATUS) {
      const err = new gog.GogError(`gog says ${code}`, code);
      const base = await gogApp(t, err);
      await expectError(t, await gogAuth(base), status, code, err.message);
    }
  });

  /* ------------------------------ helper API -------------------------------- */

  const { mapDomainError } = require('../server/core/errors');

  function probeError(message, code, status) {
    const err = new Error(message);
    err.code = code;
    if (status != null) err.status = status;
    return err;
  }

  test('mapDomainError returns the very same HttpError and never re-wraps it', () => {
    const profile = { rules: [{ is: Error, statuses: { probe: 400 }, defaultStatus: 502 }] };
    const original = new HttpError(409, 'already running', 'livelib_import_running');
    assert.equal(mapDomainError(original, profile), original);
  });

  test('mapDomainError copies retryAt only for profiles that declare it', () => {
    const err = Object.assign(probeError('rate limited', 'probe_rate_limited'), {
      retryAt: '2026-11-10T00:00:00.000Z',
    });
    const withRetry = mapDomainError(err, {
      rules: [{ is: Error, statuses: { probe_rate_limited: 429 }, defaultStatus: 502 }],
      retryAt: true,
    });
    assert.equal(withRetry.retryAt, '2026-11-10T00:00:00.000Z');
    assert.equal(withRetry.status, 429);

    const withoutRetry = mapDomainError(err, {
      rules: [{ is: Error, statuses: { probe_rate_limited: 429 }, defaultStatus: 502 }],
    });
    assert.equal(withoutRetry.retryAt, undefined);
  });

  test('mapDomainError maps by class, by known code, or by the status a plain error carries', () => {
    const err = probeError('own status', 'probe_code', 418);

    assert.equal(
      mapDomainError(err, { rules: [{ is: Error, statuses: {}, defaultStatus: 502 }] }).status,
      502
    );
    assert.equal(
      mapDomainError(err, {
        rules: [{ is: Error, statuses: {}, defaultStatus: 502, ownStatus: 'whenSet' }],
      }).status,
      418
    );
    assert.equal(
      mapDomainError(err, {
        rules: [{ is: Error, statuses: {}, defaultStatus: 502, ownStatus: 'whenAtLeast400' }],
      }).status,
      418
    );

    const lowStatus = probeError('too low', 'probe_code', 302);
    assert.equal(
      mapDomainError(lowStatus, {
        rules: [{ is: Error, statuses: {}, defaultStatus: 502, ownStatus: 'whenSet' }],
      }).status,
      302
    );
    assert.equal(
      mapDomainError(lowStatus, {
        rules: [{ is: Error, statuses: {}, defaultStatus: 502, ownStatus: 'whenAtLeast400' }],
      }).status,
      502
    );

    const plainWithKnownCode = probeError('known code', 'probe_code', 401);
    const byCode = { codeIn: { probe_code: 409 }, statuses: { probe_code: 409 }, defaultStatus: 502 };
    assert.equal(mapDomainError(plainWithKnownCode, { rules: [byCode] }).status, 409);
    assert.equal(mapDomainError(plainWithKnownCode, { rules: [byCode] }).code, 'probe_code');
    assert.equal(
      mapDomainError(probeError('unknown code', 'other_code'), { rules: [byCode] }).status,
      undefined
    );
    assert.equal(
      mapDomainError(probeError('unknown code', 'other_code'), {
        rules: [{ is: Error, statuses: { probe_code: 409 }, defaultStatus: 502 }],
      }).status,
      502
    );
  });

  test('mapDomainError maps only errors inside the 400..599 fallback range', () => {
    const profile = { rules: [], fallback: { code: 'probe_fallback' } };
    const plain = (status) => Object.assign(new Error('plain'), { status, code: 'probe_code' });

    assert.equal(mapDomainError(plain(422), profile).status, 422);
    assert.equal(mapDomainError(plain(422), profile).code, 'probe_code');
    assert.equal(
      mapDomainError(Object.assign(new Error('plain'), { status: 422 }), profile).code,
      'probe_fallback'
    );

    const outOfRange = plain(302);
    assert.equal(mapDomainError(outOfRange, profile), outOfRange);
    assert.equal(mapDomainError(plain(600), profile).status, 600);
    assert.equal(mapDomainError(plain(422), { rules: [] }).status, 422);
  });

  test('mapDomainError masks the message only when the profile asks for it', () => {
    const mask = (text) => text.replace(/secret/g, '***');
    const err = probeError('a secret value', 'probe_code');
    const profile = {
      rules: [{ is: Error, statuses: {}, defaultStatus: 502 }],
      message: { mask, fallback: 'fallback text' },
    };
    assert.equal(mapDomainError(err, profile).message, 'a *** value');

    const empty = probeError('', 'probe_code');
    assert.equal(mapDomainError(empty, profile).message, 'fallback text');
    assert.equal(
      mapDomainError(err, { rules: [{ is: Error, statuses: {}, defaultStatus: 502 }] }).message,
      'a secret value'
    );
  });
  after(() => env.resetMutableState());
});


describe('core-errors', () => {
  /**
   * `server/core/errors.js`: the HTTP error type every router throws and the one
   * response shape (`{ error, code }`). The middleware must never leak an
   * internal message.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');

  const { HttpError, isHttpError, fromStatus, respondError, errorMiddleware } = require('../server/core/errors');

  function fakeRes() {
    return {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
  }

  test('HttpError carries the status, the message and a stable code', () => {
    const err = new HttpError(400, 'bad request', 'invalid_profile');
    assert.equal(err.status, 400);
    assert.equal(err.message, 'bad request');
    assert.equal(err.code, 'invalid_profile');
    assert.equal(isHttpError(err), true);
    assert.equal(new HttpError(500, 'boom').code, 'error');
  });

  test('fromStatus wraps a plain error with an explicit status', () => {
    const wrapped = fromStatus(Object.assign(new Error('no library'), { status: 404, code: 'unknown_profile' }));
    assert.ok(wrapped instanceof HttpError);
    assert.equal(wrapped.status, 404);
    assert.equal(wrapped.code, 'unknown_profile');

    const unchanged = new Error('internal');
    assert.equal(fromStatus(unchanged), unchanged);
    const already = new HttpError(400, 'x', 'y');
    assert.equal(fromStatus(already), already);
  });

  test('respondError writes { error, code } for an HttpError', () => {
    const res = fakeRes();
    respondError(res, new HttpError(409, 'already matched', 'already_matched'));
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, { error: 'already matched', code: 'already_matched' });
  });

  test('respondError logs and hides an unexpected error', () => {
    const res = fakeRes();
    const originalError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    try {
      respondError(res, new Error('secret internal detail'));
    } finally {
      console.error = originalError;
    }
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Internal server error.', code: 'internal_error' });
    assert.equal(logged.length, 1);
  });

  test('errorMiddleware maps a broken JSON body to a 400', () => {
    const res = fakeRes();
    const syntax = new SyntaxError('Unexpected token');
    syntax.body = '{';
    errorMiddleware(syntax, {}, res, () => {});
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'Invalid JSON body.', code: 'invalid_json' });
  });
  after(() => env.resetMutableState());
});


describe('core-fs-store', () => {
  /**
   * `server/core/fs-store.js`: atomic JSON writes, fingerprint-checked reads and
   * the secret writer (0600). This is the layer the first phase of the refactor
   * gives to every cache module, so its failure modes are pinned here.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const store = require('../server/core/fs-store');

  function tempDir() {
    return env.tmpDir('kinoboxd-fs-store-');
  }

  test('writeJsonAtomic + readJson round-trip and leave no tmp file behind', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'facts.json');
    const fingerprint = await store.writeJsonAtomic(file, { schemaVersion: 1, values: [1, 2] });
    assert.ok(fingerprint);
    assert.deepEqual(store.readJson(file), { schemaVersion: 1, values: [1, 2] });
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')),
      []
    );
  });

  test('the fingerprint moves when the file is replaced', async () => {
    const file = path.join(tempDir(), 'doc.json');
    const first = await store.writeJsonAtomic(file, { n: 1 });
    const second = await store.writeJsonAtomic(file, { n: 2, longer: 'payload' });
    assert.notEqual(first, second);
    const read = store.readJsonWithFingerprint(file);
    assert.equal(read.fingerprint, second);
    assert.deepEqual(read.data, { n: 2, longer: 'payload' });
  });

  test('a missing file and a corrupt file both read as null', async () => {
    const dir = tempDir();
    assert.equal(store.readJson(path.join(dir, 'absent.json')), null);

    const corrupt = path.join(dir, 'corrupt.json');
    fs.writeFileSync(corrupt, '{not json', 'utf8');
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(message);
    try {
      assert.equal(store.readJson(corrupt, { label: 'unit-test' }), null);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[unit-test\] corrupt JSON/);
  });

  test('sync write is atomic and returns the new fingerprint', () => {
    const file = path.join(tempDir(), 'sync.json');
    const fingerprint = store.writeJsonAtomicSync(file, { ok: true });
    assert.equal(store.readJson(file).ok, true);
    assert.equal(fingerprint, store.fingerprintOf(file));
  });

  test('writeJsonAtomic(Sync) honours an explicit JSON indent', async () => {
    const file = path.join(tempDir(), 'indented.json');
    const data = { schemaVersion: 1, nested: { a: 1 } };
    await store.writeJsonAtomic(file, data, { space: 2 });
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(data, null, 2));
    store.writeJsonAtomicSync(file, data, { space: 2 });
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(data, null, 2));
  });

  test('secret documents are written 0600 inside a 0700 directory', () => {
    const dir = tempDir();
    const file = path.join(dir, 'nested', 'token.json');
    store.writeSecretAtomicSync(file, { access_token: 'redacted' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.deepEqual(store.readJson(file), { access_token: 'redacted' });
  });

  test('verifySecretFileSync repairs 0644 and refuses a non-regular file', () => {
    const dir = tempDir();
    const file = path.join(dir, 'secret.json');
    fs.writeFileSync(file, '{}');
    fs.chmodSync(file, 0o644);
    store.verifySecretFileSync(file, 0o600);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    const sub = path.join(dir, 'not-a-file');
    fs.mkdirSync(sub);
    assert.throws(
      () => store.verifySecretFileSync(sub),
      (err) => err.code === 'secret_mode_error'
    );

    const link = path.join(dir, 'link.json');
    fs.symlinkSync(file, link);
    assert.throws(
      () => store.verifySecretFileSync(link),
      (err) => err.code === 'secret_mode_error'
    );
  });

  test('safeKey removes path traversal and keeps the readable part', () => {
    assert.equal(store.safeKey('../../etc/passwd'), '.._.._etc_passwd');
    assert.equal(store.safeKey('steam-76561198038369983'), 'steam-76561198038369983');
    assert.equal(store.safeKey(null), '');
    assert.equal(store.safeKey('x'.repeat(200)).length, 120);
  });

  test('listJsonFiles returns sorted json documents only', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'b.json'), '{}');
    fs.writeFileSync(path.join(dir, 'a.json'), '{}');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    fs.mkdirSync(path.join(dir, 'nested'));
    assert.deepEqual(store.listJsonFiles(dir), ['a.json', 'b.json']);
    assert.deepEqual(store.listJsonFiles(path.join(dir, 'missing')), []);
  });

  test('listJsonFiles accepts symlinked documents (worktree cache is a link)', () => {
    const dir = tempDir();
    const target = tempDir();
    fs.writeFileSync(path.join(target, 'linked.json'), '{}');
    fs.symlinkSync(path.join(target, 'linked.json'), path.join(dir, 'linked.json'));
    fs.writeFileSync(path.join(dir, 'plain.json'), '{}');
    fs.symlinkSync(path.join(target, 'linked.json'), path.join(dir, 'linked.txt'));
    // A dangling link is still a link entry: it is listed, the reader decides.
    fs.symlinkSync(path.join(target, 'gone.json'), path.join(dir, 'dangling.json'));

    assert.deepEqual(store.listJsonFiles(dir), ['dangling.json', 'linked.json', 'plain.json']);
  });
  after(() => env.resetMutableState());
});


describe('core-http', () => {
  /**
   * `core/http.js` — transport + retry contract.
   *
   * No live network: `fetchOnce`/`fetchJson`/`postJson` take an injected
   * `fetchImpl`, and the two `nodeRequest` cases use a throwaway local server on
   * an ephemeral port (never 3000).
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const http = require('node:http');

  const {
    HttpTransportError,
    fetchJson,
    fetchText,
    fetchOnce,
    fetchBinary,
    postJson,
    nodeRequest,
    parseRetryAfter,
    backoffFor,
  } = require('../server/core/http');

  function jsonResponse(body, status = 200, headers = {}) {
    return {
      status,
      headers: {
        get: (name) => headers[String(name).toLowerCase()] || null,
        getSetCookie: () => [],
      },
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      url: 'https://example.test/x',
    };
  }

  function callsOf() {
    const calls = [];
    const sleeps = [];
    return {
      calls,
      sleeps,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        const next = calls.length - 1;
        return calls[next].response;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    };
  }

  test('fetchJson retries 429/5xx with Retry-After and succeeds', async () => {
    const queue = [
      jsonResponse({}, 429, { 'retry-after': '1' }),
      jsonResponse({}, 503),
      jsonResponse({ ok: true }),
    ];
    const calls = [];
    const sleeps = [];
    const fetchImpl = async () => {
      calls.push(1);
      return queue.shift();
    };
    const data = await fetchJson('https://example.test/json', {
      fetchImpl,
      sleep: async (ms) => sleeps.push(ms),
      label: 'test',
    });
    assert.deepEqual(data, { ok: true });
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [1000, 2000]);
  });

  test('fetchJson gives up after the retry budget with the last transport error', async () => {
    const fetchImpl = async () => jsonResponse({}, 500);
    await assert.rejects(
      () => fetchJson('https://example.test/json', { fetchImpl, sleep: async () => {}, retries: 1, label: 'test' }),
      (err) => err instanceof HttpTransportError && err.code === 'provider_http_error' && err.status === 500
    );
  });

  test('fetchJson retries a network failure and a non-JSON 200', async () => {
    const queue = [
      () => {
        throw new Error('ECONNRESET');
      },
      () => jsonResponse('<html>not json</html>'),
      () => jsonResponse({ ok: 1 }),
    ];
    let index = 0;
    const fetchImpl = async () => queue[index++]();
    const data = await fetchJson('https://example.test/json', {
      fetchImpl,
      sleep: async () => {},
      retries: 2,
    });
    assert.deepEqual(data, { ok: 1 });
    assert.equal(index, 3);
  });

  test('fetchJson does not retry a 4xx (except 429)', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return jsonResponse({}, 404);
    };
    await assert.rejects(
      () => fetchJson('https://example.test/json', { fetchImpl, sleep: async () => {}, label: 'test' }),
      (err) => err.status === 404 && err.code === 'provider_http_error'
    );
    assert.equal(calls, 1);
  });

  test('fetchText returns the body as-is and passes the redirect mode through', async () => {
    const seen = [];
    const fetchImpl = async (url, options) => {
      seen.push(options.redirect);
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => '<html>ok</html>',
        url,
      };
    };
    const body = await fetchText('https://example.test/html', {
      fetchImpl,
      redirect: 'manual',
      sleep: async () => {},
    });
    assert.equal(body, '<html>ok</html>');
    assert.deepEqual(seen, ['manual']);
  });

  test('fetchOnce caps the body when maxBytes is given', async () => {
    const fetchImpl = async () => jsonResponse('0123456789');
    await assert.rejects(
      () => fetchOnce('https://example.test/x', { fetchImpl, maxBytes: 5, label: 'test' }),
      (err) => err.code === 'response_too_large'
    );
  });

  test('timeoutMs: 0 means no deadline; omitted keeps the 15 s default', async () => {
    let seen = null;
    const fetchImpl = async (url, init) => {
      seen = init;
      return jsonResponse({ ok: true });
    };
    await fetchOnce('https://example.test/x', { fetchImpl });
    assert.ok(seen.signal, 'the default deadline is still installed');
    await fetchOnce('https://example.test/x', { fetchImpl, timeoutMs: 0 });
    assert.equal(seen.signal, undefined, '0 must not install an AbortSignal');
  });

  test('fetchBinary reads bytes and enforces maxBytes', async () => {
    const fetchImpl = async () => ({
      status: 200,
      headers: new Map(),
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      url: 'https://example.test/i',
    });
    const ok = await fetchBinary('https://example.test/i', { fetchImpl });
    assert.equal(ok.buffer.length, 4);
    await assert.rejects(
      () => fetchBinary('https://example.test/i', { fetchImpl, maxBytes: 2 }),
      (err) => err.code === 'response_too_large'
    );
  });

  test('postJson sends a POST with a JSON body', async () => {
    let request = null;
    const fetchImpl = async (url, options) => {
      request = { url, options };
      return jsonResponse({ data: 1 });
    };
    const data = await postJson(
      'https://example.test/graphql',
      { query: '{ x }' },
      { fetchImpl, headers: { authorization: 'Bearer ***' }, sleep: async () => {} }
    );
    assert.deepEqual(data, { data: 1 });
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.body, '{"query":"{ x }"}');
    assert.equal(request.options.headers.authorization, 'Bearer ***');
  });

  test('parseRetryAfter and backoffFor share the documented bounds', () => {
    assert.equal(parseRetryAfter({ headers: { get: () => '2' } }), 2000);
    assert.equal(parseRetryAfter({ headers: { get: () => null } }), null);
    assert.equal(parseRetryAfter({ headers: { get: () => 'nonsense' } }), null);
    assert.equal(backoffFor(0), 800);
    assert.equal(backoffFor(1), 2000);
    assert.equal(backoffFor(9), 2000);
  });

  test('nodeRequest follows redirects and reports a refused connection', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/final' });
        res.end('Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const response = await nodeRequest(`http://127.0.0.1:${port}/start`, { maxRedirects: 3 });
      assert.equal(response.status, 200);
      assert.equal(response.body, 'ok');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    await assert.rejects(
      () => nodeRequest('http://127.0.0.1:1/', { timeoutMs: 2000 }),
      (err) => err.code === 'network_error'
    );
  });

  test('nodeRequest reports too many redirects and an invalid URL', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(302, { Location: '/again' });
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      await assert.rejects(
        () => nodeRequest(`http://127.0.0.1:${port}/loop`, { maxRedirects: 1 }),
        (err) => err.code === 'too_many_redirects'
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    await assert.rejects(
      () => nodeRequest('not a url', {}),
      (err) => err.code === 'invalid_url'
    );
  });

  test('nodeRequest keeps response_too_large when the body cap destroys the stream', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('x'.repeat(4096));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      await assert.rejects(
        () => nodeRequest(`http://127.0.0.1:${port}/big`, { maxBytes: 16 }),
        (err) => err.code === 'response_too_large'
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
  after(() => env.resetMutableState());
});


describe('core-jobs', () => {
  /**
   * `server/core/jobs.js`: the single job registry behind all nine `start*` /
   * `getStatus` pairs. Covers the mechanics the domains rely on: single-flight
   * coalescing (including alias keys), stage/progress snapshots, the serialized
   * chain, the failure snapshot, the cooldown window (with an injected clock)
   * and retention.
   *
   * No timers and no sleeps: every scenario resolves through promises, and the
   * cooldown clock is a variable, so the file stays deterministic.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');

  const { createJobs } = require('../server/core/jobs');

  const tick = () => new Promise((resolve) => setImmediate(resolve));

  function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  test('single-flight: a second start for the same key joins the live job', async () => {
    const jobs = createJobs({ name: 'test', keyOf: (job) => job.key });
    const gate = deferred();
    let runs = 0;

    const first = jobs.start('alpha', async (job) => {
      runs++;
      await gate.promise;
      job.stage = 'done';
    });
    const second = jobs.start('alpha', async () => {
      runs++;
    });

    assert.equal(second, first, 'the second start returns the live job');
    await tick();
    assert.equal(runs, 1, 'the task body ran once');
    assert.equal(jobs.isRunning('alpha'), true);

    gate.resolve();
    await jobs.whenIdle();

    assert.equal(runs, 1);
    assert.equal(jobs.isRunning('alpha'), false);
    assert.equal(jobs.get(first.id).status, 'done');
    assert.equal(jobs.get(first.id).done, true);
  });

  test('a finished key can start again; alias keys coalesce too', async () => {
    const jobs = createJobs({ name: 'test', keyOf: (job) => job.key });

    const first = jobs.start('vanity:bob', async (job) => {
      job.stage = 'done';
    }, { fields: { key: 'vanity:bob', aliasKeys: ['steam-42'] } });
    assert.equal(jobs.isRunning('steam-42'), true, 'the alias is live while running');

    const joined = jobs.start('steam-42', async () => {});
    assert.equal(joined, first);

    await jobs.whenIdle();
    assert.equal(jobs.isRunning('steam-42'), false, 'a finished job is not live');

    const next = jobs.start('steam-42', async () => {});
    assert.notEqual(next.id, first.id, 'a new job is created after the first one finished');
    await jobs.whenIdle();
  });

  test('a task may move its own key and keep the old one as an alias', async () => {
    const jobs = createJobs({ name: 'test', keyOf: (job) => job.key });
    const gate = deferred();

    const job = jobs.start('vanity:bob', async (self) => {
      self.aliasKeys = [...(self.aliasKeys || []), self.key];
      self.key = 'steam-42';
      await gate.promise;
    });

    await tick();
    assert.equal(jobs.isRunning('steam-42'), true);
    assert.equal(jobs.isRunning('vanity:bob'), true);
    assert.equal(jobs.start('steam-42', async () => {}), job, 'no second job for the owner key');

    gate.resolve();
    await jobs.whenIdle();
  });

  test('stages and progress land in the unified snapshot', async () => {
    const jobs = createJobs({ name: 'test', keyOf: (job) => job.key });
    let seen = null;

    const job = jobs.start('p', async (self) => {
      self.setStage('library', 3, 10);
      seen = jobs.snapshot(jobs.get(self.id));
      self.setProgress(10, 10);
      self.stage = 'done';
    });

    await jobs.whenIdle();
    assert.equal(seen.stage, 'library');
    assert.deepEqual(seen.progress, { current: 3, total: 10 });
    assert.equal(seen.status, 'running');
    assert.equal(seen.error, null);
    assert.equal(seen.partial, null);
    assert.equal(typeof seen.startedAt, 'number');

    const done = jobs.snapshot(job);
    assert.equal(done.stage, 'done');
    assert.deepEqual(done.progress, { current: 10, total: 10 });
    assert.equal(done.status, 'done');
    assert.equal(typeof done.finishedAt, 'number');
  });

  test('a task that throws leaves an honest error snapshot and a finished job', async () => {
    const jobs = createJobs({ name: 'demo', keyOf: (job) => job.key });

    const job = jobs.start('broken', async (self) => {
      self.setStage('fetching', 1, 4);
      const err = new Error('boom');
      err.code = 'demo_boom';
      err.retryAt = 123;
      throw err;
    });

    await jobs.whenIdle();
    const status = jobs.status(job.id);
    assert.equal(status.status, 'failed');
    assert.equal(status.stage, 'failed');
    assert.equal(status.error, 'boom');
    assert.equal(job.code, 'demo_boom', 'the error code is preserved');
    assert.equal(job.retryAt, 123, 'retryAt is preserved');
    assert.equal(job.done, true);
    assert.equal(typeof status.finishedAt, 'number');
    assert.equal(jobs.isRunning('broken'), false);
  });

  test('a deferred error keeps its own status, like the Epic import', async () => {
    const jobs = createJobs({ name: 'epic', keyOf: (job) => job.key });
    const job = jobs.start('deferred', async () => {
      const err = new Error('network');
      err.code = 'epic_unreachable';
      err.deferred = true;
      throw err;
    });

    await jobs.whenIdle();
    assert.equal(job.status, 'deferred');
    assert.equal(job.stage, 'deferred');
    assert.equal(job.done, true);
    assert.equal(jobs.status(job.id).status, 'deferred');
  });

  test('a domain verdict (skipped) survives the finalizer', async () => {
    const jobs = createJobs({ name: 'test', keyOf: (job) => job.key });
    const job = jobs.start('skipped', async (self) => {
      self.status = 'skipped';
      self.stage = 'skipped';
      self.skipped = 'lock_busy';
    });

    await jobs.whenIdle();
    assert.equal(job.status, 'skipped');
    assert.equal(job.done, true);
    assert.equal(job.percent, 0, 'a skipped job is not 100 % done');
    assert.equal(job.skipped, 'lock_busy');
  });

  test('cooldown window: the last pass throttles a re-kick until it expires', async () => {
    let clock = 1000;
    const jobs = createJobs({
      name: 'test',
      keyOf: (job) => job.key,
      cooldownMs: 60_000,
      now: () => clock,
    });

    assert.equal(jobs.cooldownRemaining('p'), 0, 'nothing ran yet');

    jobs.start('p', async (job) => {
      job.status = 'done';
      job.stage = 'done';
    });
    await jobs.whenIdle();

    clock += 10_000;
    assert.equal(jobs.cooldownRemaining('p'), 50_000);
    assert.deepEqual(jobs.lastFinish('p'), { at: 1000, status: 'done', skipped: null });

    clock += 50_000;
    assert.equal(jobs.cooldownRemaining('p'), 0, 'the window expired');

    jobs.resetCooldown();
    assert.equal(jobs.lastFinish('p'), null);
  });

  test('a failed pass is not throttled; a custom ignore rule can widen that', async () => {
    let clock = 5000;
    const jobs = createJobs({
      name: 'test',
      keyOf: (job) => job.key,
      cooldownMs: 10_000,
      now: () => clock,
    });

    jobs.start('f', async (job) => {
      job.status = 'failed';
      job.stage = 'failed';
    });
    await jobs.whenIdle();
    assert.equal(jobs.cooldownRemaining('f'), 0, 'failure never opens the window');

    jobs.start('s', async (job) => {
      job.status = 'skipped';
      job.stage = 'skipped';
      job.skipped = 'lock_busy';
    });
    await jobs.whenIdle();
    clock += 1000;
    assert.equal(jobs.cooldownRemaining('s'), 9000, 'a skip throttles by default');
    assert.equal(
      jobs.cooldownRemaining('s', { ignore: (record) => record.skipped === 'lock_busy' }),
      0,
      'the franchise rule ignores a busy lock'
    );
  });

  test('two independent keys are accepted and both complete', async () => {
    const jobs = createJobs({ name: 'test', keyOf: (job) => job.key });
    const first = jobs.start('a', async (job) => {
      job.stage = 'done';
    });
    const second = jobs.start('b', async (job) => {
      job.stage = 'done';
    });

    assert.notEqual(first.id, second.id);
    await jobs.whenIdle();
    assert.equal(first.done, true);
    assert.equal(second.done, true);
  });

  test('per-key chains let two keys overlap; the default chain serializes', async () => {
    const jobs = createJobs({ name: 'test', keyOf: (job) => job.key });
    const gate = deferred();
    let parallel = false;
    let running = 0;

    const first = jobs.start('a', async () => {
      running++;
      await gate.promise;
      running--;
    }, { chainKey: 'a' });
    const second = jobs.start('b', async () => {
      running++;
      parallel = running > 1;
      running--;
    }, { chainKey: 'b' });

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(parallel, true, 'different chain keys run concurrently');
    gate.resolve();
    await jobs.whenIdle();
    assert.equal(first.done, true);
    assert.equal(second.done, true);

    const serial = createJobs({ name: 'test', keyOf: (job) => job.key });
    let serialParallel = false;
    let live = 0;
    const block = deferred();
    serial.start('a', async () => {
      live++;
      await block.promise;
      live--;
    });
    serial.start('b', async () => {
      live++;
      serialParallel = live > 1;
      live--;
    });
    block.resolve();
    await serial.whenIdle();
    assert.equal(serialParallel, false, 'the registry-wide chain is serial');
  });

  test('retention keeps the newest maxJobs and forgets the oldest', async () => {
    const jobs = createJobs({ name: 'test', keyOf: (job) => job.key, maxJobs: 2 });
    const first = jobs.start('a', async () => {});
    await jobs.whenIdle();
    const second = jobs.start('b', async () => {});
    await jobs.whenIdle();
    const third = jobs.start('c', async () => {});
    await jobs.whenIdle();

    assert.equal(jobs.get(first.id), undefined);
    assert.ok(jobs.get(second.id));
    assert.ok(jobs.get(third.id));
    assert.equal(jobs.list().length, 2);
  });

  test('job.finish() and job.fail() finalize from inside the task', async () => {
    const jobs = createJobs({ name: 'test', keyOf: (job) => job.key, errorCode: 'test_manual' });
    const ok = jobs.start('ok', async (job) => {
      job.finish({ gameCount: 3 });
    });
    await jobs.whenIdle();
    assert.equal(ok.status, 'done');
    assert.equal(ok.done, true);
    assert.equal(ok.percent, 100);
    assert.equal(ok.gameCount, 3);

    const bad = jobs.start('bad', async (job) => {
      job.fail(new Error('nope'));
    });
    await jobs.whenIdle();
    assert.equal(bad.status, 'failed');
    assert.equal(bad.code, 'test_manual');
    assert.equal(bad.error, 'nope');
    assert.equal(bad.done, true);
  });

  test('onFinish can replace the default finalizer (books import shape)', async () => {
    const jobs = createJobs({ name: 'books', keyOf: (job) => job.key });
    const job = jobs.start('b', async (self) => {
      self.stage = 'failed';
      self.error = 'nope';
    }, {
      finish: false,
      onFinish: (self) => {
        self.finishedAt = 42;
        if (!self.done && self.stage !== 'failed') self.stage = 'done';
        self.done = self.stage === 'done';
      },
    });

    await jobs.whenIdle();
    assert.equal(job.done, false, 'a failed books job is not `done`');
    assert.equal(job.finishedAt, 42);
    assert.equal(job.stage, 'failed');
  });

  test('status() of an unknown id is null and never throws', () => {
    const jobs = createJobs({ name: 'test' });
    assert.equal(jobs.status('nope'), null);
    assert.equal(jobs.status(null), null);
    assert.equal(jobs.get(undefined), undefined);
  });

  test('ids keep the legacy shape and an explicit prefix (books per source)', () => {
    const jobs = createJobs({ name: 'test', idPrefix: 'games-steam' });
    const id = jobs.newId('76561198 000000001');
    assert.match(id, /^games-steam-76561198_000000001-[0-9a-z]+-[0-9a-f]{6}$/);
    assert.match(jobs.newId('livelib', 'resolve'), /^resolve-livelib-[0-9a-z]+-[0-9a-f]{6}$/);
  });

  test('remember() attaches the job methods to a plain legacy literal', async () => {
    const jobs = createJobs({ name: 'test', keyOf: (job) => job.uploadId });
    const job = jobs.remember({
      id: 'upload-1',
      uploadId: 'upload-1',
      total: 2,
      matched: 0,
      failed: 0,
      done: false,
      startedAt: 1,
      finishedAt: null,
    });

    job.setStage('enrich', 1, 2);
    assert.equal(job.stage, 'enrich');
    assert.deepEqual(job.progress, { current: 1, total: 2 });
    assert.equal(jobs.get('upload-1'), job);

    const snapshot = jobs.snapshot(job);
    assert.equal(snapshot.status, 'running');
    assert.equal(snapshot.progress.current, 1);
    assert.equal(snapshot.partial, null);
  });

  test('cooldownRemaining accepts a per-call window override (route option)', async () => {
    let clock = 0;
    const jobs = createJobs({ name: 'test', keyOf: (job) => job.key, cooldownMs: 1000, now: () => clock });
    jobs.start('p', async (job) => {
      job.status = 'done';
      job.stage = 'done';
    });
    await jobs.whenIdle();
    clock = 500;
    assert.equal(jobs.cooldownRemaining('p'), 500);
    assert.equal(jobs.cooldownRemaining('p', { windowMs: 0 }), 0);
    assert.equal(jobs.cooldownRemaining('p', { windowMs: 200 }), 0, 'the shorter window already expired');
  });
  after(() => env.resetMutableState());
});


describe('core-lock', () => {
  /**
   * `server/core/lock.js`: the single file lock both the book resolve chain and
   * the games personnel pass use. Covers ownership, staleness (age and dead pid),
   * the busy path and the directory bootstrap.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');

  const core = require('../server/core/lock');

  function tempLock() {
    const dir = env.tmpDir('kinoboxd-lock-');
    return core.createLock({ path: path.join(dir, 'nested', 'test.lock'), name: 'test-lock' });
  }

  function writeLock(lock, payload) {
    fs.mkdirSync(path.dirname(lock.path), { recursive: true });
    fs.writeFileSync(lock.path, JSON.stringify(payload), 'utf8');
  }

  test('acquire takes the lock, a second caller is busy, release frees it', () => {
    const lock = tempLock();
    const token = lock.tryAcquire('first');
    assert.ok(token);
    assert.equal(lock.isLocked(), true);
    assert.equal(lock.tryAcquire('second'), null);

    assert.equal(lock.release('foreign-token'), false);
    assert.equal(lock.isLocked(), true);

    assert.equal(lock.release(token), true);
    assert.equal(lock.isLocked(), false);
    assert.equal(fs.existsSync(lock.path), false);
  });

  test('a lock older than staleMs is ignored even when the pid is alive', () => {
    const lock = tempLock();
    writeLock(lock, {
      token: 'old',
      pid: process.pid,
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(lock.isLocked({ staleMs: 60 * 1000 }), false);
    assert.equal(lock.isLocked({ staleMs: 3 * 60 * 60 * 1000 }), true);
  });

  test('a dead pid does not hold the lock', () => {
    const lock = tempLock();
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    writeLock(lock, {
      token: 'dead',
      pid: child.pid,
      startedAt: new Date().toISOString(),
    });
    assert.equal(core.pidAlive(child.pid), false);
    assert.equal(lock.isLocked(), false);
  });

  test('acquire reports busy without waiting when waitMs is 0', async () => {
    const lock = tempLock();
    const token = lock.tryAcquire('holder');
    assert.ok(token);
    const result = await lock.acquire({ owner: 'waiter', waitMs: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.token, null);
    assert.ok(result.waitedMs >= 0);
    lock.release(token);
  });

  test('acquire polls until the holder releases', async () => {
    const lock = tempLock();
    const token = lock.tryAcquire('holder');
    assert.ok(token);
    setTimeout(() => lock.release(token), 40);
    const result = await lock.acquire({ owner: 'waiter', waitMs: 1000, pollMs: 50 });
    assert.equal(result.ok, true);
    assert.ok(result.token);
    lock.release(result.token);
  });

  test('a corrupt lock file is treated as free and replaced', () => {
    const lock = tempLock();
    fs.mkdirSync(path.dirname(lock.path), { recursive: true });
    fs.writeFileSync(lock.path, '{not json', 'utf8');
    assert.equal(lock.isLocked(), false);
    const token = lock.tryAcquire('next');
    assert.ok(token);
    assert.equal(lock.read().owner, 'next');
    lock.release(token);
  });
  after(() => env.resetMutableState());
});


describe('core-numeric', () => {
  /**
   * R15 behaviour pin: every domain numeric wrapper is pinned as it behaves
   * today, *before* the copies are replaced by `server/core/stats.js`.
   *
   * The payload hash is byte-sensitive, so a merge of `round2` copies must not
   * pick one rounding policy: films/games round plainly, books returns `null`
   * for anything non-finite, games personnel coerces with `Number()` first.
   * Those three policies are pinned here table-by-table, and the same table is
   * re-run against the core helper, so any future edit that "unifies" them
   * silently fails this file.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const TMP = (name) => env.tmpDir(`kinoboxd-numeric-${name}-`);

  process.env.KINOBOXD_CACHE_DIR = run.cacheDir;
  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const filmsNumeric = require('../server/stats/numeric');
  const gamesNumeric = require('../server/games/stats/numeric');
  const booksNumeric = require('../server/books/stats/numeric');
  const personnelIdentity = require('../server/games/personnel/identity');
  const franchiseRules = require('../server/games/franchise/aggregate-rules');
  const epicSecondary = require('../server/games/secondary/epic');
  const taxonomy = require('../server/taxonomy');
  const coreStats = require('../server/core/stats');

  const VALUES = [
    0,
    1.005,
    1.0049,
    2.5,
    -2.5,
    1e-7,
    7.335,
    NaN,
    Infinity,
    -Infinity,
    null,
    undefined,
    '1.005',
    '-2.5',
    '',
    'abc',
    true,
  ];

  const mapValues = (fn) => VALUES.map((value) => fn(value));

  const PLAIN_ROUND2 = [0, 1, 1, 2.5, -2.5, 0, 7.34, NaN, Infinity, -Infinity, 0, NaN, 1, -2.5, 0, NaN, 1];

  const FINITE_ROUND2 = [0, 1, 1, 2.5, -2.5, 0, 7.34, null, null, null, null, null, null, null, null, null, null];

  test('round2: films and games round plainly, NaN/Infinity survive', () => {
    assert.deepStrictEqual(mapValues(filmsNumeric.round2), PLAIN_ROUND2);
    assert.deepStrictEqual(mapValues(gamesNumeric.round2), PLAIN_ROUND2);
  });

  test('round2: books answers null for every non-finite input, including numeric strings', () => {
    assert.deepStrictEqual(mapValues(booksNumeric.round2), FINITE_ROUND2);
  });

  test('round2: games personnel coerces with Number() first', () => {
    assert.deepStrictEqual(mapValues(personnelIdentity.round2), PLAIN_ROUND2);
  });

  test('round1/round3/round4 keep their own digit policies', () => {
    const round1 = [0, 1, 1, 2.5, -2.5, 0, 7.3, NaN, Infinity, -Infinity, 0, NaN, 1, -2.5, 0, NaN, 1];
    assert.deepStrictEqual(mapValues(gamesNumeric.round1), round1);
    assert.deepStrictEqual(mapValues(franchiseRules.round1), round1);
    assert.deepStrictEqual(
      mapValues(gamesNumeric.round3),
      [0, 1.005, 1.005, 2.5, -2.5, 0, 7.335, NaN, Infinity, -Infinity, 0, NaN, 1.005, -2.5, 0, NaN, 1]
    );
    assert.deepStrictEqual(
      mapValues(personnelIdentity.round4),
      [0, 1.005, 1.0049, 2.5, -2.5, 0, 7.335, NaN, Infinity, -Infinity, 0, NaN, 1.005, -2.5, 0, NaN, 1]
    );
  });

  test('minutesToHours: stats keeps infinities, personnel answers 0, epic answers null', () => {
    assert.deepStrictEqual(
      mapValues(gamesNumeric.minutesToHours),
      [0, 0, 0, 0, -0, 0, 0.1, 0, Infinity, -Infinity, 0, 0, 0, -0, 0, 0, 0]
    );
    assert.deepStrictEqual(
      mapValues(personnelIdentity.minutesToHours),
      [0, 0, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    );
    assert.deepStrictEqual(
      mapValues(epicSecondary.minutesToHours),
      [0, 0, 0, 0, -0, 0, 0.1, null, null, null, 0, null, 0, -0, 0, null, 0]
    );
  });

  test('mean and median keep the finite-only filter', () => {
    assert.deepStrictEqual(
      [booksNumeric.mean([]), booksNumeric.mean([7, 8]), booksNumeric.mean([7, 7, 8]), booksNumeric.mean([1, 2, NaN, null, '3'])],
      [null, 7.5, 7.33, 1.5]
    );
    assert.deepStrictEqual(
      [gamesNumeric.median([]), gamesNumeric.median([1, 2, 3]), gamesNumeric.median([1, 2, 3, 4]), gamesNumeric.median([3, NaN, 1])],
      [null, 2, 2.5, 2]
    );
  });

  test('dayNumber: films and books agree on every shape', () => {
    const table = [
      ['2024-05-06', 19849],
      ['2024-05-06T10:00:00Z', null],
      ['2024-02', null],
      ['', null],
      [null, null],
      [undefined, null],
      ['garbage', null],
      ['1970-01-01', 0],
      ['2024-13-01', 20089],
      [20240506, null],
    ];
    for (const [input, expected] of table) {
      assert.equal(filmsNumeric.dayNumber(input), expected, `films ${String(input)}`);
      assert.equal(booksNumeric.dayNumber(input), expected, `books ${String(input)}`);
    }
  });

  test('computeStreaks: films reports lastWatchDate, books defaults to lastReadDate', () => {
    assert.deepStrictEqual(filmsNumeric.computeStreaks(null), {
      current: 0,
      best: 0,
      lastWatchDate: null,
      bestDates: [],
    });
    assert.deepStrictEqual(booksNumeric.computeStreaks([]), {
      current: 0,
      best: 0,
      lastReadDate: null,
      bestDates: [],
    });
    const days = [{ date: '2024-05-06' }, { date: '2024-05-07' }, { date: '2024-05-10' }];
    assert.deepStrictEqual(filmsNumeric.computeStreaks(days), {
      current: 1,
      best: 2,
      lastWatchDate: '2024-05-10',
      bestDates: ['2024-05-06', '2024-05-07'],
    });
    assert.deepStrictEqual(booksNumeric.computeStreaks(days), {
      current: 1,
      best: 2,
      lastReadDate: '2024-05-10',
      bestDates: ['2024-05-06', '2024-05-07'],
    });
    assert.deepStrictEqual(booksNumeric.computeStreaks([{ date: '2024-05-06' }], 'lastSeen'), {
      current: 1,
      best: 1,
      lastSeen: '2024-05-06',
      bestDates: ['2024-05-06', '2024-05-06'],
    });
    assert.deepStrictEqual(filmsNumeric.computeStreaks([{ date: '2024-05-06' }, { date: null }, { date: 'x' }]), {
      current: 1,
      best: 1,
      lastWatchDate: '2024-05-06',
      bestDates: ['2024-05-06', '2024-05-06'],
    });
  });

  test('taxonomy avgRating rounds through the plain policy', () => {
    const films = [
      { slug: 'a', rating: 7, genres: [{ id: 16, name: 'Animation' }], keywords: [] },
      { slug: 'b', rating: 8, genres: [{ id: 16, name: 'Animation' }], keywords: [] },
      { slug: 'c', rating: 8, genres: [{ id: 16, name: 'Animation' }], keywords: [] },
    ];
    const taxonomyView = taxonomy.buildTaxonomy(films);
    const animation = taxonomyView.categories.find((bucket) => bucket.key === 'animation');
    assert.equal(animation.avgRating, 7.67);
    assert.equal(animation.count, 3);
  });

  test('profileSummary: books shape', () => {
    const profile = {
      source: 'livelib',
      userKey: 'u',
      events: [
        { id: 'e1', source: 'livelib', userKey: 'u', sourceBookId: 'b1', workId: 'w1', status: 'read', finishedAt: '2024-05-06', rating10: 7 },
        { id: 'e2', source: 'livelib', userKey: 'u', sourceBookId: 'b2', workId: 'w2', status: 'read', finishedAt: '2024-05-07', rating10: 8 },
        { id: 'e3', source: 'livelib', userKey: 'u', sourceBookId: 'b3', workId: 'w3', status: 'reading', readMonth: '2024-06' },
      ],
    };
    const { profileSummary } = require('../server/books/stats');
    assert.deepStrictEqual(profileSummary(profile), {
      eventCount: 3,
      bookCount: 3,
      finishedCount: 2,
      undatedEventCount: 0,
      monthOnlyEventCount: 1,
      readCount: 2,
      reReadCount: 0,
      avgRating: 7.5,
      dateFrom: '2024-05-06',
      dateTo: '2024-05-07',
    });
    assert.deepStrictEqual(profileSummary(null), {
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

  test('profileSummary: games shape', () => {
    const { profileSummary } = require('../server/games/stats');
    assert.deepStrictEqual(
      profileSummary(
        { userKey: '76561198000000001', personaName: 'X', importedAt: '2024-01-01' },
        {
          game_count: 3,
          partial: false,
          games: [
            { appid: 1, playtime_forever: 600 },
            { appid: 2, playtime_forever: 0 },
            { appid: 3, playtime_forever: 1 },
          ],
        }
      ),
      {
        key: 'steam-76561198000000001',
        source: 'steam',
        userKey: '76561198000000001',
        personaName: 'X',
        label: null,
        avatarUrl: null,
        privacy: null,
        importedAt: '2024-01-01',
        libraryPartial: false,
        gameCount: 3,
        ownedCount: 3,
        totalHours: 10,
        playedCount: 2,
      }
    );
    assert.equal(profileSummary(null), null);
  });

  test('core/stats: every rounding policy reproduces its domain table', () => {
    assert.deepStrictEqual(mapValues((value) => coreStats.round2(value, 'plain')), PLAIN_ROUND2);
    assert.deepStrictEqual(mapValues((value) => coreStats.round2(value)), PLAIN_ROUND2);
    assert.deepStrictEqual(mapValues((value) => coreStats.round2(value, 'finite')), FINITE_ROUND2);
    assert.deepStrictEqual(mapValues((value) => coreStats.round2(value, 'numeric')), PLAIN_ROUND2);
    assert.deepStrictEqual(
      mapValues((value) => coreStats.round1(value)),
      [0, 1, 1, 2.5, -2.5, 0, 7.3, NaN, Infinity, -Infinity, 0, NaN, 1, -2.5, 0, NaN, 1]
    );
    assert.deepStrictEqual(
      mapValues((value) => coreStats.round3(value)),
      [0, 1.005, 1.005, 2.5, -2.5, 0, 7.335, NaN, Infinity, -Infinity, 0, NaN, 1.005, -2.5, 0, NaN, 1]
    );
    assert.deepStrictEqual(
      mapValues((value) => coreStats.round4(value, 'numeric')),
      [0, 1.005, 1.0049, 2.5, -2.5, 0, 7.335, NaN, Infinity, -Infinity, 0, NaN, 1.005, -2.5, 0, NaN, 1]
    );
    assert.deepStrictEqual(
      [0.04, 0.05, -0.04, -0.05, 1.15].map((value) => coreStats.round1(value, 'numeric')),
      [0, 0.1, -0, -0, 1.2]
    );
  });

  test('core/stats: mean, dayNumber and computeStreaks match the books surface', () => {
    assert.deepStrictEqual(
      [coreStats.mean([]), coreStats.mean([7, 8]), coreStats.mean([7, 7, 8]), coreStats.mean([1, 2, NaN, null, '3'])],
      [null, 7.5, 7.33, 1.5]
    );
    assert.equal(coreStats.dayNumber('2024-05-06'), 19849);
    assert.equal(coreStats.dayNumber('2024-13-01'), 20089);
    assert.equal(coreStats.dayNumber('2024-05-06T10:00:00Z'), null);
    assert.deepStrictEqual(coreStats.computeStreaks([{ date: '2024-05-06' }], 'lastReadDate'), {
      current: 1,
      best: 1,
      lastReadDate: '2024-05-06',
      bestDates: ['2024-05-06', '2024-05-06'],
    });
  });

  const SERVER_DIR = path.join(__dirname, '..', 'server');

  const serverSources = () =>
    fs
      .readdirSync(SERVER_DIR, { recursive: true })
      .filter((name) => name.endsWith('.js'))
      .map((name) => fs.readFileSync(path.join(SERVER_DIR, name), 'utf8'));

  const definitionsOf = (sources, name) =>
    sources.reduce((count, source) => count + (source.match(new RegExp(`function ${name}\\(`, 'g')) || []).length, 0);

  test('one definition per numeric concept in server/', () => {
    const sources = serverSources();
    assert.equal(definitionsOf(sources, 'round2'), 1, 'round2');
    assert.equal(definitionsOf(sources, 'computeStreaks'), 1, 'computeStreaks');
    assert.equal(definitionsOf(sources, 'dayNumber'), 1, 'dayNumber');
    assert.equal(definitionsOf(sources, 'round1'), 1, 'round1');
    assert.equal(definitionsOf(sources, 'round3'), 1, 'round3');
    assert.equal(definitionsOf(sources, 'round4'), 1, 'round4');
    assert.equal(definitionsOf(sources, 'mean'), 1, 'mean');
  });
  after(() => env.resetMutableState());
});


describe('core-params', () => {
  /**
   * `server/core/params.js`: the strict query contract shared by the books and
   * games routers. An unknown parameter or an unparsable value is a 400 with a
   * stable code; the messages match the pre-refactor routers.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');

  const {
    assertOnlyParams,
    parseBoolParam,
    parseMinHours,
    parseInteger,
    parseEnum,
  } = require('../server/core/params');
  const { HttpError } = require('../server/core/errors');

  function expect400(fn, code) {
    assert.throws(fn, (err) => {
      assert.ok(err instanceof HttpError, `expected HttpError, got ${err}`);
      assert.equal(err.status, 400);
      assert.equal(err.code, code);
      return true;
    });
  }

  test('assertOnlyParams accepts exactly the listed parameters', () => {
    assertOnlyParams({ query: { profile: 'steam-1', minHours: '0' } }, ['profile', 'minHours'], 'GET /x');
    assertOnlyParams({ query: {} }, [], 'GET /x');
    assertOnlyParams({}, ['profile'], 'GET /x');
  });

  test('assertOnlyParams rejects the first unexpected parameter with a 400', () => {
    expect400(
      () => assertOnlyParams({ query: { profile: 'a', sources: 'x' } }, ['profile'], 'GET /api/books/stats'),
      'unexpected_parameter'
    );
    assert.throws(
      () => assertOnlyParams({ query: { bogus: '1' } }, [], 'GET /api/games/stats'),
      /Unexpected query parameter\(s\) for GET \/api\/games\/stats: "bogus"\. Accepted: \./
    );
  });

  test('parseBoolParam: 0/1 forms, fallback for empty, 400 for junk', () => {
    for (const value of ['1', 'true', 'YES', ' on ']) assert.equal(parseBoolParam(value, 'flag', false), true);
    for (const value of ['0', 'false', 'NO', ' off ']) assert.equal(parseBoolParam(value, 'flag', true), false);
    assert.equal(parseBoolParam(undefined, 'flag', true), true);
    assert.equal(parseBoolParam('', 'flag', false), false);
    expect400(() => parseBoolParam('maybe', 'includeFree', true), 'invalid_includeFree');
  });

  test('parseMinHours: -1, 0 and N; fractions and text are 400', () => {
    assert.equal(parseMinHours(undefined), 0);
    assert.equal(parseMinHours(''), 0);
    assert.equal(parseMinHours('-1'), -1);
    assert.equal(parseMinHours('0'), 0);
    assert.equal(parseMinHours('12'), 12);
    assert.equal(parseMinHours(null, 3), 3);
    for (const value of ['1.5', '-2', 'abc', '1e3']) {
      expect400(() => parseMinHours(value), 'invalid_minHours');
    }
  });

  test('parseInteger enforces the declared range', () => {
    assert.equal(parseInteger('7', { name: 'limit', min: 1, max: 10 }), 7);
    assert.equal(parseInteger(undefined, { name: 'limit', fallback: 5 }), 5);
    expect400(() => parseInteger('0', { name: 'limit', min: 1 }), 'invalid_limit');
    expect400(() => parseInteger('11', { name: 'limit', max: 10 }), 'invalid_limit');
    expect400(() => parseInteger('x', { name: 'limit' }), 'invalid_limit');
  });

  test('parseEnum is case-insensitive and reports the allowed values', () => {
    assert.equal(parseEnum('DETAILS', 'phase', ['details', 'spy']), 'details');
    assert.equal(parseEnum(undefined, 'phase', ['details'], null), null);
    assert.throws(() => parseEnum('all', 'phase', ['details', 'spy']), /must be one of: details, spy/);
  });
  after(() => env.resetMutableState());
});


describe('core-politeness', () => {
  /**
   * Cross-source politeness contract (P2): the table in `core/sources.js`, the
   * counter in `core/budget.js` and the breaker in `core/breaker.js` are the
   * only places those rules live now.
   *
   * Four claims, one per AGENTS.md §1 rule:
   *   1. the pause is read from the table and actually awaited;
   *   2. the per-run budget is not exceeded (one unit per request);
   *   3. a 429 opens the persisted breaker and the next client does not ask;
   *   4. a 5xx is deferred: it throws, writes nothing and does not trip the
   *      breaker.
   *
   * No live request: the store client's `request` is injected, the clock and
   * sleep are fake, and the cache roots point at a tmp directory.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');

  const env = require('./helpers/env');
  const tmp = env.currentDirs();

  const store = require('../server/games/store');
  const gameCache = require('../server/games/game-cache');
  const sources = require('../server/core/sources');
  const { createBudget } = require('../server/core/budget');
  const { readFixture } = require('./fixtures/games/fake-client');

  function fixture(appid) {
    return JSON.parse(readFixture(`appdetails-${appid}.json`));
  }

  test.after(() => {
    tmp.cleanup();
  });

  test('the pause comes from core/sources and is awaited between requests', async () => {
    assert.equal(sources.pauseMs('steamStore'), 1700);
    const sleeps = [];
    let clock = 100000;
    const client = store.createClient({
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      request: async () => {
        clock += 100;
        return { status: 200, body: JSON.stringify(fixture(620)), headers: {} };
      },
    });
    await client.getAppDetails(620);
    await client.getAppDetails(620);
    assert.deepEqual(sleeps, [1600]);
  });

  test('the per-run budget stops before the request, not after it', () => {
    const previous = process.env.GAMES_SPY_BUDGET;
    delete process.env.GAMES_SPY_BUDGET;
    const limit = sources.budgetLimit('steamSpy');
    assert.equal(limit, 340);
    const budget = createBudget(limit);
    for (let index = 0; index < limit; index++) assert.equal(budget.take(), true);
    assert.equal(budget.take(), false);
    assert.equal(budget.used, limit);
    assert.equal(budget.remaining, 0);
    if (previous == null) delete process.env.GAMES_SPY_BUDGET;
    else process.env.GAMES_SPY_BUDGET = previous;
  });

  test('a 429 opens the persisted breaker; the next client does not ask', async () => {
    gameCache.writeBreaker({});
    let clock = 100000;
    let calls = 0;
    const client = store.createClient({
      now: () => clock,
      sleep: async () => {},
      request: async () => {
        calls++;
        return { status: 429, body: '', headers: {} };
      },
    });
    await assert.rejects(() => client.getAppDetails(620), (err) => err.code === 'store_rate_limited');
    assert.equal(calls, 1);
    const state = gameCache.readBreaker();
    const entry = state[store.STORE_HOST];
    assert.ok(entry, 'breaker entry must be persisted');
    assert.ok(entry.until > clock);
    assert.equal(entry.reason, '429 Too Many Requests');

    const second = store.createClient({ now: () => clock, sleep: async () => {} });
    await assert.rejects(() => second.getAppDetails(570), (err) => err.code === 'store_rate_limited');
    assert.equal(calls, 1, 'an open breaker refuses without a request');
    gameCache.writeBreaker({});
  });

  test('a 5xx is deferred: it throws, writes nothing and does not trip the breaker', async () => {
    gameCache.writeBreaker({});
    let calls = 0;
    const client = store.createClient({
      now: () => 100000,
      sleep: async () => {},
      request: async () => {
        calls++;
        return { status: 503, body: 'oops', headers: {} };
      },
    });
    await assert.rejects(() => client.getAppDetails(620), (err) => err.code === 'store_http_error');
    assert.equal(calls, 1);
    assert.deepEqual(gameCache.readBreaker(), {});
  });
  after(() => env.resetMutableState());
});


describe('core-profile', () => {
  /**
   * `server/core/profile.js` — the owner (profile) registry (U8).
   *
   * Pinned here:
   *   - a domain registers ONE lazy lister: it is not called at registration
   *     time and is called on EVERY read, so a finished import shows up on the
   *     next `GET /api/{domain}/profiles` without a restart;
   *   - the snapshot is validated (a token-shaped `id`, one `primary`, typed
   *     `enrichers`/`metrics`) and the legacy per-profile fields are copied
   *     through untouched — that is what makes the unified form additive;
   *   - `sources` is either declared by the domain or derived from the owners
   *     (`primary` wins over `enricher`, `expired` only when every binding of
   *     that source is expired);
   *   - `resolveOwnerOrThrow` answers the same three codes as the domain routers
   *     (`profile_required` / `invalid_profile` / `unknown_profile`) and refuses
   *     a token that is a path (`../`, `/`), a CSV or a repeated parameter.
   *
   * The registry has no cache/network dependency of its own, so this test
   * registers fake domains and never touches a tmp cache.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');

  const profile = require('../server/core/profile');

  const { HttpError } = require('../server/core/errors');

  /** A minimal valid owner. */
  function owner(id, extra = {}) {
    return {
      id,
      label: null,
      primary: { source: id.split('-')[0], userKey: id.split('-').slice(1).join('-') },
      enrichers: [],
      metrics: {},
      ...extra,
    };
  }

  function withDomain(name, listFn, fn) {
    profile.registerDomainProfiles(name, listFn);
    try {
      return fn();
    } finally {
      profile.unregisterDomainProfiles(name);
    }
  }

  function httpError(predicate) {
    return (err) => {
      assert.ok(err instanceof HttpError, `expected HttpError, got ${err && err.stack}`);
      return predicate(err);
    };
  }

  test('registration is lazy and every read sees the current cache', () => {
    let calls = 0;
    let rows = [owner('steam-76561198000000001')];

    withDomain(
      'core-profile-lazy',
      () => {
        calls += 1;
        return { profiles: rows };
      },
      () => {
        assert.equal(calls, 0, 'listFn must not run at registration time');
        assert.equal(profile.listOwners('core-profile-lazy').length, 1);
        assert.equal(calls, 1);

        // A finished import: the next read must see it without re-registering.
        rows = [...rows, owner('steam-76561198000000002')];
        const ids = profile.listOwners('core-profile-lazy').map((entry) => entry.id);
        assert.deepEqual(ids, ['steam-76561198000000001', 'steam-76561198000000002']);
        assert.equal(calls, 2);
      }
    );
  });

  test('snapshot keeps the legacy fields and fills the unified ones', () => {
    withDomain(
      'core-profile-shape',
      () => ({
        profiles: [
          {
            ...owner('livelib-Margaret'),
            // legacy domain fields, passed through untouched
            key: 'livelib-Margaret',
            summary: { eventCount: 3 },
            metrics: undefined,
          },
        ],
      }),
      () => {
        const [entry] = profile.listOwners('core-profile-shape');
        assert.equal(entry.key, 'livelib-Margaret');
        assert.deepEqual(entry.summary, { eventCount: 3 });
        assert.equal(entry.label, null, 'a missing label is null, not undefined');
        assert.deepEqual(entry.metrics, {}, 'a missing metrics is an empty object');
        assert.deepEqual(entry.primary, {
          source: 'livelib',
          userKey: 'Margaret',
          status: 'connected',
          updatedAt: null,
        });
        assert.deepEqual(entry.enrichers, []);
      }
    );
  });

  test('an invalid owner record fails fast instead of leaking a half-form', () => {
    const cases = [
      ['a path is not a token', { ...owner('livelib-Margaret'), id: '../etc/passwd' }],
      ['an empty id', { ...owner('livelib-Margaret'), id: '  ' }],
      ['a missing primary', { ...owner('livelib-Margaret'), primary: null }],
      ['an unknown status', { ...owner('livelib-Margaret'), primary: { source: 'livelib', status: 'nope' } }],
      ['enrichers that are not an array', { ...owner('livelib-Margaret'), enrichers: 'gog' }],
      ['metrics that are not an object', { ...owner('livelib-Margaret'), metrics: 42 }],
      ['a non-string label', { ...owner('livelib-Margaret'), label: 7 }],
    ];
    for (const [label, record] of cases) {
      assert.throws(
        () =>
          withDomain('core-profile-bad', () => ({ profiles: [record] }), () =>
            profile.listOwners('core-profile-bad')
          ),
        TypeError,
        label
      );
    }

    assert.throws(
      () =>
        withDomain('core-profile-dup', () => ({ profiles: [owner('steam-1'), owner('steam-1')] }), () =>
          profile.listOwners('core-profile-dup')
        ),
      /duplicate owner id/,
      'two owners with one id would make resolveOwnerOrThrow ambiguous'
    );
  });

  test('sources are derived from the owners when the domain sends only a list', () => {
    const rows = [
      {
        ...owner('steam-1'),
        enrichers: [
          { source: 'gog', userKey: '42', status: 'expired' },
          { source: 'epic', userKey: 'acc-1' },
        ],
      },
      {
        ...owner('steam-2'),
        enrichers: [{ source: 'gog', userKey: '43' }],
      },
    ];
    withDomain('core-profile-derived', () => rows, () => {
      assert.deepEqual(profile.listSources('core-profile-derived'), [
        { id: 'steam', role: 'primary', connected: true, state: 'ready' },
        { id: 'gog', role: 'enricher', connected: true, state: 'ready' },
        { id: 'epic', role: 'enricher', connected: true, state: 'ready' },
      ]);

      // Only expired GOG bindings -> the source itself is expired.
      profile.unregisterDomainProfiles('core-profile-derived');
      profile.registerDomainProfiles('core-profile-derived', () => [rows[0]]);
      const [gog] = profile.listSources('core-profile-derived').filter((entry) => entry.id === 'gog');
      assert.equal(gog.state, 'expired');
      assert.equal(gog.connected, true, 'an expired binding is still a binding');
    });
  });

  test('a declared sources table wins over the derived one', () => {
    withDomain(
      'core-profile-declared',
      () => ({
        profiles: [owner('steam-1')],
        sources: [
          { id: 'steam', role: 'primary', connected: true, state: 'ready' },
          { id: 'gog', role: 'enricher', connected: false, state: 'missing' },
        ],
      }),
      () => {
        assert.deepEqual(profile.listSources('core-profile-declared'), [
          { id: 'steam', role: 'primary', connected: true, state: 'ready' },
          { id: 'gog', role: 'enricher', connected: false, state: 'missing' },
        ]);
      }
    );

    assert.throws(
      () =>
        withDomain(
          'core-profile-bad-source',
          () => ({ profiles: [], sources: [{ id: 'gog', role: 'secondary' }] }),
          () => profile.listSources('core-profile-bad-source')
        ),
      TypeError,
      'only primary|enricher are roles'
    );
  });

  test('resolveOwnerOrThrow: exact id, case-insensitive key, alias and pattern', () => {
    const rows = [owner('steam-76561198000000001'), owner('livelib-Margaret')];
    withDomain('core-profile-resolve', () => rows, () => {
      assert.equal(
        profile.resolveOwnerOrThrow('core-profile-resolve', 'steam-76561198000000001').id,
        'steam-76561198000000001'
      );
      // A client may lower-case the token; the canonical id comes back.
      assert.equal(
        profile.resolveOwnerOrThrow('core-profile-resolve', 'LIVELIB-margaret').id,
        'livelib-Margaret'
      );
      // The `?profile=` array form with one value is still one token.
      assert.equal(
        profile.resolveOwnerOrThrow('core-profile-resolve', ['livelib-Margaret', '']).id,
        'livelib-Margaret'
      );
      // Aliases (the films endpoint takes a bare kpUserId) resolve first.
      assert.equal(
        profile.resolveOwnerOrThrow('core-profile-resolve', 'kp:1', {
          aliases: { 'kp:1': 'steam-76561198000000001' },
        }).id,
        'steam-76561198000000001'
      );
      assert.equal(
        profile.resolveOwnerOrThrow('core-profile-resolve', 'x', {
          aliases: (token) => (token === 'x' ? 'livelib-Margaret' : null),
        }).id,
        'livelib-Margaret'
      );
      // A per-domain shape check keeps `invalid_profile` for a foreign token.
      assert.throws(
        () =>
          profile.resolveOwnerOrThrow('core-profile-resolve', 'livelib-Margaret', {
            pattern: /^steam-\d{17}$/i,
          }),
        httpError((err) => err.code === 'invalid_profile' && err.status === 400)
      );
      // `require` is how a route keeps refusing a cached-but-unusable owner.
      assert.throws(
        () => profile.resolveOwnerOrThrow('core-profile-resolve', 'livelib-Margaret', { require: () => false }),
        httpError((err) => err.code === 'unknown_profile')
      );
    });
  });

  test('resolveOwnerOrThrow: profile_required / invalid_profile / unknown_profile', () => {
    const rows = [owner('steam-76561198000000001')];
    withDomain('core-profile-codes', () => rows, () => {
      const required = [
        undefined,
        null,
        '',
        '   ',
        [],
        [''],
      ];
      for (const raw of required) {
        assert.throws(
          () => profile.resolveOwnerOrThrow('core-profile-codes', raw),
          httpError(
            (err) =>
              err.code === 'profile_required' &&
              err.status === 400 &&
              err.message.includes('steam-76561198000000001')
          ),
          `expected profile_required for ${JSON.stringify(raw)}`
        );
      }

      const malformed = [
        ['a repeated parameter', ['steam-76561198000000001', 'steam-76561198000000002']],
        ['a CSV', 'steam-76561198000000001,steam-76561198000000002'],
        ['whitespace inside the token', 'steam 1'],
        ['a semicolon list', 'steam-1;steam-2'],
        ['a path', '../cache/kp/1.json'],
        ['a slash', 'steam/1'],
        ['a dot-dot key', 'livelib-..'],
        ['an over-long token', `steam-${'1'.repeat(200)}`],
      ];
      for (const [label, raw] of malformed) {
        assert.throws(
          () => profile.resolveOwnerOrThrow('core-profile-codes', raw),
          httpError((err) => err.code === 'invalid_profile' && err.status === 400),
          label
        );
      }

      assert.throws(
        () => profile.resolveOwnerOrThrow('core-profile-codes', 'steam-76561198000000009'),
        httpError(
          (err) =>
            err.code === 'unknown_profile' &&
            err.status === 400 &&
            err.message.includes('steam-76561198000000009') &&
            err.message.includes('steam-76561198000000001')
        )
      );
    });
  });

  test('the error body is the documented { error, code } shape', () => {
    withDomain('core-profile-body', () => [], () => {
      let caught = null;
      try {
        profile.resolveOwnerOrThrow('core-profile-body', undefined);
      } catch (err) {
        caught = err;
      }
      assert.equal(caught.code, 'profile_required');
      assert.equal(caught.status, 400);
      assert.equal(typeof caught.message, 'string');
      // `respondError` renders exactly these two fields.
      assert.deepEqual(Object.keys({ error: caught.message, code: caught.code }), ['error', 'code']);
    });
  });

  test('a legacy non-ASCII owner id is listed, not dropped', () => {
    // The import grammar is ASCII, but an older cache may hold another userKey.
    // Listing it is harmless; resolving it stays strict (`invalid_profile`).
    withDomain(
      'core-profile-legacy',
      () => ({ profiles: [owner('livelib-Маргарита')] }),
      () => {
        assert.equal(profile.listOwners('core-profile-legacy')[0].id, 'livelib-Маргарита');
        assert.throws(
          () => profile.resolveOwnerOrThrow('core-profile-legacy', 'livelib-Маргарита'),
          httpError((err) => err.code === 'invalid_profile')
        );
      }
    );
  });

  test('a domain is registered once; an unknown domain is a wiring error', () => {
    const listFn = () => ({ profiles: [] });
    profile.registerDomainProfiles('core-profile-once', listFn);
    try {
      assert.throws(() => profile.registerDomainProfiles('core-profile-once', listFn), /already registered/);
      assert.ok(profile.listRegisteredDomains().includes('core-profile-once'));
    } finally {
      profile.unregisterDomainProfiles('core-profile-once');
    }

    assert.equal(profile.listRegisteredDomains().includes('core-profile-once'), false);
    assert.throws(() => profile.listOwners('core-profile-unknown'), /is not registered/);
    assert.throws(() => profile.resolveOwnerOrThrow('core-profile-unknown', 'steam-1'), /is not registered/);
    assert.throws(() => profile.registerDomainProfiles('', listFn), TypeError);
    assert.throws(() => profile.registerDomainProfiles('x', 'nope'), TypeError);
  });
  after(() => env.resetMutableState());
});


describe('core-sources', () => {
  /**
   * `core/sources.js` — the declarative politeness table.
   *
   * Values are transcribed from the constants the modules carried; this test
   * pins the AGENTS.md §1 numbers so a future edit cannot silently loosen a
   * pause, a budget or a breaker.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');

  const sources = require('../server/core/sources');

  const MINUTE = 60 * 1000;
  const DAY = 24 * 60 * MINUTE;

  test('the table covers every source the phase declares', () => {
    const expected = [
      'tmdb',
      'kinopoisk',
      'wdqs',
      'livelib',
      'hardcover',
      'litres',
      'googlebooks',
      'steam',
      'steamCommunity',
      'steamStore',
      'steamSpy',
      'steamReviews',
      'gog',
      'epic',
      'secondary',
      'moby',
      'wikidataFranchise',
    ];
    for (const id of expected) {
      assert.ok(sources.SOURCES[id], `missing source ${id}`);
    }
    assert.equal(sources.SOURCE_IDS.length, Object.keys(sources.SOURCES).length);
  });

  test('pauses match AGENTS.md §1', () => {
    assert.equal(sources.pauseMs('litres'), 2000);
    assert.equal(sources.pauseMs('googlebooks'), 400);
    assert.equal(sources.pauseMs('steamSpy'), 1100);
    assert.equal(sources.pauseMs('steamReviews'), 1700);
    assert.equal(sources.pauseMs('secondary'), 2000);
    assert.equal(sources.SOURCES.secondary.epicPauseMs, 1500);
    assert.equal(sources.pauseMs('steamCommunity'), 2000);
    assert.equal(sources.pauseMs('moby'), 1100);
  });

  test('budgets match AGENTS.md §1 and env names are the real ones', () => {
    assert.equal(sources.budgetLimit('litres'), 200);
    assert.equal(sources.SOURCES.litres.budgetEnv, 'BOOKS_LITRES_BUDGET');
    assert.equal(sources.budgetLimit('googlebooks'), 300);
    assert.equal(sources.SOURCES.googlebooks.budgetEnv, 'BOOKS_GB_BUDGET');
    assert.equal(sources.budgetLimit('steamSpy'), 340);
    assert.equal(sources.SOURCES.steamSpy.budgetEnv, 'GAMES_SPY_BUDGET');
    assert.equal(sources.budgetLimit('steamReviews'), 340);
    assert.equal(sources.SOURCES.steamReviews.budgetEnv, 'GAMES_REVIEWS_BUDGET');
    assert.equal(sources.budgetLimit('secondary'), 200);
    assert.equal(sources.SOURCES.secondary.budgetEnv, 'GAMES_SECONDARY_BUDGET');
    assert.equal(sources.budgetLimit('steam'), null);
  });

  test('breakers are 30 minutes and keyed by the documented host', () => {
    for (const id of ['litres', 'googlebooks', 'steam', 'steamCommunity', 'steamStore', 'steamSpy', 'steamReviews', 'gog', 'epic', 'secondary', 'moby']) {
      assert.equal(sources.breakerMs(id), 30 * MINUTE, `${id} breaker`);
    }
    assert.equal(sources.breakerMs('tmdb'), null);
    assert.equal(sources.SOURCES.steamReviews.breakerKey, 'api.steampowered.com/IUserReviewsService');
  });

  test('TTLs mirror the runtime owners without taking them over', () => {
    assert.equal(sources.ttlMs('steamStore'), 180 * DAY);
    assert.equal(sources.ttlMs('steamSpy'), 30 * DAY);
    assert.equal(sources.ttlMs('steamReviews'), 30 * DAY);
    assert.equal(sources.ttlMs('secondary'), 30 * DAY);
    assert.equal(sources.ttlMs('wikidataFranchise'), 90 * DAY);
    assert.equal(sources.ttlMs('tmdb'), null);
  });

  test('env overrides are read at call time, not at require time', () => {
    const previous = process.env.GAMES_SPY_PAUSE_MS;
    try {
      process.env.GAMES_SPY_PAUSE_MS = '5';
      assert.equal(sources.pauseMs('steamSpy'), 5);
      process.env.GAMES_SPY_PAUSE_MS = 'nope';
      assert.equal(sources.pauseMs('steamSpy'), 1100);
    } finally {
      if (previous == null) delete process.env.GAMES_SPY_PAUSE_MS;
      else process.env.GAMES_SPY_PAUSE_MS = previous;
    }
  });

  test('getSource throws for an unknown id instead of guessing a policy', () => {
    assert.throws(() => sources.getSource('nope'), /unknown source/);
  });

  test('env=0 means «off» for pause, budget, TTL, breaker and timeout', () => {
    const names = [
      'GAMES_SPY_PAUSE_MS',
      'GAMES_MOBY_PAUSE_MS',
      'GAMES_GOG_BUDGET',
      'GAMES_MOBY_BUDGET',
      'GAMES_SECONDARY_TTL_MS',
      'GAMES_FRANCHISE_TTL_DAYS',
      'GAMES_STORE_BREAKER_MS',
      'GAMES_SECONDARY_TIMEOUT_MS',
    ];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) process.env[name] = '0';
      assert.equal(sources.pauseMs('steamSpy'), 0);
      assert.equal(sources.pauseMs('moby'), 0);
      assert.equal(sources.budgetLimit('gog'), 0);
      assert.equal(sources.budgetLimit('moby'), 0);
      assert.equal(sources.ttlMs('secondary'), 0);
      assert.equal(sources.ttlMs('wikidataFranchise'), 0);
      assert.equal(sources.breakerMs('steamStore'), 0);
      assert.equal(sources.timeoutMs('secondary'), 0);

      // Empty is unset, not zero.
      process.env.GAMES_SPY_PAUSE_MS = '';
      assert.equal(sources.pauseMs('steamSpy'), 1100);
    } finally {
      for (const name of names) {
        if (saved[name] == null) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });

  test('core/env envMs keeps the same 0 = off convention', () => {
    const { envMs } = require('../server/core/env');
    const name = 'KINOBOXD_TEST_TTL_MS';
    const saved = process.env[name];
    try {
      process.env[name] = '0';
      assert.equal(envMs(name, 1234), 0);
      process.env[name] = '';
      assert.equal(envMs(name, 1234), 1234);
      process.env[name] = '-5';
      assert.equal(envMs(name, 1234), 1234);
    } finally {
      if (saved == null) delete process.env[name];
      else process.env[name] = saved;
    }
  });

  test('the LiveLib card pause stays at the pre-P2 2 s', () => {
    assert.equal(sources.SOURCES.livelib.cardPauseMs, 2000);
    assert.equal(sources.pauseMs('livelib'), 1500, 'bulk import keeps its random range');
  });
  after(() => env.resetMutableState());
});


describe('config-gbooks-key', () => {
  // Unit tests for the Google Books key plumbing in server/config.js.
  //
  // Each case runs in a child process against a throwaway copy of config.js so
  // that the real repo key file (config/gbooks-token, gitignored) never
  // participates and the environment is fully controlled. The value is never
  // asserted by echo: only the source name and presence are.

  const { test } = require('node:test');
  const assert = require('node:assert');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');

  const SOURCE = path.join(__dirname, '..', 'server', 'config.js');

  function sandbox({ keyFile } = {}) {
    const dir = env.tmpDir('kb-gb-config-');
    fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    fs.copyFileSync(SOURCE, path.join(dir, 'server', 'config.js'));
    // config.js delegates the loading itself to server/core/secrets.js.
    fs.mkdirSync(path.join(dir, 'server', 'core'), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, '..', 'server', 'core', 'secrets.js'),
      path.join(dir, 'server', 'core', 'secrets.js')
    );
    if (keyFile !== undefined) {
      fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'config', 'gbooks-token'), keyFile);
    }
    return dir;
  }

  function childEnv(extra) {
    const env = { ...process.env };
    delete env.GB_API_KEY;
    delete env.BOOKS_GOOGLE_API_KEY;
    delete env.HARDCOVER_API_TOKEN;
    delete env.HARDCOVER_READ_TOKEN;
    delete env.TMDB_API_TOKEN;
    delete env.TMDB_READ_ACCESS_TOKEN;
    return { ...env, ...extra };
  }

  function run(dir, env, code) {
    return execFileSync(process.execPath, ['-e', code], {
      cwd: dir,
      env: childEnv(env),
      encoding: 'utf8',
    }).trim();
  }

  const PROBE = `
    const config = require('./server/config');
    const key = config.loadGbooksKey();
    process.stdout.write(JSON.stringify({
      present: typeof key === 'string' && key.length > 0,
      source: config.gbooksKeySource(),
    }));
  `;

  test('gbooks key: missing everywhere is not an error (anonymous mode)', () => {
    const dir = sandbox();
    const out = JSON.parse(run(dir, {}, PROBE));
    assert.deepStrictEqual(out, { present: false, source: null });
  });

  test('gbooks key: config/gbooks-token fallback is used and trimmed', () => {
    const dir = sandbox({ keyFile: '  AIzaSy_from_file\n\n' });
    const out = JSON.parse(run(dir, {}, PROBE));
    assert.deepStrictEqual(out, { present: true, source: 'file' });
  });

  test('gbooks key: GB_API_KEY wins over the file', () => {
    const dir = sandbox({ keyFile: 'AIzaSy_from_file\n' });
    const out = JSON.parse(run(dir, { GB_API_KEY: 'AIzaSy_from_env' }, PROBE));
    assert.deepStrictEqual(out, { present: true, source: 'GB_API_KEY' });
  });

  test('gbooks key: BOOKS_GOOGLE_API_KEY is the alias (env > file)', () => {
    const dir = sandbox({ keyFile: 'AIzaSy_from_file\n' });
    const out = JSON.parse(run(dir, { BOOKS_GOOGLE_API_KEY: 'AIzaSy_alias' }, PROBE));
    assert.deepStrictEqual(out, { present: true, source: 'BOOKS_GOOGLE_API_KEY' });
  });

  test('gbooks key: blank env values fall through to the file', () => {
    const dir = sandbox({ keyFile: 'AIzaSy_from_file\n' });
    const out = JSON.parse(run(dir, { GB_API_KEY: '   ', BOOKS_GOOGLE_API_KEY: '\n' }, PROBE));
    assert.deepStrictEqual(out, { present: true, source: 'file' });
  });
  after(() => env.resetMutableState());
});


describe('config-hardcover-token', () => {
  // Unit tests for the Hardcover token plumbing in server/config.js.
  //
  // Each case runs in a child process against a throwaway copy of config.js so
  // that the real repo token file (config/hardcover-token, gitignored) never
  // participates and the environment is fully controlled.

  const { test } = require('node:test');
  const assert = require('node:assert');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');

  const SOURCE = path.join(__dirname, '..', 'server', 'config.js');

  function sandbox({ tokenFile } = {}) {
    const dir = env.tmpDir('kb-hc-config-');
    fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    fs.copyFileSync(SOURCE, path.join(dir, 'server', 'config.js'));
    // config.js delegates the loading itself to server/core/secrets.js.
    fs.mkdirSync(path.join(dir, 'server', 'core'), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, '..', 'server', 'core', 'secrets.js'),
      path.join(dir, 'server', 'core', 'secrets.js')
    );
    if (tokenFile !== undefined) {
      fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'config', 'hardcover-token'), tokenFile);
    }
    return dir;
  }

  function childEnv(extra) {
    const env = { ...process.env };
    delete env.HARDCOVER_API_TOKEN;
    delete env.HARDCOVER_READ_TOKEN;
    delete env.TMDB_API_TOKEN;
    delete env.TMDB_READ_ACCESS_TOKEN;
    return { ...env, ...extra };
  }

  function run(dir, env, code) {
    return execFileSync(process.execPath, ['-e', code], {
      cwd: dir,
      env: childEnv(env),
      encoding: 'utf8',
    }).trim();
  }

  const PROBE = `
    const config = require('./server/config');
    try {
      process.stdout.write(JSON.stringify({
        token: config.getHardcoverToken(),
        source: config.hardcoverTokenSource(),
      }));
    } catch (err) {
      process.stdout.write(JSON.stringify({ code: err.code, message: err.message }));
    }
  `;

  test('hardcover token: missing everywhere gives HARDCOVER_TOKEN_MISSING', () => {
    const dir = sandbox();
    const out = JSON.parse(run(dir, {}, PROBE));
    assert.strictEqual(out.code, 'HARDCOVER_TOKEN_MISSING');
    assert.match(out.message, /HARDCOVER_API_TOKEN/);
  });

  test('hardcover token: config/hardcover-token fallback is used and trimmed', () => {
    const dir = sandbox({ tokenFile: '  hc_pat_from_file\n\n' });
    const out = JSON.parse(run(dir, {}, PROBE));
    assert.deepStrictEqual(out, { token: 'hc_pat_from_file', source: 'file' });
  });

  test('hardcover token: HARDCOVER_API_TOKEN wins over the file', () => {
    const dir = sandbox({ tokenFile: 'hc_pat_from_file\n' });
    const out = JSON.parse(
      run(dir, { HARDCOVER_API_TOKEN: 'hc_pat_from_env' }, PROBE),
    );
    assert.deepStrictEqual(out, {
      token: 'hc_pat_from_env',
      source: 'HARDCOVER_API_TOKEN',
    });
  });

  test('hardcover token: HARDCOVER_READ_TOKEN is the alias (env > file)', () => {
    const dir = sandbox({ tokenFile: 'hc_pat_from_file\n' });
    const out = JSON.parse(
      run(dir, { HARDCOVER_READ_TOKEN: 'hc_pat_alias' }, PROBE),
    );
    assert.deepStrictEqual(out, {
      token: 'hc_pat_alias',
      source: 'HARDCOVER_READ_TOKEN',
    });
  });

  test('hardcover token: blank env values fall through to the file', () => {
    const dir = sandbox({ tokenFile: 'hc_pat_from_file\n' });
    const out = JSON.parse(
      run(
        dir,
        { HARDCOVER_API_TOKEN: '   ', HARDCOVER_READ_TOKEN: '\n' },
        PROBE,
      ),
    );
    assert.deepStrictEqual(out, { token: 'hc_pat_from_file', source: 'file' });
  });

  test('hardcover token: requiring config stays lazy (server starts without it)', () => {
    const dir = sandbox(); // no env, no token file
    const out = run(
      dir,
      {},
      `const c = require('./server/config');
       process.stdout.write(typeof c.getHardcoverToken + ':' + typeof c.getTmdbToken);`,
    );
    assert.strictEqual(out, 'function:function');
  });
  after(() => env.resetMutableState());
});


describe('films-attach-persisted-profile', () => {
  /**
   * Letterboxd attachment after a server restart.
   *
   * The in-memory upload store forgets its ids on restart, but the KinoPoisk
   * profile (cache/kp/{userId}.json) and the attachment
   * (cache/profile-lb/{userId}.json) are persistent. The browser keeps showing
   * the cached dashboard and remembers the stale uploadId, so both routes must
   * accept the persistent owner (`kpUserId`) as a fallback:
   *
   *   GET  /api/stats?uploadId=<stale>&kpUserId=<id>  -> 200 rebuilt payload
   *   POST /api/attach/lbzip (uploadId=<stale>&kpUserId=<id>) -> 200
   *
   * Without the fallback the UI says «Выгрузка не найдена на сервере» right
   * after the user picks the ZIP, which is the bug this suite pins.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');

  const env = require('./helpers/env');
  const tmp = env.currentDirs();

  const express = require('express');
  const AdmZip = require('adm-zip');
  const { errorMiddleware } = require('../server/core/errors');

  const cache = require('../server/cache');
  const filmsRouter = require('../server/films/routes');

  const KP_USER = '15702206';
  const STALE_UPLOAD = 'deadbeefdeadbeefdeadbeef';

  function seedProfile() {
    const dir = path.join(tmp.cacheDir, 'kp');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${KP_USER}.json`),
      JSON.stringify({
        fetchedAt: '2026-10-26T13:30:00.000Z',
        kpNick: 'tester',
        entries: [
          {
            kpId: 1,
            type: 'film',
            titleRu: 'Альфа',
            titleEn: 'Alpha',
            year: 2001,
            ratedAt: '2025-01-01T00:00:00.000Z',
            rating: 8,
          },
          {
            kpId: 2,
            type: 'film',
            titleRu: 'Бета',
            titleEn: 'Beta',
            year: 2002,
            ratedAt: '2025-02-01T00:00:00.000Z',
            rating: 7,
          },
        ],
      }),
      'utf8'
    );

    // Known misses: no TMDB request is made while matching the archive.
    for (const title of ['Alpha', 'Beta']) {
      cache.setIndexValue(cache.makeKindKey(title, title === 'Alpha' ? 2001 : 2002, 'movie'), false);
      cache.setIndexValue(cache.makeKindKey(title, title === 'Alpha' ? 2001 : 2002, 'tv'), false);
    }
    cache.flushIndex();
  }

  function letterboxdZip() {
    const zip = new AdmZip();
    zip.addFile(
      'diary.csv',
      Buffer.from(
        [
          'Letterboxd URI,Date,Name,Year,Watched Date,Rating,Rewatch',
          'https://boxd.it/alpha,2025-01-02,Alpha,2001,2025-01-01,4,No',
          'https://boxd.it/beta,2025-02-02,Beta,2002,2025-02-01,3.5,Yes',
          '',
        ].join('\n'),
        'utf8'
      )
    );
    zip.addFile(
      'watched.csv',
      Buffer.from(
        [
          'Date,Name,Year,Letterboxd URI',
          '2025-01-02,Alpha,2001,https://boxd.it/alpha',
          '2025-02-02,Beta,2002,https://boxd.it/beta',
          '',
        ].join('\n'),
        'utf8'
      )
    );
    return zip.toBuffer();
  }

  let server;
  let baseUrl;

  test.before(async () => {
    seedProfile();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', filmsRouter);
    app.use(errorMiddleware);
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  test.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    tmp.cleanup();
  });

  test('GET /api/stats rebuilds a forgotten upload from the persistent profile', async () => {
    const response = await fetch(
      `${baseUrl}/api/stats?uploadId=${STALE_UPLOAD}&kpUserId=${KP_USER}`
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.summary.source.type, 'kinopoisk');
    assert.equal(String(payload.summary.source.kpUserId), KP_USER);
    assert.equal(payload.summary.filmCount, 2);
    assert.equal(payload.summary.ratedCount, 2);
    // No attachment yet (`attachedLb` is omitted by summary.js when absent).
    assert.ok(!payload.summary.attachedLb);
  });

  test('GET /api/stats still 404s without the persistent fallback', async () => {
    const response = await fetch(`${baseUrl}/api/stats?uploadId=${STALE_UPLOAD}`);
    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.equal(payload.code, 'unknown_upload');
  });

  test('POST /api/attach/lbzip attaches to a cached profile by kpUserId', async () => {
    const form = new FormData();
    form.append('uploadId', STALE_UPLOAD);
    form.append('kpUserId', KP_USER);
    form.append(
      'file',
      new Blob([letterboxdZip()], { type: 'application/zip' }),
      'letterboxd-export.zip'
    );

    const response = await fetch(`${baseUrl}/api/attach/lbzip`, {
      method: 'POST',
      body: form,
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.attached, true);
    assert.equal(String(payload.kpUserId), KP_USER);
    assert.equal(payload.events, 2);
    assert.equal(payload.diaryEvents, 2);

    const stored = JSON.parse(
      fs.readFileSync(path.join(tmp.cacheDir, 'profile-lb', `${KP_USER}.json`), 'utf8')
    );
    assert.equal(stored.events.length, 2);
    assert.equal(stored.fileName, 'letterboxd-export.zip');
  });

  test('the rebuilt stats payload picks the fresh attachment up immediately', async () => {
    const response = await fetch(
      `${baseUrl}/api/stats?uploadId=${STALE_UPLOAD}&kpUserId=${KP_USER}`
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.ok(payload.summary.attachedLb, 'attachment must be in the rebuilt summary');
    assert.equal(payload.summary.attachedLb.fileName, 'letterboxd-export.zip');
    // `events` counts archive events applied to MATCHED films. Both test
    // films are deliberate TMDB misses, so the field is 0 by design; presence
    // of the block is what proves the attachment reached the stats build.
    assert.equal(typeof payload.summary.attachedLb.events, 'number');
  });

  test('an unknown kpUserId is a clear 404, not a fake attach', async () => {
    const form = new FormData();
    form.append('kpUserId', '999999999');
    form.append(
      'file',
      new Blob([letterboxdZip()], { type: 'application/zip' }),
      'letterboxd-export.zip'
    );

    const response = await fetch(`${baseUrl}/api/attach/lbzip`, {
      method: 'POST',
      body: form,
    });
    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.equal(payload.code, 'unknown_profile');
  });

  test('the client sends the persistent kpUserId with stats and attach', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const publicDir = path.join(__dirname, '..', 'public', 'js');
    const api = fs.readFileSync(path.join(publicDir, 'api.js'), 'utf8');
    const attach = fs.readFileSync(path.join(publicDir, 'attach.js'), 'utf8');
    const main = fs.readFileSync(path.join(publicDir, 'main.js'), 'utf8');

    // Dashboard: the stale uploadId is paired with the owner id.
    assert.match(api, /params\.set\('kpUserId', String\(kpUserId\)\)/);
    // Attach: the multipart form carries the owner fallback.
    assert.match(api, /form\.append\('kpUserId', String\(kpUserId\)\)/);
    assert.match(attach, /attachLbZip\(uploadId, file, \{ kpUserId \}\)/);
    // The modal may open on a profile even when uploadId is gone.
    assert.match(attach, /if \(!uploadId && !kpUserId\)/);
    // main.js supplies the owner from the active KinoPoisk profile.
    assert.match(main, /getKpUserId: \(\) => activeKpUserId\(\)/);
  });
  after(() => env.resetMutableState());
});


describe('films-connections', () => {
  /**
   * Films «Подключения»: the Letterboxd archive is a connection of the current
   * KinoPoisk profile, so it lives on its own screen (a card with the attach
   * action) instead of the topbar. The attach flow itself is unchanged: the
   * button keeps `id="attach-lb"`, which `attach.js` binds.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');

  const PUBLIC = path.join(__dirname, '..', 'public');
  const read = (name) => fs.readFileSync(path.join(PUBLIC, name), 'utf8');

  test('the films topbar offers «Подключения» instead of the archive button', () => {
    const html = read('index.html');
    assert.match(html, /id="films-connections-btn"[\s\S]*?Подключения/);
    // One attach button, and it is not in the topbar block any more.
    const attach = html.match(/id="attach-lb"/g) || [];
    assert.equal(attach.length, 1);
    const topbarStart = html.indexOf('<header class="topbar" id="app-topbar">');
    const topbarEnd = html.indexOf('</header>', topbarStart);
    const topbar = html.slice(topbarStart, topbarEnd);
    assert.doesNotMatch(topbar, /id="attach-lb"/);
  });

  test('the connections screen carries the archive card and a way back', () => {
    const html = read('index.html');
    const screen = html.slice(
      html.indexOf('<section class="view" data-view="films-connections" hidden>'),
      html.indexOf('<section class="view" data-view="dashboard" hidden>')
    );
    assert.ok(screen.length > 0, 'экран подключений должен существовать');
    assert.match(screen, /id="attach-lb"/);
    assert.match(screen, /data-source="letterboxd"/);
    assert.match(screen, /id="films-attach-status"/);
    assert.match(screen, /id="films-connections-back"/);
  });

  test('main.js opens the screen and returns to the dashboard', () => {
    const js = read('js/main.js');
    assert.match(js, /getElementById\('films-connections-btn'\)/);
    assert.match(js, /showView\('films-connections'\)/);
    assert.match(js, /getElementById\('films-connections-back'\)/);
  });
  after(() => env.resetMutableState());
});


describe('films-stale-banner-removed', () => {
  /**
   * Films dashboard: no "Обновите профиль / данные устарели" nag after a
   * server restart.
   *
   * A restarted server forgets every `uploadId`, so the boot path falls back to
   * the IndexedDB payload (`handleUnknownUpload`). That fallback used to raise a
   * sticky topbar banner plus an info toast on every restart, even though the
   * topbar already carries a permanent «↻ Обновить профиль» action. The nag was
   * removed; these assertions keep it gone:
   *
   *   1. index.html has no `#stale-banner` markup (and no stale-* id at all);
   *   2. main.js has no banner logic (`showStaleBanner`/`hideStaleBanner`/
   *      `staleProfileId`) and no `#stale-refresh` binding;
   *   3. the restart fallback still renders the cached payload and stays quiet —
   *      no toast, no banner call — while the manual refresh button survives;
   *   4. style.css dropped the dead banner rules.
   *
   * The date formatter lives on in switcher.js (`formatSavedAt` there renders
   * profile timestamps and is unrelated to the banner).
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const { readPublicCss } = require('./helpers/css');

  const PUBLIC_DIR = path.join(__dirname, '..', 'public');

  function readPublic(name) {
    return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
  }

  /** Extract the body of `function <name>(...) { ... }` by brace counting. */
  function functionBody(js, name) {
    const start = js.indexOf(`function ${name}(`);
    assert.ok(start !== -1, `main.js still defines ${name}()`);
    const open = js.indexOf('{', js.indexOf(')', start));
    let depth = 0;
    for (let i = open; i < js.length; i += 1) {
      if (js[i] === '{') depth += 1;
      else if (js[i] === '}') {
        depth -= 1;
        if (depth === 0) return js.slice(open, i + 1);
      }
    }
    throw new Error(`unbalanced braces in ${name}()`);
  }

  test('index.html no longer carries the stale-data banner markup', () => {
    const html = readPublic('index.html');

    assert.doesNotMatch(html, /id="stale-banner"/, 'the banner element must be gone');
    assert.doesNotMatch(html, /id="stale-refresh"/);
    assert.doesNotMatch(html, /id="stale-(?:title|meta)"/);
    assert.doesNotMatch(html, /Данные устарели/);
    assert.doesNotMatch(html, /Показаны сохранённые данные/);
    assert.doesNotMatch(html, /Обновите профиль/);

    // The permanent manual refresh affordance is what replaced the banner.
    assert.match(html, /id="profile-refresh"/, 'topbar «Обновить профиль» must stay');
  });

  test('main.js has no stale-banner logic left', () => {
    const js = readPublic('js/main.js');

    assert.doesNotMatch(js, /stale-banner/);
    assert.doesNotMatch(js, /stale-refresh/);
    assert.doesNotMatch(js, /stale-title/);
    assert.doesNotMatch(js, /stale-meta/);
    assert.doesNotMatch(js, /staleProfileId/);
    assert.doesNotMatch(js, /showStaleBanner|hideStaleBanner/);
    // formatSavedAt() lived only for the banner copy; switcher.js keeps its own.
    assert.doesNotMatch(js, /function formatSavedAt/);
  });

  test('restart fallback draws the cache silently, without banner or toast', () => {
    const js = readPublic('js/main.js');
    const body = functionBody(js, 'handleUnknownUpload');

    // The cached branch keeps rendering the local payload ...
    assert.match(body, /const cached = await getStatsCache\(profile\.id\)/);
    assert.match(body, /applyStats\(cached\.stats, \{ fromCache: true, profile \}\)/);
    assert.match(body, /return;/, 'the cached branch must return without recovery');

    // ... and says nothing about it: no toast, no banner helper call.
    assert.doesNotMatch(body, /toast\(/, 'no restart toast in the cache fallback');
    assert.doesNotMatch(body, /Banner/, 'no banner helper in the cache fallback');
    assert.doesNotMatch(body, /устарел|перезапустился|Обновите/i);

    // The no-cache path still replays the import instead of nagging.
    assert.match(body, /await recoverProfile\(profile, \{ flow: current \}\)/);
  });

  test('the unrecoverable-profile toast is not a restart nag', () => {
    const js = readPublic('js/main.js');
    // Only the "cache + no link -> import again" hard failure may speak up.
    const unrecoverable = functionBody(js, 'showUnrecoverableProfile');
    assert.match(unrecoverable, /toast\(/);
    assert.doesNotMatch(unrecoverable, /Banner/);
  });

  test('style.css dropped the dead banner rules', () => {
    const css = readPublicCss();

    assert.doesNotMatch(css, /\.topbar-banner/);
    assert.doesNotMatch(css, /\.stale-icon/);
    assert.doesNotMatch(css, /\.stale-copy/);
    assert.doesNotMatch(css, /\.btn-stale/);
  });
  after(() => env.resetMutableState());
});


describe('films-stats-sections', () => {
  /**
   * Section builders of the films stats payload (S3 split).
   *
   * These are unit checks of the pieces that came out of the `buildStats`
   * god-function (`server/stats/*`). They do not replace the golden snapshot
   * (`test/golden.test.js`) — the payload contract is covered there
   * byte-for-byte. Here only the rules that are easy to break when a section
   * moves to its own file are pinned:
   *
   *   - the keyword taxonomy classifies and aggregates exactly as before
   *     (`taxonomy.js` had no direct tests at all);
   *   - the runtime histogram keeps the bucket bounds and skips unrated films
   *     in `avgRating`;
   *   - the timeline is the day-level view of the same events, so
   *     `sum(watchDays.count) === sum(timeline.watched)`.
   *
   * The builders are pure reads of a hand-built context; no cache, no network.
   * `widgets.js` pulls `../mcu` (and therefore `cache`), so the tmp-cache helper
   * runs first, exactly like in every other test.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');

  const env = require('./helpers/env');
  const tmp = env.currentDirs();

  const { buildTaxonomy } = require('../server/taxonomy');
  const { buildRuntimeHistogram } = require('../server/stats/widgets');
  const { buildTimeline, buildRewatches } = require('../server/stats/timeline');

  test.after(() => {
    tmp.cleanup();
  });

  test('taxonomy: keyword rules aggregate categories/origins with avgRating', () => {
    const taxonomy = buildTaxonomy([
      {
        slug: 'a',
        rating: 8,
        year: 1995,
        genres: [{ id: 16, name: 'Animation' }],
        keywords: [{ name: 'anime' }, { name: 'based on novel' }],
        wd: {},
        directors: [],
        countries: [],
        kind: 'movie',
      },
      {
        slug: 'b',
        rating: 6,
        year: 2000,
        genres: [],
        keywords: [{ name: 'anime' }],
        wd: {},
        directors: [],
        countries: [],
        kind: 'movie',
      },
    ]);

    const anime = taxonomy.categories.find((entry) => entry.key === 'anime');
    assert.ok(anime, 'anime category missing');
    assert.equal(anime.count, 2);
    assert.equal(anime.avgRating, 7);
    assert.deepEqual(anime.films, ['a', 'b']);

    // "Мультфильмы" is the Animation genre minus anime: only film `a` has the
    // genre, and it is already anime, so the bucket stays empty (and is omitted).
    assert.equal(taxonomy.categories.some((entry) => entry.key === 'animation'), false);

    // Origins are mutually exclusive and always cover every film.
    const origins = Object.fromEntries(taxonomy.origins.map((entry) => [entry.key, entry.count]));
    assert.equal(origins.book, 1, 'based-on-novel film must land in the book origin');
    assert.equal(origins.original, 1, 'a keyword-only film stays original');
    assert.equal(
      taxonomy.origins.reduce((sum, entry) => sum + entry.count, 0),
      2,
      'origins must sum to the number of films'
    );
  });

  test('runtime histogram: bucket bounds are inclusive and avgRating skips unrated', () => {
    const ctx = {
      filmsIndex: {
        a: { runtime: 39, rating: 8 },
        b: { runtime: 40, rating: 6 },
        c: { runtime: 120, rating: null },
        d: { runtime: 0, rating: 10 },
        e: { runtime: null, rating: 4 },
      },
    };
    const histogram = buildRuntimeHistogram(ctx);
    assert.deepEqual(
      histogram.map((bucket) => [bucket.bucket, bucket.count, bucket.avgRating]),
      [
        ['<40', 1, 8],
        ['40-59', 1, 6],
        ['120-149', 1, null],
        // Missing and zero runtimes share the "unknown" bucket.
        ['unknown', 2, 7],
      ]
    );
  });

  test('timeline: calendar days mirror the monthly bars and streaks', () => {
    const ctx = {
      isKpSource: false,
      upload: {
        events: [
          { source: 'diary', date: '2024-01-01', rating: 8, slug: 'a', rewatch: false },
          // watched.csv import dates never feed the timeline.
          { source: 'watched', date: '2024-03-01', rating: null, slug: 'b' },
          { source: 'diary', date: '2024-01-02', rating: 6, slug: 'b', rewatch: true },
          { source: 'diary', date: '2024-01-02', rating: null, slug: 'c', rewatch: false },
        ],
      },
      timelineMap: new Map(),
      watchDayMap: new Map(),
      watchEvents: [],
      realDateFrom: null,
      realDateTo: null,
    };

    const { timeline, watchDays, recentlyWatched, streaks, viewCount } = buildTimeline(ctx);

    assert.deepEqual(timeline, [
      { month: '2024-01', watched: 3, rated: 2, rewatchCount: 1 },
    ]);
    assert.equal(viewCount, 3);
    assert.equal(
      watchDays.reduce((sum, day) => sum + day.count, 0),
      viewCount,
      'sum(watchDays.count) must equal sum(timeline.watched)'
    );
    assert.deepEqual(
      watchDays.map((day) => [day.date, day.count, day.rewatchCount]),
      [
        ['2024-01-01', 1, 0],
        ['2024-01-02', 2, 1],
      ]
    );
    // Newest first; same-day viewings keep their insertion order (stable sort).
    assert.deepEqual(recentlyWatched.map((event) => event.slug), ['b', 'c', 'a']);
    assert.equal(streaks.current, 2);
    assert.equal(streaks.best, 2);
    assert.equal(streaks.lastWatchDate, '2024-01-02');
  });

  test('rewatch ranking keeps films with at least two Rewatch rows', () => {
    const rewatches = buildRewatches({
      rewatchBySlug: new Map([
        ['a', 3],
        ['b', 1],
        ['c', 2],
      ]),
    });
    assert.deepEqual(rewatches, [
      { slug: 'a', count: 3 },
      { slug: 'c', count: 2 },
    ]);
  });
  after(() => env.resetMutableState());
});


describe('matcher', () => {
  const test = require('node:test');
  const assert = require('node:assert/strict');

  process.env.TMDB_API_TOKEN = process.env.TMDB_API_TOKEN || 'test-token';

  const tmdb = require('../server/tmdb');

  let handler = async () => new Response(JSON.stringify({ results: [] }), { status: 200 });

  const __realFetch = globalThis.fetch;
  before(() => {
    globalThis.fetch = async (url) => handler(new URL(String(url)));;
  });
  after(() => {
    globalThis.fetch = __realFetch;
  });

  function json(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  function movie(id, title, release, votes, original) {
    return {
      id,
      title,
      original_title: original || title,
      release_date: release,
      vote_count: votes,
      vote_average: 7,
      popularity: 10,
    };
  }

  function tv(id, name, firstAir, votes, original) {
    return {
      id,
      name,
      original_name: original || name,
      first_air_date: firstAir,
      vote_count: votes,
      vote_average: 7,
      popularity: 10,
    };
  }

  function searchResults(url, items) {
    return json({ results: items });
  }

  test('similarity table protects against fragment matches', () => {
    const miCanonical = [
      'Mission: Impossible - Dead Reckoning',
      'Миссия невыполнима: Смертельная расплата',
    ];
    assert.equal(
      tmdb.titleMatchScore(
        ['Mission: Impossible - Dead Reckoning Part One', 'Mission: Impossible - Dead Reckoning Part One'],
        miCanonical
      ),
      0.95
    );
    assert.ok(
      tmdb.titleMatchScore(['ImPossible', 'ImPossible'], miCanonical) < 0.5,
      'a one-word fragment must not become an exact match'
    );

    const swCanonical = [
      'Star Wars: Episode VIII - The Last Jedi',
      'Звёздные войны: Последние джедаи',
    ];
    assert.equal(
      tmdb.titleMatchScore(['Star Wars: The Last Jedi', 'Star Wars: The Last Jedi'], swCanonical),
      1
    );
    assert.ok(
      tmdb.titleMatchScore(['Star Wars', 'Star Wars'], swCanonical) < 0.5,
      'the franchise title must not match an episode'
    );
    assert.equal(
      tmdb.titleMatchScore(
        ['Звёздные войны: Эпизод 8 - Последние джедаи', 'Star Wars: The Last Jedi'],
        swCanonical
      ),
      1
    );

    assert.equal(
      tmdb.titleMatchScore(['Слёзы капали', 'Слёзы капали'], ['Слезы капали']),
      1
    );
    assert.ok(
      tmdb.titleMatchScore(
        ['Ён Паль. Подпольный доктор', 'Yong Pal'],
        ['Yongpari', 'Ён-пхаль: Подпольный доктор']
      ) >= 0.85
    );
  });

  test('Mission: Impossible picks Dead Reckoning, not ImPossible', async () => {
    const dead = movie(575264, 'Mission: Impossible - Dead Reckoning Part One', '2023-07-08', 5478);
    const imp = movie(1199378, 'ImPossible', '2023-10-29', 0);
    handler = async (url) => {
      const q = url.searchParams.get('query');
      if (q === 'Mission: Impossible - Dead Reckoning') return searchResults(url, [dead, imp]);
      if (q === 'Impossible') return searchResults(url, [imp, dead]);
      if (q && q.startsWith('Миссия невыполнима')) return searchResults(url, [dead]);
      if (q === 'Dead Reckoning') return searchResults(url, [dead]);
      return searchResults(url, []);
    };
    const found = await tmdb.searchMovie('Mission: Impossible - Dead Reckoning', 2023, {
      language: 'en-US',
      fallbackTitle: 'Миссия невыполнима: Смертельная расплата',
    });
    assert.equal(found && found.id, 575264);
  });

  test('Star Wars episode numbers resolve to the right episode', async () => {
    const episodes = {
      'Star Wars: Episode VIII - The Last Jedi': tvOrMovie(181808, 'Star Wars: The Last Jedi', '2017-12-13', 16820),
      'Star Wars: Episode IX - The Rise of Skywalker': tvOrMovie(181812, 'Star Wars: The Rise of Skywalker', '2019-12-18', 11275),
      'Star Wars: Episode VII - The Force Awakens': tvOrMovie(140607, 'Star Wars: The Force Awakens', '2015-12-15', 21069),
    };
    function tvOrMovie(id, title, release, votes) {
      return movie(id, title, release, votes);
    }
    handler = async (url) => {
      const q = url.searchParams.get('query');
      if (episodes[q]) return searchResults(url, [episodes[q]]);
      if (q === 'Star Wars') return searchResults(url, [movie(11, 'Star Wars', '1977-05-25', 23078)]);
      return searchResults(url, []);
    };

    const viii = await tmdb.searchMovie('Star Wars: Episode VIII - The Last Jedi', 2017, {
      language: 'en-US',
      fallbackTitle: 'Звёздные войны: Последние джедаи',
    });
    assert.equal(viii && viii.id, 181808);
    const ix = await tmdb.searchMovie('Star Wars: Episode IX - The Rise of Skywalker', 2019, {
      language: 'en-US',
      fallbackTitle: 'Звёздные войны: Скайуокер. Восход',
    });
    assert.equal(ix && ix.id, 181812);
    const vii = await tmdb.searchMovie('Star Wars: Episode VII - The Force Awakens', 2015, {
      language: 'en-US',
      fallbackTitle: 'Звёздные войны: Пробуждение силы',
    });
    assert.equal(vii && vii.id, 140607);
  });

  test('previous broad regressions stay matched', async () => {
    const tears = movie(27925, 'Слёзы капали', '1983-01-15', 24);
    const yong = tv(63311, 'Ён Паль. Подпольный доктор', '2015-08-05', 33, 'Yong Pal');
    const healer = tv(61670, 'Хилер (Целитель)', '2014-12-08', 329, '힐러');
    const wicked = movie(402431, 'Wicked', '2024-10-16', 3303);

    handler = async (url) => {
      const q = url.searchParams.get('query');
      const pathname = url.pathname;
      if (pathname.endsWith('/search/tv')) {
        if (q === 'Ён-пхаль: Подпольный доктор' || q === 'Ён-пхаль' || q === 'Подпольный доктор') {
          return searchResults(url, [yong]);
        }
        if (q === 'Хилер') return searchResults(url, [healer]);
        return searchResults(url, []);
      }
      if (q === 'Слезы капали' || q === 'Слёзы капали') return searchResults(url, [tears]);
      if (q === 'Wicked') return searchResults(url, [wicked]);
      return searchResults(url, []);
    };

    const t = await tmdb.searchMovie('Слезы капали', 1982, { language: 'ru-RU' });
    assert.equal(t && t.id, 27925);

    const y = await tmdb.searchTv('Yongpari', 2015, {
      language: 'en-US',
      fallbackTitle: 'Ён-пхаль: Подпольный доктор',
    });
    assert.equal(y && y.id, 63311);

    const h = await tmdb.searchTv('Hilreo', 2014, {
      language: 'en-US',
      fallbackTitle: 'Хилер',
    });
    assert.equal(h && h.id, 61670);

    const w = await tmdb.searchMovie('Wicked', 2024, { language: 'en-US' });
    assert.equal(w && w.id, 402431);
  });

  test('a lone unrelated hit is rejected, a supported lone hit is accepted', async () => {
    const posh = movie(1577425, 'POSH (Please only send help)', '2025-11-01', 1);
    handler = async () => searchResults(null, [posh]);
    const rejected = await tmdb.searchMovie('Send Help', 2025, { language: 'en-US' });
    assert.equal(rejected, null);

    const obscure = movie(777, 'Старая деревня', '2000-01-01', 500);
    handler = async () => searchResults(null, [obscure]);
    const accepted = await tmdb.searchMovie('Деревня', 2000, { language: 'ru-RU' });
    assert.equal(accepted && accepted.id, 777);

    const nobody = movie(778, 'Старая деревня', '2000-01-01', 5);
    handler = async () => searchResults(null, [nobody]);
    const rejected2 = await tmdb.searchMovie('Деревня', 2000, { language: 'ru-RU' });
    assert.equal(rejected2, null);
  });

  test('transport failures are retried with backoff', async () => {
    let calls = 0;
    handler = async () => {
      calls++;
      if (calls <= 2) throw new Error('fetch failed');
      return json({ ok: true });
    };
    const before = tmdb.counters.transportRetries;
    const result = await tmdb.tmdbGet('/configuration', {});
    assert.deepEqual(result, { ok: true });
    assert.ok(calls >= 3);
    assert.ok(tmdb.counters.transportRetries >= before + 2);
  });
  after(() => env.resetMutableState());
});


describe('mcu', () => {
  /**
   * MCU parent-franchise membership and collection-name cleanup.
   *
   * The membership signal is the static canonical film list (validated against
   * Wikidata P179); cache/mcu.json is an optional superset written by
   * `npm run backfill:mcu`. The selected corpus checks are the same ones used in
   * the live spot-check: Deadpool & Wolverine is in, Sony's Venom and the
   * pre-MCU Spider-Man trilogy are out, TV entries never match.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_DIR = run.cacheDir;
  process.env.TMDB_API_TOKEN = 'test-token';

  const mcu = require('../server/mcu');
  const { __internal: { cleanCollectionName } } = require('../server/stats');

  test('MCU membership includes canonical films and excludes Sony spin-offs', () => {
    assert.equal(mcu.isMcuFilm({ imdbId: 'tt6263850', kind: 'movie' }), true); // Deadpool & Wolverine
    assert.equal(mcu.isMcuFilm({ imdbId: 'tt10676048', kind: 'movie' }), true); // The Marvels
    assert.equal(mcu.isMcuFilm({ imdbId: 'tt2250912', kind: 'movie' }), true); // Homecoming
    assert.equal(mcu.isMcuFilm({ imdbId: 'tt1270797', kind: 'movie' }), false); // Venom
    assert.equal(mcu.isMcuFilm({ imdbId: 'tt1431045', kind: 'movie' }), false); // Deadpool (2016)
    assert.equal(mcu.isMcuFilm({ imdbId: 'tt0145487', kind: 'movie' }), false); // Spider-Man (2002)
    assert.equal(mcu.isMcuFilm({ imdbId: 'tt13966962', kind: 'tv' }), false); // Echo (MCU TV)
    // TMDB-id fallback when the IMDb backfill has not populated details yet.
    assert.equal(mcu.isMcuFilm({ tmdbId: 1726, kind: 'movie' }), true); // Iron Man
    assert.equal(mcu.isMcuFilm({ tmdbId: 1003596, kind: 'movie' }), false); // Morbius
  });

  test('collection display names lose collection suffixes only', () => {
    assert.equal(cleanCollectionName('Гарри Поттер (Коллекция)'), 'Гарри Поттер');
    assert.equal(cleanCollectionName('Миссия невыполнима (Коллекция)'), 'Миссия невыполнима');
    assert.equal(cleanCollectionName('Пираты Карибского моря (Коллекция)'), 'Пираты Карибского моря');
    assert.equal(cleanCollectionName('Сумерки. Сага (Коллекция)'), 'Сумерки. Сага');
    assert.equal(cleanCollectionName('Foo (Mcu Collect)'), 'Foo');
    assert.equal(cleanCollectionName('X Коллекция'), 'X');
    // A bracket that is part of the title, not a suffix, survives.
    assert.equal(cleanCollectionName('Человек-паук [КВМ] (Коллекция)'), 'Человек-паук [КВМ]');
    assert.equal(cleanCollectionName('The Collector (Коллекционер)'), 'The Collector (Коллекционер)');
    assert.equal(cleanCollectionName('Marvel Cinematic Universe'), 'Marvel Cinematic Universe');
  });
  after(() => env.resetMutableState());
});


describe('enrich-retry', () => {
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const cacheDir = run.cacheDir;
  process.env.KINOBOXD_CACHE_DIR = run.cacheDir;
  process.env.TMDB_API_TOKEN = 'test-token';

  const tmdb = require('../server/tmdb');
  const enrich = require('../server/enrich');

  test('a transport-failed film is retried once and counted', async () => {
    let calls = 0;
    tmdb.searchMovie = async () => {
      calls++;
      if (calls === 1) throw new Error('fetch failed');
      return { id: 123, title: 'Retry Me' };
    };
    tmdb.fetchMovieData = async (id) => ({
      kind: 'movie',
      details: { id, title: 'Retry Me', runtime: 90 },
      credits: { cast: [], crew: [] },
    });

    enrich.startEnrich({
      uploadId: 'retry-test',
      films: [{ slug: 'retry-me', title: 'Retry Me', year: 2020, kind: 'movie' }],
    });

    const started = Date.now();
    while (!enrich.getStatus('retry-test').done && Date.now() - started < 15000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const job = enrich.getJob('retry-test');
    assert.equal(calls, 2);
    assert.equal(job.retriedSuccesses, 1);
    assert.equal(job.matched, 1);
    assert.equal(job.failed, 0);

    const index = JSON.parse(fs.readFileSync(path.join(cacheDir, 'index.json'), 'utf8'));
    assert.equal(index['retry me|2020'], 123);
    assert.ok(fs.existsSync(path.join(cacheDir, 'details', '123.json')));
  });
  after(() => env.resetMutableState());
});


describe('films-import-activation', () => {
  /**
   * Films: a finished KinoPoisk import becomes the active profile immediately.
   *
   * The registry write is asynchronous, so before this round the dashboard was
   * rendered with `profileId = null` and the topbar switcher said «Профиль»
   * until `/api/profiles` answered (and stayed that way if the request was slow).
   * The activation point is the stats payload: its `summary.source.kpUserId`
   * names the profile, so `applyStats()` now marks that record active and paints
   * the switcher before the registry refresh.
   *
   * The smoke drives the real `main.js` in the headless DOM shim: submit the
   * upload form, answer the job as done, then inspect the switcher. A second
   * import of the same account must reuse the same row (idempotent).
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const { installDom, textById } = require('./helpers/dom-shim');

  const { nodeFor, storage, document } = installDom();

  const statsPayload = {
    summary: {
      source: {
        type: 'kinopoisk',
        kpUserId: '15702206',
        kpNick: 'tester',
        fetchedAt: '2026-11-01T00:00:00.000Z',
      },
      filmCount: 12,
      ratedCount: 12,
      viewCount: 12,
      ratedFilms: 12,
      dateFrom: '2001-01-01',
      dateTo: '2026-01-01',
      attachedLb: null,
    },
    ratings: [],
    genres: [],
    franchises: [],
    runtimeHistogram: [],
    decades: [],
    years: [],
    decadeMatrix: [],
    auteurs: [],
    origins: [],
    periods: [],
    yearBars: [],
    timeline: [],
    recentlyWatched: [],
    watchCalendar: [],
    persons: { directors: [], actors: [] },
    films: [],
    events: [],
  };

  let profileCalls = 0;
  const routes = [];
  const __realFetch = globalThis.fetch;
  before(() => {
    globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    routes.push(`${options.method || 'GET'} ${target}`);
    let payload = {};
    let status = 200;

    if (target.startsWith('/api/auth/session')) payload = { authRequired: false, authed: true };
    else if (target.startsWith('/api/profiles')) {
      // The first catalogue read is empty (fresh browser); every later one hangs
      // on purpose: activation must not depend on the registry refresh.
      profileCalls += 1;
      if (profileCalls > 1) return new Promise(() => {});
      payload = [];
    } else if (target.startsWith('/api/import/kinopoisk/status')) {
      payload = { done: true, stage: 'done', matched: 12, total: 12, failed: 0 };
    } else if (target.startsWith('/api/import/kinopoisk')) {
      status = 201;
      payload = { uploadId: 'up-1', userId: '15702206', stage: 'scrape' };
    } else if (target.startsWith('/api/stats')) payload = statsPayload;
    else if (target.startsWith('/api/tmdb')) payload = { results: [] };

    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      async json() { return payload; },
      async text() { return JSON.stringify(payload); },
    };
  };;
  });
  after(() => {
    globalThis.fetch = __realFetch;
  });

  function rows() {
    return nodeFor('profile-list').children
      .filter((node) => node.classList && node.classList.contains('profile-item'));
  }
  function activeRows() {
    return rows().filter((node) => node.classList.contains('is-active'));
  }
  async function wait(ms = 0) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  test('films import: the new KinoPoisk profile is active before /api/profiles answers', async () => {
    await import('../public/js/main.js');
    await wait(80);

    assert.equal(document.body.dataset.view, 'upload', 'a fresh browser opens the upload screen');

    nodeFor('kp-url').value = 'https://www.kinopoisk.ru/user/15702206/';
    nodeFor('kp-form').dispatch('submit');
    await wait(400);

    assert.equal(document.body.dataset.view, 'dashboard');
    assert.ok(routes.some((route) => route === 'POST /api/import/kinopoisk'), 'the import was started');
    assert.ok(routes.some((route) => route.startsWith('GET /api/stats?uploadId=up-1')), 'the payload was read');

    const session = JSON.parse(storage.get('kinoboxd.session.v1') || 'null');
    assert.equal(session.profileId, 'kp:15702206', 'the session remembers the imported profile');
    assert.equal(session.uploadId, 'up-1');

    assert.equal(rows().length, 1, 'exactly one switcher row');
    assert.equal(activeRows().length, 1, 'the imported profile is highlighted');
    assert.match(textById(nodeFor, 'profile-list'), /Кинопоиск · tester/);
  });

  test('films re-import: the same account updates the row instead of duplicating it', async () => {
    // Open the upload screen from the switcher and import the same user again.
    nodeFor('profile-add').click();
    nodeFor('kp-url').value = 'https://www.kinopoisk.ru/user/15702206/';
    nodeFor('kp-form').dispatch('submit');
    await wait(400);

    assert.equal(document.body.dataset.view, 'dashboard');
    assert.equal(rows().length, 1, 'a re-import must not add a second row');
    assert.equal(activeRows().length, 1);
    assert.equal(JSON.parse(storage.get('kinoboxd.session.v1') || 'null').profileId, 'kp:15702206');
  });
  after(() => env.resetMutableState());
});
