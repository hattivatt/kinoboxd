'use strict';

/**
 * Declarative source table: the single place that says how politely each
 * external endpoint may be asked.
 *
 * The values are TRANSCRIBED from the constants the modules carried before
 * this phase — nothing is "improved" here. `AGENTS.md` §1 remains the prose
 * reference; `contracts/limits.md` (P9) is meant to be generated from this
 * file.
 *
 * **Env convention (shared with `core/env.js`): `0` means «off», an unset /
 * empty variable means the value in this table.**
 *
 *   pause 0    -> no pause            budget 0  -> zero requests
 *   TTL 0      -> always stale        breaker 0 -> no cooldown
 *   timeout 0  -> no deadline
 *
 * The only known deviation is `GAMES_FRANCHISE_BUDGET=0`: `franchise.js`
 * applies `Math.max(1, …)`, so it still asks one question (pre-existing, kept
 * on purpose and marked at the call site).
 *
 * Entry shape:
 *
 *   id            stable key used by callers
 *   host          the host the breaker is keyed by (or a descriptive label)
 *   pauseMs       default spacing between requests (0 = no pause)
 *   pauseMaxMs    upper bound when the source wants a random pause
 *   pauseEnv      env override for `pauseMs`
 *   timeoutMs     request timeout
 *   timeoutEnv    env override for `timeoutMs`
 *   budgetEnv     per-run budget env (absent = the source has no budget)
 *   budgetDefault default when the env is unset
 *   breakerMs     breaker window (null = the source has no breaker)
 *   breakerEnv    env override for `breakerMs`
 *   ttlMs         freshness window (null = owned elsewhere / no TTL)
 *   ttlEnv        env override for `ttlMs`
 *   userAgent     the UA string the source sends
 *   note          why a value is what it is / who still owns the runtime
 *
 * TTL caveat (P5/P6 scope): for the games domain the runtime TTL still lives
 * in `games/game-cache.js` and the secondary-details module. The values below
 * mirror those constants so the table is complete; this phase does not move
 * the runtime owner.
 */

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BREAKER_30M = 30 * MINUTE_MS;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SOURCES = Object.freeze({
  /* ---------------------------- films ---------------------------- */
  tmdb: {
    id: 'tmdb',
    host: 'api.themoviedb.org',
    pauseMs: 0,
    timeoutMs: 20000,
    concurrency: 12,
    // 4 transport retries are implied by `retryDelaysMs.length`; no separate
    // field, so P9 does not generate a phantom knob.
    retryDelaysMs: [1000, 2000, 4000, 8000],
    rateLimitRetries: 5,
    budgetEnv: null,
    breakerMs: null,
    ttlMs: null,
    userAgent: null,
    note: 'Bearer token, 12-way semaphore, 4 transport retries + 5 rate-limit retries (tmdb.js).',
  },
  kinopoisk: {
    id: 'kinopoisk',
    host: 'www.kinopoisk.ru',
    pauseMs: 1500,
    pauseMaxMs: 2500,
    timeoutMs: 30000,
    maxRedirects: 10,
    budgetEnv: null,
    breakerMs: null,
    ttlMs: null,
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    note: 'Manual redirect hops carry the cookie jar; random 1.5-2.5 s page delay; UA is the pre-P2 kp.js fingerprint (Chrome/128).',
  },
  wdqs: {
    id: 'wdqs',
    host: 'query.wikidata.org',
    pauseMs: 1200,
    timeoutMs: 120000,
    batchSize: 450,
    maxAttempts: 8,
    baseBackoffMs: 2000,
    maxBackoffMs: 60000,
    outageGapMs: MINUTE_MS,
    budgetEnv: null,
    breakerMs: null,
    ttlMs: null,
    userAgent: 'kinoboxd/1.0 (https://github.com/hattivatt/kinoboxd); contact: github issue',
    note: 'POST SPARQL, batches of 450, Retry-After honoured; during an outage no more than 1 request/min.',
  },
  wikidataLabels: {
    id: 'wikidataLabels',
    host: 'www.wikidata.org',
    pauseMs: 0,
    timeoutMs: 120000,
    batchSize: 50,
    maxAttempts: 3,
    budgetEnv: null,
    breakerMs: null,
    ttlMs: null,
    userAgent: 'kinoboxd/1.0 (https://github.com/hattivatt/kinoboxd); contact: github issue',
    note: 'P144 type labels, batches of 50.',
  },
  wikidataPersonnel: {
    id: 'wikidataPersonnel',
    host: 'query.wikidata.org',
    pauseMs: 1100,
    timeoutMs: 60000,
    batchSize: 450,
    cooldownMs: BREAKER_30M,
    minOutageGapMs: MINUTE_MS,
    maxFailures: 3,
    budgetEnv: null,
    breakerMs: BREAKER_30M,
    ttlMs: null,
    userAgent: 'kinoboxd/1.0 (games personnel; https://github.com/hattivatt/kinoboxd)',
    // Not yet wired: `games/personnel/wikidata.js` still owns these constants.
    // Kept here as the transcription for P9; do not treat it as a runtime
    // override until that module reads this entry.
    note: 'Games personnel WDQS client (own persisted cooldown in personnel-wikidata.json); NOT YET WIRED.',
  },
  wikidataFranchise: {
    id: 'wikidataFranchise',
    host: 'query.wikidata.org',
    pauseMs: 1100,
    timeoutMs: 60000,
    batchSize: 450,
    budgetEnv: 'GAMES_FRANCHISE_BUDGET',
    budgetDefault: 450,
    breakerMs: BREAKER_30M,
    ttlEnv: 'GAMES_FRANCHISE_TTL_DAYS',
    ttlMs: 90 * DAY_MS,
    userAgent: 'kinoboxd/1.0 (games personnel; https://github.com/hattivatt/kinoboxd)',
    note: 'Franchise bridge uses the personnel WDQS client; budget is one batch (450).',
  },

  /* ---------------------------- books ---------------------------- */
  livelib: {
    id: 'livelib',
    host: 'www.livelib.ru',
    pauseMs: 1500,
    pauseMaxMs: 2500,
    // The card provider always used a fixed 2 s (pre-P2 `livelib-card.js`);
    // the 1.5-2.5 s random range belongs to the bulk import.
    cardPauseMs: 2000,
    timeoutMs: 45000,
    maxRedirects: 5,
    budgetEnv: 'BOOKS_LIVELIB_CARD_BUDGET',
    budgetDefault: 300,
    breakerMs: BREAKER_30M,
    ttlMs: null,
    userAgent: BROWSER_UA,
    note: 'Bulk import + card provider; random 1.5-2.5 s pause, DDoS-Guard 403 trips the card breaker.',
  },
  hardcover: {
    id: 'hardcover',
    host: 'api.hardcover.app',
    pauseMs: 1100,
    minIntervalMs: 1100,
    maxPerMinute: 55,
    windowMs: MINUTE_MS,
    timeoutMs: 30000,
    maxTransportAttempts: 3,
    budgetEnv: null,
    breakerMs: null,
    ttlMs: null,
    userAgent: null,
    note: 'Free plan: 55 req/min, 5000/day; local rate gate, 429 blocks for Retry-After.',
  },
  litres: {
    id: 'litres',
    host: 'api.litres.ru',
    pauseMs: 2000,
    timeoutMs: 15000,
    budgetEnv: 'BOOKS_LITRES_BUDGET',
    budgetDefault: 200,
    breakerMs: BREAKER_30M,
    ttlMs: null,
    userAgent: 'Calibre-Web-Litres-Provider/2.0',
    note: 'Unofficial Foundation API, no key; 2 s pause, 403/429 -> 30 min breaker.',
  },
  googlebooks: {
    id: 'googlebooks',
    host: 'www.googleapis.com',
    pauseMs: 400,
    timeoutMs: 15000,
    budgetEnv: 'BOOKS_GB_BUDGET',
    budgetDefault: 300,
    breakerMs: BREAKER_30M,
    ttlMs: null,
    userAgent: null,
    note: 'Free tier with optional key; 400 ms pause, 403/429 -> 30 min breaker.',
  },
  openlibrary: {
    id: 'openlibrary',
    host: 'openlibrary.org',
    pauseMs: 250,
    timeoutMs: 15000,
    budgetEnv: null,
    breakerMs: null,
    ttlMs: null,
    userAgent: null,
    note: 'Public read-only API; 250 ms pause.',
  },
  wikidataBooks: {
    id: 'wikidataBooks',
    host: 'query.wikidata.org',
    pauseMs: 1200,
    // WDQS answers 504 after ~60 s on a query it cannot plan; a 30 s client
    // deadline plus 3 attempts bounds one bad batch to ~1.5 min, after which
    // the breaker stops the rest of the pass.
    timeoutMs: 30000,
    batchSize: 12,
    maxAttempts: 3,
    baseBackoffMs: 4000,
    maxBackoffMs: 30000,
    budgetEnv: 'BOOKS_WIKIDATA_BUDGET',
    budgetDefault: 300,
    breakerMs: BREAKER_30M,
    ttlMs: null,
    userAgent: 'kinoboxd/1.0 (books first-publication year; https://github.com/hattivatt/kinoboxd)',
    note: 'WDQS label batch: one query covers up to `batchSize` titles, budget counts books, 429/504 -> 30 min breaker.',
  },

  /* ---------------------------- games ---------------------------- */
  steam: {
    id: 'steam',
    host: 'api.steampowered.com',
    // Declarative only: the Web API path never awaits a pause, so no module
    // reads `pauseMs('steam')` today (the community path reads
    // `steamCommunity.pauseMs`). Not yet wired.
    pauseMs: 0,
    timeoutEnv: 'GAMES_STEAM_TIMEOUT_MS',
    timeoutMs: 20000,
    budgetEnv: null,
    breakerEnv: 'GAMES_STEAM_BREAKER_MS',
    breakerMs: BREAKER_30M,
    ttlMs: null,
    userAgent: 'kinoboxd/1.0 (+games-tab)',
    note: 'Web API (key required for the library); no pause between API calls, 429 trips the host breaker.',
  },
  steamCommunity: {
    id: 'steamCommunity',
    host: 'steamcommunity.com',
    pauseEnv: 'GAMES_STEAM_COMMUNITY_PAUSE_MS',
    pauseMs: 2000,
    timeoutEnv: 'GAMES_STEAM_TIMEOUT_MS',
    timeoutMs: 20000,
    budgetEnv: null,
    breakerEnv: 'GAMES_STEAM_BREAKER_MS',
    breakerMs: BREAKER_30M,
    ttlMs: null,
    userAgent: 'kinoboxd/1.0 (+games-tab)',
    note: 'Community XML: 2 s pause, 403/429/Cloudflare -> 30 min breaker.',
  },
  steamStore: {
    id: 'steamStore',
    host: 'store.steampowered.com',
    pauseEnv: 'GAMES_STORE_PAUSE_MS',
    pauseMs: 1700,
    timeoutEnv: 'GAMES_STEAM_TIMEOUT_MS',
    timeoutMs: 20000,
    budgetEnv: 'GAMES_STORE_BUDGET',
    budgetDefault: 340,
    breakerEnv: 'GAMES_STORE_BREAKER_MS',
    breakerMs: BREAKER_30M,
    ttlEnv: 'GAMES_STORE_TTL_MS',
    ttlMs: 180 * DAY_MS,
    userAgent: 'kinoboxd/1.0 (+games-tab)',
    note: 'appdetails, one appid per request; runtime TTL still owned by game-cache.js.',
  },
  steamSpy: {
    id: 'steamSpy',
    host: 'steamspy.com',
    pauseEnv: 'GAMES_SPY_PAUSE_MS',
    pauseMs: 1100,
    timeoutEnv: 'GAMES_SPY_TIMEOUT_MS',
    timeoutMs: 20000,
    budgetEnv: 'GAMES_SPY_BUDGET',
    budgetDefault: 340,
    breakerEnv: 'GAMES_SPY_BREAKER_MS',
    breakerMs: BREAKER_30M,
    ttlEnv: 'GAMES_SPY_TTL_MS',
    ttlMs: 30 * DAY_MS,
    userAgent: 'kinoboxd/1.0 (+games-tab)',
    note: 'SteamSpy asks for <=1 request/s; 1100 ms pause.',
  },
  steamReviews: {
    id: 'steamReviews',
    host: 'api.steampowered.com',
    breakerKey: 'api.steampowered.com/IUserReviewsService',
    pauseEnv: 'GAMES_REVIEWS_PAUSE_MS',
    pauseMs: 1700,
    timeoutEnv: 'GAMES_REVIEWS_TIMEOUT_MS',
    timeoutMs: 20000,
    budgetEnv: 'GAMES_REVIEWS_BUDGET',
    budgetDefault: 340,
    breakerEnv: 'GAMES_REVIEWS_BREAKER_MS',
    breakerMs: BREAKER_30M,
    ttlEnv: 'GAMES_REVIEWS_TTL_MS',
    ttlMs: 30 * DAY_MS,
    userAgent: 'kinoboxd/1.0 (+games-tab)',
    note: 'IUserReviewsService; own breaker key so a 429 does not freeze the Web API.',
  },
  steamBrowse: {
    id: 'steamBrowse',
    host: 'api.steampowered.com',
    // The per-asset hash of the new-schema vertical capsule is published only
    // by the store-frontend method `IStoreBrowseService/GetItems` (no key).
    // One request per appid per 180-day resolve, 150 ms apart.
    pauseEnv: 'GAMES_BROWSE_PAUSE_MS',
    pauseMs: 150,
    timeoutEnv: 'GAMES_BROWSE_TIMEOUT_MS',
    timeoutMs: 20000,
    budgetEnv: 'GAMES_BROWSE_BUDGET',
    budgetDefault: 340,
    breakerEnv: 'GAMES_BROWSE_BREAKER_MS',
    breakerMs: BREAKER_30M,
    ttlEnv: 'GAMES_ART_TTL_MS',
    ttlMs: 180 * DAY_MS,
    userAgent: 'kinoboxd/1.0 (+games-tab)',
    note: 'IStoreBrowseService: public store-frontend API, assets.library_capsule hash; breaker key api.steampowered.com/IStoreBrowseService.',
  },
  steamGridDb: {
    id: 'steamGridDb',
    host: 'www.steamgriddb.com',
    // Optional community grids for SKUs Steam publishes no vertical capsule
    // for. Without `STEAMGRIDDB_API_KEY` the provider is skipped silently.
    pauseEnv: 'GAMES_SGDB_PAUSE_MS',
    pauseMs: 1000,
    timeoutEnv: 'GAMES_SGDB_TIMEOUT_MS',
    timeoutMs: 20000,
    budgetEnv: 'GAMES_SGDB_BUDGET',
    budgetDefault: 50,
    breakerEnv: 'GAMES_SGDB_BREAKER_MS',
    breakerMs: BREAKER_30M,
    ttlMs: null,
    userAgent: 'kinoboxd/1.0 (+games-tab)',
    note: 'Optional artwork provider (key in STEAMGRIDDB_API_KEY): 1 s pause, 50 appids/run, 403/429 -> 30 min breaker.',
  },
  gog: {
    id: 'gog',
    host: 'api.gog.com',
    pauseEnv: 'GAMES_GOG_LIBRARY_PAUSE_MS',
    pauseMs: 400,
    playtimePauseEnv: 'GAMES_GOG_PLAYTIME_PAUSE_MS',
    playtimePauseMs: 500,
    timeoutEnv: 'GAMES_GOG_TIMEOUT_MS',
    timeoutMs: 20000,
    budgetEnv: 'GAMES_GOG_BUDGET',
    budgetDefault: 200,
    breakerEnv: 'GAMES_GOG_BREAKER_MS',
    breakerMs: BREAKER_30M,
    ttlMs: null,
    userAgent: 'kinoboxd/1.0 (+games-tab; gog)',
    note: 'Library 400 ms, playtime 500 ms; runtime TTLs owned by gog-cache.js.',
  },
  epic: {
    id: 'epic',
    host: 'account-public-service-prod03.ol.epicgames.com',
    pauseEnv: 'GAMES_EPIC_PAUSE_MS',
    pauseMs: 300,
    timeoutEnv: 'GAMES_EPIC_TIMEOUT_MS',
    timeoutMs: 20000,
    budgetEnv: null,
    breakerEnv: 'GAMES_EPIC_BREAKER_MS',
    breakerMs: BREAKER_30M,
    ttlMs: null,
    userAgent: 'kinoboxd/1.0 (+games-tab)',
    note: 'Account/library/catalog/entitlement hosts; 300 ms pause, 403/429 -> breaker.',
  },
  secondary: {
    id: 'secondary',
    host: 'api.gog.com',
    hosts: ['api.gog.com', 'store-content.ak.epicgames.com', 'store-content-ipv4.ak.epicgames.com'],
    pauseEnv: 'GAMES_SECONDARY_PAUSE_MS',
    pauseMs: 2000,
    epicPauseMs: 1500,
    timeoutEnv: 'GAMES_SECONDARY_TIMEOUT_MS',
    timeoutMs: 20000,
    budgetEnv: 'GAMES_SECONDARY_BUDGET',
    budgetDefault: 200,
    breakerEnv: 'GAMES_SECONDARY_BREAKER_MS',
    breakerMs: BREAKER_30M,
    ttlEnv: 'GAMES_SECONDARY_TTL_MS',
    ttlMs: 30 * DAY_MS,
    userAgent: BROWSER_UA,
    note: 'GOG v2 first, then Epic CMS; 2 s / 1.5 s pause; runtime TTL owned by secondary-details.js.',
  },
  moby: {
    id: 'moby',
    host: 'api.mobygames.com',
    pauseEnv: 'GAMES_MOBY_PAUSE_MS',
    pauseMs: 1100,
    timeoutMs: 30000,
    budgetEnv: 'GAMES_MOBY_BUDGET',
    budgetDefault: 100,
    breakerMs: BREAKER_30M,
    ttlMs: null,
    userAgent: null,
    note: '1.1 s pause, breaker state in moby-breaker.json (no env override).',
  },
});

const SOURCE_IDS = Object.freeze(Object.keys(SOURCES));

function getSource(id) {
  const entry = SOURCES[id];
  if (!entry) throw new Error(`unknown source: ${id}`);
  return entry;
}

/**
 * Finite non-negative env number, else fallback. Zero is a real value
 * («off»); an unset or empty variable is the fallback.
 */
function envNonNegative(name, fallback) {
  const value = process.env[name];
  if (value == null || String(value).trim() === '') return fallback;
  const raw = Number(value);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** Finite positive env number, else fallback (moby-style knobs). */
function envPositive(name, fallback) {
  const value = process.env[name];
  if (value == null || String(value).trim() === '') return fallback;
  const raw = Number(value);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function pauseMs(id) {
  const source = getSource(id);
  return source.pauseEnv ? envNonNegative(source.pauseEnv, source.pauseMs) : source.pauseMs;
}

function pauseMaxMs(id) {
  const source = getSource(id);
  return source.pauseMaxMs == null ? null : source.pauseMaxMs;
}

function timeoutMs(id) {
  const source = getSource(id);
  return source.timeoutEnv ? envNonNegative(source.timeoutEnv, source.timeoutMs) : source.timeoutMs;
}

function breakerMs(id) {
  const source = getSource(id);
  if (source.breakerMs == null) return null;
  return source.breakerEnv ? envNonNegative(source.breakerEnv, source.breakerMs) : source.breakerMs;
}

function budgetLimit(id) {
  const source = getSource(id);
  if (!source.budgetEnv) return null;
  return envNonNegative(source.budgetEnv, source.budgetDefault);
}

function ttlMs(id) {
  const source = getSource(id);
  if (source.ttlMs == null) return null;
  if (!source.ttlEnv) return source.ttlMs;
  if (source.ttlEnv.endsWith('_DAYS')) {
    return envNonNegative(source.ttlEnv, source.ttlMs / DAY_MS) * DAY_MS;
  }
  return envNonNegative(source.ttlEnv, source.ttlMs);
}

function userAgent(id) {
  return getSource(id).userAgent;
}

function hostOf(id) {
  return getSource(id).host;
}

module.exports = {
  SOURCES,
  SOURCE_IDS,
  getSource,
  envNonNegative,
  envPositive,
  pauseMs,
  pauseMaxMs,
  timeoutMs,
  breakerMs,
  budgetLimit,
  ttlMs,
  userAgent,
  hostOf,
  MINUTE_MS,
  DAY_MS,
  BREAKER_30M,
};
