'use strict';

const gogCache = require('../gog-cache');
const { buildSecondaryUnion } = require('../secondary/union');
const { enrichUnionWithDetails } = require('../secondary-details');
const { attachSecondaryIdentity } = require('../secondary-works');
const { epicSourceBlock } = require('../secondary/epic');

function buildSecondaryState({ input = {}, allWorks, linkDocs }) {
  const gogAccounts = Array.isArray(input.gogAccounts) ? input.gogAccounts : [];
  const gogSnapshots = Array.isArray(input.gogSnapshots) ? input.gogSnapshots : [];
  const epicLayer =
    input.epic && typeof input.epic === 'object' && input.epic.accountId ? input.epic : null;
  const union = buildSecondaryUnion({
    works: allWorks,
    gogSnapshots,
    epicLayer,
    links: linkDocs,
    secondaryLinks: input.secondaryLinks,
  });
  const secondaryDetailsIndex =
    input.secondaryDetails && typeof input.secondaryDetails === 'object'
      ? input.secondaryDetails
      : {};
  enrichUnionWithDetails(union, secondaryDetailsIndex);
  attachSecondaryIdentity(union, {
    bridge: input.secondaryLinks,
    titleBridge: input.secondaryTitleLinks,
  });
  const secondaryDetailTotal = union.works.filter(
    (entry) => (entry.gog && entry.gog.gogGameId) || (entry.epic && entry.epic.slug)
  ).length;
  const secondaryDetailResolved = union.works.filter((entry) => {
    if (
      !entry.secondaryDetails ||
      entry.secondaryDetails.catalogPending === true ||
      entry.secondaryDetails.needsCatalog === true
    ) {
      return false;
    }
    if (entry.secondaryDetails.source === 'epic') {
      return (
        entry.secondaryDetails.yearHas === true &&
        entry.secondaryDetails.genresOk === true
      );
    }
    return true;
  }).length;
  const secondaryDetailPartial = union.works.filter((entry) => {
    const detail = entry.secondaryDetails;
    if (!detail || detail.source !== 'epic') return false;
    if (detail.catalogPending === true || detail.needsCatalog === true) return false;
    const yearHas = detail.yearHas === true;
    const genresOk = detail.genresOk === true;
    return (yearHas && !genresOk) || (!yearHas && genresOk);
  }).length;
  const secondaryDetailNoSlug = union.works.filter(
    (entry) => entry.epic && !entry.epic.slug
  ).length;
  const unionActive = gogSnapshots.length > 0 || Boolean(epicLayer);
  const gogUnion = unionActive ? union : null;
  const gogConnected = input.gogConnected === true;
  const gogHoursValue = gogSnapshots.length ? union.summary.gogHours : null;
  const gogOwnedValue = gogSnapshots.length ? union.summary.gogProducts : null;
  const gogAccountView = gogAccounts[0] || null;
  const gogSnapshotView = gogSnapshots[0] || null;
  const gogAuthState = gogAccountView && gogAccountView.authState
    ? gogAccountView.authState
    : gogAccountView && gogAccountView.expired === true
      ? { needsReconnect: true, status: 'refresh_failed', refreshable: false }
      : null;
  const gogNeedsReconnect = Boolean(gogAuthState && gogAuthState.needsReconnect === true);
  const gogStatus = !gogConnected
    ? gogSnapshots.length
      ? 'snapshot_only'
      : 'not_connected'
    : gogNeedsReconnect
      ? 'auth_expired'
      : gogSnapshotView && gogSnapshotView.library
        ? gogCache.isFresh(gogSnapshotView.library, gogCache.libraryTtlMs())
          ? 'ok'
          : 'stale'
        : 'connected_no_import';
  const gogSource = {
    configured: gogConnected,
    connected: gogConnected,
    status: gogStatus,
    userKey: gogAccountView ? gogAccountView.userKey : null,
    key: gogAccountView ? gogAccountView.key : null,
    username: gogAccountView ? gogAccountView.username : null,
    ownerProfile: gogAccountView ? gogAccountView.ownerProfile : null,
    auth: gogAuthState
      ? {
          status: gogAuthState.status || null,
          hasRefreshToken: Boolean(gogAuthState.hasRefreshToken),
          expiresAt: gogAuthState.expiresAt || null,
          expiresInMs: gogAuthState.expiresInMs == null ? null : gogAuthState.expiresInMs,
          expired: gogAuthState.expired === true,
          refreshable: gogAuthState.refreshable === true,
          needsReconnect: gogNeedsReconnect,
          refreshedAt: gogAuthState.refreshedAt || null,
          lastRefreshError: gogAuthState.lastRefreshError || null,
          lastError: gogAuthState.lastError || null,
          binding: gogAuthState.binding || null,
        }
      : null,
    binding: gogAccountView ? gogAccountView.binding || (gogAccountView.ownerProfile ? 'bound' : 'unbound') : null,
    lastImportAt:
      gogSnapshotView && gogSnapshotView.library
        ? gogSnapshotView.library.fetchedAt || null
        : null,
    libraryFetchedAt:
      gogSnapshotView && gogSnapshotView.library
        ? gogSnapshotView.library.fetchedAt || null
        : null,
    playtimeFetchedAt:
      gogSnapshotView && gogSnapshotView.playtime
        ? gogSnapshotView.playtime.fetchedAt || null
        : null,
    productCount: gogOwnedValue,
    hours: gogHoursValue,
    playtimeGames:
      gogSnapshotView && gogSnapshotView.playtime
        ? gogSnapshotView.playtime.fetchedGames == null
          ? null
          : gogSnapshotView.playtime.fetchedGames
        : null,
    budgetExceeded: Boolean(
      gogSnapshotView && gogSnapshotView.playtime && gogSnapshotView.playtime.budgetExceeded
    ),
    stale:
      gogStatus === 'stale' || gogStatus === 'auth_expired' || gogStatus === 'connected_no_import',
  };

  const epicSource = epicSourceBlock(epicLayer);
  const epicHoursValue =
    epicLayer && epicLayer.summary && epicLayer.summary.hours != null
      ? epicLayer.summary.hours
      : null;
  const epicOwnedValue =
    epicLayer && epicLayer.summary && epicLayer.summary.ownedCount != null
      ? epicLayer.summary.ownedCount
      : null;

  return {
    gogAccounts,
    gogSnapshots,
    epicLayer,
    union,
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
  };
}

module.exports = { buildSecondaryState };
