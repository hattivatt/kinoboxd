'use strict';

/**
 * `core/sources.js` — the declarative politeness table.
 *
 * Values are transcribed from the constants the modules carried; this test
 * pins the AGENTS.md §1 numbers so a future edit cannot silently loosen a
 * pause, a budget or a breaker.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sources = require('../server/core/sources');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

test('the table covers every source the phase declares', () => {
  const expected = [
    'tmdb',
    'kinopoisk',
    'wdqs',
    'livelib',
    'hardcover',
    'litres',
    'googlebooks',
    'steam',
    'steamCommunity',
    'steamStore',
    'steamSpy',
    'steamReviews',
    'gog',
    'epic',
    'secondary',
    'moby',
    'wikidataFranchise',
  ];
  for (const id of expected) {
    assert.ok(sources.SOURCES[id], `missing source ${id}`);
  }
  assert.equal(sources.SOURCE_IDS.length, Object.keys(sources.SOURCES).length);
});

test('pauses match AGENTS.md §1', () => {
  assert.equal(sources.pauseMs('litres'), 2000);
  assert.equal(sources.pauseMs('googlebooks'), 400);
  assert.equal(sources.pauseMs('steamSpy'), 1100);
  assert.equal(sources.pauseMs('steamReviews'), 1700);
  assert.equal(sources.pauseMs('secondary'), 2000);
  assert.equal(sources.SOURCES.secondary.epicPauseMs, 1500);
  assert.equal(sources.pauseMs('steamCommunity'), 2000);
  assert.equal(sources.pauseMs('moby'), 1100);
});

test('budgets match AGENTS.md §1 and env names are the real ones', () => {
  assert.equal(sources.budgetLimit('litres'), 200);
  assert.equal(sources.SOURCES.litres.budgetEnv, 'BOOKS_LITRES_BUDGET');
  assert.equal(sources.budgetLimit('googlebooks'), 300);
  assert.equal(sources.SOURCES.googlebooks.budgetEnv, 'BOOKS_GB_BUDGET');
  assert.equal(sources.budgetLimit('steamSpy'), 340);
  assert.equal(sources.SOURCES.steamSpy.budgetEnv, 'GAMES_SPY_BUDGET');
  assert.equal(sources.budgetLimit('steamReviews'), 340);
  assert.equal(sources.SOURCES.steamReviews.budgetEnv, 'GAMES_REVIEWS_BUDGET');
  assert.equal(sources.budgetLimit('secondary'), 200);
  assert.equal(sources.SOURCES.secondary.budgetEnv, 'GAMES_SECONDARY_BUDGET');
  assert.equal(sources.budgetLimit('steam'), null);
});

test('breakers are 30 minutes and keyed by the documented host', () => {
  for (const id of ['litres', 'googlebooks', 'steam', 'steamCommunity', 'steamStore', 'steamSpy', 'steamReviews', 'gog', 'epic', 'secondary', 'moby']) {
    assert.equal(sources.breakerMs(id), 30 * MINUTE, `${id} breaker`);
  }
  assert.equal(sources.breakerMs('tmdb'), null);
  assert.equal(sources.SOURCES.steamReviews.breakerKey, 'api.steampowered.com/IUserReviewsService');
});

test('TTLs mirror the runtime owners without taking them over', () => {
  assert.equal(sources.ttlMs('steamStore'), 180 * DAY);
  assert.equal(sources.ttlMs('steamSpy'), 30 * DAY);
  assert.equal(sources.ttlMs('steamReviews'), 30 * DAY);
  assert.equal(sources.ttlMs('secondary'), 30 * DAY);
  assert.equal(sources.ttlMs('wikidataFranchise'), 90 * DAY);
  assert.equal(sources.ttlMs('tmdb'), null);
});

test('env overrides are read at call time, not at require time', () => {
  const previous = process.env.GAMES_SPY_PAUSE_MS;
  try {
    process.env.GAMES_SPY_PAUSE_MS = '5';
    assert.equal(sources.pauseMs('steamSpy'), 5);
    process.env.GAMES_SPY_PAUSE_MS = 'nope';
    assert.equal(sources.pauseMs('steamSpy'), 1100);
  } finally {
    if (previous == null) delete process.env.GAMES_SPY_PAUSE_MS;
    else process.env.GAMES_SPY_PAUSE_MS = previous;
  }
});

test('getSource throws for an unknown id instead of guessing a policy', () => {
  assert.throws(() => sources.getSource('nope'), /unknown source/);
});

test('env=0 means «off» for pause, budget, TTL, breaker and timeout', () => {
  const names = [
    'GAMES_SPY_PAUSE_MS',
    'GAMES_MOBY_PAUSE_MS',
    'GAMES_GOG_BUDGET',
    'GAMES_MOBY_BUDGET',
    'GAMES_SECONDARY_TTL_MS',
    'GAMES_FRANCHISE_TTL_DAYS',
    'GAMES_STORE_BREAKER_MS',
    'GAMES_SECONDARY_TIMEOUT_MS',
  ];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = '0';
    assert.equal(sources.pauseMs('steamSpy'), 0);
    assert.equal(sources.pauseMs('moby'), 0);
    assert.equal(sources.budgetLimit('gog'), 0);
    assert.equal(sources.budgetLimit('moby'), 0);
    assert.equal(sources.ttlMs('secondary'), 0);
    assert.equal(sources.ttlMs('wikidataFranchise'), 0);
    assert.equal(sources.breakerMs('steamStore'), 0);
    assert.equal(sources.timeoutMs('secondary'), 0);

    // Empty is unset, not zero.
    process.env.GAMES_SPY_PAUSE_MS = '';
    assert.equal(sources.pauseMs('steamSpy'), 1100);
  } finally {
    for (const name of names) {
      if (saved[name] == null) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test('core/env envMs keeps the same 0 = off convention', () => {
  const { envMs } = require('../server/core/env');
  const name = 'KINOBOXD_TEST_TTL_MS';
  const saved = process.env[name];
  try {
    process.env[name] = '0';
    assert.equal(envMs(name, 1234), 0);
    process.env[name] = '';
    assert.equal(envMs(name, 1234), 1234);
    process.env[name] = '-5';
    assert.equal(envMs(name, 1234), 1234);
  } finally {
    if (saved == null) delete process.env[name];
    else process.env[name] = saved;
  }
});

test('the LiveLib card pause stays at the pre-P2 2 s', () => {
  assert.equal(sources.SOURCES.livelib.cardPauseMs, 2000);
  assert.equal(sources.pauseMs('livelib'), 1500, 'bulk import keeps its random range');
});
