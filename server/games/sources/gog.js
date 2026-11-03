'use strict';

/**
 * GOG store-metadata source of the secondary library.
 *
 * One product page (`api.gog.com/v2/games/{id}`, public, no token) → the
 * normalized document of `secondary/normalize.js`. This module owns the
 * request, the cache→breaker→network order and the negative cache:
 *
 *   - a fresh document is served as is (a cached store answer without a year is
 *     completed from the identity bridge — additive, never replaced);
 *   - a `404` is a negative entry (`not_found`, 30 days);
 *   - a `403`/`429` trips the 30-minute breaker (`secondary-details-breaker.json`);
 *   - a network/5xx answer is deferred: nothing is written.
 *
 * Politeness (§14.5): one request per product, pause `GAMES_SECONDARY_PAUSE_MS`
 * (2 s, GOG's undocumented ~200 req/h/IP limit is the reference), budget
 * `GAMES_SECONDARY_BUDGET` (200 requests/run, GOG first then Epic).
 *
 * The source descriptor mirrors the book providers' shape where the model
 * allows it (`{ id, capabilities, normalize, fetchDetails }`); a game library
 * is «library entries + playtime», not a «work lookup», so the capability
 * block says so instead of faking a journal interface.
 */

const { fetchJson } = require('../secondary/transport');
const { normalizeGogProduct } = require('../secondary/normalize');
const { readDetail, writeDetail, breakerBlock, tripBreaker } = require('../secondary/store');
const { applyWikidataYear } = require('../secondary');
const { SecondaryDetailsError } = require('../secondary/errors');

const GOG_API_HOST = 'api.gog.com';

function gogUrl(gogGameId) {
  return `https://${GOG_API_HOST}/v2/games/${encodeURIComponent(String(gogGameId))}`;
}

/**
 * Resolve one GOG product, honouring cache → breaker → network. Returns
 * `{ data, cached, status }`; throws `SecondaryDetailsError` for a deferred
 * answer (nothing cached) and returns `{status:'not_found', data:null}` for a
 * 404 that is now cached.
 */
async function resolveGog(gogGameId, options = {}) {
  const id = String(gogGameId == null ? '' : gogGameId);
  if (!id) throw new SecondaryDetailsError('Нет GOG id.', 'secondary_details_bad_target');
  const { doc, fresh } = readDetail('gog', id);
  if (fresh && doc && !options.force) {
    let data = doc.status === 'ok' ? doc.data : null;
    // A cached store answer without a year is completed from the identity
    // bridge (same rule as the Epic path): additive, never replaced.
    if (data) {
      const withYear = applyWikidataYear(data, {
        store: 'gog',
        slug: options.slug || data.slug,
      });
      if (withYear !== data) {
        try {
          writeDetail('gog', id, 'ok', withYear);
        } catch (err) {
          /* a read-only cache must not fail the read model */
        }
        data = withYear;
      }
    }
    return {
      data,
      status: doc.status,
      cached: true,
    };
  }
  const blocked = breakerBlock('gog');
  if (blocked && !options.ignoreBreaker) {
    throw new SecondaryDetailsError(
      `GOG на паузе до ${blocked.until}.`,
      'secondary_details_blocked',
      { deferred: true, retryAt: blocked.until }
    );
  }
  let payload;
  try {
    payload = await fetchJson(options.client, gogUrl(id));
  } catch (err) {
    if (err && err.code === 'secondary_details_not_found') {
      writeDetail('gog', id, 'not_found', null);
      return { data: null, status: 'not_found', cached: false };
    }
    if (err && (err.status === 403 || err.status === 429)) {
      tripBreaker('gog', 'blocked', err.status);
    }
    throw err;
  }
  let data;
  try {
    data = normalizeGogProduct(payload, { id, slug: options.slug, title: options.title });
  } catch (err) {
    // A 200 that does not parse is not a verdict about the product.
    throw err;
  }
  // No date on the product page (a partial): the bridged Wikidata item's P577
  // may still know the year. Genres/tags from the store are untouched.
  data = applyWikidataYear(data, { store: 'gog', slug: options.slug || data.slug });
  writeDetail('gog', id, 'ok', data);
  return { data, status: 'ok', cached: false };
}

const GOG_SOURCE = {
  id: 'gog',
  capabilities: {
    // A same-owner secondary library: entries + playtime, no journal.
    journal: false,
    library: true,
    playtime: true,
    storeMetadata: true,
    workLookup: false,
  },
  normalize: normalizeGogProduct,
  fetchDetails: resolveGog,
};

module.exports = {
  GOG_SOURCE,
  GOG_API_HOST,
  gogUrl,
  resolveGog,
};
