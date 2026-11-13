'use strict';

const gameCache = require('../game-cache');
const epicCache = require('../epic-cache');
const tokenStore = require('../epic-token-store');
const epic = require('../epic');
const { round1 } = require('../../core/stats');

const CONTRACT_VERSION = 1;

function minutesToHours(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value)) return null;
  return round1(value / 60);
}

function steamSide(ownerKey) {
  const match = /^steam-(\d{17})$/.exec(String(ownerKey == null ? '' : ownerKey).trim());
  if (!match) return { hours: null, owned: null };
  const library = gameCache.getLibrary(match[1]);
  if (!library) return { hours: null, owned: null };
  const hours = Number.isFinite(Number(library.totalMinutes))
    ? minutesToHours(library.totalMinutes)
    : null;
  const owned = Number.isFinite(Number(library.game_count))
    ? Number(library.game_count)
    : Array.isArray(library.games)
      ? library.games.length
      : null;
  return { hours, owned };
}

function tokenStatus(token, profile) {
  if (!token) return 'not_connected';
  if (profile && profile.disconnectedAt) return 'not_connected';
  if (token.lastAuthError) return 'auth_expired';
  return 'connected';
}

function libraryStatus(tokenStatusValue, library) {
  if (tokenStatusValue === 'not_connected' || tokenStatusValue === 'auth_expired') {
    return tokenStatusValue;
  }
  if (!library) return 'not_imported';
  return gameCache.isFresh(library, epicCache.epicLibraryTtlMs()) ? 'ok' : 'stale';
}

function joinGames(library, playtime, catalog) {
  const games = Array.isArray(library && library.games) ? library.games : [];
  let slugOverrides = {};
  try {
    slugOverrides = epicCache.readSlugOverrides();
  } catch (err) {
    slugOverrides = {};
  }
  let productMapping = {};
  try {
    const mapping = epicCache.getProductMapping();
    productMapping = mapping && mapping.byAppName ? mapping.byAppName : {};
  } catch (err) {
    productMapping = {};
  }
  return games.map((game) => {
    const meta = (game.catalogItemId && catalog[game.catalogItemId]) || null;
    const tracked = epic.playtimeForGame(game, playtime);
    const name =
      (meta && meta.title) || game.name || game.appName || game.entitlementName || null;
    const mappedSlug =
      (game.appName && productMapping[game.appName]) ||
      (game.namespace && productMapping[game.namespace]) ||
      null;
    const discovered =
      game.catalogItemId && slugOverrides[game.catalogItemId]
        ? slugOverrides[game.catalogItemId].slug || null
        : null;
    return {
      source: 'epic',
      appName: game.appName || null,
      catalogItemId: game.catalogItemId || null,
      namespace: game.namespace || null,
      productId: game.productId || null,
      sandboxType: game.sandboxType || null,
      platforms: Array.isArray(game.platforms) ? game.platforms : [],
      acquisitionDate: game.acquisitionDate || null,
      entitlementName: game.entitlementName || null,
      entitlementType: game.entitlementType || null,
      sources: Array.isArray(game.sources) ? game.sources : [],
      name,
      title: meta ? meta.title || null : null,
      slug: (meta && meta.slug) || game.slug || mappedSlug || discovered || null,
      developer: meta ? meta.developer || null : null,
      publisher: meta ? meta.publisher || null : null,
      releaseDate: meta ? meta.releaseDate || null : null,
      metadataSource: meta
        ? 'epic-catalog'
        : game.slug || mappedSlug
          ? 'epic-productmapping'
          : discovered
            ? 'epic-slug-probe'
            : null,
      totalTimeSec: tracked ? tracked.totalTimeSec : null,
      totalMinutes: tracked ? tracked.totalMinutes : null,
      hours: tracked ? epic.secondsToHours(tracked.totalTimeSec) : null,
      playtimeKnown: Boolean(tracked),
      lastPlayed: null,
    };
  });
}

function toExportedGame(game, accountId, ownerKey) {
  return {
    source: 'epic',
    accountId,
    owner: ownerKey || null,
    appName: game.appName || null,
    catalogItemId: game.catalogItemId || null,
    namespace: game.namespace || null,
    slug: game.slug || null,
    name: game.name || null,
    developer: game.developer || null,
    publisher: game.publisher || null,
    totalTimeSec: game.totalTimeSec,
    totalMinutes: game.totalMinutes,
    hours: game.hours,
    platforms: game.platforms,
    workKey: null,
    steamAppId: null,
  };
}

async function buildEpicLayer(options = {}) {
  const { ownerKey, accountId } = resolveOwner(options);
  const steam = steamSide(ownerKey);
  const libraries = ownerKey ? epicCache.librariesForOwner(ownerKey) : [];
  if (!accountId) return emptyLayer(ownerKey, libraries, steam);
  const token = tokenStore.readTokenSummarySync(accountId);
  return composeLayer({ ownerKey, accountId, token, steam, libraries });
}

function buildEpicLayerSync(options = {}) {
  const { ownerKey, accountId } = resolveOwner(options);
  const steam = steamSide(ownerKey);
  const libraries = ownerKey ? epicCache.librariesForOwner(ownerKey) : [];
  if (!accountId) {
    const { exportedGames, ...rest } = emptyLayer(ownerKey, libraries, steam);
    return rest;
  }
  const token = tokenStore.readTokenSummarySync(accountId);
  const { exportedGames, ...rest } = composeLayer({ ownerKey, accountId, token, steam, libraries });
  return rest;
}

function epicSourceBlock(layer) {
  if (!layer) {
    return {
      configured: false,
      connected: false,
      status: 'not_connected',
      accountId: null,
      displayName: null,
      ownerProfile: null,
      lastImportAt: null,
      libraryFetchedAt: null,
      playtimeFetchedAt: null,
      productCount: null,
      hours: null,
      stale: false,
    };
  }
  const status = layer.status || 'not_connected';
  return {
    configured: status !== 'not_connected',
    connected: status !== 'not_connected' && status !== 'auth_expired',
    status,
    accountId: layer.accountId || null,
    displayName: (layer.account && layer.account.displayName) || null,
    ownerProfile: layer.owner || null,
    lastImportAt: (layer.meta && layer.meta.fetchedAt) || null,
    libraryFetchedAt: (layer.meta && layer.meta.fetchedAt) || null,
    playtimeFetchedAt: (layer.meta && layer.meta.playtimeFetchedAt) || null,
    productCount: layer.summary ? layer.summary.ownedCount : null,
    hours: layer.summary ? layer.summary.hours : null,
    stale: status === 'stale' || status === 'auth_expired' || status === 'not_imported',
  };
}

function epicSecondaryWorks(layer, { limit = 200 } = {}) {
  const games = Array.isArray(layer && layer.games) ? layer.games : [];
  return games
    .filter((game) => game && game.name)
    .slice(0, limit)
    .map((game) => ({
      workKey: null,
      source: 'epic',
      name: game.name,
      sources: ['epic'],
      ownedOn: ['epic'],
      storeIds: { steam: null, gog: null, epic: game.catalogItemId || null },
      hoursBySource: {
        steam: null,
        gog: null,
        epic: game.totalMinutes == null ? null : game.totalMinutes,
      },
      primaryAppid: null,
      gog: null,
      epic: {
        accountId: (layer && layer.accountId) || null,
        appName: game.appName || null,
        catalogItemId: game.catalogItemId || null,
        slug: game.slug || null,
        namespace: game.namespace || null,
        platforms: game.platforms || [],
        image: null,
      },
      matchedBy: 'none',
      confidence: 'single',
    }));
}

function resolveOwner(options = {}) {
  const ownerKey = options.ownerKey ? String(options.ownerKey).trim() : null;
  let accountId = options.accountId ? String(options.accountId).trim() : null;
  if (!accountId && ownerKey) accountId = epicCache.epicAccountForOwner(ownerKey);
  return { ownerKey, accountId };
}

function emptyLayer(ownerKey, libraries, steam) {
  return {
    source: 'epic',
    contractVersion: CONTRACT_VERSION,
    owner: ownerKey,
    accountId: null,
    status: 'not_connected',
    account: null,
    libraries,
    summary: null,
    hoursBySource: { steam: steam.hours, epic: null },
    ownedBySource: { steam: steam.owned, epic: null },
    games: [],
    exportedGames: [],
    meta: {
      note:
        'Epic не подключён: часы Epic отсутствуют (null), а не 0. ' +
        'Steam-журнал не меняется.',
    },
  };
}

function composeLayer({ ownerKey, accountId, token, steam, libraries }) {
  const profile = epicCache.getEpicProfile(accountId);
  const library = epicCache.getEpicLibrary(accountId);
  const playtime = epicCache.getEpicPlaytime(accountId);
  const tokenState = tokenStatus(token, profile);
  const status = libraryStatus(tokenState, library);

  if (ownerKey && profile && profile.ownerKey && profile.ownerKey !== ownerKey) {
    throw Object.assign(
      new Error(
        `Epic-аккаунт ${accountId} привязан к другому владельцу (${profile.ownerKey}); ` +
          'библиотеки двух людей не сливаются (§14.4).'
      ),
      { code: 'owner_mismatch', status: 400 }
    );
  }

  const catalogIds = library
    ? (library.games || []).map((game) => game.catalogItemId).filter(Boolean)
    : [];
  const catalog = epicCache.listEpicCatalogItems(catalogIds);
  const games = library ? joinGames(library, playtime, catalog) : [];
  const knownPlaytime = games.filter((game) => game.playtimeKnown);
  const matchedSeconds = knownPlaytime.reduce(
    (sum, game) => sum + (Number(game.totalTimeSec) || 0),
    0
  );
  const hours = playtime ? epic.secondsToHours(playtime.totalSeconds) : null;
  const ownedCount = library ? games.length : null;
  const playedCount = knownPlaytime.filter((game) => game.totalMinutes > 0).length;
  const withMetadata = games.filter((game) => game.metadataSource).length;

  const exportedGames = games.map((game) => toExportedGame(game, accountId, ownerKey || profile && profile.ownerKey));

  return {
    source: 'epic',
    contractVersion: CONTRACT_VERSION,
    owner: ownerKey || (profile && profile.ownerKey) || null,
    accountId,
    status,
    account: {
      accountId,
      displayName: (profile && profile.displayName) || (token && token.displayName) || null,
      label: (profile && profile.label) || null,
      connectedAt: (profile && profile.connectedAt) || null,
      importedAt: (profile && profile.importedAt) || null,
      disconnectedAt: (profile && profile.disconnectedAt) || null,
      authMethod: (token && token.authMethod) || null,
      token: token || null,
    },
    libraries,
    summary: library
      ? {
          ownedCount,
          playedCount,
          unplayedCount: ownedCount == null ? null : ownedCount - playedCount,
          hours,
          totalTimeSec: playtime ? playtime.totalSeconds : null,
          totalMinutes: playtime ? playtime.totalMinutes : null,
          externalOwnedCount: ownedCount,
          externalHours: hours,
          libraryExternalNumberCount: ownedCount,
          matchedPlaytimeSeconds: matchedSeconds,
          playtimeCoverage:
            ownedCount && knownPlaytime.length
              ? Math.round((knownPlaytime.length / ownedCount) * 1000) / 10
              : 0,
        }
      : null,
    hoursBySource: { steam: steam.hours, epic: hours },
    ownedBySource: { steam: steam.owned, epic: ownedCount },
    games,
    exportedGames,
    meta: {
      contractVersion: CONTRACT_VERSION,
      fetchedAt: (library && library.fetchedAt) || null,
      playtimeFetchedAt: (playtime && playtime.fetchedAt) || null,
      libraryFresh: library ? gameCache.isFresh(library, epicCache.epicLibraryTtlMs()) : false,
      playtimeFresh: playtime ? gameCache.isFresh(playtime, epicCache.epicPlaytimeTtlMs()) : false,
      catalogCoverage:
        ownedCount && withMetadata
          ? Math.round((withMetadata / ownedCount) * 1000) / 10
          : 0,
      counts: (library && library.counts) || null,
      warnings: (library && Array.isArray(library.warnings) ? library.warnings : []).slice(),
      units: { totalTimeSec: 'seconds', totalMinutes: 'minutes', hours: 'hours (1 decimal)' },
    },
  };
}

async function buildEpicSources(ownerKey) {
  const layer = await buildEpicLayer({ ownerKey });
  return {
    source: 'epic',
    contractVersion: layer.contractVersion,
    owner: layer.owner,
    status: layer.status,
    account: layer.account,
    libraries: layer.libraries,
    summary: layer.summary,
    hoursBySource: layer.hoursBySource,
    ownedBySource: layer.ownedBySource,
    meta: layer.meta,
  };
}

module.exports = {
  CONTRACT_VERSION,
  buildEpicLayer,
  buildEpicLayerSync,
  buildEpicSources,
  epicSourceBlock,
  epicSecondaryWorks,
  steamSide,
  minutesToHours,
};
