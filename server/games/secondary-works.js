'use strict';

/**
 * Secondary-only works of one owner (M6 follow-up, 03.11.2026).
 *
 * A GOG/Epic game that is **not** in the owner's Steam library is a real owned
 * work, but it has no `appid`: `/api/games/game/:appid` cannot describe it and
 * the Steam-centric passes (personnel, franchises) used to skip it entirely.
 * Alan Wake 2 (Epic exclusive) is the reference case: Remedy Entertainment must
 * appear in «Игры Remedy», and P179 must put the game into «Alan Wake».
 *
 * This module builds exactly that list, reusing the union
 * (`secondary.js:buildSecondaryUnion`) so a work that *is* on Steam is never
 * returned twice and hours are never summed:
 *
 *   - Steam works are built from the library + the canonical editions index
 *     (the same `buildWorks` the stats payload uses);
 *   - GOG/Epic products of **this** owner are unioned by `workKey`;
 *   - only `union.secondaryOnly` entries survive (a Steam work merged with a
 *     store copy adds no row);
 *   - store details (`secondary-details.readDetailsIndex`) fill
 *     developers/publishers, and the Wikidata bridge (`links/secondary.json`,
 *     slug entries + title entries) supplies the QID;
 *   - the franchise comes from `links/secondary-franchise.json` (fresh only).
 *
 * Everything is a cache read: no network, no mutation except the editions
 * index that `/stats` already persists. The caller decides whether to pass
 * `secondaryWorks` explicitly (tests, purity) or let the function read.
 */

const gameCache = require('./game-cache');
const gogCache = require('./gog-cache');

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

/** GOG snapshots of exactly one owner (never another owner's token). */
function gogSnapshotsForOwner(ownerKey) {
  const out = [];
  for (const library of gogCache.listLibraries()) {
    if (!library || library.ownerProfile !== ownerKey) continue;
    out.push({ library, playtime: gogCache.getPlaytime(library.userKey) });
  }
  return out;
}

/** Epic read model of the owner, or `null` when no account is bound. */
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

/**
 * Pure metadata attachment: QID + franchise of one union entry. Used both by
 * this module and by the `/stats` secondary block, so the two can never
 * disagree about which series a secondary work belongs to.
 *
 * @param {object} entry       union entry (`gog`/`epic` blocks + `workKey`)
 * @param {{bridge?:object, titleBridge?:object, franchiseDoc?:object,
 *          ttlMs?:number, now?:number}} options
 */
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

/**
 * Attach QID/franchise to every work of a union (in place). The stats payload
 * calls this after `enrichUnionWithDetails`, so `secondaryWorks`/`gamesIndex`
 * rows can carry the same franchise reference a Steam row does.
 */
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

/**
 * Secondary-only works of one owner (cache read, no network).
 *
 * @param {string} ownerKey `steam-<steamid64>`
 * @param {{secondaryLinks?:object, secondaryTitleLinks?:object,
 *          franchiseDoc?:object, ttlMs?:number, now?:number}} [options]
 * @returns {Array<{workKey:string, name:string|null, hours:number,
 *          qid:string|null, franchise:object|null, franchiseChecked:boolean,
 *          releaseYear:number|null, developers:string[], publishers:string[],
 *          genres:string[], sources:string[], store:string, slug:string|null,
 *          storeIds:object}>}
 */
function secondaryWorksForOwner(ownerKey, options = {}) {
  const parsed = gameCache.parseProfileToken(ownerKey);
  if (!parsed) return [];
  const gogSnapshots = gogSnapshotsForOwner(parsed.key);
  const epicLayer = epicLayerForOwner(parsed.key);
  // Fast path: a Steam-only owner has no secondary work by definition and the
  // whole editions/details read would be wasted.
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
