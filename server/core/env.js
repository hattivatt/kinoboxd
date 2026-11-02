'use strict';

/**
 * Environment-backed numeric knobs shared by the cache modules.
 *
 * `envMs` is the exact predicate three cache modules used to carry as local
 * copies (`gog-cache.js`, `secondary-details.js`, `epic-cache.js`): a positive
 * finite `Number` from `process.env[name]`, otherwise the caller's default.
 * Zero and negative values fall back on purpose — a TTL of 0 would mean
 * "always stale", and a pause/budget of 0 is a misconfiguration, not a
 * request. Callers that DO want zero (budgets) use `Number(...)` directly.
 *
 * `envTtl` is the same function under the name the Epic cache used; the two
 * former copies were byte-identical before U1.
 */

function envMs(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

module.exports = {
  envMs,
  envTtl: envMs,
};
