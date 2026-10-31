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
 * Requests per full import: 1 community (profile XML) + 2 Web API
 * (GetPlayerSummaries, GetOwnedGames) — no pagination, no scraping of the
 * login-gated `/games` family.
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

const crypto = require('crypto');

const config = require('../config');
const steam = require('./steam');
const gameCache = require('./game-cache');

const jobs = new Map();
const jobOrder = [];
const MAX_JOBS = 20;

let importChain = Promise.resolve();

function newJobId(seed) {
  return `games-steam-${gameCache.safeKey(seed)}-${Date.now().toString(36)}-${crypto
    .randomBytes(3)
    .toString('hex')}`;
}

function rememberJob(job) {
  jobs.set(job.id, job);
  jobOrder.push(job.id);
  while (jobOrder.length > MAX_JOBS) {
    const stale = jobOrder.shift();
    if (stale !== job.id) jobs.delete(stale);
  }
}

function findRunningJob(targetKey) {
  for (const job of jobs.values()) {
    if (job.targetKey === targetKey && !job.done && job.status === 'running') return job;
  }
  return null;
}

/** Public job view: no key, no key source value, no raw HTTP details. */
function publicStatus(job) {
  if (!job) return null;
  return {
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
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    elapsedMs: job.finishedAt ? job.finishedAt - job.startedAt : null,
    cachedAt: job.cachedAt || null,
  };
}

function getStatus(id) {
  return publicStatus(jobs.get(String(id || '')));
}

function isRunning(targetKey) {
  return Boolean(findRunningJob(targetKey));
}

function enqueue(job, task) {
  importChain = importChain
    .then(task)
    .catch((err) => {
      job.status = 'failed';
      job.stage = 'failed';
      job.code = (err && err.code) || 'games_import_failed';
      // SteamError messages are already masked; mask once more so a wrapped
      // URL (with `key=`) can never reach a log or the job status.
      job.error = steam.maskSecrets(err && err.message ? err.message : 'неизвестная ошибка');
      if (err && err.retryAt) job.retryAt = err.retryAt;
      console.error(`[games-import ${job.id}] ${job.code}: ${job.error}`);
    })
    .then(() => {
      job.done = job.status !== 'running';
      job.finishedAt = Date.now();
      if (job.status === 'running') {
        job.status = 'done';
        job.stage = 'done';
        job.percent = 100;
        job.done = true;
      }
      console.log(
        `[games-import ${job.id}] ${job.status} after ${job.finishedAt - job.startedAt}ms ` +
          `(stage=${job.stage}, requests=${job.requests}, ` +
          `games=${job.gameCount == null ? '—' : job.gameCount}, ` +
          `partial=${job.libraryPartial}${job.code ? `, code=${job.code}` : ''})`
      );
    });
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
  job.userKey = steamId64;
  job.profile = gameCache.profileKeyOf(steamId64);

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
    job.code = 'steam_key_missing';
    job.warning =
      'STEAM_API_KEY не задан: библиотека и часы недоступны. Сохранены профиль и три ' +
      'последние игры из профиля. Ключ: env STEAM_API_KEY или config/steam-token.';
    job.gameCount = null;
    job.ownedCount = library.games.length;
    job.totalMinutes = library.totalMinutes;
    job.totalHours = Math.round((library.totalMinutes / 60) * 10) / 10;
    job.playedCount = library.games.filter((game) => game.playtime_forever > 0).length;
    job.backlogCount = library.games.filter((game) => game.playtime_forever === 0).length;
    job.percent = 100;
    job.warnings = ['steam_key_missing'];
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
  const library = {
    fetchedAt,
    partial: false,
    source: 'steam-webapi',
    game_count: owned.gameCount,
    games: owned.games,
    totalMinutes: owned.totalMinutes,
    fingerprint: owned.fingerprint,
  };
  await gameCache.saveLibrary(steamId64, library);

  job.gameCount = owned.gameCount;
  job.ownedCount = owned.games.length;
  job.totalMinutes = owned.totalMinutes;
  job.totalHours = Math.round((owned.totalMinutes / 60) * 10) / 10;
  job.playedCount = owned.games.filter((game) => game.playtime_forever > 0).length;
  job.backlogCount = owned.games.filter((game) => game.playtime_forever === 0).length;
  job.percent = 100;
  job.stage = 'done';
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
          ? Math.round((Number(library.totalMinutes) / 60) * 10) / 10
          : null,
        playedCount: (library.games || []).filter((game) => game.playtime_forever > 0).length,
        backlogCount: (library.games || []).filter((game) => game.playtime_forever === 0).length,
        startedAt: now,
        finishedAt: now,
        cachedAt: (profile && profile.importedAt) || library.fetchedAt || null,
      };
      rememberJob(reused);
      console.log(
        `[games-import ${reused.id}] library reused from cache ` +
          `(${reused.ownedCount} games, fetchedAt=${library.fetchedAt})`
      );
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
  return importChain;
}

module.exports = {
  startImport,
  getStatus,
  isRunning,
  publicStatus,
  whenIdle,
  partialLibraryFromProfile,
  MAX_JOBS,
};
