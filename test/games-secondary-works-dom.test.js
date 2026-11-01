'use strict';

/**
 * M6c secondary-only works (headless DOM), no separate widget.
 *
 * Product decision (01.11.2026): the works are **not** a standalone «Вне
 * Steam» widget. They are counted by the year/decade/genre charts and appear
 * in those drilldowns; clicking a row opens the client-side union card
 * without a single `/api/games/game/:appid` request.
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

// The server puts secondary-only works into `gamesIndex` under their own
// `workKey` (`appid: null`); the drilldown list must count them exactly like
// the chart bucket does.
const SECONDARY_INDEX_ROW = {
  appid: null,
  workKey: 'gog:1',
  secondaryOnly: true,
  source: 'gog',
  name: 'Work 1',
  hours: 13.8,
  hours2w: 0,
  rtime: 0,
  lastPlayed: null,
  iconUrl: null,
  canonicalWorkKey: 'gog:1',
  primaryAppid: null,
  isPrimary: true,
  editionCount: 1,
  canonicalHours: 13.8,
  sources: ['gog', 'epic'],
  storeIds: { steam: null, gog: '1', epic: 'epic-1' },
  hoursBySource: { steam: null, gog: 12.3, epic: 1.5 },
  hoursUnknown: false,
  hoursStatus: { gog: 'ok', epic: 'ok' },
  type: 'game',
  year: 2015,
  releaseYear: 2015,
  genres: ['RPG', 'Action'],
  developers: [],
  publishers: [],
  categories: [],
  tags: [],
  metadataSources: [],
};

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
  gamesIndex: { 'gog:1': SECONDARY_INDEX_ROW },
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

function lastModal() {
  const root = nodeFor('modal-root');
  if (!root || !root.children.length) return null;
  return root.children[root.children.length - 1];
}

function lastModalText() {
  const modal = lastModal();
  return modal ? norm(textOf(modal)) : '';
}

function findByClass(root, className) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    const classes = String(node.className || '').split(/\s+/);
    if (classes.includes(className)) out.push(node);
    for (const child of node.children || []) walk(child);
  };
  walk(root);
  return out;
}

function findSlices(hostId) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    const key = node.attributes && node.attributes['data-key'];
    if (key) out.push({ key, node });
    for (const child of node.children || []) walk(child);
  };
  walk(nodeFor(hostId));
  return out;
}

test('secondary works live in the charts and open the union card from a drilldown', async () => {
  const games = await import('../public/js/games.js');
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(60);

  // There is no standalone «Вне Steam» widget any more.
  assert.equal(payload.gamesIndex['gog:1'].secondaryOnly, true);
  assert.equal(
    (nodeFor('games-secondary-widget').children || []).length,
    0,
    'the removed widget must never be painted',
  );

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

  // Chart notes are tolerant and report the inclusion status.
  assert.match(norm(textOf(nodeFor('games-decades-note'))), /включая вне Steam: 20/);
  assert.match(norm(textOf(nodeFor('games-years-note'))), /включая вне Steam: 20/);
  assert.match(norm(textOf(nodeFor('games-genres-note'))), /включая вне Steam: 20/);

  // Genre drilldown: the RPG bar counts the secondary-only work, and its list
  // contains the same row (no second widget, no separate screen).
  const rpgRow = nodeFor('games-genres-chart').children
    .find((row) => norm(textOf(row)).includes('RPG'));
  assert.ok(rpgRow, 'the RPG genre row must be painted');
  rpgRow.click();
  await wait(20);
  assert.match(lastModalText(), /RPG/);
  assert.match(lastModalText(), /Work 1/);

  const listRow = findByClass(lastModal(), 'film-row')
    .find((row) => norm(textOf(row)).includes('Work 1'));
  assert.ok(listRow, 'the secondary-only work must be a row in the genre modal');
  // Per-source hours in the row: a GOG+Epic work never prints 13,8 ч.
  assert.match(norm(textOf(listRow)), /GOG 12,3 ч · Epic 1,5 ч/);
  assert.equal(norm(textOf(listRow)).includes('13,8'), false);

  // The row opens the client-side union card: no appid, no details request.
  const before = fetched.filter((url) => url.includes('/api/games/game/')).length;
  listRow.click();
  await wait(20);
  const modal = lastModalText();
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

  // Year drilldown counts the same secondary-only work (release year 2015).
  nodeFor('modal-root').children = [];
  const yearSlice = findSlices('games-years-donut')
    .find((slice) => slice.key === 'year-2015');
  assert.ok(yearSlice, 'the 2015 year slice must be painted');
  yearSlice.node.click();
  await wait(20);
  assert.match(lastModalText(), /Work 1/);
});
