'use strict';

/**
 * MobyGames provider (M3): graceful no-key mode, role mapping, budget,
 * breaker. Every request is mocked; no key exists in this round (ИГРЫ §2.4).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-moby-')
);
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-moby-state-')
);
// The main tree may carry a dev fallback; point it away so the no-key test is
// deterministic. The key value itself is never asserted or printed.
process.env.KINOBOXD_MOBY_KEY_FILE = path.join(
  process.env.KINOBOXD_STATE_DIR,
  'no-moby-token'
);

const moby = require('../server/games/personnel/moby');
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'games', 'moby-credits.json'), 'utf8')
);

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
  };
}

function memoryStore() {
  let state = {};
  return {
    read: () => ({ ...state }),
    write: (next) => {
      state = { ...next };
    },
    snapshot: () => ({ ...state }),
  };
}

test('no key: disabled status, no network, key_missing on use', async () => {
  delete process.env.MOBYGAMES_API_KEY;
  delete process.env.MOBY_API_KEY;
  moby.resetMobyKeyCache();

  const info = moby.mobyKeyInfo();
  assert.equal(info.configured, false);
  assert.equal(info.source, null);
  assert.equal(moby.mobyEnabled(), false);

  let calls = 0;
  const client = moby.createClient({
    fetchImpl: async () => {
      calls++;
      return jsonResponse(fixture);
    },
    keyProvider: () => ({ key: null, source: null }),
    breakerStore: memoryStore(),
  });
  const status = client.status();
  assert.equal(status.enabled, false);
  assert.equal(status.reason, 'key_missing');
  assert.equal(status.source, null);

  await assert.rejects(
    () => client.fetchGameCredits({ mobyId: 123, platformId: 5 }),
    (err) => err.code === 'moby_key_missing'
  );
  assert.equal(calls, 0);
});

test('with a key: parses credits, maps roles, drops QA, never leaks the key', async () => {
  const secret = 'moby-test-key-not-real';
  process.env.MOBYGAMES_API_KEY = secret;
  moby.resetMobyKeyCache();
  try {
    const headers = [];
    const client = moby.createClient({
      fetchImpl: async (url, init) => {
        headers.push(init.headers);
        assert.match(String(url), /\/v1\/games\/123\/platforms\/5\/credits$/);
        return jsonResponse(fixture);
      },
      breakerStore: memoryStore(),
      pauseMs: 0,
    });
    const status = client.status();
    assert.equal(status.enabled, true);
    assert.equal(status.configured, true);
    assert.equal(status.source, 'MOBYGAMES_API_KEY');
    assert.equal(JSON.stringify(status).includes(secret), false);

    const doc = await client.fetchGameCredits({ mobyId: 123, platformId: 5 });
    assert.equal(doc.source, 'mobygames');
    assert.equal(headers.length, 1);
    assert.equal(headers[0].authorization, `Bearer ${secret}`);
    assert.equal(JSON.stringify(doc).includes(secret), false);

    const byName = new Map(doc.people.map((person) => [person.name, person]));
    assert.deepEqual(byName.get('Marcin Przybyłowicz').roles, ['composer']);
    assert.deepEqual(byName.get('Konrad Tomaszkiewicz').roles, ['designer']);
    assert.deepEqual(byName.get('Marcin Blacha').roles, ['writer']);
    assert.deepEqual(byName.get('Bartłomiej Gaweł').roles, ['artist']);
    assert.deepEqual(byName.get('Grzegorz Mocarski').roles, ['programmer']);
    assert.deepEqual(byName.get('Piotr Twardowski').roles, ['producer']);
    assert.deepEqual(byName.get('Paweł Błaszczak').roles, ['sound']);
    assert.deepEqual(byName.get('Doug Cockle').roles, ['voice']);
    assert.equal(byName.has('QA Person'), false);
    assert.equal(byName.get('Marcin Przybyłowicz').mobyId, 9001);
    assert.equal(byName.get('Marcin Przybyłowicz').roleSource, 'mobygames');
  } finally {
    delete process.env.MOBYGAMES_API_KEY;
    moby.resetMobyKeyCache();
  }
});

test('role mapping table', () => {
  assert.equal(moby.mapRole('Composer'), 'composer');
  assert.equal(moby.mapRole('Music'), 'composer');
  assert.equal(moby.mapRole('Game Design'), 'designer');
  assert.equal(moby.mapRole('Writing'), 'writer');
  assert.equal(moby.mapRole('Art/Graphics'), 'artist');
  assert.equal(moby.mapRole('Programming'), 'programmer');
  assert.equal(moby.mapRole('Production'), 'producer');
  assert.equal(moby.mapRole('Audio'), 'sound');
  assert.equal(moby.mapRole('Voice Actor'), 'voice');
  assert.equal(moby.mapRole('Quality Assurance'), null);
  assert.equal(moby.mapRole('Something Unknown'), null);
});

test('array-shaped credits are accepted defensively', () => {
  const doc = moby.parseCreditsResponse({
    credits: [
      { role: 'Writing', person_id: 1, name: 'A Writer' },
      { role: 'Game Design', person_id: 2, name: 'A Designer' },
    ],
  });
  assert.equal(doc.people.length, 2);
  assert.deepEqual(doc.people[0].roles, ['writer']);
});

test('403 trips the 30-minute breaker: the next call does not hit the network', async () => {
  process.env.MOBYGAMES_API_KEY = 'moby-test-key-not-real';
  moby.resetMobyKeyCache();
  try {
    const store = memoryStore();
    let calls = 0;
    const client = moby.createClient({
      fetchImpl: async () => {
        calls++;
        return jsonResponse({}, 403);
      },
      breakerStore: store,
      pauseMs: 0,
    });
    await assert.rejects(
      () => client.fetchGameCredits({ mobyId: 1, platformId: 1 }),
      (err) => err.code === 'moby_rate_limited'
    );
    assert.equal(calls, 1);
    const breaker = client.status().breaker;
    assert.ok(breaker);
    assert.equal(breaker.reason, 'HTTP 403');

    await assert.rejects(
      () => client.fetchGameCredits({ mobyId: 1, platformId: 1 }),
      (err) => err.code === 'moby_rate_limited' && Boolean(err.retryAt)
    );
    assert.equal(calls, 1);
  } finally {
    delete process.env.MOBYGAMES_API_KEY;
    moby.resetMobyKeyCache();
  }
});

test('budget: GAMES_MOBY_BUDGET exhausted stops before the request', async () => {
  process.env.MOBYGAMES_API_KEY = 'moby-test-key-not-real';
  moby.resetMobyKeyCache();
  try {
    let calls = 0;
    const client = moby.createClient({
      fetchImpl: async () => {
        calls++;
        return jsonResponse(fixture);
      },
      breakerStore: memoryStore(),
      pauseMs: 0,
      budget: 1,
    });
    await client.fetchGameCredits({ mobyId: 1, platformId: 1 });
    assert.equal(calls, 1);
    await assert.rejects(
      () => client.fetchGameCredits({ mobyId: 2, platformId: 1 }),
      (err) => err.code === 'moby_budget_exhausted'
    );
    assert.equal(calls, 1);
    assert.equal(client.status().budgetUsed, 1);
  } finally {
    delete process.env.MOBYGAMES_API_KEY;
    moby.resetMobyKeyCache();
  }
});

test('404 is not_found and does not open the breaker', async () => {
  process.env.MOBYGAMES_API_KEY = 'moby-test-key-not-real';
  moby.resetMobyKeyCache();
  try {
    const store = memoryStore();
    const client = moby.createClient({
      fetchImpl: async () => jsonResponse({}, 404),
      breakerStore: store,
      pauseMs: 0,
    });
    await assert.rejects(
      () => client.fetchGameCredits({ mobyId: 9, platformId: 9 }),
      (err) => err.code === 'moby_not_found'
    );
    assert.deepEqual(store.snapshot(), {});
  } finally {
    delete process.env.MOBYGAMES_API_KEY;
    moby.resetMobyKeyCache();
  }
});
