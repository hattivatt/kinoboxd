'use strict';

/**
 * M6d fix-round (02.11.2026): the «library-only» Epic card stayed empty on
 * production after 66c3d21 because **nothing re-kicked** the store-metadata job
 * for a library imported before the deploy, and a CMS edge can answer `403`
 * from another IP.
 *
 * These tests pin:
 *   - `GET /api/games/secondary-details/status` (the owner's copy-paste check);
 *   - the lazy kick from `GET /api/games/stats` (coalesced, fire-and-forget);
 *   - the end-to-end chain kick → title probe → slug override → union card
 *     (the order-of-calls check for 66c3d21);
 *   - the CMS transport: browser UA, IPv4 mirror fallback, `cms_blocked`
 *     breaker, the ≤2 KB debug dump;
 *   - a stale catalog slug that 404s → validated title-probe fallback.
 *
 * No live request: the details client is injected, and the transport tests use
 * a throwaway HTTP server on 127.0.0.1 (port 7109 per the round brief).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-secondary-status-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-secondary-status-state-')
);
process.env.KINOBOXD_STEAM_KEY_FILE = path.join(
  process.env.KINOBOXD_STATE_DIR,
  'no-steam-token'
);
// The job pause is politeness for the live stores; the tests use a fake client.
process.env.GAMES_SECONDARY_PAUSE_MS = '1';

const { createRouter } = require('../server/games/routes');
const gameCache = require('../server/games/game-cache');
const gogCache = require('../server/games/gog-cache');
const epicCache = require('../server/games/epic-cache');
const details = require('../server/games/secondary-details');
const { buildGamesStatsFromCache } = require('../server/games/stats');

const FIXTURES = path.join(__dirname, 'fixtures', 'games');
function fixture(relative) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, relative), 'utf8'));
}
const EPIC_AW2 = fixture('epic/product-alan-wake-2.json');

const PORT = 7109;
const STEAM_ID = '76561198000000710';
const OWNER = `steam-${STEAM_ID}`;
const EPIC_ACCOUNT = 'epic-wife';

const CONTROL_PAYLOAD = {
  productName: 'Control',
  pages: [
    {
      type: 'productHome',
      productName: 'Control',
      data: {
        meta: {
          releaseDate: '2019-08-27T00:00:00.000Z',
          tags: ['ACTION', 'THIRD_PERSON_SHOOTER'],
          developer: ['Remedy Entertainment'],
          publisher: ['505 Games'],
        },
        hero: {
          portraitBackgroundImageUrl: 'https://cdn1.epicgames.com/control-1200x1600.jpg',
          backgroundImageUrl: 'https://cdn1.epicgames.com/control-2560x1440.jpg',
        },
      },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* seed                                                                */
/* ------------------------------------------------------------------ */

async function seed() {
  const now = new Date().toISOString();
  await gameCache.saveProfile({
    userKey: STEAM_ID,
    personaName: 'wife',
    ownerLabel: 'Жена',
    importedAt: now,
    fetchedAt: now,
  });
  await gameCache.saveLibrary(STEAM_ID, {
    userKey: STEAM_ID,
    fetchedAt: now,
    game_count: 1,
    partial: false,
    fingerprint: '292030',
    totalMinutes: 600,
    games: [
      {
        appid: 292030,
        name: 'The Witcher 3: Wild Hunt',
        playtime_forever: 600,
        playtime_2weeks: 0,
        rtime_last_played: 0,
      },
    ],
  });
  await gameCache.saveDetails(292030, {
    success: true,
    type: 'game',
    name: 'The Witcher 3: Wild Hunt',
    releaseYear: 2015,
    genres: [{ id: '3', description: 'RPG' }],
    is_free: false,
  });
  await epicCache.saveEpicProfile({
    accountId: EPIC_ACCOUNT,
    ownerKey: OWNER,
    displayName: 'wife',
    connectedAt: now,
    importedAt: now,
  });
  await epicCache.saveEpicLibrary(EPIC_ACCOUNT, {
    accountId: EPIC_ACCOUNT,
    ownerKey: OWNER,
    fetchedAt: now,
    gameCount: 2,
    games: [
      // Alan Wake 2: the catalog bulk knows the *title* but not a slug
      // (productmapping does not list it) → only a validated title probe can
      // address it. `appName` is the launcher codename ("Ginger").
      { appName: 'Ginger', catalogItemId: 'aw2-cat', name: 'Ginger' },
      // A normal exclusive with a catalog slug.
      { appName: 'Control', catalogItemId: 'control-cat', name: 'Control' },
    ],
  });
  await epicCache.saveEpicPlaytime(EPIC_ACCOUNT, {
    accountId: EPIC_ACCOUNT,
    fetchedAt: now,
    byArtifactId: {
      'aw2-cat': { artifactId: 'aw2-cat', totalTimeSec: 196200, totalMinutes: 3270 },
      'control-cat': { artifactId: 'control-cat', totalTimeSec: 3600, totalMinutes: 60 },
    },
    totalSeconds: 199800,
    totalMinutes: 3330,
  });
  await epicCache.saveEpicCatalogItem('aw2-cat', {
    title: 'Alan Wake 2',
    releaseDate: '2023-10-27T00:00:00.000Z',
    categories: [{ path: 'games' }, { path: 'games/action' }, { path: 'games/horror' }],
  });
  await epicCache.saveEpicCatalogItem('control-cat', {
    title: 'Control',
    slug: 'control',
    releaseDate: '2019-08-27T00:00:00.000Z',
    categories: [{ path: 'games' }, { path: 'games/action' }],
  });
}

function fakeDetailsClient(handlers = {}) {
  const calls = [];
  return {
    calls,
    async getJson(url) {
      calls.push(url);
      const key = Object.keys(handlers).find((needle) => url.includes(needle));
      if (!key) {
        const err = Object.assign(new Error(`unexpected URL: ${url}`), {
          code: 'secondary_details_unexpected',
        });
        throw err;
      }
      const value = handlers[key];
      if (typeof value === 'function') return value(url);
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

function notFoundError() {
  return Object.assign(new Error('404'), {
    code: 'secondary_details_not_found',
    status: 404,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJob(ownerKey, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    const job = details.jobFor(ownerKey);
    if (job && job.status !== 'running') return job;
    if (Date.now() - started > timeoutMs) throw new Error('job did not finish in time');
    await delay(5);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP status + lazy kick                                             */
/* ------------------------------------------------------------------ */

test('secondary details status + lazy kick', async (t) => {
  details.resetJobs();
  await seed();

  const detailsClient = fakeDetailsClient({
    '/products/alan-wake-2': EPIC_AW2,
    '/products/control': CONTROL_PAYLOAD,
  });
  const app = express();
  app.use(express.json());
  app.use(
    '/api/games',
    createRouter({ client: {}, autoEnrich: false, secondaryDetailsClient: detailsClient })
  );
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    res.status(500).json({ error: 'internal', code: 'internal_error' });
  });
  const server = app.listen(PORT);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${PORT}`;

  await t.test('status is honest before the first kick (slugless is named)', async () => {
    const response = await fetch(`${base}/api/games/secondary-details/status?profile=${OWNER}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.profile, OWNER);
    assert.equal(body.total, 2);
    assert.equal(body.resolved, 0);
    assert.equal(body.running, false);
    assert.deepEqual(body.bySource.epic, {
      total: 2,
      resolved: 0,
      notFound: 0,
      missingSlug: 1,
      pending: 2,
    });
    assert.equal(body.bySource.gog.total, 0);
    // Alan Wake 2 cannot be addressed by slug; its catalog title is reported.
    assert.deepEqual(body.slugless, [
      { name: 'Alan Wake 2', catalogItemId: 'aw2-cat', appName: 'Ginger' },
    ]);
    assert.deepEqual(body.lastErrors, []);
    assert.equal(body.cooldownUntil, null);
    assert.equal(body.lastRunAt, null);
    assert.equal(body.kick.lastKickAt, null);
    // The diagnostic endpoint never makes a network request.
    assert.equal(detailsClient.calls.length, 0);
  });

  await t.test('the diagnostic endpoint rejects unknown parameters', async () => {
    const unknown = await fetch(
      `${base}/api/games/secondary-details/status?profile=${OWNER}&kick=1`
    );
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).code, 'unexpected_parameter');
    const missing = await fetch(`${base}/api/games/secondary-details/status`);
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).code, 'profile_required');
  });

  await t.test('GET /stats kicks the job lazily and reports running', async () => {
    const response = await fetch(`${base}/api/games/stats?profile=${OWNER}`);
    assert.equal(response.status, 200);
    const stats = await response.json();
    // The first answer already says the job is running (no UI change needed).
    assert.equal(stats.meta.secondaryDetails.running, true);
    // Before the slug override exists the read model can address only Control:
    // Alan Wake 2 is `noSlug`, which is exactly why the kick is needed.
    assert.equal(stats.meta.secondaryDetails.total, 1);
    assert.equal(stats.meta.secondaryDetails.noSlug, 1);
    assert.equal(stats.meta.secondaryDetails.resolved, 0);

    const job = await waitForJob(OWNER);
    assert.equal(job.status, 'done');
    assert.equal(job.epic.total, 2);
    assert.equal(job.epic.resolved, 2);
    assert.equal(job.epic.missingSlug, 1);
    // Probe + explicit slug: the probe request is counted, the product page is
    // reused from the probe payload (66c3d21 behaviour).
    assert.equal(detailsClient.calls.length, 2);
    assert.match(detailsClient.calls[0], /products\/alan-wake-2$/);
    assert.match(detailsClient.calls[1], /products\/control$/);
    // The discovered slug is remembered for the read model.
    assert.equal(epicCache.getEpicSlugOverride('aw2-cat'), 'alan-wake-2');
    assert.equal(details.readDetail('epic', 'alan-wake-2').doc.status, 'ok');
    assert.equal(details.readDetail('epic', 'control').doc.status, 'ok');
  });

  await t.test('the union card is filled on the next /stats (order of calls)', async () => {
    const response = await fetch(`${base}/api/games/stats?profile=${OWNER}`);
    assert.equal(response.status, 200);
    const stats = await response.json();
    assert.deepEqual(stats.meta.secondaryDetails, {
      resolved: 2,
      total: 2,
      noSlug: 0,
      running: false,
    });
    const aw2 = stats.secondaryWorks.find((entry) => entry.name === 'Alan Wake 2');
    assert.ok(aw2, 'Alan Wake 2 is a secondary-only work');
    assert.equal(aw2.source, 'epic');
    // Stale CMS page: the year/genres come from the catalog bulk, the poster
    // from the CMS portrait (1200×1600), exactly the 66c3d21 contract.
    assert.equal(aw2.releaseYear, 2023);
    assert.deepEqual(aw2.genres, ['Action', 'Horror']);
    assert.match(aw2.verticalCover, /1200x1600/);
    // Provenance is signed in the payload (the union attached the detail).
    assert.ok(aw2.metadataSources.includes('epic-store'));
    assert.ok(aw2.metadataSources.includes('epic-catalog'));
    // Hours stay Epic-only (minutes → hours at the payload boundary).
    assert.equal(aw2.hoursBySource.epic, 54.5);
    assert.equal(aw2.hoursBySource.steam, null);
  });

  await t.test('a settled kick starts the cooldown; no second job is spawned', async () => {
    const before = details.jobFor(OWNER).id;
    assert.equal(details.kickGate(OWNER), 'cooldown');
    const direct = details.kickSecondaryDetailsQuietly(OWNER, { gog: [], epic: [] });
    assert.equal(direct.skipped, 'cooldown');
    // Every work is already attempted: even without a cooldown the lazy kick
    // would not start a no-op job.
    const noop = details.kickFromStats(OWNER, { resolved: 0, total: 1, noSlug: 0 });
    assert.equal(noop.skipped, 'attempted');
    assert.equal(details.jobFor(OWNER).id, before);
  });

  await t.test('status after the run: coverage, kick history and lastRunAt', async () => {
    const response = await fetch(`${base}/api/games/secondary-details/status?profile=${OWNER}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, 2);
    assert.equal(body.resolved, 2);
    assert.equal(body.pending, 0);
    assert.equal(body.running, false);
    assert.equal(body.bySource.epic.resolved, 2);
    // The discovered override removed the slugless slot.
    assert.equal(body.bySource.epic.missingSlug, 0);
    assert.deepEqual(body.slugless, []);
    assert.ok(body.lastRunAt);
    // The ledger proves *who* asked: the deploy-time symptom was «nobody
    // kicked», so the trigger is part of the diagnostic.
    assert.ok(
      body.kick.history.some((entry) => entry.trigger === 'stats' && entry.result === 'started')
    );
    assert.equal(body.kick.lastKickAt != null, true);
    assert.ok(body.cooldownUntil);
    assert.equal(body.breakers.epic, null);
    assert.equal(body.checkedAt != null, true);
  });

  await t.test('coalescing: a second kick reuses the running job', async () => {
    details.resetJobs();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const gatedClient = fakeDetailsClient({
      '/products/fresh-target': async () => {
        await gate;
        return CONTROL_PAYLOAD;
      },
    });
    const target = {
      slug: 'fresh-target',
      id: 'fresh-cat',
      catalogItemId: 'fresh-cat',
      title: 'Fresh Target',
    };
    const first = details.kickSecondaryDetailsQuietly(OWNER, {
      gog: [],
      epic: [target],
      client: gatedClient,
      pauseMs: 0,
    });
    assert.ok(first.id);
    const second = details.kickSecondaryDetailsQuietly(OWNER, {
      gog: [],
      epic: [target],
      client: gatedClient,
      pauseMs: 0,
    });
    assert.equal(second.skipped, 'running');
    release();
    await waitForJob(OWNER);
  });
});

/* ------------------------------------------------------------------ */
/* CMS transport: UA, mirror, breaker, dump                            */
/* ------------------------------------------------------------------ */

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function cleanDebug() {
  try {
    fs.rmSync(details.DEBUG_DIR, { recursive: true, force: true });
  } catch (err) {
    /* nothing */
  }
}

test('CMS transport: browser UA, IPv4 mirror, cms_blocked, debug dump', async (t) => {
  details.writeBreaker({});
  cleanDebug();
  t.after(cleanDebug);

  await t.test('primary 403 → IPv4 mirror 200, browser UA on both attempts', async () => {
    const seen = [];
    const server = await startServer((req, res) => {
      seen.push({ url: req.url, ua: req.headers['user-agent'] });
      if (req.url.startsWith('/primary/')) {
        res.writeHead(403, { 'content-type': 'text/html' });
        res.end('<html>blocked by edge</html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(EPIC_AW2));
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const port = server.address().port;
    const urlOf = (slug, host) =>
      `http://127.0.0.1:${port}/${host}/api/en-US/content/products/${slug}`;

    const result = await details.resolveEpic('aw2-mirror', {
      hosts: ['primary', 'mirror'],
      urlOf,
      force: true,
      ignoreBreaker: true,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.host, 'mirror');
    assert.equal(result.data.title, 'Alan Wake 2');
    assert.equal(seen.length, 2);
    assert.match(seen[0].url, /^\/primary\//);
    assert.match(seen[1].url, /^\/mirror\//);
    // A browser UA, not the `kinoboxd/1.0` bot string.
    for (const entry of seen) {
      assert.match(entry.ua, /^Mozilla\/5\.0/);
      assert.match(entry.ua, /Chrome\//);
    }
    // The failed primary answer is dumped for the owner to send back.
    const dump = JSON.parse(
      fs.readFileSync(path.join(details.DEBUG_DIR, 'aw2-mirror.json'), 'utf8')
    );
    assert.equal(dump.status, 403);
    assert.equal(dump.host, 'primary');
    assert.equal(dump.body, '<html>blocked by edge</html>');
    assert.ok(dump.body.length <= 2048);
    assert.equal(details.breakerBlock('epic'), null);
  });

  await t.test('both hosts 403 → breaker cms_blocked for 30 minutes', async () => {
    details.writeBreaker({});
    cleanDebug();
    let requests = 0;
    const server = await startServer((req, res) => {
      requests++;
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('nope');
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const port = server.address().port;
    const urlOf = (slug, host) =>
      `http://127.0.0.1:${port}/${host}/api/en-US/content/products/${slug}`;

    await assert.rejects(
      () =>
        details.resolveEpic('blocked-slug', {
          hosts: ['primary', 'mirror'],
          urlOf,
          force: true,
          ignoreBreaker: true,
        }),
      (err) =>
        err.code === 'secondary_details_blocked' && err.status === 403 && err.deferred === true
    );
    assert.equal(requests, 2);
    const blocked = details.breakerBlock('epic');
    assert.ok(blocked);
    assert.equal(blocked.code, 'cms_blocked');
    assert.ok(Date.parse(blocked.until) - Date.now() > 25 * 60 * 1000);
    // The next product is refused without a request, and says why.
    await assert.rejects(
      () =>
        details.resolveEpic('another-slug', {
          hosts: ['primary', 'mirror'],
          urlOf,
          force: true,
        }),
      (err) =>
        err.code === 'secondary_details_blocked' &&
        err.breakerCode === 'cms_blocked' &&
        err.deferred === true
    );
    assert.equal(requests, 2);
    details.writeBreaker({});
  });

  await t.test('429 is a rate limit: no mirror retry, breaker still tripped', async () => {
    details.writeBreaker({});
    let requests = 0;
    const server = await startServer((req, res) => {
      requests++;
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":"rate"}');
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const port = server.address().port;
    const urlOf = (slug, host) =>
      `http://127.0.0.1:${port}/${host}/api/en-US/content/products/${slug}`;
    await assert.rejects(() =>
      details.resolveEpic('rate-limited', {
        hosts: ['primary', 'mirror'],
        urlOf,
        force: true,
        ignoreBreaker: true,
      })
    );
    assert.equal(requests, 1);
    assert.equal(details.breakerBlock('epic').code, 'cms_blocked');
    details.writeBreaker({});
  });

  await t.test('the dump keeps at most three files and masks query secrets', async () => {
    cleanDebug();
    details.writeBreaker({});
    let requests = 0;
    const server = await startServer((req, res) => {
      requests++;
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`boom ${'x'.repeat(5000)}`);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const port = server.address().port;
    const urlOf = (slug, host) =>
      `http://127.0.0.1:${port}/${host}/api/en-US/content/products/${slug}?token=secret-value`;
    for (const slug of ['one', 'two', 'three', 'four']) {
      await assert.rejects(() =>
        details.resolveEpic(slug, {
          hosts: ['primary'],
          urlOf,
          force: true,
          ignoreBreaker: true,
        })
      );
    }
    assert.equal(requests, 4);
    const files = fs.readdirSync(details.DEBUG_DIR).filter((name) => name.endsWith('.json'));
    assert.equal(files.length, 3);
    const dump = JSON.parse(fs.readFileSync(path.join(details.DEBUG_DIR, 'one.json'), 'utf8'));
    assert.equal(dump.status, 500);
    assert.equal(dump.body.length, 2048);
    assert.equal(dump.url.includes('secret-value'), false);
    assert.match(dump.url, /token=\*\*\*/);
    details.writeBreaker({});
  });
});

/* ------------------------------------------------------------------ */
/* stale slug → title-probe fallback                                   */
/* ------------------------------------------------------------------ */

test('a stale catalog slug falls back to the validated title probe', async (t) => {
  details.resetJobs();
  details.writeBreaker({});
  t.after(() => details.writeBreaker({}));

  await t.test('404 on the catalog slug → probe resolves and the override is saved', async () => {
    const client = fakeDetailsClient({
      '/products/stale-control': () => {
        throw notFoundError();
      },
      '/products/control': CONTROL_PAYLOAD,
    });
    const result = await details.resolveEpic('stale-control', {
      client,
      title: 'Control',
      catalogItemId: 'control-cat',
      probeBudget: 5,
      force: true,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.data.slug, 'control');
    assert.equal(epicCache.getEpicSlugOverride('control-cat'), 'control');
    // The stale slug itself is NOT remembered as «not found».
    assert.equal(details.readDetail('epic', 'stale-control').doc, null);
    assert.equal(client.calls.length, 2);
  });

  await t.test('both the slug and the probe 404 → honest not_found, no override', async () => {
    const client = fakeDetailsClient({
      '/products/': () => {
        throw notFoundError();
      },
    });
    const result = await details.resolveEpic('stale-x', {
      client,
      title: 'Some Exclusive',
      catalogItemId: 'x-cat',
      probeBudget: 5,
      force: true,
    });
    assert.equal(result.status, 'not_found');
    const addressed = details.readDetail('epic', 'stale-x').doc;
    assert.equal(addressed.status, 'not_found');
    // The guess is a short-lived memory, not a verdict.
    const guess = details.readDetail('epic', 'some-exclusive').doc;
    assert.equal(guess.status, 'not_found');
    assert.equal(guess.probe, true);
    assert.equal(epicCache.getEpicSlugOverride('x-cat'), null);
  });

  await t.test('a probe-only negative does not block an explicitly addressed slug', async () => {
    // `some-exclusive` is cached as `probe: true`; if the catalog later names
    // exactly that slug, the product must be fetched, not served as 404.
    const client = fakeDetailsClient({
      '/products/some-exclusive': {
        productName: 'Some Exclusive',
        pages: [
          {
            type: 'productHome',
            productName: 'Some Exclusive',
            data: { meta: { releaseDate: '2021-01-01', tags: ['ACTION'] } },
          },
        ],
      },
    });
    const result = await details.resolveEpic('some-exclusive', {
      client,
      title: 'Some Exclusive',
      force: false,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.data.releaseYear, 2021);
    assert.equal(client.calls.length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* 403 from the job → reason, not «no data»                            */
/* ------------------------------------------------------------------ */

test('a blocked CMS is reported as epic_cms_blocked in the job', async (t) => {
  details.resetJobs();
  details.writeBreaker({});
  t.after(() => details.writeBreaker({}));
  const client = fakeDetailsClient({
    '/products/': Object.assign(new Error('blocked'), {
      code: 'secondary_details_blocked',
      status: 403,
      deferred: true,
      reason: 'blocked',
    }),
  });
  details.startSecondaryDetails({
    ownerKey: 'steam-blocked-job',
    gog: [],
    epic: [
      {
        slug: 'blocked-target',
        id: 'blocked-cat',
        catalogItemId: 'blocked-cat',
        title: 'Blocked Target',
      },
    ],
    client,
    pauseMs: 0,
  });
  const job = await waitForJob('steam-blocked-job');
  assert.equal(job.status, 'done');
  // The warning carries the *reason*, so «blocked by the edge» is not read as
  // «the game has no metadata».
  assert.ok(job.warnings.includes('epic_cms_blocked'));
  assert.equal(job.epic.resolved, 0);
  assert.equal(job.epic.deferred, 1);
  const state = details.readStatusState();
  const last = state.lastErrors[state.lastErrors.length - 1];
  assert.equal(last.source, 'epic');
  assert.equal(last.status, 403);
  assert.equal(last.reason, 'cms_blocked');
  assert.equal(last.ownerKey, 'steam-blocked-job');
});
