'use strict';

/**
 * `server/core/errors.js`: the HTTP error type every router throws and the one
 * response shape (`{ error, code }`). The middleware must never leak an
 * internal message.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { HttpError, isHttpError, fromStatus, respondError, errorMiddleware } = require('../server/core/errors');

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('HttpError carries the status, the message and a stable code', () => {
  const err = new HttpError(400, 'bad request', 'invalid_profile');
  assert.equal(err.status, 400);
  assert.equal(err.message, 'bad request');
  assert.equal(err.code, 'invalid_profile');
  assert.equal(isHttpError(err), true);
  assert.equal(new HttpError(500, 'boom').code, 'error');
});

test('fromStatus wraps a plain error with an explicit status', () => {
  const wrapped = fromStatus(Object.assign(new Error('no library'), { status: 404, code: 'unknown_profile' }));
  assert.ok(wrapped instanceof HttpError);
  assert.equal(wrapped.status, 404);
  assert.equal(wrapped.code, 'unknown_profile');

  const unchanged = new Error('internal');
  assert.equal(fromStatus(unchanged), unchanged);
  const already = new HttpError(400, 'x', 'y');
  assert.equal(fromStatus(already), already);
});

test('respondError writes { error, code } for an HttpError', () => {
  const res = fakeRes();
  respondError(res, new HttpError(409, 'already matched', 'already_matched'));
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: 'already matched', code: 'already_matched' });
});

test('respondError logs and hides an unexpected error', () => {
  const res = fakeRes();
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    respondError(res, new Error('secret internal detail'));
  } finally {
    console.error = originalError;
  }
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Internal server error.', code: 'internal_error' });
  assert.equal(logged.length, 1);
});

test('errorMiddleware maps a broken JSON body to a 400', () => {
  const res = fakeRes();
  const syntax = new SyntaxError('Unexpected token');
  syntax.body = '{';
  errorMiddleware(syntax, {}, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Invalid JSON body.', code: 'invalid_json' });
});
