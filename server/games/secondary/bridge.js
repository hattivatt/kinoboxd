'use strict';

const { fetchOnce, responseFacade } = require('../../core/http');
const { parseWbDate, pickDate } = require('../franchise');

const gameCache = require('../game-cache');
const { normalizeSlug, uniqueSlugs } = require('./identity');
const { readCache, writeCache, emptyEntry, isSettledEntry, ttlMs } = require('./cache');

/* ------------------------------------------------------------------ */
/* identity bridge                                                      */
/* ------------------------------------------------------------------ */

const WDQS = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'kinoboxd/1.0 (games secondary identity; https://github.com/hattivatt/kinoboxd)';
const BATCH_SIZE = 450;
const DEFAULT_TIMEOUT_MS = 25000;

class SecondaryIdentityError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'SecondaryIdentityError';
    this.code = code || 'secondary_identity_error';
    if (details.status != null) this.status = details.status;
    if (details.retryAfter != null) this.retryAfter = details.retryAfter;
  }
}

function escapeLiteral(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]/g, ' ');
}

/**
 * One SPARQL query for both stores. GOG values are written as `game/<slug>`
 * (the P2725 literal form), Epic values as the bare slug (P6278). The
 * publication date is `OPTIONAL` so a QID without P577 still answers identity
 * (and is cached as a settled «no date», not as a failure).
 */
function buildBridgeQuery({ gogSlugs = [], epicSlugs = [] } = {}) {
  const gog = gogSlugs.map((slug) => `"game/${escapeLiteral(slug)}"`);
  const epic = epicSlugs.map((slug) => `"${escapeLiteral(slug)}"`);
  const branches = [];
  if (gog.length) {
    branches.push(
      `  { VALUES ?gogSlug { ${gog.join(' ')} }\n    ?item wdt:P2725 ?gogSlug .\n    BIND(?gogSlug AS ?slug)\n    BIND("gog" AS ?store) }`
    );
  }
  if (epic.length) {
    branches.push(
      `  { VALUES ?epicSlug { ${epic.join(' ')} }\n    ?item wdt:P6278 ?epicSlug .\n    BIND(?epicSlug AS ?slug)\n    BIND("epic" AS ?store) }`
    );
  }
  return `SELECT ?item ?store ?slug ?appid ?date ?precision WHERE {
${branches.join('\n  UNION\n')}
  OPTIONAL { ?item wdt:P1733 ?appid . }
  OPTIONAL {
    ?item p:P577 ?st .
    ?st psv:P577 ?val .
    ?val wikibase:timeValue ?date .
    ?val wikibase:timePrecision ?precision .
  }
}`;
}

/**
 * One entry per `store:slug`. A date is only ever *added*: several P577
 * statements (regional releases) are reduced by the shared `pickDate` rule
 * (earliest year, then the most precise statement). `releaseDate` stays `null`
 * unless the statement is day-precision — a month/year precision must not
 * become a fake day.
 */
function parseBridgeResponse(data) {
  const bindings =
    data && data.results && Array.isArray(data.results.bindings) ? data.results.bindings : [];
  const acc = {};
  for (const row of bindings) {
    const item = row && row.item && row.item.value ? String(row.item.value) : null;
    const qid = item ? item.slice(item.lastIndexOf('/') + 1) : null;
    const store = row && row.store && row.store.value ? String(row.store.value) : null;
    const slug = row && row.slug && row.slug.value ? normalizeSlug(row.slug.value) : null;
    if (!qid || !store || !slug) continue;
    const key = `${store}:${slug}`;
    let entry = acc[key];
    if (!entry) {
      entry = { qid, appid: null, store, dates: [] };
      acc[key] = entry;
    }
    const appid = row.appid && row.appid.value ? String(row.appid.value) : null;
    // Several rows per item (base + expansion pass): keep the one with an appid.
    if (appid && !entry.appid) entry.appid = appid;
    if (row.date && row.date.value) {
      const date = parseWbDate(row.date.value, row.precision && row.precision.value);
      if (
        date &&
        !entry.dates.some((known) => known.iso === date.iso && known.precision === date.precision)
      ) {
        entry.dates.push(date);
      }
    }
  }
  const entries = {};
  for (const [key, entry] of Object.entries(acc)) {
    const date = pickDate(entry.dates);
    entries[key] = {
      qid: entry.qid,
      appid: entry.appid,
      store: entry.store,
      releaseYear: date ? date.year : null,
      releasePrecision: date ? date.precision : null,
      releaseDate: date && date.precision === 'day' ? date.iso : null,
      releaseDateSource: date ? 'wikidata' : null,
    };
  }
  return entries;
}

function sparqlRequest(query, options = {}) {
  const fetchImpl = options.fetchImpl;
  if (!fetchImpl && typeof globalThis.fetch !== 'function') {
    return Promise.reject(
      new SecondaryIdentityError('fetch is not available', 'secondary_identity_unavailable')
    );
  }
  const timeoutMs =
    options.timeoutMs == null
      ? DEFAULT_TIMEOUT_MS
      : Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  return fetchOnce(options.endpoint || process.env.KINOBOXD_WDQS_ENDPOINT || WDQS, {
    fetchImpl,
    method: 'POST',
    headers: {
      accept: 'application/sparql-results+json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT,
    },
    body: new URLSearchParams({ query, format: 'json' }).toString(),
    timeoutMs,
    label: 'secondary-bridge',
  }).then(responseFacade);
}

function chunk(list, size) {
  const out = [];
  for (let index = 0; index < list.length; index += size) {
    out.push(list.slice(index, index + size));
  }
  return out;
}

/**
 * Resolve GOG/Epic slugs to Wikidata items and Steam appids, merging into the
 * cached document.
 *
 * @param {object} input `{ gogSlugs: string[], epicSlugs: string[] }`
 * @param {object} [options] `{ fetchImpl, endpoint, ttlMs, force, timeoutMs }`
 * @returns {Promise<{entries, queries, resolved, cached, skipped, errors}>}
 */
async function fetchSecondaryLinks(input = {}, options = {}) {
  // The **raw** slug is what Wikidata stores (`P6278 the-witcher-3-wild-hunt`,
  // `P2725 game/the_witcher_3_wild_hunt`); the normalised form is only the
  // cache key, because the two stores spell the same game differently.
  const rawGog = uniqueSlugs(input.gogSlugs);
  const rawEpic = uniqueSlugs(input.epicSlugs);
  const cached = readCache();
  const cachedEntries = cached && cached.entries && typeof cached.entries === 'object'
    ? cached.entries
    : {};
  const fresh = cached && gameCache.isFresh(cached, options.ttlMs || ttlMs());
  const known = (store, slug) => isSettledEntry(cachedEntries[`${store}:${normalizeSlug(slug)}`]);
  const pendingGog = fresh && options.force !== true
    ? rawGog.filter((slug) => !known('gog', slug))
    : rawGog;
  const pendingEpic = fresh && options.force !== true
    ? rawEpic.filter((slug) => !known('epic', slug))
    : rawEpic;
  const result = {
    entries: { ...cachedEntries },
    queries: 0,
    resolved: 0,
    cached: rawGog.length + rawEpic.length - pendingGog.length - pendingEpic.length,
    skipped: null,
    errors: [],
  };
  if (!pendingGog.length && !pendingEpic.length) return result;

  const batches = [];
  const gogBatches = chunk(pendingGog, BATCH_SIZE);
  const epicBatches = chunk(pendingEpic, BATCH_SIZE);
  const total = Math.max(gogBatches.length, epicBatches.length, 1);
  for (let index = 0; index < total; index++) {
    batches.push({ gogSlugs: gogBatches[index] || [], epicSlugs: epicBatches[index] || [] });
  }

  for (const batch of batches) {
    if (!batch.gogSlugs.length && !batch.epicSlugs.length) continue;
    const query = buildBridgeQuery(batch);
    result.queries++;
    let response;
    try {
      response = await sparqlRequest(query, options);
    } catch (err) {
      result.errors.push(`wd_network:${(err && err.code) || 'failed'}`);
      result.skipped = 'network';
      // Deferred, not negative: nothing is written for this batch.
      continue;
    }
    if (!response || !response.ok) {
      const status = response ? Number(response.status) || 0 : 0;
      result.errors.push(`wd_${status || 'http'}`);
      result.skipped = status === 429 ? 'rate_limited' : 'http';
      continue;
    }
    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      result.errors.push('wd_parse');
      result.skipped = 'parse';
      continue;
    }
    const parsed = parseBridgeResponse(data);
    // A slug the query did not answer is a real miss for the cached document.
    for (const slug of batch.gogSlugs) {
      const key = `gog:${normalizeSlug(slug)}`;
      if (parsed[key]) result.entries[key] = parsed[key];
      else if (!result.entries[key]) {
        result.entries[key] = emptyEntry('gog', slug);
      }
    }
    for (const slug of batch.epicSlugs) {
      const key = `epic:${normalizeSlug(slug)}`;
      if (parsed[key]) result.entries[key] = parsed[key];
      else if (!result.entries[key]) {
        result.entries[key] = emptyEntry('epic', slug);
      }
    }
    result.resolved += Object.values(parsed).filter((entry) => entry.qid).length;
  }

  // Only a batch that was actually answered may extend the TTL: a failed pass
  // keeps the previous `fetchedAt` so the next run retries.
  if (!result.skipped || result.resolved > 0) {
    writeCache(result.entries, {
      stats: { gogSlugs: rawGog.length, epicSlugs: rawEpic.length, queries: result.queries },
    });
  }
  return result;
}

module.exports = {
  WDQS,
  BATCH_SIZE,
  SecondaryIdentityError,
  escapeLiteral,
  buildBridgeQuery,
  parseBridgeResponse,
  sparqlRequest,
  chunk,
  fetchSecondaryLinks,
};
