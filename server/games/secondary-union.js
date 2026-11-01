'use strict';

/**
 * Cross-store union of the **same owner's** libraries (M6c).
 *
 * Steam stays the journal (achievements, `rtime_last_played`, completion); GOG
 * and Epic are same-owner secondary libraries (§14.4). This module answers one
 * question only: *which works exist, what does each store know about them, and
 * how many minutes did each store record?* It is pure (plain objects in, plain
 * objects out) so `stats.js` can include the result in every aggregate without
 * a second cache read.
 *
 * Identity (`workKey`) resolution, strongest first:
 *   1. **Wikidata bridge** — a store slug resolved to a Steam appid by the
 *      `P2725`/`P6278` → `P1733` batch (`secondary-identity.js`), then
 *      `appid → workKey` through the canonical edition index;
 *   2. **`links/<appid>.json` `P2725`** — the GOG slug of a Steam work
 *      (`gog-union.js` already reads it);
 *   3. **exact normalised title** — unique among Steam works, confidence
 *      `medium`;
 *   4. **own work** — `gog:<gogGameId>` / `epic:<catalogItemId>`, confidence
 *      `single`.
 *
 * Hours are reported **per source** and also as a display sum
 * (`displayMinutes` = Steam + GOG + Epic). The 01.11.2026 product decision
 * («объединённая работа показывает Steam-часы + GOG-часы, разбивка остаётся в
 * `hoursBySource`») is implemented here once, so no aggregate can forget it.
 *
 * An unknown number is **never** a zero: `hoursBySource.<store>` is `null`
 * when the store has no playtime answer for that work, and the entry is marked
 * `hoursUnknown` so the `minHours` filter keeps it.
 */

const {
  normalizeTitle,
  normalizeSlug,
  slugsOfLink,
} = require('./gog-union');

/** `2023-09-26` / `2023.09.26` / `2023` → 2023 (or null). */
function yearOfDate(value) {
  const text = String(value == null ? '' : value).trim();
  const match = /^(\d{4})/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isFinite(year) && year > 1900 && year < 2200 ? year : null;
}

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

function stringList(value) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  return list
    .map((entry) => (typeof entry === 'string' ? entry : entry && entry.name))
    .filter(Boolean)
    .map(String);
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

  const appidToWork = new Map();
  const slugToWork = new Map();
  const titleToWork = new Map();
  const ambiguousTitles = new Set();
  const byWorkKey = new Map();

  for (const work of steamWorks) {
    const name =
      (work.primary && work.primary.name) ||
      (Array.isArray(work.games) && work.games[0] && work.games[0].name) ||
      null;
    if (name) {
      const normalized = normalizeTitle(name);
      if (normalized) {
        if (titleToWork.has(normalized) && titleToWork.get(normalized) !== work.workKey) {
          ambiguousTitles.add(normalized);
        } else {
          titleToWork.set(normalized, work.workKey);
        }
      }
    }
    for (const game of Array.isArray(work.games) ? work.games : []) {
      const appid = String(game.appid);
      appidToWork.set(appid, work.workKey);
      for (const slug of slugsOfLink(linkMap[appid])) {
        if (!slugToWork.has(slug)) slugToWork.set(slug, work.workKey);
      }
    }
    byWorkKey.set(work.workKey, {
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
      genres: [],
      developers: [],
      publishers: [],
      metadataSources: ['steam-store'],
    });
  }
  for (const title of ambiguousTitles) titleToWork.delete(title);

  /* ------------------------------ bridge ------------------------------ */
  const resolveBridged = (prefix, slug) => {
    const key = normalizeSlug(slug);
    if (!key) return null;
    const hit = bridge[`${prefix}:${key}`] || bridge[`${prefix}:${slug}`] || null;
    const appid = hit && hit.appid != null ? String(hit.appid) : null;
    if (!appid) return null;
    return appidToWork.get(appid) || null;
  };

  const ensureEntry = (workKey, fallbackName) => {
    let entry = byWorkKey.get(workKey);
    if (entry) return entry;
    entry = {
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
      genres: [],
      developers: [],
      publishers: [],
      metadataSources: [],
    };
    byWorkKey.set(workKey, entry);
    return entry;
  };

  const matched = { wikidata: 0, title: 0, none: 0 };
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
    if (!workKey && slug && bridge[`gog:${slug}`]) matchedBy = 'wikidata';
    if (!workKey) {
      const titleKey = normalizeTitle(product.title);
      workKey = titleKey ? titleToWork.get(titleKey) || null : null;
      if (workKey) matchedBy = 'title';
    }
    if (!workKey) {
      workKey = `gog:${gogGameId}`;
      matchedBy = 'none';
    }
    matched[matchedBy] = (matched[matchedBy] || 0) + 1;

    const entry = ensureEntry(workKey, product.title || null);
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
    if (entry.releaseYear == null) entry.releaseYear = yearOfDate(product.releaseDate);
    if (!entry.genres.length) entry.genres = genreNames(product.genres);
    if (!entry.developers.length) entry.developers = stringList(product.developers);
    if (!entry.publishers.length) entry.publishers = stringList(product.publishers);
    if (!entry.metadataSources.includes('gog-catalog')) entry.metadataSources.push('gog-catalog');
  }

  /* ------------------------------- Epic ------------------------------ */
  let epicMinutes = 0;
  let epicOwned = 0;
  for (const game of epicGames) {
    if (!game || !game.name) continue;
    epicOwned++;
    const epicId = String(game.catalogItemId || game.appName || '');
    const epicValue = minutesOrNull(game.totalMinutes);
    if (epicValue != null) epicMinutes += epicValue;
    let workKey = resolveBridged('epic', game.slug);
    let matchedBy = workKey ? 'wikidata' : null;
    if (!workKey) {
      const titleKey = normalizeTitle(game.name);
      workKey = titleKey ? titleToWork.get(titleKey) || null : null;
      if (workKey) matchedBy = 'title';
    }
    if (!workKey) {
      workKey = `epic:${epicId}`;
      matchedBy = 'none';
    }
    matched[matchedBy] = (matched[matchedBy] || 0) + 1;
    const entry = ensureEntry(workKey, game.name);
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
      image: null,
      title: game.name || null,
      releaseDate: game.releaseDate || null,
      developer: game.developer || null,
      publisher: game.publisher || null,
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
    if (entry.releaseYear == null) entry.releaseYear = yearOfDate(game.releaseDate);
    if (!entry.genres.length) entry.genres = genreNames(game.genres);
    if (!entry.developers.length && game.developer) entry.developers = [String(game.developer)];
    if (!entry.publishers.length && game.publisher) entry.publishers = [String(game.publisher)];
    if (!entry.metadataSources.includes('epic-catalog')) entry.metadataSources.push('epic-catalog');
  }

  /* --------------------------- derived hours -------------------------- */
  const worksList = [...byWorkKey.values()];
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

  const secondaryOnly = worksList
    .filter((entry) => entry.secondaryOnly)
    .sort(
      (left, right) =>
        (right.displayMinutes || 0) - (left.displayMinutes || 0) ||
        String(left.name || '').localeCompare(String(right.name || ''))
    );

  const steamWorkCount = steamWorks.length;
  const secondaryOnlyCount = secondaryOnly.length;
  const gogHours = Math.round((gogMinutes / 60) * 10) / 10;
  const epicHours = Math.round((epicMinutes / 60) * 10) / 10;

  return {
    works: worksList,
    byWorkKey,
    byAppid,
    secondaryOnly,
    // Kept for the existing GOG block/summary consumers.
    secondaryWorks: secondaryOnly,
    summary: {
      steamWorks: steamWorkCount,
      gogProducts,
      gogMinutes,
      gogHours,
      epicGames: epicOwned,
      epicMinutes,
      epicHours,
      // Union over canonical works: Steam works + works that exist only
      // outside Steam (a GOG/Epic game merged into a Steam work adds no row).
      worksTotal: worksList.length,
      secondaryOnlyWorks: secondaryOnlyCount,
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
  yearOfDate,
  genreNames,
  flattenGogSnapshots,
  buildSecondaryUnion,
};
