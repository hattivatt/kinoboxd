'use strict';

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

function assetHashFromUrl(value) {
  if (!isAllowedArtUrl(value)) return null;
  const match = /\/store_item_assets\/steam\/apps\/\d+\/([A-Za-z0-9]{1,64})\//.exec(
    String(value)
  );
  return match ? match[1] : null;
}

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

async function probeArt(type, appid, hash, options = {}) {
  return fetchUpstream(resolverCandidates(type, appid, hash, { single: options.single }), options);
}

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
  const newSchema = Boolean(headerHash);
  let reachable = false;
  let chosen = null;

  if (newSchema) {
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
  }
  return doc;
}

module.exports = {
  resolverCandidates,
  assetHashFromUrl,
  resolveVerticalArt,
};
