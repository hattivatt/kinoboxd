'use strict';

/**
 * Epic cache (M6b) — `cache-games/` files owned by the Epic secondary library.
 *
 * The Steam cache module (`game-cache.js`) is deliberately untouched: GOG
 * (M6a) is developed in parallel and will add its own files to the same
 * namespace, so every Epic path lives here instead of extending the Steam
 * module. This keeps the two branches file-disjoint apart from one mount line
 * in `server/index.js` and one slot in the UI.
 *
 * Layout (ИГРЫ-АРХИТЕКТУРА §14.4):
 *
 *   profiles/epic-<accountId>.json      displayName/ownerKey/connectedAt
 *   library/epic-<accountId>.json       merged entitlements+library snapshot
 *   playtime/epic-<accountId>.json      artifactId → totalTime (seconds)
 *   catalog/<catalogItemId>.json        Epic catalog bulk metadata (global)
 *   catalog/productmapping.json         appName → slug (public fallback)
 *   tokens/epic-<accountId>.json        0600, handled by epic-token-store.js
 *
 * TTLs: library 24 h (like Steam), playtime 24 h, catalog 180 d,
 * productmapping 7 d. The library/playtime TTLs only gate *reuse*; a stale
 * snapshot is still served (with `status: 'stale'`) instead of pretending the
 * account has zero games (§14.4 rule 7).
 */

const fs = require('fs');
const path = require('path');

const gameCache = require('./game-cache');

const CACHE_DIR = gameCache.GAMES_CACHE_DIR;
const PROFILES_DIR = path.join(CACHE_DIR, 'profiles');
const LIBRARY_DIR = path.join(CACHE_DIR, 'library');
const PLAYTIME_DIR = path.join(CACHE_DIR, 'playtime');
const CATALOG_DIR = path.join(CACHE_DIR, 'catalog');
const PRODUCT_MAPPING_PATH = path.join(CATALOG_DIR, 'productmapping.json');

const LIBRARY_TTL_MS = 24 * 60 * 60 * 1000;
const PLAYTIME_TTL_MS = 24 * 60 * 60 * 1000;
const CATALOG_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const PRODUCT_MAPPING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

for (const dir of [PROFILES_DIR, LIBRARY_DIR, PLAYTIME_DIR, CATALOG_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const EPIC_ACCOUNT_RE = /^[A-Za-z0-9._-]{1,80}$/;

function assertAccountId(accountId) {
  const value = String(accountId == null ? '' : accountId).trim();
  if (!EPIC_ACCOUNT_RE.test(value) || value === '.' || value === '..') {
    throw Object.assign(new Error('Некорректный Epic accountId.'), {
      code: 'epic_invalid_account',
      status: 400,
    });
  }
  return value;
}

function epicProfileKeyOf(accountId) {
  return `epic-${assertAccountId(accountId)}`;
}

/**
 * `epic-<accountId>` token parser. Deliberately separate from
 * `gameCache.parseProfileToken` (steam-only): a games stats request must never
 * accept an Epic token as its owner profile.
 */
function parseEpicProfileToken(token) {
  const value = String(token == null ? '' : token).trim();
  const match = /^epic-([A-Za-z0-9._-]{1,80})$/i.exec(value);
  if (!match) return null;
  return { source: 'epic', accountId: match[1], key: epicProfileKeyOf(match[1]) };
}

function profilePath(accountId) {
  return path.join(PROFILES_DIR, `epic-${gameCache.safeKey(assertAccountId(accountId))}.json`);
}

function libraryPath(accountId) {
  return path.join(LIBRARY_DIR, `epic-${gameCache.safeKey(assertAccountId(accountId))}.json`);
}

function playtimePath(accountId) {
  return path.join(PLAYTIME_DIR, `epic-${gameCache.safeKey(assertAccountId(accountId))}.json`);
}

function catalogPath(catalogItemId) {
  return path.join(CATALOG_DIR, `${gameCache.safeKey(catalogItemId)}.json`);
}

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

async function saveEpicProfile(profile) {
  const accountId = assertAccountId(profile && profile.accountId);
  const doc = {
    schemaVersion: 1,
    source: 'epic',
    ...profile,
    accountId,
    key: epicProfileKeyOf(accountId),
  };
  const fingerprint = await gameCache.writeJsonAtomic(profilePath(accountId), doc);
  return { data: doc, fingerprint };
}

function getEpicProfile(accountId) {
  const hit = gameCache.readJsonWithFingerprint(profilePath(accountId));
  return hit ? hit.data : null;
}

/** All Epic profiles, newest connection/import first. */
function listEpicProfiles() {
  let names = [];
  try {
    names = fs.readdirSync(PROFILES_DIR).filter((name) => /^epic-.+\.json$/.test(name));
  } catch (err) {
    return [];
  }
  const result = [];
  for (const name of names) {
    const hit = gameCache.readJsonWithFingerprint(path.join(PROFILES_DIR, name));
    if (!hit || !hit.data || !hit.data.accountId) continue;
    const library = getEpicLibrary(hit.data.accountId);
    result.push({
      source: 'epic',
      accountId: hit.data.accountId,
      key: epicProfileKeyOf(hit.data.accountId),
      displayName: hit.data.displayName || null,
      label: hit.data.label || null,
      ownerKey: hit.data.ownerKey || null,
      connectedAt: hit.data.connectedAt || null,
      disconnectedAt: hit.data.disconnectedAt || null,
      importedAt: hit.data.importedAt || null,
      libraryPartial: Boolean(library && library.partial),
      gameCount: library ? library.gameCount : null,
      totalHours:
        library && Number.isFinite(Number(library.totalMinutes))
          ? Math.round((Number(library.totalMinutes) / 60) * 10) / 10
          : null,
      libraryFetchedAt: library ? library.fetchedAt || null : null,
      fingerprint: hit.fingerprint,
    });
  }
  result.sort((a, b) =>
    String(b.importedAt || b.connectedAt || '').localeCompare(
      String(a.importedAt || a.connectedAt || '')
    )
  );
  return result;
}

/** Same-owner libraries (`libraries[]` of the owner profile, §14.4). */
function librariesForOwner(ownerKey) {
  const wanted = String(ownerKey == null ? '' : ownerKey).trim();
  if (!wanted) return [];
  return listEpicProfiles()
    .filter((entry) => entry.ownerKey === wanted)
    .map((entry) => ({
      source: 'epic',
      userKey: entry.accountId,
      role: 'library',
      connectedAt: entry.connectedAt || null,
      displayName: entry.displayName || null,
      label: entry.label || null,
      gameCount: entry.gameCount,
      totalHours: entry.totalHours,
      libraryFetchedAt: entry.libraryFetchedAt || null,
    }));
}

/**
 * The first Epic account bound to an owner. The games model is one owner →
 * one Epic library (§14.4 rule 1); a second account is refused by the auth
 * layer with `owner_mismatch` instead of silently summing libraries.
 */
function epicAccountForOwner(ownerKey) {
  const wanted = String(ownerKey == null ? '' : ownerKey).trim();
  if (!wanted) return null;
  const entry = listEpicProfiles().find((profile) => profile.ownerKey === wanted);
  return entry ? entry.accountId : null;
}

async function markEpicDisconnected(accountId) {
  const profile = getEpicProfile(accountId);
  if (!profile) return null;
  return saveEpicProfile({
    ...profile,
    disconnectedAt: new Date().toISOString(),
  });
}

/* ------------------------------------------------------------------ */
/* Library                                                             */
/* ------------------------------------------------------------------ */

async function saveEpicLibrary(accountId, library) {
  const id = assertAccountId(accountId);
  const doc = {
    schemaVersion: 1,
    source: 'epic',
    accountId: id,
    ...library,
  };
  const fingerprint = await gameCache.writeJsonAtomic(libraryPath(id), doc);
  return { data: doc, fingerprint };
}

function getEpicLibrary(accountId) {
  const hit = gameCache.readJsonWithFingerprint(libraryPath(accountId));
  return hit ? hit.data : null;
}

function listEpicLibraries() {
  let names = [];
  try {
    names = fs.readdirSync(LIBRARY_DIR).filter((name) => /^epic-.+\.json$/.test(name));
  } catch (err) {
    return [];
  }
  const result = [];
  for (const name of names) {
    const hit = gameCache.readJsonWithFingerprint(path.join(LIBRARY_DIR, name));
    if (hit && hit.data && hit.data.accountId) result.push(hit.data);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Playtime                                                            */
/* ------------------------------------------------------------------ */

async function saveEpicPlaytime(accountId, playtime) {
  const id = assertAccountId(accountId);
  const doc = {
    schemaVersion: 1,
    source: 'epic',
    accountId: id,
    ...playtime,
  };
  const fingerprint = await gameCache.writeJsonAtomic(playtimePath(id), doc);
  return { data: doc, fingerprint };
}

function getEpicPlaytime(accountId) {
  const hit = gameCache.readJsonWithFingerprint(playtimePath(accountId));
  return hit ? hit.data : null;
}

/* ------------------------------------------------------------------ */
/* Catalog metadata (global, not per owner)                            */
/* ------------------------------------------------------------------ */

async function saveEpicCatalogItem(catalogItemId, doc) {
  const key = gameCache.safeKey(catalogItemId);
  if (!key) {
    throw Object.assign(new Error('catalogItemId is required for catalog metadata.'), {
      code: 'epic_invalid_catalog_item',
      status: 400,
    });
  }
  const payload = {
    schemaVersion: 1,
    source: 'epic-catalog',
    ...doc,
    catalogItemId: String(catalogItemId),
  };
  const fingerprint = await gameCache.writeJsonAtomic(catalogPath(catalogItemId), payload);
  return { data: payload, fingerprint };
}

function getEpicCatalogItem(catalogItemId) {
  const hit = gameCache.readJsonWithFingerprint(catalogPath(catalogItemId));
  return hit ? hit.data : null;
}

/** `{ [catalogItemId]: doc }`; missing/corrupt files are simply absent. */
function listEpicCatalogItems(ids) {
  const result = {};
  if (!Array.isArray(ids)) return result;
  for (const id of ids) {
    if (id == null) continue;
    const key = String(id);
    if (result[key]) continue;
    const doc = getEpicCatalogItem(key);
    if (doc) result[key] = doc;
  }
  return result;
}

async function saveProductMapping(doc) {
  const payload = {
    schemaVersion: 1,
    source: 'epic-productmapping',
    ...doc,
    fetchedAt: doc && doc.fetchedAt ? doc.fetchedAt : new Date().toISOString(),
  };
  const fingerprint = await gameCache.writeJsonAtomic(PRODUCT_MAPPING_PATH, payload);
  return { data: payload, fingerprint };
}

function getProductMapping() {
  const hit = gameCache.readJsonWithFingerprint(PRODUCT_MAPPING_PATH);
  return hit ? hit.data : null;
}

/* ------------------------------------------------------------------ */
/* TTLs                                                                */
/* ------------------------------------------------------------------ */

function envTtl(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function epicLibraryTtlMs() {
  return envTtl('GAMES_EPIC_LIBRARY_TTL_MS', LIBRARY_TTL_MS);
}

function epicPlaytimeTtlMs() {
  return envTtl('GAMES_EPIC_PLAYTIME_TTL_MS', PLAYTIME_TTL_MS);
}

function epicCatalogTtlMs() {
  return envTtl('GAMES_EPIC_CATALOG_TTL_MS', CATALOG_TTL_MS);
}

function productMappingTtlMs() {
  return envTtl('GAMES_EPIC_PRODUCTMAPPING_TTL_MS', PRODUCT_MAPPING_TTL_MS);
}

module.exports = {
  CACHE_DIR,
  PROFILES_DIR,
  LIBRARY_DIR,
  PLAYTIME_DIR,
  CATALOG_DIR,
  PRODUCT_MAPPING_PATH,
  LIBRARY_TTL_MS,
  PLAYTIME_TTL_MS,
  CATALOG_TTL_MS,
  PRODUCT_MAPPING_TTL_MS,
  epicProfileKeyOf,
  parseEpicProfileToken,
  profilePath,
  libraryPath,
  playtimePath,
  catalogPath,
  saveEpicProfile,
  getEpicProfile,
  listEpicProfiles,
  librariesForOwner,
  epicAccountForOwner,
  markEpicDisconnected,
  saveEpicLibrary,
  getEpicLibrary,
  listEpicLibraries,
  saveEpicPlaytime,
  getEpicPlaytime,
  saveEpicCatalogItem,
  getEpicCatalogItem,
  listEpicCatalogItems,
  saveProductMapping,
  getProductMapping,
  epicLibraryTtlMs,
  epicPlaytimeTtlMs,
  epicCatalogTtlMs,
  productMappingTtlMs,
};
