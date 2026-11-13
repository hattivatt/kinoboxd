'use strict';

const config = require('../config');
const { createJobs } = require('../core/jobs');
const { round1 } = require('../core/stats');
const steam = require('./steam');
const gameCache = require('./game-cache');
const enrichJobs = require('./enrich');
const personnelJobs = require('./personnel/jobs');
const franchiseJobs = require('./franchise-jobs');

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

function publicStatus(job) {
  if (!job) return null;
  return {
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
    recentPlayedFetchedAt: job.recentPlayedFetchedAt || null,
    recentPlayedCount: job.recentPlayedCount == null ? null : job.recentPlayedCount,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    elapsedMs: job.finishedAt ? job.finishedAt - job.startedAt : null,
    cachedAt: job.cachedAt || null,
    enrichJobId: job.enrichJobId || null,
    enrichSkipped: job.enrichSkipped || null,
    enrichPhases: job.enrichPhases ? [...job.enrichPhases] : [],
    personnelJobId: job.personnelJobId || null,
    personnelSkipped: job.personnelSkipped || null,
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

const AUTO_ENRICH_PHASES = ['details', 'spy'];

function kickEnrichQuietly(job, options = {}) {
  if (options.autoEnrich !== true) return null;
  if (!job || !job.profile) return null;
  if (job.libraryPartial) {
    job.enrichSkipped = 'library_partial';
    return null;
  }
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

function kickFranchiseQuietly(job, options = {}) {
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

  const keyInfo =
    options.keyInfo ||
    (typeof client._keyProvider === 'function' ? client._keyProvider() : null) ||
    { key: config.loadSteamKey(), source: config.steamKeySource() };
  job.keySource = keyInfo.source || null;

  if (!keyInfo.key) {
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
    kickEnrichQuietly(job, options);
    kickPersonnelQuietly(job, options);
    kickFranchiseQuietly(job, options);
    return;
  }

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
    job.warnings = [...(job.warnings || []), `summaries_${(err && err.code) || 'failed'}`];
    console.warn(
      `[games-import ${job.id}] player summaries skipped: ${(err && err.code) || err.message}`
    );
  }

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
    const message = steam.maskSecrets((err && err.message) || 'failed');
    console.warn(`[games-import ${job.id}] recently-played skipped (import kept): ${message}`);
  }
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

  kickEnrichQuietly(job, options);
  kickPersonnelQuietly(job, options);
  kickFranchiseQuietly(job, options);
}

function startImport(rawTarget, options = {}) {
  const target = steam.normalizeTarget(rawTarget);
  const client = options.client || steam.createClient();
  const force = Boolean(options.force);
  const targetKey = target.id64 ? `steam-${target.id64}` : `vanity:${target.vanity.toLowerCase()}`;

  const running = findRunningJob(targetKey);
  if (running) return publicStatus(running);

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
