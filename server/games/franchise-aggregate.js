'use strict';

/**
 * Franchise aggregation for `GET /api/games/franchises` (ИГРЫ §4.4, §5.1).
 *
 * Bottom-up and pure: it reads the library + `details/<appid>.json` +
 * `links/<appid>.json` and never calls the network. The route owns the lazy
 * kick; this module only says how much is still pending.
 *
 * Two sources, in this order:
 *
 *   1. **Wikidata P179** (`links/<appid>.json`, written by `franchise.js`) —
 *      `source: "wikidata"`, `confidence: "high"`. A game with a WD series is
 *      never re-guessed by the title heuristic.
 *   2. **Title heuristic** — `source: "heuristic"`, `confidence: "low"`. This
 *      is deliberately minimal (the champion of the heuristic is M4-C): a
 *      group is only a franchise when **at least two owned games** share the
 *      same normalised head («Fallout», «Half-Life», «Civilization»), so a
 *      single title can never invent a franchise. False-pair guards from the
 *      spec (`Dark Souls` ≠ `Darkest Dungeon`, `Hitman` ≠ `Hitman's
 *      Bodyguard`) are kept as a blacklist even though exact-head grouping
 *      already separates them.
 *
 * Release years are the store's `details.releaseYear` when present, otherwise
 * the Wikidata `P577` year — that is the whole point of the WD pass: the 21
 * region-locked `success:false` games and the coarse (`Q4 2026`, month-only)
 * store dates get a year from WD when Wikidata knows it. Unknown stays
 * unknown, never 0.
 *
 * Only games are counted (`details.type` absent or `"game"`); DLC/demo/
 * software/video are skipped exactly like `gameCount` in the stats payload.
 */

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
  // ---- aggregate ----
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
        // M6 follow-up: identity of the secondary-only members (a Steam row is
        // addressed by `appid`, a GOG/Epic row by its `workKey`).
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

/**
 * Build the franchise payload for one cached profile.
 *
 * @param {string} profileKey `steam-<steamid64>`
 * @param {{readDetails?:Function, readLinks?:Function, getProfile?:Function,
 *          getLibrary?:Function, now?:Function, ttlMs?:number}} [options]
 * @returns {object|null} null when the profile/library is not cached
 */
function buildFranchises(profileKey, options = {}) {
  const startedAt = Date.now();
  const parsed = gameCache.parseProfileToken(profileKey);
  if (!parsed) return null;
  const getProfile = options.getProfile || gameCache.getProfile;
  const getLibrary = options.getLibrary || gameCache.getLibrary;
  const readDetails = options.readDetails || gameCache.getDetails;
  const readLinks = options.readLinks || franchise.readLinks;
  const nowMs = typeof options.now === 'function' ? options.now() : Date.now();
  // The 90-day links TTL is the same knob the writer uses (`franchise.js`);
  // without it `links.fresh` and `pending.wikidata` would always say «fresh».
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
      // M6 follow-up: GOG/Epic-only works are part of `gamesTotal` (they are
      // owned works of the same owner), reported here as their own number.
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
      // A game can have a WD QID but no P179 — that is a real «no franchise»
      // answer, not a missing one; `links.fresh` is the 90-day cache signal.
      links: { ...linksCoverage, ttlDays: ttlMs ? Math.round(ttlMs / 86400000) : null },
      releaseYears: release,
    },
    pending: {
      // Games the WD pass has not answered inside the TTL (the route may kick).
      wikidata: pendingWikidata,
      // B6: `qid: null` rows whose base version is still unknown (the bridge
      // runs in the same job, so this is part of the same kick decision).
      bridge: bridgePending,
      // M6 follow-up: secondary-only works whose P179 answer is not cached
      // yet. The franchise job asks them in the same pass, so this is the
      // lazy-kick signal for a deploy that happened after the last import.
      secondary: secondaryFranchisePending,
      // Games with no year from either source.
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
