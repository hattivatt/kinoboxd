'use strict';

/**
 * Preprocessor of the `/api/games/stats` payload.
 *
 * S1 «распил god-функции»: one snapshot built once, then every payload section
 * is a pure function of it. It holds the inputs (library/profile/details/
 * secondary maps), the filtered library, the canonical works (editions), the
 * same-owner secondary union, the visible work rows (`chartWorks`), the
 * headline counters and the per-work metadata helpers. Sections receive it as
 * an explicit argument instead of closing over a 1 700-line function body.
 *
 * The returned context is the snapshot the payload is built from. Builders do
 * not mutate it, except for the pre-existing `work.completion` annotation that
 * the achievements block has always written onto a visible work row.
 */

const gameCache = require('../game-cache');
const config = require('../../config');
const editions = require('../editions');
const { round1, round2, round3, median } = require('./numeric');
const { normalizeMinHours, hoursFilterPass, applyDetailFilters } = require('./filters');
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

  /* ---------------- details + filters (M2) ---------------- */
  // `details` is the `{ [appid]: details/<appid>.json }` map. With no details
  // at all the payload must stay exactly M1: every game is kept, every M2
  // bucket stays empty and `meta.pending` says why.
  const details = input.details && typeof input.details === 'object' ? input.details : {};
  // B6: appdetails of the **base** version of a regional SKU
  // (`details-base/<baseAppid>.json`). Used only as a metadata fallback
  // (name/year/genres/studios) — never for DLC lists, ownership flags or
  // completion, which belong to the owned edition.
  const detailsBase =
    input.detailsBase && typeof input.detailsBase === 'object' ? input.detailsBase : {};
  const spyDocs = input.spy && typeof input.spy === 'object' ? input.spy : {};
  const reviewDocs = input.reviews && typeof input.reviews === 'object' ? input.reviews : {};
  // M4-B: `franchise.readLinks` views keyed by appid (optional input, so the
  // builder stays pure and every M1..M4 unit test keeps working unchanged).
  const linkDocs = input.links && typeof input.links === 'object' ? input.links : {};
  const includeFree = input.includeFree !== false;
  const includeDlc = Boolean(input.includeDlc);
  const { detailsCount, hasDetails, excluded, keptGames } = applyDetailFilters(games, details, {
    includeFree,
    includeDlc,
  });

  /* ---------------- canonical works (M5-B editions) ---------------- */
  const { editionDoc, canonicalOf, workMap, allWorks } = buildWorks({
    input,
    keptGames,
    details,
    links: linkDocs,
    profileKey,
    library,
  });

  /* ---------------- M6a/M6c: same-owner secondary libraries ---------------- */
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

  // Platform hours are in the library snapshot (playtime_*_forever). Deck hours
  // are a subset of Linux hours and are reported separately, never added.
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
    // User-facing number: how many rows the edition merge removed.
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
