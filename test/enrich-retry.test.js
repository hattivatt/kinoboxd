'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-enrich-'));
process.env.KINOBOXD_CACHE_DIR = cacheDir;
process.env.TMDB_API_TOKEN = 'test-token';

const tmdb = require('../server/tmdb');
const enrich = require('../server/enrich');

test('a transport-failed film is retried once and counted', async () => {
  let calls = 0;
  tmdb.searchMovie = async () => {
    calls++;
    if (calls === 1) throw new Error('fetch failed');
    return { id: 123, title: 'Retry Me' };
  };
  tmdb.fetchMovieData = async (id) => ({
    kind: 'movie',
    details: { id, title: 'Retry Me', runtime: 90 },
    credits: { cast: [], crew: [] },
  });

  enrich.startEnrich({
    uploadId: 'retry-test',
    films: [{ slug: 'retry-me', title: 'Retry Me', year: 2020, kind: 'movie' }],
  });

  const started = Date.now();
  while (!enrich.getStatus('retry-test').done && Date.now() - started < 15000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const job = enrich.getJob('retry-test');
  assert.equal(calls, 2);
  assert.equal(job.retriedSuccesses, 1);
  assert.equal(job.matched, 1);
  assert.equal(job.failed, 0);

  const index = JSON.parse(fs.readFileSync(path.join(cacheDir, 'index.json'), 'utf8'));
  assert.equal(index['retry me|2020'], 123);
  assert.ok(fs.existsSync(path.join(cacheDir, 'details', '123.json')));
});
