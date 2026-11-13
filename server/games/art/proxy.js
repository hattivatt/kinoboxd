'use strict';

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
const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
]);

const UPSTREAM_HOSTS = [
  'cdn.cloudflare.steamstatic.com',
  'cdn.akamai.steamstatic.com',
  'shared.cloudflare.steamstatic.com',
  'shared.akamai.steamstatic.com',
  'cdn.cloudflare.steampowered.com',
  'media.steampowered.com',
];

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
  if (/\.png$/i.test(String(url || ''))) return 'image/png';
  if (/\.(?:jpg|jpeg)$/i.test(String(url || ''))) return 'image/jpeg';
  return '';
}

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
        timeoutMs: timeout,
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
        }
        sendEntry(res, fetched, 'miss');
        return;
      }
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
