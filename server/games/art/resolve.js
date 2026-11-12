'use strict';

/**
 * Vertical-art resolve: one verdict per appid, cached in
 * `cache-games/art/resolved/<appid>.json` by `./store`.
 *
 * The probe ladder lives here (`resolverCandidates`, `probeArt`) because only
 * the resolver needs the compact two-host list; the proxy keeps the full host
 * list for the browser path. `assetHashFromUrl` is the gate that turns an
 * `appdetails` asset URL into a hash, and it refuses anything off the
 * allowlist.
 */

const { fetchUpstream, isAllowedArtUrl } = require('./proxy');
const { fetchBrowseAssets, smallIconFallbackOf } = require('./browse');
const {
  TYPES,
  FILE_BY_TYPE,
  RESOLVED_SCHEMA_VERSION,
  readResolvedArt,
  saveResolvedArt,
  resolvedFresh,
} = require('./store');

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

/**
 * Compact probe list for the resolver (the proxy keeps the full host list for
 * the browser path). Two hosts per schema are enough to tell «exists» from
 * «404», and a resolver pass over 340 games must not spend five requests on
 * each missing file. `options.single` keeps only the primary host, for the
 * new-schema `library_600x900.jpg` probe where a second host would repeat the
 * same answer (both CDN edges share the asset store).
 */
function resolverCandidates(type, appid, hash, options = {}) {
  if (!TYPES.has(type)) return [];
  const file = FILE_BY_TYPE[type];
  const urls = hash
    ? [
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/${hash}/${file}`,
        `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/${hash}/${file}`,
      ]
    : [
        `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/${file}`,
        `https://shared.akamai.steamstatic.com/steam/apps/${appid}/${file}`,
      ];
  return options.single ? urls.slice(0, 1) : urls;
}

/** Probe one candidate list. Returns the upstream result (never throws). */
async function probeArt(type, appid, hash, options = {}) {
  return fetchUpstream(resolverCandidates(type, appid, hash, { single: options.single }), options);
}

/**
 * Resolve the real vertical capsule of one appid **once** and cache the
 * answer in `cache-games/art/resolved/<appid>.json`.
 *
 * Order depends on the schema of `appdetails.header_image` (each step stops on
 * the first 200 image):
 *
 *   new schema (`/store_item_assets/`, post-2024):
 *     a) one probe `library_600x900.jpg` under the header asset hash — some
 *        SKUs still publish the legacy file name there;
 *     b) **legacy hash-less path is skipped**: for this schema it is a
 *        guaranteed 404 (live 03.11.2026: 86 useless 404s per hour on fresh
 *        SKUs), so a 404 goes straight to `IStoreBrowseService`;
 *     c) `assets.library_capsule` → `<hash>/library_capsule.jpg` (the file
 *        post-2024 SKUs actually publish; CONTROL Resonant 3669870:
 *        200/56 KB);
 *
 *   legacy schema (no asset hash in the header URL):
 *     a) `library_600x900.jpg` under an explicit `capsule_image` hash, if any;
 *     b) legacy `/steam/apps/<appid>/library_600x900.jpg`;
 *     c) the same store-frontend fallback as above;
 *
 *   then, for both schemas:
 *     d) SteamGridDB, only when a key is configured (see `steamgriddb.js`);
 *     e) `none` — the client must not try the library chain again for this SKU.
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
  const headerHash = assetHashFromUrl(info.headerImage);
  const capsuleHash = assetHashFromUrl(info.capsuleImage);
  // A `store_item_assets` header URL means the new schema, where the legacy
  // hash-less path does not exist at all. Its one hashed probe is cheap; the
  // legacy chain after it is not (two guaranteed 404s per SKU).
  const newSchema = Boolean(headerHash);
  let reachable = false;
  let chosen = null;

  if (newSchema) {
    // (a) exactly one `library_600x900.jpg` probe under the header hash: the
    // file either sits in that asset preamble or it does not, and both CDN
    // edges answer from the same store. The second edge is only tried when the
    // first one failed at the transport level — a 404 is the store's answer,
    // not an edge hiccup.
    let probe = await probeArt('library', appid, headerHash, {
      ...fetchOptions,
      single: true,
    });
    if (!probe.ok && probe.status === 0) {
      const spare = resolverCandidates('library', appid, headerHash).slice(1);
      probe = await fetchUpstream(spare, fetchOptions);
    }
    if (probe.status > 0) reachable = true;
    if (probe.ok) {
      chosen = {
        kind: 'library-hashed',
        h: headerHash,
        file: 'library_600x900.jpg',
        proxyType: 'library',
        matchedBy: 'header-hash',
      };
    }
  } else {
    // (a') legacy schema: the header URL carries no asset hash, so only an
    // explicit `capsule_image` hash can match a hashed file.
    const hashes = [];
    for (const hash of [headerHash, capsuleHash]) {
      if (hash && !hashes.includes(hash)) hashes.push(hash);
    }
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
      const { resolveSteamGridDb } = require('../steamgriddb');
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

module.exports = {
  resolverCandidates,
  assetHashFromUrl,
  resolveVerticalArt,
};
