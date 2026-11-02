'use strict';

/**
 * Fix-round 02.11.2026 — «год работы из Wikidata P577» для GOG/Epic partial.
 *
 * Production complaint: an Epic catalog answer can carry genres but no release
 * date (`genresOk true, yearHas false`), and the store has no other date at
 * all — the detail is `partial` forever even though the game has a Wikidata
 * item. The identity bridge (`secondary-identity.js`) resolves the slug to a
 * QID already; this round also asks `P577` (with statement precision) in the
 * same batch and caches `releaseYear` / `releaseDate` /
 * `releaseDateSource: 'wikidata'` per `(source, slug)`.
 *
 * These tests pin:
 *   - the SPARQL adds P577 to the one identity batch (no extra request);
 *   - `releaseDate` only exists for a **day**-precision statement;
 *   - the cache is settled for a QID without P577 and heals a pre-P577 entry;
 *   - an Epic partial / a GOG product without a store date takes the year from
 *     the bridge, never replacing a store/catalog year and never touching
 *     genres;
 *   - no bridged QID/year → the detail stays honestly partial (no fake year);
 *   - coverage moves `partial -> resolved` once the year arrives;
 *   - the union reports the same mark as `releaseYearSource: 'wikidata'`.
 *
 * No live request: every store client is injected and the bridge cache is the
 * fixture `test/fixtures/games/secondary-links.json` (AW2 values are the live
 * WDQS answer of 02.11.2026: P6278 `alan-wake-2` -> Q108417001, P577
 * 2023-10-27, precision 11).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-wd-year-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-wd-year-state-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = STATE_DIR;
process.env.KINOBOXD_STEAM_KEY_FILE = path.join(STATE_DIR, 'no-steam-token');
process.env.GAMES_SECONDARY_PAUSE_MS = '1';

const identity = require('../server/games/secondary-identity');
const details = require('../server/games/secondary-details');
const gameCache = require('../server/games/game-cache');
const epicCache = require('../server/games/epic-cache');
const tokenStore = require('../server/games/epic-token-store');

const FIXTURES = path.join(__dirname, 'fixtures', 'games');
const LINKS_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'secondary-links.json'), 'utf8')
);
const GOG_WITCHER = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'gog', 'product-1207658924.json'), 'utf8')
);
const NOW = new Date().toISOString();

/* ------------------------------- helpers -------------------------- */

/** Fresh bridge cache from the fixture (`writeCache` stamps `fetchedAt`). */
function seedBridge(entries = LINKS_FIXTURE.entries) {
  identity.writeCache(entries);
  return identity.readSecondaryLinks();
}

function clearedBridge() {
  try {
    fs.rmSync(identity.CACHE_PATH, { force: true });
  } catch (err) {
    /* nothing to clean */
  }
}

function clearDetails() {
  try {
    for (const name of fs.readdirSync(details.CACHE_DIR)) {
      if (name.endsWith('.json')) fs.unlinkSync(path.join(details.CACHE_DIR, name));
    }
  } catch (err) {
    /* nothing to clean */
  }
  details.writeBreaker({});
  details.resetJobs();
}

function fakeClient(handlers = {}) {
  const calls = [];
  return {
    calls,
    async getJson(url) {
      calls.push(url);
      const key = Object.keys(handlers).find((needle) => url.includes(needle));
      if (!key) throw new Error(`unexpected URL in test: ${url}`);
      const value = handlers[key];
      if (typeof value === 'function') return value(url);
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
  };
}

/**
 * An Epic CMS page with a genre line but **no** release date — the `yearHas
 * false` half of the production symptom (the catalog then answers genres only).
 */
function epicCmsWithoutDate() {
  return {
    productName: 'Alan Wake 2',
    pages: [
      {
        type: 'productHome',
        productName: 'Alan Wake 2',
        data: {
          meta: { tags: ['HORROR'], developer: ['Remedy Entertainment'] },
          hero: {
            portraitBackgroundImageUrl:
              'https://cdn1.epicgames.com/aw2/portrait-1200x1600.jpg',
          },
          about: {},
        },
      },
    ],
  };
}

/** The GOG v2 page with neither `globalReleaseDate` nor `gogReleaseDate`. */
function gogProductWithoutDate(id = 1229800000) {
  const payload = JSON.parse(JSON.stringify(GOG_WITCHER));
  delete payload._embedded.product.globalReleaseDate;
  delete payload._embedded.product.gogReleaseDate;
  payload._embedded.product.id = id;
  return payload;
}

function partialEpicDetail(options = {}) {
  const slug = options.slug || 'alan-wake-2';
  const data = {
    schemaVersion: 1,
    source: 'epic',
    id: slug,
    title: options.title || 'Alan Wake 2',
    slug,
    genres: ['Horror'],
    genresSource: 'epic-catalog',
    tags: ['Horror'],
    releaseDate: null,
    releaseYear: null,
    releaseDateSource: null,
    globalReleaseDate: null,
    storeReleaseDate: null,
    verticalCover: null,
    image: null,
    logo: null,
    developers: ['Remedy Entertainment'],
    publishers: [],
    series: null,
    platforms: [],
    fetchedAt: NOW,
    catalogChecked: true,
    metaStatus: 'partial',
    metaYearHas: false,
    metaGenresOk: true,
    ...(options.extra || {}),
  };
  details.writeDetail('epic', slug, 'ok', data);
  return data;
}

async function seedOwner({ steamId, owner, account, catalogItemId, slug = 'alan-wake-2' }) {
  await gameCache.saveProfile({
    userKey: steamId,
    personaName: 'wd-year',
    privacy: 'public',
    importedAt: NOW,
    fetchedAt: NOW,
  });
  await gameCache.saveLibrary(steamId, {
    fetchedAt: NOW,
    partial: false,
    source: 'steam-webapi',
    game_count: 0,
    games: [],
  });
  await epicCache.saveEpicProfile({ accountId: account, ownerKey: owner, connectedAt: NOW });
  await epicCache.saveEpicLibrary(account, {
    accountId: account,
    ownerKey: owner,
    fetchedAt: NOW,
    games: [{ appName: 'Ginger', catalogItemId, slug, name: 'Alan Wake 2' }],
  });
  await tokenStore.saveTokens({
    accountId: account,
    displayName: 'WD year',
    ownerKey: owner,
    accessToken: 'eg1~fake-access-token',
    refreshToken: 'eg1~fake-refresh-token',
    accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
  });
}

/* -------------------------------- tests --------------------------- */

test('wikidata P577 in the secondary identity batch', async (t) => {
  await t.test('the one batch query also asks P577 with precision', () => {
    const query = identity.buildBridgeQuery({
      gogSlugs: ['the_witcher'],
      epicSlugs: ['alan-wake-2'],
    });
    assert.match(query, /P6278/);
    assert.match(query, /P2725/);
    assert.match(query, /p:P577 \?st/);
    assert.match(query, /wikibase:timeValue \?date/);
    assert.match(query, /wikibase:timePrecision \?precision/);
    assert.match(query, /\?date \?precision/);
  });

  await t.test('a day-precision P577 becomes a year + an exact date', () => {
    const entries = identity.parseBridgeResponse({
      results: {
        bindings: [
          {
            item: { value: 'http://www.wikidata.org/entity/Q108417001' },
            store: { value: 'epic' },
            slug: { value: 'alan-wake-2' },
            date: { value: '2023-10-27T00:00:00Z' },
            precision: { value: '11' },
          },
        ],
      },
    });
    assert.deepEqual(entries['epic:alan_wake_2'], {
      qid: 'Q108417001',
      appid: null,
      store: 'epic',
      releaseYear: 2023,
      releasePrecision: 'day',
      releaseDate: '2023-10-27',
      releaseDateSource: 'wikidata',
    });
  });

  await t.test('several P577 values: earliest year wins, month precision has no date', () => {
    const entries = identity.parseBridgeResponse({
      results: {
        bindings: [
          {
            item: { value: 'http://www.wikidata.org/entity/Q270054' },
            store: { value: 'gog' },
            slug: { value: 'the_witcher' },
            date: { value: '2011-05-09T00:00:00Z' },
            precision: { value: '11' },
          },
          {
            item: { value: 'http://www.wikidata.org/entity/Q270054' },
            store: { value: 'gog' },
            slug: { value: 'the_witcher' },
            date: { value: '2007-10-01T00:00:00Z' },
            precision: { value: '10' },
          },
        ],
      },
    });
    assert.equal(entries['gog:the_witcher'].releaseYear, 2007);
    assert.equal(entries['gog:the_witcher'].releasePrecision, 'month');
    assert.equal(entries['gog:the_witcher'].releaseDate, null, 'a month is not a day');
    assert.equal(entries['gog:the_witcher'].releaseDateSource, 'wikidata');
  });

  await t.test('a QID without P577 is a settled answer, not a retry loop', async () => {
    clearedBridge();
    const fetchImpl = async () => jsonResponse({
      results: {
        bindings: [
          {
            item: { value: 'http://www.wikidata.org/entity/Q999001' },
            store: { value: 'epic' },
            slug: { value: 'undated-game' },
          },
        ],
      },
    });
    const first = await identity.fetchSecondaryLinks(
      { epicSlugs: ['undated-game'] },
      { fetchImpl }
    );
    assert.equal(first.queries, 1);
    assert.equal(first.entries['epic:undated_game'].releaseYear, null);
    assert.equal(first.entries['epic:undated_game'].releaseDateSource, null);

    // Settled: a second pass must not ask WDQS again.
    let calls = 0;
    const second = await identity.fetchSecondaryLinks(
      { epicSlugs: ['undated-game'] },
      {
        fetchImpl: async () => {
          calls++;
          return jsonResponse({ results: { bindings: [] } });
        },
      }
    );
    assert.equal(calls, 0);
    assert.equal(second.queries, 0);
    assert.equal(second.cached, 1);
  });

  await t.test('an entry written before P577 is re-asked once (deploy heal)', async () => {
    clearedBridge();
    // Old schema: a QID, no `releaseDateSource` key at all.
    identity.writeCache({
      'epic:alan_wake_2': { qid: 'Q108417001', appid: null, store: 'epic' },
    });
    const fetchImpl = async () =>
      jsonResponse({
        results: {
          bindings: [
            {
              item: { value: 'http://www.wikidata.org/entity/Q108417001' },
              store: { value: 'epic' },
              slug: { value: 'alan-wake-2' },
              date: { value: '2023-10-27T00:00:00Z' },
              precision: { value: '11' },
            },
          ],
        },
      });
    const report = await identity.fetchSecondaryLinks(
      { epicSlugs: ['alan-wake-2'] },
      { fetchImpl }
    );
    assert.equal(report.queries, 1, 'the old entry is not trusted for the date');
    assert.equal(report.entries['epic:alan_wake_2'].releaseYear, 2023);
    assert.equal(identity.readSecondaryLinks()['epic:alan_wake_2'].releaseDate, '2023-10-27');
  });
});

test('applyWikidataYear is additive only', async (t) => {
  await t.test('fills an empty year from the bridged item', () => {
    seedBridge();
    const data = details.applyWikidataYear(
      { source: 'epic', slug: 'alan-wake-2', releaseYear: null, releaseDate: null },
      { store: 'epic' }
    );
    assert.equal(data.releaseYear, 2023);
    assert.equal(data.releaseDate, '2023-10-27');
    assert.equal(data.releaseDateSource, 'wikidata');
  });

  await t.test('a store/catalog year is never replaced', () => {
    seedBridge();
    const original = {
      source: 'epic',
      slug: 'alan-wake-2',
      releaseYear: 2015,
      releaseDate: '2015-05-19',
      releaseDateSource: 'epic-store',
    };
    assert.equal(details.applyWikidataYear(original, { store: 'epic' }), original);
  });

  await t.test('no QID, no P577 or an unknown slug changes nothing', () => {
    seedBridge();
    const noQid = {
      source: 'epic',
      slug: 'no-qid-game',
      releaseYear: null,
      releaseDateSource: null,
    };
    const noDate = {
      source: 'epic',
      slug: 'undated-game',
      releaseYear: null,
      releaseDateSource: null,
    };
    const unknown = { source: 'epic', slug: 'never-asked', releaseYear: null };
    assert.equal(details.applyWikidataYear(noQid, { store: 'epic' }), noQid);
    assert.equal(details.applyWikidataYear(noDate, { store: 'epic' }), noDate);
    assert.equal(details.applyWikidataYear(unknown, { store: 'epic' }), unknown);
  });

  await t.test('no bridge cache at all (pass never ran) changes nothing', () => {
    clearedBridge();
    const data = { source: 'epic', slug: 'alan-wake-2', releaseYear: null };
    assert.equal(details.applyWikidataYear(data, { store: 'epic' }), data);
  });
});

test('Epic partial gets the year from Wikidata', async (t) => {
  await t.test('cached partial (genres only) is healed and genres are untouched', async () => {
    clearDetails();
    seedBridge();
    partialEpicDetail();

    const before = details.readDetail('epic', 'alan-wake-2').doc.data;
    assert.equal(before.releaseYear, null);
    assert.deepEqual(before.genres, ['Horror']);

    // A cache hit: no CMS/catalog client is provided, so any request would throw.
    const resolved = await details.resolveEpic('alan-wake-2', {});
    assert.equal(resolved.cached, true);
    assert.equal(resolved.data.releaseYear, 2023);
    assert.equal(resolved.data.releaseDate, '2023-10-27');
    assert.equal(resolved.data.releaseDateSource, 'wikidata');
    assert.deepEqual(resolved.data.genres, ['Horror'], 'genres are not rewritten');
    assert.equal(resolved.data.storeReleaseDate, null, 'the store date field is not faked');
    assert.equal(resolved.data.metaStatus, 'complete');
    assert.equal(resolved.data.metaYearHas, true);

    // Persisted: the next /stats sees the year without another resolve.
    const doc = details.readDetail('epic', 'alan-wake-2').doc;
    assert.equal(doc.data.releaseYear, 2023);
    assert.equal(doc.data.releaseDateSource, 'wikidata');
  });

  await t.test('CMS page with genres but no date: the year comes from P577', async () => {
    clearDetails();
    seedBridge();
    const cms = fakeClient({ 'content/products/alan-wake-2': epicCmsWithoutDate() });
    const resolved = await details.resolveEpic('alan-wake-2', {
      client: cms,
      title: 'Alan Wake 2',
    });
    assert.equal(resolved.status, 'ok');
    assert.equal(cms.calls.length, 1);
    assert.deepEqual(resolved.data.genres, ['Horror']);
    assert.deepEqual(resolved.data.developers, ['Remedy Entertainment']);
    assert.match(resolved.data.verticalCover, /1200x1600/);
    assert.equal(resolved.data.releaseYear, 2023);
    assert.equal(resolved.data.releaseDate, '2023-10-27');
    assert.equal(resolved.data.releaseDateSource, 'wikidata');
    assert.equal(resolved.data.storeReleaseDate, null);
    assert.equal(resolved.data.metaStatus, 'complete');
  });

  await t.test('no bridged year: the detail stays partial, no fake year', async () => {
    clearDetails();
    // Bridge has the item but no P577 (`undated-game`).
    seedBridge();
    details.writeDetail('epic', 'undated-game', 'ok', {
      ...partialEpicDetail({ slug: 'undated-game', title: 'Undated Game' }),
    });
    const resolved = await details.resolveEpic('undated-game', {});
    assert.equal(resolved.data.releaseYear, null);
    assert.equal(resolved.data.releaseDateSource, null);
    assert.equal(resolved.data.metaStatus, 'partial');
    assert.equal(details.readDetail('epic', 'undated-game').doc.data.releaseYear, null);
  });

  await t.test('coverage moves partial -> resolved once the year is known', async () => {
    clearDetails();
    seedBridge();
    const steamId = '76561198000000715';
    const owner = `steam-${steamId}`;
    const account = 'epic-wd-year';
    await seedOwner({ steamId, owner, account, catalogItemId: 'wd-year-cat' });
    partialEpicDetail();

    const before = details.coverageForOwner(owner);
    assert.equal(before.epic.total, 1);
    assert.equal(before.epic.resolved, 0);
    assert.equal(before.epic.partial, 1);

    // No catalogItemId: this test proves the year heal alone (the catalog step
    // is a separate path with its own token/client and must not be reached).
    await details.resolveEpic('alan-wake-2', { ownerKey: owner });

    const after = details.coverageForOwner(owner);
    assert.equal(after.epic.resolved, 1, '1/1 after the year arrived');
    assert.equal(after.epic.partial, 0);
    assert.equal(after.resolved, after.total);
  });
});

test('GOG partial gets the year from Wikidata', async (t) => {
  await t.test('a product page without any date is completed from P577', async () => {
    clearDetails();
    seedBridge();
    const payload = gogProductWithoutDate(1229800000);
    const client = fakeClient({ 'api.gog.com/v2/games/1229800000': payload });
    const resolved = await details.resolveGog('1229800000', {
      slug: 'the_witcher',
      client,
    });
    assert.equal(resolved.status, 'ok');
    // The store id is kept exactly as given by the store (no rounding).
    assert.equal(resolved.data.id, '1229800000');
    assert.deepEqual(resolved.data.genres, ['Role-playing', 'Action', 'Fantasy']);
    assert.equal(resolved.data.releaseYear, 2007);
    assert.equal(resolved.data.releaseDate, '2007-10-26');
    assert.equal(resolved.data.releaseDateSource, 'wikidata');
    assert.equal(resolved.data.storeReleaseDate, null);
    assert.equal(resolved.data.globalReleaseDate, null);
  });

  await t.test('a cached GOG detail without a year is healed in place', async () => {
    clearDetails();
    seedBridge();
    details.writeDetail('gog', '1229800000', 'ok', {
      schemaVersion: 1,
      source: 'gog',
      id: '1229800000',
      title: 'The Witcher: Enhanced Edition',
      slug: 'the_witcher',
      genres: ['Role-playing', 'Action'],
      tags: [],
      releaseDate: null,
      releaseYear: null,
      releaseDateSource: null,
      globalReleaseDate: null,
      storeReleaseDate: null,
      verticalCover: null,
      image: null,
      logo: null,
      developers: [],
      publishers: [],
      series: null,
      platforms: [],
      fetchedAt: NOW,
    });
    const resolved = await details.resolveGog('1229800000', { slug: 'the_witcher' });
    assert.equal(resolved.cached, true);
    assert.equal(resolved.data.releaseYear, 2007);
    assert.equal(resolved.data.releaseDateSource, 'wikidata');
    assert.deepEqual(resolved.data.genres, ['Role-playing', 'Action']);
  });

  await t.test('a store date is not replaced by the bridged one', async () => {
    clearDetails();
    seedBridge();
    const client = fakeClient({ 'api.gog.com/v2/games/1229800000': GOG_WITCHER });
    const resolved = await details.resolveGog('1229800000', {
      slug: 'the_witcher',
      client,
    });
    assert.equal(resolved.data.releaseYear, 2007);
    assert.equal(resolved.data.releaseDateSource, 'gog-global');
    assert.equal(resolved.data.globalReleaseDate, '2007-10-26T00:00:00+02:00');
  });
});

test('the union reports the Wikidata provenance', async (t) => {
  await t.test('releaseYearSource becomes wikidata, Steam-derived data is kept', () => {
    seedBridge();
    const union = {
      works: [
        {
          workKey: 'epic:aw2',
          minutes: 120,
          primary: { name: 'Alan Wake 2' },
          releaseYear: null,
          releaseYearSource: null,
          epic: { slug: 'alan-wake-2', catalogItemId: 'aw2-cat' },
        },
      ],
    };
    details.enrichUnionWithDetails(union, {
      'epic:alan-wake-2': {
        source: 'epic',
        id: 'alan-wake-2',
        genres: ['Horror'],
        genresSource: 'epic-catalog',
        releaseYear: 2023,
        releaseDate: '2023-10-27',
        releaseDateSource: 'wikidata',
        fetchedAt: NOW,
      },
    });
    const entry = union.works[0];
    assert.equal(entry.releaseYear, 2023);
    assert.equal(entry.releaseYearSource, 'wikidata');
    assert.deepEqual(entry.genres, ['Horror']);
    assert.equal(entry.secondaryDetails.releaseDateSource, 'wikidata');
    assert.equal(entry.secondaryDetails.metaStatus, 'complete');
  });
});
