'use strict';

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
const tmp = env.makeTmpCache('profiles-unified', { budgets: true });
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
