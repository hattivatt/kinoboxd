'use strict';

/**
 * Per-film taxonomy blacklist (`cache/flags/taxonomy-blacklist.json`).
 *
 * A rule is global: one TMDB keyword widens a bucket for the whole corpus, so a
 * false positive used to be fixable only by weakening the rule. The blacklist
 * removes a category/period from ONE slug. These tests pin the tolerance rules
 * (missing/empty/broken JSON = empty blacklist) and the locality of the effect:
 * the neighbouring film keeps its counts and the payload shape does not move.
 *
 * Order matters: the tmp cache roots are set BEFORE the first `server/**`
 * require, because those modules bake their roots in at load time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const env = require('./helpers/env');
const tmp = env.makeTmpCache('films-taxonomy-blacklist', { budgets: true });

const taxonomy = require('../server/taxonomy');

const FILMS = [
  { slug: 'a-zombie', rating: 7, year: 2004, keywords: ['zombie'] },
  { slug: 'b-zombie-kaiju', rating: 8, year: 2005, keywords: ['zombie', 'kaiju'] },
  { slug: 'c-noir', rating: 9, year: 1950, keywords: ['film noir'] },
  { slug: 'd-expressionism', rating: 6, year: 1920, keywords: ['german expressionism'] },
];

function blacklistPath() {
  return path.join(tmp.cacheDir, 'flags', 'taxonomy-blacklist.json');
}

function writeBlacklist(value) {
  const file = blacklistPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return file;
}

function removeBlacklist() {
  fs.rmSync(blacklistPath(), { force: true });
}

function countOf(section, key) {
  const bucket = section.find((entry) => entry.key === key);
  return bucket ? bucket.count : 0;
}

function keysOf(section) {
  return section.map((entry) => entry.key);
}

test.after(() => {
  tmp.cleanup();
  env.cleanupTmpDirs();
});

test('blacklist lives at <films cache>/flags/taxonomy-blacklist.json', () => {
  assert.equal(taxonomy.BLACKLIST_PATH, blacklistPath());
});

test('missing file: empty blacklist, counts identical to a build without the option', () => {
  removeBlacklist();

  const read = taxonomy.readBlacklist();
  assert.deepEqual(read.keys, []);
  assert.deepEqual(read.ignored, []);
  assert.equal(read.bySlug.size, 0);

  const plain = taxonomy.buildTaxonomy(FILMS);
  const withBlacklist = taxonomy.buildTaxonomy(FILMS, { blacklist: taxonomy.readBlacklist() });
  assert.deepEqual(withBlacklist, plain);
  assert.equal(countOf(plain.categories, 'zombie'), 2);
  assert.equal(countOf(plain.categories, 'kaiju'), 1);
  assert.equal(countOf(plain.periods, 'film-noir'), 1);
});

test('empty file and wrong shape: empty blacklist, no throw', () => {
  writeBlacklist('');
  assert.equal(taxonomy.readBlacklist().bySlug.size, 0);

  writeBlacklist({ version: 1, films: ['a-zombie'] });
  assert.equal(taxonomy.readBlacklist().bySlug.size, 0);

  writeBlacklist({ version: 1, films: { 'a-zombie': 'zombie' } });
  assert.equal(taxonomy.readBlacklist().bySlug.size, 0);

  removeBlacklist();
});

test('valid document: only the listed slug loses the category', () => {
  writeBlacklist({ version: 1, films: { 'a-zombie': ['zombie'] } });

  const read = taxonomy.readBlacklist();
  assert.deepEqual(read.keys, ['zombie']);
  assert.deepEqual(read.ignored, []);
  assert.deepEqual([...read.bySlug.keys()], ['a-zombie']);
  assert.deepEqual([...read.bySlug.get('a-zombie')], ['zombie']);

  const result = taxonomy.buildTaxonomy(FILMS, { blacklist: read });
  assert.equal(countOf(result.categories, 'zombie'), 1);
  const zombie = result.categories.find((entry) => entry.key === 'zombie');
  assert.deepEqual(zombie.films, ['b-zombie-kaiju']);

  // Neighbour untouched: its own keyword plus the shared one.
  assert.equal(countOf(result.categories, 'kaiju'), 1);
  assert.deepEqual(
    result.categories.find((entry) => entry.key === 'kaiju').films,
    ['b-zombie-kaiju']
  );

  // Origins are never blacklisted: every film still has exactly one.
  assert.equal(
    result.origins.reduce((sum, entry) => sum + entry.count, 0),
    FILMS.length
  );

  removeBlacklist();
});

test('unknown key: nothing removed, key reported in ignored', () => {
  writeBlacklist({ version: 1, films: { 'a-zombie': ['zombie', 'zombi'] } });

  const read = taxonomy.readBlacklist();
  assert.deepEqual(read.keys, ['zombie']);
  assert.deepEqual(read.ignored, ['zombi']);

  const withTypo = taxonomy.buildTaxonomy(FILMS, { blacklist: read });
  const onlyValid = taxonomy.buildTaxonomy(FILMS, {
    blacklist: { version: 1, films: { 'a-zombie': ['zombie'] } },
  });
  assert.deepEqual(withTypo, onlyValid);

  writeBlacklist({ version: 1, films: { 'a-zombie': ['zombi'] } });
  const typoOnly = taxonomy.readBlacklist();
  assert.deepEqual(typoOnly.ignored, ['zombi']);
  assert.equal(typoOnly.bySlug.size, 0);
  assert.deepEqual(taxonomy.buildTaxonomy(FILMS, { blacklist: typoOnly }), taxonomy.buildTaxonomy(FILMS));

  removeBlacklist();
});

test('broken JSON: empty blacklist, no exception', () => {
  writeBlacklist('{"version":1,"films":{"a-zombie":[');

  const read = taxonomy.readBlacklist();
  assert.equal(read.bySlug.size, 0);
  assert.deepEqual(read.keys, []);
  assert.deepEqual(read.ignored, []);

  const result = taxonomy.buildTaxonomy(FILMS, { blacklist: read });
  assert.equal(countOf(result.categories, 'zombie'), 2);

  removeBlacklist();
});

test('periods can be blacklisted too, categories stay untouched', () => {
  writeBlacklist({ version: 1, films: { 'd-expressionism': ['german-expressionism'] } });

  const result = taxonomy.buildTaxonomy(FILMS, { blacklist: taxonomy.readBlacklist() });
  assert.equal(countOf(result.periods, 'german-expressionism'), 0);
  assert.deepEqual(keysOf(result.periods), ['film-noir']);
  // The film keeps every category: a period-only key cannot touch them.
  assert.equal(countOf(result.categories, 'zombie'), 2);
  assert.equal(countOf(result.categories, 'film-noir'), 1);

  removeBlacklist();
});

test('a key that is both a category and a period removes both', () => {
  writeBlacklist({ version: 1, films: { 'c-noir': ['film-noir'] } });

  const result = taxonomy.buildTaxonomy(FILMS, { blacklist: taxonomy.readBlacklist() });
  assert.equal(countOf(result.periods, 'film-noir'), 0);
  assert.equal(countOf(result.categories, 'film-noir'), 0);
  // Neighbours keep their counts.
  assert.equal(countOf(result.categories, 'zombie'), 2);

  removeBlacklist();
});
