'use strict';

/**
 * Per-run budget counter.
 *
 * One implementation replaces the four byte-identical copies that lived in
 * `books/providers/{litres,googlebooks,livelib-card}.js` and
 * `games/enrich.js`. The contract is deliberately tiny and mutable, because
 * callers inspect `used`/`remaining` after a run:
 *
 *   const budget = createBudget(300);
 *   if (!budget.take()) return null;   // "not asked", not "not found"
 *
 * `limit` parsing is shared too: a finite non-negative `Number` is floored;
 * anything else falls back to the caller's default (a per-source constant, so
 * the default stays where the source declares it).
 *
 * Numeric limits that are not counters (franchise's `GAMES_FRANCHISE_BUDGET`,
 * `GAMES_GOG_BUDGET`, secondary-details' request counter) keep their own
 * shape; `budgetLimitFromEnv` is the shared env reader for those.
 */

/**
 * @param {number|string} limit
 * @param {number} [fallback]
 * @returns {{limit:number, used:number, remaining:number, take:()=>boolean}}
 */
function createBudget(limit, fallback) {
  const parsed = Number(limit);
  const fallbackNumber = Number(fallback);
  const max =
    Number.isFinite(parsed) && parsed >= 0
      ? Math.floor(parsed)
      : Number.isFinite(fallbackNumber) && fallbackNumber >= 0
        ? Math.floor(fallbackNumber)
        : 0;
  return {
    limit: max,
    used: 0,
    get remaining() {
      return Math.max(max - this.used, 0);
    },
    take() {
      if (this.used >= max) return false;
      this.used++;
      return true;
    },
  };
}

/** A finite non-negative number from the environment, else `fallback`. */
function budgetLimitFromEnv(envName, fallback) {
  const raw = Number(process.env[envName]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

/** `budgetFromEnv('BOOKS_GB_BUDGET', 300)` -> a fresh counter. */
function budgetFromEnv(envName, fallback) {
  return createBudget(budgetLimitFromEnv(envName, fallback), fallback);
}

module.exports = {
  createBudget,
  budgetLimitFromEnv,
  budgetFromEnv,
};
