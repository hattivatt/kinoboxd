'use strict';

/**
 * M6d: public store metadata for secondary-only works.
 *
 * The user's complaint: a GOG/Epic game with no Steam twin had no genres, no
 * reliable year and no vertical poster — so it fell out of the genre/year
 * charts and its card was a horizontal banner. These tests pin the two public
 * endpoints (GOG `api.gog.com/v2/games/{id}`, Epic CMS
 * `store-content.ak.epicgames.com/.../products/{slug}`), the normalization,
 * the 30-day cache, the budget/breaker/deferred rules and the stats contract
 * (`genres[]`, `years[]`, `secondaryWorks[].verticalCover`).
 *
 * All network calls are mocked (`client.getJson`); live requests are never made
 * from `npm test` (ИГРЫ §14.5).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-secondary-details-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-secondary-details-state-')
);

const gameCache = require('../server/games/game-cache');
const gogCache = require('../server/games/gog-cache');
const epicCache = require('../server/games/epic-cache');
const details = require('../server/games/secondary-details');
const { buildSecondaryUnion } = require('../server/games/secondary-union');
const { buildGamesStatsFromCache } = require('../server/games/stats');

const FIXTURES = path.join(__dirname, 'fixtures', 'games');
function fixture(relative) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, relative), 'utf8'));
}

const GOG_WITCHER = fixture('gog/product-1207658924.json');
const GOG_HEROES = fixture('gog/product-1207658787.json');
const EPIC_WITCHER = fixture('epic/product-the-witcher-3-wild-hunt.json');

function cacheFile(source, id) {
  return path.join(details.CACHE_DIR, `${source}-${id}.json`);
}

/** Remove every cached detail between test groups (the cache is global). */
function clearCache() {
  for (const name of fs.readdirSync(details.CACHE_DIR)) {
    if (name.endsWith('.json')) fs.unlinkSync(path.join(details.CACHE_DIR, name));
  }
  details.writeBreaker({});
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
    assert.deepEqual(details.targetsForOwner('steam-unknown'), { gog: [], epic: [] });
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
      running: false,
    });
  });
});
