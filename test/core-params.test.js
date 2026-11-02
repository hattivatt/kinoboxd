'use strict';

/**
 * `server/core/params.js`: the strict query contract shared by the books and
 * games routers. An unknown parameter or an unparsable value is a 400 with a
 * stable code; the messages match the pre-refactor routers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertOnlyParams,
  parseBoolParam,
  parseMinHours,
  parseInteger,
  parseEnum,
} = require('../server/core/params');
const { HttpError } = require('../server/core/errors');

function expect400(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof HttpError, `expected HttpError, got ${err}`);
    assert.equal(err.status, 400);
    assert.equal(err.code, code);
    return true;
  });
}

test('assertOnlyParams accepts exactly the listed parameters', () => {
  assertOnlyParams({ query: { profile: 'steam-1', minHours: '0' } }, ['profile', 'minHours'], 'GET /x');
  assertOnlyParams({ query: {} }, [], 'GET /x');
  assertOnlyParams({}, ['profile'], 'GET /x');
});

test('assertOnlyParams rejects the first unexpected parameter with a 400', () => {
  expect400(
    () => assertOnlyParams({ query: { profile: 'a', sources: 'x' } }, ['profile'], 'GET /api/books/stats'),
    'unexpected_parameter'
  );
  assert.throws(
    () => assertOnlyParams({ query: { bogus: '1' } }, [], 'GET /api/games/stats'),
    /Unexpected query parameter\(s\) for GET \/api\/games\/stats: "bogus"\. Accepted: \./
  );
});

test('parseBoolParam: 0/1 forms, fallback for empty, 400 for junk', () => {
  for (const value of ['1', 'true', 'YES', ' on ']) assert.equal(parseBoolParam(value, 'flag', false), true);
  for (const value of ['0', 'false', 'NO', ' off ']) assert.equal(parseBoolParam(value, 'flag', true), false);
  assert.equal(parseBoolParam(undefined, 'flag', true), true);
  assert.equal(parseBoolParam('', 'flag', false), false);
  expect400(() => parseBoolParam('maybe', 'includeFree', true), 'invalid_includeFree');
});

test('parseMinHours: -1, 0 and N; fractions and text are 400', () => {
  assert.equal(parseMinHours(undefined), 0);
  assert.equal(parseMinHours(''), 0);
  assert.equal(parseMinHours('-1'), -1);
  assert.equal(parseMinHours('0'), 0);
  assert.equal(parseMinHours('12'), 12);
  assert.equal(parseMinHours(null, 3), 3);
  for (const value of ['1.5', '-2', 'abc', '1e3']) {
    expect400(() => parseMinHours(value), 'invalid_minHours');
  }
});

test('parseInteger enforces the declared range', () => {
  assert.equal(parseInteger('7', { name: 'limit', min: 1, max: 10 }), 7);
  assert.equal(parseInteger(undefined, { name: 'limit', fallback: 5 }), 5);
  expect400(() => parseInteger('0', { name: 'limit', min: 1 }), 'invalid_limit');
  expect400(() => parseInteger('11', { name: 'limit', max: 10 }), 'invalid_limit');
  expect400(() => parseInteger('x', { name: 'limit' }), 'invalid_limit');
});

test('parseEnum is case-insensitive and reports the allowed values', () => {
  assert.equal(parseEnum('DETAILS', 'phase', ['details', 'spy']), 'details');
  assert.equal(parseEnum(undefined, 'phase', ['details'], null), null);
  assert.throws(() => parseEnum('all', 'phase', ['details', 'spy']), /must be one of: details, spy/);
});
