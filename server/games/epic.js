'use strict';

/**
 * Epic Games Store client for the games tab (M6b).
 *
 * Server-side channel (§14.2): **device-code OAuth → library items →
 * playtime/account/all**, plus catalog bulk metadata. There is no public
 * no-key path to somebody else's Epic library — every user endpoint answers
 * `401 authentication_failed` without the owner's token.
 *
 * Flow implemented here:
 *
 *   1. `POST /account/api/oauth/token` (grant_type=client_credentials) with
 *      the public launcher client → a short-lived *client* token;
 *   2. `POST /account/api/oauth/deviceAuthorization` (bearer client token) →
 *      `{device_code, user_code, verification_uri_complete, expires_in,
 *      interval}`. The user opens the URL, types the code on
 *      epicgames.com/id/activate; the backend polls;
 *   3. `POST /account/api/oauth/token` (grant_type=device_code) →
 *      `{access_token, refresh_token, account_id, displayName, …}`;
 *   4. `grant_type=refresh_token` refreshes an expired access token.
 *
 * Read endpoints:
 *   - `GET /entitlement/api/account/{id}/entitlements` (primary ownership);
 *   - `GET /library/api/public/items?includeMetadata=true&cursor=…`
 *     (cursor pagination, fallback/merge for appName/platform/acquisition);
 *   - `GET /library/api/public/playtime/account/{id}/all` → `totalTime` is in
 *     **seconds**, there is **no lastPlayed** in the model;
 *   - `GET /catalog/api/shared/namespace/{ns}/bulk/items?id=…` (metadata);
 *   - `GET store-content.ak.epicgames.com/api/content/productmapping`
 *     (public appName → slug fallback, no token).
 *
 * Politeness (§14.5): pause `GAMES_EPIC_PAUSE_MS` (default 300 ms) between
 * requests, 30-minute breaker on 403/429, network/5xx → `epic_unreachable`
 * with `deferred: true` (the importer keeps the previous snapshot instead of
 * caching a negative result), 401 → `epic_auth_expired` (never "0 games").
 *
 * Secrets: access/refresh/device codes and the launcher client secret are
 * never logged or embedded in error messages. `maskSecrets()` is applied to
 * every message that leaves this module.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const gameCache = require('./game-cache');

const ACCOUNT_HOST = 'account-public-service-prod03.ol.epicgames.com';
const ACCOUNT_HOST_FALLBACKS = ['account-public-service-prod.ol.epicgames.com'];
const LIBRARY_HOST = 'library-service.live.use1a.on.epicgames.com';
const CATALOG_HOST = 'catalog-public-service-prod06.ol.epicgames.com';
const ENTITLEMENT_HOST = 'entitlement-public-service-prod08.ol.epicgames.com';
const STORE_CONTENT_HOST = 'store-content.ak.epicgames.com';
const VERIFY_URI = 'https://www.epicgames.com/id/activate';

/**
 * Public launcher client credentials. They are hardcoded in Legendary,
 * Heroic and Playnite; they are not a user secret, but §14.5 still forbids
 * echoing the values. `EPIC_CLIENT_ID` / `EPIC_CLIENT_SECRET` (aliases
 * `GAMES_EPIC_*`) override them for a private deployment.
 */
const DEFAULT_CLIENT_ID = '34a02cf8f4414e29b15921876da36f9a';
const DEFAULT_CLIENT_SECRET = 'daafbccc737745039dffe53d94fc76cf';

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_PAUSE_MS = 300;
const DEFAULT_BREAKER_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_LIBRARY_PAGES = 50;
const MAX_ENTITLEMENT_PAGES = 20;
const CATALOG_CHUNK = 25;
const ACCESS_REFRESH_SKEW_MS = 120000;

/** Stable error codes; routes map them to HTTP statuses. */
class EpicError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'EpicError';
    this.code = code || 'epic_error';
    if (details.status != null) this.status = details.status;
    if (details.retryAt != null) this.retryAt = details.retryAt;
    if (details.host != null) this.host = details.host;
    if (details.deferred) this.deferred = true;
  }
}

/* ------------------------------------------------------------------ */
/* Secrets                                                             */
/* ------------------------------------------------------------------ */

/**
 * Remove every Epic secret shape from a string. User codes are deliberately
 * NOT masked (they are shown to the user); `user_code` does not match the
 * `code=`/`token=` patterns below because of the `user_` prefix.
 */
function maskSecrets(value) {
  return String(value == null ? '' : value)
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
    .replace(/(basic\s+)[A-Za-z0-9+/=]+/gi, '$1***')
    .replace(
      /((?:access_token|refresh_token|device_code|client_secret|password|secret|authorization)["']?\s*[:=]\s*["']?)[^"'&\s,}]+/gi,
      '$1***'
    )
    .replace(
      /([?&](?:access_token|refresh_token|device_code|client_secret|password|secret|code|token)=)[^&\s"']+/gi,
      '$1***'
    );
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numOrNull(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toIso(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    // Epic uses seconds in `expires_at` in some payloads, milliseconds in
    // others; anything below 10^12 is treated as seconds.
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function formEncode(values) {
  return Object.entries(values)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function parseJsonBody(body) {
  const text = String(body == null ? '' : body);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function normalizeSlug(value) {
  let slug = String(value == null ? '' : value)
    .trim()
    .toLowerCase();
  slug = slug.replace(/^\/+|\/+$/g, '');
  slug = slug.replace(/\/home$/i, '');
  return slug || null;
}

function normalizePlatform(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase();
}

function normalizePlatforms(list) {
  if (!Array.isArray(list)) return [];
  return unique(list.map(normalizePlatform));
}

/* ------------------------------------------------------------------ */
/* HTTP layer                                                          */
/* ------------------------------------------------------------------ */

function networkError(err, target) {
  if (err instanceof EpicError) return err;
  const code = err && err.code ? err.code : 'ENETWORK';
  let host = null;
  try {
    host = new URL(target).hostname;
  } catch (_) {
    /* ignore */
  }
  return new EpicError(
    `Epic недоступен (${host || 'epic'}, ${code}): сеть/DNS/TLS не пускает к источнику. ` +
      'Это не повод считать источник мёртвым — импорт будет отложен (deferred).',
    'epic_unreachable',
    { host, deferred: true }
  );
}

function httpRequest({ method = 'GET', url, headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(new EpicError(`Некорректный Epic URL: ${maskSecrets(url)}`, 'epic_invalid_url'));
      return;
    }
    const lib = parsed.protocol === 'http:' ? http : https;
    const requestOptions = { method, headers };
    let req;
    try {
      req = lib.request(parsed, requestOptions, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(
              new EpicError(`Ответ Epic больше ${MAX_BODY_BYTES} байт.`, 'epic_http_error', {
                status: res.statusCode,
              })
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            status: Number(res.statusCode) || 0,
            headers: res.headers || {},
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', (err) => reject(networkError(err, url)));
      });
    } catch (err) {
      reject(networkError(err, url));
      return;
    }
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new EpicError(
          `Таймаут ${timeoutMs} мс при запросе к ${parsed.hostname} — Epic недоступен.`,
          'epic_unreachable',
          { host: parsed.hostname, deferred: true }
        )
      );
    });
    req.on('error', (err) => reject(networkError(err, url)));
    if (body != null) req.write(body);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* Parsers / normalizers (pure; fixtures cover them)                   */
/* ------------------------------------------------------------------ */

function normalizeDeviceAuthorization(json) {
  const raw = json && typeof json === 'object' ? json : {};
  const deviceCode = raw.device_code || raw.deviceCode || null;
  const userCode = raw.user_code || raw.userCode || null;
  const verificationUri =
    raw.verification_uri || raw.verificationUri || VERIFY_URI;
  const verificationUriComplete =
    raw.verification_uri_complete ||
    raw.verificationUriComplete ||
    (userCode ? `${VERIFY_URI}?userCode=${encodeURIComponent(userCode)}` : verificationUri);
  const expiresIn = numOrNull(raw.expires_in != null ? raw.expires_in : raw.expiresIn);
  const interval = numOrNull(raw.interval);
  if (!deviceCode || !userCode) {
    throw new EpicError(
      'Epic не выдал device code (нет device_code/user_code в ответе).',
      'epic_auth_failed'
    );
  }
  return {
    deviceCode: String(deviceCode),
    userCode: String(userCode),
    verificationUri: String(verificationUri),
    verificationUriComplete: String(verificationUriComplete),
    expiresIn: expiresIn && expiresIn > 0 ? Math.round(expiresIn) : 300,
    intervalMs: interval && interval > 0 ? Math.round(interval * 1000) : 5000,
  };
}

function normalizeTokenResponse(json, nowMs = Date.now()) {
  const raw = json && typeof json === 'object' ? json : {};
  const accountId = raw.account_id || raw.accountId || null;
  if (!accountId) {
    throw new EpicError(
      'Epic вернул токен без account_id — невозможно привязать библиотеку к владельцу.',
      'epic_auth_failed'
    );
  }
  const expiresIn = numOrNull(raw.expires_in != null ? raw.expires_in : raw.expiresIn);
  const refreshExpiresIn = numOrNull(
    raw.refresh_expires_in != null ? raw.refresh_expires_in : raw.refreshExpiresIn
  );
  const accessExpiresAt =
    toIso(raw.expires_at) ||
    (expiresIn && expiresIn > 0
      ? new Date(nowMs + Math.round(expiresIn) * 1000).toISOString()
      : null);
  const refreshExpiresAt =
    toIso(raw.refresh_expires_at) ||
    (refreshExpiresIn && refreshExpiresIn > 0
      ? new Date(nowMs + Math.round(refreshExpiresIn) * 1000).toISOString()
      : null);
  return {
    accountId: String(accountId),
    displayName: raw.displayName || raw.display_name || null,
    accessToken: raw.access_token || raw.accessToken || null,
    refreshToken: raw.refresh_token || raw.refreshToken || null,
    accessExpiresAt,
    refreshExpiresAt,
    tokenType: raw.token_type || raw.tokenType || null,
    clientId: raw.client_id || raw.clientId || null,
    scope: raw.scope || null,
  };
}

function normalizeEntitlement(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  return {
    id: item.id == null ? null : String(item.id),
    entitlementName: item.entitlementName || item.name || null,
    entitlementType: item.entitlementType || null,
    catalogItemId: item.catalogItemId == null ? null : String(item.catalogItemId),
    namespace: item.namespace || null,
    active: typeof item.active === 'boolean' ? item.active : null,
    status: item.status || null,
    consumable: typeof item.consumable === 'boolean' ? item.consumable : null,
    created: item.created || null,
    updated: item.updated || null,
  };
}

function isExcludedEntitlement(entitlement) {
  if (String(entitlement.namespace || '').toLowerCase() === 'ue') {
    return { excluded: true, reason: 'ue' };
  }
  if (entitlement.active === false) return { excluded: true, reason: 'inactive' };
  if (entitlement.status && String(entitlement.status).toUpperCase() !== 'ACTIVE') {
    return { excluded: true, reason: 'inactive' };
  }
  if (entitlement.consumable === true) return { excluded: true, reason: 'consumable' };
  if (String(entitlement.entitlementType || '').toUpperCase() === 'CONSUMABLE') {
    return { excluded: true, reason: 'consumable' };
  }
  return { excluded: false };
}

function normalizeLibraryRecord(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const platforms = normalizePlatforms(item.platform || item.platforms);
  return {
    appName: item.appName || item.app_name || null,
    namespace: item.namespace || null,
    catalogItemId: item.catalogItemId == null ? null : String(item.catalogItemId),
    productId: item.productId == null ? null : String(item.productId),
    sandboxType: item.sandboxType || null,
    country: item.country || null,
    platforms,
    acquisitionDate: item.acquisitionDate || null,
    productSlug: item.productSlug || null,
  };
}

const MOBILE_PLATFORMS = new Set(['android', 'ios', 'iphone', 'ipad']);

/**
 * Library item filter from the clients (§14.2): Unreal Engine marketplace
 * (`namespace === "ue"`), `sandboxType === "PRIVATE"`, and mobile-only records
 * (`platform` without Win32/Windows/Mac). An empty platform list is *unknown*
 * and kept — the rule is "Android-only", not "no platform field".
 */
function isExcludedLibraryRecord(record) {
  if (String(record.namespace || '').toLowerCase() === 'ue') {
    return { excluded: true, reason: 'ue' };
  }
  if (String(record.sandboxType || '').toUpperCase() === 'PRIVATE') {
    return { excluded: true, reason: 'private' };
  }
  const platforms = Array.isArray(record.platforms) ? record.platforms : [];
  if (platforms.length && platforms.every((platform) => MOBILE_PLATFORMS.has(platform))) {
    return { excluded: true, reason: 'mobile' };
  }
  return { excluded: false };
}

function secondsToMinutes(seconds) {
  return Math.round((Number(seconds) || 0) / 60);
}

function secondsToHours(seconds) {
  return Math.round(((Number(seconds) || 0) / 3600) * 10) / 10;
}

function normalizePlaytimeItem(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const artifactId =
    item.artifactId != null
      ? item.artifactId
      : item.artifact_id != null
        ? item.artifact_id
        : item.catalogItemId;
  const seconds = numOrNull(
    item.totalTime != null
      ? item.totalTime
      : item.total_time != null
        ? item.total_time
        : item.time
  );
  const totalTimeSec = seconds && seconds > 0 ? Math.round(seconds) : 0;
  return {
    artifactId: artifactId == null ? null : String(artifactId),
    totalTimeSec,
    totalMinutes: secondsToMinutes(totalTimeSec),
  };
}

/**
 * `playtime/account/{id}/all` → normalized snapshot. The unit is **seconds**
 * (Playnite stores `totalTime` as seconds); there is no lastPlayed field, so
 * none is invented here. Duplicate artifactIds are collapsed (last wins) so a
 * total is never double-counted.
 */
function normalizePlaytimeResponse(json) {
  const list = Array.isArray(json)
    ? json
    : json && Array.isArray(json.items)
      ? json.items
      : json && Array.isArray(json.playtime)
        ? json.playtime
        : json && Array.isArray(json.records)
          ? json.records
          : [];
  const byArtifactId = {};
  for (const raw of list) {
    const item = normalizePlaytimeItem(raw);
    if (!item.artifactId) continue;
    byArtifactId[item.artifactId] = item;
  }
  const items = Object.values(byArtifactId);
  const totalSeconds = items.reduce((sum, item) => sum + item.totalTimeSec, 0);
  return {
    items,
    byArtifactId,
    totalSeconds,
    totalMinutes: secondsToMinutes(totalSeconds),
    totalHours: secondsToHours(totalSeconds),
  };
}

function playtimeForGame(game, playtime) {
  if (!game || !playtime || !playtime.byArtifactId) return null;
  const byId = playtime.byArtifactId;
  if (game.catalogItemId && byId[game.catalogItemId]) return byId[game.catalogItemId];
  if (game.appName && byId[game.appName]) return byId[game.appName];
  if (game.productId && byId[game.productId]) return byId[game.productId];
  return null;
}

function normalizeCatalogItem(raw, catalogItemId) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const custom = item.customAttributes && typeof item.customAttributes === 'object'
    ? item.customAttributes
    : {};
  const releaseInfo = Array.isArray(item.releaseInfo) ? item.releaseInfo : [];
  const categories = Array.isArray(item.categories)
    ? item.categories
        .map((entry) =>
          typeof entry === 'string' ? entry : (entry && (entry.path || entry.name)) || null
        )
        .filter(Boolean)
    : [];
  return {
    catalogItemId: String(catalogItemId),
    namespace: item.namespace || null,
    title: item.title || null,
    description: item.description || null,
    slug: normalizeSlug(item.productSlug || item.urlSlug),
    productSlug: item.productSlug || null,
    urlSlug: item.urlSlug || null,
    developer: item.developer || custom.DeveloperName || null,
    publisher: item.publisher || custom.PublisherName || null,
    developerId: item.developerId || null,
    publisherId: item.publisherId || null,
    releaseDate: (releaseInfo[0] && releaseInfo[0].date) || null,
    categories,
    fetchedAt: new Date().toISOString(),
  };
}

function normalizeProductMapping(json) {
  const source =
    json && typeof json === 'object' && json.response && typeof json.response === 'object'
      ? json.response
      : json && typeof json === 'object' && json.items && typeof json.items === 'object'
        ? json.items
        : json && typeof json === 'object'
          ? json
          : {};
  const byAppName = {};
  for (const [appName, value] of Object.entries(source)) {
    if (['schemaVersion', 'source', 'fetchedAt'].includes(appName)) continue;
    const slug =
      typeof value === 'string'
        ? value
        : value && typeof value === 'object'
          ? value.slug || value.productSlug || value.urlSlug
          : null;
    const normalized = normalizeSlug(slug);
    if (normalized) byAppName[appName] = normalized;
  }
  return { byAppName, count: Object.keys(byAppName).length };
}

/**
 * Merge the two ownership sources. Entitlements are primary (they survive a
 * library-service change), library items add `appName`/`platform`/
 * `acquisitionDate`. Both sides are filtered first (UE/PRIVATE/mobile,
 * inactive/consumable) and the counts are reported honestly.
 */
function mergeLibrary({ entitlements = [], libraryItems = [] } = {}) {
  const excluded = {
    ue: 0,
    private: 0,
    mobile: 0,
    inactive: 0,
    consumable: 0,
    missingCatalogId: 0,
  };
  const byKey = new Map();
  let entitlementCount = 0;
  let libraryCount = 0;

  for (const raw of Array.isArray(entitlements) ? entitlements : []) {
    const entitlement = normalizeEntitlement(raw);
    const verdict = isExcludedEntitlement(entitlement);
    if (verdict.excluded) {
      excluded[verdict.reason] = (excluded[verdict.reason] || 0) + 1;
      continue;
    }
    if (!entitlement.catalogItemId) {
      excluded.missingCatalogId++;
      continue;
    }
    entitlementCount++;
    const key = entitlement.catalogItemId;
    const entry = byKey.get(key) || {
      appName: null,
      namespace: entitlement.namespace,
      catalogItemId: key,
      productId: null,
      sandboxType: null,
      platforms: [],
      acquisitionDate: null,
      entitlementId: null,
      entitlementName: null,
      entitlementType: null,
      sources: [],
    };
    entry.namespace = entry.namespace || entitlement.namespace;
    entry.entitlementId = entitlement.id;
    entry.entitlementName = entitlement.entitlementName;
    entry.entitlementType = entitlement.entitlementType;
    entry.sources.push('entitlement');
    byKey.set(key, entry);
  }

  for (const raw of Array.isArray(libraryItems) ? libraryItems : []) {
    const record = normalizeLibraryRecord(raw);
    const verdict = isExcludedLibraryRecord(record);
    if (verdict.excluded) {
      excluded[verdict.reason] = (excluded[verdict.reason] || 0) + 1;
      continue;
    }
    if (!record.catalogItemId && !record.appName) {
      excluded.missingCatalogId++;
      continue;
    }
    libraryCount++;
    const key = record.catalogItemId || `app:${record.namespace || ''}:${record.appName}`;
    const entry = byKey.get(key) || {
      appName: null,
      namespace: record.namespace,
      catalogItemId: record.catalogItemId,
      productId: null,
      sandboxType: null,
      platforms: [],
      acquisitionDate: null,
      entitlementId: null,
      entitlementName: null,
      entitlementType: null,
      sources: [],
    };
    entry.appName = entry.appName || record.appName;
    entry.namespace = entry.namespace || record.namespace;
    entry.catalogItemId = entry.catalogItemId || record.catalogItemId;
    entry.productId = entry.productId || record.productId;
    entry.sandboxType = entry.sandboxType || record.sandboxType;
    entry.platforms = unique([...(entry.platforms || []), ...record.platforms]);
    entry.acquisitionDate = entry.acquisitionDate || record.acquisitionDate;
    entry.sources.push('library');
    byKey.set(key, entry);
  }

  const games = [...byKey.values()].map((entry) => ({
    ...entry,
    source: 'epic',
    sources: unique(entry.sources),
    // `name` is filled by the catalog/productmapping step; `appName` is the
    // launcher id and is never a human title.
    name: entry.appName || entry.entitlementName || null,
    slug: null,
  }));

  return {
    games,
    counts: {
      entitlementCount,
      libraryCount,
      mergedCount: games.length,
      excluded,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

function defaultBreakerStore() {
  return {
    read() {
      return gameCache.readBreaker();
    },
    write(state) {
      return gameCache.writeBreaker(state);
    },
  };
}

function clientCredentials(options) {
  const id =
    options.clientId ||
    process.env.EPIC_CLIENT_ID ||
    process.env.GAMES_EPIC_CLIENT_ID ||
    DEFAULT_CLIENT_ID;
  const secret =
    options.clientSecret ||
    process.env.EPIC_CLIENT_SECRET ||
    process.env.GAMES_EPIC_CLIENT_SECRET ||
    DEFAULT_CLIENT_SECRET;
  return { clientId: id, clientSecret: secret };
}

function createClient(options = {}) {
  const request = options.request || httpRequest;
  const sleep = options.sleep || sleepDefault;
  const now = options.now || (() => Date.now());
  const pauseMs =
    options.pauseMs != null ? options.pauseMs : envInt('GAMES_EPIC_PAUSE_MS', DEFAULT_PAUSE_MS);
  const breakerMs =
    options.breakerMs != null ? options.breakerMs : envInt('GAMES_EPIC_BREAKER_MS', DEFAULT_BREAKER_MS);
  const breakerStore = options.breakerStore || defaultBreakerStore();
  const timeoutMs = options.timeoutMs || envInt('GAMES_EPIC_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const accountHost = options.accountHost || process.env.GAMES_EPIC_ACCOUNT_HOST || ACCOUNT_HOST;
  const accountHosts = unique([
    accountHost,
    ...(options.accountHosts || ACCOUNT_HOST_FALLBACKS),
  ]);
  const libraryHost = options.libraryHost || process.env.GAMES_EPIC_LIBRARY_HOST || LIBRARY_HOST;
  const catalogHost = options.catalogHost || process.env.GAMES_EPIC_CATALOG_HOST || CATALOG_HOST;
  const entitlementHost =
    options.entitlementHost || process.env.GAMES_EPIC_ENTITLEMENT_HOST || ENTITLEMENT_HOST;
  const storeContentHost =
    options.storeContentHost || process.env.GAMES_EPIC_STORE_CONTENT_HOST || STORE_CONTENT_HOST;
  const country = options.country || process.env.GAMES_EPIC_COUNTRY || 'US';
  const locale = options.locale || process.env.GAMES_EPIC_LOCALE || 'en-US';
  const creds = clientCredentials(options);
  const tokenStore = options.tokenStore || null;

  let lastRequestAt = null;
  let breakerCache = null;
  let clientToken = null;

  function loadBreaker() {
    if (breakerCache) return breakerCache;
    try {
      const state = breakerStore.read();
      breakerCache = state && typeof state === 'object' ? state : {};
    } catch (err) {
      breakerCache = {};
    }
    return breakerCache;
  }

  function breakerFor(host) {
    const state = loadBreaker();
    const entry = state[host];
    if (!entry || !entry.until) return null;
    if (entry.until <= now()) {
      delete state[host];
      try {
        breakerStore.write(state);
      } catch (_) {
        /* best-effort */
      }
      return null;
    }
    return entry;
  }

  function tripBreaker(host, reason) {
    const state = loadBreaker();
    state[host] = { until: now() + breakerMs, reason: String(reason || 'blocked'), at: now() };
    try {
      breakerStore.write(state);
    } catch (_) {
      /* best-effort */
    }
  }

  function assertNotBlocked(host) {
    const entry = breakerFor(host);
    if (!entry) return;
    throw new EpicError(
      `Epic (${host}) временно не опрашивается: предыдущий ответ ${entry.reason}. ` +
        `Повтор через ${Math.max(1, Math.ceil((entry.until - now()) / 60000))} мин.`,
      'epic_rate_limited',
      { host, retryAt: new Date(entry.until).toISOString() }
    );
  }

  async function throttle() {
    if (pauseMs <= 0) return;
    if (lastRequestAt != null) {
      const wait = pauseMs - (now() - lastRequestAt);
      if (wait > 0) await sleep(wait);
    }
    // Reserve the slot before awaiting so concurrent callers also space out.
    lastRequestAt = now();
  }

  function headersFor({ token, contentType, basic } = {}) {
    const headers = {
      'User-Agent': 'kinoboxd/1.0 (+games-tab)',
      Accept: 'application/json',
    };
    if (contentType) headers['Content-Type'] = contentType;
    if (token) headers.Authorization = `bearer ${token}`;
    if (basic) headers.Authorization = `basic ${basic}`;
    return headers;
  }

  /** Raw HTTP response; throttle + breaker, but no status classification. */
  async function requestRaw({ method = 'GET', url, host, token, basic, contentType, body }) {
    assertNotBlocked(host);
    await throttle();
    let response;
    try {
      response = await request({
        method,
        url,
        headers: headersFor({ token, contentType, basic }),
        body: body == null ? null : String(body),
        timeoutMs,
      });
    } catch (err) {
      throw err instanceof EpicError ? err : networkError(err, url);
    }
    const status = Number(response.status) || 0;
    if (status === 403 || status === 429) {
      tripBreaker(host, status === 429 ? '429 Too Many Requests' : 'HTTP 403');
    }
    return { status, body: String(response.body || ''), headers: response.headers || {} };
  }

  function classify(status, url, host) {
    if (status === 401) {
      return new EpicError(
        'Epic отклонил токен (401): подключение истекло, требуется переподключение. ' +
          'Значение токена не печатается.',
        'epic_auth_expired',
        { status, host }
      );
    }
    if (status === 403 || status === 429) {
      return new EpicError(
        `Epic (${host}) ответил ${status}: запросы приостановлены на 30 минут (breaker). ` +
          'Это не ошибка аккаунта — повторите позже.',
        'epic_rate_limited',
        { status, host }
      );
    }
    if (status >= 500) {
      return new EpicError(
        `Epic (${host}) ответил ${status}: источник временно недоступен, импорт отложен (deferred).`,
        'epic_unreachable',
        { status, host, deferred: true }
      );
    }
    return new EpicError(
      `Epic (${host}) ответил ${status}: ${maskSecrets(url)}`,
      'epic_http_error',
      { status, host }
    );
  }

  async function requestJson({ method = 'GET', url, host, token, basic, contentType, body }) {
    const response = await requestRaw({ method, url, host, token, basic, contentType, body });
    if (response.status < 200 || response.status >= 300) {
      throw classify(response.status, url, host);
    }
    const json = parseJsonBody(response.body);
    if (json == null) {
      throw new EpicError(
        `Epic (${host}) вернул не JSON: ${maskSecrets(url)}`,
        'epic_http_error',
        { status: response.status, host }
      );
    }
    return json;
  }

  /** Try the account hosts in order on network/5xx failures (host drift). */
  async function requestAccountJson(pathAndQuery, opts = {}) {
    let lastError = null;
    for (const host of accountHosts) {
      try {
        return await requestJson({
          ...opts,
          url: `https://${host}${pathAndQuery}`,
          host,
        });
      } catch (err) {
        lastError = err;
        const retryable = err && (err.code === 'epic_unreachable' || err.code === 'epic_http_error');
        if (!retryable) throw err;
      }
    }
    throw lastError;
  }

  /* --------------------------- OAuth ---------------------------- */

  async function getClientToken(force = false) {
    if (!force && clientToken && clientToken.expiresAt > now() + 30000) {
      return clientToken.token;
    }
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`, 'utf8').toString('base64');
    let json;
    try {
      json = await requestAccountJson('/account/api/oauth/token', {
        method: 'POST',
        basic,
        contentType: 'application/x-www-form-urlencoded',
        body: formEncode({ grant_type: 'client_credentials' }),
      });
    } catch (err) {
      // 401 here is about the *client* credentials, not the owner's token:
      // the message must say so (the values are never printed).
      if (err && err.code === 'epic_auth_expired') {
        throw new EpicError(
          'Epic отклонил client credentials лаунчера (значения не печатаются). ' +
            'Проверьте EPIC_CLIENT_ID/EPIC_CLIENT_SECRET.',
          'epic_client_invalid'
        );
      }
      throw err;
    }
    const token = json.access_token || json.accessToken || null;
    if (!token) {
      throw new EpicError(
        'Epic не выдал client token (проверьте client credentials; значения не печатаются).',
        'epic_auth_failed'
      );
    }
    const expiresIn = numOrNull(json.expires_in != null ? json.expires_in : json.expiresIn);
    clientToken = {
      token: String(token),
      expiresAt: now() + (expiresIn && expiresIn > 0 ? expiresIn * 1000 : 3600000),
    };
    return clientToken.token;
  }

  async function deviceAuthorization() {
    const requestDevice = async (clientToken) =>
      requestAccountJson('/account/api/oauth/deviceAuthorization', {
        method: 'POST',
        token: clientToken,
        contentType: 'application/x-www-form-urlencoded',
        body: '',
      });
    let client = await getClientToken();
    try {
      return normalizeDeviceAuthorization(await requestDevice(client));
    } catch (err) {
      // A client token can be revoked between the cache write and this call;
      // retry exactly once with a fresh client_credentials token.
      if (!err || err.code !== 'epic_auth_expired') throw err;
      client = await getClientToken(true);
      return normalizeDeviceAuthorization(await requestDevice(client));
    }
  }

  /**
   * One poll of the device-code grant. Returns a *status*, never throws for
   * the normal pending/slow_down/expired states; authorized carries tokens
   * (the caller stores them, this module does not write secrets).
   */
  async function exchangeDeviceCode(deviceCode) {
    const client = await getClientToken();
    const response = await requestRaw({
      method: 'POST',
      url: `https://${accountHosts[0]}/account/api/oauth/token`,
      host: accountHosts[0],
      basic: Buffer.from(`${creds.clientId}:${creds.clientSecret}`, 'utf8').toString('base64'),
      contentType: 'application/x-www-form-urlencoded',
      body: formEncode({
        grant_type: 'device_code',
        device_code: deviceCode,
        token_type: 'eg1',
      }),
    });
    const json = parseJsonBody(response.body) || {};
    if (response.status === 200) {
      return { status: 'authorized', tokens: normalizeTokenResponse(json, now()) };
    }
    if (response.status === 403 || response.status === 429) {
      throw new EpicError(
        `Epic (${accountHosts[0]}) ответил ${response.status} на опрос device-code: ` +
          'запросы приостановлены на 30 минут (breaker).',
        'epic_rate_limited',
        { status: response.status, host: accountHosts[0] }
      );
    }
    const errorText = `${json.errorCode || ''} ${json.error || ''} ${json.errorMessage || ''}`.toLowerCase();
    if (errorText.includes('authorization_pending') || errorText.includes('pending')) {
      return { status: 'pending' };
    }
    if (errorText.includes('slow_down') || errorText.includes('slowdown')) {
      const interval = numOrNull(json.interval);
      return {
        status: 'slow_down',
        intervalMs: interval && interval > 0 ? Math.round(interval * 1000) : 10000,
      };
    }
    if (errorText.includes('expired')) {
      return {
        status: 'expired',
        code: 'epic_auth_expired',
        error: 'Код Epic истёк — начните подключение заново.',
      };
    }
    return {
      status: 'failed',
      code: 'epic_auth_failed',
      error: maskSecrets(
        json.errorMessage || json.errorCode || `Epic ответил ${response.status}`
      ),
    };
  }

  async function refreshTokens(refreshToken) {
    const client = await getClientToken();
    let response;
    try {
      response = await requestRaw({
        method: 'POST',
        url: `https://${accountHosts[0]}/account/api/oauth/token`,
        host: accountHosts[0],
        basic: Buffer.from(`${creds.clientId}:${creds.clientSecret}`, 'utf8').toString('base64'),
        contentType: 'application/x-www-form-urlencoded',
        body: formEncode({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          token_type: 'eg1',
        }),
      });
    } catch (err) {
      if (err && err.deferred) throw err;
      throw new EpicError(
        'Не удалось обновить Epic-токен: сеть недоступна, повторите позже.',
        'epic_unreachable',
        { deferred: true }
      );
    }
    if (response.status !== 200) {
      throw new EpicError(
        'Epic-токен больше не действует (refresh отклонён): требуется переподключение.',
        'epic_auth_expired',
        { status: response.status }
      );
    }
    const json = parseJsonBody(response.body);
    if (!json) {
      throw new EpicError('Epic вернул не JSON при refresh.', 'epic_http_error');
    }
    return normalizeTokenResponse(json, now());
  }

  async function markAuthExpired(accountId) {
    if (!tokenStore || typeof tokenStore.getTokens !== 'function') return;
    try {
      const doc = await tokenStore.getTokens(accountId);
      if (!doc) return;
      await tokenStore.saveTokens({
        ...doc,
        lastAuthError: 'auth_expired',
        lastAuthErrorAt: new Date().toISOString(),
      });
    } catch (_) {
      /* best-effort: the 401 is the primary signal */
    }
  }

  /**
   * Run a read call and record a 401 in the token file, so the status route
   * says "требуется переподключение" instead of showing the old snapshot as
   * if the connection were fine.
   */
  async function readWithAuth(accountId, task) {
    try {
      return await task();
    } catch (err) {
      if (err && err.code === 'epic_auth_expired') await markAuthExpired(accountId);
      throw err;
    }
  }

  /**
   * A usable access token for `accountId`, refreshed when it is within 2 min
   * of expiry. A missing file is `epic_not_connected`; a rejected refresh is
   * `epic_auth_expired` and is recorded in the token file (status, never the
   * value) so `/epic/status` can say "переподключите".
   */
  async function getAccessToken(accountId) {
    if (!tokenStore || typeof tokenStore.getTokens !== 'function') {
      throw new EpicError(
        'Epic token store не подключён — доступ к библиотеке невозможен.',
        'epic_not_connected'
      );
    }
    const doc = await tokenStore.getTokens(accountId);
    if (!doc || !doc.accessToken) {
      throw new EpicError(
        'Epic-аккаунт не подключён: сначала выполните «Войти через Epic» (device-code).',
        'epic_not_connected'
      );
    }
    const expiresAt = Date.parse(String(doc.accessExpiresAt || ''));
    const needsRefresh = !Number.isFinite(expiresAt) || expiresAt - now() < ACCESS_REFRESH_SKEW_MS;
    if (!needsRefresh) return doc.accessToken;
    if (!doc.refreshToken) {
      await markAuthExpired(accountId);
      throw new EpicError(
        'Epic access token истёк, refresh token отсутствует: требуется переподключение.',
        'epic_auth_expired'
      );
    }
    try {
      const fresh = await refreshTokens(doc.refreshToken);
      const merged = {
        ...doc,
        ...fresh,
        refreshToken: fresh.refreshToken || doc.refreshToken,
        deviceAuth: doc.deviceAuth || null,
        ownerKey: doc.ownerKey || null,
        displayName: fresh.displayName || doc.displayName,
        lastAuthError: null,
        lastAuthErrorAt: null,
      };
      if (typeof tokenStore.saveTokens === 'function') await tokenStore.saveTokens(merged);
      return merged.accessToken;
    } catch (err) {
      if (err && err.code === 'epic_auth_expired') await markAuthExpired(accountId);
      throw err;
    }
  }

  /* ------------------------- read endpoints ---------------------- */

  async function getAccount(accountId) {
    const token = await getAccessToken(accountId);
    try {
      const json = await requestAccountJson(
        `/account/api/public/account/${encodeURIComponent(accountId)}`,
        { token }
      );
      return {
        accountId: json.id ? String(json.id) : String(accountId),
        displayName: json.displayName || json.display_name || null,
        country: json.country || null,
        preferredLanguage: json.preferredLanguage || null,
      };
    } catch (err) {
      if (err && err.code === 'epic_auth_expired') await markAuthExpired(accountId);
      throw err;
    }
  }

  /**
   * Entitlements (primary ownership). Pagination is `start`/`count`; the
   * endpoint is on `entitlement-public-service-prod08` (the `…prod06` host
   * does not resolve from this network, §14.2 research note).
   */
  async function getEntitlements(accountId, opts = {}) {
    return readWithAuth(accountId, async () => {
      const token = await getAccessToken(accountId);
      const pageSize = Math.max(1, Math.min(1000, Number(opts.pageSize) || 1000));
      const maxPages = Math.max(1, Number(opts.maxPages) || MAX_ENTITLEMENT_PAGES);
      const all = [];
      let start = 0;
      let pages = 0;
      for (let page = 0; page < maxPages; page++) {
        const json = await requestJson({
          url:
            `https://${entitlementHost}/entitlement/api/account/` +
            `${encodeURIComponent(accountId)}` +
            `/entitlements?start=${start}&count=${pageSize}&includeMetadata=true`,
          host: entitlementHost,
          token,
        });
        const list = Array.isArray(json.entitlements)
          ? json.entitlements
          : Array.isArray(json.records)
            ? json.records
            : Array.isArray(json.items)
              ? json.items
              : [];
        pages++;
        all.push(...list);
        if (list.length < pageSize) break;
        start += pageSize;
      }
      return { entitlements: all, pages };
    });
  }

  /** Library items with cursor pagination (fallback/merge for appName). */
  async function getLibraryItems(accountId, opts = {}) {
    return readWithAuth(accountId, async () => {
      const token = await getAccessToken(accountId);
      const maxPages = Math.max(1, Number(opts.maxPages) || MAX_LIBRARY_PAGES);
      const records = [];
      let cursor = opts.cursor || null;
      let pages = 0;
      let truncated = false;
      for (let page = 0; page < maxPages; page++) {
        const query = new URLSearchParams({ includeMetadata: 'true' });
        if (cursor) query.set('cursor', cursor);
        const json = await requestJson({
          url: `https://${libraryHost}/library/api/public/items?${query.toString()}`,
          host: libraryHost,
          token,
        });
        const list = Array.isArray(json.records)
          ? json.records
          : Array.isArray(json.items)
            ? json.items
            : [];
        pages++;
        records.push(...list);
        cursor =
          (json.responseMetadata && json.responseMetadata.nextCursor) ||
          json.nextCursor ||
          null;
        if (!cursor) break;
        if (page === maxPages - 1) truncated = true;
      }
      return { records, pages, truncated, nextCursor: cursor || null };
    });
  }

  async function getPlaytime(accountId) {
    return readWithAuth(accountId, async () => {
      const token = await getAccessToken(accountId);
      const json = await requestJson({
        url:
          `https://${libraryHost}/library/api/public/playtime/account/` +
          `${encodeURIComponent(accountId)}/all`,
        host: libraryHost,
        token,
      });
      return normalizePlaytimeResponse(json);
    });
  }

  /**
   * Catalog metadata, batched by namespace. The endpoint requires the owner's
   * token even though the host is called `…public-service` (§14.2). Returns
   * `{ [catalogItemId]: normalized }`; chunk failures are collected so the
   * importer can keep a partial coverage instead of failing the library.
   */
  async function getCatalogBulk(namespace, catalogItemIds, opts = {}) {
    return readWithAuth(opts.accountId, async () => {
      const ids = unique((Array.isArray(catalogItemIds) ? catalogItemIds : []).map(String));
      if (!ids.length) return { items: {}, requests: 0, failures: [] };
      const token = await getAccessToken(opts.accountId);
      const chunkSize = Math.max(1, Math.min(50, Number(opts.chunkSize) || CATALOG_CHUNK));
      const items = {};
      const failures = [];
      let requests = 0;
      for (let index = 0; index < ids.length; index += chunkSize) {
        const chunk = ids.slice(index, index + chunkSize);
        const query = new URLSearchParams({
          includeDLCDetails: 'true',
          includeMainGameDetails: 'true',
          country,
          locale,
        });
        for (const id of chunk) query.append('id', id);
        try {
          const json = await requestJson({
            url:
              `https://${catalogHost}/catalog/api/shared/namespace/` +
              `${encodeURIComponent(namespace || 'fn')}/bulk/items?${query.toString()}`,
            host: catalogHost,
            token,
          });
          requests++;
          const source = json && typeof json === 'object' && json.items ? json.items : json;
          for (const id of chunk) {
            const raw = source && typeof source === 'object' ? source[id] : null;
            if (raw && typeof raw === 'object') {
              items[id] = normalizeCatalogItem(raw, id);
            }
          }
        } catch (err) {
          requests++;
          failures.push({
            namespace: namespace || null,
            ids: chunk,
            code: (err && err.code) || 'epic_http_error',
          });
          if (err && (err.code === 'epic_auth_expired' || err.code === 'epic_rate_limited')) {
            throw err;
          }
        }
      }
      return { items, requests, failures };
    });
  }

  /** Public appName → slug mapping; no token, one request, 68 KB. */
  async function getProductMapping() {
    const json = await requestJson({
      url: `https://${storeContentHost}/api/content/productmapping`,
      host: storeContentHost,
    });
    return normalizeProductMapping(json);
  }

  /** Best-effort session kill on disconnect (local token is deleted anyway). */
  async function killSession(accessToken) {
    if (!accessToken) return false;
    try {
      const response = await requestRaw({
        method: 'DELETE',
        url:
          `https://${accountHosts[0]}/account/api/oauth/sessions/kill/` +
          encodeURIComponent(accessToken),
        host: accountHosts[0],
        token: accessToken,
      });
      return response.status >= 200 && response.status < 300;
    } catch (err) {
      return false;
    }
  }

  return {
    options: { pauseMs, breakerMs, accountHosts, libraryHost, catalogHost, entitlementHost },
    getClientToken,
    deviceAuthorization,
    exchangeDeviceCode,
    refreshTokens,
    getAccessToken,
    getAccount,
    getEntitlements,
    getLibraryItems,
    getPlaytime,
    getCatalogBulk,
    getProductMapping,
    killSession,
    assertNotBlocked,
    tripBreaker,
    breakerFor,
    // Exposed for diagnostics/tests only. Never print the values.
    _tokenStore: tokenStore,
    _clientCredentials: () => ({ clientId: creds.clientId, hasSecret: Boolean(creds.clientSecret) }),
  };
}

module.exports = {
  EpicError,
  ACCOUNT_HOST,
  ACCOUNT_HOST_FALLBACKS,
  LIBRARY_HOST,
  CATALOG_HOST,
  ENTITLEMENT_HOST,
  STORE_CONTENT_HOST,
  VERIFY_URI,
  DEFAULT_PAUSE_MS,
  DEFAULT_BREAKER_MS,
  CATALOG_CHUNK,
  createClient,
  httpRequest,
  maskSecrets,
  normalizeDeviceAuthorization,
  normalizeTokenResponse,
  normalizeEntitlement,
  isExcludedEntitlement,
  normalizeLibraryRecord,
  isExcludedLibraryRecord,
  normalizePlaytimeItem,
  normalizePlaytimeResponse,
  secondsToMinutes,
  secondsToHours,
  playtimeForGame,
  normalizeCatalogItem,
  normalizeProductMapping,
  mergeLibrary,
  normalizeSlug,
};
