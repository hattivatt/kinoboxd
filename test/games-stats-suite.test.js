'use strict';

/**
 * Games: stats payload, timelines and per-source caches suite: the former standalone `*.test.js` files of this domain,
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

const run = env.makeTmpCache('games-stats-suite', { budgets: false });

after(() => {
  env.cleanupTmpDirs();
});

process.on('exit', () => {
  env.cleanupTmpDirs();
});


describe('games-stats', () => {
  /**
   * `/api/games/stats` computations (M1): hours, Pareto, backlog, achievements.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const CACHE_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const gameCache = require('../server/games/game-cache');
  const steam = require('../server/games/steam');
  const {
    buildGamesStats,
    buildGamesStatsFromCache,
    calendarFromAchievements,
    profileSummary,
  } = require('../server/games/stats');
  const { readFixture } = require('./fixtures/games/fake-client');

  const ID = '76561198000000001';
  const PROFILE_KEY = `steam-${ID}`;

  function fixtureLibrary() {
    const owned = steam.parseOwnedGamesResponse(JSON.parse(readFixture('owned-games.json')));
    return {
      fetchedAt: new Date().toISOString(),
      partial: false,
      source: 'steam-webapi',
      game_count: owned.gameCount,
      games: owned.games,
      totalMinutes: owned.totalMinutes,
      fingerprint: owned.fingerprint,
    };
  }

  async function seed() {
    await gameCache.saveProfile({
      userKey: ID,
      personaName: 'tester',
      avatarUrl: 'https://example.test/avatar.jpg',
      privacy: 'public',
      importedAt: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    });
    await gameCache.saveLibrary(ID, fixtureLibrary());
    const achievements = steam.parseAchievementsXml(readFixture('achievements.xml'));
    await gameCache.saveAchievements(ID, 620, {
      ...achievements,
      fetchedAt: new Date().toISOString(),
    });
    // Unlocked achievement with a 3.5% global rate = rare (<5%).
    await gameCache.saveGlobal(620, {
      fetchedAt: new Date().toISOString(),
      achievements: [{ name: 'ACH.SURVIVE_CONTAINER_RIDE', percent: 3.5 }],
      byName: { 'ach.survive_container_ride': 3.5, 'ACH.SURVIVE_CONTAINER_RIDE': 3.5 },
    });
  }

  test('stats payload: counts, hours, Pareto, median, histogram, recent, backlog', async () => {
    await seed();
    const stats = buildGamesStatsFromCache(PROFILE_KEY);
    assert.ok(stats);
    assert.equal(stats.libraryPartial, false);
    assert.equal(stats.sources.selected.length, 1);
    assert.equal(stats.sources.selected[0], PROFILE_KEY);
    assert.equal(stats.sources.profile.key, PROFILE_KEY);
    assert.equal(stats.sources.profile.personaName, 'tester');
    assert.equal(stats.sources.profile.gameCount, 10);

    const summary = stats.summary;
    assert.equal(summary.ownedCount, 10);
    assert.equal(summary.gameCount, 10);
    assert.equal(summary.gameCountEstimated, true);
    assert.equal(summary.playedCount, 8);
    assert.equal(summary.unplayedCount, 2);
    assert.equal(summary.totalHours, 616.2);
    assert.equal(summary.meanHours, 61.62);
    assert.equal(summary.medianHours, 9.1);
    assert.equal(summary.top10HoursShare, 0.556);
    assert.equal(summary.top10Count, 1);
    assert.equal(summary.recent2wHours, 1.8);
    assert.equal(summary.lastPlayedAt, '2026-10-29T17:34:11.000Z');
    assert.equal(summary.releaseYearFrom, null);
    assert.equal(summary.releaseYearTo, null);
    // platform hours are library data (M1), not appdetails
    assert.equal(summary.platformHours.linux, 4.9);
    assert.equal(summary.platformHours.deck, 4.9);

    assert.deepEqual(
      stats.hoursHistogram.map((entry) => entry.count),
      [2, 0, 1, 4, 1, 0, 2, 0]
    );
    assert.equal(
      stats.hoursHistogram.reduce((sum, entry) => sum + entry.count, 0),
      summary.ownedCount
    );

    assert.equal(stats.topGames.length, 10);
    assert.equal(stats.topGames[0].appid, 211420);
    assert.equal(stats.topGames[0].hours, 342.6);
    assert.equal(stats.topGames[1].appid, 570);
    assert.equal(stats.topGames[1].hours, 213.3);
    assert.equal(stats.topGames[0].releaseYear, null);

    assert.equal(stats.recentlyPlayed[0].appid, 1091500);
    assert.equal(stats.recentlyPlayed[0].hours2w, 1.8);
    assert.equal(stats.recently2w.length, 1);
    assert.equal(stats.recently2w[0].appid, 1091500);

    assert.equal(stats.backlog.count, 2);
    assert.equal(stats.backlog.share, 0.2);
    assert.equal(stats.backlog.items.length, 2);
    assert.deepEqual(
      stats.backlog.items.map((entry) => entry.appid).sort((a, b) => a - b),
      [320, 360]
    );
    assert.equal(stats.backlog.truncated, false);

    // M2/M3 buckets exist but are empty — nothing is invented.
    assert.deepEqual(stats.genres, []);
    assert.deepEqual(stats.years, []);
    assert.equal(stats.personnelTop, null);
    assert.equal(stats.summary.modes, null);
    assert.equal(stats.summary.freeToPlay, null);
    assert.ok(stats.meta.pending.includes('genres'));
    assert.equal(stats.meta.filters.includeFree.applied, false);
  });

  test('gamesIndex is a light appid → entry map', async () => {
    await seed();
    const stats = buildGamesStatsFromCache(PROFILE_KEY);
    assert.equal(Object.keys(stats.gamesIndex).length, 10);
    const dota = stats.gamesIndex[570];
    assert.equal(dota.name, 'Dota 2');
    assert.equal(dota.hours, 213.3);
    assert.equal(dota.hours2w, 0);
    assert.equal(dota.lastPlayed, '2016-12-06T20:37:30.000Z');
    assert.equal(dota.year, null);
    assert.deepEqual(dota.genres, []);
    assert.equal(dota.completion, null);
    assert.match(dota.iconUrl, /apps\/570\/.+\.jpg$/);

    const portal = stats.gamesIndex[620];
    assert.equal(portal.completion, 60);
    assert.deepEqual(portal.achievements, { unlocked: 3, total: 5, percent: 60 });
  });

  test('achievements block: completion, rare unlocked, calendar from cached XML', async () => {
    await seed();
    const stats = buildGamesStatsFromCache(PROFILE_KEY);
    assert.equal(stats.summary.completion.gamesWithStats, 1);
    assert.equal(stats.summary.completion.avgPercent, 60);
    assert.equal(stats.summary.completion.medianPercent, 60);
    assert.equal(stats.summary.completion.perfectCount, 0);
    assert.equal(stats.summary.achievements.unlocked, 3);
    assert.equal(stats.summary.achievements.total, 5);
    assert.equal(stats.summary.achievements.rareUnlocked, 1);
    assert.deepEqual(stats.summary.achievements.coverage, { gamesWithStats: 1, gamesTotal: 10 });

    assert.deepEqual(stats.timeline, [{ month: '2015-08', unlocked: 3, games: 1 }]);
    assert.equal(stats.achievementDays.length, 1);
    assert.equal(stats.achievementDays[0].date, '2015-08-06');
    assert.equal(stats.achievementDays[0].count, 3);
    assert.deepEqual(stats.achievementDays[0].appids, [620]);
    assert.equal(stats.streaks.best, 1);
    assert.equal(stats.streaks.current, 0);
    assert.equal(stats.streaks.lastUnlockDate, '2015-08-06');
    assert.equal(stats.meta.calendarAvailable, true);
  });

  test('calendarFromAchievements: consecutive days form a current streak', () => {
    const today = Math.floor(Date.now() / 86400000);
    const day = (offset) => today - offset;
    const at = (dayNumber) => dayNumber * 86400 + 3600;
    const docs = [
      {
        appid: 1,
        achievements: [
          { achieved: true, unlockTimestamp: at(day(2)) },
          { achieved: true, unlockTimestamp: at(day(1)) },
          { achieved: true, unlockTimestamp: at(day(0)) },
          { achieved: false, unlockTimestamp: null },
        ],
      },
    ];
    const calendar = calendarFromAchievements(docs);
    assert.equal(calendar.achievementDays.length, 3);
    assert.equal(calendar.streaks.current, 3);
    assert.equal(calendar.streaks.best, 3);
    assert.equal(calendar.timeline.reduce((sum, entry) => sum + entry.unlocked, 0), 3);
  });

  test('partial (no key) library: libraryPartial flag and no invented game count', () => {
    const stats = buildGamesStats({
      steamId64: ID,
      profile: { userKey: ID, personaName: 'tester', privacy: 'public' },
      library: {
        fetchedAt: new Date().toISOString(),
        partial: true,
        game_count: null,
        games: [
          { appid: 1, name: 'One', playtime_forever: 828, playtime_2weeks: null, rtime_last_played: 0 },
        ],
        totalMinutes: 828,
        fingerprint: 'partial',
      },
      achievements: [],
      globals: new Map(),
    });
    assert.equal(stats.libraryPartial, true);
    assert.equal(stats.summary.gameCount, 1);
    assert.equal(stats.summary.ownedCount, 1);
    assert.equal(stats.summary.totalHours, 13.8);
    assert.equal(stats.meta.calendarAvailable, false);
    assert.deepEqual(stats.timeline, []);
  });

  test('one profile = one owner: a second cached profile is not merged', async () => {
    await seed();
    const OTHER = '76561198000000002';
    await gameCache.saveProfile({
      userKey: OTHER,
      personaName: 'other',
      privacy: 'public',
      importedAt: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    });
    await gameCache.saveLibrary(OTHER, {
      fetchedAt: new Date().toISOString(),
      partial: false,
      game_count: 1,
      games: [
        { appid: 999, name: 'Other Game', playtime_forever: 600, playtime_2weeks: null, rtime_last_played: 0 },
      ],
      totalMinutes: 600,
      fingerprint: 'other',
    });

    const mine = buildGamesStatsFromCache(PROFILE_KEY);
    assert.equal(mine.summary.ownedCount, 10);
    assert.equal(mine.summary.totalHours, 616.2);
    assert.equal(mine.sources.selected.length, 1);
    assert.equal(mine.gamesIndex[999], undefined);

    const other = buildGamesStatsFromCache(`steam-${OTHER}`);
    assert.equal(other.summary.ownedCount, 1);
    assert.equal(other.summary.totalHours, 10);

    assert.equal(buildGamesStatsFromCache('steam-76561198000000009'), null);
    assert.equal(buildGamesStatsFromCache('livelib-Margaret'), null);
  });

  test('profileSummary is compact and honest about partial libraries', async () => {
    await seed();
    const summary = profileSummary(
      gameCache.getProfile(ID),
      gameCache.getLibrary(ID)
    );
    assert.equal(summary.key, PROFILE_KEY);
    assert.equal(summary.gameCount, 10);
    assert.equal(summary.ownedCount, 10);
    assert.equal(summary.totalHours, 616.2);
    assert.equal(summary.playedCount, 8);
    assert.equal(summary.libraryPartial, false);
  });
  after(() => env.resetMutableState());
});


describe('games-stats-m2', () => {
  /**
   * M2 stats: release years/decades, playtime-weighted genres, modes, EA/F2P,
   * platforms, gamesIndex details, and the *real* includeFree/includeDlc filters.
   * Also pins the M1 fallback: no details → old payload + honest pending markers.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const gameCache = require('../server/games/game-cache');
  const { buildGamesStats, buildGamesStatsFromCache } = require('../server/games/stats');

  const ID = '76561198000000201';
  const PROFILE_KEY = `steam-${ID}`;

  function game(appid, minutes) {
    return {
      appid,
      name: `Game ${appid}`,
      playtime_forever: minutes,
      playtime_2weeks: null,
      rtime_last_played: 0,
      img_icon_url: null,
      playtime_windows_forever: 0,
      playtime_mac_forever: 0,
      playtime_linux_forever: 0,
      playtime_deck_forever: 0,
    };
  }

  function doc(appid, extra) {
    return {
      appid,
      success: true,
      type: 'game',
      name: `Game ${appid}`,
      is_free: false,
      developers: ['CD'],
      publishers: ['CD'],
      genres: [{ id: '3', description: 'RPG' }],
      categories: [{ id: '2', description: 'Single-player' }],
      release_date: {
        date: '1 Jan, 2015',
        coming_soon: false,
        year: 2015,
        month: 1,
        day: 1,
        precision: 'day',
      },
      releaseYear: 2015,
      releasePrecision: 'day',
      dlc: [],
      dlcCount: 0,
      metacritic: null,
      platforms: { windows: true, mac: false, linux: false },
      screenshots: [],
      earlyAccess: false,
      metadataSource: 'steam-store',
      ...extra,
    };
  }

  const LIBRARY = {
    fetchedAt: new Date().toISOString(),
    partial: false,
    game_count: 6,
    games: [game(1001, 6000), game(1002, 3000), game(1003, 600), game(1004, 0), game(1005, 300), game(1006, 60)],
    totalMinutes: 9960,
    fingerprint: 'm2-fixture',
  };

  const DETAILS = {
    1001: doc(1001, {
      genres: [
        { id: '3', description: 'RPG' },
        { id: '1', description: 'Action' },
      ],
      dlc: [2001, 2002],
      dlcCount: 2,
      metacritic: { score: 93 },
    }),
    1002: doc(1002, {
      releaseYear: 2020,
      release_date: { date: '10 Dec, 2020', coming_soon: false, year: 2020, month: 12, day: 10, precision: 'day' },
      genres: [{ id: '1', description: 'Action' }],
      categories: [
        { id: '1', description: 'Multi-player' },
        { id: '9', description: 'Co-op' },
        { id: '38', description: 'Online Co-op' },
        { id: '23', description: 'Steam Cloud' },
      ],
      is_free: true,
      earlyAccess: true,
      platforms: { windows: true, mac: false, linux: true },
    }),
    1003: doc(1003, { type: 'dlc', genres: [{ id: '3', description: 'RPG' }] }),
    1004: doc(1004, {
      releaseYear: null,
      release_date: { date: 'Coming soon', coming_soon: true, year: null, month: null, day: null, precision: 'unknown' },
      genres: [{ id: '25', description: 'Indie' }],
      platforms: { windows: false, mac: true, linux: false },
    }),
    // 1005 has no details at all.
    1006: doc(1006, { type: 'demo', releaseYear: 2024, is_free: true }),
  };

  function stats(options = {}) {
    return buildGamesStats({
      steamId64: ID,
      profile: { userKey: ID, personaName: 'tester', privacy: 'public' },
      library: LIBRARY,
      details: DETAILS,
      achievements: [],
      globals: new Map(),
      ...options,
    });
  }

  test('base filters (includeFree=1, includeDlc=0): DLC/demo excluded, unknown kept', () => {
    const payload = stats();
    const summary = payload.summary;
    assert.equal(summary.ownedCount, 6);
    assert.equal(summary.gameCount, 4);
    assert.equal(summary.gameCountEstimated, true); // one game has no details
    assert.equal(summary.totalHours, 155);
    assert.equal(summary.playedCount, 3);
    assert.equal(summary.unplayedCount, 1);
    assert.equal(summary.meanHours, 38.75);
    assert.equal(summary.medianHours, 27.5);

    assert.equal(payload.meta.excluded.dlc, 1);
    assert.equal(payload.meta.excluded.otherType, 1);
    assert.equal(payload.meta.excluded.free, 0);
    assert.equal(payload.meta.excluded.unknownType, 1);

    assert.equal(payload.meta.filters.includeFree.requested, true);
    assert.equal(payload.meta.filters.includeFree.applied, true);
    assert.equal(payload.meta.filters.includeFree.excluded, 0);
    assert.equal(payload.meta.filters.includeDlc.requested, false);
    assert.equal(payload.meta.filters.includeDlc.applied, true);
    assert.equal(payload.meta.filters.includeDlc.excluded, 1);
    assert.equal(payload.meta.filters.includeDlc.excludedTypes, 1);

    assert.deepEqual(Object.keys(payload.gamesIndex).sort(), ['1001', '1002', '1004', '1005']);
    assert.equal(payload.unmatchedCount, 1);
    assert.deepEqual(payload.meta.pending, ['tags', 'reviews', 'franchises', 'studios', 'personnelTop']);
  });

  test('years/decades: releaseYear buckets with an honest unknown bucket last', () => {
    const payload = stats();
    assert.deepEqual(payload.years, [
      { year: 2015, count: 1, hours: 100, secondaryCount: 0 },
      { year: 2020, count: 1, hours: 50, secondaryCount: 0 },
      {
        year: null,
        key: 'unknown',
        label: 'год неизвестен',
        unknown: true,
        count: 2,
        hours: 5,
        secondaryCount: 0,
      },
    ]);
    assert.deepEqual(payload.decades, [
      { decade: 2010, count: 1, hours: 100, secondaryCount: 0 },
      { decade: 2020, count: 1, hours: 50, secondaryCount: 0 },
      {
        decade: null,
        key: 'unknown',
        label: 'год неизвестен',
        unknown: true,
        count: 2,
        hours: 5,
        secondaryCount: 0,
      },
    ]);
    assert.equal(payload.summary.releaseYearFrom, 2015);
    assert.equal(payload.summary.releaseYearTo, 2020);
  });

  test('genres: playtime-weighted wall (hours/weight/share) and counts', () => {
    const payload = stats();
    assert.deepEqual(
      payload.genres.map((entry) => entry.name),
      ['Action', 'RPG', 'Indie']
    );
    assert.deepEqual(payload.genres[0], {
      name: 'Action',
      count: 2,
      hours: 150,
      weight: 150,
      share: 0.968,
      secondaryCount: 0,
    });
    assert.equal(payload.genres[1].hours, 100);
    assert.equal(payload.genres[2].hours, 0);
  });

  test('modes / early access / free-to-play / platforms', () => {
    const payload = stats();
    assert.deepEqual(payload.summary.modes, {
      single: 2,
      multi: 1,
      coop: 1,
      onlineCoop: 1,
      localCoop: 0,
      onlinePvp: 0,
      mmo: 0,
      cloud: 1,
      controller: 0,
    });
    assert.deepEqual(payload.summary.earlyAccess, { count: 1, hours: 50, share: 0.323 });
    assert.deepEqual(payload.summary.freeToPlay, { count: 1, hours: 50, share: 0.323 });
    assert.deepEqual(payload.summary.platforms, {
      windows: 2,
      mac: 1,
      linux: 1,
      deckHours: 0,
      deckHoursShare: 0,
    });
    assert.deepEqual(payload.summary.metadata, {
      detailsResolved: 5,
      detailsTotal: 6,
      detailsPercent: 83.3,
      detailsUnavailable: 0,
      detailsMissing: 1,
      lastEnrichedAt: null,
      // Additive (integration round): the UI polls while a job is running.
      running: false,
    });
  });

  test('gamesIndex carries the full details entry; top/backlog are enriched', () => {
    const payload = stats();
    assert.deepEqual(payload.gamesIndex[1001], {
      appid: 1001,
      name: 'Game 1001',
      hours: 100,
      hours2w: 0,
      rtime: 0,
      lastPlayed: null,
      iconUrl: null,
      // M7 (additive): no `header_image` in this fixture — the card falls back
      // to the legacy CDN chain instead of inventing a URL.
      headerImage: null,
      // M5-B (additive): edition identity; `hours` above stays this row's own.
      canonicalWorkKey: 'steam:1001',
      primaryAppid: 1001,
      isPrimary: true,
      editionCount: 1,
      canonicalHours: 100,
      type: 'game',
      year: 2015,
      releaseYear: 2015,
      genres: ['RPG', 'Action'],
      developers: ['CD'],
      publishers: ['CD'],
      categories: ['Single-player'],
      dlcCount: 2,
      metacritic: 93,
      isFree: false,
      earlyAccess: false,
      metadataSources: ['steam-store'],
      // M4 (additive): no SteamSpy/reviews documents in this fixture.
      tags: [],
      reviewScore: null,
      reviewDesc: null,
      // M4-B (additive): no Wikidata links document in this fixture either —
      // `null` means «WD has not answered», not «no franchise».
      franchise: null,
      releaseYearWikidata: null,
      completion: null,
      achievements: null,
    });
    // No details → null/[] placeholders, never invented values.
    const unknown = payload.gamesIndex[1005];
    assert.equal(unknown.type, null);
    assert.equal(unknown.releaseYear, null);
    assert.deepEqual(unknown.genres, []);
    assert.deepEqual(unknown.metadataSources, []);

    assert.equal(payload.topGames[0].appid, 1001);
    assert.equal(payload.topGames[0].releaseYear, 2015);
    assert.deepEqual(payload.topGames[0].genres, ['RPG', 'Action']);
    assert.equal(payload.topGames[0].type, 'game');
    assert.equal(payload.backlog.items.length, 1);
    assert.equal(payload.backlog.items[0].appid, 1004);
    assert.equal(payload.backlog.items[0].releaseYear, null);
    assert.deepEqual(payload.backlog.items[0].genres, ['Indie']);
  });

  test('includeDlc=1 includes DLC in every counter; demo/software stay out', () => {
    const payload = stats({ includeDlc: true });
    assert.equal(payload.summary.gameCount, 5);
    assert.equal(payload.summary.totalHours, 165);
    assert.equal(payload.meta.excluded.dlc, 0);
    assert.equal(payload.meta.excluded.otherType, 1);
    assert.ok(payload.gamesIndex[1003]);
    assert.equal(payload.gamesIndex[1003].type, 'dlc');
    assert.equal(payload.genres.find((entry) => entry.name === 'RPG').hours, 110);
    assert.deepEqual(
      payload.decades.map((entry) => [entry.decade, entry.count, entry.hours]),
      [
        [2010, 2, 110],
        [2020, 1, 50],
        [null, 2, 5],
      ]
    );
    assert.equal(payload.summary.modes.single, 3);
  });

  test('includeFree=0 really removes free-to-play games from every counter', () => {
    const payload = stats({ includeFree: false });
    assert.equal(payload.summary.gameCount, 3);
    assert.equal(payload.summary.totalHours, 105);
    assert.equal(payload.meta.excluded.free, 1);
    assert.equal(payload.meta.filters.includeFree.requested, false);
    assert.equal(payload.meta.filters.includeFree.excluded, 1);
    assert.equal(payload.gamesIndex[1002], undefined);
    assert.deepEqual(payload.summary.freeToPlay, { count: 0, hours: 0, share: 0 });
    assert.equal(payload.summary.modes.multi, 0);
    assert.deepEqual(
      payload.genres.map((entry) => [entry.name, entry.hours]),
      [
        ['Action', 100],
        ['RPG', 100],
        ['Indie', 0],
      ]
    );
    assert.equal(payload.summary.platforms.windows, 1);
    assert.equal(payload.summary.platforms.linux, 0);
  });

  test('both filters at once: only paid games and DLC remain', () => {
    const payload = stats({ includeFree: false, includeDlc: true });
    assert.equal(payload.summary.gameCount, 4);
    assert.equal(payload.summary.totalHours, 115);
    assert.deepEqual(Object.keys(payload.gamesIndex).sort(), ['1001', '1003', '1004', '1005']);
  });

  test('M1 fallback: no details → old payload and explicit pending markers', () => {
    const payload = stats({ details: {} });
    assert.equal(payload.summary.gameCount, 6);
    assert.equal(payload.summary.gameCountEstimated, true);
    assert.equal(payload.summary.totalHours, 166);
    assert.deepEqual(payload.genres, []);
    assert.deepEqual(payload.years, []);
    assert.deepEqual(payload.decades, []);
    assert.equal(payload.summary.modes, null);
    assert.equal(payload.summary.earlyAccess, null);
    assert.equal(payload.summary.freeToPlay, null);
    assert.equal(payload.summary.platforms, null);
    assert.equal(payload.summary.metadata, null);
    assert.equal(payload.meta.filters.includeFree.applied, false);
    assert.equal(payload.meta.filters.includeFree.reason, 'details_not_imported');
    assert.equal(payload.meta.filters.includeDlc.applied, false);
    assert.ok(payload.meta.pending.includes('genres'));
    assert.ok(payload.meta.pending.includes('modes'));
    assert.equal(payload.unmatchedCount, 6);
    assert.equal(payload.gamesIndex[1001].type, null);
  });

  test('buildGamesStatsFromCache reads details/<appid>.json from the cache', async () => {
    const now = new Date().toISOString();
    await gameCache.saveProfile({
      userKey: ID,
      personaName: 'tester',
      privacy: 'public',
      importedAt: now,
      fetchedAt: now,
    });
    await gameCache.saveLibrary(ID, LIBRARY);
    await gameCache.saveDetails(1001, { ...DETAILS[1001], fetchedAt: now });
    await gameCache.saveDetails(1002, { ...DETAILS[1002], fetchedAt: now });

    const payload = buildGamesStatsFromCache(PROFILE_KEY);
    assert.ok(payload);
    assert.equal(payload.summary.metadata.detailsResolved, 2);
    assert.equal(payload.summary.metadata.lastEnrichedAt, now);
    assert.equal(payload.meta.filters.includeDlc.applied, true);
    assert.ok(payload.years.some((entry) => entry.year === 2015));
    assert.ok(payload.genres.length > 0);
    // includeFree=0 is honoured through the cache path too.
    const paid = buildGamesStatsFromCache(PROFILE_KEY, { includeFree: false });
    assert.equal(paid.meta.excluded.free, 1);
  });
  after(() => env.resetMutableState());
});


describe('games-stats-m4', () => {
  /**
   * M4 stats payload: SteamSpy tag wall, the nine review-score buckets, DLC
   * facts and the additive `gamesIndex` fields. Pure `buildGamesStats` calls —
   * no cache, no network.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');

  const { buildGamesStats, REVIEW_SCORE_LABELS } = require('../server/games/stats');

  function game(appid, minutes, name = `Game ${appid}`) {
    return {
      appid,
      name,
      playtime_forever: minutes,
      playtime_2weeks: 0,
      rtime_last_played: 0,
      img_icon_url: null,
    };
  }

  function detailsDoc(appid, extra = {}) {
    return {
      success: true,
      type: 'game',
      name: `Game ${appid}`,
      is_free: false,
      genres: [{ id: '1', description: 'Action' }],
      categories: [{ id: '2', description: 'Single-player' }],
      releaseYear: 2015,
      dlc: [],
      dlcCount: 0,
      platforms: { windows: true, mac: false, linux: false },
      ...extra,
    };
  }

  function spyDoc(tags) {
    return { success: true, tags };
  }

  function reviewDoc(score, desc) {
    return { success: true, score, desc, positive: 100, negative: 10, total: 110 };
  }

  function build(overrides = {}) {
    return buildGamesStats({
      steamId64: '76561198000000001',
      profile: { userKey: '76561198000000001', personaName: 'tester' },
      library: { games: [], game_count: 0 },
      details: {},
      achievements: [],
      globals: new Map(),
      ...overrides,
    });
  }

  const LIBRARY = {
    games: [game(1, 600), game(2, 0), game(3, 120), game(4, 60)],
    game_count: 4,
    fetchedAt: new Date().toISOString(),
  };

  const DETAILS = {
    1: detailsDoc(1, { dlc: [10, 11, 12], dlcCount: 3 }),
    2: detailsDoc(2, { dlc: [], dlcCount: 0 }),
    3: detailsDoc(3, { dlc: [20], dlcCount: 1 }),
    4: detailsDoc(4, { dlc: [], dlcCount: 0 }),
  };

  const SPY = {
    1: spyDoc([
      { name: 'RPG', weight: 900 },
      { name: 'Open World', weight: 800 },
      { name: 'Story Rich', weight: 700 },
      { name: 'Fantasy', weight: 600 },
      { name: 'Atmospheric', weight: 500 },
      { name: 'Choices Matter', weight: 400 },
    ]),
    2: spyDoc([
      { name: 'RPG', weight: 300 },
      { name: 'Indie', weight: 200 },
    ]),
    3: spyDoc([
      { name: 'RPG', weight: 100 },
      { name: 'Open World', weight: 50 },
    ]),
  };

  const REVIEWS = {
    1: reviewDoc(9, 'Overwhelmingly Positive'),
    2: reviewDoc(5, 'Mixed'),
    3: reviewDoc(9, 'Overwhelmingly Positive'),
    4: { success: false, unavailable: true, score: null, desc: null },
  };

  test('tags: count = games with the tag, hours = their playtime, weight = Σ SteamSpy weights', () => {
    const payload = build({ library: LIBRARY, details: DETAILS, spy: SPY });
    assert.deepEqual(payload.tags, [
      { name: 'RPG', count: 3, hours: 12, weight: 1300 },
      { name: 'Open World', count: 2, hours: 12, weight: 850 },
      { name: 'Story Rich', count: 1, hours: 10, weight: 700 },
      { name: 'Fantasy', count: 1, hours: 10, weight: 600 },
      { name: 'Atmospheric', count: 1, hours: 10, weight: 500 },
      { name: 'Choices Matter', count: 1, hours: 10, weight: 400 },
      { name: 'Indie', count: 1, hours: 0, weight: 200 },
    ]);
    assert.deepEqual(payload.meta.tags, {
      source: 'steamspy',
      gamesWithTags: 3,
      gamesTotal: 4,
      percent: 75,
    });
    assert.ok(!payload.meta.pending.includes('tags'));
  });

  test('tags: top 50 only, honest empty array without SteamSpy documents', () => {
    const tags = {};
    for (let index = 0; index < 60; index++) tags[`Tag ${String(index).padStart(2, '0')}`] = 1000 - index;
    const payload = build({
      library: { games: [game(1, 60)], game_count: 1 },
      details: { 1: detailsDoc(1) },
      spy: { 1: spyDoc(Object.entries(tags).map(([name, weight]) => ({ name, weight }))) },
    });
    assert.equal(payload.tags.length, 50);
    assert.equal(payload.tags[0].name, 'Tag 00');

    const empty = build({ library: LIBRARY, details: DETAILS });
    assert.deepEqual(empty.tags, []);
    assert.equal(empty.meta.tags.gamesWithTags, 0);
    assert.equal(empty.meta.tags.percent, 0);
    assert.ok(empty.meta.pending.includes('tags'));
  });

  test('tags follow the visible (filtered) set, not the raw library', () => {
    const library = {
      games: [game(1, 600), game(2, 0)],
      game_count: 2,
    };
    const details = {
      1: detailsDoc(1),
      2: detailsDoc(2, { type: 'dlc' }),
    };
    const spy = {
      1: spyDoc([{ name: 'RPG', weight: 10 }]),
      2: spyDoc([{ name: 'DLC Tag', weight: 99 }]),
    };
    const payload = build({ library, details, spy });
    assert.equal(payload.summary.gameCount, 1);
    assert.deepEqual(payload.tags.map((tag) => tag.name), ['RPG']);
  });

  test('reviewScore: avg/median over cached summaries, nine Steam buckets', () => {
    const payload = build({ library: LIBRARY, details: DETAILS, reviews: REVIEWS });
    assert.deepEqual(payload.summary.reviewScore, { avg: 7.67, median: 9 });
    assert.equal(payload.scores.length, 9);
    assert.deepEqual(
      payload.scores.map((entry) => [entry.score, entry.bucket, entry.count, entry.hours]),
      [
        [1, REVIEW_SCORE_LABELS[1], 0, 0],
        [2, REVIEW_SCORE_LABELS[2], 0, 0],
        [3, REVIEW_SCORE_LABELS[3], 0, 0],
        [4, REVIEW_SCORE_LABELS[4], 0, 0],
        [5, REVIEW_SCORE_LABELS[5], 1, 0],
        [6, REVIEW_SCORE_LABELS[6], 0, 0],
        [7, REVIEW_SCORE_LABELS[7], 0, 0],
        [8, REVIEW_SCORE_LABELS[8], 0, 0],
        [9, REVIEW_SCORE_LABELS[9], 2, 12],
      ]
    );
    assert.deepEqual(payload.meta.reviews, {
      source: 'steam-reviews',
      gamesWithReviews: 3,
      gamesTotal: 4,
      percent: 75,
    });
    // `success:false` (no summary) is not a 0-score game.
    assert.ok(!payload.meta.pending.includes('reviews'));
  });

  test('reviewScore: null and [] when nothing is cached — never a fake 0', () => {
    const payload = build({ library: LIBRARY, details: DETAILS });
    assert.equal(payload.summary.reviewScore, null);
    assert.deepEqual(payload.scores, []);
    assert.equal(payload.meta.reviews.gamesWithReviews, 0);
    assert.ok(payload.meta.pending.includes('reviews'));
  });

  test('dlc: gamesWithDlc/avgCount/max top-10 from dlcCount in details', () => {
    const payload = build({ library: LIBRARY, details: DETAILS });
    assert.equal(payload.summary.dlc.gamesWithDlc, 2);
    assert.equal(payload.summary.dlc.dlcTotal, 4);
    assert.equal(payload.summary.dlc.avgCount, 1);
    assert.deepEqual(payload.summary.dlc.max, [
      { appid: 1, name: 'Game 1', dlcCount: 3 },
      { appid: 3, name: 'Game 3', dlcCount: 1 },
    ]);
    const noDetails = build({ library: LIBRARY });
    assert.equal(noDetails.summary.dlc, null);
  });

  test('dlc: max is capped at 10 and sorted by count', () => {
    const games = [];
    const details = {};
    for (let index = 0; index < 14; index++) {
      const appid = 100 + index;
      games.push(game(appid, 60));
      details[appid] = detailsDoc(appid, { dlcCount: index });
    }
    const payload = build({ library: { games, game_count: games.length }, details });
    assert.equal(payload.summary.dlc.max.length, 10);
    assert.equal(payload.summary.dlc.max[0].dlcCount, 13);
    assert.equal(payload.summary.dlc.max[9].dlcCount, 4);
  });

  test('gamesIndex: top-5 tags by weight + review score/desc, additive to M2 fields', () => {
    const payload = build({ library: LIBRARY, details: DETAILS, spy: SPY, reviews: REVIEWS });
    const entry = payload.gamesIndex[1];
    assert.deepEqual(entry.tags, [
      { name: 'RPG', weight: 900 },
      { name: 'Open World', weight: 800 },
      { name: 'Story Rich', weight: 700 },
      { name: 'Fantasy', weight: 600 },
      { name: 'Atmospheric', weight: 500 },
    ]);
    assert.equal(entry.reviewScore, 9);
    assert.equal(entry.reviewDesc, 'Overwhelmingly Positive');
    assert.deepEqual(entry.metadataSources, ['steam-store', 'steamspy', 'steam-reviews']);
    assert.equal(entry.type, 'game');
    assert.equal(entry.dlcCount, 3);

    // A game with no tags/reviews keeps honest nulls and an empty list.
    const unknown = payload.gamesIndex[4];
    assert.deepEqual(unknown.tags, []);
    assert.equal(unknown.reviewScore, null);
    assert.equal(unknown.reviewDesc, null);
    assert.deepEqual(unknown.metadataSources, ['steam-store']);
  });

  test('payload size: tags carry no appid lists (the card has them), scores only count/hours', () => {
    const payload = build({ library: LIBRARY, details: DETAILS, spy: SPY, reviews: REVIEWS });
    for (const tag of payload.tags) {
      assert.deepEqual(Object.keys(tag).sort(), ['count', 'hours', 'name', 'weight']);
    }
    for (const bucket of payload.scores) {
      assert.deepEqual(Object.keys(bucket).sort(), ['bucket', 'count', 'hours', 'score']);
    }
  });

  /* ------------------------------------------------------------------ */
  /* M4-B integration: Wikidata links in the games index                 */
  /* ------------------------------------------------------------------ */

  const LINKS = {
    1: {
      qid: 'Q1',
      franchise: { qid: 'Q18935909', labelEn: 'The Witcher', labelRu: 'Ведьмак' },
      releaseYear: 2015,
      releasePrecision: 'day',
      franchiseKey: 'wd:Q18935909',
      resolved: true,
      fetchedAt: '2026-11-01T00:00:00.000Z',
    },
    2: { qid: 'Q2', franchise: null, releaseYear: null, franchiseKey: null, resolved: true },
  };

  test('gamesIndex: franchise + P577 year are additive, null when WD has not answered', () => {
    const payload = build({ library: LIBRARY, details: DETAILS, links: LINKS });
    const witcher = payload.gamesIndex[1];
    assert.deepEqual(witcher.franchise, {
      key: 'wd:Q18935909',
      label: 'The Witcher',
      labelRu: 'Ведьмак',
    });
    assert.equal(witcher.releaseYearWikidata, 2015);
    assert.deepEqual(witcher.metadataSources, ['steam-store', 'wikidata']);

    // WD answered «no series / no year»: still null, never invented.
    const answered = payload.gamesIndex[2];
    assert.equal(answered.franchise, null);
    assert.equal(answered.releaseYearWikidata, null);
    assert.deepEqual(answered.metadataSources, ['steam-store', 'wikidata']);

    // No links document at all: nulls and no `wikidata` in the sources.
    const missing = payload.gamesIndex[3];
    assert.equal(missing.franchise, null);
    assert.equal(missing.releaseYearWikidata, null);
    assert.deepEqual(missing.metadataSources, ['steam-store']);
  });

  test('meta.franchises: Wikidata-only math, heuristic lives in /franchises', () => {
    const payload = build({ library: LIBRARY, details: DETAILS, links: LINKS });
    assert.deepEqual(payload.meta.franchises, {
      source: 'wikidata',
      includesHeuristic: false,
      gamesWithFranchise: 1,
      gamesAnswered: 2,
      gamesTotal: 4,
      percent: 25,
    });
    // Two documents answered → the WD pass is no longer «pending».
    assert.ok(!payload.meta.pending.includes('franchises'));
  });

  test('meta.pending keeps "franchises" until the WD pass has written links', () => {
    const payload = build({ library: LIBRARY, details: DETAILS });
    assert.ok(payload.meta.pending.includes('franchises'));
    assert.deepEqual(payload.meta.franchises, {
      source: 'wikidata',
      includesHeuristic: false,
      gamesWithFranchise: 0,
      gamesAnswered: 0,
      gamesTotal: 4,
      percent: 0,
    });
  });
  after(() => env.resetMutableState());
});


describe('games-stats-sections', () => {
  /**
   * S1 «распил god-функции»: micro-tests for the pure section builders of
   * `/api/games/stats`. No cache, no network, no production directories — the
   * builders take plain objects in and return plain objects out.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');

  const { buildVisible } = require('../server/games/stats/visible');
  const { buildTimeline } = require('../server/games/stats/timeline');
  const { buildWorkMeta } = require('../server/games/stats/work-meta');

  function steamWork(appid, minutes) {
    return {
      workKey: `steam:${appid}`,
      primary: { appid, name: `Game ${appid}` },
      games: [
        {
          appid,
          name: `Game ${appid}`,
          playtime_forever: minutes,
          playtime_2weeks: 0,
          rtime_last_played: 0,
        },
      ],
      minutes,
      minutes2w: 0,
      rtime: 0,
    };
  }

  function secondaryOnly(workKey, minutes, hoursUnknown = false) {
    return {
      workKey,
      name: `Secondary ${workKey}`,
      sources: ['gog'],
      storeIds: { gog: workKey.slice(4) },
      secondaryMinutes: minutes,
      displayMinutes: minutes,
      hoursUnknown,
      hoursStatus: { gog: hoursUnknown ? 'pending' : 'ok' },
      genres: [],
      developers: [],
      publishers: [],
      metadataSources: ['gog'],
    };
  }

  test('buildVisible: display hours drive minHours, unknown-hours works are kept', () => {
    const work = steamWork(1, 60);
    const union = {
      byWorkKey: new Map([['steam:1', { displayMinutes: 120 }]]),
      secondaryOnly: [
        secondaryOnly('gog:9', 0),
        secondaryOnly('gog:10', 0, true),
      ],
      summary: {},
    };
    const allWorks = [work];

    const all = buildVisible({ union, allWorks, minHours: -1, games: work.games });
    assert.equal(all.gameCount, 3, 'every work is visible at minHours=-1');
    assert.equal(all.totalHoursAll, 2, 'display total is the union minutes, not the Steam row');
    assert.equal(all.secondaryVisible.length, 2);

    const played = buildVisible({ union, allWorks, minHours: 0, games: work.games });
    assert.equal(played.gameCount, 2, '0-hour secondary work is dropped, unknown-hours work is kept');
    assert.equal(played.playedCount, 1);
    assert.equal(played.unplayedCount, 0);
    assert.equal(played.hoursUnknownCount, 1);
  });

  test('buildTimeline: months, achievement days and the best streak', () => {
    const ts = (iso) => Date.parse(`${iso}T10:00:00Z`) / 1000;
    const docs = [
      {
        appid: 1,
        achievements: [
          { achieved: true, unlockTimestamp: ts('2020-01-01') },
          { achieved: true, unlockTimestamp: ts('2020-01-02') },
          { achieved: false, unlockTimestamp: null },
        ],
      },
      {
        appid: 2,
        achievements: [{ achieved: true, unlockTimestamp: ts('2020-02-01') }],
      },
    ];
    const canonicalOf = (appid) => ({ workKey: `steam:${appid}` });
    const { timeline, achievementDays, streaks } = buildTimeline({ achievementDocs: docs, canonicalOf });

    assert.deepEqual(timeline, [
      { month: '2020-01', unlocked: 2, games: 1 },
      { month: '2020-02', unlocked: 1, games: 1 },
    ]);
    assert.equal(achievementDays.length, 3);
    assert.deepEqual(achievementDays[0], { date: '2020-01-01', count: 1, appids: [1] });
    assert.equal(streaks.best, 2);
    assert.deepEqual(streaks.bestDates, ['2020-01-01', '2020-01-02']);
    assert.equal(streaks.lastUnlockDate, '2020-02-01');
  });

  test('buildWorkMeta: own year → Wikidata P577 → base version → secondary store', () => {
    const meta = buildWorkMeta({
      details: { 1: { success: true, releaseYear: 2011 } },
      detailsBase: { 99: { success: true, releaseYear: 2001, genres: [{ description: 'Action' }] } },
      linkDocs: {
        2: { releaseYear: 2012 },
        4: { baseAppid: 99 },
      },
      spyDocs: {},
      reviewDocs: {},
      unionOf: () => null,
      workByAppid: new Map(),
    });

    assert.equal(meta.workYear({ games: [{ appid: 1 }] }), 2011, 'own appdetails year wins');
    assert.equal(meta.workYear({ games: [{ appid: 2 }] }), 2012, 'Wikidata P577 is the fallback');
    assert.equal(meta.workYear({ games: [{ appid: 4 }] }), 2001, 'base-version card is the last resort');
    assert.equal(
      meta.workYear({ games: [{ appid: 3 }], union: { releaseYear: 2015 } }),
      2015,
      'a secondary-only work takes its store release year'
    );
    assert.deepEqual(
      meta.workGenres({ games: [{ appid: 3 }], union: { genres: ['RPG'] } }),
      ['RPG']
    );
  });
  after(() => env.resetMutableState());
});


describe('games-steam', () => {
  /**
   * Steam client (M1): parsers of the three real payloads + politeness rules.
   *
   * All network calls are faked (or a localhost server); `npm test` never talks
   * to Steam (ИГРЫ §10.3). Fixtures are trimmed real responses from 01.11.2026
   * with the steamid64 replaced by a fake one and no key anywhere.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const http = require('node:http');

  const steam = require('../server/games/steam');
  const { readFixture } = require('./fixtures/games/fake-client');

  const profileXml = readFixture('profile.xml');
  const ownedJson = JSON.parse(readFixture('owned-games.json'));
  const achievementsXml = readFixture('achievements.xml');
  const globalJson = JSON.parse(readFixture('global-percentages.json'));

  function memoryBreakerStore(initial = {}) {
    let state = initial;
    return {
      read: () => state,
      write: (next) => {
        state = next;
      },
      snapshot: () => state,
    };
  }

  function fakeRequest(handler) {
    const calls = [];
    const request = async (url, options) => {
      calls.push({ url, options });
      return handler(url, options, calls.length);
    };
    request.calls = calls;
    return request;
  }

  test('parseProfileXml: vanity → steamid64, privacy, persona and the most recent games', () => {
    const profile = steam.parseProfileXml(profileXml);
    assert.equal(profile.steamId64, '76561198000000001');
    assert.equal(profile.customUrl, 'test-player');
    assert.equal(profile.personaName, 'test-player');
    assert.equal(profile.privacyState, 'public');
    assert.equal(profile.visibilityState, 3);
    assert.equal(profile.memberSince, 'February 19, 2011');
    assert.equal(profile.memberSinceAt, '2011-02-19T00:00:00.000Z');
    assert.equal(profile.mostPlayedGames.length, 2);
    assert.equal(profile.mostPlayedGames[0].appid, 1313140);
    assert.equal(profile.mostPlayedGames[0].hoursOnRecord, 13.8);
    // The XML `hoursPlayed2Wk` is stale; it is parsed but never aggregated.
    assert.equal(profile.hoursPlayed2Wk, 0);
  });

  test('parseOwnedGamesResponse: counts, minutes, optional fields and fingerprint', () => {
    const owned = steam.parseOwnedGamesResponse(ownedJson);
    assert.equal(owned.empty, false);
    assert.equal(owned.gameCount, 10);
    assert.equal(owned.games.length, 10);
    assert.equal(owned.totalMinutes, 36973);
    assert.equal(owned.fingerprint, steam.libraryFingerprint(owned.games, 10));

    const cyberpunk = owned.games.find((game) => game.appid === 1091500);
    assert.equal(cyberpunk.playtime_2weeks, 108);
    assert.equal(cyberpunk.rtime_last_played, 1793295251);

    // Absence of an optional field = "unknown"/"no activity", never a fake 0.
    const halfLife = owned.games.find((game) => game.appid === 70);
    assert.equal(halfLife.playtime_2weeks, null);
    assert.equal(halfLife.has_community_visible_stats, null);

    // The fingerprint ignores a stable snapshot and changes with playtime.
    const same = steam.parseOwnedGamesResponse(ownedJson);
    assert.equal(same.fingerprint, owned.fingerprint);
    const changed = {
      response: {
        game_count: 10,
        games: ownedJson.response.games.map((game) =>
          game.appid === 70 ? { ...game, playtime_forever: game.playtime_forever + 1 } : game
        ),
      },
    };
    assert.notEqual(steam.parseOwnedGamesResponse(changed).fingerprint, owned.fingerprint);
  });

  test('parseOwnedGamesResponse: missing/empty response means private, not "0 games"', () => {
    assert.equal(steam.parseOwnedGamesResponse({}).empty, true);
    assert.equal(steam.parseOwnedGamesResponse({ response: {} }).empty, true);
    assert.equal(steam.parseOwnedGamesResponse({ response: { game_count: 0, games: [] } }).empty, true);
  });

  test('parseRecentlyPlayedResponse: same row shape as owned games, empty window is not an error', () => {
    const recent = steam.parseRecentlyPlayedResponse(
      JSON.parse(readFixture('recently-played-populated.json'))
    );
    assert.equal(recent.empty, false);
    assert.equal(recent.gameCount, 3);
    assert.equal(recent.games.length, 3);
    const cyberpunk = recent.games.find((game) => game.appid === 1091500);
    // A 2-week window row is normalized like a library row: minutes stay minutes
    // and an unexposed launch date stays 0 (the "unknown" value).
    assert.equal(cyberpunk.playtime_2weeks, 108);
    assert.equal(cyberpunk.playtime_forever, 120);
    assert.equal(cyberpunk.rtime_last_played, 0);
    assert.equal(recent.totalMinutes, 120 + 1204 + 30);
    assert.equal(recent.fingerprint, steam.libraryFingerprint(recent.games, 3));

    // An empty `response` / `total_count: 0` is "nothing played", not an error.
    assert.equal(steam.parseRecentlyPlayedResponse({}).empty, true);
    assert.equal(steam.parseRecentlyPlayedResponse({ response: {} }).empty, true);
    assert.deepEqual(
      steam.parseRecentlyPlayedResponse({ response: { total_count: 0, games: [] } }).games,
      []
    );
  });

  test('getRecentlyPlayedGames: canonical URL, key never echoed, parsed window', async () => {
    const fixture = readFixture('recently-played-populated.json');
    const request = fakeRequest(() => ({ status: 200, body: fixture }));
    const key = 'SECRETKEY0123456789';
    const client = steam.createClient({
      request,
      pauseMs: 0,
      breakerStore: memoryBreakerStore(),
      keyProvider: () => ({ key, source: 'env:STEAM_API_KEY' }),
    });
    const recent = await client.getRecentlyPlayedGames('76561198000000001');
    assert.equal(recent.games.length, 3);
    const url = request.calls[0].url;
    assert.match(url, /\/IPlayerService\/GetRecentlyPlayedGames\/v1\/\?/);
    assert.match(url, /steamid=76561198000000001/);
    assert.match(url, /format=json/);
    assert.equal(url.includes(key), true, 'the key travels in the URL…');
    assert.equal(steam.maskSecrets(url).includes(key), false, '…and is masked when logged');
  });

  test('parseAchievementsXml: closed flags, unlockTimestamp and fingerprint', () => {
    const parsed = steam.parseAchievementsXml(achievementsXml);
    assert.equal(parsed.privacyState, 'public');
    assert.equal(parsed.appid, 620);
    assert.equal(parsed.gameName, 'Portal 2');
    assert.equal(parsed.totalCount, 5);
    assert.equal(parsed.unlockedCount, 3);
    assert.equal(parsed.achievements.filter((entry) => !entry.achieved).length, 2);
    const first = parsed.achievements.find((entry) => entry.achieved);
    assert.equal(first.apiname, 'ach.survive_container_ride');
    assert.equal(first.unlockTimestamp, 1438886614);
    assert.equal(first.unlockAt, '2015-08-06T18:43:34.000Z');
    const locked = parsed.achievements.find((entry) => !entry.achieved);
    assert.equal(locked.unlockTimestamp, null);
    assert.equal(parsed.fingerprint.length, 40);
  });

  test('parseGlobalPercentages: numeric percent and case-insensitive lookup', () => {
    const parsed = steam.parseGlobalPercentages(globalJson, 620);
    assert.equal(parsed.appid, 620);
    assert.equal(parsed.achievements.length, 5);
    assert.equal(parsed.byName['ACH.SURVIVE_CONTAINER_RIDE'], 74);
    assert.equal(parsed.byName['ach.survive_container_ride'], 74);
    assert.equal(parsed.byName['ACH.SPEED_RUN_LEVEL'], 4);
  });

  test('normalizeTarget accepts steamid64, vanity and profile URLs', () => {
    assert.deepEqual(steam.normalizeTarget('76561198000000001').id64, '76561198000000001');
    assert.deepEqual(steam.normalizeTarget('whitefiercewolf').vanity, 'whitefiercewolf');
    assert.deepEqual(
      steam.normalizeTarget('https://steamcommunity.com/id/whitefiercewolf/').vanity,
      'whitefiercewolf'
    );
    assert.deepEqual(
      steam.normalizeTarget('https://steamcommunity.com/profiles/76561198000000001').id64,
      '76561198000000001'
    );
    assert.throws(() => steam.normalizeTarget(''), /steamid64|vanity/i);
    assert.throws(() => steam.normalizeTarget('12345'), (err) => err.code === 'invalid_steamid');
    assert.throws(
      () => steam.normalizeTarget('https://example.com/id/foo'),
      (err) => err.code === 'invalid_steamid'
    );
  });

  test('maskSecrets never leaks the key from a URL', () => {
    const masked = steam.maskSecrets(
      'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=SECRET123&steamid=1'
    );
    assert.equal(masked.includes('SECRET123'), false);
    assert.match(masked, /key=\*\*\*/);
  });

  test('getProfile: vanity request URL, pause between community calls, parsed result', async () => {
    let clock = 1_000_000;
    const sleepCalls = [];
    const request = fakeRequest(() => ({ status: 200, body: profileXml }));
    const client = steam.createClient({
      request,
      pauseMs: 2000,
      now: () => clock,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        clock += ms;
      },
      breakerStore: memoryBreakerStore(),
    });
    const profile = await client.getProfile('whitefiercewolf');
    assert.equal(profile.steamId64, '76561198000000001');
    assert.equal(request.calls[0].url, 'https://steamcommunity.com/id/whitefiercewolf/?xml=1');
    await client.getProfile('76561198000000001');
    assert.deepEqual(sleepCalls, [2000]);
    assert.match(request.calls[1].url, /\/profiles\/76561198000000001\/\?xml=1$/);
  });

  test('403/429 trips a 30-minute breaker and blocks further community requests', async () => {
    let clock = 5_000_000;
    const store = memoryBreakerStore();
    const request = fakeRequest(() => ({ status: 429, body: 'Too Many Requests' }));
    const client = steam.createClient({
      request,
      pauseMs: 0,
      now: () => clock,
      breakerStore: store,
    });
    await assert.rejects(
      () => client.getProfile('whitefiercewolf'),
      (err) => err.code === 'steam_rate_limited'
    );
    assert.equal(request.calls.length, 1);
    const breaker = store.snapshot()['steamcommunity.com'];
    assert.equal(breaker.until, clock + 30 * 60 * 1000);

    // While open: fail fast, no new request.
    await assert.rejects(
      () => client.getProfile('whitefiercewolf'),
      (err) => err.code === 'steam_rate_limited' && Boolean(err.retryAt)
    );
    assert.equal(request.calls.length, 1);

    // After the window the client may try again.
    clock = breaker.until + 1;
    const okRequest = fakeRequest(() => ({ status: 200, body: profileXml }));
    const client2 = steam.createClient({
      request: okRequest,
      pauseMs: 0,
      now: () => clock,
      breakerStore: store,
    });
    const profile = await client2.getProfile('whitefiercewolf');
    assert.equal(profile.steamId64, '76561198000000001');
    assert.equal(okRequest.calls.length, 1);
  });

  test('Cloudflare challenge body is treated as a block', async () => {
    const store = memoryBreakerStore();
    const client = steam.createClient({
      request: async () => ({ status: 200, body: '<title>Just a moment...</title>' }),
      pauseMs: 0,
      now: () => 1000,
      breakerStore: store,
    });
    await assert.rejects(() => client.getProfile('x'), (err) => err.code === 'steam_rate_limited');
    assert.ok(store.snapshot()['steamcommunity.com']);
  });

  test('network failures are steam_unreachable and never trip the breaker', async () => {
    const store = memoryBreakerStore();
    const networkError = Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
    const client = steam.createClient({
      request: async () => {
        throw networkError;
      },
      pauseMs: 0,
      now: () => 1000,
      breakerStore: store,
    });
    await assert.rejects(
      () => client.getProfile('whitefiercewolf'),
      (err) => err.code === 'steam_unreachable' && /DNS|сеть/i.test(err.message)
    );
    assert.deepEqual(store.snapshot(), {});
  });

  test('the key is masked in errors and never returned in a status', async () => {
    const key = 'SECRETKEY0123456789';
    const request = fakeRequest(() => ({ status: 500, body: 'boom' }));
    const client = steam.createClient({
      request,
      pauseMs: 0,
      now: () => 1000,
      breakerStore: memoryBreakerStore(),
      keyProvider: () => ({ key, source: 'env:STEAM_API_KEY' }),
    });
    await assert.rejects(
      () => client.getOwnedGames('76561198000000001'),
      (err) => {
        assert.equal(err.code, 'steam_http_error');
        assert.equal(err.message.includes(key), false);
        assert.match(err.message, /key=\*\*\*/);
        return true;
      }
    );
  });

  test('a missing key is steam_key_missing; 401 is steam_key_invalid', async () => {
    const noKey = steam.createClient({
      request: async () => ({ status: 200, body: '{}' }),
      pauseMs: 0,
      breakerStore: memoryBreakerStore(),
      keyProvider: () => ({ key: null, source: null }),
    });
    await assert.rejects(
      () => noKey.getOwnedGames('76561198000000001'),
      (err) => err.code === 'steam_key_missing'
    );

    const badKey = steam.createClient({
      request: async () => ({ status: 401, body: 'Access is denied' }),
      pauseMs: 0,
      breakerStore: memoryBreakerStore(),
      keyProvider: () => ({ key: 'bad', source: 'env:STEAM_API_KEY' }),
    });
    await assert.rejects(
      () => badKey.getOwnedGames('76561198000000001'),
      (err) => err.code === 'steam_key_invalid'
    );
  });

  test('GetOwnedGames URL carries include_appinfo/include_played_free_games and no pagination', async () => {
    const request = fakeRequest(() => ({ status: 200, body: JSON.stringify(ownedJson) }));
    const client = steam.createClient({
      request,
      pauseMs: 0,
      breakerStore: memoryBreakerStore(),
      keyProvider: () => ({ key: 'k', source: 'env:STEAM_API_KEY' }),
    });
    const owned = await client.getOwnedGames('76561198000000001');
    assert.equal(owned.games.length, 10);
    const url = request.calls[0].url;
    assert.match(url, /include_appinfo=true/);
    assert.match(url, /include_played_free_games=true/);
    assert.equal(/start=|page=/.test(url), false);
  });

  test('getAchievements: private stats are stats_private, empty game is stats_not_found', async () => {
    const privateXml =
      '<?xml version="1.0"?><playerstats><privacyState>private</privacyState></playerstats>';
    const privateClient = steam.createClient({
      request: async () => ({ status: 200, body: privateXml }),
      pauseMs: 0,
      breakerStore: memoryBreakerStore(),
    });
    await assert.rejects(
      () => privateClient.getAchievements('76561198000000001', 620),
      (err) => err.code === 'stats_private'
    );

    const notFound = steam.createClient({
      request: async () => ({ status: 404, body: '' }),
      pauseMs: 0,
      breakerStore: memoryBreakerStore(),
    });
    await assert.rejects(
      () => notFound.getAchievements('76561198000000001', 620),
      (err) => err.code === 'stats_not_found'
    );
  });

  test('httpGet follows redirects and reports a refused connection as steam_unreachable', async () => {
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
      const response = await steam.httpGet(`http://127.0.0.1:${port}/start`);
      assert.equal(response.status, 200);
      assert.equal(response.body, 'ok');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    await assert.rejects(
      () => steam.httpGet('http://127.0.0.1:1/', { timeoutMs: 2000 }),
      (err) => err.code === 'steam_unreachable'
    );
  });
  after(() => env.resetMutableState());
});


describe('games-sgdb', () => {
  /**
   * Optional SteamGridDB artwork provider. Key-gated: without a key it must be a
   * silent `skipped`, never a failure. No live request — `fetch` is injected.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const sgdb = require('../server/games/steamgriddb');
  const gameCache = require('../server/games/game-cache');
  const { createBudget } = require('../server/core/budget');

  function json(status, body) {
    const text = JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      async text() {
        return text;
      },
      async arrayBuffer() {
        return Buffer.from(text);
      },
    };
  }

  function recording(handler) {
    const calls = [];
    const impl = async (url) => {
      calls.push(String(url));
      return handler(String(url));
    };
    impl.calls = calls;
    return impl;
  }

  test('no key: provider is skipped without any request', async () => {
    const fetchImpl = recording(async () => json(500, {}));
    const result = await sgdb.resolveSteamGridDb(3669870, { key: null, fetch: fetchImpl });
    assert.equal(result.status, 'skipped');
    assert.equal(fetchImpl.calls.length, 0);
  });

  test('found: game id → vertical 600×900 grid URL', async () => {
    const fetchImpl = recording(async (url) => {
      if (url.includes('/games/steam/3669870')) return json(200, { success: true, data: { id: 4242 } });
      if (url.includes('/grids/game/4242')) {
        assert.match(url, /dimensions=600x900/);
        return json(200, {
          success: true,
          data: [
            { url: 'https://cdn2.steamgriddb.com/grid/horizontal.png', width: 920, height: 430 },
            { url: 'https://cdn2.steamgriddb.com/grid/vertical.png', width: 600, height: 900 },
          ],
        });
      }
      return json(404, {});
    });
    const result = await sgdb.resolveSteamGridDb(3669870, {
      key: 'test-key-not-real',
      fetch: fetchImpl,
      pauseMs: 0,
    });
    assert.deepEqual(result, {
      status: 'found',
      url: 'https://cdn2.steamgriddb.com/grid/vertical.png',
      source: 'steamgriddb',
    });
    assert.equal(fetchImpl.calls.length, 2);
  });

  test('no grid: a horizontal-only answer is «none», not a broken poster', async () => {
    const fetchImpl = recording(async (url) => {
      if (url.includes('/games/steam/')) return json(200, { success: true, data: { id: 7 } });
      return json(200, {
        success: true,
        data: [{ url: 'https://cdn2.steamgriddb.com/grid/horizontal.png', width: 920, height: 430 }],
      });
    });
    const result = await sgdb.resolveSteamGridDb(1, {
      key: 'k',
      fetch: fetchImpl,
      pauseMs: 0,
    });
    assert.equal(result.status, 'none');
    assert.equal(result.reason, 'no_grid');
  });

  test('a non-SteamGridDB host in the asset URL is rejected', async () => {
    const fetchImpl = recording(async (url) => {
      if (url.includes('/games/steam/')) return json(200, { success: true, data: { id: 7 } });
      return json(200, {
        success: true,
        data: [{ url: 'https://evil.example/grid.png', width: 600, height: 900 }],
      });
    });
    const result = await sgdb.resolveSteamGridDb(1, {
      key: 'k',
      fetch: fetchImpl,
      pauseMs: 0,
    });
    assert.equal(result.status, 'none');
    assert.equal(sgdb.allowedGridUrl('http://cdn2.steamgriddb.com/x.png'), false);
  });

  test('403 trips the persisted breaker; the next call is deferred without a request', async () => {
    gameCache.writeBreaker({});
    const fetchImpl = recording(async () => json(403, { success: false }));
    const first = await sgdb.resolveSteamGridDb(9, {
      key: 'k',
      fetch: fetchImpl,
      pauseMs: 0,
      retries: 0,
      sleep: async () => {},
    });
    assert.equal(first.status, 'deferred');
    assert.equal(first.reason, 'rate_limited');
    assert.ok(gameCache.readBreaker()[sgdb.BREAKER_KEY], 'the breaker is persisted');
    const callsBefore = fetchImpl.calls.length;
    const second = await sgdb.resolveSteamGridDb(10, {
      key: 'k',
      fetch: fetchImpl,
      pauseMs: 0,
    });
    assert.equal(second.status, 'deferred');
    assert.equal(second.reason, 'breaker');
    assert.equal(fetchImpl.calls.length, callsBefore, 'open breaker makes no request');
  });

  test('an exhausted per-run budget is «deferred», not «no art»', async () => {
    const fetchImpl = recording(async () => json(500, {}));
    const budget = createBudget(0);
    const result = await sgdb.resolveSteamGridDb(11, {
      key: 'k',
      fetch: fetchImpl,
      budget,
    });
    assert.equal(result.status, 'deferred');
    assert.equal(result.reason, 'budget');
    assert.equal(fetchImpl.calls.length, 0);
  });
  after(() => env.resetMutableState());
});


describe('games-normalize-split', () => {
  /**
   * Games split F3: the normalisers moved out of `public/js/games-view.js`.
   *
   * Three properties are pinned here:
   *
   *   1. every `public/js/games/**` module exports exactly the names the view
   *      imports (a stale re-export or a forgotten import fails loudly);
   *   2. `games-view.js` re-exports the moved functions by identity, so
   *      `games.js` / `games-modal.js` keep importing one implementation;
   *   3. the normalisers behave identically on the real `/stats` fixture and on
   *      every JSON fixture under `test/fixtures/games/**`, and stay tolerant on
   *      null / empty / unknown-enum input.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const { installDom } = require('./helpers/dom-shim');

  installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });

  const ROOT = path.join(__dirname, '..');
  const GAMES_FIXTURES = path.join(__dirname, 'fixtures', 'games');
  const UI_FIXTURES = path.join(__dirname, 'fixtures', 'games-ui');
  const JS_DIR = path.join(ROOT, 'public', 'js');

  const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);

  const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

  const SPLIT_EXPORTS = {
    'public/js/games/normalize/common.js': [
      'STEAM_REVIEW_SCALE', 'boolOrNull', 'hoursText', 'normalizeFranchiseRef', 'normalizeGenres',
      'normalizeHours', 'normalizeHours2w', 'normalizeTagsList', 'resolveReviewBucket',
      'reviewScaleEntry', 'toCount',
    ],
    'public/js/games/normalize/payload.js': ['normalizeGamesPayload'],
    'public/js/games/normalize/secondary.js': [
      'SECONDARY_SOURCE_LABELS', 'SECONDARY_SOURCE_ORDER', 'normalizeSecondaryWork',
      'normalizeSourceKey', 'secondaryChartStatus',
    ],
    'public/js/games/normalize/profile.js': ['normalizeCardPersonnel', 'normalizeProfile'],
    'public/js/games/normalize/buckets.js': [
      'normalizeAchievementDays', 'normalizeDecades', 'normalizeFranchises', 'normalizeHistogram',
      'normalizePersonnelTop', 'normalizeScores', 'normalizeStudios', 'normalizeTimeline',
      'normalizeUnknownYear', 'normalizeWeightItems', 'normalizeYears',
    ],
    'public/js/games/normalize/graph.js': [
      'normalizeGameIndexEntry', 'normalizeIndexAchievements', 'normalizePersonGames',
    ],
    'public/js/games/normalize/summary.js': [
      'MODE_DEFS', 'normalizeAccessBlock', 'normalizeAchievements', 'normalizeCompletion',
      'normalizeDlcSummary', 'normalizeExcluded', 'normalizeFilters', 'normalizeMetadata',
      'normalizeModes', 'normalizeReviewScoreBlock',
    ],
    'public/js/games/labels.js': [
      'GAME_PLURAL', 'SECONDARY_WORK_PLURAL', 'epochSeconds', 'formatDateRu', 'formatDateShortRu',
      'percentNumber', 'percentText', 'shortDayText',
    ],
    'public/js/games/sources.js': ['gogSourcesView', 'gogStatusText'],
    'public/js/games/secondary-card.js': ['asSecondaryWork', 'secondaryWorkCardView'],
    'public/js/games/import-flow.js': [
      'accountFromInput', 'gamesJobId', 'importErrorText', 'jobStageText', 'normalizeProfilesList',
    ],
  };

  const RE_EXPORTED = {
    'public/js/games/normalize/payload.js': ['normalizeGamesPayload'],
    'public/js/games/normalize/common.js': ['STEAM_REVIEW_SCALE', 'hoursText', 'resolveReviewBucket'],
    'public/js/games/normalize/secondary.js': ['normalizeSecondaryWork', 'secondaryChartStatus'],
    'public/js/games/normalize/summary.js': ['MODE_DEFS'],
    'public/js/games/labels.js': ['formatDateRu', 'formatDateShortRu', 'percentNumber', 'percentText'],
    'public/js/games/sources.js': ['gogSourcesView', 'gogStatusText'],
    'public/js/games/secondary-card.js': ['secondaryWorkCardView'],
    'public/js/games/import-flow.js': [
      'accountFromInput', 'gamesJobId', 'importErrorText', 'jobStageText', 'normalizeProfilesList',
    ],
  };

  const MOVED_DEFINITIONS = [
    'normalizeGamesPayload', 'normalizeSecondaryWork', 'normalizeCardPersonnel',
    'normalizeScores', 'normalizeStudios', 'normalizePersonGames', 'normalizeReviewScoreBlock',
    'secondaryChartStatus', 'percentText', 'formatDateRu', 'gogSourcesView', 'accountFromInput',
  ];

  const OWN_SCAN_DIRS = [
    path.join(JS_DIR, 'games'),
  ];
  const OWN_SCAN_FILES = [path.join(JS_DIR, 'games-view.js')];

  function jsFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...jsFiles(full));
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  function jsonFixtures(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...jsonFixtures(full));
      else if (entry.name.endsWith('.json')) out.push(full);
    }
    return out.sort();
  }

  test('the split modules export exactly the names the view imports', async () => {
    for (const [relative, expected] of Object.entries(SPLIT_EXPORTS)) {
      const mod = await load(relative);
      assert.deepEqual(Object.keys(mod).sort(), [...expected].sort(), `${relative} export list`);
    }
  });

  test('games-view.js re-exports the split functions by identity', async () => {
    const view = await load('public/js/games-view.js');
    for (const [relative, names] of Object.entries(RE_EXPORTED)) {
      const mod = await load(relative);
      for (const name of names) {
        assert.ok(name in mod, `${relative} has no ${name}`);
        assert.equal(view[name], mod[name], `games-view.js ${name} is not the ${relative} one`);
      }
    }
  });

  test('every moved normaliser is defined once under public/js/games', () => {
    const files = [...OWN_SCAN_DIRS.flatMap(jsFiles), ...OWN_SCAN_FILES];
    const sources = files.map((file) => ({ file, src: fs.readFileSync(file, 'utf8') }));
    const duplicated = [];
    for (const name of MOVED_DEFINITIONS) {
      const pattern = new RegExp(`function ${name}\\s*\\(`);
      const sites = sources
        .filter(({ src }) => pattern.test(src))
        .map(({ file }) => path.relative(ROOT, file));
      if (sites.length !== 1) duplicated.push(`${name}: ${sites.length ? sites.join(', ') : 'nowhere'}`);
    }
    assert.deepEqual(duplicated, [], `definition counts: ${duplicated.join('; ')}`);
  });

  test('normalizeGamesPayload is deep-equal on the real /stats fixture', async () => {
    const { normalizeGamesPayload } = await load('public/js/games/normalize/payload.js');
    const reExported = (await load('public/js/games-view.js')).normalizeGamesPayload;
    const raw = readJson(path.join(UI_FIXTURES, 'stats-m2-mock.json'));

    const fromModule = normalizeGamesPayload(raw);
    assert.deepEqual(fromModule, reExported(raw));
    assert.equal(fromModule.summary.gameCount, 340);
    assert.equal(fromModule.summary.totalHours, 5862.6);
    assert.equal(fromModule.profile.personaName, 'whitefiercewolf');
    assert.ok(Object.keys(fromModule.gamesIndex).length > 0, 'gamesIndex is empty on the real fixture');
    assert.equal(fromModule.decades.length, 5);
  });

  test('normalisation matches on every JSON fixture from test/fixtures/games/**', async () => {
    const { normalizeGamesPayload } = await load('public/js/games/normalize/payload.js');
    const reExported = (await load('public/js/games-view.js')).normalizeGamesPayload;
    const files = jsonFixtures(GAMES_FIXTURES);
    assert.ok(files.length >= 10, `found only ${files.length} fixtures`);

    for (const file of files) {
      const raw = readJson(file);
      const relative = path.relative(GAMES_FIXTURES, file);
      assert.deepEqual(
        normalizeGamesPayload(raw),
        reExported(raw),
        `normalizeGamesPayload differs on ${relative}`,
      );
    }
  });

  test('edge cases stay tolerant and identical: null, {}, missing keys, unknown enum', async () => {
    const payload = await load('public/js/games/normalize/payload.js');
    const view = await load('public/js/games-view.js');

    const empty = payload.normalizeGamesPayload(null);
    assert.deepEqual(empty, view.normalizeGamesPayload(null));
    assert.deepEqual(empty.gamesIndex, {});
    assert.deepEqual(empty.secondaryWorks, []);
    assert.equal(empty.summary.gameCount, 0);
    assert.equal(empty.summary.totalHours, null);
    assert.equal(empty.profile, null);

    const emptyObject = payload.normalizeGamesPayload({});
    assert.deepEqual(emptyObject, view.normalizeGamesPayload({}));
    assert.deepEqual(emptyObject, empty);

    const missingKeys = { summary: { gameCount: '340' }, sources: { profile: {} } };
    assert.deepEqual(payload.normalizeGamesPayload(missingKeys), view.normalizeGamesPayload(missingKeys));
    assert.equal(payload.normalizeGamesPayload(missingKeys).summary.gameCount, 340);
    assert.equal(payload.normalizeGamesPayload(missingKeys).profile, null);

    const unknownEnum = { scores: { buckets: [{ bucket: 'nonsense', count: 3 }] } };
    assert.deepEqual(payload.normalizeGamesPayload(unknownEnum), view.normalizeGamesPayload(unknownEnum));

    const { resolveReviewBucket } = await load('public/js/games/normalize/common.js');
    assert.equal(resolveReviewBucket('что-то своё'), null);
    assert.equal(resolveReviewBucket('Overwhelmingly Positive'), 9);
    assert.equal(view.resolveReviewBucket('что-то своё'), resolveReviewBucket('что-то своё'));

    const { normalizePersonnelRole } = view;
    assert.equal(normalizePersonnelRole('showrunner'), '');
    assert.equal(normalizePersonnelRole('shoe designer'), '');
    assert.equal(normalizePersonnelRole('studio'), 'developer');
  });
  after(() => env.resetMutableState());
});


describe('games-minhours', () => {
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
  after(() => env.resetMutableState());
});


describe('games-recent-played', () => {
  /**
   * `GetRecentlyPlayedGames` (03.11.2026) and the `recentlyPlayed` fallback.
   *
   * The diagnosed owner (steam-76561198203871831) has a complete 226-game
   * library whose every row says `rtime_last_played: 0`, while Steam still knows
   * six games of the last two weeks. The import now merges that window into the
   * snapshot (merge-only, non-fatal), and `stats/top.js` lets a work with 2-week
   * hours but no launch date into the strip with `lastPlayed: null` — no date is
   * ever invented.
   *
   * Everything is offline: the Steam client is the fixture-backed fake, the
   * cache roots point at /tmp.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;
  process.env.KINOBOXD_GAMES_WD = 'off';

  const steam = require('../server/games/steam');
  const gameCache = require('../server/games/game-cache');
  const importJobs = require('../server/games/import');
  const { buildGamesStatsFromCache } = require('../server/games/stats');
  const { createFakeClient, readFixture } = require('./fixtures/games/fake-client');

  const ID = '76561198000000001';
  const PROFILE_KEY = `steam-${ID}`;

  function recentWindow(name) {
    return steam.parseRecentlyPlayedResponse(JSON.parse(readFixture(name)));
  }

  async function seedLibrary(steamId64, games) {
    const totalMinutes = games.reduce(
      (sum, game) => sum + (Number(game.playtime_forever) || 0),
      0
    );
    await gameCache.saveProfile({
      userKey: steamId64,
      personaName: 'tester',
      avatarUrl: 'https://example.test/avatar.jpg',
      privacy: 'public',
      importedAt: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    });
    await gameCache.saveLibrary(steamId64, {
      fetchedAt: new Date().toISOString(),
      partial: false,
      source: 'steam-webapi',
      game_count: games.length,
      games,
      totalMinutes,
      fingerprint: steam.libraryFingerprint(games, games.length),
    });
  }

  test('a full import merges GetRecentlyPlayedGames into the library snapshot', async () => {
    const client = createFakeClient({ recent: recentWindow('recently-played-populated.json') });
    const job = importJobs.startImport(ID, { client, force: true });
    await importJobs.whenIdle();
    const status = importJobs.getStatus(job.jobId);
    assert.equal(status.status, 'done');
    assert.equal(status.code, null);
    assert.deepEqual(status.warnings, []);
    // The foreign appid of the window is ignored (merge-only): 2 of 3 rows hit.
    assert.equal(status.recentPlayedCount, 2);
    assert.ok(status.recentPlayedFetchedAt);

    const library = gameCache.getLibrary(ID);
    assert.ok(library.recentPlayedFetchedAt);
    const cyberpunk = library.games.find((game) => game.appid === 1091500);
    // RGP `rtime_last_played: 0` = "not exposed", so the known launch survives.
    assert.equal(cyberpunk.rtime_last_played, 1793295251);
    assert.equal(cyberpunk.playtime_2weeks, 108);
    assert.equal(cyberpunk.playtime_forever, 120, 'the fresher total wins');
    const portal = library.games.find((game) => game.appid === 620);
    assert.equal(portal.rtime_last_played, 1795000000);
    assert.equal(portal.playtime_2weeks, 60);
    assert.equal(portal.playtime_forever, 1204, 'a staler total never shrinks a row');
    assert.equal(library.games.some((game) => game.appid === 999999), false);
    // Totals/fingerprint describe the rows that were actually stored.
    assert.equal(library.totalMinutes, 36973 + 12);
    assert.equal(status.totalMinutes, 36973 + 12);
    assert.equal(library.fingerprint, steam.libraryFingerprint(library.games, 10));
  });

  test('an RGP failure is a warning: the import stays done with the plain library', async () => {
    const client = createFakeClient({
      fail: {
        recent: new steam.SteamError('Steam Web API ответил 500', 'steam_http_error'),
      },
    });
    const job = importJobs.startImport(ID, { client, force: true });
    await importJobs.whenIdle();
    const status = importJobs.getStatus(job.jobId);
    assert.equal(status.status, 'done');
    assert.equal(status.code, null);
    assert.deepEqual(status.warnings, ['recent_played_steam_http_error']);
    assert.equal(status.recentPlayedFetchedAt, null);
    assert.equal(status.recentPlayedCount, null);

    const library = gameCache.getLibrary(ID);
    assert.equal(library.recentPlayedFetchedAt, null);
    assert.equal(library.totalMinutes, 36973);
    assert.equal(library.games.find((game) => game.appid === 1091500).playtime_forever, 108);
  });

  test('a partial (no key) library never asks for the recently-played window', async () => {
    const client = createFakeClient({ key: null });
    const job = importJobs.startImport(ID, { client, force: true });
    await importJobs.whenIdle();
    const status = importJobs.getStatus(job.jobId);
    assert.equal(status.libraryPartial, true);
    assert.deepEqual(client.calls, ['profile']);
    assert.equal(status.recentPlayedFetchedAt, null);
    assert.equal(status.recentPlayedCount, null);
  });

  test('mergeRecentlyPlayed: merge-only, 0 rtime is unknown, totals never regress', () => {
    const games = [
      { appid: 1, playtime_forever: 10, playtime_2weeks: null, rtime_last_played: 1700 },
    ];
    const merged = importJobs.mergeRecentlyPlayed(games, {
      games: [
        { appid: 1, playtime_forever: 5, playtime_2weeks: 30, rtime_last_played: 0 },
        { appid: 2, playtime_forever: 1, playtime_2weeks: 1, rtime_last_played: 1 },
      ],
    });
    assert.equal(merged, 1, 'only the owned appid counts');
    assert.equal(games.length, 1, 'no row is invented');
    assert.equal(games[0].playtime_forever, 10);
    assert.equal(games[0].playtime_2weeks, 30);
    assert.equal(games[0].rtime_last_played, 1700);
    assert.equal(importJobs.mergeRecentlyPlayed(games, { games: [] }), 0);
    assert.equal(importJobs.mergeRecentlyPlayed(games, null), 0);
  });

  test('recentlyPlayed: works without a launch date join on 2-week hours, sorted', async () => {
    // The diagnosed profile shape: every rtime=0, activity only in the window.
    const owned = steam.parseOwnedGamesResponse(JSON.parse(readFixture('owned-games.json')));
    const active = { 1091500: 1493, 620: 71, 70: 18 };
    const games = owned.games.map((game) => ({
      ...game,
      rtime_last_played: 0,
      playtime_2weeks: active[game.appid] || null,
    }));
    const id64 = '76561198000000011';
    await seedLibrary(id64, games);

    const stats = buildGamesStatsFromCache(`steam-${id64}`);
    assert.deepEqual(
      stats.recentlyPlayed.map((row) => row.appid),
      [1091500, 620, 70],
      'sorted by two-week minutes desc when no launch date exists'
    );
    assert.equal(stats.recentlyPlayed[0].hours2w, 24.9);
    assert.equal(stats.recentlyPlayed[0].hoursTotal, 1.8);
    for (const row of stats.recentlyPlayed) {
      assert.equal(row.lastPlayed, null, 'no invented date');
    }
    assert.equal(stats.summary.lastPlayedAt, null);
  });

  test('recentlyPlayed: rtime desc first, then two-week minutes; lastPlayed stays null for rtime=0', async () => {
    const owned = steam.parseOwnedGamesResponse(JSON.parse(readFixture('owned-games.json')));
    const patch = {
      1091500: { rtime_last_played: 0, playtime_2weeks: 1493 },
      620: { rtime_last_played: 0, playtime_2weeks: 71 },
      220: { rtime_last_played: 1715018956, playtime_2weeks: 600 },
      570: { rtime_last_played: 1793295251, playtime_2weeks: null },
    };
    const games = owned.games.map((game) => ({
      ...game,
      rtime_last_played: 0,
      playtime_2weeks: null,
      ...(patch[game.appid] || {}),
    }));
    const id64 = '76561198000000012';
    await seedLibrary(id64, games);

    const stats = buildGamesStatsFromCache(`steam-${id64}`);
    assert.deepEqual(
      stats.recentlyPlayed.map((row) => row.appid),
      [570, 220, 1091500, 620],
      'launch dates come first (newest first), the 2-week-only rows after them'
    );
    assert.equal(stats.recentlyPlayed[0].lastPlayed, '2026-10-29T17:34:11.000Z');
    assert.equal(stats.recentlyPlayed[1].lastPlayed, '2024-05-06T18:09:16.000Z');
    assert.equal(stats.recentlyPlayed[2].lastPlayed, null);
    assert.equal(stats.recentlyPlayed[2].hours2w, 24.9);
    assert.equal(stats.recentlyPlayed[3].lastPlayed, null);
    // The archived 2-week strip is untouched by the fallback.
    assert.deepEqual(
      stats.recently2w.map((row) => row.appid),
      [1091500, 220, 620]
    );
  });
  after(() => env.resetMutableState());
});


describe('games-reviews', () => {
  /**
   * Steam review summary (M4): the `IUserReviewsService/GetAppReviews` envelope,
   * the cheapest request shape (`num_per_page: 1`, no review bodies), the 1.7 s
   * pause and a breaker that is separate from the store appdetails host.
   *
   * Live context (01.11.2026): the old `store.steampowered.com/appreviews/<id>`
   * feed was retired on 22.10.2026 and answers `302 -> /`; the Web API method
   * below needs no key and returns the same `query_summary`.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const store = require('../server/games/store');
  const gameCache = require('../server/games/game-cache');
  const { readFixture } = require('./fixtures/games/fake-client');

  function fixture(appid) {
    return JSON.parse(readFixture(`reviews-${appid}.json`));
  }

  test('parseAppReviews: real Witcher 3 summary → score 9, desc, counts', () => {
    const doc = store.parseAppReviews(fixture(292030), 292030);
    assert.equal(doc.appid, 292030);
    assert.equal(doc.success, true);
    assert.equal(doc.score, 9);
    assert.equal(doc.desc, 'Overwhelmingly Positive');
    assert.ok(doc.positive > 800000);
    assert.ok(doc.negative > 30000);
    assert.ok(doc.total > 900000);
    assert.equal(doc.metadataSource, 'steam-reviews');
  });

  test('parseAppReviews: Portal 2 and Dota 2 keep their own levels', () => {
    const portal = store.parseAppReviews(fixture(620), 620);
    assert.equal(portal.score, 9);
    const dota = store.parseAppReviews(fixture(570), 570);
    assert.equal(dota.score, 8);
    assert.equal(dota.desc, 'Very Positive');
  });

  test('parseAppReviews: a response without query_summary is an honest "no reviews"', () => {
    const doc = store.parseAppReviews({ response: { reviews: [], cursor: '*' } }, 99999999);
    assert.equal(doc.success, false);
    assert.equal(doc.unavailable, true);
    assert.equal(doc.reason, 'no_summary');
    assert.equal(doc.score, null);
    assert.equal(doc.total, 0);
  });

  test('parseAppReviews: out-of-range scores are dropped, not clamped', () => {
    const doc = store.parseAppReviews(
      { response: { query_summary: { review_score: 12, review_score_desc: 'Nope', total_positive: 1 } } },
      1
    );
    assert.equal(doc.success, true);
    assert.equal(doc.score, null);
    assert.equal(doc.positive, 1);
  });

  test('reviewsUrl: the Web API method with one JSON blob, cheapest shape', () => {
    const url = new URL(store.reviewsUrl(292030));
    assert.equal(url.host, 'api.steampowered.com');
    assert.equal(url.pathname, '/IUserReviewsService/GetAppReviews/v1/');
    const input = JSON.parse(url.searchParams.get('input_json'));
    assert.deepEqual(input, {
      appid: 292030,
      filter: 1,
      languages: ['all'],
      purchase_type: 1,
      num_per_page: 1,
      cursor: '*',
      filter_offtopic_activity: false,
    });
  });

  test('createClient: 1.7 s pause between review requests, one request per appid', async () => {
    const calls = [];
    const waits = [];
    let clock = 0;
    const client = store.createClient({
      request: async (url) => {
        calls.push(url);
        return { status: 200, headers: {}, body: readFixture('reviews-292030.json') };
      },
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    const first = await client.getAppReviews(292030);
    const second = await client.getAppReviews(620);
    assert.equal(first.score, 9);
    assert.equal(second.score, 9);
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [1700]);
  });

  test('createClient: 429 trips the reviews breaker only, not the store appdetails one', async () => {
    gameCache.writeBreaker({});
    let calls = 0;
    const client = store.createClient({
      request: async () => {
        calls++;
        return { status: 429, headers: {}, body: '' };
      },
      sleep: async () => {},
      reviewsPauseMs: 0,
      pauseMs: 0,
    });
    await assert.rejects(() => client.getAppReviews(292030), (err) => {
      assert.equal(err.code, 'reviews_rate_limited');
      assert.ok(err.retryAt);
      return true;
    });
    assert.equal(calls, 1);
    const breaker = gameCache.readBreaker();
    assert.ok(breaker[store.REVIEWS_BREAKER_KEY]);
    assert.equal(breaker['api.steampowered.com'], undefined);
    assert.equal(breaker['store.steampowered.com'], undefined);
    // appdetails is not blocked by a reviews 429 (different host, different key).
    assert.equal(client.breakerEntry(), null);
    // A second review call is refused without a request.
    await assert.rejects(() => client.getAppReviews(620), (err) => {
      assert.equal(err.code, 'reviews_rate_limited');
      return true;
    });
    assert.equal(calls, 1);
  });

  test('createClient: network/5xx/non-JSON are deferred, never cached, no breaker', async () => {
    gameCache.writeBreaker({});
    const cases = [
      {
        response: async () => {
          throw Object.assign(new Error('tls'), { code: 'ECONNRESET' });
        },
        expected: 'reviews_unreachable',
      },
      { response: async () => ({ status: 500, headers: {}, body: '' }), expected: 'reviews_http_error' },
      { response: async () => ({ status: 200, headers: {}, body: '<html>302</html>' }), expected: 'reviews_http_error' },
    ];
    for (const entry of cases) {
      const client = store.createClient({
        request: entry.response,
        sleep: async () => {},
        reviewsPauseMs: 0,
      });
      await assert.rejects(() => client.getAppReviews(292030), (err) => {
        assert.equal(err.code, entry.expected);
        return true;
      });
      assert.equal(client.reviewsBreakerEntry(), null);
    }
    assert.equal(gameCache.getReviews(292030), null);
  });

  test('reviewsFresh honours the TTL and a missing fetchedAt is stale', () => {
    const now = Date.now();
    assert.equal(store.reviewsFresh({ fetchedAt: new Date(now).toISOString() }, 1000), true);
    assert.equal(
      store.reviewsFresh(
        { fetchedAt: new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString() },
        undefined
      ),
      false
    );
    assert.equal(store.reviewsFresh({}, 1000), false);
  });
  after(() => env.resetMutableState());
});


describe('games-spy', () => {
  /**
   * SteamSpy client (M4): tags parser, the "unknown app" skeleton, the 1.1 s
   * politeness pause, the persisted 30-minute breaker and deferred (never
   * negative-cached) network/5xx failures. No network: `request` is injected.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const spy = require('../server/games/spy');
  const gameCache = require('../server/games/game-cache');
  const { readFixture } = require('./fixtures/games/fake-client');

  function fixture(appid) {
    return JSON.parse(readFixture(`spy-${appid}.json`));
  }

  test('parseSpyDetails: real Portal 2 fragment → weighted tags sorted heaviest first', () => {
    const doc = spy.parseSpyDetails(fixture(620), 620);
    assert.equal(doc.appid, 620);
    assert.equal(doc.success, true);
    assert.equal(doc.unavailable, false);
    assert.equal(doc.name, 'Portal 2');
    assert.equal(doc.developer, 'Valve');
    assert.equal(doc.publisher, 'Valve');
    assert.equal(doc.positive, 427835);
    assert.equal(doc.negative, 5675);
    assert.equal(doc.owners, '5,000,000 .. 10,000,000');
    assert.equal(doc.ccu, 1959);
    assert.equal(doc.metadataSource, 'steamspy');
    assert.ok(doc.tags.length >= 15);
    // Sorted by weight, not by the object's insertion order.
    for (let index = 1; index < doc.tags.length; index++) {
      assert.ok(doc.tags[index - 1].weight >= doc.tags[index].weight);
    }
    assert.deepEqual(doc.tags[0], { name: 'Platformer', weight: 7477 });
    const names = doc.tags.map((tag) => tag.name);
    assert.ok(names.includes('Puzzle'));
    assert.ok(names.includes('Story Rich'));
  });

  test('parseSpyDetails: the live "unknown app" skeleton is an answer, not metadata', () => {
    const doc = spy.parseSpyDetails(fixture('unknown'), 99999999);
    assert.equal(doc.success, false);
    assert.equal(doc.unavailable, true);
    assert.equal(doc.reason, 'no_data');
    assert.deepEqual(doc.tags, []);
    assert.equal(doc.name, null);
  });

  test('parseTags: drops empty/zero/non-numeric weights, caps the list', () => {
    const tags = spy.parseTags({
      RPG: 100,
      Broken: 'nope',
      Zero: 0,
      Negative: -5,
      '': 50,
      ' Open World ': 90,
    });
    assert.deepEqual(tags, [
      { name: 'RPG', weight: 100 },
      { name: 'Open World', weight: 90 },
    ]);
    const many = {};
    for (let index = 0; index < 80; index++) many[`Tag ${index}`] = 1000 - index;
    assert.equal(spy.parseTags(many).length, spy.MAX_TAGS);
    assert.deepEqual(spy.parseTags(null), []);
    assert.deepEqual(spy.parseTags([]), []);
  });

  test('spyFresh honours the TTL and a missing fetchedAt is stale', () => {
    const now = Date.now();
    assert.equal(spy.spyFresh({ fetchedAt: new Date(now).toISOString() }, 1000), true);
    assert.equal(
      spy.spyFresh({ fetchedAt: new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString() }, undefined),
      false
    );
    assert.equal(spy.spyFresh({}, 1000), false);
    assert.equal(spy.spyFresh(null, 1000), false);
  });

  test('createClient: one request per appid, 1.1 s pause, clean parse', async () => {
    const calls = [];
    const waits = [];
    let clock = 0;
    const client = spy.createClient({
      request: async (url) => {
        calls.push(url);
        return { status: 200, headers: {}, body: readFixture('spy-292030.json') };
      },
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    const first = await client.getAppTags(292030);
    const second = await client.getAppTags(292030);
    assert.equal(first.success, true);
    assert.equal(second.success, true);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /^https:\/\/steamspy\.com\/api\.php\?request=appdetails&appid=292030$/);
    // The second request waits the remainder of the 1100 ms window.
    assert.deepEqual(waits, [1100]);
  });

  test('createClient: 429 trips a persisted 30-minute breaker for steamspy.com only', async () => {
    let calls = 0;
    const client = spy.createClient({
      request: async () => {
        calls++;
        return { status: 429, headers: {}, body: '' };
      },
      sleep: async () => {},
      pauseMs: 0,
    });
    await assert.rejects(() => client.getAppTags(620), (err) => {
      assert.equal(err.code, 'spy_rate_limited');
      assert.ok(err.retryAt);
      return true;
    });
    assert.equal(calls, 1);
    const breaker = gameCache.readBreaker();
    assert.ok(breaker['steamspy.com']);
    assert.ok(breaker['steamspy.com'].until > Date.now());
    assert.equal(breaker['store.steampowered.com'], undefined);

    // A second call is refused without touching the network.
    await assert.rejects(() => client.getAppTags(570), (err) => {
      assert.equal(err.code, 'spy_rate_limited');
      return true;
    });
    assert.equal(calls, 1);
  });

  test('createClient: network/5xx/non-JSON are deferred and never trip the breaker', async () => {
    // The 429 test above persisted a breaker; start from a clean state.
    gameCache.writeBreaker({});
    const cases = [
      {
        response: async () => {
          throw Object.assign(new Error('dns'), { code: 'ENOTFOUND' });
        },
        expected: 'spy_unreachable',
      },
      { response: async () => ({ status: 503, headers: {}, body: '' }), expected: 'spy_http_error' },
      { response: async () => ({ status: 200, headers: {}, body: '<html>blocked</html>' }), expected: 'spy_http_error' },
    ];
    for (const entry of cases) {
      const client = spy.createClient({ request: entry.response, sleep: async () => {}, pauseMs: 0 });
      await assert.rejects(() => client.getAppTags(620), (err) => {
        assert.equal(err.code, entry.expected);
        return true;
      });
      assert.equal(client.breakerEntry(), null);
    }
    // Nothing was written to the cache by any of those failures.
    assert.equal(gameCache.getSpy(620), null);
  });

  test('createClient: an invalid appid is rejected before any request', async () => {
    let calls = 0;
    const client = spy.createClient({
      request: async () => {
        calls++;
        return { status: 200, headers: {}, body: '{}' };
      },
    });
    await assert.rejects(() => client.getAppTags('nope'), (err) => {
      assert.equal(err.code, 'spy_invalid_appid');
      return true;
    });
    assert.equal(calls, 0);
  });
  after(() => env.resetMutableState());
});


describe('games-gog-stats', () => {
  /**
   * `/api/games/stats` with a GOG secondary library (M6a): per-source hours are
   * separate (never summed), the union counts one work once, secondary-only games
   * are counted but stay out of the Steam journal.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const CACHE_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const gameCache = require('../server/games/game-cache');
  const gogCache = require('../server/games/gog-cache');
  const { buildGamesStatsFromCache } = require('../server/games/stats');

  const ID = '76561198000000001';
  const ID2 = '76561198000000002';
  const PROFILE_KEY = `steam-${ID}`;
  const GOG_KEY = '1234567890';

  function steamLibrary(games) {
    const totalMinutes = games.reduce((sum, game) => sum + game.playtime_forever, 0);
    return {
      fetchedAt: new Date().toISOString(),
      partial: false,
      source: 'steam-webapi',
      game_count: games.length,
      games,
      totalMinutes,
      fingerprint: games.map((game) => game.appid).join(','),
    };
  }

  const STEAM_GAMES = [
    {
      appid: 292030,
      name: 'The Witcher 3: Wild Hunt',
      playtime_forever: 6000,
      playtime_2weeks: 0,
      rtime_last_played: 1793295251,
      img_icon_url: null,
    },
    {
      appid: 1091500,
      name: 'Cyberpunk 2077',
      playtime_forever: 3000,
      playtime_2weeks: 0,
      rtime_last_played: 0,
      img_icon_url: null,
    },
  ];

  const GOG_PRODUCTS = [
    {
      gogGameId: '1207658924',
      title: 'The Witcher 3: Wild Hunt - Game of the Year Edition',
      slug: 'the_witcher_3_wild_hunt',
      image: null,
      category: 'game',
      isGame: true,
      isMovie: false,
      releaseDate: '2015-05-18T00:00:00+0000',
    },
    {
      gogGameId: '1423049311',
      title: 'Cyberpunk 2077: Ultimate Edition',
      slug: 'cyberpunk_2077_ultimate_edition',
      image: null,
      category: 'game',
      isGame: true,
      isMovie: false,
      releaseDate: '2023-09-26T00:00:00+0000',
    },
    {
      gogGameId: '1999999999',
      title: 'GOG Exclusive Indie',
      slug: 'gog_exclusive_indie',
      image: null,
      category: 'game',
      isGame: true,
      isMovie: false,
      releaseDate: '2020-01-01T00:00:00+0000',
    },
  ];

  async function seedOwner(userKey) {
    await gameCache.saveProfile({
      userKey,
      personaName: 'tester',
      ownerLabel: 'Me',
      importedAt: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    });
    await gameCache.saveLibrary(userKey, steamLibrary(STEAM_GAMES));
  }

  test('GOG stats', async (t) => {
    await seedOwner(ID);
    await seedOwner(ID2);
    const nowIso = new Date().toISOString();
    gogCache.saveToken(GOG_KEY, {
      accessToken: 'secret-access',
      refreshToken: 'secret-refresh',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      username: 'gog_tester',
      ownerProfile: PROFILE_KEY,
      connectedAt: nowIso,
    });
    gogCache.saveProfile({ userKey: GOG_KEY, username: 'gog_tester', ownerProfile: PROFILE_KEY });
    gogCache.saveLibrary(GOG_KEY, {
      fetchedAt: nowIso,
      ownerProfile: PROFILE_KEY,
      products: GOG_PRODUCTS,
      fingerprint: GOG_PRODUCTS.map((product) => product.gogGameId).join(','),
      account: { username: 'gog_tester' },
    });
    gogCache.savePlaytime(GOG_KEY, {
      fetchedAt: nowIso,
      ownerProfile: PROFILE_KEY,
      minutes: { 1207658924: 1200, 1423049311: 600, 1999999999: 90 },
      fetchedGames: 3,
      budgetExceeded: false,
    });

    await t.test('totalHours is the display sum; hoursBySource.steam stays the journal', () => {
      const payload = buildGamesStatsFromCache(PROFILE_KEY);
      // M6c: the headline number is Steam + GOG + Epic of the same works …
      assert.equal(payload.summary.totalHours, 181.5);
      // … while the Steam journal number and the per-source breakdown stay.
      assert.equal(payload.summary.totalHoursSteam, 150);
      assert.deepEqual(payload.summary.hoursBySource, { steam: 150, gog: 31.5, epic: null, all: 181.5 });
      assert.deepEqual(payload.summary.ownedBySource, { steam: 2, gog: 3, epic: null });
      assert.equal(payload.summary.worksTotal, 3);
      assert.equal(payload.summary.secondaryOnlyWorks, 1);
      assert.equal(payload.gog.status, 'ok');
      assert.equal(payload.gog.gogProducts, 3);
      assert.equal(payload.gog.gogHours, 31.5);
    });

    await t.test('gamesIndex carries sources/storeIds/hoursBySource (hours)', () => {
      const payload = buildGamesStatsFromCache(PROFILE_KEY);
      const witcher = payload.gamesIndex['292030'];
      assert.deepEqual(witcher.sources, ['steam', 'gog']);
      assert.deepEqual(witcher.storeIds, { steam: 292030, gog: '1207658924', epic: null });
      // Integration contract: payload hours, not minutes (100 h + 20 h).
      assert.deepEqual(witcher.hoursBySource, { steam: 100, gog: 20, epic: null });
      assert.deepEqual(witcher.ownedOn, ['steam', 'gog']);
      const cyberpunk = payload.gamesIndex['1091500'];
      assert.deepEqual(cyberpunk.sources, ['steam', 'gog']);
      assert.equal(cyberpunk.storeIds.gog, '1423049311');
    });

    await t.test('a secondary-only work is counted and ranked, not hidden', () => {
      const payload = buildGamesStatsFromCache(PROFILE_KEY);
      assert.equal(payload.secondaryWorks.length, 1);
      assert.equal(payload.secondaryWorks[0].workKey, 'gog:1999999999');
      assert.equal(payload.secondaryWorks[0].hoursBySource.gog, 1.5);
      assert.equal(payload.secondaryWorks[0].hoursBySource.steam, null);
      // M6c: it is a real owned game — one more row in the library, its hours in
      // the totals, its name in the top list.
      assert.equal(payload.summary.gameCount, 3);
      assert.equal(payload.summary.secondaryOnlyWorks, 1);
      const row = payload.topGames.find((entry) => entry.name === 'GOG Exclusive Indie');
      assert.ok(row);
      assert.equal(row.appid, null);
      assert.deepEqual(row.sources, ['gog']);
      assert.equal(row.hours, 1.5);
    });

    await t.test('sources block exposes GOG state without a token', () => {
      const payload = buildGamesStatsFromCache(PROFILE_KEY);
      assert.equal(payload.sources.gog.connected, true);
      assert.equal(payload.sources.gog.userKey, GOG_KEY);
      assert.equal(payload.sources.gog.username, 'gog_tester');
      assert.equal(payload.sources.gog.status, 'ok');
      const serialized = JSON.stringify(payload.sources);
      assert.equal(serialized.includes('secret-access'), false);
      assert.equal(serialized.includes('secret-refresh'), false);
      assert.equal(payload.sources.steam.status, 'ok');
    });

    await t.test('a disconnected account keeps its dated snapshot (snapshot_only)', () => {
      gogCache.deleteToken(GOG_KEY);
      const payload = buildGamesStatsFromCache(PROFILE_KEY);
      assert.equal(payload.sources.gog.connected, false);
      assert.equal(payload.sources.gog.status, 'snapshot_only');
      assert.equal(payload.summary.hoursBySource.gog, 31.5);
      assert.equal(payload.summary.ownedBySource.gog, 3);
      assert.equal(payload.gamesIndex['292030'].storeIds.gog, '1207658924');
    });

    await t.test('a Steam-only profile has no cross-store fields at all', () => {
      const payload = buildGamesStatsFromCache(`steam-${ID2}`);
      assert.deepEqual(payload.summary.hoursBySource, { steam: 150, gog: null, epic: null });
      assert.deepEqual(payload.summary.ownedBySource, { steam: 2, gog: null, epic: null });
      assert.equal(payload.summary.secondaryOnlyWorks, 0);
      assert.equal(payload.summary.worksTotal, payload.summary.gameCount);
      assert.equal(payload.sources.gog.status, 'not_connected');
      assert.equal(payload.secondaryWorks.length, 0);
      assert.equal(Object.prototype.hasOwnProperty.call(payload.gamesIndex['292030'], 'sources'), false);
    });
  });
  after(() => env.resetMutableState());
});


describe('games-gog-playtime', () => {
  /**
   * GOG playtime (M6c): the 01.11.2026 «0.00 ч при часах в профиле» bug.
   *
   * What is pinned here:
   *   - the `{uid}` of `gameplay.gog.com/games/{id}/users/{uid}/sessions` is the
   *     **Galaxy** id (OAuth `user_id`, then `userData.json.galaxyUserId`), never
   *     `userData.json.userId` — that field was the production bug;
   *   - `time_sum` is minutes; a session list is summed, a 200 without any
   *     recognizable field is **not** a zero;
   *   - a 404 is a real zero but is re-checked on a later import instead of being
   *     frozen forever;
   *   - the first three raw answers of a run are dumped for the user.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const CACHE_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const gameCache = require('../server/games/game-cache');
  const gogCache = require('../server/games/gog-cache');
  const gogImport = require('../server/games/gog-import');
  const gog = require('../server/games/gog');

  const STEAM_ID = '76561198000000011';
  const OWNER = `steam-${STEAM_ID}`;
  const USER_KEY = '1234567890';
  const GALAXY_ID = '5555555555';

  const PRODUCTS = [
    { gogGameId: '1207658924', title: 'Majesty 2 Collection', slug: 'majesty_2', category: 'game', isGame: true },
    { gogGameId: '1423049311', title: 'Gothic 2 Gold', slug: 'gothic_2_gold', category: 'game', isGame: true },
    { gogGameId: '1999999999', title: 'Never Played', slug: 'never_played', category: 'game', isGame: true },
  ];

  /** A fake GOG client whose answers can be shaped per test. */
  function fakeApi({ answers = {}, onSession = null } = {}) {
    const calls = [];
    return {
      calls,
      async exchangeCode() {
        return {
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          userId: GALAXY_ID,
        };
      },
      async getUserData() {
        return {
          userKey: USER_KEY,
          username: 'gog_tester',
          // Deliberately different from the token `user_id`: this is exactly the
          // pair that broke production.
          galaxyUserId: GALAXY_ID,
        };
      },
      async refresh() {
        return {
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          userId: GALAXY_ID,
        };
      },
      async fetchAllProducts() {
        return {
          products: PRODUCTS,
          pages: [1],
          totalPages: 1,
          totalProducts: PRODUCTS.length,
          productsPerPage: 100,
          complete: true,
        };
      },
      async getSessions(tokenDoc, gogGameId, options = {}) {
        calls.push({ gogGameId, tokenDoc, raw: options.raw === true });
        if (onSession) return onSession(gogGameId, tokenDoc, options);
        if (gogGameId === '1999999999') {
          return { gogGameId, minutes: 0, found: false, status: 'not_found', uidSource: 'token:user_id' };
        }
        return { gogGameId, minutes: 240, found: true, status: 'ok', field: 'time_sum', uidSource: 'token:user_id' };
      },
    };
  }

  async function waitForJob(jobId) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const status = gogImport.getStatus(jobId);
      if (status && status.done) return status;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`GOG job ${jobId} did not finish`);
  }

  async function seed() {
    await gameCache.saveProfile({
      userKey: STEAM_ID,
      personaName: 'tester',
      ownerLabel: 'Me',
      importedAt: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    });
  }

  test('GOG playtime: uid, response shapes, diagnostics', async (t) => {
    await seed();

    await t.test('gameplayUserId prefers the OAuth user_id, then galaxyUserId', () => {
      assert.deepEqual(gog.gameplayUserId({ userId: GALAXY_ID, userKey: USER_KEY }), {
        uid: GALAXY_ID,
        source: 'token:user_id',
      });
      // The production case: the token has no `userId` yet, `galaxyUserId` is the
      // Galaxy id, `userKey` is `userData.json.userId` (the wrong field).
      assert.deepEqual(gog.gameplayUserId({ userKey: USER_KEY, galaxyUserId: GALAXY_ID }), {
        uid: GALAXY_ID,
        source: 'userData:galaxyUserId',
      });
      // Legacy document: only the old field is known.
      assert.deepEqual(gog.gameplayUserId({ userKey: USER_KEY }), {
        uid: USER_KEY,
        source: 'userData:userId',
      });
      assert.deepEqual(gog.gameplayUserId({}), { uid: null, source: null });
      assert.deepEqual(gog.gameplayUserId(null), { uid: null, source: null });
    });

    await t.test('minutesOfSessionsPayload: time_sum, timeSum, session lists', () => {
      assert.deepEqual(gog.minutesOfSessionsPayload({ time_sum: 1200 }), {
        minutes: 1200,
        field: 'time_sum',
      });
      assert.deepEqual(gog.minutesOfSessionsPayload({ time_sum: '90' }), {
        minutes: 90,
        field: 'time_sum',
      });
      assert.deepEqual(gog.minutesOfSessionsPayload({ timeSum: 30 }), {
        minutes: 30,
        field: 'timeSum',
      });
      // A session list is summed — the same quantity, not an invented one.
      assert.deepEqual(
        gog.minutesOfSessionsPayload({
          sessions: [{ time: 30 }, { time_sum: 15 }, { minutes: 5 }, { duration_minutes: 10 }],
        }),
        { minutes: 60, field: 'sessions[]', sessions: 4 }
      );
      assert.deepEqual(gog.minutesOfSessionsPayload({ sessions: [] }), {
        minutes: 0,
        field: 'sessions[]',
        sessions: 0,
      });
      // No recognizable field is NOT a zero.
      assert.deepEqual(gog.minutesOfSessionsPayload({ ok: true }), { minutes: null, field: null });
      assert.deepEqual(gog.minutesOfSessionsPayload(null), { minutes: null, field: null });
      assert.deepEqual(gog.minutesOfSessionsPayload({ time_sum: 'abc' }), {
        minutes: null,
        field: null,
      });
    });

    await t.test('connect stores both ids; the job sends the Galaxy uid', async () => {
      const api = fakeApi();
      await gogImport.connect({ code: 'ok', profile: OWNER, client: api });
      const token = gogCache.getToken(USER_KEY);
      assert.equal(token.userId, GALAXY_ID);
      // The import persists `galaxyUserId` on the token so an old account heals
      // without a reconnect.
      const job = gogImport.startImport({ account: USER_KEY, client: api, force: true, budget: 50 });
      const status = await waitForJob(job.jobId);
      assert.equal(status.status, 'done');
      assert.equal(gogCache.getToken(USER_KEY).galaxyUserId, GALAXY_ID);
      assert.equal(status.playtime.uidSource, 'token:user_id');
      // Both ids with their sources: the decisive diagnostic when «0.0 ч»
      // persists (if `token:user_id` and `userData:userId` are the same number,
      // the OAuth id is not the Galaxy id and the *order* is the bug).
      assert.deepEqual(status.playtime.uidCandidates, [
        { value: GALAXY_ID, source: 'token:user_id' },
        { value: USER_KEY, source: 'userData:userId' },
      ]);
      assert.equal(status.playtime.ok, 2);
      assert.equal(status.playtime.notFound, 1);
      assert.equal(status.playtime.fields.time_sum, 2);
      assert.equal(status.playtime.targets, 3);
      assert.equal(status.playtime.sample.length, 3);
      assert.deepEqual(
        status.playtime.sample.map((entry) => entry.name),
        ['Majesty 2 Collection', 'Gothic 2 Gold', 'Never Played']
      );
      assert.equal(status.playtime.sample[0].hours, 4);
      assert.equal(status.playtime.sample[2].hours, 0);
      assert.equal(status.playtime.sample[2].status, 'not_found');
    });

    await t.test('the first three raw answers are dumped (no token inside)', async () => {
      // `auth-lifecycle.json` lives in the same directory (silent-refresh trail)
      // and is not a `sessions` dump.
      const dumps = gogCache
        .listDebugDumps()
        .filter((name) => name !== `${gogCache.AUTH_LIFECYCLE_NAME}.json`);
      assert.equal(dumps.length, 3);
      const doc = gogCache.getDebugDump('1207658924');
      assert.equal(doc.kind, 'sessions-raw');
      assert.equal(doc.gogGameId, '1207658924');
      assert.equal(doc.status, 'ok');
      assert.equal(doc.field, 'time_sum');
      assert.equal(doc.minutes, 240);
      assert.match(doc.urlShape, /gameplay\.gog\.com\/games\/\{gogGameId\}\/users\/\{uid\}\/sessions/);
      const serialized = JSON.stringify(doc);
      assert.equal(serialized.includes('access-1'), false);
      assert.equal(serialized.includes('refresh-1'), false);
    });

    await t.test('a 200 without a field stays pending, not zero', async () => {
      const api = fakeApi({
        onSession: (gogGameId) => ({
          gogGameId,
          minutes: null,
          found: false,
          status: 'unparsed',
          httpStatus: 200,
          field: null,
          raw: '{"ok":true}',
        }),
      });
      const job = gogImport.startImport({ account: USER_KEY, client: api, force: true, budget: 50 });
      const status = await waitForJob(job.jobId);
      assert.equal(status.playtime.unparsed, 3);
      assert.equal(status.playtime.ok, 0);
      const playtime = gogCache.getPlaytime(USER_KEY);
      assert.deepEqual(playtime.minutes, {});
      assert.equal(playtime.entries['1207658924'].status, 'unparsed');
      // The raw body is kept for the user even when nothing parsed.
      assert.match(gogCache.getDebugDump('1207658924').raw, /ok/);
    });

    await t.test('a zero written with the old uid is re-checked at once', async () => {
      const first = fakeApi();
      await waitForJob(
        gogImport.startImport({ account: USER_KEY, client: first, force: true, budget: 50 }).jobId
      );
      assert.equal(first.calls.length, 3);

      // Simulate the production snapshot of 01.11.2026: zeros written while the
      // client sent `userData.json.userId` as the uid. After the fix the next
      // import must re-ask them instead of trusting the zeros forever.
      const stale = gogCache.getPlaytime(USER_KEY);
      gogCache.savePlaytime(USER_KEY, { ...stale, uidSource: 'userData:userId' });

      const second = fakeApi();
      const status = await waitForJob(
        gogImport.startImport({ account: USER_KEY, client: second, budget: 50 }).jobId
      );
      assert.deepEqual(second.calls.map((call) => call.gogGameId), ['1999999999']);
      assert.equal(status.playtime.notFound, 1);
    });

    await t.test('a fresh zero with the same uid is not re-asked (24 h window)', async () => {
      const api = fakeApi();
      const status = await waitForJob(
        gogImport.startImport({ account: USER_KEY, client: api, budget: 50 }).jobId
      );
      // The zero was re-checked seconds ago by the previous subtest, with the
      // same uid: no request, no budget spent.
      assert.deepEqual(api.calls, []);
      assert.equal(status.playtime.targets, 3);
      assert.equal(status.playtime.cached, 3);
    });

    await t.test('the raw dump is capped and marked when truncated', () => {
      const long = 'x'.repeat(6000);
      const cut = gog.truncateBody(long, 5 * 1024);
      assert.equal(cut.length > 5 * 1024, true);
      assert.match(cut, /\[truncated \d+ B\]/);
      assert.equal(gog.truncateBody('{"time_sum":1}'), '{"time_sum":1}');
    });
  });
  after(() => env.resetMutableState());
});
