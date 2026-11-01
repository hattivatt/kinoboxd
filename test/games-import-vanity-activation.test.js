'use strict';

/**
 * P0: a vanity import activates the profile it RESOLVED, not the one that was
 * selected when the form was submitted.
 *
 * `POST /api/games/import/steam { vanityUrl }` cannot name an owner: the
 * steamid64 only exists after the server reads the profile XML, so the 202
 * answers `profile: null`. The old UI filled that hole with `state.profileKey`
 * (the previously selected profile) and kept activating it — a second person
 * could never become the active tab. This smoke drives the real `games.js`:
 *
 *   1. OLD profile is selected and rendered;
 *   2. the form submits a VANITY of the new person (response: `profile: null`);
 *   3. the first status poll resolves `profile: NEW` while still running;
 *   4. the second poll is `done` → `finishImport` must select NEW.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom, textOf } = require('./helpers/dom-shim');

const { nodeFor, storage } = installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });

const OLD = 'steam-11111111111111111';
const NEW = 'steam-76561198038369983';
const VANITY = 'secondplayer';

function statsFor(key, personaName) {
  return {
    sources: {
      connected: [key],
      selected: [key],
      profile: {
        key, source: 'steam', userKey: key.replace(/^steam-/, ''), personaName,
        gameCount: 2, libraryPartial: false,
      },
      steamKeyConfigured: true,
    },
    summary: {
      gameCount: 2, ownedCount: 2, playedCount: 1, unplayedCount: 1, totalHours: 12,
      meanHours: 6, medianHours: 6, top10HoursShare: 0.9, libraryPartial: false,
      steamKeyConfigured: true,
    },
    hoursHistogram: [],
    topGames: [],
    recentlyPlayed: [],
    backlog: { count: 1, share: 0.5, items: [] },
    genres: [], tags: [], decades: [], years: [], modes: [], access: {},
    timeline: [], achievementDays: [], streaks: [], metadata: {}, gamesIndex: {},
  };
}

const oldRow = { source: 'steam', userKey: '11111111111111111', key: OLD, personaName: 'oldie', gameCount: 2 };
const newRow = {
  source: 'steam', userKey: '76561198038369983', key: NEW, personaName: 'secondplayer', label: 'Брат', gameCount: 2,
};
let imported = false;
let statusCalls = 0;
const routes = [];

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  routes.push(`${options.method || 'GET'} ${target}`);
  let payload = {};
  let status = 200;

  if (target.startsWith('/api/games/profiles')) {
    payload = {
      profiles: imported ? [oldRow, newRow] : [oldRow],
      steamKey: { configured: true, source: 'file' },
    };
  } else if (target.startsWith('/api/games/import/status')) {
    statusCalls += 1;
    if (statusCalls === 1) {
      // The server resolved the vanity: the owner is known, the job still runs.
      payload = { job: 'games-import', id: 'job-2', profile: NEW, status: 'running', stage: 'library', percent: 60 };
    } else {
      payload = { job: 'games-import', id: 'job-2', profile: NEW, status: 'done', done: true, stage: 'done', percent: 100 };
    }
  } else if (target.startsWith('/api/games/import/steam')) {
    status = 202;
    imported = true;
    // Vanity: the owner is NOT known at submit time (the real contract).
    payload = { job: 'games-import', id: 'job-2', profile: null, status: 'queued' };
  } else if (target.startsWith('/api/games/stats')) {
    const key = new URL(`http://x${target}`).searchParams.get('profile');
    payload = key === NEW ? statsFor(NEW, 'secondplayer') : statsFor(OLD, 'oldie');
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
function jobStore() {
  const raw = storage.get('kinoboxd.games.job.v1');
  return raw ? JSON.parse(raw) : null;
}
async function wait(ms = 0) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('a vanity import activates the resolved profile, not the previously selected one', async () => {
  const games = await import('../public/js/games.js');
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(60);

  assert.equal(storage.get('kinoboxd.games.profile.v1'), OLD, 'the old profile is selected before the import');
  assert.equal(activeChips().length, 1);

  nodeFor('games-import-account').value = VANITY;
  nodeFor('games-import-label').value = 'Брат';
  nodeFor('games-import-form').dispatch('submit');

  // The 202 names no owner, so the job must not claim the old key: the first
  // poll is where the owner appears.
  await wait(450);
  const submitted = routes.find((route) => route === 'POST /api/games/import/steam');
  assert.ok(submitted, 'the import was submitted');
  const duringJob = jobStore();
  assert.ok(duringJob, 'the job is persisted for a reload');
  assert.equal(duringJob.profile, NEW, 'the poll wrote the resolved owner into the stored job');

  await wait(1800);
  assert.equal(storage.get('kinoboxd.games.profile.v1'), NEW, 'the finished job activates ITS profile');
  assert.equal(activeChips().length, 1, 'exactly one chip is active');
  assert.match(textOf(activeChips()[0]).replace(/\s+/g, ' '), /Брат/, 'the chip shows the owner label');
  assert.ok(
    routes.some((route) => route.endsWith(`profile=${NEW}`)),
    `stats were requested for the resolved profile:\n${routes.join('\n')}`,
  );
  // The status poll never had to name a profile it did not know yet.
  assert.ok(
    routes.some((route) => route.includes('/api/games/import/status')),
    'the job was followed through the status route',
  );
});
