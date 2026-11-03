'use strict';

/**
 * `server/core/fs-store.js`: atomic JSON writes, fingerprint-checked reads and
 * the secret writer (0600). This is the layer the first phase of the refactor
 * gives to every cache module, so its failure modes are pinned here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../server/core/fs-store');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-fs-store-'));
}

test('writeJsonAtomic + readJson round-trip and leave no tmp file behind', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'facts.json');
  const fingerprint = await store.writeJsonAtomic(file, { schemaVersion: 1, values: [1, 2] });
  assert.ok(fingerprint);
  assert.deepEqual(store.readJson(file), { schemaVersion: 1, values: [1, 2] });
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')),
    []
  );
});

test('the fingerprint moves when the file is replaced', async () => {
  const file = path.join(tempDir(), 'doc.json');
  const first = await store.writeJsonAtomic(file, { n: 1 });
  const second = await store.writeJsonAtomic(file, { n: 2, longer: 'payload' });
  assert.notEqual(first, second);
  const read = store.readJsonWithFingerprint(file);
  assert.equal(read.fingerprint, second);
  assert.deepEqual(read.data, { n: 2, longer: 'payload' });
});

test('a missing file and a corrupt file both read as null', async () => {
  const dir = tempDir();
  assert.equal(store.readJson(path.join(dir, 'absent.json')), null);

  const corrupt = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corrupt, '{not json', 'utf8');
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(store.readJson(corrupt, { label: 'unit-test' }), null);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[unit-test\] corrupt JSON/);
});

test('sync write is atomic and returns the new fingerprint', () => {
  const file = path.join(tempDir(), 'sync.json');
  const fingerprint = store.writeJsonAtomicSync(file, { ok: true });
  assert.equal(store.readJson(file).ok, true);
  assert.equal(fingerprint, store.fingerprintOf(file));
});

test('writeJsonAtomic(Sync) honours an explicit JSON indent', async () => {
  const file = path.join(tempDir(), 'indented.json');
  const data = { schemaVersion: 1, nested: { a: 1 } };
  await store.writeJsonAtomic(file, data, { space: 2 });
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(data, null, 2));
  store.writeJsonAtomicSync(file, data, { space: 2 });
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(data, null, 2));
});

test('secret documents are written 0600 inside a 0700 directory', () => {
  const dir = tempDir();
  const file = path.join(dir, 'nested', 'token.json');
  store.writeSecretAtomicSync(file, { access_token: 'redacted' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(store.readJson(file), { access_token: 'redacted' });
});

test('verifySecretFileSync repairs 0644 and refuses a non-regular file', () => {
  const dir = tempDir();
  const file = path.join(dir, 'secret.json');
  fs.writeFileSync(file, '{}');
  fs.chmodSync(file, 0o644);
  store.verifySecretFileSync(file, 0o600);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const sub = path.join(dir, 'not-a-file');
  fs.mkdirSync(sub);
  assert.throws(
    () => store.verifySecretFileSync(sub),
    (err) => err.code === 'secret_mode_error'
  );

  const link = path.join(dir, 'link.json');
  fs.symlinkSync(file, link);
  assert.throws(
    () => store.verifySecretFileSync(link),
    (err) => err.code === 'secret_mode_error'
  );
});

test('safeKey removes path traversal and keeps the readable part', () => {
  assert.equal(store.safeKey('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(store.safeKey('steam-76561198038369983'), 'steam-76561198038369983');
  assert.equal(store.safeKey(null), '');
  assert.equal(store.safeKey('x'.repeat(200)).length, 120);
});

test('listJsonFiles returns sorted json documents only', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'b.json'), '{}');
  fs.writeFileSync(path.join(dir, 'a.json'), '{}');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'nested'));
  assert.deepEqual(store.listJsonFiles(dir), ['a.json', 'b.json']);
  assert.deepEqual(store.listJsonFiles(path.join(dir, 'missing')), []);
});

test('listJsonFiles accepts symlinked documents (worktree cache is a link)', () => {
  const dir = tempDir();
  const target = tempDir();
  fs.writeFileSync(path.join(target, 'linked.json'), '{}');
  fs.symlinkSync(path.join(target, 'linked.json'), path.join(dir, 'linked.json'));
  fs.writeFileSync(path.join(dir, 'plain.json'), '{}');
  fs.symlinkSync(path.join(target, 'linked.json'), path.join(dir, 'linked.txt'));
  // A dangling link is still a link entry: it is listed, the reader decides.
  fs.symlinkSync(path.join(target, 'gone.json'), path.join(dir, 'dangling.json'));

  assert.deepEqual(store.listJsonFiles(dir), ['dangling.json', 'linked.json', 'plain.json']);
});
