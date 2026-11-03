'use strict';

/**
 * Environment-backed numeric knobs shared by the cache modules.
 *
 * **Convention (P2/FIX): `0` means «off», `undefined` means the table default.**
 * The same rule is declared in `core/sources.js` and applies to every
 * `*_MS` / `*_BUDGET` knob:
 *
 *   - pause `0`          -> no pause between requests;
 *   - budget `0`         -> zero requests this run;
 *   - TTL `0`            -> the entry is always stale;
 *   - breaker window `0` -> no cooldown (the trip expires immediately);
 *   - timeout `0`        -> no deadline (wait as long as the source needs).
 *
 * Negative and non-finite values are a misconfiguration and fall back to the
 * caller's default. Before this convention `envMs` deliberately rejected `0`
 * and returned the fallback; the review found that this made
 * `GAMES_SECONDARY_TTL_MS=0` / `GAMES_MOBY_PAUSE_MS=0` mean «default», not
 * «off». Those modules now share the explicit rule.
 *
 * `envMs` is the exact predicate three cache modules used to carry as local
 * copies (`gog-cache.js`, `secondary-details.js`, `epic-cache.js`).
 *
 * `envTtl` is the same function under the name the Epic cache used; the two
 * former copies were byte-identical before U1.
 */

function envMs(name, fallback) {
  const value = process.env[name];
  if (value == null || String(value).trim() === '') return fallback;
  const raw = Number(value);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

module.exports = {
  envMs,
  envTtl: envMs,
};
