'use strict';

// Unit tests for the Hardcover token plumbing in server/config.js.
//
// Each case runs in a child process against a throwaway copy of config.js so
// that the real repo token file (app/config/hardcover-token, gitignored) never
// participates and the environment is fully controlled.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SOURCE = path.join(__dirname, '..', 'server', 'config.js');

function sandbox({ tokenFile } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-hc-config-'));
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.copyFileSync(SOURCE, path.join(dir, 'server', 'config.js'));
  if (tokenFile !== undefined) {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'hardcover-token'), tokenFile);
  }
  return dir;
}

function childEnv(extra) {
  const env = { ...process.env };
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
  try {
    process.stdout.write(JSON.stringify({
      token: config.getHardcoverToken(),
      source: config.hardcoverTokenSource(),
    }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ code: err.code, message: err.message }));
  }
`;

test('hardcover token: missing everywhere gives HARDCOVER_TOKEN_MISSING', () => {
  const dir = sandbox();
  const out = JSON.parse(run(dir, {}, PROBE));
  assert.strictEqual(out.code, 'HARDCOVER_TOKEN_MISSING');
  assert.match(out.message, /HARDCOVER_API_TOKEN/);
});

test('hardcover token: config/hardcover-token fallback is used and trimmed', () => {
  const dir = sandbox({ tokenFile: '  hc_pat_from_file\n\n' });
  const out = JSON.parse(run(dir, {}, PROBE));
  assert.deepStrictEqual(out, { token: 'hc_pat_from_file', source: 'file' });
});

test('hardcover token: HARDCOVER_API_TOKEN wins over the file', () => {
  const dir = sandbox({ tokenFile: 'hc_pat_from_file\n' });
  const out = JSON.parse(
    run(dir, { HARDCOVER_API_TOKEN: 'hc_pat_from_env' }, PROBE),
  );
  assert.deepStrictEqual(out, {
    token: 'hc_pat_from_env',
    source: 'HARDCOVER_API_TOKEN',
  });
});

test('hardcover token: HARDCOVER_READ_TOKEN is the alias (env > file)', () => {
  const dir = sandbox({ tokenFile: 'hc_pat_from_file\n' });
  const out = JSON.parse(
    run(dir, { HARDCOVER_READ_TOKEN: 'hc_pat_alias' }, PROBE),
  );
  assert.deepStrictEqual(out, {
    token: 'hc_pat_alias',
    source: 'HARDCOVER_READ_TOKEN',
  });
});

test('hardcover token: blank env values fall through to the file', () => {
  const dir = sandbox({ tokenFile: 'hc_pat_from_file\n' });
  const out = JSON.parse(
    run(
      dir,
      { HARDCOVER_API_TOKEN: '   ', HARDCOVER_READ_TOKEN: '\n' },
      PROBE,
    ),
  );
  assert.deepStrictEqual(out, { token: 'hc_pat_from_file', source: 'file' });
});

test('hardcover token: requiring config stays lazy (server starts without it)', () => {
  const dir = sandbox(); // no env, no token file
  const out = run(
    dir,
    {},
    `const c = require('./server/config');
     process.stdout.write(typeof c.getHardcoverToken + ':' + typeof c.getTmdbToken);`,
  );
  assert.strictEqual(out, 'function:function');
});
