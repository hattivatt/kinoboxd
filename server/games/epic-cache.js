'use strict';

const fs = require('fs');
const path = require('path');

const gameCache = require('./game-cache');
const { envTtl } = require('../core/env');
const { round1 } = require('../core/stats');

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
          ? round1(Number(library.totalMinutes) / 60)
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

function epicAccountForOwner(ownerKey) {
  const wanted = String(ownerKey == null ? '' : ownerKey).trim();
  if (!wanted) return null;
  const entry = listEpicProfiles().find((profile) => profile.ownerKey === wanted);
  return entry ? entry.accountId : null;
}

function epicBindingForOwnerSync(ownerKey) {
  const wanted = String(ownerKey == null ? '' : ownerKey).trim();
  if (!wanted) return { state: 'no_owner', accountId: null, hasAccessToken: false };
  const bound = epicAccountForOwner(wanted);
  const summaries = () => {
    try {
      const store = require('./epic-token-store');
      return typeof store.listTokenSummariesSync === 'function'
        ? store.listTokenSummariesSync()
        : [];
    } catch (err) {
      return [];
    }
  };
  if (bound) {
    const token = summaries().find((entry) => entry.accountId === bound) || null;
    return {
      state: 'bound',
      accountId: bound,
      hasAccessToken: Boolean(token && token.hasAccessToken),
    };
  }
  const ownerOf = (entry) =>
    String((entry && (entry.ownerKey || entry.ownerProfile)) || '').trim();
  const docs = summaries();
  if (!docs.length) return { state: 'none', accountId: null, hasAccessToken: false };
  const mine = docs.filter((entry) => ownerOf(entry) === wanted);
  const foreign = docs.filter((entry) => ownerOf(entry) && ownerOf(entry) !== wanted);
  const unbound = docs.filter((entry) => !ownerOf(entry));
  const withToken = (state, entry, extra = {}) => ({
    state,
    accountId: entry ? String(entry.accountId) : null,
    hasAccessToken: Boolean(entry && entry.hasAccessToken),
    ...extra,
  });
  if (docs.length === 1) {
    const only = docs[0];
    if (!ownerOf(only)) return withToken('unbound', only);
    if (ownerOf(only) === wanted) return withToken('profile_missing', only);
    return withToken('owner_mismatch', null, { otherOwner: ownerOf(only) });
  }
  if (foreign.length) {
    return {
      state: 'owner_mismatch',
      accountId: null,
      hasAccessToken: false,
      otherOwner: ownerOf(foreign[0]) || null,
      accounts: docs.map((entry) => entry.accountId).slice(0, 5),
    };
  }
  if (mine.length === 1 && unbound.length === 0) {
    return withToken('profile_missing', mine[0]);
  }
  return {
    state: 'ambiguous',
    accountId: null,
    hasAccessToken: false,
    candidates: docs.map((entry) => entry.accountId).slice(0, 5),
  };
}

async function ensureEpicOwnerBinding(ownerKey, options = {}) {
  const wanted = String(ownerKey == null ? '' : ownerKey).trim();
  const state = epicBindingForOwnerSync(wanted);
  if (state.state !== 'unbound' && state.state !== 'profile_missing') return state;
  const accountId = state.accountId;
  if (!accountId) return state;
  const store = options.tokenStore || require('./epic-token-store');
  const nowIso = new Date().toISOString();
  if (state.state === 'unbound') {
    let doc = null;
    try {
      doc = typeof store.getTokens === 'function' ? await store.getTokens(accountId) : null;
    } catch (err) {
      doc = null;
    }
    if (!doc) return { ...state, state: 'unbound', adopted: false };
    try {
      await store.saveTokens({ ...doc, ownerKey: wanted });
    } catch (err) {
      return { ...state, state: 'unbound', adopted: false, code: 'bind_write_failed' };
    }
  }
  const profile = getEpicProfile(accountId);
  try {
    await saveEpicProfile({
      ...(profile || {}),
      accountId,
      ownerKey: wanted,
      connectedAt: (profile && profile.connectedAt) || nowIso,
      ownerBinding: {
        adoptedAt: nowIso,
        source: state.state === 'profile_missing' ? 'token' : 'self-heal',
      },
    });
  } catch (err) {
    return { ...state, state: 'unbound', adopted: false, code: 'profile_write_failed' };
  }
  return { ...state, state: 'bound', accountId, adopted: true };
}


async function markEpicDisconnected(accountId) {
  const profile = getEpicProfile(accountId);
  if (!profile) return null;
  return saveEpicProfile({
    ...profile,
    disconnectedAt: new Date().toISOString(),
  });
}

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

function slugOverridesPath() {
  return path.join(CATALOG_DIR, 'slug-overrides.json');
}

function readSlugOverrides() {
  const hit = gameCache.readJsonWithFingerprint(slugOverridesPath());
  const data = (hit && hit.data) || null;
  return data && data.slugs && typeof data.slugs === 'object' ? data.slugs : {};
}

function getEpicSlugOverride(catalogItemId) {
  const id = String(catalogItemId == null ? '' : catalogItemId);
  if (!id) return null;
  const entry = readSlugOverrides()[id];
  return entry && entry.slug ? String(entry.slug) : null;
}

function saveEpicSlugOverride(catalogItemId, slug, extra = {}) {
  const id = String(catalogItemId == null ? '' : catalogItemId);
  const value = String(slug == null ? '' : slug).trim();
  if (!id || !value) return null;
  const slugs = readSlugOverrides();
  const previous = slugs[id] || null;
  if (previous && previous.slug === value) return previous;
  const entry = {
    slug: value,
    title: extra.title || (previous && previous.title) || null,
    source: extra.source || 'cms-title-probe',
    at: new Date().toISOString(),
  };
  slugs[id] = entry;
  gameCache.writeJsonAtomicSync(slugOverridesPath(), {
    schemaVersion: 1,
    source: 'epic-slug-overrides',
    updatedAt: new Date().toISOString(),
    slugs,
  });
  return entry;
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
  epicBindingForOwnerSync,
  ensureEpicOwnerBinding,
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
  slugOverridesPath,
  readSlugOverrides,
  getEpicSlugOverride,
  saveEpicSlugOverride,
  epicLibraryTtlMs,
  epicPlaytimeTtlMs,
  epicCatalogTtlMs,
  productMappingTtlMs,
};
