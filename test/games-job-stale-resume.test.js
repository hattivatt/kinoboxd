'use strict';

/**
 * P0 (resume path): a stored import job may only speak for the profile it
 * names.
 *
 * `hydrateJob()` used to take `job.profile` as the tab's profile
 * unconditionally, so a leftover job from an earlier import could pull the tab
 * back onto an old profile (and rewrite `kinoboxd.games.profile.v1`) on the
 * next tab activation. Now:
 *
 *   - job profile ≠ selected profile → the job is stale, dropped, and the tab
 *     opens on the selected profile's dashboard;
 *   - job profile == selected profile → the progress screen is resumed;
 *   - a job with no owner yet (vanity import, `profile: ''`) is kept.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom } = require('./helpers/dom-shim');

const { nodeFor, storage } = installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });

const SELECTED = 'steam-76561198038369983';
const OTHER = 'steam-11111111111111111';

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

const rows = [
  { source: 'steam', userKey: '76561198038369983', key: SELECTED, personaName: 'mine', gameCount: 2 },
  { source: 'steam', userKey: '11111111111111111', key: OTHER, personaName: 'other', gameCount: 2 },
];
const routes = [];

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  routes.push(`${options.method || 'GET'} ${target}`);
  let payload = {};

  if (target.startsWith('/api/games/profiles')) {
    payload = { profiles: rows, steamKey: { configured: true, source: 'file' } };
  } else if (target.startsWith('/api/games/import/status')) {
    // The status echoes the profile the poll asked about (the job's own key).
    const asked = new URL(`http://x${target}`).searchParams.get('profile');
    payload = { job: 'games-import', id: 'job-9', profile: asked || OTHER, status: 'running', stage: 'library', percent: 40 };
  } else if (target.startsWith('/api/games/stats')) {
    const key = new URL(`http://x${target}`).searchParams.get('profile');
    payload = statsFor(key, key === SELECTED ? 'mine' : 'other');
  } else if (target.startsWith('/api/games/personnel')) {
    payload = { role: 'developer', persons: [] };
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

async function wait(ms = 0) { return new Promise((resolve) => setTimeout(resolve, ms)); }

let games = null;

test('a stored job for another profile does not hijack the tab', async () => {
  storage.set('kinoboxd.games.profile.v1', SELECTED);
  storage.set('kinoboxd.games.job.v1', JSON.stringify({ id: 'job-9', profile: OTHER, startedAt: Date.now() }));

  games = await import('../public/js/games.js');
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(80);

  assert.equal(storage.get('kinoboxd.games.profile.v1'), SELECTED, 'the selected profile survives a stale job');
  assert.equal(storage.has('kinoboxd.games.job.v1'), false, 'the stale job is dropped from storage');
  assert.equal(nodeFor('games-progress').hidden, true, 'the progress screen is not shown');
  assert.equal(nodeFor('games-dash').hidden, false, 'the selected profile dashboard is shown');
  assert.ok(
    routes.some((route) => route.endsWith(`profile=${SELECTED}`)),
    `stats were requested for the selected profile:\n${routes.join('\n')}`,
  );
  assert.equal(
    routes.some((route) => route.endsWith(`profile=${OTHER}`)),
    false,
    'the stale job profile was never requested',
  );
});

test('a stored job for the selected profile still resumes the progress screen', async () => {
  games.resetGames();
  storage.clear();
  storage.set('kinoboxd.games.profile.v1', SELECTED);
  storage.set('kinoboxd.games.job.v1', JSON.stringify({ id: 'job-9', profile: SELECTED, startedAt: Date.now() }));

  await games.showGames();
  await wait(600);

  assert.equal(nodeFor('games-progress').hidden, false, 'the progress screen resumes');
  assert.ok(
    routes.some((route) => route.includes('/api/games/import/status')),
    'the job is polled again',
  );
  // Stop the poller: a resumed job is long-lived by design.
  games.hideGames();
});
