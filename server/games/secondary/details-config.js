'use strict';

const { envMs } = require('../../core/env');
const sources = require('../../core/sources');

const DEFAULT_BUDGET = sources.budgetLimit('secondary');
const DEFAULT_PAUSE_MS = sources.pauseMs('secondary');
const DEFAULT_EPIC_PAUSE_MS = sources.SOURCES.secondary.epicPauseMs;
const DEFAULT_KICK_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_SLUGLESS = 50;
const COVERAGE_MEMO_MS = 60 * 1000;

function budgetDefault() {
  return sources.budgetLimit('secondary');
}

function pauseMsFor(source) {
  const fallback = source === 'epic' ? DEFAULT_EPIC_PAUSE_MS : DEFAULT_PAUSE_MS;
  return sources.envNonNegative('GAMES_SECONDARY_PAUSE_MS', fallback);
}

function kickCooldownMs() {
  return envMs('GAMES_SECONDARY_KICK_COOLDOWN_MS', DEFAULT_KICK_COOLDOWN_MS);
}

module.exports = {
  MAX_SLUGLESS,
  COVERAGE_MEMO_MS,
  budgetDefault,
  pauseMsFor,
  kickCooldownMs,
};
