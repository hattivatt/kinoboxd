'use strict';

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

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-identity-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-identity-state-')
);
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
