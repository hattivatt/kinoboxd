'use strict';

/**
 * Cross-store union for GOG (M6a, model v7).
 *
 * GOG products are merged into the Steam **works** of the same owner by
 * `workKey`; a GOG-only game becomes a secondary work (`ownedOn:['gog']`) and
 * never enters the Steam journal aggregates (top hours, achievements,
 * completion). The union is deliberately pure: it takes the already-built
 * Steam works plus the cached GOG snapshot and returns plain objects, so it is
 * unit-testable without HTTP or the filesystem.
 *
 * Resolution order (§14.3):
 *   1. **Wikidata bridge** — `P2725` is a slug `game/<slug>`; the link
 *      document may carry it as `gogSlugs`/`gogSlug`/`p2725`. Compared after
 *      stripping the `game/` prefix and normalising separators.
 *   2. **Title fallback** — normalised title (diacritics folded, punctuation
 *      removed, common edition suffixes dropped) must match exactly and be
 *      unique among Steam works; confidence `medium`.
 *   3. **Own work** — `gog:<gogGameId>`, confidence `single`.
 *
 * Hours are **never summed across sources**: `hoursBySource.steam` and
 * `hoursBySource.gog` are separate numbers, and a game played in both stores
 * shows both instead of one inflated total (§14.4 п. 2).
 */

const EDITION_SUFFIXES = [
  'game of the year edition',
  'goty edition',
  'definitive edition',
  'ultimate edition',
  'deluxe edition',
  'complete edition',
  'special edition',
  'gold edition',
  'enhanced edition',
  'director s cut',
  'directors cut',
  'edition',
];

/** Fold a title for cross-store comparison (no store-specific noise). */
function normalizeTitle(value) {
  let text = String(value == null ? '' : value)
    .replace(/[™®©]/g, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9а-я]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Drop a trailing edition marker, repeatedly: "… Deluxe Edition" and
  // "… Game of the Year Edition" are the same work as the base game.
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of EDITION_SUFFIXES) {
      if (text.endsWith(` ${suffix}`)) {
        text = text.slice(0, -(suffix.length + 1)).trim();
        changed = true;
      }
    }
  }
  return text;
}

/** `game/the_witcher_3_wild_hunt` → `the_witcher_3_wild_hunt`. */
function normalizeSlug(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/^game\//, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function slugsOfLink(link) {
  if (!link || typeof link !== 'object') return [];
  const raw = [];
  if (Array.isArray(link.gogSlugs)) raw.push(...link.gogSlugs);
  if (typeof link.gogSlug === 'string') raw.push(link.gogSlug);
  if (typeof link.p2725 === 'string') raw.push(link.p2725);
  if (Array.isArray(link.p2725)) raw.push(...link.p2725);
  if (typeof link.wikidataP2725 === 'string') raw.push(link.wikidataP2725);
  if (Array.isArray(link.wikidataP2725)) raw.push(...link.wikidataP2725);
  return raw.map(normalizeSlug).filter(Boolean);
}

function minutesOf(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

/**
 * Build the union.
 *
 * @param {object} input
 * @param {Array}  input.products  GOG products (`gogGameId`, `title`, `slug`, …)
 * @param {object} input.minutes   `{ [gogGameId]: minutes }`
 * @param {Array}  input.works     Steam works (`workKey`, `minutes`, `primary`,
 *                                 `games:[{appid, name, playtime_forever}]`)
 * @param {object} input.links     `{ [appid]: linkDoc }` (may carry P2725)
 * @returns {object} union view (plain, JSON-safe)
 */
function buildGogUnion({ products, minutes, works, links } = {}) {
  const gogProducts = Array.isArray(products) ? products.filter(Boolean) : [];
  const minutesMap = minutes && typeof minutes === 'object' ? minutes : {};
  const steamWorks = Array.isArray(works) ? works.filter(Boolean) : [];
  const linkMap = links && typeof links === 'object' ? links : {};

  const slugToWork = new Map();
  const titleToWork = new Map();
  const ambiguousTitles = new Set();

  for (const work of steamWorks) {
    const name =
      (work.primary && work.primary.name) ||
      (Array.isArray(work.games) && work.games[0] && work.games[0].name) ||
      null;
    if (name) {
      const normalized = normalizeTitle(name);
      if (!normalized) continue;
      if (titleToWork.has(normalized) && titleToWork.get(normalized) !== work.workKey) {
        ambiguousTitles.add(normalized);
      } else {
        titleToWork.set(normalized, work.workKey);
      }
    }
    for (const game of Array.isArray(work.games) ? work.games : []) {
      for (const slug of slugsOfLink(linkMap[String(game.appid)])) {
        if (!slugToWork.has(slug)) slugToWork.set(slug, work.workKey);
      }
    }
  }
  for (const title of ambiguousTitles) titleToWork.delete(title);

  const byWorkKey = new Map();
  for (const work of steamWorks) {
    byWorkKey.set(work.workKey, {
      workKey: work.workKey,
      name:
        (work.primary && work.primary.name) ||
        (Array.isArray(work.games) && work.games[0] && work.games[0].name) ||
        null,
      sources: ['steam'],
      ownedOn: ['steam'],
      storeIds: { steam: work.primary ? work.primary.appid : null, gog: null, epic: null },
      hoursBySource: { steam: minutesOf(work.minutes), gog: null, epic: null },
      primaryAppid: work.primary ? work.primary.appid : null,
      gog: null,
      matchedBy: null,
      confidence: 'single',
    });
  }

  const byAppid = {};
  const secondaryWorks = [];
  const matchedWorkKeys = new Set();
  let matchedBySlug = 0;
  let matchedByTitle = 0;
  let unmatched = 0;
  let gogMinutes = 0;

  for (const product of gogProducts) {
    const gogGameId = String(product.gogGameId || product.gogProductId || '');
    if (!gogGameId) continue;
    const gogMinutesValue = minutesOf(minutesMap[gogGameId]);
    gogMinutes += gogMinutesValue;
    const slug = normalizeSlug(product.slug);
    const titleKey = normalizeTitle(product.title);
    let workKey = slug ? slugToWork.get(slug) : null;
    let matchedBy = workKey ? 'wikidata' : null;
    if (!workKey && titleKey) {
      workKey = titleToWork.get(titleKey) || null;
      if (workKey) matchedBy = 'title';
    }
    if (!workKey) {
      workKey = `gog:${gogGameId}`;
      matchedBy = 'none';
      unmatched++;
    } else {
      matchedWorkKeys.add(workKey);
      if (matchedBy === 'wikidata') matchedBySlug++;
      else matchedByTitle++;
    }

    let entry = byWorkKey.get(workKey);
    if (!entry) {
      entry = {
        workKey,
        name: product.title || null,
        sources: ['gog'],
        ownedOn: ['gog'],
        storeIds: { steam: null, gog: gogGameId, epic: null },
        hoursBySource: { steam: null, gog: 0, epic: null },
        primaryAppid: null,
        gog: null,
        matchedBy: null,
        confidence: 'single',
      };
      byWorkKey.set(workKey, entry);
    }
    if (!entry.sources.includes('gog')) entry.sources.push('gog');
    if (!entry.ownedOn.includes('gog')) entry.ownedOn.push('gog');
    entry.storeIds.gog = gogGameId;
    // GOG editions of one work add up **within** GOG; they never touch Steam.
    entry.hoursBySource.gog = minutesOf(entry.hoursBySource.gog) + gogMinutesValue;
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
    };
    entry.matchedBy = entry.sources.includes('steam') ? matchedBy : 'none';
    entry.confidence = entry.sources.includes('steam') ? (matchedBy === 'wikidata' ? 'high' : 'medium') : 'single';
  }

  // Per-appid view: every Steam edition of a work inherits the GOG link.
  for (const work of steamWorks) {
    const unionEntry = byWorkKey.get(work.workKey);
    if (!unionEntry) continue;
    for (const game of Array.isArray(work.games) ? work.games : []) {
      const appid = String(game.appid);
      if (!appid) continue;
      byAppid[appid] = {
        workKey: work.workKey,
        sources: [...unionEntry.sources],
        ownedOn: [...unionEntry.ownedOn],
        storeIds: {
          steam: game.appid,
          gog: unionEntry.storeIds.gog,
          epic: null,
        },
        hoursBySource: {
          steam: minutesOf(game.playtime_forever),
          gog: unionEntry.storeIds.gog ? minutesOf(unionEntry.hoursBySource.gog) : null,
          epic: null,
        },
        matchedBy: unionEntry.matchedBy,
        confidence: unionEntry.confidence,
      };
    }
  }

  const worksList = [...byWorkKey.values()];
  for (const entry of worksList) {
    if (entry.sources.length === 1 && entry.sources[0] === 'gog') secondaryWorks.push(entry);
  }
  secondaryWorks.sort(
    (left, right) =>
      minutesOf(right.hoursBySource.gog) - minutesOf(left.hoursBySource.gog) ||
      String(left.name || '').localeCompare(String(right.name || ''))
  );

  return {
    works: worksList,
    byAppid,
    secondaryWorks,
    summary: {
      gogProducts: gogProducts.length,
      gogMinutes,
      gogHours: Math.round((gogMinutes / 60) * 10) / 10,
      steamWorks: steamWorks.length,
      worksTotal: worksList.length,
      matchedWorks: matchedWorkKeys.size,
      matchedBySlug,
      matchedByTitle,
      unmatched,
      secondaryOnlyWorks: secondaryWorks.length,
    },
  };
}

module.exports = {
  EDITION_SUFFIXES,
  normalizeTitle,
  normalizeSlug,
  slugsOfLink,
  buildGogUnion,
};
