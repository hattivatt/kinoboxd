'use strict';

/**
 * Wikidata credit provider (M3): batching, parsing, politeness, breaker.
 * No live requests: `fetchImpl` is always injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-wd-')
);
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-games-wd-state-')
);

const wd = require('../server/games/personnel/wikidata');
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'games', 'wikidata-credits.json'), 'utf8')
);

function jsonResponse(data, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => data,
  };
}

function memoryStore(initial = {}) {
  let state = { ...initial };
  return {
    read: () => ({ ...state }),
    write: (next) => {
      state = { ...next };
    },
    snapshot: () => ({ ...state }),
  };
}

test('parses a real WDQS answer: composers/designers/director/programmer + studios', () => {
  const credits = wd.parseCreditsResponse(fixture);
  assert.equal(credits.size, 2);

  const witcher = credits.get('Q4267401');
  assert.ok(witcher);
  const composers = witcher.people.filter((person) => person.roles.includes('composer'));
  assert.deepEqual(composers.map((person) => person.name).sort(), [
    'Marcin Przybyłowicz',
    'Mikolai Stroinski',
  ]);
  // RU label is kept as an alias source, EN is the display name.
  const marcin = composers.find((person) => person.name === 'Marcin Przybyłowicz');
  assert.equal(marcin.nameRu, 'Марцин Пшибылович');
  assert.equal(marcin.qid, 'Q19005369');
  assert.equal(marcin.roleSource, 'wikidata');
  assert.equal(marcin.confidence, 'high');
  assert.match(marcin.image, /^https:\/\//);

  // A company credited as P162 producer is not a person: CD Projekt RED is a
  // studio of this game (P178/P123), so the studio record wins.
  assert.equal(
    witcher.people.some((person) => person.name === 'CD Projekt RED'),
    false
  );
  const cdpr = witcher.studios.find((studio) => studio.name === 'CD Projekt RED');
  assert.ok(cdpr);
  assert.deepEqual(cdpr.roles.sort(), ['developer', 'publisher']);
  assert.equal(cdpr.qid, 'Q1172164');

  // Pathologic: composer + 2 designers + director + programmer (spec §2.4).
  const pathologic = credits.get('Q2429644');
  const roles = new Set(pathologic.people.flatMap((person) => person.roles));
  for (const role of ['composer', 'designer', 'director', 'programmer']) {
    assert.ok(roles.has(role), `Pathologic should have a ${role}`);
  }
  assert.equal(pathologic.people.filter((person) => person.roles.includes('designer')).length, 2);
  assert.ok(pathologic.studios.some((studio) => studio.name === 'Ice-Pick Lodge'));
});

/**
 * `mul` is Wikidata's language-neutral label. Q3539040 carries a truncated
 * English label («Development Studio») next to the real `mul` one («Paradox
 * Development Studio»), which is what made the same studio appear twice in the
 * «Персоналии» widget (round 01.11.2026).
 */
function labelRow(qid, lang, value, game = 'Q677869') {
  return {
    game: { type: 'uri', value: `http://www.wikidata.org/entity/${game}` },
    kind: { type: 'literal', value: 'studio' },
    role: { type: 'literal', value: 'developer' },
    entity: { type: 'uri', value: `http://www.wikidata.org/entity/${qid}` },
    label: { type: 'literal', value, 'xml:lang': lang },
  };
}

test('canonical label: the mul spelling wins over a truncated English one', () => {
  const credits = wd.parseCreditsResponse({
    results: {
      bindings: [
        labelRow('Q3539040', 'en', 'Development Studio'),
        labelRow('Q3539040', 'mul', 'Paradox Development Studio'),
      ],
    },
  });
  const studio = credits.get('Q677869').studios[0];
  assert.equal(studio.name, 'Paradox Development Studio');
  assert.equal(studio.nameEn, 'Paradox Development Studio', 'the display spelling follows');
  assert.equal(studio.qid, 'Q3539040');
});

test('canonical label: a shorter mul never degrades a more specific English name', () => {
  assert.deepEqual(
    wd.canonicalLabel({ nameEn: 'Warner Bros. Entertainment', nameMul: 'Warner Bros.' }),
    { name: 'Warner Bros. Entertainment', nameEn: 'Warner Bros. Entertainment' }
  );
  // No English label at all: mul is the fallback (as before, but explicit).
  assert.deepEqual(wd.canonicalLabel({ nameEn: null, nameMul: 'Sega' }), {
    name: 'Sega',
    nameEn: 'Sega',
  });
  // No mul label: English stays exactly as it was.
  assert.deepEqual(wd.canonicalLabel({ nameEn: 'Valve', nameRu: 'Valve' }), {
    name: 'Valve',
    nameEn: 'Valve',
  });
  // Unrelated mul label (a known Wikidata defect) is not preferred.
  assert.equal(wd.canonicalLabel({ nameEn: 'Aspyr', nameMul: 'Roger Cruz' }).name, 'Aspyr');
});

test('batch size is ≤450: 500 QIDs become two queries', async () => {
  const queries = [];
  const fetchImpl = async (url, init) => {
    queries.push(init.body);
    return jsonResponse({ results: { bindings: [] } });
  };
  const qids = Array.from({ length: 500 }, (_, index) => `Q${1000 + index}`);
  const result = await wd.fetchCredits(qids, {
    fetchImpl,
    pauseMs: 0,
    stateStore: memoryStore(),
  });
  assert.equal(queries.length, 2);
  assert.equal(result.queries, 2);
  assert.equal(result.batches, 2);
  assert.equal(result.credits.size, 0);
  // The first query carries exactly 450 VALUES, the second 50.
  assert.equal((queries[0].match(/wd%3AQ/g) || []).length, 450);
  assert.equal((queries[1].match(/wd%3AQ/g) || []).length, 50);
});

test('appid query uses P1733 and quotes the external ids', async () => {
  const query = wd.appidCreditsQuery(['292030', '2429644']);
  assert.match(query, /wdt:P1733 \?appid/);
  assert.match(query, /VALUES \?appid \{ "292030" "2429644" \}/);
});

test('429 with Retry-After: three failures open the persisted cooldown', async () => {
  const store = memoryStore();
  let nowMs = Date.parse('2026-11-01T10:00:00Z');
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse({}, 429, { 'retry-after': '3600' });
  };
  const options = {
    fetchImpl,
    pauseMs: 0,
    stateStore: store,
    now: () => nowMs,
    minOutageGapMs: 0,
  };
  const qids = ['Q1', 'Q2', 'Q3'];

  const first = await wd.fetchCredits(qids, options);
  assert.equal(first.skipped, undefined);
  assert.equal(first.errors.length, 1);
  assert.equal(first.disabledUntil, null);
  assert.equal(store.snapshot().failures, 1);

  const second = await wd.fetchCredits(qids, options);
  assert.equal(second.errors.length, 1);
  assert.equal(store.snapshot().failures, 2);

  nowMs += 1000;
  const third = await wd.fetchCredits(qids, options);
  assert.equal(third.skipped, 'wikidata_disabled');
  assert.ok(third.disabledUntil);
  const until = Date.parse(third.disabledUntil);
  // Retry-After (1 h) wins over the 30-min default.
  assert.ok(until - nowMs >= 3600 * 1000 - 1000);
  assert.equal(store.snapshot().failures, 3);

  // Breaker open: the next call must not touch the network at all.
  const callsBefore = calls;
  const fourth = await wd.fetchCredits(qids, options);
  assert.equal(fourth.skipped, 'wikidata_disabled');
  assert.equal(calls, callsBefore);
});

test('outage gap: at most one attempt per minute while failing', async () => {
  const store = memoryStore();
  let nowMs = Date.parse('2026-11-01T11:00:00Z');
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse({}, 503);
  };
  const options = { fetchImpl, pauseMs: 0, stateStore: store, now: () => nowMs };
  await wd.fetchCredits(['Q10'], options);
  assert.equal(calls, 1);

  const immediate = await wd.fetchCredits(['Q10'], options);
  assert.equal(immediate.skipped, 'wikidata_outage_gap');
  assert.equal(calls, 1);

  nowMs += 61 * 1000;
  await wd.fetchCredits(['Q10'], options);
  assert.equal(calls, 2);
});

test('a successful batch resets failures', async () => {
  const store = memoryStore({ failures: 2, lastAttemptAt: new Date(0).toISOString() });
  const result = await wd.fetchCredits(['Q1'], {
    fetchImpl: async () => jsonResponse({ results: { bindings: [] } }),
    pauseMs: 0,
    stateStore: store,
  });
  assert.equal(result.queries, 1);
  assert.equal(store.snapshot().failures, 0);
  assert.ok(store.snapshot().lastSuccessAt);
});

test('kill switch KINOBOXD_GAMES_WD=off makes no request', async () => {
  process.env.KINOBOXD_GAMES_WD = 'off';
  try {
    let calls = 0;
    const result = await wd.fetchCredits(['Q1'], {
      fetchImpl: async () => {
        calls++;
        return jsonResponse({ results: { bindings: [] } });
      },
      stateStore: memoryStore(),
    });
    assert.equal(result.skipped, 'disabled_by_env');
    assert.equal(calls, 0);
  } finally {
    delete process.env.KINOBOXD_GAMES_WD;
  }
});

test('retry-after parser: seconds and HTTP date', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  assert.equal(wd.parseRetryAfter('120', now), 120000);
  assert.equal(wd.parseRetryAfter('Sun, 01 Nov 2026 13:00:00 GMT', now), 3600000);
  assert.equal(wd.parseRetryAfter('nonsense', now), null);
  assert.equal(wd.parseRetryAfter(null, now), null);
});
