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
 * **This file is the facade and the job.** The old export names keep working
 * (re-exports below) because `stats.js`, the routes and the tests import them;
 * the logic lives in the modules above.
 *
 * Status machine (unchanged, byte-for-byte in the payload):
 *   - a running job makes `meta.secondaryDetails.running` true;
 *   - `resolved` counts a detail whose **facts** arrived (year + genres for
 *     Epic), `partial` a document with only one of them, `pending` a work with
 *     no detail yet, `unavailable` a settled negative;
 *   - the kick rule is `resolved < total || partial > 0 || noSlug > 0`
 *     (`coverageNeedsKick`), refined by the cache so an already-attempted work
 *     is not re-kicked every poll;
 *   - a `partial` whose catalog answer is still due (`retryablePartial`) stays
 *     kickable; a settled `shape_ok` partial does not burn a request per poll.
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

const fs = require('fs');

const gogCache = require('./gog-cache');
const epicCache = require('./epic-cache');
const { envMs } = require('../core/env');
const sources = require('../core/sources');
const { SecondaryDetailsError, maskSecrets } = require('./secondary/errors');
const {
  nowMs,
  isoOf,
  slugFromTitle,
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
} = require('./secondary/normalize');
const {
  CACHE_DIR,
  DEBUG_DIR,
  CATALOG_PROBE_DIR,
  CATALOG_STATE_PATH,
  STATUS_PATH,
  MAX_STATUS_ERRORS,
  MAX_KICK_HISTORY,
  readDetail,
  writeDetail,
  readDetailsIndex,
  readCatalogProbe,
  writeCatalogProbe,
  readCatalogState,
  writeCatalogState,
  readCatalogAttempt,
  recordCatalogAttempt,
  catalogRetryDue,
  catalogCompletionState,
  shouldAttemptCatalog,
  catalogAttemptsForOwner,
  writeBreaker,
  breakerBlock,
  readStatusState,
  recordError,
  recordKick,
  recordSkip,
  recordRunFinished,
} = require('./secondary/store');
const { resolveGog } = require('./sources/gog');
const {
  refetchEpicCatalog,
  resolveEpic,
  createCatalogClient,
} = require('./sources/epic');
const {
  applyWikidataFacts,
  applyWikidataYear,
  enrichUnionWithDetails,
  refreshForJob,
} = require('./secondary');

const DEFAULT_BUDGET = sources.budgetLimit('secondary');
const DEFAULT_PAUSE_MS = sources.pauseMs('secondary');
const DEFAULT_EPIC_PAUSE_MS = sources.SOURCES.secondary.epicPauseMs;
const DEFAULT_KICK_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_SLUGLESS = 50;
const COVERAGE_MEMO_MS = 60 * 1000;

function budgetDefault() {
  return sources.budgetLimit('secondary');
}

function pauseMsFor(source) {
  const fallback = source === 'epic' ? DEFAULT_EPIC_PAUSE_MS : DEFAULT_PAUSE_MS;
  return sources.envNonNegative('GAMES_SECONDARY_PAUSE_MS', fallback);
}

function kickCooldownMs() {
  return envMs('GAMES_SECONDARY_KICK_COOLDOWN_MS', DEFAULT_KICK_COOLDOWN_MS);
}

/* ------------------------------------------------------------------ */
/* job                                                                 */
/* ------------------------------------------------------------------ */

const jobs = new Map();
const lastKick = new Map();
// `ownerKey → {at, pending}` — a *negative* coverage verdict, memoized because
// `/stats` is polled (see `kickFromStats`).
const coverageMemo = new Map();
let jobSeq = 0;

/** Latest kick of one owner, memory first, then the persisted ledger. */
function lastKickAtFor(ownerKey) {
  const key = String(ownerKey == null ? '' : ownerKey);
  const memory = lastKick.get(key);
  if (memory) return memory;
  const state = readStatusState();
  let latest = 0;
  for (const kick of state.kicks) {
    if (!kick || kick.ownerKey !== key) continue;
    if (kick.result === 'skipped') continue;
    const at = Date.parse(kick.at || '');
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  if (latest) lastKick.set(key, latest);
  return latest || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyPhase() {
  return {
    total: 0,
    resolved: 0,
    fetched: 0,
    notFound: 0,
    cached: 0,
    failed: 0,
    deferred: 0,
    // Works whose catalog step exited without asking (token binding, probe,
    // budget, no client). Visible so a «done in 1 s» job can explain itself.
    catalogSkipped: 0,
    // Works with no store slug at all: «library-only» (title + hours), never a
    // silent drop and never a fake `not_found`.
    missingSlug: 0,
  };
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    ownerKey: job.ownerKey,
    status: job.status,
    stage: job.stage,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    requests: job.requests,
    budget: job.budget,
    budgetExceeded: job.budgetExceeded,
    gog: { ...job.gog },
    epic: { ...job.epic },
    pending: Math.max(0, job.gog.total + job.epic.total - job.gog.resolved - job.epic.resolved),
    warnings: [...job.warnings],
  };
}

/** Running job for an owner (for `meta.secondaryDetails.running`). */
function runningFor(ownerKey) {
  const job = jobs.get(String(ownerKey == null ? '' : ownerKey));
  return Boolean(job && job.status === 'running');
}

function jobFor(ownerKey) {
  return publicJob(jobs.get(String(ownerKey == null ? '' : ownerKey)));
}

async function runPhase(job, source, targets, resolveOne) {
  const phase = job[source];
  phase.total = targets.length;
  for (const target of targets) {
    if (job.cancelled) break;
    if (job.requests >= job.budget) {
      job.budgetExceeded = true;
      job.warnings.push(`${source}_budget`);
      break;
    }
    const cached = readDetail(source, target.id);
    // A cached Epic detail that is still «poster only» (stale CMS page, no
    // catalog when it was written) is completed from the catalog with the
    // owner's token. This is not a CMS refetch: `resolveEpic` sees the fresh
    // document and only merges catalog fields into it.
    const completingCatalog =
      cached.fresh &&
      !job.force &&
      source === 'epic' &&
      cached.doc &&
      cached.doc.status === 'ok' &&
      target.catalogItemId &&
      shouldAttemptCatalog(cached.doc.data, {
        ownerKey: job.ownerKey,
        catalogItemId: target.catalogItemId,
      });
    if (cached.fresh && !job.force && !completingCatalog) {
      // A fresh document can still receive facts that appeared in the identity
      // bridge after it was written: a release year (the Alan Wake 2 heal) or
      // a P136 genre line when the store/catalog gave none (its stale CMS page
      // has only the `public` bucket, whose chip is filtered out on read since
      // 03.11.2026). This is a cache read + a write only when something was
      // actually filled; no network, no request counter.
      const cachedData = cached.doc && cached.doc.status === 'ok' ? cached.doc.data : null;
      const needsWikidataFacts = Boolean(
        cachedData &&
          (cachedData.releaseYear == null ||
            !(Array.isArray(cachedData.genres) && cachedData.genres.length))
      );
      if (source === 'epic' && needsWikidataFacts) {
        const healed = applyWikidataFacts(cachedData, {
          store: 'epic',
          slug: target.slug || target.id,
        });
        if (healed !== cachedData) {
          const flags = catalogMetaFlags(healed);
          writeDetail('epic', target.id, 'ok', {
            ...healed,
            metaStatus: flags.metaStatus,
            metaYearHas: flags.yearHas,
            metaGenresOk: flags.genresOk,
            metaCheckedAt: isoOf(nowMs()),
          });
          phase.resolved++;
          phase.cached++;
          continue;
        }
      }
      if (cached.doc.status === 'ok') phase.resolved++;
      else phase.notFound++;
      phase.cached++;
      continue;
    }
    try {
      if (!completingCatalog) job.requests++;
      const result = await resolveOne(target, {
        client: job.client,
        force: job.force,
        // A no-slug target needs a probe + a product page; both count.
        probeBudget: job.budget - job.requests + 1,
        canRequest: () => job.requests < job.budget,
        onWarning: (warning) => {
          if (warning) job.warnings.push(String(warning));
        },
        onCatalogDeferred: () => {
          phase.deferred++;
        },
        onRequest: () => {
          job.requests++;
        },
      });
      if (result.status === 'ok') {
        phase.resolved++;
        if (completingCatalog) phase.cached++;
        else phase.fetched++;
      } else if (result.status === 'not_found') {
        // `no_slug` is not a verdict about the product (it was never
        // addressed): it is already counted in `phase.missingSlug`.
        if (result.reason !== 'no_slug') {
          phase.notFound++;
          phase.fetched++;
        }
      }
      if (result.catalogSkipped) {
        // «The phase found the work, saw the catalog could help and did not
        // ask» must be a visible fact, not a fast `done`.
        phase.catalogSkipped++;
        const warning = `epic_catalog_${result.catalogSkipReason || result.catalogSkipped}`;
        if (!job.warnings.includes(warning)) job.warnings.push(warning);
      }
    } catch (err) {
      const code = (err && err.code) || 'secondary_details_error';
      // `cms_blocked` is the reason an edge refused the CMS — it must not be
      // reported as «no metadata» (ИГРЫ §14.5).
      const reason = (err && (err.breakerCode || err.reason)) || code;
      recordError({
        ownerKey: job.ownerKey,
        source,
        id: String(target.id || target.slug || ''),
        code,
        reason,
        status: err && err.status != null ? err.status : null,
        host: err && err.host ? err.host : null,
        message: maskSecrets((err && err.message) || '').slice(0, 200),
      });
      if (err && err.deferred) {
        phase.deferred++;
        job.warnings.push(`${source}_${reason}`);
        // A blocked/unreachable host is not a per-product failure: stop this
        // phase instead of hammering it for every remaining product.
        if (code === 'secondary_details_blocked') break;
      } else {
        phase.failed++;
        job.warnings.push(`${source}_${reason}`);
      }
    }
    if (job.requests < job.budget) await sleep(job.pauseMs);
  }
  if (source === 'epic' && phase.missingSlug > 0) {
    // Honest diagnostic: these works stay «library-only» (title + hours) —
    // not a `not_found` verdict about a product we never addressed.
    job.warnings.push('epic_no_slug');
  }
  job.stage = source === 'gog' ? 'epic' : 'done';
}

/**
 * Epic works that may still gain facts from a Wikidata title match: the store
 * and catalog gave no date, **or** the cached detail has no genre line (the
 * stale `public` bucket is filtered away on read, so the genre axis is empty).
 * Only these may be title-matched; a work with a store date and a store genre
 * line is never re-identified by title.
 *
 * Since 03.11.2026 a catalog date no longer stops the pass by itself: `P577`
 * and `P136` are independent facts of the item, so a dated Epic exclusive with
 * an empty genre line (Alan Wake 2) is a candidate too. This costs **no**
 * network when the title answer is already cached — `isSettledTitleEntry()`
 * filters it in `fetchSecondaryTitleLinks()` — and exactly one question when
 * the cache has no genre answer yet. A dated work with no cached detail
 * document is still skipped: there is no genre axis to judge before the
 * document exists, and the catalog date is trusted as before.
 */
function titleCandidatesFor(epic) {
  const out = [];
  for (const entry of Array.isArray(epic) ? epic : []) {
    if (!entry || !entry.slug || !entry.title) continue;
    // No catalog document means the store date is unknown; the import writes
    // one for every game, so wait for that instead of asking on a guess.
    if (!entry.catalog) continue;
    const hasCatalogDate = Boolean(entry.catalog.releaseDate);
    let cached = null;
    try {
      cached = readDetail('epic', entry.slug);
    } catch (err) {
      cached = null;
    }
    const data = cached && cached.doc && cached.doc.status === 'ok' ? cached.doc.data : null;
    if (!data) {
      // The old rule: a catalog date is enough while no document exists.
      if (hasCatalogDate) continue;
      out.push({ slug: entry.slug, title: entry.title });
      continue;
    }
    const hasYear = data.releaseYear != null;
    const hasGenres = Array.isArray(data.genres) && data.genres.length > 0;
    if (hasYear && hasGenres) continue;
    // The `genres` key makes the genre axis explicit for `collectTitleCandidates`;
    // `releaseYear`/`releaseDate` keep the year axis honest.
    out.push({
      slug: entry.slug,
      title: entry.title,
      releaseYear: data.releaseYear == null ? null : data.releaseYear,
      releaseDate: data.releaseDate || null,
      genres: Array.isArray(data.genres) ? data.genres : [],
    });
  }
  return out;
}

/**
 * Start (or coalesce into) a details job. Returns the public job immediately;
 * the loop runs in the background and never rejects into the caller.
 */
function startSecondaryDetails(options = {}) {
  const ownerKey = String(options.ownerKey == null ? '' : options.ownerKey).trim();
  const gog = Array.isArray(options.gog) ? options.gog : [];
  const epic = Array.isArray(options.epic) ? options.epic : [];
  if (!ownerKey) {
    throw new SecondaryDetailsError('Нужен ownerKey.', 'secondary_details_no_owner');
  }
  const existing = jobs.get(ownerKey);
  if (existing && existing.status === 'running' && !options.force) {
    return { ...publicJob(existing), reused: true };
  }
  const budget =
    options.budget != null && Number.isFinite(Number(options.budget))
      ? Math.max(0, Math.floor(Number(options.budget)))
      : budgetDefault();
  // One client per job: its `client_credentials` token and throttle state are
  // reused across catalog refetches instead of fetched per product.
  const epicClient =
    options.epicClient || options.catalogClient || (epic.length ? createCatalogClient(options) : null);
  const job = {
    id: `secondary-details-${++jobSeq}`,
    ownerKey,
    status: 'running',
    stage: gog.length ? 'gog' : 'epic',
    startedAt: isoOf(nowMs()),
    finishedAt: null,
    requests: 0,
    budget,
    budgetExceeded: false,
    force: Boolean(options.force),
    client: options.client,
    // Owner-token catalog refetch (stale Epic CMS): injected in tests, created
    // once per job from the token store in production.
    epicClient: epicClient,
    tokenStore: options.tokenStore || null,
    epicAccountId: options.epicAccountId || null,
    pauseMs: options.pauseMs != null ? options.pauseMs : pauseMsFor('gog'),
    gog: emptyPhase(),
    epic: emptyPhase(),
    warnings: [],
    cancelled: false,
  };
  // Counters are visible in the immediate response, before the first await.
  job.gog.total = gog.filter((entry) => entry && entry.id).length;
  job.epic.total = epic.filter((entry) => entry && (entry.slug || entry.title)).length;
  job.epic.missingSlug = epic.filter((entry) => entry && !entry.slug).length;
  jobs.set(ownerKey, job);
  lastKick.set(ownerKey, nowMs());

  const run = async () => {
    try {
      // A store-exclusive with no date (Alan Wake 2) can get its P577 from a
      // unique exact-title Wikidata match. One cache-backed request per run,
      // skipped for inert clients and on the shared `KINOBOXD_GAMES_WD=off`
      // kill switch (checked inside `refreshForJob`).
      const titleCards = titleCandidatesFor(epic);
      if (!job.client && titleCards.length) {
        try {
          job.titleLinks = await refreshForJob({
            epicGames: titleCards,
            options: {
              fetchImpl: options.fetchImpl,
              wdqsEndpoint: options.wdqsEndpoint,
              wikidata: options.wikidata,
            },
          });
        } catch (err) {
          job.titleLinks = { skipped: 'error' };
        }
      }
      await runPhase(
        job,
        'gog',
        gog
          .filter((entry) => entry && entry.id)
          .map((entry) => ({ id: String(entry.id), slug: entry.slug || null, title: entry.title || null })),
        (target, opts) => resolveGog(target.id, { ...opts, slug: target.slug, title: target.title })
      );
      if (job.pauseMs && !job.cancelled && job.requests < job.budget) {
        job.pauseMs = pauseMsFor('epic');
      }
      await runPhase(
        job,
        'epic',
        epic
          .filter((entry) => entry && (entry.slug || entry.title))
          .map((entry) => ({
            id: String(entry.slug || entry.id || `catalog:${entry.catalogItemId || ''}`),
            slug: entry.slug || null,
            title: entry.title || null,
            catalogItemId: entry.catalogItemId || null,
            catalog: entry.catalog || null,
            namespace: entry.namespace || null,
          })),
        (target, opts) =>
          resolveEpic(target.slug, {
            ...opts,
            title: target.title,
            catalog: target.catalog,
            catalogItemId: target.catalogItemId,
            namespace: target.namespace,
            ownerKey: job.ownerKey,
            epicClient: job.epicClient,
            tokenStore: job.tokenStore,
            epicAccountId: job.epicAccountId,
            forceCatalog: job.force,
          })
      );
      job.status = job.budgetExceeded ? 'partial' : 'done';
    } catch (err) {
      job.status = 'failed';
      job.warnings.push((err && err.code) || 'secondary_details_error');
    } finally {
      job.finishedAt = isoOf(nowMs());
      job.stage = 'done';
      recordRunFinished(job);
    }
  };
  Promise.resolve().then(run);
  return publicJob(job);
}

/** Cheap re-kick guard: `null` = go ahead, otherwise the reason. */
function kickGate(ownerKey, options = {}) {
  const key = String(ownerKey == null ? '' : ownerKey);
  if (!key) return 'no_owner';
  const job = jobs.get(key);
  if (job && job.status === 'running') return 'running';
  if (options.forceKick) return null;
  const last = lastKickAtFor(key);
  const cooldown =
    options.kickCooldownMs != null ? Number(options.kickCooldownMs) : kickCooldownMs();
  if (last && nowMs() - last < cooldown) return 'cooldown';
  return null;
}

/**
 * Fire-and-forget kick after a GOG/Epic import (the `kickFranchiseQuietly`
 * pattern): a failure is a job warning, the import stays `done`. `forceKick`
 * is set for an explicit user import so the cooldown does not swallow it.
 *
 * `trigger` is recorded in the kick ledger (`import`, `refresh`, `stats`) —
 * the status endpoint shows it, so «the fix did nothing on prod» can be told
 * apart from «nobody asked».
 */
function kickSecondaryDetailsQuietly(ownerKey, options = {}) {
  const key = String(ownerKey == null ? '' : ownerKey);
  const trigger = options.trigger || 'import';
  const gate = kickGate(key, options);
  if (gate) {
    if (trigger !== 'stats') {
      recordKick({ ownerKey: key, result: 'skipped', skipped: gate, trigger });
    }
    return { skipped: gate, ownerKey: ownerKey || null };
  }
  try {
    const job = startSecondaryDetails({ ...options, ownerKey });
    recordKick({
      ownerKey: key,
      result: job.reused ? 'reused' : 'started',
      jobId: job.id || null,
      trigger,
      budget: job.budget == null ? null : job.budget,
    });
    console.log(
      `[games-secondary-details] kicked ${job.id} ` +
        `(gog=${job.gog.total}, epic=${job.epic.total}, budget=${job.budget}, trigger=${trigger})`
    );
    return job;
  } catch (err) {
    const message = maskSecrets((err && err.message) || 'secondary details failed');
    console.warn(`[games-secondary-details] kick failed (caller kept): ${message}`);
    recordKick({ ownerKey: key, result: 'failed', trigger, code: (err && err.code) || 'kick_failed' });
    return { skipped: 'kick_failed', code: (err && err.code) || 'kick_failed' };
  }
}

/* ------------------------------------------------------------------ */
/* targets from the cached libraries                                   */
/* ------------------------------------------------------------------ */

function targetsForOwner(ownerKey) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  const gog = [];
  const epic = [];
  if (!key) return { gog, epic, epicNoSlug: 0 };
  const gogCache = require('./gog-cache');
  const epicCache = require('./epic-cache');
  // Both a bound token and a dated snapshot carry the owner: a restored
  // snapshot without a token still deserves metadata (its games are in the
  // union), so libraries are read directly and filtered by `ownerProfile`.
  const seenGog = new Set();
  for (const library of gogCache.listLibraries()) {
    if (!library || library.ownerProfile !== key) continue;
    for (const product of library.products || []) {
      if (!product || !product.gogGameId) continue;
      const id = String(product.gogGameId);
      if (seenGog.has(id)) continue;
      seenGog.add(id);
      gog.push({ id, slug: product.slug || null, title: product.title || null });
    }
  }
  let epicNoSlug = 0;
  // Read-only binding scan: a token the profile has not adopted yet (exactly
  // one, no other owner) still addresses this owner's library. The job adopts
  // it; enumeration here must not report «no Epic» while the games exist.
  const epicBinding =
    typeof epicCache.epicBindingForOwnerSync === 'function'
      ? epicCache.epicBindingForOwnerSync(key)
      : { state: 'none', accountId: epicCache.epicAccountForOwner(key) };
  const epicAccount = epicBinding.accountId || null;
  if (epicAccount) {
    const library = epicCache.getEpicLibrary(epicAccount);
    const games = (library && library.games) || [];
    // The library snapshot's own `slug` is only the productmapping fallback
    // (~1 283 appNames). The catalog bulk (`productSlug`/`urlSlug`) and a
    // previously discovered slug override cover Epic exclusives such as
    // Alan Wake 2, which `productmapping` does not list at all.
    const catalog = epicCache.listEpicCatalogItems(
      games.map((game) => game && game.catalogItemId).filter(Boolean)
    );
    // productmapping keys are appNames or namespaces; an Epic exclusive (Alan
    // Wake 2) is present only under its namespace.
    let productMapping = {};
    try {
      const mapping = epicCache.getProductMapping();
      productMapping = mapping && mapping.byAppName ? mapping.byAppName : {};
    } catch (err) {
      productMapping = {};
    }
    for (const game of games) {
      if (!game) continue;
      const meta = (game.catalogItemId && catalog[game.catalogItemId]) || null;
      const mappedSlug =
        (game.appName && productMapping[game.appName]) ||
        (game.namespace && productMapping[game.namespace]) ||
        null;
      const slug =
        (meta && meta.slug) ||
        game.slug ||
        mappedSlug ||
        (game.catalogItemId ? epicCache.getEpicSlugOverride(game.catalogItemId) : null) ||
        null;
      const title = (meta && meta.title) || game.name || game.appName || null;
      if (!slug) epicNoSlug++;
      epic.push({
        slug: slug || null,
        id: String(game.catalogItemId || game.appName || slug || ''),
        catalogItemId: game.catalogItemId || null,
        appName: game.appName || null,
        namespace: game.namespace || null,
        title,
        catalog: meta,
      });
    }
  }
  return { gog, epic, epicNoSlug, epicBinding };
}

/* ------------------------------------------------------------------ */
/* coverage / status / lazy kick                                       */
/* ------------------------------------------------------------------ */

/**
 * How many of the owner's secondary products already have a detail document.
 * `total` includes **slugless** Epic works: the title probe is the only way to
 * address them, and «resolved < total» must stay true until one of them is
 * either resolved or explicitly given up (a probe negative is not resolved,
 * but it stops the retry loop through the probe TTL).
 */
function coverageForOwner(ownerKey) {
  const targets = targetsForOwner(ownerKey);
  const epicBinding = targets.epicBinding || { state: 'none', accountId: null };
  const epicHasToken = Boolean(
    epicBinding.accountId && epicBinding.hasAccessToken !== false
  );
  // One ledger read for the whole pass: `/stats` is polled, and a 300-work
  // Epic library must not re-read the same state file per target.
  let catalogState = null;
  try {
    catalogState = readCatalogState();
  } catch (err) {
    catalogState = null;
  }
  const phase = (source, list, idOf) => {
    let resolved = 0;
    let notFound = 0;
    let unavailable = 0;
    let partial = 0;
    let retryablePartial = 0;
    let pending = 0;
    for (const target of list) {
      const id = idOf(target);
      if (!id) {
        // A slugless Epic work is addressable only by its title guess. A fresh
        // probe negative means «attempted, nothing found» — not pending.
        let attempted = false;
        if (source === 'epic' && target.title) {
          const guess = slugFromTitle(target.title);
          const hit = guess ? readDetail('epic', guess) : null;
          if (
            hit &&
            hit.fresh &&
            hit.doc &&
            hit.doc.status === 'not_found' &&
            hit.doc.probe === true
          ) {
            notFound++;
            attempted = true;
          }
        }
        if (!attempted) pending++;
        continue;
      }
      const { doc, fresh } = readDetail(source, id);
      if (!fresh || !doc) {
        pending++;
        continue;
      }
      if (doc.status !== 'ok') {
        if (doc.status === 'not_found') notFound++;
        else pending++;
        continue;
      }
      if (source === 'gog') {
        // GOG was resolved before the `metaStatus` work; keep its contract.
        resolved++;
        continue;
      }
      // Epic: `resolved` means the **facts** arrived (year + genres), not that
      // a file exists. A settled negative is `unavailable` (honest «store has
      // no release info»), a deferred/pre-catalog document is still pending.
      const completion = catalogCompletionState(doc.data, {
        ownerKey,
        catalogItemId: target.catalogItemId,
        hasCatalogToken: epicHasToken,
        catalogState,
      });
      if (completion === 'complete') resolved++;
      else if (completion === 'partial') {
        // One fact arrived, the other did not. It is still a work the catalog
        // can complete, so it must reach the kick (fix 02.11.2026: `partial`
        // used to be counted as neither `resolved` nor `pending`, so the lazy
        // kick returned `attempted` and AW2 stayed poster-only forever).
        // A partial whose catalog answer is already settled (`shape_ok`, or
        // `ok` inside its 30-day probe TTL) is not re-asked on every poll, and
        // without an owner token there is nothing to ask — the next connect
        // makes it retryable again.
        partial++;
        if (
          epicHasToken &&
          target.catalogItemId &&
          catalogRetryDue(ownerKey, target.catalogItemId, { catalogState })
        ) {
          retryablePartial++;
        }
      } else if (completion === 'pending') pending++;
      else unavailable++;
    }
    return {
      total: list.length,
      resolved,
      notFound,
      unavailable,
      partial,
      retryablePartial,
      missingSlug: 0,
      pending,
    };
  };
  const gog = phase('gog', targets.gog, (target) => target.id);
  const epic = phase('epic', targets.epic, (target) => target.slug);
  epic.missingSlug = targets.epicNoSlug;
  const slugless = targets.epic
    .filter((target) => !target.slug)
    .slice(0, MAX_SLUGLESS)
    .map((target) => ({
      name: target.title || null,
      catalogItemId: target.catalogItemId || null,
      appName: target.appName || null,
    }));
  return {
    gog,
    epic,
    slugless,
    // Where the Epic binding actually stands (`bound`/`unbound`/`profile_missing`/
    // `owner_mismatch`/`ambiguous`/`none`) plus the account it resolves to, so a
    // missing/foreign token is a stated fact rather than an empty card.
    epicBinding,
    resolved: gog.resolved + epic.resolved,
    total: gog.total + epic.total,
    pending: gog.pending + epic.pending,
    // `partial` is a first-class state: the work has a detail document but one
    // of year/genres is missing. `retryablePartial` is the subset the catalog
    // can still answer for (no attempt yet, or the 30-day window expired).
    partial: gog.partial + epic.partial,
    retryablePartial: gog.retryablePartial + epic.retryablePartial,
  };
}

/**
 * The owner-facing diagnostic (`GET /api/games/secondary-details/status`).
 * Contract: `{ resolved, total, pending, partial, retryablePartial, running,
 * bySource, slugless[], lastErrors[], cooldownUntil, kick, lastRunAt }`.
 * Everything here is a cache/state read — the endpoint never makes a network
 * request.
 */
function statusForOwner(ownerKey) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  const coverage = coverageForOwner(key);
  const state = readStatusState();
  const lastKick = lastKickAtFor(key);
  const kicks = state.kicks
    .filter((kick) => kick && kick.ownerKey === key)
    .slice(-MAX_KICK_HISTORY);
  const last = kicks.length ? kicks[kicks.length - 1] : null;
  const gogBreaker = breakerBlock('gog');
  const epicBreaker = breakerBlock('epic');
  const ownerSkips = (state.skips && state.skips[key]) || {};
  const cooldownUntil = lastKick ? isoOf(lastKick + kickCooldownMs()) : null;
  const kickCooldownActive = Boolean(
    lastKick && nowMs() - lastKick < kickCooldownMs()
  );
  return {
    profile: key || null,
    resolved: coverage.resolved,
    total: coverage.total,
    pending: coverage.pending,
    // Degraded-but-present metadata: a detail document exists, but only one of
    // year/genres arrived. `retryablePartial` is the subset the catalog can
    // still complete (no attempt yet / probe TTL expired) — that subset, not
    // every partial, is what a lazy kick will address.
    partial: coverage.partial,
    retryablePartial: coverage.retryablePartial,
    running: runningFor(key),
    bySource: {
      gog: { ...coverage.gog },
      epic: {
        ...coverage.epic,
        // Why the last catalog step did not ask (`not_connected`, `no_token`,
        // `owner_mismatch`, `binding_ambiguous`, `probe`, `budget`,
        // `no_client`, `no_access_token`, …) — `null` when every due work was
        // actually asked. The owner can paste this text back.
        lastSkip: ownerSkips.epic || null,
        // Where the owner→account binding stands, independent of a job run.
        binding: coverage.epicBinding || { state: 'none', accountId: null },
      },
    },
    // The per-owner catalog ledger: which `catalogItemId`s were asked, what
    // the token answered, HTTP status/bytes and whether year/genres arrived.
    // `total: 0` is itself the answer to «did the job ever ask?».
    catalogAttempts: catalogAttemptsForOwner(key),
    slugless: coverage.slugless,
    lastErrors: state.lastErrors
      .filter((entry) => entry && entry.ownerKey === key)
      .slice(-MAX_STATUS_ERRORS),
    // `null` when a kick is allowed right now (cooldown is advisory, the
    // breaker is the hard stop and is reported separately).
    cooldownUntil: kickCooldownActive ? cooldownUntil : null,
    cooldownActive: kickCooldownActive,
    breakers: {
      gog: gogBreaker ? { until: gogBreaker.until, code: gogBreaker.code } : null,
      epic: epicBreaker ? { until: epicBreaker.until, code: epicBreaker.code } : null,
    },
    kick: {
      lastKickAt: lastKick ? isoOf(lastKick) : null,
      lastJobId: last ? last.jobId || null : null,
      lastResult: last ? last.result || null : null,
      lastSkipped: last && last.result === 'skipped' ? last.skipped || null : null,
      lastTrigger: last ? last.trigger || null : null,
      history: kicks,
    },
    lastRunAt: state.lastRunAt || null,
    checkedAt: isoOf(nowMs()),
  };
}

/**
 * The single kick rule (fix 02.11.2026): a secondary library needs the store
 * metadata job when **any** of these holds:
 *
 *   - `resolved < total` — an addressable work has no detail yet;
 *   - `partial > 0`      — a detail exists but only one of year/genres
 *                          arrived; the time-based rule used to let this work
 *                          sit forever (the AW2 symptom), so it is now
 *                          re-posted with the goal «complete»;
 *   - `noSlug > 0`       — an Epic work has no store slug and can only be
 *                          addressed by the title probe.
 *
 * Callers pass either `stats.meta.secondaryDetails` (cheap, no cache reads) or
 * a refined `coverageForOwner()` snapshot; the predicate is identical.
 */
function coverageNeedsKick(meta) {
  if (!meta || typeof meta !== 'object') return false;
  const total = Number(meta.total) || 0;
  const resolved = Number(meta.resolved) || 0;
  const partial = Number(meta.partial) || 0;
  const noSlug = Number(meta.noSlug) || 0;
  return (total > 0 && resolved < total) || partial > 0 || noSlug > 0;
}

/**
 * Lazy kick from `GET /api/games/stats` (the missing piece after the 66c3d21
 * deploy: an Epic library imported *before* the deploy never fired a kick, and
 * nothing re-kicked it). Fire-and-forget, coalesced by `kickGate`, disabled
 * with `GAMES_SECONDARY_LAZY_KICK=0`.
 *
 * Kick rule (fix 02.11.2026): `resolved < total || partial > 0 || noSlug > 0`
 * — see `coverageNeedsKick`. The cache refinement then drops works that were
 * already attempted (404/settled negative), while a `partial` whose catalog
 * answer is still due stays kickable.
 */
function kickFromStats(ownerKey, meta, options = {}) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  if (!key) return { skipped: 'no_owner' };
  if (String(process.env.GAMES_SECONDARY_LAZY_KICK || '').trim() === '0') {
    return { skipped: 'disabled' };
  }
  // An adoptable token (exactly one unbound/old-format token) is not visible to
  // the Epic read layer yet, so `/stats` may report no Epic works at all. The
  // binding must still reach the job that adopts it — otherwise the self-heal
  // would only ever run from an import kick.
  const bindingForKick = (() => {
    try {
      const epicCache = require('./epic-cache');
      return typeof epicCache.epicBindingForOwnerSync === 'function'
        ? epicCache.epicBindingForOwnerSync(key)
        : null;
    } catch (err) {
      return null;
    }
  })();
  const adoptableBinding =
    bindingForKick &&
    (bindingForKick.state === 'unbound' || bindingForKick.state === 'profile_missing');
  if (!coverageNeedsKick(meta) && !adoptableBinding) return { skipped: 'covered' };
  // Refine with the cache: a product whose slug 404'd (or whose title probe
  // already failed) is *attempted*, not pending. Without this a no-op job would
  // start every cooldown window for a work that cannot be resolved. A negative
  // verdict is memoized for a minute: `/stats` is polled, and the refinement
  // re-reads the library/catalog.
  const memo = coverageMemo.get(key);
  if (
    memo &&
    memo.pending <= 0 &&
    memo.retryablePartial <= 0 &&
    nowMs() - memo.at < COVERAGE_MEMO_MS
  ) {
    return { skipped: 'attempted' };
  }
  const coverage = coverageForOwner(key);
  // A token that names another owner (or several candidates) is never adopted:
  // it is stated in the status ledger and blocks the job instead of silently
  // pretending the owner has no Epic library.
  const binding = coverage.epicBinding || null;
  if (binding && (binding.state === 'owner_mismatch' || binding.state === 'ambiguous')) {
    recordSkip(key, {
      source: 'epic',
      reason: binding.state,
      detail: 'binding',
      otherOwner: binding.otherOwner || null,
      trigger: 'stats',
    });
  }
  // `partial` is kickable (fix 02.11.2026): the detail exists, but year/genres
  // are incomplete — the catalog is re-asked when no attempt is recorded yet
  // or its 30-day probe window expired. A settled `shape_ok` partial stays
  // settled and must not burn a request on every poll.
  const retryablePartial = coverage.retryablePartial;
  if (coverage.pending <= 0 && retryablePartial <= 0) {
    coverageMemo.set(key, { at: nowMs(), pending: 0, retryablePartial: 0 });
    return { skipped: 'attempted' };
  }
  coverageMemo.delete(key);
  const gate = kickGate(key, options);
  if (gate) return { skipped: gate };
  return kickSecondaryDetailsQuietly(key, {
    trigger: 'stats',
    client: options.client,
    // Catalog refetch injection for tests (and for a caller that already owns
    // a client): the lazy kick must use the same token-bound client as an
    // explicit run.
    epicClient: options.epicClient,
    catalogClient: options.catalogClient,
    tokenStore: options.tokenStore,
    epicAccountId: options.epicAccountId,
    pauseMs: options.pauseMs,
    ...targetsForOwner(key),
  });
}

/** Test helper: forget job/cooldown state between cases. */
function resetJobs() {
  jobs.clear();
  lastKick.clear();
  coverageMemo.clear();
  try {
    fs.rmSync(STATUS_PATH, { force: true });
  } catch (err) {
    /* nothing to clean */
  }
}

/* ------------------------------------------------------------------ */
/* public facade                                                       */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* public facade                                                       */
/* ------------------------------------------------------------------ */

/**
 * Only the names the domain and the tests actually import are re-exported.
 * The rest of the pipeline (normalizers, catalog guards, breaker, dumps) is
 * used *inside* this module or by the `secondary/` modules directly — an
 * export list is a contract, not a directory listing.
 */
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
