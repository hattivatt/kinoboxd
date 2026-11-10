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
    // Which sources can still add something? `wikidata` counts as covered only
    // when the document records that Wikidata actually answered (`wdAsked`),
    // otherwise a failed/skipped run would look complete and the 90-day
    // freshness window would keep the credits away for three months.
    const needs = ['steam-store'];
    if (wdEnabled && !(existing && existing.wdAsked === true)) needs.push('wikidata');
    if (mobyEnabled && links.mobyId && links.mobyPlatformId) needs.push('mobygames');
    // A document written under an older label rule is re-fetched once even
    // while it is still «fresh»: its names may be truncated fragments of the
    // real ones (§4.2, Q3539040 «Development Studio»).
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
  // Wikidata: one appid batch (resolves P1733) for games without a QID, then
  // one QID batch for the rest. Both are ≤450 values inside the provider.
  const withoutQid = targets.filter((target) => !target.links.qid).map((target) => target.appid);
  if (withoutQid.length && wdEnabled) {
    const result = await wd.creditsForAppids(withoutQid, options);
    report.wdQueries += result.queries;
    report.wdSkipped = result.skipped || report.wdSkipped;
    report.wdDisabledUntil = result.disabledUntil || report.wdDisabledUntil;
    report.errors.push(...(result.errors || []));
    if (!result.skipped && !(result.errors || []).length) {
      // Asked AND answered (even with «nothing»): the negative cache is valid
      // for 90 days, so the game is not asked again on the next run. A network
      // failure / breaker / HTTP error is NOT an answer — `wdAsked` stays
      // false and the game is retried.
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
    // The store credits are recomputed from the live union on every pass; a
    // document written from an older union (before the developers/publishers
    // provenance fix, or after the store page changed) carries a different
    // signature and is re-written even inside the 90-day freshness window.
    const liveStoreStudios = carriedStoreStudios(studiosFromSecondaryWork(work), existing);
    const storeSignature = storeStudiosSignature(liveStoreStudios);
    const storeStale = Boolean(existing) && existing.storeSignature !== storeSignature;
    // A work with a QID that was already asked is complete; a work without a
    // QID only needs the store-derived studios, which the document carries.
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
    // Asked AND answered (even «no credits»): the negative answer is a
    // settled 90-day cache, exactly like the Steam pass.
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
      // WD did not answer this run (cooldown/outage/budget): keep the cached
      // people instead of wiping them with an empty document.
      studios.push(...(existing.studios || []).filter((entry) => entry.source === 'wikidata'));
      people.push(...(existing.people || []).filter((entry) => entry.source === 'wikidata'));
      sources.add('wikidata');
    }
    // «Wikidata has answered for this work», not «asked this run»: a pass that
    // only refreshes the store credits (changed signature) must not reset a
    // settled Wikidata answer and re-ask on the next pass.
    const wdAnswered =
      Boolean(target.wdCredits) ||
      target.wdAsked === true ||
      (!target.needsAsk && Boolean(existing && existing.wdAsked === true));
    if (!wdAnswered && !existing && work.qid && !target.wdAsked) {
      // A work with a QID but no answer and no cache: writing now would look
      // «fresh» for 90 days. Defer, the next pass retries.
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
      // Signature of the store credits this document was built from: the next
      // pass compares it with the live union and re-writes a changed list
      // without waiting for the 90-day TTL.
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

/** Credits already cached for a source that did not answer this run. */
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
      // Asked, but the game has no WD item/credits: remember the answer so the
      // negative cache lasts 90 days (ИГРЫ §3.3).
      sources.add('wikidata');
    }
    // Wikidata/Moby did not answer (cooldown, outage, budget): keep the credits
    // already cached for that source instead of wiping them with an empty run.
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
    // Nothing was asked successfully and nothing is cached: writing a document
    // now would look «fresh» and hide the credits for 90 days. Defer instead —
    // the next pass (or the lazy route kick) retries.
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
      // Persisted verdict: «Wikidata was actually asked» (credits or a negative
      // answer). `isPersonnelFresh`/`covered` rely on it, so a transient WDQS
      // failure can never be mistaken for a complete run.
      wdAsked: wdAnswered,
      // Which label rule produced these names (§4.2). Only a real Wikidata
      // answer can raise it: a carried-over document keeps its old number and
      // stays eligible for the one-off re-fetch.
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

/**
 * Fetch credits for the profile's games and persist `personnel/<appid>.json`.
 * Network phase: Wikidata batches + optional MobyGames per game (1.1 s pause).
 *
 * @param {{profileKey:string, limit?:number, force?:boolean, now?:Function,
 *          wikidata?:object, moby?:object, sleep?:Function}} options
 */
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
    // M6 follow-up: GOG/Epic-only works.
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

  /* ------------------------------------------------------------------ */
  /* Secondary-only works (GOG/Epic): studios from store details, people  */
  /* from Wikidata when the bridge resolved a QID.                        */
  /* ------------------------------------------------------------------ */
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
