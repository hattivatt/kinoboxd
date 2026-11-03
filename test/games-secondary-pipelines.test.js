'use strict';

/**
 * Secondary-only pipelines (03.11.2026): GOG/Epic exclusives get a Wikidata
 * franchise (P179 by QID) and take part in the personnel/franchise aggregates.
 *
 * The reference case is Alan Wake 2 (Epic exclusive): it must show up under
 * Remedy Entertainment with its Epic hours and inside the «Alan Wake» series
 * together with the Steam title of the same owner. Everything here is a cache
 * read or an injected provider — no live WDQS/GOG/Epic request.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-secondary-pipe-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-secondary-pipe-state-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = STATE_DIR;
process.env.KINOBOXD_MOBY_KEY_FILE = path.join(STATE_DIR, 'no-moby-token');

const gameCache = require('../server/games/game-cache');
const franchise = require('../server/games/franchise');
const aggregate = require('../server/games/franchise-aggregate');
const personnel = require('../server/games/personnel/personnel');
const secondary = require('../server/games/secondary');
const secondaryStore = require('../server/games/secondary/store');
const epicCache = require('../server/games/epic-cache');
const tokenStore = require('../server/games/epic-token-store');
const { buildGamesStatsFromCache } = require('../server/games/stats');

const ID = '76561198000000901';
const OWNER = `steam-${ID}`;
const ACCOUNT = 'epic-account-aw2';
const AW2_QID = 'Q108417001';
const ALAN_WAKE_FRANCHISE = 'Q211910';

const QID_FRANCHISE_FIXTURE = {
  results: {
    bindings: [
      {
        game: { value: `http://www.wikidata.org/entity/${AW2_QID}` },
        franchise: { value: `http://www.wikidata.org/entity/${ALAN_WAKE_FRANCHISE}` },
        franchiseEn: { value: 'Alan Wake' },
        franchiseRu: { value: 'Alan Wake' },
      },
      {
        game: { value: 'http://www.wikidata.org/entity/Q424242' },
      },
    ],
  },
};

function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function fakeProvider(calls = []) {
  return {
    async runBatched(values, buildQuery, keyBy, options) {
      calls.push({ values: [...values], query: buildQuery(values), keyBy });
      return {
        credits: options.parse(QID_FRANCHISE_FIXTURE),
        queries: 1,
        batches: 1,
        errors: [],
        disabledUntil: null,
      };
    },
  };
}

async function seedSteam() {
  await gameCache.saveProfile({
    userKey: ID,
    personaName: 'aw-tester',
    privacy: 'public',
    importedAt: iso(),
    fetchedAt: iso(),
  });
  await gameCache.saveLibrary(ID, {
    fetchedAt: iso(),
    partial: false,
    source: 'steam-webapi',
    game_count: 1,
    games: [{ appid: 108710, name: 'Alan Wake', playtime_forever: 600 }],
    totalMinutes: 600,
  });
  await gameCache.saveDetails(108710, {
    appid: 108710,
    success: true,
    type: 'game',
    name: 'Alan Wake',
    developers: ['Remedy Entertainment'],
    publishers: ['Microsoft Studios'],
    genres: [{ description: 'Action' }],
    categories: [],
    releaseYear: 2010,
    releasePrecision: 'day',
    headerImage: 'https://cdn.example.invalid/aw.jpg',
  });
  franchise.writeLinksDoc(108710, {
    fetchedAt: iso(),
    franchiseKey: `wd:${ALAN_WAKE_FRANCHISE}`,
    sources: ['wikidata'],
    wikidata: {
      qid: 'Q1086783',
      franchise: { qid: ALAN_WAKE_FRANCHISE, labelEn: 'Alan Wake', labelRu: 'Alan Wake' },
      releaseYear: 2010,
      releasePrecision: 'day',
      releaseDate: '2010-05-14',
      resolved: true,
      fetchedAt: iso(),
    },
  });
  await personnel.savePersonnelDoc(108710, {
    fetchedAt: iso(),
    qid: 'Q1086783',
    sources: ['steam-store', 'wikidata'],
    studios: [
      {
        name: 'Remedy Entertainment',
        nameEn: 'Remedy Entertainment',
        nameRu: null,
        qid: 'Q735227',
        mobyId: null,
        roles: ['developer'],
        roleSource: 'wikidata',
        source: 'wikidata',
        confidence: 'high',
      },
    ],
    people: [],
  });
}

async function seedEpicAlanWake2() {
  await epicCache.saveEpicProfile({
    accountId: ACCOUNT,
    ownerKey: OWNER,
    displayName: 'EpicTester',
    connectedAt: iso(-86400000),
    importedAt: iso(),
    libraryFetchedAt: iso(),
    gameCount: 1,
    totalHours: 54.5,
  });
  await tokenStore.saveTokens({
    accountId: ACCOUNT,
    displayName: 'EpicTester',
    ownerKey: OWNER,
    accessToken: 'eg1~fake-access-token-value',
    refreshToken: 'eg1~fake-refresh-token-value',
    accessExpiresAt: iso(3600000),
    refreshExpiresAt: iso(7200000),
  });
  await epicCache.saveEpicLibrary(ACCOUNT, {
    fetchedAt: iso(),
    games: [
      {
        appName: 'AlanWake2',
        catalogItemId: 'cat-aw2',
        namespace: 'ns-aw2',
        name: 'Alan Wake 2',
        slug: 'alan-wake-2',
        sandboxType: 'PUBLIC',
      },
    ],
  });
  await epicCache.saveEpicPlaytime(ACCOUNT, {
    fetchedAt: iso(),
    byArtifactId: {
      'cat-aw2': { totalTimeSec: 196200, totalMinutes: 3270, totalHours: 54.5 },
    },
  });
  // Store metadata: developers/publishers/genres/poster of the Epic product.
  secondaryStore.writeDetail('epic', 'alan-wake-2', 'ok', {
    source: 'epic',
    id: 'alan-wake-2',
    name: 'Alan Wake 2',
    developers: ['Remedy Entertainment'],
    publishers: ['Epic Games Publishing'],
    genres: ['Action'],
    releaseYear: 2023,
    releaseDate: '2023-10-27',
    releaseDateSource: 'epic-catalog',
  });
  // Wikidata identity bridge (P6278 slug → QID) + title facts.
  secondary.writeCache(
    {
      'epic:alan_wake_2': {
        qid: AW2_QID,
        appid: null,
        store: 'epic',
        releaseYear: 2023,
        releasePrecision: 'day',
        releaseDate: '2023-10-27',
        releaseDateSource: 'wikidata',
      },
    },
    {
      titleEntries: {
        'epic:alan_wake_2': {
          qid: AW2_QID,
          appid: null,
          store: 'epic',
          slug: 'alan-wake-2',
          title: 'Alan Wake 2',
          matchedBy: 'title',
          confidence: 'medium',
          titleMatched: 'unique',
          releaseYear: 2023,
          releasePrecision: 'day',
          releaseDate: '2023-10-27',
          releaseDateSource: 'wikidata',
          genres: ['Action'],
        },
      },
    }
  );
}

/* ------------------------------------------------------------------ */
/* 1. SPARQL by QID                                                    */
/* ------------------------------------------------------------------ */

test('qidFranchiseQuery: VALUES by QID + OPTIONAL P179 with en/ru/mul labels', () => {
  const query = franchise.qidFranchiseQuery([AW2_QID, 'Q424242']);
  assert.match(query, /VALUES \?game \{ wd:Q108417001 wd:Q424242 \}/);
  assert.match(query, /wdt:P179 \?franchise/);
  assert.match(query, /LANG\(\?franchiseEn\) = "en"/);
  assert.match(query, /LANG\(\?franchiseRu\) = "ru"/);
  assert.match(query, /LANG\(\?franchiseMul\) = "mul"/);
  // An item without P179 is still in the answer (honest negative cache).
  assert.doesNotMatch(query, /P1733/);
});

test('parseFranchiseByQid: series labels, honest «no series», no invented key', () => {
  const parsed = franchise.parseFranchiseByQid(QID_FRANCHISE_FIXTURE);
  assert.equal(parsed.size, 2);
  const aw2 = parsed.get(AW2_QID);
  assert.equal(aw2.qid, AW2_QID);
  assert.equal(aw2.franchise.qid, ALAN_WAKE_FRANCHISE);
  assert.equal(aw2.franchise.labelEn, 'Alan Wake');
  assert.equal(aw2.franchise.labelRu, 'Alan Wake');
  const none = parsed.get('Q424242');
  assert.equal(none.franchise, null);
});

/* ------------------------------------------------------------------ */
/* 2. cache: settle, TTL, force, budget                                */
/* ------------------------------------------------------------------ */

test('secondary franchise cache: settle inside TTL, re-ask after force/TTL, budget by QID', async () => {
  const calls = [];
  const provider = fakeProvider(calls);
  const target = { store: 'epic', slug: 'alan_wake_2', qid: AW2_QID, title: 'Alan Wake 2' };
  const first = await franchise.enrichSecondaryFranchises({
    targets: [target],
    wikidata: provider,
    now: () => Date.now(),
  });
  assert.equal(first.queries, 1);
  assert.equal(first.updated, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].keyBy, 'qid');

  const doc = franchise.readSecondaryFranchise();
  const bySlug = doc.entries['epic:alan_wake_2'];
  assert.equal(bySlug.qid, AW2_QID);
  assert.equal(bySlug.franchiseKey, `wd:${ALAN_WAKE_FRANCHISE}`);
  assert.equal(bySlug.franchiseLabel, 'Alan Wake');
  assert.equal(bySlug.source, 'wikidata');
  assert.equal(bySlug.resolved, true);
  assert.equal(doc.entries[`qid:${AW2_QID}`].franchiseKey, `wd:${ALAN_WAKE_FRANCHISE}`);

  // Settled: the same target is skipped, no second query.
  const second = await franchise.enrichSecondaryFranchises({
    targets: [target],
    wikidata: provider,
  });
  assert.equal(second.skippedFresh, 1);
  assert.equal(second.queries, 0);
  assert.equal(calls.length, 1);

  // force re-asks.
  const forced = await franchise.enrichSecondaryFranchises({
    targets: [target],
    wikidata: provider,
    force: true,
  });
  assert.equal(forced.queries, 1);
  assert.equal(calls.length, 2);

  // A stale entry is re-asked without force (TTL window).
  franchise.writeSecondaryFranchiseEntries({
    'epic:stale-work': {
      qid: AW2_QID,
      franchiseKey: null,
      franchise: null,
      source: 'wikidata',
      resolved: true,
      store: 'epic',
      slug: 'stale-work',
      fetchedAt: iso(-100 * 86400000),
    },
  });
  const stale = await franchise.enrichSecondaryFranchises({
    targets: [{ store: 'epic', slug: 'stale-work', qid: AW2_QID }],
    wikidata: provider,
  });
  assert.equal(stale.skippedFresh, 0);
  assert.equal(stale.queries, 1);

  // Budget counts QIDs: two targets, limit 1 → one query, one write.
  const budget = await franchise.enrichSecondaryFranchises({
    targets: [
      { store: 'epic', slug: 'budget-a', qid: 'Q1' },
      { store: 'epic', slug: 'budget-b', qid: 'Q2' },
    ],
    wikidata: provider,
    limit: 1,
  });
  assert.equal(budget.selected, 1);
  assert.equal(budget.remaining, 1);
  assert.equal(budget.queries, 1);
  assert.equal(budget.updated, 1);
  assert.equal(franchise.readSecondaryFranchise().entries['epic:budget-b'], undefined);
});

/* ------------------------------------------------------------------ */
/* 3. personnel aggregate with a secondary work                        */
/* ------------------------------------------------------------------ */

test('buildPersonnel: Remedy gets AW2 (workKey, Epic hours) without a network call', async () => {
  await seedSteam();
  await seedEpicAlanWake2();
  await franchise.writeSecondaryFranchiseEntries({
    'epic:alan_wake_2': {
      qid: AW2_QID,
      franchiseKey: `wd:${ALAN_WAKE_FRANCHISE}`,
      franchiseLabel: 'Alan Wake',
      labelRu: 'Alan Wake',
      franchise: { qid: ALAN_WAKE_FRANCHISE, labelEn: 'Alan Wake', labelRu: 'Alan Wake' },
      source: 'wikidata',
      resolved: true,
      store: 'epic',
      slug: 'alan-wake-2',
      fetchedAt: iso(),
    },
  });

  const payload = personnel.buildPersonnel(OWNER, { gamesLimit: 10 });
  const remedy = payload.items.find((item) => /remedy/i.test(item.name));
  assert.ok(remedy, 'Remedy must be in the developer list');
  assert.equal(remedy.count, 2);
  assert.equal(remedy.hours, 64.5);
  const aw2 = remedy.games.find((game) => game.workKey === 'epic:cat-aw2');
  assert.ok(aw2, 'AW2 must be listed under Remedy');
  assert.equal(aw2.appid, null);
  assert.equal(aw2.secondaryOnly, true);
  assert.equal(aw2.hours, 54.5);
  assert.equal(payload.totals.secondaryWorks, 1);
  assert.equal(payload.pending.secondary, 1);
  // Steam rows keep their pre-existing shape (no additive keys).
  const steamGame = remedy.games.find((game) => game.appid === 108710);
  assert.deepEqual(Object.keys(steamGame).sort(), ['appid', 'hours', 'name']);
});

/* ------------------------------------------------------------------ */
/* 4. franchise aggregate: AW2 joins the Steam «Alan Wake» group       */
/* ------------------------------------------------------------------ */

test('buildFranchises: a secondary work joins the existing wd group by workKey', async () => {
  await seedSteam();
  await seedEpicAlanWake2();
  await franchise.writeSecondaryFranchiseEntries({
    'epic:alan_wake_2': {
      qid: AW2_QID,
      franchiseKey: `wd:${ALAN_WAKE_FRANCHISE}`,
      franchiseLabel: 'Alan Wake',
      labelRu: 'Alan Wake',
      franchise: { qid: ALAN_WAKE_FRANCHISE, labelEn: 'Alan Wake', labelRu: 'Alan Wake' },
      source: 'wikidata',
      resolved: true,
      store: 'epic',
      slug: 'alan-wake-2',
      fetchedAt: iso(),
    },
  });
  const payload = aggregate.buildFranchises(OWNER);
  const alanWake = payload.franchises.find((entry) => entry.key === `wd:${ALAN_WAKE_FRANCHISE}`);
  assert.ok(alanWake, 'Alan Wake franchise must exist');
  assert.equal(alanWake.gamesCount, 2);
  assert.deepEqual(alanWake.appids, [108710]);
  assert.deepEqual(alanWake.workKeys, ['epic:cat-aw2']);
  const secondaryGame = alanWake.games.find((game) => game.secondaryOnly);
  assert.equal(secondaryGame.appid, null);
  assert.equal(secondaryGame.workKey, 'epic:cat-aw2');
  assert.equal(alanWake.hoursSum, 64.5);
  assert.equal(payload.totals.secondaryWorks, 1);
  assert.equal(payload.coverage.secondary.works, 1);
  assert.equal(payload.coverage.secondary.withFranchise, 1);
  assert.equal(payload.pending.secondary, 0);
});

test('buildFranchises: a lone secondary work without a cached answer stays pending', () => {
  const payload = aggregate.buildFranchises(OWNER, {
    secondaryWorks: [
      {
        workKey: 'gog:42',
        name: 'GOG Exclusive',
        hours: 3,
        qid: 'Q999',
        franchise: null,
        franchiseChecked: false,
        releaseYear: 2021,
        developers: [],
        publishers: [],
        sources: ['gog'],
      },
    ],
  });
  assert.equal(payload.totals.secondaryWorks, 1);
  assert.equal(payload.pending.secondary, 1);
  assert.equal(payload.franchises.length, 0);
});

/* ------------------------------------------------------------------ */
/* 5. integration: /stats carries qid + franchise on the AW2 row       */
/* ------------------------------------------------------------------ */

test('stats: secondaryWorks/gamesIndex of AW2 carry qid and the Alan Wake franchise', async () => {
  await seedSteam();
  await seedEpicAlanWake2();
  await franchise.writeSecondaryFranchiseEntries({
    'epic:alan_wake_2': {
      qid: AW2_QID,
      franchiseKey: `wd:${ALAN_WAKE_FRANCHISE}`,
      franchiseLabel: 'Alan Wake',
      labelRu: 'Alan Wake',
      franchise: { qid: ALAN_WAKE_FRANCHISE, labelEn: 'Alan Wake', labelRu: 'Alan Wake' },
      source: 'wikidata',
      resolved: true,
      store: 'epic',
      slug: 'alan-wake-2',
      fetchedAt: iso(),
    },
  });
  const payload = buildGamesStatsFromCache(OWNER);
  const aw2 = payload.secondaryWorks.find((entry) => entry.workKey === 'epic:cat-aw2');
  assert.ok(aw2, 'AW2 must be a secondaryWorks entry');
  assert.equal(aw2.qid, AW2_QID);
  assert.deepEqual(aw2.franchise, {
    key: `wd:${ALAN_WAKE_FRANCHISE}`,
    label: 'Alan Wake',
    labelRu: 'Alan Wake',
  });
  assert.deepEqual(aw2.developers, ['Remedy Entertainment']);
  assert.deepEqual(aw2.publishers, ['Epic Games Publishing']);
  const indexRow = payload.gamesIndex['epic:cat-aw2'];
  assert.ok(indexRow);
  assert.equal(indexRow.qid, AW2_QID);
  assert.equal(indexRow.franchise.key, `wd:${ALAN_WAKE_FRANCHISE}`);
  // Steam rows stay additive: no secondary keys appear on them.
  const steamRow = payload.gamesIndex[108710];
  assert.equal(Object.prototype.hasOwnProperty.call(steamRow, 'qid'), false);
});
