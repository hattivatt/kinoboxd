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

const MIN_HEURISTIC_GAMES = 2;
const EDITION_SUFFIXES = [
  'enhanced edition',
  'complete edition',
  'definitive edition',
  'ultimate edition',
  'deluxe edition',
  'game of the year edition',
  'goty edition',
  'remastered',
  'legacy',
];
/** Bases that are too generic to be a franchise on their own. */
const STOP_BASES = new Set(['the', 'a', 'an', 'game', 'games', 'collection', 'series']);
/** False pairs from ИГРЫ §2.5/§4.4 — never merge even if a future fuzzy pass tries. */
const BLACKLIST_PAIRS = [
  ['dark souls', 'darkest dungeon'],
  ['hitman', "hitman's bodyguard"],
];

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function normalizeTitle(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[™®©]/g, ' ')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function stripEdition(text) {
  let out = text;
  for (const suffix of EDITION_SUFFIXES) {
    if (out.endsWith(` ${suffix}`)) {
      out = out.slice(0, -(suffix.length + 1)).trim();
      break;
    }
  }
  return out;
}

/**
 * Normalised franchise head of a game title:
 *   "The Witcher 3: Wild Hunt"        → "the-witcher"
 *   "Fallout: New Vegas PCR"          → "fallout"
 *   "Sid Meier's Civilization V"      → "sid-meier-s-civilization"
 *   "Half-Life 2: Deathmatch"         → "half-life"
 * Returns null when the head is too short/generic to be a franchise.
 */
function heuristicBase(name) {
  let text = normalizeTitle(name);
  if (!text) return null;
  // Subtitle cut: ":" and spaced dashes. «Half-Life» keeps its hyphen.
  text = text.split(/\s*:\s*|\s+[\u2013\u2014]\s+|\s+-\s+/)[0].trim();
  text = stripEdition(text);
  // Trailing sequence marker: "Civilization IV", "Fallout 4", "Grand Theft Auto V".
  const stripped = text.replace(/\s+(?:[ivxlcdm]+|\d{1,3})$/i, '').trim();
  if (stripped && stripped.length >= 3) text = stripped;
  if (!text || text.length < 3) return null;
  const slug = text
    .replace(/[^a-z0-9\u0400-\u04ff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || STOP_BASES.has(slug)) return null;
  return slug;
}

const SMALL_WORDS = new Set(['of', 'the', 'and', 'in', 'on', 'at', 'to', 'for', 'a', 'an']);

function humanizeBase(slug) {
  const words = String(slug || '').split('-').filter(Boolean);
  return words
    .map((word, index) =>
      index > 0 && SMALL_WORDS.has(word)
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join(' ');
}

function blacklisted(a, b) {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  return BLACKLIST_PAIRS.some(
    ([x, y]) => (left.includes(x) && right.includes(y)) || (left.includes(y) && right.includes(x))
  );
}

function groupIsBlacklisted(members) {
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      if (blacklisted(members[i].name, members[j].name)) return true;
    }
  }
  return false;
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
  const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Number(options.ttlMs) : null;

  const profile = getProfile(parsed.userKey);
  const library = getLibrary(parsed.userKey);
  if (!profile || !library) return null;

  const games = [];
  const release = { fromDetails: 0, fromWikidata: 0, unknown: 0, unavailableDetails: 0 };
  const linksCoverage = { documents: 0, withQid: 0, withFranchise: 0, withReleaseYear: 0, fresh: 0 };

  for (const game of library.games || []) {
    const appid = Number(game.appid);
    if (!Number.isInteger(appid) || appid <= 0) continue;
    const details = readDetails(appid);
    if (details && details.success !== false && details.type && details.type !== 'game') continue;
    if (details && details.success === false) release.unavailableDetails++;

    const links = readLinks(appid) || {};
    if (links.resolved || links.qid || links.franchise || links.releaseYear) linksCoverage.documents++;
    if (links.qid) linksCoverage.withQid++;
    if (links.franchiseKey || links.franchise) linksCoverage.withFranchise++;
    if (links.releaseYear) linksCoverage.withReleaseYear++;
    const linksAt = Date.parse(String(links.fetchedAt || ''));
    const linksFresh =
      Boolean(links.resolved) &&
      (ttlMs == null
        ? true
        : Number.isFinite(linksAt) && nowMs - linksAt >= 0 && nowMs - linksAt < ttlMs);
    if (linksFresh) linksCoverage.fresh++;

    let releaseYear = null;
    let releaseSource = null;
    const detailYear = details && details.success !== false ? details.releaseYear : null;
    if (Number.isInteger(Number(detailYear)) && Number(detailYear) > 0) {
      releaseYear = Number(detailYear);
      releaseSource = 'steam-store';
      release.fromDetails++;
    } else if (Number.isInteger(Number(links.releaseYear)) && Number(links.releaseYear) > 0) {
      releaseYear = Number(links.releaseYear);
      releaseSource = 'wikidata';
      release.fromWikidata++;
    } else {
      release.unknown++;
    }

    const wdFranchise = links.franchise;
    const wdKey = links.franchiseKey || (wdFranchise && wdFranchise.qid ? `wd:${wdFranchise.qid}` : null);
    games.push({
      appid,
      name: (details && details.name) || game.name || null,
      hours: round1((Number(game.playtime_forever) || 0) / 60),
      releaseYear,
      releaseSource,
      releasePrecision:
        releaseSource === 'steam-store'
          ? details.releasePrecision || null
          : releaseSource === 'wikidata'
            ? links.releasePrecision || null
            : null,
      // Did Wikidata answer inside the TTL? (independent of whether P179/P577
      // were found: a negative answer is still an answer).
      wdResolved: Boolean(links.resolved),
      wdFresh: linksFresh,
      // WD assignment; the heuristic is applied below, after grouping.
      wdKey,
      wdFranchise: wdKey
        ? {
            key: wdKey,
            label: (wdFranchise && (wdFranchise.labelEn || wdFranchise.labelRu)) || null,
            labelRu: (wdFranchise && wdFranchise.labelRu) || null,
            confidence: 'high',
          }
        : null,
    });
  }

  // ---- minimal title heuristic (only for games Wikidata did not place) ----
  const groups = new Map();
  for (const game of games) {
    if (game.wdKey || !game.name) continue;
    const base = heuristicBase(game.name);
    if (!base) continue;
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(game);
  }
  for (const [base, members] of groups) {
    if (members.length < MIN_HEURISTIC_GAMES) continue;
    if (groupIsBlacklisted(members)) continue;
    for (const game of members) {
      game.heuristicKey = `title:${base}`;
      game.heuristicLabel = humanizeBase(base);
    }
  }

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
          .slice()
          .sort((a, b) => b.hours - a.hours || a.appid - b.appid)
          .map((game) => game.appid),
        games: bucket.games
          .slice()
          .sort((a, b) => b.hours - a.hours || a.appid - b.appid)
          .map((game) => ({
            appid: game.appid,
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

  const gamesTotal = games.length;
  const percent = gamesTotal ? round1((gamesWithFranchise / gamesTotal) * 100) : 0;
  const pendingWikidata = games.filter((game) => !game.wdFresh).length;

  return {
    profile: parsed.key,
    franchises,
    totals: {
      franchises: franchises.length,
      gamesTotal,
      gamesInFranchises: franchises.reduce((sum, entry) => sum + entry.gamesCount, 0),
      hoursInFranchises: round1(franchises.reduce((sum, entry) => sum + entry.hoursSum, 0)),
      hoursTotal: round1(games.reduce((sum, game) => sum + game.hours, 0)),
    },
    coverage: {
      gamesTotal,
      gamesWithFranchise,
      percent,
      bySource,
      // A game can have a WD QID but no P179 — that is a real «no franchise»
      // answer, not a missing one; `links.fresh` is the 90-day cache signal.
      links: { ...linksCoverage, ttlDays: ttlMs ? Math.round(ttlMs / 86400000) : null },
      releaseYears: release,
    },
    pending: {
      // Games the WD pass has not answered inside the TTL (the route may kick).
      wikidata: pendingWikidata,
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
      yearsSource: ['steam-store', 'wikidata'],
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
