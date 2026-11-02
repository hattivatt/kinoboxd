'use strict';

/**
 * M6c: the Wikidata identity bridge for secondary stores.
 *
 * `gameplay`-style politeness: one POST batch (≤450 slugs), the cache
 * `cache-games/links/secondary.json`, a network/5xx answer is deferred (never a
 * negative verdict), and a job driven by an injected client never touches WDQS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-secondary-identity-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-secondary-identity-state-')
);

const identity = require('../server/games/secondary-identity');

const RESPONSE = {
  results: {
    bindings: [
      {
        item: { value: 'http://www.wikidata.org/entity/Q4267401' },
        store: { value: 'gog' },
        slug: { value: 'game/the_witcher_3_wild_hunt' },
        appid: { value: '292030' },
      },
      {
        item: { value: 'http://www.wikidata.org/entity/Q4267401' },
        store: { value: 'epic' },
        slug: { value: 'the-witcher-3-wild-hunt' },
        appid: { value: '292030' },
      },
    ],
  },
};

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? String(init.body) : '' });
    return handler(url, init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
  };
}

test('secondary identity bridge', async (t) => {
  await t.test('one batch resolves both stores and is cached', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(RESPONSE));
    const report = await identity.fetchSecondaryLinks(
      { gogSlugs: ['the_witcher_3_wild_hunt'], epicSlugs: ['the-witcher-3-wild-hunt'] },
      { fetchImpl }
    );
    assert.equal(report.queries, 1);
    assert.equal(report.errors.length, 0);
    assert.equal(report.entries['gog:the_witcher_3_wild_hunt'].appid, '292030');
    assert.equal(report.entries['epic:the_witcher_3_wild_hunt'].appid, '292030');
    // POST + SPARQL JSON accept header + the project UA.
    const call = fetchImpl.calls[0];
    assert.equal(call.init.method, 'POST');
    assert.match(call.init.headers.accept, /sparql-results\+json/);
    assert.match(call.init.headers['user-agent'], /kinoboxd/);
    // The cache is readable without a network call.
    const cached = identity.readSecondaryLinks();
    assert.equal(cached['gog:the_witcher_3_wild_hunt'].qid, 'Q4267401');
    assert.ok(fs.existsSync(identity.CACHE_PATH));
  });

  await t.test('a second pass reuses the cache (no request)', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(RESPONSE));
    const report = await identity.fetchSecondaryLinks(
      { gogSlugs: ['the_witcher_3_wild_hunt'], epicSlugs: [] },
      { fetchImpl }
    );
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(report.queries, 0);
    assert.equal(report.cached, 1);
  });

  await t.test('a miss is cached honestly as qid:null', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ results: { bindings: [] } }));
    const report = await identity.fetchSecondaryLinks(
      { gogSlugs: ['no_such_game'], epicSlugs: [] },
      { fetchImpl }
    );
    assert.deepEqual(report.entries['gog:no_such_game'], {
      qid: null,
      appid: null,
      store: 'gog',
      slug: 'no_such_game',
      // The P577 column is part of the settled shape: a miss has no date and
      // must not be re-asked by the schema heal (`isSettledEntry`).
      releaseYear: null,
      releasePrecision: null,
      releaseDate: null,
      releaseDateSource: null,
    });
  });

  await t.test('a 429/5xx answer is deferred, not a negative verdict', async () => {
    const before = identity.readSecondaryLinks({ allowStale: true });
    const fetchImpl = fakeFetch(() => jsonResponse({}, 429));
    const report = await identity.fetchSecondaryLinks(
      { gogSlugs: ['another_slug'], epicSlugs: [] },
      { fetchImpl }
    );
    assert.equal(report.queries, 1);
    assert.equal(report.skipped, 'rate_limited');
    assert.equal(report.errors[0], 'wd_429');
    const after = identity.readSecondaryLinks({ allowStale: true });
    // Nothing was written for the failed batch.
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  });

  await t.test('a network failure never throws', async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error('ECONNRESET');
    });
    const report = await identity.fetchSecondaryLinks(
      { gogSlugs: ['yet_another'], epicSlugs: [] },
      { fetchImpl }
    );
    assert.equal(report.skipped, 'network');
    assert.match(report.errors[0], /wd_network/);
  });

  await t.test('slugs are chunked by 450 per request', async () => {
    const slugs = Array.from({ length: 460 }, (_, index) => `game_${index}`);
    const fetchImpl = fakeFetch(() => jsonResponse({ results: { bindings: [] } }));
    const report = await identity.fetchSecondaryLinks({ gogSlugs: slugs, epicSlugs: [] }, {
      fetchImpl,
      force: true,
    });
    assert.equal(report.queries, 2);
    assert.equal(fetchImpl.calls.length, 2);
  });

  await t.test('the query uses the raw Epic slug (dashes), the cache key does not', async () => {
    // Live shape (verified 01.11.2026): P6278 is `the-witcher-3-wild-hunt`
    // while P2725 is `game/the_witcher_3_wild_hunt`. Sending the normalised
    // `the_witcher_3_wild_hunt` to P6278 matches nothing — the 0-hit bug this
    // test pins.
    const fetchImpl = fakeFetch((url, init) => {
      assert.match(String(init.body), /the-witcher-3-wild-hunt/);
      assert.equal(String(init.body).includes('"the_witcher_3_wild_hunt"'), false);
      return jsonResponse(RESPONSE);
    });
    const report = await identity.fetchSecondaryLinks(
      { gogSlugs: ['the_witcher_3_wild_hunt'], epicSlugs: ['the-witcher-3-wild-hunt'] },
      { fetchImpl, force: true }
    );
    // One cache key per store, both normalised for lookup.
    assert.equal(report.entries['epic:the_witcher_3_wild_hunt'].appid, '292030');
  });

  await t.test('refreshForJob is skipped for an injected client and for a disabled pass', async () => {
    assert.deepEqual(
      await identity.refreshForJob({
        gogProducts: [{ slug: 'x' }],
        options: { client: { fake: true } },
      }),
      { skipped: 'injected_client' }
    );
    assert.deepEqual(
      await identity.refreshForJob({
        gogProducts: [{ slug: 'x' }],
        options: { wikidata: false },
      }),
      { skipped: 'disabled' }
    );
    assert.deepEqual(await identity.refreshForJob({ gogProducts: [], options: {} }), {
      skipped: 'no_slugs',
    });
  });

  await t.test('refreshForJob reports what it asked for', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(RESPONSE));
    const report = await identity.refreshForJob({
      gogProducts: [{ slug: 'the_witcher_3_wild_hunt' }],
      epicGames: [{ slug: 'the-witcher-3-wild-hunt' }],
      options: { fetchImpl, force: true },
    });
    assert.equal(report.gogSlugs, 1);
    assert.equal(report.epicSlugs, 1);
    assert.equal(report.queries, 1);
    assert.equal(report.skipped, null);
    assert.deepEqual(report.errors, []);
  });
});
