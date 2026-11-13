'use strict';

const gameCache = require('../game-cache');
const config = require('../../config');
const editions = require('../editions');
const { normalizeMinHours, applyDetailFilters } = require('./filters');
const { buildWorks } = require('./works');
const { buildSecondaryState } = require('./secondary');
const { buildVisible } = require('./visible');
const { buildWorkMeta } = require('./work-meta');
const { buildAchievements } = require('./achievements');

function buildContext(input = {}) {
  const library = input.library || { games: [], partial: true, game_count: null };
  const profile = input.profile || null;
  const steamId64 = input.steamId64 || (profile && profile.userKey) || library.userKey;
  const profileKey = gameCache.profileKeyOf(steamId64);
  const games = Array.isArray(library.games) ? library.games : [];
  const partial = Boolean(library.partial);
  const minHours = normalizeMinHours(input.minHours, -1);

  const details = input.details && typeof input.details === 'object' ? input.details : {};
  const detailsBase =
    input.detailsBase && typeof input.detailsBase === 'object' ? input.detailsBase : {};
  const spyDocs = input.spy && typeof input.spy === 'object' ? input.spy : {};
  const reviewDocs = input.reviews && typeof input.reviews === 'object' ? input.reviews : {};
  const linkDocs = input.links && typeof input.links === 'object' ? input.links : {};
  const artDocs = input.art && typeof input.art === 'object' ? input.art : {};
  const includeFree = input.includeFree !== false;
  const includeDlc = Boolean(input.includeDlc);
  const { detailsCount, hasDetails, excluded, keptGames } = applyDetailFilters(games, details, {
    includeFree,
    includeDlc,
  });

  const { editionDoc, canonicalOf, workMap, allWorks } = buildWorks({
    input,
    keptGames,
    details,
    links: linkDocs,
    profileKey,
    library,
  });

  const secondary = buildSecondaryState({ input, allWorks, linkDocs });
  const {
    union,
    gogSnapshots,
    epicLayer,
    secondaryDetailsIndex,
    secondaryDetailTotal,
    secondaryDetailResolved,
    secondaryDetailPartial,
    secondaryDetailNoSlug,
    unionActive,
    gogUnion,
    gogConnected,
    gogHoursValue,
    gogOwnedValue,
    gogAccountView,
    gogSnapshotView,
    gogAuthState,
    gogNeedsReconnect,
    gogStatus,
    gogSource,
    epicSource,
    epicHoursValue,
    epicOwnedValue,
  } = secondary;

  const visible = buildVisible({ union, allWorks, minHours, games });
  const {
    unionOf,
    visibleWorks,
    visibleGames,
    workByAppid,
    excludedWorks,
    excludedByHours,
    secondaryVisible,
    secondaryExcludedByHours,
    chartWorks,
    hoursOf,
  } = visible;

  const workMeta = buildWorkMeta({
    details,
    detailsBase,
    linkDocs,
    spyDocs,
    reviewDocs,
    unionOf,
    workByAppid,
  });

  const achievements = buildAchievements({
    achievements: input.achievements,
    visibleGames,
    visibleWorks,
    globals: input.globals,
  });

  const platformMinutes = visibleGames.reduce(
    (acc, game) => {
      acc.windows += Number(game.playtime_windows_forever) || 0;
      acc.mac += Number(game.playtime_mac_forever) || 0;
      acc.linux += Number(game.playtime_linux_forever) || 0;
      acc.deck += Number(game.playtime_deck_forever) || 0;
      return acc;
    },
    { windows: 0, mac: 0, linux: 0, deck: 0 }
  );

  const mergedWorks = visibleWorks.filter((work) => work.games.length > 1);
  const editionsMeta = {
    source: 'cache-games/editions.json',
    algorithmVersion: editionDoc.algorithmVersion || editions.ALGORITHM_VERSION,
    fromCache: editionDoc === input.editions,
    appids: visibleGames.length,
    works: visibleWorks.length,
    groups: mergedWorks.length,
    gamesMerged: mergedWorks.reduce((sum, work) => sum + work.games.length, 0),
    savedCount: visibleGames.length - visibleWorks.length,
  };

  return {
    input,
    library,
    profile,
    steamId64,
    profileKey,
    games,
    partial,
    minHours,
    details,
    detailsBase,
    spyDocs,
    reviewDocs,
    linkDocs,
    art: artDocs,
    includeFree,
    includeDlc,
    detailsCount,
    hasDetails,
    excluded,
    keptGames,
    editionDoc,
    canonicalOf,
    workMap,
    allWorks,
    union,
    gogSnapshots,
    epicLayer,
    secondaryDetailsIndex,
    secondaryDetailTotal,
    secondaryDetailResolved,
    secondaryDetailPartial,
    secondaryDetailNoSlug,
    unionActive,
    gogUnion,
    gogConnected,
    gogHoursValue,
    gogOwnedValue,
    gogAccountView,
    gogSnapshotView,
    gogAuthState,
    gogNeedsReconnect,
    gogStatus,
    gogSource,
    epicSource,
    epicHoursValue,
    epicOwnedValue,
    ...visible,
    workMeta,
    ...achievements,
    platformMinutes,
    editionsMeta,
    allProfileKeys: gameCache.listProfiles().map((entry) => entry.key),
    keyConfigured: Boolean(config.loadSteamKey()),
  };
}

module.exports = { buildContext };
