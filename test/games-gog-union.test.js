'use strict';

/**
 * Cross-store union (M6a): one work per `workKey`, hours per source never
 * summed, GOG-only games become secondary works.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeTitle,
  normalizeSlug,
  buildGogUnion,
} = require('../server/games/gog-union');

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
