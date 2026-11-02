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
 *     type  header | capsule | library | small_capsule | icon
 *     h     community icon hash (`icon`), or the `store_item_assets` asset
 *           hash for the newer `shared.akamai.steamstatic.com` schema
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
const { HttpError } = require('../upload');

const ART_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'art');

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

const TYPES = new Set(['header', 'capsule', 'library', 'small_capsule', 'icon']);
const FILE_BY_TYPE = {
  header: 'header.jpg',
  capsule: 'capsule_231x87.jpg',
  library: 'library_600x900.jpg',
  small_capsule: 'capsule_231x87.jpg',
};

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

function safeKey(value) {
  return String(value == null ? '' : value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

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

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

/**
 * Ask the candidate hosts until one answers 200 with a usable body. A
 * 404/403/5xx/network error moves on; the last HTTP status is reported when
 * every host failed, so «not found» stays distinguishable from «unreachable».
 */
async function fetchUpstream(candidates, options = {}) {
  const fetchImpl = options.fetch || (typeof fetch === 'function' ? fetch : null);
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
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { Accept: 'image/avif,image/webp,image/jpeg,image/png,image/*' },
        signal: timeout > 0 ? timeoutSignal(timeout) : undefined,
      });
    } catch (err) {
      tried.push({ url, status: 0, error: (err && err.name) || 'network_error' });
      lastError = (err && err.name) || 'network_error';
      continue;
    }
    const status = Number(response && response.status) || 0;
    tried.push({ url, status });
    if (status === 200) {
      let buffer;
      try {
        buffer = Buffer.from(await response.arrayBuffer());
      } catch (err) {
        lastError = 'body_read_error';
        continue;
      }
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
  TTL_MS,
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
  isAllowedArtUrl,
  readEntry,
  writeEntry,
  pruneArtCache,
  fetchUpstream,
  parseRequest,
  createSteamArtHandler,
};
