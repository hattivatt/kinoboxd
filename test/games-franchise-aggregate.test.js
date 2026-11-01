'use strict';

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

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-franchise-agg-')
);
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-franchise-agg-state-')
);

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
