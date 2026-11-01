'use strict';

/**
 * `/api/games/personnel` + `POST /api/games/override` route contract (M3).
 * Mounted on a throwaway express app on an ephemeral port (no fixed 7041
 * collision); no live network, no Steam/WDQS/Moby calls.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-personnel-routes-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-personnel-routes-state-')
);
process.env.KINOBOXD_MOBY_KEY_FILE = path.join(
  process.env.KINOBOXD_STATE_DIR,
  'no-moby-token'
);
// This file pins the payload/route contract only: the lazy WD pass is covered
// by `games-personnel-kick.test.js` with an injected provider. Leaving the
// provider on would make the GET below ask the real WDQS.
process.env.KINOBOXD_GAMES_WD = 'off';

const gameCache = require('../server/games/game-cache');
const personnel = require('../server/games/personnel/personnel');
const { createRouter } = require('../server/games/personnel/routes-personnel');

const ID = '76561198000000003';
const PROFILE = `steam-${ID}`;

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
    game_count: 2,
    games: [
      { appid: 292030, name: 'The Witcher 3: Wild Hunt', playtime_forever: 6420 },
      { appid: 999, name: 'No Details Yet', playtime_forever: 600 },
    ],
  });
  fs.mkdirSync(path.join(CACHE_DIR, 'details'), { recursive: true });
  fs.writeFileSync(
    path.join(CACHE_DIR, 'details', '292030.json'),
    JSON.stringify({
      success: true,
      type: 'game',
      developers: ['CD PROJEKT RED'],
      publishers: ['CD PROJEKT RED'],
    })
  );
  await gameCache.saveAchievements(ID, 292030, {
    totalCount: 78,
    unlockedCount: 48,
    fetchedAt: now,
  });
  await personnel.savePersonnelDoc(292030, {
    fetchedAt: now,
    qid: 'Q4267401',
    sources: ['steam-store', 'wikidata'],
    studios: [
      {
        name: 'CD Projekt RED',
        nameEn: 'CD Projekt RED',
        qid: 'Q1172164',
        roles: ['developer', 'publisher'],
        source: 'wikidata',
        roleSource: 'wikidata',
      },
    ],
    people: [
      {
        name: 'Marcin Przybyłowicz',
        nameEn: 'Marcin Przybyłowicz',
        nameRu: 'Марцин Пшибылович',
        qid: 'Q19005369',
        roles: ['composer'],
        source: 'wikidata',
        roleSource: 'wikidata',
      },
    ],
  });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/games', createRouter());
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error('[test] unhandled', err);
    res.status(500).json({ error: 'internal', code: 'internal_error' });
  });
  return app;
}

let server;
let base;

test.before(async () => {
  await seed();
  server = buildApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
});

test('GET /api/games/personnel: §5.3 shape, developer by default', async () => {
  const response = await fetch(`${base}/api/games/personnel?profile=${PROFILE}`);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('x-games-personnel-build-ms'));
  assert.equal(response.headers.get('x-games-personnel-pending'), '1');
  const body = await response.json();

  assert.equal(body.profile, PROFILE);
  assert.equal(body.role, 'developer');
  assert.equal(body.roleRequested, 'developer');
  assert.equal(body.roleAlias, null);
  assert.equal(body.roles.default, 'developer');
  assert.equal(body.sort, 'hours');
  assert.ok(Array.isArray(body.items));
  assert.ok(body.items.length >= 1);
  const cdpr = body.items.find((item) => item.name === 'CD PROJEKT RED');
  assert.ok(cdpr);
  assert.equal(cdpr.id, 'wd:Q1172164');
  assert.equal(cdpr.qid, 'Q1172164');
  assert.deepEqual(cdpr.roles.sort(), ['developer', 'publisher']);
  assert.equal(cdpr.count, 1);
  assert.equal(cdpr.hours, 107);
  assert.equal(cdpr.hoursShare, Math.round((107 / 117) * 10000) / 10000);
  assert.equal(cdpr.avgCompletion, 62);
  assert.deepEqual(cdpr.games, [{ appid: 292030, name: 'The Witcher 3: Wild Hunt', hours: 107 }]);
  assert.deepEqual(cdpr.sources, ['steam-store', 'wikidata']);
  assert.equal(cdpr.ambiguous, false);

  assert.equal(body.coverage.gamesTotal, 2);
  assert.equal(body.coverage.gamesWithDetails, 1);
  assert.equal(body.coverage.gamesWithCredits, 1);
  assert.equal(body.coverage.percent, 50);
  assert.equal(body.pending.details, 1);
  assert.equal(body.pending.credits, 1);
  assert.equal(body.pending.running, false);
  // WD is switched off in this file (see the env line above): the route says
  // why nothing will arrive instead of pretending the data is complete.
  assert.equal(body.pending.reason, 'sources_disabled');
  assert.equal(body.coverage.wikidata.state, 'disabled');
  assert.equal(body.coverage.wikidata.badge, 'WD: выключено');
  assert.equal(body.sources.mobygames.enabled, false);
  assert.equal(body.sources.mobygames.reason, 'key_missing');
  assert.equal(body.meta.libraryPartial, false);
});

test('role=studio is the documented alias, role=publisher is a separate answer', async () => {
  const aliased = await (await fetch(`${base}/api/games/personnel?profile=${PROFILE}&role=studio`)).json();
  assert.equal(aliased.role, 'developer');
  assert.equal(aliased.roleRequested, 'studio');
  assert.equal(aliased.roleAlias, 'studio');
  assert.ok(aliased.items.some((item) => item.name === 'CD PROJEKT RED'));

  const publishers = await (
    await fetch(`${base}/api/games/personnel?profile=${PROFILE}&role=publisher`)
  ).json();
  assert.equal(publishers.role, 'publisher');
  for (const item of publishers.items) assert.ok(item.roles.includes('publisher'));
});

test('GET role=composer returns people, not studios', async () => {
  const response = await fetch(`${base}/api/games/personnel?profile=${PROFILE}&role=composer`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.role, 'composer');
  assert.equal(body.items.length, 1);
  const marcin = body.items[0];
  assert.equal(marcin.name, 'Marcin Przybyłowicz');
  assert.deepEqual(marcin.roles, ['composer']);
  assert.ok(marcin.aliases.includes('Марцин Пшибылович'));
  assert.equal(marcin.avgCompletion, 62);
});

test('strict query contract: role/sort/limit/unknown parameter', async () => {
  const invalidRole = await fetch(`${base}/api/games/personnel?profile=${PROFILE}&role=wizard`);
  assert.equal(invalidRole.status, 400);
  assert.equal((await invalidRole.json()).code, 'invalid_role');

  const invalidSort = await fetch(`${base}/api/games/personnel?profile=${PROFILE}&sort=magic`);
  assert.equal(invalidSort.status, 400);
  assert.equal((await invalidSort.json()).code, 'invalid_sort');

  const invalidLimit = await fetch(`${base}/api/games/personnel?profile=${PROFILE}&limit=500`);
  assert.equal(invalidLimit.status, 400);
  assert.equal((await invalidLimit.json()).code, 'invalid_limit');

  const extra = await fetch(`${base}/api/games/personnel?profile=${PROFILE}&sources=all`);
  assert.equal(extra.status, 400);
  assert.equal((await extra.json()).code, 'unexpected_parameter');

  const missing = await fetch(`${base}/api/games/personnel`);
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, 'profile_required');

  const unknown = await fetch(`${base}/api/games/personnel?profile=steam-76561198000000999`);
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).code, 'unknown_profile');

  const notImported = await fetch(`${base}/api/games/personnel?profile=steam-12345`);
  assert.equal(notImported.status, 400);
  assert.equal((await notImported.json()).code, 'invalid_profile');
});

test('POST /api/games/override writes the file and the next payload applies it', async () => {
  const response = await fetch(`${base}/api/games/override`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'person',
      action: 'alias',
      from: 'Марцин Пшибылович',
      to: 'Marcin Przybyłowicz',
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.type, 'person');
  assert.equal(body.action, 'alias');
  assert.equal(body.overrides.aliases, 1);

  const file = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'personnel-overrides.json'), 'utf8'));
  assert.equal(file.manual.aliases.length, 1);
  assert.equal(file.manual.aliases[0].alias, 'Марцин Пшибылович');

  const invalid = await fetch(`${base}/api/games/override`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'wizard', action: 'merge', from: 'a', to: 'b' }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, 'invalid_override_type');
});
