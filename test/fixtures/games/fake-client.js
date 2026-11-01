'use strict';

/**
 * Offline Steam client for the games tests: returns the trimmed real payloads
 * from `test/fixtures/games/` and records every call. Live requests are never
 * made from `npm test` (ИГРЫ §10.3); the live smoke is a manual run.
 */

const fs = require('fs');
const path = require('path');

const steam = require('../../../server/games/steam');

function readFixture(name) {
  return fs.readFileSync(path.join(__dirname, name), 'utf8');
}

function createFakeClient(options = {}) {
  const calls = [];
  const state = {
    key: options.key === undefined ? 'test-key-not-real' : options.key,
    profile:
      options.profile || steam.parseProfileXml(readFixture('profile.xml')),
    owned:
      options.owned ||
      steam.parseOwnedGamesResponse(JSON.parse(readFixture('owned-games.json'))),
    achievements:
      options.achievements || steam.parseAchievementsXml(readFixture('achievements.xml')),
    global:
      options.global ||
      steam.parseGlobalPercentages(JSON.parse(readFixture('global-percentages.json')), 620),
    fail: options.fail || {},
  };

  const client = {
    calls,
    state,
    _keyProvider: () => ({ key: state.key, source: state.key ? 'test' : null }),
    async getProfile(target) {
      calls.push('profile');
      if (state.fail.profile) throw state.fail.profile;
      // The real `profiles/<id64>/?xml=1` always echoes the requested id64;
      // the trimmed fixture is one fixed profile, so echo it here too (this
      // keeps the import's steamid_mismatch guard honest in tests).
      const id64 = target && target.id64 ? String(target.id64) : state.profile.steamId64;
      return {
        ...state.profile,
        steamId64: id64,
        mostPlayedGames: state.profile.mostPlayedGames.map((g) => ({ ...g })),
      };
    },
    async getPlayerSummaries() {
      calls.push('summaries');
      if (state.fail.summaries) throw state.fail.summaries;
      const summary = JSON.parse(readFixture('player-summaries.json')).response.players[0];
      return {
        steamId64: summary.steamid,
        personaName: summary.personaname,
        profileUrl: summary.profileurl,
        avatarFull: summary.avatarfull,
        communityVisibilityState: summary.communityvisibilitystate,
        timeCreated: summary.timecreated,
        lastLogOff: summary.lastlogoff,
        countryCode: summary.loccountrycode,
      };
    },
    async getOwnedGames() {
      calls.push('owned');
      if (state.fail.owned) throw state.fail.owned;
      return { ...state.owned, games: state.owned.games.map((g) => ({ ...g })) };
    },
    async getAchievements() {
      calls.push('achievements');
      if (state.fail.achievements) throw state.fail.achievements;
      return { ...state.achievements, achievements: state.achievements.achievements.map((a) => ({ ...a })) };
    },
    async getGlobalPercentages() {
      calls.push('global');
      if (state.fail.global) throw state.fail.global;
      return { ...state.global, achievements: state.global.achievements.map((a) => ({ ...a })) };
    },
  };
  return client;
}

module.exports = { createFakeClient, readFixture };
