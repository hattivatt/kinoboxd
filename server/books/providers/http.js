'use strict';

const {
  HttpTransportError,
  DEFAULT_TIMEOUT_MS,
  fetchOnce,
  fetchJson,
  parseRetryAfter,
  defaultSleep,
} = require('../../core/http');
const { createBudget, budgetFromEnv } = require('../../core/budget');
const { createSourceGate } = require('../../core/source-client');
const sources = require('../../core/sources');

function createSourceClient(options = {}) {
  const name = options.name;
  const source = options.source || name;
  const budgetEnv = options.budgetEnv;
  const breakerMs = sources.breakerMs(source);
  const budgetLimit = sources.budgetLimit(source);
  const gate = createSourceGate({ breakerMs });

  return {
    breakerMs,
    budgetLimit,
    isBreakerOpen(now = Date.now()) {
      return Boolean(gate.breakerFor(name, now));
    },
    tripBreaker(ms = breakerMs) {
      gate.tripBreaker(name, { untilMs: ms });
    },
    resetBreaker() {
      gate.breaker.reset(name);
    },
    createBudget(limit) {
      return createBudget(limit, budgetLimit);
    },
    budgetFromEnv() {
      return budgetFromEnv(budgetEnv, budgetLimit);
    },
  };
}

module.exports = {
  ProviderHttpError: HttpTransportError,
  DEFAULT_TIMEOUT_MS,
  fetchOnce,
  fetchJson,
  parseRetryAfter,
  defaultSleep,
  createSourceClient,
};
