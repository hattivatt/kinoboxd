'use strict';

/**
 * Contract generator (P9): the documents in `contracts/` must be a pure
 * function of the code.
 *
 * Claims:
 *   1. the generator is idempotent (two runs -> byte-identical files);
 *   2. the committed `contracts/*.md` are current (no drift);
 *   3. the documents carry the key nodes the code declares (routes, env,
 *      limits, cache) — a generator that silently emits an empty table fails;
 *   4. the generator needs no network and writes only where told.
 *
 * No live request, no repo mutation: everything is rendered into a tmp dir.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gen = require('../scripts/gen-contracts.js');

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `opencode/gen-contracts-${label}-`));
}

test('the generator is idempotent (second run produces identical bytes)', () => {
  const first = tmpDir('a');
  const second = tmpDir('b');
  try {
    gen.writeContracts({ outDir: first });
    gen.writeContracts({ outDir: second });
    for (const mode of gen.MODES) {
      const file = `${mode}.md`;
      const a = fs.readFileSync(path.join(first, file), 'utf8');
      const b = fs.readFileSync(path.join(second, file), 'utf8');
      assert.equal(a, b, `${file} is not deterministic`);
    }
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test('the committed contracts are up to date with the code', () => {
  const stale = gen.staleContracts();
  assert.deepEqual(
    stale,
    [],
    `contracts/${stale.join(', contracts/')} drifted — run: node scripts/gen-contracts.js`
  );
});

test('api.md lists the real route table (method + path + source)', () => {
  const { routes } = gen.collectRoutes();
  assert.equal(routes.length, 72, 'expected 72 entry points (12 films inline era is over)');

  const api = gen.generate(['api'])[0].content;
  const paths = new Set(routes.map((route) => route.path));
  for (const expected of [
    'GET /api/books/profiles',
    'POST /api/books/import/livelib-file',
    'GET /api/games/stats',
    'GET /api/games/secondary-details/status',
    'POST /api/games/epic/import',
    'GET /api/games/personnel',
    'GET /api/health',
  ]) {
    const [method, ...rest] = expected.split(' ');
    assert.ok(paths.has(rest.join(' ')), `route ${expected} is missing from the scan`);
    assert.match(api, new RegExp(`\\\`${method} ${rest.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\\``));
  }

  // Strict query contracts come from `assertOnlyParams`, not from prose.
  const stats = routes.find((route) => route.method === 'GET' && route.path === '/api/books/stats');
  assert.deepEqual(stats.query, ['includeMangaComics', 'profile']);
  assert.ok(
    stats.errors.some((err) => err.status === '400' && err.code === 'invalid_include_manga'),
    'books/stats error codes are not extracted'
  );

  // Every route names the file and the line it was declared at.
  for (const route of routes) {
    assert.match(route.file, /^server\/.+\.js$/);
    assert.ok(Number.isInteger(route.line) && route.line > 0);
  }
});

test('env.md covers process.env, the sources table and the credential aliases', () => {
  const env = gen.generate(['env'])[0].content;
  for (const name of [
    'KINOBOXD_CACHE_DIR',
    'KINOBOXD_STATE_DIR',
    'GAMES_SECONDARY_BUDGET',
    'TMDB_READ_ACCESS_TOKEN',
    'HARDCOVER_READ_TOKEN',
    'BOOKS_GOOGLE_API_KEY',
    'GB_API_KEY',
    'STEAM_API_KEY',
    'MOBYGAMES_API_KEY',
    'PORT',
  ]) {
    assert.ok(env.includes(`\`${name}\``), `env name ${name} is missing from env.md`);
  }
  // Aliases are declared as aliases, not as unrelated variables.
  assert.match(env, /`tmdb` \| `TMDB_API_TOKEN`, `TMDB_READ_ACCESS_TOKEN`/);
  assert.match(env, /`gbooks` \| `GB_API_KEY`, `BOOKS_GOOGLE_API_KEY`/);

  const names = gen.collectEnvNames([
    ['server/core/sources.js', fs.readFileSync(path.join(gen.APP_ROOT, 'server/core/sources.js'), 'utf8')],
  ]);
  assert.ok(names.has('GAMES_SECONDARY_BUDGET'));
});

test('limits.md is generated from SOURCES and keeps the special rows', () => {
  const limits = gen.generate(['limits'])[0].content;
  const { SOURCE_IDS } = require('../server/core/sources.js');
  for (const id of SOURCE_IDS) {
    assert.ok(limits.includes(`\`${id}\``), `source ${id} is missing from limits.md`);
  }
  for (const marker of [
    'GAMES_SECONDARY_BUDGET',
    'GAMES_FRANCHISE_BUDGET',
    'maxPerMinute',
    '5000',
    'GAMES_STEAM_BUDGET',
    'Особые лимиты, не выводимые из таблицы',
  ]) {
    assert.ok(limits.includes(marker), `limits.md lost ${marker}`);
  }
  // The convention must stay visible: `0` is off.
  assert.match(limits, /`0` = «выключено»/);
});

test('cache.md resolves the namespaces and their env roots', () => {
  const cache = gen.generate(['cache'])[0].content;
  for (const marker of [
    'KINOBOXD_CACHE_DIR',
    'KINOBOXD_CACHE_BOOK_DIR',
    'KINOBOXD_CACHE_GAMES_DIR',
    'KINOBOXD_STATE_DIR',
    'app/cache-book/profiles',
    'app/cache-games/secondary-details',
    'app/cache-games/state/games-breaker.json',
  ]) {
    assert.ok(cache.includes(marker), `cache.md lost ${marker}`);
  }
});

test('the generator never touches the network', () => {
  const source = fs.readFileSync(path.join(gen.APP_ROOT, 'scripts/gen-contracts.js'), 'utf8');
  for (const forbidden of ['node:http', 'node:https', 'http.request', 'https.request']) {
    assert.ok(!source.includes(forbidden), `generator must stay offline, found ${forbidden}`);
  }
  assert.ok(!/\bfetch\(/.test(source), 'generator must not call fetch');
});

test('--check reports stale files and stays green on current ones', () => {
  const dir = tmpDir('check');
  try {
    // Empty dir: every document is stale.
    assert.equal(gen.staleContracts({ outDir: dir }).length, gen.MODES.length);
    gen.writeContracts({ outDir: dir });
    assert.deepEqual(gen.staleContracts({ outDir: dir }), []);
    assert.equal(gen.main(['--check', '--out', dir]), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
