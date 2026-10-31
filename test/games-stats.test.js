'use strict';

/**
 * `/api/games/stats` computations (M1): hours, Pareto, backlog, achievements.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-stats-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-stats-state-'));

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
