'use strict';

/**
 * Games: a finished import job activates its Steam profile.
 *
 * The job's `done` answer names the profile (`job.profile`), so `finishImport`
 * sets `kinoboxd.games.profile.v1`, reloads the catalogue and forces a stats
 * render. This smoke drives the real `games.js` in the headless DOM shim:
 * submit the import form, answer the status as done, then read the chip bar.
 * A second `showGames()` (the page-reload path) must keep the same profile.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom, textOf } = require('./helpers/dom-shim');

const { nodeFor, storage } = installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });

const KEY = 'steam-76561198038369983';
const USER_KEY = '76561198038369983';

function statsFor(key, personaName, gameCount = 2) {
  return {
    sources: {
      connected: [key],
      selected: [key],
      profile: {
        key,
        source: 'steam',
        userKey: key.replace(/^steam-/, ''),
        personaName,
        gameCount,
        libraryPartial: false,
      },
      steamKeyConfigured: true,
    },
    summary: {
      gameCount,
      ownedCount: gameCount,
      playedCount: 1,
      unplayedCount: gameCount - 1,
      totalHours: 12,
      meanHours: 6,
      medianHours: 6,
      top10HoursShare: 0.9,
      libraryPartial: false,
      steamKeyConfigured: true,
    },
    hoursHistogram: [],
    topGames: [],
    recentlyPlayed: [],
    backlog: { count: gameCount - 1, share: 0.5, items: [] },
    genres: [],
    tags: [],
    decades: [],
    years: [],
    modes: [],
    access: {},
    timeline: [],
    achievementDays: [],
    streaks: [],
    metadata: {},
    gamesIndex: {},
  };
}

const profileRow = { source: 'steam', userKey: USER_KEY, key: KEY, personaName: 'hattivatt', gameCount: 2 };
let imported = false;
const routes = [];

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  routes.push(`${options.method || 'GET'} ${target}`);
  let payload = {};
  let status = 200;

  if (target.startsWith('/api/games/profiles')) {
    payload = { profiles: imported ? [profileRow] : [], steamKey: { configured: true, source: 'file' } };
  } else if (target.startsWith('/api/games/import/status')) {
    payload = { job: 'games-import', id: 'job-1', profile: KEY, status: 'done', done: true, stage: 'done' };
  } else if (target.startsWith('/api/games/import/steam')) {
    status = 202;
    imported = true;
    payload = { job: 'games-import', id: 'job-1', profile: KEY, status: 'queued' };
  } else if (target.startsWith('/api/games/stats')) {
    payload = statsFor(KEY, 'hattivatt');
  } else if (target.startsWith('/api/games/personnel')) {
    payload = { role: 'developer', persons: [] };
  } else if (target.startsWith('/api/games/enrich')) {
    payload = { running: false };
  }

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async json() { return payload; },
    async text() { return JSON.stringify(payload); },
  };
};

function chips() {
  return nodeFor('games-profile-list').children
    .filter((node) => node.classList && node.classList.contains('games-profile-chip'));
}
function activeChips() {
  return chips().filter((node) => node.classList.contains('is-active'));
}
async function wait(ms = 0) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('games import: the finished job makes its profile the active chip', async () => {
  const games = await import('../public/js/games.js');
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(40);

  assert.equal(chips().length, 0, 'a fresh browser has no Steam profiles');

  nodeFor('games-import-account').value = `https://steamcommunity.com/profiles/${USER_KEY}/`;
  nodeFor('games-import-form').dispatch('submit');
  await wait(800);

  assert.ok(routes.some((route) => route === 'POST /api/games/import/steam'));
  assert.ok(
    routes.some((route) => route.startsWith(`GET /api/games/stats?profile=${KEY}`)),
    'the stats request is scoped to the imported profile',
  );
  assert.equal(storage.get('kinoboxd.games.profile.v1'), KEY);
  assert.equal(chips().length, 1);
  assert.equal(activeChips().length, 1, 'the imported profile is highlighted');
  assert.match(textOf(activeChips()[0]).replace(/\s+/g, ' '), /hattivatt/);

  // Page-reload path: the stored key survives and the chip stays active.
  await games.showGames();
  await wait(60);
  assert.equal(storage.get('kinoboxd.games.profile.v1'), KEY);
  assert.equal(activeChips().length, 1);
});
