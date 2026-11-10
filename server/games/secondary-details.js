'use strict';

/**
 * Store metadata for **secondary-only** works (M6d, ИГРЫ §14) — job, status
 * and the public facade of the secondary-library pipeline.
 *
 * A GOG/Epic game that has no Steam twin has no `details/<appid>.json`, so the
 * genre wall / year chart / decade chart had nothing to draw for it and the
 * «Вне Steam» card had no vertical poster. The pipeline fetches the *public*
 * store metadata of those games and normalizes it into one shape
 * (`secondary/normalize.js`), resolves identity/union once
 * (`secondary/index.js`) and keeps the cache/breaker/ledger in
 * `secondary/store.js`.
 *
 * **This file is the public facade only.** The pipeline lives in the
 * `secondary/details-*.js` modules — config (budget/pause/cooldown), state
 * (job maps, kick ledger, coverage memo), the job loop and its phases, the
 * per-owner targets, the coverage/status counters and the kick gate. The
 * export surface below is what `stats.js`, the routes and the tests import;
 * it is a contract, not a directory listing.
 *
 * Status machine (unchanged, byte-for-byte in the payload):
 *   - a running job makes `meta.secondaryDetails.running` true;
 *   - `resolved` counts a detail whose **facts** arrived (year + genres for
 *     Epic), `partial` a document with only one of them, `pending` a work with
 *     no detail yet, `unavailable` a settled negative;
 *   - the kick rule is `resolved < total || partial > 0 || healable > 0 ||
 *     noSlug > 0` (`coverageNeedsKick`), refined by the cache so an
 *     already-attempted work is not re-kicked every poll;
 *   - a `partial` whose catalog answer is still due (`retryablePartial`) stays
 *     kickable; a settled `shape_ok` partial does not burn a request per poll;
 *   - a `partial` whose missing fact is already in the identity bridge
 *     (`healable`: a `P577` year or a `P136` genre line waiting in
 *     `links/secondary.json`) is kickable too — the job's heal branch writes it
 *     from the cache with **no** request, and the counter drops to 0 afterwards.
 *
 * Politeness (§14.5): one request per product, pause `GAMES_SECONDARY_PAUSE_MS`
 * (default **2 s**, GOG's undocumented ~200 req/h/IP limit is the reference),
 * budget `GAMES_SECONDARY_BUDGET` (default **200** requests/run, GOG first then
 * Epic), 30-minute breaker on `403`/`429`. A network/5xx answer is **deferred**
 * (nothing is cached, the previous detail stays), a `404` is a negative cache
 * entry (`not_found`, 30 days) — the same «unknown ≠ empty» rule as everywhere
 * else in the games tab. A **guessed** slug (title probe) that 404s is cached
 * with `probe: true` for `GAMES_SECONDARY_PROBE_TTL_MS` (7 days).
 *
 * Cache paths and document formats are unchanged (see `secondary/store.js`):
 * `cache-games/secondary-details/<source>-<id>.json`, TTL 30 days, resumable
 * by construction (each product is its own file, so an interrupted run
 * continues where it stopped).
 *
 * Secrets: none. These endpoints are public and the module never reads a token
 * file. The catalog fallback uses the **owner's** Epic token through
 * `epic-token-store` and never echoes a value.
 */

const {
  CACHE_DIR,
  DEBUG_DIR,
  CATALOG_PROBE_DIR,
  CATALOG_STATE_PATH,
  STATUS_PATH,
  readCatalogProbe,
  writeCatalogProbe,
  writeCatalogState,
  readCatalogAttempt,
  recordCatalogAttempt,
  readDetail,
  writeDetail,
  readDetailsIndex,
  writeBreaker,
  breakerBlock,
  readStatusState,
} = require('./secondary/store');
const {
  yearOfDate,
  absoluteUrl,
  normalizeGogProduct,
  normalizeEpicProduct,
  pickEpicPage,
  epicTagName,
  epicGenresFromCategories,
  sanitizeEpicGenres,
  sanitizeDetailGenres,
  catalogAnswersMissing,
  catalogMetaFlags,
  slugFromTitle,
} = require('./secondary/normalize');
const { refetchEpicCatalog, resolveEpic } = require('./sources/epic');
const { resolveGog } = require('./sources/gog');
const {
  applyWikidataYear,
  applyWikidataFacts,
  enrichUnionWithDetails,
} = require('./secondary/enrich');
const { startSecondaryDetails, runningFor, jobFor } = require('./secondary/details-job');
const {
  kickGate,
  kickSecondaryDetailsQuietly,
  kickFromStats,
} = require('./secondary/details-kick');
const {
  coverageNeedsKick,
  coverageForOwner,
} = require('./secondary/details-coverage');
const { titleCandidatesFor } = require('./secondary/details-run');
const { statusForOwner } = require('./secondary/details-status');
const { targetsForOwner } = require('./secondary/details-targets');
const { resetJobs } = require('./secondary/details-state');

module.exports = {
  CACHE_DIR,
  DEBUG_DIR,
  CATALOG_PROBE_DIR,
  CATALOG_STATE_PATH,
  STATUS_PATH,
  yearOfDate,
  absoluteUrl,
  normalizeGogProduct,
  normalizeEpicProduct,
  pickEpicPage,
  epicTagName,
  epicGenresFromCategories,
  sanitizeEpicGenres,
  sanitizeDetailGenres,
  catalogAnswersMissing,
  catalogMetaFlags,
  refetchEpicCatalog,
  readCatalogProbe,
  writeCatalogProbe,
  writeCatalogState,
  readCatalogAttempt,
  recordCatalogAttempt,
  applyWikidataYear,
  applyWikidataFacts,
  slugFromTitle,
  readDetail,
  writeDetail,
  readDetailsIndex,
  enrichUnionWithDetails,
  writeBreaker,
  breakerBlock,
  readStatusState,
  resolveGog,
  resolveEpic,
  startSecondaryDetails,
  kickSecondaryDetailsQuietly,
  kickGate,
  kickFromStats,
  coverageNeedsKick,
  coverageForOwner,
  titleCandidatesFor,
  statusForOwner,
  runningFor,
  jobFor,
  targetsForOwner,
  resetJobs,
};
