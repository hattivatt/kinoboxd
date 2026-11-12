'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const env = require('./helpers/env');
const run = env.makeTmpCache('books-quality');
process.on('exit', () => env.cleanupTmpDirs());

process.env.KINOBOXD_CACHE_BOOK_DIR = run.cacheBookDir;

const bookCache = require('../server/books/book-cache');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'books-quality.js');

function profileDoc(source, userKey, events) {
  return {
    schemaVersion: 1,
    source,
    userKey,
    sourceUserId: null,
    importedAt: '2026-11-01T00:00:00.000Z',
    events,
    warnings: [],
  };
}

async function seedQualityFixture() {
  await bookCache.saveDetails(900, {
    schemaVersion: 1,
    hcWorkId: 900,
    title: 'Дюна',
    authors: [{ hcId: 1, name: 'Фрэнк Герберт' }],
    genres: ['Фантастика'],
    series: [],
    pages: 400,
    publicationYear: 1984,
    firstPublishedYear: 1965,
    firstPublishedYearSource: 'wikidata',
    publisher: 'Издательство',
    partial: false,
  });
  await bookCache.saveLink('701', {
    schemaVersion: 2,
    livelibBookId: '701',
    workId: 'hc:900',
    method: 'isbn',
    score: 1,
    evidence: { isbn: '9785172222222' },
  });
  await bookCache.saveLink('702', {
    schemaVersion: 2,
    livelibBookId: '702',
    workId: 'hc:901',
    method: 'title-author-fuzzy',
    score: 0.72,
    evidence: { isbn: null },
  });
  await bookCache.saveLink('999', {
    schemaVersion: 2,
    livelibBookId: '999',
    workId: 'hc:901',
    method: 'isbn',
    score: 1,
    evidence: {},
  });
  await bookCache.saveProfile(
    'livelib',
    'QualityProbe',
    profileDoc('livelib', 'QualityProbe', [
      {
        id: 'll:701',
        sourceBookId: '701',
        title: 'Дюна',
        authors: ['Фрэнк Герберт'],
        rating: 8,
        ratingScale: 10,
        status: 'read',
        finishedAt: '2024-01-01',
        isbn13: '9785171111111',
      },
      {
        id: 'll:702',
        sourceBookId: '702',
        title: 'Дюна',
        authors: ['Фрэнк Герберт'],
        status: 'read',
        finishedAt: '2024-01-02',
      },
      {
        id: 'll:703',
        sourceBookId: '703',
        title: 'Witcher',
        authors: ['Andrzej Sapkowski'],
        status: 'read',
        finishedAt: '2024-02-01',
        origin: 'livelib-file',
        shelf: 'read',
        edition: { series: 'Witcher', year: 1990 },
      },
      {
        id: 'll:704',
        sourceBookId: '704',
        title: 'Witcher. The Last Wish',
        authors: ['Andrzej Sapkowski'],
        status: 'read',
        finishedAt: '2024-02-02',
        origin: 'livelib-file',
        shelf: 'read',
        edition: { series: 'Witcher (Publication order)', year: 1993 },
      },
    ])
  );
  await bookCache.saveProfile(
    'hardcover',
    'QualityProbe',
    profileDoc('hardcover', 'QualityProbe', [
      {
        id: 'hc:read:1',
        sourceBookId: '900',
        workId: 'hc:900',
        title: 'Dune',
        authors: ['Frank Herbert'],
        status: 'read',
        statusId: 3,
        finishedAt: '2023-03-01',
      },
      {
        id: 'hc:read:2',
        sourceBookId: '900',
        workId: 'hc:900',
        title: 'Dune Messiah',
        authors: ['Frank Herbert'],
        status: 'read',
        statusId: 3,
        finishedAt: '2023-03-02',
      },
    ])
  );
  await bookCache.flushIndex();
  await bookCache.flushLinks();
}

function runScript(extraArgs = [], options = {}) {
  return execFileSync(process.execPath, [SCRIPT, '--cache', run.cacheBookDir, ...extraArgs], {
    encoding: 'utf8',
    ...options,
  });
}

test('fixture metrics report the seeded dup, split series and year sources', async () => {
  await seedQualityFixture();
  const report = JSON.parse(runScript(['--json']));
  const livelib = report.profiles['livelib-QualityProbe'];
  assert.ok(livelib, 'livelib profile present');
  assert.ok(livelib.dupGroups >= 1, 'canonical dup group detected');
  assert.ok(livelib.dupExtra >= 1);
  assert.ok(livelib.sameTitleGroups >= 1);
  assert.equal(livelib.series.splitGroups, 1);
  assert.equal(livelib.series.splitSeries, 2);
  assert.ok(livelib.series.defective >= 2);
  assert.equal(livelib.yearSources.first, 1);
  assert.equal(livelib.yearSources.edition, 2);
  assert.equal(livelib.yearSources.none, 1);
  assert.ok(livelib.claimSources.wikidata >= 1);
  assert.ok('(none)' in livelib.claimSources);
  assert.equal(livelib.unresolved, 1);
  assert.equal(report.total.dupGroups >= 1, true);

  const hardcover = report.profiles['hardcover-QualityProbe'];
  assert.equal(hardcover.overMatch.count, 1);
  assert.match(hardcover.overMatch.examples[0], /Dune/i);

  assert.equal(report.links.total, 3);
  assert.equal(report.links.lowScore, 1);
  assert.equal(report.links.isbnMismatch, 1);
  assert.equal(report.links.orphans, 1);
  assert.equal(report.links.methods['title-author-fuzzy'], 1);
  assert.equal(report.links.methods.isbn, 2);
});

test('human-readable output names each profile and exits 0', () => {
  const stdout = runScript();
  assert.match(stdout, /profile livelib-QualityProbe/);
  assert.match(stdout, /profile hardcover-QualityProbe/);
  assert.match(stdout, /links total=3/);
  assert.match(stdout, /total works=/);
});

test('empty cache prints zeros and exits 0', () => {
  const emptyDir = env.tmpDir('books-quality-empty');
  const stdout = execFileSync(
    process.execPath,
    [SCRIPT, '--cache', emptyDir, '--json'],
    { encoding: 'utf8' }
  );
  const report = JSON.parse(stdout);
  assert.equal(report.total.works, 0);
  assert.equal(report.total.events, 0);
  assert.equal(report.total.unresolved, 0);
  assert.equal(report.total.dupGroups, 0);
  assert.equal(report.total.yearSources.first, 0);
  assert.deepEqual(report.links, {
    total: 0,
    methods: {},
    lowScore: 0,
    lowScoreExamples: [],
    isbnMismatch: 0,
    isbnMismatchExamples: [],
    orphans: 0,
    orphansExamples: [],
  });
});

test('--json emits a stable top-level key shape', () => {
  const report = JSON.parse(runScript(['--json']));
  assert.deepEqual(Object.keys(report), ['cache', 'profiles', 'links', 'total']);
  const metrics = report.total;
  assert.deepEqual(
    Object.keys(metrics),
    [
      'works',
      'events',
      'unresolved',
      'yearSources',
      'claimSources',
      'dupGroups',
      'dupExtra',
      'dupExamples',
      'sameTitleGroups',
      'sameTitleExamples',
      'series',
      'overMatch',
    ]
  );
  assert.deepEqual(Object.keys(metrics.yearSources), ['first', 'manual', 'edition', 'none']);
  assert.deepEqual(Object.keys(metrics.series), [
    'total',
    'singletons',
    'splitGroups',
    'splitSeries',
    'splitExamples',
    'internalDup',
    'internalDupExamples',
    'mixedScript',
    'mixedScriptExamples',
    'defective',
  ]);
});
