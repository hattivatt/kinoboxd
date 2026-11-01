'use strict';

/**
 * Epic import + isolated layer (M6b): ownership chain (entitlements > library
 * items, filters), playtime seconds, catalog metadata, deferred/auth-expired
 * degradation, owner binding, and the rule that Epic never changes Steam
 * hours (`hoursBySource` stays split).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-epic-import-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-epic-import-state-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = STATE_DIR;
process.env.KINOBOXD_GAMES_WD = 'off';

const epic = require('../server/games/epic');
const gameCache = require('../server/games/game-cache');
const epicCache = require('../server/games/epic-cache');
const epicImport = require('../server/games/epic-import');
const epicLayer = require('../server/games/epic-layer');
const tokenStore = require('../server/games/epic-token-store');
const { createFakeEpicClient } = require('./fixtures/games/epic/fake-client');

const ACCOUNT = 'epic-account-1';
const STEAM_ID = '76561198000000001';
const OWNER = `steam-${STEAM_ID}`;

function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function seedSteam() {
  await gameCache.saveProfile({
    userKey: STEAM_ID,
    personaName: 'SteamTester',
    privacy: 'public',
    importedAt: iso(),
    fetchedAt: iso(),
  });
  await gameCache.saveLibrary(STEAM_ID, {
    fetchedAt: iso(),
    partial: false,
    source: 'steam-webapi',
    game_count: 5,
    games: [
      { appid: 1, name: 'Steam One', playtime_forever: 3000, rtime_last_played: 0 },
      { appid: 2, name: 'Steam Two', playtime_forever: 3000, rtime_last_played: 0 },
    ],
    totalMinutes: 6000,
    fingerprint: 'steam-fingerprint',
  });
}

async function seedToken(accountId = ACCOUNT, ownerKey = null) {
  return tokenStore.saveTokens({
    accountId,
    displayName: 'EpicTester',
    ownerKey,
    accessToken: 'eg1~fake-access-token',
    refreshToken: 'eg1~fake-refresh-token',
    accessExpiresAt: iso(3600000),
    refreshExpiresAt: iso(7200000),
  });
}

test('full import: entitlements + library + playtime + catalog, filters applied', async () => {
  await seedSteam();
  await seedToken();
  const client = createFakeEpicClient();
  const job = await epicImport.startImport({
    accountId: ACCOUNT,
    ownerKey: OWNER,
    client,
    tokenStore,
    force: true,
  });
  assert.equal(job.status, 'running');
  await epicImport.whenIdle();
  const status = epicImport.getStatus(job.jobId);
  assert.equal(status.status, 'done');
  assert.equal(status.stage, 'done');
  assert.equal(status.done, true);
  assert.equal(status.deferred, false);
  assert.equal(status.code, null);
  assert.equal(status.owner, OWNER);
  assert.equal(status.displayName, 'EpicTester');
  assert.equal(status.gameCount, 4);
  assert.equal(status.ownedCount, 4);
  assert.equal(status.totalSeconds, 37800);
  assert.equal(status.totalMinutes, 630);
  assert.equal(status.totalHours, 10.5);
  assert.equal(status.playedCount, 2);
  assert.equal(status.backlogCount, 2);
  assert.equal(status.catalogCount, 4);
  // account + entitlements + 2 library pages + playtime + 3 catalog namespaces
  // + productmapping = 9
  assert.equal(status.requests, 9);

  const library = epicCache.getEpicLibrary(ACCOUNT);
  assert.equal(library.source, 'epic-entitlements+library');
  assert.equal(library.partial, false);
  assert.equal(library.ownerKey, OWNER);
  assert.equal(library.gameCount, 4);
  assert.equal(library.counts.entitlementCount, 4);
  assert.equal(library.counts.libraryCount, 3);
  assert.deepEqual(library.counts.excluded, {
    ue: 2,
    private: 1,
    mobile: 1,
    inactive: 1,
    consumable: 1,
    missingCatalogId: 1,
  });
  assert.ok(library.fingerprint);

  const playtime = epicCache.getEpicPlaytime(ACCOUNT);
  assert.equal(playtime.totalSeconds, 37800);
  assert.equal(playtime.totalMinutes, 630);

  const profile = epicCache.getEpicProfile(ACCOUNT);
  assert.equal(profile.ownerKey, OWNER);
  assert.equal(profile.displayName, 'EpicTester');

  // The Steam cache is untouched: Epic import never rewrites the journal.
  const steamLibrary = gameCache.getLibrary(STEAM_ID);
  assert.equal(steamLibrary.totalMinutes, 6000);
  assert.equal(steamLibrary.game_count, 5);
  assert.equal(steamLibrary.games.some((game) => game.source === 'epic'), false);
});

test('isolated layer: hoursBySource split, catalog metadata, exportedGames contract', async () => {
  const layer = await epicLayer.buildEpicLayer({ ownerKey: OWNER });
  assert.equal(layer.status, 'ok');
  assert.equal(layer.owner, OWNER);
  assert.equal(layer.accountId, ACCOUNT);
  assert.deepEqual(layer.hoursBySource, { steam: 100, epic: 10.5 });
  assert.deepEqual(layer.ownedBySource, { steam: 5, epic: 4 });
  assert.equal(layer.summary.ownedCount, 4);
  assert.equal(layer.summary.hours, 10.5);
  assert.equal(layer.summary.libraryExternalNumberCount, 4);
  assert.equal(layer.summary.externalOwnedCount, 4);
  assert.equal(layer.libraries.length, 1);
  assert.equal(layer.libraries[0].source, 'epic');
  assert.equal(layer.libraries[0].userKey, ACCOUNT);

  const witcher = layer.games.find(
    (game) => game.catalogItemId === '9d2d0eb64d5c44529cece33fe2a46482'
  );
  assert.ok(witcher);
  assert.equal(witcher.name, 'The Witcher 3: Wild Hunt');
  assert.equal(witcher.slug, 'the-witcher-3-wild-hunt');
  assert.equal(witcher.developer, 'CD PROJEKT RED');
  assert.equal(witcher.publisher, 'CD PROJEKT RED');
  assert.equal(witcher.totalTimeSec, 36000);
  assert.equal(witcher.totalMinutes, 600);
  assert.equal(witcher.hours, 10);
  assert.equal(witcher.playtimeKnown, true);
  assert.equal(witcher.lastPlayed, null);

  const control = layer.games.find(
    (game) => game.catalogItemId === '5c0e4c8b3a9f4c7e8d1b2a3c4d5e6f70'
  );
  assert.equal(control.slug, 'control'); // productmapping fallback
  assert.equal(control.hours, 0.5);

  const fortnite = layer.games.find(
    (game) => game.catalogItemId === '4fe75bbc5a674f4f9b356b5c90567da5'
  );
  assert.equal(fortnite.hours, 0);
  assert.equal(fortnite.platforms.includes('windows'), true);

  const entitlementOnly = layer.games.find(
    (game) => game.catalogItemId === 'entonly-item-000000000000000000'
  );
  assert.equal(entitlementOnly.appName, null);
  assert.equal(entitlementOnly.name, 'Entitlement Only Game');
  assert.equal(entitlementOnly.playtimeKnown, false);
  assert.equal(entitlementOnly.hours, null);
  assert.deepEqual(entitlementOnly.sources, ['entitlement']);

  assert.equal(layer.exportedGames.length, 4);
  for (const exported of layer.exportedGames) {
    assert.equal(exported.source, 'epic');
    assert.equal(exported.accountId, ACCOUNT);
    assert.equal(exported.owner, OWNER);
    assert.equal(exported.workKey, null);
    assert.equal(exported.steamAppId, null);
  }
  const exportedWitcher = layer.exportedGames.find(
    (game) => game.catalogItemId === '9d2d0eb64d5c44529cece33fe2a46482'
  );
  assert.equal(exportedWitcher.totalTimeSec, 36000);
  assert.equal(exportedWitcher.totalMinutes, 600);
});

test('a fresh snapshot is reused without requests; force re-imports', async () => {
  const client = createFakeEpicClient();
  const reused = await epicImport.startImport({
    accountId: ACCOUNT,
    ownerKey: OWNER,
    client,
    tokenStore,
  });
  assert.equal(reused.reused, true);
  assert.equal(reused.status, 'done');
  assert.equal(reused.requests, 0);
  assert.equal(client.calls.length, 0);

  const forced = await epicImport.startImport({
    accountId: ACCOUNT,
    ownerKey: OWNER,
    client,
    tokenStore,
    force: true,
  });
  await epicImport.whenIdle();
  const status = epicImport.getStatus(forced.jobId);
  assert.equal(status.status, 'done');
  // Catalog + productmapping are fresh: only account/entitlements/library/
  // playtime hit the fake client.
  assert.equal(status.requests, 5);
  assert.equal(client.calls.filter((call) => call.startsWith('catalog:')).length, 0);
  assert.equal(client.calls.includes('productmapping'), false);
});

test('playtime 5xx is deferred: the ownership snapshot stays, the old playtime is kept', async () => {
  const before = epicCache.getEpicLibrary(ACCOUNT);
  const client = createFakeEpicClient({
    fail: {
      getPlaytime: new epic.EpicError('Epic недоступен', 'epic_unreachable', {
        deferred: true,
      }),
    },
  });
  const job = await epicImport.startImport({
    accountId: ACCOUNT,
    ownerKey: OWNER,
    client,
    tokenStore,
    force: true,
  });
  await epicImport.whenIdle();
  const status = epicImport.getStatus(job.jobId);
  assert.equal(status.status, 'deferred');
  assert.equal(status.deferred, true);
  assert.equal(status.code, 'epic_unreachable');
  assert.equal(status.done, true);

  const after = epicCache.getEpicLibrary(ACCOUNT);
  assert.ok(after);
  assert.equal(after.gameCount, before.gameCount);
  assert.notEqual(after.fetchedAt, before.fetchedAt);
  const playtime = epicCache.getEpicPlaytime(ACCOUNT);
  assert.equal(playtime.totalSeconds, 37800);
});

test('a 401 is epic_auth_expired and leaves the previous snapshot intact', async () => {
  const before = epicCache.getEpicLibrary(ACCOUNT);
  const client = createFakeEpicClient({
    fail: {
      getAccount: new epic.EpicError('Epic отклонил токен', 'epic_auth_expired', {
        status: 401,
      }),
    },
  });
  const job = await epicImport.startImport({
    accountId: ACCOUNT,
    ownerKey: OWNER,
    client,
    tokenStore,
    force: true,
  });
  await epicImport.whenIdle();
  const status = epicImport.getStatus(job.jobId);
  assert.equal(status.status, 'failed');
  assert.equal(status.code, 'epic_auth_expired');
  const after = epicCache.getEpicLibrary(ACCOUNT);
  assert.equal(after.fetchedAt, before.fetchedAt);
  assert.equal(after.gameCount, before.gameCount);
});

test('an unconnected account is a 400-level error before a job exists', async () => {
  await tokenStore.deleteTokens(ACCOUNT);
  await assert.rejects(
    epicImport.startImport({ accountId: ACCOUNT, client: createFakeEpicClient() }),
    (err) => err.code === 'epic_not_connected'
  );
});

test('owner binding: one Epic account per owner, no cross-owner merge', async () => {
  await seedToken('epic-other-account', `steam-76561198000000002`);
  await epicCache.saveEpicProfile({
    accountId: 'epic-other-account',
    displayName: 'Other',
    ownerKey: `steam-76561198000000002`,
  });
  await seedToken(ACCOUNT, null);
  await assert.rejects(
    epicImport.startImport({
      accountId: 'epic-other-account',
      ownerKey: OWNER,
      client: createFakeEpicClient(),
    }),
    (err) => err.code === 'owner_mismatch'
  );
});

test('mergeLibrary filters UE/PRIVATE/mobile and keeps entitlement-only rows', () => {
  const merged = epic.mergeLibrary({
    entitlements: [
      { catalogItemId: 'a', namespace: 'fn', active: true, status: 'ACTIVE' },
      { catalogItemId: 'b', namespace: 'ue', active: true, status: 'ACTIVE' },
      { catalogItemId: 'c', namespace: 'fn', active: false, status: 'INACTIVE' },
    ],
    libraryItems: [
      { appName: 'A', namespace: 'fn', catalogItemId: 'a', platform: ['Windows'] },
      { appName: 'B', namespace: 'ue', catalogItemId: 'b', platform: ['Windows'] },
      { appName: 'D', namespace: 'fn', catalogItemId: 'd', sandboxType: 'PRIVATE' },
      { appName: 'E', namespace: 'fn', catalogItemId: 'e', platform: ['Android'] },
      { appName: 'F', namespace: 'fn', catalogItemId: 'f', platform: [] },
    ],
  });
  assert.deepEqual(
    merged.games.map((game) => game.catalogItemId).sort(),
    ['a', 'f']
  );
  assert.equal(merged.counts.excluded.ue, 2);
  assert.equal(merged.counts.excluded.inactive, 1);
  assert.equal(merged.counts.excluded.private, 1);
  assert.equal(merged.counts.excluded.mobile, 1);
  const a = merged.games.find((game) => game.catalogItemId === 'a');
  assert.deepEqual(a.sources.sort(), ['entitlement', 'library']);
  assert.equal(a.appName, 'A');
});
