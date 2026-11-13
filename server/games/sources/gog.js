'use strict';

const { fetchJson } = require('../secondary/transport');
const { normalizeGogProduct } = require('../secondary/normalize');
const { readDetail, writeDetail, breakerBlock, tripBreaker } = require('../secondary/store');
const { applyWikidataYear } = require('../secondary');
const { SecondaryDetailsError } = require('../secondary/errors');

const GOG_API_HOST = 'api.gog.com';

function gogUrl(gogGameId) {
  return `https://${GOG_API_HOST}/v2/games/${encodeURIComponent(String(gogGameId))}`;
}

async function resolveGog(gogGameId, options = {}) {
  const id = String(gogGameId == null ? '' : gogGameId);
  if (!id) throw new SecondaryDetailsError('Нет GOG id.', 'secondary_details_bad_target');
  const { doc, fresh } = readDetail('gog', id);
  if (fresh && doc && !options.force) {
    let data = doc.status === 'ok' ? doc.data : null;
    if (data) {
      const withYear = applyWikidataYear(data, {
        store: 'gog',
        slug: options.slug || data.slug,
      });
      if (withYear !== data) {
        try {
          writeDetail('gog', id, 'ok', withYear);
        } catch (err) {
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
    throw err;
  }
  data = applyWikidataYear(data, { store: 'gog', slug: options.slug || data.slug });
  writeDetail('gog', id, 'ok', data);
  return { data, status: 'ok', cached: false };
}

const GOG_SOURCE = {
  id: 'gog',
  capabilities: {
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
