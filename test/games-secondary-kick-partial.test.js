'use strict';

/**
 * M6d fix-round (02.11.2026): a **partial** Epic detail must trigger the lazy
 * catalog kick.
 *
 * Production symptom (Alan Wake 2 on the wife's profile):
 * `resolved 0/1, partial 1`, `catalogAttempts.total 0`, no kick in the history.
 * Root cause: `coverageForOwner` classified a detail with only one of
 * year/genres as `partial` and left `pending` at 0, so `kickFromStats` returned
 * `{skipped:'attempted'}` without ever asking the catalog. The kick rule is now
 * `resolved < total || partial > 0 || noSlug > 0` and the refined coverage
 * exposes `retryablePartial`.
 *
 * All store calls are injected; no live request.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-partial-kick-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-partial-kick-state-')
);
process.env.KINOBOXD_STEAM_KEY_FILE = path.join(
  process.env.KINOBOXD_STATE_DIR,
  'no-steam-token'
);
process.env.GAMES_SECONDARY_PAUSE_MS = '1';

const gameCache = require('../server/games/game-cache');
const epicCache = require('../server/games/epic-cache');
const tokenStore = require('../server/games/epic-token-store');
const details = require('../server/games/secondary-details');
const { buildGamesStatsFromCache } = require('../server/games/stats');

const STEAM_ID = '76561198000000777';
const OWNER = `steam-${STEAM_ID}`;
const ACCOUNT = 'epic-partial-kick';
const CATALOG_ID = 'aw2-partial-catalog';
const SLUG = 'alan-wake-2';

const NOW = new Date().toISOString();

async function seedOwner() {
  await gameCache.saveProfile({
    userKey: STEAM_ID,
    personaName: 'partial-kick',
    privacy: 'public',
    importedAt: NOW,
    fetchedAt: NOW,
  });
  await gameCache.saveLibrary(STEAM_ID, {
    fetchedAt: NOW,
    partial: false,
    source: 'steam-webapi',
    game_count: 0,
    games: [],
  });
  await epicCache.saveEpicProfile({ accountId: ACCOUNT, ownerKey: OWNER, connectedAt: NOW });
  await epicCache.saveEpicLibrary(ACCOUNT, {
    accountId: ACCOUNT,
    fetchedAt: NOW,
    games: [{ appName: 'Ginger', catalogItemId: CATALOG_ID, slug: SLUG, name: 'Alan Wake 2' }],
  });
  await tokenStore.saveTokens({
    accountId: ACCOUNT,
    displayName: 'EpicPartial',
    ownerKey: OWNER,
    accessToken: 'eg1~fake-access-token',
    refreshToken: 'eg1~fake-refresh-token',
    accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
  });
}

function writePartialDetail(extra = {}) {
  details.writeDetail('epic', SLUG, 'ok', {
    schemaVersion: 1,
    source: 'epic',
    id: SLUG,
    title: 'Alan Wake 2',
    slug: SLUG,
    genres: [],
    releaseDate: null,
    releaseYear: 2023,
    releaseDateSource: 'epic-catalog',
    verticalCover: 'https://cdn1.epicgames.com/aw2/portrait-1200x1600.jpg',
    fetchedAt: NOW,
    catalogChecked: true,
    metaStatus: 'partial',
    metaYearHas: true,
    metaGenresOk: false,
    ...extra,
  });
}

function fakeCatalogClient() {
  const calls = [];
  return {
    calls,
    async getCatalogBulk(namespace, ids) {
      calls.push({ namespace, ids: [...ids] });
      return {
        items: {
          [CATALOG_ID]: {
            catalogItemId: CATALOG_ID,
            title: 'Alan Wake 2',
            slug: SLUG,
            releaseDate: '2023-10-27T00:00:00.000Z',
            categories: [{ path: 'games' }, { path: 'games/action' }, { path: 'games/horror' }],
          },
        },
        requests: 1,
        failures: [],
        chunks: [{ ids: [CATALOG_ID], status: 200, bytes: 512 }],
      };
    },
    async refreshTokens() {
      throw new Error('refresh must not be needed in this test');
    },
  };
}

function fakeClient(calls) {
  return {
    async getJson(url) {
      calls.push(url);
      throw new Error(`unexpected CMS request in the partial test: ${url}`);
    },
  };
}

async function waitForJob(timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    const job = details.jobFor(OWNER);
    if (job && job.status !== 'running') return job;
    if (Date.now() - started > timeoutMs) throw new Error('job did not finish in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function clearState() {
  details.resetJobs();
  try {
    fs.rmSync(details.CATALOG_STATE_PATH, { force: true });
  } catch (err) {
    /* nothing to clean */
  }
  try {
    fs.rmSync(details.STATUS_PATH, { force: true });
  } catch (err) {
    /* nothing to clean */
  }
}

test('coverageNeedsKick: the documented rule, in one place', () => {
  assert.equal(details.coverageNeedsKick({ resolved: 0, total: 1, partial: 0, noSlug: 0 }), true);
  assert.equal(details.coverageNeedsKick({ resolved: 1, total: 1, partial: 0, noSlug: 0 }), false);
  assert.equal(details.coverageNeedsKick({ resolved: 1, total: 1, partial: 1, noSlug: 0 }), true);
  assert.equal(details.coverageNeedsKick({ resolved: 1, total: 1, partial: 0, noSlug: 1 }), true);
  assert.equal(details.coverageNeedsKick(null), false);
  assert.equal(details.coverageNeedsKick({}), false);
});

test('partial coverage: retryablePartial > 0, status and stats expose partial', async (t) => {
  await t.test('fresh partial detail with no catalog ledger is retryable', async () => {
    clearState();
    await seedOwner();
    writePartialDetail();

    const coverage = details.coverageForOwner(OWNER);
    assert.equal(coverage.total, 1);
    assert.equal(coverage.resolved, 0);
    assert.equal(coverage.partial, 1);
    assert.equal(coverage.retryablePartial, 1);
    assert.equal(coverage.pending, 0);

    const status = details.statusForOwner(OWNER);
    assert.equal(status.resolved, 0);
    assert.equal(status.total, 1);
    assert.equal(status.partial, 1);
    assert.equal(status.retryablePartial, 1);
    assert.equal(status.bySource.epic.partial, 1);
    assert.equal(status.catalogAttempts.total, 0);
  });

  await t.test('/stats carries partial in meta.secondaryDetails', async () => {
    const stats = buildGamesStatsFromCache(OWNER);
    assert.ok(stats, 'the owner has a library snapshot');
    assert.equal(stats.meta.secondaryDetails.total, 1);
    assert.equal(stats.meta.secondaryDetails.resolved, 0);
    assert.equal(stats.meta.secondaryDetails.partial, 1);
    assert.equal(stats.meta.secondaryDetails.noSlug, 0);
  });

  await t.test('kickFromStats with partial starts the job and completes the detail', async () => {
    clearState();
    writePartialDetail();
    const catalogClient = fakeCatalogClient();
    const cmsCalls = [];
    const kicked = details.kickFromStats(
      OWNER,
      { resolved: 0, total: 1, partial: 1, noSlug: 0 },
      {
        client: fakeClient(cmsCalls),
        epicClient: catalogClient,
        tokenStore,
        pauseMs: 0,
      }
    );
    assert.equal(kicked.skipped, undefined, 'the partial work must not be skipped');
    assert.ok(kicked.id, 'a job was started');
    const job = await waitForJob();
    assert.equal(job.status, 'done');
    assert.equal(catalogClient.calls.length, 1);
    assert.deepEqual(catalogClient.calls[0].ids, [CATALOG_ID]);
    assert.equal(cmsCalls.length, 0, 'a fresh partial detail is not refetched from the CMS');

    const doc = details.readDetail('epic', SLUG).doc;
    assert.deepEqual(doc.data.genres, ['Action', 'Horror']);
    assert.equal(doc.data.releaseYear, 2023);
    assert.equal(doc.data.metaStatus, 'complete');

    const status = details.statusForOwner(OWNER);
    assert.equal(status.resolved, 1);
    assert.equal(status.partial, 0);
    assert.equal(status.catalogAttempts.total, 1);
    assert.equal(status.catalogAttempts.items[0].lastResult, 'shape_ok');
    // The kick ledger proves the trigger: the production symptom was «no kick
    // at all», so `stats` must be visible in the history.
    assert.ok(
      status.kick.history.some((entry) => entry.trigger === 'stats' && entry.result === 'started')
    );
  });

  await t.test('a settled partial (shape_ok ledger) is not kicked again', async () => {
    clearState();
    writePartialDetail();
    details.recordCatalogAttempt(OWNER, CATALOG_ID, {
      result: 'shape_ok',
      httpStatus: 200,
      bytes: 512,
      genresOk: true,
      yearHas: true,
    });
    const coverage = details.coverageForOwner(OWNER);
    assert.equal(coverage.partial, 1);
    assert.equal(coverage.retryablePartial, 0, 'a shape_ok answer is terminal even if the doc is partial');

    const skipped = details.kickFromStats(OWNER, {
      resolved: 0,
      total: 1,
      partial: 1,
      noSlug: 0,
    });
    assert.equal(skipped.skipped, 'attempted');
    assert.equal(details.jobFor(OWNER), null);
  });
});
