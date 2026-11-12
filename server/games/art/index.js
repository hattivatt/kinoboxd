'use strict';

/**
 * Steam artwork package: the CDN proxy (`./proxy`), its disk cache and
 * per-appid verdicts (`./store`), the store-frontend asset client (`./browse`)
 * and the vertical-capsule resolver (`./resolve`).
 *
 * This barrel is the only entry point: the export set is exactly the one the
 * single-file module had, so callers see no seam.
 */

const {
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
  TYPES,
  FILE_BY_TYPE,
  APPID_RE,
  HASH_RE,
  artCacheKey,
  readEntry,
  writeEntry,
  pruneArtCache,
  readResolvedArt,
  listResolvedArt,
  saveResolvedArt,
  resolvedFresh,
  artProxyUrlFor,
} = require('./store');
const {
  CACHE_CONTROL,
  UPSTREAM_HOSTS,
  upstreamCandidates,
  isAllowedArtUrl,
  fetchUpstream,
  parseRequest,
  createSteamArtHandler,
} = require('./proxy');
const { fetchBrowseAssets } = require('./browse');
const { resolverCandidates, assetHashFromUrl, resolveVerticalArt } = require('./resolve');

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
