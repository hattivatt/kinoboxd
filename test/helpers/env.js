'use strict';

/**
 * Tmp-cache environment helper for tests (P0 «страховочная сетка»).
 *
 * WHY: every cache namespace of kinoboxd resolves its root from the
 * environment **once, at module load time**:
 *
 *   server/cache.js              KINOBOXD_CACHE_DIR        -> cache/
 *   server/books/book-cache.js   KINOBOXD_CACHE_BOOK_DIR   -> cache-book/
 *   server/games/game-cache.js   KINOBOXD_CACHE_GAMES_DIR  -> cache-games/
 *   server/games/game-cache.js   KINOBOXD_STATE_DIR        -> state/games/
 *   server/games/epic-token-store.js KINOBOXD_EPIC_TOKENS_DIR (default:
 *                                    <cache-games>/tokens)
 *
 * Therefore the order is always:
 *
 *     const env = require('./helpers/env');
 *     env.makeTmpCache('my-test');          // sets process.env BEFORE require
 *     const bookCache = require('../server/books/book-cache');
 *
 * A `require` that happens before the env is applied keeps the production
 * path (`app/cache*`) baked into the module for the whole process. That is
 * exactly the failure this helper exists to prevent.
 *
 * Entry point for the merged domain suites (R19): a suite calls
 * `makeTmpCache` once at module scope, before any `server/**` require, and
 * ends with `cleanupTmpDirs()` (plus the same call from `process.on('exit')`,
 * because a late job write can land after the runner's hooks). The helpers a
 * merged block uses instead of its old hand-rolled `mkdtempSync`:
 *
 * | Helper               | Replaces                                     |
 * |----------------------|----------------------------------------------|
 * | `makeTmpCache(name)` | the suite-wide run root                       |
 * | `currentDirs()`      | a block's own five roots (i.e. the run root)   |
 * | `tmpDir(label)`      | a `fs.mkdtempSync` for a dir passed explicitly |
 * | `resetMutableState()`| a fresh state dir between blocks (breakers,    |
 * |                      | job journals, stale `.lock` files)             |
 * | `cleanupTmpDirs()`   | the per-file `rmSync` that almost never existed |
 *
 * JSDoc table — the env names that MUST point into a tmp dir per namespace
 * (source of truth: the `process.env` reads listed above):
 *
 * | Domain / namespace | Env var                    | Default when unset        |
 * |--------------------|----------------------------|---------------------------|
 * | films              | KINOBOXD_CACHE_DIR         | app/cache                 |
 * | books              | KINOBOXD_CACHE_BOOK_DIR    | app/cache-book            |
 * | games              | KINOBOXD_CACHE_GAMES_DIR   | app/cache-games           |
 * | mutable state      | KINOBOXD_STATE_DIR         | app/state (games breaker) |
 * | Epic tokens        | KINOBOXD_EPIC_TOKENS_DIR   | <games>/tokens            |
 *
 * Optional knobs that make a test offline / inert (budgets are only consumed
 * by jobs, never by a stats build, but a stray job must not reach the network):
 *
 * | Knob                          | Meaning                              |
 * |-------------------------------|--------------------------------------|
 * | BOOKS_LITRES_BUDGET=0         | no litres.ru requests                |
 * | BOOKS_GB_BUDGET=0             | no Google Books requests             |
 * | BOOKS_LIVELIB_CARD_BUDGET=0   | no LiveLib card requests             |
 * | GAMES_*_BUDGET=0              | no store/spy/reviews/secondary calls |
 * | KINOBOXD_GAMES_WD=0           | no WDQS requests for games           |
 * | KINOBOXD_BOOKS_WIKIDATA=0     | no WDQS requests for books           |
 * | KINOBOXD_BOOKS_FANTLAB=0      | no FantLab requests for books        |
 * | KINOBOXD_STEAM_KEY_FILE=...   | point the dev Steam key at /dev/null |
 * | KINOBOXD_MOBY_KEY_FILE=...    | same for the Moby key                |
 *
 * Test port rule (AGENTS §1): never 3000; pick a free 5xxx/6xxx port.
 *
 * Tmp-dir hygiene: every root this module hands out (`makeTmpCache`,
 * `tmpDir`) is remembered, so a merged suite ends with ONE
 * `cleanupTmpDirs()` call and leaves no directory behind.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_BASE = path.join(os.tmpdir(), 'opencode');

const ENV_VARS = Object.freeze({
  films: 'KINOBOXD_CACHE_DIR',
  books: 'KINOBOXD_CACHE_BOOK_DIR',
  games: 'KINOBOXD_CACHE_GAMES_DIR',
  state: 'KINOBOXD_STATE_DIR',
  epicTokens: 'KINOBOXD_EPIC_TOKENS_DIR',
});

/** Namespaced roots inside one tmp run directory. */
const SUBDIRS = Object.freeze({
  films: 'cache',
  books: 'cache-book',
  games: 'cache-games',
  state: 'state',
  epicTokens: 'state/epic-tokens',
});

/** Budget/switch knobs zeroed by `zeroBudgets()` (see the table above). */
const BUDGET_ENV = Object.freeze([
  'BOOKS_LITRES_BUDGET',
  'BOOKS_GB_BUDGET',
  'BOOKS_LIVELIB_CARD_BUDGET',
  'GAMES_STORE_BUDGET',
  'GAMES_SPY_BUDGET',
  'GAMES_REVIEWS_BUDGET',
  'GAMES_SECONDARY_BUDGET',
  'GAMES_GOG_BUDGET',
  'GAMES_FRANCHISE_BUDGET',
  'GAMES_MOBY_BUDGET',
  'GAMES_BASE_DETAILS_BUDGET',
]);

let counter = 0;
const pending = [];

function ensureBase() {
  fs.mkdirSync(TMP_BASE, { recursive: true });
}

function remember(dir) {
  assertTmp(dir, 'tmp root');
  pending.push(dir);
  return dir;
}

/**
 * A tracked replacement for a hand-rolled `fs.mkdtempSync(...)` block: the
 * directory lives under `TMP_BASE` and is removed by `cleanupTmpDirs()`.
 *
 * @param {string} [label] short label used in the directory name
 * @returns {string} the created directory
 */
function tmpDir(label) {
  ensureBase();
  const safe = String(label || 'tmp')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return remember(fs.mkdtempSync(path.join(TMP_BASE, `${safe || 'tmp'}-`)));
}

/**
 * Drop the mutable, cross-block state a merged suite must not inherit: host
 * breakers, job journals and resolve locks. Data fixtures (cached profiles,
 * details, links) stay — they are the files' own seeds; a tripped 30 minute
 * breaker or a stale job, on the other hand, only ever means «the previous
 * block left the process poisoned».
 */
function resetMutableState() {
  const stateRoots = [
    process.env[ENV_VARS.state],
    ...[ENV_VARS.films, ENV_VARS.books, ENV_VARS.games].map((name) =>
      process.env[name] ? path.join(process.env[name], 'state') : null,
    ),
  ].filter(Boolean);
  for (const dir of stateRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const name of [ENV_VARS.films, ENV_VARS.books, ENV_VARS.games]) {
    const root = process.env[name];
    if (!root) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.lock')) {
        fs.rmSync(path.join(root, entry.name), { force: true });
      }
    }
  }
  return stateRoots.length;
}

/** Remove every root handed out by this module; returns how many it owns. */
function cleanupTmpDirs() {
  for (const dir of pending) fs.rmSync(dir, { recursive: true, force: true });
  return pending.length;
}

function uniqueRoot(domain) {
  counter += 1;
  const safeDomain = String(domain || 'tmp').replace(/[^a-zA-Z0-9_.-]+/g, '-');
  const stamp = `${Date.now()}-${process.pid}-${counter}`;
  return path.join(TMP_BASE, `${safeDomain}-${stamp}`);
}

function insideTmp(dir) {
  const resolved = path.resolve(dir);
  const base = path.resolve(TMP_BASE);
  const systemTmp = path.resolve(os.tmpdir());
  return (
    resolved === base ||
    resolved.startsWith(`${base}${path.sep}`) ||
    resolved === systemTmp ||
    resolved.startsWith(`${systemTmp}${path.sep}`)
  );
}

/** Throw if a cache path escaped /tmp — a guard against prod-cache mutation. */
function assertTmp(dir, label) {
  if (!insideTmp(dir)) {
    throw new Error(
      `[test/helpers/env] refusing a non-tmp ${label || 'path'}: ${dir} ` +
        `(expected under ${TMP_BASE} or ${os.tmpdir()})`
    );
  }
  return dir;
}

/** Throw if any of the cache env vars currently point outside /tmp. */
function assertNoProdPaths() {
  for (const [domain, name] of Object.entries(ENV_VARS)) {
    const value = process.env[name];
    if (value && value.trim()) assertTmp(value, `${domain} (${name})`);
  }
  return true;
}

/**
 * Create the five tmp roots for one run and (by default) apply them to
 * `process.env`. Call it before requiring any `server/**` module.
 *
 * @param {string} domain  short label used in the directory name
 * @param {{ apply?: boolean, budgets?: boolean }} [options]
 * @returns {{
 *   root: string, cacheDir: string, cacheBookDir: string,
 *   cacheGamesDir: string, stateDir: string, epicTokensDir: string,
 *   cleanup: () => void
 * }}
 */
function makeTmpCache(domain, options = {}) {
  const root = uniqueRoot(domain);
  const dirs = {
    root,
    cacheDir: path.join(root, SUBDIRS.films),
    cacheBookDir: path.join(root, SUBDIRS.books),
    cacheGamesDir: path.join(root, SUBDIRS.games),
    stateDir: path.join(root, SUBDIRS.state),
    epicTokensDir: path.join(root, SUBDIRS.epicTokens),
  };
  assertTmp(root, 'run root');
  remember(root);
  for (const dir of [
    dirs.cacheDir,
    dirs.cacheBookDir,
    dirs.cacheGamesDir,
    dirs.stateDir,
    dirs.epicTokensDir,
  ]) {
    assertTmp(dir);
    fs.mkdirSync(dir, { recursive: true });
  }
  if (options.apply !== false) applyEnv(dirs);
  if (options.budgets !== false) zeroBudgets();
  return {
    ...dirs,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * The roots the process is currently running on, shaped like `makeTmpCache`'s
 * answer with a no-op `cleanup()`. A merged suite calls `makeTmpCache` once at
 * module scope; the blocks that used to build their own tmp cache ask for
 * these instead, so no module ever diverges from the run root.
 */
function currentDirs() {
  return {
    root: process.env[ENV_VARS.films],
    cacheDir: process.env[ENV_VARS.films],
    cacheBookDir: process.env[ENV_VARS.books],
    cacheGamesDir: process.env[ENV_VARS.games],
    stateDir: process.env[ENV_VARS.state],
    epicTokensDir: process.env[ENV_VARS.epicTokens],
    cleanup() {},
  };
}

/** Point every cache env var at the given run's roots. */
function applyEnv(dirs) {
  process.env[ENV_VARS.films] = assertTmp(dirs.cacheDir, ENV_VARS.films);
  process.env[ENV_VARS.books] = assertTmp(dirs.cacheBookDir, ENV_VARS.books);
  process.env[ENV_VARS.games] = assertTmp(dirs.cacheGamesDir, ENV_VARS.games);
  process.env[ENV_VARS.state] = assertTmp(dirs.stateDir, ENV_VARS.state);
  process.env[ENV_VARS.epicTokens] = assertTmp(dirs.epicTokensDir, ENV_VARS.epicTokens);
  return dirs;
}

/** Zero every network budget (a no-op for pure stats builds, a fence for jobs). */
function zeroBudgets() {
  for (const name of BUDGET_ENV) process.env[name] = '0';
  process.env.KINOBOXD_GAMES_WD = '0';
  process.env.KINOBOXD_BOOKS_WIKIDATA = '0';
  process.env.KINOBOXD_BOOKS_FANTLAB = '0';
  process.env.KINOBOXD_GAMES_MOBY = '0';
  process.env.KINOBOXD_STEAM_KEY_FILE = '/dev/null';
  process.env.KINOBOXD_MOBY_KEY_FILE = '/dev/null';
  process.env.GAMES_SECONDARY_LAZY_KICK = '0';
  return process.env;
}

module.exports = {
  TMP_BASE,
  ENV_VARS,
  BUDGET_ENV,
  SUBDIRS,
  uniqueRoot,
  insideTmp,
  assertTmp,
  assertNoProdPaths,
  tmpDir,
  cleanupTmpDirs,
  resetMutableState,
  currentDirs,
  makeTmpCache,
  applyEnv,
  zeroBudgets,
};
