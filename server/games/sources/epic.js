'use strict';

/**
 * Epic store-metadata source of the secondary library.
 *
 * Two public endpoints and one owner-token fallback:
 *
 *   1. **CMS product page** — `store-content.ak.epicgames.com/api/en-US/
 *      content/products/{slug}` (public, `200` from this network). The base
 *      page is `type === 'productHome'`; `data.meta` has release date/tags/
 *      developer/publisher and `data.hero.portraitBackgroundImageUrl` is the
 *      vertical poster. The request carries a browser `User-Agent` (a bot
 *      string is the first thing an edge challenge looks at) and a failed
 *      primary host is retried once against the IPv4 mirror
 *      `store-content-ipv4.ak.epicgames.com`. A `403`/`429` from either host
 *      trips the 30-minute breaker with `code: 'cms_blocked'`; the first three
 *      failed answers are dumped (status + ≤2 KB body, tokens masked) to
 *      `cache-games/debug/epic/<slug>.json`.
 *   2. **Catalog bulk** (`createClient().getCatalogBulk`, **owner token**) —
 *      the only store-owned source left for a stale CMS page (Alan Wake 2:
 *      poster, no date/tags). One request per `catalogItemId`, same per-run
 *      budget/pause, same breaker; the result is written to
 *      `catalog/<catalogItemId>.json` and re-normalized. A `401` triggers one
 *      silent token refresh + retry, a still-expired token is **deferred**
 *      (`catalogPending`); a definitive empty answer is a 30-day negative
 *      probe (`catalog-probe/`). Every attempt lands in the per-owner ledger
 *      (`state/catalog-state.json`) so «resolved 1/1 with an empty card» can
 *      be told apart from «the job never asked».
 *   3. **Title probe** (`discoverEpicSlug`) — last-resort slug discovery for an
 *      exclusive that is in neither `productmapping` nor the catalog: the
 *      store slug is almost always the title in kebab-case, and the public CMS
 *      answers `200`/`404` without a token. The guess is **validated** (the
 *      page's own `productName` must equal the library title), so a wrong slug
 *      can never attach another game's poster/genres.
 *
 * A network/5xx answer is deferred (nothing is cached, the previous detail
 * stays); a `404` is a negative entry (`not_found`, 30 days, 7 days for a
 * guessed slug). Nothing is ever invented: an empty answer leaves the field
 * empty and the coverage says so.
 */

const fs = require('fs');
const path = require('path');

const gameCache = require('../game-cache');
const epicCache = require('../epic-cache');
const epic = require('../epic');
const tokenStore = require('../epic-token-store');
const { safeKey } = require('../../core/fs-store');
const { fetchJson } = require('../secondary/transport');
const {
  SCHEMA_VERSION,
  nowMs,
  isoOf,
  normalizeEpicProduct,
  epicPageNeedsCatalog,
  applyCatalogToDetail,
  catalogHasMeta,
  catalogAnswersMissing,
  catalogMetaFlags,
  epicGenresFromCategories,
  slugFromTitle,
  comparableTitle,
} = require('../secondary/normalize');
const {
  DEBUG_DIR,
  MAX_DEBUG_FILES,
  DEBUG_BODY_LIMIT,
  readDetail,
  writeDetail,
  readCatalogProbe,
  writeCatalogProbe,
  recordCatalogAttempt,
  shouldAttemptCatalog,
  catalogIsFresh,
  dumpCatalogFailure,
  recordError,
  recordSkip,
  breakerBlock,
  tripBreaker,
} = require('../secondary/store');
const { SecondaryDetailsError, maskSecrets } = require('../secondary/errors');
const { applyWikidataYear } = require('../secondary');

const EPIC_CONTENT_HOST = 'store-content.ak.epicgames.com';
// Cloudflare fronts the store CMS; the IPv4-only name is the same origin and
// is the documented workaround for an edge that rejects a network's IPv6 path.
const EPIC_CONTENT_MIRROR_HOST = 'store-content-ipv4.ak.epicgames.com';
const EPIC_HOSTS = [EPIC_CONTENT_HOST, EPIC_CONTENT_MIRROR_HOST];
// A browser UA: the CMS (and its CDN) answers a bot string with a challenge on
// some edges. The value is a plain desktop Chrome string, no cookies, no token.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_EPIC_NAMESPACE = 'fn';

function epicUrl(slug, host = EPIC_CONTENT_HOST) {
  return `https://${host}/api/en-US/content/products/${encodeURIComponent(String(slug))}`;
}

/* ------------------------------------------------------------------ */
/* Epic catalog refetch (owner token)                                  */
/* ------------------------------------------------------------------ */

/**
 * A stale Epic CMS page (Alan Wake 2: `meta` has only `customReleaseDate:
 * "Coming Soon"`) has no tags/release date. The catalog bulk is the only
 * store-owned source left, and it requires the **owner's** token. This block
 * is the bounded fallback: it is reached only for an Epic work whose CMS page
 * has no meta and whose catalog document is missing/stale, uses the same
 * per-run budget and pause as the Epic details phase, and never invents a
 * genre/date.
 */

function createCatalogClient(options = {}) {
  try {
    const store = options.tokenStore || tokenStore;
    return epic.createClient({ tokenStore: store });
  } catch (err) {
    return null;
  }
}

/**
 * One silent refresh + one retry. `getAccessToken` already refreshes a token
 * that is within two minutes of expiry; a 401 after that means the token was
 * revoked, but Epic sometimes rejects a token that the local clock still
 * considers valid. The retry is bounded (exactly one) and never prints a value.
 */
async function trySilentTokenRefresh(options, accountId) {
  const client =
    options.epicClient || options.catalogClient || createCatalogClient(options);
  if (!client || typeof client.refreshTokens !== 'function') return false;
  const store = options.tokenStore || tokenStore;
  if (typeof store.getTokens !== 'function' || typeof store.saveTokens !== 'function') {
    return false;
  }
  let doc;
  try {
    doc = await store.getTokens(accountId);
  } catch (err) {
    return false;
  }
  if (!doc || !doc.refreshToken) return false;
  try {
    if (typeof options.onRequest === 'function') options.onRequest();
    const fresh = await client.refreshTokens(doc.refreshToken);
    if (!fresh || !fresh.accessToken) return false;
    await store.saveTokens({
      ...doc,
      ...fresh,
      refreshToken: fresh.refreshToken || doc.refreshToken,
      lastAuthError: null,
      lastAuthErrorAt: null,
    });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Fetch `catalog/<catalogItemId>.json` with the owner's token. Returns
 * `{ catalog, pending, deferred, warning, skipped }`:
 *
 *   - `catalog` — the saved catalog document (or null);
 *   - `pending` — the owner may still get this metadata later (401/expired,
 *     rate limit, network): the detail is written but coverage stays pending,
 *     so the next kick retries. A *negative* answer is not pending;
 *   - `warning` — the job/status code (`catalog_auth_expired`, `catalog_blocked`,
 *     `catalog_empty`, …).
 *
 * Guards: no token / not connected → `skipped: 'not_connected'` (library-only,
 * previous behaviour); a fresh negative probe → `skipped: 'probe'`; a spent
 * budget → `skipped: 'budget'`. A 403/429 trips the **existing** Epic
 * secondary-details breaker (no new breaker is introduced).
 */
async function refetchEpicCatalog(options = {}) {
  const catalogItemId = options.catalogItemId ? String(options.catalogItemId) : '';
  const ownerKey = options.ownerKey ? String(options.ownerKey) : '';
  // Every early exit is recorded: `bySource.epic.lastSkip` must be able to say
  // «not_connected because the token was unbound», «probe», «budget», … — a
  // silent return is what made the production symptom undiagnosable.
  const skip = (reason, entry = {}) => {
    recordSkip(ownerKey, {
      source: 'epic',
      reason,
      catalogItemId: catalogItemId || null,
      ...entry,
    });
    return reason;
  };
  if (!catalogItemId) {
    return { catalog: null, skipped: 'no_catalog_id', skipReason: skip('no_catalog_id') };
  }
  let accountId =
    options.epicAccountId || (ownerKey ? epicCache.epicAccountForOwner(ownerKey) : null);
  if (!accountId && ownerKey) {
    // Self-heal an unbound/old-format token (one token, no other owner claims
    // it). A mismatch/ambiguity is *not* guessed at: the reason goes to the
    // status ledger instead.
    const binding =
      typeof epicCache.ensureEpicOwnerBinding === 'function'
        ? await epicCache.ensureEpicOwnerBinding(ownerKey, {
            tokenStore: options.tokenStore || null,
          })
        : null;
    if (binding && binding.accountId) accountId = binding.accountId;
    if (!accountId) {
      const state = (binding && binding.state) || 'none';
      const reason =
        state === 'owner_mismatch'
          ? 'owner_mismatch'
          : state === 'ambiguous'
            ? 'binding_ambiguous'
            : state === 'none' || state === 'no_owner'
              ? 'no_token'
              : 'not_connected';
      return {
        catalog: null,
        skipped: 'not_connected',
        skipReason: skip(reason, {
          detail: state,
          otherOwner: binding && binding.otherOwner ? binding.otherOwner : null,
        }),
        binding: binding || null,
      };
    }
  }
  if (!accountId) {
    return {
      catalog: null,
      skipped: 'not_connected',
      skipReason: skip('no_owner'),
      binding: null,
    };
  }
  const store = options.tokenStore || tokenStore;
  let token = null;
  try {
    token = typeof store.readTokenSummarySync === 'function'
      ? store.readTokenSummarySync(accountId)
      : null;
  } catch (err) {
    token = null;
  }
  if (!token || !token.hasAccessToken) {
    return {
      catalog: null,
      skipped: 'not_connected',
      skipReason: skip('no_access_token', { accountId }),
    };
  }
  const namespace = options.namespace || DEFAULT_EPIC_NAMESPACE;
  if (options.force !== true && options.forceCatalog !== true) {
    const probe = readCatalogProbe(catalogItemId);
    if (probe.fresh && probe.doc && probe.doc.status && probe.doc.status !== 'ok') {
      return {
        catalog: null,
        skipped: 'probe',
        skipReason: skip('probe', { accountId, detail: probe.doc.status }),
      };
    }
  }
  if (typeof options.canRequest === 'function' && !options.canRequest()) {
    noteCatalogAttempt(ownerKey, catalogItemId, {
      namespace,
      result: 'budget',
      code: 'catalog_budget',
      reason: 'budget',
    });
    return {
      catalog: null,
      skipped: 'budget',
      warning: 'catalog_budget',
      skipReason: skip('budget', { accountId }),
    };
  }
  const client =
    options.epicClient || options.catalogClient || createCatalogClient(options);
  if (!client || typeof client.getCatalogBulk !== 'function') {
    return {
      catalog: null,
      skipped: 'no_client',
      skipReason: skip('no_client', { accountId }),
    };
  }

  const record = (entry) => {
    try {
      recordError({
        ownerKey: ownerKey || null,
        source: 'epic',
        id: catalogItemId,
        ...entry,
      });
    } catch (err) {
      /* diagnostics must never break the job */
    }
  };

  const attempt = async () => {
    if (typeof options.onRequest === 'function') options.onRequest();
    return client.getCatalogBulk(namespace, [catalogItemId], { accountId });
  };

  let result;
  try {
    result = await attempt();
  } catch (err) {
    const code = (err && err.code) || 'epic_http_error';
    if (code === 'epic_auth_expired') {
      // One silent refresh (rerun the token), then one retry. If that fails,
      // the metadata is deferred, not denied: the next kick tries again.
      if (await trySilentTokenRefresh(options, accountId)) {
        try {
          result = await attempt();
        } catch (retryErr) {
          return catalogFailure(retryErr, failureKindOf(retryErr), {
            record,
            catalogItemId,
            namespace,
            ownerKey,
          });
        }
      } else {
        return catalogFailure(err, 'auth', { record, catalogItemId, namespace, ownerKey });
      }
    } else {
      return catalogFailure(err, failureKindOf(err), {
        record,
        catalogItemId,
        namespace,
        ownerKey,
      });
    }
  }

  const item = result && result.items ? result.items[catalogItemId] : null;
  const transport = catalogTransportFacts(result, catalogItemId);
  if (item) {
    try {
      await epicCache.saveEpicCatalogItem(catalogItemId, item);
    } catch (err) {
      /* a read-only cache must not fail the fetch */
    }
    const yearHas = Boolean(item.releaseDate);
    const genresOk = epicGenresFromCategories(item.categories).length > 0;
    if (!catalogHasMeta(item)) {
      // The catalog knows the item but has no date/categories either: this is
      // a definitive dead end, not a retryable one. Remember it for 30 days
      // and leave a dump — «the item exists but its shape is empty» is exactly
      // the Alan Wake 2 symptom that used to be invisible.
      writeCatalogProbe(catalogItemId, 'empty', { namespace, code: 'no_meta' });
      record({ code: 'catalog_empty', reason: 'no_meta', status: transport.httpStatus, message: null });
      noteCatalogAttempt(ownerKey, catalogItemId, {
        namespace,
        result: 'empty',
        ...transport,
        genresOk,
        yearHas,
        code: 'catalog_empty',
        reason: 'no_meta',
        item,
      });
      return { catalog: item, pending: false, deferred: false, warning: 'catalog_empty' };
    }
    // `shape_ok` is the only outcome that needs no follow-up: a release date
    // AND a real genre line. `ok` (one of them) is dumped for the owner.
    noteCatalogAttempt(ownerKey, catalogItemId, {
      namespace,
      result: yearHas && genresOk ? 'shape_ok' : 'ok',
      ...transport,
      genresOk,
      yearHas,
      item,
    });
    return { catalog: item, pending: false, deferred: false, warning: null };
  }

  const failures = Array.isArray(result && result.failures) ? result.failures : [];
  const failure = failures[0] || null;
  if (failure) {
    const code = failure.code || 'epic_http_error';
    if (code === 'epic_auth_expired') {
      return catalogFailure(failure, 'auth', { record, catalogItemId, namespace, ownerKey });
    }
    if (code === 'epic_rate_limited') {
      return catalogFailure(failure, 'rate', { record, catalogItemId, namespace, ownerKey });
    }
    if (code === 'epic_unreachable') {
      return catalogFailure(failure, 'network', { record, catalogItemId, namespace, ownerKey });
    }
  }
  // A 200 without the item is a definitive answer for this catalog id: remember
  // it for 30 days so a polled kick does not repeat the request.
  writeCatalogProbe(catalogItemId, failure ? 'http_error' : 'empty', {
    namespace,
    code: failure ? failure.code || null : null,
  });
  const warning = failure ? 'catalog_http_error' : 'catalog_empty';
  record({
    code: warning,
    reason: warning,
    status: transport.httpStatus,
    message: null,
  });
  noteCatalogAttempt(ownerKey, catalogItemId, {
    namespace,
    result: failure && transport.httpStatus !== 404 ? 'unavailable' : 'empty',
    ...transport,
    code: failure ? failure.code || null : 'catalog_empty',
    reason: warning,
  });
  return { catalog: null, pending: false, deferred: false, warning };
}

/**
 * Status + byte size of the chunk that carried this catalog id. A fake client
 * may omit `chunks` (tests) — then the fields stay `null`, never invented.
 */
function catalogTransportFacts(result, catalogItemId) {
  const id = String(catalogItemId == null ? '' : catalogItemId);
  const has = (entry) =>
    Array.isArray(entry && entry.ids) && entry.ids.map(String).includes(id);
  const chunks = Array.isArray(result && result.chunks) ? result.chunks : [];
  const chunk = chunks.find(has);
  if (chunk) {
    return {
      httpStatus: chunk.status == null ? null : Number(chunk.status),
      bytes: chunk.bytes == null ? null : Number(chunk.bytes),
    };
  }
  const failures = Array.isArray(result && result.failures) ? result.failures : [];
  const failure = failures.find(has);
  if (failure) {
    return {
      httpStatus: failure.status == null ? null : Number(failure.status),
      bytes: failure.bytes == null ? null : Number(failure.bytes),
    };
  }
  return { httpStatus: null, bytes: null };
}

/**
 * Record one catalog attempt in the owner ledger and dump a diagnostic file
 * for anything short of `shape_ok`. Both are best-effort: diagnostics must
 * never fail the job.
 */
function noteCatalogAttempt(ownerKey, catalogItemId, entry = {}) {
  if (!ownerKey || !catalogItemId) return null;
  const recorded = recordCatalogAttempt(ownerKey, catalogItemId, entry);
  if (entry.result !== 'shape_ok') {
    dumpCatalogFailure(catalogItemId, entry);
  }
  return recorded;
}

function failureKindOf(err) {
  const code = (err && err.code) || 'epic_http_error';
  if (code === 'epic_auth_expired') return 'auth';
  if (code === 'epic_rate_limited') return 'rate';
  if (code === 'epic_unreachable' || (err && err.deferred)) return 'network';
  return 'http';
}

function catalogFailure(err, kind, context = {}) {
  const { record, catalogItemId, namespace, ownerKey } = context;
  const code = (err && err.code) || 'epic_http_error';
  const status = err && err.status != null ? err.status : null;
  const bytes = err && err.bodyBytes != null ? err.bodyBytes : null;
  const note = (result, extra = {}) =>
    noteCatalogAttempt(ownerKey, catalogItemId, {
      namespace,
      result,
      httpStatus: status,
      bytes,
      code,
      ...extra,
    });
  if (kind === 'auth') {
    if (record) record({ code: 'catalog_auth_expired', reason: code, status, message: null });
    note('401');
    return {
      catalog: null,
      pending: true,
      deferred: true,
      warning: 'catalog_auth_expired',
    };
  }
  if (kind === 'rate') {
    tripBreaker('epic', 'catalog_blocked', status);
    if (record) record({ code: 'catalog_blocked', reason: code, status, message: null });
    note('403');
    return {
      catalog: null,
      pending: true,
      deferred: true,
      warning: 'catalog_blocked',
    };
  }
  if (kind === 'network') {
    if (record) record({ code: 'catalog_deferred', reason: code, status, message: null });
    note('unavailable');
    return {
      catalog: null,
      pending: true,
      deferred: true,
      warning: 'catalog_deferred',
    };
  }
  if (catalogItemId) {
    writeCatalogProbe(catalogItemId, 'http_error', {
      namespace: namespace || null,
      code,
    });
  }
  if (record) record({ code: 'catalog_http_error', reason: code, status, message: null });
  note(status === 404 ? 'empty' : 'unavailable');
  return {
    catalog: null,
    pending: false,
    deferred: false,
    warning: 'catalog_http_error',
  };
}

/* ------------------------------------------------------------------ */
/* Epic CMS transport                                                  */
/* ------------------------------------------------------------------ */

/* ------------------------- Epic CMS transport ---------------------- */

/**
 * Keep the first `MAX_DEBUG_FILES` failed CMS answers for the owner to send
 * back. The body is truncated to 2 KB and secrets are masked; the file name is
 * the slug, so a re-run overwrites its own dump instead of growing the folder.
 * Diagnostics must never fail the request.
 */
function dumpEpicFailure(slug, info = {}) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const file = path.join(DEBUG_DIR, `${safeKey(slug)}.json`);
    if (!fs.existsSync(file)) {
      let count = 0;
      for (const name of fs.readdirSync(DEBUG_DIR)) {
        // The catalog ledger has its own cap (`MAX_CATALOG_DEBUG_FILES`): a
        // catalog failure must not evict the CMS dumps and vice versa.
        if (name.endsWith('.json') && !name.startsWith('catalog-')) count++;
      }
      if (count >= MAX_DEBUG_FILES) return null;
    }
    const body = info.body == null ? null : maskSecrets(String(info.body)).slice(0, DEBUG_BODY_LIMIT);
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      source: 'epic',
      slug: String(slug),
      at: isoOf(nowMs()),
      host: info.host || null,
      url: info.url ? maskSecrets(String(info.url)) : null,
      status: info.status == null ? null : Number(info.status),
      reason: info.reason || null,
      contentType: info.contentType || null,
      bodyBytes: info.bodyBytes == null ? null : Number(info.bodyBytes),
      body,
      note: 'Диагностика CMS Epic: только статус и первые 2 KB ответа, секреты замаскированы.',
    };
    gameCache.writeJsonAtomicSync(file, doc);
    return file;
  } catch (err) {
    return null;
  }
}

/**
 * Fetch one Epic CMS product page: primary host first, then the IPv4 mirror
 * when the primary fails for a reason that may be edge-specific (network,
 * `403`, `5xx`, a non-JSON challenge page). A `404` is the product's own
 * verdict and is **not** retried against the mirror; `429` is an account/IP
 * rate limit and is not retried either.
 *
 * Returns `{ payload, host, url }`. Every failed answer is dumped (capped).
 * `onExtraRequest` is called for the mirror attempt so the job budget counts
 * the real request count.
 */
async function fetchEpicProduct(slug, options = {}) {
  const hosts = Array.isArray(options.hosts) && options.hosts.length
    ? options.hosts
    : EPIC_HOSTS;
  const urlOf = typeof options.urlOf === 'function' ? options.urlOf : epicUrl;
  let lastError = null;
  for (let index = 0; index < hosts.length; index++) {
    const host = hosts[index];
    const url = urlOf(slug, host);
    if (index > 0 && typeof options.onExtraRequest === 'function') {
      try {
        options.onExtraRequest();
      } catch (err) {
        /* a counting hook must never break the fetch */
      }
    }
    try {
      const payload = await fetchJson(options.client, url, { userAgent: BROWSER_UA });
      return { payload, host, url };
    } catch (err) {
      lastError = err || lastError;
      const code = (err && err.code) || 'secondary_details_error';
      dumpEpicFailure(slug, {
        host,
        url,
        status: err && err.status,
        reason: (err && err.reason) || code,
        body: err && err.body,
        contentType: err && err.contentType,
        bodyBytes: err && err.bodyBytes,
      });
      if (code === 'secondary_details_not_found') throw err;
      if (err && err.status === 429) throw err;
    }
  }
  throw lastError || new SecondaryDetailsError('CMS Epic недоступна.', 'secondary_details_unreachable');
}

/* ------------------------------------------------------------------ */
/* slug discovery                                                      */
/* ------------------------------------------------------------------ */


/**
 * Last-resort slug discovery for an Epic exclusive that is in neither
 * `productmapping` (~1 283 records) nor the catalog's `productSlug`/`urlSlug`:
 * the store slug of a game is almost always its title in kebab-case, and the
 * public CMS answers `200`/`404` without a token. The guess is **validated** —
 * the page's own `productName` must equal the library title, so a wrong slug
 * can never attach another game's poster/genres.
 */
async function discoverEpicSlug(options = {}) {
  const title = options.title ? String(options.title).trim() : '';
  const guess = slugFromTitle(title);
  if (!guess || guess.length < 3) return null;
  if (comparableTitle(title).length < 3) return null;
  // A previous probe of this guess 404'd. It is a short-lived memory (7 days),
  // not a verdict: the same guess is retried later, and an explicit slug from
  // the catalog always bypasses it.
  if (!options.force) {
    const known = readDetail('epic', guess);
    if (
      known.fresh &&
      known.doc &&
      known.doc.status === 'not_found' &&
      known.doc.probe === true
    ) {
      return null;
    }
  }
  let fetched;
  try {
    if (typeof options.onRequest === 'function') options.onRequest();
    fetched = await fetchEpicProduct(guess, {
      client: options.client,
      onExtraRequest: options.onRequest,
      hosts: options.hosts,
      urlOf: options.urlOf,
    });
  } catch (err) {
    if (err && err.code === 'secondary_details_not_found') {
      // The guess is not a verdict about the product: remember it briefly so
      // the next kick does not probe again, and stay «library-only».
      writeDetail('epic', guess, 'not_found', null, { probe: true, title: title || null });
      return null;
    }
    if (err && (err.status === 403 || err.status === 429)) {
      tripBreaker('epic', 'cms_blocked', err.status);
      // The reason travels with the error: the job warning and the status
      // ledger must say «blocked by the CMS», not «no metadata».
      err.breakerCode = 'cms_blocked';
    }
    throw err;
  }
  const payload = fetched.payload;
  const name =
    (payload && (payload.productName || payload._title)) ||
    (payload && payload.pages && payload.pages[0] && payload.pages[0].productName) ||
    null;
  if (!name || comparableTitle(name) !== comparableTitle(title)) return null;
  // The validated page is the product page itself — no second request.
  return { slug: guess, payload, host: fetched.host || null };
}

/**
 * Use the cached catalog when it is fresh, otherwise refetch it with the
 * owner's token. A stale-but-present catalog is still returned as a fallback
 * even when the refetch is deferred: a real store date beats no date.
 */
async function ensureEpicCatalog(options = {}) {
  const catalog = options.catalog;
  const detail = options.detail || null;
  // Reuse is justified only by a document that answers the missing fact: a
  // freshly imported catalog with a date but no genre must not silence the
  // request (see `catalogAnswersMissing`).
  if (
    catalogHasMeta(catalog) &&
    catalogIsFresh(catalog) &&
    catalogAnswersMissing(detail, catalog)
  ) {
    return { catalog, pending: false, deferred: false, warning: null, reused: true };
  }
  const result = await refetchEpicCatalog(options);
  if (result.catalog) return result;
  if (catalogHasMeta(catalog)) return { ...result, catalog };
  return result;
}

function noteCatalogResult(result, options = {}) {
  if (!result) return;
  if (result.warning && typeof options.onWarning === 'function') {
    try {
      options.onWarning(result.warning);
    } catch (err) {
      /* a diagnostic hook must never break the fetch */
    }
  }
  if (result.deferred && typeof options.onCatalogDeferred === 'function') {
    try {
      options.onCatalogDeferred(result.warning);
    } catch (err) {
      /* ignore */
    }
  }
}

async function resolveEpic(slug, options = {}) {
  let id = String(slug == null ? '' : slug).trim();
  let probedPayload = null;
  let probedHost = null;
  const title = options.title ? String(options.title).trim() : '';
  const canProbe =
    Boolean(title) &&
    comparableTitle(title).length >= 3 &&
    (options.probeBudget == null || options.probeBudget >= 2);
  if (!id) {
    // Two requests are needed (probe + product page): only try when the job
    // still has that much budget left. Without a title there is nothing to
    // guess — the caller reports the work as `library-only`.
    if (!canProbe) {
      return { data: null, status: 'not_found', cached: false, reason: 'no_slug' };
    }
    const discovered = await discoverEpicSlug(options);
    if (!discovered) {
      return { data: null, status: 'not_found', cached: false, reason: 'no_slug' };
    }
    id = discovered.slug;
    probedPayload = discovered.payload;
    probedHost = discovered.host;
  }
  const { doc, fresh } = readDetail('epic', id);
  // A probe negative cache (`probe: true`) is a memory about a *guess*, not a
  // verdict about this id — an explicitly addressed product is re-fetched.
  const probeOnlyNegative = Boolean(
    doc && doc.status === 'not_found' && doc.probe === true
  );
  if (fresh && doc && !options.force && !(probeOnlyNegative && !probedPayload)) {
    let data = doc.status === 'ok' ? doc.data : null;
    let catalogSkipped = null;
    let catalogSkipReason = null;
    // A detail cached before the catalog existed (Alan Wake 2: poster only)
    // is completed in place: the raw CMS payload is not cached, so the catalog
    // fields are merged additively. No catalog item → nothing to do.
    if (
      data &&
      options.catalogItemId &&
      shouldAttemptCatalog(data, {
        ownerKey: options.ownerKey,
        catalogItemId: options.catalogItemId,
      })
    ) {
      // `detail: data` is what keeps a cached-but-unhelpful catalog document
      // from silencing the request (the import writes one without a ledger).
      const ensured = await ensureEpicCatalog({ ...options, detail: data });
      noteCatalogResult(ensured, options);
      catalogSkipped = ensured.skipped || null;
      catalogSkipReason = ensured.skipReason || null;
      let next = data;
      if (ensured.catalog) next = applyCatalogToDetail(next, ensured.catalog);
      if (ensured.skipped === 'not_connected') {
        if (next.catalogSkipped !== 'not_connected') {
          next = { ...next, catalogSkipped: 'not_connected' };
        }
      } else if (ensured.pending) {
        if (next.catalogPending !== true || next.catalogChecked === true) {
          next = { ...next, catalogPending: true };
          delete next.catalogChecked;
        }
        if (next.catalogSkipped) {
          next = { ...next };
          delete next.catalogSkipped;
        }
      } else if (next.catalogChecked !== true || next.catalogPending || next.catalogSkipped) {
        // Filled, definitively empty, or «not connected»: the one-time
        // completion attempt is over. A later connect still re-imports and the
        // run-phase `completingCatalog` path retries regardless of this marker.
        next = { ...next, catalogChecked: true };
        delete next.catalogPending;
        delete next.catalogSkipped;
      }
      const flags = catalogMetaFlags(next);
      if (next.metaStatus !== flags.metaStatus || next.metaCheckedAt == null) {
        next = {
          ...next,
          metaStatus: flags.metaStatus,
          metaYearHas: flags.yearHas,
          metaGenresOk: flags.genresOk,
          metaCheckedAt: isoOf(nowMs()),
        };
      }
      if (next !== data) {
        writeDetail('epic', id, 'ok', next);
        data = next;
      }
    }
    // A partial document whose year is still empty is completed from the
    // identity bridge (`links/secondary.json`). Additive: a catalog/store year
    // always wins; no bridge entry → the document stays honestly partial.
    if (data) {
      const withYear = applyWikidataYear(data, { store: 'epic', slug: id });
      if (withYear !== data) {
        const flags = catalogMetaFlags(withYear);
        data = {
          ...withYear,
          metaStatus: flags.metaStatus,
          metaYearHas: flags.yearHas,
          metaGenresOk: flags.genresOk,
          metaCheckedAt: isoOf(nowMs()),
        };
        writeDetail('epic', id, 'ok', data);
      }
    }
    return {
      data,
      status: doc.status,
      cached: true,
      catalogSkipped,
      catalogSkipReason,
    };
  }
  const blocked = breakerBlock('epic');
  if (blocked && !options.ignoreBreaker) {
    throw new SecondaryDetailsError(
      `Epic на паузе до ${blocked.until}.`,
      'secondary_details_blocked',
      {
        deferred: true,
        retryAt: blocked.until,
        reason: blocked.code || 'blocked',
        breakerCode: blocked.code || 'blocked',
      }
    );
  }
  let payload = probedPayload;
  let host = probedHost;
  if (!payload) {
    try {
      const fetched = await fetchEpicProduct(id, {
        client: options.client,
        onExtraRequest: options.onRequest,
        hosts: options.hosts,
        urlOf: options.urlOf,
      });
      payload = fetched.payload;
      host = fetched.host || null;
    } catch (err) {
      let recovered = null;
      // A catalog/productmapping slug can be stale (the catalog knows the base
      // game, the owned SKU has a different slug). A validated title probe is
      // the only way to tell «removed product» from «wrong slug»; it runs once
      // and must match the library title.
      if (err && err.code === 'secondary_details_not_found' && canProbe) {
        const guess = slugFromTitle(title);
        if (guess && guess !== id) {
          recovered = await discoverEpicSlug(options);
        }
      }
      if (!recovered) {
        if (err && err.code === 'secondary_details_not_found') {
          writeDetail('epic', id, 'not_found', null);
          return { data: null, status: 'not_found', cached: false };
        }
        if (err && (err.status === 403 || err.status === 429)) {
          tripBreaker('epic', 'cms_blocked', err.status);
          err.breakerCode = 'cms_blocked';
        }
        throw err;
      }
      id = recovered.slug;
      payload = recovered.payload;
      host = recovered.host || null;
    }
  }
  let catalog = options.catalog;
  let catalogPending = false;
  // Stale CMS page (Alan Wake 2): `meta` has no tags/releaseDate at all, so
  // the catalog bulk is the only store-owned source left. It needs the
  // owner's token and is bounded by the same budget/breaker as this phase.
  let catalogSkipped = null;
  let catalogSkipReason = null;
  if (epicPageNeedsCatalog(payload)) {
    // No detail document yet: both year and genres are missing, so a date-only
    // cached catalog is not enough to skip the request.
    const ensured = await ensureEpicCatalog({ ...options, detail: null });
    noteCatalogResult(ensured, options);
    if (ensured.catalog) catalog = ensured.catalog;
    catalogPending = Boolean(ensured.pending);
    if (ensured.skipped === 'not_connected') catalogSkipped = 'not_connected';
    catalogSkipReason = ensured.skipReason || null;
  }
  const normalized = normalizeEpicProduct(payload, {
    slug: id,
    title: options.title,
    catalog,
  });
  // After the catalog pass: if neither the CMS page nor the catalog carried a
  // release date, the bridged Wikidata item (P6278 slug → QID → P577) may know
  // it. Genres/developers/poster are untouched; no bridge entry → partial.
  const data = applyWikidataYear(normalized, {
    store: 'epic',
    slug: normalized.slug || id,
  });
  if (catalogPending) {
    data.catalogPending = true;
  } else {
    // The catalog question is settled for this detail: either the CMS page
    // carried its own meta, the catalog filled it, or the answer was
    // definitively empty. This is what keeps a polled `/stats` from re-kicking
    // a work whose store metadata is as complete as the stores allow.
    data.catalogChecked = true;
  }
  if (catalogSkipped) data.catalogSkipped = catalogSkipped;
  const flags = catalogMetaFlags(data);
  data.metaStatus = flags.metaStatus;
  data.metaYearHas = flags.yearHas;
  data.metaGenresOk = flags.genresOk;
  data.metaCheckedAt = isoOf(nowMs());
  writeDetail('epic', id, 'ok', data);
  // Persist a discovered slug so the read model (`secondary/index.js joinGames`) can
  // key the union entry `epic:<slug>` and attach this detail next request.
  if (options.catalogItemId && data.slug) {
    try {
      epicCache.saveEpicSlugOverride(options.catalogItemId, data.slug, {
        title: data.title || options.title || null,
        source: 'cms-title-probe',
      });
    } catch (err) {
      /* a read-only cache must not fail the fetch */
    }
  }
  return {
    data,
    status: 'ok',
    cached: false,
    host: host || null,
    catalogSkipped,
    catalogSkipReason,
  };
}

const EPIC_SOURCE = {
  id: 'epic',
  capabilities: {
    // A same-owner secondary library: entries + playtime + store metadata.
    journal: false,
    library: true,
    playtime: true,
    storeMetadata: true,
    catalog: true,
    workLookup: false,
  },
  normalize: normalizeEpicProduct,
  fetchDetails: resolveEpic,
};

module.exports = {
  EPIC_SOURCE,
  EPIC_CONTENT_HOST,
  EPIC_CONTENT_MIRROR_HOST,
  EPIC_HOSTS,
  BROWSER_UA,
  DEFAULT_EPIC_NAMESPACE,
  epicUrl,
  createCatalogClient,
  trySilentTokenRefresh,
  refetchEpicCatalog,
  catalogTransportFacts,
  noteCatalogAttempt,
  catalogFailure,
  dumpEpicFailure,
  fetchEpicProduct,
  discoverEpicSlug,
  ensureEpicCatalog,
  noteCatalogResult,
  resolveEpic,
};
