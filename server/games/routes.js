'use strict';

/**
 * `/api/games/*` router (M1 import/achievements + M2 enrich). Mounted under the existing auth gate in
 * server/index.js, exactly like `/api/books`.
 *
 *   GET  /api/games/profiles
 *   POST /api/games/import            { vanityOrId64, label?, force? }
 *   POST /api/games/import/steam      { steamid64 | vanityUrl, label?, force? }
 *   GET  /api/games/import/:jobId
 *   GET  /api/games/import/status?id=…
 *   POST /api/games/enrich            { profile, force?, phases?, recheckDays? }
 *                                     phases: details|spy|reviews|all (default all)
 *   GET  /api/games/enrich/:jobId
 *   GET  /api/games/enrich/status?id=…
 *   GET  /api/games/stats?profile=steam-<steamid64>&includeFree=0|1&includeDlc=0|1&minHours=N
 *        minHours: -1 = all games (0-hour backlog), 0 = played only (default), N>=1 = N+ hours
 *   GET  /api/games/achievements?profile=…&appid=…&refresh=0|1
 *   GET  /api/games/game/:appid?profile=…
 *   GET  /api/games/steam-art/<type>/<appid>[?h=<hash>]
 *        type: header|capsule|library|small_capsule|icon
 *        The Steam CDN proxy for the owner's ISP-blocked client; the upstream
 *        URL is assembled server-side (allowlisted hosts only).
 *
 * Query contract is strict: an unknown parameter is a 400
 * `unexpected_parameter`, never a silent ignore (same rule as books).
 */

const express = require('express');

const { HttpError } = require('../core/errors');
const { assertOnlyParams, parseBoolParam, parseMinHours, parseForce } = require('../core/params');
const profileRegistry = require('../core/profile');
const config = require('../config');
const steam = require('./steam');
const store = require('./store');
const spy = require('./spy');
const gameCache = require('./game-cache');
const gogCache = require('./gog-cache');
const epicCache = require('./epic-cache');
const gog = require('./gog');
const importJobs = require('./import');
const enrichJobs = require('./enrich');
const personnelJobs = require('./personnel/jobs');
const franchiseJobs = require('./franchise-jobs');
const franchise = require('./franchise');
const secondaryDetails = require('./secondary-details');
const steamArt = require('./steam-art');
const { personnelForGame } = require('./personnel/personnel');
const {
  buildGamesStatsFromCache,
  profileSummary,
  minutesToHours,
  genreNamesOf,
  categoryNamesOf,
} = require('./stats');

const STEAM_ERROR_STATUS = {
  invalid_steamid: 400,
  steamid_mismatch: 400,
  profile_private: 400,
  library_private: 400,
  steam_key_missing: 400,
  stats_private: 400,
  stats_not_found: 404,
  steam_unreachable: 502,
  steam_rate_limited: 429,
  steam_key_invalid: 502,
  steam_forbidden: 502,
  steam_http_error: 502,
  steam_invalid_url: 400,
  store_rate_limited: 429,
  store_unreachable: 502,
  store_http_error: 502,
  store_invalid_appid: 400,
  spy_rate_limited: 429,
  spy_unreachable: 502,
  spy_http_error: 502,
  spy_invalid_appid: 400,
  reviews_rate_limited: 429,
  reviews_unreachable: 502,
  reviews_http_error: 502,
  reviews_invalid_appid: 400,
};

function mapError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof steam.SteamError || err instanceof store.StoreError) {
    const status = STEAM_ERROR_STATUS[err.code] || 502;
    const mapped = new HttpError(status, err.message, err.code);
    if (err.retryAt) mapped.retryAt = err.retryAt;
    return mapped;
  }
  if (err instanceof spy.SpyError) {
    const status = STEAM_ERROR_STATUS[err.code] || 502;
    const mapped = new HttpError(status, err.message, err.code);
    if (err.retryAt) mapped.retryAt = err.retryAt;
    return mapped;
  }
  // Job starters throw plain errors with an explicit HTTP status
  // (`invalid_profile`/`unknown_profile` from the enrich job).
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) {
    return new HttpError(err.status, err.message, err.code || 'games_error');
  }
  return err;
}





/**
 * Resolve `?profile=` to exactly one cached games profile. Mirrors the books
 * contract: missing/repeated/malformed/unknown → 400 with the available keys.
 */
function resolveProfileOrThrow(raw) {
  const value = raw == null ? '' : String(raw).trim();
  const available = gameCache.listProfiles().map((entry) => entry.key);
  const availableText = available.length ? available.join(', ') : '(none)';
  if (!value) {
    throw new HttpError(
      400,
      'Query parameter "profile" is required: exactly one token "steam-<steamid64>". ' +
        `Available: ${availableText}.`,
      'profile_required'
    );
  }
  if (/[,;]/.test(value) || /\s/.test(value)) {
    throw new HttpError(
      400,
      `"profile" accepts exactly ONE profile (steam-<steamid64>), got: ${value}.`,
      'invalid_profile'
    );
  }
  const parsed = gameCache.parseProfileToken(value);
  if (!parsed) {
    throw new HttpError(
      400,
      `"profile": expected "steam-<steamid64>", got: ${value}. Available: ${availableText}.`,
      'invalid_profile'
    );
  }
  const profile = gameCache.getProfile(parsed.userKey);
  const library = gameCache.getLibrary(parsed.userKey);
  if (!profile || !library) {
    throw new HttpError(
      400,
      `"profile": not a cached games profile: ${value}. Available: ${availableText}.`,
      'unknown_profile'
    );
  }
  return { parsed, profile, library, available };
}

function keyInfo() {
  const configured = Boolean(config.loadSteamKey());
  return { configured, source: configured ? config.steamKeySource() : null };
}

/** Epic accounts bound to a Steam owner; a missing cache is not an error. */
function listEpicProfilesSafe() {
  try {
    return epicCache.listEpicProfiles().filter((entry) => !entry.disconnectedAt);
  } catch {
    return [];
  }
}

/**
 * Unified owner snapshot of the games domain (`core/profile`, U8).
 *
 * A games owner is a Steam account; GOG and Epic libraries of the same person
 * are `enrichers` (§6/§14.4: a second account is never a second owner). The
 * legacy per-profile fields (`summary`, `libraries`, `gameCount`, …) are passed
 * through untouched; `metrics` is the very object `summary` carries, so the
 * unified form does not compute anything new.
 *
 * - `id`        the `?profile=` token (`steam-<steamid64>`),
 * - `label`     the name typed at import (`ownerLabel`), `null` when absent —
 *               the same value the switcher already reads,
 * - `updatedAt` `importedAt` (the import write), falling back to the profile
 *               fetch time; no invented timestamps.
 */
function listGameProfileOwners() {
  const gogAccounts = gogCache.listAccounts();
  const epicProfiles = listEpicProfilesSafe();
  const profiles = gameCache.listProfiles().map((entry) => {
    const profile = gameCache.getProfile(entry.userKey);
    const library = gameCache.getLibrary(entry.userKey);
    const summary = profileSummary(profile, library);
    // M6a: same-owner secondary libraries (GOG today, Epic later).
    // A GOG account is never shown under two Steam owners.
    const libraries = gogAccounts
      .filter((account) => account.ownerProfile === entry.key)
      .map((account) => ({
        source: 'gog',
        userKey: account.userKey,
        key: account.key,
        username: account.username,
        connectedAt: account.connectedAt,
        expiresAt: account.expiresAt,
        expired: account.expired,
      }));
    return {
      ...entry,
      summary,
      libraries,
      id: entry.key,
      label: entry.label,
      primary: {
        source: 'steam',
        userKey: entry.userKey,
        status: 'connected',
        updatedAt: entry.importedAt || entry.profileFetchedAt || null,
      },
      enrichers: [
        ...libraries.map((account) => ({
          source: 'gog',
          userKey: account.userKey,
          status: account.expired ? 'expired' : 'connected',
          updatedAt: account.connectedAt || null,
        })),
        ...epicProfiles
          .filter((account) => account.ownerKey === entry.key)
          .map((account) => ({
            source: 'epic',
            userKey: account.accountId,
            status: 'connected',
            updatedAt: account.libraryFetchedAt || account.connectedAt || null,
          })),
      ],
      metrics: summary,
    };
  });

  const gogConnected = gogAccounts.length > 0;
  const gogExpired = gogConnected && gogAccounts.every((account) => account.expired);
  const epicConnected = epicProfiles.length > 0;
  return {
    profiles,
    sources: [
      { id: 'steam', role: 'primary', connected: true, state: 'ready' },
      {
        id: 'gog',
        role: 'enricher',
        connected: gogConnected,
        state: gogConnected ? (gogExpired ? 'expired' : 'ready') : 'missing',
      },
      {
        id: 'epic',
        role: 'enricher',
        connected: epicConnected,
        state: epicConnected ? 'ready' : 'missing',
      },
    ],
  };
}

profileRegistry.registerDomainProfiles('games', listGameProfileOwners);

function createRouter(deps = {}) {
  const client = deps.client || steam.createClient();
  const importer = deps.importer || importJobs;
  const storeClient = deps.storeClient || null;
  const router = express.Router();
  const artHandler = steamArt.createSteamArtHandler({
    fetch: deps.steamArtFetch || deps.fetch,
  });

  /* ------------------------- profiles ------------------------- */

  router.get('/profiles', (req, res) => {
    // The unified owner snapshot (core/profile) is the single source of the
    // list; the legacy domain fields stay exactly where they were.
    const { profiles, sources } = profileRegistry.snapshot('games');
    const gogAccounts = gogCache.listAccounts();
    res.status(200).json({
      profiles,
      connected: ['steam', ...(gogAccounts.length ? ['gog'] : [])],
      availableProfileKeys: profiles.map((entry) => entry.key),
      // Boolean only: the key value is never exposed.
      steamKey: keyInfo(),
      gog: {
        configured: true,
        accounts: gogAccounts.length,
        // Source only (`env`/`file`/`default`), never the client value.
        clientSource: gog.clientSource(),
      },
      cacheDir: gameCache.GAMES_CACHE_DIR,
      libraryTtlHours: Math.round(gameCache.libraryTtlMs() / 3600000),
      sources,
    });
  });

  /* ------------------------- import -------------------------- */

  function startFromRequest(req, res) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const rawTarget =
      body.vanityOrId64 != null
        ? body.vanityOrId64
        : body.steamid64 != null
          ? body.steamid64
          : body.vanityUrl != null
            ? body.vanityUrl
            : body.vanity != null
              ? body.vanity
              : null;
    if (rawTarget == null || String(rawTarget).trim() === '') {
      throw new HttpError(
        400,
        'Body must contain "vanityOrId64" (steamid64, vanity name, or a steamcommunity profile URL).',
        'target_required'
      );
    }
    const force = parseForce(body.force != null ? body.force : req.query.force);
    const label =
      typeof body.label === 'string' && body.label.trim()
        ? body.label.trim().slice(0, 80)
        : null;
    const job = importer.startImport(rawTarget, {
      client,
      force,
      label,
      autoEnrich: deps.autoEnrich !== false,
      autoPersonnel: deps.autoPersonnel !== false,
      autoFranchise: deps.autoFranchise !== false,
      personnelOptions: deps.personnelOptions,
      franchiseOptions: deps.franchiseOptions,
      enrichClient: storeClient || undefined,
      // M4: the automatic pass is details+spy; `reviews` stays manual.
      enrichPhases: deps.enrichPhases,
      spyClient: deps.spyClient || undefined,
    });
    const created = job.status === 'running' && !job.reused && job.stage === 'queued';
    res.status(created ? 201 : 200).json(job);
  }

  router.post('/import', (req, res, next) => {
    try {
      startFromRequest(req, res);
    } catch (err) {
      next(mapError(err));
    }
  });

  router.post('/import/steam', (req, res, next) => {
    try {
      startFromRequest(req, res);
    } catch (err) {
      next(mapError(err));
    }
  });

  /**
   * `POST /api/games/refresh` — re-read the library/achievements of an already
   * imported profile (ИГРЫ-АРХИТЕКТУРА §5). Always `force`: a manual refresh
   * exists to bypass the TTLs, so it never returns the cached snapshot.
   * Body: `{ profile: "steam-<steamid64>" }` (query fallback for curl).
   */
  router.post('/refresh', (req, res, next) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const requested = body.profile != null ? body.profile : req.query.profile;
      const scope = resolveProfileOrThrow(requested);
      const job = importer.startImport(scope.parsed.userKey, {
        client,
        force: true,
        autoEnrich: deps.autoEnrich !== false,
        autoPersonnel: deps.autoPersonnel !== false,
        autoFranchise: deps.autoFranchise !== false,
        personnelOptions: deps.personnelOptions,
        franchiseOptions: deps.franchiseOptions,
        enrichClient: storeClient || undefined,
        enrichPhases: deps.enrichPhases,
        spyClient: deps.spyClient || undefined,
      });
      const created = job.status === 'running' && !job.reused && job.stage === 'queued';
      res.status(created ? 201 : 200).json(job);
    } catch (err) {
      next(mapError(err));
    }
  });

  router.get('/import/status', (req, res, next) => {
    try {
      const id = req.query.id;
      if (id == null || String(id).trim() === '') {
        throw new HttpError(400, 'Query parameter "id" is required.', 'job_id_required');
      }
      const status = importer.getStatus(String(id).trim());
      if (!status) throw new HttpError(404, 'Unknown import job id.', 'unknown_job');
      res.status(200).json(status);
    } catch (err) {
      next(mapError(err));
    }
  });

  router.get('/import/:jobId', (req, res, next) => {
    try {
      const status = importer.getStatus(req.params.jobId);
      if (!status) throw new HttpError(404, 'Unknown import job id.', 'unknown_job');
      res.status(200).json(status);
    } catch (err) {
      next(mapError(err));
    }
  });

  /* --------------------------- enrich ------------------------- */

  /**
   * `POST /api/games/enrich` — fetch metadata for the library of one profile.
   * Body: `{ profile, force?, phases?, recheckDays? }` (query fallback for
   * curl). `phases` is `details` | `spy` | `reviews` | `all` (comma-separated
   * or an array); the default is `all`, i.e. run whatever is missing/stale.
   * Resumable: the cache is the progress; `force` re-fetches all.
   */
  router.post('/enrich', (req, res, next) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const requested = body.profile != null ? body.profile : req.query.profile;
      const scope = resolveProfileOrThrow(requested);
      const force = parseForce(body.force != null ? body.force : req.query.force);
      const rawPhases =
        body.phases != null
          ? body.phases
          : body.phase != null
            ? body.phase
            : req.query.phases != null
              ? req.query.phases
              : req.query.phase;
      // Unknown phase names are a 400 (`invalid_phases`), never a silent no-op.
      const phases = enrichJobs.parsePhases(rawPhases, 'all');
      let recheckDays;
      const rawRecheck = body.recheckDays != null ? body.recheckDays : req.query.recheckDays;
      if (rawRecheck != null && String(rawRecheck).trim() !== '') {
        const value = Number(rawRecheck);
        if (!Number.isFinite(value) || value < 0) {
          throw new HttpError(
            400,
            'Parameter "recheckDays" must be a non-negative number of days.',
            'invalid_recheckDays'
          );
        }
        recheckDays = value;
      }
      const job = enrichJobs.startEnrich(scope.parsed.key, {
        force,
        recheckDays,
        phases,
        client: storeClient || undefined,
        spyClient: deps.spyClient || undefined,
        reviewsClient: deps.reviewsClient || undefined,
      });
      // Credits follow the details: the personnel pass waits for this enrich
      // job (`waitForEnrich`), so the widget gets people without a second
      // manual step (ИГРЫ §2.4 fix).
      let personnelJob = null;
      if (deps.autoPersonnel !== false) {
        personnelJob = personnelJobs.kickQuietly(scope.parsed.key, {
          ...(deps.personnelOptions || {}),
          waitForEnrich: true,
          // Explicit «Обогатить» must not be swallowed by the lazy cooldown.
          forceKick: true,
        });
      }
      // M4-B: franchises/release years follow the same explicit action and
      // share the WDQS lock with the credits pass.
      let franchiseJob = null;
      if (deps.autoFranchise !== false) {
        franchiseJob = franchiseJobs.kickQuietly(scope.parsed.key, {
          ...(deps.franchiseOptions || {}),
          waitForEnrich: true,
          forceKick: true,
        });
      }
      const created = job.status === 'running' && job.stage === 'queued';
      res.status(created ? 202 : 200).json({
        ...job,
        personnelJobId: personnelJob && personnelJob.id ? personnelJob.id : null,
        personnelSkipped: personnelJob ? personnelJob.skipped || null : null,
        franchiseJobId: franchiseJob && franchiseJob.id ? franchiseJob.id : null,
        franchiseSkipped: franchiseJob ? franchiseJob.skipped || null : null,
      });
    } catch (err) {
      next(mapError(err));
    }
  });

  router.get('/enrich/status', (req, res, next) => {
    try {
      const id = req.query.id;
      if (id == null || String(id).trim() === '') {
        throw new HttpError(400, 'Query parameter "id" is required.', 'job_id_required');
      }
      const status = enrichJobs.getStatus(String(id).trim());
      if (!status) throw new HttpError(404, 'Unknown enrich job id.', 'unknown_job');
      res.status(200).json(status);
    } catch (err) {
      next(mapError(err));
    }
  });

  router.get('/enrich/:jobId', (req, res, next) => {
    try {
      const status = enrichJobs.getStatus(req.params.jobId);
      if (!status) throw new HttpError(404, 'Unknown enrich job id.', 'unknown_job');
      res.status(200).json(status);
    } catch (err) {
      next(mapError(err));
    }
  });

  /* --------------------------- stats -------------------------- */

  /**
   * `GET /api/games/secondary-details/status?profile=…` — the owner-facing
   * diagnostic for «вне Steam» metadata (M6d). Answers only from the cache and
   * the job/breaker state, never with a network request:
   *
   *   { resolved, total, running, bySource {gog, epic}, slugless[],
   *     lastErrors[] (max 5), cooldownUntil, breakers, kick, lastRunAt }
   *
   * `resolved < total` means some store page is still missing; `slugless` names
   * the Epic works the job could not even address (title probe failed).
   */
  router.get('/secondary-details/status', (req, res, next) => {
    try {
      assertOnlyParams(
        req,
        ['profile'],
        'GET /api/games/secondary-details/status'
      );
      const scope = resolveProfileOrThrow(req.query.profile);
      res.status(200).json(secondaryDetails.statusForOwner(scope.parsed.key));
    } catch (err) {
      next(mapError(err));
    }
  });

  router.get('/stats', (req, res, next) => {
    try {
      assertOnlyParams(
        req,
        ['profile', 'includeFree', 'includeDlc', 'minHours'],
        'GET /api/games/stats'
      );
      const includeFree = parseBoolParam(req.query.includeFree, 'includeFree', true);
      const includeDlc = parseBoolParam(req.query.includeDlc, 'includeDlc', false);
      // Default 0: only games the owner actually played (M5-B requirement).
      // `minHours=-1` brings the 0-hour backlog back.
      const minHours = parseMinHours(req.query.minHours, 0);
      const scope = resolveProfileOrThrow(req.query.profile);
      const stats = buildGamesStatsFromCache(scope.parsed.key, {
        includeFree,
        includeDlc,
        minHours,
        // The UI polls `summary.metadata.running`; the flag comes from the
        // in-process enrich job registry (no extra cache read, no request).
        enrichRunning: enrichJobs.isRunning(scope.parsed.key),
      });
      if (!stats) {
        throw new HttpError(
          400,
          `"profile": no library snapshot for ${scope.parsed.key}; run the import first.`,
          'profile_not_imported'
        );
      }
      // M6d lazy kick: the import-time kick alone is not enough — an Epic/GOG
      // library imported **before** the details job existed never got one, and
      // the «Вне Steam» card stayed empty forever. Coalesced (`kickGate`),
      // fire-and-forget (the response is never blocked) and disable-able for
      // tests. `running` is re-read so the very first answer already says so.
      if (deps.secondaryDetailsKick !== false) {
        try {
          secondaryDetails.kickFromStats(
            scope.parsed.key,
            stats.meta && stats.meta.secondaryDetails,
            { client: deps.secondaryDetailsClient || undefined }
          );
          if (stats.meta && stats.meta.secondaryDetails) {
            stats.meta.secondaryDetails.running = secondaryDetails.runningFor(
              scope.parsed.key
            );
          }
        } catch (err) {
          // A kick must never break the stats answer.
        }
      }
      res.set('X-Games-Build-Ms', String(stats.meta.buildMs));
      res.status(200).json(stats);
    } catch (err) {
      next(mapError(err));
    }
  });

  /* ----------------------- achievements ----------------------- */

  function globalPercentFor(global, apiname) {
    if (!global || !global.byName || !apiname) return null;
    const direct = global.byName[apiname];
    if (direct != null) return direct;
    return global.byName[String(apiname).toLowerCase()] ?? null;
  }

  router.get('/achievements', async (req, res, next) => {
    try {
      assertOnlyParams(
        req,
        ['profile', 'appid', 'refresh'],
        'GET /api/games/achievements'
      );
      const scope = resolveProfileOrThrow(req.query.profile);
      const appid = Number(req.query.appid);
      if (!Number.isInteger(appid) || appid <= 0) {
        throw new HttpError(400, 'Query parameter "appid" must be a positive integer.', 'invalid_appid');
      }
      const game = (scope.library.games || []).find((entry) => entry.appid === appid) || null;
      const refresh = parseBoolParam(req.query.refresh, 'refresh', false);
      const cached = gameCache.getAchievements(scope.parsed.userKey, appid);
      let doc = cached;
      let fetched = false;
      if (!doc || refresh || !gameCache.isFresh(doc, gameCache.achievementsTtlMs())) {
        doc = await client.getAchievements(scope.parsed.userKey, appid);
        doc = {
          ...doc,
          fetchedAt: new Date().toISOString(),
        };
        await gameCache.saveAchievements(scope.parsed.userKey, appid, doc);
        fetched = true;
      }

      let global = gameCache.getGlobal(appid);
      let globalFetched = false;
      let globalError = null;
      if (!global || !gameCache.isFresh(global, gameCache.globalTtlMs())) {
        try {
          const fresh = await client.getGlobalPercentages(appid);
          global = { ...fresh, fetchedAt: new Date().toISOString() };
          await gameCache.saveGlobal(appid, global);
          globalFetched = true;
        } catch (err) {
          globalError = (err && err.code) || 'global_failed';
        }
      }

      const items = (doc.achievements || []).map((entry) => ({
        apiname: entry.apiname,
        name: entry.name,
        description: entry.description,
        achieved: entry.achieved,
        unlockTimestamp: entry.unlockTimestamp,
        unlockAt: entry.unlockAt,
        icon: entry.achieved ? entry.iconOpen || entry.iconClosed : entry.iconClosed || entry.iconOpen,
        globalPercent: globalPercentFor(global, entry.apiname),
      }));
      const rareUnlocked = items.filter(
        (entry) => entry.achieved && entry.globalPercent != null && entry.globalPercent < 5
      ).length;
      res.status(200).json({
        profile: scope.parsed.key,
        appid,
        inLibrary: Boolean(game),
        name: (game && game.name) || doc.gameName || null,
        gameName: doc.gameName || null,
        hoursPlayedStats: doc.statsHoursPlayed,
        unlocked: doc.unlockedCount,
        total: doc.totalCount,
        percent: doc.totalCount ? Math.round((doc.unlockedCount / doc.totalCount) * 1000) / 10 : 0,
        rareUnlocked,
        rareThresholdPercent: 5,
        items,
        source: 'steam-community',
        fetched,
        fetchedAt: doc.fetchedAt || null,
        globalFetched,
        globalAvailable: Boolean(global),
        globalFetchedAt: global ? global.fetchedAt || null : null,
        globalError,
      });
    } catch (err) {
      next(mapError(err));
    }
  });

  /* ------------------------ game card ------------------------- */

  // Steam art CDN proxy (fix-round 02.11.2026, ИГРЫ §8.2 artwork). The owner's
  // ISP blocks the Steam CDN in Vietnam; the server relays the public asset.
  // The upstream URL is built from type/appid/hash, never from client input.
  // The global `/api` auth gate in `server/index.js` already protects it.
  router.get(
    '/steam-art/:type/:appid',
    (req, res, next) => {
      try {
        assertOnlyParams(req, ['h'], 'GET /api/games/steam-art/:type/:appid');
      } catch (err) {
        return next(err);
      }
      return artHandler(req, res, next);
    }
  );

  router.get('/game/:appid', (req, res, next) => {
    try {
      assertOnlyParams(req, ['profile'], 'GET /api/games/game/:appid');
      const scope = resolveProfileOrThrow(req.query.profile);
      const appid = Number(req.params.appid);
      if (!Number.isInteger(appid) || appid <= 0) {
        throw new HttpError(400, 'Path parameter "appid" must be a positive integer.', 'invalid_appid');
      }
      const game = (scope.library.games || []).find((entry) => entry.appid === appid);
      if (!game) {
        throw new HttpError(
          404,
          `App ${appid} is not in the ${scope.parsed.key} library.`,
          'game_not_in_library'
        );
      }
      const detailsDoc = gameCache.getDetails(appid);
      const details =
        detailsDoc && detailsDoc.success
          ? {
              type: detailsDoc.type || null,
              name: detailsDoc.name || null,
              isFree: typeof detailsDoc.is_free === 'boolean' ? detailsDoc.is_free : null,
              developers: detailsDoc.developers || [],
              publishers: detailsDoc.publishers || [],
              genres: genreNamesOf(detailsDoc),
              categories: categoryNamesOf(detailsDoc),
              releaseDate: (detailsDoc.release_date && detailsDoc.release_date.date) || null,
              releaseYear: detailsDoc.releaseYear == null ? null : detailsDoc.releaseYear,
              releasePrecision: detailsDoc.releasePrecision || null,
              earlyAccess: Boolean(detailsDoc.earlyAccess),
              metacritic:
                detailsDoc.metacritic && detailsDoc.metacritic.score != null
                  ? detailsDoc.metacritic.score
                  : null,
              dlc: Array.isArray(detailsDoc.dlc) ? detailsDoc.dlc : [],
              dlcCount: detailsDoc.dlcCount == null ? null : detailsDoc.dlcCount,
              platforms: detailsDoc.platforms || null,
              headerImage: detailsDoc.headerImage || null,
              capsuleImage: detailsDoc.capsuleImage || null,
              screenshots: Array.isArray(detailsDoc.screenshots) ? detailsDoc.screenshots : [],
              fetchedAt: detailsDoc.fetchedAt || null,
              metadataSource: detailsDoc.metadataSource || 'steam-store',
            }
          : null;
      const cached = gameCache.getAchievements(scope.parsed.userKey, appid);
      // M4: cached tags and review summary (no network, no fabrication).
      const spyDoc = gameCache.getSpy(appid);
      const tags = spyDoc && spyDoc.success && Array.isArray(spyDoc.tags) ? spyDoc.tags : [];
      const reviewDoc = gameCache.getReviews(appid);
      const review =
        reviewDoc && reviewDoc.success
          ? {
              score: reviewDoc.score == null ? null : reviewDoc.score,
              desc: reviewDoc.desc || null,
              positive: reviewDoc.positive,
              negative: reviewDoc.negative,
              total: reviewDoc.total,
              fetchedAt: reviewDoc.fetchedAt || null,
              source: 'steam-reviews',
            }
          : null;
      // M3: cached credits for this appid (no network, no fabrication).
      const personnel = personnelForGame(appid);
      // M4-B: franchise / release year from links/<appid>.json (written by the
      // WD pass). `null` when Wikidata has not answered yet — the card says so
      // instead of pretending the game has no franchise.
      const wdLinks = franchise.readLinks(appid);
      const achievements = cached
        ? {
            unlocked: cached.unlockedCount,
            total: cached.totalCount,
            percent: cached.totalCount
              ? Math.round((cached.unlockedCount / cached.totalCount) * 1000) / 10
              : 0,
            fetchedAt: cached.fetchedAt || null,
            items: (cached.achievements || []).map((entry) => ({
              apiname: entry.apiname,
              name: entry.name,
              description: entry.description,
              achieved: entry.achieved,
              unlockTimestamp: entry.unlockTimestamp,
              unlockAt: entry.unlockAt,
            })),
          }
        : null;
      res.status(200).json({
        profile: scope.parsed.key,
        appid,
        name: game.name || null,
        hours: minutesToHours(game.playtime_forever),
        hours2w: game.playtime_2weeks ? minutesToHours(game.playtime_2weeks) : 0,
        lastPlayed: Number(game.rtime_last_played)
          ? new Date(Number(game.rtime_last_played) * 1000).toISOString()
          : null,
        iconUrl: game.img_icon_url
          ? `https://media.steampowered.com/steamcommunity/public/images/apps/${appid}/${game.img_icon_url}.jpg`
          : null,
        achievements,
        // M2: store appdetails (null until the enrich job has fetched it).
        details,
        // M4: SteamSpy tags (top-20, weighted) and the community review grade
        // (reference only — Steam has no personal 1..10 ratings, ИГРЫ §1.2).
        tags,
        review,
        // M3: credits for this game from cache-games/personnel/<appid>.json
        // (studios from details + Wikidata/Moby, people, honest `pending`).
        // Never a network call — the personnel job fills the cache.
        personnel: personnelForGame(appid),
        // M4-B: Wikidata series + P577 year (cache-games/links/<appid>.json).
        franchise: wdLinks.franchiseKey
          ? {
              key: wdLinks.franchiseKey,
              qid: wdLinks.franchise ? wdLinks.franchise.qid : null,
              label:
                (wdLinks.franchise && (wdLinks.franchise.labelEn || wdLinks.franchise.labelRu)) ||
                null,
              labelRu: (wdLinks.franchise && wdLinks.franchise.labelRu) || null,
              source: 'wikidata',
              confidence: 'high',
            }
          : null,
        releaseYearWikidata: wdLinks.releaseYear,
        releasePrecisionWikidata: wdLinks.releasePrecision,
        links: {
          steam: `https://store.steampowered.com/app/${appid}`,
          steamdb: `https://steamdb.info/app/${appid}/`,
        },
        meta: {
          achievementsCached: Boolean(cached),
          detailsCached: Boolean(details),
          tagsCached: tags.length > 0,
          reviewCached: Boolean(review),
          personnelCached: Boolean(personnel && personnel.coverage),
          pending: [
            ...new Set([
              ...(details ? [] : ['details']),
              ...(tags.length ? [] : ['tags']),
              ...(review ? [] : ['reviews']),
              // `personnelForGame` already says whether details/credits are
              // missing for this appid, so the card never claims a full
              // payload it does not have (and never lists what is present).
              ...(personnel && Array.isArray(personnel.pending)
                ? personnel.pending
                : ['personnel']),
              ...(wdLinks.qid ? [] : ['links.wikidata']),
              'links.igdb',
            ]),
          ],
        },
      });
    } catch (err) {
      next(mapError(err));
    }
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
