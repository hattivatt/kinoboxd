'use strict';

/**
 * P1a: the profile catalogue is server state, not session state.
 *
 * `ensureProfiles()` used to fetch `/api/games/profiles` once per page load, so
 * a profile imported from another browser (or another tab of the same account)
 * never appeared in the switcher until a reload. Activation now re-reads the
 * catalogue, throttled by `PROFILES_RELOAD_MS` so a quick tab flip-flop does
 * not turn into a request storm.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom, textOf } = require('./helpers/dom-shim');

const { nodeFor, storage } = installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });

const A = 'steam-76561198038369983';
const B = 'steam-11111111111111111';

function statsFor(key, personaName) {
  return {
    sources: {
      connected: [key],
      selected: [key],
      profile: { key, source: 'steam', userKey: key.replace(/^steam-/, ''), personaName, gameCount: 2, libraryPartial: false },
      steamKeyConfigured: true,
    },
    summary: {
      gameCount: 2, ownedCount: 2, playedCount: 1, unplayedCount: 1, totalHours: 12,
      meanHours: 6, medianHours: 6, top10HoursShare: 0.9, libraryPartial: false, steamKeyConfigured: true,
    },
    hoursHistogram: [],
    topGames: [],
    recentlyPlayed: [],
    backlog: { count: 1, share: 0.5, items: [] },
    genres: [], tags: [], decades: [], years: [], modes: [], access: {},
    timeline: [], achievementDays: [], streaks: [], metadata: {}, gamesIndex: {},
  };
}

const rowA = { source: 'steam', userKey: '76561198038369983', key: A, personaName: 'hattivatt', gameCount: 2 };
const rowB = { source: 'steam', userKey: '11111111111111111', key: B, personaName: 'secondplayer', gameCount: 2 };

let serverProfiles = [rowA];
let profileRequests = 0;

globalThis.fetch = async (url) => {
  const target = String(url);
  let payload = {};

  if (target.startsWith('/api/games/profiles')) {
    profileRequests += 1;
    payload = { profiles: serverProfiles, steamKey: { configured: true, source: 'file' } };
  } else if (target.startsWith('/api/games/stats')) {
    const key = new URL(`http://x${target}`).searchParams.get('profile');
    payload = statsFor(key, key === A ? 'hattivatt' : 'secondplayer');
  } else if (target.startsWith('/api/games/personnel')) {
    payload = { role: 'developer', items: [] };
  } else if (target.startsWith('/api/games/enrich')) {
    payload = { running: false };
  }

  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    async json() { return payload; },
    async text() { return JSON.stringify(payload); },
  };
};

function chips() {
  return nodeFor('games-profile-list').children
    .filter((node) => node.classList && node.classList.contains('games-profile-chip'));
}
async function wait(ms = 0) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('a profile imported elsewhere shows up on the next tab activation', async () => {
  storage.set('kinoboxd.games.profile.v1', A);
  const games = await import('../public/js/games.js');
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(80);

  assert.equal(chips().length, 1);
  assert.match(textOf(chips()[0]).replace(/\s+/g, ' '), /hattivatt/);
  const afterFirst = profileRequests;

  // Another browser imports a second owner.
  serverProfiles = [rowA, rowB];

  // A quick re-activation is throttled: no request, no chip yet.
  await games.showGames();
  await wait(20);
  assert.equal(profileRequests, afterFirst, 'the throttle absorbed the immediate re-activation');
  assert.equal(chips().length, 1);

  // Once the throttle window has passed, activation re-reads the catalogue.
  const realNow = Date.now;
  Date.now = () => realNow() + 31_000;
  try {
    await games.showGames();
    await wait(20);
  } finally {
    Date.now = realNow;
  }
  assert.ok(profileRequests > afterFirst, 'the catalogue was re-read');
  assert.equal(chips().length, 2, 'the new owner is in the switcher');
  assert.equal(storage.get('kinoboxd.games.profile.v1'), A, 'the selected profile is unchanged');

  games.hideGames();
});
