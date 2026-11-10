'use strict';

/**
 * Games: import, enrich and details self-heal suite: the former standalone `*.test.js` files of this domain,
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

const run = env.makeTmpCache('games-import-suite', { budgets: false });

after(() => {
  env.cleanupTmpDirs();
});

process.on('exit', () => {
  env.cleanupTmpDirs();
});


describe('games-import', () => {
  /**
   * Steam import job (M1): stages, partial mode without a key, errors,
   * idempotent re-import and key masking.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;
  // These files pin the import/enrich contract; the personnel pass (and its
  // live WDQS batch) is covered by games-personnel-kick.test.js with a mock.
  process.env.KINOBOXD_GAMES_WD = 'off';

  const steam = require('../server/games/steam');
  const gameCache = require('../server/games/game-cache');
  const importJobs = require('../server/games/import');
  const { createFakeClient } = require('./fixtures/games/fake-client');

  const ID = '76561198000000001';

  test('full import: profile XML + summaries + GetOwnedGames + recently played', async () => {
    const client = createFakeClient();
    const job = importJobs.startImport('test-player', { client });
    assert.equal(job.status, 'running');
    assert.equal(job.stage, 'queued');
    assert.equal(job.done, false);

    await importJobs.whenIdle();
    const status = importJobs.getStatus(job.jobId);
    assert.equal(status.status, 'done');
    assert.equal(status.stage, 'done');
    assert.equal(status.done, true);
    assert.equal(status.profile, `steam-${ID}`);
    assert.equal(status.libraryPartial, false);
    assert.equal(status.code, null);
    assert.equal(status.error, null);
    assert.equal(status.requests, 4);
    assert.equal(status.gameCount, 10);
    assert.equal(status.ownedCount, 10);
    assert.equal(status.totalMinutes, 36973);
    assert.equal(status.totalHours, 616.2);
    assert.equal(status.playedCount, 8);
    assert.equal(status.backlogCount, 2);
    // The default fake recently-played window is empty: no row is touched.
    assert.equal(status.recentPlayedCount, 0);
    assert.ok(status.recentPlayedFetchedAt);
    assert.deepEqual(client.calls, ['profile', 'summaries', 'owned', 'recent']);

    const profile = gameCache.getProfile(ID);
    assert.equal(profile.personaName, 'test-player');
    assert.equal(profile.privacy, 'public');
    assert.equal(profile.lastLogOff, 1793295403);
    assert.equal(profile.timeCreated, 1298134151);
    assert.equal(profile.customUrl, 'test-player');

    const library = gameCache.getLibrary(ID);
    assert.equal(library.partial, false);
    assert.equal(library.game_count, 10);
    assert.equal(library.games.length, 10);
    assert.equal(library.source, 'steam-webapi');
    assert.equal(library.fingerprint, steam.libraryFingerprint(library.games, 10));
    assert.ok(library.fetchedAt);
  });

  test('a repeat import reuses the fresh snapshot without touching Steam', async () => {
    const client = createFakeClient();
    const job = importJobs.startImport(ID, { client });
    assert.equal(job.status, 'done');
    assert.equal(job.reused, true);
    assert.equal(job.requests, 0);
    assert.equal(job.gameCount, 10);
    assert.deepEqual(client.calls, []);
  });

  test('force bypasses the reuse window', async () => {
    const client = createFakeClient();
    const job = importJobs.startImport(ID, { client, force: true });
    assert.equal(job.reused, false);
    await importJobs.whenIdle();
    assert.equal(importJobs.getStatus(job.jobId).status, 'done');
    assert.equal(client.calls.length, 4);
  });

  test('concurrent requests coalesce into one running job', async () => {
    const client = createFakeClient();
    const first = importJobs.startImport(ID, { client, force: true });
    const second = importJobs.startImport(ID, { client, force: true });
    assert.equal(second.jobId, first.jobId);
    await importJobs.whenIdle();
    assert.equal(importJobs.getStatus(first.jobId).status, 'done');
  });

  test('no key → libraryPartial with the most recent games, not a failed job', async () => {
    const client = createFakeClient({ key: null });
    const job = importJobs.startImport(ID, { client, force: true });
    await importJobs.whenIdle();
    const status = importJobs.getStatus(job.jobId);
    assert.equal(status.status, 'done');
    assert.equal(status.libraryPartial, true);
    assert.equal(status.code, 'steam_key_missing');
    assert.ok(status.warning);
    assert.equal(status.gameCount, null);
    assert.equal(status.ownedCount, 2); // trimmed fixture has two most-recent games
    assert.equal(status.totalMinutes, 828 + 108); // 13.8 h + 1.8 h
    assert.deepEqual(client.calls, ['profile']);

    const library = gameCache.getLibrary(ID);
    assert.equal(library.partial, true);
    assert.equal(library.game_count, null);
    assert.equal(library.source, 'steam-profile-xml');
    assert.equal(library.games.length, 2);
  });

  test('private profile fails with profile_private and is not cached', async () => {
    const profile = steam.parseProfileXml(
      fs.readFileSync(path.join(__dirname, 'fixtures', 'games', 'profile.xml'), 'utf8')
    );
    const client = createFakeClient({
      profile: { ...profile, steamId64: '76561198000000009', privacyState: 'private' },
    });
    const job = importJobs.startImport('76561198000000009', { client });
    await importJobs.whenIdle();
    const status = importJobs.getStatus(job.jobId);
    assert.equal(status.status, 'failed');
    assert.equal(status.stage, 'failed');
    assert.equal(status.code, 'profile_private');
    assert.match(status.error, /приватност/i);
    assert.equal(gameCache.getProfile('76561198000000009'), null);
  });

  test('empty GetOwnedGames is library_private, not "0 games"', async () => {
    const client = createFakeClient({
      owned: { empty: true, gameCount: 0, games: [], totalMinutes: 0, fingerprint: null },
    });
    const job = importJobs.startImport(ID, { client, force: true });
    await importJobs.whenIdle();
    const status = importJobs.getStatus(job.jobId);
    assert.equal(status.status, 'failed');
    assert.equal(status.code, 'library_private');
  });

  test('invalid targets throw synchronously (route answers 400)', () => {
    assert.throws(() => importJobs.startImport('123'), (err) => err.code === 'invalid_steamid');
    assert.throws(() => importJobs.startImport(''), (err) => err.code === 'invalid_steamid');
  });

  test('the API key never reaches the job status or the logs', async () => {
    const secret = 'SECRETKEY0123456789';
    const client = createFakeClient({ key: secret });
    client.getOwnedGames = async () => {
      throw new steam.SteamError(
        `Steam Web API ответил 500: https://api.steampowered.com/x?key=${secret}&steamid=1`,
        'steam_http_error'
      );
    };
    const logs = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => logs.push(args.join(' '));
    console.error = (...args) => logs.push(args.join(' '));
    try {
      const job = importJobs.startImport(ID, { client, force: true });
      await importJobs.whenIdle();
      const status = importJobs.getStatus(job.jobId);
      assert.equal(status.status, 'failed');
      assert.equal(status.code, 'steam_http_error');
      assert.equal(status.error.includes(secret), false);
      assert.match(status.error, /key=\*\*\*/);
      assert.equal(status.keySource, 'test');
      assert.equal(JSON.stringify(status).includes(secret), false);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    assert.equal(logs.join('\n').includes(secret), false);
  });
  after(() => env.resetMutableState());
});


describe('games-import-mismatch', () => {
  /**
   * P0/s (defensive): Steam may not hand over a library that belongs to another
   * owner than the one that was asked for.
   *
   * The community profile XML is the authoritative owner: `profiles/<id64>/`
   * echoes the requested steamid64. If it ever answers a different one (a
   * redirect, a broken vanity, a proxy), the `GetOwnedGames` snapshot that
   * follows would be attributed to the wrong person — the one thing the games
   * model forbids (ИГРЫ §2.0: two owners are never merged). The import fails with
   * `steamid_mismatch` and caches nothing, so the tab cannot show foreign hours.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;
  process.env.KINOBOXD_GAMES_WD = 'off';

  const steam = require('../server/games/steam');
  const gameCache = require('../server/games/game-cache');
  const importJobs = require('../server/games/import');
  const { createFakeClient } = require('./fixtures/games/fake-client');

  const REQUESTED = '76561198000000009';
  const ANSWERED = '76561198000000077';

  function profileFixture(overrides = {}) {
    const base = steam.parseProfileXml(
      fs.readFileSync(path.join(__dirname, 'fixtures', 'games', 'profile.xml'), 'utf8')
    );
    return { ...base, ...overrides };
  }

  test('a profile XML that answers another steamid64 fails the import and caches nothing', async () => {
    const client = createFakeClient();
    // The fake client echoes the requested id64 (like the real endpoint); here we
    // need the pathological answer: a DIFFERENT owner than the one asked for.
    client.getProfile = async () => profileFixture({ steamId64: ANSWERED });
    const job = importJobs.startImport(REQUESTED, { client, force: true });
    await importJobs.whenIdle();
    const status = importJobs.getStatus(job.jobId);

    assert.equal(status.status, 'failed');
    assert.equal(status.code, 'steamid_mismatch');
    assert.match(status.error, new RegExp(REQUESTED));
    assert.match(status.error, new RegExp(ANSWERED));
    assert.equal(status.ownedCount, null, 'the library was never read');
    assert.equal(client.calls.includes('owned'), false, 'no GetOwnedGames for a foreign owner');

    assert.equal(gameCache.getProfile(REQUESTED), null);
    assert.equal(gameCache.getProfile(ANSWERED), null);
    assert.equal(gameCache.getLibrary(REQUESTED), null);
    assert.equal(gameCache.getLibrary(ANSWERED), null);
  });

  test('a vanity import takes the owner Steam resolves (no mismatch: nothing was claimed)', async () => {
    const client = createFakeClient();
    client.getProfile = async () => profileFixture({ steamId64: ANSWERED });
    const job = importJobs.startImport('some-vanity', { client, force: true });
    await importJobs.whenIdle();
    const status = importJobs.getStatus(job.jobId);

    assert.equal(status.status, 'done');
    assert.equal(status.profile, `steam-${ANSWERED}`);
    assert.equal(gameCache.getProfile(ANSWERED).userKey, ANSWERED);
  });
  after(() => env.resetMutableState());
});


describe('games-import-targetkey', () => {
  /**
   * P3: a vanity import job must name the OWNER, not the string that was typed.
   *
   * `startImport('some-vanity')` used to keep `targetKey = 'vanity:some-vanity'`
   * for the whole run, while the profile is `steam-<steamid64>`. Everything that
   * asks «is an import running for this profile?» (`isRunning('steam-…')`) missed
   * the job until it finished. Now the resolved key replaces the vanity one and
   * the vanity stays as an alias, so coalescing still works both ways.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;
  process.env.KINOBOXD_GAMES_WD = 'off';

  const steam = require('../server/games/steam');
  const importJobs = require('../server/games/import');
  const { createFakeClient, readFixture } = require('./fixtures/games/fake-client');

  const ID = steam.parseProfileXml(readFixture('profile.xml')).steamId64;
  const PROFILE_KEY = `steam-${ID}`;
  const VANITY = 'test-player';

  function gatedClient() {
    const client = createFakeClient();
    const owned = client.getOwnedGames.bind(client);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    client.getOwnedGames = async (steamId64) => {
      await gate;
      return owned(steamId64);
    };
    return { client, release };
  }

  test('the running vanity job answers isRunning("steam-<id64>") and still coalesces', async () => {
    const { client, release } = gatedClient();
    const job = importJobs.startImport(VANITY, { client, force: true });
    assert.equal(job.status, 'running');

    // The profile stage has resolved the owner by now (the library is gated).
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(importJobs.isRunning(PROFILE_KEY), true, 'the job is known by the owner key');
    assert.equal(importJobs.isRunning(`vanity:${VANITY}`), true, 'the vanity stays an alias');

    // A second import — by vanity or by steamid64 — coalesces into the same job.
    const again = importJobs.startImport(VANITY, { client, force: true });
    const byId = importJobs.startImport(ID, { client, force: true });
    assert.equal(again.jobId, job.jobId);
    assert.equal(byId.jobId, job.jobId);

    release();
    await importJobs.whenIdle();
    const status = importJobs.getStatus(job.jobId);
    assert.equal(status.status, 'done');
    assert.equal(status.profile, PROFILE_KEY);
    assert.equal(importJobs.isRunning(PROFILE_KEY), false, 'a finished job is no longer running');
  });
  after(() => env.resetMutableState());
});


describe('games-enrich', () => {
  /**
   * M2 enrich job: resumable appdetails pass over one library, budget, force,
   * re-check window, deferred failures (no negative cache) and the persisted
   * progress state. No network: the store client is injected.
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

  let nextBase = 100000;
  function appidRange(count) {
    const base = nextBase;
    nextBase += 100;
    return Array.from({ length: count }, (_, index) => base + index);
  }

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
      release_date: {
        date: '1 Jan, 2015',
        coming_soon: false,
        year: 2015,
        month: 1,
        day: 1,
        precision: 'day',
      },
      releaseYear: 2015,
      releasePrecision: 'day',
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

  function createFakeStoreClient(options = {}) {
    const calls = [];
    const docs = options.docs || {};
    const fail = options.fail || {};
    return {
      calls,
      async getAppDetails(appid) {
        calls.push(appid);
        if (fail[appid]) {
          const err = new Error(`store failed for ${appid}`);
          err.code = fail[appid];
          throw err;
        }
        return JSON.parse(JSON.stringify(docs[appid] || detailDoc(appid)));
      },
    };
  }

  async function seedProfile(id, appids) {
    const now = new Date().toISOString();
    await gameCache.saveProfile({
      userKey: id,
      personaName: `tester-${id.slice(-2)}`,
      privacy: 'public',
      importedAt: now,
      fetchedAt: now,
    });
    const games = appids.map((appid, index) => ({
      appid,
      name: `Game ${appid}`,
      playtime_forever: (index + 1) * 60,
      playtime_2weeks: null,
      rtime_last_played: 0,
      img_icon_url: null,
      playtime_windows_forever: 0,
      playtime_mac_forever: 0,
      playtime_linux_forever: 0,
      playtime_deck_forever: 0,
    }));
    await gameCache.saveLibrary(id, {
      fetchedAt: now,
      partial: false,
      source: 'steam-webapi',
      game_count: games.length,
      games,
      totalMinutes: games.reduce((sum, game) => sum + game.playtime_forever, 0),
      fingerprint: `fp-${id}`,
    });
    return gameCache.profileKeyOf(id);
  }

  async function runJob(profileKey, client, options = {}) {
    const started = enrich.startEnrich(profileKey, { client, ...options });
    await enrich.whenIdle();
    return enrich.getStatus(started.jobId);
  }

  test('full enrich: one request per appid, details written, journal state saved', async () => {
    const appids = appidRange(4);
    const profile = await seedProfile('76561198000000101', appids);
    const client = createFakeStoreClient();
    const status = await runJob(profile, client, { budget: 100 });
    assert.equal(status.status, 'done');
    assert.equal(status.stage, 'done');
    assert.equal(status.done, true);
    assert.equal(status.total, 4);
    assert.equal(status.selected, 4);
    assert.equal(status.ok, 4);
    assert.equal(status.unavailable, 0);
    assert.equal(status.deferred, 0);
    assert.equal(status.requests, 4);
    assert.equal(status.remaining, 0);
    assert.equal(status.budgetLimit, 100);
    assert.equal(status.budgetRemaining, 96);
    assert.equal(status.detailsResolved, 4);
    assert.equal(status.detailsTotal, 4);
    assert.equal(status.detailsPercent, 100);
    assert.deepEqual(client.calls, appids);

    for (const appid of appids) {
      const doc = gameCache.getDetails(appid);
      assert.equal(doc.success, true);
      assert.equal(doc.type, 'game');
      assert.ok(doc.fetchedAt);
    }
    const state = gameCache.readEnrichState();
    assert.equal(state.profiles[profile].attempted.length, 4);
    assert.equal(state.profiles[profile].lastAppid, appids[appids.length - 1]);
    assert.equal(state.runs.length, 1);
    assert.equal(state.runs[0].ok, 4);
    assert.equal(state.runs[0].detailsResolved, 4);
  });

  test('resume: a second pass skips fresh details and sends zero requests', async () => {
    const appids = appidRange(3);
    const profile = await seedProfile('76561198000000102', appids);
    await runJob(profile, createFakeStoreClient(), { budget: 100 });
    const before = appids.map((appid) => gameCache.getDetails(appid).fetchedAt);

    const client = createFakeStoreClient();
    const second = await runJob(profile, client, { budget: 100 });
    assert.equal(second.selected, 0);
    assert.equal(second.skippedFresh, 3);
    assert.equal(second.requests, 0);
    assert.equal(second.ok, 0);
    assert.equal(second.detailsResolved, 3);
    assert.deepEqual(client.calls, []);
    const after = appids.map((appid) => gameCache.getDetails(appid).fetchedAt);
    assert.deepEqual(after, before);
  });

  test('force re-fetches everything, ignoring freshness', async () => {
    const appids = appidRange(2);
    const profile = await seedProfile('76561198000000103', appids);
    await runJob(profile, createFakeStoreClient(), { budget: 100 });
    const client = createFakeStoreClient();
    const forced = await runJob(profile, client, { budget: 100, force: true });
    assert.equal(forced.force, true);
    assert.equal(forced.selected, 2);
    assert.equal(forced.requests, 2);
    assert.deepEqual(client.calls, appids);
  });

  test('recheckDays: only documents older than the window are re-fetched', async () => {
    const appids = appidRange(4);
    const profile = await seedProfile('76561198000000104', appids);
    await runJob(profile, createFakeStoreClient(), { budget: 100 });

    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const staleDoc = gameCache.getDetails(appids[1]);
    await gameCache.saveDetails(appids[1], { ...staleDoc, fetchedAt: old });

    const window180 = createFakeStoreClient();
    const first = await runJob(profile, window180, { budget: 100, recheckDays: 180 });
    assert.deepEqual(window180.calls, [appids[1]]);
    assert.equal(first.selected, 1);
    assert.equal(first.skippedFresh, 3);

    const window365 = createFakeStoreClient();
    const second = await runJob(profile, window365, { budget: 100, recheckDays: 365 });
    assert.deepEqual(window365.calls, []);
    assert.equal(second.selected, 0);
    assert.equal(second.skippedFresh, 4);
  });

  test('budget: each run processes one slice, the next run resumes the rest', async () => {
    // Isolate the run ring so this test counts exactly its own passes.
    await gameCache.saveEnrichState({ profiles: {}, runs: [] });
    const appids = appidRange(10);
    const profile = await seedProfile('76561198000000105', appids);
    const expectations = [
      { selected: 3, remaining: 7 },
      { selected: 3, remaining: 4 },
      { selected: 3, remaining: 1 },
      { selected: 1, remaining: 0 },
      { selected: 0, remaining: 0 },
    ];
    for (const expected of expectations) {
      const client = createFakeStoreClient();
      const status = await runJob(profile, client, { budget: 3 });
      assert.equal(status.selected, expected.selected);
      assert.equal(status.remaining, expected.remaining);
      assert.equal(client.calls.length, expected.selected);
    }
    const state = gameCache.readEnrichState();
    // The fifth pass selected nothing (everything fresh) and is a no-op: only
    // the four fetching passes are journaled.
    assert.equal(state.runs.filter((run) => run.profile === profile).length, 4);
    assert.equal(state.profiles[profile].detailsResolved, 10);
  });

  test('network failure is deferred: nothing is cached and the run stops', async () => {
    const appids = appidRange(3);
    const profile = await seedProfile('76561198000000106', appids);
    const client = createFakeStoreClient({ fail: { [appids[1]]: 'store_unreachable' } });
    const status = await runJob(profile, client, { budget: 100 });
    assert.equal(status.ok, 1);
    assert.equal(status.deferred, 1);
    assert.equal(status.remaining, 1);
    assert.equal(status.stoppedBy, 'store_unreachable');
    assert.deepEqual(status.errors, ['store_unreachable']);
    assert.ok(gameCache.getDetails(appids[0]));
    assert.equal(gameCache.getDetails(appids[1]), null);
    // The run stopped at the failure: the third appid was not attempted.
    assert.equal(gameCache.getDetails(appids[2]), null);
    assert.deepEqual(client.calls, [appids[0], appids[1]]);
  });

  test('a single 5xx is deferred but the pass continues with the next appid', async () => {
    const appids = appidRange(3);
    const profile = await seedProfile('76561198000000107', appids);
    const client = createFakeStoreClient({ fail: { [appids[1]]: 'store_http_error' } });
    const status = await runJob(profile, client, { budget: 100 });
    assert.equal(status.ok, 2);
    assert.equal(status.deferred, 1);
    assert.equal(status.remaining, 1);
    assert.equal(status.stoppedBy, null);
    assert.deepEqual(client.calls, appids);
    assert.ok(gameCache.getDetails(appids[2]));
  });

  test('success:false is an honest unavailable document, not a deferred error', async () => {
    const appids = appidRange(2);
    const profile = await seedProfile('76561198000000108', appids);
    const docs = {
      [appids[0]]: {
        appid: appids[0],
        success: false,
        unavailable: true,
        type: null,
        name: null,
        metadataSource: 'steam-store',
        error: 'not_available',
      },
    };
    const client = createFakeStoreClient({ docs });
    const status = await runJob(profile, client, { budget: 100 });
    assert.equal(status.ok, 1);
    assert.equal(status.unavailable, 1);
    assert.equal(status.deferred, 0);
    assert.equal(status.detailsResolved, 1);
    const doc = gameCache.getDetails(appids[0]);
    assert.equal(doc.success, false);
    assert.equal(doc.unavailable, true);

    // The answer is cached, so the next pass does not ask again.
    const next = createFakeStoreClient({ docs });
    const second = await runJob(profile, next, { budget: 100 });
    assert.equal(second.selected, 0);
    assert.deepEqual(next.calls, []);
  });

  test('a running job for the same profile coalesces', async () => {
    const appids = appidRange(2);
    const profile = await seedProfile('76561198000000109', appids);
    const client = createFakeStoreClient();
    const first = enrich.startEnrich(profile, { client, budget: 100 });
    const second = enrich.startEnrich(profile, { client, budget: 100 });
    assert.equal(second.jobId, first.jobId);
    await enrich.whenIdle();
    assert.equal(enrich.getStatus(first.jobId).done, true);
  });

  test('unknown / malformed profiles are rejected synchronously', async () => {
    assert.throws(
      () => enrich.startEnrich('steam-76561198000000999'),
      (err) => err.code === 'unknown_profile' && err.status === 400
    );
    assert.throws(
      () => enrich.startEnrich('livelib-Margaret'),
      (err) => err.code === 'invalid_profile' && err.status === 400
    );
  });
  after(() => env.resetMutableState());
});


describe('games-details-heal', () => {
  /**
   * One-time heal of `details` documents written before the store parser kept
   * `headerImage` (e5bc5b9, 02.11.2026).
   *
   * The user-visible contract: pressing «Обновить профиль» / «Импорт» after the
   * deploy must **add the missing artwork** to an otherwise TTL-fresh document
   * instead of waiting 180 days or forcing a full re-fetch of the library.
   *
   * Pinned here, with injected fake clients (no live requests):
   *   1. a fresh `success:true` document without `headerImage` is re-fetched
   *      once and the healed URL lands in `details/<appid>.json`;
   *   2. the ledger (`state/details-heal-state.json`) records the outcome, so a
   *      second run selects nothing — no cyclic `force`, no repeated spend;
   *   3. an honest `unavailable` document (success:false) is **not** a candidate:
   *      there is no store page to ask for artwork;
   *   4. a store answer without artwork is remembered as `no_artwork`;
   *   5. a deferred (network) failure is not recorded, so the next run retries;
   *   6. the heal obeys `GAMES_STORE_BUDGET` like any other details request.
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

  let nextBase = 810000;
  function appidRange(count) {
    const base = nextBase;
    nextBase += 100;
    return Array.from({ length: count }, (_, index) => base + index);
  }

  function headerUrl(appid) {
    return `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/h/hash/header.jpg`;
  }

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
      release_date: {
        date: '1 Jan, 2015',
        coming_soon: false,
        year: 2015,
        month: 1,
        day: 1,
        precision: 'day',
      },
      releaseYear: 2015,
      releasePrecision: 'day',
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

  function healClient(options = {}) {
    const calls = [];
    const fail = options.fail || {};
    return {
      calls,
      async getAppDetails(appid) {
        calls.push(appid);
        if (fail[appid]) {
          const err = new Error(`store failed for ${appid}`);
          err.code = fail[appid];
          throw err;
        }
        if (typeof options.doc === 'function') return options.doc(appid);
        if (options.noArtwork) return detailDoc(appid);
        return detailDoc(appid, { headerImage: headerUrl(appid) });
      },
    };
  }

  async function seedProfile(id, appids) {
    const now = new Date().toISOString();
    await gameCache.saveProfile({
      userKey: id,
      personaName: `heal-${id.slice(-2)}`,
      privacy: 'public',
      importedAt: now,
      fetchedAt: now,
    });
    const games = appids.map((appid, index) => ({
      appid,
      name: `Game ${appid}`,
      playtime_forever: (index + 1) * 60,
      playtime_2weeks: null,
      rtime_last_played: 0,
      img_icon_url: null,
      playtime_windows_forever: 0,
      playtime_mac_forever: 0,
      playtime_linux_forever: 0,
      playtime_deck_forever: 0,
    }));
    await gameCache.saveLibrary(id, {
      fetchedAt: now,
      partial: false,
      source: 'steam-webapi',
      game_count: games.length,
      games,
      totalMinutes: games.reduce((sum, game) => sum + game.playtime_forever, 0),
      fingerprint: `fp-${id}`,
    });
    return gameCache.profileKeyOf(id);
  }

  async function seedFreshDetail(appid, extra = {}) {
    const doc = detailDoc(appid, {
      fetchedAt: new Date().toISOString(),
      ...extra,
    });
    await gameCache.saveDetails(appid, doc);
    return doc;
  }

  async function runDetails(profileKey, client, options = {}) {
    const started = enrich.startEnrich(profileKey, {
      client,
      phases: 'details',
      budget: 100,
      ...options,
    });
    await enrich.whenIdle();
    return enrich.getStatus(started.jobId);
  }

  test('a fresh document without headerImage is healed once, then skipped', async () => {
    const appids = appidRange(2);
    const profile = await seedProfile('76561198000008101', appids);
    // Both documents are TTL-fresh; only the first predates `headerImage`.
    await seedFreshDetail(appids[0]);
    await seedFreshDetail(appids[1], { headerImage: headerUrl(appids[1]) });

    const first = healClient();
    const status = await runDetails(profile, first);

    assert.deepEqual(first.calls, [appids[0]], 'only the artwork-less document is healed');
    assert.equal(status.phases.details.selected, 1);
    assert.equal(status.phases.details.skippedFresh, 1);
    assert.equal(status.phases.details.healCandidates, 1);
    assert.equal(status.phases.details.healed, 1);
    assert.equal(status.phases.details.ok, 1);
    assert.equal(status.phases.details.resolved, 2);

    const healed = gameCache.getDetails(appids[0]);
    assert.equal(healed.headerImage, headerUrl(appids[0]));
    assert.ok(healed.fetchedAt);

    const ledger = gameCache.readDetailsHealState();
    assert.equal(ledger.appids[String(appids[0])].result, 'healed');
    assert.equal(ledger.appids[String(appids[1])], undefined, 'a document with artwork is not in the ledger');

    // Second «Обновить профиль»: nothing is asked again (no cyclic force).
    const second = healClient();
    const again = await runDetails(profile, second);
    assert.deepEqual(second.calls, []);
    assert.equal(again.phases.details.selected, 0);
    assert.equal(again.phases.details.skippedFresh, 2);
    assert.equal(again.phases.details.healCandidates, 0);
    assert.equal(again.phases.details.healed, 0);
  });

  test('an honest unavailable document is not a heal candidate', async () => {
    const appids = appidRange(1);
    const profile = await seedProfile('76561198000008102', appids);
    await gameCache.saveDetails(appids[0], {
      appid: appids[0],
      success: false,
      unavailable: true,
      error: 'not_available',
      metadataSource: 'steam-store',
      fetchedAt: new Date().toISOString(),
    });

    const client = healClient();
    const status = await runDetails(profile, client);
    assert.deepEqual(client.calls, [], 'success:false has no store page to ask');
    assert.equal(status.phases.details.selected, 0);
    assert.equal(status.phases.details.healCandidates, 0);
    assert.equal(status.phases.details.skippedFresh, 1);
    assert.equal(gameCache.readDetailsHealState().appids[String(appids[0])], undefined);
  });

  test('a store answer without artwork is remembered as no_artwork', async () => {
    const appids = appidRange(1);
    const profile = await seedProfile('76561198000008103', appids);
    await seedFreshDetail(appids[0]);

    const first = healClient({ noArtwork: true });
    const status = await runDetails(profile, first);
    assert.deepEqual(first.calls, [appids[0]]);
    assert.equal(status.phases.details.healed, 1);
    assert.equal(gameCache.getDetails(appids[0]).headerImage, undefined);
    const ledger = gameCache.readDetailsHealState();
    assert.equal(ledger.appids[String(appids[0])].result, 'no_artwork');

    const second = healClient();
    const again = await runDetails(profile, second);
    assert.deepEqual(second.calls, [], 'the store already answered without artwork');
    assert.equal(again.phases.details.selected, 0);
  });

  test('a deferred heal request is retried on the next run', async () => {
    const appids = appidRange(1);
    const profile = await seedProfile('76561198000008104', appids);
    await seedFreshDetail(appids[0]);

    const failing = healClient({ fail: { [appids[0]]: 'store_unreachable' } });
    const first = await runDetails(profile, failing);
    assert.deepEqual(failing.calls, [appids[0]]);
    assert.equal(first.phases.details.deferred, 1);
    assert.equal(
      gameCache.readDetailsHealState().appids[String(appids[0])],
      undefined,
      'a network failure is not a verdict'
    );

    const second = healClient();
    const again = await runDetails(profile, second);
    assert.deepEqual(second.calls, [appids[0]], 'the deferred heal is retried');
    assert.equal(again.phases.details.healed, 1);
    assert.equal(gameCache.getDetails(appids[0]).headerImage, headerUrl(appids[0]));
  });

  test('the heal obeys the per-run details budget', async () => {
    const appids = appidRange(3);
    const profile = await seedProfile('76561198000008105', appids);
    for (const appid of appids) await seedFreshDetail(appid);

    const first = healClient();
    const firstRun = await runDetails(profile, first, { budget: 2 });
    assert.equal(firstRun.phases.details.healCandidates, 3);
    assert.equal(firstRun.phases.details.selected, 2);
    assert.equal(firstRun.phases.details.remaining, 1);
    assert.equal(first.calls.length, 2);

    const second = healClient();
    const secondRun = await runDetails(profile, second, { budget: 2 });
    assert.equal(secondRun.phases.details.selected, 1);
    assert.equal(secondRun.phases.details.remaining, 0);
    assert.equal(second.calls.length, 1);
    assert.equal(secondRun.phases.details.healed, 1);
    // Every document now carries artwork and is in the ledger.
    for (const appid of appids) {
      assert.ok(gameCache.getDetails(appid).headerImage);
      assert.equal(
        gameCache.readDetailsHealState().appids[String(appid)].result,
        'healed'
      );
    }
  });
  after(() => env.resetMutableState());
});


describe('games-profile-switch', () => {
  /**
   * P1b/P2: the profile switcher of the games tab.
   *
   *  - a chip shows the owner `label` typed at import (fallback: the Steam
   *    persona), so two owners of one Steam account are told apart (P1b);
   *  - switching profiles never leaves the previous owner's numbers on screen:
   *    the dashboard is hidden behind the loader until the new payload lands (P2);
   *  - includeFree/includeDlc are stored PER PROFILE
   *    (`kinoboxd.games.filters.<profileKey>.v1`) and applied to the switch (P2);
   *  - a personnel answer that arrives after a switch is discarded instead of
   *    painting the other owner's credits (P2 race).
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const { installDom, textOf } = require('./helpers/dom-shim');

  const { nodeFor, storage } = installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });

  const A = 'steam-76561198038369983';
  const B = 'steam-11111111111111111';

  function statsFor(key, personaName) {
    return {
      sources: {
        connected: [key],
        selected: [key],
        profile: { key, source: 'steam', userKey: key.replace(/^steam-/, ''), personaName, gameCount: 2, libraryPartial: false },
        steamKeyConfigured: true,
      },
      summary: {
        gameCount: 2, ownedCount: 2, playedCount: 1, unplayedCount: 1, totalHours: 12,
        meanHours: 6, medianHours: 6, top10HoursShare: 0.9, libraryPartial: false, steamKeyConfigured: true,
      },
      hoursHistogram: [],
      topGames: [],
      recentlyPlayed: [],
      backlog: { count: 1, share: 0.5, items: [] },
      genres: [{ name: 'RPG', hours: 10, count: 2 }],
      tags: [], decades: [], years: [], modes: [], access: {},
      timeline: [], achievementDays: [], streaks: [], metadata: {}, gamesIndex: {},
    };
  }

  const rows = [
    { source: 'steam', userKey: '76561198038369983', key: A, personaName: 'hattivatt', label: 'Я', gameCount: 2 },
    { source: 'steam', userKey: '11111111111111111', key: B, personaName: 'secondplayer', label: 'Брат', gameCount: 2 },
  ];

  const routes = [];
  let releasePersonnelA;
  const personnelGate = new Promise((resolve) => { releasePersonnelA = resolve; });

  const __realFetch = globalThis.fetch;
  before(() => {
    globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    routes.push(`${options.method || 'GET'} ${target}`);
    let payload = {};

    if (target.startsWith('/api/games/profiles')) {
      payload = { profiles: rows, steamKey: { configured: true, source: 'file' } };
    } else if (target.startsWith('/api/games/stats')) {
      const key = new URL(`http://x${target}`).searchParams.get('profile');
      payload = statsFor(key, key === A ? 'hattivatt' : 'secondplayer');
    } else if (target.startsWith('/api/games/personnel')) {
      const profile = new URL(`http://x${target}`).searchParams.get('profile');
      if (profile === A) {
        // Slow answer for the owner we are about to leave.
        await personnelGate;
        payload = { role: 'developer', items: [{ name: 'Alice Studio', count: 1, games: [] }] };
      } else {
        payload = { role: 'developer', items: [{ name: 'Bob Studio', count: 1, games: [] }] };
      }
    } else if (target.startsWith('/api/games/enrich')) {
      payload = { running: false };
    }

    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      async json() { return payload; },
      async text() { return JSON.stringify(payload); },
    };
  };;
  });
  after(() => {
    globalThis.fetch = __realFetch;
  });

  function chips() {
    return nodeFor('games-profile-list').children
      .filter((node) => node.classList && node.classList.contains('games-profile-chip'));
  }
  function chipNamed(name) {
    return chips().find((node) => textOf(node).includes(name));
  }
  async function wait(ms = 0) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  test('chips show the owner label, the switch resets to that owner\'s own filters', async () => {
    storage.set('kinoboxd.games.profile.v1', A);
    // B already has its own filter choice; A has none (server defaults).
    storage.set(`kinoboxd.games.filters.${B}.v1`, JSON.stringify({ includeFree: false, includeDlc: true }));

    const games = await import('../public/js/games.js');
    games.initGames({ onActivate() {} });
    await games.showGames();
    await wait(80);

    /* P1b: the chip is the owner name, the persona stays in the tooltip */
    assert.equal(chips().length, 2);
    assert.match(textOf(chipNamed('Я')).replace(/\s+/g, ' '), /Я/);
    assert.match(chipNamed('Я').getAttribute('title'), /hattivatt/, 'the Steam persona is still discoverable');
    assert.match(textOf(chipNamed('Брат')).replace(/\s+/g, ' '), /Брат/);
    assert.equal(nodeFor('games-dash').hidden, false, 'the selected profile dashboard is shown');

    /* §8.5: the genre filter of the year-count chart is per profile */
    const genreSelect = nodeFor('games-yearcount-genre');
    genreSelect.value = 'RPG';
    genreSelect.onchange();
    assert.equal(genreSelect.value, 'RPG', 'the genre filter was applied');

    /* P2: switching hides the old numbers until the new payload lands */
    chipNamed('Брат').dispatch('click');
    assert.equal(nodeFor('games-dash').hidden, true, 'the old dashboard is hidden on switch');
    assert.equal(nodeFor('games-loading').hidden, false, 'the loader is shown instead');

    await wait(120);
    assert.equal(nodeFor('games-dash').hidden, false, 'the new dashboard is painted');
    assert.equal(storage.get('kinoboxd.games.profile.v1'), B);
    assert.equal(genreSelect.value, '', 'the previous owner genre filter is cleared on switch');

    const switched = routes.filter((route) => route.includes('/api/games/stats'));
    const last = switched[switched.length - 1];
    assert.match(last, /profile=steam-11111111111111111/, 'stats were requested for the new owner');
    assert.match(last, /includeFree=0/, 'the new owner\'s own F2P filter is applied');
    assert.match(last, /includeDlc=1/, 'the new owner\'s own DLC filter is applied');
    assert.equal(
      storage.has(`kinoboxd.games.filters.${A}.v1`),
      false,
      'the previous owner\'s stored filters were not rewritten',
    );

    /* P2 race: A's late personnel answer must not paint Alice on B's dashboard */
    releasePersonnelA();
    await wait(120);
    const persons = textOf(nodeFor('games-person-list'));
    assert.match(persons, /Bob Studio/, 'the current owner credits are rendered');
    assert.doesNotMatch(persons, /Alice Studio/, 'the stale owner answer was discarded');

    games.hideGames();
  });
  after(() => env.resetMutableState());
});
