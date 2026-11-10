'use strict';

/**
 * Same-owner secondary libraries of the games payload (M6a/M6c): the GOG and
 * Epic read models, the union of their products with the Steam works, and the
 * per-source state blocks (`sources.gog`, `sources.epic`).
 *
 * S1 «распил god-функции»: this is a pure function of the input maps. GOG and
 * Epic are **libraries of the same owner**, never a second journal (§14.4).
 * The union merges their products into the Steam works by `workKey`
 * (Wikidata P2725/P6278 → P1733, then title); a game that exists only outside
 * Steam becomes a secondary-only work. Hours are reported per source
 * (`hoursBySource`) **and** as a display sum (`displayMinutes`), the
 * 01.11.2026 product decision: an owned work shows Steam + GOG + Epic hours,
 * the breakdown stays visible.
 */

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
  // M6d: store metadata (genres/year/vertical poster) of secondary-only works.
  // The index is read from the cache by `buildGamesStatsFromCache`; the pure
  // builder stays pure (no disk read) and only applies what it was given.
  const secondaryDetailsIndex =
    input.secondaryDetails && typeof input.secondaryDetails === 'object'
      ? input.secondaryDetails
      : {};
  enrichUnionWithDetails(union, secondaryDetailsIndex);
  // M6 follow-up (03.11.2026): a secondary-only work carries the QID the
  // bridge resolved and the P179 series from `links/secondary-franchise.json`.
  // Cache-only: `/stats` never calls WDQS.
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
    // Epic details are only «resolved» when the **facts** arrived (year and
    // genres), not when a file exists: a settled negative is `unavailable` in
    // the secondary-details status, never a fake 1/1 coverage. GOG keeps its
    // previous «detail exists» contract.
    if (entry.secondaryDetails.source === 'epic') {
      return (
        entry.secondaryDetails.yearHas === true &&
        entry.secondaryDetails.genresOk === true
      );
    }
    return true;
  }).length;
  // Partial Epic details (only one of year/genres). The lazy kick treats this
  // as «not finished» (fix 02.11.2026): the catalog is re-posted with the goal
  // «complete» when an attempt is still due.
  const secondaryDetailPartial = union.works.filter((entry) => {
    const detail = entry.secondaryDetails;
    if (!detail || detail.source !== 'epic') return false;
    if (detail.catalogPending === true || detail.needsCatalog === true) return false;
    const yearHas = detail.yearHas === true;
    const genresOk = detail.genresOk === true;
    return (yearHas && !genresOk) || (!yearHas && genresOk);
  }).length;
  // Epic works that have no store slug at all (`productmapping`, catalog and
  // the validated title probe all failed): «library-only» — title + hours, no
  // genres/year/poster. Reported honestly instead of being silently dropped.
  const secondaryDetailNoSlug = union.works.filter(
    (entry) => entry.epic && !entry.epic.slug
  ).length;
  // Legacy alias: the GOG block below and the per-appid annotations read the
  // same union object (it exposes `byAppid`/`secondaryWorks`/`summary`).
  // Annotate Steam rows with cross-store fields only when a secondary library
  // is actually connected — a Steam-only payload stays byte-identical.
  const unionActive = gogSnapshots.length > 0 || Boolean(epicLayer);
  const gogUnion = unionActive ? union : null;
  const gogConnected = input.gogConnected === true;
  // GOG-specific numbers exist only when a GOG snapshot is attached to this
  // owner: an Epic-only owner must see `gog: null`, never a zero.
  const gogHoursValue = gogSnapshots.length ? union.summary.gogHours : null;
  const gogOwnedValue = gogSnapshots.length ? union.summary.gogProducts : null;
  const gogAccountView = gogAccounts[0] || null;
  const gogSnapshotView = gogSnapshots[0] || null;
  // Auth state, not the ~1 h access-token lifetime, decides «подключите GOG
  // заново» (01.11.2026 auth-loop): a token with a working refresh token is
  // refreshed silently by the importer and must never be reported as expired.
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
    // Additive diagnostic block: presence booleans and dates only, never a
    // token value (the UI ignores unknown fields).
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
    // A snapshot older than the TTL is still shown with its date, never as 0.
    stale:
      gogStatus === 'stale' || gogStatus === 'auth_expired' || gogStatus === 'connected_no_import',
  };

  /* ---------------- M6b/M6c: Epic same-owner secondary library ------------ */
  // The Epic read model is assembled by `secondary/epic.js` (status, catalog
  // coverage, playtime). M6c joins its games into the union above: a game with
  // a Wikidata `P6278`/title match becomes part of the Steam work, the rest is
  // a secondary-only work (`epic:<catalogItemId>`). These constants only feed
  // the `sources.epic` block and the Epic summary, never a Steam journal field
  // (achievements, `lastPlayed`, completion).
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
