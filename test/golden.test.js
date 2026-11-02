'use strict';

/**
 * Golden payload snapshots — the P0 «страховочная сетка».
 *
 * Goal: freeze the *contract* of the three heavy payloads (films, books,
 * games) in a way that fails on a semantic change and survives a refactor:
 *
 *   - top-level keys and the first level of every object (structure);
 *   - a handful of summary numbers per domain;
 *   - the byte size and sha256 of the canonical JSON.
 *
 * How it works: the fixtures in `test/fixtures/golden/**` are copied into a
 * fresh tmp cache (`/tmp/opencode/golden-*`), then the real builders are
 * called exactly as the routes call them (`buildStats`, `buildBooksStats`,
 * `buildGamesStatsFromCache`). No live cache, no network, no production
 * directories — the env helper sets all four cache roots before any
 * `server/**` module is required.
 *
 * Volatile fields are normalized away before hashing:
 *   - `meta.buildMs` (books, games) — wall-clock build time;
 *   - `meta.secondaryDetails.running` (games) — a process-local job flag.
 * Everything else is expected to be byte-stable: fixture timestamps are
 * fixed, and the achievements calendar only derives "current streak" from
 * old 2015 unlock dates (always 0).
 *
 * Regenerate after an INTENTIONAL contract change:
 *
 *     UPDATE_GOLDEN=1 node --test test/golden.test.js
 *
 * Review the diff of `test/golden/*.json` in the commit — a golden bump is a
 * contract decision, not a fix-up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// 1. Tmp cache roots FIRST (the cache modules bake them in at require time).
const env = require('./helpers/env');
const tmp = env.makeTmpCache('golden', { budgets: true });

// 2. Only now the modules under test.
const cache = require('../server/cache');
const bookCache = require('../server/books/book-cache');
const gameCache = require('../server/games/game-cache');
const { buildStats } = require('../server/stats');
const { buildBooksStats } = require('../server/books/stats');
const { buildGamesStatsFromCache } = require('../server/games/stats');
const seed = require('./golden/seed');

const GOLDEN_DIR = path.join(__dirname, 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

test.after(() => {
  tmp.cleanup();
});

/* ------------------------------------------------------------------ */
/* Canonicalization + descriptor                                       */
/* ------------------------------------------------------------------ */

/** Drop the wall-clock / process-local fields before hashing. */
function canonicalize(domain, payload) {
  const clone = JSON.parse(JSON.stringify(payload));
  if (clone.meta && Object.prototype.hasOwnProperty.call(clone.meta, 'buildMs')) {
    clone.meta.buildMs = 0;
  }
  if (clone.summary && Object.prototype.hasOwnProperty.call(clone.summary, 'buildMs')) {
    clone.summary.buildMs = 0;
  }
  if (clone.meta && clone.meta.secondaryDetails) {
    clone.meta.secondaryDetails.running = false;
  }
  return clone;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * One level of the payload shape: every top-level object becomes its sorted
 * key list, every array its length. Enough to catch a renamed/dropped field
 * without freezing the whole (megabyte) document.
 */
function structureOf(payload) {
  const structure = {};
  for (const key of Object.keys(payload).sort()) {
    const value = payload[key];
    if (Array.isArray(value)) {
      structure[key] = { array: value.length };
    } else if (value && typeof value === 'object') {
      structure[key] = Object.keys(value).sort();
    } else {
      structure[key] = value === null ? null : typeof value;
    }
  }
  return structure;
}

function pick(source, dotted) {
  return dotted.split('.').reduce((value, part) => {
    if (value == null) return null;
    return value[part];
  }, source);
}

function numbersOf(payload, fields) {
  const out = {};
  for (const field of fields) out[field] = pick(payload, field);
  return out;
}

function descriptorOf(domain, payload, numberFields) {
  const canonical = canonicalize(domain, payload);
  const json = JSON.stringify(canonical);
  return {
    domain,
    bytes: Buffer.byteLength(json, 'utf8'),
    sha256: sha256(json),
    topLevelKeys: Object.keys(canonical).sort(),
    structure: structureOf(canonical),
    summaryNumbers: numbersOf(canonical, numberFields),
  };
}

function goldenPath(domain) {
  return path.join(GOLDEN_DIR, `${domain}.json`);
}

function loadGolden(domain) {
  return JSON.parse(fs.readFileSync(goldenPath(domain), 'utf8'));
}

/**
 * Compare the freshly built descriptor with the committed golden.
 * `UPDATE_GOLDEN=1` rewrites the file instead (review the diff!).
 */
function checkGolden(domain, payload, numberFields) {
  const actual = descriptorOf(domain, payload, numberFields);
  if (UPDATE) {
    fs.writeFileSync(goldenPath(domain), `${JSON.stringify(actual, null, 2)}\n`);
    return actual;
  }
  const expected = loadGolden(domain);

  assert.deepEqual(
    actual.topLevelKeys,
    expected.topLevelKeys,
    `${domain}: top-level keys changed — add/remove is a contract change`
  );
  assert.deepEqual(
    actual.structure,
    expected.structure,
    `${domain}: payload shape changed (a field was renamed/added/removed)`
  );
  assert.deepEqual(
    actual.summaryNumbers,
    expected.summaryNumbers,
    `${domain}: summary numbers changed`
  );
  assert.equal(
    actual.bytes,
    expected.bytes,
    `${domain}: payload size ${actual.bytes} B != golden ${expected.bytes} B`
  );
  assert.equal(
    actual.sha256,
    expected.sha256,
    `${domain}: payload hash changed (${actual.sha256} != ${expected.sha256}); ` +
      'if this is intentional run UPDATE_GOLDEN=1'
  );
  return actual;
}

/* ------------------------------------------------------------------ */
/* Films                                                               */
/* ------------------------------------------------------------------ */

const FILM_NUMBERS = [
  'summary.filmCount',
  'summary.ratedCount',
  'summary.viewCount',
  'summary.totalMinutes',
  'summary.avgRuntime',
  'summary.unmatchedCount',
  'persons.director.length',
  'genres.length',
  'franchises.length',
];

test('films: /api/stats payload matches the golden contract', async () => {
  await seed.seedFilms(cache);
  const { upload, job } = seed.filmsInput();
  const stats = buildStats(upload, job);
  assert.ok(stats, 'buildStats returned null — the job override was not picked up');
  const descriptor = checkGolden('films', stats, FILM_NUMBERS);
  // A smoke-sized sanity check independent of the golden file.
  assert.equal(stats.summary.filmCount, 7);
  assert.ok(descriptor.bytes > 1000);
});

test('films: the payload is deterministic (two builds, one hash)', async () => {
  const { upload, job } = seed.filmsInput();
  const first = canonicalize('films', buildStats(upload, job));
  const second = canonicalize('films', buildStats(upload, job));
  assert.equal(
    sha256(JSON.stringify(first)),
    sha256(JSON.stringify(second)),
    'buildStats is not deterministic on the same cache snapshot'
  );
});

/* ------------------------------------------------------------------ */
/* Books                                                               */
/* ------------------------------------------------------------------ */

const BOOK_NUMBERS = [
  'summary.bookCount',
  'summary.eventCount',
  'summary.finishedCount',
  'summary.resolvedCount',
  'summary.unresolvedCount',
  'summary.readingNowCount',
  'summary.metadata.resolved',
  'summary.metadata.total',
  'authors.length',
  'series.length',
];

test('books: /api/books/stats payload matches the golden contract', async () => {
  await seed.seedBooks(bookCache);
  const stats = buildBooksStats({ profile: 'livelib-golden' });
  assert.ok(stats);
  const descriptor = checkGolden('books', stats, BOOK_NUMBERS);
  // 6 finished + 1 undated stub + 1 reading/wish excluded by shelf.
  assert.equal(stats.summary.eventCount, 6);
  assert.ok(descriptor.bytes > 1000);
});

test('books: the payload is deterministic (two builds, one hash)', async () => {
  const first = canonicalize('books', buildBooksStats({ profile: 'livelib-golden' }));
  const second = canonicalize('books', buildBooksStats({ profile: 'livelib-golden' }));
  assert.equal(sha256(JSON.stringify(first)), sha256(JSON.stringify(second)));
});

/* ------------------------------------------------------------------ */
/* Games                                                               */
/* ------------------------------------------------------------------ */

const GAME_NUMBERS = [
  'summary.ownedCount',
  'summary.gameCount',
  'summary.playedCount',
  'summary.unplayedCount',
  'summary.totalHours',
  'summary.achievements.unlocked',
  'summary.achievements.total',
  'summary.completion.gamesWithStats',
  'backlog.count',
  'genres.length',
];

test('games: /api/games/stats payload matches the golden contract', async () => {
  const seeded = await seed.seedGames(gameCache);
  const stats = buildGamesStatsFromCache(seeded.profileKey, { minHours: -1 });
  assert.ok(stats, 'buildGamesStatsFromCache returned null — the fixture library was not read');
  const descriptor = checkGolden('games', stats, GAME_NUMBERS);
  assert.equal(stats.summary.ownedCount, 10);
  assert.ok(descriptor.bytes > 1000);
});

test('games: the payload is deterministic (two builds, one hash)', async () => {
  const profileKey = 'steam-76561198000000001';
  const first = canonicalize('games', buildGamesStatsFromCache(profileKey, { minHours: -1 }));
  const second = canonicalize('games', buildGamesStatsFromCache(profileKey, { minHours: -1 }));
  assert.equal(sha256(JSON.stringify(first)), sha256(JSON.stringify(second)));
});
