'use strict';

/**
 * `core/budget.js` — one counter implementation for every source.
 *
 * The old copies in the three book providers and `games/enrich.js` were
 * byte-identical; this test pins the contract they shared (limit parsing,
 * `take()` idempotence, `remaining`) plus the two env readers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBudget, budgetLimitFromEnv, budgetFromEnv } = require('../server/core/budget');

test('createBudget: parses the limit, floors fractions and stops at zero', () => {
  const budget = createBudget('2.9');
  assert.equal(budget.limit, 2);
  assert.equal(budget.used, 0);
  assert.equal(budget.remaining, 2);
  assert.equal(budget.take(), true);
  assert.equal(budget.take(), true);
  assert.equal(budget.take(), false);
  assert.equal(budget.used, 2);
  assert.equal(budget.remaining, 0);
});

test('createBudget: a missing/junk limit falls back to the caller default', () => {
  assert.equal(createBudget(undefined, 300).limit, 300);
  assert.equal(createBudget('nope', 200).limit, 200);
  assert.equal(createBudget(-1, 340).limit, 340);
  assert.equal(createBudget(0, 300).limit, 0);
  assert.equal(createBudget(0, 300).take(), false);
});

test('budgetLimitFromEnv reads a finite non-negative number at call time', () => {
  const previous = process.env.BOOKS_GB_BUDGET;
  try {
    process.env.BOOKS_GB_BUDGET = '7';
    assert.equal(budgetLimitFromEnv('BOOKS_GB_BUDGET', 300), 7);
    process.env.BOOKS_GB_BUDGET = '0';
    assert.equal(budgetLimitFromEnv('BOOKS_GB_BUDGET', 300), 0);
    process.env.BOOKS_GB_BUDGET = 'oops';
    assert.equal(budgetLimitFromEnv('BOOKS_GB_BUDGET', 300), 300);
    delete process.env.BOOKS_GB_BUDGET;
    assert.equal(budgetLimitFromEnv('BOOKS_GB_BUDGET', 300), 300);
  } finally {
    if (previous == null) delete process.env.BOOKS_GB_BUDGET;
    else process.env.BOOKS_GB_BUDGET = previous;
  }
});

test('budgetFromEnv returns a fresh counter with the env limit', () => {
  const previous = process.env.BOOKS_LITRES_BUDGET;
  try {
    process.env.BOOKS_LITRES_BUDGET = '3';
    const budget = budgetFromEnv('BOOKS_LITRES_BUDGET', 200);
    assert.equal(budget.limit, 3);
    assert.equal(budget.take(), true);
    assert.equal(budget.used, 1);
  } finally {
    if (previous == null) delete process.env.BOOKS_LITRES_BUDGET;
    else process.env.BOOKS_LITRES_BUDGET = previous;
  }
});
