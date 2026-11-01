'use strict';

/**
 * B6 — regional-SKU editions (ИГРЫ §8.2.2 «издания», audit §4.4/§4.5).
 *
 * Covers the three things that were broken on `126c38a`:
 *   1. the `qidOf` contract (raw `wikidata.qid` on disk vs the flat view);
 *   2. the second Wikidata pass by exact label (`baseQid`/`baseAppid`);
 *   3. canonical metadata from the base version (`details-base/`), the year
 *      fallback in `stats.js` and the manual-override fingerprint.
 *
 * No live request: `fetchImpl` and the store client are always injected, the
 * cache/state dirs point at `/tmp`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-b6-')
);
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-b6-state-')
);

const gameCache = require('../server/games/game-cache');
const editions = require('../server/games/editions');
const franchise = require('../server/games/franchise');
const stats = require('../server/games/stats');

const franchiseFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'games', 'wikidata-franchises.json'), 'utf8')
);
const baseLabelFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'games', 'wikidata-base-labels.json'), 'utf8')
);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function jsonResponse(data, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => data,
  };
}

function memoryStore(initial = {}) {
  let state = { ...initial };
  return {
    read: () => ({ ...state }),
    write: (next) => {
      state = { ...next };
    },
    snapshot: () => ({ ...state }),
  };
}

async function seed(userKey, games) {
  const now = new Date().toISOString();
  await gameCache.saveProfile({ userKey, personaName: 'b6 tester', importedAt: now, fetchedAt: now });
  await gameCache.saveLibrary(userKey, {
    fetchedAt: now,
    partial: false,
    game_count: games.length,
    games,
  });
  return gameCache.profileKeyOf(userKey);
}

function game(appid, name, minutes = 0) {
  return { appid, name, playtime_forever: minutes, playtime_2weeks: 0, rtime_last_played: 0 };
}

function detailsDoc(name, extra = {}) {
  return {
    success: true,
    type: 'game',
    name,
    developers: [],
    publishers: [],
    releaseYear: null,
    genres: [],
    ...extra,
  };
}

function linksView(extra = {}) {
  return { qid: null, franchiseKey: null, releaseYear: null, resolved: true, ...extra };
}

/**
 * The dispatcher POSTs `application/x-www-form-urlencoded`, so the query text
 * arrives as `VALUES+%3Flabel` — decode the percent escapes and the `+`.
 */
function sparqlBody(init) {
  return decodeURIComponent(String((init && init.body) || '')).replace(/\+/g, ' ');
}

function clearLinks(appids) {
  for (const appid of appids) {
    try {
      fs.unlinkSync(franchise.linksPath(appid));
    } catch (err) {
      /* already gone */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 1. qidOf reads both document shapes                                 */
/* ------------------------------------------------------------------ */

test('qidOf: raw `wikidata.qid`, legacy string and the flat view are all the same QID', () => {
  assert.equal(editions.qidOf({ qid: 'Q500851' }), 'Q500851');
  assert.equal(editions.qidOf({ wikidata: { qid: 'Q500851' } }), 'Q500851');
  assert.equal(editions.qidOf({ wikidata: 'q500851' }), 'Q500851');
  assert.equal(editions.qidOf({ wikidata: { qid: null } }), null);
  assert.equal(editions.qidOf({}), null);
  assert.equal(editions.qidOf(null), null);
  // A base-version QID is a different field, not the SKU's own identity.
  assert.equal(editions.qidOf({ wikidata: { qid: null, baseQid: 'Q323264' } }), null);
  assert.equal(editions.baseQidOf({ wikidata: { baseQid: 'Q323264' } }), 'Q323264');
  assert.equal(editions.baseAppidOf({ wikidata: { baseAppid: 205100 } }), 205100);
});

test('buildEditionIndex: raw links documents still merge by QID (contract bug)', () => {
  const games = [game(228200, 'Company of Heroes', 60), game(4560, 'Company of Heroes - Legacy Edition', 0)];
  const rawLinks = {
    228200: { appid: 228200, wikidata: { qid: 'Q500851', resolved: true } },
    4560: { appid: 4560, wikidata: { qid: 'Q500851', resolved: true } },
  };
  const doc = editions.buildEditionIndex({
    games,
    details: {},
    links: rawLinks,
    profileKey: 'steam-76561198000000902',
  });
  assert.equal(doc.meta.works, 1, 'two appids with the same raw QID are one work');
  assert.equal(doc.canonical['4560'].workKey, 'wd:Q500851');
  assert.equal(doc.groups[0].confidence, 'qid');
});

/* ------------------------------------------------------------------ */
/* 2. Label bridge: candidate labels + strict guards                   */
/* ------------------------------------------------------------------ */

test('labelVariants strips region/edition wrappers but keeps the real title', () => {
  assert.ok(franchise.labelVariants('Dishonored RHCP').includes('Dishonored'));
  assert.ok(franchise.labelVariants('Max Payne (RU)').includes('Max Payne'));
  assert.ok(franchise.labelVariants('Fallout: New Vegas PCR').includes('Fallout: New Vegas'));
  assert.ok(
    franchise.labelVariants('Metro: Last Light Complete Edition').includes('Metro: Last Light')
  );
  assert.ok(
    franchise.labelVariants('Stronghold Crusader Extreme HD').includes('Stronghold Crusader Extreme')
  );
  assert.ok(franchise.labelVariants('East India Company Gold').includes('East India Company'));
  // Never eat a real word: no wrapper to strip, the title stays whole.
  assert.deepEqual(franchise.labelVariants('The Last of Us'), ['The Last of Us']);
  assert.deepEqual(franchise.labelVariants(''), []);
  assert.deepEqual(franchise.labelLanguages('Метро 2033'), ['ru', 'en']);
  assert.deepEqual(franchise.labelLanguages('Metro 2033'), ['en']);
});

test('baseLabelQuery: exact label VALUES (index lookup), P1733 required, series/date optional', () => {
  const query = franchise.baseLabelQuery([
    { labels: [{ text: 'Dishonored', lang: 'en' }, { text: 'Метро 2033', lang: 'ru' }] },
  ]);
  assert.match(query, /VALUES \?label \{ "Dishonored"@en "Метро 2033"@ru \}/);
  assert.match(query, /\?item rdfs:label \?label/);
  assert.match(query, /skos:altLabel/);
  assert.match(query, /\?item wdt:P1733 \?appid/);
  assert.match(query, /wdt:P179 \?franchise/);
  assert.match(query, /p:P577 \?st/);
  // A quote in a title must not break the query.
  const quoted = franchise.baseLabelQuery([{ labels: [{ text: 'Say "Hi"', lang: 'en' }] }]);
  assert.match(quoted, /"Say \\"Hi\\""@en/);
});

test('parseBaseLabelResponse groups by the base item (labels, appids, series, date)', () => {
  const parsed = franchise.parseBaseLabelResponse(baseLabelFixture);
  assert.equal(parsed.size, 7);
  const dishonored = parsed.get('Q323264');
  assert.deepEqual(dishonored.appids, [205100]);
  assert.deepEqual(dishonored.labels, ['Dishonored']);
  assert.equal(dishonored.franchise.qid, 'Q1346301');
  assert.equal(dishonored.releaseYear, 2012);
  assert.equal(dishonored.releasePrecision, 'day');
  const maxPayne = parsed.get('Q1175156');
  assert.equal(maxPayne.franchise, null);
  assert.equal(maxPayne.releaseYear, 2001);
  // A non-answer is simply absent, never invented.
  assert.equal(parsed.get('Q000000'), undefined);
});

test('matchBaseFor: exact normalized label + numeric signature, franchise guard', () => {
  const items = franchise.parseBaseLabelResponse(baseLabelFixture);

  const dishonored = franchise.matchBaseFor('Dishonored RHCP', items);
  assert.equal(dishonored.qid, 'Q323264');
  assert.equal(dishonored.appid, 205100);
  assert.equal(dishonored.date.year, 2012);

  const maxPayne = franchise.matchBaseFor('Max Payne (RU)', items);
  assert.equal(maxPayne.qid, 'Q1175156', 'Max Payne 2 is a different numeric signature');
  assert.equal(maxPayne.appid, 12140);

  const newVegas = franchise.matchBaseFor('Fallout: New Vegas PCR', items);
  assert.equal(newVegas.qid, 'Q753749');
  assert.equal(newVegas.franchise.labelEn, 'Fallout');

  // Cyrillic label lookup (ru) resolves the same way.
  const metro = franchise.matchBaseFor('Метро 2033 (RU)', items);
  assert.equal(metro.qid, 'Q648617');
  assert.equal(metro.appid, 43130);

  // «Fallout: New Vegas» must never bridge to plain «Fallout».
  const plainFallout = franchise.matchBaseFor('Fallout PCR', items);
  assert.equal(plainFallout.qid, 'Q1078436');

  // No exact label → no bridge.
  assert.equal(franchise.matchBaseFor('Something Else Entirely', items), null);

  // A different known series blocks the label hit.
  const conflicting = franchise.matchBaseFor('Dishonored RHCP', items, {
    franchiseKey: 'wd:Q999999',
  });
  assert.equal(conflicting, null);
  // The matching series does not block it.
  const agreeing = franchise.matchBaseFor('Dishonored RHCP', items, {
    franchiseKey: 'wd:Q1346301',
  });
  assert.equal(agreeing.qid, 'Q323264');
});

/* ------------------------------------------------------------------ */
/* 3. baseQid merging in the edition index                             */
/* ------------------------------------------------------------------ */

test('editions: a regional SKU merges into its base card via baseQid', () => {
  const games = [game(217980, 'Dishonored RHCP', 522), game(205100, 'Dishonored', 0)];
  const doc = editions.buildEditionIndex({
    games,
    details: { 205100: detailsDoc('Dishonored', { developers: ['Arkane Studios'], releaseYear: 2012 }) },
    links: {
      217980: linksView({ qid: null, baseQid: 'Q323264', baseAppid: 205100 }),
      205100: linksView({ qid: 'Q323264' }),
    },
    profileKey: 'steam-76561198000000903',
  });
  assert.equal(doc.meta.works, 1);
  assert.equal(doc.canonical['217980'].workKey, 'wd:Q323264');
  assert.equal(doc.canonical['217980'].primaryAppid, 217980, 'the played edition is the face');
  assert.equal(doc.groups[0].confidence, 'qid');
});

test('editions: two regionals of one base merge even when the base card is absent', () => {
  const games = [
    game(217980, 'Dishonored RHCP', 100),
    game(217981, 'Dishonored (RU)', 0),
    game(22490, 'Fallout: New Vegas PCR', 0),
  ];
  const doc = editions.buildEditionIndex({
    games,
    details: {},
    links: {
      217980: linksView({ baseQid: 'Q323264', baseAppid: 205100 }),
      217981: linksView({ baseQid: 'Q323264', baseAppid: 205100 }),
      22490: linksView({ baseQid: 'Q753749', baseAppid: 22380 }),
    },
    profileKey: 'steam-76561198000000904',
  });
  assert.equal(doc.meta.works, 2);
  assert.equal(doc.canonical['217980'].workKey, doc.canonical['217981'].workKey);
  assert.notEqual(doc.canonical['217980'].workKey, doc.canonical['22490'].workKey);
  assert.equal(doc.canonical['217980'].workKey, 'wd:Q323264');
});

test('editions: a baseQid never merges across different works', () => {
  const left = {
    appid: 1,
    name: 'Alpha',
    names: [{ raw: 'Alpha', tokens: editions.coreTokens('Alpha'), key: 'alpha', marker: false }],
    type: 'game',
    developers: [],
    year: null,
    qid: null,
    baseQid: 'Q1',
    baseAppid: 10,
    franchiseKey: null,
  };
  const right = {
    ...left,
    appid: 2,
    name: 'Beta',
    names: [{ raw: 'Beta', tokens: editions.coreTokens('Beta'), key: 'beta', marker: false }],
    qid: 'Q2',
    baseQid: null,
  };
  assert.equal(editions.editionMatch(left, right), null, 'Q1 ≠ Q2 and the titles differ');
});

test('editions: an own QID keeps the work key when the bridge adds a second one', () => {
  // Wikidata models «Serious Sam HD: The Second Encounter» and «… Classic: …»
  // as two items; the title merge still puts them in one work, and the key
  // must stay the own QID of the row that has one.
  const games = [
    game(41010, 'Serious Sam HD: The Second Encounter', 60),
    game(41060, 'Serious Sam Classic: The Second Encounter', 0),
  ];
  const doc = editions.buildEditionIndex({
    games,
    details: {
      41010: detailsDoc('Serious Sam HD: The Second Encounter', { releaseYear: 2019 }),
      41060: detailsDoc('Serious Sam Classic: The Second Encounter', { releaseYear: 2019 }),
    },
    links: {
      41010: linksView({ qid: null, baseQid: 'Q8238558', baseAppid: 41014 }),
      41060: linksView({ qid: 'Q840206' }),
    },
    profileKey: 'steam-76561198000000909',
  });
  assert.equal(doc.meta.works, 1);
  assert.equal(doc.canonical['41010'].workKey, 'wd:Q840206');
});

/* ------------------------------------------------------------------ */
/* 4. Manual overrides are an input (audit §4.4d)                      */
/* ------------------------------------------------------------------ */

test('ensureEditions rebuilds when only manual.merges changed', () => {
  const profileKey = 'steam-76561198000000905';
  const games = [game(10, 'Alpha', 60), game(11, 'Beta', 120)];
  const detailsMap = { 10: detailsDoc('Alpha'), 11: detailsDoc('Beta') };
  const library = { games, fingerprint: 'lib-manual' };

  const first = editions.ensureEditions(profileKey, {
    library,
    games,
    details: detailsMap,
    links: {},
  });
  assert.equal(first.rebuilt, true);
  assert.equal(first.doc.meta.works, 2);

  const second = editions.ensureEditions(profileKey, {
    library,
    games,
    details: detailsMap,
    links: {},
  });
  assert.equal(second.rebuilt, false);

  // Hand-edit the manual list exactly as a human would: no other input moves.
  const edited = editions.readEditions(profileKey);
  edited.manual = { merges: [[10, 11]], splits: [] };
  editions.saveEditions(profileKey, edited);

  const third = editions.ensureEditions(profileKey, {
    library,
    games,
    details: detailsMap,
    links: {},
  });
  assert.equal(third.rebuilt, true, 'the manual list is part of the inputs');
  assert.equal(third.doc.meta.works, 1);
  assert.deepEqual(third.doc.manual.merges, [[10, 11]]);
  assert.equal(third.doc.groups[0].confidence, 'manual');
});

/* ------------------------------------------------------------------ */
/* 5. Canonical metadata from the base version                         */
/* ------------------------------------------------------------------ */

test('stats: a bridged regional SKU gets the work year/name/genres/studios from the base', () => {
  const games = [
    game(217980, 'Dishonored RHCP', 522),
    game(22490, 'Fallout: New Vegas PCR', 60),
    game(292030, 'The Witcher 3: Wild Hunt', 6420),
  ];
  const payload = stats.buildGamesStats({
    steamId64: '76561198000000906',
    profile: { userKey: '76561198000000906', personaName: 'b6' },
    library: { games, fingerprint: 'lib-b6', partial: false, game_count: games.length },
    details: {
      292030: detailsDoc('The Witcher 3: Wild Hunt', {
        releaseYear: 2015,
        genres: [{ id: '3', description: 'RPG' }],
        developers: ['CD Projekt RED'],
      }),
    },
    links: {
      217980: linksView({
        qid: null,
        baseQid: 'Q323264',
        baseAppid: 205100,
        baseName: 'Dishonored',
        baseReleaseYear: 2012,
      }),
      22490: linksView({
        qid: null,
        baseQid: 'Q753749',
        baseAppid: 22380,
        baseName: 'Fallout: New Vegas',
        baseReleaseYear: 2010,
      }),
    },
    detailsBase: {
      205100: detailsDoc('Dishonored', {
        releaseYear: 2012,
        genres: [{ id: '1', description: 'Action' }],
        developers: ['Arkane Studios'],
        publishers: ['Bethesda Softworks'],
      }),
      22380: detailsDoc('Fallout: New Vegas', {
        releaseYear: 2010,
        genres: [{ id: '3', description: 'RPG' }],
        developers: ['Obsidian Entertainment'],
        publishers: ['Bethesda Softworks'],
      }),
    },
    editions: null,
    minHours: -1,
  });

  const top = payload.topGames.find((entry) => entry.appid === 217980);
  assert.equal(top.releaseYear, 2012, 'year comes from the base version, not from nothing');
  assert.equal(top.canonicalName, 'Dishonored');
  assert.deepEqual(top.genres, ['Action']);
  assert.deepEqual(top.developers, ['Arkane Studios']);
  assert.deepEqual(top.publishers, ['Bethesda Softworks']);
  assert.equal(top.name, 'Dishonored RHCP', 'the owned edition keeps its own name');

  // The per-appid index must agree with the canonical work (drilldowns).
  assert.equal(payload.gamesIndex['217980'].year, 2012);
  assert.equal(payload.gamesIndex['217980'].canonicalName, 'Dishonored');
  assert.equal(payload.gamesIndex['217980'].baseAppid, 205100);
  assert.ok(payload.gamesIndex['217980'].metadataSources.includes('wikidata'));

  // Years/decades buckets contain the work exactly once.
  assert.equal(payload.summary.gameCount, 3);
  assert.equal(payload.years.filter((entry) => entry.year != null).length, 3);
});

test('stats: workYear falls back to links.releaseYear (Wikidata P577, audit §3)', () => {
  const games = [
    game(489830, 'The Elder Scrolls V: Skyrim Special Edition', 60),
    game(292030, 'The Witcher 3: Wild Hunt', 6420),
  ];
  const payload = stats.buildGamesStats({
    steamId64: '76561198000000907',
    profile: { userKey: '76561198000000907', personaName: 'b6' },
    library: { games, fingerprint: 'lib-b6-wd', partial: false, game_count: 2 },
    details: {
      // The store answered `success:false` for the region-locked SKU…
      489830: { appid: 489830, success: false },
      // …while the rest of the library has real store metadata.
      292030: detailsDoc('The Witcher 3: Wild Hunt', { releaseYear: 2015 }),
    },
    links: { 489830: linksView({ qid: 'Q323264', releaseYear: 2016, releasePrecision: 'year' }) },
    editions: null,
    minHours: -1,
  });
  const skyrim = payload.topGames.find((entry) => entry.appid === 489830);
  assert.equal(skyrim.releaseYear, 2016);
  assert.equal(payload.summary.gameCount, 2);
  assert.equal(payload.years.find((entry) => entry.year === 2016).count, 1);
});

test('stats: the base year is a last resort, it never moves a work that has its own year', () => {
  // `Grand Theft Auto III` (2008 on Steam) + its regional twin bridged to the
  // 2001 original: the work keeps the store year, not the base one.
  const games = [game(12100, 'Grand Theft Auto III', 120), game(12230, 'Grand Theft Auto III', 0)];
  const payload = stats.buildGamesStats({
    steamId64: '76561198000000908',
    profile: { userKey: '76561198000000908', personaName: 'b6' },
    library: { games, fingerprint: 'lib-b6-gta', partial: false, game_count: 2 },
    details: { 12100: detailsDoc('Grand Theft Auto III', { releaseYear: 2008 }) },
    links: {
      12230: linksView({ baseQid: 'Q149106', baseAppid: 12100, baseReleaseYear: 2001 }),
    },
    editions: null,
    minHours: -1,
  });
  assert.equal(payload.topGames[0].releaseYear, 2008);
  // Both rows agree, so the frontend recount (`min` over editions) matches.
  assert.equal(payload.gamesIndex['12100'].year, 2008);
  assert.equal(payload.gamesIndex['12230'].year, 2008);
  assert.equal(payload.years.find((entry) => entry.year === 2001), undefined);
});

/* ------------------------------------------------------------------ */
/* 6. The bridge inside the franchise pass                             */
/* ------------------------------------------------------------------ */

test('enrichFranchises: second batch bridges a qid:null regional to its base version', async () => {
  clearLinks([217980, 292030]);
  const userKey = '76561198000002011';
  const profileKey = await seed(userKey, [
    { appid: 217980, name: 'Dishonored RHCP', playtime_forever: 522 },
    { appid: 292030, name: 'The Witcher 3: Wild Hunt', playtime_forever: 6420 },
  ]);

  const queries = [];
  const report = await franchise.enrichFranchises({
    profileKey,
    fetchImpl: async (url, init) => {
      const body = sparqlBody(init);
      queries.push(body);
      return jsonResponse(body.includes('VALUES ?label') ? baseLabelFixture : franchiseFixture);
    },
    stateStore: memoryStore(),
    pauseMs: 0,
  });

  assert.equal(queries.length, 2, 'one P1733 batch + one label batch');
  assert.equal(report.wdQueries, 1);
  assert.equal(report.bridgeQueries, 1);
  assert.equal(report.bridgeCandidates, 1);
  assert.equal(report.bridged, 1);

  const sku = franchise.readLinksDoc(217980);
  assert.equal(sku.wikidata.qid, null, 'the SKU never pretends to be the base game');
  assert.equal(sku.wikidata.baseQid, 'Q323264');
  assert.equal(sku.wikidata.baseAppid, 205100);
  assert.equal(sku.wikidata.baseName, 'Dishonored');
  assert.equal(sku.wikidata.baseReleaseYear, 2012);
  assert.equal(sku.wikidata.baseReleasePrecision, 'day');
  assert.equal(sku.wikidata.baseMatch, 'label');
  assert.equal(sku.wikidata.baseFranchise.qid, 'Q1346301');
  assert.equal(sku.wikidata.resolved, true);
  assert.ok(sku.wikidata.baseCheckedAt);

  // The flat view the rest of the tab reads exposes the same identity.
  const view = franchise.readLinks(217980);
  assert.equal(view.qid, null);
  assert.equal(view.baseQid, 'Q323264');
  assert.equal(view.baseAppid, 205100);
  assert.equal(view.baseReleaseYear, 2012);

  // The Witcher keeps its own P1733 answer and gets no base identity.
  const witcher = franchise.readLinksDoc(292030);
  assert.equal(witcher.wikidata.qid, 'Q4267401');
  assert.equal(witcher.wikidata.baseQid, undefined);
});

test('enrichFranchises: a bridged row is not asked again, an honest miss is cached', async () => {
  const userKey = '76561198000002012';
  const profileKey = await seed(userKey, [
    { appid: 217980, name: 'Dishonored RHCP', playtime_forever: 522 },
    { appid: 259300, name: 'Earth 2150: Lost Souls', playtime_forever: 0 },
  ]);
  clearLinks([217980, 259300]);

  let labelQueries = 0;
  const fetchImpl = async (url, init) => {
    const body = sparqlBody(init);
    if (body.includes('VALUES ?label')) {
      labelQueries++;
      return jsonResponse(baseLabelFixture);
    }
    return jsonResponse(franchiseFixture);
  };

  const first = await franchise.enrichFranchises({
    profileKey,
    fetchImpl,
    stateStore: memoryStore(),
    pauseMs: 0,
  });
  assert.equal(first.bridgeCandidates, 2);
  assert.equal(first.bridged, 1, 'only Dishonored has a base label');
  assert.equal(first.bridgeMisses, 1);
  assert.equal(labelQueries, 1);

  const miss = franchise.readLinksDoc(259300);
  assert.equal(miss.wikidata.qid, null);
  assert.equal(miss.wikidata.baseQid, null);
  assert.ok(miss.wikidata.baseCheckedAt, 'the negative bridge answer has its own 90-day marker');

  const second = await franchise.enrichFranchises({
    profileKey,
    fetchImpl,
    stateStore: memoryStore(),
    pauseMs: 0,
  });
  assert.equal(second.skipped, 'nothing_to_ask');
  assert.equal(second.bridgeCandidates, 0);
  assert.equal(labelQueries, 1, 'no extra query inside the TTL');
});

test('enrichFranchises: a failing label batch writes no negative bridge marker', async () => {
  clearLinks([217980]);
  const userKey = '76561198000002013';
  const profileKey = await seed(userKey, [
    { appid: 217980, name: 'Dishonored RHCP', playtime_forever: 522 },
  ]);
  // Seed the P1733 miss the way the pre-B6 cache has it: resolved, qid null.
  fs.mkdirSync(franchise.LINKS_DIR, { recursive: true });
  fs.writeFileSync(
    franchise.linksPath(217980),
    JSON.stringify({
      schemaVersion: 1,
      appid: 217980,
      wikidata: { qid: null, resolved: true, fetchedAt: new Date().toISOString() },
      fetchedAt: new Date().toISOString(),
    })
  );

  const report = await franchise.enrichFranchises({
    profileKey,
    fetchImpl: async (url, init) => {
      const body = sparqlBody(init);
      if (body.includes('VALUES ?label')) return jsonResponse({}, 429, { 'retry-after': '60' });
      return jsonResponse(franchiseFixture);
    },
    stateStore: memoryStore(),
    pauseMs: 0,
    minOutageGapMs: 0,
  });
  assert.ok(report.bridgeCandidates >= 1, 'the stale qid:null row is picked up without force');
  const doc = franchise.readLinksDoc(217980);
  assert.equal(doc.wikidata.baseCheckedAt, undefined, 'a 429 is deferred, never a negative marker');
  assert.equal(doc.wikidata.baseQid, undefined);
});

/* ------------------------------------------------------------------ */
/* 7. Canonical metadata fetch (store step)                            */
/* ------------------------------------------------------------------ */

test('enrichBaseDetails fetches each base version once, honours the budget', async () => {
  const userKey = '76561198000002014';
  const profileKey = await seed(userKey, [
    { appid: 217980, name: 'Dishonored RHCP', playtime_forever: 522 },
    { appid: 22490, name: 'Fallout: New Vegas PCR', playtime_forever: 60 },
  ]);
  franchise.writeLinksDoc(217980, {
    wikidata: { qid: null, baseQid: 'Q323264', baseAppid: 205100, resolved: true },
    sources: ['wikidata'],
  });
  franchise.writeLinksDoc(22490, {
    wikidata: { qid: null, baseQid: 'Q753749', baseAppid: 22380, resolved: true },
    sources: ['wikidata'],
  });

  const asked = [];
  const storeClient = {
    getAppDetails: async (appid) => {
      asked.push(appid);
      return {
        appid,
        success: true,
        type: 'game',
        name: appid === 205100 ? 'Dishonored' : 'Fallout: New Vegas',
        developers: ['Arkane Studios'],
        publishers: ['Bethesda Softworks'],
        genres: [{ id: '1', description: 'Action' }],
        releaseYear: appid === 205100 ? 2012 : 2010,
        releasePrecision: 'day',
      };
    },
  };

  const first = await franchise.enrichBaseDetails({
    profileKey,
    limit: 1,
    storeClient,
    now: () => Date.now(),
  });
  assert.deepEqual(asked, [205100]);
  assert.equal(first.fetched, 1);
  assert.equal(first.remaining, 1);
  const saved = gameCache.getDetailsBase(205100);
  assert.equal(saved.name, 'Dishonored');
  assert.equal(saved.baseVersion, true);
  assert.ok(saved.fetchedAt, 'the TTL marker is written by the caller');
  // `details/` must not be polluted: the owner does not own that card.
  assert.equal(gameCache.getDetails(205100), null);

  const second = await franchise.enrichBaseDetails({
    profileKey,
    limit: 1,
    storeClient,
    now: () => Date.now(),
  });
  assert.deepEqual(asked, [205100, 22380], 'the first base is fresh, the second is not');
  assert.equal(second.skippedFresh, 1);

  const third = await franchise.enrichBaseDetails({ profileKey, storeClient, now: () => Date.now() });
  assert.equal(third.candidates, 0);
  assert.equal(third.skipped, 'nothing_to_fetch');
  assert.equal(asked.length, 2);
});

test('enrichBaseDetails: a store failure is deferred, nothing is written', async () => {
  const userKey = '76561198000002015';
  const profileKey = await seed(userKey, [
    { appid: 22490, name: 'Fallout: New Vegas PCR', playtime_forever: 60 },
  ]);
  // Another case in this file may already have cached this base document.
  for (const appid of [22380]) {
    try {
      fs.unlinkSync(gameCache.detailsBasePath(appid));
    } catch (err) {
      /* already gone */
    }
  }
  franchise.writeLinksDoc(22490, {
    wikidata: { qid: null, baseQid: 'Q753749', baseAppid: 22380, resolved: true },
    sources: ['wikidata'],
  });
  const storeClient = {
    getAppDetails: async () => {
      const err = new Error('store_unreachable');
      err.code = 'store_unreachable';
      throw err;
    },
  };
  const report = await franchise.enrichBaseDetails({ profileKey, storeClient });
  assert.equal(report.fetched, 0);
  assert.deepEqual(report.errors, ['store_unreachable']);
  assert.equal(gameCache.getDetailsBase(22380), null);
});
