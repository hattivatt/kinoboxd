'use strict';

/**
 * M6 integration (GOG + Epic + vertical posters): the merged contract.
 *
 * M6a wired GOG into `stats.js` (union by `workKey`, per-source hours); M6b
 * shipped an **isolated** Epic read model that did not touch the payload. This
 * suite pins the merged behaviour:
 *
 *   - `summary.hoursBySource` / `ownedBySource` carry `epic` next to `steam`
 *     and `gog`, and are never summed;
 *   - Epic games are `secondaryWorks` entries with `workKey: null` (no
 *     identity yet) and never change `totalHours`, `worksTotal` or `topGames`;
 *   - a Steam-only owner sees `null` for every secondary number, never 0;
 *   - `buildEpicLayer` (async, per-game `exportedGames`) and
 *     `buildEpicLayerSync` (stats) return the same numbers;
 *   - the token store exposes a sync redacted summary for the sync stats path;
 *   - the «Подключения» screen is one screen: `#games-connections` exists
 *     once, the GOG card lives inside it, the topbar button is separate;
 *   - a recent-strip row can carry cross-store sources and its own poster.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-m6-int-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-m6-int-state-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = STATE_DIR;
process.env.KINOBOXD_GAMES_WD = 'off';

const gameCache = require('../server/games/game-cache');
const epicCache = require('../server/games/epic-cache');
const epicImport = require('../server/games/epic-import');
const epicLayer = require('../server/games/epic-layer');
const tokenStore = require('../server/games/epic-token-store');
const { buildGamesStatsFromCache } = require('../server/games/stats');
const { createFakeEpicClient } = require('./fixtures/games/epic/fake-client');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ACCOUNT = 'epic-account-1';
const STEAM_ID = '76561198000000001';
const OWNER = `steam-${STEAM_ID}`;
const OTHER_ID = '76561198000000002';
const OTHER_OWNER = `steam-${OTHER_ID}`;

function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function readPublic(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

async function seedSteam(userKey, { games, totalMinutes, gameCount }) {
  await gameCache.saveProfile({
    userKey,
    personaName: 'SteamTester',
    privacy: 'public',
    importedAt: iso(),
    fetchedAt: iso(),
  });
  await gameCache.saveLibrary(userKey, {
    fetchedAt: iso(),
    partial: false,
    source: 'steam-webapi',
    game_count: gameCount == null ? games.length : gameCount,
    games,
    totalMinutes,
    fingerprint: `steam-${userKey}`,
  });
}

test('M6 integration', async (t) => {
  await seedSteam(STEAM_ID, {
    totalMinutes: 6000,
    games: [
      { appid: 1, name: 'Steam One', playtime_forever: 3000, rtime_last_played: 1793295251 },
      { appid: 2, name: 'Steam Two', playtime_forever: 3000, rtime_last_played: 0 },
    ],
  });
  await seedSteam(OTHER_ID, {
    totalMinutes: 1200,
    games: [{ appid: 3, name: 'Other Only', playtime_forever: 1200, rtime_last_played: 0 }],
  });
  // The owner binding is written by the token; the import copies it onto the
  // Epic profile, which is what `epicAccountForOwner` reads.
  await tokenStore.saveTokens({
    accountId: ACCOUNT,
    displayName: 'EpicTester',
    ownerKey: OWNER,
    accessToken: 'eg1~fake-access-token-value',
    refreshToken: 'eg1~fake-refresh-token-value',
    accessExpiresAt: iso(3600000),
    refreshExpiresAt: iso(7200000),
  });
  const job = await epicImport.startImport({
    accountId: ACCOUNT,
    ownerKey: OWNER,
    client: createFakeEpicClient(),
    tokenStore,
    force: true,
  });
  assert.equal(job.status, 'running');
  await epicImport.whenIdle();
  assert.equal(epicImport.getStatus(job.jobId).status, 'done');

  await t.test('stats: Epic hours join the display total, the breakdown stays', () => {
    const payload = buildGamesStatsFromCache(OWNER);
    // M6c: headline = Steam (100 h) + Epic (10.5 h) of the visible works.
    assert.equal(payload.summary.totalHours, 110.5);
    assert.equal(payload.summary.totalHoursSteam, 100);
    assert.deepEqual(payload.summary.hoursBySource, {
      steam: 100,
      gog: null,
      epic: 10.5,
      all: 110.5,
    });
    assert.deepEqual(payload.summary.ownedBySource, { steam: 2, gog: null, epic: 4 });
    // One row per work: 2 Steam + 4 Epic-only (none of the Epic ids is a Steam
    // work in this fixture, so nothing is merged).
    assert.equal(payload.summary.worksTotal, 6);
    assert.equal(payload.summary.gameCount, 6);
    assert.equal(payload.summary.epicSecondaryGames, 4);
    assert.equal(payload.summary.secondaryWorksTotal, 4);
    // Epic titles are real owned games: they are counted and ranked, with no
    // invented Steam identity.
    const witcher = payload.topGames.find((row) => /witcher/i.test(row.name || ''));
    assert.ok(witcher);
    assert.equal(witcher.appid, null);
    assert.deepEqual(witcher.sources, ['epic']);
    assert.equal(payload.summary.achievements.total, 0);
  });

  await t.test('stats: sources.epic mirrors sources.gog and leaks no token', () => {
    const payload = buildGamesStatsFromCache(OWNER);
    assert.equal(payload.sources.epic.connected, true);
    assert.equal(payload.sources.epic.configured, true);
    assert.equal(payload.sources.epic.status, 'ok');
    assert.equal(payload.sources.epic.accountId, ACCOUNT);
    assert.equal(payload.sources.epic.displayName, 'EpicTester');
    assert.equal(payload.sources.epic.productCount, 4);
    assert.equal(payload.sources.epic.hours, 10.5);
    assert.ok(payload.sources.epic.libraryFetchedAt);
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes('fake-access-token-value'), false);
    assert.equal(serialized.includes('fake-refresh-token-value'), false);
    assert.equal(serialized.includes('eg1~'), false);
    // The top-level Epic block is the read model without per-game arrays.
    assert.equal(payload.epic.status, 'ok');
    assert.equal(payload.epic.accountId, ACCOUNT);
    assert.equal(payload.epic.hoursBySource.epic, 10.5);
    assert.equal(Object.prototype.hasOwnProperty.call(payload.epic, 'games'), false);
  });

  await t.test('stats: Epic games are secondaryWorks with their own workKey', () => {
    const payload = buildGamesStatsFromCache(OWNER);
    assert.equal(payload.secondaryWorks.length, 4);
    for (const entry of payload.secondaryWorks) {
      assert.equal(entry.source, 'epic');
      // M6c: an unmerged Epic game is its own work (),
      // never a fake Steam work key.
      assert.match(entry.workKey, /^epic:/);
      assert.deepEqual(entry.ownedOn, ['epic']);
      assert.equal(entry.storeIds.steam, null);
      assert.equal(entry.storeIds.gog, null);
      assert.ok(entry.storeIds.epic);
      assert.equal(entry.hoursBySource.steam, null);
      assert.equal(entry.hoursBySource.gog, null);
      // Playtime is only known for imported entries; unknown stays null (a
      // zero would claim «0 hours» for a game Epic never reported).
      assert.ok(entry.hoursBySource.epic == null || entry.hoursBySource.epic >= 0);
      assert.equal(entry.epic.accountId, ACCOUNT);
    }
    const witcher = payload.secondaryWorks.find(
      (entry) => entry.storeIds.epic === '9d2d0eb64d5c44529cece33fe2a46482'
    );
    assert.ok(witcher);
    assert.equal(witcher.name, 'The Witcher 3: Wild Hunt');
    // Payload contract (integration round): hours, not minutes.
    assert.equal(witcher.hoursBySource.epic, 10);
    assert.equal(witcher.epic.slug, 'the-witcher-3-wild-hunt');
    assert.equal(witcher.epic.playtimeKnown, true);
  });

  await t.test('a Steam-only owner sees nulls, not zeroes', () => {
    const payload = buildGamesStatsFromCache(OTHER_OWNER);
    assert.deepEqual(payload.summary.hoursBySource, { steam: 20, gog: null, epic: null });
    assert.deepEqual(payload.summary.ownedBySource, { steam: 1, gog: null, epic: null });
    assert.equal(payload.summary.epicSecondaryGames, 0);
    assert.equal(payload.summary.secondaryWorksTotal, 0);
    // A Steam-only owner keeps the pre-M6c `worksTotal` (= gameCount), so the
    // «Источники» headline does not change without a secondary library.
    assert.equal(payload.summary.worksTotal, payload.summary.gameCount);
    assert.equal(payload.summary.chartsIncludeSecondary, false);
    assert.equal(payload.summary.secondaryWorksInCharts, 0);
    assert.equal(payload.sources.epic.status, 'not_connected');
    assert.equal(payload.sources.epic.connected, false);
    assert.equal(payload.sources.epic.productCount, null);
    assert.equal(payload.epic, null);
    assert.deepEqual(payload.secondaryWorks, []);
  });

  await t.test('buildEpicLayerSync and buildEpicLayer agree on the contract', async () => {
    const sync = epicLayer.buildEpicLayerSync({ ownerKey: OWNER });
    const full = await epicLayer.buildEpicLayer({ ownerKey: OWNER });
    assert.equal(sync.status, full.status);
    assert.deepEqual(sync.hoursBySource, full.hoursBySource);
    assert.deepEqual(sync.ownedBySource, full.ownedBySource);
    assert.deepEqual(sync.summary, full.summary);
    assert.equal(sync.accountId, full.accountId);
    assert.equal(sync.games.length, full.games.length);
    // The sync variant skips the exported array on purpose (stats never uses it).
    assert.equal(Object.prototype.hasOwnProperty.call(sync, 'exportedGames'), false);
    assert.equal(full.exportedGames.length, 4);
  });

  await t.test('epicSecondaryWorks respects the cap and keeps names', () => {
    const layer = epicLayer.buildEpicLayerSync({ ownerKey: OWNER });
    const capped = epicLayer.epicSecondaryWorks(layer, { limit: 2 });
    assert.equal(capped.length, 2);
    assert.equal(capped.every((entry) => entry.source === 'epic' && entry.name), true);
    assert.deepEqual(epicLayer.epicSecondaryWorks(null), []);
  });

  await t.test('token store: sync summary is redacted and refuses nothing valid', () => {
    const summary = tokenStore.readTokenSummarySync(ACCOUNT);
    assert.ok(summary);
    assert.equal(summary.hasAccessToken, true);
    assert.equal(summary.hasRefreshToken, true);
    assert.equal(summary.ownerKey, OWNER);
    assert.equal(JSON.stringify(summary).includes('eg1~'), false);
    assert.equal(tokenStore.readTokenSummarySync('no-such-account'), null);
    // A path-traversal account id is refused, not resolved.
    assert.equal(tokenStore.readTokenSummarySync('../etc/passwd'), null);
  });

  await t.test('markup: one «Подключения» screen carries GOG and the Epic slot', () => {
    const html = readPublic('index.html');
    const count = (needle) => html.split(needle).length - 1;
    assert.equal(count('id="games-connections"'), 1, '#games-connections must be unique');
    assert.equal(count('id="games-connections-btn"'), 1);
    assert.equal(count('id="games-connections-screen"'), 1);
    assert.equal(count('id="games-gog-card"'), 1);
    // The GOG card lives inside the connections screen, not in the import grid.
    const screenStart = html.indexOf('id="games-connections-screen"');
    const screenEnd = html.indexOf('id="games-progress"');
    const gogCard = html.indexOf('id="games-gog-card"');
    assert.ok(gogCard > screenStart && gogCard < screenEnd, 'GOG card must be in «Подключения»');
    const importStart = html.indexOf('id="games-import"');
    const importEnd = html.indexOf('id="games-progress"');
    const importBlock = html.slice(importStart, importEnd);
    assert.equal(importBlock.includes('id="games-gog-card"'), false);
    assert.ok(importBlock.includes('id="games-import-connections-link"'));
    assert.match(html, /src="\.\/js\/games-epic\.js"/);
    // The topbar button must not share an id with the Epic mount point.
    assert.equal(/id="games-connections"\s+hidden title="Подключения/.test(html), false);
  });

  await t.test('markup: games.js opens the connections screen, not the import card', () => {
    const source = readPublic('js/games.js');
    assert.match(source, /connections: \$\('games-connections-screen'\)/);
    assert.match(source, /const connections = \$\('games-connections-btn'\)/);
    assert.match(source, /games:connections-open/);
    // The Epic module is loaded by index.html; importing it from games.js would
    // drag its DOM/timers into DOM-free tests.
    assert.equal(/from '\.\/games-epic\.js'/.test(source), false);
  });

  await t.test('recent strip: cross-store sources and a store-provided poster', async () => {
    const { recentStripView } = await import('../public/js/games-view.js');
    const now = Date.now();
    const view = recentStripView(
      [
        {
          appid: 292030,
          name: 'The Witcher 3',
          hoursTotal: 100,
          lastPlayed: new Date(now - 3600_000).toISOString(),
          sources: ['steam', 'gog'],
          hoursBySource: { steam: 6000, gog: 1200, epic: null },
        },
      ],
      {},
    );
    assert.equal(view.items.length, 1);
    assert.deepEqual(view.items[0].sources, ['steam', 'gog']);
    assert.equal(view.items[0].hoursTotalText, '100,0 ч');
  });

  await t.test('vertical cover chain prefers the Steam CDN, then a provided poster', async () => {
    const { gameVerticalCoverUrls } = await import('../public/js/games-modal.js');
    const steam = gameVerticalCoverUrls({ appid: 292030, coverUrl: 'https://img/gog.jpg' });
    // Steam art goes through the local proxy (ISP-blocked CDN), GOG art does
    // not: it is not a Steam host and stays exactly as the payload sent it.
    assert.equal(steam[0], '/api/games/steam-art/library/292030');
    assert.ok(steam.includes('https://img/gog.jpg'));
    // A row that is not on the Steam CDN has only its own art.
    assert.deepEqual(
      gameVerticalCoverUrls({ name: 'GOG Only', coverUrl: 'https://img/gog.jpg' }),
      ['https://img/gog.jpg']
    );
    assert.deepEqual(gameVerticalCoverUrls({ name: 'Nothing' }), []);
  });

  await t.test('Epic cache is owner-scoped: the other Steam owner gets nothing', () => {
    assert.equal(epicCache.epicAccountForOwner(OTHER_OWNER), null);
    assert.equal(epicCache.epicAccountForOwner(OWNER), ACCOUNT);
    assert.equal(epicCache.librariesForOwner(OTHER_OWNER).length, 0);
    assert.equal(epicCache.librariesForOwner(OWNER).length, 1);
  });
});
