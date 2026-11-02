'use strict';

/**
 * Fix-round 02.11.2026 — «Epic-фаза secondary-details молча скипает каталог».
 *
 * Production symptom after 19475ce: `bySource.epic {total:1, partial:1,
 * retryablePartial:1}`, the kick ledger shows the job starting, `lastRunAt`
 * ~1 s later, but `catalogAttempts.total: 0`, `lastErrors: []`, no breaker.
 *
 * Root cause pinned here by the first test: `epic-import.js` writes
 * `catalog/<id>.json` from the **same** bulk endpoint the details phase uses,
 * but it records no per-owner attempt. A document with a release date and only
 * bucket categories («games») made `catalogHasMeta` true while the detail still
 * had no genre, so `ensureEpicCatalog` returned it before `getCatalogBulk`
 * forever. The job counted the work as `resolved`, the ledger stayed empty and
 * nothing was an error — the silent no-op.
 *
 * These tests pin:
 *   - the reuse decision (only a catalog that answers the **missing** fact may
 *     silence the request);
 *   - every early exit is surfaced as `bySource.epic.lastSkip {reason, at}`;
 *   - an unbound/old-format single token is adopted by the owner (self-heal);
 *   - a token that names another owner (or several candidates) is **never**
 *     adopted and is stated in the status;
 *   - the HTTP `/secondary-details/status` response carries both fields.
 *
 * No live request: CMS/catalog clients are injected; the one HTTP server is on
 * the round's port 7114.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-catalog-heal-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-catalog-heal-state-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = STATE_DIR;
process.env.KINOBOXD_STEAM_KEY_FILE = path.join(STATE_DIR, 'no-steam-token');
process.env.GAMES_SECONDARY_PAUSE_MS = '1';

const { createRouter } = require('../server/games/routes');
const gameCache = require('../server/games/game-cache');
const epicCache = require('../server/games/epic-cache');
const tokenStore = require('../server/games/epic-token-store');
const details = require('../server/games/secondary-details');

const PORT = 7114;
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
