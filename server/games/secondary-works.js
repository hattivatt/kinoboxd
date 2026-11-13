'use strict';

const gameCache = require('./game-cache');
const gogCache = require('./gog-cache');
const { round1: roundNumber } = require('../core/stats');

const round1 = (value) => roundNumber(value, 'numeric');

function gogSnapshotsForOwner(ownerKey) {
  const out = [];
  for (const library of gogCache.listLibraries()) {
    if (!library || library.ownerProfile !== ownerKey) continue;
    out.push({ library, playtime: gogCache.getPlaytime(library.userKey) });
  }
  return out;
}

function epicLayerForOwner(ownerKey) {
  try {
    return require('./secondary/epic').buildEpicLayerSync({ ownerKey });
  } catch (err) {
    return null;
  }
}

function editionDocFor(profileKey, library, games, details, links) {
  const editions = require('./editions');
  try {
    return editions.ensureEditions(profileKey, { library, games, details, links }).doc;
  } catch (err) {
    return editions.buildEditionIndex({
      games,
      details,
      links,
      profileKey,
      libraryFingerprint: library.fingerprint,
    });
  }
}

function secondaryIdentityOf(entry, options = {}) {
  const franchise = require('./franchise');
  const { normalizeSlug } = require('./secondary/identity');
  const store = entry && entry.epic ? 'epic' : entry && entry.gog ? 'gog' : null;
  const rawSlug = entry && entry.epic ? entry.epic.slug : entry && entry.gog ? entry.gog.slug : null;
  const slug = rawSlug ? normalizeSlug(rawSlug) : null;
  const bridge = options.bridge && typeof options.bridge === 'object' ? options.bridge : {};
  const titleBridge =
    options.titleBridge && typeof options.titleBridge === 'object' ? options.titleBridge : {};
  const key = store && slug ? `${store}:${slug}` : null;
  const link = key ? bridge[key] || titleBridge[key] || null : null;
  const qid = link && link.qid ? String(link.qid) : null;
  const doc = options.franchiseDoc && typeof options.franchiseDoc === 'object'
    ? options.franchiseDoc
    : franchise.readSecondaryFranchise();
  const nowMs = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const ttlMs = options.ttlMs == null ? franchise.ttlMsFromEnv() : options.ttlMs;
  const hit = franchise.secondaryFranchiseFrom(doc, { store, slug, qid });
  const fresh = franchise.isSecondaryFranchiseFresh(hit, ttlMs, nowMs);
  const series = fresh && hit && hit.franchise ? hit.franchise : null;
  return {
    store,
    slug,
    qid,
    franchiseChecked: Boolean(fresh),
    franchise: series
      ? {
          key: `wd:${series.qid}`,
          label: series.labelEn || series.labelMul || series.labelRu || null,
          labelRu: series.labelRu || null,
        }
      : null,
  };
}

function attachSecondaryIdentity(union, options = {}) {
  if (!union || !Array.isArray(union.works)) return union;
  const franchise = require('./franchise');
  const franchiseDoc = options.franchiseDoc || franchise.readSecondaryFranchise();
  const ttlMs = options.ttlMs == null ? franchise.ttlMsFromEnv() : options.ttlMs;
  const now = options.now == null ? Date.now() : options.now;
  for (const entry of union.works) {
    const identity = secondaryIdentityOf(entry, {
      bridge: options.bridge,
      titleBridge: options.titleBridge,
      franchiseDoc,
      ttlMs,
      now,
    });
    entry.qid = identity.qid;
    entry.franchise = identity.franchise;
    entry.franchiseKey = identity.franchise ? identity.franchise.key : null;
    entry.franchiseChecked = identity.franchiseChecked;
  }
  return union;
}

function secondaryWorksForOwner(ownerKey, options = {}) {
  const parsed = gameCache.parseProfileToken(ownerKey);
  if (!parsed) return [];
  const gogSnapshots = gogSnapshotsForOwner(parsed.key);
  const epicLayer = epicLayerForOwner(parsed.key);
  if (!gogSnapshots.length && !epicLayer) return [];
  const library = gameCache.getLibrary(parsed.userKey);
  if (!library) return [];
  const games = Array.isArray(library.games) ? library.games : [];
  const appids = games.map((game) => game.appid);
  const details = gameCache.listDetails(appids);
  const franchise = require('./franchise');
  const links = franchise.readLinksMap(appids);
  const editionDoc = editionDocFor(parsed.key, library, games, details, links);
  const { buildWorks } = require('./stats/works');
  const { allWorks } = buildWorks({
    input: { editions: editionDoc },
    keptGames: games,
    details,
    links,
    profileKey: parsed.key,
    library,
  });
  const { buildSecondaryUnion } = require('./secondary/union');
  const { readSecondaryLinks, readSecondaryTitleLinks } = require('./secondary/cache');
  const bridge = options.secondaryLinks || readSecondaryLinks({ allowStale: true });
  const titleBridge =
    options.secondaryTitleLinks || readSecondaryTitleLinks({ allowStale: true });
  const union = buildSecondaryUnion({
    works: allWorks,
    gogSnapshots,
    epicLayer,
    links,
    secondaryLinks: bridge,
  });
  const gogIds = [];
  const epicSlugs = [];
  for (const entry of union.works) {
    if (entry.gog && entry.gog.gogGameId) gogIds.push(String(entry.gog.gogGameId));
    if (entry.epic && entry.epic.slug) epicSlugs.push(entry.epic.slug);
  }
  const { readDetailsIndex, enrichUnionWithDetails } = require('./secondary-details');
  enrichUnionWithDetails(union, readDetailsIndex({ gogIds, epicSlugs }));
  const franchiseDoc = options.franchiseDoc || franchise.readSecondaryFranchise();
  const now = options.now == null ? Date.now() : options.now;
  const ttlMs = options.ttlMs == null ? franchise.ttlMsFromEnv() : options.ttlMs;
  const out = [];
  for (const entry of union.secondaryOnly) {
    const identity = secondaryIdentityOf(entry, {
      bridge,
      titleBridge,
      franchiseDoc,
      ttlMs,
      now,
    });
    out.push({
      workKey: entry.workKey,
      name: entry.name || null,
      hours: round1((entry.displayMinutes || 0) / 60),
      qid: identity.qid,
      franchise: identity.franchise,
      franchiseChecked: identity.franchiseChecked,
      releaseYear:
        entry.releaseYear == null ? null : Number(entry.releaseYear) || null,
      developers: [...(entry.developers || [])],
      publishers: [...(entry.publishers || [])],
      genres: [...(entry.genres || [])],
      sources: [...entry.sources],
      store: identity.store,
      slug: identity.slug,
      storeIds: { ...entry.storeIds },
    });
  }
  return out;
}

module.exports = {
  gogSnapshotsForOwner,
  secondaryIdentityOf,
  attachSecondaryIdentity,
  secondaryWorksForOwner,
};
