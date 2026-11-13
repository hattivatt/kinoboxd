'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.KINOBOXD_PASSWORD = 'correct horse';

const express = require('express');
const { portFor } = require('./helpers/port');
const auth = require('../server/auth');

const PORT = portFor(280);
const BASE = `http://127.0.0.1:${PORT}`;

function login(password) {
  return fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

test('login limiter locks a client after repeated failures and unlocks after the window', () => {
  let clock = 1000;
  const limiter = auth.createLoginLimiter({ maxFailures: 3, windowMs: 60000, now: () => clock });
  for (let i = 0; i < 2; i++) limiter.fail('a');
  assert.equal(limiter.retryAfterMs('a'), 0);
  limiter.fail('a');
  assert.equal(limiter.retryAfterMs('a'), 60000);
  assert.equal(limiter.retryAfterMs('b'), 0);
  clock += 60000;
  assert.equal(limiter.retryAfterMs('a'), 0);
  assert.equal(limiter.size(), 0);
});

test('login limiter forgets a client after a successful login', () => {
  const limiter = auth.createLoginLimiter({ maxFailures: 2, windowMs: 60000, now: () => 0 });
  limiter.fail('a');
  limiter.succeed('a');
  limiter.fail('a');
  assert.equal(limiter.retryAfterMs('a'), 0);
});

test('login limiter keeps its table bounded', () => {
  const limiter = auth.createLoginLimiter({ maxTracked: 3, windowMs: 60000, now: () => 0 });
  for (const key of ['a', 'b', 'c', 'd', 'e']) limiter.fail(key);
  assert.equal(limiter.size(), 3);
});

test('sweepSessions drops expired sessions only', () => {
  const token = auth.createSession();
  assert.ok(auth.getSession(token));
  auth.sweepSessions(Date.now());
  assert.ok(auth.getSession(token));
  auth.sweepSessions(Date.now() + 31 * 24 * 60 * 60 * 1000);
  assert.equal(auth.getSession(token), null);
});

test('POST /api/auth/login answers 429 with Retry-After after five wrong passwords', async (t) => {
  const app = express();
  app.use(express.json());
  app.use(auth.attachCookies);
  app.use('/api/auth', auth.router);
  const server = await new Promise((resolve) => {
    const listening = app.listen(PORT, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => server.close());

  for (let i = 0; i < 5; i++) {
    const res = await login('wrong');
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'wrong_password');
  }
  const locked = await login('correct horse');
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).code, 'too_many_attempts');
  assert.ok(Number(locked.headers.get('retry-after')) > 0);

  auth.loginLimiter.succeed('::ffff:127.0.0.1');
  auth.loginLimiter.succeed('127.0.0.1');
  const ok = await login('correct horse');
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie') || '', /kinoboxd_session=/);
});
