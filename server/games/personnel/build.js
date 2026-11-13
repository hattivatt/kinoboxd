'use strict';

const path = require('path');

const gameCache = require('../game-cache');
const wikidataProvider = require('./wikidata');
const mobyProvider = require('./moby');
const {
  OVERRIDES_PATH,
  ROLES,
  ROLE_ALIASES,
  DEFAULT_ROLE,
  STUDIO_ROLES,
  PEOPLE_ROLES,
  PersonnelError,
  readJson,
  resolveRole,
  normalizeSort,
  cleanName,
  minutesToHours,
  round2,
  readOverrides,
  saveOverrides,
  mergeOverrides,
  applyOverride,
} = require('./identity');
const {
  groupEntries,
  applyManualNames,
  buildItems,
  coverageCounts,
  studiosFromDetails,
  studiosOfSecondaryWork,
  secondaryWorksFor,
} = require('./group');

const DETAILS_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'details');
const LINKS_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'links');
const PERSONNEL_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'personnel');

const PERSONNEL_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const LABEL_RULE_VERSION = 2;

function detailsPath(appid) {
  return path.join(DETAILS_DIR, `${gameCache.safeKey(appid)}.json`);
}

function linksPath(appid) {
  return path.join(LINKS_DIR, `${gameCache.safeKey(appid)}.json`);
}

function personnelPath(appid) {
  return path.join(PERSONNEL_DIR, `${gameCache.safeKey(appid)}.json`);
}

function secondaryPersonnelPath(workKey) {
  return path.join(PERSONNEL_DIR, `work-${gameCache.safeKey(workKey)}.json`);
}

function readDetails(appid) {
  const doc = readJson(detailsPath(appid));
  if (!doc) return null;
  if (doc.success === false) return null;
  return doc;
}

function readLinks(appid) {
  const doc = readJson(linksPath(appid)) || {};
  const wikidataRaw = doc.wikidata && typeof doc.wikidata === 'object'
    ? doc.wikidata.qid
    : doc.wikidata;
  const qidRaw = wikidataRaw || doc.wikidataQid || doc.qid || null;
  const qid = qidRaw && /^Q\d+$/i.test(String(qidRaw).trim())
    ? String(qidRaw).trim().toUpperCase()
    : null;
  const mobyRaw = doc.moby || doc.mobyId || doc.mobygames || null;
  const mobyId = Number.isFinite(Number(mobyRaw)) && Number(mobyRaw) > 0 ? Number(mobyRaw) : null;
  const platformRaw = doc.mobyPlatformId || doc.mobyPlatform || null;
  const mobyPlatformId =
    Number.isFinite(Number(platformRaw)) && Number(platformRaw) > 0 ? Number(platformRaw) : null;
  return { qid, mobyId, mobyPlatformId, igdbId: doc.igdb || doc.igdbId || null };
}

function readPersonnelDoc(appid) {
  const doc = readJson(personnelPath(appid));
  if (!doc || typeof doc !== 'object') return null;
  return {
    ...doc,
    people: Array.isArray(doc.people) ? doc.people : [],
    studios: Array.isArray(doc.studios) ? doc.studios : [],
    sources: Array.isArray(doc.sources) ? doc.sources : [],
  };
}

function isPersonnelFresh(doc, nowMs, ttlMs = PERSONNEL_TTL_MS) {
  if (!doc || !doc.fetchedAt) return false;
  const ts = Date.parse(String(doc.fetchedAt));
  if (!Number.isFinite(ts)) return false;
  const age = nowMs - ts;
  return age >= 0 && age < ttlMs;
}

async function savePersonnelDoc(appid, doc) {
  const payload = {
    schemaVersion: 1,
    appid: Number(appid),
    ...doc,
  };
  const fingerprint = await gameCache.writeJsonAtomic(personnelPath(appid), payload);
  return { data: payload, fingerprint };
}

function readSecondaryPersonnelDoc(workKey) {
  if (!workKey) return null;
  const doc = readJson(secondaryPersonnelPath(workKey));
  if (!doc || typeof doc !== 'object') return null;
  return {
    ...doc,
    people: Array.isArray(doc.people) ? doc.people : [],
    studios: Array.isArray(doc.studios) ? doc.studios : [],
    sources: Array.isArray(doc.sources) ? doc.sources : [],
  };
}

async function saveSecondaryPersonnelDoc(workKey, doc) {
  const payload = {
    schemaVersion: 1,
    workKey: String(workKey),
    secondaryOnly: true,
    ...doc,
  };
  const fingerprint = await gameCache.writeJsonAtomic(
    secondaryPersonnelPath(workKey),
    payload
  );
  return { data: payload, fingerprint };
}

const WIKIDATA_BADGES = {
  ok: null,
  never_run: 'WD: не запущено',
  unavailable: 'WD: недоступно',
  cooldown: 'WD: недоступно',
  disabled: 'WD: выключено',
};

function wikidataStatus(state, nowMs, enabled) {
  const doc = state && typeof state === 'object' ? state : {};
  const disabledUntilRaw = doc.disabledUntil || null;
  const disabledUntilMs = disabledUntilRaw ? Date.parse(String(disabledUntilRaw)) : NaN;
  const disabledUntil =
    Number.isFinite(disabledUntilMs) && disabledUntilMs > nowMs ? disabledUntilRaw : null;
  const base = {
    enabled: Boolean(enabled),
    lastSuccessAt: doc.lastSuccessAt || null,
    lastAttemptAt: doc.lastAttemptAt || null,
    lastError: doc.lastError || null,
    disabledUntil,
  };
  let status;
  if (!enabled) {
    status = { state: 'disabled', reason: 'disabled_by_env' };
  } else if (disabledUntil) {
    status = { state: 'cooldown', reason: doc.lastError || 'cooldown' };
  } else if (Number(doc.failures) > 0 && doc.lastError) {
    status = { state: 'unavailable', reason: doc.lastError };
  } else if (doc.lastSuccessAt) {
    status = { state: 'ok', reason: null };
  } else {
    status = { state: 'never_run', reason: 'never_run' };
  }
  return { ...base, ...status, badge: WIKIDATA_BADGES[status.state] || null };
}

function collectGames(context) {
  const { library, profileKey, parsed, wdEnabled, secondaryWorks: providedWorks } = context;
  const games = [];
  let excludedNonGame = 0;
  let staleLabels = 0;
  for (const game of library.games || []) {
    const appid = Number(game.appid);
    if (!Number.isInteger(appid) || appid <= 0) continue;
    const details = readDetails(appid);
    if (details && details.type && details.type !== 'game') {
      excludedNonGame++;
      continue;
    }
    const doc = readPersonnelDoc(appid);
    if (wdEnabled && doc && doc.wdAsked === true && doc.labelRule !== LABEL_RULE_VERSION) {
      staleLabels++;
    }
    const studios = studiosFromDetails(details);
    const wdStudios = doc ? doc.studios : [];
    for (const studio of wdStudios) {
      const name = cleanName(studio.name);
      if (!name) continue;
      studios.push({
        name,
        nameEn: studio.nameEn || null,
        nameRu: studio.nameRu || null,
        qid: studio.qid || null,
        mobyId: studio.mobyId != null ? studio.mobyId : null,
        roles: Array.isArray(studio.roles) && studio.roles.length ? studio.roles : ['developer'],
        roleSource: studio.roleSource || studio.source || 'wikidata',
        source: studio.source || 'wikidata',
        confidence: studio.confidence || 'high',
      });
    }
    const people = doc
      ? doc.people
          .map((person) => ({
            name: cleanName(person.name),
            nameEn: person.nameEn || null,
            nameRu: person.nameRu || null,
            qid: person.qid || null,
            mobyId: person.mobyId != null ? person.mobyId : null,
            roles: Array.isArray(person.roles) ? person.roles : [],
            roleSource: person.roleSource || person.source || 'wikidata',
            source: person.source || 'wikidata',
            confidence: person.confidence || 'high',
          }))
          .filter((person) => person.name && person.roles.length)
      : [];

    const achievements = gameCache.getAchievements(parsed.userKey, appid);
    const total = achievements ? Number(achievements.totalCount) : 0;
    const unlocked = achievements ? Number(achievements.unlockedCount) : 0;
    const completion = total > 0 && Number.isFinite(unlocked) ? round2((unlocked / total) * 100) : null;

    games.push({
      appid,
      name: cleanName(game.name) || cleanName(details && details.name) || String(appid),
      hours: minutesToHours(game.playtime_forever),
      completion,
      detailsResolved: Boolean(details),
      creditsResolved: Boolean(doc),
      studios,
      people,
    });
  }
  const secondaryWorks = secondaryWorksFor(profileKey, providedWorks);
  for (const work of secondaryWorks) {
    if (!work || !work.workKey) continue;
    const doc = readSecondaryPersonnelDoc(work.workKey);
    const studios = studiosOfSecondaryWork(work, doc);
    const people = doc
      ? doc.people
          .map((person) => ({
            name: cleanName(person.name),
            nameEn: person.nameEn || null,
            nameRu: person.nameRu || null,
            qid: person.qid || null,
            mobyId: person.mobyId != null ? person.mobyId : null,
            roles: Array.isArray(person.roles) ? person.roles : [],
            roleSource: person.roleSource || person.source || 'wikidata',
            source: person.source || 'wikidata',
            confidence: person.confidence || 'high',
          }))
          .filter((person) => person.name && person.roles.length)
      : [];
    games.push({
      appid: null,
      workKey: work.workKey,
      secondaryOnly: true,
      qid: work.qid || null,
      name: cleanName(work.name) || work.workKey,
      hours: round2(Number(work.hours) || 0),
      completion: null,
      detailsResolved: true,
      creditsResolved: Boolean(doc),
      studios,
      people,
    });
  }
  return { games, excludedNonGame, staleLabels };
}

function requestScope(profileKey, options) {
  const parsed = gameCache.parseProfileToken(profileKey);
  if (!parsed) {
    throw new PersonnelError(
      `"profile": expected "steam-<steamid64>", got: ${profileKey}.`,
      'invalid_profile'
    );
  }
  const library = gameCache.getLibrary(parsed.userKey);
  if (!library) return null;
  return {
    parsed,
    library,
    role: resolveRole(options.role),
    sort: normalizeSort(options.sort),
    gamesLimit: Math.min(
      50,
      Math.max(1, Number.isFinite(Number(options.gamesLimit)) ? Number(options.gamesLimit) : 5)
    ),
    nowMs: Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now(),
    overrides: options.overrides || readOverrides(),
    wdEnabled: wikidataProvider.wikidataEnabled(),
  };
}

function creditsStatus(context) {
  const {
    wdEnabled,
    nowMs,
    steamTotal,
    gamesWithCredits,
    secondaryGames,
    secondaryWithCredits,
    staleLabels,
  } = context;
  const wdState = wikidataProvider.defaultStateStore().read();
  const wdStatus = wikidataStatus(wdState, nowMs, wdEnabled);
  const mobyStatus = mobyProvider.createClient().status();
  const pendingCredits = steamTotal - gamesWithCredits;
  const pendingSecondary = secondaryGames.length - secondaryWithCredits;
  let pendingReason = null;
  if (pendingCredits > 0) {
    if (wdStatus.state === 'cooldown') pendingReason = 'wikidata_cooldown';
    else if (wdStatus.state === 'disabled' && !mobyStatus.enabled) pendingReason = 'sources_disabled';
    else if (wdStatus.state === 'never_run' && !mobyStatus.enabled) pendingReason = 'wikidata_not_run';
    else if (wdStatus.state === 'unavailable') pendingReason = 'wikidata_unavailable';
    else pendingReason = 'not_fetched';
  } else if (pendingSecondary > 0) {
    pendingReason = 'secondary_pending';
  } else if (staleLabels > 0) {
    pendingReason = 'labels_stale';
  }
  return { wdStatus, mobyStatus, pendingCredits, pendingSecondary, pendingReason };
}

function buildPersonnel(profileKey, options = {}) {
  const started = Date.now();
  const scope = requestScope(profileKey, options);
  if (!scope) return null;
  const { parsed, library, sort, gamesLimit, nowMs, overrides, wdEnabled } = scope;
  const resolvedRole = scope.role;
  const role = resolvedRole.role;

  const { games, excludedNonGame, staleLabels } = collectGames({
    library,
    profileKey,
    parsed,
    wdEnabled,
    secondaryWorks: options.secondaryWorks,
  });

  const totalHours = round2(games.reduce((sum, game) => sum + game.hours, 0));
  const wantStudios = STUDIO_ROLES.includes(role);
  const items = buildItems(games, {
    kind: wantStudios ? 'studio' : 'person',
    role,
    sort,
    gamesLimit,
    totalHours,
    overrides,
  });

  const {
    secondaryGames,
    detailsResolved,
    gamesWithCredits,
    secondaryWithCredits,
    studiosResolved,
    byRole,
    byStudioRole,
    gamesTotal,
    steamTotal,
    percent,
    studioPercent,
    developerPercent,
    publisherPercent,
  } = coverageCounts(games);

  const { wdStatus, mobyStatus, pendingCredits, pendingSecondary, pendingReason } = creditsStatus({
    wdEnabled,
    nowMs,
    steamTotal,
    gamesWithCredits,
    secondaryGames,
    secondaryWithCredits,
    staleLabels,
  });

  return {
    profile: parsed.key,
    role,
    roleRequested: resolvedRole.requested,
    roleAlias: resolvedRole.alias,
    sort,
    roles: {
      accepted: [...ROLES],
      default: DEFAULT_ROLE,
      aliases: { ...ROLE_ALIASES },
      studio: [...STUDIO_ROLES],
      people: [...PEOPLE_ROLES],
    },
    items,
    totals: {
      games: gamesTotal,
      secondaryWorks: secondaryGames.length,
      hours: totalHours,
      excludedNonGame,
    },
    coverage: {
      gamesTotal,
      steamGames: steamTotal,
      gamesWithDetails: detailsResolved,
      detailsPercent: steamTotal ? Math.round((detailsResolved / steamTotal) * 100) : 0,
      gamesWithCredits,
      percent,
      secondaryWorks: secondaryGames.length,
      secondaryWithCredits,
      gamesWithStudios: studiosResolved,
      studioPercent,
      gamesWithDevelopers: byStudioRole.developer,
      developerPercent,
      gamesWithPublishers: byStudioRole.publisher,
      publisherPercent,
      byRole,
      byStudioRole,
      wikidata: wdStatus,
    },
    pending: {
      details: steamTotal - detailsResolved,
      credits: pendingCredits,
      secondary: pendingSecondary,
      staleLabels,
      running: Boolean(options.running),
      jobId: null,
      reason: pendingReason,
    },
    sources: {
      credits: ['steam-store', 'wikidata'].concat(mobyStatus.enabled ? ['mobygames'] : []),
      wikidata: wdStatus,
      mobygames: mobyStatus,
    },
    meta: {
      builtAt: new Date(nowMs).toISOString(),
      buildMs: Date.now() - started,
      gamesConsidered: gamesTotal,
      completionAvailable: games.some((game) => game.completion != null),
      detailsSource: 'cache-games/details',
      creditsCache: 'cache-games/personnel',
      libraryPartial: Boolean(library.partial),
      libraryFetchedAt: library.fetchedAt || null,
    },
  };
}

function personnelForGame(appid, options = {}) {
  const id = Number(appid);
  const details = readDetails(id);
  const doc = readPersonnelDoc(id);
  const overrides = options.overrides || readOverrides();
  const studios = studiosFromDetails(details);
  if (doc) studios.push(...doc.studios);
  const people = doc ? doc.people : [];
  const groupedStudios = groupEntries(
    studios.map((studio) => ({ ...studio, game: { appid: id, name: '', hours: 0 } })),
    'studio',
    overrides
  ).groups.map((group) => {
    const names = applyManualNames(group, 'studio', overrides);
    return { name: names.display, aliases: names.aliases, roles: group.roles, qid: group.qid, mobyId: group.mobyId, sources: group.sources.sort() };
  });
  const groupedPeople = groupEntries(
    people.map((person) => ({ ...person, game: { appid: id, name: '', hours: 0 } })),
    'person',
    overrides
  ).groups.map((group) => {
    const names = applyManualNames(group, 'person', overrides);
    return {
      name: names.display,
      aliases: names.aliases,
      roles: group.roles,
      qid: group.qid,
      mobyId: group.mobyId,
      roleSource: group.entries[0] ? group.entries[0].roleSource : null,
      sources: group.sources.sort(),
    };
  });
  return {
    studios: groupedStudios,
    people: groupedPeople,
    sources: doc ? doc.sources : [],
    coverage: doc ? doc.coverage || null : null,
    pending: !details && !doc ? ['details', 'credits'] : !doc ? ['credits'] : [],
  };
}

module.exports = {
  DETAILS_DIR,
  LINKS_DIR,
  PERSONNEL_DIR,
  OVERRIDES_PATH,
  PERSONNEL_TTL_MS,
  LABEL_RULE_VERSION,
  WIKIDATA_BADGES,
  wikidataStatus,
  readDetails,
  readLinks,
  readPersonnelDoc,
  isPersonnelFresh,
  savePersonnelDoc,
  secondaryPersonnelPath,
  readSecondaryPersonnelDoc,
  saveSecondaryPersonnelDoc,
  readOverrides,
  saveOverrides,
  mergeOverrides,
  applyOverride,
  buildPersonnel,
  personnelForGame,
};
