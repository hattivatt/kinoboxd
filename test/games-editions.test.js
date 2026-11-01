'use strict';

/**
 * M5-B edition matching: title normalization, false-positive guards, Wikidata
 * QID merge, manual overrides and the persisted `cache-games/editions.json`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-editions-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-editions-state-')
);

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
