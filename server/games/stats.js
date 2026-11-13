'use strict';

const gameCache = require('./game-cache');
const gogCache = require('./gog-cache');
const {
  readDetailsIndex,
  runningFor: secondaryDetailsRunning,
} = require('./secondary-details');
const { readSecondaryLinks, readSecondaryTitleLinks } = require('./secondary/cache');
const { buildEpicLayerSync } = require('./secondary/epic');
const franchise = require('./franchise');
const editions = require('./editions');

const {
  TAG_LIMIT,
  TAG_INDEX_LIMIT,
  DLC_TOP_LIMIT,
  RARE_PERCENT,
  UNKNOWN_YEAR_LABEL,
  REVIEW_SCORE_LABELS,
  MODE_TESTS,
  HISTOGRAM_BUCKETS,
} = require('./stats/constants');
const {
  round1,
  round2,
  round3,
  minutesToHours,
  hoursBySourceOf,
  median,
  isoOfSeconds,
  iconUrlOf,
  headerImageOf,
  hoursHistogram,
} = require('./stats/numeric');
const {
  detailOf,
  spyOf,
  reviewsOf,
  linksOf,
  genreNamesOf,
  categoryNamesOf,
  modeFlagsOf,
  releaseYearOf,
} = require('./stats/documents');
const { normalizeMinHours, hoursFilterPass } = require('./stats/filters');
const { buildContext } = require('./stats/context');
const { buildSummary } = require('./stats/summary');
const { buildSources } = require('./stats/sources');
const { buildDetailsCoverage, buildMeta } = require('./stats/meta');
const { buildAggregates } = require('./stats/aggregates');
const { buildFeatures } = require('./stats/features');
const { buildTop } = require('./stats/top');
const { buildGamesIndex } = require('./stats/games-index');
const { buildTimeline, calendarFromAchievements } = require('./stats/timeline');
const steamArt = require('./art');

function buildGamesStats(input = {}) {
  const startedAt = process.hrtime.bigint();
  const ctx = buildContext(input);
  const {
    partial,
    details,
    union,
    gogSnapshots,
    epicLayer,
    epicHoursValue,
    epicOwnedValue,
    epicSource,
    gogStatus,
    visibleWorks,
    secondaryVisible,
    chartWorks,
    achievementDocs,
    chosenDocs,
    ownedCount,
    gameCount,
    totalHours,
    unplayedCount,
  } = ctx;

  const { timeline, achievementDays, streaks } = buildTimeline(ctx);

  const aggregates = { ...buildAggregates(ctx), ...buildFeatures(ctx) };
  const { topGames, recentlyPlayed, recently2w, backlogItems } = buildTop(ctx);
  const gamesIndex = buildGamesIndex(ctx);

  const detailsCoverage = buildDetailsCoverage(ctx);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  return {
    sources: buildSources(ctx),
    libraryPartial: partial,
    summary: buildSummary(ctx, {
      ...aggregates,
      metadata: detailsCoverage,
    }),
    hoursHistogram: hoursHistogram(chartWorks.map((work) => work.hours)),
    topGames,
    recentlyPlayed,
    recently2w,
    backlog: {
      count: unplayedCount,
      share: gameCount ? round3(unplayedCount / gameCount) : 0,
      items: backlogItems,
      truncated: unplayedCount > backlogItems.length,
    },
    genres: aggregates.genres,
    tags: aggregates.tags,
    scores: aggregates.scores,
    decades: aggregates.decades,
    years: aggregates.years,
    franchises: [],
    studios: [],
    personnelTop: null,
    timeline,
    achievementDays,
    streaks,
    gamesIndex,
    secondaryWorks: secondaryVisible.slice(0, 200).map((entry) => ({
      workKey: entry.workKey,
      name: entry.name || null,
      sources: [...entry.sources],
      ownedOn: [...entry.ownedOn],
      storeIds: { ...entry.storeIds },
      hoursBySource: hoursBySourceOf(entry),
      primaryAppid: entry.primaryAppid == null ? null : entry.primaryAppid,
      gog: entry.gog ? { ...entry.gog } : null,
      epic: entry.epic ? { ...entry.epic } : null,
      matchedBy: entry.matchedBy,
      confidence: entry.confidence,
      releaseYear: entry.releaseYear == null ? null : entry.releaseYear,
      releaseYearSource: entry.releaseYearSource || null,
      releaseDate: entry.releaseDate || null,
      verticalCover: entry.verticalCover || null,
      image:
        entry.image ||
        (entry.gog && entry.gog.image) ||
        (entry.epic && entry.epic.image) ||
        null,
      genres: [...entry.genres],
      developers: [...entry.developers],
      publishers: [...entry.publishers],
      qid: entry.qid || null,
      franchise: entry.franchise ? { ...entry.franchise } : null,
      metadataSources: [...entry.metadataSources],
      hours: round1(entry.secondaryMinutes / 60),
      secondaryHours: round1(entry.secondaryMinutes / 60),
      displayHours: round1(entry.displayMinutes / 60),
      hoursUnknown: Boolean(entry.hoursUnknown),
      hoursStatus: { ...entry.hoursStatus },
      secondaryOnly: true,
      source: entry.sources.includes('gog') ? 'gog' : 'epic',
    })),
    gog: gogSnapshots.length ? { ...union.summary, status: gogStatus } : null,
    epic: epicLayer
      ? {
          contractVersion: epicLayer.contractVersion,
          status: epicSource.status,
          accountId: epicLayer.accountId || null,
          summary: epicLayer.summary,
          hoursBySource: { steam: totalHours, epic: epicHoursValue },
          ownedBySource: { steam: ownedCount, epic: epicOwnedValue },
          meta: epicLayer.meta,
        }
      : null,
    unmatchedCount: visibleWorks.filter((work) =>
      work.games.every((game) => !detailOf(details, game.appid))
    ).length,
    meta: buildMeta(ctx, {
      ...aggregates,
      elapsedMs,
      metadata: detailsCoverage,
      chosenDocs,
      achievementDocs,
    }),
  };
}
function buildGamesStatsFromCache(profileKey, options = {}) {
  const parsed = gameCache.parseProfileToken(profileKey);
  if (!parsed) return null;
  const profile = gameCache.getProfile(parsed.userKey);
  const library = gameCache.getLibrary(parsed.userKey);
  if (!profile || !library) return null;
  const achievements = gameCache.listAchievements(parsed.userKey);
  const globals = new Map();
  for (const doc of achievements) {
    const global = gameCache.getGlobal(doc.appid);
    if (global) globals.set(doc.appid, global);
  }
  const appids = (Array.isArray(library.games) ? library.games : []).map((game) => game.appid);
  const details = gameCache.listDetails(appids);
  const links = franchise.readLinksMap(appids);
  const baseAppids = [];
  for (const link of Object.values(links)) {
    if (link && link.baseAppid && !baseAppids.includes(link.baseAppid)) {
      baseAppids.push(link.baseAppid);
    }
  }
  const detailsBase = gameCache.listDetailsBase(baseAppids);
  let editionDoc = null;
  try {
    editionDoc = editions.ensureEditions(profileKey, {
      library,
      games: Array.isArray(library.games) ? library.games : [],
      details,
      links,
    }).doc;
  } catch (err) {
    console.warn(`[games-stats] editions index not persisted: ${err.message}`);
    editionDoc = editions.buildEditionIndex({
      games: Array.isArray(library.games) ? library.games : [],
      details,
      links,
      profileKey,
      libraryFingerprint: library.fingerprint,
    });
  }
  const gogTokenAccounts = gogCache.accountsForOwner(profileKey);
  if (!gogTokenAccounts.length) {
    for (const library of gogCache.listLibraries()) {
      if (!library || library.ownerProfile !== profileKey) continue;
      const view = gogCache.publicTokenView(gogCache.getToken(library.userKey));
      if (view && !view.ownerProfile) {
        gogTokenAccounts.push({ ...view, binding: 'unbound' });
      }
    }
  }
  const gogAccounts = [...gogTokenAccounts];
  const gogSnapshots = [];
  for (const account of gogTokenAccounts) {
    const gogLibrary = gogCache.getLibrary(account.userKey);
    if (!gogLibrary) continue;
    gogSnapshots.push({
      account,
      library: gogLibrary,
      playtime: gogCache.getPlaytime(account.userKey),
    });
  }
  if (!gogTokenAccounts.length) {
    for (const gogLibrary of gogCache.listLibraries()) {
      if (!gogLibrary || gogLibrary.ownerProfile !== profileKey) continue;
      const synthetic = {
        source: 'gog',
        userKey: String(gogLibrary.userKey),
        key: gogCache.profileKeyOf(gogLibrary.userKey),
        username: (gogLibrary.account && gogLibrary.account.username) || null,
        ownerProfile: profileKey,
        connected: false,
        expired: null,
      };
      gogAccounts.push(synthetic);
      gogSnapshots.push({
        account: synthetic,
        library: gogLibrary,
        playtime: gogCache.getPlaytime(gogLibrary.userKey),
      });
    }
  }
  const epicLayerView = buildEpicLayerSync({ ownerKey: profileKey });
  const detailGogIds = [];
  for (const snapshot of gogSnapshots) {
    for (const product of (snapshot.library && snapshot.library.products) || []) {
      if (product && product.gogGameId) detailGogIds.push(String(product.gogGameId));
    }
  }
  const detailEpicSlugs = [];
  for (const game of (epicLayerView && epicLayerView.games) || []) {
    if (game && game.slug) detailEpicSlugs.push(game.slug);
  }
  const secondaryDetailsIndex = readDetailsIndex({
    gogIds: detailGogIds,
    epicSlugs: detailEpicSlugs,
  });
  return buildGamesStats({
    steamId64: parsed.userKey,
    profile,
    library,
    achievements,
    globals,
    details,
    spy: gameCache.listSpy(appids),
    reviews: gameCache.listReviews(appids),
    links,
    art: steamArt.listResolvedArt(appids),
    detailsBase,
    gogAccounts,
    gogSnapshots,
    gogConnected: gogTokenAccounts.length > 0,
    secondaryLinks: readSecondaryLinks({ allowStale: true }),
    secondaryTitleLinks: readSecondaryTitleLinks({ allowStale: true }),
    epic: epicLayerView,
    secondaryDetails: secondaryDetailsIndex,
    secondaryDetailsRunning: secondaryDetailsRunning(profileKey),
    editions: editionDoc,
    includeFree: options.includeFree !== false,
    includeDlc: Boolean(options.includeDlc),
    minHours: options.minHours,
    enrichRunning: options.enrichRunning === true,
  });
}

function profileSummary(profile, library) {
  if (!profile) return null;
  const games = (library && Array.isArray(library.games) && library.games) || [];
  const minutes = games.reduce((sum, game) => sum + (Number(game.playtime_forever) || 0), 0);
  return {
    key: gameCache.profileKeyOf(profile.userKey),
    source: 'steam',
    userKey: profile.userKey,
    personaName: profile.personaName || null,
    label: profile.ownerLabel || null,
    avatarUrl: profile.avatarUrl || null,
    privacy: profile.privacy || null,
    importedAt: profile.importedAt || null,
    libraryPartial: Boolean(library && library.partial),
    gameCount: library ? library.game_count : null,
    ownedCount: games.length,
    totalHours: minutesToHours(minutes),
    playedCount: games.filter((game) => (Number(game.playtime_forever) || 0) > 0).length,
  };
}

module.exports = {
  RARE_PERCENT,
  HISTOGRAM_BUCKETS,
  UNKNOWN_YEAR_LABEL,
  MODE_TESTS,
  REVIEW_SCORE_LABELS,
  TAG_LIMIT,
  TAG_INDEX_LIMIT,
  DLC_TOP_LIMIT,
  detailOf,
  spyOf,
  reviewsOf,
  linksOf,
  genreNamesOf,
  categoryNamesOf,
  modeFlagsOf,
  releaseYearOf,
  round1,
  round2,
  round3,
  minutesToHours,
  median,
  normalizeMinHours,
  hoursFilterPass,
  hoursHistogram,
  calendarFromAchievements,
  buildGamesStats,
  buildGamesStatsFromCache,
  profileSummary,
};
