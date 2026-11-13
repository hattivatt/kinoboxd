'use strict';

const gameCache = require('../game-cache');
const wikidataProvider = require('./wikidata');
const mobyProvider = require('./moby');
const {
  LABEL_RULE_VERSION,
  readDetails,
  readLinks,
  readPersonnelDoc,
  isPersonnelFresh,
  savePersonnelDoc,
  readSecondaryPersonnelDoc,
  saveSecondaryPersonnelDoc,
} = require('./build');
const { PersonnelError, cleanName } = require('./identity');
const {
  dedupePeople,
  dedupeStudios,
  studiosFromDetails,
  studiosFromSecondaryWork,
  carriedStoreStudios,
  storeStudiosSignature,
  mergeSecondaryStudios,
  secondaryWorksFor,
} = require('./group');

function selectSteamTargets(context) {
  const { library, wdEnabled, mobyEnabled, force, limit, now } = context;
  const targets = [];
  let pendingDetails = 0;
  let skippedFresh = 0;
  for (const game of library.games || []) {
    const appid = Number(game.appid);
    if (!Number.isInteger(appid) || appid <= 0) continue;
    const details = readDetails(appid);
    if (!details) {
      pendingDetails++;
      continue;
    }
    if (details.type && details.type !== 'game') continue;
    const links = readLinks(appid);
    const existing = readPersonnelDoc(appid);
    const needs = ['steam-store'];
    if (wdEnabled && !(existing && existing.wdAsked === true)) needs.push('wikidata');
    if (mobyEnabled && links.mobyId && links.mobyPlatformId) needs.push('mobygames');
    const labelsStale =
      wdEnabled &&
      Boolean(existing) &&
      existing.wdAsked === true &&
      existing.labelRule !== LABEL_RULE_VERSION;
    const covered =
      Boolean(existing) &&
      !labelsStale &&
      needs.every((source) => (existing.sources || []).includes(source));
    if (!force && covered && isPersonnelFresh(existing, now())) {
      skippedFresh++;
      continue;
    }
    targets.push({ appid, details, links, existing, name: game.name });
    if (targets.length >= limit) break;
  }
  return { targets, pendingDetails, skippedFresh };
}

async function fetchSteamWikidata(targets, wd, options, report, wdEnabled) {
  const withoutQid = targets.filter((target) => !target.links.qid).map((target) => target.appid);
  if (withoutQid.length && wdEnabled) {
    const result = await wd.creditsForAppids(withoutQid, options);
    report.wdQueries += result.queries;
    report.wdSkipped = result.skipped || report.wdSkipped;
    report.wdDisabledUntil = result.disabledUntil || report.wdDisabledUntil;
    report.errors.push(...(result.errors || []));
    if (!result.skipped && !(result.errors || []).length) {
      for (const target of targets) {
        if (!target.links.qid) target.wdAsked = true;
      }
    }
    for (const target of targets) {
      const hit = result.credits.get(String(target.appid));
      if (hit) {
        target.wdCredits = hit;
        target.qid = hit.qid;
      }
    }
  }
  const qids = targets
    .filter((target) => !target.wdCredits)
    .map((target) => target.links.qid)
    .filter(Boolean);
  if (qids.length && wdEnabled) {
    const result = await wd.fetchCredits(qids, options);
    report.wdQueries += result.queries;
    report.wdSkipped = result.skipped || report.wdSkipped;
    report.wdDisabledUntil = result.disabledUntil || report.wdDisabledUntil;
    report.errors.push(...(result.errors || []));
    if (!result.skipped && !(result.errors || []).length) {
      for (const target of targets) {
        if (!target.wdCredits && target.links.qid) target.wdAsked = true;
      }
    }
    for (const target of targets) {
      if (target.wdCredits || !target.links.qid) continue;
      const hit = result.credits.get(target.links.qid);
      if (hit) target.wdCredits = hit;
    }
  }
}

function selectSecondaryTargets(context) {
  const { list, wdEnabled, force, limit, now } = context;
  const targets = [];
  let skippedFresh = 0;
  for (const work of list) {
    if (!work || !work.workKey) continue;
    const existing = readSecondaryPersonnelDoc(work.workKey);
    const fresh = isPersonnelFresh(existing, now());
    const labelsStale =
      wdEnabled &&
      Boolean(existing) &&
      existing.wdAsked === true &&
      existing.labelRule !== LABEL_RULE_VERSION;
    const liveStoreStudios = carriedStoreStudios(studiosFromSecondaryWork(work), existing);
    const storeSignature = storeStudiosSignature(liveStoreStudios);
    const storeStale = Boolean(existing) && existing.storeSignature !== storeSignature;
    const complete = Boolean(existing) && !labelsStale && (!work.qid || existing.wdAsked === true);
    if (!force && complete && fresh && !storeStale) {
      skippedFresh++;
      continue;
    }
    const needsAsk =
      Boolean(work.qid) &&
      (force || !existing || existing.wdAsked !== true || labelsStale);
    targets.push({
      work,
      existing,
      labelsStale,
      needsAsk,
      storeStudios: liveStoreStudios,
      storeSignature,
    });
    if (targets.length >= limit) break;
  }
  return { targets, skippedFresh };
}

async function fetchSecondaryWikidata(secondaryTargets, wd, options, report) {
  const askedQids = [
    ...new Set(
      secondaryTargets
        .filter((target) => target.needsAsk)
        .map((target) => String(target.work.qid))
    ),
  ];
  if (!askedQids.length) return;
  const result = await wd.fetchCredits(askedQids, options);
  report.secondaryQueries += result.queries;
  report.wdQueries += result.queries;
  report.wdSkipped = result.skipped || report.wdSkipped;
  report.wdDisabledUntil = result.disabledUntil || report.wdDisabledUntil;
  report.errors.push(...(result.errors || []));
  const answered = !result.skipped && !(result.errors || []).length;
  for (const target of secondaryTargets) {
    const qid = target.work.qid ? String(target.work.qid) : null;
    if (!qid || !askedQids.includes(qid)) continue;
    const hit = result.credits.get(qid) || null;
    if (hit) target.wdCredits = hit;
    if (answered) target.wdAsked = true;
  }
}

async function writeSecondaryDocs(secondaryTargets, context) {
  const { now, report } = context;
  for (const target of secondaryTargets) {
    const { work, existing } = target;
    const studios = [...target.storeStudios];
    const people = [];
    const sources = new Set();
    const storeSource = (work.sources || []).includes('gog') ? 'gog-store' : 'epic-store';
    sources.add(storeSource);
    if (target.wdCredits) {
      studios.push(...(target.wdCredits.studios || []));
      people.push(...(target.wdCredits.people || []));
      sources.add('wikidata');
    } else if (target.wdAsked) {
      sources.add('wikidata');
    } else if (existing && (existing.sources || []).includes('wikidata')) {
      studios.push(...(existing.studios || []).filter((entry) => entry.source === 'wikidata'));
      people.push(...(existing.people || []).filter((entry) => entry.source === 'wikidata'));
      sources.add('wikidata');
    }
    const wdAnswered =
      Boolean(target.wdCredits) ||
      target.wdAsked === true ||
      (!target.needsAsk && Boolean(existing && existing.wdAsked === true));
    if (!wdAnswered && !existing && work.qid && !target.wdAsked) {
      report.secondaryDeferred++;
      continue;
    }
    const mergedPeople = dedupePeople(people);
    const mergedStudios = mergeSecondaryStudios(studios);
    await saveSecondaryPersonnelDoc(work.workKey, {
      name: cleanName(work.name) || null,
      qid: work.qid || null,
      fetchedAt: new Date(now()).toISOString(),
      wdAsked: wdAnswered,
      labelRule: wdAnswered
        ? LABEL_RULE_VERSION
        : (existing && existing.labelRule) || null,
      studios: mergedStudios,
      storeSignature: target.storeSignature,
      people: mergedPeople,
      sources: [...sources].sort(),
      coverage: {
        people: mergedPeople.length,
        studios: mergedStudios.length,
        roles: [...new Set(mergedPeople.flatMap((person) => person.roles || []))].sort(),
      },
      empty: mergedPeople.length === 0 && mergedStudios.length === 0,
    });
    report.secondaryUpdated++;
  }
}

function carryOver(existing, source) {
  if (!existing || !Array.isArray(existing.sources) || !existing.sources.includes(source)) {
    return { studios: [], people: [] };
  }
  const has = (entry) =>
    entry &&
    (entry.source === source ||
      (Array.isArray(entry.sources) && entry.sources.includes(source)));
  return {
    studios: (existing.studios || []).filter(has),
    people: (existing.people || []).filter(has),
  };
}

async function writeSteamDocs(targets, context) {
  const { mobyEnabled, moby, now, report } = context;
  for (const target of targets) {
    const studios = studiosFromDetails(target.details);
    const people = [];
    const sources = new Set(['steam-store']);
    const wdAnswered = Boolean(target.wdCredits) || target.wdAsked === true;
    if (target.wdCredits) {
      studios.push(...target.wdCredits.studios);
      people.push(...target.wdCredits.people);
      sources.add('wikidata');
    } else if (target.links.qid || target.wdAsked) {
      sources.add('wikidata');
    }
    if (!target.wdCredits && !target.wdAsked) {
      const carried = carryOver(target.existing, 'wikidata');
      if (carried.people.length || carried.studios.length) {
        studios.push(...carried.studios);
        people.push(...carried.people);
        sources.add('wikidata');
      }
    }
    let mobyAnswered = false;
    if (mobyEnabled && target.links.mobyId && target.links.mobyPlatformId) {
      try {
        const doc = await moby.fetchGameCredits({
          mobyId: target.links.mobyId,
          platformId: target.links.mobyPlatformId,
        });
        report.mobyRequests++;
        people.push(...doc.people);
        sources.add('mobygames');
        mobyAnswered = true;
      } catch (err) {
        report.mobyErrors.push((err && err.code) || 'mobygames_failed');
        const carried = carryOver(target.existing, 'mobygames');
        if (carried.people.length) {
          people.push(...carried.people);
          sources.add('mobygames');
        }
      }
    }
    if (!wdAnswered && !mobyAnswered && !target.existing) {
      report.wdDeferred++;
      continue;
    }
    if (wdAnswered) report.wdAnswered++;
    const mergedPeople = dedupePeople(people);
    const mergedStudios = dedupeStudios(studios);
    const doc = {
      schemaVersion: 1,
      appid: target.appid,
      name: cleanName(target.name) || null,
      qid: target.qid || target.links.qid || null,
      fetchedAt: new Date(now()).toISOString(),
      wdAsked: wdAnswered,
      labelRule: wdAnswered
        ? LABEL_RULE_VERSION
        : (target.existing && target.existing.labelRule) || null,
      studios: mergedStudios,
      people: mergedPeople,
      sources: [...sources].sort(),
      coverage: {
        people: mergedPeople.length,
        studios: mergedStudios.length,
        roles: [...new Set(mergedPeople.flatMap((person) => person.roles || []))].sort(),
      },
      empty: mergedPeople.length === 0 && mergedStudios.length === 0,
    };
    await savePersonnelDoc(target.appid, doc);
    report.updated++;
  }
}

async function enrichPersonnel(options = {}) {
  const parsed = gameCache.parseProfileToken(options.profileKey);
  if (!parsed) {
    throw new PersonnelError(
      `"profile": expected "steam-<steamid64>", got: ${options.profileKey}.`,
      'invalid_profile'
    );
  }
  const library = gameCache.getLibrary(parsed.userKey);
  if (!library) {
    throw new PersonnelError(`No library snapshot for ${parsed.key}.`, 'profile_not_imported', 400);
  }
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const wd = options.wikidata || wikidataProvider;
  const moby = options.moby || mobyProvider.createClient();
  const mobyEnabled = typeof moby.isEnabled === 'function' ? moby.isEnabled() : mobyProvider.mobyEnabled();
  const limit = Math.max(1, Number(options.limit) || 200);
  const force = Boolean(options.force);

  const report = {
    profile: parsed.key,
    games: 0,
    updated: 0,
    skippedFresh: 0,
    pendingDetails: 0,
    wdQueries: 0,
    wdSkipped: null,
    wdDisabledUntil: null,
    wdAnswered: 0,
    wdDeferred: 0,
    mobyRequests: 0,
    mobyErrors: [],
    secondaryGames: 0,
    secondaryUpdated: 0,
    secondarySkippedFresh: 0,
    secondaryDeferred: 0,
    secondaryQueries: 0,
    errors: [],
  };

  const wdEnabled = wd.wikidataEnabled();
  const steam = selectSteamTargets({ library, wdEnabled, mobyEnabled, force, limit, now });
  const targets = steam.targets;
  report.pendingDetails = steam.pendingDetails;
  report.skippedFresh = steam.skippedFresh;
  report.games = targets.length;

  await fetchSteamWikidata(targets, wd, options, report, wdEnabled);

  const secondaryList = secondaryWorksFor(parsed.key, options.secondaryWorks);
  const secondary = selectSecondaryTargets({
    list: secondaryList,
    wdEnabled,
    force,
    limit,
    now,
  });
  const secondaryTargets = secondary.targets;
  report.secondarySkippedFresh = secondary.skippedFresh;
  report.secondaryGames = secondaryTargets.length;
  if (secondaryTargets.length && wdEnabled) {
    await fetchSecondaryWikidata(secondaryTargets, wd, options, report);
  }
  await writeSecondaryDocs(secondaryTargets, { now, report });
  await writeSteamDocs(targets, { mobyEnabled, moby, now, report });
  return report;
}

module.exports = {
  enrichPersonnel,
};
