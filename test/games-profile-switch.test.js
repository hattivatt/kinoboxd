'use strict';

/**
 * P1b/P2: the profile switcher of the games tab.
 *
 *  - a chip shows the owner `label` typed at import (fallback: the Steam
 *    persona), so two owners of one Steam account are told apart (P1b);
 *  - switching profiles never leaves the previous owner's numbers on screen:
 *    the dashboard is hidden behind the loader until the new payload lands (P2);
 *  - includeFree/includeDlc are stored PER PROFILE
 *    (`kinoboxd.games.filters.<profileKey>.v1`) and applied to the switch (P2);
 *  - a personnel answer that arrives after a switch is discarded instead of
 *    painting the other owner's credits (P2 race).
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
    genres: [{ name: 'RPG', hours: 10, count: 2 }],
    tags: [], decades: [], years: [], modes: [], access: {},
    timeline: [], achievementDays: [], streaks: [], metadata: {}, gamesIndex: {},
  };
}

const rows = [
  { source: 'steam', userKey: '76561198038369983', key: A, personaName: 'hattivatt', label: 'Я', gameCount: 2 },
  { source: 'steam', userKey: '11111111111111111', key: B, personaName: 'secondplayer', label: 'Брат', gameCount: 2 },
];

const routes = [];
let releasePersonnelA;
const personnelGate = new Promise((resolve) => { releasePersonnelA = resolve; });

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  routes.push(`${options.method || 'GET'} ${target}`);
  let payload = {};

  if (target.startsWith('/api/games/profiles')) {
    payload = { profiles: rows, steamKey: { configured: true, source: 'file' } };
  } else if (target.startsWith('/api/games/stats')) {
    const key = new URL(`http://x${target}`).searchParams.get('profile');
    payload = statsFor(key, key === A ? 'hattivatt' : 'secondplayer');
  } else if (target.startsWith('/api/games/personnel')) {
    const profile = new URL(`http://x${target}`).searchParams.get('profile');
    if (profile === A) {
      // Slow answer for the owner we are about to leave.
      await personnelGate;
      payload = { role: 'developer', items: [{ name: 'Alice Studio', count: 1, games: [] }] };
    } else {
      payload = { role: 'developer', items: [{ name: 'Bob Studio', count: 1, games: [] }] };
    }
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
function chipNamed(name) {
  return chips().find((node) => textOf(node).includes(name));
}
async function wait(ms = 0) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('chips show the owner label, the switch resets to that owner\'s own filters', async () => {
  storage.set('kinoboxd.games.profile.v1', A);
  // B already has its own filter choice; A has none (server defaults).
  storage.set(`kinoboxd.games.filters.${B}.v1`, JSON.stringify({ includeFree: false, includeDlc: true }));

  const games = await import('../public/js/games.js');
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(80);

  /* P1b: the chip is the owner name, the persona stays in the tooltip */
  assert.equal(chips().length, 2);
  assert.match(textOf(chipNamed('Я')).replace(/\s+/g, ' '), /Я/);
  assert.match(chipNamed('Я').getAttribute('title'), /hattivatt/, 'the Steam persona is still discoverable');
  assert.match(textOf(chipNamed('Брат')).replace(/\s+/g, ' '), /Брат/);
  assert.equal(nodeFor('games-dash').hidden, false, 'the selected profile dashboard is shown');

  /* §8.5: the genre filter of the year-count chart is per profile */
  const genreSelect = nodeFor('games-yearcount-genre');
  genreSelect.value = 'RPG';
  genreSelect.onchange();
  assert.equal(genreSelect.value, 'RPG', 'the genre filter was applied');

  /* P2: switching hides the old numbers until the new payload lands */
  chipNamed('Брат').dispatch('click');
  assert.equal(nodeFor('games-dash').hidden, true, 'the old dashboard is hidden on switch');
  assert.equal(nodeFor('games-loading').hidden, false, 'the loader is shown instead');

  await wait(120);
  assert.equal(nodeFor('games-dash').hidden, false, 'the new dashboard is painted');
  assert.equal(storage.get('kinoboxd.games.profile.v1'), B);
  assert.equal(genreSelect.value, '', 'the previous owner genre filter is cleared on switch');

  const switched = routes.filter((route) => route.includes('/api/games/stats'));
  const last = switched[switched.length - 1];
  assert.match(last, /profile=steam-11111111111111111/, 'stats were requested for the new owner');
  assert.match(last, /includeFree=0/, 'the new owner\'s own F2P filter is applied');
  assert.match(last, /includeDlc=1/, 'the new owner\'s own DLC filter is applied');
  assert.equal(
    storage.has(`kinoboxd.games.filters.${A}.v1`),
    false,
    'the previous owner\'s stored filters were not rewritten',
  );

  /* P2 race: A's late personnel answer must not paint Alice on B's dashboard */
  releasePersonnelA();
  await wait(120);
  const persons = textOf(nodeFor('games-person-list'));
  assert.match(persons, /Bob Studio/, 'the current owner credits are rendered');
  assert.doesNotMatch(persons, /Alice Studio/, 'the stale owner answer was discarded');

  games.hideGames();
});
