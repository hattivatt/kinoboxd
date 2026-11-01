'use strict';

/**
 * Games U6: decade/year donuts (films/books parity) + Steam covers.
 *
 * Three layers, like the other games UI tests:
 *
 *   1. view models on the live snapshot (`/tmp/opencode/gm4int/stats-live.json`,
 *      332 games): the decade counts (2 / 59 / 209 / 33 + 29 without a year)
 *      and the year counts (2013 = 34 games / 450.2 h) must not move when the
 *      widgets change shape;
 *   2. headless DOM smoke of the real `games.js`: «Десятилетия» paints four
 *      donut slices (the year-less bucket is a note button, never a slice),
 *      «Годы релиза» paints every year as a donut slice by default, a decade
 *      slice narrows it, and the note opens the year-less list;
 *   3. the Steam cover chain: header.jpg → capsule_231x87 → 32×32 icon →
 *      initials, built from the canonical `primaryAppid`.
 *
 * The live snapshot is optional: without it the deterministic checks still
 * run (the file skips only the snapshot assertions).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { installDom, textOf } = require('./helpers/dom-shim');

const { nodeFor, storage } = installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });

const LIVE_FILE = '/tmp/opencode/gm4int/stats-live.json';
const KEY = 'steam-76561198038369983';
const KEY2 = 'steam-76561198000000002';
storage.set('kinoboxd.games.profile.v1', KEY);

function live() {
  if (!fs.existsSync(LIVE_FILE)) return null;
  return JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8'));
}

const snapshot = live();

globalThis.fetch = async (url) => {
  const target = String(url);
  let body = {};
  if (target.startsWith('/api/games/profiles')) {
    body = {
      profiles: snapshot
        ? [
          { source: 'steam', userKey: '76561198038369983', key: KEY, personaName: 'hattivatt', gameCount: 340 },
          { source: 'steam', userKey: '76561198000000002', key: KEY2, personaName: 'second-owner', gameCount: 340 },
        ]
        : [],
      steamKey: { configured: true, source: 'file' },
    };
  } else if (target.startsWith('/api/games/stats')) {
    body = snapshot || {};
  } else if (target.startsWith('/api/games/personnel')) {
    body = { role: 'developer', persons: [] };
  } else if (target.startsWith('/api/games/franchises')) {
    body = { franchises: [] };
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

function walk(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function slices(hostId) {
  const hits = [];
  walk(nodeFor(hostId), (node) => {
    const key = node.attributes && node.attributes['data-key'];
    if (key) hits.push({ key, node });
  });
  return hits;
}

function lastModalText() {
  const root = nodeFor('modal-root');
  if (!root || !root.children.length) return '';
  return textOf(root.children[root.children.length - 1]).replace(/\s+/g, ' ').trim();
}

async function wait(ms = 0) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/* =========================================================
   1. live snapshot: the numbers survive the donut swap
   ========================================================= */

test('live snapshot: decade and year numbers are unchanged after the donut swap', { skip: !snapshot }, async () => {
  const { normalizeGamesPayload, decadesView, yearsView, yearsInDecade } = await import('../public/js/games-view.js');
  const data = normalizeGamesPayload(snapshot);

  const decades = decadesView(data.decades);
  const known = decades.rows.filter((row) => !row.unknown);
  assert.deepEqual(known.map((row) => [row.decade, row.count]), [
    [1990, 2], [2000, 59], [2010, 209], [2020, 33],
  ]);
  // The year-less bucket stays a bucket: 29 games, reported apart.
  assert.equal(decades.unknownCount, 29);

  const years = yearsView(data.years);
  assert.equal(years.years.find((item) => item.year === 2013).count, 34);
  assert.equal(years.years.find((item) => item.year === 2013).hours, 450.2);
  assert.equal(years.total, 303);
  assert.equal(data.unknownYear.count, 29);

  // The narrowed range is exactly the decade's ten years, counts included.
  const narrowed = yearsInDecade(data.years, 2010);
  assert.equal(narrowed.length, 10);
  assert.equal(narrowed.reduce((sum, item) => sum + item.count, 0), 209);
});

/* =========================================================
   2. DOM smoke: both cards are donuts, the unknown year is a note
   ========================================================= */

test('games donuts paint from the live payload: 4 decade slices, 26 year slices', { skip: !snapshot }, async () => {
  const games = await import('../public/js/games.js');
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(60);

  // Decades: four real slices, unknown year is not one of them.
  assert.equal(nodeFor('games-decades-widget').hidden, false);
  assert.deepEqual(
    slices('games-decades-donut').map((slice) => slice.key),
    ['decade-1990', 'decade-2000', 'decade-2010', 'decade-2020'],
  );
  const decadeText = textOf(nodeFor('games-decades-donut')).replace(/\s+/g, ' ');
  assert.match(decadeText, /303/);
  assert.match(decadeText, /игр с годом/);
  assert.match(textOf(nodeFor('games-decades-legend')), /2010-е/);
  // Counts are the same numbers the old ranked list printed (209 / 303).
  assert.match(textOf(nodeFor('games-decades-legend')).replace(/\s+/g, ' '), /2010-е 209/);
  // Honest note: «4 десятилетия · 29 игр без года» (the count is a button).
  const note = textOf(nodeFor('games-decades-note')).replace(/\s+/g, ' ').trim();
  assert.match(note, /4 десятилетия/);
  assert.match(note, /29 игр без года/);

  // Years: every release year is a slice by default (26 known years).
  assert.equal(nodeFor('games-years-widget').hidden, false);
  const yearKeys = slices('games-years-donut').map((slice) => slice.key);
  assert.equal(yearKeys.length, 26);
  assert.ok(yearKeys.includes('year-2013'));
  assert.ok(yearKeys.includes('year-1997'));
  assert.ok(yearKeys.includes('year-2026'));
  const yearsNote = textOf(nodeFor('games-years-note')).replace(/\s+/g, ' ');
  assert.match(yearsNote, /1997 — 2026/);
  assert.match(yearsNote, /303 игры/);
  assert.match(yearsNote, /29 без года/);
  // 2013 keeps its 34 games in the donut legend (count-driven slices).
  assert.match(textOf(nodeFor('games-years-legend')).replace(/\s+/g, ' '), /2013 34/);
});

test('games donuts: a decade slice narrows the years donut and can be cleared', { skip: !snapshot }, async () => {
  const games = await import('../public/js/games.js');
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(60);

  const decade2010 = slices('games-decades-donut').find((slice) => slice.key === 'decade-2010').node;
  decade2010.click();
  await wait(20);

  assert.deepEqual(
    slices('games-years-donut').map((slice) => slice.key),
    ['year-2019', 'year-2018', 'year-2017', 'year-2016', 'year-2015',
      'year-2014', 'year-2013', 'year-2012', 'year-2011', 'year-2010'],
  );
  const note = textOf(nodeFor('games-years-note')).replace(/\s+/g, ' ');
  assert.match(note, /2010–2019/);
  assert.match(note, /10 лет/);
  assert.match(note, /209 игр/);
  // The narrowed 2013 slice still says 34 games.
  assert.match(textOf(nodeFor('games-years-legend')).replace(/\s+/g, ' '), /2013 34/);

  // Second click on the same slice clears the selection (full range again).
  slices('games-decades-donut').find((slice) => slice.key === 'decade-2010').node.click();
  await wait(20);
  assert.equal(slices('games-years-donut').length, 26);
});

test('games decades: «N игр без года» is a note button that opens the list', { skip: !snapshot }, async () => {
  const games = await import('../public/js/games.js');
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(60);

  const note = nodeFor('games-decades-note');
  let button = null;
  walk(note, (node) => {
    if (!button && node.tagName === 'BUTTON' && /без года/.test(textOf(node))) button = node;
  });
  assert.ok(button, 'нет кнопки «N игр без года» в примечании');
  button.click();
  await wait(20);
  const modal = lastModalText();
  assert.match(modal, /Год неизвестен — 29 игр/);
  assert.match(modal, /releaseYear/);
});

/* =========================================================
   2b. profile switch clears the decade selection
   ========================================================= */

test('profile switch resets the decade selection (a6c5d48 regression guard)', { skip: !snapshot }, async () => {
  const games = await import('../public/js/games.js');
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(60);

  // Narrow the pair to 2010-е, then switch the owner: the selection belongs to
  // the previous profile and must not survive (AGENTS §6, one owner per view).
  slices('games-decades-donut').find((slice) => slice.key === 'decade-2010').node.click();
  await wait(20);
  assert.equal(slices('games-years-donut').length, 10);

  const chips = nodeFor('games-profile-list').children;
  assert.equal(chips.length, 2, 'нужны два профиля для переключения');
  chips[1].click();
  await wait(100);

  assert.equal(slices('games-years-donut').length, 26, 'полный диапазон после смены профиля');
  assert.doesNotMatch(textOf(nodeFor('games-years-note')).replace(/\s+/g, ' '), /2010–2019/);
  assert.doesNotMatch(textOf(nodeFor('games-decades-note')).replace(/\s+/g, ' '), /выбрано/);
});

/* =========================================================
   3. Steam covers: header → capsule → icon → initials
   ========================================================= */
test('cover chain: header.jpg first, capsule second, 32×32 icon last', async () => {
  const { gameCoverUrls } = await import('../public/js/games-modal.js');

  assert.deepEqual(gameCoverUrls({
    appid: 292030,
    iconUrl: 'https://media.steampowered.com/steamcommunity/public/images/apps/292030/abc.jpg',
  }), [
    'https://cdn.cloudflare.steamstatic.com/steam/apps/292030/header.jpg',
    'https://cdn.cloudflare.steamstatic.com/steam/apps/292030/capsule_231x87.jpg',
    'https://media.steampowered.com/steamcommunity/public/images/apps/292030/abc.jpg',
  ]);

  // The canonical primary edition wins: two editions of one work share a cover.
  assert.deepEqual(gameCoverUrls({ appid: 462780, primaryAppid: 937 }).slice(0, 2), [
    'https://cdn.cloudflare.steamstatic.com/steam/apps/937/header.jpg',
    'https://cdn.cloudflare.steamstatic.com/steam/apps/937/capsule_231x87.jpg',
  ]);

  // No appid and no icon: nothing to request, the caller paints initials.
  assert.deepEqual(gameCoverUrls({ name: 'No appid' }), []);
  assert.deepEqual(gameCoverUrls(null), []);
});

test('cover element: an error walks the chain and ends in the initials block', async () => {
  const { gameCoverEl } = await import('../public/js/games-modal.js');
  const host = document.createElement('div');

  const img = gameCoverEl({ appid: 70, name: 'Half-Life' }, { className: 'games-recent-icon' });
  host.append(img);
  assert.equal(img.tagName, 'IMG');
  assert.equal(img.getAttribute('src'), 'https://cdn.cloudflare.steamstatic.com/steam/apps/70/header.jpg');
  assert.equal(img.className, 'games-recent-icon');

  // 404 on the header → capsule.
  img.dispatch('error');
  assert.equal(img.getAttribute('src'), 'https://cdn.cloudflare.steamstatic.com/steam/apps/70/capsule_231x87.jpg');
  // 404 on the capsule → the 32×32 icon (absent here) → initials.
  img.dispatch('error');
  assert.equal(host.children.length, 1, 'the <img> is replaced by one initials block');
  const fallback = host.children[0];
  assert.equal(fallback.tagName, 'DIV');
  assert.equal(fallback.className, 'games-recent-icon game-icon-fallback');
  assert.equal(fallback.textContent, 'H');

  // No appid and no icon: initials straight away, no request.
  const bare = gameCoverEl({ name: 'Half-Life' }, { className: 'games-recent-icon' });
  assert.equal(bare.tagName, 'DIV');
  assert.equal(bare.className, 'games-recent-icon game-icon-fallback');
  assert.equal(bare.textContent, 'H');
});

test('cover element: a 32×32 icon is the last Steam step, then initials', async () => {
  const { gameCoverEl } = await import('../public/js/games-modal.js');
  const host = document.createElement('div');
  const icon = 'https://media.steampowered.com/steamcommunity/public/images/apps/70/abc.jpg';
  const img = gameCoverEl({ appid: 70, name: 'Half-Life', iconUrl: icon });
  host.append(img);
  img.dispatch('error');
  img.dispatch('error');
  assert.equal(img.getAttribute('src'), icon);
  img.dispatch('error');
  assert.equal(host.children[0].tagName, 'DIV');
});

/* =========================================================
   4. «Недавно играл»: strict dedupe by canonical work
   ========================================================= */

test('strip dedupe: two index editions of one work paint one card', async () => {
  const { recentStripView } = await import('../public/js/games-view.js');
  const now = Date.UTC(2026, 10, 1);
  const index = {
    937: {
      appid: 937, name: 'Darksiders', hours: 15.6, hours2w: 0, rtime: 1793000000,
      canonicalWorkKey: 'steam:50620', primaryAppid: 937, isPrimary: true,
    },
    462780: {
      appid: 462780, name: 'Darksiders Warmastered Edition', hours: 5.4, hours2w: 1.2,
      rtime: 1793300000, canonicalWorkKey: 'steam:50620', primaryAppid: 937, isPrimary: false,
    },
  };
  const view = recentStripView([], index, { now });
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].primaryAppid, 937, 'обложка — по primary-изданию');
  assert.equal(view.items[0].hours2w, 1.2, 'часы изданий складываются');
});

test('strip dedupe: a payload row without canonicalWorkKey still merges with its editions', async () => {
  const { recentStripView } = await import('../public/js/games-view.js');
  const now = Date.UTC(2026, 10, 1);
  // Older/trimmed server payload: the canonical row has no `canonicalWorkKey`,
  // the index does. The appid→work map must keep it one card.
  const index = {
    937: {
      appid: 937, name: 'Darksiders', hours: 15.6, hours2w: 0, rtime: 1793000000,
      canonicalWorkKey: 'steam:50620', primaryAppid: 937,
    },
    462780: {
      appid: 462780, name: 'Darksiders Warmastered Edition', hours: 5.4, hours2w: 0,
      rtime: 1793300000, canonicalWorkKey: 'steam:50620', primaryAppid: 937,
    },
  };
  const view = recentStripView(
    [{ appid: 937, name: 'Darksiders', hours2w: 0, hoursTotal: 21, lastPlayed: '2026-10-20T00:00:00.000Z' }],
    index,
    { now },
  );
  assert.equal(view.items.length, 1, 'одна работа — одна карточка, даже без workKey в payload');
  assert.equal(view.items[0].appid, 937, 'лицо карточки — каноническая строка сервера');
  assert.equal(view.items[0].primaryAppid, 937);
  assert.equal(view.items[0].hoursTotalText, '21,0 ч');
});

test('strip dedupe: distinct works stay distinct', async () => {
  const { recentStripView } = await import('../public/js/games-view.js');
  const now = Date.UTC(2026, 10, 1);
  const index = {
    70: { appid: 70, name: 'Half-Life', hours2w: 0, rtime: 1793000000, canonicalWorkKey: 'steam:70' },
    220: { appid: 220, name: 'Half-Life 2', hours2w: 0, rtime: 1793100000, canonicalWorkKey: 'steam:220' },
  };
  assert.equal(recentStripView([], index, { now }).items.length, 2);
});
