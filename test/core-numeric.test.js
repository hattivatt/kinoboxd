'use strict';

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

const TMP = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `kinoboxd-numeric-${name}-`));

process.env.KINOBOXD_CACHE_DIR = TMP('cache');
process.env.KINOBOXD_CACHE_GAMES_DIR = TMP('games');
process.env.KINOBOXD_CACHE_BOOK_DIR = TMP('books');
process.env.KINOBOXD_STATE_DIR = TMP('state');

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
