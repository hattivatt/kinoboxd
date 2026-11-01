'use strict';

/**
 * M6c «Вне Steam» (headless DOM): the real `games.js` paints the list from a
 * `/stats` payload, the 15-row cap expands, and a row opens the client-side
 * union card without a single `/api/games/game/:appid` request.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom, textOf } = require('./helpers/dom-shim');

const { nodeFor, storage } = installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });
const KEY = 'steam-76561198038369983';
storage.set('kinoboxd.games.profile.v1', KEY);

function work(index) {
  const epic = index % 3 === 0;
  const both = index === 1;
  const sources = both ? ['gog', 'epic'] : epic ? ['epic'] : ['gog'];
  const hoursBySource = both
    ? { steam: null, gog: 12.3, epic: 1.5 }
    : epic
      ? { steam: null, gog: null, epic: index + 1 }
      : { steam: null, gog: index + 1, epic: null };
  return {
    workKey: both ? 'gog:1' : epic ? null : `gog:${index}`,
    source: epic ? 'epic' : 'gog',
    name: index === 0 ? 'GOG Zero Hours' : index === 2 ? 'GOG Unknown Hours' : `Work ${index}`,
    sources,
    ownedOn: sources,
    storeIds: {
      steam: null,
      gog: epic ? null : String(index),
      epic: epic ? `epic-${index}` : null,
    },
    hoursBySource: index === 0
      ? { steam: null, gog: 0, epic: null }
      : index === 2
        ? { steam: null, gog: null, epic: null }
        : hoursBySource,
    gog: epic ? null : {
      gogGameId: String(index),
      slug: `work-${index}`,
      title: `Work ${index}`,
      image: '//images.gog.com/work.jpg',
      releaseDate: '2015-05-18T00:00:00+0000',
    },
    epic: epic ? {
      catalogItemId: `epic-${index}`,
      slug: `work-${index}`,
      releaseDate: '2018-06-01T00:00:00+0000',
    } : {},
    genres: index === 1 ? ['RPG', 'Action'] : [],
  };
}

const WORKS = Array.from({ length: 20 }, (_, index) => work(index));

const payload = {
  sources: {
    connected: [KEY],
    selected: [KEY],
    profile: { key: KEY, source: 'steam', personaName: 'player', gameCount: 340 },
    steam: { configured: true, status: 'ok', gameCount: 340 },
    gog: { configured: true, connected: true, status: 'ok', productCount: 10 },
    epic: { configured: true, connected: true, status: 'ok', productCount: 5 },
  },
  summary: {
    gameCount: 340,
    ownedCount: 340,
    totalHours: 5852.7,
    worksTotal: 360,
    secondaryOnlyWorks: 20,
    secondaryWorksTotal: 20,
    hoursBySource: { steam: 5852.7, gog: 120.4, epic: 45 },
    ownedBySource: { steam: 340, gog: 10, epic: 5 },
    // M6c backend contract: charts counted secondary-only works.
    chartsIncludeSecondary: true,
    secondaryWorksInCharts: 20,
  },
  genres: [{ name: 'RPG', count: 40, hours: 100, secondaryCount: 2 }],
  decades: [{ decade: 2010, count: 80, hours: 200 }],
  years: [{ year: 2015, count: 30, hours: 70 }],
  secondaryWorks: WORKS,
  topGames: [],
  recentlyPlayed: [],
  gamesIndex: {},
  timeline: [],
  achievementDays: [],
  streaks: [],
  tags: [],
  scores: [],
  franchises: [],
};

const fetched = [];
globalThis.fetch = async (url) => {
  const target = String(url);
  fetched.push(target);
  let body = {};
  if (target.startsWith('/api/games/profiles')) {
    body = {
      profiles: [{ source: 'steam', userKey: '76561198038369983', key: KEY, personaName: 'player', gameCount: 340 }],
      steamKey: { configured: true, source: 'file' },
    };
  } else if (target.startsWith('/api/games/stats')) {
    body = payload;
  } else if (target.startsWith('/api/games/gog/status')) {
    body = { configured: true, connected: true, status: 'ok', productCount: 10 };
  } else if (target.startsWith('/api/games/epic/status')) {
    body = { configured: true, connected: true, status: 'ok', productCount: 5 };
  } else if (target.startsWith('/api/games/enrich')) {
    body = { running: false };
  }
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
};

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();

test('«Вне Steam» paints 15 works, expands to all, and opens a no-network card', async () => {
  const games = await import('../public/js/games.js');
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(60);

  // Sources widget: union headline + per-source hour totals + chart status.
  assert.equal(nodeFor('games-sources-widget').hidden, false);
  assert.match(norm(textOf(nodeFor('games-sources-note'))), /360 работ в объединённой библиотеке \(включая вне Steam: 20\)/);
  const secondary = norm(textOf(nodeFor('games-sources-secondary')));
  assert.match(secondary, /Часы вне Steam: GOG 120,4 ч · Epic 45,0 ч/);
  assert.match(secondary, /Графики жанров, годов и десятилетий включают работы вне Steam: 20/);

  // Each secondary source row prints its own hours next to the game count.
  const sourceRows = nodeFor('games-sources-body').children;
  assert.match(norm(textOf(sourceRows[1])), /10 игр · 120,4 ч/);
  assert.match(norm(textOf(sourceRows[2])), /5 игр · 45,0 ч/);

  // Full list widget.
  const widget = nodeFor('games-secondary-widget');
  assert.equal(widget.hidden, false);
  assert.match(norm(textOf(nodeFor('games-secondary-note'))), /20 работ вне Steam/);
  const list = nodeFor('games-secondary-list');
  assert.equal(list.children.length, 15);
  assert.equal(norm(textOf(nodeFor('games-secondary-more'))), 'Показать все (20)');

  // One row = poster + info + value.
  const first = list.children[0];
  assert.match(first.className, /games-secondary-row/);
  assert.equal(first.children.length, 3);
  assert.match(first.children[0].className, /games-secondary-poster/);
  assert.equal(first.children[0].tagName, 'IMG');
  assert.match(first.children[0].getAttribute('src'), /images\.gog\.com\/work\.jpg/);
  assert.equal(first.children[1].className, 'games-secondary-info');
  assert.match(norm(textOf(first)), /Work 19/);

  // The GOG+Epic work prints both source chips and both hour totals, never a
  // combined 13.8 h number.
  const rowsByText = new Map(list.children.map((row) => [norm(textOf(row)), row]));
  const both = [...rowsByText.entries()].find(([text]) => text.includes('Epic 1,5 ч'))?.[1];
  assert.ok(both, 'the GOG+Epic work must paint both sources');
  assert.match(norm(textOf(both)), /GOG/);
  assert.match(norm(textOf(both)), /Epic/);
  assert.match(norm(textOf(both)), /GOG 12,3 ч · Epic 1,5 ч/);
  assert.equal(norm(textOf(both)).includes('13,8'), false);

  // Chart notes are tolerant and report the inclusion status.
  assert.match(norm(textOf(nodeFor('games-decades-note'))), /включая вне Steam: 20/);
  assert.match(norm(textOf(nodeFor('games-years-note'))), /включая вне Steam: 20/);
  assert.match(norm(textOf(nodeFor('games-genres-note'))), /включая вне Steam: 20/);

  // «Показать все (N)» expands to every row and collapses again.
  nodeFor('games-secondary-more').children[0].click();
  await wait(20);
  assert.equal(nodeFor('games-secondary-list').children.length, 20);
  assert.equal(norm(textOf(nodeFor('games-secondary-more'))), 'Свернуть до 15');

  // Unknown hours and a real zero are different, honest states; both stay in
  // the full list even though they sort below every positive number.
  const expandedRows = nodeFor('games-secondary-list').children;
  const zero = expandedRows.find((row) => norm(textOf(row)).includes('GOG Zero Hours'));
  const unknown = expandedRows.find((row) => norm(textOf(row)).includes('GOG Unknown Hours'));
  assert.ok(zero, 'the zero-hour work must stay in the list');
  assert.match(norm(textOf(zero)), /не запущена/);
  assert.ok(unknown, 'the unknown-hour work must stay in the list');
  assert.match(norm(textOf(unknown)), /часы не получены/);

  // A row opens the client-side union card: no appid, no details request.
  const before = fetched.filter((url) => url.includes('/api/games/game/')).length;
  const expandedList = nodeFor('games-secondary-list');
  const bothAgain = expandedList.children.find((row) => norm(textOf(row)).includes('Epic 1,5 ч'));
  assert.ok(bothAgain);
  bothAgain.click();
  await wait(20);
  const modal = norm(textOf(nodeFor('modal-root')));
  assert.match(modal, /Работа вне Steam/);
  assert.match(modal, /Work 1/);
  assert.match(modal, /Часы по источникам/);
  assert.match(modal, /Steam/);
  assert.match(modal, /GOG/);
  assert.match(modal, /Epic/);
  assert.match(modal, /12,3 ч/);
  assert.match(modal, /1,5 ч/);
  assert.match(modal, /год релиза 2015/);
  assert.match(modal, /RPG/);
  const after = fetched.filter((url) => url.includes('/api/games/game/')).length;
  assert.equal(after, before, 'a secondary card must never call /api/games/game/:appid');
});
