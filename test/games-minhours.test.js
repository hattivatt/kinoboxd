'use strict';

/**
 * M5-B stats contract: `minHours` (-1 / 0 / N), the filter chain with
 * includeFree/includeDlc, and canonical-work aggregation (one game per
 * edition group) across every aggregate.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildGamesStats,
  normalizeMinHours,
  hoursFilterPass,
} = require('../server/games/stats');

function game(appid, name, minutes, extra = {}) {
  return {
    appid,
    name,
    playtime_forever: minutes,
    playtime_2weeks: 0,
    rtime_last_played: 0,
    img_icon_url: null,
    ...extra,
  };
}

function details(name, extra = {}) {
  return {
    success: true,
    type: 'game',
    name,
    is_free: false,
    developers: ['Dev'],
    publishers: ['Dev'],
    genres: [{ id: '1', description: 'Action' }],
    categories: [{ id: '2', description: 'Single-player' }],
    releaseYear: 2015,
    dlc: [],
    dlcCount: 0,
    platforms: { windows: true, mac: false, linux: false },
    ...extra,
  };
}

function build(library, detailMap, extra = {}) {
  return buildGamesStats({
    steamId64: '76561198000000902',
    profile: { userKey: '76561198000000902', personaName: 'tester' },
    library: { ...library, fingerprint: 'm5b-fixture' },
    details: detailMap,
    achievements: [],
    globals: new Map(),
    ...extra,
  });
}

const BASE_LIBRARY = {
  game_count: 4,
  games: [
    game(1, 'Alpha', 120),
    game(2, 'Beta', 0),
    game(3, 'Gamma', 60),
    game(4, 'Delta', 30),
  ],
};

const BASE_DETAILS = {
  1: details('Alpha', { genres: [{ id: '1', description: 'RPG' }], releaseYear: 2010 }),
  2: details('Beta', { genres: [{ id: '1', description: 'Indie' }], releaseYear: 2020 }),
  3: details('Gamma', { genres: [{ id: '1', description: 'RPG' }], releaseYear: 2015 }),
  4: details('Delta', { genres: [{ id: '1', description: 'Action' }], releaseYear: 2018 }),
};

test('normalizeMinHours / hoursFilterPass semantics', () => {
  assert.equal(normalizeMinHours(undefined), -1);
  assert.equal(normalizeMinHours(-1), -1);
  assert.equal(normalizeMinHours(0), 0);
  assert.equal(normalizeMinHours('2'), 2);
  assert.equal(normalizeMinHours(1.5, 0), 0);
  assert.equal(normalizeMinHours(-2, 0), 0);

  assert.equal(hoursFilterPass(0, -1), true);
  assert.equal(hoursFilterPass(0, 0), false);
  assert.equal(hoursFilterPass(1, 0), true);
  // Exactly 60 minutes is «1 hour» and passes minHours=1.
  assert.equal(hoursFilterPass(60, 1), true);
  assert.equal(hoursFilterPass(59, 1), false);
  assert.equal(hoursFilterPass(120, 2), true);
  assert.equal(hoursFilterPass(119, 2), false);
});

test('minHours=-1 keeps the 0-hour backlog, 0 keeps only played works', () => {
  const all = build(BASE_LIBRARY, BASE_DETAILS, { minHours: -1 });
  assert.equal(all.summary.gameCount, 4);
  assert.equal(all.summary.playedCount, 3);
  assert.equal(all.summary.unplayedCount, 1);
  assert.equal(all.summary.totalHours, 3.5);
  assert.equal(all.summary.meanHours, 0.88);
  assert.equal(all.summary.medianHours, 0.8);
  assert.equal(all.backlog.count, 1);
  assert.equal(all.backlog.items[0].appid, 2);
  assert.equal(Object.keys(all.gamesIndex).length, 4);
  assert.equal(all.meta.filters.minHours.requested, -1);
  assert.equal(all.meta.filters.minHours.excluded, 0);

  const played = build(BASE_LIBRARY, BASE_DETAILS, { minHours: 0 });
  assert.equal(played.summary.gameCount, 3);
  assert.equal(played.summary.playedCount, 3);
  assert.equal(played.summary.unplayedCount, 0);
  assert.equal(played.summary.totalHours, 3.5);
  assert.equal(played.summary.meanHours, 1.17);
  assert.equal(played.summary.medianHours, 1);
  assert.equal(played.backlog.count, 0);
  assert.equal(Object.keys(played.gamesIndex).length, 3);
  assert.equal(played.meta.filters.minHours.excluded, 1);
  assert.equal(played.meta.filters.minHours.excludedAppids, 1);
});

test('minHours=N keeps works with at least N hours (60 min passes N=1)', () => {
  const one = build(BASE_LIBRARY, BASE_DETAILS, { minHours: 1 });
  assert.equal(one.summary.gameCount, 2); // Alpha 2 h + Gamma exactly 1 h
  assert.equal(one.summary.totalHours, 3);
  assert.deepEqual(one.topGames.map((entry) => entry.appid), [1, 3]);

  const two = build(BASE_LIBRARY, BASE_DETAILS, { minHours: 2 });
  assert.equal(two.summary.gameCount, 1);
  assert.equal(two.summary.totalHours, 2);
  assert.equal(two.summary.meanHours, 2);
  assert.equal(two.summary.medianHours, 2);
  assert.equal(two.meta.filters.minHours.excluded, 3);

  const none = build(BASE_LIBRARY, BASE_DETAILS, { minHours: 100 });
  assert.equal(none.summary.gameCount, 0);
  assert.equal(none.summary.totalHours, 0);
  assert.equal(none.summary.meanHours, 0);
  assert.equal(none.summary.medianHours, 0);
  assert.deepEqual(none.topGames, []);
  assert.deepEqual(none.gamesIndex, {});
  assert.deepEqual(none.hoursHistogram.map((entry) => entry.count), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test('canonical works: one game per edition group across every aggregate', () => {
  const library = {
    game_count: 3,
    games: [
      game(100, 'Skyrim', 60),
      game(101, 'Skyrim Special Edition', 120),
      game(102, 'Other Game', 30),
    ],
  };
  const detailMap = {
    100: details('Skyrim', {
      developers: ['Bethesda'],
      releaseYear: 2011,
      genres: [{ id: '1', description: 'RPG' }],
    }),
    101: details('Skyrim Special Edition', {
      developers: ['Bethesda'],
      releaseYear: 2016,
      genres: [
        { id: '1', description: 'RPG' },
        { id: '2', description: 'Action' },
      ],
    }),
    102: details('Other Game', {
      developers: ['Someone'],
      releaseYear: 2020,
      genres: [{ id: '3', description: 'Indie' }],
    }),
  };
  const payload = build(library, detailMap, { minHours: -1 });

  // 3 appids → 2 games.
  assert.equal(payload.summary.gameCount, 2);
  assert.equal(payload.summary.ownedCount, 3);
  assert.equal(payload.summary.totalHours, 3.5);
  // Mean/median are per canonical work, never per edition (no inflation).
  assert.equal(payload.summary.meanHours, 1.75);
  assert.equal(payload.summary.medianHours, 1.8);
  assert.equal(payload.summary.top10HoursShare, 0.857);
  assert.equal(payload.meta.editions.works, 2);
  assert.equal(payload.meta.editions.appids, 3);
  assert.equal(payload.meta.editions.groups, 1);
  assert.equal(payload.meta.editions.gamesMerged, 2);
  assert.equal(payload.meta.editions.savedCount, 1);

  // Top game = the edition the owner actually played (primary), with the
  // canonical hours and the edition list.
  assert.equal(payload.topGames.length, 2);
  assert.equal(payload.topGames[0].appid, 101);
  assert.equal(payload.topGames[0].hours, 3);
  assert.equal(payload.topGames[0].editionCount, 2);
  assert.deepEqual(payload.topGames[0].editions.map((entry) => entry.appid), [101, 100]);
  assert.equal(payload.topGames[0].canonicalWorkKey, 'steam:100');

  // Every appid stays in the library table with its own hours.
  assert.equal(Object.keys(payload.gamesIndex).length, 3);
  assert.equal(payload.gamesIndex[100].hours, 1);
  assert.equal(payload.gamesIndex[100].canonicalHours, 3);
  assert.equal(payload.gamesIndex[100].isPrimary, false);
  assert.equal(payload.gamesIndex[101].isPrimary, true);
  assert.equal(payload.gamesIndex[101].editionCount, 2);
  assert.equal(payload.gamesIndex[101].canonicalWorkKey, 'steam:100');

  // Genres/years count the work once (min release year = the original game).
  const rpg = payload.genres.find((entry) => entry.name === 'RPG');
  assert.equal(rpg.count, 1);
  assert.equal(rpg.hours, 3);
  const action = payload.genres.find((entry) => entry.name === 'Action');
  assert.equal(action.count, 1);
  assert.equal(action.hours, 3);
  assert.deepEqual(
    payload.years.map((entry) => [entry.year, entry.count, entry.hours]),
    [
      [2011, 1, 3],
      [2020, 1, 0.5],
    ]
  );
  assert.equal(payload.summary.releaseYearFrom, 2011);
  assert.equal(payload.summary.releaseYearTo, 2020);
});

test('minHours uses canonical hours: a 0-hour edition + a played edition pass', () => {
  const library = {
    game_count: 2,
    games: [game(200, 'Skyrim', 0), game(201, 'Skyrim Special Edition', 60)],
  };
  const detailMap = {
    200: details('Skyrim', { developers: ['Bethesda'], releaseYear: 2011 }),
    201: details('Skyrim Special Edition', { developers: ['Bethesda'], releaseYear: 2016 }),
  };
  const payload = build(library, detailMap, { minHours: 1 });
  assert.equal(payload.summary.gameCount, 1);
  assert.equal(payload.summary.totalHours, 1);
  assert.equal(payload.summary.unplayedCount, 0);
  // The library table keeps both editions, including the 0-hour one.
  assert.equal(Object.keys(payload.gamesIndex).length, 2);
  assert.equal(payload.gamesIndex[200].hours, 0);
  assert.equal(payload.gamesIndex[200].canonicalHours, 1);
  assert.equal(payload.gamesIndex[201].isPrimary, true);

  const twoHours = build(library, detailMap, { minHours: 2 });
  assert.equal(twoHours.summary.gameCount, 0);
  assert.deepEqual(twoHours.gamesIndex, {});
  assert.equal(twoHours.meta.filters.minHours.excludedAppids, 2);
});

test('filter chain: includeFree runs before the edition merge, minHours after', () => {
  const library = {
    game_count: 4,
    games: [
      game(300, 'Free Game', 120),
      game(301, 'Paid Game', 120),
      game(302, 'Thing', 60),
      game(303, 'Thing Enhanced', 120),
    ],
  };
  const detailMap = {
    300: details('Free Game', { is_free: true, developers: ['FreeDev'], releaseYear: 2015 }),
    301: details('Paid Game', { developers: ['PaidDev'], releaseYear: 2015 }),
    302: details('Thing', { is_free: true, developers: ['ThingDev'], releaseYear: 2015 }),
    303: details('Thing Enhanced', { developers: ['ThingDev'], releaseYear: 2016 }),
  };

  const withFree = build(library, detailMap, { includeFree: true, minHours: 1 });
  assert.equal(withFree.summary.gameCount, 3); // Free Game + Paid Game + Thing
  assert.equal(withFree.summary.totalHours, 7); // 2 + 2 + (1 + 2)
  assert.deepEqual(withFree.summary.freeToPlay, { count: 2, hours: 3, share: 0.429 });

  const paidOnly = build(library, detailMap, { includeFree: false, minHours: 1 });
  assert.equal(paidOnly.summary.gameCount, 2); // Paid Game + Thing (paid edition only)
  assert.equal(paidOnly.summary.totalHours, 4);
  assert.deepEqual(paidOnly.summary.freeToPlay, { count: 0, hours: 0, share: 0 });
  assert.equal(paidOnly.meta.excluded.free, 2);
  // The merged work survives through its paid edition: 2 h, not 3 h.
  assert.equal(paidOnly.gamesIndex[302], undefined);
  assert.equal(paidOnly.gamesIndex[303].canonicalHours, 2);
});

test('DLC/demo rows never merge with a game and stay out of the default payload', () => {
  const library = {
    game_count: 2,
    games: [game(400, 'Project Y', 60), game(401, 'Project Y', 120)],
  };
  const detailMap = {
    400: details('Project Y', { developers: ['Studio'], releaseYear: 2015 }),
    401: details('Project Y', { type: 'dlc', developers: ['Studio'], releaseYear: 2015 }),
  };
  const payload = build(library, detailMap, { minHours: -1 });
  assert.equal(payload.summary.gameCount, 1);
  assert.equal(payload.summary.ownedCount, 2);
  assert.equal(payload.meta.excluded.dlc, 1);
  assert.deepEqual(Object.keys(payload.gamesIndex), ['400']);

  const withDlc = build(library, detailMap, { includeDlc: true, minHours: -1 });
  assert.equal(withDlc.summary.gameCount, 2, 'a DLC is not an edition of its base game');
  assert.equal(withDlc.meta.excluded.dlc, 0);
  assert.equal(withDlc.gamesIndex[401].type, 'dlc');
  assert.equal(withDlc.gamesIndex[401].editionCount, 1);
});
