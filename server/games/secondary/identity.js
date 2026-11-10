'use strict';

/* ------------------------------------------------------------------ */
/* titles, slugs, edition markers (was `gog-union.js`)                 */
/* ------------------------------------------------------------------ */

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

/**
 * Wikidata labels often spell a numbered sequel with a Roman numeral («Alan
 * Wake II»), while the store says «Alan Wake 2». Exact string matching would
 * miss the canonical Alan Wake 2 case, so a title gets a small, deterministic
 * set of variants (Arabic ↔ Roman, up to 20). No fuzzy matching: every value
 * still goes into a `VALUES` literal and must match a `rdfs:label`/`skos:altLabel`
 * exactly.
 */
const ROMAN_NUMERALS = [
  ['XX', 20], ['XIX', 19], ['XVIII', 18], ['XVII', 17], ['XVI', 16],
  ['XV', 15], ['XIV', 14], ['XIII', 13], ['XII', 12], ['XI', 11],
  ['X', 10], ['IX', 9], ['VIII', 8], ['VII', 7], ['VI', 6],
  ['V', 5], ['IV', 4], ['III', 3], ['II', 2], ['I', 1],
];
const ARABIC_TO_ROMAN = new Map(ROMAN_NUMERALS.map(([roman, number]) => [number, roman]));
const ROMAN_TO_ARABIC = new Map(ROMAN_NUMERALS.map(([roman, number]) => [roman, number]));

function titleVariants(title) {
  const text = String(title == null ? '' : title).trim();
  if (!text) return [];
  const out = [text];
  // Trailing Arabic number → Roman numeral: "Alan Wake 2" → "Alan Wake II".
  const arabic = /^(.*?\D)(\d{1,2})$/.exec(text);
  if (arabic) {
    const roman = ARABIC_TO_ROMAN.get(Number(arabic[2]));
    if (roman) out.push(`${arabic[1]}${roman}`);
  }
  // Trailing Roman numeral → Arabic: "Alan Wake II" → "Alan Wake 2".
  const roman = /^(.*?\D)([IVX]+)$/.exec(text);
  if (roman) {
    const number = ROMAN_TO_ARABIC.get(roman[2]);
    if (number) out.push(`${roman[1]}${number}`);
  }
  return [...new Set(out)];
}

/**
 * Raw slugs, de-duplicated by their normalised form: `the-witcher-3-wild-hunt`
 * (Epic) and `the_witcher_3_wild_hunt` (GOG) are the same key but different
 * literals, and Wikidata stores each store's own spelling.
 */
function uniqueSlugs(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) continue;
    const key = normalizeSlug(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

/** Slugs of the GOG products / Epic games that still need an identity. */
function collectSlugs({ gogProducts = [], epicGames = [] } = {}) {
  const gogSlugs = uniqueSlugs(gogProducts.map((product) => product && product.slug));
  const epicSlugs = uniqueSlugs(epicGames.map((game) => game && game.slug));
  return { gogSlugs, epicSlugs };
}

module.exports = {
  EDITION_SUFFIXES,
  normalizeTitle,
  normalizeSlug,
  slugsOfLink,
  buildGogUnion,
  titleVariants,
  uniqueSlugs,
  collectSlugs,
};
