'use strict';

/**
 * M6d secondary-details: the store-metadata job, its cache and its status.
 *
 * Merged from `games-secondary-details.test.js`,
 * `games-secondary-details-status.test.js` and `games-secondary-kick-partial.test.js`
 * — one job, one file. Every assertion of the three files is kept; each block
 * is scoped so the helper names cannot clash.
 *
 * All network calls are mocked (`client.getJson`); live requests are never made
 * from `npm test` (ИГРЫ §14.5).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-secondary-details-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-secondary-details-state-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = STATE_DIR;
process.env.KINOBOXD_STEAM_KEY_FILE = path.join(STATE_DIR, 'no-steam-token');
process.env.GAMES_SECONDARY_PAUSE_MS = '1';

const { createRouter } = require('../server/games/routes');
const gameCache = require('../server/games/game-cache');
const gogCache = require('../server/games/gog-cache');
const epicCache = require('../server/games/epic-cache');
const tokenStore = require('../server/games/epic-token-store');
const details = require('../server/games/secondary-details');
const identity = require('../server/games/secondary-identity');
const epicLayer = require('../server/games/epic-layer');
const { buildSecondaryUnion } = require('../server/games/secondary-union');
const { buildGamesStatsFromCache } = require('../server/games/stats');

/**
 * Settle the previous block, then wipe every cached document and state file.
 *
 * The three merged files used to run in separate processes with their own tmp
 * roots. A job started by the previous block can still be in flight when this
 * one begins (its fake client resolves on the next tick), so the wipe waits
 * for it first — otherwise a stale probe-negative or a fresh detail would
 * change the next block's expectations.
 */
async function settleWorld() {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const wipe = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) wipe(full);
      else if (entry.name.endsWith('.json')) fs.rmSync(full, { force: true });
    }
  };
  wipe(CACHE_DIR);
  wipe(STATE_DIR);
  details.resetJobs();
}

/* ---- was games-secondary-details.test.js ---- */
{
const FIXTURES = path.join(__dirname, 'fixtures', 'games');
function fixture(relative) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, relative), 'utf8'));
}

const GOG_WITCHER = fixture('gog/product-1207658924.json');
const GOG_HEROES = fixture('gog/product-1207658787.json');
const EPIC_WITCHER = fixture('epic/product-the-witcher-3-wild-hunt.json');
// Alan Wake 2: an Epic exclusive whose CMS page is stale (`meta` has only
// `customReleaseDate: "Coming Soon"`, no tags/releaseDate/developer) and whose
// appName is absent from `productmapping` (~1 283 records). Live 02.11.2026.
const EPIC_AW2 = fixture('epic/product-alan-wake-2.json');
const AW2_CATALOG = {
  catalogItemId: 'aw2-catalog',
  title: 'Alan Wake 2',
  slug: 'alan-wake-2',
  developer: 'Remedy Entertainment',
  publisher: 'Epic Games Publishing',
  releaseDate: '2023-10-27T00:00:00.000Z',
  categories: [{ path: 'games' }, { path: 'games/action' }, { path: 'games/horror' }],
};

function cacheFile(source, id) {
  return path.join(details.CACHE_DIR, `${source}-${id}.json`);
}

/** Remove every cached detail between test groups (the cache is global). */
function clearCache() {
  for (const name of fs.readdirSync(details.CACHE_DIR)) {
    if (name.endsWith('.json')) fs.unlinkSync(path.join(details.CACHE_DIR, name));
  }
  details.writeBreaker({});
  // Slug overrides live in the Epic catalog dir (global, like the details).
  try {
    fs.rmSync(epicCache.slugOverridesPath(), { force: true });
  } catch (err) {
    /* nothing to clean */
  }
  // Negative catalog probes are per catalogItemId; each case uses its own id,
  // but a clean slate keeps the assertions about «no second request» honest.
  try {
    for (const name of fs.readdirSync(details.CATALOG_PROBE_DIR)) {
      if (name.endsWith('.json')) fs.unlinkSync(path.join(details.CATALOG_PROBE_DIR, name));
    }
  } catch (err) {
    /* nothing to clean */
  }
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

/** Fake Epic client with only the catalog surface used by the details job. */
function fakeCatalogClient(options = {}) {
  const calls = [];
  let call = 0;
  return {
    calls,
    refreshedWith: null,
    async getCatalogBulk(namespace, ids) {
      calls.push({ namespace, ids: [...ids] });
      call++;
      if (typeof options.onCatalog === 'function') return options.onCatalog(call, ids);
      return { items: options.items || {}, requests: 1, failures: options.failures || [] };
    },
    async refreshTokens(refreshToken) {
      this.refreshedWith = refreshToken;
      if (typeof options.refresh === 'function') return options.refresh(refreshToken);
      if (options.refreshError) throw options.refreshError;
      return {
        accessToken: 'eg1~refreshed-access',
        refreshToken: 'eg1~refreshed-refresh',
        accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        refreshExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
      };
    },
  };
}

async function seedEpicOwner(ownerKey, accountId, options = {}) {
  const nowIso = new Date().toISOString();
  await epicCache.saveEpicProfile({ accountId, ownerKey, connectedAt: nowIso });
  await tokenStore.saveTokens({
    accountId,
    displayName: 'EpicTester',
    ownerKey,
    accessToken: 'eg1~fake-access-token',
    refreshToken: options.refreshToken === undefined ? 'eg1~fake-refresh-token' : options.refreshToken,
    accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
  });
  return accountId;
}

function authExpired() {
  return Object.assign(new Error('401'), { code: 'epic_auth_expired', status: 401 });
}

async function waitForJob(ownerKey, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    const job = details.jobFor(ownerKey);
    if (job && job.status !== 'running') return job;
    if (Date.now() - started > timeoutMs) throw new Error('job did not finish in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/* ------------------------------------------------------------------ */
/* normalization                                                       */
/* ------------------------------------------------------------------ */

test('secondary details', async (t) => {
  await t.test('yearOfDate reads both store date shapes', () => {
    assert.equal(details.yearOfDate('2015-05-18'), 2015);
    assert.equal(details.yearOfDate('2023.09.26'), 2023);
    assert.equal(details.yearOfDate('2007-10-26T00:00:00+02:00'), 2007);
    assert.equal(details.yearOfDate(null), null);
    assert.equal(details.yearOfDate('nope'), null);
  });

  await t.test('absoluteUrl upgrades protocol-relative GOG URLs', () => {
    assert.equal(details.absoluteUrl('//images-2.gog-statics.com/x.jpg'), 'https://images-2.gog-statics.com/x.jpg');
    assert.equal(details.absoluteUrl('https://cdn/x.jpg'), 'https://cdn/x.jpg');
    assert.equal(details.absoluteUrl(''), null);
  });

  await t.test('GOG v2 product: genres from tags, ORIGINAL release date, vertical box art', () => {
    const data = details.normalizeGogProduct(GOG_WITCHER, { id: '1207658924' });
    assert.equal(data.source, 'gog');
    assert.equal(data.id, '1207658924');
    assert.equal(data.title, 'The Witcher: Enhanced Edition');
    assert.equal(data.slug, 'the_witcher');
    // `_embedded.tags` is the store's genre line (three levels).
    assert.deepEqual(data.genres, ['Role-playing', 'Action', 'Fantasy']);
    // `_embedded.properties` is the tag wall — kept apart from genres.
    assert.ok(data.tags.includes('Story Rich'));
    // The original release (2007), not the 2011 GOG listing date.
    assert.equal(data.releaseYear, 2007);
    assert.equal(data.releaseDateSource, 'gog-global');
    assert.equal(data.globalReleaseDate, '2007-10-26T00:00:00+02:00');
    assert.equal(data.storeReleaseDate, '2011-05-09T23:00:00+02:00');
    // `_links.boxArtImage` is the vertical poster (171×241 live), the
    // background is the horizontal hero.
    assert.equal(
      data.verticalCover,
      'https://images.gog-statics.com/32385c2c39b8715a9ccfb159ed481b55503b96526b00866f75a4af48461615a5.jpg'
    );
    assert.match(data.image, /images\.gog-statics\.com\/c73009/);
    assert.deepEqual(data.developers, ['CD PROJEKT RED']);
    assert.deepEqual(data.publishers, ['CD PROJEKT RED']);
    assert.equal(data.series, 'The Witcher');
    assert.deepEqual(data.platforms, ['windows', 'osx']);
  });

  await t.test('GOG v2: a product without a store date keeps the global one', () => {
    const data = details.normalizeGogProduct(GOG_HEROES, { id: '1207658787' });
    assert.deepEqual(data.genres, ['Strategy', 'Turn-based', 'Fantasy']);
    assert.equal(data.releaseYear, 1999);
    assert.equal(data.releaseDateSource, 'gog-global');
    assert.equal(data.series, 'Heroes of Might & Magic');
    assert.ok(data.verticalCover);
  });

  await t.test('GOG v2: only a store date → source is gog-store', () => {
    const payload = JSON.parse(JSON.stringify(GOG_WITCHER));
    delete payload._embedded.product.globalReleaseDate;
    const data = details.normalizeGogProduct(payload, { id: '1207658924' });
    assert.equal(data.releaseDateSource, 'gog-store');
    assert.equal(data.releaseYear, 2011);
  });

  await t.test('GOG v2: a response without _embedded.product is not an empty game', () => {
    assert.throws(
      () => details.normalizeGogProduct({ error: 'nope' }, { id: '1' }),
      (err) => err.code === 'secondary_details_unparsed'
    );
  });

  await t.test('Epic CMS: base-game page, mapped genres, 1200×1600 portrait', () => {
    const data = details.normalizeEpicProduct(EPIC_WITCHER, { slug: 'the-witcher-3-wild-hunt' });
    assert.equal(data.source, 'epic');
    assert.equal(data.slug, 'the-witcher-3-wild-hunt');
    assert.equal(data.title, 'The Witcher 3: Wild Hunt - Game of the Year Edition');
    assert.deepEqual(data.genres, ['Role-Playing', 'Open World', 'Adventure']);
    assert.equal(data.releaseYear, 2015);
    assert.equal(data.releaseDateSource, 'epic-store');
    // productHome portrait, NOT the `offer` page of the redkit DLC.
    assert.match(data.verticalCover, /1200x1600/);
    assert.match(data.verticalCover, /egs-thewitcher3wildhuntcompleteedition/);
    assert.match(data.image, /2560x1440/);
    assert.deepEqual(data.developers, ['CD PROJEKT RED S.A.']);
    assert.deepEqual(data.publishers, ['CD PROJEKT RED S.A.']);
    assert.deepEqual(data.platforms, ['Windows']);
  });

  await t.test('Epic CMS: feature tags stay in tags but never in genres', () => {
    const payload = JSON.parse(JSON.stringify(EPIC_WITCHER));
    payload.pages[0].data.meta.tags = ['RPG', 'SINGLE_PLAYER', 'OPEN_WORLD'];
    const data = details.normalizeEpicProduct(payload, { slug: 'x' });
    assert.deepEqual(data.genres, ['Role-Playing', 'Open World']);
    assert.deepEqual(data.tags, ['Role-Playing', 'Single Player', 'Open World']);
  });

  await t.test('Epic CMS: productHome wins over an addon page', () => {
    const page = details.pickEpicPage({
      pages: [
        { type: 'addon', data: { meta: { releaseDate: '2020-01-01' } } },
        { type: 'productHome', data: { meta: { releaseDate: '2019-08-27' } } },
        { type: 'offer', data: { meta: { releaseDate: '2020-09-10' } } },
      ],
    });
    assert.equal(page.type, 'productHome');
    assert.equal(page.data.meta.releaseDate, '2019-08-27');
  });

  await t.test('Epic CMS: an unknown tag code is prettified, not dropped', () => {
    assert.equal(details.epicTagName('SOME_NEW_TAG'), 'Some New Tag');
    assert.equal(details.epicTagName('RPG'), 'Role-Playing');
  });

  /* ---- Alan Wake 2: Epic exclusive with a stale CMS page (02.11.2026) ---- */

  await t.test('Epic CMS: stale page (Alan Wake 2) — poster + attribution survive', () => {
    const data = details.normalizeEpicProduct(EPIC_AW2, { slug: 'alan-wake-2' });
    assert.equal(data.title, 'Alan Wake 2');
    assert.equal(data.slug, 'alan-wake-2');
    // The CMS page has no meta.tags/releaseDate/developer at all.
    assert.deepEqual(data.genres, []);
    assert.equal(data.genresSource, null);
    assert.equal(data.releaseDate, null);
    assert.equal(data.releaseDateSource, null);
    // `about.*Attribution` is the only developer/publisher source on such a page.
    assert.deepEqual(data.developers, ['Remedy Entertainment']);
    assert.deepEqual(data.publishers, ['Epic Games Publishing']);
    assert.match(data.verticalCover, /1200x1600/);
    assert.match(data.verticalCover, /egs-alanwake2-remedyentertainment-s2/);
    assert.match(data.image, /2560x1440/);
  });

  await t.test('Epic CMS: stale page + catalog fallback fills year/genres/dev', () => {
    const data = details.normalizeEpicProduct(EPIC_AW2, {
      slug: 'alan-wake-2',
      catalog: AW2_CATALOG,
    });
    assert.equal(data.releaseDate, '2023-10-27T00:00:00.000Z');
    assert.equal(data.releaseYear, 2023);
    assert.equal(data.releaseDateSource, 'epic-catalog');
    assert.deepEqual(data.genres, ['Action', 'Horror']);
    assert.equal(data.genresSource, 'epic-catalog');
    // The CMS tag line, when present, always wins over the catalog buckets.
    const fresh = JSON.parse(JSON.stringify(EPIC_AW2));
    fresh.pages[0].data.meta.tags = ['HORROR', 'ADVENTURE'];
    fresh.pages[0].data.meta.releaseDate = '2023-10-27T00:00:00.000Z';
    const fromCms = details.normalizeEpicProduct(fresh, { catalog: AW2_CATALOG });
    assert.deepEqual(fromCms.genres, ['Horror', 'Adventure']);
    assert.equal(fromCms.genresSource, 'epic-store');
    assert.equal(fromCms.releaseDateSource, 'epic-store');
  });

  await t.test('Epic catalog categories: only genre segments, never buckets', () => {
    assert.deepEqual(details.epicGenresFromCategories(['games', 'freegames']), []);
    assert.deepEqual(details.epicGenresFromCategories([{ path: 'games/action' }]), ['Action']);
    assert.deepEqual(
      details.epicGenresFromCategories([{ path: 'games' }, { path: 'games/action' }, { path: 'games/action' }]),
      ['Action']
    );
  });

  await t.test('Epic buckets are case-insensitive and never become a genre', () => {
    // The live Alan Wake 2 catalog answer: ["public","games","applications"].
    // «public» used to pass the filter and became the genre «Public».
    assert.deepEqual(details.epicGenresFromCategories(['public', 'games', 'applications']), []);
    assert.deepEqual(details.epicGenresFromCategories(['Public', 'GAMES', 'Applications']), []);
    assert.deepEqual(details.epicGenresFromCategories(['PUBLIC', 'Games']), []);
    assert.deepEqual(
      details.epicGenresFromCategories(['public', { path: 'games/action' }, 'applications']),
      ['Action']
    );
    // The same bucket filter on an already-normalized line: a stale document's
    // `["Public"]` disappears, real genres survive in order.
    assert.deepEqual(details.sanitizeEpicGenres(['Public']), []);
    assert.deepEqual(details.sanitizeEpicGenres(['Public', 'Action', 'Games', 'Horror']), [
      'Action',
      'Horror',
    ]);
    // Read sanitizer is pure and source-scoped.
    const epicDoc = { source: 'epic', genres: ['Public'], genresSource: 'epic-catalog' };
    const cleaned = details.sanitizeDetailGenres(epicDoc);
    assert.deepEqual(cleaned.genres, []);
    assert.equal(cleaned.genresSource, null);
    assert.deepEqual(epicDoc.genres, ['Public'], 'the input object is never mutated');
    const intact = { source: 'epic', genres: ['Horror'] };
    assert.equal(details.sanitizeDetailGenres(intact), intact);
    const gogDoc = { source: 'gog', genres: ['Public'] };
    assert.equal(details.sanitizeDetailGenres(gogDoc), gogDoc);
  });

  await t.test('Epic catalog without a date and public-only buckets stays empty', () => {
    const data = details.normalizeEpicProduct(EPIC_AW2, {
      slug: 'alan-wake-2',
      catalog: {
        catalogItemId: 'aw2-live',
        title: 'Alan Wake 2',
        releaseDate: null,
        categories: ['public', 'games', 'applications'],
      },
    });
    assert.equal(data.releaseDate, null);
    assert.equal(data.releaseDateSource, null);
    assert.deepEqual(data.genres, []);
    assert.equal(data.genresSource, null);
  });

  await t.test('slugFromTitle: kebab-case, ASCII only, no invented transliteration', () => {
    assert.equal(details.slugFromTitle('Alan Wake 2'), 'alan-wake-2');
    assert.equal(details.slugFromTitle('The Witcher 3: Wild Hunt'), 'the-witcher-3-wild-hunt');
    assert.equal(details.slugFromTitle('  '), '');
    assert.equal(details.slugFromTitle('Ведьмак 3'), '3');
  });

  await t.test('a legacy «Public» genre document is sanitized on every read path', () => {
    // The document was normalized *before* `public` entered
    // EPIC_NON_GENRE_CATEGORIES (Alan Wake 2, 02.11.2026) and keeps the bucket
    // on disk for its 30-day TTL. No cache file is edited: the readers filter.
    const legacy = fixture('epic/detail-alan-wake-2-public.json');
    const fetchedAt = new Date().toISOString();
    legacy.fetchedAt = fetchedAt;
    legacy.data.fetchedAt = fetchedAt;
    fs.writeFileSync(cacheFile('epic', 'alan-wake-2'), JSON.stringify(legacy));

    // 1. Detail read.
    const { doc, fresh } = details.readDetail('epic', 'alan-wake-2');
    assert.equal(fresh, true);
    assert.deepEqual(doc.data.genres, []);
    assert.equal(doc.data.genresSource, null);
    // The document on disk is untouched (no hand-cleaning of the cache).
    const onDisk = JSON.parse(fs.readFileSync(cacheFile('epic', 'alan-wake-2'), 'utf8'));
    assert.deepEqual(onDisk.data.genres, ['Public']);

    // 2. The stats read model: the same filtered line, and «genresOk» is
    // recomputed from it instead of trusting the persisted `complete` marker.
    const index = details.readDetailsIndex({ epicSlugs: ['alan-wake-2'] });
    assert.deepEqual(index['epic:alan-wake-2'].genres, []);
    const union = buildSecondaryUnion({
      works: [],
      epicLayer: {
        accountId: 'acct-legacy-public',
        games: [{ name: 'Alan Wake 2', slug: 'alan-wake-2', catalogItemId: 'aw2-catalog' }],
      },
    });
    details.enrichUnionWithDetails(union, index);
    const entry = union.works.find((work) => work.epic && work.epic.slug === 'alan-wake-2');
    assert.ok(entry);
    assert.deepEqual(entry.genres, []);
    assert.equal(entry.secondaryDetails.genresOk, false);
    assert.equal(entry.secondaryDetails.metaStatus, 'partial');
  });

  await t.test('a title-matched P577 fills an empty Epic year (Alan Wake 2 path)', () => {
    identity.writeCache(
      {},
      {
        titleEntries: {
          'epic:aw2_title_year': {
            qid: 'Q108417001',
            appid: null,
            store: 'epic',
            slug: 'aw2-title-year',
            title: 'Alan Wake 2',
            matchedBy: 'title',
            confidence: 'medium',
            titleMatched: 'unique',
            releaseYear: 2023,
            releasePrecision: 'day',
            releaseDate: '2023-10-27',
            releaseDateSource: 'wikidata',
          },
        },
      }
    );
    const data = details.applyWikidataYear(
      { source: 'epic', slug: 'aw2-title-year', releaseYear: null, releaseDate: null },
      { store: 'epic' }
    );
    assert.equal(data.releaseYear, 2023);
    assert.equal(data.releaseDate, '2023-10-27');
    assert.equal(data.releaseDateSource, 'wikidata');
    assert.equal(data.releaseYearMatchedBy, 'title');
    // A store/catalog year is still never replaced.
    const original = { ...data, releaseYear: 2015, releaseDateSource: 'epic-store' };
    assert.equal(
      details.applyWikidataYear(original, { store: 'epic' }),
      original
    );
  });

  await t.test('a title-matched P136 fills empty Epic genres and never a store line', () => {
    identity.writeCache(
      {},
      {
        titleEntries: {
          'epic:aw2_title_genres': {
            qid: 'Q108417001',
            appid: null,
            store: 'epic',
            slug: 'aw2-title-genres',
            title: 'Alan Wake 2',
            matchedLabel: 'Alan Wake II',
            matchedBy: 'title',
            confidence: 'medium',
            titleMatched: 'unique',
            releaseYear: 2023,
            releasePrecision: 'day',
            releaseDate: '2023-10-27',
            releaseDateSource: 'wikidata',
            genres: ['Survival horror', 'Third-person shooter'],
          },
        },
      }
    );
    const empty = details.applyWikidataFacts(
      {
        source: 'epic',
        slug: 'aw2-title-genres',
        genres: [],
        genresSource: null,
        releaseYear: 2023,
        releaseDateSource: 'epic-catalog',
      },
      { store: 'epic' }
    );
    assert.deepEqual(empty.genres, ['Survival horror', 'Third-person shooter']);
    assert.equal(empty.genresSource, 'wikidata');
    // The store year is not replaced.
    assert.equal(empty.releaseYear, 2023);
    assert.equal(empty.releaseDateSource, 'epic-catalog');

    // Existing store/catalog genres win; the document object is untouched.
    const storeGenres = {
      source: 'epic',
      slug: 'aw2-title-genres',
      genres: ['Horror'],
      genresSource: 'epic-store',
      releaseYear: 2023,
      releaseDateSource: 'epic-store',
    };
    assert.equal(details.applyWikidataFacts(storeGenres, { store: 'epic' }), storeGenres);

    // A GOG document never receives the P136 genre axis.
    const gogDoc = {
      source: 'gog',
      slug: 'aw2-title-genres',
      genres: [],
      releaseYear: 2023,
      releaseDateSource: 'gog-global',
    };
    assert.equal(details.applyWikidataFacts(gogDoc, { store: 'epic' }), gogDoc);
  });

  /* -- 03.11.2026: a slug entry with a date is not a genre verdict --- */

  // The deploy shape of Alan Wake 2: `epic:alan-wake-2` carries the `P6278`
  // identity and the `P577` date, the QID's `P136` line lives in the title map
  // only. The date says nothing about the genre axis, so both facts are used.
  const datedSlugEntry = {
    qid: 'Q108417001',
    appid: null,
    store: 'epic',
    releaseYear: 2023,
    releasePrecision: 'day',
    releaseDate: '2023-10-27',
    releaseDateSource: 'wikidata',
  };
  const aw2TitleEntry = {
    qid: 'Q108417001',
    appid: null,
    store: 'epic',
    title: 'Alan Wake 2',
    matchedLabel: 'Alan Wake II',
    matchedBy: 'title',
    confidence: 'medium',
    titleMatched: 'unique',
    releaseYear: 2023,
    releasePrecision: 'day',
    releaseDate: '2023-10-27',
    releaseDateSource: 'wikidata',
    genres: ['Survival horror', 'Third-person shooter'],
  };

  await t.test('a dated slug entry still receives the title genres (Alan Wake 2)', () => {
    identity.writeCache(
      { 'epic:aw2_dated_slug': { ...datedSlugEntry, slug: 'aw2-dated-slug' } },
      {
        titleEntries: {
          'epic:aw2_dated_slug': { ...aw2TitleEntry, slug: 'aw2-dated-slug' },
        },
      }
    );
    const doc = {
      source: 'epic',
      slug: 'aw2-dated-slug',
      genres: [],
      genresSource: null,
      releaseYear: 2023,
      releaseDate: '2023-10-27',
      releaseDateSource: 'epic-catalog',
    };
    const healed = details.applyWikidataFacts(doc, { store: 'epic' });
    assert.notEqual(healed, doc, 'a real fact change produces a new document');
    assert.deepEqual(healed.genres, ['Survival horror', 'Third-person shooter']);
    assert.equal(healed.genresSource, 'wikidata');
    // The year axis does not move: the store/catalog answer is not replaced and
    // no `releaseYearMatchedBy` marker is invented for a year that did not move.
    assert.equal(healed.releaseYear, 2023);
    assert.equal(healed.releaseDateSource, 'epic-catalog');
    assert.equal(Object.prototype.hasOwnProperty.call(healed, 'releaseYearMatchedBy'), false);
    // No identity leaked into the document either.
    assert.equal(Object.prototype.hasOwnProperty.call(healed, 'matchedBy'), false);
    assert.equal(details.applyWikidataFacts(doc, { store: 'epic' }).slug, 'aw2-dated-slug');

    // A document that lacks the year takes the slug entry's `P577`: the identity
    // label stays the slug's (`slug`, never `title`) even though the genre line
    // came from the title map.
    const dateless = details.applyWikidataFacts(
      { source: 'epic', slug: 'aw2-dated-slug', genres: [], releaseYear: null },
      { store: 'epic' }
    );
    assert.equal(dateless.releaseYear, 2023);
    assert.equal(dateless.releaseDate, '2023-10-27');
    assert.equal(dateless.releaseDateSource, 'wikidata');
    assert.equal(dateless.releaseYearMatchedBy, 'slug');
    assert.deepEqual(dateless.genres, ['Survival horror', 'Third-person shooter']);
  });

  await t.test('a settled title entry without genres changes nothing', () => {
    identity.writeCache(
      { 'epic:aw2_dated_settled': { ...datedSlugEntry, slug: 'aw2-dated-settled' } },
      {
        titleEntries: {
          'epic:aw2_dated_settled': {
            ...aw2TitleEntry,
            slug: 'aw2-dated-settled',
            genres: [],
          },
        },
      }
    );
    const doc = {
      source: 'epic',
      slug: 'aw2-dated-settled',
      genres: [],
      releaseYear: 2023,
      releaseDateSource: 'epic-catalog',
    };
    assert.equal(details.applyWikidataFacts(doc, { store: 'epic' }), doc);
  });

  await t.test('two different QIDs are never mixed, not even for genres', () => {
    // The slug entry names the item (Q108417001); the title answer resolved a
    // different item (Q999999). Its genre line is not evidence about this game.
    identity.writeCache(
      { 'epic:aw2_other_item': { ...datedSlugEntry, slug: 'aw2-other-item' } },
      {
        titleEntries: {
          'epic:aw2_other_item': {
            ...aw2TitleEntry,
            qid: 'Q999999',
            slug: 'aw2-other-item',
            genres: ['First-person shooter'],
          },
        },
      }
    );
    const doc = {
      source: 'epic',
      slug: 'aw2-other-item',
      genres: [],
      releaseYear: 2023,
      releaseDateSource: 'epic-catalog',
    };
    assert.equal(details.applyWikidataFacts(doc, { store: 'epic' }), doc);
  });
});

/* ------------------------------------------------------------------ */
/* cache                                                               */
/* ------------------------------------------------------------------ */

test('secondary details cache', async (t) => {
  await t.test('a resolved product is cached and served without a second request', async () => {
    const client = fakeClient({ '/v2/games/1207658924': GOG_WITCHER });
    const first = await details.resolveGog('1207658924', { client });
    assert.equal(first.cached, false);
    assert.equal(first.status, 'ok');
    assert.ok(fs.existsSync(cacheFile('gog', '1207658924')));
    const second = await details.resolveGog('1207658924', { client });
    assert.equal(second.cached, true);
    assert.equal(client.calls.length, 1);
  });

  await t.test('readDetailsIndex returns fresh ok entries only', () => {
    details.writeDetail('gog', '999', 'ok', { source: 'gog', id: '999', genres: ['X'] });
    details.writeDetail('gog', '998', 'not_found', null);
    const index = details.readDetailsIndex({ gogIds: ['999', '998', '997'] });
    assert.deepEqual(index['gog:999'].genres, ['X']);
    assert.equal(index['gog:998'], undefined);
    assert.equal(index['gog:997'], undefined);
  });

  await t.test('an expired entry is not served by readDetailsIndex', () => {
    details.writeDetail('gog', '997', 'ok', { source: 'gog', id: '997', genres: ['Old'] });
    const file = cacheFile('gog', '997');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.fetchedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(doc));
    const index = details.readDetailsIndex({ gogIds: ['997'] });
    assert.equal(index['gog:997'], undefined);
    // But the stale document is still readable for a fallback decision.
    const stale = details.readDetail('gog', '997');
    assert.equal(stale.fresh, false);
    assert.ok(stale.doc);
  });

  await t.test('a 404 is a negative cache entry, not an empty game', async () => {
    const client = fakeClient({
      '/v2/games/404': () => {
        const err = new Error('not found');
        err.code = 'secondary_details_not_found';
        err.status = 404;
        throw err;
      },
    });
    const result = await details.resolveGog('404', { client });
    assert.equal(result.status, 'not_found');
    assert.equal(result.data, null);
    const doc = JSON.parse(fs.readFileSync(cacheFile('gog', '404'), 'utf8'));
    assert.equal(doc.status, 'not_found');
    // A second call is answered from the negative cache.
    const again = await details.resolveGog('404', { client });
    assert.equal(again.cached, true);
    assert.equal(client.calls.length, 1);
  });

  await t.test('a network failure is deferred and never cached', async () => {
    const client = fakeClient({
      '/v2/games/500': () => {
        const err = new Error('down');
        err.code = 'secondary_details_unreachable';
        err.deferred = true;
        throw err;
      },
    });
    await assert.rejects(
      () => details.resolveGog('500', { client }),
      (err) => err.code === 'secondary_details_unreachable'
    );
    assert.equal(fs.existsSync(cacheFile('gog', '500')), false);
  });
});

/* ------------------------------------------------------------------ */
/* breaker                                                             */
/* ------------------------------------------------------------------ */

test('secondary details breaker', async (t) => {
  await t.test('a 429 trips the host breaker for 30 minutes', async () => {
    details.writeBreaker({});
    const client = fakeClient({
      '/v2/games/429': () => {
        const err = new Error('too many requests');
        err.code = 'secondary_details_blocked';
        err.status = 429;
        throw err;
      },
    });
    await assert.rejects(() => details.resolveGog('429', { client }));
    const blocked = details.breakerBlock('gog');
    assert.ok(blocked);
    assert.ok(Date.parse(blocked.until) > Date.now());
    // The next product is refused without a request.
    await assert.rejects(
      () => details.resolveGog('1207658787', { client }),
      (err) => err.code === 'secondary_details_blocked' && err.deferred === true
    );
    assert.equal(client.calls.length, 1);
    details.writeBreaker({});
  });
});

/* ------------------------------------------------------------------ */
/* job                                                                 */
/* ------------------------------------------------------------------ */

test('secondary details job', async (t) => {
  await t.test('GOG first, then Epic; counters and pending are honest', async () => {
    details.resetJobs();
    clearCache();
    const client = fakeClient({
      '/v2/games/1207658924': GOG_WITCHER,
      '/v2/games/1207658787': GOG_HEROES,
      '/products/the-witcher-3-wild-hunt': EPIC_WITCHER,
    });
    details.startSecondaryDetails({
      ownerKey: 'steam-test-job',
      gog: [{ id: '1207658924' }, { id: '1207658787' }],
      epic: [{ slug: 'the-witcher-3-wild-hunt' }],
      client,
      pauseMs: 0,
    });
    const job = await waitForJob('steam-test-job');
    assert.equal(job.status, 'done');
    assert.equal(job.requests, 3);
    assert.equal(job.gog.total, 2);
    assert.equal(job.gog.resolved, 2);
    assert.equal(job.epic.total, 1);
    assert.equal(job.epic.resolved, 1);
    assert.equal(job.pending, 0);
    // GOG requests precede the Epic one (budget policy).
    assert.match(client.calls[0], /api\.gog\.com/);
    assert.match(client.calls[2], /store-content\.ak\.epicgames\.com/);
  });

  await t.test('a spent budget stops the run (partial), never fabricates data', async () => {
    details.resetJobs();
    clearCache();
    const client = fakeClient({
      '/v2/games/1207658924': GOG_WITCHER,
      '/v2/games/1207658787': GOG_HEROES,
    });
    details.startSecondaryDetails({
      ownerKey: 'steam-test-budget',
      gog: [{ id: '1207658924' }, { id: '1207658787' }],
      epic: [{ slug: 'x' }],
      client,
      pauseMs: 0,
      budget: 1,
    });
    const job = await waitForJob('steam-test-budget');
    assert.equal(job.status, 'partial');
    assert.equal(job.budgetExceeded, true);
    assert.equal(job.requests, 1);
    assert.equal(job.gog.resolved, 1);
    assert.equal(job.epic.resolved, 0);
    assert.ok(job.warnings.includes('gog_budget'));
  });

  await t.test('Epic exclusive without a slug: validated title probe resolves it', async () => {
    details.resetJobs();
    clearCache();
    const client = fakeClient({ '/products/alan-wake-2': EPIC_AW2 });
    details.startSecondaryDetails({
      ownerKey: 'steam-test-aw2',
      gog: [],
      epic: [
        {
          slug: null,
          id: 'aw2-catalog',
          catalogItemId: 'aw2-catalog',
          title: 'Alan Wake 2',
          catalog: AW2_CATALOG,
        },
      ],
      client,
      pauseMs: 0,
    });
    const job = await waitForJob('steam-test-aw2');
    assert.equal(job.status, 'done');
    assert.equal(job.epic.total, 1);
    // No slug in productmapping — the job says so instead of hiding it.
    assert.equal(job.epic.missingSlug, 1);
    assert.equal(job.epic.resolved, 1);
    assert.equal(job.epic.notFound, 0);
    // One HTTP call (the probe payload is reused), counted conservatively.
    assert.equal(client.calls.length, 1);
    assert.equal(job.requests, 2);
    assert.match(client.calls[0], /store-content\.ak\.epicgames\.com\/api\/en-US\/content\/products\/alan-wake-2$/);
    // The probe result is cached under the discovered slug…
    const doc = details.readDetail('epic', 'alan-wake-2');
    assert.equal(doc.doc.status, 'ok');
    assert.equal(doc.doc.data.releaseYear, 2023);
    assert.deepEqual(doc.doc.data.genres, ['Action', 'Horror']);
    assert.deepEqual(doc.doc.data.developers, ['Remedy Entertainment']);
    // …and remembered per catalogItemId, so the read model can key the union.
    assert.equal(epicCache.getEpicSlugOverride('aw2-catalog'), 'alan-wake-2');
  });

  await t.test('Epic exclusive: a failed probe is library-only, not not_found', async () => {
    details.resetJobs();
    clearCache();
    const notFound = Object.assign(new Error('404'), {
      code: 'secondary_details_not_found',
      status: 404,
    });
    const client = fakeClient({ '/products/': notFound });
    details.startSecondaryDetails({
      ownerKey: 'steam-test-noslug',
      gog: [],
      epic: [
        { slug: null, id: 'x-catalog', catalogItemId: 'x-catalog', title: 'Some Exclusive' },
      ],
      client,
      pauseMs: 0,
    });
    const job = await waitForJob('steam-test-noslug');
    assert.equal(job.status, 'done');
    assert.equal(job.epic.total, 1);
    assert.equal(job.epic.missingSlug, 1);
    assert.equal(job.epic.resolved, 0);
    // A guessed slug that 404s is NOT a verdict about the product.
    assert.equal(job.epic.notFound, 0);
    assert.ok(job.warnings.includes('epic_no_slug'));
    // The guess is remembered for a short time (`probe: true`, 7 days) so the
    // next kick does not spend a request on it again…
    const probeDoc = JSON.parse(fs.readFileSync(cacheFile('epic', 'some-exclusive'), 'utf8'));
    assert.equal(probeDoc.status, 'not_found');
    assert.equal(probeDoc.probe, true);
    assert.equal(epicCache.getEpicSlugOverride('x-catalog'), null);
    // …and the next kick is answered from that memory, no network.
    details.resetJobs();
    details.startSecondaryDetails({
      ownerKey: 'steam-test-noslug',
      gog: [],
      epic: [
        { slug: null, id: 'x-catalog', catalogItemId: 'x-catalog', title: 'Some Exclusive' },
      ],
      client,
      pauseMs: 0,
    });
    const again = await waitForJob('steam-test-noslug');
    assert.equal(again.epic.resolved, 0);
    assert.equal(client.calls.length, 1);
  });

  await t.test('a dated detail is healed with the cached title genres, zero WDQS', async () => {
    // The deploy shape (03.11.2026): the slug entry owns the identity and the
    // date, the QID's `P136` line lives in the title map, and the cached detail
    // carries the store year plus the filtered `Public` bucket. The heal must
    // write the genres and must not spend a single WDQS request — the facts are
    // already in `links/secondary.json`.
    details.resetJobs();
    clearCache();
    identity.writeCache(
      {
        'epic:alan_wake_2': {
          qid: 'Q108417001',
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
            qid: 'Q108417001',
            appid: null,
            store: 'epic',
            slug: 'alan-wake-2',
            title: 'Alan Wake 2',
            matchedLabel: 'Alan Wake II',
            matchedBy: 'title',
            confidence: 'medium',
            titleMatched: 'unique',
            releaseYear: 2023,
            releasePrecision: 'day',
            releaseDate: '2023-10-27',
            releaseDateSource: 'wikidata',
            genres: ['Survival horror', 'Third-person shooter'],
          },
        },
      }
    );
    details.writeDetail('epic', 'alan-wake-2', 'ok', {
      source: 'epic',
      slug: 'alan-wake-2',
      title: 'Alan Wake 2',
      // The stale bucket is filtered on read, so the genre axis is empty.
      genres: ['Public'],
      genresSource: 'epic-catalog',
      releaseYear: 2023,
      releaseDate: '2023-10-27',
      releaseDateSource: 'epic-catalog',
      storeReleaseDate: null,
      developers: [],
      publishers: [],
      tags: [],
      platforms: [],
      fetchedAt: new Date().toISOString(),
    });
    let wdqsCalls = 0;
    const fetchImpl = async () => {
      wdqsCalls++;
      return { ok: true, status: 200, json: async () => ({ results: { bindings: [] } }) };
    };
    details.startSecondaryDetails({
      ownerKey: 'steam-test-aw2-heal',
      gog: [],
      epic: [
        {
          slug: 'alan-wake-2',
          title: 'Alan Wake 2',
          // A dated catalog entry no longer stops the pass, and the settled
          // title entry answers it from the cache.
          catalog: { releaseDate: '2023-10-27T00:00:00.000Z' },
        },
      ],
      fetchImpl,
      pauseMs: 0,
    });
    const job = await waitForJob('steam-test-aw2-heal');
    assert.equal(job.status, 'done');
    assert.equal(wdqsCalls, 0, 'no WDQS request for facts that are already cached');
    assert.equal(job.requests, 0, 'the details phase did not go to the network');
    assert.equal(job.epic.resolved, 1);
    assert.equal(job.epic.cached, 1);

    const healed = details.readDetail('epic', 'alan-wake-2').doc.data;
    assert.deepEqual(healed.genres, ['Survival horror', 'Third-person shooter']);
    assert.equal(healed.genresSource, 'wikidata');
    // The store year is still the store's.
    assert.equal(healed.releaseYear, 2023);
    assert.equal(healed.releaseDateSource, 'epic-catalog');
    // Written to disk, so /stats sees it without another kick.
    const onDisk = JSON.parse(fs.readFileSync(cacheFile('epic', 'alan-wake-2'), 'utf8'));
    assert.deepEqual(onDisk.data.genres, ['Survival horror', 'Third-person shooter']);
    assert.equal(onDisk.data.genresSource, 'wikidata');
    assert.equal(onDisk.data.metaGenresOk, true);
    assert.equal(onDisk.data.metaStatus, 'complete');

    // A second run has nothing left to heal and still asks nobody.
    details.resetJobs();
    details.startSecondaryDetails({
      ownerKey: 'steam-test-aw2-heal',
      gog: [],
      epic: [
        {
          slug: 'alan-wake-2',
          title: 'Alan Wake 2',
          catalog: { releaseDate: '2023-10-27T00:00:00.000Z' },
        },
      ],
      fetchImpl,
      pauseMs: 0,
    });
    const again = await waitForJob('steam-test-aw2-heal');
    assert.equal(again.epic.resolved, 1);
    assert.equal(again.epic.cached, 1);
    assert.equal(wdqsCalls, 0);
  });

  await t.test('title candidates: a catalog date does not hide an empty genre axis', () => {
    details.resetJobs();
    clearCache();
    const dated = { releaseDate: '2023-10-27T00:00:00.000Z' };
    details.writeDetail('epic', 'dated-no-genres', 'ok', {
      source: 'epic',
      slug: 'dated-no-genres',
      genres: [],
      releaseYear: 2023,
    });
    details.writeDetail('epic', 'dated-complete', 'ok', {
      source: 'epic',
      slug: 'dated-complete',
      genres: ['Horror'],
      releaseYear: 2023,
    });
    const cards = details.titleCandidatesFor([
      { slug: 'dated-no-genres', title: 'Dated No Genres', catalog: dated },
      { slug: 'dated-complete', title: 'Dated Complete', catalog: dated },
      // A dated catalog entry with no document yet keeps the old rule: wait for
      // the document instead of asking on a guess.
      { slug: 'dated-no-doc', title: 'Dated No Doc', catalog: dated },
      // No catalog document at all: the store date is unknown, stay quiet.
      { slug: 'no-catalog', title: 'No Catalog', catalog: null },
      // No slug/title: nothing to address.
      { slug: null, title: 'No Slug', catalog: dated },
    ]);
    assert.deepEqual(cards, [
      {
        slug: 'dated-no-genres',
        title: 'Dated No Genres',
        releaseYear: 2023,
        releaseDate: null,
        genres: [],
      },
    ]);
    // `collectTitleCandidates` accepts exactly that card (the empty genre axis
    // makes the work askable) and would reject a complete one.
    assert.deepEqual(identity.collectTitleCandidates(cards), [
      { store: 'epic', slug: 'dated-no-genres', title: 'Dated No Genres' },
    ]);
    assert.deepEqual(
      identity.collectTitleCandidates([
        { slug: 'dated-complete', title: 'Dated Complete', releaseYear: 2023, genres: ['Horror'] },
      ]),
      []
    );
  });

  await t.test('a dated work without a title answer is asked once, then stays quiet', async () => {
    details.resetJobs();
    clearCache();
    identity.writeCache(
      {
        'epic:dated_quiet': {
          qid: 'Q108417001',
          appid: null,
          store: 'epic',
          releaseYear: 2023,
          releasePrecision: 'day',
          releaseDate: '2023-10-27',
          releaseDateSource: 'wikidata',
        },
      },
      { titleEntries: {} }
    );
    details.writeDetail('epic', 'dated-quiet', 'ok', {
      source: 'epic',
      slug: 'dated-quiet',
      title: 'Dated Quiet',
      genres: [],
      releaseYear: 2023,
    });
    let wdqsCalls = 0;
    const fetchImpl = async () => {
      wdqsCalls++;
      return { ok: true, status: 200, json: async () => ({ results: { bindings: [] } }) };
    };
    const targets = [
      {
        slug: 'dated-quiet',
        title: 'Dated Quiet',
        catalog: { releaseDate: '2023-10-27T00:00:00.000Z' },
      },
    ];
    details.startSecondaryDetails({
      ownerKey: 'steam-test-dated-quiet',
      gog: [],
      epic: targets,
      fetchImpl,
      pauseMs: 0,
    });
    await waitForJob('steam-test-dated-quiet');
    assert.equal(wdqsCalls, 1, 'exactly one question for an unset title answer');
    // Nothing is written when there is no genre fact to apply.
    const unchanged = details.readDetail('epic', 'dated-quiet').doc.data;
    assert.deepEqual(unchanged.genres, []);
    assert.notEqual(unchanged.genresSource, 'wikidata');
    // The miss is now settled in `titleEntries`, so the next run asks nobody.
    assert.equal(identity.readSecondaryTitleLinks()['epic:dated_quiet'].titleMatched, 'miss');
    details.resetJobs();
    details.startSecondaryDetails({
      ownerKey: 'steam-test-dated-quiet',
      gog: [],
      epic: targets,
      fetchImpl,
      pauseMs: 0,
    });
    const again = await waitForJob('steam-test-dated-quiet');
    assert.equal(wdqsCalls, 1, 'the settled miss is never re-asked');
    assert.equal(again.status, 'done');
  });

  await t.test('a running job is reused, not duplicated; kick honours the cooldown', async () => {
    details.resetJobs();
    clearCache();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const client = fakeClient({
      '/v2/games/1207658924': async () => {
        await gate;
        return GOG_WITCHER;
      },
    });
    const first = details.kickSecondaryDetailsQuietly('steam-test-kick', {
      gog: [{ id: '1207658924' }],
      epic: [],
      client,
      pauseMs: 0,
      forceKick: true,
    });
    assert.ok(first.id);
    const second = details.kickSecondaryDetailsQuietly('steam-test-kick', {
      gog: [{ id: '1207658924' }],
      epic: [],
      client,
      pauseMs: 0,
      forceKick: true,
    });
    assert.equal(second.skipped, 'running');
    release();
    await waitForJob('steam-test-kick');
    // After completion a plain kick is swallowed by the cooldown…
    assert.equal(details.kickGate('steam-test-kick'), 'cooldown');
    // …while an explicit import (forceKick) may run again.
    assert.equal(details.kickGate('steam-test-kick', { forceKick: true }), null);
  });
});

/* ------------------------------------------------------------------ */
/* kick targets                                                        */
/* ------------------------------------------------------------------ */

test('kick targets come from the cached libraries', async (t) => {
  await t.test('GOG products and Epic slugs of ONE owner only', async () => {
    const nowIso = new Date().toISOString();
    const owner = 'steam-76561198000000041';
    await gogCache.saveLibrary('1234500041', {
      fetchedAt: nowIso,
      ownerProfile: owner,
      products: [
        { gogGameId: '1207658924', title: 'The Witcher', slug: 'the_witcher' },
        { gogGameId: '1207658787', title: 'Heroes 3', slug: 'heroes_3' },
      ],
    });
    await gogCache.saveLibrary('1234500042', {
      fetchedAt: nowIso,
      ownerProfile: 'steam-76561198000000042',
      products: [{ gogGameId: '999', title: 'Someone else', slug: 'other' }],
    });
    await epicCache.saveEpicProfile({ accountId: 'epic-owner-41', ownerKey: owner, connectedAt: nowIso });
    await epicCache.saveEpicLibrary('epic-owner-41', {
      accountId: 'epic-owner-41',
      fetchedAt: nowIso,
      games: [{ appName: 'W3', catalogItemId: 'cat-1', slug: 'the-witcher-3-wild-hunt', name: 'W3' }],
    });
    const targets = details.targetsForOwner(owner);
    assert.deepEqual(targets.gog.map((entry) => entry.id).sort(), ['1207658787', '1207658924']);
    assert.deepEqual(targets.epic.map((entry) => entry.slug), ['the-witcher-3-wild-hunt']);
    assert.equal(targets.epicNoSlug, 0);
    assert.deepEqual(details.targetsForOwner('steam-unknown'), {
      gog: [],
      epic: [],
      epicNoSlug: 0,
      // Added by the binding self-heal: «no book» is stated as a state.
      epicBinding: { state: 'none', accountId: null, hasAccessToken: false },
    });
  });

  await t.test('Epic exclusives: catalog slug and discovered override address the slot', async () => {
    clearCache();
    const owner = 'steam-76561198000000042';
    const nowIso = new Date().toISOString();
    await epicCache.saveEpicProfile({ accountId: 'epic-aw2', ownerKey: owner, connectedAt: nowIso });
    await epicCache.saveEpicLibrary('epic-aw2', {
      accountId: 'epic-aw2',
      fetchedAt: nowIso,
      games: [
        // Alan Wake 2: absent from `productmapping`, but the catalog bulk knows
        // the store slug.
        { appName: 'Ginger', catalogItemId: 'aw2-cat', name: 'Alan Wake 2' },
        // No catalog doc, no productmapping, no override → library-only.
        { appName: 'OtherExclusive', catalogItemId: 'other-cat', name: 'Other Exclusive' },
      ],
    });
    await epicCache.saveEpicCatalogItem('aw2-cat', {
      title: 'Alan Wake 2',
      slug: 'alan-wake-2',
      releaseDate: '2023-10-27T00:00:00.000Z',
      categories: [{ path: 'games' }, { path: 'games/action' }],
    });

    const targets = details.targetsForOwner(owner);
    assert.deepEqual(targets.epic.map((entry) => entry.slug), ['alan-wake-2', null]);
    assert.equal(targets.epicNoSlug, 1);
    assert.equal(targets.epic[0].title, 'Alan Wake 2');
    assert.equal(targets.epic[0].catalog.releaseDate, '2023-10-27T00:00:00.000Z');

    // The probe's discovery is remembered, so the next kick addresses it too.
    epicCache.saveEpicSlugOverride('other-cat', 'other-exclusive', { title: 'Other Exclusive' });
    const again = details.targetsForOwner(owner);
    assert.deepEqual(again.epic.map((entry) => entry.slug), ['alan-wake-2', 'other-exclusive']);
    assert.equal(again.epicNoSlug, 0);

    // The read model (union key `epic:<slug>`) sees the same discovered slug.
    const layer = epicLayer.buildEpicLayerSync({ ownerKey: owner });
    const games = layer.games.map((game) => [game.name, game.slug, game.metadataSource]);
    assert.deepEqual(games, [
      ['Alan Wake 2', 'alan-wake-2', 'epic-catalog'],
      ['Other Exclusive', 'other-exclusive', 'epic-slug-probe'],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* union enrichment                                                    */
/* ------------------------------------------------------------------ */

test('union enrichment', async (t) => {
  await t.test('fills genres/year/poster from the detail, never overwrites Steam data', () => {
    const union = buildSecondaryUnion({
      works: [],
      gogSnapshots: [
        {
          library: {
            products: [
              {
                gogGameId: '1207658924',
                title: 'The Witcher: Enhanced Edition',
                slug: 'the_witcher',
                releaseDate: '2011-05-09',
              },
            ],
          },
          playtime: { minutes: { 1207658924: 60 } },
        },
      ],
      epicLayer: null,
      links: {},
      secondaryLinks: {},
    });
    const entry = union.works[0];
    assert.equal(entry.releaseYear, 2011);
    assert.equal(entry.releaseYearSource, 'gog-library');
    assert.deepEqual(entry.genres, []);
    const index = {
      'gog:1207658924': details.normalizeGogProduct(GOG_WITCHER, { id: '1207658924' }),
    };
    const touched = details.enrichUnionWithDetails(union, index);
    assert.equal(touched, 1);
    assert.deepEqual(entry.genres, ['Role-playing', 'Action', 'Fantasy']);
    // The store listing date (2011) is replaced by the original release (2007).
    assert.equal(entry.releaseYear, 2007);
    assert.equal(entry.releaseYearSource, 'gog-global');
    assert.equal(entry.genresSource, 'gog-store');
    assert.match(entry.verticalCover, /images\.gog-statics\.com/);
    assert.ok(entry.metadataSources.includes('gog-store'));
    assert.equal(entry.secondaryDetails.source, 'gog');
  });

  await t.test('library tag slugs seed genres until the product page answers', () => {
    const union = buildSecondaryUnion({
      works: [],
      gogSnapshots: [
        {
          library: {
            products: [
              {
                gogGameId: '1207658924',
                title: 'The Witcher: Enhanced Edition',
                slug: 'the_witcher',
                // `getFilteredProducts.tags` are slugs, not a genre line.
                tags: ['role-playing', 'open-world'],
              },
            ],
          },
          playtime: { minutes: {} },
        },
      ],
      epicLayer: null,
      links: {},
      secondaryLinks: {},
    });
    const entry = union.works[0];
    assert.deepEqual(entry.genres, ['Role-playing', 'Open-world']);
    assert.equal(entry.genresSource, 'gog-library');
    details.enrichUnionWithDetails(union, {
      'gog:1207658924': details.normalizeGogProduct(GOG_WITCHER, { id: '1207658924' }),
    });
    // The product page's genre line wins over the library tag slugs.
    assert.deepEqual(entry.genres, ['Role-playing', 'Action', 'Fantasy']);
    assert.equal(entry.genresSource, 'gog-store');
  });

  await t.test('a Steam-owned genre list is not replaced by a store genre list', () => {
    const union = buildSecondaryUnion({
      works: [
        {
          workKey: 'steam:292030',
          minutes: 600,
          primary: { appid: 292030, name: 'The Witcher 3' },
          games: [{ appid: 292030, name: 'The Witcher 3', playtime_forever: 600 }],
        },
      ],
      gogSnapshots: [
        {
          library: {
            products: [{ gogGameId: '1207658924', title: 'The Witcher 3', slug: 'the_witcher_3' }],
          },
          playtime: { minutes: {} },
        },
      ],
      epicLayer: null,
      links: {},
      secondaryLinks: { 'gog:the_witcher_3': { qid: 'Q1', appid: '292030' } },
    });
    const entry = union.works[0];
    entry.genres = ['RPG'];
    details.enrichUnionWithDetails(union, {
      'gog:1207658924': details.normalizeGogProduct(GOG_WITCHER, { id: '1207658924' }),
    });
    assert.deepEqual(entry.genres, ['RPG']);
  });

  await t.test('a pre-catalog Epic detail is flagged for one completion attempt', () => {
    const union = buildSecondaryUnion({
      works: [],
      gogSnapshots: [],
      epicLayer: {
        accountId: 'epic-a',
        games: [{ catalogItemId: 'c1', name: 'Alan Wake 2', slug: 'alan-wake-2' }],
      },
      links: {},
      secondaryLinks: {},
    });
    const entry = union.works[0];
    const base = { source: 'epic', id: 'alan-wake-2', genres: [], releaseYear: null };
    details.enrichUnionWithDetails(union, { 'epic:alan-wake-2': base });
    assert.equal(entry.secondaryDetails.needsCatalog, true);
    // After one attempt the marker settles the question — no endless kicks.
    details.enrichUnionWithDetails(union, {
      'epic:alan-wake-2': { ...base, catalogChecked: true },
    });
    assert.equal(entry.secondaryDetails.needsCatalog, false);
    // A deferred catalog step is pending, not a needs-catalog retry.
    details.enrichUnionWithDetails(union, {
      'epic:alan-wake-2': { ...base, catalogPending: true },
    });
    assert.equal(entry.secondaryDetails.needsCatalog, false);
    assert.equal(entry.secondaryDetails.catalogPending, true);
  });
});

/* ------------------------------------------------------------------ */
/* stats contract                                                      */
/* ------------------------------------------------------------------ */

const STEAM_ID = '76561198000000031';
const OWNER = `steam-${STEAM_ID}`;
const GOG_KEY = '1234500031';

async function seedStats() {
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
    game_count: 1,
    partial: false,
    fingerprint: '292030',
    totalMinutes: 6000,
    games: [
      {
        appid: 292030,
        name: 'The Witcher 3: Wild Hunt',
        playtime_forever: 6000,
        playtime_2weeks: 0,
        rtime_last_played: 0,
      },
    ],
  });
  await gameCache.saveDetails(292030, {
    success: true,
    type: 'game',
    name: 'The Witcher 3: Wild Hunt',
    releaseYear: 2015,
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
    products: [
      {
        gogGameId: '1207658924',
        title: 'The Witcher: Enhanced Edition',
        slug: 'the_witcher',
        // The listing date: must lose to the product's global release date.
        releaseDate: '2011-05-09',
        isGame: true,
      },
    ],
    fingerprint: '1207658924',
  });
  gogCache.savePlaytime(GOG_KEY, {
    fetchedAt: nowIso,
    ownerProfile: OWNER,
    minutes: { 1207658924: 120 },
    entries: { 1207658924: { minutes: 120, status: 'ok', at: nowIso } },
    fetchedGames: 1,
  });
  details.writeDetail(
    'gog',
    '1207658924',
    'ok',
    details.normalizeGogProduct(GOG_WITCHER, { id: '1207658924' })
  );
}

test('stats use the store metadata', async (t) => {
  clearCache();
  await seedStats();

  await t.test('secondary-only work lands in genres[] and years[] with its poster', () => {
    const payload = buildGamesStatsFromCache(OWNER);
    const gogOnly = payload.secondaryWorks.find((entry) => entry.name === 'The Witcher: Enhanced Edition');
    assert.ok(gogOnly);
    assert.deepEqual(gogOnly.genres, ['Role-playing', 'Action', 'Fantasy']);
    assert.equal(gogOnly.releaseYear, 2007);
    assert.equal(gogOnly.releaseYearSource, 'gog-global');
    assert.match(gogOnly.verticalCover, /images\.gog-statics\.com/);
    assert.match(gogOnly.image, /images\.gog-statics\.com/);

    // Genres wall: GOG genres are real buckets and flagged as secondary.
    const fantasy = payload.genres.find((entry) => entry.name === 'Fantasy');
    assert.ok(fantasy, 'Fantasy bucket');
    assert.equal(fantasy.secondaryCount, 1);
    // Steam work keeps its own genre (no store genre replaced it).
    assert.ok(payload.genres.some((entry) => entry.name === 'RPG'));

    // Year chart: 2007 (original), not 2011 (GOG listing date).
    const years = payload.years.map((entry) => entry.year).filter((year) => year != null);
    assert.ok(years.includes(2007));
    assert.equal(years.includes(2011), false);
    assert.ok(payload.decades.some((entry) => entry.decade === 2000));
  });

  await t.test('gamesIndex carries the genres of the secondary row', () => {
    const payload = buildGamesStatsFromCache(OWNER);
    const secondary = Object.values(payload.gamesIndex).filter((row) => row.secondaryOnly);
    assert.equal(secondary.length, 1);
    assert.deepEqual(secondary[0].genres, ['Role-playing', 'Action', 'Fantasy']);
    assert.equal(secondary[0].releaseYear, 2007);
  });

  await t.test('meta.secondaryDetails reports coverage honestly', () => {
    const payload = buildGamesStatsFromCache(OWNER);
    assert.deepEqual(payload.meta.secondaryDetails, {
      resolved: 1,
      total: 1,
      partial: 0,
      noSlug: 0,
      running: false,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Epic catalog refetch with the owner token (stale CMS page)          */
/* ------------------------------------------------------------------ */

test('Epic catalog refetch', async (t) => {
  await t.test('stale CMS page → catalog bulk with the owner token fills genres/year', async () => {
    details.resetJobs();
    clearCache();
    const owner = 'steam-test-catalog-refetch';
    const account = 'epic-cat-refetch';
    const catalogId = 'aw2-cat-refetch';
    await seedEpicOwner(owner, account);
    const cms = fakeClient({ '/products/alan-wake-2': EPIC_AW2 });
    const catalogClient = fakeCatalogClient({ items: { [catalogId]: AW2_CATALOG } });
    details.startSecondaryDetails({
      ownerKey: owner,
      gog: [],
      epic: [
        {
          slug: 'alan-wake-2',
          catalogItemId: catalogId,
          namespace: 'fn',
          title: 'Alan Wake 2',
          catalog: null,
        },
      ],
      client: cms,
      epicClient: catalogClient,
      tokenStore,
      pauseMs: 0,
    });
    const job = await waitForJob(owner);
    assert.equal(job.status, 'done');
    assert.equal(job.epic.resolved, 1);
    assert.equal(cms.calls.length, 1);
    assert.equal(catalogClient.calls.length, 1);
    assert.equal(catalogClient.calls[0].namespace, 'fn');
    assert.deepEqual(catalogClient.calls[0].ids, [catalogId]);
    // One CMS request + one catalog request.
    assert.equal(job.requests, 2);

    const doc = details.readDetail('epic', 'alan-wake-2').doc;
    assert.equal(doc.status, 'ok');
    assert.deepEqual(doc.data.genres, ['Action', 'Horror']);
    assert.equal(doc.data.releaseYear, 2023);
    assert.equal(doc.data.releaseDateSource, 'epic-catalog');
    assert.equal(doc.data.catalogPending, undefined);
    assert.match(doc.data.verticalCover, /1200x1600/);
    // The catalog document is written in the old schema, so the read model and
    // the next kick see it too.
    assert.ok(fs.existsSync(epicCache.catalogPath(catalogId)));
    assert.equal(epicCache.getEpicCatalogItem(catalogId).releaseDate, '2023-10-27T00:00:00.000Z');
  });

  await t.test('a cached poster-only detail is completed without a CMS request', async () => {
    details.resetJobs();
    clearCache();
    const owner = 'steam-test-catalog-cached';
    const account = 'epic-cat-cached';
    const catalogId = 'aw2-cat-cached';
    await seedEpicOwner(owner, account);
    // This is the production state: the detail was written before the catalog
    // existed (poster only, no genres/year).
    details.writeDetail(
      'epic',
      'alan-wake-2',
      'ok',
      details.normalizeEpicProduct(EPIC_AW2, { slug: 'alan-wake-2' })
    );
    const cms = fakeClient({});
    const catalogClient = fakeCatalogClient({ items: { [catalogId]: AW2_CATALOG } });
    details.startSecondaryDetails({
      ownerKey: owner,
      gog: [],
      epic: [
        {
          slug: 'alan-wake-2',
          catalogItemId: catalogId,
          namespace: 'fn',
          title: 'Alan Wake 2',
          catalog: null,
        },
      ],
      client: cms,
      epicClient: catalogClient,
      tokenStore,
      pauseMs: 0,
    });
    const job = await waitForJob(owner);
    assert.equal(job.status, 'done');
    assert.equal(job.epic.resolved, 1);
    assert.equal(job.epic.cached, 1);
    // No CMS request: the cached document only needed the catalog fields.
    assert.equal(cms.calls.length, 0);
    assert.equal(catalogClient.calls.length, 1);
    const doc = details.readDetail('epic', 'alan-wake-2').doc;
    assert.deepEqual(doc.data.genres, ['Action', 'Horror']);
    assert.equal(doc.data.releaseYear, 2023);
    assert.equal(doc.data.releaseDateSource, 'epic-catalog');
    assert.equal(doc.data.catalogChecked, true);
    assert.match(doc.data.verticalCover, /1200x1600/);
  });

  await t.test('401 without a refresh token is deferred and stays pending', async () => {
    details.resetJobs();
    clearCache();
    const owner = 'steam-test-catalog-auth';
    const account = 'epic-cat-auth';
    const catalogId = 'aw2-cat-auth';
    await seedEpicOwner(owner, account, { refreshToken: null });
    await epicCache.saveEpicLibrary(account, {
      accountId: account,
      ownerKey: owner,
      fetchedAt: new Date().toISOString(),
      games: [
        { appName: 'Ginger', catalogItemId: catalogId, namespace: 'fn', name: 'Alan Wake 2' },
      ],
    });
    const cms = fakeClient({ '/products/alan-wake-2': EPIC_AW2 });
    const catalogClient = fakeCatalogClient({
      onCatalog() {
        throw authExpired();
      },
    });
    details.startSecondaryDetails({
      ownerKey: owner,
      gog: [],
      epic: [
        {
          slug: 'alan-wake-2',
          catalogItemId: catalogId,
          namespace: 'fn',
          title: 'Alan Wake 2',
          catalog: null,
        },
      ],
      client: cms,
      epicClient: catalogClient,
      tokenStore,
      pauseMs: 0,
    });
    const job = await waitForJob(owner);
    // The poster document is still written — auth expiry is not a reason to
    // lose it — but the catalog step is deferred, not denied.
    assert.equal(job.epic.resolved, 1);
    assert.equal(job.epic.deferred, 1);
    assert.ok(job.warnings.includes('catalog_auth_expired'));
    const doc = details.readDetail('epic', 'alan-wake-2').doc;
    assert.equal(doc.data.catalogPending, true);
    assert.deepEqual(doc.data.genres, []);
    assert.match(doc.data.verticalCover, /1200x1600/);
    // Coverage stays pending so the next kick retries the catalog.
    const coverage = details.coverageForOwner(owner);
    assert.equal(coverage.epic.resolved, 0);
    assert.equal(coverage.epic.pending, 1);
    // Auth expiry is retryable: no negative probe is written.
    assert.equal(details.readCatalogProbe(catalogId).doc, null);
  });

  await t.test('401 → one silent refresh → the retry succeeds', async () => {
    details.resetJobs();
    clearCache();
    const owner = 'steam-test-catalog-refresh';
    const account = 'epic-cat-refresh';
    const catalogId = 'aw2-cat-refresh';
    await seedEpicOwner(owner, account);
    const cms = fakeClient({ '/products/alan-wake-2': EPIC_AW2 });
    const catalogClient = fakeCatalogClient({
      onCatalog(call) {
        if (call === 1) throw authExpired();
        return { items: { [catalogId]: AW2_CATALOG }, requests: 1, failures: [] };
      },
    });
    details.startSecondaryDetails({
      ownerKey: owner,
      gog: [],
      epic: [
        {
          slug: 'alan-wake-2',
          catalogItemId: catalogId,
          namespace: 'fn',
          title: 'Alan Wake 2',
          catalog: null,
        },
      ],
      client: cms,
      epicClient: catalogClient,
      tokenStore,
      pauseMs: 0,
    });
    const job = await waitForJob(owner);
    assert.equal(job.epic.resolved, 1);
    assert.equal(catalogClient.calls.length, 2);
    assert.equal(catalogClient.refreshedWith, 'eg1~fake-refresh-token');
    const doc = details.readDetail('epic', 'alan-wake-2').doc;
    assert.deepEqual(doc.data.genres, ['Action', 'Horror']);
    assert.equal(doc.data.releaseYear, 2023);
    assert.equal(doc.data.catalogPending, undefined);
    const saved = await tokenStore.getTokens(account);
    assert.equal(saved.accessToken, 'eg1~refreshed-access');
    assert.equal(saved.refreshToken, 'eg1~refreshed-refresh');
  });

  await t.test('an empty catalog answer is a 30-day negative memory', async () => {
    details.resetJobs();
    clearCache();
    const owner = 'steam-test-catalog-empty';
    const account = 'epic-cat-empty';
    const catalogId = 'aw2-cat-empty';
    await seedEpicOwner(owner, account);
    const cms = fakeClient({ '/products/alan-wake-2': EPIC_AW2 });
    const catalogClient = fakeCatalogClient({ items: {} });
    const target = {
      slug: 'alan-wake-2',
      catalogItemId: catalogId,
      namespace: 'fn',
      title: 'Alan Wake 2',
      catalog: null,
    };
    details.startSecondaryDetails({
      ownerKey: owner,
      gog: [],
      epic: [target],
      client: cms,
      epicClient: catalogClient,
      tokenStore,
      pauseMs: 0,
    });
    const first = await waitForJob(owner);
    assert.equal(first.epic.resolved, 1);
    const probe = details.readCatalogProbe(catalogId);
    assert.equal(probe.fresh, true);
    assert.equal(probe.doc.status, 'empty');
    // A second kick does not repeat the dead end (the detail is fresh and the
    // probe is negative) — no catalog request.
    details.resetJobs();
    details.startSecondaryDetails({
      ownerKey: owner,
      gog: [],
      epic: [target],
      client: cms,
      epicClient: catalogClient,
      tokenStore,
      pauseMs: 0,
    });
    const second = await waitForJob(owner);
    assert.equal(second.epic.cached, 1);
    assert.equal(catalogClient.calls.length, 1);
    assert.equal(second.requests, 0);
  });

  await t.test('no owner token → library-only, no catalog request', async () => {
    details.resetJobs();
    clearCache();
    const owner = 'steam-test-catalog-notoken';
    const account = 'epic-cat-notoken';
    const catalogId = 'aw2-cat-notoken';
    const nowIso = new Date().toISOString();
    await epicCache.saveEpicProfile({ accountId: account, ownerKey: owner, connectedAt: nowIso });
    const cms = fakeClient({ '/products/alan-wake-2': EPIC_AW2 });
    const catalogClient = fakeCatalogClient({ items: { [catalogId]: AW2_CATALOG } });
    details.startSecondaryDetails({
      ownerKey: owner,
      gog: [],
      epic: [
        {
          slug: 'alan-wake-2',
          catalogItemId: catalogId,
          namespace: 'fn',
          title: 'Alan Wake 2',
          catalog: null,
        },
      ],
      client: cms,
      epicClient: catalogClient,
      tokenStore,
      pauseMs: 0,
    });
    const job = await waitForJob(owner);
    assert.equal(job.epic.resolved, 1);
    assert.equal(catalogClient.calls.length, 0);
    assert.equal(job.requests, 1);
    const doc = details.readDetail('epic', 'alan-wake-2').doc;
    assert.deepEqual(doc.data.genres, []);
    assert.equal(doc.data.catalogPending, undefined);
    assert.match(doc.data.verticalCover, /1200x1600/);
  });

  await t.test('429 trips the existing Epic secondary breaker, detail stays pending', async () => {
    details.resetJobs();
    clearCache();
    details.writeBreaker({});
    const owner = 'steam-test-catalog-rate';
    const account = 'epic-cat-rate';
    const catalogId = 'aw2-cat-rate';
    await seedEpicOwner(owner, account);
    const cms = fakeClient({ '/products/alan-wake-2': EPIC_AW2 });
    const catalogClient = fakeCatalogClient({
      onCatalog() {
        throw Object.assign(new Error('429'), { code: 'epic_rate_limited', status: 429 });
      },
    });
    details.startSecondaryDetails({
      ownerKey: owner,
      gog: [],
      epic: [
        {
          slug: 'alan-wake-2',
          catalogItemId: catalogId,
          namespace: 'fn',
          title: 'Alan Wake 2',
          catalog: null,
        },
      ],
      client: cms,
      epicClient: catalogClient,
      tokenStore,
      pauseMs: 0,
    });
    const job = await waitForJob(owner);
    assert.equal(job.epic.resolved, 1);
    assert.ok(job.warnings.includes('catalog_blocked'));
    const blocked = details.breakerBlock('epic');
    assert.ok(blocked);
    assert.equal(blocked.code, 'catalog_blocked');
    const doc = details.readDetail('epic', 'alan-wake-2').doc;
    assert.equal(doc.data.catalogPending, true);
    details.writeBreaker({});
  });

  await t.test('a spent budget skips the catalog request honestly', async () => {
    details.resetJobs();
    clearCache();
    const owner = 'steam-test-catalog-budget';
    const account = 'epic-cat-budget';
    const catalogId = 'aw2-cat-budget';
    await seedEpicOwner(owner, account);
    const cms = fakeClient({ '/products/alan-wake-2': EPIC_AW2 });
    const catalogClient = fakeCatalogClient({ items: { [catalogId]: AW2_CATALOG } });
    details.startSecondaryDetails({
      ownerKey: owner,
      gog: [],
      epic: [
        {
          slug: 'alan-wake-2',
          catalogItemId: catalogId,
          namespace: 'fn',
          title: 'Alan Wake 2',
          catalog: null,
        },
      ],
      client: cms,
      epicClient: catalogClient,
      tokenStore,
      pauseMs: 0,
      budget: 1,
    });
    const job = await waitForJob(owner);
    assert.equal(job.epic.resolved, 1);
    assert.ok(job.warnings.includes('catalog_budget'));
    assert.equal(catalogClient.calls.length, 0);
    assert.equal(job.requests, 1);
  });
});

}

/* ---- was games-secondary-details-status.test.js ---- */
{

const FIXTURES = path.join(__dirname, 'fixtures', 'games');
function fixture(relative) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, relative), 'utf8'));
}
const EPIC_AW2 = fixture('epic/product-alan-wake-2.json');

const PORT = 7109;
const STEAM_ID = '76561198000000710';
const OWNER = `steam-${STEAM_ID}`;
const EPIC_ACCOUNT = 'epic-wife';

const CONTROL_PAYLOAD = {
  productName: 'Control',
  pages: [
    {
      type: 'productHome',
      productName: 'Control',
      data: {
        meta: {
          releaseDate: '2019-08-27T00:00:00.000Z',
          tags: ['ACTION', 'THIRD_PERSON_SHOOTER'],
          developer: ['Remedy Entertainment'],
          publisher: ['505 Games'],
        },
        hero: {
          portraitBackgroundImageUrl: 'https://cdn1.epicgames.com/control-1200x1600.jpg',
          backgroundImageUrl: 'https://cdn1.epicgames.com/control-2560x1440.jpg',
        },
      },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* seed                                                                */
/* ------------------------------------------------------------------ */

async function seed() {
  const now = new Date().toISOString();
  await gameCache.saveProfile({
    userKey: STEAM_ID,
    personaName: 'wife',
    ownerLabel: 'Жена',
    importedAt: now,
    fetchedAt: now,
  });
  await gameCache.saveLibrary(STEAM_ID, {
    userKey: STEAM_ID,
    fetchedAt: now,
    game_count: 1,
    partial: false,
    fingerprint: '292030',
    totalMinutes: 600,
    games: [
      {
        appid: 292030,
        name: 'The Witcher 3: Wild Hunt',
        playtime_forever: 600,
        playtime_2weeks: 0,
        rtime_last_played: 0,
      },
    ],
  });
  await gameCache.saveDetails(292030, {
    success: true,
    type: 'game',
    name: 'The Witcher 3: Wild Hunt',
    releaseYear: 2015,
    genres: [{ id: '3', description: 'RPG' }],
    is_free: false,
  });
  await epicCache.saveEpicProfile({
    accountId: EPIC_ACCOUNT,
    ownerKey: OWNER,
    displayName: 'wife',
    connectedAt: now,
    importedAt: now,
  });
  await epicCache.saveEpicLibrary(EPIC_ACCOUNT, {
    accountId: EPIC_ACCOUNT,
    ownerKey: OWNER,
    fetchedAt: now,
    gameCount: 2,
    games: [
      // Alan Wake 2: the catalog bulk knows the *title* but not a slug
      // (productmapping does not list it) → only a validated title probe can
      // address it. `appName` is the launcher codename ("Ginger").
      { appName: 'Ginger', catalogItemId: 'aw2-cat', name: 'Ginger' },
      // A normal exclusive with a catalog slug.
      { appName: 'Control', catalogItemId: 'control-cat', name: 'Control' },
    ],
  });
  await epicCache.saveEpicPlaytime(EPIC_ACCOUNT, {
    accountId: EPIC_ACCOUNT,
    fetchedAt: now,
    byArtifactId: {
      'aw2-cat': { artifactId: 'aw2-cat', totalTimeSec: 196200, totalMinutes: 3270 },
      'control-cat': { artifactId: 'control-cat', totalTimeSec: 3600, totalMinutes: 60 },
    },
    totalSeconds: 199800,
    totalMinutes: 3330,
  });
  await epicCache.saveEpicCatalogItem('aw2-cat', {
    title: 'Alan Wake 2',
    releaseDate: '2023-10-27T00:00:00.000Z',
    categories: [{ path: 'games' }, { path: 'games/action' }, { path: 'games/horror' }],
  });
  await epicCache.saveEpicCatalogItem('control-cat', {
    title: 'Control',
    slug: 'control',
    releaseDate: '2019-08-27T00:00:00.000Z',
    categories: [{ path: 'games' }, { path: 'games/action' }],
  });
}

function fakeDetailsClient(handlers = {}) {
  const calls = [];
  return {
    calls,
    async getJson(url) {
      calls.push(url);
      const key = Object.keys(handlers).find((needle) => url.includes(needle));
      if (!key) {
        const err = Object.assign(new Error(`unexpected URL: ${url}`), {
          code: 'secondary_details_unexpected',
        });
        throw err;
      }
      const value = handlers[key];
      if (typeof value === 'function') return value(url);
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

function notFoundError() {
  return Object.assign(new Error('404'), {
    code: 'secondary_details_not_found',
    status: 404,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJob(ownerKey, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    const job = details.jobFor(ownerKey);
    if (job && job.status !== 'running') return job;
    if (Date.now() - started > timeoutMs) throw new Error('job did not finish in time');
    await delay(5);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP status + lazy kick                                             */
/* ------------------------------------------------------------------ */

test('secondary details status + lazy kick', async (t) => {
  await settleWorld();
  await seed();

  const detailsClient = fakeDetailsClient({
    '/products/alan-wake-2': EPIC_AW2,
    '/products/control': CONTROL_PAYLOAD,
  });
  const app = express();
  app.use(express.json());
  app.use(
    '/api/games',
    createRouter({ client: {}, autoEnrich: false, secondaryDetailsClient: detailsClient })
  );
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    res.status(500).json({ error: 'internal', code: 'internal_error' });
  });
  const server = app.listen(PORT);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${PORT}`;

  await t.test('status is honest before the first kick (slugless is named)', async () => {
    const response = await fetch(`${base}/api/games/secondary-details/status?profile=${OWNER}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.profile, OWNER);
    assert.equal(body.total, 2);
    assert.equal(body.resolved, 0);
    assert.equal(body.running, false);
    assert.deepEqual(body.bySource.epic, {
      total: 2,
      resolved: 0,
      notFound: 0,
      unavailable: 0,
      partial: 0,
      retryablePartial: 0,
      missingSlug: 1,
      pending: 2,
      // Diagnostics added by the 02.11.2026 silent-skip fix: the profile is
      // bound to the account, but no token file exists (hasAccessToken false),
      // and no catalog step has skipped yet.
      lastSkip: null,
      binding: { state: 'bound', accountId: EPIC_ACCOUNT, hasAccessToken: false },
    });
    assert.equal(body.bySource.gog.total, 0);
    // Alan Wake 2 cannot be addressed by slug; its catalog title is reported.
    assert.deepEqual(body.slugless, [
      { name: 'Alan Wake 2', catalogItemId: 'aw2-cat', appName: 'Ginger' },
    ]);
    assert.deepEqual(body.lastErrors, []);
    assert.equal(body.cooldownUntil, null);
    assert.equal(body.lastRunAt, null);
    assert.equal(body.kick.lastKickAt, null);
    // The diagnostic endpoint never makes a network request.
    assert.equal(detailsClient.calls.length, 0);
  });

  await t.test('the diagnostic endpoint rejects unknown parameters', async () => {
    const unknown = await fetch(
      `${base}/api/games/secondary-details/status?profile=${OWNER}&kick=1`
    );
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).code, 'unexpected_parameter');
    const missing = await fetch(`${base}/api/games/secondary-details/status`);
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).code, 'profile_required');
  });

  await t.test('GET /stats kicks the job lazily and reports running', async () => {
        const response = await fetch(`${base}/api/games/stats?profile=${OWNER}`);
    assert.equal(response.status, 200);
    const stats = await response.json();
    // The first answer already says the job is running (no UI change needed).
    assert.equal(stats.meta.secondaryDetails.running, true);
    // Before the slug override exists the read model can address only Control:
    // Alan Wake 2 is `noSlug`, which is exactly why the kick is needed.
    assert.equal(stats.meta.secondaryDetails.total, 1);
    assert.equal(stats.meta.secondaryDetails.noSlug, 1);
    assert.equal(stats.meta.secondaryDetails.resolved, 0);

    const job = await waitForJob(OWNER);
    assert.equal(job.status, 'done');
    assert.equal(job.epic.total, 2);
    assert.equal(job.epic.resolved, 2);
    assert.equal(job.epic.missingSlug, 1);
    // Probe + explicit slug: the probe request is counted, the product page is
    // reused from the probe payload (66c3d21 behaviour).
    assert.equal(detailsClient.calls.length, 2);
    assert.match(detailsClient.calls[0], /products\/alan-wake-2$/);
    assert.match(detailsClient.calls[1], /products\/control$/);
    // The discovered slug is remembered for the read model.
    assert.equal(epicCache.getEpicSlugOverride('aw2-cat'), 'alan-wake-2');
    assert.equal(details.readDetail('epic', 'alan-wake-2').doc.status, 'ok');
    assert.equal(details.readDetail('epic', 'control').doc.status, 'ok');
  });

  await t.test('the union card is filled on the next /stats (order of calls)', async () => {
    const response = await fetch(`${base}/api/games/stats?profile=${OWNER}`);
    assert.equal(response.status, 200);
    const stats = await response.json();
    assert.deepEqual(stats.meta.secondaryDetails, {
      resolved: 2,
      total: 2,
      partial: 0,
      noSlug: 0,
      running: false,
    });
    const aw2 = stats.secondaryWorks.find((entry) => entry.name === 'Alan Wake 2');
    assert.ok(aw2, 'Alan Wake 2 is a secondary-only work');
    assert.equal(aw2.source, 'epic');
    // Stale CMS page: the year/genres come from the catalog bulk, the poster
    // from the CMS portrait (1200×1600), exactly the 66c3d21 contract.
    assert.equal(aw2.releaseYear, 2023);
    assert.deepEqual(aw2.genres, ['Action', 'Horror']);
    assert.match(aw2.verticalCover, /1200x1600/);
    // Provenance is signed in the payload (the union attached the detail).
    assert.ok(aw2.metadataSources.includes('epic-store'));
    assert.ok(aw2.metadataSources.includes('epic-catalog'));
    // Hours stay Epic-only (minutes → hours at the payload boundary).
    assert.equal(aw2.hoursBySource.epic, 54.5);
    assert.equal(aw2.hoursBySource.steam, null);
  });

  await t.test('a settled kick starts the cooldown; no second job is spawned', async () => {
    const before = details.jobFor(OWNER).id;
    assert.equal(details.kickGate(OWNER), 'cooldown');
    const direct = details.kickSecondaryDetailsQuietly(OWNER, { gog: [], epic: [] });
    assert.equal(direct.skipped, 'cooldown');
    // Every work is already attempted: even without a cooldown the lazy kick
    // would not start a no-op job.
    const noop = details.kickFromStats(OWNER, { resolved: 0, total: 1, noSlug: 0 });
    assert.equal(noop.skipped, 'attempted');
    assert.equal(details.jobFor(OWNER).id, before);
  });

  await t.test('status after the run: coverage, kick history and lastRunAt', async () => {
    const response = await fetch(`${base}/api/games/secondary-details/status?profile=${OWNER}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, 2);
    assert.equal(body.resolved, 2);
    assert.equal(body.pending, 0);
    assert.equal(body.running, false);
    assert.equal(body.bySource.epic.resolved, 2);
    // The discovered override removed the slugless slot.
    assert.equal(body.bySource.epic.missingSlug, 0);
    assert.deepEqual(body.slugless, []);
    assert.ok(body.lastRunAt);
    // The ledger proves *who* asked: the deploy-time symptom was «nobody
    // kicked», so the trigger is part of the diagnostic.
    assert.ok(
      body.kick.history.some((entry) => entry.trigger === 'stats' && entry.result === 'started')
    );
    assert.equal(body.kick.lastKickAt != null, true);
    assert.ok(body.cooldownUntil);
    assert.equal(body.breakers.epic, null);
    assert.equal(body.checkedAt != null, true);
  });

  await t.test('coalescing: a second kick reuses the running job', async () => {
    details.resetJobs();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const gatedClient = fakeDetailsClient({
      '/products/fresh-target': async () => {
        await gate;
        return CONTROL_PAYLOAD;
      },
    });
    const target = {
      slug: 'fresh-target',
      id: 'fresh-cat',
      catalogItemId: 'fresh-cat',
      title: 'Fresh Target',
    };
    const first = details.kickSecondaryDetailsQuietly(OWNER, {
      gog: [],
      epic: [target],
      client: gatedClient,
      pauseMs: 0,
    });
    assert.ok(first.id);
    const second = details.kickSecondaryDetailsQuietly(OWNER, {
      gog: [],
      epic: [target],
      client: gatedClient,
      pauseMs: 0,
    });
    assert.equal(second.skipped, 'running');
    release();
    await waitForJob(OWNER);
  });
});

/* ------------------------------------------------------------------ */
/* CMS transport: UA, mirror, breaker, dump                            */
/* ------------------------------------------------------------------ */

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function cleanDebug() {
  try {
    fs.rmSync(details.DEBUG_DIR, { recursive: true, force: true });
  } catch (err) {
    /* nothing */
  }
}

test('CMS transport: browser UA, IPv4 mirror, cms_blocked, debug dump', async (t) => {
  details.writeBreaker({});
  cleanDebug();
  t.after(cleanDebug);

  await t.test('primary 403 → IPv4 mirror 200, browser UA on both attempts', async () => {
    const seen = [];
    const server = await startServer((req, res) => {
      seen.push({ url: req.url, ua: req.headers['user-agent'] });
      if (req.url.startsWith('/primary/')) {
        res.writeHead(403, { 'content-type': 'text/html' });
        res.end('<html>blocked by edge</html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(EPIC_AW2));
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const port = server.address().port;
    const urlOf = (slug, host) =>
      `http://127.0.0.1:${port}/${host}/api/en-US/content/products/${slug}`;

    const result = await details.resolveEpic('aw2-mirror', {
      hosts: ['primary', 'mirror'],
      urlOf,
      force: true,
      ignoreBreaker: true,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.host, 'mirror');
    assert.equal(result.data.title, 'Alan Wake 2');
    assert.equal(seen.length, 2);
    assert.match(seen[0].url, /^\/primary\//);
    assert.match(seen[1].url, /^\/mirror\//);
    // A browser UA, not the `kinoboxd/1.0` bot string.
    for (const entry of seen) {
      assert.match(entry.ua, /^Mozilla\/5\.0/);
      assert.match(entry.ua, /Chrome\//);
    }
    // The failed primary answer is dumped for the owner to send back.
    const dump = JSON.parse(
      fs.readFileSync(path.join(details.DEBUG_DIR, 'aw2-mirror.json'), 'utf8')
    );
    assert.equal(dump.status, 403);
    assert.equal(dump.host, 'primary');
    assert.equal(dump.body, '<html>blocked by edge</html>');
    assert.ok(dump.body.length <= 2048);
    assert.equal(details.breakerBlock('epic'), null);
  });

  await t.test('both hosts 403 → breaker cms_blocked for 30 minutes', async () => {
    details.writeBreaker({});
    cleanDebug();
    let requests = 0;
    const server = await startServer((req, res) => {
      requests++;
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('nope');
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const port = server.address().port;
    const urlOf = (slug, host) =>
      `http://127.0.0.1:${port}/${host}/api/en-US/content/products/${slug}`;

    await assert.rejects(
      () =>
        details.resolveEpic('blocked-slug', {
          hosts: ['primary', 'mirror'],
          urlOf,
          force: true,
          ignoreBreaker: true,
        }),
      (err) =>
        err.code === 'secondary_details_blocked' && err.status === 403 && err.deferred === true
    );
    assert.equal(requests, 2);
    const blocked = details.breakerBlock('epic');
    assert.ok(blocked);
    assert.equal(blocked.code, 'cms_blocked');
    assert.ok(Date.parse(blocked.until) - Date.now() > 25 * 60 * 1000);
    // The next product is refused without a request, and says why.
    await assert.rejects(
      () =>
        details.resolveEpic('another-slug', {
          hosts: ['primary', 'mirror'],
          urlOf,
          force: true,
        }),
      (err) =>
        err.code === 'secondary_details_blocked' &&
        err.breakerCode === 'cms_blocked' &&
        err.deferred === true
    );
    assert.equal(requests, 2);
    details.writeBreaker({});
  });

  await t.test('429 is a rate limit: no mirror retry, breaker still tripped', async () => {
    details.writeBreaker({});
    let requests = 0;
    const server = await startServer((req, res) => {
      requests++;
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":"rate"}');
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const port = server.address().port;
    const urlOf = (slug, host) =>
      `http://127.0.0.1:${port}/${host}/api/en-US/content/products/${slug}`;
    await assert.rejects(() =>
      details.resolveEpic('rate-limited', {
        hosts: ['primary', 'mirror'],
        urlOf,
        force: true,
        ignoreBreaker: true,
      })
    );
    assert.equal(requests, 1);
    assert.equal(details.breakerBlock('epic').code, 'cms_blocked');
    details.writeBreaker({});
  });

  await t.test('the dump keeps at most three files and masks query secrets', async () => {
    cleanDebug();
    details.writeBreaker({});
    let requests = 0;
    const server = await startServer((req, res) => {
      requests++;
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`boom ${'x'.repeat(5000)}`);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const port = server.address().port;
    const urlOf = (slug, host) =>
      `http://127.0.0.1:${port}/${host}/api/en-US/content/products/${slug}?token=secret-value`;
    for (const slug of ['one', 'two', 'three', 'four']) {
      await assert.rejects(() =>
        details.resolveEpic(slug, {
          hosts: ['primary'],
          urlOf,
          force: true,
          ignoreBreaker: true,
        })
      );
    }
    assert.equal(requests, 4);
    const files = fs.readdirSync(details.DEBUG_DIR).filter((name) => name.endsWith('.json'));
    assert.equal(files.length, 3);
    const dump = JSON.parse(fs.readFileSync(path.join(details.DEBUG_DIR, 'one.json'), 'utf8'));
    assert.equal(dump.status, 500);
    assert.equal(dump.body.length, 2048);
    assert.equal(dump.url.includes('secret-value'), false);
    assert.match(dump.url, /token=\*\*\*/);
    details.writeBreaker({});
  });
});

/* ------------------------------------------------------------------ */
/* stale slug → title-probe fallback                                   */
/* ------------------------------------------------------------------ */

test('a stale catalog slug falls back to the validated title probe', async (t) => {
  details.resetJobs();
  details.writeBreaker({});
  t.after(() => details.writeBreaker({}));

  await t.test('404 on the catalog slug → probe resolves and the override is saved', async () => {
    const client = fakeDetailsClient({
      '/products/stale-control': () => {
        throw notFoundError();
      },
      '/products/control': CONTROL_PAYLOAD,
    });
    const result = await details.resolveEpic('stale-control', {
      client,
      title: 'Control',
      catalogItemId: 'control-cat',
      probeBudget: 5,
      force: true,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.data.slug, 'control');
    assert.equal(epicCache.getEpicSlugOverride('control-cat'), 'control');
    // The stale slug itself is NOT remembered as «not found».
    assert.equal(details.readDetail('epic', 'stale-control').doc, null);
    assert.equal(client.calls.length, 2);
  });

  await t.test('both the slug and the probe 404 → honest not_found, no override', async () => {
    const client = fakeDetailsClient({
      '/products/': () => {
        throw notFoundError();
      },
    });
    const result = await details.resolveEpic('stale-x', {
      client,
      title: 'Some Exclusive',
      catalogItemId: 'x-cat',
      probeBudget: 5,
      force: true,
    });
    assert.equal(result.status, 'not_found');
    const addressed = details.readDetail('epic', 'stale-x').doc;
    assert.equal(addressed.status, 'not_found');
    // The guess is a short-lived memory, not a verdict.
    const guess = details.readDetail('epic', 'some-exclusive').doc;
    assert.equal(guess.status, 'not_found');
    assert.equal(guess.probe, true);
    assert.equal(epicCache.getEpicSlugOverride('x-cat'), null);
  });

  await t.test('a probe-only negative does not block an explicitly addressed slug', async () => {
    // `some-exclusive` is cached as `probe: true`; if the catalog later names
    // exactly that slug, the product must be fetched, not served as 404.
    const client = fakeDetailsClient({
      '/products/some-exclusive': {
        productName: 'Some Exclusive',
        pages: [
          {
            type: 'productHome',
            productName: 'Some Exclusive',
            data: { meta: { releaseDate: '2021-01-01', tags: ['ACTION'] } },
          },
        ],
      },
    });
    const result = await details.resolveEpic('some-exclusive', {
      client,
      title: 'Some Exclusive',
      force: false,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.data.releaseYear, 2021);
    assert.equal(client.calls.length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* 403 from the job → reason, not «no data»                            */
/* ------------------------------------------------------------------ */

test('a blocked CMS is reported as epic_cms_blocked in the job', async (t) => {
  details.resetJobs();
  details.writeBreaker({});
  t.after(() => details.writeBreaker({}));
  const client = fakeDetailsClient({
    '/products/': Object.assign(new Error('blocked'), {
      code: 'secondary_details_blocked',
      status: 403,
      deferred: true,
      reason: 'blocked',
    }),
  });
  details.startSecondaryDetails({
    ownerKey: 'steam-blocked-job',
    gog: [],
    epic: [
      {
        slug: 'blocked-target',
        id: 'blocked-cat',
        catalogItemId: 'blocked-cat',
        title: 'Blocked Target',
      },
    ],
    client,
    pauseMs: 0,
  });
  const job = await waitForJob('steam-blocked-job');
  assert.equal(job.status, 'done');
  // The warning carries the *reason*, so «blocked by the edge» is not read as
  // «the game has no metadata».
  assert.ok(job.warnings.includes('epic_cms_blocked'));
  assert.equal(job.epic.resolved, 0);
  assert.equal(job.epic.deferred, 1);
  const state = details.readStatusState();
  const last = state.lastErrors[state.lastErrors.length - 1];
  assert.equal(last.source, 'epic');
  assert.equal(last.status, 403);
  assert.equal(last.reason, 'cms_blocked');
  assert.equal(last.ownerKey, 'steam-blocked-job');
});

}

/* ---- was games-secondary-kick-partial.test.js ---- */
{

const STEAM_ID = '76561198000000777';
const OWNER = `steam-${STEAM_ID}`;
const ACCOUNT = 'epic-partial-kick';
const CATALOG_ID = 'aw2-partial-catalog';
const SLUG = 'alan-wake-2';

const NOW = new Date().toISOString();

async function seedOwner() {
  await gameCache.saveProfile({
    userKey: STEAM_ID,
    personaName: 'partial-kick',
    privacy: 'public',
    importedAt: NOW,
    fetchedAt: NOW,
  });
  await gameCache.saveLibrary(STEAM_ID, {
    fetchedAt: NOW,
    partial: false,
    source: 'steam-webapi',
    game_count: 0,
    games: [],
  });
  await epicCache.saveEpicProfile({ accountId: ACCOUNT, ownerKey: OWNER, connectedAt: NOW });
  await epicCache.saveEpicLibrary(ACCOUNT, {
    accountId: ACCOUNT,
    fetchedAt: NOW,
    games: [{ appName: 'Ginger', catalogItemId: CATALOG_ID, slug: SLUG, name: 'Alan Wake 2' }],
  });
  await tokenStore.saveTokens({
    accountId: ACCOUNT,
    displayName: 'EpicPartial',
    ownerKey: OWNER,
    accessToken: 'eg1~fake-access-token',
    refreshToken: 'eg1~fake-refresh-token',
    accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
  });
}

function writePartialDetail(extra = {}) {
  details.writeDetail('epic', SLUG, 'ok', {
    schemaVersion: 1,
    source: 'epic',
    id: SLUG,
    title: 'Alan Wake 2',
    slug: SLUG,
    genres: [],
    releaseDate: null,
    releaseYear: 2023,
    releaseDateSource: 'epic-catalog',
    verticalCover: 'https://cdn1.epicgames.com/aw2/portrait-1200x1600.jpg',
    fetchedAt: NOW,
    catalogChecked: true,
    metaStatus: 'partial',
    metaYearHas: true,
    metaGenresOk: false,
    ...extra,
  });
}

function fakeCatalogClient() {
  const calls = [];
  return {
    calls,
    async getCatalogBulk(namespace, ids) {
      calls.push({ namespace, ids: [...ids] });
      return {
        items: {
          [CATALOG_ID]: {
            catalogItemId: CATALOG_ID,
            title: 'Alan Wake 2',
            slug: SLUG,
            releaseDate: '2023-10-27T00:00:00.000Z',
            categories: [{ path: 'games' }, { path: 'games/action' }, { path: 'games/horror' }],
          },
        },
        requests: 1,
        failures: [],
        chunks: [{ ids: [CATALOG_ID], status: 200, bytes: 512 }],
      };
    },
    async refreshTokens() {
      throw new Error('refresh must not be needed in this test');
    },
  };
}

function fakeClient(calls) {
  return {
    async getJson(url) {
      calls.push(url);
      throw new Error(`unexpected CMS request in the partial test: ${url}`);
    },
  };
}

async function waitForJob(timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    const job = details.jobFor(OWNER);
    if (job && job.status !== 'running') return job;
    if (Date.now() - started > timeoutMs) throw new Error('job did not finish in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function clearState() {
  details.resetJobs();
  try {
    fs.rmSync(details.CATALOG_STATE_PATH, { force: true });
  } catch (err) {
    /* nothing to clean */
  }
  try {
    fs.rmSync(details.STATUS_PATH, { force: true });
  } catch (err) {
    /* nothing to clean */
  }
}

test('coverageNeedsKick: the documented rule, in one place', () => {
  assert.equal(details.coverageNeedsKick({ resolved: 0, total: 1, partial: 0, noSlug: 0 }), true);
  assert.equal(details.coverageNeedsKick({ resolved: 1, total: 1, partial: 0, noSlug: 0 }), false);
  assert.equal(details.coverageNeedsKick({ resolved: 1, total: 1, partial: 1, noSlug: 0 }), true);
  assert.equal(details.coverageNeedsKick({ resolved: 1, total: 1, partial: 0, noSlug: 1 }), true);
  assert.equal(details.coverageNeedsKick(null), false);
  assert.equal(details.coverageNeedsKick({}), false);
});

test('partial coverage: retryablePartial > 0, status and stats expose partial', async (t) => {
  await settleWorld();

  await t.test('fresh partial detail with no catalog ledger is retryable', async () => {
    clearState();
    await seedOwner();
    writePartialDetail();

    const coverage = details.coverageForOwner(OWNER);
    assert.equal(coverage.total, 1);
    assert.equal(coverage.resolved, 0);
    assert.equal(coverage.partial, 1);
    assert.equal(coverage.retryablePartial, 1);
    assert.equal(coverage.pending, 0);

    const status = details.statusForOwner(OWNER);
    assert.equal(status.resolved, 0);
    assert.equal(status.total, 1);
    assert.equal(status.partial, 1);
    assert.equal(status.retryablePartial, 1);
    assert.equal(status.bySource.epic.partial, 1);
    assert.equal(status.catalogAttempts.total, 0);
  });

  await t.test('/stats carries partial in meta.secondaryDetails', async () => {
    const stats = buildGamesStatsFromCache(OWNER);
    assert.ok(stats, 'the owner has a library snapshot');
    assert.equal(stats.meta.secondaryDetails.total, 1);
    assert.equal(stats.meta.secondaryDetails.resolved, 0);
    assert.equal(stats.meta.secondaryDetails.partial, 1);
    assert.equal(stats.meta.secondaryDetails.noSlug, 0);
  });

  await t.test('kickFromStats with partial starts the job and completes the detail', async () => {
    clearState();
    writePartialDetail();
    const catalogClient = fakeCatalogClient();
    const cmsCalls = [];
    const kicked = details.kickFromStats(
      OWNER,
      { resolved: 0, total: 1, partial: 1, noSlug: 0 },
      {
        client: fakeClient(cmsCalls),
        epicClient: catalogClient,
        tokenStore,
        pauseMs: 0,
      }
    );
    assert.equal(kicked.skipped, undefined, 'the partial work must not be skipped');
    assert.ok(kicked.id, 'a job was started');
    const job = await waitForJob();
    assert.equal(job.status, 'done');
    assert.equal(catalogClient.calls.length, 1);
    assert.deepEqual(catalogClient.calls[0].ids, [CATALOG_ID]);
    assert.equal(cmsCalls.length, 0, 'a fresh partial detail is not refetched from the CMS');

    const doc = details.readDetail('epic', SLUG).doc;
    assert.deepEqual(doc.data.genres, ['Action', 'Horror']);
    assert.equal(doc.data.releaseYear, 2023);
    assert.equal(doc.data.metaStatus, 'complete');

    const status = details.statusForOwner(OWNER);
    assert.equal(status.resolved, 1);
    assert.equal(status.partial, 0);
    assert.equal(status.catalogAttempts.total, 1);
    assert.equal(status.catalogAttempts.items[0].lastResult, 'shape_ok');
    // The kick ledger proves the trigger: the production symptom was «no kick
    // at all», so `stats` must be visible in the history.
    assert.ok(
      status.kick.history.some((entry) => entry.trigger === 'stats' && entry.result === 'started')
    );
  });

  await t.test('a settled partial (shape_ok ledger) is not kicked again', async () => {
    clearState();
    writePartialDetail();
    details.recordCatalogAttempt(OWNER, CATALOG_ID, {
      result: 'shape_ok',
      httpStatus: 200,
      bytes: 512,
      genresOk: true,
      yearHas: true,
    });
    const coverage = details.coverageForOwner(OWNER);
    assert.equal(coverage.partial, 1);
    assert.equal(coverage.retryablePartial, 0, 'a shape_ok answer is terminal even if the doc is partial');

    const skipped = details.kickFromStats(OWNER, {
      resolved: 0,
      total: 1,
      partial: 1,
      noSlug: 0,
    });
    assert.equal(skipped.skipped, 'attempted');
    assert.equal(details.jobFor(OWNER), null);
  });
});

}
