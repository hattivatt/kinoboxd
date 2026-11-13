'use strict';

const gameCache = require('./game-cache');
const franchise = require('./franchise');
const {
  MIN_HEURISTIC_GAMES,
  STOP_BASES,
  BLACKLIST_PAIRS,
  round1,
  normalizeTitle,
  heuristicBase,
  humanizeBase,
  groupIsBlacklisted,
  applyTitleHeuristic,
} = require('./franchise/aggregate-rules');
const {
  resolveSecondaryWorks,
  collectLibraryGames,
  collectSecondaryGames,
} = require('./franchise/aggregate-games');

function buildFranchiseEntries(games) {
  const buckets = new Map();
  const touch = (key, meta, game) => {
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        label: meta.label || key,
        labelRu: meta.labelRu || null,
        source: meta.source,
        confidence: meta.confidence,
        games: [],
      });
    }
    buckets.get(key).games.push(game);
  };

  let gamesWithFranchise = 0;
  const bySource = { wikidata: 0, heuristic: 0 };
  for (const game of games) {
    if (game.wdKey) {
      touch(
        game.wdKey,
        {
          label: game.wdFranchise.label,
          labelRu: game.wdFranchise.labelRu,
          source: 'wikidata',
          confidence: 'high',
        },
        game
      );
      gamesWithFranchise++;
      bySource.wikidata++;
    } else if (game.heuristicKey) {
      touch(
        game.heuristicKey,
        { label: game.heuristicLabel, source: 'heuristic', confidence: 'low' },
        game
      );
      gamesWithFranchise++;
      bySource.heuristic++;
    }
  }

  const franchises = [...buckets.values()]
    .filter((bucket) => bucket.games.length >= 2)
    .map((bucket) => {
      const years = bucket.games
        .map((game) => game.releaseYear)
        .filter((year) => Number.isInteger(year) && year > 0)
        .sort((a, b) => a - b);
      const hoursSum = round1(bucket.games.reduce((sum, game) => sum + game.hours, 0));
      return {
        key: bucket.key,
        label: bucket.label,
        labelRu: bucket.labelRu,
        source: bucket.source,
        confidence: bucket.confidence,
        gamesCount: bucket.games.length,
        hoursSum,
        yearsSpread: years.length
          ? { min: years[0], max: years[years.length - 1], span: years[years.length - 1] - years[0] }
          : { min: null, max: null, span: null },
        years: [...new Set(years)],
        appids: bucket.games
          .filter((game) => game.appid != null)
          .slice()
          .sort((a, b) => b.hours - a.hours || a.appid - b.appid)
          .map((game) => game.appid),
        workKeys: bucket.games
          .filter((game) => game.workKey)
          .slice()
          .sort(
            (a, b) =>
              b.hours - a.hours ||
              String(a.workKey).localeCompare(String(b.workKey))
          )
          .map((game) => game.workKey),
        games: bucket.games
          .slice()
          .sort(
            (a, b) =>
              b.hours - a.hours ||
              (a.appid == null ? 0 : a.appid) - (b.appid == null ? 0 : b.appid) ||
              String(a.workKey || '').localeCompare(String(b.workKey || ''))
          )
          .map((game) => ({
            appid: game.appid == null ? null : game.appid,
            workKey: game.workKey || null,
            secondaryOnly: game.secondaryOnly === true,
            name: game.name,
            hours: game.hours,
            releaseYear: game.releaseYear,
            releaseSource: game.releaseSource,
          })),
      };
    })
    .sort(
      (a, b) =>
        b.hoursSum - a.hoursSum ||
        b.gamesCount - a.gamesCount ||
        String(a.label || a.key).localeCompare(String(b.label || b.key), 'ru')
    );

  return { franchises, gamesWithFranchise, bySource };
}

function buildFranchises(profileKey, options = {}) {
  const startedAt = Date.now();
  const parsed = gameCache.parseProfileToken(profileKey);
  if (!parsed) return null;
  const getProfile = options.getProfile || gameCache.getProfile;
  const getLibrary = options.getLibrary || gameCache.getLibrary;
  const readDetails = options.readDetails || gameCache.getDetails;
  const readLinks = options.readLinks || franchise.readLinks;
  const nowMs = typeof options.now === 'function' ? options.now() : Date.now();
  const ttlMs = options.ttlMs != null && Number.isFinite(Number(options.ttlMs))
    ? Number(options.ttlMs)
    : franchise.ttlMsFromEnv();

  const profile = getProfile(parsed.userKey);
  const library = getLibrary(parsed.userKey);
  if (!profile || !library) return null;

  const secondaryList = resolveSecondaryWorks(options, parsed);
  const primary = collectLibraryGames(library, { readDetails, readLinks, ttlMs, nowMs });
  const secondary = collectSecondaryGames(secondaryList);
  const games = [...primary.games, ...secondary.games];
  const { release, linksCoverage, bridgePending } = primary;
  const { secondaryGames, secondaryWithFranchise, secondaryFranchisePending } = secondary;

  applyTitleHeuristic(games);

  const { franchises, gamesWithFranchise, bySource } = buildFranchiseEntries(games);

  const gamesTotal = games.length;
  const percent = gamesTotal ? round1((gamesWithFranchise / gamesTotal) * 100) : 0;
  const pendingWikidata = games.filter(
    (game) => !game.secondaryOnly && !game.wdFresh
  ).length;

  return {
    profile: parsed.key,
    franchises,
    totals: {
      franchises: franchises.length,
      gamesTotal,
      secondaryWorks: secondaryGames,
      gamesInFranchises: franchises.reduce((sum, entry) => sum + entry.gamesCount, 0),
      hoursInFranchises: round1(franchises.reduce((sum, entry) => sum + entry.hoursSum, 0)),
      hoursTotal: round1(games.reduce((sum, game) => sum + game.hours, 0)),
    },
    coverage: {
      gamesTotal,
      gamesWithFranchise,
      percent,
      bySource,
      secondary: {
        works: secondaryGames,
        withFranchise: secondaryWithFranchise,
        pending: secondaryFranchisePending,
      },
      links: { ...linksCoverage, ttlDays: ttlMs ? Math.round(ttlMs / 86400000) : null },
      releaseYears: release,
    },
    pending: {
      wikidata: pendingWikidata,
      bridge: bridgePending,
      secondary: secondaryFranchisePending,
      releaseYears: release.unknown,
      unavailableDetails: release.unavailableDetails,
      running: false,
      reason: null,
    },
    meta: {
      buildMs: round1(Date.now() - startedAt),
      heuristic: {
        enabled: true,
        confidence: 'low',
        minGames: MIN_HEURISTIC_GAMES,
        blacklistPairs: BLACKLIST_PAIRS.length,
      },
      sourceOrder: ['wikidata', 'heuristic'],
      yearsSource: ['steam-store', 'wikidata', 'wikidata-base'],
    },
  };
}

module.exports = {
  MIN_HEURISTIC_GAMES,
  STOP_BASES,
  BLACKLIST_PAIRS,
  normalizeTitle,
  heuristicBase,
  humanizeBase,
  groupIsBlacklisted,
  buildFranchises,
};
