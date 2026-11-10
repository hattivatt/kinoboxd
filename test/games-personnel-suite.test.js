'use strict';

/**
 * Games: personnel, franchise and secondary model suite: the former standalone `*.test.js` files of this domain,
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

const run = env.makeTmpCache('games-personnel-suite', { budgets: false });

after(() => {
  env.cleanupTmpDirs();
});

process.on('exit', () => {
  env.cleanupTmpDirs();
});


describe('games-franchise-wikidata', () => {
  /**
   * Wikidata franchise provider (M4-B): P1733/P179/P577 query, parsing, links
   * writing, negative cache, resume/force and the shared kill switch.
   *
   * No live request: `fetchImpl` is always injected, the cache/state dirs point
   * at `/tmp`.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const gameCache = require('../server/games/game-cache');
  const franchise = require('../server/games/franchise');

  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'games', 'wikidata-franchises.json'), 'utf8')
  );

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
    await gameCache.saveProfile({ userKey, personaName: 'franchise tester', importedAt: now, fetchedAt: now });
    await gameCache.saveLibrary(userKey, {
      fetchedAt: now,
      partial: false,
      game_count: games.length,
      games,
    });
    return gameCache.profileKeyOf(userKey);
  }

  function links(appid) {
    return franchise.readLinksDoc(appid);
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

  test('SPARQL resolves P1733, series P179 (+en/ru labels) and P577 with precision', () => {
    const query = franchise.franchiseQuery(['292030', '12240']);
    assert.match(query, /VALUES \?appid \{ "292030" "12240" \}/);
    assert.match(query, /wdt:P1733 \?appid/);
    assert.match(query, /wdt:P179 \?franchise/);
    assert.match(query, /LANG\(\?franchiseEn\) = "en"/);
    assert.match(query, /LANG\(\?franchiseRu\) = "ru"/);
    assert.match(query, /p:P577 \?st/);
    assert.match(query, /wikibase:timeValue \?date/);
    assert.match(query, /wikibase:timePrecision \?precision/);
  });

  test('parses the WDQS answer: franchise labels, release year/precision, honest misses', () => {
    const parsed = franchise.parseFranchiseResponse(fixture);
    assert.equal(parsed.size, 7);

    const witcher = parsed.get('292030');
    assert.equal(witcher.qid, 'Q4267401');
    assert.equal(witcher.franchise.qid, 'Q1060747');
    assert.equal(witcher.franchise.labelEn, 'The Witcher');
    assert.equal(witcher.franchise.labelRu, 'Ведьмак');
    assert.equal(witcher.releaseYear, 2015);
    assert.equal(witcher.releasePrecision, 'day');
    assert.equal(witcher.releaseDate, '2015-05-19');

    const halfLife = parsed.get('220');
    assert.equal(halfLife.franchise.labelEn, 'Half-Life');

    // Some series items only carry the multilingual label (Q752241 Half-Life).
    const mulLabel = parsed.get('70');
    assert.equal(mulLabel.franchise.qid, 'Q752241');
    assert.equal(mulLabel.franchise.labelEn, 'Half-Life');

    // No P179, only a year-precision P577: a year is an answer, a date is not.
    const yearOnly = parsed.get('12240');
    assert.equal(yearOnly.franchise, null);
    assert.equal(yearOnly.releaseYear, 2010);
    assert.equal(yearOnly.releasePrecision, 'year');
    assert.equal(yearOnly.releaseDate, null);

    // Two series and two regional dates: lowest labelled series + earliest date.
    const fallout = parsed.get('377160');
    assert.equal(fallout.franchise.qid, 'Q1048511');
    assert.equal(fallout.franchise.labelEn, 'Fallout');
    assert.equal(fallout.releaseDate, '2015-11-09');

    // A QID with neither series nor date is still a resolved answer.
    const bare = parsed.get('91310');
    assert.equal(bare.qid, 'Q3000562');
    assert.equal(bare.franchise, null);
    assert.equal(bare.releaseYear, null);
    assert.equal(bare.releasePrecision, null);
  });

  test('parseWbDate maps WD precision and rejects nonsense years', () => {
    const day = franchise.parseWbDate('+2015-05-19T00:00:00Z', '11');
    assert.equal(day.year, 2015);
    assert.equal(day.month, 5);
    assert.equal(day.day, 19);
    assert.equal(day.precision, 'day');
    assert.equal(day.iso, '2015-05-19');
    const month = franchise.parseWbDate('+2026-09-01T00:00:00Z', '10');
    assert.equal(month.precision, 'month');
    assert.equal(month.day, null);
    assert.equal(month.month, 9);
    const year = franchise.parseWbDate('+1998-01-01T00:00:00Z', '9');
    assert.equal(year.precision, 'year');
    assert.equal(year.month, null);
    assert.equal(franchise.parseWbDate('+1900-01-01T00:00:00Z', '9'), null);
    assert.equal(franchise.parseWbDate('not-a-date', '11'), null);
  });

  test('writes links/<appid>.json and merges what other providers wrote', async () => {
    const userKey = '76561198000002001';
    const profileKey = await seed(userKey, [
      { appid: 292030, name: 'The Witcher 3: Wild Hunt', playtime_forever: 6420 },
      { appid: 12240, name: 'Region Locked Game', playtime_forever: 120 },
      { appid: 91310, name: 'No Franchise At All', playtime_forever: 0 },
    ]);
    // Existing document from the legacy resolver: a string QID + a Moby id.
    fs.mkdirSync(franchise.LINKS_DIR, { recursive: true });
    fs.writeFileSync(
      franchise.linksPath(292030),
      JSON.stringify({ schemaVersion: 1, appid: 292030, wikidata: 'Q999999', mobyId: 123 })
    );

    const queries = [];
    const report = await franchise.enrichFranchises({
      profileKey,
      fetchImpl: async (url, init) => {
        queries.push(init.body);
        return jsonResponse(fixture);
      },
      stateStore: memoryStore(),
      pauseMs: 0,
    });

    assert.equal(report.updated, 3);
    assert.equal(report.wdQueries, 1, 'one batch for the whole library');
    assert.equal(report.wdAnswered, 7);
    assert.equal(report.releaseYearsFilled, 2);
    assert.equal(queries.length, 1);

    const witcher = links(292030);
    assert.equal(witcher.wikidata.qid, 'Q4267401');
    assert.equal(witcher.wikidata.franchise.qid, 'Q1060747');
    assert.equal(witcher.wikidata.franchise.labelRu, 'Ведьмак');
    assert.equal(witcher.wikidata.releaseYear, 2015);
    assert.equal(witcher.franchiseKey, 'wd:Q1060747');
    assert.deepEqual(witcher.sources, ['wikidata']);
    assert.equal(witcher.mobyId, 123, 'Moby id survives the franchise refresh');

    const locked = links(12240);
    assert.equal(locked.wikidata.qid, 'Q1318551');
    assert.equal(locked.wikidata.franchise, null);
    assert.equal(locked.wikidata.releaseYear, 2010);
    assert.equal(locked.franchiseKey, null);

    const bare = links(91310);
    assert.equal(bare.wikidata.qid, 'Q3000562');
    assert.equal(bare.wikidata.resolved, true);

    const state = franchise.readFranchiseState();
    assert.ok(state.profiles[profileKey]);
    assert.equal(state.profiles[profileKey].updated, 3);
    assert.equal(state.runs.length, 1);
  });

  test('resume: a fresh links document is skipped, force re-asks', async () => {
    clearLinks([292030]);
    const userKey = '76561198000002002';
    const profileKey = await seed(userKey, [
      { appid: 292030, name: 'The Witcher 3: Wild Hunt', playtime_forever: 100 },
    ]);
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return jsonResponse(fixture);
    };

    const first = await franchise.enrichFranchises({
      profileKey,
      fetchImpl,
      stateStore: memoryStore(),
      pauseMs: 0,
    });
    assert.equal(first.updated, 1);
    assert.equal(calls, 1);

    const second = await franchise.enrichFranchises({
      profileKey,
      fetchImpl,
      stateStore: memoryStore(),
      pauseMs: 0,
    });
    assert.equal(second.candidates, 0);
    assert.equal(second.skippedFresh, 1);
    assert.equal(second.skipped, 'nothing_to_ask');
    assert.equal(calls, 1, 'the 90-day cache answered, no WDQS request');

    const forced = await franchise.enrichFranchises({
      profileKey,
      force: true,
      fetchImpl,
      stateStore: memoryStore(),
      pauseMs: 0,
    });
    assert.equal(forced.updated, 1);
    assert.equal(calls, 2);
  });

  test('kill switch KINOBOXD_GAMES_WD=off writes nothing and asks nothing', async () => {
    clearLinks([292030]);
    const userKey = '76561198000002003';
    const profileKey = await seed(userKey, [
      { appid: 292030, name: 'The Witcher 3: Wild Hunt', playtime_forever: 100 },
    ]);
    process.env.KINOBOXD_GAMES_WD = 'off';
    try {
      let calls = 0;
      const report = await franchise.enrichFranchises({
        profileKey,
        fetchImpl: async () => {
          calls++;
          return jsonResponse(fixture);
        },
        stateStore: memoryStore(),
        pauseMs: 0,
      });
      assert.equal(calls, 0);
      assert.equal(report.wdSkipped, 'disabled_by_env');
      assert.equal(report.updated, 0);
      assert.equal(links(292030), null);
    } finally {
      delete process.env.KINOBOXD_GAMES_WD;
    }
  });

  test('a failing WDQS answer is not cached as «no franchise»', async () => {
    clearLinks([292030]);
    const userKey = '76561198000002004';
    const profileKey = await seed(userKey, [
      { appid: 292030, name: 'The Witcher 3: Wild Hunt', playtime_forever: 100 },
    ]);
    const report = await franchise.enrichFranchises({
      profileKey,
      fetchImpl: async () => jsonResponse({}, 429, { 'retry-after': '120' }),
      stateStore: memoryStore(),
      pauseMs: 0,
      minOutageGapMs: 0,
    });
    assert.ok(report.errors.length >= 1);
    assert.equal(report.updated, 0);
    assert.equal(links(292030), null, 'a 429 is deferred, never a negative cache');
  });

  test('writeLinksDoc keeps a legacy string QID when Wikidata answers nothing', () => {
    fs.mkdirSync(franchise.LINKS_DIR, { recursive: true });
    fs.writeFileSync(
      franchise.linksPath(555),
      JSON.stringify({ appid: 555, wikidata: 'Q42', igdb: 777 })
    );
    const doc = franchise.writeLinksDoc(555, {
      franchiseKey: null,
      sources: ['wikidata'],
      wikidata: { qid: null, franchise: null, releaseYear: null, resolved: true },
      fetchedAt: '2026-11-01T00:00:00.000Z',
    });
    assert.equal(doc.wikidata.qid, 'Q42');
    assert.equal(doc.igdb, 777);
    assert.equal(doc.franchiseKey, null);
  });
  after(() => env.resetMutableState());
});


describe('games-personnel-aggregate', () => {
  /**
   * Personnel aggregation (M3, ИГРЫ §5.3/§7): studios first, weights, QID dedup,
   * aliases, ambiguity, coverage, overrides, per-game block, enrichment.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const CACHE_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;
  process.env.KINOBOXD_MOBY_KEY_FILE = path.join(
    process.env.KINOBOXD_STATE_DIR,
    'no-moby-token'
  );

  const gameCache = require('../server/games/game-cache');
  const personnel = require('../server/games/personnel/personnel');

  const ID = '76561198000000002';
  const PROFILE = `steam-${ID}`;

  const DETAILS_DIR = path.join(CACHE_DIR, 'details');
  const LINKS_DIR = path.join(CACHE_DIR, 'links');

  function writeDetails(appid, doc) {
    fs.mkdirSync(DETAILS_DIR, { recursive: true });
    fs.writeFileSync(path.join(DETAILS_DIR, `${appid}.json`), JSON.stringify(doc));
  }

  function writeLinks(appid, doc) {
    fs.mkdirSync(LINKS_DIR, { recursive: true });
    fs.writeFileSync(path.join(LINKS_DIR, `${appid}.json`), JSON.stringify(doc));
  }

  function credit(name, roles, extra = {}) {
    return {
      name,
      nameEn: /[a-z]/i.test(name) ? name : null,
      nameRu: /[\u0400-\u04ff]/.test(name) ? name : null,
      qid: null,
      mobyId: null,
      roles,
      roleSource: 'wikidata',
      source: 'wikidata',
      confidence: 'high',
      ...extra,
    };
  }

  async function seed() {
    const now = new Date().toISOString();
    await gameCache.saveProfile({
      userKey: ID,
      personaName: 'tester',
      privacy: 'public',
      importedAt: now,
      fetchedAt: now,
    });
    await gameCache.saveLibrary(ID, {
      fetchedAt: now,
      partial: false,
      game_count: 5,
      totalMinutes: 8520,
      games: [
        { appid: 292030, name: 'The Witcher 3: Wild Hunt', playtime_forever: 6420 },
        { appid: 111001, name: 'Pathologic', playtime_forever: 1200 },
        { appid: 620, name: 'Portal 2', playtime_forever: 300 },
        { appid: 400, name: 'Portal', playtime_forever: 0 },
        { appid: 999, name: 'No Details Yet', playtime_forever: 600 },
      ],
    });
    writeDetails(292030, {
      success: true,
      type: 'game',
      name: 'The Witcher 3: Wild Hunt',
      developers: ['CD PROJEKT RED'],
      publishers: ['CD PROJEKT RED'],
      releaseYear: 2015,
    });
    writeDetails(111001, {
      success: true,
      type: 'game',
      name: 'Pathologic',
      developers: ['Ice-Pick Lodge'],
      publishers: ['Buka Entertainment'],
      releaseYear: 2005,
    });
    writeDetails(620, {
      success: true,
      type: 'game',
      name: 'Portal 2',
      developers: ['Valve'],
      publishers: ['Valve'],
    });
    writeDetails(400, {
      success: true,
      type: 'game',
      name: 'Portal',
      developers: ['Valve'],
      publishers: ['Valve'],
    });

    await gameCache.saveAchievements(ID, 292030, {
      totalCount: 60,
      unlockedCount: 30,
      fetchedAt: now,
    });
    await gameCache.saveAchievements(ID, 111001, {
      totalCount: 40,
      unlockedCount: 10,
      fetchedAt: now,
    });

    await personnel.savePersonnelDoc(292030, {
      fetchedAt: now,
      qid: 'Q4267401',
      sources: ['steam-store', 'wikidata'],
      studios: [
        credit('CD Projekt RED', ['developer', 'publisher'], { qid: 'Q1172164' }),
        credit('Namco', ['publisher'], { qid: 'Q309996' }),
      ],
      people: [
        credit('Marcin Przybyłowicz', ['composer'], {
          qid: 'Q19005369',
          nameRu: 'Марцин Пшибылович',
        }),
        credit('Mikolai Stroinski', ['composer'], { qid: 'Q19005837' }),
      ],
    });
    await personnel.savePersonnelDoc(111001, {
      fetchedAt: now,
      qid: 'Q2429644',
      sources: ['steam-store', 'wikidata'],
      studios: [credit('Ice-Pick Lodge', ['developer'], { qid: 'Q2248318' })],
      people: [
        credit('Andriesh Gandrabur', ['composer'], { qid: 'Q63537346' }),
        credit('Sanan Ushanov', ['designer'], { qid: 'Q63537392' }),
        credit('Nikolai Dybowskiy', ['director'], { qid: 'Q125589574' }),
      ],
    });
    await personnel.savePersonnelDoc(620, {
      fetchedAt: now,
      qid: 'Q279446',
      sources: ['steam-store', 'wikidata'],
      studios: [credit('Valve', ['developer', 'publisher'], { qid: 'Q193559' })],
      people: [
        credit('Mike Morasky', ['composer'], { qid: 'Q6848400' }),
        credit('John Smith', ['composer'], { qid: 'Q1001' }),
        credit('Alex Doe', ['designer']),
      ],
    });
    await personnel.savePersonnelDoc(400, {
      fetchedAt: now,
      qid: 'Q274897',
      sources: ['steam-store', 'wikidata'],
      studios: [credit('Valve', ['developer', 'publisher'], { qid: 'Q193559' })],
      people: [
        credit('Marcin Przybyłowicz', ['composer'], {
          qid: 'Q19005369',
          nameRu: 'Марцин Пшибылович',
        }),
        credit('John Smith', ['composer'], { qid: 'Q1002' }),
        credit('Alexander Doe', ['designer']),
      ],
    });
  }

  function byName(items, name) {
    return items.find((item) => item.name === name);
  }

  test('studios first: developer/publisher roles, hours weights, QID bridge to Steam', async () => {
    await seed();
    const payload = personnel.buildPersonnel(PROFILE, { role: 'developer' });
    assert.ok(payload);
    assert.equal(payload.role, 'developer');
    assert.equal(payload.roleRequested, 'developer');
    assert.equal(payload.roleAlias, null);
    assert.equal(payload.sort, 'hours');
    assert.equal(payload.roles.default, 'developer');
    assert.deepEqual(payload.roles.studio, ['developer', 'publisher']);

    // Every studio item carries at least one studio role; people never leak in.
    for (const item of payload.items) {
      assert.ok(item.roles.includes('developer') || item.roles.includes('publisher'));
    }

    const cdpr = byName(payload.items, 'CD PROJEKT RED');
    assert.ok(cdpr, 'Steam spelling wins as the display name');
    assert.equal(cdpr.qid, 'Q1172164');
    assert.deepEqual(cdpr.roles.sort(), ['developer', 'publisher']);
    assert.equal(cdpr.count, 1);
    assert.equal(cdpr.hours, 107);
    assert.equal(cdpr.avgCompletion, 50);
    assert.deepEqual(cdpr.sources, ['steam-store', 'wikidata']);
    assert.equal(cdpr.id, 'wd:Q1172164');
    assert.deepEqual(cdpr.games, [{ appid: 292030, name: 'The Witcher 3: Wild Hunt', hours: 107 }]);

    const icePick = byName(payload.items, 'Ice-Pick Lodge');
    assert.equal(icePick.hours, 20);
    assert.equal(icePick.avgCompletion, 25);

    const valve = byName(payload.items, 'Valve');
    assert.equal(valve.count, 2, 'Valve appears in two library games');
    assert.equal(valve.hours, 5);
    assert.equal(valve.qid, 'Q193559');

    // Sorted by hours: CDPR (107) > Ice-Pick (20) > Namco/Buka (107?) — Namco is
    // also on W3, so it shares 107 and sorts by count/name.
    assert.equal(payload.items[0].hours, 107);
    assert.equal(payload.totals.games, 5);
    assert.equal(payload.totals.hours, 142);

    // hoursShare is the share of the profile's considered hours.
    assert.equal(cdpr.hoursShare, Math.round((107 / 142) * 10000) / 10000);
  });

  test('role filter: publisher only, composer weights and completion', async () => {
    const developers = personnel.buildPersonnel(PROFILE, { role: 'developer' });
    for (const item of developers.items) {
      assert.ok(item.roles.includes('developer'), `${item.name} must be a developer`);
    }
    assert.ok(byName(developers.items, 'CD PROJEKT RED'));
    assert.ok(byName(developers.items, 'Ice-Pick Lodge'));
    assert.ok(byName(developers.items, 'Valve'));
    // Publisher-only studios do not leak into the developer answer.
    assert.equal(byName(developers.items, 'Namco'), undefined);
    assert.equal(byName(developers.items, 'Buka Entertainment'), undefined);

    const publishers = personnel.buildPersonnel(PROFILE, { role: 'publisher' });
    for (const item of publishers.items) {
      assert.ok(item.roles.includes('publisher'), `${item.name} must be a publisher`);
    }
    assert.ok(byName(publishers.items, 'CD PROJEKT RED'));
    assert.ok(byName(publishers.items, 'Namco'));
    assert.equal(byName(publishers.items, 'Ice-Pick Lodge'), undefined);

    const composers = personnel.buildPersonnel(PROFILE, { role: 'composer' });
    for (const item of composers.items) assert.ok(item.roles.includes('composer'));
    assert.equal(byName(composers.items, 'CD PROJEKT RED'), undefined);

    const marcin = byName(composers.items, 'Marcin Przybyłowicz');
    assert.equal(marcin.count, 2, 'same QID on two games is one person');
    assert.equal(marcin.hours, 107);
    assert.equal(marcin.avgCompletion, 50, 'completion only over games that have achievements');
    assert.deepEqual(marcin.sources, ['wikidata']);
    assert.ok(marcin.aliases.includes('Марцин Пшибылович'));

    assert.equal(composers.items[0].name, 'Marcin Przybyłowicz', 'sorted by hours');
    const andriesh = byName(composers.items, 'Andriesh Gandrabur');
    assert.equal(andriesh.hours, 20);

    // `avgCompletion` is null (not 0) when no game of that person has achievements.
    const mike = byName(composers.items, 'Mike Morasky');
    assert.equal(mike.avgCompletion, null);
  });

  test('same name, different QIDs: two items, both ambiguous (never merged)', () => {
    const payload = personnel.buildPersonnel(PROFILE, { role: 'composer' });
    const smiths = payload.items.filter((item) => item.name === 'John Smith');
    assert.equal(smiths.length, 2);
    assert.deepEqual(smiths.map((item) => item.qid).sort(), ['Q1001', 'Q1002']);
    for (const smith of smiths) assert.equal(smith.ambiguous, true);
  });

  test('coverage and pending are honest: no details/credits → counters, not zeros', () => {
    const payload = personnel.buildPersonnel(PROFILE);
    assert.equal(payload.role, 'developer', 'developer is the default role');
    assert.equal(payload.coverage.gamesTotal, 5);
    assert.equal(payload.coverage.gamesWithDetails, 4);
    assert.equal(payload.coverage.detailsPercent, 80);
    assert.equal(payload.coverage.gamesWithCredits, 4);
    assert.equal(payload.coverage.percent, 80);
    assert.equal(payload.coverage.byRole.composer, 4);
    assert.equal(payload.coverage.byRole.designer, 3);
    assert.equal(payload.coverage.byRole.director, 1);
    // Studio roles are counted separately from people roles.
    assert.equal(payload.coverage.byStudioRole.developer, 4);
    assert.equal(payload.coverage.byStudioRole.publisher, 4);
    assert.equal(payload.coverage.developerPercent, 80);
    assert.equal(payload.coverage.publisherPercent, 80);
    assert.equal(payload.pending.details, 1);
    assert.equal(payload.pending.credits, 1);
    assert.equal(payload.pending.running, false);
    assert.equal(payload.meta.completionAvailable, true);
    assert.equal(payload.sources.mobygames.enabled, false);
    assert.equal(payload.sources.mobygames.reason, 'key_missing');
    assert.equal(JSON.stringify(payload).includes('moby-token'), false);
  });

  test('unknown role/sort are rejected with a coded error', () => {
    assert.throws(
      () => personnel.buildPersonnel(PROFILE, { role: 'wizard' }),
      (err) => err.code === 'invalid_role' && err.status === 400
    );
    assert.throws(
      () => personnel.buildPersonnel(PROFILE, { sort: 'magic' }),
      (err) => err.code === 'invalid_sort'
    );
  });

  test('overrides: alias, manual display, union-safe save, merge of two name-only people', async () => {
    const overridesPath = path.join(CACHE_DIR, 'personnel-overrides.json');

    const alias = await personnel.applyOverride({
      type: 'person',
      action: 'alias',
      from: 'Марчин Пшибылович',
      to: 'Marcin Przybyłowicz',
    });
    assert.equal(alias.ok, true);
    const withAlias = personnel.buildPersonnel(PROFILE, { role: 'composer' });
    assert.ok(byName(withAlias.items, 'Marcin Przybyłowicz').aliases.includes('Марчин Пшибылович'));

    // A second, unrelated override must not drop the first one (union-safe).
    await personnel.saveOverrides({
      manual: { person: { 'marcin przybyłowicz': { display: 'Marcin P.', aliases: ['MP'] } } },
    });
    await personnel.saveOverrides({ manual: { studio: { namco: { display: 'Namco Bandai' } } } });
    const saved = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
    assert.equal(saved.manual.person['marcin przybyłowicz'].display, 'Marcin P.');
    assert.equal(saved.manual.studio.namco.display, 'Namco Bandai');
    assert.equal(saved.manual.aliases.length, 1);

    const renamed = personnel.buildPersonnel(PROFILE, { role: 'composer' });
    const marcin = renamed.items.find((item) => item.name === 'Marcin P.');
    assert.ok(marcin);
    assert.ok(marcin.aliases.includes('Marcin Przybyłowicz'));
    assert.ok(marcin.aliases.includes('MP'));
    assert.equal(byName(renamed.items, 'Marcin Przybyłowicz'), undefined);

    const studios = personnel.buildPersonnel(PROFILE, { role: 'publisher' });
    assert.ok(byName(studios.items, 'Namco Bandai'));

    // Two spellings without any id: separate by default, one after a merge.
    const before = personnel.buildPersonnel(PROFILE, { role: 'designer' });
    assert.ok(byName(before.items, 'Alex Doe'));
    assert.ok(byName(before.items, 'Alexander Doe'));

    const merged = await personnel.applyOverride({
      type: 'person',
      action: 'merge',
      from: 'Alex Doe',
      to: 'Alexander Doe',
    });
    assert.equal(merged.ok, true);
    const after = personnel.buildPersonnel(PROFILE, { role: 'designer' });
    const doe = after.items.filter((item) => /Doe$/.test(item.name));
    assert.equal(doe.length, 1);
    assert.equal(doe[0].count, 2);
    assert.ok(['Alex Doe', 'Alexander Doe'].includes(doe[0].name));
    assert.ok(
      doe[0].aliases.includes(doe[0].name === 'Alex Doe' ? 'Alexander Doe' : 'Alex Doe'),
      'the other spelling stays as an alias'
    );
  });

  test('applyOverride validates type/action/from/to', async () => {
    await assert.rejects(
      () => personnel.applyOverride({ type: 'wizard', action: 'merge', from: 'a', to: 'b' }),
      (err) => err.code === 'invalid_override_type'
    );
    await assert.rejects(
      () => personnel.applyOverride({ type: 'person', action: 'magic', from: 'a', to: 'b' }),
      (err) => err.code === 'invalid_override_action'
    );
    await assert.rejects(
      () => personnel.applyOverride({ type: 'person', action: 'merge', from: 'a' }),
      (err) => err.code === 'invalid_override_to'
    );
    await assert.rejects(
      () => personnel.applyOverride({ type: 'person', action: 'merge', to: 'b' }),
      (err) => err.code === 'invalid_override_from'
    );
  });

  test('per-game block for the game card (§5.2)', () => {
    // Earlier tests wrote overrides into the shared cache; this test checks the
    // base contract, so the file is removed first.
    fs.rmSync(path.join(CACHE_DIR, 'personnel-overrides.json'), { force: true });
    const block = personnel.personnelForGame(292030);
    assert.ok(block.studios.some((studio) => studio.name === 'CD PROJEKT RED'));
    const marcin = block.people.find((person) => person.name === 'Marcin Przybyłowicz');
    assert.ok(marcin);
    assert.equal(marcin.roleSource, 'wikidata');
    assert.deepEqual(marcin.roles, ['composer']);

    const pending = personnel.personnelForGame(999);
    assert.deepEqual(pending.pending, ['details', 'credits']);
    assert.equal(pending.people.length, 0);
  });

  test('enrichPersonnel: WD by appid, studios from details, 90-day negative cache', async () => {
    const now = new Date().toISOString();
    await gameCache.saveLibrary(ID, {
      fetchedAt: now,
      partial: false,
      game_count: 2,
      games: [
        { appid: 5001, name: 'Enriched Game', playtime_forever: 600 },
        { appid: 5002, name: 'Unknown Credits', playtime_forever: 0 },
      ],
    });
    writeDetails(5001, { success: true, type: 'game', developers: ['Some Studio'] });
    writeDetails(5002, { success: true, type: 'game', developers: ['Other Studio'] });

    const calls = { appids: 0, qids: 0 };
    const wdMock = {
      wikidataEnabled: () => true,
      creditsForAppids: async (appids) => {
        calls.appids++;
        assert.deepEqual(appids.sort(), [5001, 5002]);
        return {
          credits: new Map([
            [
              '5001',
              {
                qid: 'Q999001',
                appid: 5001,
                studios: [credit('Some Studio', ['developer'], { qid: 'Q888001' })],
                people: [credit('Jane Composer', ['composer'], { qid: 'Q777001' })],
              },
            ],
          ]),
          queries: 1,
          batches: 1,
          errors: [],
          disabledUntil: null,
        };
      },
      fetchCredits: async (qids) => {
        calls.qids++;
        return { credits: new Map(), queries: 1, batches: 1, errors: [], disabledUntil: null };
      },
    };
    const mobyMock = {
      isEnabled: () => false,
      status: () => ({ enabled: false, reason: 'key_missing' }),
      fetchGameCredits: async () => {
        throw new Error('moby must not be called without a key');
      },
    };

    const report = await personnel.enrichPersonnel({
      profileKey: PROFILE,
      wikidata: wdMock,
      moby: mobyMock,
    });
    assert.equal(calls.appids, 1);
    assert.equal(calls.qids, 0);
    assert.equal(report.updated, 2);
    assert.equal(report.mobyRequests, 0);

    const doc = personnel.readPersonnelDoc(5001);
    assert.equal(doc.qid, 'Q999001');
    assert.deepEqual(doc.sources, ['steam-store', 'wikidata']);
    assert.deepEqual(
      doc.people.map((person) => person.name),
      ['Jane Composer']
    );
    assert.deepEqual(
      doc.studios.map((studio) => studio.name).sort(),
      ['Some Studio']
    );
    assert.equal(doc.coverage.people, 1);

    const negative = personnel.readPersonnelDoc(5002);
    assert.equal(negative.people.length, 0);
    assert.ok(negative.sources.includes('wikidata'));

    // Second run: both documents are fresh and cover the available sources.
    const second = await personnel.enrichPersonnel({
      profileKey: PROFILE,
      wikidata: wdMock,
      moby: mobyMock,
    });
    assert.equal(second.updated, 0);
    assert.equal(second.skippedFresh, 2);
    assert.equal(calls.appids, 1, 'no second WDQS pass');
  });

  test('enrichPersonnel uses links/<appid>.json QID when present', async () => {
    writeLinks(5001, { wikidata: 'Q123456', moby: 4242, mobyPlatformId: 5 });
    let appidCalls = 0;
    let qidCalls = 0;
    const wdMock = {
      wikidataEnabled: () => true,
      creditsForAppids: async () => {
        appidCalls++;
        return { credits: new Map(), queries: 0, batches: 0, errors: [], disabledUntil: null };
      },
      fetchCredits: async (qids) => {
        qidCalls++;
        assert.deepEqual(qids, ['Q123456']);
        return {
          credits: new Map([
            [
              'Q123456',
              {
                qid: 'Q123456',
                appid: null,
                studios: [],
                people: [credit('Linked Person', ['writer'], { qid: 'Q555001' })],
              },
            ],
          ]),
          queries: 1,
          batches: 1,
          errors: [],
          disabledUntil: null,
        };
      },
    };
    const report = await personnel.enrichPersonnel({
      profileKey: PROFILE,
      wikidata: wdMock,
      moby: { isEnabled: () => false, fetchGameCredits: async () => ({}) },
      force: true,
    });
    assert.equal(appidCalls, 1, '5002 has no QID and is asked by appid');
    assert.equal(qidCalls, 1);
    assert.ok(report.updated >= 1);
    const doc = personnel.readPersonnelDoc(5001);
    assert.deepEqual(
      doc.people.map((person) => person.name),
      ['Linked Person']
    );
    assert.deepEqual(doc.sources, ['steam-store', 'wikidata']);
  });

  test('enrichPersonnel keeps cached WD credits when WDQS is in cooldown', async () => {
    // 5001 already has a Wikidata credit from the previous test.
    const before = personnel.readPersonnelDoc(5001);
    assert.ok(before.people.length >= 1);

    const wdSkipped = {
      wikidataEnabled: () => true,
      creditsForAppids: async () => ({
        credits: new Map(),
        queries: 0,
        batches: 1,
        errors: ['wikidata_429'],
        skipped: 'wikidata_disabled',
        disabledUntil: new Date(Date.now() + 1800000).toISOString(),
      }),
      fetchCredits: async () => ({
        credits: new Map(),
        queries: 0,
        batches: 1,
        errors: [],
        skipped: 'wikidata_disabled',
        disabledUntil: null,
      }),
    };
    const report = await personnel.enrichPersonnel({
      profileKey: PROFILE,
      wikidata: wdSkipped,
      moby: { isEnabled: () => false, fetchGameCredits: async () => ({}) },
      force: true,
    });
    assert.equal(report.wdSkipped, 'wikidata_disabled');
    const after = personnel.readPersonnelDoc(5001);
    assert.deepEqual(
      after.people.map((person) => person.name),
      before.people.map((person) => person.name),
      'a cooldown run must not wipe cached credits'
    );
    assert.deepEqual(after.sources, ['steam-store', 'wikidata']);
  });

  test('details studios: strings and object entries are both accepted', () => {
    const list = personnel.studiosFromDetails({
      developers: [{ name: 'Object Studio' }],
      publishers: 'Plain Publisher',
    });
    assert.deepEqual(
      list.map((studio) => `${studio.name}:${studio.roles[0]}`).sort(),
      ['Object Studio:developer', 'Plain Publisher:publisher']
    );
    assert.deepEqual(personnel.studiosFromDetails(null), []);
  });

  test('a WD outage is not an answer: the 90-day cache is not poisoned', async () => {
    // Regression for the production symptom «данные так и не приехали»: a
    // transient WDQS timeout used to be recorded as `wdAsked`, the document got
    // a fresh `fetchedAt` and the negative cache hid the credits for 90 days.
    const now = new Date().toISOString();
    await gameCache.saveLibrary(ID, {
      fetchedAt: now,
      partial: false,
      game_count: 1,
      games: [{ appid: 6001, name: 'Outage Game', playtime_forever: 600 }],
    });
    writeDetails(6001, { success: true, type: 'game', developers: ['Outage Studio'] });

    const mobyOff = { isEnabled: () => false, fetchGameCredits: async () => ({}) };
    const wdDown = {
      wikidataEnabled: () => true,
      creditsForAppids: async () => ({
        credits: new Map(),
        queries: 1,
        batches: 1,
        errors: ['23'],
        disabledUntil: null,
      }),
      fetchCredits: async () => ({ credits: new Map(), queries: 0, batches: 0, errors: [] }),
    };
    const first = await personnel.enrichPersonnel({ profileKey: PROFILE, wikidata: wdDown, moby: mobyOff });
    assert.equal(first.wdDeferred, 1, 'nothing was written: no answer, no cache');
    assert.equal(first.updated, 0);
    assert.equal(personnel.readPersonnelDoc(6001), null);

    const wdUp = {
      wikidataEnabled: () => true,
      creditsForAppids: async (appids) => ({
        credits: new Map(
          appids.map((appid) => [
            String(appid),
            {
              qid: 'Q600100',
              appid,
              studios: [credit('Outage Studio', ['developer'], { qid: 'Q600200' })],
              people: [credit('Late Composer', ['composer'], { qid: 'Q600300' })],
            },
          ])
        ),
        queries: 1,
        batches: 1,
        errors: [],
        disabledUntil: null,
      }),
      fetchCredits: async () => ({ credits: new Map(), queries: 0, batches: 0, errors: [] }),
    };
    const second = await personnel.enrichPersonnel({ profileKey: PROFILE, wikidata: wdUp, moby: mobyOff });
    assert.equal(second.skippedFresh, 0, 'the failed run must not look fresh');
    assert.equal(second.updated, 1);
    assert.equal(second.wdAnswered, 1);
    const doc = personnel.readPersonnelDoc(6001);
    assert.equal(doc.wdAsked, true);
    assert.deepEqual(doc.people.map((person) => person.name), ['Late Composer']);
    assert.deepEqual(doc.sources, ['steam-store', 'wikidata']);

    const third = await personnel.enrichPersonnel({ profileKey: PROFILE, wikidata: wdUp, moby: mobyOff });
    assert.equal(third.skippedFresh, 1, 'a real answer is cached for 90 days');
    assert.equal(third.updated, 0);
  });
  after(() => env.resetMutableState());
});


describe('games-personnel-identity', () => {
  /**
   * Studio identity across sources (ИГРЫ §4.2/§7.4, round 01.11.2026).
   *
   * Reported bug («Персоналии», role=developer, top-3):
   *
   *     wd:Q3539040 «Development Studio»      2 игры / 1054.4 ч
   *     «Paradox Development Studio»          2 игры / 1054.4 ч
   *
   * One company, two cards. Two independent causes:
   *
   *   1. The Wikidata item Q3539040 is *Paradox Development Studio*, but its
   *      English `rdfs:label` is the truncated «Development Studio» (`mul`/ja/it
   *      say «Paradox Development Studio»). The credit was stored under the
   *      fragment, so the normalized-name unification with Steam's
   *      `developers[]` string could not fire. Fixed in the provider
   *      (`wikidata.canonicalLabel`), plus `labelRule` in the document so a
   *      cache written by the old rule is re-fetched once instead of keeping the
   *      fragment for its 90-day TTL.
   *   2. Steam and Wikidata also disagree on the legal form — «Valve
   *      Corporation» vs «Valve», «FromSoftware, Inc.» vs «FromSoftware» — which
   *      produced seven more duplicates of the same class. The legal form is not
   *      part of the name (§4.2 keeps «Studio»/«Games»/«Interactive»), so it is
   *      stripped for the *identity* comparison only; the display name stays the
   *      Steam spelling.
   *
   * Never merged: two different QIDs (§4.3), and a core-name match with no QID at
   * all (no fuzzy matching without a strong id, §4.2).
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const CACHE_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;
  process.env.KINOBOXD_MOBY_KEY_FILE = path.join(
    process.env.KINOBOXD_STATE_DIR,
    'no-moby-token'
  );

  const gameCache = require('../server/games/game-cache');
  const personnel = require('../server/games/personnel/personnel');

  const DETAILS_DIR = path.join(CACHE_DIR, 'details');

  function writeDetails(appid, doc) {
    fs.mkdirSync(DETAILS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DETAILS_DIR, `${appid}.json`),
      JSON.stringify({ success: true, type: 'game', ...doc })
    );
  }

  function studio(name, roles, extra = {}) {
    return {
      name,
      nameEn: /[a-z]/i.test(name) ? name : null,
      nameRu: null,
      qid: null,
      mobyId: null,
      roles,
      roleSource: 'wikidata',
      source: 'wikidata',
      confidence: 'high',
      ...extra,
    };
  }

  async function seedProfile(userKey, games) {
    const now = new Date().toISOString();
    await gameCache.saveProfile({
      userKey,
      personaName: `player-${userKey.slice(-3)}`,
      privacy: 'public',
      importedAt: now,
      fetchedAt: now,
    });
    await gameCache.saveLibrary(userKey, {
      fetchedAt: now,
      partial: false,
      game_count: games.length,
      games: games.map((game) => ({
        appid: game.appid,
        name: game.name,
        playtime_forever: Math.round(game.hours * 60),
      })),
    });
    for (const game of games) {
      writeDetails(game.appid, {
        name: game.name,
        developers: game.developers || [],
        publishers: game.publishers || [],
      });
      if (game.studios || game.people) {
        await personnel.savePersonnelDoc(game.appid, {
          fetchedAt: now,
          qid: game.qid || null,
          sources: ['steam-store', 'wikidata'],
          studios: game.studios || [],
          people: game.people || [],
        });
      }
    }
    return `steam-${userKey}`;
  }

  test('the reported duplicate: one Paradox Development Studio card with the QID', async () => {
    const profile = await seedProfile('76561198000002001', [
      {
        appid: 203770,
        name: 'Crusader Kings II',
        hours: 1054.4,
        developers: ['Paradox Development Studio'],
        publishers: ['Paradox Interactive'],
        studios: [
          // What the fixed provider writes: the `mul` label, not the truncated
          // English «Development Studio».
          studio('Paradox Development Studio', ['developer'], { qid: 'Q3539040' }),
          studio('Paradox Interactive', ['publisher'], { qid: 'Q217493' }),
        ],
      },
      {
        appid: 1158310,
        name: 'Crusader Kings III',
        hours: 0,
        developers: ['Paradox Development Studio'],
        publishers: ['Paradox Interactive'],
        studios: [
          studio('Paradox Development Studio', ['developer'], { qid: 'Q3539040' }),
          studio('Paradox Interactive', ['publisher'], { qid: 'Q217493' }),
        ],
      },
    ]);

    const payload = personnel.buildPersonnel(profile, { role: 'developer', sort: 'hours' });
    const paradox = payload.items.filter((item) => /paradox/i.test(item.name));
    assert.equal(paradox.length, 1, 'one company, one card — the duplicate is gone');
    const item = paradox[0];
    assert.equal(item.id, 'wd:Q3539040');
    assert.equal(item.name, 'Paradox Development Studio', 'the Steam spelling is the display name');
    assert.equal(item.qid, 'Q3539040');
    assert.equal(item.count, 2);
    assert.equal(item.hours, 1054.4);
    assert.deepEqual(item.sources, ['steam-store', 'wikidata']);
    assert.deepEqual(item.roles, ['developer']);
    assert.equal(item.ambiguous, false);
    assert.deepEqual(item.games, [
      { appid: 203770, name: 'Crusader Kings II', hours: 1054.4 },
      { appid: 1158310, name: 'Crusader Kings III', hours: 0 },
    ]);

    // The publisher answer is untouched: Paradox Interactive is a different
    // company (Q217493) and keeps its own card.
    const publishers = personnel.buildPersonnel(profile, { role: 'publisher', sort: 'hours' });
    assert.deepEqual(
      publishers.items.map((entry) => [entry.name, entry.qid]),
      [['Paradox Interactive', 'Q217493']]
    );
  });

  test('the truncation is what split the card: the old name still yields two items', async () => {
    // Characterization of the bug itself (the label rule is pinned in
    // games-personnel-wikidata.test.js): unification is by normalized name, so a
    // document that still carries «Development Studio» cannot join Steam's
    // «Paradox Development Studio». That is why stale documents are re-fetched.
    const profile = await seedProfile('76561198000002002', [
      {
        appid: 203770,
        name: 'Crusader Kings II',
        hours: 10,
        developers: ['Paradox Development Studio'],
        studios: [studio('Development Studio', ['developer'], { qid: 'Q3539040' })],
      },
    ]);
    const payload = personnel.buildPersonnel(profile, { role: 'developer' });
    assert.equal(payload.items.length, 2);
    assert.deepEqual(payload.items.map((item) => item.qid).sort(), [null, 'Q3539040'].sort());
  });

  test('legal form is not part of the name: «Valve Corporation» joins Q193559 «Valve»', async () => {
    const profile = await seedProfile('76561198000002003', [
      {
        appid: 620,
        name: 'Portal 2',
        hours: 20,
        developers: ['Valve Corporation'],
        publishers: ['Valve Corporation'],
        studios: [studio('Valve', ['developer', 'publisher'], { qid: 'Q193559' })],
      },
    ]);
    const payload = personnel.buildPersonnel(profile, { role: 'developer' });
    assert.equal(payload.items.length, 1);
    const item = payload.items[0];
    assert.equal(item.name, 'Valve Corporation', 'Steam spelling wins the display');
    assert.equal(item.qid, 'Q193559');
    assert.equal(item.id, 'wd:Q193559');
    assert.deepEqual(item.aliases, ['Valve'], 'the Wikidata spelling stays reachable');
    assert.deepEqual(item.sources, ['steam-store', 'wikidata']);
  });

  test('two different QIDs are never merged, even with the same core name', async () => {
    const profile = await seedProfile('76561198000002004', [
      {
        appid: 620,
        name: 'Portal 2',
        hours: 20,
        developers: ['Valve'],
        studios: [studio('Valve', ['developer'], { qid: 'Q193559' })],
      },
      {
        appid: 621,
        name: 'Portal Stories',
        hours: 1,
        developers: ['Valve Corporation'],
        studios: [studio('Valve Corporation', ['developer'], { qid: 'Q999999' })],
      },
    ]);
    const payload = personnel.buildPersonnel(profile, { role: 'developer' });
    assert.equal(payload.items.length, 2, '§4.3: never merge two QIDs');
    assert.deepEqual(payload.items.map((item) => item.qid).sort(), ['Q193559', 'Q999999']);
  });

  test('a core-name match with no strong id is left alone (no fuzzy merge)', async () => {
    const profile = await seedProfile('76561198000002005', [
      { appid: 1, name: 'Game A', hours: 1, developers: ['Foo Games'] },
      { appid: 2, name: 'Game B', hours: 1, developers: ['Foo Games, Inc.'] },
    ]);
    const payload = personnel.buildPersonnel(profile, { role: 'developer' });
    assert.equal(payload.items.length, 2, '§4.2: exact slug only when there is no QID');
  });

  test('enrichment dedupe inside one game uses the same identity rules', () => {
    const merged = personnel.dedupeStudios([
      studio('Valve Corporation', ['developer'], { source: 'steam-store', roleSource: 'steam-store' }),
      studio('Valve', ['developer', 'publisher'], { qid: 'Q193559' }),
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].qid, 'Q193559');
    assert.deepEqual(merged[0].roles.sort(), ['developer', 'publisher']);
    assert.deepEqual(merged[0].sources, ['steam-store', 'wikidata']);
  });

  test('stale labels: an old-rule document is counted and re-fetched once', async () => {
    const userKey = '76561198000002006';
    const profile = await seedProfile(userKey, [
      {
        appid: 203770,
        name: 'Crusader Kings II',
        hours: 10,
        developers: ['Paradox Development Studio'],
        studios: [studio('Development Studio', ['developer'], { qid: 'Q3539040' })],
        // People credits complete, so `pending.credits` is 0 and the only
        // reason left for a pass is the stale label rule.
        people: [studio('Andreas Waldetoft', ['composer'], { qid: 'Q1000101' })],
      },
    ]);
    // Rewrite the document the way the pre-fix code left it: Wikidata answered,
    // no label rule recorded.
    const docPath = path.join(CACHE_DIR, 'personnel', '203770.json');
    const old = JSON.parse(fs.readFileSync(docPath, 'utf8'));
    delete old.labelRule;
    old.wdAsked = true;
    fs.writeFileSync(docPath, JSON.stringify(old));

    const before = personnel.buildPersonnel(profile, { role: 'developer' });
    assert.equal(before.pending.staleLabels, 1);
    assert.equal(before.pending.reason, 'labels_stale');
    assert.equal(before.items.length, 2, 'the truncated name is still cached');

    const wd = {
      wikidataEnabled: () => true,
      defaultStateStore: () => ({
        read: () => ({ schemaVersion: 1, failures: 0, lastSuccessAt: new Date().toISOString() }),
        write: () => {},
      }),
      async creditsForAppids(appids) {
        const credits = new Map();
        for (const raw of appids) {
          const appid = Number(raw);
          credits.set(String(appid), {
            qid: 'Q677869',
            appid,
            studios: [studio('Paradox Development Studio', ['developer'], { qid: 'Q3539040' })],
            people: [],
          });
        }
        return { credits, queries: 1, batches: 1, errors: [], disabledUntil: null };
      },
      async fetchCredits() {
        return { credits: new Map(), queries: 1, batches: 1, errors: [], disabledUntil: null };
      },
    };
    const moby = {
      isEnabled: () => false,
      status: () => ({ enabled: false, configured: false, source: null, reason: 'key_missing' }),
      fetchGameCredits: async () => {
        throw new Error('moby must not be called without a key');
      },
    };

    const report = await personnel.enrichPersonnel({
      profileKey: profile,
      wikidata: wd,
      moby,
      force: true,
    });
    assert.equal(report.updated, 1);

    const written = JSON.parse(fs.readFileSync(docPath, 'utf8'));
    assert.equal(written.labelRule, personnel.LABEL_RULE_VERSION);
    assert.equal(written.wdAsked, true);

    const after = personnel.buildPersonnel(profile, { role: 'developer' });
    assert.equal(after.pending.staleLabels, 0);
    assert.equal(after.items.length, 1, 'one card after the label repair');
    assert.equal(after.items[0].name, 'Paradox Development Studio');
    assert.equal(after.items[0].qid, 'Q3539040');
  });
  after(() => env.resetMutableState());
});


describe('games-personnel-moby', () => {
  /**
   * MobyGames provider (M3): graceful no-key mode, role mapping, budget,
   * breaker. Every request is mocked; no key exists in this round (ИГРЫ §2.4).
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;
  // The main tree may carry a dev fallback; point it away so the no-key test is
  // deterministic. The key value itself is never asserted or printed.
  process.env.KINOBOXD_MOBY_KEY_FILE = path.join(
    process.env.KINOBOXD_STATE_DIR,
    'no-moby-token'
  );

  const moby = require('../server/games/personnel/moby');
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'games', 'moby-credits.json'), 'utf8')
  );

  function jsonResponse(data, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => data,
    };
  }

  function memoryStore() {
    let state = {};
    return {
      read: () => ({ ...state }),
      write: (next) => {
        state = { ...next };
      },
      snapshot: () => ({ ...state }),
    };
  }

  test('no key: disabled status, no network, key_missing on use', async () => {
    delete process.env.MOBYGAMES_API_KEY;
    delete process.env.MOBY_API_KEY;
    moby.resetMobyKeyCache();

    const info = moby.mobyKeyInfo();
    assert.equal(info.configured, false);
    assert.equal(info.source, null);
    assert.equal(moby.mobyEnabled(), false);

    let calls = 0;
    const client = moby.createClient({
      fetchImpl: async () => {
        calls++;
        return jsonResponse(fixture);
      },
      keyProvider: () => ({ key: null, source: null }),
      breakerStore: memoryStore(),
    });
    const status = client.status();
    assert.equal(status.enabled, false);
    assert.equal(status.reason, 'key_missing');
    assert.equal(status.source, null);

    await assert.rejects(
      () => client.fetchGameCredits({ mobyId: 123, platformId: 5 }),
      (err) => err.code === 'moby_key_missing'
    );
    assert.equal(calls, 0);
  });

  test('with a key: parses credits, maps roles, drops QA, never leaks the key', async () => {
    const secret = 'moby-test-key-not-real';
    process.env.MOBYGAMES_API_KEY = secret;
    moby.resetMobyKeyCache();
    try {
      const headers = [];
      const client = moby.createClient({
        fetchImpl: async (url, init) => {
          headers.push(init.headers);
          assert.match(String(url), /\/v1\/games\/123\/platforms\/5\/credits$/);
          return jsonResponse(fixture);
        },
        breakerStore: memoryStore(),
        pauseMs: 0,
      });
      const status = client.status();
      assert.equal(status.enabled, true);
      assert.equal(status.configured, true);
      assert.equal(status.source, 'MOBYGAMES_API_KEY');
      assert.equal(JSON.stringify(status).includes(secret), false);

      const doc = await client.fetchGameCredits({ mobyId: 123, platformId: 5 });
      assert.equal(doc.source, 'mobygames');
      assert.equal(headers.length, 1);
      assert.equal(headers[0].authorization, `Bearer ${secret}`);
      assert.equal(JSON.stringify(doc).includes(secret), false);

      const byName = new Map(doc.people.map((person) => [person.name, person]));
      assert.deepEqual(byName.get('Marcin Przybyłowicz').roles, ['composer']);
      assert.deepEqual(byName.get('Konrad Tomaszkiewicz').roles, ['designer']);
      assert.deepEqual(byName.get('Marcin Blacha').roles, ['writer']);
      assert.deepEqual(byName.get('Bartłomiej Gaweł').roles, ['artist']);
      assert.deepEqual(byName.get('Grzegorz Mocarski').roles, ['programmer']);
      assert.deepEqual(byName.get('Piotr Twardowski').roles, ['producer']);
      assert.deepEqual(byName.get('Paweł Błaszczak').roles, ['sound']);
      assert.deepEqual(byName.get('Doug Cockle').roles, ['voice']);
      assert.equal(byName.has('QA Person'), false);
      assert.equal(byName.get('Marcin Przybyłowicz').mobyId, 9001);
      assert.equal(byName.get('Marcin Przybyłowicz').roleSource, 'mobygames');
    } finally {
      delete process.env.MOBYGAMES_API_KEY;
      moby.resetMobyKeyCache();
    }
  });

  test('role mapping table', () => {
    assert.equal(moby.mapRole('Composer'), 'composer');
    assert.equal(moby.mapRole('Music'), 'composer');
    assert.equal(moby.mapRole('Game Design'), 'designer');
    assert.equal(moby.mapRole('Writing'), 'writer');
    assert.equal(moby.mapRole('Art/Graphics'), 'artist');
    assert.equal(moby.mapRole('Programming'), 'programmer');
    assert.equal(moby.mapRole('Production'), 'producer');
    assert.equal(moby.mapRole('Audio'), 'sound');
    assert.equal(moby.mapRole('Voice Actor'), 'voice');
    assert.equal(moby.mapRole('Quality Assurance'), null);
    assert.equal(moby.mapRole('Something Unknown'), null);
  });

  test('array-shaped credits are accepted defensively', () => {
    const doc = moby.parseCreditsResponse({
      credits: [
        { role: 'Writing', person_id: 1, name: 'A Writer' },
        { role: 'Game Design', person_id: 2, name: 'A Designer' },
      ],
    });
    assert.equal(doc.people.length, 2);
    assert.deepEqual(doc.people[0].roles, ['writer']);
  });

  test('403 trips the 30-minute breaker: the next call does not hit the network', async () => {
    process.env.MOBYGAMES_API_KEY = 'moby-test-key-not-real';
    moby.resetMobyKeyCache();
    try {
      const store = memoryStore();
      let calls = 0;
      const client = moby.createClient({
        fetchImpl: async () => {
          calls++;
          return jsonResponse({}, 403);
        },
        breakerStore: store,
        pauseMs: 0,
      });
      await assert.rejects(
        () => client.fetchGameCredits({ mobyId: 1, platformId: 1 }),
        (err) => err.code === 'moby_rate_limited'
      );
      assert.equal(calls, 1);
      const breaker = client.status().breaker;
      assert.ok(breaker);
      assert.equal(breaker.reason, 'HTTP 403');

      await assert.rejects(
        () => client.fetchGameCredits({ mobyId: 1, platformId: 1 }),
        (err) => err.code === 'moby_rate_limited' && Boolean(err.retryAt)
      );
      assert.equal(calls, 1);
    } finally {
      delete process.env.MOBYGAMES_API_KEY;
      moby.resetMobyKeyCache();
    }
  });

  test('budget: GAMES_MOBY_BUDGET exhausted stops before the request', async () => {
    process.env.MOBYGAMES_API_KEY = 'moby-test-key-not-real';
    moby.resetMobyKeyCache();
    try {
      let calls = 0;
      const client = moby.createClient({
        fetchImpl: async () => {
          calls++;
          return jsonResponse(fixture);
        },
        breakerStore: memoryStore(),
        pauseMs: 0,
        budget: 1,
      });
      await client.fetchGameCredits({ mobyId: 1, platformId: 1 });
      assert.equal(calls, 1);
      await assert.rejects(
        () => client.fetchGameCredits({ mobyId: 2, platformId: 1 }),
        (err) => err.code === 'moby_budget_exhausted'
      );
      assert.equal(calls, 1);
      assert.equal(client.status().budgetUsed, 1);
    } finally {
      delete process.env.MOBYGAMES_API_KEY;
      moby.resetMobyKeyCache();
    }
  });

  test('404 is not_found and does not open the breaker', async () => {
    process.env.MOBYGAMES_API_KEY = 'moby-test-key-not-real';
    moby.resetMobyKeyCache();
    try {
      const store = memoryStore();
      const client = moby.createClient({
        fetchImpl: async () => jsonResponse({}, 404),
        breakerStore: store,
        pauseMs: 0,
      });
      await assert.rejects(
        () => client.fetchGameCredits({ mobyId: 9, platformId: 9 }),
        (err) => err.code === 'moby_not_found'
      );
      assert.deepEqual(store.snapshot(), {});
    } finally {
      delete process.env.MOBYGAMES_API_KEY;
      moby.resetMobyKeyCache();
    }
  });
  after(() => env.resetMutableState());
});


describe('games-personnel-roles', () => {
  /**
   * Role split (ИГРЫ §2.4/§7.2, 01.11.2026): `developer` and `publisher` are
   * separate answers fed by both sources (Steam `developers[]`/`publishers[]`
   * and Wikidata `P178`/`P123`), `developer` is the default, the old `studio`
   * token is an alias, and the «WD: не запущено / недоступно» badge comes from
   * the persisted breaker state.
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
  process.env.KINOBOXD_MOBY_KEY_FILE = path.join(STATE_DIR, 'no-moby-token');

  const gameCache = require('../server/games/game-cache');
  const personnel = require('../server/games/personnel/personnel');
  const { buildGamesStatsFromCache } = require('../server/games/stats');

  const ID = '76561198000000042';
  const PROFILE = `steam-${ID}`;
  const GAMES_STATE_PATH = path.join(STATE_DIR, 'games', 'personnel-wikidata.json');

  const DETAILS_DIR = path.join(CACHE_DIR, 'details');

  function writeDetails(appid, doc) {
    fs.mkdirSync(DETAILS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DETAILS_DIR, `${appid}.json`),
      JSON.stringify({ fetchedAt: new Date().toISOString(), ...doc })
    );
  }

  function credit(name, roles, extra = {}) {
    return {
      name,
      nameEn: name,
      nameRu: null,
      qid: null,
      mobyId: null,
      roles,
      roleSource: 'wikidata',
      source: 'wikidata',
      confidence: 'high',
      ...extra,
    };
  }

  function writeWdState(state) {
    fs.mkdirSync(path.dirname(GAMES_STATE_PATH), { recursive: true });
    fs.writeFileSync(GAMES_STATE_PATH, JSON.stringify({ schemaVersion: 1, ...state }));
  }

  async function seed() {
    const now = new Date().toISOString();
    await gameCache.saveProfile({
      userKey: ID,
      personaName: 'roles-tester',
      privacy: 'public',
      importedAt: now,
      fetchedAt: now,
    });
    await gameCache.saveLibrary(ID, {
      fetchedAt: now,
      partial: false,
      game_count: 2,
      games: [
        { appid: 7001, name: 'Aurora Quest', playtime_forever: 6000 },
        { appid: 7002, name: 'Aurora Quest II', playtime_forever: 1200 },
      ],
    });
    writeDetails(7001, {
      success: true,
      type: 'game',
      name: 'Aurora Quest',
      developers: ['Aurora Works'],
      publishers: ['Northlight Publishing'],
      releaseYear: 2015,
    });
    writeDetails(7002, {
      success: true,
      type: 'game',
      name: 'Aurora Quest II',
      developers: ['Aurora Works'],
      publishers: ['Northlight Publishing'],
      releaseYear: 2018,
    });
    await personnel.savePersonnelDoc(7001, {
      fetchedAt: now,
      qid: 'Q700100',
      sources: ['steam-store', 'wikidata'],
      studios: [
        credit('Aurora Works', ['developer'], { qid: 'Q7001' }),
        credit('Northlight Publishing', ['publisher'], { qid: 'Q7002' }),
        // Wikidata-only developer: it must land in the developer bucket even
        // though no `details/<appid>.json` mentions it.
        credit('Lumen Audio Studio', ['developer'], { qid: 'Q7003' }),
      ],
      people: [
        credit('Ivy Composer', ['composer'], { qid: 'Q7101' }),
        credit('Dana Designer', ['designer'], { qid: 'Q7102' }),
      ],
    });
    await personnel.savePersonnelDoc(7002, {
      fetchedAt: now,
      qid: 'Q700200',
      sources: ['steam-store', 'wikidata'],
      studios: [credit('Aurora Works', ['developer'], { qid: 'Q7001' })],
      people: [credit('Ivy Composer', ['composer'], { qid: 'Q7101' })],
    });
  }

  test.before(async () => {
    writeWdState({ lastSuccessAt: new Date().toISOString() });
    await seed();
  });

  test('developer and publisher are separate answers, both fed by Steam + Wikidata', () => {
    const developers = personnel.buildPersonnel(PROFILE, { role: 'developer' });
    const names = developers.items.map((item) => item.name).sort();
    assert.deepEqual(names, ['Aurora Works', 'Lumen Audio Studio']);
    const aurora = developers.items.find((item) => item.name === 'Aurora Works');
    assert.equal(aurora.qid, 'Q7001', 'Steam spelling merged with its Wikidata QID');
    assert.equal(aurora.count, 2);
    assert.equal(aurora.hours, 120);
    assert.deepEqual(aurora.sources, ['steam-store', 'wikidata']);
    assert.deepEqual(aurora.roles, ['developer']);
    const lumen = developers.items.find((item) => item.name === 'Lumen Audio Studio');
    assert.equal(lumen.count, 1, 'a Wikidata-only developer is still a developer');

    const publishers = personnel.buildPersonnel(PROFILE, { role: 'publisher' });
    assert.deepEqual(
      publishers.items.map((item) => item.name),
      ['Northlight Publishing']
    );
    assert.deepEqual(publishers.items[0].roles, ['publisher']);
    assert.equal(publishers.items[0].count, 2);
    assert.equal(
      publishers.items.some((item) => item.name === 'Aurora Works'),
      false,
      'a developer is not a publisher'
    );

    assert.equal(developers.coverage.byStudioRole.developer, 2);
    assert.equal(developers.coverage.byStudioRole.publisher, 2);
    assert.equal(developers.coverage.gamesWithDevelopers, 2);
    assert.equal(developers.coverage.gamesWithPublishers, 2);
  });

  test('gamesIndex.developers/publishers agree with the studio role counters', () => {
    const stats = buildGamesStatsFromCache(PROFILE);
    assert.ok(stats);
    const index = Object.values(stats.gamesIndex);
    const withDevelopers = index.filter((game) => (game.developers || []).length > 0).length;
    const withPublishers = index.filter((game) => (game.publishers || []).length > 0).length;
    const payload = personnel.buildPersonnel(PROFILE, { role: 'developer' });
    assert.equal(withDevelopers, payload.coverage.gamesWithDevelopers);
    assert.equal(withPublishers, payload.coverage.gamesWithPublishers);
    // Steam spellings are the same names the personnel answer groups by.
    const steamNames = new Set(index.flatMap((game) => game.developers || []));
    const developerNames = new Set(payload.items.map((item) => item.name));
    for (const name of steamNames) assert.ok(developerNames.has(name), `${name} must be a developer`);
    // …and a Wikidata-only studio appears in the role without being in gamesIndex.
    assert.ok(!steamNames.has('Lumen Audio Studio'));
    assert.ok(developerNames.has('Lumen Audio Studio'));
  });

  test('the old "studio" token is a documented alias for developer', () => {
    const aliased = personnel.buildPersonnel(PROFILE, { role: 'studio' });
    const direct = personnel.buildPersonnel(PROFILE, { role: 'developer' });
    assert.equal(aliased.role, 'developer');
    assert.equal(aliased.roleRequested, 'studio');
    assert.equal(aliased.roleAlias, 'studio');
    assert.deepEqual(
      aliased.items.map((item) => item.id),
      direct.items.map((item) => item.id)
    );
    assert.equal(personnel.normalizeRole('STUDIO'), 'developer');
    assert.equal(personnel.normalizeRole(''), 'developer');
    assert.equal(personnel.normalizeRole(null), 'developer');
    assert.throws(
      () => personnel.normalizeRole('wizard'),
      (err) => err.code === 'invalid_role' && /studio/.test(err.message)
    );
  });

  test('default role is developer and the payload documents the contract', () => {
    const payload = personnel.buildPersonnel(PROFILE);
    assert.equal(payload.role, 'developer');
    assert.equal(payload.roles.default, 'developer');
    assert.deepEqual(payload.roles.studio, ['developer', 'publisher']);
    assert.deepEqual(payload.roles.aliases, { studio: 'developer', studios: 'developer', dev: 'developer', pub: 'publisher' });
    assert.deepEqual(payload.roles.accepted, [
      'developer',
      'publisher',
      'composer',
      'designer',
      'writer',
      'artist',
      'programmer',
      'producer',
      'director',
      'creator',
      'sound',
      'voice',
    ]);
    assert.equal(payload.roles.accepted.includes('studio'), false, 'studio is an alias, not a role');
  });

  test('WD badge: never_run / unavailable / cooldown / ok, with the provider reason', () => {
    writeWdState({});
    const never = personnel.buildPersonnel(PROFILE, { role: 'composer' });
    assert.equal(never.coverage.wikidata.state, 'never_run');
    assert.equal(never.coverage.wikidata.badge, 'WD: не запущено');
    assert.equal(never.sources.wikidata.state, 'never_run');

    writeWdState({
      failures: 2,
      lastError: 'wikidata_429',
      lastAttemptAt: new Date().toISOString(),
    });
    const failed = personnel.buildPersonnel(PROFILE, { role: 'composer' });
    assert.equal(failed.coverage.wikidata.state, 'unavailable');
    assert.equal(failed.coverage.wikidata.badge, 'WD: недоступно');
    assert.equal(failed.coverage.wikidata.reason, 'wikidata_429');

    writeWdState({
      failures: 3,
      lastError: 'wikidata_403',
      disabledUntil: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    const cooldown = personnel.buildPersonnel(PROFILE, { role: 'composer' });
    assert.equal(cooldown.coverage.wikidata.state, 'cooldown');
    assert.equal(cooldown.coverage.wikidata.badge, 'WD: недоступно');
    assert.ok(cooldown.coverage.wikidata.disabledUntil);

    writeWdState({ failures: 0, lastSuccessAt: new Date().toISOString() });
    const ok = personnel.buildPersonnel(PROFILE, { role: 'composer' });
    assert.equal(ok.coverage.wikidata.state, 'ok');
    assert.equal(ok.coverage.wikidata.badge, null);
    assert.equal(ok.pending.credits, 0);
  });
  after(() => env.resetMutableState());
});


describe('games-personnel-wikidata', () => {
  /**
   * Wikidata credit provider (M3): batching, parsing, politeness, breaker.
   * No live requests: `fetchImpl` is always injected.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const wd = require('../server/games/personnel/wikidata');
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'games', 'wikidata-credits.json'), 'utf8')
  );

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

  test('parses a real WDQS answer: composers/designers/director/programmer + studios', () => {
    const credits = wd.parseCreditsResponse(fixture);
    assert.equal(credits.size, 2);

    const witcher = credits.get('Q4267401');
    assert.ok(witcher);
    const composers = witcher.people.filter((person) => person.roles.includes('composer'));
    assert.deepEqual(composers.map((person) => person.name).sort(), [
      'Marcin Przybyłowicz',
      'Mikolai Stroinski',
    ]);
    // RU label is kept as an alias source, EN is the display name.
    const marcin = composers.find((person) => person.name === 'Marcin Przybyłowicz');
    assert.equal(marcin.nameRu, 'Марцин Пшибылович');
    assert.equal(marcin.qid, 'Q19005369');
    assert.equal(marcin.roleSource, 'wikidata');
    assert.equal(marcin.confidence, 'high');
    assert.match(marcin.image, /^https:\/\//);

    // A company credited as P162 producer is not a person: CD Projekt RED is a
    // studio of this game (P178/P123), so the studio record wins.
    assert.equal(
      witcher.people.some((person) => person.name === 'CD Projekt RED'),
      false
    );
    const cdpr = witcher.studios.find((studio) => studio.name === 'CD Projekt RED');
    assert.ok(cdpr);
    assert.deepEqual(cdpr.roles.sort(), ['developer', 'publisher']);
    assert.equal(cdpr.qid, 'Q1172164');

    // Pathologic: composer + 2 designers + director + programmer (spec §2.4).
    const pathologic = credits.get('Q2429644');
    const roles = new Set(pathologic.people.flatMap((person) => person.roles));
    for (const role of ['composer', 'designer', 'director', 'programmer']) {
      assert.ok(roles.has(role), `Pathologic should have a ${role}`);
    }
    assert.equal(pathologic.people.filter((person) => person.roles.includes('designer')).length, 2);
    assert.ok(pathologic.studios.some((studio) => studio.name === 'Ice-Pick Lodge'));
  });

  /**
   * `mul` is Wikidata's language-neutral label. Q3539040 carries a truncated
   * English label («Development Studio») next to the real `mul` one («Paradox
   * Development Studio»), which is what made the same studio appear twice in the
   * «Персоналии» widget (round 01.11.2026).
   */
  function labelRow(qid, lang, value, game = 'Q677869') {
    return {
      game: { type: 'uri', value: `http://www.wikidata.org/entity/${game}` },
      kind: { type: 'literal', value: 'studio' },
      role: { type: 'literal', value: 'developer' },
      entity: { type: 'uri', value: `http://www.wikidata.org/entity/${qid}` },
      label: { type: 'literal', value, 'xml:lang': lang },
    };
  }

  test('canonical label: the mul spelling wins over a truncated English one', () => {
    const credits = wd.parseCreditsResponse({
      results: {
        bindings: [
          labelRow('Q3539040', 'en', 'Development Studio'),
          labelRow('Q3539040', 'mul', 'Paradox Development Studio'),
        ],
      },
    });
    const studio = credits.get('Q677869').studios[0];
    assert.equal(studio.name, 'Paradox Development Studio');
    assert.equal(studio.nameEn, 'Paradox Development Studio', 'the display spelling follows');
    assert.equal(studio.qid, 'Q3539040');
  });

  test('canonical label: a shorter mul never degrades a more specific English name', () => {
    assert.deepEqual(
      wd.canonicalLabel({ nameEn: 'Warner Bros. Entertainment', nameMul: 'Warner Bros.' }),
      { name: 'Warner Bros. Entertainment', nameEn: 'Warner Bros. Entertainment' }
    );
    // No English label at all: mul is the fallback (as before, but explicit).
    assert.deepEqual(wd.canonicalLabel({ nameEn: null, nameMul: 'Sega' }), {
      name: 'Sega',
      nameEn: 'Sega',
    });
    // No mul label: English stays exactly as it was.
    assert.deepEqual(wd.canonicalLabel({ nameEn: 'Valve', nameRu: 'Valve' }), {
      name: 'Valve',
      nameEn: 'Valve',
    });
    // Unrelated mul label (a known Wikidata defect) is not preferred.
    assert.equal(wd.canonicalLabel({ nameEn: 'Aspyr', nameMul: 'Roger Cruz' }).name, 'Aspyr');
  });

  test('batch size is ≤450: 500 QIDs become two queries', async () => {
    const queries = [];
    const fetchImpl = async (url, init) => {
      queries.push(init.body);
      return jsonResponse({ results: { bindings: [] } });
    };
    const qids = Array.from({ length: 500 }, (_, index) => `Q${1000 + index}`);
    const result = await wd.fetchCredits(qids, {
      fetchImpl,
      pauseMs: 0,
      stateStore: memoryStore(),
    });
    assert.equal(queries.length, 2);
    assert.equal(result.queries, 2);
    assert.equal(result.batches, 2);
    assert.equal(result.credits.size, 0);
    // The first query carries exactly 450 VALUES, the second 50.
    assert.equal((queries[0].match(/wd%3AQ/g) || []).length, 450);
    assert.equal((queries[1].match(/wd%3AQ/g) || []).length, 50);
  });

  test('appid query uses P1733 and quotes the external ids', async () => {
    const query = wd.appidCreditsQuery(['292030', '2429644']);
    assert.match(query, /wdt:P1733 \?appid/);
    assert.match(query, /VALUES \?appid \{ "292030" "2429644" \}/);
  });

  test('429 with Retry-After: three failures open the persisted cooldown', async () => {
    const store = memoryStore();
    let nowMs = Date.parse('2026-11-01T10:00:00Z');
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return jsonResponse({}, 429, { 'retry-after': '3600' });
    };
    const options = {
      fetchImpl,
      pauseMs: 0,
      stateStore: store,
      now: () => nowMs,
      minOutageGapMs: 0,
    };
    const qids = ['Q1', 'Q2', 'Q3'];

    const first = await wd.fetchCredits(qids, options);
    assert.equal(first.skipped, undefined);
    assert.equal(first.errors.length, 1);
    assert.equal(first.disabledUntil, null);
    assert.equal(store.snapshot().failures, 1);

    const second = await wd.fetchCredits(qids, options);
    assert.equal(second.errors.length, 1);
    assert.equal(store.snapshot().failures, 2);

    nowMs += 1000;
    const third = await wd.fetchCredits(qids, options);
    assert.equal(third.skipped, 'wikidata_disabled');
    assert.ok(third.disabledUntil);
    const until = Date.parse(third.disabledUntil);
    // Retry-After (1 h) wins over the 30-min default.
    assert.ok(until - nowMs >= 3600 * 1000 - 1000);
    assert.equal(store.snapshot().failures, 3);

    // Breaker open: the next call must not touch the network at all.
    const callsBefore = calls;
    const fourth = await wd.fetchCredits(qids, options);
    assert.equal(fourth.skipped, 'wikidata_disabled');
    assert.equal(calls, callsBefore);
  });

  test('outage gap: at most one attempt per minute while failing', async () => {
    const store = memoryStore();
    let nowMs = Date.parse('2026-11-01T11:00:00Z');
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return jsonResponse({}, 503);
    };
    const options = { fetchImpl, pauseMs: 0, stateStore: store, now: () => nowMs };
    await wd.fetchCredits(['Q10'], options);
    assert.equal(calls, 1);

    const immediate = await wd.fetchCredits(['Q10'], options);
    assert.equal(immediate.skipped, 'wikidata_outage_gap');
    assert.equal(calls, 1);

    nowMs += 61 * 1000;
    await wd.fetchCredits(['Q10'], options);
    assert.equal(calls, 2);
  });

  test('a successful batch resets failures', async () => {
    const store = memoryStore({ failures: 2, lastAttemptAt: new Date(0).toISOString() });
    const result = await wd.fetchCredits(['Q1'], {
      fetchImpl: async () => jsonResponse({ results: { bindings: [] } }),
      pauseMs: 0,
      stateStore: store,
    });
    assert.equal(result.queries, 1);
    assert.equal(store.snapshot().failures, 0);
    assert.ok(store.snapshot().lastSuccessAt);
  });

  test('kill switch KINOBOXD_GAMES_WD=off makes no request', async () => {
    process.env.KINOBOXD_GAMES_WD = 'off';
    try {
      let calls = 0;
      const result = await wd.fetchCredits(['Q1'], {
        fetchImpl: async () => {
          calls++;
          return jsonResponse({ results: { bindings: [] } });
        },
        stateStore: memoryStore(),
      });
      assert.equal(result.skipped, 'disabled_by_env');
      assert.equal(calls, 0);
    } finally {
      delete process.env.KINOBOXD_GAMES_WD;
    }
  });

  test('retry-after parser: seconds and HTTP date', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    assert.equal(wd.parseRetryAfter('120', now), 120000);
    assert.equal(wd.parseRetryAfter('Sun, 01 Nov 2026 13:00:00 GMT', now), 3600000);
    assert.equal(wd.parseRetryAfter('nonsense', now), null);
    assert.equal(wd.parseRetryAfter(null, now), null);
  });
  after(() => env.resetMutableState());
});


describe('games-franchise-aggregate', () => {
  /**
   * Franchise aggregation (M4-B): Wikidata P179 groups, the minimal title
   * heuristic (only ≥2 owned games, low confidence), release-year overlay from
   * P577 and honest coverage/pending counters.
   *
   * Pure readers are injected: no cache files, no network.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const aggregate = require('../server/games/franchise-aggregate');

  const ID = '76561198000003001';
  const PROFILE = `steam-${ID}`;
  const FRESH = new Date().toISOString();

  function game(appid, name, minutes) {
    return { appid, name, playtime_forever: minutes };
  }

  function build(libraryGames, { details = {}, links = {} } = {}) {
    return aggregate.buildFranchises(PROFILE, {
      getProfile: () => ({ userKey: ID, personaName: 'tester' }),
      getLibrary: () => ({ games: libraryGames, partial: false }),
      readDetails: (appid) => details[appid] || null,
      readLinks: (appid) => links[appid] || {},
      ttlMs: 90 * 86400000,
    });
  }

  function wdLinks(qid, franchiseQid, labelEn, labelRu, releaseYear) {
    return {
      qid,
      franchise: { qid: franchiseQid, labelEn, labelRu },
      franchiseKey: `wd:${franchiseQid}`,
      releaseYear,
      releasePrecision: 'day',
      resolved: true,
      fetchedAt: FRESH,
      sources: ['wikidata'],
    };
  }

  test('groups P179 franchises with hours, yearsSpread and appids', () => {
    const payload = build(
      [
        game(292030, 'The Witcher 3: Wild Hunt', 6420),
        game(20900, 'The Witcher: Enhanced Edition', 600),
        game(220, 'Half-Life 2', 1200),
        game(70, 'Half-Life', 300),
        game(999, 'Singleton Without Franchise', 60),
      ],
      {
        details: {
          292030: { success: true, type: 'game', name: 'The Witcher 3: Wild Hunt', releaseYear: 2015, releasePrecision: 'day' },
          20900: { success: true, type: 'game', name: 'The Witcher: Enhanced Edition', releaseYear: 2007, releasePrecision: 'day' },
          220: { success: true, type: 'game', name: 'Half-Life 2', releaseYear: 2004, releasePrecision: 'day' },
          70: { success: true, type: 'game', name: 'Half-Life', releaseYear: 1998, releasePrecision: 'day' },
        },
        links: {
          292030: wdLinks('Q4267401', 'Q1060747', 'The Witcher', 'Ведьмак', 2015),
          20900: wdLinks('Q845211', 'Q1060747', 'The Witcher', 'Ведьмак', 2007),
          220: wdLinks('Q546207', 'Q753753', 'Half-Life', 'Half-Life', 2004),
          70: wdLinks('Q332937', 'Q753753', 'Half-Life', 'Half-Life', 1998),
        },
      }
    );

    assert.equal(payload.profile, PROFILE);
    assert.equal(payload.totals.gamesTotal, 5);
    assert.equal(payload.franchises.length, 2);

    const witcher = payload.franchises.find((entry) => entry.key === 'wd:Q1060747');
    assert.equal(witcher.label, 'The Witcher');
    assert.equal(witcher.labelRu, 'Ведьмак');
    assert.equal(witcher.source, 'wikidata');
    assert.equal(witcher.confidence, 'high');
    assert.equal(witcher.gamesCount, 2);
    assert.equal(witcher.hoursSum, 117);
    assert.deepEqual(witcher.yearsSpread, { min: 2007, max: 2015, span: 8 });
    assert.deepEqual(witcher.appids, [292030, 20900]);
    assert.equal(witcher.games[0].releaseSource, 'steam-store');

    // Sorted by hours: The Witcher (117 h) before Half-Life (25 h).
    assert.deepEqual(payload.franchises.map((entry) => entry.key), ['wd:Q1060747', 'wd:Q753753']);
    assert.equal(payload.coverage.gamesWithFranchise, 4);
    assert.equal(payload.coverage.percent, 80);
    assert.deepEqual(payload.coverage.bySource, { wikidata: 4, heuristic: 0 });
    assert.equal(payload.coverage.links.documents, 4);
    assert.equal(payload.coverage.links.fresh, 4);
    assert.equal(payload.pending.wikidata, 1);
    assert.equal(payload.pending.releaseYears, 1);
  });

  test('heuristic fallback: only groups of ≥2 owned titles, low confidence', () => {
    const payload = build([
      game(1, 'Fallout', 300),
      game(2, 'Fallout: New Vegas PCR', 900),
      game(3, 'Portal', 200),
      game(4, 'Portal 2', 400),
      game(5, 'Dishonored RHCP', 500),
      game(6, 'Galactic Civilizations II: Ultimate Edition', 100),
    ]);

    assert.equal(payload.franchises.length, 2);
    const byKey = new Map(payload.franchises.map((entry) => [entry.key, entry]));
    const fallout = byKey.get('title:fallout');
    assert.ok(fallout, 'Fallout + Fallout: New Vegas form a franchise');
    assert.equal(fallout.gamesCount, 2);
    assert.equal(fallout.source, 'heuristic');
    assert.equal(fallout.confidence, 'low');
    assert.equal(fallout.label, 'Fallout');
    assert.deepEqual(fallout.appids, [2, 1]);
    assert.ok(byKey.get('title:portal'));
    // A single game never becomes a franchise.
    assert.equal(payload.franchises.some((entry) => entry.key.includes('dishonored')), false);
    assert.equal(payload.coverage.bySource.heuristic, 4);
    assert.equal(payload.coverage.gamesWithFranchise, 4);
    assert.equal(payload.meta.heuristic.confidence, 'low');
  });

  test('synthetic zero-details cache: heuristic from library names, no invented years', () => {
    const payload = build([
      game(11, 'Half-Life', 0),
      game(12, 'Half-Life 2', 0),
      game(13, 'Mystery Game', 0),
    ]);
    assert.ok(payload);
    assert.equal(payload.totals.gamesTotal, 3);
    assert.equal(payload.franchises.length, 1);
    assert.equal(payload.franchises[0].key, 'title:half-life');
    assert.deepEqual(payload.franchises[0].yearsSpread, { min: null, max: null, span: null });
    assert.equal(payload.coverage.releaseYears.unknown, 3);
    assert.equal(payload.pending.releaseYears, 3);
    assert.equal(payload.pending.wikidata, 3);
    // The heuristic works without any details document at all.
    assert.equal(payload.coverage.bySource.heuristic, 2);
  });

  test('WD franchise wins; the remaining title group is too small to guess', () => {
    const payload = build(
      [
        game(292030, 'The Witcher 3: Wild Hunt', 100),
        game(20900, 'The Witcher 2: Assassins of Kings', 50),
      ],
      {
        links: {
          292030: wdLinks('Q4267401', 'Q1060747', 'The Witcher', 'Ведьмак', 2015),
        },
      }
    );
    assert.equal(payload.franchises.length, 0, 'one game alone is not a heuristic franchise');
    assert.equal(payload.coverage.gamesWithFranchise, 1);
    assert.equal(payload.coverage.bySource.wikidata, 1);
    assert.equal(payload.coverage.bySource.heuristic, 0);
  });

  test('P577 closes a region-locked game year; unknown stays unknown', () => {
    const payload = build(
      [
        game(12240, 'Region Locked Game', 120),
        game(777, 'No Year Anywhere', 10),
      ],
      {
        details: {
          12240: { success: false, unavailable: true },
        },
        links: {
          12240: {
            qid: 'Q1318551',
            franchise: null,
            releaseYear: 2010,
            releasePrecision: 'year',
            resolved: true,
            fetchedAt: FRESH,
          },
        },
      }
    );
    assert.equal(payload.coverage.releaseYears.fromWikidata, 1);
    assert.equal(payload.coverage.releaseYears.unknown, 1);
    assert.equal(payload.coverage.releaseYears.unavailableDetails, 1);
    assert.equal(payload.coverage.releaseYears.fromDetails, 0);
    assert.equal(payload.pending.releaseYears, 1);
    assert.equal(payload.pending.unavailableDetails, 1);
  });

  test('DLC/demo/software are excluded from franchise buckets', () => {
    const payload = build(
      [
        game(10, 'Base Game', 100),
        game(11, 'Base Game DLC', 20),
      ],
      {
        details: {
          10: { success: true, type: 'game', name: 'Base Game' },
          11: { success: true, type: 'dlc', name: 'Base Game DLC' },
        },
      }
    );
    assert.equal(payload.totals.gamesTotal, 1);
    assert.equal(payload.pending.wikidata, 1);
  });

  test('heuristic base + blacklist guards from the spec', () => {
    assert.equal(aggregate.heuristicBase('The Witcher 3: Wild Hunt'), 'the-witcher');
    assert.equal(aggregate.heuristicBase('Civilization IV'), 'civilization');
    assert.equal(aggregate.heuristicBase('Grand Theft Auto V Legacy'), 'grand-theft-auto');
    assert.equal(aggregate.heuristicBase('Half-Life 2: Deathmatch'), 'half-life');
    assert.equal(aggregate.heuristicBase('Doom'), 'doom');
    assert.equal(aggregate.heuristicBase('A'), null);
    assert.equal(
      aggregate.groupIsBlacklisted([{ name: 'Dark Souls' }, { name: 'Darkest Dungeon' }]),
      true
    );
    assert.equal(
      aggregate.groupIsBlacklisted([{ name: 'Hitman 2' }, { name: "Hitman's Bodyguard" }]),
      true
    );
    assert.equal(aggregate.groupIsBlacklisted([{ name: 'Fallout 3' }, { name: 'Fallout 4' }]), false);
  });
  after(() => env.resetMutableState());
});


describe('games-franchise-jobs', () => {
  /**
   * Franchise job (M4-B): coalescing, shared WDQS lock, resume/force, lazy-kick
   * gate and the import wiring. Providers are injected, no live WDQS.
   */

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  process.env.KINOBOXD_CACHE_GAMES_DIR = run.cacheGamesDir;
  process.env.KINOBOXD_STATE_DIR = run.stateDir;

  const gameCache = require('../server/games/game-cache');
  const franchise = require('../server/games/franchise');
  const franchiseJobs = require('../server/games/franchise-jobs');
  const importJobs = require('../server/games/import');
  const lock = require('../server/games/personnel/lock');

  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'games', 'wikidata-franchises.json'), 'utf8')
  );

  function jsonResponse(data, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => data,
    };
  }

  function memoryStore() {
    let state = {};
    return {
      read: () => ({ ...state }),
      write: (next) => {
        state = { ...next };
      },
    };
  }

  async function seed(userKey, games) {
    const now = new Date().toISOString();
    await gameCache.saveProfile({ userKey, personaName: 'jobs tester', importedAt: now, fetchedAt: now });
    await gameCache.saveLibrary(userKey, {
      fetchedAt: now,
      partial: false,
      game_count: games.length,
      games,
    });
    return gameCache.profileKeyOf(userKey);
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

  test.before(() => {
    franchiseJobs.resetCooldown();
  });

  test.after(() => {
    lock.clearLock();
  });

  test('one pass writes links, records state and coalesces a second start', async () => {
    const userKey = '76561198000004001';
    clearLinks([292030, 12240]);
    const profileKey = await seed(userKey, [
      { appid: 292030, name: 'The Witcher 3: Wild Hunt', playtime_forever: 100 },
      { appid: 12240, name: 'Region Locked', playtime_forever: 10 },
    ]);
    let calls = 0;
    const options = {
      fetchImpl: async () => {
        calls++;
        return jsonResponse(fixture);
      },
      stateStore: memoryStore(),
      pauseMs: 0,
      waitForEnrich: false,
      lockWaitMs: 0,
    };

    const first = franchiseJobs.startFranchise(profileKey, options);
    const second = franchiseJobs.startFranchise(profileKey, options);
    assert.equal(first.jobId, second.jobId, 'a running pass is reused, not duplicated');
    assert.equal(first.status, 'running');

    await franchiseJobs.whenIdle();
    const done = franchiseJobs.getStatus(first.jobId);
    assert.equal(done.status, 'done');
    assert.equal(done.updated, 2);
    assert.equal(done.wdQueries, 1);
    assert.equal(done.wdAnswered, 7);
    assert.equal(done.skipped, null);
    assert.equal(calls, 1);

    assert.ok(franchise.readLinksDoc(292030));
    assert.ok(franchise.readLinksDoc(12240));
    const state = franchise.readFranchiseState();
    assert.equal(state.profiles[profileKey].updated, 2);
  });

  test('the shared personnel lock makes the pass skip instead of racing WDQS', async () => {
    const userKey = '76561198000004002';
    clearLinks([292030]);
    const profileKey = await seed(userKey, [
      { appid: 292030, name: 'The Witcher 3: Wild Hunt', playtime_forever: 100 },
    ]);
    const token = lock.tryAcquire('another-wdqs-pass');
    assert.ok(token, 'test holds the shared lock');
    try {
      const job = franchiseJobs.startFranchise(profileKey, {
        fetchImpl: async () => jsonResponse(fixture),
        stateStore: memoryStore(),
        pauseMs: 0,
        waitForEnrich: false,
        lockWaitMs: 0,
      });
      await franchiseJobs.whenIdle();
      const done = franchiseJobs.getStatus(job.jobId);
      assert.equal(done.status, 'skipped');
      assert.equal(done.skipped, 'lock_busy');
      assert.equal(done.code, 'franchise_lock_busy');
      assert.equal(franchise.readLinksDoc(292030), null);
    } finally {
      lock.releaseLock(token);
    }
  });

  test('lazy kick gate: recent_cooldown after a pass, forceKick bypasses, WD off disables', async () => {
    const userKey = '76561198000004003';
    clearLinks([292030]);
    const profileKey = await seed(userKey, [
      { appid: 292030, name: 'The Witcher 3: Wild Hunt', playtime_forever: 100 },
    ]);
    franchiseJobs.resetCooldown();

    const job = franchiseJobs.startFranchise(profileKey, {
      fetchImpl: async () => jsonResponse(fixture),
      stateStore: memoryStore(),
      pauseMs: 0,
      waitForEnrich: false,
      lockWaitMs: 0,
    });
    await franchiseJobs.whenIdle();
    assert.equal(franchiseJobs.getStatus(job.jobId).status, 'done');

    assert.equal(franchiseJobs.kickGate(profileKey), 'recent_cooldown');
    assert.equal(franchiseJobs.kickGate(profileKey, { forceKick: true }), null);

    const skipped = franchiseJobs.kickQuietly(profileKey, {});
    assert.equal(skipped.id, null);
    assert.equal(skipped.skipped, 'recent_cooldown');

    process.env.KINOBOXD_GAMES_WD = 'off';
    try {
      franchiseJobs.resetCooldown();
      assert.equal(franchiseJobs.kickGate(profileKey, { forceKick: true }), 'sources_disabled');
      const disabled = franchiseJobs.kickQuietly(profileKey, { forceKick: true });
      assert.equal(disabled.skipped, 'sources_disabled');
    } finally {
      delete process.env.KINOBOXD_GAMES_WD;
    }
  });

  test('force re-asks a fresh links document', async () => {
    const userKey = '76561198000004004';
    clearLinks([292030]);
    const profileKey = await seed(userKey, [
      { appid: 292030, name: 'The Witcher 3: Wild Hunt', playtime_forever: 100 },
    ]);
    let calls = 0;
    const options = {
      fetchImpl: async () => {
        calls++;
        return jsonResponse(fixture);
      },
      stateStore: memoryStore(),
      pauseMs: 0,
      waitForEnrich: false,
      lockWaitMs: 0,
    };
    const first = franchiseJobs.startFranchise(profileKey, options);
    await franchiseJobs.whenIdle();
    assert.equal(franchiseJobs.getStatus(first.jobId).updated, 1);

    const cached = franchiseJobs.startFranchise(profileKey, options);
    await franchiseJobs.whenIdle();
    const cachedStatus = franchiseJobs.getStatus(cached.jobId);
    assert.equal(cachedStatus.updated, 0);
    assert.equal(cachedStatus.skippedFresh, 1);
    assert.equal(cachedStatus.skipped, 'nothing_to_ask');
    assert.equal(calls, 1);

    const forced = franchiseJobs.startFranchise(profileKey, { ...options, force: true });
    await franchiseJobs.whenIdle();
    assert.equal(franchiseJobs.getStatus(forced.jobId).updated, 1);
    assert.equal(calls, 2);
  });

  test('import kicks the franchise pass after the library is ready', async () => {
    const userKey = '76561198000004005';
    clearLinks([292030]);
    await seed(userKey, [
      { appid: 292030, name: 'The Witcher 3: Wild Hunt', playtime_forever: 100 },
    ]);
    franchiseJobs.resetCooldown();

    const job = importJobs.startImport(userKey, {
      autoEnrich: false,
      autoPersonnel: false,
      autoFranchise: true,
      franchiseOptions: {
        fetchImpl: async () => jsonResponse(fixture),
        stateStore: memoryStore(),
        pauseMs: 0,
        lockWaitMs: 0,
      },
    });
    await importJobs.whenIdle();
    await franchiseJobs.whenIdle();

    const status = importJobs.getStatus(job.jobId);
    assert.ok(status.franchiseJobId, 'import reports the franchise job id');
    assert.match(status.franchiseJobId, /^games-franchise-/);
    assert.equal(status.franchiseSkipped, null);
    const franchiseStatus = franchiseJobs.getStatus(status.franchiseJobId);
    assert.equal(franchiseStatus.status, 'done');
    assert.equal(franchiseStatus.updated, 1);
    assert.ok(franchise.readLinksDoc(292030));
  });
  after(() => env.resetMutableState());
});


describe('games-secondary-model', () => {
  /**
   * Secondary-library **model** (U10): identity, cross-store union, title/edition
   * matching.
   *
   * Merged from three model suites — one model, one file. Every assertion of the
   * three files is kept; each block is scoped so the helper names cannot clash.
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
  const gogCache = require('../server/games/gog-cache');
  const epicCache = require('../server/games/epic-cache');
  const { buildSecondaryUnion, genreNames } = require('../server/games/secondary/union');
  const { yearOfDate } = require('../server/games/secondary/normalize');
  const { buildGamesStatsFromCache } = require('../server/games/stats');
  const { buildBridgeQuery, parseBridgeResponse } = require('../server/games/secondary/bridge');
  const { collectSlugs } = require('../server/games/secondary/identity');
  const identity = require('../server/games/secondary');
  const { normalizeTitle, normalizeSlug, buildGogUnion } = require('../server/games/secondary/identity');

  /* ---- cross-store union ---- */
  {const STEAM_ID = '76561198000000021';
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
      // No P577 statement in this answer: the identity is still recorded and the
      // date is an explicit `null` (a settled «WD knows no date»), never a fake.
      assert.deepEqual(entries['gog:the_witcher_3_wild_hunt'], {
        qid: 'Q4267401',
        appid: '292030',
        store: 'gog',
        releaseYear: null,
        releasePrecision: null,
        releaseDate: null,
        releaseDateSource: null,
      });
      // A row without an appid still records the QID (honest partial answer).
      assert.deepEqual(entries['gog:the_witcher_3_wild_hunt_expansion'], {
        qid: 'Q4267401',
        appid: null,
        store: 'gog',
        releaseYear: null,
        releasePrecision: null,
        releaseDate: null,
        releaseDateSource: null,
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

  }

  /* ---- identity bridge ---- */
  {
  const RESPONSE = {
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
          store: { value: 'epic' },
          slug: { value: 'the-witcher-3-wild-hunt' },
          appid: { value: '292030' },
        },
      ],
    },
  };

  function fakeFetch(handler) {
    const calls = [];
    const impl = async (url, init) => {
      calls.push({ url, init, body: init && init.body ? String(init.body) : '' });
      return handler(url, init, calls.length);
    };
    impl.calls = calls;
    return impl;
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

  test('secondary identity bridge', async (t) => {
    await t.test('one batch resolves both stores and is cached', async () => {
      const fetchImpl = fakeFetch(() => jsonResponse(RESPONSE));
      const report = await identity.fetchSecondaryLinks(
        { gogSlugs: ['the_witcher_3_wild_hunt'], epicSlugs: ['the-witcher-3-wild-hunt'] },
        { fetchImpl }
      );
      assert.equal(report.queries, 1);
      assert.equal(report.errors.length, 0);
      assert.equal(report.entries['gog:the_witcher_3_wild_hunt'].appid, '292030');
      assert.equal(report.entries['epic:the_witcher_3_wild_hunt'].appid, '292030');
      // POST + SPARQL JSON accept header + the project UA.
      const call = fetchImpl.calls[0];
      assert.equal(call.init.method, 'POST');
      assert.match(call.init.headers.accept, /sparql-results\+json/);
      assert.match(call.init.headers['user-agent'], /kinoboxd/);
      // The cache is readable without a network call.
      const cached = identity.readSecondaryLinks();
      assert.equal(cached['gog:the_witcher_3_wild_hunt'].qid, 'Q4267401');
      assert.ok(fs.existsSync(identity.CACHE_PATH));
    });

    await t.test('a second pass reuses the cache (no request)', async () => {
      const fetchImpl = fakeFetch(() => jsonResponse(RESPONSE));
      const report = await identity.fetchSecondaryLinks(
        { gogSlugs: ['the_witcher_3_wild_hunt'], epicSlugs: [] },
        { fetchImpl }
      );
      assert.equal(fetchImpl.calls.length, 0);
      assert.equal(report.queries, 0);
      assert.equal(report.cached, 1);
    });

    await t.test('a miss is cached honestly as qid:null', async () => {
      const fetchImpl = fakeFetch(() => jsonResponse({ results: { bindings: [] } }));
      const report = await identity.fetchSecondaryLinks(
        { gogSlugs: ['no_such_game'], epicSlugs: [] },
        { fetchImpl }
      );
      assert.deepEqual(report.entries['gog:no_such_game'], {
        qid: null,
        appid: null,
        store: 'gog',
        slug: 'no_such_game',
        // The P577 column is part of the settled shape: a miss has no date and
        // must not be re-asked by the schema heal (`isSettledEntry`).
        releaseYear: null,
        releasePrecision: null,
        releaseDate: null,
        releaseDateSource: null,
      });
    });

    await t.test('a 429/5xx answer is deferred, not a negative verdict', async () => {
      const before = identity.readSecondaryLinks({ allowStale: true });
      const fetchImpl = fakeFetch(() => jsonResponse({}, 429));
      const report = await identity.fetchSecondaryLinks(
        { gogSlugs: ['another_slug'], epicSlugs: [] },
        { fetchImpl }
      );
      assert.equal(report.queries, 1);
      assert.equal(report.skipped, 'rate_limited');
      assert.equal(report.errors[0], 'wd_429');
      const after = identity.readSecondaryLinks({ allowStale: true });
      // Nothing was written for the failed batch.
      assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
    });

    await t.test('a network failure never throws', async () => {
      const fetchImpl = fakeFetch(() => {
        throw new Error('ECONNRESET');
      });
      const report = await identity.fetchSecondaryLinks(
        { gogSlugs: ['yet_another'], epicSlugs: [] },
        { fetchImpl }
      );
      assert.equal(report.skipped, 'network');
      assert.match(report.errors[0], /wd_network/);
    });

    await t.test('slugs are chunked by 450 per request', async () => {
      const slugs = Array.from({ length: 460 }, (_, index) => `game_${index}`);
      const fetchImpl = fakeFetch(() => jsonResponse({ results: { bindings: [] } }));
      const report = await identity.fetchSecondaryLinks({ gogSlugs: slugs, epicSlugs: [] }, {
        fetchImpl,
        force: true,
      });
      assert.equal(report.queries, 2);
      assert.equal(fetchImpl.calls.length, 2);
    });

    await t.test('the query uses the raw Epic slug (dashes), the cache key does not', async () => {
      // Live shape (verified 01.11.2026): P6278 is `the-witcher-3-wild-hunt`
      // while P2725 is `game/the_witcher_3_wild_hunt`. Sending the normalised
      // `the_witcher_3_wild_hunt` to P6278 matches nothing — the 0-hit bug this
      // test pins.
      const fetchImpl = fakeFetch((url, init) => {
        assert.match(String(init.body), /the-witcher-3-wild-hunt/);
        assert.equal(String(init.body).includes('"the_witcher_3_wild_hunt"'), false);
        return jsonResponse(RESPONSE);
      });
      const report = await identity.fetchSecondaryLinks(
        { gogSlugs: ['the_witcher_3_wild_hunt'], epicSlugs: ['the-witcher-3-wild-hunt'] },
        { fetchImpl, force: true }
      );
      // One cache key per store, both normalised for lookup.
      assert.equal(report.entries['epic:the_witcher_3_wild_hunt'].appid, '292030');
    });

    await t.test('title query is exact-literal, class-restricted and never a SEARCH call', () => {
      const query = identity.buildTitleQuery(['Alan Wake 2']);
      // The store says «2», Wikidata usually says «II» — both are exact VALUES.
      assert.match(query, /"Alan Wake 2"@en/);
      assert.match(query, /"Alan Wake II"@en/);
      assert.match(query, /VALUES \?matched/);
      assert.match(query, /rdfs:label \?matched/);
      assert.match(query, /skos:altLabel \?matched/);
      assert.match(query, /wdt:P31\/wdt:P279\* wd:Q7889/);
      assert.match(query, /p:P577 \?st/);
      // P136 (genre) is an optional label of the already-resolved item — it can
      // never create an identity and adds no unconstrained scan.
      assert.match(query, /wdt:P136 \?genre/);
      assert.match(query, /wikibase:label/);
      assert.doesNotMatch(query, /mwapi|SEARCH/i);
      // No title → no query, never an unconstrained scan.
      assert.equal(identity.buildTitleQuery([]), null);
    });

    await t.test('P136 labels become a curated genre line, never a bucket chip', () => {
      // Live WDQS answer for Alan Wake 2 (Q108417001, 03.11.2026): «survival
      // horror», «third-person shooter». A row per genre; duplicates and store
      // buckets are dropped.
      const entries = identity.parseTitleResponse(
        {
          results: {
            bindings: [
              {
                item: { value: 'http://www.wikidata.org/entity/Q108417001' },
                matched: { value: 'Alan Wake II' },
                date: { value: '2023-10-27T00:00:00Z' },
                precision: { value: '11' },
                genreLabel: { value: 'survival horror' },
              },
              {
                item: { value: 'http://www.wikidata.org/entity/Q108417001' },
                matched: { value: 'Alan Wake II' },
                genreLabel: { value: 'third-person shooter' },
              },
              {
                item: { value: 'http://www.wikidata.org/entity/Q108417001' },
                matched: { value: 'Alan Wake II' },
                genreLabel: { value: 'survival horror' },
              },
              {
                item: { value: 'http://www.wikidata.org/entity/Q108417001' },
                matched: { value: 'Alan Wake II' },
                genreLabel: { value: 'video game' },
              },
              {
                item: { value: 'http://www.wikidata.org/entity/Q108417001' },
                matched: { value: 'Alan Wake II' },
                genreLabel: { value: 'Public' },
              },
            ],
          },
        },
        [{ store: 'epic', slug: 'alan-wake-2', title: 'Alan Wake 2' }]
      );
      assert.deepEqual(entries['epic:alan_wake_2'].genres, [
        'Survival horror',
        'Third-person shooter',
      ]);
      assert.equal(entries['epic:alan_wake_2'].releaseYear, 2023);
    });

    await t.test('wikidataGenreName strips only the generic suffix and capitalizes', () => {
      assert.equal(identity.wikidataGenreName('survival horror'), 'Survival horror');
      assert.equal(identity.wikidataGenreName('role-playing video game'), 'Role-playing');
      assert.equal(identity.wikidataGenreName('action-adventure game'), 'Action-adventure');
      assert.equal(identity.wikidataGenreName('video game'), null);
      assert.equal(identity.wikidataGenreName(''), null);
    });

    await t.test('a unique exact-title match is stored in the title map with honest provenance', () => {
      const entries = identity.parseTitleResponse(
        {
          results: {
            bindings: [
              {
                item: { value: 'http://www.wikidata.org/entity/Q108417001' },
                matched: { value: 'Alan Wake II' },
                date: { value: '2023-10-27T00:00:00Z' },
                precision: { value: '11' },
              },
            ],
          },
        },
        [{ store: 'epic', slug: 'alan-wake-2', title: 'Alan Wake 2' }]
      );
      assert.deepEqual(entries['epic:alan_wake_2'], {
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
        genres: [],
      });
    });

    await t.test('two different QIDs for an exact title are not linked', () => {
      const entries = identity.parseTitleResponse(
        {
          results: {
            bindings: [
              {
                item: { value: 'http://www.wikidata.org/entity/Q100' },
                matched: { value: 'Prey' },
              },
              {
                item: { value: 'http://www.wikidata.org/entity/Q200' },
                matched: { value: 'Prey' },
              },
            ],
          },
        },
        [{ store: 'epic', slug: 'prey', title: 'Prey' }]
      );
      const entry = entries['epic:prey'];
      assert.equal(entry.qid, null, 'ambiguity is never resolved by picking one');
      assert.equal(entry.titleMatched, 'ambiguous');
      assert.equal(entry.confidence, 'none');
      assert.equal(entry.releaseYear, null);
    });

    await t.test('an ambiguous title has no genre line either', () => {
      const entries = identity.parseTitleResponse(
        {
          results: {
            bindings: [
              {
                item: { value: 'http://www.wikidata.org/entity/Q100' },
                matched: { value: 'Prey' },
                genreLabel: { value: 'first-person shooter' },
              },
              {
                item: { value: 'http://www.wikidata.org/entity/Q200' },
                matched: { value: 'Prey' },
                genreLabel: { value: 'immersive sim' },
              },
            ],
          },
        },
        [{ store: 'epic', slug: 'prey', title: 'Prey' }]
      );
      assert.deepEqual(entries['epic:prey'].genres, []);
    });

    await t.test('a legacy title entry (no genres key) is re-asked once and then settled', async () => {
      // Schema 3 wrote year-only entries. Without this upgrade path a cached
      // Alan Wake 2 answer would keep its bucket genre until the 30-day TTL.
      identity.writeCache(
        {},
        {
          titleEntries: {
            'epic:aw2_legacy': {
              qid: 'Q108417001',
              appid: null,
              store: 'epic',
              slug: 'aw2-legacy',
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
      const fetchImpl = fakeFetch(() =>
        jsonResponse({
          results: {
            bindings: [
              {
                item: { value: 'http://www.wikidata.org/entity/Q108417001' },
                matched: { value: 'Alan Wake II' },
                date: { value: '2023-10-27T00:00:00Z' },
                precision: { value: '11' },
                genreLabel: { value: 'survival horror' },
              },
            ],
          },
        })
      );
      const report = await identity.fetchSecondaryTitleLinks(
        {
          epicGames: [
            {
              slug: 'aw2-legacy',
              title: 'Alan Wake 2',
              releaseYear: 2023,
              genres: [],
            },
          ],
        },
        { fetchImpl }
      );
      assert.equal(report.queries, 1);
      assert.deepEqual(report.titleEntries['epic:aw2_legacy'].genres, ['Survival horror']);
      // Written back with the key → settled, no second request.
      const again = await identity.fetchSecondaryTitleLinks(
        {
          epicGames: [
            { slug: 'aw2-legacy', title: 'Alan Wake 2', releaseYear: 2023, genres: [] },
          ],
        },
        { fetchImpl }
      );
      assert.equal(again.queries, 0);
      assert.equal(fetchImpl.calls.length, 1);
    });

    await t.test('the genre axis is only judged when the caller knows it', () => {
      // The Epic import passes no `genres` key: its candidates stay year-driven.
      assert.deepEqual(
        identity.collectTitleCandidates([
          { slug: 'dated', title: 'Dated', releaseDate: '2023-10-27' },
        ]),
        []
      );
      // The details job reads the cached document, so an empty genre line with a
      // known year is a candidate (the «Public» bucket case).
      assert.deepEqual(
        identity.collectTitleCandidates([
          { slug: 'bucket', title: 'Bucket', releaseYear: 2023, genres: [] },
        ]),
        [{ store: 'epic', slug: 'bucket', title: 'Bucket' }]
      );
      assert.deepEqual(
        identity.collectTitleCandidates([
          { slug: 'complete', title: 'Complete', releaseYear: 2023, genres: ['Horror'] },
        ]),
        []
      );
    });

    await t.test('the title pass caches into titleEntries, not into the P6278 entries', async () => {
      const fetchImpl = fakeFetch(() =>
        jsonResponse({
          results: {
            bindings: [
              {
                item: { value: 'http://www.wikidata.org/entity/Q108417001' },
                matched: { value: 'Alan Wake II' },
                date: { value: '2023-10-27T00:00:00Z' },
                precision: { value: '11' },
              },
            ],
          },
        })
      );
      const report = await identity.fetchSecondaryTitleLinks(
        { epicGames: [{ slug: 'aw2-title-cache', title: 'Alan Wake 2' }] },
        { fetchImpl, force: true }
      );
      assert.equal(report.queries, 1);
      assert.equal(report.resolved, 1);
      assert.equal(fetchImpl.calls.length, 1);
      // The query is the title query, not the P6278 bridge query.
      assert.equal(String(fetchImpl.calls[0].body).includes('P6278'), false);
      assert.match(String(fetchImpl.calls[0].body), /skos%3AaltLabel|skos:altLabel/);
      const titleLinks = identity.readSecondaryTitleLinks();
      assert.equal(titleLinks['epic:aw2_title_cache'].qid, 'Q108417001');
      assert.equal(titleLinks['epic:aw2_title_cache'].matchedBy, 'title');
      // It did not fabricate a trustworthy slug identity.
      assert.equal(identity.readSecondaryLinks()['epic:aw2_title_cache'], undefined);

      // Fresh miss/answer is not re-asked.
      const again = await identity.fetchSecondaryTitleLinks(
        { epicGames: [{ slug: 'aw2-title-cache', title: 'Alan Wake 2' }] },
        { fetchImpl }
      );
      assert.equal(again.queries, 0);
      assert.equal(fetchImpl.calls.length, 1);
    });

    await t.test('refreshForJob is skipped for an injected client and for a disabled pass', async () => {
      assert.deepEqual(
        await identity.refreshForJob({
          gogProducts: [{ slug: 'x' }],
          options: { client: { fake: true } },
        }),
        { skipped: 'injected_client' }
      );
      assert.deepEqual(
        await identity.refreshForJob({
          gogProducts: [{ slug: 'x' }],
          options: { wikidata: false },
        }),
        { skipped: 'disabled' }
      );
      assert.deepEqual(await identity.refreshForJob({ gogProducts: [], options: {} }), {
        skipped: 'no_slugs',
      });
    });

    await t.test('refreshForJob reports what it asked for', async () => {
      const fetchImpl = fakeFetch(() => jsonResponse(RESPONSE));
      const report = await identity.refreshForJob({
        gogProducts: [{ slug: 'the_witcher_3_wild_hunt' }],
        epicGames: [{ slug: 'the-witcher-3-wild-hunt' }],
        options: { fetchImpl, force: true },
      });
      assert.equal(report.gogSlugs, 1);
      assert.equal(report.epicSlugs, 1);
      assert.equal(report.queries, 1);
      assert.equal(report.skipped, null);
      assert.deepEqual(report.errors, []);
    });

    await t.test('refreshForJob asks the title pass only for a date-less Epic work', async () => {
      const fetchImpl = fakeFetch((url, init) => {
        const body = String(init.body);
        if (body.includes('P6278')) return jsonResponse({ results: { bindings: [] } });
        if (body.includes('P577')) {
          return jsonResponse({
            results: {
              bindings: [
                {
                  item: { value: 'http://www.wikidata.org/entity/Q108417001' },
                  matched: { value: 'Alan Wake II' },
                  date: { value: '2023-10-27T00:00:00Z' },
                  precision: { value: '11' },
                },
              ],
            },
          });
        }
        return jsonResponse({ results: { bindings: [] } });
      });
      const report = await identity.refreshForJob({
        epicGames: [{ slug: 'aw2-title-job', title: 'Alan Wake 2' }],
        options: { fetchImpl, force: true },
      });
      assert.equal(report.epicTitles, 1);
      assert.equal(report.queries, 2);
      assert.equal(report.titleQueries, 1);
      assert.equal(report.titleResolved, 1);
      assert.equal(identity.readSecondaryTitleLinks()['epic:aw2_title_job'].qid, 'Q108417001');
      // A work with a store date is not even considered for the title pass.
      const dated = identity.collectTitleCandidates([
        { slug: 'aw2-title-job', title: 'Alan Wake 2', releaseDate: '2023-10-27' },
        { slug: 'aw2-title-job', title: 'Alan Wake 2', releaseYear: 2023 },
      ]);
      assert.deepEqual(dated, []);
    });
  });

  }

  /* ---- GOG union / title model ---- */
  {
  function steamWorks() {
    return [
      {
        workKey: 'steam:292030',
        minutes: 6000,
        primary: { appid: 292030, name: 'The Witcher 3: Wild Hunt' },
        games: [
          { appid: 292030, name: 'The Witcher 3: Wild Hunt', playtime_forever: 6000 },
          { appid: 378648, name: 'The Witcher 3: Wild Hunt - GOTY', playtime_forever: 0 },
        ],
      },
      {
        workKey: 'steam:1091500',
        minutes: 3000,
        primary: { appid: 1091500, name: 'Cyberpunk 2077' },
        games: [{ appid: 1091500, name: 'Cyberpunk 2077', playtime_forever: 3000 }],
      },
      {
        workKey: 'steam:620',
        minutes: 120,
        primary: { appid: 620, name: 'Portal 2' },
        games: [{ appid: 620, name: 'Portal 2', playtime_forever: 120 }],
      },
    ];
  }

  test('GOG union', async (t) => {
    await t.test('normalizes titles and slugs across stores', () => {
      assert.equal(
        normalizeTitle('The Witcher 3: Wild Hunt — Game of the Year Edition'),
        'the witcher 3 wild hunt'
      );
      assert.equal(normalizeTitle('Cyberpunk 2077: Ultimate Edition'), 'cyberpunk 2077');
      assert.equal(normalizeTitle('Pokémon™ & Co.'), 'pokemon and co');
      assert.equal(normalizeSlug('game/the_witcher_3_wild_hunt'), 'the_witcher_3_wild_hunt');
      assert.equal(normalizeSlug('the-witcher-3-wild-hunt'), 'the_witcher_3_wild_hunt');
    });

    await t.test('the same game on Steam+GOG is one work with separate hours', () => {
      const union = buildGogUnion({
        products: [
          {
            gogGameId: '1207658924',
            title: 'The Witcher 3: Wild Hunt - Game of the Year Edition',
            slug: 'the_witcher_3_wild_hunt',
          },
        ],
        minutes: { 1207658924: 1200 },
        works: steamWorks(),
        links: { 292030: { gogSlugs: ['game/the_witcher_3_wild_hunt'] } },
      });
      const witcher = union.works.find((work) => work.workKey === 'steam:292030');
      assert.deepEqual(witcher.sources, ['steam', 'gog']);
      assert.deepEqual(witcher.ownedOn, ['steam', 'gog']);
      assert.deepEqual(witcher.storeIds, { steam: 292030, gog: '1207658924', epic: null });
      // Never summed: Steam stays 6000 min, GOG 1200 min.
      assert.equal(witcher.hoursBySource.steam, 6000);
      assert.equal(witcher.hoursBySource.gog, 1200);
      assert.equal(witcher.matchedBy, 'wikidata');
      assert.equal(witcher.confidence, 'high');
      assert.equal(union.summary.secondaryOnlyWorks, 0);
      assert.equal(union.summary.worksTotal, 3);
      assert.equal(union.summary.gogHours, 20);
      // Every Steam edition row inherits the GOG link.
      assert.deepEqual(union.byAppid['292030'].storeIds.gog, '1207658924');
      assert.deepEqual(union.byAppid['378648'].storeIds.gog, '1207658924');
      assert.equal(union.byAppid['292030'].hoursBySource.steam, 6000);
      assert.equal(union.byAppid['292030'].hoursBySource.gog, 1200);
    });

    await t.test('title fallback matches an edition suffix (medium confidence)', () => {
      const union = buildGogUnion({
        products: [
          {
            gogGameId: '1423049311',
            title: 'Cyberpunk 2077: Ultimate Edition',
            slug: 'cyberpunk_2077_ultimate_edition',
          },
        ],
        minutes: { 1423049311: 600 },
        works: steamWorks(),
        links: {},
      });
      const cp = union.works.find((work) => work.workKey === 'steam:1091500');
      assert.deepEqual(cp.sources, ['steam', 'gog']);
      assert.equal(cp.matchedBy, 'title');
      assert.equal(cp.confidence, 'medium');
      assert.equal(union.summary.matchedByTitle, 1);
    });

    await t.test('a GOG-only game is a secondary work and never enters Steam hours', () => {
      const union = buildGogUnion({
        products: [
          { gogGameId: '1999999999', title: 'GOG Exclusive Indie', slug: 'gog_exclusive_indie' },
        ],
        minutes: { 1999999999: 90 },
        works: steamWorks(),
        links: {},
      });
      assert.equal(union.summary.secondaryOnlyWorks, 1);
      assert.equal(union.summary.worksTotal, 4);
      assert.equal(union.summary.gogHours, 1.5);
      assert.equal(union.secondaryWorks.length, 1);
      const only = union.secondaryWorks[0];
      assert.equal(only.workKey, 'gog:1999999999');
      assert.deepEqual(only.sources, ['gog']);
      assert.equal(only.hoursBySource.steam, null);
      assert.equal(only.hoursBySource.gog, 90);
      // No Steam appid was invented.
      assert.deepEqual(union.byAppid, {
        292030: {
          workKey: 'steam:292030',
          sources: ['steam'],
          ownedOn: ['steam'],
          storeIds: { steam: 292030, gog: null, epic: null },
          hoursBySource: { steam: 6000, gog: null, epic: null },
          matchedBy: null,
          confidence: 'single',
        },
        378648: {
          workKey: 'steam:292030',
          sources: ['steam'],
          ownedOn: ['steam'],
          storeIds: { steam: 378648, gog: null, epic: null },
          hoursBySource: { steam: 0, gog: null, epic: null },
          matchedBy: null,
          confidence: 'single',
        },
        1091500: {
          workKey: 'steam:1091500',
          sources: ['steam'],
          ownedOn: ['steam'],
          storeIds: { steam: 1091500, gog: null, epic: null },
          hoursBySource: { steam: 3000, gog: null, epic: null },
          matchedBy: null,
          confidence: 'single',
        },
        620: {
          workKey: 'steam:620',
          sources: ['steam'],
          ownedOn: ['steam'],
          storeIds: { steam: 620, gog: null, epic: null },
          hoursBySource: { steam: 120, gog: null, epic: null },
          matchedBy: null,
          confidence: 'single',
        },
      });
    });

    await t.test('an ambiguous title is not auto-merged', () => {
      const works = [
        { workKey: 'steam:1', minutes: 0, primary: { appid: 1, name: 'Same Name' }, games: [{ appid: 1, name: 'Same Name', playtime_forever: 0 }] },
        { workKey: 'steam:2', minutes: 0, primary: { appid: 2, name: 'Same Name' }, games: [{ appid: 2, name: 'Same Name', playtime_forever: 0 }] },
      ];
      const union = buildGogUnion({
        products: [{ gogGameId: '77', title: 'Same Name', slug: 'same_name' }],
        minutes: { 77: 30 },
        works,
        links: {},
      });
      assert.equal(union.summary.secondaryOnlyWorks, 1);
      assert.equal(union.summary.matchedByTitle, 0);
      assert.equal(union.works.find((work) => work.workKey === 'gog:77').hoursBySource.gog, 30);
    });

    await t.test('GOG editions match by slug only when the slug is the same', () => {
      const union = buildGogUnion({
        products: [
          { gogGameId: '1', title: 'The Witcher 3: Wild Hunt', slug: 'the_witcher_3_wild_hunt' },
          { gogGameId: '2', title: 'The Witcher 3: Wild Hunt - Expansion Pass', slug: 'the_witcher_3_wild_hunt_expansion_pass' },
        ],
        minutes: { 1: 600, 2: 120 },
        works: steamWorks(),
        links: { 292030: { gogSlugs: ['game/the_witcher_3_wild_hunt'] } },
      });
      const witcher = union.works.find((work) => work.workKey === 'steam:292030');
      assert.equal(witcher.hoursBySource.steam, 6000);
      assert.equal(witcher.hoursBySource.gog, 600);
      // The expansion pass does not match the base slug → its own GOG work.
      assert.equal(union.summary.secondaryOnlyWorks, 1);
    });
  });

  }
  after(() => env.resetMutableState());
});
