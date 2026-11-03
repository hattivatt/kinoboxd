'use strict';

/**
 * Epic import jobs (M6b).
 *
 *   POST /api/games/epic/import   { accountId?, owner?, force?, label? } → job
 *   GET  /api/games/epic/import/:jobId
 *   GET  /api/games/epic/import/status?id=…
 *
 * Chain (§14.2, §14.4):
 *   queued → auth (token + account) → entitlements → library items
 *   (cursor, filtered: UE/PRIVATE/mobile) → playtime (seconds) → catalog bulk
 *   (metadata) → done.
 *
 * Ownership is merged with entitlements as the primary source and library
 * items as the fallback/enricher (appName, platform, acquisitionDate). The
 * snapshot is written **before** playtime/catalog so a later failure never
 * loses the library. A network/5xx failure is `deferred` (the previous
 * snapshot stays in place); a 401 is `epic_auth_expired` (never "0 games").
 *
 * The job never writes to the Steam cache and never changes Steam hours: the
 * Epic snapshot is a separate file (`library/epic-<accountId>.json`), and the
 * read model (`epic-layer.js`) keeps `hoursBySource` separate.
 */

const crypto = require('crypto');

const epic = require('./epic');
const { createJobs } = require('../core/jobs');
const epicCache = require('./epic-cache');
const gameCache = require('./game-cache');
const tokenStore = require('./epic-token-store');
const secondaryIdentity = require('./secondary-identity');
const secondaryDetails = require('./secondary-details');

/**
 * Job registry (core/jobs): single-flight per Epic account id, one import
 * chain and the 20-job ring. `deferred` (network/5xx) stays a domain verdict —
 * the shared finalizer only finishes whatever status the task left.
 */
const jobs = createJobs({
  name: 'games-epic-import',
  idPrefix: 'games-epic',
  maxJobs: 20,
  keyOf: (job) => (job.accountId == null ? null : String(job.accountId)),
  maskError: (err) => epic.maskSecrets(err && err.message ? err.message : 'неизвестная ошибка'),
  errorCode: 'epic_import_failed',
});

const MAX_JOBS = jobs.maxJobs;

function newJobId(seed) {
  return jobs.newId(seed);
}

function rememberJob(job) {
  return jobs.remember(job);
}

function findRunningJob(accountId) {
  return jobs.findRunning(String(accountId == null ? "" : accountId));
}

/** Public job view: no token, no device code, no raw HTTP details. */
function publicStatus(job) {
  if (!job) return null;
  return {
    ...jobs.snapshot(job),
    jobId: job.id,
    id: job.id,
    source: 'epic',
    accountId: job.accountId,
    owner: job.owner || null,
    displayName: job.displayName || null,
    status: job.status,
    stage: job.stage,
    done: job.done,
    deferred: Boolean(job.deferred),
    percent: job.percent,
    reused: job.reused,
    force: job.force,
    code: job.code,
    error: job.error,
    warning: job.warning,
    warnings: job.warnings ? [...job.warnings] : [],
    requests: job.requests,
    gameCount: job.gameCount,
    ownedCount: job.ownedCount,
    totalSeconds: job.totalSeconds == null ? null : job.totalSeconds,
    totalMinutes: job.totalMinutes == null ? null : job.totalMinutes,
    totalHours: job.totalHours == null ? null : job.totalHours,
    playedCount: job.playedCount,
    backlogCount: job.backlogCount,
    catalogCount: job.catalogCount == null ? null : job.catalogCount,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    elapsedMs: job.finishedAt ? job.finishedAt - job.startedAt : null,
    cachedAt: job.cachedAt || null,
  };
}

function getStatus(id) {
  return publicStatus(jobs.get(String(id || '')));
}

function isRunning(accountId) {
  return Boolean(findRunningJob(String(accountId || '')));
}

function enqueue(job, task) {
  return jobs.run(job, task, {
    onError: (self, err) => {
      jobs.fail(self, err);
      self.deferred = Boolean(err && err.deferred);
      console.error(`[games-epic-import ${self.id}] ${self.code}: ${self.error}`);
    },
    onFinish: (self) => {
      console.log(
        `[games-epic-import ${self.id}] ${self.status} after ${self.finishedAt - self.startedAt}ms ` +
          `(stage=${self.stage}, requests=${self.requests}, ` +
          `games=${self.gameCount == null ? '—' : self.gameCount}` +
          `${self.deferred ? ', deferred' : ''}${self.code ? `, code=${self.code}` : ''})`
      );
    },
  });
}

function isoNow() {
  return new Date().toISOString();
}

function fingerprintOf(games, totalSeconds) {
  const ids = (games || [])
    .map((game) => game.catalogItemId || game.appName || '')
    .filter(Boolean)
    .sort();
  return crypto
    .createHash('sha1')
    .update(`${games.length}:${Number(totalSeconds) || 0}:${ids.join(',')}`)
    .digest('hex');
}

function totalsOf(games, playtime) {
  const list = Array.isArray(games) ? games : [];
  const totalSeconds = playtime ? Number(playtime.totalSeconds) || 0 : null;
  return {
    totalSeconds,
    totalMinutes: totalSeconds == null ? null : epic.secondsToMinutes(totalSeconds),
    totalHours: totalSeconds == null ? null : epic.secondsToHours(totalSeconds),
    playedCount: playtime
      ? list.filter((game) => {
          const hit = epic.playtimeForGame(game, playtime);
          return hit && hit.totalMinutes > 0;
        }).length
      : null,
    backlogCount: playtime
      ? list.filter((game) => {
          const hit = epic.playtimeForGame(game, playtime);
          return !hit || hit.totalMinutes === 0;
        }).length
      : null,
  };
}

/**
 * Fill `game.slug` for the games the store metadata job can address, strongest
 * source first:
 *
 *   1. `catalog/<catalogItemId>.json` `slug` (catalog `productSlug`/`urlSlug`) —
 *      this is the source that covers **Epic exclusives** absent from
 *      `productmapping` (Alan Wake 2, §14.2/§14.7);
 *   2. the public `productmapping` appName → slug list (~1 283 records);
 *   3. a previously discovered slug override (`slug-overrides.json`).
 */
function mergeCatalogSlugs(games, productMapping, catalogDocs) {
  const byAppName = (productMapping && productMapping.byAppName) || {};
  const catalog = catalogDocs && typeof catalogDocs === 'object' ? catalogDocs : {};
  for (const game of games) {
    if (game.slug) continue;
    const meta = game.catalogItemId ? catalog[game.catalogItemId] : null;
    if (meta && meta.slug) {
      game.slug = meta.slug;
      continue;
    }
    if (game.appName && byAppName[game.appName]) {
      game.slug = byAppName[game.appName];
      continue;
    }
    // `productmapping` is a flat map whose keys are *either* an appName or a
    // namespace. Epic exclusives such as Alan Wake 2 live under the namespace
    // key only (`c4763f…` → `alan-wake-2`), so the library record's namespace
    // is a legitimate second lookup, not a fabricated slug.
    if (game.namespace && byAppName[game.namespace]) {
      game.slug = byAppName[game.namespace];
      continue;
    }
    const known = game.catalogItemId
      ? epicCache.getEpicSlugOverride(game.catalogItemId)
      : null;
    if (known) game.slug = known;
  }
}

/**
 * Fetch catalog metadata for the games that need it. Cached items younger
 * than the catalog TTL are reused; failures are warnings, never fatal (the
 * library is the primary artifact). The productmapping endpoint is the public
 * slug fallback when the catalog has no `productSlug`.
 */
async function fetchCatalog(job, client, games, options) {
  const ids = [...new Set(games.map((game) => game.catalogItemId).filter(Boolean))];
  const cached = epicCache.listEpicCatalogItems(ids);
  const ttl = epicCache.epicCatalogTtlMs();
  const missing = ids.filter(
    (id) => !cached[id] || options.forceCatalog || !gameCache.isFresh(cached[id], ttl)
  );
  let catalogCount = 0;

  if (missing.length && options.autoCatalog !== false) {
    const byNamespace = new Map();
    for (const game of games) {
      if (!game.catalogItemId || !missing.includes(game.catalogItemId)) continue;
      const namespace = game.namespace || 'fn';
      if (!byNamespace.has(namespace)) byNamespace.set(namespace, []);
      byNamespace.get(namespace).push(game.catalogItemId);
    }
    for (const [namespace, namespaceIds] of byNamespace) {
      try {
        const result = await client.getCatalogBulk(namespace, namespaceIds, {
          accountId: job.accountId,
        });
        job.requests += result.requests || 0;
        for (const [id, doc] of Object.entries(result.items || {})) {
          await epicCache.saveEpicCatalogItem(id, doc);
          catalogCount++;
        }
        for (const failure of result.failures || []) {
          job.warnings.push(`catalog_${failure.code || 'failed'}`);
        }
      } catch (err) {
        if (err && err.code === 'epic_auth_expired') throw err;
        if (err && err.deferred) throw err;
        job.warnings.push(`catalog_${(err && err.code) || 'failed'}`);
      }
    }
  }

  // Public appName → slug mapping (no token): one request, cached 7 days.
  let mapping = epicCache.getProductMapping();
  if (!mapping || !gameCache.isFresh(mapping, epicCache.productMappingTtlMs())) {
    try {
      const fresh = await client.getProductMapping();
      job.requests += 1;
      mapping = await epicCache
        .saveProductMapping({ ...fresh, fetchedAt: isoNow() })
        .then((saved) => saved.data);
    } catch (err) {
      job.warnings.push(`productmapping_${(err && err.code) || 'failed'}`);
      // A stale mapping is still usable; a missing one just means no fallback.
    }
  }
  mergeCatalogSlugs(games, mapping, epicCache.listEpicCatalogItems(ids));

  return { catalogCount, catalogCached: Object.keys(cached).length };
}

async function runImport(job, accountId, client, options) {
  const ownerKey = options.ownerKey ? String(options.ownerKey).trim() : null;

  /* ------------------------- 1. auth ---------------------------- */
  job.stage = 'auth';
  job.percent = 5;
  job.requests++;
  let account = null;
  try {
    account = await client.getAccount(accountId);
  } catch (err) {
    if (err && err.code === 'epic_auth_expired') throw err;
    if (err && err.deferred) throw err;
    job.warnings.push(`account_${(err && err.code) || 'failed'}`);
  }
  job.displayName = (account && account.displayName) || job.displayName || null;

  const existingProfile = epicCache.getEpicProfile(accountId);
  const profileDoc = {
    ...(existingProfile || {}),
    accountId,
    displayName: job.displayName || (existingProfile && existingProfile.displayName) || null,
    ownerKey: ownerKey || (existingProfile && existingProfile.ownerKey) || null,
    label: options.label || (existingProfile && existingProfile.label) || null,
    authMethod: 'device_code',
    connectedAt: (existingProfile && existingProfile.connectedAt) || isoNow(),
    importedAt: isoNow(),
    fetchedAt: isoNow(),
  };
  await epicCache.saveEpicProfile(profileDoc);
  job.owner = profileDoc.ownerKey || null;

  /* --------------------- 2. entitlements ------------------------ */
  job.stage = 'entitlements';
  job.percent = 20;
  let entitlements = [];
  try {
    const result = await client.getEntitlements(accountId);
    job.requests += result.pages || 1;
    entitlements = result.entitlements || [];
  } catch (err) {
    if (err && err.code === 'epic_auth_expired') throw err;
    if (err && err.deferred) {
      // The entitlement host is known to drift (§14.2); the library-service
      // fallback may still work. Only give up when *both* are unreachable.
      job.warnings.push(`entitlements_${err.code || 'failed'}`);
    } else {
      job.warnings.push(`entitlements_${(err && err.code) || 'failed'}`);
    }
  }

  /* --------------------- 3. library items ----------------------- */
  job.stage = 'library';
  job.percent = 40;
  let libraryItems = [];
  let libraryPages = 0;
  let libraryTruncated = false;
  try {
    const result = await client.getLibraryItems(accountId);
    libraryPages = result.pages || 1;
    job.requests += libraryPages;
    libraryItems = result.records || [];
    libraryTruncated = Boolean(result.truncated);
  } catch (err) {
    if (err && err.code === 'epic_auth_expired') throw err;
    if (err && err.deferred && !entitlements.length) throw err;
    if (err && err.deferred) {
      job.warnings.push(`library_${err.code || 'failed'}`);
    } else {
      job.warnings.push(`library_${(err && err.code) || 'failed'}`);
    }
  }
  if (libraryTruncated) job.warnings.push('library_truncated');

  const merged = epic.mergeLibrary({ entitlements, libraryItems });
  if (!merged.games.length) {
    throw new epic.EpicError(
      'Epic не отдал ни одной игры: пустые entitlements и library items. ' +
        'Проверьте аккаунт (библиотека может быть скрыта) и повторите импорт.',
      'epic_library_empty'
    );
  }

  const fetchedAt = isoNow();
  const oldPlaytime = epicCache.getEpicPlaytime(accountId);
  const oldLibrary = epicCache.getEpicLibrary(accountId);
  const baseLibrary = {
    fetchedAt,
    partial: !oldPlaytime,
    source:
      merged.counts.entitlementCount && merged.counts.libraryCount
        ? 'epic-entitlements+library'
        : merged.counts.entitlementCount
          ? 'epic-entitlements'
          : 'epic-library',
    accountId,
    ownerKey: profileDoc.ownerKey,
    displayName: profileDoc.displayName,
    gameCount: merged.games.length,
    games: merged.games,
    counts: merged.counts,
    libraryPages,
    totalSeconds: oldPlaytime ? oldPlaytime.totalSeconds : null,
    totalMinutes: oldPlaytime ? oldPlaytime.totalMinutes : null,
    fingerprint: fingerprintOf(merged.games, oldPlaytime ? oldPlaytime.totalSeconds : null),
    warnings: [...job.warnings],
  };
  // Save ownership before playtime/catalog: a later failure must not lose the
  // library that was already fetched (and must not overwrite it with zeros).
  await epicCache.saveEpicLibrary(accountId, baseLibrary);

  job.gameCount = merged.games.length;
  job.ownedCount = merged.games.length;

  /* ------------------------- 4. playtime ------------------------ */
  job.stage = 'playtime';
  job.percent = 60;
  let playtimeDoc = oldPlaytime;
  try {
    job.requests++;
    const fresh = await client.getPlaytime(accountId);
    playtimeDoc = { ...fresh, fetchedAt: isoNow() };
    await epicCache.saveEpicPlaytime(accountId, playtimeDoc);
  } catch (err) {
    if (err && err.code === 'epic_auth_expired') throw err;
    if (err && err.deferred) {
      // Deferred, not failed: the ownership snapshot above is valid, the old
      // playtime file (if any) stays in place, and the job says so.
      job.warnings.push(`playtime_${err.code || 'failed'}`);
      throw err;
    }
    job.warnings.push(`playtime_${(err && err.code) || 'failed'}`);
  }

  const totals = totalsOf(merged.games, playtimeDoc);
  job.totalSeconds = totals.totalSeconds;
  job.totalMinutes = totals.totalMinutes;
  job.totalHours = totals.totalHours;
  job.playedCount = totals.playedCount;
  job.backlogCount = totals.backlogCount;

  const libraryWithPlaytime = {
    ...baseLibrary,
    partial: !playtimeDoc,
    playtimeFetchedAt: playtimeDoc ? playtimeDoc.fetchedAt || null : null,
    totalSeconds: totals.totalSeconds,
    totalMinutes: totals.totalMinutes,
    totalHours: totals.totalHours,
    playedCount: totals.playedCount,
    backlogCount: totals.backlogCount,
    fingerprint: fingerprintOf(merged.games, totals.totalSeconds),
    warnings: [...job.warnings],
  };
  await epicCache.saveEpicLibrary(accountId, libraryWithPlaytime);

  /* ------------------------- 5. catalog ------------------------- */
  job.stage = 'catalog';
  job.percent = 80;
  const catalog = await fetchCatalog(job, client, merged.games, options);
  job.catalogCount = catalog.catalogCount;

  const finalLibrary = {
    ...libraryWithPlaytime,
    catalogFetchedAt: isoNow(),
    catalogCount: catalog.catalogCount,
    warnings: [...new Set(job.warnings)],
    fingerprint: fingerprintOf(merged.games, totals.totalSeconds),
  };
  await epicCache.saveEpicLibrary(accountId, finalLibrary);

  job.warning = job.warnings.length ? job.warnings.join(' ') : null;

  // M6c: one Wikidata batch (P6278 → P1733) so an Epic game that is also on
  // Steam joins the same work instead of duplicating it in every chart. Never
  // fatal; an injected client (tests) skips it entirely.
  job.stage = 'identity';
  job.percent = 96;
  const catalogIds = merged.games.map((game) => game.catalogItemId).filter(Boolean);
  const catalogDocs = epicCache.listEpicCatalogItems(catalogIds);
  job.secondaryLinks = await secondaryIdentity.refreshForJob({
    epicGames: merged.games.map((game) => {
      const meta = (game.catalogItemId && catalogDocs[game.catalogItemId]) || null;
      return {
        slug: (meta && meta.slug) || game.slug || null,
        // Title/date let the bridge fill a year for a store-exclusive whose
        // CMS page and catalog both carry no date (Alan Wake 2).
        title: (meta && meta.title) || game.name || null,
        releaseDate: (meta && meta.releaseDate) || null,
      };
    }),
    options: { ...options, force: options.force === true },
  });

  job.percent = 100;
  job.stage = 'done';
}

function resolveAccountId(options, tokens) {
  if (options.accountId) return String(options.accountId).trim();
  if (options.ownerKey) {
    const bound = epicCache.epicAccountForOwner(options.ownerKey);
    if (bound) return bound;
  }
  if (tokens.length === 1) return tokens[0].accountId;
  return null;
}

/**
 * Start (or coalesce into) an Epic import.
 *
 * Options: `{ accountId?, ownerKey?, force?, label?, client?, tokenStore?,
 * autoCatalog?, forceCatalog? }`. Throws synchronously (rejects) with
 * `epic_account_required` / `epic_not_connected` / `owner_mismatch` so the
 * route can answer 400 before a job exists.
 */
async function startImport(options = {}) {
  const store = options.tokenStore || tokenStore;
  const tokenDocs = await store.listTokenDocs();
  const accountId = resolveAccountId(options, tokenDocs);
  if (!accountId) {
    throw new epic.EpicError(
      'Укажите Epic-аккаунт: несколько подключений найдено, нужен accountId (или owner). ' +
        'Список: GET /api/games/epic/status.',
      'epic_account_required'
    );
  }
  const tokenDoc = tokenDocs.find((doc) => doc.accountId === accountId) || null;
  if (!tokenDoc) {
    throw new epic.EpicError(
      `Epic-аккаунт ${accountId} не подключён: сначала «Войти через Epic» (вход по коду).`,
      'epic_not_connected'
    );
  }

  const ownerKey = options.ownerKey ? String(options.ownerKey).trim() : null;
  let profile = epicCache.getEpicProfile(accountId);
  if (ownerKey) {
    if (profile && profile.ownerKey && profile.ownerKey !== ownerKey) {
      throw new epic.EpicError(
        `Epic-аккаунт ${accountId} уже привязан к ${profile.ownerKey}; ` +
          'библиотеки разных владельцев не сливаются (§14.4).',
        'owner_mismatch'
      );
    }
    const other = epicCache.epicAccountForOwner(ownerKey);
    if (other && other !== accountId) {
      throw new epic.EpicError(
        `У владельца ${ownerKey} уже есть Epic-аккаунт ${other}: ` +
          'одна вторичная библиотека на владельца, без суммы (§14.4).',
        'owner_mismatch'
      );
    }
    // A library imported before the owner was known must become part of the
    // owner's `libraries[]` on the next import/reuse, otherwise the union
    // (M6c) would never see it.
    if (!profile || !profile.ownerKey) {
      profile = (
        await epicCache.saveEpicProfile({
          ...(profile || {}),
          accountId,
          displayName: (profile && profile.displayName) || tokenDoc.displayName || null,
          ownerKey,
          label: (profile && profile.label) || options.label || null,
          authMethod: tokenDoc.authMethod || 'device_code',
          connectedAt: (profile && profile.connectedAt) || new Date().toISOString(),
        })
      ).data;
    }
  }

  const running = findRunningJob(accountId);
  if (running) return publicStatus(running);

  const force = Boolean(options.force);
  const library = epicCache.getEpicLibrary(accountId);
  if (!force && library && gameCache.isFresh(library, epicCache.epicLibraryTtlMs())) {
    const now = Date.now();
    const reused = {
      id: newJobId(accountId),
      accountId,
      owner: ownerKey || (profile && profile.ownerKey) || null,
      displayName: (profile && profile.displayName) || null,
      status: 'done',
      stage: 'done',
      done: true,
      deferred: false,
      percent: 100,
      reused: true,
      force: false,
      code: null,
      error: null,
      warning: null,
      warnings: [],
      requests: 0,
      gameCount: library.gameCount,
      ownedCount: Array.isArray(library.games) ? library.games.length : 0,
      totalSeconds: library.totalSeconds == null ? null : library.totalSeconds,
      totalMinutes: library.totalMinutes == null ? null : library.totalMinutes,
      totalHours: library.totalHours == null ? null : library.totalHours,
      playedCount: library.playedCount == null ? null : library.playedCount,
      backlogCount: library.backlogCount == null ? null : library.backlogCount,
      catalogCount: library.catalogCount == null ? null : library.catalogCount,
      startedAt: now,
      finishedAt: now,
      cachedAt: library.fetchedAt || null,
    };
    rememberJob(reused);
    console.log(
      `[games-epic-import ${reused.id}] library reused from cache ` +
        `(${reused.ownedCount} games, fetchedAt=${library.fetchedAt})`
    );
    // M6d: a cached library still needs store metadata for its secondary-only
    // works; the details job is idempotent (per-product cache).
    if (options.autoSecondaryDetails !== false && !options.client && reused.owner) {
      const status = secondaryDetails.kickSecondaryDetailsQuietly(reused.owner, {
        forceKick: true,
        ...secondaryDetails.targetsForOwner(reused.owner),
      });
      reused.secondaryDetailsJobId = (status && status.id) || null;
      reused.secondaryDetailsSkipped = (status && status.skipped) || null;
    }
    return publicStatus(reused);
  }

  const job = {
    id: newJobId(accountId),
    accountId,
    owner: ownerKey || (profile && profile.ownerKey) || null,
    displayName: (profile && profile.displayName) || null,
    status: 'running',
    stage: 'queued',
    done: false,
    deferred: false,
    percent: 0,
    reused: false,
    force,
    code: null,
    error: null,
    warning: null,
    warnings: [],
    requests: 0,
    gameCount: null,
    ownedCount: null,
    totalSeconds: null,
    totalMinutes: null,
    totalHours: null,
    playedCount: null,
    backlogCount: null,
    catalogCount: null,
    startedAt: Date.now(),
  };
  rememberJob(job);
  const client = options.client || epic.createClient({ tokenStore: store });
  enqueue(job, async () => {
    await runImport(job, accountId, client, { ...options, ownerKey });
    // M6d: public store metadata (genres/year/vertical poster) for the works
    // that have no Steam twin. Never kicked with an injected client (tests).
    if (options.autoSecondaryDetails !== false && !options.client && job.owner) {
      const status = secondaryDetails.kickSecondaryDetailsQuietly(job.owner, {
        forceKick: true,
        ...secondaryDetails.targetsForOwner(job.owner),
      });
      job.secondaryDetailsJobId = (status && status.id) || null;
      job.secondaryDetailsSkipped = (status && status.skipped) || null;
    }
  });
  return publicStatus(job);
}

/** Wait for the current job chain to settle (tests / shutdown). */
function whenIdle() {
  return jobs.whenIdle();
}

module.exports = {
  startImport,
  getStatus,
  isRunning,
  publicStatus,
  whenIdle,
  resolveAccountId,
  totalsOf,
  fingerprintOf,
  mergeCatalogSlugs,
  MAX_JOBS,
};
