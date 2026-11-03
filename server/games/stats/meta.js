'use strict';

/**
 * `meta` of the games payload plus the details-coverage block that `summary`
 * embeds: build time, secondary-details job state, library freshness, cache
 * coverage (tags/reviews/franchises), the applied filters and `pending[]`.
 *
 * S1 «распил god-функции»: pure reads of the context. `buildMs` is measured by
 * the assembly line and passed in, so the number still covers the whole build.
 * Aggregate counters (`gamesWithTags`, `gamesWithReviews`, `franchiseCoverage`,
 * `dlcSummary`) arrive through `extra` — the assembly line slots `summary`
 * before those sections in the payload.
 */

const gameCache = require('../game-cache');
const config = require('../../config');
const { runningFor: secondaryDetailsRunning } = require('../secondary-details');
const { round1 } = require('./numeric');

/**
 * `summary.metadata` / `meta.details`: how much of the library has store
 * details, how many documents answered `success:false`, and whether the
 * enrich job is running right now.
 */
function buildDetailsCoverage(ctx) {
  const { games, details, detailsCount, hasDetails, input } = ctx;
  const detailDocs = games
    .map((game) => details[String(game.appid)])
    .filter((doc) => doc && typeof doc === 'object');
  const detailsUnavailable = detailDocs.filter((doc) => doc.success === false).length;
  const detailsMissing = Math.max(0, games.length - detailsCount - detailsUnavailable);
  let lastEnrichedMs = 0;
  for (const doc of detailDocs) {
    const ts = Date.parse(String(doc.fetchedAt || ''));
    if (Number.isFinite(ts) && ts > lastEnrichedMs) lastEnrichedMs = ts;
  }
  const lastEnrichedAt = lastEnrichedMs ? new Date(lastEnrichedMs).toISOString() : null;
  // `running` closes the UX loop with the auto-enrich kick: right after an
  // import the UI has no enrich job id, it only sees this flag in
  // `summary.metadata` and starts polling. It is also why metadata exists
  // before the first detail lands (detailsResolved = 0).
  const enrichRunning = input.enrichRunning === true;
  return hasDetails || enrichRunning
    ? {
        detailsResolved: detailsCount,
        detailsTotal: games.length,
        detailsPercent: games.length
          ? round1((detailsCount / games.length) * 100)
          : 0,
        detailsUnavailable,
        detailsMissing,
        lastEnrichedAt,
        running: enrichRunning,
      }
    : null;
}

function buildMeta(ctx, extra = {}) {
  const {
    profileKey,
    input,
    library,
    secondaryDetailResolved,
    secondaryDetailTotal,
    secondaryDetailPartial,
    secondaryDetailNoSlug,
    gameCount,
    hasDetails,
    excluded,
    includeFree,
    includeDlc,
    minHours,
    excludedByHours,
    excludedWorks,
    secondaryExcludedByHours,
    secondaryVisible,
    keyConfigured,
    editionsMeta,
  } = ctx;
  const {
    elapsedMs,
    metadata,
    gamesWithTags,
    gamesWithReviews,
    franchiseCoverage,
    dlcSummary,
    linksResolved,
    chosenDocs,
    achievementDocs,
  } = extra;

  return {
    buildMs: Number(elapsedMs.toFixed(1)),
    // M6d: how many secondary works already have store metadata cached
    // (genres/year/poster) and whether the details job is running right now.
    // `total` counts works with a store id; `resolved` those with a detail
    // document — never a percentage of an empty set.
    secondaryDetails: {
      resolved: secondaryDetailResolved,
      total: secondaryDetailTotal,
      // Present-but-incomplete Epic metadata (only year or only genres).
      // Part of the kick rule: `resolved < total || partial > 0 || noSlug`.
      partial: secondaryDetailPartial,
      // Epic works with no store slug: «library-only» (title + hours), the
      // store metadata job cannot address them at all.
      noSlug: secondaryDetailNoSlug,
      running:
        input.secondaryDetailsRunning === true
          ? true
          : secondaryDetailsRunning(profileKey),
    },
    libraryFingerprint: library.fingerprint || null,
    libraryFetchedAt: library.fetchedAt || null,
    libraryStale: !gameCache.isFresh(library, gameCache.libraryTtlMs()),
    libraryTtlHours: Math.round(gameCache.libraryTtlMs() / 3600000),
    achievementsCachedGames: chosenDocs.length,
    calendarAvailable: achievementDocs.length > 0,
    keyConfigured,
    keySource: keyConfigured ? config.steamKeySource() : null,
    details: metadata,
    // M5-B: canonical-work merge facts (additive, UI-safe).
    editions: editionsMeta,
    // M4 coverage: how much of the visible library has tags / a review grade.
    // `percent` is honest: 0 with no documents, never a fake 100.
    tags: {
      source: 'steamspy',
      gamesWithTags,
      gamesTotal: gameCount,
      percent: gameCount ? round1((gamesWithTags / gameCount) * 100) : 0,
    },
    reviews: {
      source: 'steam-reviews',
      gamesWithReviews,
      gamesTotal: gameCount,
      percent: gameCount ? round1((gamesWithReviews / gameCount) * 100) : 0,
    },
    // M4-B coverage of the Wikidata links pass. Wikidata-only by design: the
    // low-confidence title heuristic and the grouping live in
    // `/api/games/franchises` (`coverage.bySource`), never in this payload.
    franchises: franchiseCoverage,
    excluded,
    filters: {
      includeFree: {
        requested: includeFree,
        // `applied` means "the filter could actually run": at least one
        // details document answered `is_free`. With no details it stays
        // false and the reason is explicit, never a silent no-op.
        applied: hasDetails,
        excluded: excluded.free,
        reason: hasDetails ? null : 'details_not_imported',
      },
      includeDlc: {
        requested: includeDlc,
        applied: hasDetails,
        excluded: excluded.dlc,
        excludedTypes: excluded.otherType,
        reason: hasDetails ? null : 'details_not_imported',
      },
      // M5-B: the hours filter runs after type/free filters and after the
      // edition merge (one canonical work, one decision).
      minHours: {
        requested: minHours,
        applied: true,
        excluded: excludedByHours,
        excludedAppids: excludedWorks.reduce((sum, work) => sum + work.games.length, 0),
        // M6c: secondary-only works the filter dropped. Works whose hours the
        // store never answered for are **kept** (`hoursUnknown`), never
        // counted here — a failed playtime phase must not hide a game.
        excludedSecondary: secondaryExcludedByHours.length,
        keptSecondaryUnknownHours: secondaryVisible.filter((entry) => entry.hoursUnknown).length,
      },
    },
    pending: [
      ...(hasDetails
        ? []
        : ['genres', 'years', 'decades', 'modes', 'earlyAccess', 'freeToPlay', 'platforms']),
      ...(gamesWithTags ? [] : ['tags']),
      ...(gamesWithReviews ? [] : ['reviews']),
      ...(dlcSummary ? [] : ['dlc']),
      ...(linksResolved ? [] : ['franchises']),
      'studios',
      'personnelTop',
    ],
  };
}

module.exports = { buildDetailsCoverage, buildMeta };
