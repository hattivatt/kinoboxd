'use strict';

/**
 * Games: `/api/games/profiles` lagging behind a finished import must not move
 * the tab back to the previous profile.
 *
 * `finishImport()` reloads the catalogue after the job's `done`. If that list
 * does not contain the profile yet (eventual consistency, older server), the
 * reload used to override `state.profileKey` with `keys[0]` — the old profile —
 * and the dashboard switched back. The job named the profile, so it wins; this
 * test pins the re-assert and the forced stats request.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom } = require('./helpers/dom-shim');

const { nodeFor, storage } = installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });

const OLD = 'steam-11111111111111111';
const NEW = 'steam-76561198038369983';

function statsFor(key, personaName) {
  return {
    sources: {
      connected: [key],
      selected: [key],
      profile: { key, source: 'steam', userKey: key.replace(/^steam-/, ''), personaName, gameCount: 2, libraryPartial: false },
      steamKeyConfigured: true,
    },
    summary: {
      gameCount: 2,
      ownedCount: 2,
      playedCount: 1,
      unplayedCount: 1,
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
    backlog: { count: 1, share: 0.5, items: [] },
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

const oldRow = { source: 'steam', userKey: '11111111111111111', key: OLD, personaName: 'oldie', gameCount: 2 };
const newRow = { source: 'steam', userKey: '76561198038369983', key: NEW, personaName: 'hattivatt', gameCount: 2 };
const routes = [];

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  routes.push(`${options.method || 'GET'} ${target}`);
  let payload = {};
  let status = 200;

  if (target.startsWith('/api/games/profiles')) {
    // The catalogue never learns about the new profile in this test.
    payload = { profiles: [oldRow], steamKey: { configured: true, source: 'file' } };
  } else if (target.startsWith('/api/games/import/status')) {
    payload = { job: 'games-import', id: 'job-1', profile: NEW, status: 'done', done: true, stage: 'done' };
  } else if (target.startsWith('/api/games/import/steam')) {
    status = 202;
    payload = { job: 'games-import', id: 'job-1', profile: NEW, status: 'queued' };
  } else if (target.startsWith('/api/games/stats')) {
    const key = new URL(`http://x${target}`).searchParams.get('profile');
    payload = key === NEW ? statsFor(NEW, 'hattivatt') : statsFor(OLD, 'oldie');
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
async function wait(ms = 0) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('games import: a lagging catalogue cannot switch back to the old profile', async () => {
  const games = await import('../public/js/games.js');
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(60);

  assert.equal(storage.get('kinoboxd.games.profile.v1'), OLD, 'the old profile is active before the import');
  assert.ok(routes.some((route) => route.startsWith(`GET /api/games/stats?profile=${OLD}`)));

  nodeFor('games-import-account').value = NEW.replace(/^steam-/, '');
  nodeFor('games-import-form').dispatch('submit');
  await wait(800);

  assert.equal(storage.get('kinoboxd.games.profile.v1'), NEW, 'the finished job wins over the stale catalogue');
  const statsRoutes = routes.filter((route) => route.includes('/api/games/stats'));
  assert.ok(
    statsRoutes.some((route) => route.endsWith(`profile=${NEW}`)),
    `stats are forced for the imported profile:\n${routes.join('\n')}`,
  );
  assert.equal(chips().length, 1, 'the catalogue still lists only the old chip (no invented row)');
  assert.equal(chips()[0].classList.contains('is-active'), false, 'a profile missing from the catalogue is not painted as active');
});
