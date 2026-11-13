'use strict';

const gameCache = require('../game-cache');
const config = require('../../config');
const { runningFor: secondaryDetailsRunning } = require('../secondary-details');
const { round1 } = require('./numeric');

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
    secondaryDetails: {
      resolved: secondaryDetailResolved,
      total: secondaryDetailTotal,
      partial: secondaryDetailPartial,
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
    editions: editionsMeta,
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
    franchises: franchiseCoverage,
    excluded,
    filters: {
      includeFree: {
        requested: includeFree,
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
      minHours: {
        requested: minHours,
        applied: true,
        excluded: excludedByHours,
        excludedAppids: excludedWorks.reduce((sum, work) => sum + work.games.length, 0),
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
