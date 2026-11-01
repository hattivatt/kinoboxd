'use strict';

/**
 * Secondary-store identity bridge (M6c): GOG `P2725` / Epic `P6278` → Wikidata
 * item → Steam `P1733` appid.
 *
 * Why it exists: GOG/Epic games must join the **Steam work** of the same game
 * (`workKey`), otherwise one game owned on two stores is two rows in every
 * chart. `gog-union.js` can only match a GOG slug that already sits in a
 * `links/<appid>.json` document, and Epic has no local id at all — the only
 * shared identifier is the Wikidata item.
 *
 * The pass is deliberately small (§14.3, one batch):
 *   - input: the store slugs of **secondary-only candidates** (a GOG product or
 *     an Epic game that the title pass did not match), not the whole Steam
 *     library;
 *   - one SPARQL request per ≤450 slugs (`VALUES` + `UNION`), `P2725` for GOG
 *     and `P6278` for Epic in the same query;
 *   - cache `cache-games/links/secondary.json`, TTL 30 days; a miss is cached
 *     too (as `{qid:null}`) so the pass is not repeated every import;
 *   - a network/5xx answer is **deferred** (no cache write), never a negative
 *     verdict — the same rule as every other WD pass in this project.
 *
 * Verified 01.11.2026 (research §14.3): `Q4267401` (The Witcher 3) carries all
 * three ids — `P1733 292030`, `P2725 game/the_witcher_3_wild_hunt`,
 * `P6278 the-witcher-3-wild-hunt` — so the bridge is the right tool for
 * exactly the case the user reported (a GOG/Epic copy of a Steam game).
 */

const path = require('path');

const gameCache = require('./game-cache');

const WDQS = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'kinoboxd/1.0 (games secondary identity; https://github.com/hattivatt/kinoboxd)';
const BATCH_SIZE = 450;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 25000;

const LINKS_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'links');
const CACHE_PATH = path.join(LINKS_DIR, 'secondary.json');

class SecondaryIdentityError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'SecondaryIdentityError';
    this.code = code || 'secondary_identity_error';
    if (details.status != null) this.status = details.status;
    if (details.retryAfter != null) this.retryAfter = details.retryAfter;
  }
}

function ttlMs() {
  const raw = Number(process.env.GAMES_SECONDARY_LINKS_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

/** `game/the_witcher_3_wild_hunt` → `the_witcher_3_wild_hunt`; Epic slug as is. */
function normalizeSlug(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/^game\//, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function escapeLiteral(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]/g, ' ');
}

/**
 * One SPARQL query for both stores. GOG values are written as `game/<slug>`
 * (the P2725 literal form), Epic values as the bare slug (P6278).
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
  return `SELECT ?item ?store ?slug ?appid WHERE {
${branches.join('\n  UNION\n')}
  OPTIONAL { ?item wdt:P1733 ?appid . }
}`;
}

/** `{ 'gog:slug': {qid, appid}, 'epic:slug': {qid, appid} }` from one response. */
function parseBridgeResponse(data) {
  const bindings =
    data && data.results && Array.isArray(data.results.bindings) ? data.results.bindings : [];
  const entries = {};
  for (const row of bindings) {
    const item = row && row.item && row.item.value ? String(row.item.value) : null;
    const qid = item ? item.slice(item.lastIndexOf('/') + 1) : null;
    const store = row && row.store && row.store.value ? String(row.store.value) : null;
    const slug = row && row.slug && row.slug.value ? normalizeSlug(row.slug.value) : null;
    if (!qid || !store || !slug) continue;
    const appid = row.appid && row.appid.value ? String(row.appid.value) : null;
    const key = `${store}:${slug}`;
    const previous = entries[key];
    // Several rows per item (base + expansion pass): keep the one with an appid.
    if (previous && previous.appid && !appid) continue;
    entries[key] = { qid, appid, store };
  }
  return entries;
}

function readCache() {
  const hit = gameCache.readJsonWithFingerprint(CACHE_PATH);
  return hit ? hit.data : null;
}

/** Cached bridge entries (fresh only unless `allowStale`), never a network call. */
function readSecondaryLinks({ allowStale = false } = {}) {
  const doc = readCache();
  if (!doc || !doc.entries || typeof doc.entries !== 'object') return {};
  if (!allowStale && !gameCache.isFresh(doc, ttlMs())) return {};
  return doc.entries;
}

function writeCache(entries, extra = {}) {
  const doc = {
    schemaVersion: 1,
    source: 'wikidata',
    fetchedAt: new Date().toISOString(),
    entries,
    ...extra,
  };
  try {
    gameCache.writeJsonAtomicSync(CACHE_PATH, doc);
  } catch (err) {
    /* a read-only cache (worktree) must not fail the import */
  }
  return doc;
}

function sparqlRequest(query, options = {}) {
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) {
    return Promise.reject(
      new SecondaryIdentityError('fetch is not available', 'secondary_identity_unavailable')
    );
  }
  const timeoutMs =
    options.timeoutMs == null
      ? DEFAULT_TIMEOUT_MS
      : Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const init = {
    method: 'POST',
    headers: {
      accept: 'application/sparql-results+json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT,
    },
    body: new URLSearchParams({ query, format: 'json' }).toString(),
  };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    init.signal = AbortSignal.timeout(timeoutMs);
  }
  return fetchImpl(options.endpoint || process.env.KINOBOXD_WDQS_ENDPOINT || WDQS, init);
}

function chunk(list, size) {
  const out = [];
  for (let index = 0; index < list.length; index += size) {
    out.push(list.slice(index, index + size));
  }
  return out;
}

/**
 * Raw slugs, de-duplicated by their normalised form: `the-witcher-3-wild-hunt`
 * (Epic) and `the_witcher_3_wild_hunt` (GOG) are the same key but different
 * literals, and Wikidata stores each store's own spelling.
 */
function uniqueSlugs(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) continue;
    const key = normalizeSlug(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
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
  const known = (store, slug) => Boolean(cachedEntries[`${store}:${normalizeSlug(slug)}`]);
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
        result.entries[key] = { qid: null, appid: null, store: 'gog', slug };
      }
    }
    for (const slug of batch.epicSlugs) {
      const key = `epic:${normalizeSlug(slug)}`;
      if (parsed[key]) result.entries[key] = parsed[key];
      else if (!result.entries[key]) {
        result.entries[key] = { qid: null, appid: null, store: 'epic', slug };
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

/** Slugs of the GOG products / Epic games that still need an identity. */
function collectSlugs({ gogProducts = [], epicGames = [] } = {}) {
  const gogSlugs = uniqueSlugs(gogProducts.map((product) => product && product.slug));
  const epicSlugs = uniqueSlugs(epicGames.map((game) => game && game.slug));
  return { gogSlugs, epicSlugs };
}

/**
 * Job-side wrapper: refresh the bridge for the slugs of one import.
 *
 * Runs **only for a real import** (`options.client` absent): a job driven by an
 * injected client is hermetic (tests, diagnostics) and must not touch WDQS.
 * Never throws — the import's own result is what the user asked for; the bridge
 * is an enhancement and a WD outage is reported as `skipped`.
 */
async function refreshForJob({ gogProducts = [], epicGames = [], options = {} } = {}) {
  if (options.client) return { skipped: 'injected_client' };
  if (options.wikidata === false || options.secondaryLinks === false) {
    return { skipped: 'disabled' };
  }
  const { gogSlugs, epicSlugs } = collectSlugs({ gogProducts, epicGames });
  if (!gogSlugs.length && !epicSlugs.length) return { skipped: 'no_slugs' };
  try {
    const report = await fetchSecondaryLinks(
      { gogSlugs, epicSlugs },
      {
        fetchImpl: options.fetchImpl,
        endpoint: options.wdqsEndpoint,
        force: options.force === true,
      }
    );
    return {
      gogSlugs: gogSlugs.length,
      epicSlugs: epicSlugs.length,
      queries: report.queries,
      resolved: report.resolved,
      cached: report.cached,
      skipped: report.skipped || null,
      errors: report.errors.slice(0, 5),
    };
  } catch (err) {
    return { skipped: 'error', errors: [String((err && err.code) || 'failed')] };
  }
}

module.exports = {
  WDQS,
  BATCH_SIZE,
  CACHE_PATH,
  SecondaryIdentityError,
  normalizeSlug,
  buildBridgeQuery,
  parseBridgeResponse,
  readSecondaryLinks,
  readCache,
  writeCache,
  fetchSecondaryLinks,
  collectSlugs,
  refreshForJob,
};
