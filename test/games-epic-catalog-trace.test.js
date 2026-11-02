'use strict';

/**
 * Epic catalog trace (02.11.2026 fix-round).
 *
 * Production showed `resolved 1/1` for Alan Wake 2 while the card still had no
 * year/genres, and `lastErrors: []` could not tell «the catalog was asked and
 * answered nothing» from «the catalog was never asked». These tests pin the
 * ledger + dump + honest coverage contract:
 *
 *   - every attempt lands in `state/catalog-state.json` per owner +
 *     `catalogItemId` (result, HTTP status, bytes, `genresOk`, `yearHas`,
 *     ≤5 entries);
 *   - anything short of `shape_ok` leaves a ≤2 KB dump in
 *     `cache-games/debug/epic/catalog-<id>.json` (token never written);
 *   - the status endpoint exposes `catalogAttempts`, and `resolved` counts only
 *     documents whose year **and** genres actually arrived (a settled negative
 *     is `unavailable`, not a fake success);
 *   - a negative answer is re-probed after its TTL; a fresh negative is not.
 *
 * No live request: the CMS client and the owner-token catalog client are both
 * injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-epic-catalog-trace-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-epic-catalog-trace-state-')
);
process.env.GAMES_SECONDARY_PAUSE_MS = '1';

const gameCache = require('../server/games/game-cache');
const epicCache = require('../server/games/epic-cache');
const tokenStore = require('../server/games/epic-token-store');
const details = require('../server/games/secondary-details');

const FIXTURES = path.join(__dirname, 'fixtures', 'games');
const EPIC_AW2 = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'epic', 'product-alan-wake-2.json'), 'utf8')
);

const AW2_CATALOG = {
  catalogItemId: 'trace-aw2',
  namespace: 'fn',
  title: 'Alan Wake 2',
  slug: 'alan-wake-2',
  developer: 'Remedy Entertainment',
  publisher: 'Epic Games Publishing',
  releaseDate: '2023-10-27T00:00:00.000Z',
  categories: [{ path: 'games' }, { path: 'games/action' }, { path: 'games/horror' }],
};

const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------- helpers -------------------------- */

function cmsClient() {
  const calls = [];
  return {
    calls,
    async getJson(url) {
      calls.push(url);
      return EPIC_AW2;
    },
  };
}

function catalogClient(options = {}) {
  const calls = [];
  return {
    calls,
    async getCatalogBulk(namespace, ids) {
      calls.push({ namespace, ids: [...ids] });
      if (typeof options.onCatalog === 'function') {
        return options.onCatalog(calls.length, ids);
      }
      return {
        items: options.items || {},
        failures: options.failures || [],
        chunks: options.chunks || [],
        requests: 1,
      };
    },
  };
}

async function seedOwner(ownerKey, accountId, options = {}) {
  const nowIso = new Date().toISOString();
  await epicCache.saveEpicProfile({ accountId, ownerKey, connectedAt: nowIso });
  await epicCache.saveEpicLibrary(accountId, {
    accountId,
    ownerKey,
    fetchedAt: nowIso,
    games: [
      { appName: "Ginger", catalogItemId: "trace-aw2", namespace: "fn", name: "Alan Wake 2" },
    ],
  });
  await epicCache.saveEpicSlugOverride("trace-aw2", "alan-wake-2", {
    title: "Alan Wake 2",
    source: "test",
  });
  if (options.token === false) return accountId;
  await tokenStore.saveTokens({
    accountId,
    displayName: 'TraceTester',
    ownerKey,
    accessToken: 'eg1~fake-access-token',
    refreshToken: options.refreshToken === undefined ? null : options.refreshToken,
    accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
  });
  return accountId;
}

function authExpired() {
  return Object.assign(new Error('401 token'), { code: 'epic_auth_expired', status: 401 });
}

async function waitForJob(ownerKey, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    const job = details.jobFor(ownerKey);
    if (job && job.status !== 'running') return job;
    if (Date.now() - started > timeoutMs) throw new Error('job did not finish in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function cleanState() {
  for (const dir of [details.DEBUG_DIR]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      /* nothing */
    }
  }
  for (const dir of [details.CACHE_DIR, details.CATALOG_PROBE_DIR]) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.json')) fs.unlinkSync(path.join(dir, name));
      }
    } catch (err) {
      /* nothing */
    }
  }
  fs.rmSync(details.CATALOG_STATE_PATH, { force: true });
  try {
    fs.rmSync(epicCache.slugOverridesPath(), { force: true });
  } catch (err) {
    /* nothing */
  }
  details.writeBreaker({});
}

function debugPath(catalogItemId) {
  return path.join(details.DEBUG_DIR, `catalog-${catalogItemId}.json`);
}

async function runAw2(ownerKey, catalog) {
  const cms = cmsClient();
  details.startSecondaryDetails({
    ownerKey,
    gog: [],
    epic: [
      {
        slug: 'alan-wake-2',
        catalogItemId: catalog.id,
        namespace: 'fn',
        title: 'Alan Wake 2',
        catalog: null,
      },
    ],
    client: cms,
    epicClient: catalog.client,
    tokenStore,
    pauseMs: 0,
  });
  const job = await waitForJob(ownerKey);
  return { job, cms };
}

/* -------------------------------- tests --------------------------- */

test('catalog trace', async (t) => {
  t.beforeEach(() => {
    details.resetJobs();
    cleanState();
  });

  await t.test('shape_ok: full transport facts, no dump, resolved 1/1', async () => {
    const owner = 'steam-trace-shape';
    const account = 'epic-trace-shape';
    await seedOwner(owner, account);
    const catalog = catalogClient({
      items: { 'trace-aw2': AW2_CATALOG },
      chunks: [{ ids: ['trace-aw2'], status: 200, bytes: 4321 }],
    });
    const { job } = await runAw2(owner, { id: 'trace-aw2', client: catalog });

    assert.equal(job.status, 'done');
    assert.equal(job.epic.resolved, 1);
    assert.equal(catalog.calls.length, 1);
    assert.equal(catalog.calls[0].namespace, 'fn');

    const attempt = details.readCatalogAttempt(owner, 'trace-aw2');
    assert.equal(attempt.lastResult, 'shape_ok');
    assert.equal(attempt.attempts.length, 1);
    assert.deepEqual(attempt.attempts[0], {
      at: attempt.attempts[0].at,
      result: 'shape_ok',
      httpStatus: 200,
      bytes: 4321,
      genresOk: true,
      yearHas: true,
    });
    assert.equal(fs.existsSync(debugPath('trace-aw2')), false, 'success leaves no dump');

    const doc = details.readDetail('epic', 'alan-wake-2').doc;
    assert.equal(doc.data.releaseYear, 2023);
    assert.deepEqual(doc.data.genres, ['Action', 'Horror']);
    assert.equal(doc.data.metaStatus, 'complete');

    const status = details.statusForOwner(owner);
    assert.equal(status.resolved, 1);
    assert.equal(status.pending, 0);
    assert.equal(status.bySource.epic.resolved, 1);
    assert.equal(status.bySource.epic.unavailable, 0);
    assert.equal(status.catalogAttempts.total, 1);
    assert.equal(status.catalogAttempts.items[0].lastResult, 'shape_ok');
    assert.equal(status.catalogAttempts.items[0].bytes, 4321);
  });

  await t.test('empty bulk: dump + ledger, resolved stays 0/1 (unavailable)', async () => {
    const owner = 'steam-trace-empty';
    const account = 'epic-trace-empty';
    await seedOwner(owner, account);
    const catalog = catalogClient({
      items: {},
      chunks: [{ ids: ['trace-aw2'], status: 200, bytes: 512 }],
    });
    const { job } = await runAw2(owner, { id: 'trace-aw2', client: catalog });
    assert.equal(job.status, 'done');

    const attempt = details.readCatalogAttempt(owner, 'trace-aw2');
    assert.equal(attempt.lastResult, 'empty');
    assert.equal(attempt.attempts[0].httpStatus, 200);
    assert.equal(attempt.attempts[0].bytes, 512);
    assert.equal(attempt.attempts[0].genresOk, false);
    assert.equal(attempt.attempts[0].yearHas, false);

    const status = details.statusForOwner(owner);
    assert.equal(status.resolved, 0, 'the fact did not arrive — no fake 1/1');
    assert.equal(status.pending, 0, 'a definitive empty answer is not pending');
    assert.equal(status.bySource.epic.unavailable, 1);
    assert.equal(status.catalogAttempts.total, 1);
    assert.equal(status.catalogAttempts.items[0].lastResult, 'empty');

    const dump = JSON.parse(fs.readFileSync(debugPath('trace-aw2'), 'utf8'));
    assert.equal(dump.source, 'epic-catalog');
    assert.equal(dump.catalogItemId, 'trace-aw2');
    assert.equal(dump.result, 'empty');
    assert.equal(dump.httpStatus, 200);
    assert.equal(dump.bytes, 512);
    assert.equal(dump.item, null);
    assert.ok(JSON.stringify(dump).length < 4096);
    assert.equal(JSON.stringify(dump).includes('eg1~'), false, 'no token ever written');

    const doc = details.readDetail('epic', 'alan-wake-2').doc;
    assert.equal(doc.data.catalogChecked, true);
    assert.equal(doc.data.metaStatus, 'unavailable');
    assert.equal(doc.data.metaYearHas, false);
    assert.equal(doc.data.metaGenresOk, false);
  });

  await t.test('buckets-only catalog shape: lastResult ok, partial detail, dump kept', async () => {
    const owner = 'steam-trace-partial';
    const account = 'epic-trace-partial';
    await seedOwner(owner, account);
    const catalog = catalogClient({
      items: {
        'trace-aw2': {
          ...AW2_CATALOG,
          // The date arrived, the only categories are product buckets → the
          // genre line cannot be derived: `ok`, not `shape_ok`.
          categories: [{ path: 'games' }],
        },
      },
      chunks: [{ ids: ['trace-aw2'], status: 200, bytes: 999 }],
    });
    const { job } = await runAw2(owner, { id: 'trace-aw2', client: catalog });
    assert.equal(job.status, 'done');

    const attempt = details.readCatalogAttempt(owner, 'trace-aw2');
    assert.equal(attempt.lastResult, 'ok');
    assert.equal(attempt.attempts[0].genresOk, false);
    assert.equal(attempt.attempts[0].yearHas, true);

    const dump = JSON.parse(fs.readFileSync(debugPath('trace-aw2'), 'utf8'));
    assert.equal(dump.result, 'ok');
    assert.equal(dump.genresOk, false);
    assert.ok(dump.item, 'the normalized item is kept for diagnosis');

    const status = details.statusForOwner(owner);
    assert.equal(status.resolved, 0);
    assert.equal(status.bySource.epic.partial, 1);
    assert.equal(status.bySource.epic.unavailable, 0);
    assert.equal(status.pending, 0);

    const doc = details.readDetail('epic', 'alan-wake-2').doc;
    assert.equal(doc.data.releaseYear, 2023);
    assert.deepEqual(doc.data.genres, []);
    assert.equal(doc.data.metaStatus, 'partial');
  });

  await t.test('401 is recorded as a retryable attempt and stays pending', async () => {
    const owner = 'steam-trace-auth';
    const account = 'epic-trace-auth';
    await seedOwner(owner, account, { refreshToken: null });
    const catalog = catalogClient({
      onCatalog() {
        throw authExpired();
      },
    });
    const { job } = await runAw2(owner, { id: 'trace-aw2', client: catalog });
    assert.equal(job.status, 'done');
    assert.ok(job.warnings.includes('catalog_auth_expired'));

    const attempt = details.readCatalogAttempt(owner, 'trace-aw2');
    assert.equal(attempt.lastResult, '401');
    assert.equal(attempt.attempts[0].httpStatus, 401);

    const status = details.statusForOwner(owner);
    assert.equal(status.pending, 1, 'expired token is retryable, not a verdict');
    assert.equal(status.resolved, 0);
    assert.equal(status.catalogAttempts.items[0].lastResult, '401');
    assert.ok(fs.existsSync(debugPath('trace-aw2')));
    assert.equal(
      details.readDetail('epic', 'alan-wake-2').doc.data.catalogPending,
      true
    );
  });

  await t.test('429 is recorded as 403 and leaves a dump', async () => {
    const owner = 'steam-trace-blocked';
    const account = 'epic-trace-blocked';
    await seedOwner(owner, account);
    const catalog = catalogClient({
      onCatalog() {
        throw Object.assign(new Error('429'), { code: 'epic_rate_limited', status: 429 });
      },
    });
    const { job } = await runAw2(owner, { id: 'trace-aw2', client: catalog });
    assert.ok(job.warnings.includes('catalog_blocked'));

    const attempt = details.readCatalogAttempt(owner, 'trace-aw2');
    assert.equal(attempt.lastResult, '403');
    assert.equal(attempt.attempts[0].httpStatus, 429);
    const dump = JSON.parse(fs.readFileSync(debugPath('trace-aw2'), 'utf8'));
    assert.equal(dump.result, '403');
    assert.equal(dump.httpStatus, 429);
    details.writeBreaker({});
  });

  await t.test('no token: no catalog attempt is invented, detail says not_connected', async () => {
    const owner = 'steam-trace-notoken';
    const account = 'epic-trace-notoken';
    await seedOwner(owner, account, { token: false });
    const catalog = catalogClient({
      items: { 'trace-aw2': AW2_CATALOG },
      chunks: [{ ids: ['trace-aw2'], status: 200, bytes: 123 }],
    });
    const { job } = await runAw2(owner, { id: 'trace-aw2', client: catalog });
    assert.equal(job.status, 'done');
    assert.equal(catalog.calls.length, 0);

    const status = details.statusForOwner(owner);
    assert.equal(status.catalogAttempts.total, 0, 'never asked is visible as 0');
    assert.equal(status.resolved, 0);
    assert.equal(status.pending, 0);
    assert.equal(status.bySource.epic.unavailable, 1);
    const doc = details.readDetail('epic', 'alan-wake-2').doc;
    assert.equal(doc.data.catalogSkipped, 'not_connected');
    assert.equal(doc.data.catalogChecked, true);
  });

  await t.test('a fresh negative is not retried; an expired negative is re-probed', async () => {
    const owner = 'steam-trace-reprobe';
    const account = 'epic-trace-reprobe';
    await seedOwner(owner, account);

    // A pre-deploy document with no meta, already marked `catalogChecked`.
    const base = details.normalizeEpicProduct(EPIC_AW2, { slug: 'alan-wake-2' });
    details.writeDetail('epic', 'alan-wake-2', 'ok', { ...base, catalogChecked: true });

    const seedLedger = (ageMs) => {
      const at = new Date(Date.now() - ageMs).toISOString();
      details.writeCatalogState({
        owners: {
          [owner]: {
            'trace-aw2': {
              catalogItemId: 'trace-aw2',
              namespace: 'fn',
              lastResult: 'empty',
              lastAt: at,
              attempts: [
                { at, result: 'empty', httpStatus: 200, bytes: 100, genresOk: false, yearHas: false },
              ],
            },
          },
        },
      });
    };

    // 1) Fresh negative: the job does not spend a catalog request.
    seedLedger(DAY_MS);
    const fresh = catalogClient({ items: { 'trace-aw2': AW2_CATALOG } });
    const first = await runAw2(owner, { id: 'trace-aw2', client: fresh });
    assert.equal(fresh.calls.length, 0, 'a fresh negative is a memory, not a loop');
    assert.equal(first.job.requests, 0);

    // 2) The TTL expired: the same kick asks the catalog again.
    seedLedger(31 * DAY_MS);
    const retry = catalogClient({
      items: { 'trace-aw2': AW2_CATALOG },
      chunks: [{ ids: ['trace-aw2'], status: 200, bytes: 2048 }],
    });
    const second = await runAw2(owner, { id: 'trace-aw2', client: retry });
    assert.equal(retry.calls.length, 1, 'the expired negative is re-probed');
    assert.equal(second.job.requests, 1);
    const attempt = details.readCatalogAttempt(owner, 'trace-aw2');
    assert.equal(attempt.lastResult, 'shape_ok');
    assert.equal(attempt.attempts.length, 2);
    const doc = details.readDetail('epic', 'alan-wake-2').doc;
    assert.equal(doc.data.releaseYear, 2023);
    assert.equal(details.statusForOwner(owner).resolved, 1);
  });

  await t.test('the ledger keeps at most five attempts per item', () => {
    const owner = 'steam-trace-ring';
    const results = ['empty', '401', 'unavailable', 'budget', 'ok', '403', 'shape_ok'];
    results.forEach((result, index) =>
      details.recordCatalogAttempt(owner, 'ring-item', {
        namespace: 'fn',
        result,
        httpStatus: 200,
        bytes: index,
        genresOk: result === 'shape_ok',
        yearHas: result === 'shape_ok',
      })
    );
    const entry = details.readCatalogAttempt(owner, 'ring-item');
    assert.equal(entry.attempts.length, 5);
    assert.equal(entry.lastResult, 'shape_ok');
    assert.deepEqual(
      entry.attempts.map((attempt) => attempt.result),
      ['unavailable', 'budget', 'ok', '403', 'shape_ok']
    );
    assert.deepEqual(
      entry.attempts.map((attempt) => attempt.bytes),
      [2, 3, 4, 5, 6]
    );
  });
});

test('catalog state file lives in the state dir, not the games cache', () => {
  assert.equal(
    details.CATALOG_STATE_PATH,
    path.join(gameCache.STATE_DIR, 'catalog-state.json')
  );
});
