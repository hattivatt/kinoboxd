'use strict';

/**
 * Games: cache, store, art and editions suite: the former standalone `*.test.js` files of this domain,
 * merged into one process (R19 test-suite consolidation).
 *
 * Each block below is its original file, kept verbatim inside its own
 * `describe()`:
 *
 *   - the describe title is the file stem, so every test stays greppable as
 *     `<file> > <original title>`;
 *   - the block scope keeps a file's helper names from colliding with its
 *     neighbours;
 *   - the hooks a file declared (`test.before`/`test.after`/
 *     `test.beforeEach`) stay scoped to that block instead of applying to the
 *     whole process.
 *
 * The tmp root is one `helpers/env` run for the whole suite, created BEFORE
 * any `server/**` require (every cache namespace reads its root once, at load
 * time). A file's own tmp setup folds into that root — the module singletons
 * are process-wide anyway, so a second root would only desynchronise a file
 * from the directory its assertions read. Tests keep apart by `userKey`/work
 * key, never by root.
 *
 * `env.cleanupTmpDirs()` removes every directory this run created.
 */

const { describe, after, before } = require('node:test');
const env = require('./helpers/env');

const run = env.makeTmpCache('games-catalog-suite', { budgets: false });

after(() => {
  env.cleanupTmpDirs();
});

process.on('exit', () => {
  env.cleanupTmpDirs();
});


describe('games-cache', () => {
  /**
   * Games cache (M1): atomic writes, fingerprints, TTLs, state dir.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const CACHE_DIR = run.cacheGamesDir;
  const STATE_DIR = run.stateDir;
  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const gameCache = require('../server/games/game-cache');

  function tmpFiles(dir) {
    try {
      return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    } catch (err) {
      return [];
    }
  }

  test('profile: save, read, list, atomic write', async () => {
    const saved = await gameCache.saveProfile({
      userKey: '76561198000000001',
      personaName: 'tester',
      avatarUrl: 'https://example.test/a.jpg',
      privacy: 'public',
      importedAt: '2026-11-01T00:00:00.000Z',
      fetchedAt: '2026-11-01T00:00:00.000Z',
    });
    assert.equal(saved.data.key, 'steam-76561198000000001');
    assert.equal(saved.data.schemaVersion, 1);
    assert.ok(saved.fingerprint);

    const profile = gameCache.getProfile('76561198000000001');
    assert.equal(profile.personaName, 'tester');
    assert.equal(profile.source, 'steam');

    const byKey = gameCache.getProfileByKey('steam-76561198000000001');
    assert.equal(byKey.userKey, '76561198000000001');

    const list = gameCache.listProfiles();
    assert.equal(list.length, 1);
    assert.equal(list[0].key, 'steam-76561198000000001');
    assert.equal(list[0].personaName, 'tester');

    assert.deepEqual(tmpFiles(gameCache.PROFILES_DIR), []);
  });

  test('library: snapshot round-trip and fingerprint change on rewrite', async () => {
    const library = {
      fetchedAt: '2026-11-01T00:00:00.000Z',
      partial: false,
      game_count: 2,
      games: [
        { appid: 1, name: 'One', playtime_forever: 60, rtime_last_played: 1 },
        { appid: 2, name: 'Two', playtime_forever: 0, rtime_last_played: 0 },
      ],
      totalMinutes: 60,
      fingerprint: 'abc',
    };
    const first = await gameCache.saveLibrary('76561198000000001', library);
    const read = gameCache.getLibrary('76561198000000001');
    assert.equal(read.game_count, 2);
    assert.equal(read.games.length, 2);

    const second = await gameCache.saveLibrary('76561198000000001', { ...library, game_count: 3 });
    assert.notEqual(first.fingerprint, second.fingerprint);
    assert.deepEqual(tmpFiles(gameCache.LIBRARY_DIR), []);
  });

  test('achievements and global percentages are cached per game', async () => {
    await gameCache.saveAchievements('76561198000000001', 620, {
      fetchedAt: '2026-11-01T00:00:00.000Z',
      gameName: 'Portal 2',
      unlockedCount: 3,
      totalCount: 5,
      achievements: [],
    });
    await gameCache.saveAchievements('76561198000000001', 70, {
      fetchedAt: '2026-11-01T00:00:00.000Z',
      gameName: 'Half-Life',
      unlockedCount: 0,
      totalCount: 0,
      achievements: [],
    });
    const one = gameCache.getAchievements('76561198000000001', 620);
    assert.equal(one.gameName, 'Portal 2');
    assert.equal(one.source, 'steam-community');
    const all = gameCache.listAchievements('76561198000000001');
    assert.equal(all.length, 2);
    assert.equal(gameCache.getAchievements('76561198000000001', 999), null);

    await gameCache.saveGlobal(620, {
      fetchedAt: '2026-11-01T00:00:00.000Z',
      achievements: [{ name: 'ACH.WAKE_UP', percent: 64.7 }],
      byName: { 'ACH.WAKE_UP': 64.7, 'ach.wake_up': 64.7 },
    });
    const global = gameCache.getGlobal(620);
    assert.equal(global.byName['ACH.WAKE_UP'], 64.7);
    assert.equal(gameCache.getGlobal(999), null);
  });

  test('isFresh honours the TTL and rejects invalid timestamps', () => {
    const now = Date.now();
    const doc = { fetchedAt: new Date(now - 1000).toISOString() };
    assert.equal(gameCache.isFresh(doc, 60_000), true);
    assert.equal(gameCache.isFresh(doc, 500), false);
    assert.equal(gameCache.isFresh({ fetchedAt: 'not a date' }, 60_000), false);
    assert.equal(gameCache.isFresh(null, 60_000), false);
    // importedAt is the fallback field for the profile document.
    assert.equal(
      gameCache.isFresh({ importedAt: new Date(now - 1000).toISOString() }, 60_000),
      true
    );
  });

  test('profile tokens: only steam-<17 digits> is valid', () => {
    assert.deepEqual(gameCache.parseProfileToken('steam-76561198000000001'), {
      source: 'steam',
      userKey: '76561198000000001',
      key: 'steam-76561198000000001',
    });
    assert.equal(gameCache.parseProfileToken('steam-123'), null);
    assert.equal(gameCache.parseProfileToken('livelib-Margaret'), null);
    assert.equal(gameCache.parseProfileToken(''), null);
    assert.equal(gameCache.profileKeyOf('76561198000000001'), 'steam-76561198000000001');
  });

  test('safeKey blocks path traversal', () => {
    assert.equal(gameCache.safeKey('../../etc/passwd'), '.._.._etc_passwd');
    assert.equal(gameCache.safeKey('76561198000000001'), '76561198000000001');
    assert.ok(gameCache.achievementPath('../../x', '../y').startsWith(gameCache.ACHIEVEMENTS_DIR));
  });

  test('breaker state is persisted under KINOBOXD_STATE_DIR/games', () => {
    gameCache.writeBreaker({ 'steamcommunity.com': { until: 123, reason: 'HTTP 429' } });
    assert.ok(gameCache.BREAKER_PATH.startsWith(path.join(STATE_DIR, 'games')));
    const state = gameCache.readBreaker();
    assert.equal(state['steamcommunity.com'].until, 123);
    assert.equal(fs.existsSync(gameCache.BREAKER_PATH), true);
  });
  after(() => env.resetMutableState());
});


describe('games-store', () => {
  /**
   * Steam Store `appdetails` client (M2): release-date parser, clean parser and
   * the politeness layer (one appid per request, 1.7 s pause, 30 min breaker,
   * deferred network/5xx — never a negative cache).
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const store = require('../server/games/store');
  const gameCache = require('../server/games/game-cache');
  const { readFixture } = require('./fixtures/games/fake-client');

  function fixture(appid) {
    return JSON.parse(readFixture(`appdetails-${appid}.json`));
  }

  test('parseReleaseDate: every live format, honest precision, sane year bounds', () => {
    assert.deepEqual(store.parseReleaseDate('18 May, 2015'), {
      text: '18 May, 2015',
      year: 2015,
      month: 5,
      day: 18,
      precision: 'day',
    });
    const us = store.parseReleaseDate('Apr 18, 2011');
    assert.equal(us.year, 2011);
    assert.equal(us.month, 4);
    assert.equal(us.day, 18);
    assert.equal(us.precision, 'day');

    const month = store.parseReleaseDate('September 2026');
    assert.equal(month.year, 2026);
    assert.equal(month.month, 9);
    assert.equal(month.day, null);
    assert.equal(month.precision, 'month');

    const quarter = store.parseReleaseDate('Q4 2026');
    assert.equal(quarter.year, 2026);
    assert.equal(quarter.precision, 'quarter');
    assert.equal(quarter.quarter, 4);

    assert.deepEqual(
      { year: store.parseReleaseDate('2026').year, precision: store.parseReleaseDate('2026').precision },
      { year: 2026, precision: 'year' }
    );
    assert.equal(store.parseReleaseDate('Late 2026').year, 2026);
    assert.equal(store.parseReleaseDate('Coming soon').year, null);
    assert.equal(store.parseReleaseDate('Coming soon').precision, 'unknown');
    // A placeholder year outside 1970..2100 must not create a fake decade.
    assert.equal(store.parseReleaseDate('1 Jan, 1900').year, null);
    assert.equal(store.parseReleaseDate('').year, null);
    assert.equal(store.parseReleaseDate(null).year, null);
  });

  test('parseAppDetailsResponse: real Portal 2 fragment', () => {
    const parsed = store.parseAppDetailsResponse(fixture(620), 620);
    assert.equal(parsed.found, true);
    const doc = parsed.doc;
    assert.equal(doc.success, true);
    assert.equal(doc.type, 'game');
    assert.equal(doc.name, 'Portal 2');
    assert.equal(doc.is_free, false);
    assert.deepEqual(doc.developers, ['Valve']);
    assert.deepEqual(doc.publishers, ['Valve']);
    assert.deepEqual(
      doc.genres.map((entry) => entry.description),
      ['Action', 'Adventure']
    );
    assert.ok(doc.categories.some((entry) => entry.description === 'Single-player'));
    assert.ok(doc.categories.some((entry) => entry.description === 'Multi-player'));
    assert.equal(doc.release_date.date, '18 Apr, 2011');
    assert.equal(doc.release_date.coming_soon, false);
    assert.equal(doc.releaseYear, 2011);
    assert.equal(doc.releasePrecision, 'day');
    assert.equal(doc.dlcCount, 1);
    assert.equal(doc.metacritic.score, 95);
    assert.deepEqual(doc.platforms, { windows: true, mac: false, linux: true });
    assert.equal(doc.screenshots.length, 3);
    // M7: the real store artwork is kept as absolute URLs (new SKUs live under
    // `store_item_assets/.../<hash>/`, so the old path cannot be guessed).
    assert.equal(
      doc.headerImage,
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/aaa111/header.jpg?t=1700000000'
    );
    assert.equal(
      doc.capsuleImage,
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/bbb222/capsule_231x87.jpg?t=1700000000'
    );
    assert.equal(doc.earlyAccess, false);
    assert.equal(doc.metadataSource, 'steam-store');
    // Heavy store fields are not carried into the cache document.
    assert.equal(doc.detailed_description, undefined);
    assert.equal(doc.price_overview, undefined);
  });

  test('parseAppDetailsResponse: artwork URLs are absolute or null, never guessed', () => {
    const doc = store.parseAppDetailsResponse({
      123: {
        success: true,
        data: {
          name: 'Relative art',
          header_image: '/steam/apps/123/header.jpg',
          capsule_image: 'javascript:alert(1)',
          screenshots: [{ path_full: 'https://shared.akamai.steamstatic.com/ss/1.jpg' }],
        },
      },
    }, 123).doc;
    assert.equal(doc.headerImage, null);
    assert.equal(doc.capsuleImage, null);
    assert.deepEqual(doc.screenshots, ["https://shared.akamai.steamstatic.com/ss/1.jpg"]);
  });

  test('parseAppDetailsResponse: DLC type and a success:false answer', () => {
    const dlc = store.parseAppDetailsResponse(fixture(355880), 355880).doc;
    assert.equal(dlc.success, true);
    assert.equal(dlc.type, 'dlc');
    assert.match(dlc.name, /Expansion Pass/);

    const unavailable = store.parseAppDetailsResponse(
      { 999: { success: false } },
      999
    );
    assert.equal(unavailable.found, true);
    assert.equal(unavailable.doc.success, false);
    assert.equal(unavailable.doc.unavailable, true);
    assert.equal(unavailable.doc.type, null);

    // A missing key is a malformed answer (deferred), not a negative verdict.
    assert.deepEqual(store.parseAppDetailsResponse({}, 999), { found: false, doc: null });
  });

  test('createClient: one appid per request, 1.7 s pause, clean parse', async () => {
    const requests = [];
    const sleeps = [];
    let clock = 100000;
    const client = store.createClient({
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      request: async (url) => {
        requests.push(url);
        clock += 100;
        return { status: 200, body: JSON.stringify(fixture(620)), headers: {} };
      },
    });
    const first = await client.getAppDetails(620);
    const second = await client.getAppDetails(620);
    assert.equal(first.success, true);
    assert.equal(second.name, 'Portal 2');
    assert.equal(requests.length, 2);
    for (const url of requests) {
      assert.match(url, /store\.steampowered\.com\/api\/appdetails\?/);
      assert.match(url, /appids=620/);
      assert.match(url, /l=english/);
      // Batch was verified broken live (400 for any 2 appids): never send a list.
      assert.doesNotMatch(url, /appids=620[,\d]/);
    }
    // The first request has no pause before it; the second waits the remaining
    // 1600 ms of the 1700 ms window (100 ms was consumed by the request).
    assert.equal(sleeps.length, 1);
    assert.equal(sleeps[0], 1600);
  });

  test('createClient: 429 trips a persisted 30-minute breaker', async () => {
    gameCache.writeBreaker({});
    let calls = 0;
    let clock = 100000;
    const client = store.createClient({
      now: () => clock,
      sleep: async () => {},
      breakerMs: 30 * 60 * 1000,
      request: async () => {
        calls++;
        return { status: 429, body: '', headers: {} };
      },
    });
    await assert.rejects(() => client.getAppDetails(620), (err) => {
      assert.equal(err.code, 'store_rate_limited');
      assert.ok(err.retryAt);
      return true;
    });
    assert.equal(calls, 1);
    const breaker = gameCache.readBreaker();
    assert.ok(breaker[store.STORE_HOST].until > clock);

    // The breaker is persisted: a fresh client does not hit the host either.
    const second = store.createClient({ now: () => clock, sleep: async () => {} });
    await assert.rejects(() => second.getAppDetails(570), (err) => {
      assert.equal(err.code, 'store_rate_limited');
      return true;
    });
    assert.equal(calls, 1);
    gameCache.writeBreaker({});
  });

  test('createClient: network/5xx/non-JSON are deferred and never trip the breaker', async () => {
    gameCache.writeBreaker({});
    const network = store.createClient({
      request: async () => {
        const err = new Error('boom');
        err.code = 'ECONNRESET';
        throw err;
      },
    });
    await assert.rejects(() => network.getAppDetails(620), (err) => {
      assert.equal(err.code, 'store_unreachable');
      return true;
    });
    assert.deepEqual(gameCache.readBreaker(), {});

    const server = store.createClient({
      request: async () => ({ status: 503, body: 'oops', headers: {} }),
    });
    await assert.rejects(() => server.getAppDetails(620), (err) => {
      assert.equal(err.code, 'store_http_error');
      assert.equal(err.status, 503);
      return true;
    });

    const broken = store.createClient({
      request: async () => ({ status: 200, body: '<html>', headers: {} }),
    });
    await assert.rejects(() => broken.getAppDetails(620), (err) => {
      assert.equal(err.code, 'store_http_error');
      return true;
    });

    // A real "no store page" answer is returned, not thrown.
    const unavailable = store.createClient({
      request: async () => ({
        status: 200,
        body: JSON.stringify({ 620: { success: false } }),
        headers: {},
      }),
    });
    const doc = await unavailable.getAppDetails(620);
    assert.equal(doc.success, false);
    assert.equal(doc.unavailable, true);
    assert.deepEqual(gameCache.readBreaker(), {});
  });

  test('detailsFresh honours the TTL and a missing fetchedAt is stale', () => {
    const now = Date.now();
    assert.equal(
      store.detailsFresh({ fetchedAt: new Date(now - 1000).toISOString() }, 60 * 1000),
      true
    );
    assert.equal(
      store.detailsFresh({ fetchedAt: new Date(now - 2 * 60 * 1000).toISOString() }, 60 * 1000),
      false
    );
    assert.equal(store.detailsFresh({}, 60 * 1000), false);
    assert.equal(store.detailsFresh(null, 60 * 1000), false);
  });
  after(() => env.resetMutableState());
});


describe('games-art-enrich', () => {
  /**
   * Details phase also resolves the vertical capsule once per appid
   * (`cache-games/art/resolved/<appid>.json`). No network: the store client and
   * the art fetch are injected.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const gameCache = require('../server/games/game-cache');
  const enrich = require('../server/games/enrich');
  const art = require('../server/games/art');

  const APPID = 3669870;
  const HEADER_HASH = '1e0c76e4253d347bb1304c3f213570251d924edf';
  const HEADER = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${APPID}/${HEADER_HASH}/header.jpg`;
  const CAPSULE = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${APPID}/867a73afa5f21c28aaa14e9b0a4d895c540d4a0c/capsule_231x87.jpg`;
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

  function detailDoc(appid, extra = {}) {
    return {
      appid,
      success: true,
      type: 'game',
      name: `Game ${appid}`,
      is_free: false,
      developers: ['Dev'],
      publishers: ['Pub'],
      genres: [{ id: '1', description: 'Action' }],
      categories: [{ id: '2', description: 'Single-player' }],
      release_date: { date: '1 Jan, 2015', coming_soon: false, year: 2015, precision: 'day' },
      releaseYear: 2015,
      dlc: [],
      dlcCount: 0,
      metacritic: null,
      platforms: { windows: true, mac: false, linux: false },
      screenshots: [],
      earlyAccess: false,
      metadataSource: 'steam-store',
      ...extra,
    };
  }

  function imageResponse(status) {
    const buffer = status === 200 ? JPEG : Buffer.from('not found');
    return {
      ok: status === 200,
      status,
      headers: { get: () => (status === 200 ? 'image/jpeg' : 'text/html') },
      async arrayBuffer() {
        return buffer;
      },
      async text() {
        return buffer.toString('utf8');
      },
    };
  }

  function recordingArtFetch() {
    const calls = [];
    const impl = async (url) => {
      calls.push(String(url));
      if (String(url).includes(`${HEADER_HASH}/library_600x900.jpg`)) return imageResponse(200);
      return imageResponse(404);
    };
    impl.calls = calls;
    return impl;
  }

  async function seedProfile(id, appid) {
    return seedProfileGames(id, [
      { appid, name: `Game ${appid}`, playtime_forever: 60, img_icon_url: '' },
    ]);
  }

  async function seedProfileGames(id, games) {
    const now = new Date().toISOString();
    await gameCache.saveProfile({
      userKey: id,
      personaName: `tester-${id.slice(-2)}`,
      privacy: 'public',
      importedAt: now,
      fetchedAt: now,
    });
    await gameCache.saveLibrary(id, {
      fetchedAt: now,
      partial: false,
      source: 'steam-webapi',
      game_count: games.length,
      games,
      totalMinutes: games.reduce((sum, game) => sum + (Number(game.playtime_forever) || 0), 0),
    });
  }

  function fakeStore(doc) {
    return {
      async getAppDetails() {
        return JSON.parse(JSON.stringify(doc));
      },
    };
  }

  /** One details document per appid, each with a new-schema `header_image`. */
  function fakeStorePerAppid(headerFor) {
    return {
      async getAppDetails(appid) {
        return JSON.parse(
          JSON.stringify(detailDoc(Number(appid), { headerImage: headerFor(Number(appid)) }))
        );
      },
    };
  }

  async function run(profile, client, options) {
    const started = enrich.startEnrich(profile, { client, ...options });
    await enrich.whenIdle();
    return enrich.getStatus(started.jobId);
  }

  test('details phase resolves the vertical capsule once and writes art/resolved', async () => {
    const id = '76561198000000301';
    await seedProfile(id, APPID);
    const fetchImpl = recordingArtFetch();
    const status = await run(`steam-${id}`, fakeStore(detailDoc(APPID, {
      headerImage: HEADER,
      capsuleImage: CAPSULE,
    })), { budget: 10, fetch: fetchImpl });

    assert.equal(status.status, 'done');
    assert.equal(status.phases.details.artCandidates, 1);
    assert.equal(status.phases.details.artResolved, 1);
    assert.equal(status.phases.details.artNone, 0);
    const doc = art.readResolvedArt(APPID);
    assert.ok(doc, 'the resolve document is on disk');
    assert.equal(doc.kind, 'library-hashed');
    assert.equal(doc.h, HEADER_HASH);
    assert.equal(
      art.artProxyUrlFor(doc),
      `/api/games/steam-art/library/${APPID}?h=${HEADER_HASH}`
    );
    assert.ok(fetchImpl.calls.length >= 1, 'the CDN was probed');

    // Second run: details are TTL-fresh and the resolve document is fresh, so
    // the phase reports no art candidates and does not touch the CDN again.
    const before = fs.statSync(path.join(art.RESOLVED_DIR, `${APPID}.json`)).mtimeMs;
    const again = await run(`steam-${id}`, fakeStore(detailDoc(APPID, {
      headerImage: HEADER,
      capsuleImage: CAPSULE,
    })), { budget: 10, fetch: fetchImpl });
    assert.equal(again.phases.details.artCandidates, 0);
    const after = fs.statSync(path.join(art.RESOLVED_DIR, `${APPID}.json`)).mtimeMs;
    assert.equal(after, before, 'no rewrite of a fresh resolve document');
  });

  test('details without header_image never triggers the art resolver', async () => {
    const id = '76561198000000302';
    const appid = 620;
    await seedProfile(id, appid);
    let called = 0;
    const status = await run(`steam-${id}`, fakeStore(detailDoc(appid)), {
      budget: 10,
      artResolver: async () => {
        called++;
        return { kind: 'none' };
      },
    });
    assert.equal(status.phases.details.artCandidates, 0);
    assert.equal(called, 0);
    assert.equal(art.readResolvedArt(appid), null);
  });

  test('a deferred resolve is counted but not written (retried next run)', async () => {
    const id = '76561198000000303';
    const appid = 70;
    await seedProfile(id, appid);
    const status = await run(`steam-${id}`, fakeStore(detailDoc(appid, {
      headerImage: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
    })), {
      budget: 10,
      artResolver: async () => ({ kind: 'none', deferred: true }),
    });
    assert.equal(status.phases.details.artCandidates, 1);
    assert.equal(status.phases.details.artDeferred, 1);
    assert.equal(status.phases.details.artResolved, 0);
    assert.equal(art.readResolvedArt(appid), null);
  });

  test('art sweep order: two-week playtime, then last played, then total playtime — not ascending appid', async () => {
    const id = '76561198000000304';
    const rows = [
      { appid: 10, name: 'Game 10', playtime_forever: 0, img_icon_url: '' },
      {
        appid: 100,
        name: 'Game 100',
        playtime_forever: 5000,
        rtime_last_played: 1700000000,
        img_icon_url: '',
      },
      { appid: 300, name: 'Game 300', playtime_forever: 9000, playtime_2weeks: 30, img_icon_url: '' },
      {
        appid: 400,
        name: 'Game 400',
        playtime_forever: 1000,
        playtime_2weeks: 120,
        rtime_last_played: 1600000000,
        img_icon_url: '',
      },
      { appid: 900, name: 'Game 900', playtime_forever: 8000, img_icon_url: '' },
    ];
    await seedProfileGames(id, rows);
    const headerFor = (appid) =>
      `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/${HEADER_HASH}/header.jpg`;
    const visited = [];
    const status = await run(`steam-${id}`, fakeStorePerAppid(headerFor), {
      budget: 10,
      artResolver: async (appid) => {
        visited.push(appid);
        return { kind: 'none' };
      },
    });

    assert.equal(status.status, 'done');
    assert.equal(status.phases.details.artCandidates, 5);
    assert.equal(status.phases.details.artNone, 5);
    assert.deepEqual(
      visited,
      [400, 300, 100, 900, 10],
      'fresh two-week games first, then last-played, then total hours; the rest keeps appid order'
    );
  });
  after(() => env.resetMutableState());
});


describe('games-art-resolve', () => {
  /**
   * Server-side vertical-art resolve (`server/games/art/resolve.js`).
   *
   * Live evidence (03.11.2026, from the deploy host, public file CDN + store
   * frontend API):
   *
   *   CONTROL Resonant 3669870 — every legacy path 404s:
   *     /steam/apps/3669870/library_600x900.jpg       404
   *     /steam/apps/3669870/header.jpg                404
   *     /steam/apps/3669870/capsule_231x87.jpg        404
   *   the `appdetails` asset hashes only serve the files they name:
   *     <header-hash>/header.jpg                      200/42 KB
   *     <capsule-hash>/capsule_231x87.jpg             200/11 KB
   *     <header-hash>/library_600x900.jpg             404
   *   `IStoreBrowseService` publishes the real vertical capsule:
   *     assets.library_capsule = <hash>/library_capsule.jpg
   *     <hash>/library_capsule.jpg                    200/56 KB
   *
   * The resolver therefore probes one hashed `library_600x900.jpg` and, on a
   * 404, goes straight to the store-frontend asset map; the hash-less legacy
   * path is only kept for old-schema SKUs, where it is the primary source.
   * A negative answer is cached for 30 days.
   *
   * No live request: every `fetch` is injected.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const CACHE_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const art = require('../server/games/art');

  const APPID = 3669870;
  const HEADER_HASH = '1e0c76e4253d347bb1304c3f213570251d924edf';
  const CAPSULE_HASH = '867a73afa5f21c28aaa14e9b0a4d895c540d4a0c';
  const LIBRARY_HASH = '7d4b4f430dc4d07e6562eb445456f9615cb52f77';
  const HEADER = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${APPID}/${HEADER_HASH}/header.jpg?t=1793357289`;
  const CAPSULE = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${APPID}/${CAPSULE_HASH}/capsule_231x87.jpg?t=1793357289`;
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

  function binary(status, body = JPEG) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'image/jpeg' },
      async arrayBuffer() {
        return buffer;
      },
      async text() {
        return buffer.toString('utf8');
      },
    };
  }

  function json(status, body) {
    const text = JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      async text() {
        return text;
      },
      async arrayBuffer() {
        return Buffer.from(text);
      },
    };
  }

  function browsePayload(appid, assets) {
    return {
      response: {
        store_items: [
          {
            appid,
            success: 1,
            visible: true,
            assets,
          },
        ],
      },
    };
  }

  function recordingFetch(handler) {
    const calls = [];
    const impl = async (url, init) => {
      calls.push(String(url));
      return handler(String(url), calls.length);
    };
    impl.calls = calls;
    return impl;
  }

  function clearResolved() {
    try {
      for (const name of fs.readdirSync(art.RESOLVED_DIR)) {
        fs.rmSync(path.join(art.RESOLVED_DIR, name), { force: true });
      }
    } catch (err) {
      /* the directory may not exist yet */
    }
  }

  const isBrowse = (url) => url.includes('IStoreBrowseService');
  // The legacy hash-less path — the one the new schema must never spend a
  // request on. A hashed URL contains `store_item_assets/steam/apps/<id>/<hash>/`
  // and therefore cannot match.
  const isLegacyLibrary = (url) => /\/steam\/apps\/\d+\/library_600x900\.jpg$/.test(url);

  /* =========================================================
     1. hashed / legacy / store-frontend / none
     ========================================================= */

  test('resolve: hashed library_600x900 under header_image wins (legacy SKUs in the new schema)', async () => {
    clearResolved();
    const fetchImpl = recordingFetch(async (url) => {
      if (isBrowse(url)) return json(500, {});
      return /library_600x900\.jpg$/.test(url) && url.includes(HEADER_HASH)
        ? binary(200)
        : binary(404, 'nope');
    });
    const doc = await art.resolveVerticalArt(APPID, {
      headerImage: HEADER,
      capsuleImage: CAPSULE,
      fetch: fetchImpl,
    });
    assert.equal(doc.kind, 'library-hashed');
    assert.equal(doc.h, HEADER_HASH);
    assert.equal(doc.file, 'library_600x900.jpg');
    assert.equal(doc.proxyType, 'library');
    assert.equal(doc.matchedBy, 'header-hash');
    assert.equal(fetchImpl.calls.length, 1, 'first 200 stops the chain (no GetItems)');
    assert.equal(
      art.artProxyUrlFor(doc),
      `/api/games/steam-art/library/${APPID}?h=${HEADER_HASH}`
    );
  });

  test('resolve: legacy-scheme header → legacy library_600x900.jpg, no GetItems', async () => {
    clearResolved();
    const legacyHeader = `https://cdn.cloudflare.steamstatic.com/steam/apps/${APPID}/header.jpg?t=1793357289`;
    const fetchImpl = recordingFetch(async (url) => {
      if (isBrowse(url)) return json(500, {});
      return isLegacyLibrary(url) ? binary(200) : binary(404, 'nope');
    });
    const doc = await art.resolveVerticalArt(APPID, {
      headerImage: legacyHeader,
      fetch: fetchImpl,
    });
    assert.equal(doc.kind, 'library-legacy');
    assert.equal(doc.h, null);
    assert.equal(doc.matchedBy, 'legacy');
    assert.equal(art.artProxyUrlFor(doc), `/api/games/steam-art/library/${APPID}`);
    assert.equal(fetchImpl.calls.length, 1, 'first legacy host 200, no hashed probe, no GetItems');
    assert.ok(!fetchImpl.calls.some(isBrowse), 'the legacy path never asks the store frontend');
  });

  test('resolve: GetItems library_capsule fixes CONTROL Resonant (no library_600x900 anywhere)', async () => {
    clearResolved();
    const fetchImpl = recordingFetch(async (url) => {
      if (isBrowse(url)) {
        return json(200, browsePayload(APPID, {
          library_capsule: `${LIBRARY_HASH}/library_capsule.jpg`,
          small_capsule: `${CAPSULE_HASH}/capsule_231x87.jpg`,
          community_icon: 'f9f541b67c42a9503467f44072ef9193c135ff33',
        }));
      }
      if (url.includes(`${LIBRARY_HASH}/library_capsule.jpg`)) return binary(200);
      if (url.includes(`${CAPSULE_HASH}/capsule_231x87.jpg`)) return binary(200);
      return binary(404, 'nope');
    });
    const doc = await art.resolveVerticalArt(APPID, {
      headerImage: HEADER,
      capsuleImage: CAPSULE,
      fetch: fetchImpl,
    });
    assert.equal(doc.kind, 'library-hashed');
    assert.equal(doc.h, LIBRARY_HASH);
    assert.equal(doc.file, 'library_capsule.jpg');
    assert.equal(doc.proxyType, 'library_capsule');
    assert.equal(doc.matchedBy, 'store-browse');
    assert.equal(
      art.artProxyUrlFor(doc),
      `/api/games/steam-art/library_capsule/${APPID}?h=${LIBRARY_HASH}`
    );
    assert.equal(
      doc.smallIconFallback,
      `/api/games/steam-art/capsule/${APPID}?h=${CAPSULE_HASH}`
    );
    assert.ok(fetchImpl.calls.some(isBrowse), 'the store-frontend asset map was asked');
    assert.ok(
      !fetchImpl.calls.some(isLegacyLibrary),
      'the new schema never probes the hash-less legacy path'
    );
    // One hashed `library_600x900.jpg` probe (single host), one GetItems call,
    // one 200 for the published capsule: the two guaranteed-404 legacy requests
    // are gone.
    assert.equal(fetchImpl.calls.length, 3);
  });

  test('resolve: every path 404 and GetItems without library_capsule → none, small icon still points at the capsule', async () => {
    clearResolved();
    const fetchImpl = recordingFetch(async (url) => {
      if (isBrowse(url)) return json(200, browsePayload(APPID, {}));
      return binary(404, 'nope');
    });
    const doc = await art.resolveVerticalArt(APPID, {
      headerImage: HEADER,
      capsuleImage: CAPSULE,
      fetch: fetchImpl,
    });
    assert.equal(doc.kind, 'none');
    assert.equal(doc.verticalCapsule, undefined);
    assert.equal(art.artProxyUrlFor(doc), null);
    assert.equal(
      doc.smallIconFallback,
      `/api/games/steam-art/capsule/${APPID}?h=${CAPSULE_HASH}`
    );
  });

  /* =========================================================
     2. TTL of the resolve document
     ========================================================= */

  test('resolve: a positive document is reused for 180 days (no fetch)', async () => {
    clearResolved();
    const first = recordingFetch(async (url) =>
      url.includes(HEADER_HASH) ? binary(200) : binary(404, 'nope')
    );
    const doc = await art.resolveVerticalArt(APPID, { headerImage: HEADER, fetch: first });
    assert.equal(doc.kind, 'library-hashed');

    const second = recordingFetch(async () => binary(200));
    const again = await art.resolveVerticalArt(APPID, {
      headerImage: HEADER,
      fetch: second,
    });
    assert.equal(again.cached, true);
    assert.equal(second.calls.length, 0, 'fresh document served from disk');
    assert.equal(art.readResolvedArt(APPID).kind, 'library-hashed');
  });

  test('resolve: a negative document lives 30 days, then Steam is asked again', async () => {
    clearResolved();
    const writing = recordingFetch(async (url) => {
      if (isBrowse(url)) return json(200, browsePayload(APPID, {}));
      return binary(404, 'nope');
    });
    await art.resolveVerticalArt(APPID, {
      headerImage: HEADER,
      capsuleImage: CAPSULE,
      fetch: writing,
    });
    const file = path.join(art.RESOLVED_DIR, `${APPID}.json`);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));

    const fresh = recordingFetch(async () => binary(200));
    const cached = await art.resolveVerticalArt(APPID, { headerImage: HEADER, fetch: fresh });
    assert.equal(cached.cached, true);
    assert.equal(fresh.calls.length, 0, 'a 30-day-old negative is still fresh');

    saved.resolvedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(saved));
    const refetch = recordingFetch(async (url) => {
      if (isBrowse(url)) return json(200, browsePayload(APPID, {
        library_capsule: `${LIBRARY_HASH}/library_capsule.jpg`,
      }));
      return url.includes(`${LIBRARY_HASH}/library_capsule.jpg`)
        ? binary(200)
        : binary(404, 'nope');
    });
    const updated = await art.resolveVerticalArt(APPID, {
      headerImage: HEADER,
      fetch: refetch,
    });
    assert.equal(updated.kind, 'library-hashed');
    assert.ok(refetch.calls.length > 0, 'after 30 days the CDN is probed again');
  });

  /* =========================================================
     3. deferred, never a negative cache
     ========================================================= */

  test('resolve: GetItems unreachable after CDN 404s → deferred and no document written', async () => {
    clearResolved();
    const fetchImpl = recordingFetch(async (url) => {
      if (isBrowse(url)) throw new Error('ECONNREFUSED');
      return binary(404, 'nope');
    });
    const doc = await art.resolveVerticalArt(APPID, {
      headerImage: HEADER,
      capsuleImage: CAPSULE,
      fetch: fetchImpl,
      retries: 0,
      sleep: async () => {},
    });
    assert.equal(doc.kind, 'none');
    assert.equal(doc.deferred, true);
    assert.equal(art.readResolvedArt(APPID), null, 'a network failure is not an answer');
  });

  test('resolve: a fully unreachable CDN is deferred too', async () => {
    clearResolved();
    const fetchImpl = recordingFetch(async () => {
      throw new Error('ETIMEDOUT');
    });
    const doc = await art.resolveVerticalArt(APPID, {
      headerImage: HEADER,
      fetch: fetchImpl,
      retries: 0,
      sleep: async () => {},
    });
    assert.equal(doc.deferred, true);
    assert.equal(art.readResolvedArt(APPID), null);
  });

  /* =========================================================
     4. small pieces
     ========================================================= */

  test('assetHashFromUrl: only an allowlisted store_item_assets URL yields a hash', () => {
    assert.equal(art.assetHashFromUrl(HEADER), HEADER_HASH);
    assert.equal(
      art.assetHashFromUrl(`https://cdn.cloudflare.steamstatic.com/steam/apps/${APPID}/header.jpg`),
      null
    );
    assert.equal(
      art.assetHashFromUrl(`https://evil.example/store_item_assets/steam/apps/${APPID}/abc/header.jpg`),
      null
    );
  });

  test('artProxyUrlFor: hashed/legacy/SGDB/none', () => {
    assert.equal(
      art.artProxyUrlFor({ appid: 5, kind: 'library-hashed', h: 'abc', proxyType: 'library_capsule' }),
      '/api/games/steam-art/library_capsule/5?h=abc'
    );
    assert.equal(
      art.artProxyUrlFor({ appid: 5, kind: 'library-legacy' }),
      '/api/games/steam-art/library/5'
    );
    assert.equal(
      art.artProxyUrlFor({ appid: 5, kind: 'sgdb', url: 'https://cdn2.steamgriddb.com/grid/1.png' }),
      'https://cdn2.steamgriddb.com/grid/1.png'
    );
    assert.equal(art.artProxyUrlFor({ appid: 5, kind: 'none' }), null);
  });

  test('proxy type: library_capsule is an allowlisted type with its own file name', () => {
    assert.equal(art.FILE_BY_TYPE.library_capsule, 'library_capsule.jpg');
    const parsed = art.parseRequest({
      params: { type: 'library_capsule', appid: String(APPID) },
      query: { h: LIBRARY_HASH },
    });
    assert.deepEqual(parsed, { type: 'library_capsule', appid: APPID, hash: LIBRARY_HASH });
  });
  after(() => env.resetMutableState());
});


describe('games-art-stats', () => {
  /**
   * `/stats` payload after the vertical-art resolve: `verticalCapsule`,
   * `verticalCapsuleKnown` (false = Steam really has no vertical capsule) and
   * `iconFallbackUrl` (small capsule for a missing 32×32 icon).
   *
   * Additive contract: without a resolve document the rows keep the exact
   * pre-resolve shape and the client walks the legacy CDN chain.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const CACHE_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const gameCache = require('../server/games/game-cache');
  const art = require('../server/games/art');
  const { buildGamesStatsFromCache } = require('../server/games/stats');

  const ID = '76561198000000888';
  const PROFILE_KEY = `steam-${ID}`;
  const APPID = 3669870;
  const HEADER = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${APPID}/1e0c76e4253d347bb1304c3f213570251d924edf/header.jpg`;
  const LIB_HASH = '7d4b4f430dc4d07e6562eb445456f9615cb52f77';
  const CAPSULE_HASH = '867a73afa5f21c28aaa14e9b0a4d895c540d4a0c';

  function row(appid, name, minutes = 60, rtime = 0) {
    return { appid, name, playtime_forever: minutes, playtime_2weeks: 0, rtime_last_played: rtime, img_icon_url: '' };
  }

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
      categories: [],
      release_date: { date: 'Sep 24, 2026', coming_soon: false, year: 2026, precision: 'year' },
      releaseYear: 2026,
      dlc: [],
      dlcCount: 0,
      metacritic: null,
      platforms: { windows: true, mac: false, linux: false },
      headerImage: HEADER,
      screenshots: [],
      earlyAccess: false,
      metadataSource: 'steam-store',
      ...extra,
    };
  }

  async function seed(games, details) {
    const now = new Date().toISOString();
    await gameCache.saveProfile({
      userKey: ID,
      personaName: 'art-stats',
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

  function resolved(extra = {}) {
    return {
      schemaVersion: 1,
      appid: APPID,
      kind: 'library-hashed',
      h: LIB_HASH,
      file: 'library_capsule.jpg',
      proxyType: 'library_capsule',
      matchedBy: 'store-browse',
      source: 'steam-store',
      smallIconFallback: `/api/games/steam-art/capsule/${APPID}?h=${CAPSULE_HASH}`,
      resolvedAt: new Date().toISOString(),
      ...extra,
    };
  }

  test('gamesIndex/recentlyPlayed: resolved vertical capsule + icon fallback', async () => {
    await seed([row(APPID, 'CONTROL Resonant', 120, 1793000000)], {
      [APPID]: detailDoc(APPID),
    });
    await art.saveResolvedArt(resolved());
    const stats = buildGamesStatsFromCache(PROFILE_KEY);
    const entry = stats.gamesIndex[APPID];
    assert.equal(
      entry.verticalCapsule,
      `/api/games/steam-art/library_capsule/${APPID}?h=${LIB_HASH}`
    );
    assert.equal(entry.verticalCapsuleKnown, true);
    assert.equal(
      entry.iconFallbackUrl,
      `/api/games/steam-art/capsule/${APPID}?h=${CAPSULE_HASH}`
    );
    assert.equal(stats.recentlyPlayed[0].verticalCapsule, entry.verticalCapsule);
    assert.equal(stats.recentlyPlayed[0].iconFallbackUrl, entry.iconFallbackUrl);
  });

  test('resolved none: verticalCapsuleKnown=false and no URL', async () => {
    await seed([row(APPID, 'CONTROL Resonant', 120, 1793000000)], {
      [APPID]: detailDoc(APPID),
    });
    await art.saveResolvedArt(resolved({
      kind: 'none',
      h: null,
      file: null,
      proxyType: null,
      matchedBy: 'not_found',
    }));
    const entry = buildGamesStatsFromCache(PROFILE_KEY).gamesIndex[APPID];
    assert.equal(entry.verticalCapsule, null);
    assert.equal(entry.verticalCapsuleKnown, false);
    assert.equal(
      entry.iconFallbackUrl,
      `/api/games/steam-art/capsule/${APPID}?h=${CAPSULE_HASH}`
    );
  });

  test('legacy resolve keeps the hash-less proxy path', async () => {
    await seed([row(APPID, 'CONTROL Resonant', 120, 1793000000)], {
      [APPID]: detailDoc(APPID),
    });
    await art.saveResolvedArt(resolved({
      kind: 'library-legacy',
      h: null,
      file: 'library_600x900.jpg',
      proxyType: 'library',
      matchedBy: 'legacy',
    }));
    const entry = buildGamesStatsFromCache(PROFILE_KEY).gamesIndex[APPID];
    assert.equal(entry.verticalCapsule, `/api/games/steam-art/library/${APPID}`);
    assert.equal(entry.verticalCapsuleKnown, true);
  });

  test('no resolve document: additive fields stay absent (old payload shape)', async () => {
    const other = 620;
    await seed([row(other, 'Portal 2', 60)], { [other]: detailDoc(other) });
    fs.rmSync(path.join(art.RESOLVED_DIR, `${APPID}.json`), { force: true });
    fs.rmSync(path.join(art.RESOLVED_DIR, `${other}.json`), { force: true });
    const entry = buildGamesStatsFromCache(PROFILE_KEY).gamesIndex[other];
    assert.equal(Object.hasOwn(entry, 'verticalCapsule'), false);
    assert.equal(Object.hasOwn(entry, 'verticalCapsuleKnown'), false);
    assert.equal(Object.hasOwn(entry, 'iconFallbackUrl'), false);
  });

  test('an edition row paints the primary edition resolved capsule', async () => {
    const primary = 937;
    const edition = 462780;
    await seed(
      [row(edition, 'Darksiders Warmastered Edition', 60, 1793000000)],
      {
        [edition]: detailDoc(edition),
        [primary]: detailDoc(primary),
      }
    );
    await art.saveResolvedArt(resolved({
      appid: primary,
      h: 'primaryhash',
      file: 'library_capsule.jpg',
    }));
    // editions.json merges the two appids only when both are in the library, so
    // seed the primary row as well.
    await gameCache.saveLibrary(ID, {
      fetchedAt: new Date().toISOString(),
      partial: false,
      source: 'steam-webapi',
      game_count: 2,
      games: [row(primary, 'Darksiders', 600), row(edition, 'Darksiders Warmastered Edition', 60, 1793000000)],
      totalMinutes: 660,
    });
    const stats = buildGamesStatsFromCache(PROFILE_KEY);
    assert.equal(stats.gamesIndex[edition].primaryAppid, primary);
    assert.equal(
      stats.gamesIndex[edition].verticalCapsule,
      `/api/games/steam-art/library_capsule/${primary}?h=primaryhash`
    );
  });
  after(() => env.resetMutableState());
});


describe('games-editions', () => {
  /**
   * M5-B edition matching: title normalization, false-positive guards, Wikidata
   * QID merge, manual overrides and the persisted `cache-games/editions.json`.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const CACHE_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const editions = require('../server/games/editions');

  function game(appid, name, minutes = 0) {
    return { appid, name, playtime_forever: minutes, playtime_2weeks: 0, rtime_last_played: 0 };
  }

  function details(name, extra = {}) {
    return {
      success: true,
      type: 'game',
      name,
      developers: [],
      releaseYear: null,
      genres: [],
      ...extra,
    };
  }

  function links(extra = {}) {
    return {
      qid: null,
      franchiseKey: null,
      releaseYear: null,
      resolved: true,
      ...extra,
    };
  }

  function index(games, detailMap, linkMap = {}, manual) {
    return editions.buildEditionIndex({
      games,
      details: detailMap,
      links: linkMap,
      manual,
      profileKey: 'steam-76561198000000901',
    });
  }

  /* ------------------------------------------------------------------ */
  /* Normalization                                                       */
  /* ------------------------------------------------------------------ */

  test('coreTitle strips edition and region wrappers, keeps real words', () => {
    const cases = [
      ['The Elder Scrolls V: Skyrim Special Edition', 'the elder scrolls v skyrim'],
      ['The Elder Scrolls V: Skyrim', 'the elder scrolls v skyrim'],
      ['Grand Theft Auto V Enhanced', 'grand theft auto v'],
      ['Grand Theft Auto V Legacy', 'grand theft auto v'],
      ['Dishonored RHCP', 'dishonored'],
      ['Max Payne (RU)', 'max payne'],
      ['Max Payne RU', 'max payne'],
      ['Fallout: New Vegas PCR', 'fallout new vegas'],
      ['Company of Heroes - Legacy Edition', 'company of heroes'],
      ["Wasteland 2: Director's Cut", 'wasteland 2'],
      ['Divinity: Original Sin (Classic)', 'divinity original sin'],
      ['Divinity: Original Sin - Enhanced Edition', 'divinity original sin'],
      ['Titan Quest Anniversary Edition', 'titan quest'],
      ['BioShock™ Remastered', 'bioshock'],
      ['Darksiders Warmastered Edition', 'darksiders'],
      ['Serious Sam HD: The First Encounter', 'serious sam the first encounter'],
      ['Serious Sam Classic: The First Encounter', 'serious sam the first encounter'],
    ];
    for (const [raw, expected] of cases) {
      assert.equal(editions.coreTitle(raw), expected, raw);
    }
  });

  test('coreTitle never eats real words: "Us", years and subtitles stay', () => {
    assert.equal(editions.coreTitle('The Last of Us'), 'the last of us');
    assert.equal(editions.coreTitle('Layers of Fear (2016)'), 'layers of fear 2016');
    assert.equal(
      editions.coreTitle('Arma 2: Operation Arrowhead Beta (Obsolete)'),
      'arma 2 operation arrowhead beta obsolete'
    );
    assert.equal(editions.coreTitle('Counter-Strike: Source'), 'counter strike source');
    assert.equal(editions.coreTitle('BioShock Infinite'), 'bioshock infinite');
    assert.equal(editions.coreTitle('Gothic 1 Remake'), 'gothic 1 remake');
  });

  test('numeric signature separates numbered sequels and roman numerals', () => {
    assert.equal(editions.numericSignature(editions.coreTokens('Gothic 1')), '1');
    assert.equal(editions.numericSignature(editions.coreTokens('Gothic 2')), '2');
    assert.equal(editions.numericSignature(editions.coreTokens('Grand Theft Auto III')), 'iii');
    assert.equal(editions.numericSignature(editions.coreTokens('Grand Theft Auto IV')), 'iv');
  });

  /* ------------------------------------------------------------------ */
  /* Pairwise guards                                                     */
  /* ------------------------------------------------------------------ */

  function node(appid, name, extra = {}) {
    return {
      appid,
      name,
      names: [{ raw: name, tokens: editions.coreTokens(name), key: editions.coreTitle(name), marker: editions.hasEditionMarker(name) }],
      type: extra.type || 'game',
      developers: extra.developers || [],
      year: extra.year == null ? null : extra.year,
      qid: extra.qid || null,
      franchiseKey: extra.franchiseKey || null,
    };
  }

  test('editionMatch merges the real re-releases', () => {
    const skyrim = node(72850, 'The Elder Scrolls V: Skyrim', {
      developers: ['Bethesda Game Studios'],
      year: 2011,
    });
    const skyrimSe = node(489830, 'The Elder Scrolls V: Skyrim Special Edition', {
      developers: ['Bethesda Game Studios'],
      year: 2016,
    });
    assert.equal(editions.editionMatch(skyrim, skyrimSe).confidence, 'exact-edition');

    const gtaLegacy = node(271590, 'Grand Theft Auto V Legacy', {
      developers: ['Rockstar North'],
      year: 2015,
    });
    const gtaEnhanced = node(3240220, 'Grand Theft Auto V Enhanced', {
      developers: ['Rockstar North'],
      year: 2025,
    });
    assert.equal(editions.editionMatch(gtaLegacy, gtaEnhanced).confidence, 'exact-edition');

    const bioShock = node(7670, 'BioShock', { developers: ['2K Boston'], year: 2007 });
    const bioShockRemastered = node(409710, 'BioShock Remastered', {
      developers: ['Blind Squirrel', '2K Boston'],
      year: 2016,
    });
    assert.equal(editions.editionMatch(bioShock, bioShockRemastered).confidence, 'exact-edition');

    // Same title, no suffix, different appid: the catalog duplicate case.
    const gta3 = node(12100, 'Grand Theft Auto III', { developers: ['Rockstar Games'], year: 2008 });
    const gta3Region = node(12230, 'Grand Theft Auto III');
    assert.equal(editions.editionMatch(gta3, gta3Region).confidence, 'exact');
  });

  test('editionMatch refuses the known false positives', () => {
    const cs = node(10, 'Counter-Strike', { developers: ['Valve'], year: 2000 });
    const csSource = node(240, 'Counter-Strike: Source', { developers: ['Valve'], year: 2004 });
    assert.equal(editions.editionMatch(cs, csSource), null);

    const bioShock = node(7670, 'BioShock', { developers: ['2K Boston'], year: 2007 });
    const infinite = node(8870, 'BioShock Infinite', { developers: ['Irrational Games'], year: 2013 });
    assert.equal(editions.editionMatch(bioShock, infinite), null);

    const gothic1 = node(65540, 'Gothic 1 Classic', { developers: ['Piranha Bytes'], year: 2001 });
    const gothic2 = node(39510, 'Gothic II: Gold Classic', { developers: ['Piranha Bytes'], year: 2003 });
    assert.equal(editions.editionMatch(gothic1, gothic2), null);

    const doom = node(1, 'DOOM', { developers: ['id Software'], year: 1993 });
    const doom2016 = node(379720, 'DOOM', { developers: ['id Software'], year: 2016 });
    assert.equal(editions.editionMatch(doom, doom2016), null);

    const darkMessiah = node(2100, 'Dark Messiah of Might & Magic Single Player', {
      developers: ['Arkane Studios'],
      year: 2006,
    });
    const darkMessiahMp = node(2130, 'Dark Messiah of Might & Magic Multi-Player', {
      developers: ['Arkane Studios'],
      year: 2006,
    });
    assert.equal(editions.editionMatch(darkMessiah, darkMessiahMp), null);

    const sameNameDifferentDev = node(900, 'Project X', { developers: ['Studio A'], year: 2010 });
    const sameNameOtherDev = node(901, 'Project X', { developers: ['Studio B'], year: 2010 });
    assert.equal(editions.editionMatch(sameNameDifferentDev, sameNameOtherDev), null);

    const gameRow = node(902, 'Project Y', { developers: ['Studio A'], year: 2010 });
    const dlcRow = node(903, 'Project Y', {
      type: 'dlc',
      developers: ['Studio A'],
      year: 2010,
    });
    assert.equal(editions.editionMatch(gameRow, dlcRow), null);
  });

  test('editionMatch: same QID wins, different franchise blocks a title hit', () => {
    const left = node(228200, 'Company of Heroes', { qid: 'Q500851' });
    const right = node(4560, 'Company of Heroes - Legacy Edition', { qid: 'Q500851' });
    assert.equal(editions.editionMatch(left, right).confidence, 'qid');

    const a = node(1, 'Same Title', { developers: ['Dev'], year: 2010, franchiseKey: 'wd:Q1' });
    const b = node(2, 'Same Title', { developers: ['Dev'], year: 2011, franchiseKey: 'wd:Q2' });
    assert.equal(editions.editionMatch(a, b), null);
  });

  test('fuzzy title is a strict last resort', () => {
    const typo = node(1, 'BioShock', { developers: ['2K Boston'], year: 2007 });
    const typo2 = node(2, 'BioShok', { developers: ['2K Boston'], year: 2007 });
    assert.equal(editions.editionMatch(typo, typo2).confidence, 'fuzzy');

    // No developer evidence → no fuzzy merge.
    const noDev = node(3, 'BioShok');
    assert.equal(editions.editionMatch(typo, noDev), null);

    // Too far apart in time → no fuzzy merge.
    const late = node(4, 'BioShok', { developers: ['2K Boston'], year: 2012 });
    assert.equal(editions.editionMatch(typo, late), null);
  });

  /* ------------------------------------------------------------------ */
  /* Groups                                                              */
  /* ------------------------------------------------------------------ */

  test('buildEditionIndex: one work, canonical primary = most played edition', () => {
    const games = [
      game(72850, 'The Elder Scrolls V: Skyrim', 600),
      game(489830, 'The Elder Scrolls V: Skyrim Special Edition', 120),
      game(1, 'Other Game', 60),
    ];
    const detailsMap = {
      72850: details('The Elder Scrolls V: Skyrim', {
        developers: ['Bethesda Game Studios'],
        releaseYear: 2011,
      }),
      489830: details('The Elder Scrolls V: Skyrim Special Edition', {
        developers: ['Bethesda Game Studios'],
        releaseYear: 2016,
      }),
      1: details('Other Game', { developers: ['Someone'], releaseYear: 2020 }),
    };
    const doc = index(games, detailsMap);
    assert.equal(doc.meta.appids, 3);
    assert.equal(doc.meta.works, 2);
    assert.equal(doc.meta.groups, 1);
    assert.equal(doc.meta.gamesMerged, 2);
    assert.equal(doc.meta.savedCount, 1);
    const entry = doc.canonical['72850'];
    assert.equal(entry.workKey, 'steam:72850');
    assert.equal(entry.primaryAppid, 72850);
    assert.equal(entry.editionCount, 2);
    assert.deepEqual(entry.appids, [72850, 489830]);
    assert.deepEqual(
      entry.editions.map((edition) => [edition.appid, edition.hours, edition.isPrimary]),
      [
        [72850, 10, true],
        [489830, 2, false],
      ]
    );
    assert.equal(editions.editionKeyOf(doc, 489830), 'steam:72850');
    assert.equal(editions.editionKeyOf(doc, 999), 'steam:999');
    assert.equal(doc.canonical['1'].editionCount, 1);
    assert.equal(doc.groups[0].confidence, 'exact-edition');
  });

  test('buildEditionIndex: QID work key and manual merges/splits', () => {
    const games = [game(228200, 'Company of Heroes', 0), game(4560, 'Company of Heroes - Legacy Edition', 0)];
    const doc = index(
      games,
      {
        228200: details('Company of Heroes', { developers: ['Relic Entertainment'], releaseYear: 2006 }),
        4560: details('Company of Heroes - Legacy Edition', {
          developers: ['Relic Entertainment'],
          releaseYear: 2007,
        }),
      },
      { 228200: links({ qid: 'Q500851' }), 4560: links({ qid: 'Q500851' }) }
    );
    assert.equal(doc.canonical['228200'].workKey, 'wd:Q500851');
    assert.equal(doc.canonical['228200'].primaryAppid, 228200);

    // A manual split beats the QID signal.
    const split = index(
      games,
      {
        228200: details('Company of Heroes', { developers: ['Relic Entertainment'], releaseYear: 2006 }),
        4560: details('Company of Heroes - Legacy Edition', {
          developers: ['Relic Entertainment'],
          releaseYear: 2007,
        }),
      },
      { 228200: links({ qid: 'Q500851' }), 4560: links({ qid: 'Q500851' }) },
      { splits: [[228200, 4560]] }
    );
    assert.equal(split.meta.works, 2);

    // A manual merge beats everything else (even different titles).
    const manual = index(
      [game(10, 'Alpha', 60), game(11, 'Beta', 120)],
      { 10: details('Alpha'), 11: details('Beta') },
      {},
      { merges: [[10, 11]] }
    );
    assert.equal(manual.meta.works, 1);
    assert.equal(manual.canonical['10'].workKey, manual.canonical['11'].workKey);
    assert.equal(manual.canonical['10'].primaryAppid, 11);
    assert.equal(manual.groups[0].confidence, 'manual');
  });

  test('regional cards merge with their base card, not with a different game', () => {
    const cases = [
      ['Dishonored', 'Dishonored RHCP'],
      ['Max Payne', 'Max Payne (RU)'],
      ['Fallout: New Vegas', 'Fallout: New Vegas PCR'],
      ['The Elder Scrolls V: Skyrim', 'The Elder Scrolls V: Skyrim Special Edition'],
    ];
    for (const [base, regional] of cases) {
      const left = node(1, base, { developers: ['Dev'], year: 2011 });
      const right = node(2, regional, { developers: ['Dev'], year: 2011 });
      assert.ok(editions.editionMatch(left, right), `${base} / ${regional}`);
    }

    const newVegas = node(1, 'Fallout: New Vegas PCR', { developers: ['Obsidian'], year: 2010 });
    const fallout1 = node(2, 'Fallout', { developers: ['Interplay'], year: 1997 });
    assert.equal(editions.editionMatch(newVegas, fallout1), null);
  });

  test('buildEditionIndex is deterministic for the same inputs', () => {
    const games = [
      game(1, 'Same Game', 0),
      game(2, 'Same Game', 0),
      game(3, 'Same Game', 0),
    ];
    const detailsMap = {
      1: details('Same Game', { developers: ['Dev'], releaseYear: 2010 }),
      2: details('Same Game', { developers: ['Dev'], releaseYear: 2010 }),
      3: details('Same Game', { developers: ['Dev'], releaseYear: 2010 }),
    };
    const first = index(games, detailsMap);
    const second = index(games, detailsMap);
    assert.equal(first.meta.works, 1);
    assert.equal(first.canonical['1'].primaryAppid, 1);
    assert.deepEqual(first.canonical, second.canonical);
  });

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */

  test('ensureEditions persists, reuses and rebuilds on input change, keeps manual', () => {
    const profileKey = 'steam-76561198000000901';
    const games = [game(100, 'Skyrim', 60), game(101, 'Skyrim Special Edition', 120)];
    const detailsMap = {
      100: details('Skyrim', { developers: ['Bethesda'], releaseYear: 2011, fetchedAt: '2026-01-01T00:00:00Z' }),
      101: details('Skyrim Special Edition', {
        developers: ['Bethesda'],
        releaseYear: 2016,
        fetchedAt: '2026-01-01T00:00:00Z',
      }),
    };
    const library = { games, fingerprint: 'lib-1' };

    const first = editions.ensureEditions(profileKey, { library, games, details: detailsMap, links: {} });
    assert.equal(first.rebuilt, true);
    assert.ok(fs.existsSync(editions.EDITIONS_PATH));
    assert.equal(editions.readEditions(profileKey).canonical['100'].editionCount, 2);

    const second = editions.ensureEditions(profileKey, { library, games, details: detailsMap, links: {} });
    assert.equal(second.rebuilt, false);
    assert.equal(second.doc.inputsFingerprint, first.doc.inputsFingerprint);

    // Manual overrides survive a rebuild triggered by a new details watermark.
    const withManual = editions.readEditions(profileKey);
    withManual.manual = { merges: [], splits: [[100, 101]] };
    editions.saveEditions(profileKey, withManual);
    const changed = {
      ...detailsMap,
      101: { ...detailsMap[101], fetchedAt: '2026-02-02T00:00:00Z' },
    };
    const third = editions.ensureEditions(profileKey, { library, games, details: changed, links: {} });
    assert.equal(third.rebuilt, true);
    assert.equal(third.doc.meta.works, 2, 'manual split must survive the rebuild');
    assert.deepEqual(third.doc.manual.splits, [[100, 101]]);
  });

  test('covers() is false for an unknown appid', () => {
    const doc = index([game(1, 'One', 60)], { 1: details('One') });
    assert.equal(editions.covers(doc, [game(1, 'One', 60)]), true);
    assert.equal(editions.covers(doc, [game(1, 'One', 60), game(2, 'Two', 0)]), false);
    assert.equal(editions.covers(null, []), false);
  });
  after(() => env.resetMutableState());
});


describe('games-b6-editions-base', () => {
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

  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

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
  after(() => env.resetMutableState());
});
