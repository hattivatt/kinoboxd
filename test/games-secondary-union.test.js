'use strict';

/**
 * M6c: secondary-only works in **every** aggregate.
 *
 * The user's rule (01.11.2026): a game owned only on Epic/GOG is a real owned
 * game — it belongs in `gameCount`, `totalHours`, years/decades, genres, the
 * histogram, the top list and the backlog. Only Steam-specific facts
 * (achievements, `lastPlayed`, SteamSpy tags, review scores) stay absent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-secondary-union-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-secondary-union-state-'));

const gameCache = require('../server/games/game-cache');
const gogCache = require('../server/games/gog-cache');
const epicCache = require('../server/games/epic-cache');
const { buildSecondaryUnion, yearOfDate, genreNames } = require('../server/games/secondary-union');
const { buildGamesStatsFromCache } = require('../server/games/stats');
const { buildBridgeQuery, parseBridgeResponse, collectSlugs } = require('../server/games/secondary-identity');

const STEAM_ID = '76561198000000021';
const OWNER = `steam-${STEAM_ID}`;
const GOG_KEY = '1234500000';
const EPIC_ACCOUNT = 'epic-account-1';

function steamWork(appid, name, minutes, extra = {}) {
  return {
    workKey: `steam:${appid}`,
    minutes,
    primary: { appid, name },
    games: [{ appid, name, playtime_forever: minutes, img_icon_url: null }],
    ...extra,
  };
}

test('secondary union', async (t) => {
  await t.test('yearOfDate reads GOG and Epic date shapes', () => {
    assert.equal(yearOfDate('2015-05-18'), 2015);
    assert.equal(yearOfDate('2023.09.26'), 2023);
    assert.equal(yearOfDate('1998'), 1998);
    assert.equal(yearOfDate(''), null);
    assert.equal(yearOfDate(null), null);
    assert.equal(yearOfDate('not a date'), null);
  });

  await t.test('genreNames accepts strings, objects and a single value', () => {
    assert.deepEqual(genreNames([{ name: 'RPG' }, 'Action', { slug: 'scifi' }]), [
      'RPG',
      'Action',
      'scifi',
    ]);
    assert.deepEqual(genreNames('RPG'), ['RPG']);
    assert.deepEqual(genreNames(null), []);
  });

  await t.test('a store slug is joined to the Steam work through the Wikidata bridge', () => {
    const union = buildSecondaryUnion({
      works: [steamWork(292030, 'The Witcher 3: Wild Hunt', 600)],
      gogSnapshots: [
        {
          library: {
            products: [
              {
                gogGameId: '1207658924',
                title: 'The Witcher 3: Wild Hunt — GOTY',
                slug: 'the_witcher_3_wild_hunt_goty',
                releaseDate: '2016-08-30',
              },
            ],
          },
          playtime: { minutes: { 1207658924: 600 } },
        },
      ],
      epicLayer: null,
      links: {},
      // P2725 game/the_witcher_3_wild_hunt_goty → Q4267401 → P1733 292030
      secondaryLinks: { 'gog:the_witcher_3_wild_hunt_goty': { qid: 'Q4267401', appid: '292030' } },
    });
    assert.equal(union.works.length, 1);
    const entry = union.works[0];
    assert.deepEqual(entry.sources, ['steam', 'gog']);
    assert.equal(entry.matchedBy, 'wikidata');
    assert.equal(entry.confidence, 'high');
    // Display total = Steam + GOG, the breakdown keeps both numbers.
    assert.equal(entry.displayMinutes, 1200);
    assert.equal(entry.hours, 20);
    assert.deepEqual(entry.hoursBySource, { steam: 600, gog: 600, epic: null });
    assert.equal(union.summary.secondaryOnlyWorks, 0);
    assert.equal(union.summary.matchedWorks, 1);
  });

  // Regression 02.11.2026 (live WDQS): `Q753749` (Fallout: New Vegas) carries
  // `P2725 game/fallout_new_vegas_ultimate_edition` and `P1733 22380`. The
  // owner's Steam row is the regional SKU `22490` («Fallout: New Vegas PCR»),
  // so the bridge appid is not in the library at all: the join must go through
  // the base identity (`wikidata.baseQid/baseAppid`) the SKU's link doc holds.
  await t.test('the bridge joins a base-game slug to the owned regional SKU', () => {
    const union = buildSecondaryUnion({
      works: [steamWork(22490, 'Fallout: New Vegas PCR', 120)],
      gogSnapshots: [
        {
          library: {
            products: [
              {
                gogGameId: '1440000010',
                title: 'Fallout: New Vegas Ultimate Edition',
                slug: 'fallout_new_vegas_ultimate_edition',
                releaseDate: '2012-02-01',
              },
            ],
          },
          playtime: { minutes: { 1440000010: 600 } },
        },
      ],
      epicLayer: null,
      links: {
        22490: { wikidata: { qid: null, baseQid: 'Q753749', baseAppid: 22380 } },
      },
      secondaryLinks: {
        'gog:fallout_new_vegas_ultimate_edition': {
          qid: 'Q753749',
          appid: '22380',
          store: 'gog',
        },
      },
    });
    assert.equal(union.works.length, 1, 'one work, not a GOG duplicate row');
    const entry = union.works[0];
    assert.equal(entry.workKey, 'steam:22490');
    assert.deepEqual(entry.sources, ['steam', 'gog']);
    assert.equal(entry.matchedBy, 'wikidata');
    assert.equal(entry.confidence, 'high');
    assert.equal(entry.storeIds.steam, 22490);
    assert.equal(entry.storeIds.gog, '1440000010');
    assert.deepEqual(entry.hoursBySource, { steam: 120, gog: 600, epic: null });
    assert.equal(entry.displayMinutes, 720);
    assert.equal(union.summary.secondaryOnlyWorks, 0);
    assert.equal(union.summary.matchedByWikidata, 1);
    assert.equal(union.summary.unmatched, 0);
  });

  await t.test('a bridge QID alone joins the SKU when the link doc has no base appid', () => {
    const union = buildSecondaryUnion({
      works: [steamWork(22490, 'Fallout: New Vegas PCR', 120)],
      gogSnapshots: [
        {
          library: {
            products: [
              {
                gogGameId: '1440000011',
                title: 'Fallout: New Vegas Ultimate Edition',
                slug: 'fallout_new_vegas_ultimate_edition',
              },
            ],
          },
        },
      ],
      epicLayer: null,
      links: { 22490: { wikidata: { qid: null, baseQid: 'Q753749' } } },
      secondaryLinks: {
        'gog:fallout_new_vegas_ultimate_edition': { qid: 'Q753749', appid: '22380' },
      },
    });
    assert.equal(union.works.length, 1);
    assert.equal(union.works[0].matchedBy, 'wikidata');
  });

  await t.test('without the bridge, the edition key joins UE to a regional SKU', () => {
    const union = buildSecondaryUnion({
      works: [steamWork(22490, 'Fallout: New Vegas PCR', 120)],
      gogSnapshots: [
        {
          library: {
            products: [
              {
                gogGameId: '1440000012',
                title: 'Fallout: New Vegas Ultimate Edition',
                slug: 'fallout_new_vegas_ultimate_edition',
              },
            ],
          },
          playtime: { minutes: { 1440000012: 60 } },
        },
      ],
      epicLayer: null,
      links: {},
      secondaryLinks: {},
    });
    assert.equal(union.works.length, 1, '«Ultimate Edition» vs «PCR» is the same work');
    assert.equal(union.works[0].matchedBy, 'title');
    assert.equal(union.works[0].confidence, 'medium');
  });

  await t.test('the edition fallback keeps the numeric signature apart', () => {
    const union = buildSecondaryUnion({
      works: [steamWork(22490, 'Fallout: New Vegas PCR', 120)],
      gogSnapshots: [
        {
          library: {
            products: [
              {
                gogGameId: '1440000013',
                title: 'Fallout: New Vegas 2 Ultimate Edition',
                slug: 'fallout_new_vegas_2_ultimate_edition',
              },
            ],
          },
        },
      ],
      epicLayer: null,
      links: {},
      secondaryLinks: {},
    });
    assert.equal(union.works.length, 2, 'a different number is a different game');
    assert.equal(union.summary.secondaryOnlyWorks, 1);
  });

  await t.test('two Steam works with the same edition key are ambiguous, not matched', () => {
    const union = buildSecondaryUnion({
      works: [
        steamWork(22490, 'Fallout: New Vegas PCR', 120),
        steamWork(217980, 'Fallout: New Vegas RHCP', 0),
      ],
      gogSnapshots: [
        {
          library: {
            products: [
              {
                gogGameId: '1440000014',
                title: 'Fallout: New Vegas Ultimate Edition',
                slug: 'fallout_new_vegas_ultimate_edition',
              },
            ],
          },
        },
      ],
      epicLayer: null,
      links: {},
      secondaryLinks: {},
    });
    // Both Steam rows collapse to «fallout new vegas» under the edition key
    // but keep different plain keys (`… pcr` / `… rhcp`): the guard drops the
    // edition key instead of picking one, so the GOG copy stays its own row.
    assert.equal(union.summary.secondaryOnlyWorks, 1);
    assert.equal(union.summary.matchedByTitle, 0);
  });

  await t.test('an Epic slug joins the same work; unknown playtime stays null', () => {
    const union = buildSecondaryUnion({
      works: [steamWork(292030, 'The Witcher 3: Wild Hunt', 600)],
      gogSnapshots: [],
      epicLayer: {
        accountId: EPIC_ACCOUNT,
        games: [
          {
            name: 'The Witcher 3: Wild Hunt',
            catalogItemId: 'cat-1',
            slug: 'the-witcher-3-wild-hunt',
            totalMinutes: 600,
            releaseDate: '2015-05-19',
          },
          {
            name: 'Epic Only Game',
            catalogItemId: 'cat-2',
            slug: 'epic-only-game',
            totalMinutes: null,
            releaseDate: '2021-03-04',
          },
        ],
      },
      links: {},
      secondaryLinks: { 'epic:the-witcher-3-wild-hunt': { qid: 'Q4267401', appid: '292030' } },
    });
    const witcher = union.byWorkKey.get('steam:292030');
    assert.deepEqual(witcher.sources, ['steam', 'epic']);
    assert.equal(witcher.displayMinutes, 1200);
    assert.equal(witcher.matchedBy, 'wikidata');

    const only = union.secondaryOnly[0];
    assert.equal(only.workKey, 'epic:cat-2');
    assert.deepEqual(only.sources, ['epic']);
    // Unknown is not zero: no playtime answer → null + the flag.
    assert.equal(only.hoursBySource.epic, null);
    assert.equal(only.hoursUnknown, true);
    assert.equal(only.releaseYear, 2021);
    assert.equal(only.hoursStatus.epic, 'unknown');
  });

  await t.test('collectSlugs keeps the store spelling, de-dupes by normal form', () => {
    const { gogSlugs, epicSlugs } = collectSlugs({
      gogProducts: [
        { slug: 'the_witcher_3_wild_hunt' },
        { slug: 'the_witcher_3_wild_hunt' },
        { slug: null },
      ],
      epicGames: [{ slug: 'the-witcher-3-wild-hunt' }, { slug: 'Control' }],
    });
    // GOG and Epic spell the same game differently; Wikidata stores each
    // literal, so the raw slug is what goes into the query.
    assert.deepEqual(gogSlugs, ['the_witcher_3_wild_hunt']);
    assert.deepEqual(epicSlugs, ['the-witcher-3-wild-hunt', 'Control']);
  });

  await t.test('bridge query uses the P2725 `game/` form and a UNION of both stores', () => {
    const query = buildBridgeQuery({
      gogSlugs: ['the_witcher_3_wild_hunt'],
      epicSlugs: ['control'],
    });
    assert.match(query, /VALUES \?gogSlug \{ "game\/the_witcher_3_wild_hunt" \}/);
    assert.match(query, /VALUES \?epicSlug \{ "control" \}/);
    assert.match(query, /wdt:P2725/);
    assert.match(query, /wdt:P6278/);
    assert.match(query, /wdt:P1733/);
    assert.match(query, /UNION/);
  });

  await t.test('bridge response keeps the row with an appid', () => {
    const entries = parseBridgeResponse({
      results: {
        bindings: [
          {
            item: { value: 'http://www.wikidata.org/entity/Q4267401' },
            store: { value: 'gog' },
            slug: { value: 'game/the_witcher_3_wild_hunt' },
            appid: { value: '292030' },
          },
          {
            item: { value: 'http://www.wikidata.org/entity/Q4267401' },
            store: { value: 'gog' },
            slug: { value: 'game/the_witcher_3_wild_hunt_expansion' },
          },
        ],
      },
    });
    assert.deepEqual(entries['gog:the_witcher_3_wild_hunt'], {
      qid: 'Q4267401',
      appid: '292030',
      store: 'gog',
    });
    // A row without an appid still records the QID (honest partial answer).
    assert.deepEqual(entries['gog:the_witcher_3_wild_hunt_expansion'], {
      qid: 'Q4267401',
      appid: null,
      store: 'gog',
    });
  });
});

/* ------------------------------------------------------------------ */
/* stats: every aggregate                                            */
/* ------------------------------------------------------------------ */

const GOG_PRODUCTS = [
  {
    gogGameId: '1207658924',
    title: 'The Witcher 3: Wild Hunt',
    slug: 'the_witcher_3_wild_hunt',
    category: 'game',
    isGame: true,
    releaseDate: '2015-05-18',
  },
  {
    gogGameId: '1440000001',
    title: 'Gothic 3',
    slug: 'gothic_3',
    category: 'game',
    isGame: true,
    releaseDate: '2006-10-13',
  },
  {
    gogGameId: '1440000002',
    title: 'Unknown Hours Game',
    slug: 'unknown_hours',
    category: 'game',
    isGame: true,
    releaseDate: null,
  },
];

const EPIC_GAMES = [
  {
    name: 'The Witcher 3: Wild Hunt',
    catalogItemId: 'epic-cat-1',
    appName: 'Witcher3',
    slug: 'the-witcher-3-wild-hunt',
    totalMinutes: 600,
    releaseDate: '2015-05-19',
    platforms: ['Windows'],
  },
  {
    name: 'Epic Only Indie',
    catalogItemId: 'epic-cat-2',
    appName: 'EpicIndie',
    slug: 'epic-only-indie',
    totalMinutes: 180,
    releaseDate: '2020-07-01',
    platforms: ['Windows'],
  },
];

async function seed() {
  const nowIso = new Date().toISOString();
  await gameCache.saveProfile({
    userKey: STEAM_ID,
    personaName: 'tester',
    ownerLabel: 'Me',
    importedAt: nowIso,
    fetchedAt: nowIso,
  });
  await gameCache.saveLibrary(STEAM_ID, {
    userKey: STEAM_ID,
    fetchedAt: nowIso,
    game_count: 2,
    partial: false,
    fingerprint: '292030,1091500',
    totalMinutes: 6000,
    games: [
      {
        appid: 292030,
        name: 'The Witcher 3: Wild Hunt',
        playtime_forever: 6000,
        playtime_2weeks: 0,
        rtime_last_played: 0,
      },
      {
        appid: 1091500,
        name: 'Cyberpunk 2077',
        playtime_forever: 0,
        playtime_2weeks: 0,
        rtime_last_played: 0,
      },
    ],
  });
  // Details: two Steam games, so years/genres are "applied".
  await gameCache.saveDetails(292030, {
    success: true,
    type: 'game',
    name: 'The Witcher 3: Wild Hunt',
    releaseYear: 2015,
    genres: [{ id: '3', description: 'RPG' }],
    developers: ['CD PROJEKT RED'],
    publishers: ['CD PROJEKT RED'],
    is_free: false,
  });
  await gameCache.saveDetails(1091500, {
    success: true,
    type: 'game',
    name: 'Cyberpunk 2077',
    releaseYear: 2020,
    genres: [{ id: '3', description: 'RPG' }],
    is_free: false,
  });

  gogCache.saveToken(GOG_KEY, {
    accessToken: 'secret-access',
    refreshToken: 'secret-refresh',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ownerProfile: OWNER,
    connectedAt: nowIso,
  });
  gogCache.saveProfile({ userKey: GOG_KEY, username: 'gog_tester', ownerProfile: OWNER });
  gogCache.saveLibrary(GOG_KEY, {
    fetchedAt: nowIso,
    ownerProfile: OWNER,
    products: GOG_PRODUCTS,
    fingerprint: GOG_PRODUCTS.map((product) => product.gogGameId).join(','),
  });
  // `1440000002` has no answer at all: the playtime phase never reached it.
  gogCache.savePlaytime(GOG_KEY, {
    fetchedAt: nowIso,
    ownerProfile: OWNER,
    minutes: { 1207658924: 600, 1440000001: 120 },
    entries: {
      1207658924: { minutes: 600, status: 'ok', field: 'time_sum', at: nowIso },
      1440000001: { minutes: 120, status: 'ok', field: 'time_sum', at: nowIso },
    },
    fetchedGames: 2,
  });

  await epicCache.saveEpicProfile({
    accountId: EPIC_ACCOUNT,
    ownerKey: OWNER,
    displayName: 'EpicTester',
    connectedAt: nowIso,
    importedAt: nowIso,
  });
  await epicCache.saveEpicLibrary(EPIC_ACCOUNT, {
    accountId: EPIC_ACCOUNT,
    fetchedAt: nowIso,
    games: EPIC_GAMES.map((game) => ({
      appName: game.appName,
      catalogItemId: game.catalogItemId,
      slug: game.slug,
      name: game.name,
      platforms: game.platforms,
    })),
    counts: { owned: EPIC_GAMES.length },
  });
  await epicCache.saveEpicPlaytime(EPIC_ACCOUNT, {
    accountId: EPIC_ACCOUNT,
    fetchedAt: nowIso,
    totalSeconds: 46800,
    totalMinutes: 780,
    byArtifactId: {
      'epic-cat-1': { artifactId: 'epic-cat-1', totalTimeSec: 36000, totalMinutes: 600 },
      'epic-cat-2': { artifactId: 'epic-cat-2', totalTimeSec: 10800, totalMinutes: 180 },
    },
  });
  await epicCache.saveEpicCatalogItem(EPIC_GAMES[0].catalogItemId, {
    catalogItemId: EPIC_GAMES[0].catalogItemId,
    title: EPIC_GAMES[0].name,
    slug: EPIC_GAMES[0].slug,
    releaseDate: EPIC_GAMES[0].releaseDate,
    developer: 'CD PROJEKT RED',
  });
  await epicCache.saveEpicCatalogItem(EPIC_GAMES[1].catalogItemId, {
    catalogItemId: EPIC_GAMES[1].catalogItemId,
    title: EPIC_GAMES[1].name,
    slug: EPIC_GAMES[1].slug,
    releaseDate: EPIC_GAMES[1].releaseDate,
    developer: 'Indie Dev',
  });
}

test('secondary works in every aggregate', async (t) => {
  await seed();

  await t.test('gameCount/worksTotal/totalHours include secondary-only works', () => {
    const payload = buildGamesStatsFromCache(OWNER);
    // 2 Steam works + Gothic 3 (GOG) + Epic Only Indie + Unknown Hours Game.
    // The Witcher 3 is ONE work (Steam + GOG + Epic) thanks to the title match.
    assert.equal(payload.summary.gameCount, 5);
    assert.equal(payload.summary.worksTotal, 5);
    assert.equal(payload.summary.secondaryOnlyWorks, 3);
    assert.equal(payload.summary.epicSecondaryGames, 1);
    // Steam journal: 6000 min = 100 h. GOG: 600 + 120 = 12 h. Epic: 780 min =
    // 13 h (10 h of them on the Witcher, which is the same work as Steam).
    assert.equal(payload.summary.totalHoursSteam, 100);
    assert.equal(payload.summary.hoursBySource.steam, 100);
    assert.equal(payload.summary.hoursBySource.gog, 12);
    assert.equal(payload.summary.hoursBySource.epic, 13);
    // Display total: 100 (Steam) + 12 (GOG) + 13 (Epic).
    assert.equal(payload.summary.totalHours, 125);
    assert.equal(payload.summary.hoursBySource.all, 125);
  });

  await t.test('payload contract: secondaryWorks/summary/chart flags are complete', () => {
    const payload = buildGamesStatsFromCache(OWNER);
    // Summary contract (the UI «Вне Steam» + «Источники» widgets read these).
    for (const key of [
      'worksTotal',
      'secondaryOnlyWorks',
      'secondaryWorksTotal',
      'hoursBySource',
      'chartsIncludeSecondary',
      'secondaryWorksInCharts',
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(payload.summary, key), `summary.${key}`);
    }
    assert.equal(payload.summary.chartsIncludeSecondary, true);
    assert.equal(payload.summary.secondaryWorksInCharts, 3);
    // Source blocks tell a fetched playtime snapshot from a missing one.
    assert.ok(
      Object.prototype.hasOwnProperty.call(payload.sources.gog, 'playtimeFetchedAt'),
      'sources.gog.playtimeFetchedAt'
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(payload.sources.epic, 'playtimeFetchedAt'),
      'sources.epic.playtimeFetchedAt'
    );
    assert.ok(payload.sources.gog.playtimeFetchedAt);
    assert.ok(payload.sources.epic.playtimeFetchedAt);

    // Every row carries the full card contract; hours are in HOURS.
    for (const entry of payload.secondaryWorks) {
      for (const key of [
        'name',
        'sources',
        'ownedOn',
        'storeIds',
        'hoursBySource',
        'releaseYear',
        'releaseDate',
        'genres',
      ]) {
        assert.ok(Object.prototype.hasOwnProperty.call(entry, key), `${entry.name}: ${key}`);
      }
      assert.ok(entry.storeIds && typeof entry.storeIds === 'object');
      assert.ok(entry.hoursBySource && typeof entry.hoursBySource === 'object');
      assert.equal(entry.hoursBySource.steam, null);
      assert.equal(entry.hoursBySource.gog === undefined, false);
      assert.equal(entry.hoursBySource.epic === undefined, false);
      // No internal minute field leaks into the payload.
      assert.equal(Object.prototype.hasOwnProperty.call(entry, 'displayMinutes'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(entry, 'secondaryMinutes'), false);
      if (entry.sources.includes('gog')) {
        for (const key of ['slug', 'image', 'releaseDate', 'playtimeKnown']) {
          assert.ok(Object.prototype.hasOwnProperty.call(entry.gog, key), `${entry.name}: gog.${key}`);
        }
      }
      if (entry.sources.includes('epic')) {
        for (const key of ['slug', 'releaseDate', 'image', 'genres']) {
          assert.ok(Object.prototype.hasOwnProperty.call(entry.epic, key), `${entry.name}: epic.${key}`);
        }
      }
    }
    const gothic = payload.secondaryWorks.find((entry) => entry.name === 'Gothic 3');
    assert.equal(gothic.gog.playtimeKnown, true);
    assert.equal(gothic.hoursBySource.gog, 2);
    assert.equal(gothic.releaseDate, '2006-10-13');
    const unknown = payload.secondaryWorks.find((entry) => entry.name === 'Unknown Hours Game');
    assert.equal(unknown.gog.playtimeKnown, false);
    assert.equal(unknown.hoursBySource.gog, null);
    const epicOnly = payload.secondaryWorks.find((entry) => entry.name === 'Epic Only Indie');
    assert.equal(epicOnly.epic.playtimeKnown, true);
    assert.deepEqual(epicOnly.epic.genres, []);
    assert.equal(epicOnly.epic.image, null);
    assert.equal(epicOnly.hoursBySource.epic, 3);

    // Per-bucket inclusion counters (additive contract).
    assert.equal(payload.years.find((entry) => entry.year === 2006).secondaryCount, 1);
    assert.equal(payload.years.find((entry) => entry.year === 2020).secondaryCount, 1);
    assert.equal(payload.years.find((entry) => entry.year == null).secondaryCount, 1);
    assert.equal(payload.decades.find((entry) => entry.decade === 2000).secondaryCount, 1);
    for (const bucket of payload.genres) {
      assert.equal(typeof bucket.secondaryCount, 'number');
    }
  });

  await t.test('years and decades carry the store release dates', () => {
    const payload = buildGamesStatsFromCache(OWNER);
    const yearOf = (year) => payload.years.find((entry) => entry.year === year);
    // 2015: Witcher 3 (Steam + GOG + Epic, one row) + nothing else.
    assert.equal(yearOf(2015).count, 1);
    // Gothic 3 is a GOG-only 2006 release.
    assert.equal(yearOf(2006).count, 1);
    // Epic Only Indie 2020 + Cyberpunk 2020.
    assert.equal(yearOf(2020).count, 2);
    const decade = (value) => payload.decades.find((entry) => entry.decade === value);
    assert.equal(decade(2000).count, 1); // Gothic 3 (2006)
    assert.equal(decade(2020).count, 2); // Cyberpunk 2077 + Epic Only Indie
    // The unknown-hours GOG game has no release date → honest `unknown` bucket.
    const unknown = payload.years.find((entry) => entry.year == null);
    assert.ok(unknown);
    assert.equal(unknown.count, 1);
    assert.equal(unknown.unknown, true);
  });

  await t.test('genres include secondary works when the store knows a genre', () => {
    const payload = buildGamesStatsFromCache(OWNER);
    // Steam's two RPGs + the Witcher's GOG row (same work, one genre count).
    const rpg = payload.genres.find((entry) => entry.name === 'RPG');
    assert.equal(rpg.count, 2);
    // A store with no genre field contributes nothing — no invented genre.
    assert.equal(payload.genres.some((entry) => entry.name === 'Action'), false);
  });

  await t.test('the histogram, mean and top list see the secondary hours', () => {
    const payload = buildGamesStatsFromCache(OWNER);
    const total = payload.hoursHistogram.reduce((sum, bucket) => sum + bucket.count, 0);
    assert.equal(total, payload.summary.gameCount);
    const witcher = payload.topGames.find((row) => row.name === 'The Witcher 3: Wild Hunt');
    // Steam 100 h + GOG 10 h + Epic 10 h.
    assert.equal(witcher.hours, 120);
    assert.deepEqual(witcher.sources, ['steam', 'gog', 'epic']);
    // Payload contract: hours, not minutes (Steam 100 + GOG 10 + Epic 10).
    assert.deepEqual(witcher.hoursBySource, { steam: 100, gog: 10, epic: 10 });
    const epicOnly = payload.topGames.find((row) => row.name === 'Epic Only Indie');
    assert.ok(epicOnly);
    assert.equal(epicOnly.appid, null);
    assert.equal(epicOnly.hours, 3);
    assert.equal(epicOnly.source, 'epic');
  });

  await t.test('secondary-only works are in gamesIndex under their own workKey', () => {
    const payload = buildGamesStatsFromCache(OWNER);
    const gothic = payload.gamesIndex['gog:1440000001'];
    assert.ok(gothic);
    assert.equal(gothic.appid, null);
    assert.equal(gothic.secondaryOnly, true);
    assert.equal(gothic.releaseYear, 2006);
    assert.equal(gothic.hours, 2);
    assert.deepEqual(gothic.hoursBySource, { steam: null, gog: 2, epic: null });
    const epic = payload.gamesIndex['epic:epic-cat-2'];
    assert.ok(epic);
    assert.equal(epic.source, 'epic');
    assert.equal(epic.hours, 3);
  });

  await t.test('minHours keeps a secondary work with unknown hours', () => {
    const payload = buildGamesStatsFromCache(OWNER, { minHours: 0 });
    const names = payload.secondaryWorks.map((entry) => entry.name);
    // Gothic 3 has 2 h → kept; Epic Only Indie 3 h → kept; the GOG game whose
    // playtime never arrived → kept and flagged, never silently dropped.
    assert.deepEqual(names.sort(), ['Epic Only Indie', 'Gothic 3', 'Unknown Hours Game']);
    const unknown = payload.secondaryWorks.find((entry) => entry.name === 'Unknown Hours Game');
    assert.equal(unknown.hoursUnknown, true);
    assert.equal(unknown.hoursStatus.gog, 'pending');
    assert.equal(unknown.hoursBySource.gog, null);
    // Unknown hours are their own bucket: not «played», not «backlog».
    assert.equal(payload.summary.hoursUnknownCount, 1);
    assert.equal(
      payload.backlog.items.some((item) => item.name === 'Unknown Hours Game'),
      false
    );
    // The Steam 0-hour backlog row is filtered out as before.
    assert.equal(payload.summary.gameCount, 4);
    assert.equal(payload.meta.filters.minHours.keptSecondaryUnknownHours, 1);
  });

  await t.test('minHours drops a secondary work with a real zero', () => {
    gogCache.savePlaytime(GOG_KEY, {
      fetchedAt: new Date().toISOString(),
      minutes: { 1207658924: 600, 1440000001: 120, 1440000002: 0 },
      entries: {
        1207658924: { minutes: 600, status: 'ok', at: new Date().toISOString() },
        1440000001: { minutes: 120, status: 'ok', at: new Date().toISOString() },
        1440000002: { minutes: 0, status: 'ok', at: new Date().toISOString() },
      },
    });
    const payload = buildGamesStatsFromCache(OWNER, { minHours: 0 });
    assert.equal(
      payload.secondaryWorks.some((entry) => entry.name === 'Unknown Hours Game'),
      false
    );
    assert.equal(payload.meta.filters.minHours.excludedSecondary, 1);
  });

  await t.test('a Steam work with 0 Steam hours but GOG hours passes minHours', () => {
    const library = gogCache.getLibrary(GOG_KEY);
    gogCache.saveLibrary(GOG_KEY, {
      ...library,
      products: [
        ...library.products,
        {
          gogGameId: '1440000003',
          title: 'Cyberpunk 2077',
          slug: 'cyberpunk_2077',
          category: 'game',
          isGame: true,
          releaseDate: '2020-12-10',
        },
      ],
    });
    const playtime = gogCache.getPlaytime(GOG_KEY);
    gogCache.savePlaytime(GOG_KEY, {
      ...playtime,
      minutes: { ...playtime.minutes, 1440000003: 600 },
      entries: {
        ...playtime.entries,
        1440000003: { minutes: 600, status: 'ok', field: 'time_sum', at: new Date().toISOString() },
      },
    });
    const payload = buildGamesStatsFromCache(OWNER, { minHours: 0 });
    // One work, not two rows: the GOG copy of Cyberpunk is the same work.
    const cyber = payload.gamesIndex['1091500'];
    assert.ok(cyber);
    assert.deepEqual(cyber.sources, ['steam', 'gog']);
    const top = payload.topGames.find((row) => row.name === 'Cyberpunk 2077');
    assert.equal(top.hours, 10);
    assert.deepEqual(top.hoursBySource, { steam: 0, gog: 10, epic: null });
  });

  await t.test('the recent strip stays honest: no invented lastPlayed', () => {
    const payload = buildGamesStatsFromCache(OWNER);
    for (const row of payload.recentlyPlayed) {
      assert.equal(row.appid != null, true);
    }
    assert.equal(payload.secondaryWorks.every((entry) => entry.epic == null || entry.epic.status), true);
  });

  await t.test('a Steam-only payload is unchanged (no cross-store fields)', () => {
    const payload = buildGamesStatsFromCache(OWNER, { minHours: -1 });
    assert.ok(payload.summary.hoursBySource.all > 0);
    assert.equal(payload.summary.secondaryWorksVisible, 3);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'worksIndex'), false);
  });

  await t.test('stats reads the cached Wikidata bridge (no WDQS call)', () => {
    // A GOG row whose title differs from Steam joins through the cached
    // `links/secondary.json` written by the import job, not a network call.
    const library = gogCache.getLibrary(GOG_KEY);
    const bridgeProduct = {
      gogGameId: '1440000009',
      title: 'Vedmak 3 (bridge only)',
      slug: 'the_witcher_3_wild_hunt_bridge',
      category: 'game',
      isGame: true,
      releaseDate: '2015-05-18',
    };
    gogCache.saveLibrary(GOG_KEY, {
      ...library,
      products: [...library.products, bridgeProduct],
    });
    const linksDir = path.join(CACHE_DIR, 'links');
    fs.mkdirSync(linksDir, { recursive: true });
    fs.writeFileSync(
      path.join(linksDir, 'secondary.json'),
      JSON.stringify({
        schemaVersion: 1,
        source: 'wikidata',
        fetchedAt: new Date().toISOString(),
        entries: {
          'gog:the_witcher_3_wild_hunt_bridge': {
            qid: 'Q4267401',
            appid: '292030',
            store: 'gog',
          },
        },
      })
    );
    const payload = buildGamesStatsFromCache(OWNER, { minHours: -1 });
    const witcher = payload.gamesIndex['292030'];
    // The seeded Epic copy already joined this work by title; the bridge adds
    // the GOG row, so all three sources are present on one work.
    assert.deepEqual(witcher.sources, ['steam', 'gog', 'epic']);
    assert.equal(witcher.storeIds.gog, '1440000009');
    assert.equal(witcher.crossStoreMatchedBy, 'wikidata');
    // The bridge row is the same work: no extra union row, no duplicate.
    assert.equal(
      payload.secondaryWorks.some((entry) => entry.name === 'Vedmak 3 (bridge only)'),
      false
    );
    // Restore the library so later reruns (and the cache) stay clean.
    gogCache.saveLibrary(GOG_KEY, library);
    fs.rmSync(path.join(linksDir, 'secondary.json'), { force: true });
  });
});
