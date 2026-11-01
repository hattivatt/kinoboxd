'use strict';

/**
 * Personnel aggregation (M3, ИГРЫ §5.3/§7): studios first, weights, QID dedup,
 * aliases, ambiguity, coverage, overrides, per-game block, enrichment.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-personnel-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-personnel-state-')
);
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
  const payload = personnel.buildPersonnel(PROFILE, { role: 'studio' });
  assert.ok(payload);
  assert.equal(payload.role, 'studio');
  assert.equal(payload.sort, 'hours');

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
  const payload = personnel.buildPersonnel(PROFILE, { role: 'studio' });
  assert.equal(payload.coverage.gamesTotal, 5);
  assert.equal(payload.coverage.gamesWithDetails, 4);
  assert.equal(payload.coverage.detailsPercent, 80);
  assert.equal(payload.coverage.gamesWithCredits, 4);
  assert.equal(payload.coverage.percent, 80);
  assert.equal(payload.coverage.byRole.composer, 4);
  assert.equal(payload.coverage.byRole.designer, 3);
  assert.equal(payload.coverage.byRole.director, 1);
  assert.equal(payload.pending.details, 1);
  assert.equal(payload.pending.credits, 1);
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
