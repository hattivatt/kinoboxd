'use strict';

/**
 * Store launcher smoke: the caches must live at canonical, code-independent
 * paths. Regression guarded here (ИГРЫ §9, M2/M3 integration):
 *
 *   game-cache.js falls back to `<stamp>/cache-games` when
 *   KINOBOXD_CACHE_GAMES_DIR is unset — and the stamp is named after the store
 *   hash, so a rebuild silently started with an empty games cache (whole Steam
 *   import + enrich re-run). prepare_state() must export
 *   `$state/app/cache-games` exactly like it already does for cache/cache-book.
 *
 * The test executes the *real* `prepare_state()` shell function extracted from
 * `nix/package.nix` (the single build recipe) against a fake store tree, so a
 * change in the launcher is caught here, not on the next deploy.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const FLAKE = path.join(REPO_ROOT, 'flake.nix');
// The build recipe (prepare_state + launchers) lives in nix/package.nix; the
// flake only injects the local source tree.
const PACKAGE_NIX = path.join(REPO_ROOT, 'nix', 'package.nix');

/** Pull `prepare_state() { … }` out of a nix file and undo the nix escaping. */
function extractPrepareState(source) {
  const start = source.indexOf('prepare_state() {');
  assert.ok(start > 0, 'prepare_state() not found');
  const indent = start - (source.lastIndexOf('\n', start) + 1);
  const closer = `\n${' '.repeat(indent)}}`;
  const end = source.indexOf(closer, start);
  assert.ok(end > start, 'prepare_state() body is not terminated');
  return source.slice(start, end + closer.length + 1).replace(/''\$\{/g, '${');
}

/** A throwaway store tree shaped like $out/share/kinoboxd. */
function fakeStore(root, hash) {
  const out = path.join(root, `${hash}-kinoboxd-1.0.0`);
  const store = path.join(out, 'share', 'kinoboxd');
  fs.mkdirSync(path.join(store, 'server'), { recursive: true });
  fs.writeFileSync(path.join(store, 'server', 'index.js'), '// fake\n');
  fs.writeFileSync(path.join(store, 'package.json'), '{}\n');
  fs.mkdirSync(path.join(store, 'public'), { recursive: true });
  fs.mkdirSync(path.join(store, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(store, 'prepare-state.sh'), extractPrepareState(
    fs.readFileSync(PACKAGE_NIX, 'utf8')
  ));
  return store;
}

function runPrepareState(store, stateDir, extraEnv = {}) {
  const script = [
    'set -eu',
    `store=${JSON.stringify(store)}`,
    '. "$store/prepare-state.sh"',
    'prepare_state',
    'printf "%s\\n%s\\n%s\\n%s\\n" "$KINOBOXD_CACHE_DIR" "$KINOBOXD_CACHE_BOOK_DIR" "$KINOBOXD_CACHE_GAMES_DIR" "$PWD"',
  ].join('\n');
  const env = { ...process.env, KINOBOXD_STATE_DIR: stateDir, ...extraEnv };
  delete env.KINOBOXD_CACHE_DIR;
  delete env.KINOBOXD_CACHE_BOOK_DIR;
  delete env.KINOBOXD_CACHE_GAMES_DIR;
  Object.assign(env, extraEnv);
  const stdout = execFileSync('sh', ['-c', script], { env, encoding: 'utf8' });
  const [film, book, games, cwd] = stdout.trim().split('\n');
  return { film, book, games, cwd };
}

test('prepare_state exports a canonical games cache dir', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-store-smoke-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const store = fakeStore(root, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const run = runPrepareState(store, stateDir);

  const app = path.join(stateDir, 'app');
  assert.equal(run.film, path.join(app, 'cache'));
  assert.equal(run.book, path.join(app, 'cache-book'));
  assert.equal(run.games, path.join(app, 'cache-games'));
  assert.ok(fs.statSync(run.games).isDirectory(), 'cache-games must be created');
  // The launcher leaves the shell inside the per-version stamp.
  assert.equal(path.dirname(run.cwd), app);
  assert.match(path.basename(run.cwd), /^server@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$/);
  assert.ok(fs.existsSync(path.join(run.cwd, 'server', 'index.js')));
});

test('the games cache survives a package rebuild (new stamp, same cache)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-store-smoke-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');

  const first = runPrepareState(fakeStore(root, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), stateDir);
  // A real games cache from the "previous version" of the package.
  fs.mkdirSync(path.join(first.games, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(first.games, 'profiles', 'keep.json'), '{"kept":true}');
  const second = runPrepareState(fakeStore(root, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), stateDir);

  assert.equal(second.games, first.games, 'the games cache path must not follow the stamp');
  assert.notEqual(second.cwd, first.cwd, 'each store version gets its own stamp');
  assert.equal(
    fs.readFileSync(path.join(second.games, 'profiles', 'keep.json'), 'utf8'),
    '{"kept":true}',
    'data written by the previous version must still be there'
  );
});

test('an explicit KINOBOXD_CACHE_GAMES_DIR still wins', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-store-smoke-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const custom = path.join(root, 'elsewhere', 'games');
  const run = runPrepareState(fakeStore(root, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), stateDir, {
    KINOBOXD_CACHE_GAMES_DIR: custom,
  });
  assert.equal(run.games, custom);
  assert.ok(fs.statSync(custom).isDirectory());
});

test('flake.nix keeps the runtime caches out of the source tree', () => {
  const flake = fs.readFileSync(FLAKE, 'utf8');
  const filterStart = flake.indexOf('cleanSourceWith');
  assert.ok(filterStart > 0, 'cleanSourceWith not found');
  const filter = flake.slice(filterStart, flake.indexOf('})', filterStart));
  for (const dir of ['cache', 'cache-book', 'cache-games', 'config', 'node_modules']) {
    assert.match(filter, new RegExp(`"${dir}"`), `"${dir}" must be excluded from the flake src`);
  }
});

test('nix/package.nix carries the games cache export', () => {
  const body = extractPrepareState(fs.readFileSync(PACKAGE_NIX, 'utf8'));
  assert.match(body, /KINOBOXD_CACHE_GAMES_DIR="\$\{KINOBOXD_CACHE_GAMES_DIR:-\$app\/cache-games\}"/);
  assert.match(body, /mkdir -p .*"\$KINOBOXD_CACHE_GAMES_DIR"/);
});
