'use strict';

/**
 * `server/core/store.js`: namespaced documents over `core/fs-store`.
 *
 * Pinned here (U1/U7 of the refactor plan):
 *   - `(namespace, key)` -> `<root>/<dir>/<safeKey>.json`, no path traversal;
 *   - `put` is atomic and leaves no tmp file, even when the write fails;
 *   - two writes in a row (including concurrent ones) end with a whole,
 *     parsable document and the last writer's content;
 *   - `schemaVersion` is stamped on write, a document WITHOUT a version is
 *     still accepted on read (that is every pre-U7 cache file), and a document
 *     from an UNKNOWN FUTURE version is refused by `get()` with one warning —
 *     `read()` is the explicit, non-filtering accessor;
 *   - `fresh()` has the same contract as `game-cache.isFresh` (`fetchedAt`,
 *     `importedAt` fallback, a future timestamp is stale);
 *   - the secret writer keeps 0600/0700 (it is the path both the Epic token
 *     store and the LiveLib cookie store now use).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStore } = require('../server/core/store');
const fsStore = require('../server/core/fs-store');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-store-'));
}

function tmpLeftovers(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

function makeStore(options = {}) {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, 'details'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  const store = createStore({
    root,
    dirs: { details: 'details', state: 'state' },
    schemaVersion: 2,
    ...options,
  });
  return { root, store };
}

test('put/get round-trip stamps the store schema version and uses the namespace dir', async () => {
  const { root, store } = makeStore();
  const written = await store.put('details', 292030, { title: 'Cyberpunk 2077' });

  const filePath = path.join(root, 'details', '292030.json');
  assert.equal(written.path, filePath);
  assert.equal(written.fingerprint, fsStore.fingerprintOf(filePath));
  assert.deepEqual(fsStore.readJson(filePath), {
    title: 'Cyberpunk 2077',
    schemaVersion: 2,
  });
  assert.deepEqual(store.get('details', 292030), {
    title: 'Cyberpunk 2077',
    schemaVersion: 2,
  });
  assert.deepEqual(tmpLeftovers(path.dirname(filePath)), []);
});

test('the store version owns the field: a stale local version is overwritten', async () => {
  const { store } = makeStore();
  await store.put('details', 'x', { schemaVersion: 1, value: 'old' });
  assert.equal(store.get('details', 'x').schemaVersion, 2);
});

test('keys are sanitised and cannot escape the namespace directory', async () => {
  const { root, store } = makeStore();
  const written = await store.put('details', '../../etc/passwd', { ok: true });
  assert.equal(path.dirname(written.path), path.join(root, 'details'));
  assert.equal(path.basename(written.path), '.._.._etc_passwd.json');
  assert.deepEqual(store.get('details', '../../etc/passwd'), { ok: true, schemaVersion: 2 });

  assert.throws(() => store.pathFor('details', ''), (err) => err.code === 'store_key_required');
  assert.throws(() => store.get('unknown', 'k'), (err) => err.code === 'store_unknown_namespace');
});

test('a failed write leaves no tmp garbage and keeps the previous document', async () => {
  const { store } = makeStore();
  await store.put('details', 'keep', { value: 1 });
  const filePath = store.pathFor('details', 'keep');

  const circular = {};
  circular.self = circular;
  await assert.rejects(() => store.put('details', 'keep', circular));

  assert.deepEqual(fsStore.readJson(filePath), { value: 1, schemaVersion: 2 });
  assert.deepEqual(tmpLeftovers(path.dirname(filePath)), []);
});

test('concurrent writes end with one whole document and no tmp files', async () => {
  const { store } = makeStore();
  await Promise.all([
    store.put('details', 'race', { n: 1, pad: 'a'.repeat(64) }),
    store.put('details', 'race', { n: 2, pad: 'b'.repeat(64) }),
  ]);

  const filePath = store.pathFor('details', 'race');
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.ok(parsed.n === 1 || parsed.n === 2);
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.pad.length, 64);
  assert.deepEqual(tmpLeftovers(path.dirname(filePath)), []);

  // Sequential writes: the last writer wins, whole.
  await store.put('details', 'race', { n: 3 });
  assert.deepEqual(store.get('details', 'race'), { n: 3, schemaVersion: 2 });
});

test('a corrupt document reads as null, not as a crash', async () => {
  const { root, store } = makeStore();
  const filePath = path.join(root, 'details', 'broken.json');
  fs.writeFileSync(filePath, '{not json', 'utf8');

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(store.get('details', 'broken'), null);
    assert.equal(store.read('details', 'broken'), null);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /\[store:details\] corrupt JSON/);
});

test('a document without schemaVersion is accepted (pre-U7 cache files)', async () => {
  const { root, store } = makeStore();
  const filePath = path.join(root, 'details', 'legacy.json');
  fs.writeFileSync(filePath, JSON.stringify({ title: 'legacy', fetchedAt: '2026-01-01T00:00:00.000Z' }));

  assert.deepEqual(store.get('details', 'legacy'), {
    title: 'legacy',
    fetchedAt: '2026-01-01T00:00:00.000Z',
  });
  const hit = store.read('details', 'legacy');
  assert.equal(hit.schemaVersion, null);
  assert.equal(hit.futureVersion, false);
});

test('a future schemaVersion is refused by get() with one warning, read() reports it', async () => {
  const { root, store } = makeStore();
  const filePath = path.join(root, 'details', 'future.json');
  fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 99, title: 'from the future' }));

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(store.get('details', 'future'), null);
    assert.equal(store.get('details', 'future'), null);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /schemaVersion 99 > 2/);

  const hit = store.read('details', 'future');
  assert.equal(hit.futureVersion, true);
  assert.equal(hit.schemaVersion, 99);
  assert.deepEqual(hit.doc, { schemaVersion: 99, title: 'from the future' });
});

test('list returns sorted keys and remove is idempotent', async () => {
  const { store } = makeStore();
  await store.put('state', 'b', { n: 2 });
  await store.put('state', 'a', { n: 1 });
  assert.deepEqual(store.list('state'), ['a', 'b']);

  assert.equal(store.remove('state', 'a'), true);
  assert.equal(store.remove('state', 'a'), false);
  assert.deepEqual(store.list('state'), ['b']);
});

test('fresh() matches the game-cache TTL contract', () => {
  const { store } = makeStore();
  const now = Date.now();
  assert.equal(store.fresh({ fetchedAt: new Date(now - 1000).toISOString() }, 60_000), true);
  assert.equal(store.fresh({ fetchedAt: new Date(now - 120_000).toISOString() }, 60_000), false);
  assert.equal(store.fresh({ importedAt: new Date(now - 1000).toISOString() }, 60_000), true);
  // A timestamp in the future is not "fresh" (clock skew is not a cache hit).
  assert.equal(store.fresh({ fetchedAt: new Date(now + 60_000).toISOString() }, 60_000), false);
  assert.equal(store.fresh({}, 60_000), false);
  assert.equal(store.fresh(null, 60_000), false);
  // The field name is a parameter, exactly like `game-cache.isFresh`.
  assert.equal(store.fresh({ checkedAt: new Date(now - 1000).toISOString() }, 60_000, 'checkedAt'), true);
});

test('secret documents stay 0600 in a 0700 directory (Epic/LiveLib path)', () => {
  const root = tempRoot();
  const file = path.join(root, 'cookies', 'livelib-x.json');
  fsStore.writeSecretAtomicSync(file, { schemaVersion: 1, cookieHeader: 'redacted' });

  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(fsStore.readJson(file), { schemaVersion: 1, cookieHeader: 'redacted' });
  assert.deepEqual(tmpLeftovers(path.dirname(file)), []);
});
