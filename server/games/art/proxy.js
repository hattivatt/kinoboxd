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
 * The upstream URL is **built here**, never passed in by the client, so the
 * route cannot be used as an open proxy. Only the hostnames in
 * `UPSTREAM_HOSTS` are ever requested; `appid` must be digits, `h` is
 * `[A-Za-z0-9]{1,64}` and an unknown query parameter is a 400. The route is
 * mounted under the global `/api` auth gate (`server/index.js`), exactly like
 * every other `/api/games/*` endpoint.
 *
 * Fallback: a 404/403/5xx/network failure on one host moves to the next one
 * in `upstreamCandidates()`. A 200 is relayed with its own content type and
 * `Cache-Control: public, max-age=604800` (7 days). Responses are cached on
 * disk in `cache-games/art/` by `./store`; the disk cache only saves the
 * upstream round-trip, the browser re-validates through the same proxy.
 *
 * Politeness: at most one upstream request per missing entry (plus a fallback
 * host only when the previous one failed). No cookies, no token, no
 * `Referer`; the Steam CDN endpoints are public and anonymous.
 */

const { fetchBinary } = require('../../core/http');
const { HttpError } = require('../../upload');

const {
  TYPES,
  FILE_BY_TYPE,
  APPID_RE,
  HASH_RE,
  MAX_ART_ENTRY_BYTES,
  artCacheKey,
  readEntry,
  writeEntry,
  pruneArtCache,
  touchEntry,
} = require('./store');

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
  CACHE_CONTROL,
  UPSTREAM_HOSTS,
  APPID_RE,
  HASH_RE,
  upstreamCandidates,
  isAllowedArtUrl,
  fetchUpstream,
  parseRequest,
  createSteamArtHandler,
};
