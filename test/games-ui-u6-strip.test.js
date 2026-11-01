'use strict';

/**
 * Games U6: «Недавно играл» — one card per canonical work, wide Steam covers.
 *
 * The strip used to paint the payload's `recentlyPlayed` rows *and* every
 * `gamesIndex` entry, so two store editions of one work could appear twice.
 * This smoke drives the real `games.js`: the index carries two Darksiders
 * editions, the strip must paint one card, and every card/modal image must be
 * the wide `header.jpg` cover (not the stretched 32×32 community icon).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom, textOf } = require('./helpers/dom-shim');

const { nodeFor, storage } = installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });

const KEY = 'steam-76561198038369983';
storage.set('kinoboxd.games.profile.v1', KEY);

const nowSeconds = Math.floor(Date.now() / 1000);
const fiveDaysAgo = nowSeconds - 5 * 86400;
const twoDaysAgo = nowSeconds - 2 * 86400;
const tenDaysAgo = nowSeconds - 10 * 86400;

function game(appid, name, extra = {}) {
  return {
    appid,
    name,
    hours: 10,
    hours2w: 0,
    rtime: 0,
    lastPlayed: null,
    genres: ['Action'],
    categories: ['Single-player'],
    type: 'game',
    isFree: false,
    earlyAccess: false,
    completion: null,
    iconUrl: null,
    developers: [],
    publishers: [],
    achievements: null,
    ...extra,
  };
}

const gamesIndex = {
  937: game(937, 'Darksiders', {
    hours: 15.6,
    rtime: fiveDaysAgo,
    lastPlayed: new Date(fiveDaysAgo * 1000).toISOString(),
    canonicalWorkKey: 'steam:50620',
    primaryAppid: 937,
    isPrimary: true,
    editionCount: 2,
    iconUrl: 'https://media.steampowered.com/steamcommunity/public/images/apps/937/icon.jpg',
  }),
  462780: game(462780, 'Darksiders Warmastered Edition', {
    hours: 5.4,
    hours2w: 1.2,
    rtime: twoDaysAgo,
    lastPlayed: new Date(twoDaysAgo * 1000).toISOString(),
    canonicalWorkKey: 'steam:50620',
    primaryAppid: 937,
    isPrimary: false,
    editionCount: 2,
    iconUrl: 'https://media.steampowered.com/steamcommunity/public/images/apps/462780/icon.jpg',
  }),
  70: game(70, 'Half-Life', {
    hours: 11,
    rtime: tenDaysAgo,
    lastPlayed: new Date(tenDaysAgo * 1000).toISOString(),
    canonicalWorkKey: 'steam:70',
    primaryAppid: 70,
    iconUrl: 'https://media.steampowered.com/steamcommunity/public/images/apps/70/icon.jpg',
  }),
};

const payload = {
  sources: {
    connected: [KEY],
    selected: [KEY],
    profile: {
      key: KEY,
      source: 'steam',
      userKey: '76561198038369983',
      personaName: 'hattivatt',
      gameCount: 3,
      libraryPartial: false,
    },
    steamKeyConfigured: true,
  },
  summary: {
    gameCount: 3,
    ownedCount: 3,
    playedCount: 3,
    unplayedCount: 0,
    totalHours: 32,
    meanHours: 10.67,
    medianHours: 11,
    top10HoursShare: 1,
    libraryPartial: false,
    steamKeyConfigured: true,
  },
  hoursHistogram: [],
  topGames: [],
  // Empty on purpose: the strip must build from gamesIndex (the tolerant path).
  recentlyPlayed: [],
  backlog: { count: 0, share: 0, items: [] },
  genres: [{ name: 'Action', count: 3, hours: 32 }],
  tags: [],
  scores: [],
  franchises: [],
  decades: [],
  years: [],
  timeline: [],
  achievementDays: [],
  streaks: [],
  metadata: {},
  gamesIndex,
};

const profileRow = {
  source: 'steam',
  userKey: '76561198038369983',
  key: KEY,
  personaName: 'hattivatt',
  gameCount: 3,
};

globalThis.fetch = async (url) => {
  const target = String(url);
  let body = {};
  if (target.startsWith('/api/games/profiles')) {
    body = { profiles: [profileRow], steamKey: { configured: true, source: 'file' } };
  } else if (target.startsWith('/api/games/stats')) {
    body = payload;
  } else if (target.startsWith('/api/games/personnel')) {
    body = { role: 'developer', persons: [] };
  } else if (target.startsWith('/api/games/franchises')) {
    body = { franchises: [] };
  } else if (target.startsWith('/api/games/enrich')) {
    body = { running: false };
  } else if (target.startsWith('/api/games/game/')) {
    const appid = Number(target.split('/').pop().split('?')[0]);
    body = {
      appid,
      name: appid === 462780 ? 'Darksiders Warmastered Edition' : 'Half-Life',
      // The card route already names the canonical edition (M5-B additive).
      primaryAppid: appid === 462780 ? 937 : appid,
    };
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

function images(host) {
  const found = [];
  walk(host, (node) => {
    if (node.tagName === 'IMG') found.push(node.getAttribute('src') || '');
  });
  return found;
}

async function wait(ms = 0) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('strip: two editions of one work paint one card with a wide header cover', async () => {
  const games = await import('../public/js/games.js');
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(60);

  const strip = nodeFor('games-recent-strip');
  assert.equal(nodeFor('games-recent-widget').hidden, false);
  // Darksiders (one canonical work, two editions) + Half-Life — never three.
  assert.equal(strip.children.length, 2);
  const names = strip.children.map((card) => textOf(card));
  assert.equal(names.filter((text) => /Darksiders/.test(text)).length, 1);
  assert.match(textOf(strip.children[0]), /Darksiders Warmastered Edition/);
  assert.match(textOf(strip.children[1]), /Half-Life/);

  // Every strip image is the wide cover of the canonical (primary) edition.
  const srcs = images(strip);
  assert.equal(srcs.length, 2);
  assert.deepEqual(srcs, [
    'https://cdn.cloudflare.steamstatic.com/steam/apps/937/header.jpg',
    'https://cdn.cloudflare.steamstatic.com/steam/apps/70/header.jpg',
  ]);
  for (const src of srcs) {
    assert.doesNotMatch(src, /steamcommunity\/public\/images/, '32×32 icon не должен быть обложкой');
  }

  // The card head of the modal uses the same wide cover (primary edition).
  strip.children[0].children[0].click();
  await wait(20);
  const modal = nodeFor('modal-root');
  const modalImages = images(modal);
  assert.ok(modalImages.length >= 1, 'в карточке нет обложки');
  assert.equal(modalImages[0], 'https://cdn.cloudflare.steamstatic.com/steam/apps/937/header.jpg');
  assert.match(textOf(modal).replace(/\s+/g, ' '), /Darksiders Warmastered Edition/);
});
