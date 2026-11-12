'use strict';

/**
 * Steam import jobs for the games tab (M1).
 *
 *   POST /api/games/import        { vanityOrId64, force? }  -> 201 job
 *   POST /api/games/import/steam  { steamid64 | vanityUrl } -> 201 job (alias)
 *   GET  /api/games/import/:jobId -> { status, stage, code, error, ... }
 *   GET  /api/games/import/status?id=... -> same (spec §3.8 spelling)
 *
 * Stages: queued -> bootstrap (profile XML) -> summaries -> library
 *         (GetOwnedGames) -> done, or failed.
 *
 * Requests per full import: 1 community (profile XML) + 3 Web API
 * (GetPlayerSummaries, GetOwnedGames, GetRecentlyPlayedGames) — no pagination,
 * no scraping of the login-gated `/games` family. The recently-played call is
 * the launch/2-week source and is non-fatal: without it the library is simply
 * the plain GetOwnedGames snapshot.
 *
 * Degradation (§10.4): without `STEAM_API_KEY` the import does NOT fail. It
 * saves the profile plus the three most-recent games from the profile XML as a
 * `libraryPartial` snapshot and reports `steam_key_missing`; achievements and
 * the profile keep working.
 *
 * Idempotency: a library snapshot younger than the library TTL (24 h) is
 * reused instead of hitting Steam again; `force: true` bypasses the guard.
 * Jobs for the same profile are serialized through one chain and coalesce into
 * the running job.
 */

const config = require('../config');
const { createJobs } = require('../core/jobs');
const { round1 } = require('../core/stats');
const steam = require('./steam');
const gameCache = require('./game-cache');
const enrichJobs = require('./enrich');
const personnelJobs = require('./personnel/jobs');
const franchiseJobs = require('./franchise-jobs');

/**
 * Job registry (core/jobs): single-flight per `targetKey` (with the pre-resolve
 * vanity kept in `aliasKeys`), one import chain, 20-job ring. The domain keeps
 * `publicStatus` and its own fields; `targetKey` stays the coalescing key.
 */
const jobs = createJobs({
  name: 'games-import',
  idPrefix: 'games-steam',
  maxJobs: 20,
  keyOf: (job) => job.targetKey,
  maskError: (err) => steam.maskSecrets(err && err.message ? err.message : 'неизвестная ошибка'),
  errorCode: 'games_import_failed',
});

const MAX_JOBS = jobs.maxJobs;

function newJobId(seed) {
  return jobs.newId(seed);
}

function rememberJob(job) {
  return jobs.remember(job);
}

function findRunningJob(targetKey) {
  return jobs.findRunning(targetKey);
}

/** Public job view: no key, no key source value, no raw HTTP details. */
function publicStatus(job) {
  if (!job) return null;
  return {
    // Unified job view (id/status/stage/progress/startedAt/finishedAt/error/
    // partial); every legacy field below keeps its exact value.
    ...jobs.snapshot(job),
    jobId: job.id,
    id: job.id,
    source: 'steam',
    profile: job.profile,
    target: job.target,
    status: job.status,
    stage: job.stage,
    done: job.done,
    percent: job.percent,
    reused: job.reused,
    force: job.force,
    libraryPartial: job.libraryPartial,
    code: job.code,
    error: job.error,
    warning: job.warning,
    warnings: job.warnings ? [...job.warnings] : [],
    keySource: job.keySource,
    requests: job.requests,
    gameCount: job.gameCount,
    ownedCount: job.ownedCount,
    totalMinutes: job.totalMinutes,
    totalHours: job.totalHours,
    playedCount: job.playedCount,
    backlogCount: job.backlogCount,
    // `GetRecentlyPlayedGames` merge (03.11.2026): how many library rows it
    // refreshed and when. Null when the call was not made (partial library) or
    // failed — the import itself stays `done` either way.
    recentPlayedFetchedAt: job.recentPlayedFetchedAt || null,
    recentPlayedCount: job.recentPlayedCount == null ? null : job.recentPlayedCount,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    elapsedMs: job.finishedAt ? job.finishedAt - job.startedAt : null,
    cachedAt: job.cachedAt || null,
    // Auto-enrich (§UX): the enrich job started right after the library
    // landed, so the UI can follow it without guessing. Null when the kick
    // was disabled, skipped (partial library) or failed.
    enrichJobId: job.enrichJobId || null,
    enrichSkipped: job.enrichSkipped || null,
    // M4: which phases the automatic kick started (`details`+`spy`; `reviews`
    // stays manual, so the UI never waits for it).
    enrichPhases: job.enrichPhases ? [...job.enrichPhases] : [],
    // M3: the Wikidata/Moby pass started right after the store enrich, so the
    // personnel widget has people credits by the time the dashboard opens.
    personnelJobId: job.personnelJobId || null,
    personnelSkipped: job.personnelSkipped || null,
    // M4-B: Wikidata franchises + release years, started after the credits
    // pass and sharing its WDQS lock.
    franchiseJobId: job.franchiseJobId || null,
    franchiseSkipped: job.franchiseSkipped || null,
  };
}

function getStatus(id) {
  return publicStatus(jobs.get(String(id || '')));
}

function isRunning(targetKey) {
  return Boolean(findRunningJob(targetKey));
}

function enqueue(job, task) {
  return jobs.run(job, task, {
    onError: (self, err) => {
      // SteamError messages are already masked; mask once more so a wrapped
      // URL (with `key=`) can never reach a log or the job status.
      jobs.fail(self, err);
      console.error(`[games-import ${self.id}] ${self.code}: ${self.error}`);
    },
    onFinish: (self) => {
      console.log(
        `[games-import ${self.id}] ${self.status} after ${self.finishedAt - self.startedAt}ms ` +
          `(stage=${self.stage}, requests=${self.requests}, ` +
          `games=${self.gameCount == null ? '—' : self.gameCount}, ` +
          `partial=${self.libraryPartial}${self.code ? `, code=${self.code}` : ''})`
      );
    },
  });
}

/**
 * Phases an *automatic* enrich runs after an import/refresh (M4 policy).
 *
 * `details` is what the whole tab needs (genres, years, modes, DLC facts) and
 * `spy` is what the tag wall needs (SteamSpy tags are also copied into
 * `gamesIndex`). The third phase, `reviews`, is deliberately NOT here: it is
 * another ~340 requests × 1.7 s ≈ 10 minutes of background traffic that no
 * dashboard block depends on (the review grade is reference-only, ИГРЫ §1.2).
 * The user asks for it explicitly: `POST /api/games/enrich { phases: "reviews" }`
 * (or the «Обогатить» button with that phase). See ИГРЫ-АРХИТЕКТУРА §9 M4.
 */
const AUTO_ENRICH_PHASES = ['details', 'spy'];

/**
 * Metadata enrichment is a follow-up job, not part of the import contract: the
 * library is the primary artifact (same policy as the books resolve chain).
 * Called from the route layer right after a successful import/refresh so the
 * UI does not have to POST /api/games/enrich itself. `enrichJobs` coalesces
 * into an already running job for the same profile, so a double import never
 * queues two enrich runs. A failure here becomes a job warning — the import
 * stays `done`.
 */
function kickEnrichQuietly(job, options = {}) {
  if (options.autoEnrich !== true) return null;
  if (!job || !job.profile) return null;
  // A partial library (no STEAM_API_KEY) has 3 games at most and no hours;
  // enriching it would spend store requests on a snapshot that is about to be
  // replaced by the next real import.
  if (job.libraryPartial) {
    job.enrichSkipped = 'library_partial';
    return null;
  }
  // M4: the automatic pass is details+spy, never `all` (reviews is manual).
  const phases = Array.isArray(options.enrichPhases) && options.enrichPhases.length
    ? options.enrichPhases
    : AUTO_ENRICH_PHASES;
  try {
    const enrichJob = enrichJobs.startEnrich(job.profile, {
      client: options.enrichClient || undefined,
      spyClient: options.spyClient || undefined,
      phases,
    });
    job.enrichPhases = phases;
    job.enrichJobId = enrichJob.id;
    console.log(
      `[games-import ${job.id}] store enrich kicked: ${enrichJob.id} ` +
        `(stage=${enrichJob.stage}, running=${enrichJob.status === 'running'})`
    );
    return enrichJob;
  } catch (err) {
    const message = steam.maskSecrets(err && err.message ? err.message : 'enrich failed');
    job.warnings = [...(job.warnings || []), `enrich_${(err && err.code) || 'failed'}`];
    job.warning = [job.warning, `обогащение: ${message}`].filter(Boolean).join(' ');
    console.warn(`[games-import ${job.id}] enrich kick failed (import kept): ${message}`);
    return null;
  }
}

/**
 * Personnel (Wikidata/Moby) enrichment is the *second* follow-up: it only has
 * something to do once `details/<appid>.json` exists, so the job waits for the
 * enrich chain it was started next to. Without this kick the personnel route
 * had no writer at all and composers/designers never arrived in production
 * (ИГРЫ §2.4 fix, 01.11.2026). Fire-and-forget: a failure is a job warning, the
 * import stays `done`.
 */
function kickPersonnelQuietly(job, options = {}) {
  if (options.autoPersonnel === false) return null;
  if (!job || !job.profile) return null;
  if (job.libraryPartial) {
    job.personnelSkipped = 'library_partial';
    return null;
  }
  const status = personnelJobs.kickQuietly(job.profile, {
    ...(options.personnelOptions || {}),
    waitForEnrich: true,
    // An explicit import/refresh is a user action: it must not be swallowed by
    // the lazy re-kick cooldown (coalescing still prevents a second pass).
    forceKick: true,
  });
  if (status && status.id) {
    job.personnelJobId = status.id;
    console.log(
      `[games-import ${job.id}] personnel kicked: ${status.id} ` +
        `(stage=${status.stage}, running=${status.status === 'running'})`
    );
  } else {
    job.personnelJobId = null;
    job.personnelSkipped = (status && status.skipped) || 'skipped';
  }
  return status;
}

/**
 * Franchise (Wikidata P179/P577) is the third follow-up: it only needs the
 * library appids, so it does not wait for details. It takes the *same* WDQS
 * lock as the personnel pass (`personnel.lock`), so the two passes queue
 * instead of querying Wikidata at the same time; a failure/skip is a job
 * warning, the import stays `done`.
 */
function kickFranchiseQuietly(job, options = {}) {
  // Opt-in from the route layer (`autoFranchise: deps.autoFranchise !== false`):
  // direct `startImport` calls (tests, scripts) must not silently spend WDQS.
  if (options.autoFranchise !== true) return null;
  if (!job || !job.profile) return null;
  if (job.libraryPartial) {
    job.franchiseSkipped = 'library_partial';
    return null;
  }
  const status = franchiseJobs.kickQuietly(job.profile, {
    ...(options.franchiseOptions || {}),
    waitForEnrich: true,
    forceKick: true,
  });
  if (status && status.id) {
    job.franchiseJobId = status.id;
    console.log(
      `[games-import ${job.id}] franchise kicked: ${status.id} ` +
        `(stage=${status.stage}, running=${status.status === 'running'})`
    );
  } else {
    job.franchiseJobId = null;
    job.franchiseSkipped = (status && status.skipped) || 'skipped';
  }
  return status;
}

/** Resolve a vanity against the cached profiles (idempotent re-import). */
function cachedProfileByVanity(vanity) {
  const wanted = String(vanity || '').toLowerCase();
  for (const entry of gameCache.listProfiles()) {
    const profile = gameCache.getProfile(entry.userKey);
    if (!profile) continue;
    if (String(profile.customUrl || '').toLowerCase() === wanted) return profile;
  }
  return null;
}

function partialLibraryFromProfile(profile, fetchedAt) {
  const games = (profile.mostPlayedGames || []).map((game) => ({
    appid: game.appid,
    name: game.name || null,
    // hoursOnRecord is what the profile XML shows for the three most recent
    // games; it is a fallback, NOT the library (which needs the Web API).
    playtime_forever: Math.round((Number(game.hoursOnRecord) || 0) * 60),
    playtime_2weeks: game.hoursPlayed2w ? Math.round(Number(game.hoursPlayed2w) * 60) : null,
    rtime_last_played: 0,
    img_icon_url: null,
    has_community_visible_stats: null,
    has_leaderboards: null,
    playtime_windows_forever: 0,
    playtime_mac_forever: 0,
    playtime_linux_forever: 0,
    playtime_deck_forever: 0,
    playtime_disconnected: 0,
    content_descriptorids: null,
  }));
  return {
    fetchedAt,
    partial: true,
    source: 'steam-profile-xml',
    game_count: null,
    games,
    totalMinutes: games.reduce((sum, game) => sum + game.playtime_forever, 0),
    fingerprint: steam.libraryFingerprint(games, null),
  };
}

/**
 * Merge a `GetRecentlyPlayedGames` snapshot into the owned-games rows.
 *
 * Why: `GetOwnedGames` can answer with `rtime_last_played: 0` on every row for
 * an owner who still plays (verified 03.11.2026 on steam-76561198203871831:
 * 226 owned rows, all rtime=0; `GetRecentlyPlayedGames` returned the 6 games of
 * the last two weeks). The recently-played list is the canonical launch source,
 * so its numbers win where they exist.
 *
 * Rules (`merge-only`):
 *   - an appid that is not in the library is ignored — the library is the
 *     owner's journal, RGP never adds a game to it;
 *   - `rtime_last_played: 0` from RGP is "not exposed", not "never played", so
 *     an existing timestamp is kept;
 *   - `playtime_forever` only grows (a staler RGP snapshot must not shrink a
 *     library row);
 *   - `playtime_2weeks` is copied when present (RGP lists exactly the games
 *     with activity in the window).
 *
 * Mutates the freshly parsed library rows in place; returns the merge count.
 */
function mergeRecentlyPlayed(games, recent) {
  const list = Array.isArray(games) ? games : [];
  const recentGames = recent && Array.isArray(recent.games) ? recent.games : [];
  if (!recentGames.length) return 0;
  const byAppid = new Map();
  for (const game of list) byAppid.set(game.appid, game);
  let merged = 0;
  for (const entry of recentGames) {
    const game = byAppid.get(entry.appid);
    if (!game) continue;
    merged++;
    if (Number(entry.rtime_last_played) > 0) {
      game.rtime_last_played = Number(entry.rtime_last_played);
    }
    if (Number(entry.playtime_2weeks) > 0) {
      game.playtime_2weeks = Number(entry.playtime_2weeks);
    }
    const forever = Number(entry.playtime_forever);
    if (Number.isFinite(forever) && forever > (Number(game.playtime_forever) || 0)) {
      game.playtime_forever = forever;
    }
  }
  return merged;
}

async function runImport(job, target, client, options) {
  const nowIso = () => new Date().toISOString();

  /* ------------------------- 1. profile XML ------------------------- */
  job.stage = 'bootstrap';
  job.requests++;
  const profile = await client.getProfile(target);
  if (
    (profile.privacyState && profile.privacyState !== 'public') ||
    (profile.visibilityState != null && profile.visibilityState !== 3)
  ) {
    throw new steam.SteamError(
      `Профиль Steam закрыт (privacyState=${profile.privacyState || '?'}, ` +
        `visibilityState=${profile.visibilityState == null ? '?' : profile.visibilityState}). ` +
        'Откройте профиль и «Game details» в настройках приватности Steam и повторите импорт.',
      'profile_private'
    );
  }
  const steamId64 = profile.steamId64;
  // Defensive (P0/s): the community XML is authoritative for the owner. If the
  // resolved id64 is not the one that was asked for, the library that follows
  // would be attributed to the wrong owner — the one thing the games model
  // forbids (ИГРЫ §2.0: two owners are never merged). Fail instead of caching.
  if (target.id64 && String(steamId64) !== String(target.id64)) {
    throw new steam.SteamError(
      `Steam вернул другой профиль: запрошен ${target.id64}, ответ — ${steamId64}. ` +
        'Библиотека не сохранена, чтобы не приписать часы чужому владельцу. ' +
        'Повторите импорт по vanity-имени или проверьте steamid64.',
      'steamid_mismatch'
    );
  }
  job.userKey = steamId64;
  job.profile = gameCache.profileKeyOf(steamId64);
  // P3: the running-job key must name the owner, not the vanity that was typed
  // — otherwise `isRunning('steam-<id64>')` misses the job for the whole run.
  const resolvedKey = `steam-${steamId64}`;
  if (job.targetKey !== resolvedKey) {
    job.aliasKeys = [...(job.aliasKeys || []), job.targetKey];
    job.targetKey = resolvedKey;
  }

  const profileDoc = {
    userKey: steamId64,
    personaName: profile.personaName || null,
    customUrl: profile.customUrl || null,
    avatarUrl: profile.avatarFull || profile.avatarMedium || profile.avatarIcon || null,
    privacy: profile.privacyState || 'public',
    visibilityState: profile.visibilityState,
    memberSince: profile.memberSince || null,
    memberSinceAt: profile.memberSinceAt || null,
    vacBanned: profile.vacBanned,
    limitedAccount: profile.limitedAccount,
    groupsCount: profile.groupsCount || 0,
    profileUrl: `https://steamcommunity.com/profiles/${steamId64}`,
    mostPlayedGames: profile.mostPlayedGames || [],
    fetchedAt: nowIso(),
    importedAt: nowIso(),
  };
  if (options.label) profileDoc.ownerLabel = String(options.label).slice(0, 80);
  await gameCache.saveProfile(profileDoc);

  /* ------------------------- 2. key check -------------------------- */
  const keyInfo =
    options.keyInfo ||
    (typeof client._keyProvider === 'function' ? client._keyProvider() : null) ||
    { key: config.loadSteamKey(), source: config.steamKeySource() };
  job.keySource = keyInfo.source || null;

  if (!keyInfo.key) {
    // Honest partial mode: profile + three most recent games, no library.
    job.stage = 'library';
    const fetchedAt = nowIso();
    const library = partialLibraryFromProfile(profileDoc, fetchedAt);
    await gameCache.saveLibrary(steamId64, library);
    job.libraryPartial = true;
    job.partial = true;
    job.code = 'steam_key_missing';
    job.warning =
      'STEAM_API_KEY не задан: библиотека и часы недоступны. Сохранены профиль и три ' +
      'последние игры из профиля. Ключ: env STEAM_API_KEY или config/steam-token.';
    job.gameCount = null;
    job.ownedCount = library.games.length;
    job.totalMinutes = library.totalMinutes;
    job.totalHours = round1(library.totalMinutes / 60);
    job.playedCount = library.games.filter((game) => game.playtime_forever > 0).length;
    job.backlogCount = library.games.filter((game) => game.playtime_forever === 0).length;
    job.percent = 100;
    job.warnings = ['steam_key_missing'];
    // Nothing to enrich without a real library; records `enrichSkipped`.
    kickEnrichQuietly(job, options);
    kickPersonnelQuietly(job, options);
    kickFranchiseQuietly(job, options);
    return;
  }

  /* --------------------- 3. player summaries ---------------------- */
  job.stage = 'summaries';
  job.requests++;
  try {
    const summary = await client.getPlayerSummaries(steamId64);
    if (summary) {
      profileDoc.personaName = summary.personaName || profileDoc.personaName;
      profileDoc.avatarUrl =
        summary.avatarFull || summary.avatarMedium || summary.avatar || profileDoc.avatarUrl;
      profileDoc.profileUrl = summary.profileUrl || profileDoc.profileUrl;
      profileDoc.timeCreated = summary.timeCreated;
      profileDoc.lastLogOff = summary.lastLogOff;
      profileDoc.lastLogOffAt = summary.lastLogOff
        ? new Date(summary.lastLogOff * 1000).toISOString()
        : null;
      profileDoc.communityVisibilityState = summary.communityVisibilityState;
      profileDoc.countryCode = summary.countryCode;
      profileDoc.summariesFetchedAt = nowIso();
      await gameCache.saveProfile(profileDoc);
    }
  } catch (err) {
    // Summaries are enrichment; the library is the primary artifact. A 401
    // will surface again on GetOwnedGames and fail the job there.
    job.warnings = [...(job.warnings || []), `summaries_${(err && err.code) || 'failed'}`];
    console.warn(
      `[games-import ${job.id}] player summaries skipped: ${(err && err.code) || err.message}`
    );
  }

  /* ------------------------- 4. library --------------------------- */
  job.stage = 'library';
  job.requests++;
  const owned = await client.getOwnedGames(steamId64);
  if (!owned || owned.empty) {
    throw new steam.SteamError(
      'Steam не отдал библиотеку (пустой response). Профиль закрыт или ключ принадлежит ' +
        'другому аккаунту. Проверьте «Game details» → public и STEAM_API_KEY.',
      'library_private'
    );
  }
  const fetchedAt = nowIso();

  /* --------------------- 4b. recently played ---------------------- */
  // `GetRecentlyPlayedGames` is the canonical launch source and the only place
  // some owners expose activity: `GetOwnedGames` can answer `rtime_last_played:
  // 0` on every row while this endpoint knows the games of the last two weeks
  // (verified 03.11.2026: 226 owned rows with rtime=0, 6 RGP rows). Merge-only:
  // an appid the library does not own is ignored. NOT fatal — a network/API
  // error leaves a warning and the job keeps the plain library snapshot (no
  // negative cache: the next import asks again).
  try {
    job.requests++;
    const recent = await client.getRecentlyPlayedGames(steamId64);
    if (recent && Array.isArray(recent.games)) {
      job.recentPlayedCount = mergeRecentlyPlayed(owned.games, recent);
      job.recentPlayedFetchedAt = nowIso();
      console.log(
        `[games-import ${job.id}] recently-played merged into library: ` +
          `${job.recentPlayedCount} row(s) of ${recent.games.length}`
      );
    }
  } catch (err) {
    job.warnings = [...(job.warnings || []), `recent_played_${(err && err.code) || 'failed'}`];
    // Masked like every games log line: a wrapped URL must never carry the key.
    const message = steam.maskSecrets((err && err.message) || 'failed');
    console.warn(`[games-import ${job.id}] recently-played skipped (import kept): ${message}`);
  }
  // The merge may have raised `playtime_forever`/`rtime_last_played`, so the
  // stored totals and fingerprint describe the rows that are actually saved.
  const mergedTotalMinutes = owned.games.reduce(
    (sum, game) => sum + (Number(game.playtime_forever) || 0),
    0
  );
  const library = {
    fetchedAt,
    partial: false,
    source: 'steam-webapi',
    game_count: owned.gameCount,
    games: owned.games,
    totalMinutes: mergedTotalMinutes,
    fingerprint: steam.libraryFingerprint(owned.games, owned.gameCount),
    // Null when the RGP call failed or was not made; an ISO stamp means the
    // library rows carry the two-week window of that moment.
    recentPlayedFetchedAt: job.recentPlayedFetchedAt || null,
  };
  await gameCache.saveLibrary(steamId64, library);

  job.gameCount = owned.gameCount;
  job.ownedCount = owned.games.length;
  job.totalMinutes = mergedTotalMinutes;
  job.totalHours = round1(mergedTotalMinutes / 60);
  job.playedCount = owned.games.filter((game) => game.playtime_forever > 0).length;
  job.backlogCount = owned.games.filter((game) => game.playtime_forever === 0).length;
  job.percent = 100;
  job.stage = 'done';

  // Auto-enrich (§UX): the UI should not have to start the details job by
  // hand after a successful import or refresh.
  kickEnrichQuietly(job, options);
  // …and the credits pass after it (it waits for the enrich chain itself).
  kickPersonnelQuietly(job, options);
  // Franchises/release years share the WDQS lock with the credits pass, so
  // they queue behind it instead of doubling the Wikidata debt.
  kickFranchiseQuietly(job, options);
}

/**
 * Start (or coalesce into) an import job.
 *
 * `rawTarget` — steamid64, vanity name, or a steamcommunity profile URL.
 * `options.force` — ignore the 24 h reuse window.
 * `options.client` — injected Steam client (tests: fixtures, no network).
 * `options.keyInfo` — `{ key, source }` override (tests).
 *
 * Throws `invalid_steamid` synchronously for a malformed target, so the route
 * can answer 400 before a job exists.
 */
function startImport(rawTarget, options = {}) {
  const target = steam.normalizeTarget(rawTarget);
  const client = options.client || steam.createClient();
  const force = Boolean(options.force);
  const targetKey = target.id64 ? `steam-${target.id64}` : `vanity:${target.vanity.toLowerCase()}`;

  const running = findRunningJob(targetKey);
  if (running) return publicStatus(running);

  // Idempotency: a fresh snapshot is reused without any Steam request.
  let cachedId64 = target.id64 || null;
  if (!cachedId64 && target.vanity) {
    const cached = cachedProfileByVanity(target.vanity);
    if (cached) cachedId64 = cached.userKey;
  }
  if (!force && cachedId64) {
    const library = gameCache.getLibrary(cachedId64);
    if (library && gameCache.isFresh(library, gameCache.libraryTtlMs())) {
      const profile = gameCache.getProfile(cachedId64);
      const now = Date.now();
      const reused = {
        id: newJobId(cachedId64),
        targetKey: `steam-${cachedId64}`,
        target: target.input,
        userKey: cachedId64,
        profile: gameCache.profileKeyOf(cachedId64),
        status: 'done',
        stage: 'done',
        done: true,
        percent: 100,
        reused: true,
        force: false,
        libraryPartial: Boolean(library.partial),
        partial: Boolean(library.partial),
        code: null,
        error: null,
        warning: null,
        warnings: [],
        keySource: config.steamKeySource(),
        requests: 0,
        gameCount: library.game_count,
        ownedCount: Array.isArray(library.games) ? library.games.length : 0,
        totalMinutes: library.totalMinutes,
        totalHours: Number.isFinite(Number(library.totalMinutes))
          ? round1(Number(library.totalMinutes) / 60)
          : null,
        playedCount: (library.games || []).filter((game) => game.playtime_forever > 0).length,
        backlogCount: (library.games || []).filter((game) => game.playtime_forever === 0).length,
        // The cached snapshot keeps its own RGP stamp; a reuse makes no call.
        recentPlayedFetchedAt: library.recentPlayedFetchedAt || null,
        recentPlayedCount: null,
        startedAt: now,
        finishedAt: now,
        cachedAt: (profile && profile.importedAt) || library.fetchedAt || null,
      };
      rememberJob(reused);
      console.log(
        `[games-import ${reused.id}] library reused from cache ` +
          `(${reused.ownedCount} games, fetchedAt=${library.fetchedAt})`
      );
      // A cached library still needs details: the UI treats "import done" as
      // the moment to show the dashboard, so the enrich job starts here too.
      kickEnrichQuietly(reused, options);
      kickPersonnelQuietly(reused, options);
      kickFranchiseQuietly(reused, options);
      return publicStatus(reused);
    }
  }

  const job = {
    id: newJobId(target.id64 || target.vanity),
    targetKey,
    target: target.input,
    userKey: target.id64 || null,
    profile: target.id64 ? gameCache.profileKeyOf(target.id64) : null,
    status: 'running',
    stage: 'queued',
    done: false,
    percent: 0,
    reused: false,
    force,
    libraryPartial: false,
    partial: false,
    code: null,
    error: null,
    warning: null,
    warnings: [],
    keySource: null,
    requests: 0,
    gameCount: null,
    ownedCount: null,
    totalMinutes: null,
    totalHours: null,
    playedCount: null,
    backlogCount: null,
    startedAt: Date.now(),
  };
  rememberJob(job);
  enqueue(job, () => runImport(job, target, client, options));
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
  partialLibraryFromProfile,
  mergeRecentlyPlayed,
  AUTO_ENRICH_PHASES,
  MAX_JOBS,
};
