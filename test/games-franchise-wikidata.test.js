'use strict';

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

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-franchise-')
);
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-franchise-state-')
);

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
