'use strict';

const {
  STUDIO_ROLES,
  PEOPLE_ROLES,
  normalizeName,
  cleanName,
  asNameList,
  hasCyrillic,
  hasLatin,
  round2,
  round4,
  createUnion,
  strongKey,
  studioCoreKey,
  emptyOverrides,
} = require('./identity');

/**
 * Group raw credit entries into entities.
 *
 * @param {Array<object>} entries every (game, entity, role) occurrence
 * @param {'person'|'studio'} kind
 * @param {object} overrides normalized overrides document
 */
function groupEntries(entries, kind, overrides) {
  const union = createUnion();
  const keys = new Set(entries.map(strongKey));
  for (const key of keys) union.find(key);

  // 1. Strong ids are already in the key: nothing to do.
  // 2. Same name, no strong ids → same entity. Same name, several strong ids →
  //    separate entities (never merge two QIDs, §4.3).
  const byName = new Map();
  for (const entry of entries) {
    const nameKey = normalizeName(entry.name);
    if (!nameKey) continue;
    if (!byName.has(nameKey)) byName.set(nameKey, new Set());
    byName.get(nameKey).add(strongKey(entry));
  }
  const splitNames = new Set(
    overrides.manual.splits
      .filter((entry) => entry.type === kind)
      .map((entry) => normalizeName(entry.name))
  );
  const ambiguousNames = new Set();
  for (const [nameKey, keySet] of byName) {
    const list = [...keySet];
    const strong = list.filter((key) => !key.startsWith('name:'));
    if (strong.length > 1) {
      // Two people with the same name: keep them apart and say so.
      ambiguousNames.add(nameKey);
      continue;
    }
    if (splitNames.has(nameKey)) {
      ambiguousNames.add(nameKey);
      continue;
    }
    for (let i = 1; i < list.length; i++) union.union(list[0], list[i]);
  }

  // 2b. Studios: the same company reaches us twice — as a Wikidata entity with
  //     a QID and as the Steam `developers[]` string — with spellings that
  //     differ only by a legal form («Valve Corporation» vs «Valve»,
  //     «FromSoftware, Inc.» vs «FromSoftware»). That pair is one company when
  //     exactly ONE strong id claims the core name: two QIDs are never merged
  //     (§4.3), and a core name that no id claims is left alone (no fuzzy
  //     matching without a QID, §4.2).
  if (kind === 'studio') {
    const byCore = new Map();
    for (const [nameKey, keySet] of byName) {
      const core = studioCoreKey(nameKey);
      if (!core) continue;
      if (!byCore.has(core)) byCore.set(core, new Set());
      for (const key of keySet) byCore.get(core).add(key);
    }
    for (const [core, keySet] of byCore) {
      if (keySet.size < 2 || splitNames.has(core)) continue;
      const strong = [...keySet].filter((key) => !key.startsWith('name:'));
      if (strong.length !== 1) continue;
      for (const key of keySet) union.union(strong[0], key);
    }
  }

  // 3. Manual merges: `from` spelling joins the `to` entity (only when the
  //    override explicitly asks for it — a manual decision beats the rule).
  for (const merge of overrides.manual.merges) {
    if (merge.type !== kind) continue;
    const fromKey = normalizeName(merge.from);
    const toKey = normalizeName(merge.to);
    const fromKeys = byName.get(fromKey);
    const toKeys = byName.get(toKey);
    if (!fromKeys || !toKeys) continue;
    const anchor = [...toKeys][0];
    for (const key of [...fromKeys, ...toKeys]) union.union(anchor, key);
  }

  const groups = new Map();
  for (const entry of entries) {
    const root = union.find(strongKey(entry));
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(entry);
  }

  const result = [];
  for (const [root, list] of groups) {
    const names = [...new Set(list.map((entry) => cleanName(entry.name)).filter(Boolean))];
    const nameEn =
      list.map((entry) => cleanName(entry.nameEn)).find((name) => name && hasLatin(name) && !hasCyrillic(name)) ||
      names.find((name) => hasLatin(name) && !hasCyrillic(name)) ||
      null;
    const nameRu =
      list.map((entry) => cleanName(entry.nameRu)).find((name) => name && hasCyrillic(name)) ||
      names.find((name) => hasCyrillic(name)) ||
      null;
    const qids = [...new Set(list.map((entry) => entry.qid).filter(Boolean))];
    const mobyIds = [...new Set(list.map((entry) => entry.mobyId).filter((id) => id != null))];
    const roles = [...new Set(list.flatMap((entry) => entry.roles || []))].sort();
    const sources = [...new Set(list.map((entry) => entry.source).filter(Boolean))];
    const ambiguous =
      qids.length > 1 ||
      [...byName.entries()].some(
        ([nameKey, keySet]) => ambiguousNames.has(nameKey) && keySet.has(root)
      );
    result.push({
      key: root,
      names,
      nameEn,
      nameRu,
      qid: qids[0] || null,
      mobyId: mobyIds[0] || null,
      roles,
      sources,
      ambiguous,
      entries: list,
    });
  }
  return { groups: result, ambiguousNames };
}

function applyManualNames(group, kind, overrides) {
  const manual = overrides.manual[kind] || {};
  let display = null;
  const extraAliases = [];
  for (const name of group.names) {
    const entry = manual[normalizeName(name)];
    if (!entry) continue;
    if (entry.display) display = cleanName(entry.display) || display;
    if (Array.isArray(entry.aliases)) extraAliases.push(...entry.aliases.map(cleanName).filter(Boolean));
  }
  for (const alias of overrides.manual.aliases) {
    if (alias.type !== kind) continue;
    const target = normalizeName(alias.name);
    if (group.names.some((name) => normalizeName(name) === target)) {
      const value = cleanName(alias.alias);
      if (value) extraAliases.push(value);
    }
  }
  // Every known spelling (EN, RU, alternate) stays reachable as an alias; the
  // display name is filtered out below. A manual display only changes which
  // spelling is primary, never hides the others.
  for (const name of [group.nameEn, group.nameRu, ...group.names]) {
    if (name) extraAliases.push(name);
  }
  const primary = display || group.nameEn || group.names[0] || group.nameRu || '';
  const aliases = [...new Set(extraAliases.map(cleanName).filter(Boolean))]
    .filter((name) => normalizeName(name) !== normalizeName(primary));
  return { display: primary, aliases };
}

function itemId(group) {
  if (group.qid) return `wd:${group.qid}`;
  if (group.mobyId != null) return `moby:${group.mobyId}`;
  return `name:${normalizeName(group.names[0] || '')}`;
}

/**
 * Studios of a secondary-only work from its store detail document
 * (`developers[]`/`publishers[]`). Provenance is the store, never Wikidata:
 * the store page names the company, Wikidata credits are a separate source.
 */
function studiosFromSecondaryWork(work) {
  const sources = Array.isArray(work && work.sources) ? work.sources : [];
  const source = sources.includes('gog') ? 'gog-store' : 'epic-store';
  const map = new Map();
  const add = (name, role) => {
    const clean = cleanName(name);
    if (!clean) return;
    const key = normalizeName(clean);
    if (!key) return;
    let item = map.get(key);
    if (!item) {
      item = {
        name: clean,
        nameEn: hasLatin(clean) && !hasCyrillic(clean) ? clean : null,
        nameRu: hasCyrillic(clean) ? clean : null,
        qid: null,
        mobyId: null,
        roles: [],
        roleSource: source,
        source,
        confidence: 'high',
      };
      map.set(key, item);
    }
    if (!item.roles.includes(role)) item.roles.push(role);
  };
  for (const name of (work && work.developers) || []) add(name, 'developer');
  for (const name of (work && work.publishers) || []) add(name, 'publisher');
  return [...map.values()];
}

/** Sources whose credits come from a store document (not from Wikidata). */
const STORE_STUDIO_SOURCES = new Set(['steam-store', 'gog-store', 'epic-store']);

/**
 * Stable signature of the **store-derived** studios of a secondary work
 * (normalized name + sorted roles). It is written into
 * `personnel/work-<key>.json` so a document whose store list changed is
 * re-written even while it is still «fresh»: a 90-day TTL would otherwise keep
 * a wrong credit («Epic Games Publishing» as the developer of Alan Wake 2)
 * alive for three months after the union was fixed.
 */
function storeStudiosSignature(studios) {
  return (Array.isArray(studios) ? studios : [])
    .map((entry) => {
      const name = normalizeName(entry && entry.name);
      const roles = [...new Set((entry && entry.roles) || [])].sort().join('+');
      return `${name}:${roles}`;
    })
    .filter(Boolean)
    .sort()
    .join('|');
}

/**
 * Store credits of a secondary work for the aggregate: the **live union is the
 * authority** (it is rebuilt from the store documents on every `/stats` call),
 * the persisted document only adds what the union cannot supply — Wikidata
 * credits, or a store list when the detail document is gone. A persisted
 * *store* entry whose company is already named by the live list is dropped: its
 * roles were computed from an older union, so keeping it would resurrect
 * «Epic Games Publishing» as a developer (Alan Wake 2, 04.11.2026).
 */
function studiosOfSecondaryWork(work, doc) {
  const live = studiosFromSecondaryWork(work);
  const persisted = Array.isArray(doc && doc.studios) ? doc.studios : [];
  const out = [...live];
  const liveByName = new Map(live.map((entry) => [normalizeName(entry.name), entry]));
  for (const entry of persisted) {
    const name = normalizeName(entry && entry.name);
    if (!name) continue;
    if (STORE_STUDIO_SOURCES.has(entry.source) && liveByName.has(name)) {
      // The live union re-derived the company (and its roles) from the current
      // store document; keep only the identity the document added (Wikidata
      // QID/Moby id), so grouping with the Steam/Wikidata record survives.
      const liveEntry = liveByName.get(name);
      if (liveEntry && !liveEntry.qid && entry.qid) liveEntry.qid = entry.qid;
      if (liveEntry && liveEntry.mobyId == null && entry.mobyId != null) {
        liveEntry.mobyId = entry.mobyId;
      }
      continue;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Store studios to persist: the live list when the union has one, otherwise the
 * store entries already cached (a detail document that is missing or stale must
 * not erase the credit).
 */
function carriedStoreStudios(live, existing) {
  if (live.length) return live;
  const persisted = Array.isArray(existing && existing.studios) ? existing.studios : [];
  return persisted.filter((entry) => STORE_STUDIO_SOURCES.has(entry && entry.source));
}

/**
 * Merge studios of a secondary work without losing their store provenance.
 * `dedupeStudios` maps any non-Wikidata source to `steam-store` (its fallback),
 * which would mislabel a GOG/Epic credit; here the store source is preserved
 * and two entries merge only by QID or by normalized name.
 */
function mergeSecondaryStudios(list) {
  const map = new Map();
  for (const entry of list || []) {
    const name = cleanName(entry && entry.name);
    if (!name) continue;
    const key = entry.qid ? `qid:${entry.qid}` : `name:${normalizeName(name)}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...entry, name, roles: [...(entry.roles || [])] });
      continue;
    }
    for (const role of entry.roles || []) {
      if (!existing.roles.includes(role)) existing.roles.push(role);
    }
    if (!existing.qid && entry.qid) existing.qid = entry.qid;
  }
  return [...map.values()];
}

/** Cached secondary works of one owner (lazy: heavy union read on first use). */
function secondaryWorksFor(profileKey, provided) {
  if (Array.isArray(provided)) return provided;
  try {
    return require('../secondary-works').secondaryWorksForOwner(profileKey);
  } catch (err) {
    return [];
  }
}

/** Studios credited by Steam appdetails (the base of the first block, §7.1). */
function studiosFromDetails(details) {
  if (!details) return [];
  const out = [];
  const push = (names, role) => {
    for (const name of names) {
      out.push({
        name,
        nameEn: hasLatin(name) && !hasCyrillic(name) ? name : null,
        nameRu: hasCyrillic(name) ? name : null,
        qid: null,
        mobyId: null,
        roles: [role],
        roleSource: 'steam-store',
        source: 'steam-store',
        confidence: 'high',
      });
    }
  };
  push(asNameList(details.developers != null ? details.developers : details.developirts), 'developer');
  push(asNameList(details.publishers), 'publisher');
  return out;
}

function sourceRank(sources) {
  if (sources.has('mobygames')) return 'mobygames';
  if (sources.has('wikidata')) return 'wikidata';
  if (sources.has('steam-store')) return 'steam-store';
  return [...sources].sort()[0] || null;
}

function strongestRoleSource(entries) {
  if (entries.some((entry) => (entry.roleSource || entry.source) === 'mobygames')) return 'mobygames';
  if (entries.some((entry) => (entry.roleSource || entry.source) === 'wikidata')) return 'wikidata';
  return 'steam-store';
}

/**
 * Merge credits inside one game's document. Reuses `groupEntries`, so the same
 * identity rules apply: a Steam studio without a QID is unified with its
 * Wikidata record by normalized name, while two different QIDs never merge.
 */
function dedupeWithinGame(list, kind) {
  const entries = (list || [])
    .map((entry) => ({ ...entry, game: { appid: 0, name: '', hours: 0 } }))
    .filter((entry) => cleanName(entry.name));
  const { groups } = groupEntries(entries, kind, emptyOverrides());
  return groups.map((group) => {
    const sources = new Set(group.entries.map((entry) => entry.source).filter(Boolean));
    const confidence = group.entries.some((entry) => entry.confidence === 'high')
      ? 'high'
      : (group.entries[0] && group.entries[0].confidence) || 'high';
    return {
      name: group.nameEn || group.names[0] || group.nameRu,
      nameEn: group.nameEn,
      nameRu: group.nameRu,
      qid: group.qid,
      mobyId: group.mobyId,
      roles: group.roles,
      roleSource: strongestRoleSource(group.entries),
      source: sourceRank(sources),
      sources: [...sources].sort(),
      confidence,
      image: (group.entries.find((entry) => entry.image) || {}).image || null,
    };
  });
}

function dedupePeople(list) {
  return dedupeWithinGame(list, 'person');
}

function dedupeStudios(list) {
  return dedupeWithinGame(list, 'studio').map(({ image, ...studio }) => studio);
}

function buildItems(games, options) {
  const { kind, role, sort, gamesLimit, totalHours, overrides } = options;
  const entries = [];
  for (const game of games) {
    const list = kind === 'studio' ? game.studios : game.people;
    for (const credit of list) {
      entries.push({ ...credit, game });
    }
  }
  const { groups } = groupEntries(entries, kind, overrides);
  const items = [];
  for (const group of groups) {
    // Studio entities are grouped across both studio roles (one company =
    // one card), but `count`/`hours` only over the games where this entity
    // actually holds the requested role (§7.2: developer and publisher are
    // separate answers, not one "studio" bucket).
    const relevant = group.entries.filter((entry) => (entry.roles || []).includes(role));
    if (!relevant.length) continue;
    const gamesById = new Map();
    const keyOfGame = (game) => game.workKey || String(game.appid);
    for (const entry of relevant) {
      const gameKey = keyOfGame(entry.game);
      const existing = gamesById.get(gameKey);
      if (existing) {
        for (const r of entry.roles || []) {
          if (!existing.roles.includes(r)) existing.roles.push(r);
        }
        continue;
      }
      gamesById.set(gameKey, {
        appid: entry.game.appid == null ? null : entry.game.appid,
        workKey: entry.game.workKey || null,
        secondaryOnly: entry.game.secondaryOnly === true,
        name: entry.game.name,
        hours: entry.game.hours,
        completion: entry.game.completion,
        roles: [...(entry.roles || [])],
      });
    }
    const gameList = [...gamesById.values()];
    const hours = round2(gameList.reduce((sum, game) => sum + game.hours, 0));
    const completions = gameList.map((game) => game.completion).filter((value) => value != null);
    const names = applyManualNames(group, kind, overrides);
    items.push({
      id: itemId(group),
      name: names.display,
      aliases: names.aliases,
      qid: group.qid,
      mobyId: group.mobyId,
      roles: group.roles,
      count: gameList.length,
      hours,
      hoursShare: totalHours > 0 ? round4(hours / totalHours) : 0,
      avgCompletion: completions.length
        ? Math.round(completions.reduce((sum, value) => sum + value, 0) / completions.length)
        : null,
      games: gameList
        .slice()
        .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name, 'ru'))
        .slice(0, gamesLimit)
        .map((game) =>
          game.secondaryOnly
            ? {
                appid: game.appid,
                workKey: game.workKey || null,
                secondaryOnly: true,
                name: game.name,
                hours: game.hours,
              }
            : { appid: game.appid, name: game.name, hours: game.hours }
        ),
      ambiguous: group.ambiguous,
      sources: group.sources.sort(),
    });
  }
  items.sort((a, b) => {
    if (sort === 'count') return b.count - a.count || b.hours - a.hours || a.name.localeCompare(b.name, 'ru');
    if (sort === 'completion') {
      return (
        (b.avgCompletion == null ? -1 : b.avgCompletion) -
          (a.avgCompletion == null ? -1 : a.avgCompletion) || b.hours - a.hours
      );
    }
    if (sort === 'name') return a.name.localeCompare(b.name, 'ru');
    return b.hours - a.hours || b.count - a.count || a.name.localeCompare(b.name, 'ru');
  });
  return items;
}

function coverageCounts(games) {
  const steamGames = games.filter((game) => game.appid != null);
  const secondaryGames = games.filter((game) => game.appid == null);
  const detailsResolved = steamGames.filter((game) => game.detailsResolved).length;
  const gamesWithCredits = steamGames.filter(
    (game) => game.creditsResolved && game.people.length > 0
  ).length;
  const secondaryWithCredits = secondaryGames.filter(
    (game) => game.creditsResolved
  ).length;
  const studiosResolved = games.filter((game) => game.studios.length > 0).length;
  const byRole = {};
  for (const peopleRole of PEOPLE_ROLES) {
    byRole[peopleRole] = games.filter((game) =>
      game.people.some((person) => (person.roles || []).includes(peopleRole))
    ).length;
  }
  const byStudioRole = {};
  for (const studioRole of STUDIO_ROLES) {
    byStudioRole[studioRole] = games.filter((game) =>
      game.studios.some((studio) => (studio.roles || []).includes(studioRole))
    ).length;
  }
  const gamesTotal = games.length;
  const steamTotal = steamGames.length;
  const percent = steamTotal ? Math.round((gamesWithCredits / steamTotal) * 100) : 0;
  const studioPercent = gamesTotal ? Math.round((studiosResolved / gamesTotal) * 100) : 0;
  const developerPercent = gamesTotal
    ? Math.round((byStudioRole.developer / gamesTotal) * 100)
    : 0;
  const publisherPercent = gamesTotal
    ? Math.round((byStudioRole.publisher / gamesTotal) * 100)
    : 0;
  return {
    steamGames,
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
  };
}

module.exports = {
  groupEntries,
  applyManualNames,
  itemId,
  sourceRank,
  strongestRoleSource,
  dedupeWithinGame,
  dedupePeople,
  dedupeStudios,
  studiosFromSecondaryWork,
  STORE_STUDIO_SOURCES,
  storeStudiosSignature,
  studiosOfSecondaryWork,
  carriedStoreStudios,
  mergeSecondaryStudios,
  secondaryWorksFor,
  studiosFromDetails,
  buildItems,
  coverageCounts,
};
