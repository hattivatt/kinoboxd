'use strict';

/**
 * Facade over `server/core/http.js` + the per-source politeness bundle.
 *
 * The transport (timeout, retry/backoff for 429/5xx, Retry-After, injectable
 * `fetchImpl`/`sleep`) is shared with the games sources now; the provider
 * modules and their tests keep importing it from here.
 *
 * `createSourceClient` is the other half every network provider needs: one
 * breaker and one budget factory read from the declarative `core/sources` row.
 * `litres`, `googlebooks` and `livelib-card` each carried the same fifteen
 * lines around `core/breaker` + `core/budget`; the values were already in the
 * table, only the wiring was copied. The wrapper keeps the exported names the
 * providers and their tests use and leaves the semantics untouched:
 *
 *   - breaker state is process-local (memory), keyed by the provider `name`;
 *     `tripBreaker(ms)` still defaults to the source's 30 min window;
 *   - `createBudget(limit)` keeps the source default as its fallback;
 *   - `budgetFromEnv()` reads the source's own env variable.
 *
 * `source` differs from `name` only for the LiveLib card provider, which shares
 * the `livelib` source row (pause/budget/breaker) but keeps its own breaker key
 * and its own `BOOKS_LIVELIB_CARD_BUDGET`.
 */

const {
  HttpTransportError,
  DEFAULT_TIMEOUT_MS,
  fetchJson,
  parseRetryAfter,
  defaultSleep,
} = require('../../core/http');
const { createBudget, budgetFromEnv } = require('../../core/budget');
const { createSourceGate } = require('../../core/source-client');
const sources = require('../../core/sources');

/**
 * @param {{name:string, source?:string, budgetEnv:string}} options
 */
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
  fetchJson,
  parseRetryAfter,
  defaultSleep,
  createSourceClient,
};
