'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const { portFor } = require('./helpers/port');

const ROOT = path.join(__dirname, '..');
const PORT = portFor(281);
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDirs = [];

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function envWithoutTmdb(extra) {
  const env = { ...process.env };
  delete env.TMDB_API_TOKEN;
  delete env.TMDB_READ_ACCESS_TOKEN;
  delete env.KINOBOXD_PASSWORD;
  return { ...env, ...extra };
}

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('hasTmdbToken reports a missing token instead of throwing', () => {
  const dir = tmpDir('kb-tmdb-config-');
  fs.mkdirSync(path.join(dir, 'server', 'core'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'server', 'config.js'), path.join(dir, 'server', 'config.js'));
  fs.copyFileSync(
    path.join(ROOT, 'server', 'core', 'secrets.js'),
    path.join(dir, 'server', 'core', 'secrets.js')
  );
  const probe = `
    const config = require('./server/config');
    let code = null;
    try { config.loadTmdbToken(); } catch (err) { code = err.code; }
    process.stdout.write(JSON.stringify({ has: config.hasTmdbToken(), code }));
  `;
  const run = (extra) =>
    JSON.parse(
      execFileSync(process.execPath, ['-e', probe], {
        cwd: dir,
        env: envWithoutTmdb(extra),
        encoding: 'utf8',
      })
    );
  assert.deepEqual(run({}), { has: false, code: 'TMDB_TOKEN_MISSING' });
  assert.deepEqual(run({ TMDB_API_TOKEN: 'fake' }), { has: true, code: null });
});

test('the server boots without a TMDB token and gates only the TMDB routes', async (t) => {
  const cacheRoot = tmpDir('kb-tmdb-boot-');
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: envWithoutTmdb({
      PORT: String(PORT),
      KINOBOXD_CACHE_DIR: path.join(cacheRoot, 'cache'),
      KINOBOXD_CACHE_BOOK_DIR: path.join(cacheRoot, 'cache-book'),
      KINOBOXD_CACHE_GAMES_DIR: path.join(cacheRoot, 'cache-games'),
      KINOBOXD_STATE_DIR: path.join(cacheRoot, 'state'),
      KINOBOXD_STEAM_KEY_FILE: '/dev/null',
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(() => child.kill());
  let exited = null;
  child.on('exit', (code) => {
    exited = code;
  });

  let health = null;
  for (let attempt = 0; attempt < 100 && exited === null; attempt++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      health = await res.json();
      break;
    } catch (err) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(exited, null, 'the server must not exit without a TMDB token');
  assert.ok(health, 'the server must answer /api/health');
  assert.equal(health.ok, true);
  assert.equal(typeof health.tmdb, 'boolean');

  const books = await fetch(`${BASE}/api/books/profiles`);
  assert.equal(books.status, 200);

  if (health.tmdb) {
    t.diagnostic('a dev config/tmdb-token is present: the 503 gate is not exercised');
    return;
  }
  const search = await fetch(`${BASE}/api/tmdb/search?q=dune`);
  assert.equal(search.status, 503);
  assert.equal((await search.json()).code, 'tmdb_token_missing');
});
