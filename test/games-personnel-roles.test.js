'use strict';

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

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-roles-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-roles-state-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = STATE_DIR;
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
