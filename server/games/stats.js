'use strict';

/**
 * `/api/games/stats` payload (M1 + M2).
 *
 * One profile = one owner (one steamid64). Nothing is ever summed across two
 * Steam accounts (AGENTS.md §6, ИГРЫ §2.0): the route requires exactly one
 * `?profile=steam-<steamid64>` token and this module builds the payload from
 * that profile's library snapshot only.
 *
 * M1 fields are exactly the ones the imported data supports:
 *   - summary: owned/played/backlog counts, total/mean/median hours, Pareto
 *     top-10% share, 2-week hours, last-played timestamp;
 *   - gamesIndex: a light `appid → entry` map (as `booksIndex` in the books
 *     payload — the frontend reads it with `Object.values`);
 *   - topGames / recentlyPlayed / recently2w / backlog / hoursHistogram;
 *   - achievements: completion and rare unlocked counts from the achievements
 *     cache; timeline/achievementDays/streaks appear as soon as at least one
 *     game's XML was cached (the per-game endpoint fills it lazily).
 *
 * M2 (after `POST /api/games/enrich` has written `details/<appid>.json`):
 *   - `type` separates games from DLC/demo/software/video, so `gameCount` is
 *     real (`gameCountEstimated` flips to false once every appid has details);
 *   - `years`/`decades` bucket by `releaseYear` (unknown year is an explicit
 *     last bucket, never a fake 0; no ancient bucket — games are 1970..2100);
 *   - `genres` is the playtime-weighted wall (`count`/`hours`/`weight`/`share`);
 *   - `summary.modes`/`earlyAccess`/`freeToPlay`/`platforms`/`metadata` from
 *     categories/is_free/platforms and the details coverage;
 *   - `includeFree`/`includeDlc` are REAL filters (`meta.filters.applied:true`):
 *     includeDlc=0 drops `type!=="game"` (DLC/demo/software/video),
 *     includeFree=0 drops `is_free===true`. Unknown type is always kept.
 *
 * Without details every M2 bucket stays empty/null and `meta.pending` says
 * why — the payload is exactly M1, never invented data.
 *
 * M5-B (editions + hours filter):
 *   - every aggregate counts a **canonical work** once
 *     (`cache-games/editions.json`): `The Elder Scrolls V: Skyrim` + `…
 *     Special Edition`, `GTA V Legacy` + `GTA V Enhanced`, regional cards and
 *     catalog duplicates (`Wasteland 2` / `… Director's Cut`) are one game;
 *   - `gamesIndex` still keeps every appid (the library table must not lose
 *     rows) and adds `canonicalWorkKey`/`primaryAppid`/`isPrimary`/
 *     `editionCount`/`canonicalHours`;
 *   - `minHours` (-1 all, 0 played only, N≥1 at least N hours) runs after the
 *     type/free filters and after the edition merge, so a work with a 0-hour
 *     edition and a played edition stays when its canonical hours pass.
 *
 * Hours come only from `GetOwnedGames` (`playtime_forever`, minutes).
 * `<stats><hoursPlayed>` from the achievements XML is never aggregated: it is
 * "time under stats tracking", not full playtime (§2.1 п. 3).
 *
 * M6c (GOG/Epic as same-owner secondary libraries, 01.11.2026):
 *   - the union (`secondary/union.js`) joins GOG/Epic products to Steam works
 *     by `workKey` (Wikidata P2725/P6278 → P1733, then an exact title match);
 *   - a work that exists **only** outside Steam is a real owned game: it is
 *     counted in `gameCount`/`worksTotal`, its hours go into `totalHours`,
 *     its release year into `years`/`decades`, its genres into `genres` (when
 *     the store knows one), and it gets its own row in `topGames`/`backlog`/
 *     `gamesIndex` (`appid: null`, `secondaryOnly: true`);
 *   - `summary.hoursBySource` keeps one number per store (`steam` = the Steam
 *     journal total) and `all` = the display sum (Steam + GOG + Epic of the
 *     same works). Steam-only facts (achievements, `lastPlayed`, SteamSpy
 *     tags, review scores, completion) stay Steam-only — no invented data;
 *   - `minHours` never drops a secondary work whose hours the store never
 *     answered for (`hoursUnknown`, `hoursStatus: pending|unknown`); a real
 *     0-hour secondary work is filtered exactly like a Steam work.
 */

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

/**
 * Build the payload. Pure: the caller supplies the library snapshot, the
 * profile document, cached achievement documents and global percentages.
 *
 * Edition aggregation (M5-B): the payload counts **canonical works**, not
 * appids. `input.editions` is the persisted `cache-games/editions.json`
 * document (see `editions.js`); when it is missing or does not cover the
 * library rows, the index is rebuilt here so the builder stays pure. Every
 * aggregate (gameCount, hours, Pareto, genres, years/decades, tags, scores,
 * DLC, completion, franchises) iterates works once. `gamesIndex` still has
 * every owned appid (the library table must not lose rows); each entry carries
 * `canonicalWorkKey` / `primaryAppid` / `isPrimary` / `canonicalHours` so the
 * frontend can group without re-deriving anything.
 *
 * `minHours` (M5-B): -1 = every game (including 0-hour backlog), 0 = only
 * works with >0 hours, N≥1 = works with at least N hours. The HTTP route
 * defaults to 0; the pure builder defaults to -1 so internal callers that do
 * not care about the filter keep the full payload.
 */
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
    // M1 has no `type` in GetOwnedGames: ownedCount is the honest number,
    // gameCount is an estimate until appdetails (M2) separates DLC/tools.
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
    // M2/M3 buckets — present as empty arrays so the frontend never has to
    // guess, but never filled with invented data.
    genres: aggregates.genres,
    tags: aggregates.tags,
    // M4: nine Steam review-score levels, `[]` until a summary is cached.
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
    // M6a/M6c: entries that exist only outside Steam — GOG works (union by
    // `workKey`) followed by Epic games (`workKey: null`, no identity yet).
    // The list is capped for payload size; `summary.secondaryWorksTotal` is
    // the full count. Never merged into the Steam journal aggregates.
    // Payload contract (integration round): `hoursBySource` is in **hours**,
    // the display total is `displayHours`; the union's minute fields
    // (`steamMinutes`/`secondaryMinutes`/`displayMinutes`) stay internal and
    // never leak into the API. `null` means «the store did not answer».
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
      // M6d: vertical poster from the store product page (GOG box art,
      // Epic CMS portrait). `null` when the detail is not cached yet — the UI
      // falls back to the horizontal `gog.image`/`epic.image`.
      verticalCover: entry.verticalCover || null,
      image:
        entry.image ||
        (entry.gog && entry.gog.image) ||
        (entry.epic && entry.epic.image) ||
        null,
      genres: [...entry.genres],
      developers: [...entry.developers],
      publishers: [...entry.publishers],
      // M6 follow-up (03.11.2026): identity of a secondary-only work. `qid`
      // is the Wikidata item the bridge resolved; `franchise` is the P179
      // series (same shape as a Steam `gamesIndex` row), `null` when Wikidata
      // answered «no series» or has not been asked yet.
      qid: entry.qid || null,
      franchise: entry.franchise ? { ...entry.franchise } : null,
      metadataSources: [...entry.metadataSources],
      hours: round1(entry.secondaryMinutes / 60),
      secondaryHours: round1(entry.secondaryMinutes / 60),
      displayHours: round1(entry.displayMinutes / 60),
      hoursUnknown: Boolean(entry.hoursUnknown),
      hoursStatus: { ...entry.hoursStatus },
      secondaryOnly: true,
      // The UI's «Вне Steam» list reads `source` for the badge.
      source: entry.sources.includes('gog') ? 'gog' : 'epic',
    })),
    gog: gogSnapshots.length ? { ...union.summary, status: gogStatus } : null,
    // M6c: the Epic read model without per-game arrays (they are already in
    // `secondaryWorks`). `null` when no Epic account is bound to this owner.
    epic: epicLayer
      ? {
          contractVersion: epicLayer.contractVersion,
          status: epicSource.status,
          accountId: epicLayer.accountId || null,
          summary: epicLayer.summary,
          // Inside this payload the Steam side must be the **journal** total
          // (`summary.hoursBySource.steam`, games only), not the raw library
          // sum the layer computes on its own (`/api/games/epic/status`).
          hoursBySource: { steam: totalHours, epic: epicHoursValue },
          ownedBySource: { steam: ownedCount, epic: epicOwnedValue },
          meta: epicLayer.meta,
        }
      : null,
    // Works of the visible (filtered) set with no successful details.
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
/**
 * Load one profile from cache and build the payload.
 * Returns null when the token names no cached profile/library.
 */
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
  // M4-B: Wikidata links (franchise key + P577 year) for the games index.
  const links = franchise.readLinksMap(appids);
  // B6: appdetails of the base versions the label bridge resolved (the owner
  // does not own those cards — they live in `details-base/`).
  const baseAppids = [];
  for (const link of Object.values(links)) {
    if (link && link.baseAppid && !baseAppids.includes(link.baseAppid)) {
      baseAppids.push(link.baseAppid);
    }
  }
  const detailsBase = gameCache.listDetailsBase(baseAppids);
  // M5-B: canonical edition index. Persisted in `cache-games/editions.json`
  // (manual overrides survive); a read-only cache (worktree) still works —
  // the index is then rebuilt in memory for this request.
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
  // M6a: GOG is a same-owner secondary library. Only accounts explicitly
  // attached to THIS Steam owner are read — never another owner's token.
  // A disconnected account keeps its dated snapshot: the UI says «данные от
  // <дата>, требуется переподключение» instead of showing zeroes (§14.4 п. 7).
  const gogTokenAccounts = gogCache.accountsForOwner(profileKey);
  if (!gogTokenAccounts.length) {
    // A token written before the «one owner» rule (or restored from a backup)
    // has no `ownerProfile`; the library snapshot it wrote does. Adopting it
    // here is read-only and safe (an unbound token claims no other owner) and
    // stops the false «снимок от <дата> — подключите GOG заново» after a
    // successful import. The next import persists the binding for good.
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
  // M6d: store metadata of the secondary works (public GOG/Epic product pages,
  // cached 30 days). Collected from the same snapshots the union will read, so
  // the index never asks for a product that is not in the library.
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
    // M4 metadata: global per appid, no owner dimension.
    spy: gameCache.listSpy(appids),
    reviews: gameCache.listReviews(appids),
    links,
    // Vertical-art resolve documents (one per appid, 180/30-day TTL). Additive:
    // without them the index/rows keep the pre-resolve fields and the client
    // walks the legacy CDN chain.
    art: steamArt.listResolvedArt(appids),
    // B6: base-version metadata for regional SKUs (year/genres/studios/name).
    detailsBase,
    // M6a: GOG secondary library (ownership + its own hours, never summed).
    gogAccounts,
    gogSnapshots,
    gogConnected: gogTokenAccounts.length > 0,
    // M6c: the cached Wikidata bridge (`links/secondary.json`) written by the
    // import jobs. A read-only lookup — `/stats` never calls WDQS (§14.5).
    // Stale entries are still valid identity (a QID does not expire); an
    // absent file is `{}` and the union falls back to title/slug matching.
    secondaryLinks: readSecondaryLinks({ allowStale: true }),
    // M6 follow-up: title-matched identities (Epic exclusives such as Alan
    // Wake 2 are resolved by the exact-label pass, not by P6278). Read-only.
    secondaryTitleLinks: readSecondaryTitleLinks({ allowStale: true }),
    // M6b/M6c: Epic read model of the same owner. Built synchronously from the
    // cache (`buildEpicLayerSync`) because the stats route is synchronous and
    // polled; it reads only the redacted token summary, never a token value.
    // `null` when no Epic account is bound — `sources.epic` then reports
    // `not_connected` and `hoursBySource.epic` stays `null` (not 0).
    epic: epicLayerView,
    // M6d: cached store metadata for secondary-only works (genres/year/poster).
    secondaryDetails: secondaryDetailsIndex,
    secondaryDetailsRunning: secondaryDetailsRunning(profileKey),
    // M5-B: canonical works (one game per owner-visible title).
    editions: editionDoc,
    includeFree: options.includeFree !== false,
    includeDlc: Boolean(options.includeDlc),
    // M5-B: the route defaults to 0 (played games only); the pure builder
    // defaults to -1 (no filter) for internal callers.
    minHours: options.minHours,
    // Set by the route from the enrich job registry (no live request).
    enrichRunning: options.enrichRunning === true,
  });
}

/** Compact profile card for `/api/games/profiles`. */
function profileSummary(profile, library) {
  if (!profile) return null;
  const games = (library && Array.isArray(library.games) && library.games) || [];
  const minutes = games.reduce((sum, game) => sum + (Number(game.playtime_forever) || 0), 0);
  return {
    key: gameCache.profileKeyOf(profile.userKey),
    source: 'steam',
    userKey: profile.userKey,
    personaName: profile.personaName || null,
    // Additive: the owner-facing name from the import form (§5.4 `label`).
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
