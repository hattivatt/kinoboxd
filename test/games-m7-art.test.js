'use strict';

/**
 * Games M7: real store artwork from `appdetails.header_image` and the
 * «nullnull» card regression.
 *
 * The defect (live 02.11.2026): new Steam SKUs live under
 * `store_item_assets/steam/apps/<appid>/<asset-hash>/…`; the legacy
 * `<cdn>/steam/apps/<appid>/header.jpg` path 404s (CONTROL Resonant,
 * appid 3669870), so the card fell back to initials even though every metadata
 * field arrived. The fix stores the real `header_image`/`capsule_image` URLs;
 * since 03.11.2026 the asset hash of that header is also used to request the
 * true vertical `library_600x900.jpg` of the same SKU first, and the landscape
 * header is only a fallback (the «обрезанный арт» bug).
 *
 * The second defect: `Node.append(null)` stringifies `null` into a text node,
 * so two empty rows (DLC count + release date) painted «nullnull». `detailRow`
 * already returned `null`; the call site must not append it.
 *
 * This file covers the server document, the `/stats` index, the URL chain and
 * the real card modal against the headless DOM shim. No network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-m7-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-m7-state-'));

const store = require('../server/games/store');
const gameCache = require('../server/games/game-cache');
const { buildGamesStatsFromCache } = require('../server/games/stats');
const { installDom, textOf, FakeNode } = require('./helpers/dom-shim');
const { readFixture } = require('./fixtures/games/fake-client');

const ID = '76561198000000777';
const PROFILE_KEY = `steam-${ID}`;

const NEW_HEADER = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3669870/1e0c76e4253d347bb1304c3f213570251d924edf/header.jpg?t=1793357289';
const NEW_CAPSULE = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3669870/867a73afa5f21c28aaa14e9b0a4d895c540d4a0c/capsule_231x87.jpg?t=1793357289';

function detailDoc(appid, extra = {}) {
  return {
    appid,
    success: true,
    type: 'game',
    name: `Game ${appid}`,
    is_free: false,
    developers: ['Remedy'],
    publishers: ['505 Games'],
    genres: [{ id: '1', description: 'Action' }],
    categories: [{ id: '2', description: 'Single-player' }],
    release_date: { date: 'Sep 24, 2026', coming_soon: false, year: 2026, precision: 'year' },
    releaseYear: 2026,
    releasePrecision: 'year',
    dlc: [],
    dlcCount: 0,
    metacritic: null,
    platforms: { windows: true, mac: false, linux: false },
    headerImage: NEW_HEADER,
    capsuleImage: NEW_CAPSULE,
    screenshots: [],
    earlyAccess: false,
    metadataSource: 'steam-store',
    ...extra,
  };
}

function libraryRow(appid, name, minutes, rtime = 0) {
  return {
    appid,
    name,
    playtime_forever: minutes,
    playtime_2weeks: 0,
    rtime_last_played: rtime,
    img_icon_url: '',
  };
}

async function seedLibrary(games, details) {
  const now = new Date().toISOString();
  await gameCache.saveProfile({
    userKey: ID,
    personaName: 'art-tester',
    privacy: 'public',
    importedAt: now,
    fetchedAt: now,
  });
  await gameCache.saveLibrary(ID, {
    fetchedAt: now,
    partial: false,
    source: 'steam-webapi',
    game_count: games.length,
    games,
    totalMinutes: games.reduce((sum, game) => sum + game.playtime_forever, 0),
  });
  for (const [appid, doc] of Object.entries(details)) {
    await gameCache.saveDetails(Number(appid), doc);
  }
}

/* =========================================================
   1. store document
   ========================================================= */

test('store: appdetails keeps header_image/capsule_image as absolute URLs', () => {
  const doc = store.parseAppDetailsResponse(
    JSON.parse(readFixture('appdetails-620.json')),
    620
  ).doc;
  assert.equal(
    doc.headerImage,
    'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/aaa111/header.jpg?t=1700000000'
  );
  assert.equal(
    doc.capsuleImage,
    'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/bbb222/capsule_231x87.jpg?t=1700000000'
  );
});

test('store: a relative/non-http art value is dropped, not guessed', () => {
  const doc = store.parseAppDetailsResponse({
    123: {
      success: true,
      data: { name: 'Relative art', header_image: '/steam/apps/123/header.jpg', capsule_image: null },
    },
  }, 123).doc;
  assert.equal(doc.headerImage, null);
  assert.equal(doc.capsuleImage, null);
});

/* =========================================================
   2. /stats gamesIndex
   ========================================================= */

test('/stats gamesIndex: headerImage comes from the details document', async () => {
  await seedLibrary(
    [libraryRow(3669870, 'CONTROL Resonant', 120, 1793000000)],
    { 3669870: detailDoc(3669870) }
  );
  const stats = buildGamesStatsFromCache(PROFILE_KEY);
  assert.equal(stats.gamesIndex[3669870].headerImage, NEW_HEADER);
  assert.equal(stats.recentlyPlayed[0].headerImage, NEW_HEADER);
});

test('/stats gamesIndex: the primary edition header wins for every edition', async () => {
  await seedLibrary(
    [
      libraryRow(937, 'Darksiders', 600),
      libraryRow(462780, 'Darksiders Warmastered Edition', 60),
    ],
    {
      937: detailDoc(937, {
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/937/a/header.jpg',
      }),
      462780: detailDoc(462780, {
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/462780/b/header.jpg',
        releaseYear: 2016,
        release_date: { date: 'Nov 29, 2016', coming_soon: false, year: 2016, precision: 'day' },
      }),
    }
  );
  const stats = buildGamesStatsFromCache(PROFILE_KEY);
  assert.equal(stats.gamesIndex[462780].primaryAppid, 937);
  assert.equal(
    stats.gamesIndex[462780].headerImage,
    'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/937/a/header.jpg',
    'an edition paints the primary edition header'
  );
});

/* =========================================================
   3. card chain
   ========================================================= */

test('vertical chain: a new-schema header_image gives the vertical capsule its hash', async () => {
  const { configureGamesModals, gameVerticalCoverUrls } = await import('../public/js/games-modal.js');
  configureGamesModals({ gamesIndex: {}, secondaryWorks: [] });
  const art = '/api/games/steam-art';
  // Bug 03.11.2026 (Aseprite/Brotato/Control Resonant): the landscape
  // `header.jpg` was painted first because the asset hash was only used for
  // the header. The true `library_600x900.jpg` of the same SKU comes first.
  assert.deepEqual(gameVerticalCoverUrls({ appid: 3669870, headerImage: NEW_HEADER }), [
    `${art}/library/3669870?h=1e0c76e4253d347bb1304c3f213570251d924edf`,
    `${art}/library/3669870`,
    `${art}/header/3669870?h=1e0c76e4253d347bb1304c3f213570251d924edf`,
    `${art}/header/3669870`,
    `${art}/capsule/3669870`,
  ]);
});

test('vertical chain: gamesIndex[primaryAppid].headerImage wins over the row', async () => {
  const { configureGamesModals, gameVerticalCoverUrls } = await import('../public/js/games-modal.js');
  configureGamesModals({
    gamesIndex: {
      937: {
        appid: 937,
        headerImage: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/937/a/header.jpg',
      },
    },
    secondaryWorks: [],
  });
  assert.equal(
    gameVerticalCoverUrls({ appid: 462780, primaryAppid: 937 })[0],
    '/api/games/steam-art/library/937?h=a'
  );
});

test('vertical chain: a legacy header stays behind the vertical library capsule', async () => {
  const { configureGamesModals, gameVerticalCoverUrls } = await import('../public/js/games-modal.js');
  configureGamesModals({ gamesIndex: {}, secondaryWorks: [] });
  const cdn = 'https://cdn.cloudflare.steamstatic.com/steam/apps';
  const art = '/api/games/steam-art';
  assert.deepEqual(
    gameVerticalCoverUrls({
      appid: 70,
      headerImage: `${cdn}/70/header.jpg`,
      capsuleImage: 'https://shared.akamai.steamstatic.com/70/capsule.jpg',
      screenshot: 'https://shared.akamai.steamstatic.com/70/ss.jpg',
    }),
    [
      `${art}/library/70`,
      `${art}/header/70`,
      'https://shared.akamai.steamstatic.com/70/capsule.jpg',
      'https://shared.akamai.steamstatic.com/70/ss.jpg',
      `${art}/capsule/70`,
    ]
  );
});

test('landscape chain: header_image, capsule, then the legacy CDN path', async () => {
  const { configureGamesModals, gameCoverUrls } = await import('../public/js/games-modal.js');
  configureGamesModals({ gamesIndex: {}, secondaryWorks: [] });
  const art = '/api/games/steam-art';
  assert.deepEqual(
    gameCoverUrls({ appid: 3669870, headerImage: NEW_HEADER, capsuleImage: NEW_CAPSULE }),
    [
      `${art}/header/3669870?h=1e0c76e4253d347bb1304c3f213570251d924edf`,
      `${art}/capsule/3669870?h=867a73afa5f21c28aaa14e9b0a4d895c540d4a0c`,
      `${art}/header/3669870`,
      `${art}/capsule/3669870`,
    ]
  );
});

/* =========================================================
   4. card modal (DOM): real header paints, no «nullnull»
   ========================================================= */

function cardPayload(extraDetails = {}) {
  return {
    appid: 3669870,
    name: 'CONTROL Resonant',
    hours: 2,
    details: {
      type: 'game',
      name: 'CONTROL Resonant',
      isFree: false,
      developers: ['Remedy'],
      publishers: ['505 Games'],
      genres: ['Action'],
      categories: ['Single-player'],
      releaseDate: 'Sep 24, 2026',
      releaseYear: 2026,
      earlyAccess: false,
      metacritic: null,
      dlc: [4403940],
      dlcCount: 1,
      platforms: { windows: true, mac: false, linux: false },
      headerImage: NEW_HEADER,
      capsuleImage: NEW_CAPSULE,
      screenshots: [],
      ...extraDetails,
    },
    achievements: null,
    personnel: null,
    links: { steam: 'https://store.steampowered.com/app/3669870' },
  };
}

function findCover(root) {
  let found = null;
  const walk = (node) => {
    if (!node || found) return;
    if (String(node.className || '').includes('modal-game-cover')) {
      found = node;
      return;
    }
    for (const child of node.children || []) walk(child);
  };
  walk(root);
  return found;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('card modal: paints the vertical capsule derived from appdetails header_image', async () => {
  const { nodeFor } = installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });
  const payload = cardPayload();
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    async json() { return payload; },
    async text() { return JSON.stringify(payload); },
  });
  try {
    const modal = await import('../public/js/games-modal.js');
    modal.configureGamesModals({ profile: '', gamesIndex: {}, secondaryWorks: [] });
    modal.openGameCardModal(3669870);
    await wait(120);
    const cover = findCover(nodeFor('modal-root'));
    assert.ok(cover, 'the card head has a cover');
    assert.equal(cover.tagName, 'IMG');
    // The card must ask the local proxy, never the blocked CDN host: the
    // new-schema asset hash becomes `?h=` on the vertical capsule request.
    assert.equal(
      cover.getAttribute('src'),
      '/api/games/steam-art/library/3669870?h=1e0c76e4253d347bb1304c3f213570251d924edf'
    );
  } finally {
    delete globalThis.fetch;
  }
});

test('card modal: empty DLC/release fields append no null text («nullnull»)', async () => {
  const { nodeFor } = installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });
  const payload = cardPayload({
    genres: [],
    categories: [],
    developers: [],
    publishers: [],
    platforms: null,
    releaseDate: null,
    dlc: [],
    dlcCount: null,
  });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    async json() { return payload; },
    async text() { return JSON.stringify(payload); },
  });
  const appended = [];
  const originalAppend = FakeNode.prototype.append;
  FakeNode.prototype.append = function append(...children) {
    for (const child of children.flat(Infinity)) if (child == null) appended.push(child);
    return originalAppend.apply(this, children);
  };
  try {
    const modal = await import('../public/js/games-modal.js');
    modal.configureGamesModals({ profile: '', gamesIndex: {}, secondaryWorks: [] });
    modal.openGameCardModal(3669870);
    await wait(120);
    const text = textOf(nodeFor('modal-root')).replace(/\s+/g, ' ');
    assert.equal(appended.length, 0, 'no Node.append(null): a browser would paint «null»');
    assert.doesNotMatch(text, /nullnull/);
    assert.doesNotMatch(text, /\bnull\b/);
  } finally {
    FakeNode.prototype.append = originalAppend;
    delete globalThis.fetch;
  }
});
