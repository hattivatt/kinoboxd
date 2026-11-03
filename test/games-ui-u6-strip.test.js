'use strict';

/**
 * Games U6: «Недавно играл» — one card per canonical work, vertical posters.
 *
 * The strip used to paint the payload's `recentlyPlayed` rows *and* every
 * `gamesIndex` entry, so two store editions of one work could appear twice.
 * This smoke drives the real `games.js`: the index carries two Darksiders
 * editions, the strip must paint one card, and every card/modal image must be
 * the vertical `library_600x900` poster (not the stretched 32×32 community
 * icon and not the landscape `header.jpg` while a vertical exists).
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

const STORE = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps';
const HASH_937 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
const HASH_462780 = 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3';
const HASH_70 = '0011aabbccddeeff0011aabbccddeeff0011aabb';

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
    // Post-2024 store schema: every asset of the SKU lives under this hash,
    // so the real vertical `library_600x900.jpg` is requestable via `?h=`.
    headerImage: `${STORE}/937/${HASH_937}/header.jpg`,
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
    // The edition has its own hash; the card must still paint the primary's.
    headerImage: `${STORE}/462780/${HASH_462780}/header.jpg`,
  }),
  70: game(70, 'Half-Life', {
    hours: 11,
    rtime: tenDaysAgo,
    lastPlayed: new Date(tenDaysAgo * 1000).toISOString(),
    canonicalWorkKey: 'steam:70',
    primaryAppid: 70,
    iconUrl: 'https://media.steampowered.com/steamcommunity/public/images/apps/70/icon.jpg',
    headerImage: `${STORE}/70/${HASH_70}/header.jpg`,
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

test('strip: two editions of one work paint one card with a vertical poster', async () => {
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

  // Every strip image is the vertical library capsule of the canonical
  // (primary) edition, in the primary's own store-asset hash — the same 2:3
  // shape as books/films. The landscape header is never the first poster.
  const srcs = images(strip);
  assert.equal(srcs.length, 2);
  assert.deepEqual(srcs, [
    `/api/games/steam-art/library/937?h=${HASH_937}`,
    `/api/games/steam-art/library/70?h=${HASH_70}`,
  ]);
  for (const src of srcs) {
    assert.doesNotMatch(src, /steamcommunity\/public\/images/, '32×32 icon не должен быть обложкой');
    assert.doesNotMatch(src, /\/header\.jpg$/, 'вертикальный capsule важнее ландшафтного header');
    assert.match(src, /^\/api\/games\/steam-art\//, 'Steam-арт идёт через CDN-прокси');
  }
  assert.ok(
    srcs.every((src) => !src.includes(HASH_462780)),
    'издание не подменяет hash primary-издания',
  );
  // The art frame and the image carry the classes the CSS sizes to 2:3.
  for (const card of strip.children) {
    const art = card.children.find((node) => String(node.className || '').includes('games-recent-art'));
    assert.ok(art, 'карточка без .games-recent-art');
    const img = art.children.find((node) => node.tagName === 'IMG');
    assert.equal(img.className, 'games-recent-icon');
  }

  // The card head of the modal uses the same vertical poster (primary edition).
  strip.children[0].children[0].click();
  await wait(20);
  const modal = nodeFor('modal-root');
  const modalImages = images(modal);
  assert.ok(modalImages.length >= 1, 'в карточке нет обложки');
  assert.equal(modalImages[0], `/api/games/steam-art/library/937?h=${HASH_937}`);
  assert.match(textOf(modal).replace(/\s+/g, ' '), /Darksiders Warmastered Edition/);
});

test('strip view: a payload row headerImage survives without a gamesIndex copy', async () => {
  const { recentStripView } = await import('../public/js/games-view.js');
  const now = Date.UTC(2026, 10, 3);
  const rtime = Math.floor(now / 1000) - 3 * 86400;
  const header = `${STORE}/431730/${HASH_70}/header.jpg`;
  const view = recentStripView(
    [{
      appid: 431730,
      name: 'Aseprite',
      hours2w: 0.4,
      hoursTotal: 12,
      lastPlayed: new Date(rtime * 1000).toISOString(),
      headerImage: header,
    }],
    {},
    { now },
  );
  assert.equal(view.items.length, 1);
  // The card face must carry the store header, otherwise the hashed vertical
  // capsule cannot be built and the landscape `header.jpg` is painted.
  assert.equal(view.items[0].headerImage, header);
  assert.equal(view.items[0].primaryAppid, 431730);
});
