'use strict';

/**
 * Steam art CDN proxy (ИГРЫ §8.2 artwork, fix-round 02.11.2026).
 *
 * The owner's client sits in Vietnam, where the Steam store/CDN hosts are
 * blocked at the ISP edge (`NS_ERROR_DOM_NETWORK_ERR` on
 * `media.steampowered.com` and `cdn.cloudflare.steampowered.com`), while the
 * kinoboxd server reaches them normally. The browser therefore asks this
 * server for the artwork instead of the CDN:
 *
 *   GET /api/games/steam-art/<type>/<appid>[?h=<hash>]
 *     type  header | capsule | library | library_capsule | small_capsule | icon
 *     h     community icon hash (`icon`), or the `store_item_assets` asset
 *           hash for the newer `shared.akamai.steamstatic.com` schema
 *
 * `library_capsule` is the post-2024 file name (`library_capsule.jpg`) that
 * `IStoreBrowseService` publishes for a vertical capsule; `library` is the
 * legacy `library_600x900.jpg`. Which one a SKU has is resolved once per appid
 * by `resolveVerticalArt()` (below) and cached in `art/resolved/`.
 *
 * The upstream URL is **built here**, never passed in by the client, so the
 * route cannot be used as an open proxy. Only the five Steam CDN hostnames in
 * `UPSTREAM_HOSTS` are ever requested; `appid` must be digits, `h` is
 * `[A-Za-z0-9]{1,64}` and an unknown query parameter is a 400. The route is
 * mounted under the global `/api` auth gate (`server/index.js`), exactly like
 * every other `/api/games/*` endpoint.
 *
 * Fallback: a 404/403/5xx/network failure on one host moves to the next one
 * in `upstreamCandidates()`. A 200 is relayed with its own content type and
 * `Cache-Control: public, max-age=604800` (7 days). Responses are cached on
 * disk in `cache-games/art/` (one `<key>.bin` + one `<key>.json`), TTL 7 days,
 * with an LRU cap (`MAX_ART_FILES`, `MAX_ART_BYTES`) so a long-lived profile
 * cannot grow the cache without bound. The browser re-validates through the
 * same proxy; the disk cache only saves the upstream round-trip.
 *
 * Politeness: at most one upstream request per missing entry (plus a fallback
 * host only when the previous one failed). No cookies, no token, no
 * `Referer`; the Steam CDN endpoints are public and anonymous.
 */

const fs = require('fs');
const path = require('path');

const gameCache = require('./game-cache');
const { safeKey } = require('../core/fs-store');
const { fetchBinary, fetchJson } = require('../core/http');
const { createBreaker } = require('../core/breaker');
const sources = require('../core/sources');
const { HttpError } = require('../upload');

const ART_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'art');
const RESOLVED_DIR = path.join(ART_DIR, 'resolved');

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ART_FILES = 600;
const MAX_ART_BYTES = 64 * 1024 * 1024;
const MAX_ART_ENTRY_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12 * 1000;
const CACHE_CONTROL = 'public, max-age=604800';
// Raster formats only. An edge error page can arrive with a misleading
// `image/*` or `text/html` type; we never relay/cache anything else.
const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
]);

const TYPES = new Set(['header', 'capsule', 'library', 'library_capsule', 'small_capsule', 'icon']);
const FILE_BY_TYPE = {
  header: 'header.jpg',
  capsule: 'capsule_231x87.jpg',
  library: 'library_600x900.jpg',
  // Post-2024 SKUs put the true vertical capsule under the per-asset hash of
  // `IStoreBrowseService.assets.library_capsule` and call the file
  // `library_capsule.jpg` (live 03.11.2026: 3669870 has this file 200/56 KB,
  // while every `library_600x900.jpg` path — hashed and legacy — 404s).
  library_capsule: 'library_capsule.jpg',
  small_capsule: 'capsule_231x87.jpg',
};

// Resolve cache (`cache-games/art/resolved/<appid>.json`): one document per
// appid saying whether a vertical capsule exists and where. A positive answer
// is re-checked after 180 days (the store TTL); a negative one after 30 days,
// because Valve may publish the art later.
const RESOLVED_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const RESOLVED_NONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESOLVED_SCHEMA_VERSION = 1;
const ART_PATH = '/api/games/steam-art';
// `IStoreBrowseService/GetItems` is the public, keyless store-frontend API; it
// is the only place that publishes the per-asset `library_capsule` hash.
const BROWSE_HOST = 'api.steampowered.com';
const BROWSE_BREAKER_KEY = `${BROWSE_HOST}/IStoreBrowseService`;
const BROWSE_URL = `https://${BROWSE_HOST}/IStoreBrowseService/GetItems/v1/`;
const LIBRARY_CAPSULE_FILE_RE = /^([A-Za-z0-9]{1,64})\/(library_capsule(?:_2x)?|library_600x900(?:_2x)?)\.(?:jpg|jpeg|png)$/;

// Every host that may ever be requested. The list is an allowlist (tested):
// the request URL is assembled from an appid/hash that already passed the
// regex gate, so a client cannot turn this endpoint into an SSRF primitive.
const UPSTREAM_HOSTS = [
  'cdn.cloudflare.steamstatic.com',
  'cdn.akamai.steamstatic.com',
  'shared.cloudflare.steamstatic.com',
  'shared.akamai.steamstatic.com',
  'cdn.cloudflare.steampowered.com',
  'media.steampowered.com',
];

const APPID_RE = /^[1-9]\d{0,9}$/;
const HASH_RE = /^[A-Za-z0-9]{1,64}$/;

fs.mkdirSync(ART_DIR, { recursive: true });

// One key sanitiser for every cache (`core/fs-store`); art keys are built from
// already-validated `type`/`appid`/`hash` tokens, so the shared rules (trim,
// `[^\w.-]` -> `_`, 120-char cap) never change an existing file name here.
function artCacheKey(type, appid, hash) {
  return safeKey(`${type}-${appid}${hash ? `-${hash}` : ''}`);
}

/**
 * Upstream URLs for one art request, in fallback order. Legacy paths are
 * tried on the hosts that still serve them; `h` switches the newer
 * `store_item_assets/steam/apps/<appid>/<hash>/<file>` schema first (this is
 * what `appdetails.header_image`/`capsule_image` contain for post-2024 SKUs,
 * where the legacy path 404s).
 */
function upstreamCandidates(type, appid, hash) {
  if (!TYPES.has(type)) return [];
  if (type === 'icon') {
    if (!hash) return [];
    return [`https://media.steampowered.com/steamcommunity/public/images/apps/${appid}/${hash}.jpg`];
  }
  const file = FILE_BY_TYPE[type];
  const urls = [];
  if (hash) {
    urls.push(`https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/${hash}/${file}`);
    urls.push(`https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/${hash}/${file}`);
    urls.push(`https://cdn.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/${hash}/${file}`);
  }
  for (const host of UPSTREAM_HOSTS) {
    if (host === 'media.steampowered.com') continue;
    urls.push(`https://${host}/steam/apps/${appid}/${file}`);
  }
  return urls;
}

/** Is this an absolute URL on one of the allowed Steam CDN hosts? */
function isAllowedArtUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value == null ? '' : value));
  } catch (err) {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return UPSTREAM_HOSTS.includes(parsed.hostname.toLowerCase());
}

/**
 * Asset hash of a `store_item_assets/steam/apps/<appid>/<hash>/<file>` URL
 * (`appdetails.header_image`/`capsule_image` for post-2024 SKUs). Returns
 * `null` for a legacy path or anything that does not match the allowlisted
 * hosts, so a foreign URL can never smuggle a hash into the proxy.
 */
function assetHashFromUrl(value) {
  if (!isAllowedArtUrl(value)) return null;
  const match = /\/store_item_assets\/steam\/apps\/\d+\/([A-Za-z0-9]{1,64})\//.exec(
    String(value)
  );
  return match ? match[1] : null;
}

/* ------------------------------------------------------------------ */
/* Vertical-art resolve (one document per appid)                       */
/* ------------------------------------------------------------------ */

function resolvedPath(appid) {
  return path.join(RESOLVED_DIR, `${safeKey(appid)}.json`);
}

function readResolvedArt(appid) {
  const hit = gameCache.readJsonWithFingerprint(resolvedPath(appid));
  const doc = hit && hit.data;
  if (!doc || Number(doc.schemaVersion) !== RESOLVED_SCHEMA_VERSION) return null;
  return doc;
}

/** `{ [appid]: resolvedDoc }`; missing/corrupt files are simply absent. */
function listResolvedArt(appids) {
  const result = {};
  if (!Array.isArray(appids)) return result;
  for (const appid of appids) {
    if (appid == null) continue;
    const key = String(appid);
    if (result[key]) continue;
    const doc = readResolvedArt(appid);
    if (doc) result[key] = doc;
  }
  return result;
}

async function saveResolvedArt(doc) {
  return gameCache.writeJsonAtomic(resolvedPath(doc.appid), doc);
}

/** Positive answer lives 180 days, `none` 30 days (Steam may publish later). */
function resolvedFresh(doc, now = Date.now()) {
  if (!doc || !doc.resolvedAt) return false;
  const ts = Date.parse(doc.resolvedAt);
  if (!Number.isFinite(ts)) return false;
  const ttl = doc.kind === 'none' ? RESOLVED_NONE_TTL_MS : RESOLVED_TTL_MS;
  const age = now - ts;
  return age >= 0 && age < ttl;
}

/**
 * Compact probe list for the resolver (the proxy keeps the full host list for
 * the browser path). Two hosts per schema are enough to tell «exists» from
 * «404», and a resolver pass over 340 games must not spend five requests on
 * each missing file.
 */
function resolverCandidates(type, appid, hash) {
  if (!TYPES.has(type)) return [];
  const file = FILE_BY_TYPE[type];
  if (hash) {
    return [
      `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/${hash}/${file}`,
      `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/${hash}/${file}`,
    ];
  }
  return [
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/${file}`,
    `https://shared.akamai.steamstatic.com/steam/apps/${appid}/${file}`,
  ];
}

/** Probe one candidate list. Returns the upstream result (never throws). */
async function probeArt(type, appid, hash, options = {}) {
  return fetchUpstream(resolverCandidates(type, appid, hash), options);
}

function artProxyUrlFor(doc) {
  if (!doc || doc.kind === 'none') return null;
  if (doc.kind === 'sgdb') return doc.url || null;
  if (doc.kind === 'library-legacy') return `${ART_PATH}/library/${doc.appid}`;
  if (doc.kind === 'library-hashed') {
    const type = doc.proxyType || 'library';
    return `${ART_PATH}/${type}/${doc.appid}?h=${doc.h}`;
  }
  return null;
}

/** Small capsule URL used when the 32×32 community icon is missing or 404s. */
function smallIconFallbackOf(appid, hashes, browse) {
  const smallHash =
    (browse && browse.smallCapsuleHash) || hashes.capsule || null;
  return smallHash
    ? `${ART_PATH}/capsule/${appid}?h=${smallHash}`
    : `${ART_PATH}/capsule/${appid}`;
}

let lastBrowseAt = null;

async function browsePause(options = {}) {
  const pauseMs =
    options.pauseMs != null ? Number(options.pauseMs) : sources.pauseMs('steamBrowse');
  if (!(pauseMs > 0)) return;
  const now = options.now ? Number(options.now()) : Date.now();
  if (lastBrowseAt != null) {
    const wait = pauseMs - (now - lastBrowseAt);
    if (wait > 0) {
      const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
      await sleep(wait);
    }
  }
  lastBrowseAt = options.now ? Number(options.now()) : Date.now();
}

/**
 * `IStoreBrowseService/GetItems` for one appid, English assets. Returns
 * `{ libraryCapsule: { hash, file } | null, smallCapsuleHash: string | null }`
 * or `null` when the store has no visible item (an honest «not found»).
 *
 * Throws `{ code: 'art_browse_unreachable' | 'art_browse_rate_limited' |
 * 'art_browse_budget' }` for transport/breaker/budget failures, so the caller
 * can defer instead of caching a negative verdict (AGENTS.md §1).
 */
async function fetchBrowseAssets(appid, options = {}) {
  if (options.budget && !options.budget.take()) {
    const err = new Error('art browse budget exhausted');
    err.code = 'art_browse_budget';
    throw err;
  }
  const breaker =
    options.breaker ||
    createBreaker({
      now: options.now,
      cooldownMs: () => sources.breakerMs('steamBrowse'),
      read: () => gameCache.readBreaker(),
      write: (state) => gameCache.writeBreaker(state),
    });
  const open = breaker.entry(BROWSE_BREAKER_KEY);
  if (open) {
    const err = new Error(`IStoreBrowseService is resting until ${open.until}`);
    err.code = 'art_browse_rate_limited';
    throw err;
  }
  await browsePause(options);
  const input = encodeURIComponent(
    JSON.stringify({
      ids: [{ appid }],
      context: { language: 'english', country_code: 'US' },
      data_request: { include_assets: true },
    })
  );
  let payload;
  try {
    payload = await fetchJson(`${BROWSE_URL}?input_json=${input}`, {
      fetchImpl: options.fetch,
      timeoutMs:
        options.timeoutMs != null
          ? options.timeoutMs
          : sources.timeoutMs('steamBrowse'),
      userAgent: sources.userAgent('steamBrowse'),
      label: 'steam-browse',
      retries: options.retries != null ? options.retries : 1,
      sleep: options.sleep,
    });
  } catch (err) {
    const status = Number(err && err.status) || 0;
    if (status === 403 || status === 429 || (err && err.code === 'provider_rate_limited')) {
      breaker.trip(BROWSE_BREAKER_KEY, {
        reason: status === 429 ? '429 Too Many Requests' : 'HTTP 403',
        untilMs: sources.breakerMs('steamBrowse'),
      });
      const out = new Error('IStoreBrowseService is rate limited');
      out.code = 'art_browse_rate_limited';
      throw out;
    }
    if (status === 404) return null;
    const out = new Error('IStoreBrowseService is unreachable');
    out.code = 'art_browse_unreachable';
    out.cause = err;
    throw out;
  }
  const items = payload && payload.response && payload.response.store_items;
  const item = Array.isArray(items) ? items[0] : null;
  if (!item || !item.assets) return null;
  const assets = item.assets;
  const capsuleMatch =
    typeof assets.library_capsule === 'string' ? LIBRARY_CAPSULE_FILE_RE.exec(assets.library_capsule) : null;
  const libraryCapsule = capsuleMatch
    ? { hash: capsuleMatch[1], file: capsuleMatch[2] }
    : null;
  const iconHash =
    typeof assets.community_icon === 'string' && HASH_RE.test(assets.community_icon)
      ? assets.community_icon
      : null;
  const smallMatch =
    typeof assets.small_capsule === 'string'
      ? /^([A-Za-z0-9]{1,64})\/capsule_231x87\.jpg$/.exec(assets.small_capsule)
      : null;
  return {
    libraryCapsule,
    smallCapsuleHash: smallMatch ? smallMatch[1] : null,
    communityIconHash: iconHash,
  };
}

/**
 * Resolve the real vertical capsule of one appid **once** and cache the
 * answer in `cache-games/art/resolved/<appid>.json`.
 *
 * Order (each step stops on the first 200 image):
 *   a) `library_600x900.jpg` under the asset hash of `appdetails.header_image`
 *      / `capsule_image` (≤2 hashes) — the legacy filename in the new schema;
 *   b) legacy `/steam/apps/<appid>/library_600x900.jpg`;
 *   c) `IStoreBrowseService` → `assets.library_capsule` →
 *      `<hash>/library_capsule.jpg` (the file name post-2024 SKUs actually
 *      publish; live 03.11.2026 CONTROL Resonant 3669870: 200/56 KB);
 *   d) SteamGridDB, only when a key is configured (see `steamgriddb.js`);
 *   e) `none` — the client must not try the library chain again for this SKU.
 *
 * A network/5xx/429 failure on any step returns `{ kind: 'none',
 * deferred: true }` and writes nothing: the next enrich run retries.
 *
 * Options (all injectable for tests): `fetch`, `timeoutMs`, `now`, `sleep`,
 * `budget` (GetItems per-run counter), `sgdb` ({ key, budget, ... }),
 * `force`.
 */
async function resolveVerticalArt(rawAppid, info = {}) {
  const appid = Number(rawAppid);
  if (!Number.isSafeInteger(appid) || appid <= 0) {
    throw new Error(`resolveVerticalArt: invalid appid ${rawAppid}`);
  }
  const nowFn = typeof info.now === 'function' ? info.now : () => Number(info.now) || Date.now();
  const cached = readResolvedArt(appid);
  if (cached && !info.force && resolvedFresh(cached, nowFn())) {
    return { ...cached, cached: true };
  }

  const fetchOptions = { fetch: info.fetch, timeoutMs: info.timeoutMs };
  const hashes = [];
  for (const url of [info.headerImage, info.capsuleImage]) {
    const hash = assetHashFromUrl(url);
    if (hash && !hashes.includes(hash)) hashes.push(hash);
  }
  let reachable = false;
  let chosen = null;

  // (a) the legacy filename under a known asset hash
  for (const hash of hashes) {
    const probe = await probeArt('library', appid, hash, fetchOptions);
    if (probe.status > 0) reachable = true;
    if (probe.ok) {
      chosen = {
        kind: 'library-hashed',
        h: hash,
        file: 'library_600x900.jpg',
        proxyType: 'library',
        matchedBy: 'header-hash',
      };
      break;
    }
  }

  // (b) legacy hash-less path
  if (!chosen) {
    const probe = await probeArt('library', appid, null, fetchOptions);
    if (probe.status > 0) reachable = true;
    if (probe.ok) {
      chosen = {
        kind: 'library-legacy',
        h: null,
        file: 'library_600x900.jpg',
        proxyType: 'library',
        matchedBy: 'legacy',
      };
    }
  }

  // (c) the store-frontend asset map: the only source of the new-schema
  // `library_capsule.jpg` hash.
  let browse = null;
  let browseDeferred = false;
  if (!chosen) {
    try {
      browse = await fetchBrowseAssets(appid, info);
    } catch (err) {
      browseDeferred = true;
    }
    if (browse && browse.libraryCapsule) {
      const probe = await probeArt(
        'library_capsule',
        appid,
        browse.libraryCapsule.hash,
        fetchOptions
      );
      if (probe.status > 0) reachable = true;
      if (probe.ok) {
        chosen = {
          kind: 'library-hashed',
          h: browse.libraryCapsule.hash,
          file: 'library_capsule.jpg',
          proxyType: 'library_capsule',
          matchedBy: 'store-browse',
        };
      }
    }
  }

  // A deferred lookup (network/429/budget) is not a verdict.
  if (!chosen && (browseDeferred || (!reachable && !browse))) {
    return {
      schemaVersion: RESOLVED_SCHEMA_VERSION,
      appid,
      kind: 'none',
      deferred: true,
      resolvedAt: new Date(nowFn()).toISOString(),
      smallIconFallback: smallIconFallbackOf(appid, {
        capsule: assetHashFromUrl(info.capsuleImage),
      }, browse),
    };
  }

  // (d) SteamGridDB (optional, key-gated) for a genuinely missing capsule.
  let sgdb = null;
  if (!chosen && info.sgdb !== false) {
    try {
      const { resolveSteamGridDb } = require('./steamgriddb');
      sgdb = await resolveSteamGridDb(appid, {
        fetch: info.fetch,
        key: info.sgdbKey,
        budget: info.sgdbBudget,
        breaker: info.sgdbBreaker,
        timeoutMs: info.sgdbTimeoutMs,
        sleep: info.sleep,
        now: info.now,
      });
    } catch (err) {
      sgdb = { status: 'deferred' };
    }
    if (sgdb && sgdb.status === 'deferred') {
      return {
        schemaVersion: RESOLVED_SCHEMA_VERSION,
        appid,
        kind: 'none',
        deferred: true,
        resolvedAt: new Date(nowFn()).toISOString(),
        smallIconFallback: smallIconFallbackOf(appid, {
          capsule: assetHashFromUrl(info.capsuleImage),
        }, browse),
      };
    }
  }

  if (!chosen && sgdb && sgdb.status === 'found' && sgdb.url) {
    chosen = {
      kind: 'sgdb',
      h: null,
      file: null,
      proxyType: null,
      matchedBy: 'steamgriddb',
      url: sgdb.url,
    };
  }

  if (!chosen) {
    chosen = {
      kind: 'none',
      h: null,
      file: null,
      proxyType: null,
      matchedBy: sgdb && sgdb.status === 'skipped' ? 'sgdb_disabled' : 'not_found',
    };
  }

  const doc = {
    schemaVersion: RESOLVED_SCHEMA_VERSION,
    appid,
    kind: chosen.kind,
    h: chosen.h || null,
    file: chosen.file || null,
    proxyType: chosen.proxyType || null,
    url: chosen.url || null,
    matchedBy: chosen.matchedBy || null,
    source: chosen.kind === 'sgdb' ? 'steamgriddb' : 'steam-store',
    smallIconFallback: smallIconFallbackOf(
      appid,
      { capsule: assetHashFromUrl(info.capsuleImage) },
      browse
    ),
    resolvedAt: new Date(nowFn()).toISOString(),
  };
  try {
    await saveResolvedArt(doc);
  } catch (err) {
    // A read-only cache (worktree) must not break enrichment.
  }
  return doc;
}


function metaPath(key) {
  return path.join(ART_DIR, `${key}.json`);
}

function binPath(key) {
  return path.join(ART_DIR, `${key}.bin`);
}

function readMeta(key) {
  const hit = gameCache.readJsonWithFingerprint(metaPath(key));
  return (hit && hit.data) || null;
}

function readEntry(key, now = Date.now()) {
  const meta = readMeta(key);
  if (!meta || !meta.fetchedAt || !meta.contentType) return null;
  let buffer;
  try {
    buffer = fs.readFileSync(binPath(key));
  } catch (err) {
    return null;
  }
  const fetchedAt = Date.parse(meta.fetchedAt);
  const fresh = Number.isFinite(fetchedAt) && now - fetchedAt < TTL_MS;
  return {
    meta,
    buffer,
    fresh,
    contentType: meta.contentType,
    bytes: buffer.length,
  };
}

/** Delete the least recently used entries until both caps hold. */
function pruneArtCache(options = {}) {
  const maxFiles =
    Number.isFinite(Number(options.maxFiles)) && Number(options.maxFiles) >= 0
      ? Math.floor(Number(options.maxFiles))
      : MAX_ART_FILES;
  const maxBytes =
    Number.isFinite(Number(options.maxBytes)) && Number(options.maxBytes) >= 0
      ? Number(options.maxBytes)
      : MAX_ART_BYTES;
  let names;
  try {
    names = fs.readdirSync(ART_DIR);
  } catch (err) {
    return { removed: 0, files: 0, bytes: 0 };
  }
  const entries = [];
  let totalBytes = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const key = name.slice(0, -5);
    const metaFile = path.join(ART_DIR, name);
    const binFile = binPath(key);
    let stat;
    let binStat;
    try {
      stat = fs.statSync(metaFile);
      binStat = fs.statSync(binFile);
    } catch (err) {
      // A half-written pair is garbage: remove both halves.
      try {
        fs.rmSync(metaFile, { force: true });
        fs.rmSync(binFile, { force: true });
      } catch (rmErr) {
        /* best effort */
      }
      continue;
    }
    entries.push({ key, at: stat.mtimeMs, bytes: binStat.size });
    totalBytes += binStat.size;
  }
  entries.sort((a, b) => a.at - b.at);
  let removed = 0;
  let files = entries.length;
  while (entries.length && (files > maxFiles || totalBytes > maxBytes)) {
    const victim = entries.shift();
    try {
      fs.rmSync(metaPath(victim.key), { force: true });
      fs.rmSync(binPath(victim.key), { force: true });
    } catch (err) {
      /* best effort */
    }
    totalBytes -= victim.bytes;
    files -= 1;
    removed += 1;
  }
  return { removed, files, bytes: totalBytes };
}

function writeEntry(key, fetched) {
  fs.mkdirSync(ART_DIR, { recursive: true });
  gameCache.writeJsonAtomicSync(metaPath(key), {
    schemaVersion: 1,
    key,
    url: fetched.url,
    contentType: fetched.contentType,
    bytes: fetched.buffer.length,
    fetchedAt: new Date().toISOString(),
  });
  // A unique temp name: two concurrent misses for the same key must not
  // rename each other's file away.
  const tmp = `${binPath(key)}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, fetched.buffer);
  fs.renameSync(tmp, binPath(key));
}

/** Slide the LRU clock of a served entry (the meta mtime is the key order). */
function touchEntry(key) {
  try {
    const now = new Date();
    fs.utimesSync(metaPath(key), now, now);
  } catch (err) {
    /* a read-only cache must not break the relay */
  }
}

function contentTypeFor(url, headerValue) {
  const type = String(headerValue || '').split(';')[0].trim().toLowerCase();
  if (IMAGE_TYPES.has(type)) return type;
  // Some CDN edges omit the type; fall back to the extension of a known art
  // file. Anything else is rejected by the caller.
  if (/\.png$/i.test(String(url || ''))) return 'image/png';
  if (/\.(?:jpg|jpeg)$/i.test(String(url || ''))) return 'image/jpeg';
  return '';
}

/**
 * Ask the candidate hosts until one answers 200 with a usable body. A
 * 404/403/5xx/network error moves on; the last HTTP status is reported when
 * every host failed, so «not found» stays distinguishable from «unreachable».
 */
async function fetchUpstream(candidates, options = {}) {
  const fetchImpl = options.fetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  if (!fetchImpl) return { ok: false, status: 0, error: 'fetch_unavailable', tried: [] };
  const timeout = options.timeoutMs == null ? FETCH_TIMEOUT_MS : Number(options.timeoutMs);
  const tried = [];
  let lastStatus = 0;
  let lastError = null;
  for (const url of candidates) {
    if (!isAllowedArtUrl(url)) {
      lastStatus = 0;
      lastError = 'host_not_allowed';
      continue;
    }
    let response;
    try {
      response = await fetchBinary(url, {
        fetchImpl: options.fetch,
        headers: { Accept: 'image/avif,image/webp,image/jpeg,image/png,image/*' },
        // `0` = no deadline (shared convention); an unset option keeps the
        // 12 s default via `FETCH_TIMEOUT_MS`.
        timeoutMs: timeout,
        // Cap 404/403/HTML bodies while streaming instead of buffering them
        // whole and rejecting after the fact.
        maxBytes: MAX_ART_ENTRY_BYTES,
        label: 'steam-art',
      });
    } catch (err) {
      tried.push({ url, status: 0, error: (err && err.name) || 'network_error' });
      lastError = (err && err.name) || 'network_error';
      continue;
    }
    const status = Number(response && response.status) || 0;
    tried.push({ url, status });
    if (status === 200) {
      const buffer = Buffer.from(response.buffer || Buffer.alloc(0));
      if (!buffer.length || buffer.length > MAX_ART_ENTRY_BYTES) {
        lastError = buffer.length ? 'too_large' : 'empty_body';
        continue;
      }
      const headerType =
        response.headers && typeof response.headers.get === 'function'
          ? response.headers.get('content-type')
          : '';
      const contentType = contentTypeFor(url, headerType);
      // A CDN error page can be HTML with status 200; never cache/relay it as
      // an image.
      if (!contentType) {
        lastError = 'not_an_image';
        continue;
      }
      return { ok: true, url, buffer, contentType, status, tried };
    }
    lastStatus = status;
  }
  return {
    ok: false,
    status: lastStatus,
    error: lastError,
    tried,
  };
}

function parseRequest(req) {
  const type = String((req.params && req.params.type) || '').trim();
  if (!TYPES.has(type)) {
    throw new HttpError(
      400,
      `Path parameter "type" must be one of: ${[...TYPES].join(', ')}.`,
      'invalid_art_type'
    );
  }
  const appidRaw = String((req.params && req.params.appid) || '').trim();
  if (!APPID_RE.test(appidRaw)) {
    throw new HttpError(
      400,
      'Path parameter "appid" must be a positive integer.',
      'invalid_appid'
    );
  }
  const appid = Number(appidRaw);
  if (!Number.isSafeInteger(appid) || appid <= 0) {
    throw new HttpError(
      400,
      'Path parameter "appid" must be a positive integer.',
      'invalid_appid'
    );
  }
  const hashRaw = req.query && req.query.h != null ? String(req.query.h).trim() : '';
  if (hashRaw && !HASH_RE.test(hashRaw)) {
    throw new HttpError(
      400,
      'Query parameter "h" must be 1-64 characters of [A-Za-z0-9].',
      'invalid_art_hash'
    );
  }
  if (type === 'icon' && !hashRaw) {
    throw new HttpError(
      400,
      'Art type "icon" requires the community icon hash: ?h=<hash>.',
      'art_hash_required'
    );
  }
  return { type, appid, hash: hashRaw || null };
}

function sendEntry(res, entry, cacheState) {
  res.status(200);
  res.set('Content-Type', entry.contentType);
  res.set('Content-Length', String(entry.buffer.length));
  res.set('Cache-Control', CACHE_CONTROL);
  res.set('X-Steam-Art-Cache', cacheState);
  res.send(entry.buffer);
}

/**
 * Express handler factory. `options.fetch` is injectable for tests (no live
 * request); `options.maxFiles`/`maxBytes`/`timeoutMs` tune the cache/transport.
 */
function createSteamArtHandler(options = {}) {
  return async function steamArtHandler(req, res, next) {
    try {
      const { type, appid, hash } = parseRequest(req);
      const key = artCacheKey(type, appid, hash);
      const cached = readEntry(key);
      if (cached && cached.fresh) {
        touchEntry(key);
        sendEntry(res, cached, 'hit');
        return;
      }
      const candidates = upstreamCandidates(type, appid, hash);
      if (!candidates.length) {
        throw new HttpError(400, 'Unsupported art request.', 'invalid_art_type');
      }
      const fetched = await fetchUpstream(candidates, {
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
      });
      if (fetched.ok) {
        try {
          writeEntry(key, fetched);
          pruneArtCache({ maxFiles: options.maxFiles, maxBytes: options.maxBytes });
        } catch (err) {
          // A read-only cache must not break the relay.
        }
        sendEntry(res, fetched, 'miss');
        return;
      }
      // A stale copy is still the right artwork: serve it instead of a 502.
      if (cached && cached.buffer.length) {
        sendEntry(res, cached, 'stale');
        return;
      }
      if (fetched.status === 404 || fetched.status === 410) {
        throw new HttpError(
          404,
          `Steam has no ${type} art for app ${appid}${hash ? ` (hash ${hash})` : ''}.`,
          'steam_art_not_found'
        );
      }
      throw new HttpError(
        502,
        `Steam art CDN did not answer for app ${appid} (${fetched.error || 'unreachable'}).`,
        'steam_art_unreachable'
      );
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  ART_DIR,
  RESOLVED_DIR,
  TTL_MS,
  RESOLVED_TTL_MS,
  RESOLVED_NONE_TTL_MS,
  RESOLVED_SCHEMA_VERSION,
  ART_PATH,
  MAX_ART_FILES,
  MAX_ART_BYTES,
  MAX_ART_ENTRY_BYTES,
  CACHE_CONTROL,
  TYPES,
  FILE_BY_TYPE,
  UPSTREAM_HOSTS,
  APPID_RE,
  HASH_RE,
  artCacheKey,
  upstreamCandidates,
  resolverCandidates,
  isAllowedArtUrl,
  assetHashFromUrl,
  readEntry,
  writeEntry,
  pruneArtCache,
  fetchUpstream,
  parseRequest,
  createSteamArtHandler,
  // vertical-art resolve
  readResolvedArt,
  listResolvedArt,
  saveResolvedArt,
  resolvedFresh,
  artProxyUrlFor,
  fetchBrowseAssets,
  resolveVerticalArt,
};
