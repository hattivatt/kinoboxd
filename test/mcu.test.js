'use strict';

/**
 * MCU parent-franchise membership and collection-name cleanup.
 *
 * The membership signal is the static canonical film list (validated against
 * Wikidata P179); cache/mcu.json is an optional superset written by
 * `npm run backfill:mcu`. The selected corpus checks are the same ones used in
 * the live spot-check: Deadpool & Wolverine is in, Sony's Venom and the
 * pre-MCU Spider-Man trilogy are out, TV entries never match.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-mcu-'));
process.env.TMDB_API_TOKEN = 'test-token';

const mcu = require('../server/mcu');
const { __internal: { cleanCollectionName } } = require('../server/stats');

test('MCU membership includes canonical films and excludes Sony spin-offs', () => {
  assert.equal(mcu.isMcuFilm({ imdbId: 'tt6263850', kind: 'movie' }), true); // Deadpool & Wolverine
  assert.equal(mcu.isMcuFilm({ imdbId: 'tt10676048', kind: 'movie' }), true); // The Marvels
  assert.equal(mcu.isMcuFilm({ imdbId: 'tt2250912', kind: 'movie' }), true); // Homecoming
  assert.equal(mcu.isMcuFilm({ imdbId: 'tt1270797', kind: 'movie' }), false); // Venom
  assert.equal(mcu.isMcuFilm({ imdbId: 'tt1431045', kind: 'movie' }), false); // Deadpool (2016)
  assert.equal(mcu.isMcuFilm({ imdbId: 'tt0145487', kind: 'movie' }), false); // Spider-Man (2002)
  assert.equal(mcu.isMcuFilm({ imdbId: 'tt13966962', kind: 'tv' }), false); // Echo (MCU TV)
  // TMDB-id fallback when the IMDb backfill has not populated details yet.
  assert.equal(mcu.isMcuFilm({ tmdbId: 1726, kind: 'movie' }), true); // Iron Man
  assert.equal(mcu.isMcuFilm({ tmdbId: 1003596, kind: 'movie' }), false); // Morbius
});

test('collection display names lose collection suffixes only', () => {
  assert.equal(cleanCollectionName('Гарри Поттер (Коллекция)'), 'Гарри Поттер');
  assert.equal(cleanCollectionName('Миссия невыполнима (Коллекция)'), 'Миссия невыполнима');
  assert.equal(cleanCollectionName('Пираты Карибского моря (Коллекция)'), 'Пираты Карибского моря');
  assert.equal(cleanCollectionName('Сумерки. Сага (Коллекция)'), 'Сумерки. Сага');
  assert.equal(cleanCollectionName('Foo (Mcu Collect)'), 'Foo');
  assert.equal(cleanCollectionName('X Коллекция'), 'X');
  // A bracket that is part of the title, not a suffix, survives.
  assert.equal(cleanCollectionName('Человек-паук [КВМ] (Коллекция)'), 'Человек-паук [КВМ]');
  assert.equal(cleanCollectionName('The Collector (Коллекционер)'), 'The Collector (Коллекционер)');
  assert.equal(cleanCollectionName('Marvel Cinematic Universe'), 'Marvel Cinematic Universe');
});
