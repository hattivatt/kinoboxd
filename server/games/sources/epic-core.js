'use strict';

/**
 * Epic constants, the client error type and every pure parser/normalizer.
 *
 * This module owns the pieces that carry no I/O: token/entitlement/library/
 * playtime/catalog shapes, the secret masker and the merge of the two
 * ownership sources. `epic.js` re-exports all of it, so the public surface of
 * the client module is unchanged; `epic-requests.js` and `epic-client.js`
 * import the primitives directly and never require `epic.js` back (no cycle).
 */

const { URL } = require('url');

const sources = require('../../core/sources');
const { round1 } = require('../../core/stats');

const VERIFY_URI = 'https://www.epicgames.com/id/activate';

/** Authorization-code login: the page the user opens and the redirect it hits. */
const AUTHORIZE_URI = 'https://www.epicgames.com/id/login';
const REDIRECT_URI_BASE = 'https://www.epicgames.com/id/api/redirect';

/**
 * Public launcher client credentials. They are hardcoded in Legendary,
 * Heroic and Playnite; they are not a user secret, but §14.5 still forbids
 * echoing the values. `EPIC_CLIENT_ID` / `EPIC_CLIENT_SECRET` (aliases
 * `GAMES_EPIC_*`) override them for a private deployment, then
 * `config/epic-client.json` (0600, gitignored).
 *
 * This is `launcherAppClient2` (Legendary). It is the client that is proven
 * for `grant_type=authorization_code` + `token_type=eg1`. The device-code
 * grant is **not** available to it (nor to any public client): Epic answers
 * 1016 `unsupported_grant_type`.
 */
const DEFAULT_CLIENT_ID = '34a02cf8f4414e29b15921876da36f9a';
const DEFAULT_CLIENT_SECRET = 'daafbccc737745039dffe53d94fc76cf';

const DEFAULT_TIMEOUT_MS = sources.timeoutMs('epic');
const DEFAULT_PAUSE_MS = sources.pauseMs('epic');
const DEFAULT_BREAKER_MS = sources.breakerMs('epic');
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

/**
 * Remove every Epic secret shape from a string. User codes are deliberately
 * NOT masked (they are shown to the user); `user_code` does not match the
 * `code=`/`token=` patterns below because of the `user_` prefix.
 */
function maskSecrets(value) {
  return String(value == null ? '' : value)
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
    .replace(/(basic\s+)[A-Za-z0-9+/=]+/gi, '$1***')
    // Epic tokens have the `eg1~` prefix; mask the shape even if a future
    // payload puts it somewhere the key-based rules do not expect.
    .replace(/\beg1~[A-Za-z0-9._~+/=-]+/g, 'eg1~***')
    .replace(
      /((?:access_token|accessToken|refresh_token|refreshToken|device_code|deviceCode|client_secret|clientSecret|password|secret|authorization)["']?\s*[:=]\s*["']?)[^"'&\s,}]+/gi,
      '$1***'
    )
    .replace(
      /([?&](?:access_token|refresh_token|device_code|client_secret|password|secret|code|token)=)[^&\s"']+/gi,
      '$1***'
    );
}

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

/**
 * Epic login URL for the authorization-code flow (Legendary/Heroic pattern):
 * `https://www.epicgames.com/id/login?redirectUrl=<…/id/api/redirect?clientId=…&responseType=code>`.
 * After a successful login the browser lands on `id/api/redirect`, which shows
 * a one-time `code` the user pastes into the UI.
 */
function authorizeUrl(clientId) {
  const redirect = `${REDIRECT_URI_BASE}?clientId=${encodeURIComponent(
    String(clientId || DEFAULT_CLIENT_ID)
  )}&responseType=code`;
  return `${AUTHORIZE_URI}?redirectUrl=${encodeURIComponent(redirect)}`;
}

/**
 * Accept either the bare one-time `code` or any URL/string that carries it
 * (`https://www.epicgames.com/id/api/redirect?code=…`, a `#code=…` fragment,
 * or a pasted `code=…&…` fragment). Returns `null` when nothing looks like a
 * code — the caller answers `epic_code_required` instead of sending garbage
 * to Epic.
 */
function extractAuthCode(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return null;
  // Whole URL or query fragment: let URL parse the query, then the fragment.
  if (/^https?:\/\//i.test(raw) || raw.includes('?') || raw.includes('#')) {
    try {
      const parsed = new URL(raw, 'https://www.epicgames.com');
      const fromQuery = parsed.searchParams.get('code');
      if (fromQuery) return fromQuery.trim();
      const fragment = String(parsed.hash || '').replace(/^#/, '');
      const fromFragment = new URLSearchParams(fragment).get('code');
      if (fromFragment) return fromFragment.trim();
    } catch (err) {
      /* fall through to the regex */
    }
  }
  // A pasted `code=…&state=…` fragment or a URL URL() could not parse.
  const match = /(?:^|[?&#])code=([^&\s#]+)/.exec(raw);
  if (match) {
    try {
      return decodeURIComponent(match[1]).trim();
    } catch (err) {
      return match[1].trim();
    }
  }
  if (/^https?:\/\//i.test(raw)) return null;
  // Bare value: Epic codes are 32 hex chars, but accept any token-shaped
  // string so a future format is not rejected client-side.
  if (!/^[A-Za-z0-9._~+/=-]{8,256}$/.test(raw)) return null;
  return raw;
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
  return round1((Number(seconds) || 0) / 3600);
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
      productSlug: null,
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
    entry.productSlug = entry.productSlug || record.productSlug;
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
    // The library-service record sometimes carries `productSlug`; when it does
    // it is the same store slug as the catalog's `productSlug`. A later step
    // (`mergeCatalogSlugs`) may fill this from the catalog/productmapping.
    slug: normalizeSlug(entry.productSlug),
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

module.exports = {
  VERIFY_URI,
  AUTHORIZE_URI,
  REDIRECT_URI_BASE,
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_PAUSE_MS,
  DEFAULT_BREAKER_MS,
  MAX_BODY_BYTES,
  MAX_LIBRARY_PAGES,
  MAX_ENTITLEMENT_PAGES,
  CATALOG_CHUNK,
  ACCESS_REFRESH_SKEW_MS,
  EpicError,
  maskSecrets,
  formEncode,
  parseJsonBody,
  numOrNull,
  toIso,
  unique,
  envInt,
  sleepDefault,
  authorizeUrl,
  extractAuthCode,
  normalizeSlug,
  normalizePlatforms,
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
};
