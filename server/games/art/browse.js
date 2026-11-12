'use strict';

/**
 * `IStoreBrowseService/GetItems` client: the public, keyless store-frontend API
 * that is the only place publishing the per-asset `library_capsule` hash.
 *
 * One request per appid (`include_assets`), English assets, behind the shared
 * source gate (`core/source-client`): a pause between requests, a breaker on
 * the host, and a per-run budget counter when the caller passes one. Transport
 * failures throw `art_browse_*` codes so the caller can defer instead of
 * caching a negative verdict; an honest «no such item» is `null`.
 */

const { fetchJson } = require('../../core/http');
const { createSourceGate } = require('../../core/source-client');
const sources = require('../../core/sources');

const gameCache = require('../game-cache');
const { ART_PATH, HASH_RE } = require('./store');

// `IStoreBrowseService/GetItems` is the public, keyless store-frontend API; it
// is the only place that publishes the per-asset `library_capsule` hash.
const BROWSE_HOST = 'api.steampowered.com';
const BROWSE_BREAKER_KEY = `${BROWSE_HOST}/IStoreBrowseService`;
const BROWSE_URL = `https://${BROWSE_HOST}/IStoreBrowseService/GetItems/v1/`;
const LIBRARY_CAPSULE_FILE_RE = /^([A-Za-z0-9]{1,64})\/(library_capsule(?:_2x)?|library_600x900(?:_2x)?)\.(?:jpg|jpeg|png)$/;

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
  const gate = createSourceGate({
    breaker: options.breaker,
    now: options.now,
    breakerMs: () => sources.breakerMs('steamBrowse'),
    breakerStore: {
      read: () => gameCache.readBreaker(),
      write: (state) => gameCache.writeBreaker(state),
    },
  });
  const open = gate.breakerFor(BROWSE_BREAKER_KEY);
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
      gate.tripBreaker(BROWSE_BREAKER_KEY, {
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

/** Small capsule URL used when the 32×32 community icon is missing or 404s. */
function smallIconFallbackOf(appid, hashes, browse) {
  const smallHash =
    (browse && browse.smallCapsuleHash) || hashes.capsule || null;
  return smallHash
    ? `${ART_PATH}/capsule/${appid}?h=${smallHash}`
    : `${ART_PATH}/capsule/${appid}`;
}

module.exports = {
  BROWSE_HOST,
  BROWSE_BREAKER_KEY,
  BROWSE_URL,
  LIBRARY_CAPSULE_FILE_RE,
  browsePause,
  fetchBrowseAssets,
  smallIconFallbackOf,
};
