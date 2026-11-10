'use strict';

const editions = require('../editions');
const { yearOfDate } = require('./normalize');
const { normalizeTitle, normalizeSlug, slugsOfLink } = require('./identity');

/* ------------------------------------------------------------------ */
/* cross-store union (was `secondary-union.js`)                        */
/* ------------------------------------------------------------------ */

/** `[{name}]` | `['Action']` | `'Action'` → `['Action']`. */
function genreNames(value) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  for (const entry of list) {
    const name =
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object'
          ? entry.name || entry.label || entry.slug || null
          : null;
    if (name && !out.includes(String(name))) out.push(String(name));
  }
  return out;
}

/**
 * GOG's library snapshot carries `tags[]` as slugs (`role-playing`,
 * `open-world`). They are the store's own tag list, so they are a legitimate
 * **fallback** genre source when the product page (`secondary-details.js`) is
 * not cached yet. The canonical genre line from the product page replaces them
 * once it arrives (`genresSource` tracks which one is in use).
 */
function prettifyTagSlug(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  return text
    // GOG keeps hyphens in its display names (`Role-playing`), so only
    // underscores are turned into spaces here.
    .replace(/_+/g, ' ')
    .replace(/^\s+|\s+$/g, '')
    .replace(/^./, (char) => char.toUpperCase());
}

function genreNamesFromTags(tags) {
  return genreNames(
    (Array.isArray(tags) ? tags : []).map((tag) =>
      typeof tag === 'string' ? prettifyTagSlug(tag) : tag
    )
  );
}

function stringList(value) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  return list
    .map((entry) => (typeof entry === 'string' ? entry : entry && entry.name))
    .filter(Boolean)
    .map(String);
}

/** `stringList` with duplicates removed, order preserved (case-sensitive). */
function uniqueStringList(value) {
  const out = [];
  for (const name of stringList(value)) {
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Same names in the same order — used to keep `enrichUnionWithDetails` idempotent. */
function sameStringList(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function minutesOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Flatten the per-account GOG snapshots into one product/minute view. */
function flattenGogSnapshots(gogSnapshots) {
  const products = [];
  const minutes = {};
  const status = {};
  for (const snapshot of Array.isArray(gogSnapshots) ? gogSnapshots : []) {
    const library = snapshot && snapshot.library ? snapshot.library : null;
    const playtime = snapshot && snapshot.playtime ? snapshot.playtime : null;
    if (library && Array.isArray(library.products)) products.push(...library.products);
    if (playtime && playtime.minutes && typeof playtime.minutes === 'object') {
      for (const [id, value] of Object.entries(playtime.minutes)) {
        const number = minutesOrNull(value);
        if (number == null) continue;
        minutes[id] = (Number(minutes[id]) || 0) + number;
      }
    }
    if (playtime && playtime.entries && typeof playtime.entries === 'object') {
      for (const [id, entry] of Object.entries(playtime.entries)) {
        if (entry && entry.status) status[id] = String(entry.status);
      }
    }
  }
  return { products, minutes, status };
}

function registerIdentity(map, ambiguous, key, workKey) {
  // A QID (or a base appid) must name exactly one work: two works claiming the
  // same identity is a data conflict, not a match, so the key is dropped.
  if (key == null || key === '') return;
  const value = String(key);
  if (map.has(value) && map.get(value) !== workKey) ambiguous.add(value);
  else map.set(value, workKey);
}

function workName(work) {
  return (
    (work.primary && work.primary.name) ||
    (Array.isArray(work.games) && work.games[0] && work.games[0].name) ||
    null
  );
}

function steamUnionEntry(work, name) {
  return {
    workKey: work.workKey,
    name,
    steamWork: work,
    sources: ['steam'],
    ownedOn: ['steam'],
    storeIds: { steam: work.primary ? work.primary.appid : null, gog: null, epic: null },
    hoursBySource: { steam: minutesOrNull(work.minutes) || 0, gog: null, epic: null },
    primaryAppid: work.primary ? work.primary.appid : null,
    gog: null,
    epic: null,
    matchedBy: 'steam',
    confidence: 'single',
    releaseYear: null,
    releaseYearSource: null,
    verticalCover: null,
    image: null,
    genres: [],
    genresSource: null,
    developers: [],
    publishers: [],
    // Field-level provenance of `developers`/`publishers` (04.11.2026): the
    // union fills them from the **library snapshot** first, which is a weak
    // path for Epic (`catalog.developer` is the seller/distributor, AW2 =
    // «Epic Games Publishing»). The store product page (detail document)
    // replaces such a value in `enrichUnionWithDetails`; a value with an
    // unknown/strong provenance is never touched.
    developersSource: null,
    publishersSource: null,
    metadataSources: ['steam-store'],
  };
}

function emptyUnionEntry(workKey, fallbackName) {
  return {
    workKey,
    name: fallbackName || null,
    steamWork: null,
    sources: [],
    ownedOn: [],
    storeIds: { steam: null, gog: null, epic: null },
    hoursBySource: { steam: null, gog: null, epic: null },
    primaryAppid: null,
    gog: null,
    epic: null,
    matchedBy: 'none',
    confidence: 'single',
    releaseYear: null,
    releaseYearSource: null,
    verticalCover: null,
    image: null,
    genres: [],
    genresSource: null,
    developers: [],
    publishers: [],
    // See the Steam-seeded template above: provenance of the two company
    // lists, so a store product page can replace a library-snapshot guess.
    developersSource: null,
    publishersSource: null,
    metadataSources: [],
  };
}

function ensureUnionEntry(byWorkKey, workKey, fallbackName) {
  let entry = byWorkKey.get(workKey);
  if (entry) return entry;
  entry = emptyUnionEntry(workKey, fallbackName);
  byWorkKey.set(workKey, entry);
  return entry;
}

function seedSteamWorks(steamWorks, linkMap) {
  const appidToWork = new Map();
  const qidToWork = new Map();
  const baseAppidToWork = new Map();
  const slugToWork = new Map();
  const titleToWork = new Map();
  const coreTitleToWork = new Map();
  const ambiguousTitles = new Set();
  const ambiguousCoreTitles = new Set();
  const ambiguousQids = new Set();
  const ambiguousBaseAppids = new Set();
  const byWorkKey = new Map();

  for (const work of steamWorks) {
    const name = workName(work);
    if (name) {
      const normalized = normalizeTitle(name);
      if (normalized) {
        if (titleToWork.has(normalized) && titleToWork.get(normalized) !== work.workKey) {
          ambiguousTitles.add(normalized);
        } else {
          titleToWork.set(normalized, work.workKey);
        }
      }
      // The canonical edition key (`editions.coreTitle`) drops edition and
      // region wrappers, so a GOG «… Ultimate Edition» still finds the Steam
      // row that is a regional SKU («… PCR», «… RHCP», «… (RU)»).
      const core = editions.coreTitle(name);
      if (core) {
        if (coreTitleToWork.has(core) && coreTitleToWork.get(core) !== work.workKey) {
          ambiguousCoreTitles.add(core);
        } else {
          coreTitleToWork.set(core, work.workKey);
        }
      }
    }
    for (const game of Array.isArray(work.games) ? work.games : []) {
      const appid = String(game.appid);
      appidToWork.set(appid, work.workKey);
      const link = linkMap[appid];
      for (const slug of slugsOfLink(link)) {
        if (!slugToWork.has(slug)) slugToWork.set(slug, work.workKey);
      }
      // B6 identity of a regional SKU: its own QID is absent, the base card's
      // QID/appid is recorded next to it by the franchise pass. The Wikidata
      // bridge names the **base** game, so these keys are what let a base-game
      // GOG slug join the SKU the owner actually owns.
      registerIdentity(qidToWork, ambiguousQids, editions.qidOf(link), work.workKey);
      registerIdentity(qidToWork, ambiguousQids, editions.baseQidOf(link), work.workKey);
      registerIdentity(
        baseAppidToWork,
        ambiguousBaseAppids,
        editions.baseAppidOf(link),
        work.workKey
      );
    }
    byWorkKey.set(work.workKey, steamUnionEntry(work, name));
  }
  for (const title of ambiguousTitles) titleToWork.delete(title);
  for (const title of ambiguousCoreTitles) coreTitleToWork.delete(title);
  for (const qid of ambiguousQids) qidToWork.delete(qid);
  for (const appid of ambiguousBaseAppids) baseAppidToWork.delete(appid);

  return {
    appidToWork,
    qidToWork,
    baseAppidToWork,
    slugToWork,
    titleToWork,
    coreTitleToWork,
    byWorkKey,
  };
}

function createUnionResolver(index, bridge) {
  const { appidToWork, qidToWork, baseAppidToWork, slugToWork, titleToWork, coreTitleToWork } =
    index;

  const resolveBridged = (prefix, slug) => {
    const key = normalizeSlug(slug);
    if (!key) return null;
    const hit = bridge[`${prefix}:${key}`] || bridge[`${prefix}:${slug}`] || null;
    if (!hit) return null;
    const appid = hit.appid != null ? String(hit.appid) : null;
    // 1. The owner's library contains exactly the appid `P1733` names.
    if (appid) {
      const direct = appidToWork.get(appid);
      if (direct) return direct;
    }
    // 2. Same Wikidata item, different Steam card (regional SKU): the link
    //    document names the base item of the SKU the owner owns.
    if (hit.qid) {
      const viaQid = qidToWork.get(String(hit.qid));
      if (viaQid) return viaQid;
    }
    // 3. `P1733` is the base appid; the link document records it as the SKU's
    //    base (`wikidata.baseAppid`) even when the base card itself is not
    //    owned.
    if (appid) {
      const viaBaseAppid = baseAppidToWork.get(appid);
      if (viaBaseAppid) return viaBaseAppid;
    }
    return null;
  };

  /**
   * Title fallback: the plain normalised key first (existing behaviour), then
   * the canonical edition key, which drops edition and region wrappers. A
   * `GOG`/`Epic` copy titled «… Ultimate Edition» therefore finds a Steam row
   * that is a regional SKU («… PCR»), and vice versa. Both maps are built from
   * the same set of works and drop ambiguous keys, so the fallback can never
   * pick between two Steam works with the same normalised title.
   */
  const resolveByTitle = (name) => {
    const titleKey = normalizeTitle(name);
    if (titleKey) {
      const hit = titleToWork.get(titleKey);
      if (hit) return hit;
    }
    const core = editions.coreTitle(name);
    if (core) return coreTitleToWork.get(core) || null;
    return null;
  };

  return { resolveBridged, resolveByTitle, slugToWork };
}

function applyGogProducts({ products, minutes, gogStatus, byWorkKey, resolver, matched }) {
  const { resolveBridged, resolveByTitle, slugToWork } = resolver;
  let gogMinutes = 0;
  let gogProducts = 0;

  /* ------------------------------- GOG ------------------------------- */
  for (const product of products) {
    const gogGameId = String(product.gogGameId || product.gogProductId || '');
    if (!gogGameId) continue;
    gogProducts++;
    const gogValue = minutesOrNull(minutes[gogGameId]);
    if (gogValue != null) gogMinutes += gogValue;
    const slug = normalizeSlug(product.slug);
    let workKey = resolveBridged('gog', product.slug);
    let matchedBy = workKey ? 'wikidata' : null;
    if (!workKey && slug) workKey = slugToWork.get(slug) || null;
    if (!workKey) {
      workKey = resolveByTitle(product.title);
      if (workKey) matchedBy = 'title';
    }
    if (!workKey) {
      workKey = `gog:${gogGameId}`;
      matchedBy = 'none';
    }
    matched[matchedBy] = (matched[matchedBy] || 0) + 1;

    const entry = ensureUnionEntry(byWorkKey, workKey, product.title || null);
    if (!entry.sources.includes('gog')) entry.sources.push('gog');
    if (!entry.ownedOn.includes('gog')) entry.ownedOn.push('gog');
    entry.storeIds.gog = gogGameId;
    // A missing playtime answer stays `null` (unknown ≠ 0): only a real number
    // from the snapshot moves the per-source field.
    if (gogValue != null) {
      entry.hoursBySource.gog = (minutesOrNull(entry.hoursBySource.gog) || 0) + gogValue;
    } else if (entry.hoursBySource.gog == null) {
      entry.hoursBySource.gog = null;
    }
    entry.gog = {
      gogGameId,
      slug: product.slug || null,
      title: product.title || null,
      image: product.image || null,
      releaseDate: product.releaseDate || null,
      worksOn: product.worksOn || null,
      category: product.category || null,
      isGame: product.isGame == null ? null : product.isGame,
      isMovie: product.isMovie == null ? null : product.isMovie,
      // Contract: the UI must tell «never launched» (0) from «playtime not
      // fetched yet» (also 0) without guessing. A real answer (even 0) is
      // `true`; a missing snapshot answer stays `false`.
      playtimeKnown: gogValue != null,
      status: gogStatus[gogGameId] || (gogValue == null ? 'pending' : 'ok'),
    };
    if (!entry.name) entry.name = product.title || null;
    // A work that is also on Steam reports **why** it was joined: `wikidata`
    // (P2725/P6278 bridge or a P2725 in the link doc) beats `title`.
    if (entry.sources.includes('steam')) {
      if (entry.matchedBy !== 'wikidata' || matchedBy === 'wikidata') {
        entry.matchedBy = matchedBy;
        entry.confidence = matchedBy === 'wikidata' ? 'high' : 'medium';
      }
    } else {
      entry.matchedBy = 'none';
      entry.confidence = 'single';
    }
    if (entry.releaseYear == null) {
      entry.releaseYear = yearOfDate(product.releaseDate);
      // A snapshot date is the **store listing** date, not the original
      // release: `secondary-details.js` may replace it with the product's
      // `globalReleaseDate` once that cache exists (M6d).
      if (entry.releaseYear != null) entry.releaseYearSource = 'gog-library';
    }
    if (!entry.genres.length) entry.genres = genreNames(product.genres);
    if (!entry.genres.length && Array.isArray(product.tags) && product.tags.length) {
      // Fallback until the product page answers: the library's own tag slugs.
      entry.genres = genreNamesFromTags(product.tags);
      if (entry.genres.length) entry.genresSource = 'gog-library';
    }
    if (!entry.developers.length) {
      entry.developers = stringList(product.developers);
      // A library-snapshot field (weak): the product page may replace it.
      if (entry.developers.length) entry.developersSource = 'gog-catalog';
    }
    if (!entry.publishers.length) {
      entry.publishers = stringList(product.publishers);
      if (entry.publishers.length) entry.publishersSource = 'gog-catalog';
    }
    if (!entry.metadataSources.includes('gog-catalog')) entry.metadataSources.push('gog-catalog');
  }

  return { gogMinutes, gogProducts };
}

function applyEpicGames({ epicLayer, epicGames, byWorkKey, resolver, matched }) {
  const { resolveBridged, resolveByTitle } = resolver;
  let epicMinutes = 0;
  let epicOwned = 0;

  /* ------------------------------- Epic ------------------------------ */
  for (const game of epicGames) {
    if (!game || !game.name) continue;
    epicOwned++;
    const epicId = String(game.catalogItemId || game.appName || '');
    const epicValue = minutesOrNull(game.totalMinutes);
    if (epicValue != null) epicMinutes += epicValue;
    let workKey = resolveBridged('epic', game.slug);
    let matchedBy = workKey ? 'wikidata' : null;
    if (!workKey) {
      workKey = resolveByTitle(game.name);
      if (workKey) matchedBy = 'title';
    }
    if (!workKey) {
      workKey = `epic:${epicId}`;
      matchedBy = 'none';
    }
    matched[matchedBy] = (matched[matchedBy] || 0) + 1;
    const entry = ensureUnionEntry(byWorkKey, workKey, game.name);
    if (!entry.sources.includes('epic')) entry.sources.push('epic');
    if (!entry.ownedOn.includes('epic')) entry.ownedOn.push('epic');
    entry.storeIds.epic = epicId;
    if (epicValue != null) {
      entry.hoursBySource.epic = (minutesOrNull(entry.hoursBySource.epic) || 0) + epicValue;
    } else if (entry.hoursBySource.epic == null) {
      entry.hoursBySource.epic = null;
    }
    entry.epic = {
      accountId: (epicLayer && epicLayer.accountId) || null,
      appName: game.appName || null,
      catalogItemId: game.catalogItemId || null,
      slug: game.slug || null,
      namespace: game.namespace || null,
      platforms: Array.isArray(game.platforms) ? game.platforms : [],
      // Epic's catalog bulk has no artwork field today; the key stays present
      // and `null` (honest gap), never a fabricated URL.
      image: game.image || null,
      title: game.name || null,
      releaseDate: game.releaseDate || null,
      developer: game.developer || null,
      publisher: game.publisher || null,
      genres: genreNames(game.genres),
      playtimeKnown: epicValue != null,
      status: epicValue == null ? 'unknown' : 'ok',
    };
    if (!entry.name) entry.name = game.name;
    if (entry.sources.includes('steam')) {
      if (entry.matchedBy !== 'wikidata' || matchedBy === 'wikidata') {
        entry.matchedBy = matchedBy;
        entry.confidence = matchedBy === 'wikidata' ? 'high' : 'medium';
      }
    } else {
      entry.matchedBy = 'none';
      entry.confidence = 'single';
    }
    if (entry.releaseYear == null) {
      entry.releaseYear = yearOfDate(game.releaseDate);
      if (entry.releaseYear != null) entry.releaseYearSource = 'epic-library';
    }
    if (!entry.genres.length) entry.genres = genreNames(game.genres);
    // Epic's catalog bulk names the **seller/distributor** here (AW2:
    // «Epic Games Publishing»), so this is the weakest possible developer
    // source: the CMS product page replaces it as soon as a detail document
    // exists (`enrichUnionWithDetails`).
    if (!entry.developers.length && game.developer) {
      entry.developers = [String(game.developer)];
      entry.developersSource = 'epic-catalog';
    }
    if (!entry.publishers.length && game.publisher) {
      entry.publishers = [String(game.publisher)];
      entry.publishersSource = 'epic-catalog';
    }
    if (!entry.metadataSources.includes('epic-catalog')) entry.metadataSources.push('epic-catalog');
  }

  return { epicMinutes, epicOwned };
}

function deriveUnionHours(worksList) {
  /* --------------------------- derived hours -------------------------- */
  for (const entry of worksList) {
    const steam = minutesOrNull(entry.hoursBySource.steam) || 0;
    const gog = minutesOrNull(entry.hoursBySource.gog) || 0;
    const epic = minutesOrNull(entry.hoursBySource.epic) || 0;
    const secondary = gog + epic;
    entry.steamMinutes = steam;
    entry.secondaryMinutes = secondary;
    // Display total: the owner's hours for the work across the stores he owns.
    entry.displayMinutes = steam + secondary;
    entry.hours = Math.round((entry.displayMinutes / 60) * 10) / 10;
    entry.secondaryHours = Math.round((secondary / 60) * 10) / 10;
    // Unknown ≠ zero: the store never answered for this work.
    entry.hoursUnknown = Boolean(
      (entry.sources.includes('gog') && entry.hoursBySource.gog == null) ||
        (entry.sources.includes('epic') && entry.hoursBySource.epic == null)
    );
    // Contract: one release date string for the «Вне Steam» card, GOG first
    // (its catalogue date is the one the library row already carries), Epic
    // second. `null` means neither store answered.
    if (entry.releaseDate == null) {
      entry.releaseDate =
        (entry.gog && entry.gog.releaseDate) || (entry.epic && entry.epic.releaseDate) || null;
    }
    entry.hoursStatus = {
      steam: entry.sources.includes('steam') ? 'ok' : null,
      gog: entry.sources.includes('gog')
        ? entry.hoursBySource.gog == null
          ? entry.gog && entry.gog.status === 'not_found'
            ? 'not_found'
            : 'pending'
          : 'ok'
        : null,
      epic: entry.sources.includes('epic')
        ? entry.hoursBySource.epic == null
          ? 'unknown'
          : 'ok'
        : null,
    };
    entry.secondaryOnly = !entry.sources.includes('steam');
  }
}

function buildUnionByAppid(steamWorks, byWorkKey) {
  const byAppid = {};
  for (const work of steamWorks) {
    const entry = byWorkKey.get(work.workKey);
    if (!entry) continue;
    for (const game of Array.isArray(work.games) ? work.games : []) {
      const appid = String(game.appid);
      if (!appid) continue;
      byAppid[appid] = {
        workKey: work.workKey,
        sources: [...entry.sources],
        ownedOn: [...entry.ownedOn],
        storeIds: { ...entry.storeIds, steam: game.appid },
        hoursBySource: {
          steam: minutesOrNull(game.playtime_forever) || 0,
          gog: entry.storeIds.gog ? minutesOrNull(entry.hoursBySource.gog) : null,
          epic: entry.storeIds.epic ? minutesOrNull(entry.hoursBySource.epic) : null,
        },
        matchedBy: entry.matchedBy,
        confidence: entry.confidence,
      };
    }
  }
  return byAppid;
}

function buildSecondaryOnly(worksList) {
  return worksList
    .filter((entry) => entry.secondaryOnly)
    .sort(
      (left, right) =>
        (right.displayMinutes || 0) - (left.displayMinutes || 0) ||
        String(left.name || '').localeCompare(String(right.name || ''))
    );
}

/**
 * Build the union view.
 *
 * @param {object} input
 * @param {Array}  input.works          Steam works (`workKey`, `minutes`, `primary`, `games`)
 * @param {Array}  input.gogSnapshots   `[{account, library, playtime}]`
 * @param {object} input.epicLayer      Epic read model (`games[]`, may be null)
 * @param {object} input.links          `{ [appid]: linkDoc }` (may carry P2725)
 * @param {object} input.secondaryLinks `{ 'gog:<slug>'|'epic:<slug>': {qid, appid} }`
 */
function buildSecondaryUnion({
  works,
  gogSnapshots,
  epicLayer,
  links,
  secondaryLinks,
} = {}) {
  const steamWorks = Array.isArray(works) ? works.filter(Boolean) : [];
  const linkMap = links && typeof links === 'object' ? links : {};
  const bridge = secondaryLinks && typeof secondaryLinks === 'object' ? secondaryLinks : {};
  const { products, minutes, status: gogStatus } = flattenGogSnapshots(gogSnapshots);
  const epicGames = Array.isArray(epicLayer && epicLayer.games) ? epicLayer.games : [];

  const index = seedSteamWorks(steamWorks, linkMap);
  const resolver = createUnionResolver(index, bridge);
  const matched = { wikidata: 0, title: 0, none: 0 };

  const gog = applyGogProducts({
    products,
    minutes,
    gogStatus,
    byWorkKey: index.byWorkKey,
    resolver,
    matched,
  });
  const epicSide = applyEpicGames({
    epicLayer,
    epicGames,
    byWorkKey: index.byWorkKey,
    resolver,
    matched,
  });

  const worksList = [...index.byWorkKey.values()];
  deriveUnionHours(worksList);
  const byAppid = buildUnionByAppid(steamWorks, index.byWorkKey);
  const secondaryOnly = buildSecondaryOnly(worksList);

  return {
    works: worksList,
    byWorkKey: index.byWorkKey,
    byAppid,
    secondaryOnly,
    // Kept for the existing GOG block/summary consumers.
    secondaryWorks: secondaryOnly,
    summary: {
      steamWorks: steamWorks.length,
      gogProducts: gog.gogProducts,
      gogMinutes: gog.gogMinutes,
      gogHours: Math.round((gog.gogMinutes / 60) * 10) / 10,
      epicGames: epicSide.epicOwned,
      epicMinutes: epicSide.epicMinutes,
      epicHours: Math.round((epicSide.epicMinutes / 60) * 10) / 10,
      // Union over canonical works: Steam works + works that exist only
      // outside Steam (a GOG/Epic game merged into a Steam work adds no row).
      worksTotal: worksList.length,
      secondaryOnlyWorks: secondaryOnly.length,
      secondaryOnlyGog: secondaryOnly.filter((entry) => entry.sources.includes('gog')).length,
      secondaryOnlyEpic: secondaryOnly.filter((entry) => entry.sources.includes('epic')).length,
      matchedWorks: worksList.filter((entry) => entry.sources.length > 1).length,
      matchedByWikidata: matched.wikidata || 0,
      matchedBySlug: matched.wikidata || 0,
      matchedByTitle: matched.title || 0,
      unmatched: matched.none || 0,
      hoursUnknownWorks: worksList.filter((entry) => entry.hoursUnknown).length,
    },
  };
}

module.exports = {
  genreNames,
  flattenGogSnapshots,
  buildSecondaryUnion,
  stringList,
  uniqueStringList,
  sameStringList,
};
