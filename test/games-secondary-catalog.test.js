'use strict';

/**
 * Epic catalog completion + the Wikidata P577 year (U10).
 *
 * Merged from `games-secondary-catalog-heal.test.js`,
 * `games-epic-catalog-trace.test.js` and `games-secondary-wd-year.test.js` —
 * one subject: what a store answer that lacks a year/genre does next. Every
 * assertion is kept; each block is scoped so the helper names cannot clash.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-secondary-catalog-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-secondary-catalog-state-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = STATE_DIR;
process.env.KINOBOXD_STEAM_KEY_FILE = path.join(STATE_DIR, 'no-steam-token');
process.env.GAMES_SECONDARY_PAUSE_MS = '1';

const { createRouter } = require('../server/games/routes');
const gameCache = require('../server/games/game-cache');
const epicCache = require('../server/games/epic-cache');
const tokenStore = require('../server/games/epic-token-store');
const details = require('../server/games/secondary-details');
const identity = require('../server/games/secondary-identity');

/* ---- was games-secondary-catalog-heal.test.js ---- */
{const PORT = 7114;
const NOW = new Date().toISOString();

/* ------------------------------- helpers -------------------------- */

function clearDir(dir) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.json')) fs.unlinkSync(path.join(dir, name));
    }
  } catch (err) {
    /* nothing to clean */
  }
}

function clearTokens() {
  try {
    for (const name of fs.readdirSync(tokenStore.TOKENS_DIR)) {
      if (name.endsWith('.json')) fs.unlinkSync(path.join(tokenStore.TOKENS_DIR, name));
    }
  } catch (err) {
    /* nothing to clean */
  }
}

/** A clean diagnostic slate; libraries/profiles stay (they are per account). */
function clearState() {
  details.resetJobs();
  clearDir(details.CACHE_DIR);
  clearDir(details.CATALOG_PROBE_DIR);
  clearDir(epicCache.CATALOG_DIR);
  for (const file of [details.CATALOG_STATE_PATH]) {
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      /* nothing */
    }
  }
  details.writeBreaker({});
}

async function seedOwner({
  steamId,
  owner,
  account,
  catalogItemId,
  slug = 'alan-wake-2',
  token = 'bound',
  ownerBinding = true,
}) {
  await gameCache.saveProfile({
    userKey: steamId,
    personaName: 'heal',
    privacy: 'public',
    importedAt: NOW,
    fetchedAt: NOW,
  });
  await gameCache.saveLibrary(steamId, {
    fetchedAt: NOW,
    partial: false,
    source: 'steam-webapi',
    game_count: 0,
    games: [],
  });
  if (ownerBinding) {
    await epicCache.saveEpicProfile({ accountId: account, ownerKey: owner, connectedAt: NOW });
  } else {
    await epicCache.saveEpicProfile({ accountId: account, connectedAt: NOW });
  }
  await epicCache.saveEpicLibrary(account, {
    accountId: account,
    ownerKey: owner,
    fetchedAt: NOW,
    games: [{ appName: 'Ginger', catalogItemId, slug, name: 'Alan Wake 2' }],
  });
  if (token === 'bound' || token === 'unbound') {
    await tokenStore.saveTokens({
      accountId: account,
      displayName: 'Heal',
      ownerKey: token === 'bound' ? owner : null,
      accessToken: 'eg1~fake-access-token',
      refreshToken: 'eg1~fake-refresh-token',
      accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
    });
  }
}

function writePartialDetail(slug = 'alan-wake-2') {
  details.writeDetail('epic', slug, 'ok', {
    schemaVersion: 1,
    source: 'epic',
    id: slug,
    title: 'Alan Wake 2',
    slug,
    genres: [],
    releaseDate: '2023-10-27T00:00:00.000Z',
    releaseYear: 2023,
    releaseDateSource: 'epic-catalog',
    fetchedAt: NOW,
    catalogChecked: true,
    metaStatus: 'partial',
    metaYearHas: true,
    metaGenresOk: false,
  });
}

/**
 * The exact shape `epic-import.js` leaves behind: a fresh catalog document with
 * a release date but only bucket categories — no genre the detail is missing.
 */
async function seedImportShapedCatalog(catalogItemId) {
  await epicCache.saveEpicCatalogItem(catalogItemId, {
    catalogItemId,
    title: 'Alan Wake 2',
    slug: 'alan-wake-2',
    releaseDate: '2023-10-27T00:00:00.000Z',
    categories: ['games'],
    fetchedAt: NOW,
  });
}

function fakeCatalog(items, catalogItemId) {
  const calls = [];
  return {
    calls,
    async getCatalogBulk(namespace, ids) {
      calls.push({ namespace, ids: [...ids] });
      return {
        items:
          items === null
            ? {}
            : {
                [catalogItemId]: {
                  catalogItemId,
                  title: 'Alan Wake 2',
                  slug: 'alan-wake-2',
                  releaseDate: '2023-10-27T00:00:00.000Z',
                  categories: [{ path: 'games' }, { path: 'games/horror' }],
                  fetchedAt: NOW,
                },
              },
        requests: 1,
        failures: [],
        chunks: [{ ids: [...ids], status: 200, bytes: 512 }],
      };
    },
    async refreshTokens() {
      throw new Error('refresh must not be needed in this test');
    },
  };
}

function unexpectedCms(label) {
  const calls = [];
  return {
    calls,
    async getJson(url) {
      calls.push(url);
      throw new Error(`unexpected CMS request in ${label}: ${url}`);
    },
  };
}

async function waitForJob(owner, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    const job = details.jobFor(owner);
    if (job && job.status !== 'running') return job;
    if (Date.now() - started > timeoutMs) throw new Error('job did not finish in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/* -------------------------------- tests --------------------------- */

test('catalog reuse is justified by the missing fact, not by «has meta»', () => {
  const dateOnly = { releaseDate: '2023-10-27T00:00:00.000Z', categories: ['games'] };
  const full = {
    releaseDate: '2023-10-27T00:00:00.000Z',
    categories: [{ path: 'games/horror' }],
  };
  const needsGenres = { source: 'epic', releaseYear: 2023, genres: [] };
  const needsYear = { source: 'epic', releaseYear: null, genres: ['Action'] };

  assert.equal(details.catalogAnswersMissing(needsGenres, dateOnly), false);
  assert.equal(details.catalogAnswersMissing(needsGenres, full), true);
  // A CMS page with no meta at all needs both axes.
  assert.equal(details.catalogAnswersMissing(null, dateOnly), false);
  assert.equal(details.catalogAnswersMissing(null, full), true);
  // A genre-only document cannot fill the year.
  assert.equal(
    details.catalogAnswersMissing(needsYear, { categories: [{ path: 'games/horror' }] }),
    false
  );
});

test('import-shaped catalog: the phase asks getCatalogBulk and the ledger moves', async () => {
  clearState();
  clearTokens();
  const steamId = '76561198000000911';
  const owner = `steam-${steamId}`;
  const account = 'epic-heal-import';
  const catalogItemId = 'heal-import-cat';
  await seedOwner({ steamId, owner, account, catalogItemId });
  await seedImportShapedCatalog(catalogItemId);
  writePartialDetail();

  const before = details.statusForOwner(owner);
  assert.equal(before.bySource.epic.partial, 1);
  assert.equal(before.bySource.epic.retryablePartial, 1);
  assert.equal(before.catalogAttempts.total, 0);
  assert.equal(before.bySource.epic.lastSkip, null);

  const catalog = fakeCatalog({}, catalogItemId);
  const cms = unexpectedCms('import-shaped catalog');
  details.kickFromStats(
    owner,
    { resolved: 0, total: 1, partial: 1, noSlug: 0 },
    { client: cms, epicClient: catalog, tokenStore, pauseMs: 0 }
  );
  const job = await waitForJob(owner);
  assert.equal(job.status, 'done');
  assert.equal(catalog.calls.length, 1, 'the catalog bulk is asked despite the cached document');
  assert.deepEqual(catalog.calls[0].ids, [catalogItemId]);
  assert.equal(cms.calls.length, 0, 'the cached detail is not refetched from the CMS');
  assert.equal(job.epic.catalogSkipped, 0);

  const status = details.statusForOwner(owner);
  assert.equal(status.resolved, 1);
  assert.equal(status.partial, 0);
  assert.equal(status.catalogAttempts.total, 1);
  assert.equal(status.catalogAttempts.items[0].lastResult, 'shape_ok');
  assert.equal(status.bySource.epic.lastSkip, null);
  const doc = details.readDetail('epic', 'alan-wake-2').doc;
  assert.deepEqual(doc.data.genres, ['Horror']);
  assert.equal(doc.data.metaStatus, 'complete');
});

test('skips are visible: no_access_token leaves lastSkip, not an error', async () => {
  clearState();
  clearTokens();
  const steamId = '76561198000000912';
  const owner = `steam-${steamId}`;
  const account = 'epic-heal-notoken';
  const catalogItemId = 'heal-notoken-cat';
  await seedOwner({ steamId, owner, account, catalogItemId, token: null });
  // Force the partial document into the cache and ask the catalog step
  // directly: the job is not needed to prove the reason is recorded.
  writePartialDetail();
  const result = await details.refetchEpicCatalog({
    ownerKey: owner,
    catalogItemId,
    namespace: 'fn',
  });
  assert.equal(result.catalog, null);
  assert.equal(result.skipped, 'not_connected');
  assert.equal(result.skipReason, 'no_access_token');

  const status = details.statusForOwner(owner);
  assert.equal(status.catalogAttempts.total, 0, 'never asked stays visible as 0');
  assert.deepEqual(status.lastErrors, []);
  assert.equal(status.bySource.epic.lastSkip.reason, 'no_access_token');
  assert.equal(status.bySource.epic.lastSkip.catalogItemId, catalogItemId);
  assert.ok(status.bySource.epic.lastSkip.at);
  assert.equal(status.bySource.epic.binding.state, 'bound');
  assert.equal(status.bySource.epic.binding.hasAccessToken, false);
});

test('skips are visible: a fresh negative probe is named', async () => {
  clearState();
  clearTokens();
  const steamId = '76561198000000913';
  const owner = `steam-${steamId}`;
  const account = 'epic-heal-probe';
  const catalogItemId = 'heal-probe-cat';
  await seedOwner({ steamId, owner, account, catalogItemId });
  details.writeCatalogProbe(catalogItemId, 'empty', { code: 'no_meta' });
  const catalog = fakeCatalog({}, catalogItemId);
  const result = await details.refetchEpicCatalog({
    ownerKey: owner,
    catalogItemId,
    namespace: 'fn',
    epicClient: catalog,
  });
  assert.equal(result.skipped, 'probe');
  assert.equal(result.skipReason, 'probe');
  assert.equal(catalog.calls.length, 0);
  const status = details.statusForOwner(owner);
  assert.equal(status.bySource.epic.lastSkip.reason, 'probe');
  assert.equal(status.bySource.epic.lastSkip.detail, 'empty');
});

test('an unbound single token is adopted by the owner and the catalog is asked', async () => {
  clearState();
  clearTokens();
  const steamId = '76561198000000914';
  const owner = `steam-${steamId}`;
  const account = 'epic-heal-unbound';
  const catalogItemId = 'heal-unbound-cat';
  // Old-format token: no ownerKey; the profile has no binding either.
  await seedOwner({
    steamId,
    owner,
    account,
    catalogItemId,
    token: 'unbound',
    ownerBinding: false,
  });
  writePartialDetail();

  const before = details.statusForOwner(owner);
  assert.equal(before.bySource.epic.total, 1, 'the library is still enumerated');
  assert.equal(before.bySource.epic.binding.state, 'unbound');
  assert.equal(before.bySource.epic.binding.accountId, account);
  assert.equal(before.bySource.epic.retryablePartial, 1);

  const catalog = fakeCatalog({}, catalogItemId);
  const cms = unexpectedCms('unbound adoption');
  // `/stats` reports the union built without the Epic layer (the binding is
  // missing), so its meta can look «covered». The adoptable token itself must
  // still produce a kick — otherwise the self-heal is unreachable.
  details.kickFromStats(
    owner,
    { resolved: 1, total: 1, partial: 0, noSlug: 0 },
    { client: cms, epicClient: catalog, tokenStore, pauseMs: 0 }
  );
  await waitForJob(owner);
  assert.equal(catalog.calls.length, 1);

  const status = details.statusForOwner(owner);
  assert.equal(status.catalogAttempts.total, 1);
  assert.equal(status.bySource.epic.binding.state, 'bound');
  assert.equal(status.bySource.epic.lastSkip, null);
  const tokenDoc = await tokenStore.getTokens(account);
  assert.equal(tokenDoc.ownerKey, owner, 'the token binding is adopted on disk');
  const profile = epicCache.getEpicProfile(account);
  assert.equal(profile.ownerKey, owner, 'the profile binding is adopted on disk');
});

test('owner mismatch: two tokens are never guessed at, the reason is stated', async () => {
  clearState();
  clearTokens();
  const steamId = '76561198000000915';
  const owner = `steam-${steamId}`;
  const account = 'epic-heal-mismatch';
  const otherOwner = 'steam-76561198000000999';
  const catalogItemId = 'heal-mismatch-cat';
  await seedOwner({
    steamId,
    owner,
    account,
    catalogItemId,
    token: 'unbound',
    ownerBinding: false,
  });
  // A second token that already names a different owner.
  await tokenStore.saveTokens({
    accountId: 'epic-heal-foreign',
    displayName: 'Other',
    ownerKey: otherOwner,
    accessToken: 'eg1~fake-access-token-2',
    refreshToken: null,
    accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshExpiresAt: null,
  });
  writePartialDetail();

  const status = details.statusForOwner(owner);
  assert.equal(status.bySource.epic.binding.state, 'owner_mismatch');
  assert.equal(status.bySource.epic.binding.otherOwner, otherOwner);
  assert.equal(status.bySource.epic.binding.accountId, null);

  details.kickFromStats(owner, { resolved: 0, total: 1, partial: 1, noSlug: 0 });
  const statusAfter = details.statusForOwner(owner);
  assert.equal(statusAfter.bySource.epic.lastSkip.reason, 'owner_mismatch');
  assert.equal(details.jobFor(owner), null, 'no job is started on an ambiguous binding');
  const tokenDoc = await tokenStore.getTokens(account);
  assert.equal(tokenDoc.ownerKey, null, 'the unbound token is not adopted');
});

test('GET /secondary-details/status exposes lastSkip and binding', async (t) => {
  clearState();
  clearTokens();
  const steamId = '76561198000000916';
  const owner = `steam-${steamId}`;
  const account = 'epic-heal-http';
  const catalogItemId = 'heal-http-cat';
  await seedOwner({ steamId, owner, account, catalogItemId, token: null });
  await details.refetchEpicCatalog({ ownerKey: owner, catalogItemId, namespace: 'fn' });

  const app = express();
  app.use(express.json());
  app.use('/api/games', createRouter({ client: {}, autoEnrich: false, secondaryDetailsKick: false }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'internal', code: 'internal_error' });
  });
  const server = app.listen(PORT);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(
    `http://127.0.0.1:${PORT}/api/games/secondary-details/status?profile=${owner}`
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.bySource.epic.lastSkip.reason, 'no_access_token');
  assert.equal(body.bySource.epic.binding.state, 'bound');
  assert.equal(body.catalogAttempts.total, 0);
  assert.deepEqual(body.lastErrors, []);
});

}

/* ---- was games-epic-catalog-trace.test.js ---- */
{
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

}

/* ---- was games-secondary-wd-year.test.js ---- */
{
const FIXTURES = path.join(__dirname, 'fixtures', 'games');
const LINKS_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'secondary-links.json'), 'utf8')
);
const GOG_WITCHER = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'gog', 'product-1207658924.json'), 'utf8')
);
const NOW = new Date().toISOString();

/* ------------------------------- helpers -------------------------- */

/** Fresh bridge cache from the fixture (`writeCache` stamps `fetchedAt`). */
function seedBridge(entries = LINKS_FIXTURE.entries) {
  identity.writeCache(entries);
  return identity.readSecondaryLinks();
}

function clearedBridge() {
  try {
    fs.rmSync(identity.CACHE_PATH, { force: true });
  } catch (err) {
    /* nothing to clean */
  }
}

function clearDetails() {
  try {
    for (const name of fs.readdirSync(details.CACHE_DIR)) {
      if (name.endsWith('.json')) fs.unlinkSync(path.join(details.CACHE_DIR, name));
    }
  } catch (err) {
    /* nothing to clean */
  }
  details.writeBreaker({});
  details.resetJobs();
}

function fakeClient(handlers = {}) {
  const calls = [];
  return {
    calls,
    async getJson(url) {
      calls.push(url);
      const key = Object.keys(handlers).find((needle) => url.includes(needle));
      if (!key) throw new Error(`unexpected URL in test: ${url}`);
      const value = handlers[key];
      if (typeof value === 'function') return value(url);
      if (value instanceof Error) throw value;
      return value;
    },
  };
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

/**
 * An Epic CMS page with a genre line but **no** release date — the `yearHas
 * false` half of the production symptom (the catalog then answers genres only).
 */
function epicCmsWithoutDate() {
  return {
    productName: 'Alan Wake 2',
    pages: [
      {
        type: 'productHome',
        productName: 'Alan Wake 2',
        data: {
          meta: { tags: ['HORROR'], developer: ['Remedy Entertainment'] },
          hero: {
            portraitBackgroundImageUrl:
              'https://cdn1.epicgames.com/aw2/portrait-1200x1600.jpg',
          },
          about: {},
        },
      },
    ],
  };
}

/** The GOG v2 page with neither `globalReleaseDate` nor `gogReleaseDate`. */
function gogProductWithoutDate(id = 1229800000) {
  const payload = JSON.parse(JSON.stringify(GOG_WITCHER));
  delete payload._embedded.product.globalReleaseDate;
  delete payload._embedded.product.gogReleaseDate;
  payload._embedded.product.id = id;
  return payload;
}

function partialEpicDetail(options = {}) {
  const slug = options.slug || 'alan-wake-2';
  const data = {
    schemaVersion: 1,
    source: 'epic',
    id: slug,
    title: options.title || 'Alan Wake 2',
    slug,
    genres: ['Horror'],
    genresSource: 'epic-catalog',
    tags: ['Horror'],
    releaseDate: null,
    releaseYear: null,
    releaseDateSource: null,
    globalReleaseDate: null,
    storeReleaseDate: null,
    verticalCover: null,
    image: null,
    logo: null,
    developers: ['Remedy Entertainment'],
    publishers: [],
    series: null,
    platforms: [],
    fetchedAt: NOW,
    catalogChecked: true,
    metaStatus: 'partial',
    metaYearHas: false,
    metaGenresOk: true,
    ...(options.extra || {}),
  };
  details.writeDetail('epic', slug, 'ok', data);
  return data;
}

async function seedOwner({ steamId, owner, account, catalogItemId, slug = 'alan-wake-2' }) {
  await gameCache.saveProfile({
    userKey: steamId,
    personaName: 'wd-year',
    privacy: 'public',
    importedAt: NOW,
    fetchedAt: NOW,
  });
  await gameCache.saveLibrary(steamId, {
    fetchedAt: NOW,
    partial: false,
    source: 'steam-webapi',
    game_count: 0,
    games: [],
  });
  await epicCache.saveEpicProfile({ accountId: account, ownerKey: owner, connectedAt: NOW });
  await epicCache.saveEpicLibrary(account, {
    accountId: account,
    ownerKey: owner,
    fetchedAt: NOW,
    games: [{ appName: 'Ginger', catalogItemId, slug, name: 'Alan Wake 2' }],
  });
  await tokenStore.saveTokens({
    accountId: account,
    displayName: 'WD year',
    ownerKey: owner,
    accessToken: 'eg1~fake-access-token',
    refreshToken: 'eg1~fake-refresh-token',
    accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
  });
}

/* -------------------------------- tests --------------------------- */

test('wikidata P577 in the secondary identity batch', async (t) => {
  await t.test('the one batch query also asks P577 with precision', () => {
    const query = identity.buildBridgeQuery({
      gogSlugs: ['the_witcher'],
      epicSlugs: ['alan-wake-2'],
    });
    assert.match(query, /P6278/);
    assert.match(query, /P2725/);
    assert.match(query, /p:P577 \?st/);
    assert.match(query, /wikibase:timeValue \?date/);
    assert.match(query, /wikibase:timePrecision \?precision/);
    assert.match(query, /\?date \?precision/);
  });

  await t.test('a day-precision P577 becomes a year + an exact date', () => {
    const entries = identity.parseBridgeResponse({
      results: {
        bindings: [
          {
            item: { value: 'http://www.wikidata.org/entity/Q108417001' },
            store: { value: 'epic' },
            slug: { value: 'alan-wake-2' },
            date: { value: '2023-10-27T00:00:00Z' },
            precision: { value: '11' },
          },
        ],
      },
    });
    assert.deepEqual(entries['epic:alan_wake_2'], {
      qid: 'Q108417001',
      appid: null,
      store: 'epic',
      releaseYear: 2023,
      releasePrecision: 'day',
      releaseDate: '2023-10-27',
      releaseDateSource: 'wikidata',
    });
  });

  await t.test('several P577 values: earliest year wins, month precision has no date', () => {
    const entries = identity.parseBridgeResponse({
      results: {
        bindings: [
          {
            item: { value: 'http://www.wikidata.org/entity/Q270054' },
            store: { value: 'gog' },
            slug: { value: 'the_witcher' },
            date: { value: '2011-05-09T00:00:00Z' },
            precision: { value: '11' },
          },
          {
            item: { value: 'http://www.wikidata.org/entity/Q270054' },
            store: { value: 'gog' },
            slug: { value: 'the_witcher' },
            date: { value: '2007-10-01T00:00:00Z' },
            precision: { value: '10' },
          },
        ],
      },
    });
    assert.equal(entries['gog:the_witcher'].releaseYear, 2007);
    assert.equal(entries['gog:the_witcher'].releasePrecision, 'month');
    assert.equal(entries['gog:the_witcher'].releaseDate, null, 'a month is not a day');
    assert.equal(entries['gog:the_witcher'].releaseDateSource, 'wikidata');
  });

  await t.test('a QID without P577 is a settled answer, not a retry loop', async () => {
    clearedBridge();
    const fetchImpl = async () => jsonResponse({
      results: {
        bindings: [
          {
            item: { value: 'http://www.wikidata.org/entity/Q999001' },
            store: { value: 'epic' },
            slug: { value: 'undated-game' },
          },
        ],
      },
    });
    const first = await identity.fetchSecondaryLinks(
      { epicSlugs: ['undated-game'] },
      { fetchImpl }
    );
    assert.equal(first.queries, 1);
    assert.equal(first.entries['epic:undated_game'].releaseYear, null);
    assert.equal(first.entries['epic:undated_game'].releaseDateSource, null);

    // Settled: a second pass must not ask WDQS again.
    let calls = 0;
    const second = await identity.fetchSecondaryLinks(
      { epicSlugs: ['undated-game'] },
      {
        fetchImpl: async () => {
          calls++;
          return jsonResponse({ results: { bindings: [] } });
        },
      }
    );
    assert.equal(calls, 0);
    assert.equal(second.queries, 0);
    assert.equal(second.cached, 1);
  });

  await t.test('an entry written before P577 is re-asked once (deploy heal)', async () => {
    clearedBridge();
    // Old schema: a QID, no `releaseDateSource` key at all.
    identity.writeCache({
      'epic:alan_wake_2': { qid: 'Q108417001', appid: null, store: 'epic' },
    });
    const fetchImpl = async () =>
      jsonResponse({
        results: {
          bindings: [
            {
              item: { value: 'http://www.wikidata.org/entity/Q108417001' },
              store: { value: 'epic' },
              slug: { value: 'alan-wake-2' },
              date: { value: '2023-10-27T00:00:00Z' },
              precision: { value: '11' },
            },
          ],
        },
      });
    const report = await identity.fetchSecondaryLinks(
      { epicSlugs: ['alan-wake-2'] },
      { fetchImpl }
    );
    assert.equal(report.queries, 1, 'the old entry is not trusted for the date');
    assert.equal(report.entries['epic:alan_wake_2'].releaseYear, 2023);
    assert.equal(identity.readSecondaryLinks()['epic:alan_wake_2'].releaseDate, '2023-10-27');
  });
});

test('applyWikidataYear is additive only', async (t) => {
  await t.test('fills an empty year from the bridged item', () => {
    seedBridge();
    const data = details.applyWikidataYear(
      { source: 'epic', slug: 'alan-wake-2', releaseYear: null, releaseDate: null },
      { store: 'epic' }
    );
    assert.equal(data.releaseYear, 2023);
    assert.equal(data.releaseDate, '2023-10-27');
    assert.equal(data.releaseDateSource, 'wikidata');
  });

  await t.test('a store/catalog year is never replaced', () => {
    seedBridge();
    const original = {
      source: 'epic',
      slug: 'alan-wake-2',
      releaseYear: 2015,
      releaseDate: '2015-05-19',
      releaseDateSource: 'epic-store',
    };
    assert.equal(details.applyWikidataYear(original, { store: 'epic' }), original);
  });

  await t.test('no QID, no P577 or an unknown slug changes nothing', () => {
    seedBridge();
    const noQid = {
      source: 'epic',
      slug: 'no-qid-game',
      releaseYear: null,
      releaseDateSource: null,
    };
    const noDate = {
      source: 'epic',
      slug: 'undated-game',
      releaseYear: null,
      releaseDateSource: null,
    };
    const unknown = { source: 'epic', slug: 'never-asked', releaseYear: null };
    assert.equal(details.applyWikidataYear(noQid, { store: 'epic' }), noQid);
    assert.equal(details.applyWikidataYear(noDate, { store: 'epic' }), noDate);
    assert.equal(details.applyWikidataYear(unknown, { store: 'epic' }), unknown);
  });

  await t.test('no bridge cache at all (pass never ran) changes nothing', () => {
    clearedBridge();
    const data = { source: 'epic', slug: 'alan-wake-2', releaseYear: null };
    assert.equal(details.applyWikidataYear(data, { store: 'epic' }), data);
  });
});

test('Epic partial gets the year from Wikidata', async (t) => {
  await t.test('cached partial (genres only) is healed and genres are untouched', async () => {
    clearDetails();
    seedBridge();
    partialEpicDetail();

    const before = details.readDetail('epic', 'alan-wake-2').doc.data;
    assert.equal(before.releaseYear, null);
    assert.deepEqual(before.genres, ['Horror']);

    // A cache hit: no CMS/catalog client is provided, so any request would throw.
    const resolved = await details.resolveEpic('alan-wake-2', {});
    assert.equal(resolved.cached, true);
    assert.equal(resolved.data.releaseYear, 2023);
    assert.equal(resolved.data.releaseDate, '2023-10-27');
    assert.equal(resolved.data.releaseDateSource, 'wikidata');
    assert.deepEqual(resolved.data.genres, ['Horror'], 'genres are not rewritten');
    assert.equal(resolved.data.storeReleaseDate, null, 'the store date field is not faked');
    assert.equal(resolved.data.metaStatus, 'complete');
    assert.equal(resolved.data.metaYearHas, true);

    // Persisted: the next /stats sees the year without another resolve.
    const doc = details.readDetail('epic', 'alan-wake-2').doc;
    assert.equal(doc.data.releaseYear, 2023);
    assert.equal(doc.data.releaseDateSource, 'wikidata');
  });

  await t.test('CMS page with genres but no date: the year comes from P577', async () => {
    clearDetails();
    seedBridge();
    const cms = fakeClient({ 'content/products/alan-wake-2': epicCmsWithoutDate() });
    const resolved = await details.resolveEpic('alan-wake-2', {
      client: cms,
      title: 'Alan Wake 2',
    });
    assert.equal(resolved.status, 'ok');
    assert.equal(cms.calls.length, 1);
    assert.deepEqual(resolved.data.genres, ['Horror']);
    assert.deepEqual(resolved.data.developers, ['Remedy Entertainment']);
    assert.match(resolved.data.verticalCover, /1200x1600/);
    assert.equal(resolved.data.releaseYear, 2023);
    assert.equal(resolved.data.releaseDate, '2023-10-27');
    assert.equal(resolved.data.releaseDateSource, 'wikidata');
    assert.equal(resolved.data.storeReleaseDate, null);
    assert.equal(resolved.data.metaStatus, 'complete');
  });

  await t.test('no bridged year: the detail stays partial, no fake year', async () => {
    clearDetails();
    // Bridge has the item but no P577 (`undated-game`).
    seedBridge();
    details.writeDetail('epic', 'undated-game', 'ok', {
      ...partialEpicDetail({ slug: 'undated-game', title: 'Undated Game' }),
    });
    const resolved = await details.resolveEpic('undated-game', {});
    assert.equal(resolved.data.releaseYear, null);
    assert.equal(resolved.data.releaseDateSource, null);
    assert.equal(resolved.data.metaStatus, 'partial');
    assert.equal(details.readDetail('epic', 'undated-game').doc.data.releaseYear, null);
  });

  await t.test('coverage moves partial -> resolved once the year is known', async () => {
    clearDetails();
    seedBridge();
    const steamId = '76561198000000715';
    const owner = `steam-${steamId}`;
    const account = 'epic-wd-year';
    await seedOwner({ steamId, owner, account, catalogItemId: 'wd-year-cat' });
    partialEpicDetail();

    const before = details.coverageForOwner(owner);
    assert.equal(before.epic.total, 1);
    assert.equal(before.epic.resolved, 0);
    assert.equal(before.epic.partial, 1);

    // No catalogItemId: this test proves the year heal alone (the catalog step
    // is a separate path with its own token/client and must not be reached).
    await details.resolveEpic('alan-wake-2', { ownerKey: owner });

    const after = details.coverageForOwner(owner);
    assert.equal(after.epic.resolved, 1, '1/1 after the year arrived');
    assert.equal(after.epic.partial, 0);
    assert.equal(after.resolved, after.total);
  });
});

test('GOG partial gets the year from Wikidata', async (t) => {
  await t.test('a product page without any date is completed from P577', async () => {
    clearDetails();
    seedBridge();
    const payload = gogProductWithoutDate(1229800000);
    const client = fakeClient({ 'api.gog.com/v2/games/1229800000': payload });
    const resolved = await details.resolveGog('1229800000', {
      slug: 'the_witcher',
      client,
    });
    assert.equal(resolved.status, 'ok');
    // The store id is kept exactly as given by the store (no rounding).
    assert.equal(resolved.data.id, '1229800000');
    assert.deepEqual(resolved.data.genres, ['Role-playing', 'Action', 'Fantasy']);
    assert.equal(resolved.data.releaseYear, 2007);
    assert.equal(resolved.data.releaseDate, '2007-10-26');
    assert.equal(resolved.data.releaseDateSource, 'wikidata');
    assert.equal(resolved.data.storeReleaseDate, null);
    assert.equal(resolved.data.globalReleaseDate, null);
  });

  await t.test('a cached GOG detail without a year is healed in place', async () => {
    clearDetails();
    seedBridge();
    details.writeDetail('gog', '1229800000', 'ok', {
      schemaVersion: 1,
      source: 'gog',
      id: '1229800000',
      title: 'The Witcher: Enhanced Edition',
      slug: 'the_witcher',
      genres: ['Role-playing', 'Action'],
      tags: [],
      releaseDate: null,
      releaseYear: null,
      releaseDateSource: null,
      globalReleaseDate: null,
      storeReleaseDate: null,
      verticalCover: null,
      image: null,
      logo: null,
      developers: [],
      publishers: [],
      series: null,
      platforms: [],
      fetchedAt: NOW,
    });
    const resolved = await details.resolveGog('1229800000', { slug: 'the_witcher' });
    assert.equal(resolved.cached, true);
    assert.equal(resolved.data.releaseYear, 2007);
    assert.equal(resolved.data.releaseDateSource, 'wikidata');
    assert.deepEqual(resolved.data.genres, ['Role-playing', 'Action']);
  });

  await t.test('a store date is not replaced by the bridged one', async () => {
    clearDetails();
    seedBridge();
    const client = fakeClient({ 'api.gog.com/v2/games/1229800000': GOG_WITCHER });
    const resolved = await details.resolveGog('1229800000', {
      slug: 'the_witcher',
      client,
    });
    assert.equal(resolved.data.releaseYear, 2007);
    assert.equal(resolved.data.releaseDateSource, 'gog-global');
    assert.equal(resolved.data.globalReleaseDate, '2007-10-26T00:00:00+02:00');
  });
});

test('the union reports the Wikidata provenance', async (t) => {
  await t.test('releaseYearSource becomes wikidata, Steam-derived data is kept', () => {
    seedBridge();
    const union = {
      works: [
        {
          workKey: 'epic:aw2',
          minutes: 120,
          primary: { name: 'Alan Wake 2' },
          releaseYear: null,
          releaseYearSource: null,
          epic: { slug: 'alan-wake-2', catalogItemId: 'aw2-cat' },
        },
      ],
    };
    details.enrichUnionWithDetails(union, {
      'epic:alan-wake-2': {
        source: 'epic',
        id: 'alan-wake-2',
        genres: ['Horror'],
        genresSource: 'epic-catalog',
        releaseYear: 2023,
        releaseDate: '2023-10-27',
        releaseDateSource: 'wikidata',
        fetchedAt: NOW,
      },
    });
    const entry = union.works[0];
    assert.equal(entry.releaseYear, 2023);
    assert.equal(entry.releaseYearSource, 'wikidata');
    assert.deepEqual(entry.genres, ['Horror']);
    assert.equal(entry.secondaryDetails.releaseDateSource, 'wikidata');
    assert.equal(entry.secondaryDetails.metaStatus, 'complete');
  });
});

}
