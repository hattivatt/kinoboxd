'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-error-mapping-'));
const BOOK_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-error-mapping-books-'));
process.env.KINOBOXD_CACHE_GAMES_DIR = CACHE_DIR;
process.env.KINOBOXD_CACHE_BOOK_DIR = BOOK_CACHE_DIR;
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kinoboxd-error-mapping-state-')
);
process.env.KINOBOXD_GAMES_WD = 'off';
process.env.KINOBOXD_STEAM_KEY_FILE = path.join(process.env.KINOBOXD_STATE_DIR, 'no-steam-token');
process.env.KINOBOXD_MOBY_KEY_FILE = path.join(process.env.KINOBOXD_STATE_DIR, 'no-moby-token');

const { HttpError, errorMiddleware } = require('../server/core/errors');

const booksImport = require('../server/books/import');
const livelibCookies = require('../server/books/livelib-cookies');
const { LivelibError } = require('../server/books/livelib');
const { HardcoverError } = require('../server/books/hardcover');
const booksRoutes = require('../server/books/routes');

const gameCache = require('../server/games/game-cache');
const steam = require('../server/games/steam');
const store = require('../server/games/store');
const spy = require('../server/games/spy');
const epic = require('../server/games/epic');
const gog = require('../server/games/gog');
const franchise = require('../server/games/franchise');
const { PersonnelError } = require('../server/games/personnel/identity');
const gamesRoutes = require('../server/games/routes');
const epicRoutes = require('../server/games/routes-epic');
const gogRoutes = require('../server/games/routes-gog');
const franchiseRoutes = require('../server/games/routes-franchise');
const personnelRoutes = require('../server/games/personnel/routes-personnel');

const ID = '76561198000000021';
const PROFILE = `steam-${ID}`;
const APPID = 620;

let seeded = null;

function ensureSeed() {
  if (!seeded) {
    const now = new Date().toISOString();
    seeded = (async () => {
      await gameCache.saveProfile({
        userKey: ID,
        personaName: 'error mapping',
        privacy: 'public',
        importedAt: now,
        fetchedAt: now,
      });
      await gameCache.saveLibrary(ID, {
        fetchedAt: now,
        partial: false,
        game_count: 1,
        games: [{ appid: APPID, name: 'Portal 2', playtime_forever: 600 }],
      });
    })();
  }
  return seeded;
}

async function mount(t, prefix, router) {
  const app = express();
  app.use(express.json());
  app.use(prefix, router);
  app.use(errorMiddleware);
  const server = app.listen(0);
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}${prefix}`;
}

function patch(target, key, value) {
  const original = target[key];
  target[key] = value;
  return () => {
    target[key] = original;
  };
}

async function expectError(t, response, status, code, message) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['code', 'error']);
  assert.equal(body.code, code);
  if (message !== undefined) assert.equal(body.error, message);
  else assert.equal(typeof body.error, 'string');
  return body;
}

function throwingClient(err) {
  return { getAchievements: async () => { throw err; } };
}

async function gamesApp(t, client, importer) {
  return mount(t, '/api/games', gamesRoutes.createRouter({ client, importer }));
}

/* --------------------------------- books ---------------------------------- */

test('books: HttpError passes through unchanged', async (t) => {
  const base = await mount(t, '/api/books', booksRoutes);
  const body = await expectError(
    t,
    await fetch(`${base}/import/status`),
    400,
    'job_id_required'
  );
  assert.match(body.error, /"id" is required/);
});

test('books: LivelibFileError is a 400 with its own code and message', async (t) => {
  const base = await mount(t, '/api/books', booksRoutes);
  const form = new FormData();
  form.append('filename', 'livelib-probe-read-28.10.2026.json');
  form.append('username', 'routeprobe');
  form.append('resolve', '0');
  form.append(
    'file',
    new Blob(['{'], { type: 'application/json' }),
    'livelib-probe-read-28.10.2026.json'
  );
  const body = await expectError(
    t,
    await fetch(`${base}/import/livelib-file`, { method: 'POST', body: form }),
    400,
    'livelib_file_invalid_json'
  );
  assert.ok(body.error.length > 0);
});

test('books: LivelibError code table', async (t) => {
  const base = await mount(t, '/api/books', booksRoutes);
  const cases = [
    ['livelib_invalid_username', 400],
    ['livelib_import_running', 409],
    ['livelib_blocked', 429],
    ['livelib_bulk_error', 404],
    ['livelib_error', 502],
    ['livelib_something_else', 502],
  ];
  for (const [code, status] of cases) {
    const restore = patch(booksImport, 'startLivelibImport', () => {
      throw new LivelibError(`livelib says ${code}`, code);
    });
    t.after(restore);
    const response = await fetch(`${base}/import/livelib`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'routeprobe' }),
    });
    await expectError(t, response, status, code, `livelib says ${code}`);
  }
});

test('books: HardcoverError maps token/foreign codes to 400, the rest to 502', async (t) => {
  const base = await mount(t, '/api/books', booksRoutes);
  const cases = [
    ['hardcover_token_missing', 400],
    ['hardcover_foreign_user', 400],
    ['hardcover_rate_limited', 502],
    ['hardcover_error', 502],
  ];
  for (const [code, status] of cases) {
    const restore = patch(booksImport, 'startHardcoverImport', () => {
      throw new HardcoverError(`hardcover says ${code}`, code);
    });
    t.after(restore);
    const response = await fetch(`${base}/import/hardcover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    await expectError(t, response, status, code, `hardcover says ${code}`);
  }
});

test('books: CookieError is a 400 with its own code and message', async (t) => {
  const base = await mount(t, '/api/books', booksRoutes);
  const restore = patch(livelibCookies, 'clearCookies', async () => {
    throw new livelibCookies.CookieError('Некорректный cookie header.', 'invalid_cookie_header');
  });
  t.after(restore);
  const body = await expectError(
    t,
    await fetch(`${base}/import/livelib/cookies?userKey=routeprobe`, { method: 'DELETE' }),
    400,
    'invalid_cookie_header',
    'Некорректный cookie header.'
  );
  assert.ok(body.error.length > 0);
});

test('books: a plain error with a status is NOT mapped and stays a 500', async (t) => {
  const base = await mount(t, '/api/books', booksRoutes);
  const restore = patch(booksImport, 'startLivelibImport', () => {
    throw Object.assign(new Error('plain failure'), { status: 418, code: 'teapot' });
  });
  t.after(restore);
  const originalError = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = originalError;
  });
  const body = await expectError(
    t,
    await fetch(`${base}/import/livelib`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'routeprobe' }),
    }),
    500,
    'internal_error'
  );
  assert.equal(body.error, 'Internal server error.');
});

/* --------------------------------- games ---------------------------------- */

test('games: HttpError passes through unchanged', async (t) => {
  const base = await gamesApp(t, throwingClient(new Error('unused')));
  const body = await expectError(
    t,
    await fetch(`${base}/stats?profile=steam-nope`),
    400,
    'invalid_profile'
  );
  assert.match(body.error, /expected "steam-<steamid64>"/);
});

test('games: SteamError/StoreError/SpyError share one code table', async (t) => {
  await ensureSeed();
  const cases = [
    [new steam.SteamError('steam rate limited', 'steam_rate_limited'), 429],
    [new steam.SteamError('steam private', 'stats_private'), 400],
    [new steam.SteamError('steam missing', 'stats_not_found'), 404],
    [new steam.SteamError('steam unreachable', 'steam_unreachable'), 502],
    [new steam.SteamError('steam strange', 'steam_something_else'), 502],
    [new store.StoreError('store rate limited', 'store_rate_limited'), 429],
    [new store.StoreError('store invalid', 'store_invalid_appid'), 400],
    [new store.StoreError('store strange', 'store_something_else'), 502],
    [new spy.SpyError('spy rate limited', 'spy_rate_limited'), 429],
    [new spy.SpyError('spy invalid', 'spy_invalid_appid'), 400],
    [new spy.SpyError('spy strange', 'spy_something_else'), 502],
  ];
  for (const [err, status] of cases) {
    const base = await gamesApp(t, throwingClient(err));
    const response = await fetch(`${base}/achievements?profile=${PROFILE}&appid=${APPID}`);
    await expectError(t, response, status, err.code, err.message);
  }
});

test('games: a plain error with a status keeps its code or falls back to games_error', async (t) => {
  const withCode = await gamesApp(t, throwingClient(new Error('unused')), {
    startImport: () => {
      throw Object.assign(new Error('profile is broken'), { status: 422, code: 'invalid_profile' });
    },
  });
  await expectError(
    t,
    await fetch(`${withCode}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vanityOrId64: '76561198000000021' }),
    }),
    422,
    'invalid_profile',
    'profile is broken'
  );

  const withoutCode = await gamesApp(t, throwingClient(new Error('unused')), {
    startImport: () => {
      throw Object.assign(new Error('profile is broken'), { status: 422 });
    },
  });
  await expectError(
    t,
    await fetch(`${withoutCode}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vanityOrId64: '76561198000000021' }),
    }),
    422,
    'games_error',
    'profile is broken'
  );
});

/* ---------------------------------- epic ---------------------------------- */

async function epicApp(t, err) {
  return mount(t, '/api/games', epicRoutes.createRouter({
    auth: {
      connectWithCode: async () => {
        throw err;
      },
    },
  }));
}

function epicConnect(base) {
  return fetch(`${base}/epic/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'probe' }),
  });
}

test('epic: HttpError passes through unchanged', async (t) => {
  const base = await mount(t, '/api/games', epicRoutes.createRouter({
    auth: { connectWithCode: async () => ({}) },
  }));
  await expectError(
    t,
    await fetch(`${base}/epic/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
    400,
    'epic_code_required'
  );
});

test('epic: EpicError code table, explicit status and default 502', async (t) => {
  const cases = [
    [new epic.EpicError('epic pending', 'epic_auth_pending'), 409],
    [new epic.EpicError('epic expired', 'epic_auth_expired'), 401],
    [new epic.EpicError('epic rate limited', 'epic_rate_limited'), 429],
    [new epic.EpicError('epic strange', 'epic_something_else'), 502],
    [new epic.EpicError('epic explicit', 'epic_rate_limited', { status: 503 }), 503],
    [new epic.EpicError('epic token store', 'epic_token_store_error'), 500],
  ];
  for (const [err, status] of cases) {
    const base = await epicApp(t, err);
    await expectError(t, await epicConnect(base), status, err.code, err.message);
  }
});

test('epic: message is masked and an empty message becomes "Epic error"', async (t) => {
  const masked = await epicApp(
    t,
    new epic.EpicError('failed: bearer eg1~TOPSECRET', 'epic_import_failed')
  );
  const body = await expectError(t, await epicConnect(masked), 502, 'epic_import_failed');
  assert.equal(body.error.includes('TOPSECRET'), false);
  assert.match(body.error, /bearer \*\*\*/);

  const empty = await epicApp(t, new epic.EpicError('', 'epic_import_failed'));
  await expectError(t, await epicConnect(empty), 502, 'epic_import_failed', 'Epic error');
});

test('epic: a non-EpicError carrying a known code is mapped by that code', async (t) => {
  const err = Object.assign(new Error('auth still pending'), { code: 'epic_auth_pending' });
  const base = await epicApp(t, err);
  await expectError(t, await epicConnect(base), 409, 'epic_auth_pending', 'auth still pending');
});

test('epic: a plain error with a status is mapped and masked', async (t) => {
  const withCode = await epicApp(
    t,
    Object.assign(new Error('redirect https://api.epicgames.dev/x?code=ABC123 failed'), {
      status: 418,
      code: 'probe_code',
    })
  );
  await expectError(
    t,
    await epicConnect(withCode),
    418,
    'probe_code',
    'redirect https://api.epicgames.dev/x?code=*** failed'
  );

  const withoutCode = await epicApp(t, Object.assign(new Error('no code'), { status: 418 }));
  await expectError(t, await epicConnect(withoutCode), 418, 'error', 'no code');
});

/* ----------------------------------- gog ---------------------------------- */

async function gogApp(t, err) {
  return mount(t, '/api/games/gog', gogRoutes.createRouter({
    client: {
      exchangeCode: async () => {
        throw err;
      },
    },
  }));
}

function gogAuth(base) {
  return fetch(`${base}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'probe' }),
  });
}

test('gog: HttpError passes through unchanged', async (t) => {
  const base = await gogApp(t, new gog.GogError('unused', 'gog_error'));
  await expectError(
    t,
    await fetch(`${base}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
    400,
    'gog_code_required'
  );
});

test('gog: GogError code table, explicit status wins, default 502', async (t) => {
  const cases = [
    [new gog.GogError('gog expired', 'gog_auth_expired'), 401],
    [new gog.GogError('gog invalid code', 'gog_invalid_code'), 400],
    [new gog.GogError('gog rate limited', 'gog_rate_limited'), 429],
    [new gog.GogError('gog strange', 'gog_something_else'), 502],
    [new gog.GogError('gog explicit', 'gog_invalid_code', { status: 503 }), 503],
  ];
  for (const [err, status] of cases) {
    const base = await gogApp(t, err);
    await expectError(t, await gogAuth(base), status, err.code, err.message);
  }
});

test('gog: a plain error with a status keeps its code or falls back to games_gog_error', async (t) => {
  const withCode = await gogApp(
    t,
    Object.assign(new Error('gog probe failed'), { status: 422, code: 'probe_code' })
  );
  await expectError(t, await gogAuth(withCode), 422, 'probe_code', 'gog probe failed');

  const withoutCode = await gogApp(
    t,
    Object.assign(new Error('gog probe failed'), { status: 422 })
  );
  await expectError(t, await gogAuth(withoutCode), 422, 'games_gog_error', 'gog probe failed');
});

/* -------------------------------- franchise -------------------------------- */

async function franchiseApp(t, err) {
  return mount(t, '/api/games', franchiseRoutes.createRouter({
    buildFranchises: () => {
      throw err;
    },
    autoFranchise: false,
  }));
}

test('franchise: HttpError passes through unchanged', async (t) => {
  await ensureSeed();
  const base = await franchiseApp(t, new Error('unused'));
  await expectError(t, await fetch(`${base}/franchises`), 400, 'profile_required');
});

test('franchise: FranchiseError defaults to 400 and honours its own status', async (t) => {
  await ensureSeed();
  const cases = [
    [new franchise.FranchiseError('franchise invalid', 'franchise_invalid_year'), 400],
    [new franchise.FranchiseError('franchise busy', 'franchise_busy', 409), 409],
  ];
  for (const [err, status] of cases) {
    const base = await franchiseApp(t, err);
    const response = await fetch(`${base}/franchises?profile=${PROFILE}`);
    await expectError(t, response, status, err.code, err.message);
  }
});

test('franchise: a plain error with a status keeps its code or falls back to games_franchise_error', async (t) => {
  await ensureSeed();
  const withCode = await franchiseApp(
    t,
    Object.assign(new Error('franchise probe failed'), { status: 422, code: 'probe_code' })
  );
  await expectError(
    t,
    await fetch(`${withCode}/franchises?profile=${PROFILE}`),
    422,
    'probe_code',
    'franchise probe failed'
  );

  const withoutCode = await franchiseApp(
    t,
    Object.assign(new Error('franchise probe failed'), { status: 422 })
  );
  await expectError(
    t,
    await fetch(`${withoutCode}/franchises?profile=${PROFILE}`),
    422,
    'games_franchise_error',
    'franchise probe failed'
  );
});

/* -------------------------------- personnel -------------------------------- */

async function personnelApp(t, err) {
  return mount(t, '/api/games', personnelRoutes.createRouter({
    applyOverride: async () => {
      throw err;
    },
  }));
}

function overridden(base) {
  return fetch(`${base}/override`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

test('personnel: HttpError passes through unchanged', async (t) => {
  const base = await personnelApp(t, new Error('unused'));
  await expectError(t, await fetch(`${base}/personnel`), 400, 'profile_required');
});

test('personnel: PersonnelError defaults to 400 and honours its own status', async (t) => {
  const cases = [
    [new PersonnelError('personnel invalid', 'invalid_override_type'), 400],
    [new PersonnelError('personnel busy', 'personnel_busy', 409), 409],
  ];
  for (const [err, status] of cases) {
    const base = await personnelApp(t, err);
    await expectError(t, await overridden(base), status, err.code, err.message);
  }
});

test('personnel: a plain error with a status keeps its code or falls back to games_personnel_error', async (t) => {
  const withCode = await personnelApp(
    t,
    Object.assign(new Error('personnel probe failed'), { status: 422, code: 'probe_code' })
  );
  await expectError(t, await overridden(withCode), 422, 'probe_code', 'personnel probe failed');

  const withoutCode = await personnelApp(
    t,
    Object.assign(new Error('personnel probe failed'), { status: 422 })
  );
  await expectError(
    t,
    await overridden(withoutCode),
    422,
    'games_personnel_error',
    'personnel probe failed'
  );
});

/* ----------------------------- full code tables ---------------------------- */

const STEAM_CODE_STATUS = [
  ['invalid_steamid', 400],
  ['steamid_mismatch', 400],
  ['profile_private', 400],
  ['library_private', 400],
  ['steam_key_missing', 400],
  ['stats_private', 400],
  ['stats_not_found', 404],
  ['steam_unreachable', 502],
  ['steam_rate_limited', 429],
  ['steam_key_invalid', 502],
  ['steam_forbidden', 502],
  ['steam_http_error', 502],
  ['steam_invalid_url', 400],
  ['store_rate_limited', 429],
  ['store_unreachable', 502],
  ['store_http_error', 502],
  ['store_invalid_appid', 400],
  ['spy_rate_limited', 429],
  ['spy_unreachable', 502],
  ['spy_http_error', 502],
  ['spy_invalid_appid', 400],
  ['reviews_rate_limited', 429],
  ['reviews_unreachable', 502],
  ['reviews_http_error', 502],
  ['reviews_invalid_appid', 400],
];

const EPIC_CODE_STATUS = [
  ['invalid_owner', 400],
  ['unknown_owner', 400],
  ['epic_account_required', 400],
  ['epic_not_connected', 400],
  ['owner_mismatch', 400],
  ['epic_invalid_account', 400],
  ['epic_auth_failed', 400],
  ['epic_auth_cancelled', 400],
  ['epic_auth_pending', 409],
  ['epic_auth_expired', 401],
  ['epic_rate_limited', 429],
  ['epic_unreachable', 502],
  ['epic_http_error', 502],
  ['epic_invalid_url', 400],
  ['epic_client_invalid', 502],
  ['epic_device_grant_unavailable', 400],
  ['epic_code_required', 400],
  ['epic_invalid_code', 400],
  ['epic_library_empty', 400],
  ['epic_token_store_error', 500],
  ['epic_invalid_catalog_item', 400],
  ['epic_import_failed', 502],
  ['unknown_auth', 404],
];

const GOG_CODE_STATUS = [
  ['gog_auth_required', 401],
  ['gog_auth_expired', 401],
  ['gog_not_connected', 400],
  ['gog_invalid_code', 400],
  ['gog_invalid_request', 400],
  ['gog_code_required', 400],
  ['gog_client_rejected', 502],
  ['gog_invalid_user', 400],
  ['gog_invalid_url', 400],
  ['gog_rate_limited', 429],
  ['gog_unreachable', 502],
  ['gog_http_error', 502],
  ['unknown_profile', 400],
  ['steam_profile_required', 400],
  ['owner_required', 400],
  ['owner_mismatch', 400],
  ['gog_already_connected', 400],
  ['account_required', 400],
  ['gog_owner_mismatch', 400],
];

function gamesErrorFor(code) {
  if (code.startsWith('store_') || code.startsWith('reviews_')) {
    return new store.StoreError(`store says ${code}`, code);
  }
  if (code.startsWith('spy_')) return new spy.SpyError(`spy says ${code}`, code);
  return new steam.SteamError(`steam says ${code}`, code);
}

test('games: every games code in the table maps to its status', async (t) => {
  await ensureSeed();
  for (const [code, status] of STEAM_CODE_STATUS) {
    const err = gamesErrorFor(code);
    const base = await gamesApp(t, throwingClient(err));
    const response = await fetch(`${base}/achievements?profile=${PROFILE}&appid=${APPID}`);
    await expectError(t, response, status, code, err.message);
  }
});

test('epic: every Epic code in the table maps to its status', async (t) => {
  for (const [code, status] of EPIC_CODE_STATUS) {
    const err = new epic.EpicError(`epic says ${code}`, code);
    const base = await epicApp(t, err);
    await expectError(t, await epicConnect(base), status, code, err.message);
  }
});

test('gog: every GOG code in the table maps to its status', async (t) => {
  for (const [code, status] of GOG_CODE_STATUS) {
    const err = new gog.GogError(`gog says ${code}`, code);
    const base = await gogApp(t, err);
    await expectError(t, await gogAuth(base), status, code, err.message);
  }
});

/* ------------------------------ helper API -------------------------------- */

const { mapDomainError } = require('../server/core/errors');

function probeError(message, code, status) {
  const err = new Error(message);
  err.code = code;
  if (status != null) err.status = status;
  return err;
}

test('mapDomainError returns the very same HttpError and never re-wraps it', () => {
  const profile = { rules: [{ is: Error, statuses: { probe: 400 }, defaultStatus: 502 }] };
  const original = new HttpError(409, 'already running', 'livelib_import_running');
  assert.equal(mapDomainError(original, profile), original);
});

test('mapDomainError copies retryAt only for profiles that declare it', () => {
  const err = Object.assign(probeError('rate limited', 'probe_rate_limited'), {
    retryAt: '2026-11-10T00:00:00.000Z',
  });
  const withRetry = mapDomainError(err, {
    rules: [{ is: Error, statuses: { probe_rate_limited: 429 }, defaultStatus: 502 }],
    retryAt: true,
  });
  assert.equal(withRetry.retryAt, '2026-11-10T00:00:00.000Z');
  assert.equal(withRetry.status, 429);

  const withoutRetry = mapDomainError(err, {
    rules: [{ is: Error, statuses: { probe_rate_limited: 429 }, defaultStatus: 502 }],
  });
  assert.equal(withoutRetry.retryAt, undefined);
});

test('mapDomainError maps by class, by known code, or by the status a plain error carries', () => {
  const err = probeError('own status', 'probe_code', 418);

  assert.equal(
    mapDomainError(err, { rules: [{ is: Error, statuses: {}, defaultStatus: 502 }] }).status,
    502
  );
  assert.equal(
    mapDomainError(err, {
      rules: [{ is: Error, statuses: {}, defaultStatus: 502, ownStatus: 'whenSet' }],
    }).status,
    418
  );
  assert.equal(
    mapDomainError(err, {
      rules: [{ is: Error, statuses: {}, defaultStatus: 502, ownStatus: 'whenAtLeast400' }],
    }).status,
    418
  );

  const lowStatus = probeError('too low', 'probe_code', 302);
  assert.equal(
    mapDomainError(lowStatus, {
      rules: [{ is: Error, statuses: {}, defaultStatus: 502, ownStatus: 'whenSet' }],
    }).status,
    302
  );
  assert.equal(
    mapDomainError(lowStatus, {
      rules: [{ is: Error, statuses: {}, defaultStatus: 502, ownStatus: 'whenAtLeast400' }],
    }).status,
    502
  );

  const plainWithKnownCode = probeError('known code', 'probe_code', 401);
  const byCode = { codeIn: { probe_code: 409 }, statuses: { probe_code: 409 }, defaultStatus: 502 };
  assert.equal(mapDomainError(plainWithKnownCode, { rules: [byCode] }).status, 409);
  assert.equal(mapDomainError(plainWithKnownCode, { rules: [byCode] }).code, 'probe_code');
  assert.equal(
    mapDomainError(probeError('unknown code', 'other_code'), { rules: [byCode] }).status,
    undefined
  );
  assert.equal(
    mapDomainError(probeError('unknown code', 'other_code'), {
      rules: [{ is: Error, statuses: { probe_code: 409 }, defaultStatus: 502 }],
    }).status,
    502
  );
});

test('mapDomainError maps only errors inside the 400..599 fallback range', () => {
  const profile = { rules: [], fallback: { code: 'probe_fallback' } };
  const plain = (status) => Object.assign(new Error('plain'), { status, code: 'probe_code' });

  assert.equal(mapDomainError(plain(422), profile).status, 422);
  assert.equal(mapDomainError(plain(422), profile).code, 'probe_code');
  assert.equal(
    mapDomainError(Object.assign(new Error('plain'), { status: 422 }), profile).code,
    'probe_fallback'
  );

  const outOfRange = plain(302);
  assert.equal(mapDomainError(outOfRange, profile), outOfRange);
  assert.equal(mapDomainError(plain(600), profile).status, 600);
  assert.equal(mapDomainError(plain(422), { rules: [] }).status, 422);
});

test('mapDomainError masks the message only when the profile asks for it', () => {
  const mask = (text) => text.replace(/secret/g, '***');
  const err = probeError('a secret value', 'probe_code');
  const profile = {
    rules: [{ is: Error, statuses: {}, defaultStatus: 502 }],
    message: { mask, fallback: 'fallback text' },
  };
  assert.equal(mapDomainError(err, profile).message, 'a *** value');

  const empty = probeError('', 'probe_code');
  assert.equal(mapDomainError(empty, profile).message, 'fallback text');
  assert.equal(
    mapDomainError(err, { rules: [{ is: Error, statuses: {}, defaultStatus: 502 }] }).message,
    'a secret value'
  );
});
