'use strict';

// Unit tests for the Google Books key plumbing in server/config.js.
//
// Each case runs in a child process against a throwaway copy of config.js so
// that the real repo key file (app/config/gbooks-token, gitignored) never
// participates and the environment is fully controlled. The value is never
// asserted by echo: only the source name and presence are.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SOURCE = path.join(__dirname, '..', 'server', 'config.js');

function sandbox({ keyFile } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-gb-config-'));
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.copyFileSync(SOURCE, path.join(dir, 'server', 'config.js'));
  if (keyFile !== undefined) {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'gbooks-token'), keyFile);
  }
  return dir;
}

function childEnv(extra) {
  const env = { ...process.env };
  delete env.GB_API_KEY;
  delete env.BOOKS_GOOGLE_API_KEY;
  delete env.HARDCOVER_API_TOKEN;
  delete env.HARDCOVER_READ_TOKEN;
  delete env.TMDB_API_TOKEN;
  delete env.TMDB_READ_ACCESS_TOKEN;
  return { ...env, ...extra };
}

function run(dir, env, code) {
  return execFileSync(process.execPath, ['-e', code], {
    cwd: dir,
    env: childEnv(env),
    encoding: 'utf8',
  }).trim();
}

const PROBE = `
  const config = require('./server/config');
  const key = config.loadGbooksKey();
  process.stdout.write(JSON.stringify({
    present: typeof key === 'string' && key.length > 0,
    source: config.gbooksKeySource(),
  }));
`;

test('gbooks key: missing everywhere is not an error (anonymous mode)', () => {
  const dir = sandbox();
  const out = JSON.parse(run(dir, {}, PROBE));
  assert.deepStrictEqual(out, { present: false, source: null });
});

test('gbooks key: config/gbooks-token fallback is used and trimmed', () => {
  const dir = sandbox({ keyFile: '  AIzaSy_from_file\n\n' });
  const out = JSON.parse(run(dir, {}, PROBE));
  assert.deepStrictEqual(out, { present: true, source: 'file' });
});

test('gbooks key: GB_API_KEY wins over the file', () => {
  const dir = sandbox({ keyFile: 'AIzaSy_from_file\n' });
  const out = JSON.parse(run(dir, { GB_API_KEY: 'AIzaSy_from_env' }, PROBE));
  assert.deepStrictEqual(out, { present: true, source: 'GB_API_KEY' });
});

test('gbooks key: BOOKS_GOOGLE_API_KEY is the alias (env > file)', () => {
  const dir = sandbox({ keyFile: 'AIzaSy_from_file\n' });
  const out = JSON.parse(run(dir, { BOOKS_GOOGLE_API_KEY: 'AIzaSy_alias' }, PROBE));
  assert.deepStrictEqual(out, { present: true, source: 'BOOKS_GOOGLE_API_KEY' });
});

test('gbooks key: blank env values fall through to the file', () => {
  const dir = sandbox({ keyFile: 'AIzaSy_from_file\n' });
  const out = JSON.parse(run(dir, { GB_API_KEY: '   ', BOOKS_GOOGLE_API_KEY: '\n' }, PROBE));
  assert.deepStrictEqual(out, { present: true, source: 'file' });
});
