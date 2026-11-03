'use strict';

/**
 * One normalized shape for the store metadata of a **secondary-only** work.
 *
 * A GOG/Epic game that has no Steam twin has no `details/<appid>.json`, so the
 * genre wall / year chart / decade chart had nothing to draw for it and the
 * «Вне Steam» card had no vertical poster. This module is the pure part of
 * that pipeline: it turns a public GOG v2 product page or an Epic CMS product
 * page into the same document
 *
 *   { source, id, title, slug, genres[], tags[], releaseDate, releaseYear,
 *     releaseDateSource, verticalCover, image, logo, developers[], publishers[],
 *     series, platforms[], fetchedAt }
 *
 * and answers the catalog-completion questions about such a document (which
 * field is still missing, can a cached catalog item fill it, how to merge it).
 *
 * Nothing here touches the network, the filesystem or the clock beyond
 * `fetchedAt` — that is why the fixtures are enough to test it.
 *
 * Contract of the two sources (verified live 01.11.2026):
 *
 *   - **GOG** `api.gog.com/v2/games/{id}` (the endpoint the GOG web store uses;
 *     `api.gog.com/products/{id}` has no genre/tag fields and
 *     `catalog.gog.com/v1/catalog` cannot be filtered by product id). It
 *     carries `_embedded.tags[]` (genre line), `globalReleaseDate` (the
 *     **original** release) next to `gogReleaseDate` (the store listing date),
 *     `_links.boxArtImage` (vertical 171×241) and the developers/publishers.
 *   - **Epic** `store-content.ak.epicgames.com/api/en-US/content/products/
 *     {slug}` (public CMS page). The base page is `type === 'productHome'`;
 *     `data.meta` has `releaseDate`/`tags`/`developer`/`publisher`, and
 *     `data.hero.portraitBackgroundImageUrl` is the vertical 1200×1600 poster.
 *     `addon`/`offer` pages are skipped: their date belongs to a DLC or an
 *     edition, not to the base game.
 *
 * A stale CMS page can carry a poster but no `meta.releaseDate`/`meta.tags`
 * (Alan Wake 2). The Epic catalog bulk is then the only store-owned source;
 * `normalizeEpicProduct({ catalog })` merges its date/categories, and
 * `applyCatalogToDetail()` does the same for an already cached document.
 * Nothing is ever invented: an empty answer leaves the field empty.
 */

const { SecondaryDetailsError } = require('./errors');

const SCHEMA_VERSION = 1;

function nowMs() {
  return Date.now();
}

function isoOf(ms) {
  return new Date(ms).toISOString();
}

/* ------------------------------------------------------------------ */
/* normalization                                                       */
/* ------------------------------------------------------------------ */

/** `2023-09-26` / `2023.09.26` / `2023` → 2023 (or null). */
function yearOfDate(value) {
  const match = /^(\d{4})/.exec(String(value == null ? '' : value).trim());
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isFinite(year) && year > 1900 && year < 2200 ? year : null;
}

/** `//images.gog-statics.com/x.jpg` → `https://images.gog-statics.com/x.jpg`. */
function absoluteUrl(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  if (text.startsWith('//')) return `https:${text}`;
  if (/^https?:\/\//i.test(text)) return text;
  return null;
}

function uniqueStrings(list) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const value = typeof entry === 'string' ? entry.trim() : entry && entry.name ? String(entry.name).trim() : '';
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * Epic tags are upper-snake codes (`RPG`, `OPEN_WORLD`). The store page shows
 * human names, so the common ones are mapped; an unknown code is prettified
 * (`TURN_BASED` → `Turn Based`) instead of being dropped.
 */
const EPIC_TAG_NAMES = {
  RPG: 'Role-Playing',
  ACTION: 'Action',
  ADVENTURE: 'Adventure',
  OPEN_WORLD: 'Open World',
  STRATEGY: 'Strategy',
  SIMULATION: 'Simulation',
  INDIE: 'Indie',
  CASUAL: 'Casual',
  PUZZLE: 'Puzzle',
  HORROR: 'Horror',
  SUPERNATURAL: 'Supernatural',
  FIGHTING: 'Fighting',
  RACING: 'Racing',
  SPORTS: 'Sports',
  SURVIVAL: 'Survival',
  SHOOTER: 'Shooter',
  PLATFORMER: 'Platformer',
  STEALTH: 'Stealth',
  TACTICAL: 'Tactical',
  EXPLORATION: 'Exploration',
  MUSIC: 'Music',
  EDUCATIONAL: 'Educational',
  CARD_GAME: 'Card Game',
  MOBA: 'MOBA',
  CITY_BUILDER: 'City Builder',
  TOWER_DEFENSE: 'Tower Defense',
  PARTY: 'Party',
  MYSTERY: 'Mystery',
  CRIME: 'Crime',
  DETECTIVE: 'Detective',
  SCI_FI: 'Sci-Fi',
  FANTASY: 'Fantasy',
  MEDIEVAL: 'Medieval',
  WORLD_WAR_II: 'World War II',
  ZOMBIES: 'Zombies',
  SPACE: 'Space',
  COMEDY: 'Comedy',
  DRAMA: 'Drama',
  NONLINEAR: 'Nonlinear',
  ROGUELIKE: 'Roguelike',
  TURN_BASED: 'Turn-Based',
  REAL_TIME: 'Real Time',
  ATMOSPHERIC: 'Atmospheric',
  STORY_RICH: 'Story Rich',
  GREAT_SOUNDTRACK: 'Great Soundtrack',
  DIFFICULT: 'Difficult',
  RELAXING: 'Relaxing',
  COLORFUL: 'Colorful',
  CUTE: 'Cute',
  DARK: 'Dark',
  FUNNY: 'Funny',
  VIOLENT: 'Violent',
  NUDITY: 'Nudity',
  SEXUAL_CONTENT: 'Sexual Content',
  BLOOD: 'Blood',
  GORE: 'Gore',
};

/**
 * Tags that are store **features**, not genres. They stay in `tags` (the raw
 * list) but never reach `genres` — otherwise the genre wall would grow a
 * «Single Player» bar next to «Action».
 */
const EPIC_FEATURE_TAGS = new Set([
  'SINGLE_PLAYER',
  'MULTIPLAYER',
  'CO_OP',
  'ONLINE_COOP',
  'LOCAL_COOP',
  'LOCAL_MULTIPLAYER',
  'ONLINE_MULTIPLAYER',
  'PVP',
  'CROSS_PLATFORM',
  'CROSSPLAY',
  'CONTROLLER_SUPPORT',
  'CLOUD_SAVES',
  'FREE_TO_PLAY',
  'EARLY_ACCESS',
  'VR',
  'ACHIEVEMENTS',
  'LEADERBOARDS',
  'MOD_SUPPORT',
  'MOUSE_KEYBOARD_SUPPORT',
  'TOUCH_SUPPORT',
]);

function epicTagName(code) {
  const raw = String(code == null ? '' : code).trim();
  if (!raw) return null;
  const key = raw.toUpperCase().replace(/[\s-]+/g, '_');
  if (EPIC_TAG_NAMES[key]) return EPIC_TAG_NAMES[key];
  // Prettify an unknown code: `SOME_NEW_TAG` → `Some New Tag`.
  return key
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function epicTagCodeOf(value) {
  return String(value == null ? '' : value).trim().toUpperCase().replace(/[\s-]+/g, '_');
}

/* ------------------------------- GOG ------------------------------- */

function slugFromStoreLink(href) {
  const text = String(href == null ? '' : href);
  const match = /\/game\/([^/?#]+)/.exec(text);
  return match ? match[1] : null;
}

/**
 * `api.gog.com/v2/games/{id}` → the common shape. A response without
 * `_embedded.product` is not a product page (an error envelope, a redirect
 * body) and is treated as unparsable, never as an empty game.
 */
function normalizeGogProduct(payload, options = {}) {
  const doc = payload && typeof payload === 'object' ? payload : null;
  const embedded = (doc && doc._embedded) || null;
  const product = embedded && embedded.product ? embedded.product : null;
  if (!product || product.id == null) {
    throw new SecondaryDetailsError(
      'GOG v2: ответ без _embedded.product.',
      'secondary_details_unparsed'
    );
  }
  const links = (doc && doc._links) || {};
  const hrefOf = (key) => (links[key] && links[key].href ? absoluteUrl(links[key].href) : null);
  const id = String(product.id || options.id || '');
  const globalDate = product.globalReleaseDate || null;
  const storeDate = product.gogReleaseDate || null;
  const releaseDate = globalDate || storeDate || null;
  const genres = uniqueStrings((embedded.tags || []).map((tag) => tag && tag.name));
  const tags = uniqueStrings((embedded.properties || []).map((tag) => tag && tag.name));
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'gog',
    id,
    title: product.title || options.title || null,
    slug: slugFromStoreLink(links.store && links.store.href) || options.slug || null,
    category: product.category || null,
    genres,
    tags,
    releaseDate,
    releaseYear: yearOfDate(releaseDate),
    releaseDateSource: globalDate ? 'gog-global' : storeDate ? 'gog-store' : null,
    globalReleaseDate: globalDate,
    storeReleaseDate: storeDate,
    verticalCover: hrefOf('boxArtImage'),
    image: hrefOf('backgroundImage') || hrefOf('galaxyBackgroundImage'),
    logo: hrefOf('logo'),
    developers: uniqueStrings((embedded.developers || []).map((entry) => entry && entry.name)),
    publishers: uniqueStrings((embedded.publishers || []).map((entry) => entry && entry.name)),
    series: embedded.series && embedded.series.name ? String(embedded.series.name) : null,
    platforms: uniqueStrings(
      (embedded.supportedOperatingSystems || []).map(
        (entry) => entry && entry.operatingSystem && entry.operatingSystem.name
      )
    ),
    fetchedAt: isoOf(nowMs()),
  };
}

/* ------------------------------- Epic ------------------------------ */

/**
 * The base-game page of the Epic CMS. `productHome` first (its release date is
 * the game's own), then an `offer` page that has a date, then the first page
 * with `data.meta.releaseDate`. `addon` pages are never chosen while a base
 * page exists.
 */
function pickEpicPage(payload) {
  const pages = Array.isArray(payload && payload.pages) ? payload.pages : [];
  const withMeta = pages.filter(
    (page) => page && page.data && page.data.meta && page.data.meta.releaseDate
  );
  const home = withMeta.find((page) => page.type === 'productHome');
  if (home) return home;
  const offer = withMeta.find((page) => page.type === 'offer');
  if (offer) return offer;
  if (withMeta.length) return withMeta[0];
  return pages.find((page) => page && page.type === 'productHome') || pages[0] || null;
}

/** Tallest image from the page's `_images_` list (1200×1600 / 860×1148). */
function epicPortraitFromImages(images) {
  const list = Array.isArray(images) ? images : [];
  const tall = list.find((url) => /-(?:1200x1600|860x1148|1080x1440)-/i.test(String(url)));
  return tall ? absoluteUrl(tall) : null;
}

function epicLandscapeFromImages(images) {
  const list = Array.isArray(images) ? images : [];
  const wide = list.find((url) => /-(?:2560x1440|1920x1080|1600x900)-/i.test(String(url)));
  return wide ? absoluteUrl(wide) : null;
}

/**
 * Epic's catalog `categories` are product buckets (`games`, `freegames`, …) and
 * sometimes a genre segment (`games/action`, `games/horror`). Only the genre
 * segment is used, and only when the CMS page has no `meta.tags` at all — the
 * case of a **stale CMS page** (Alan Wake 2: `meta` has only
 * `customReleaseDate: "Coming Soon"`, no tags/releaseDate/developer).
 */
const EPIC_NON_GENRE_CATEGORIES = new Set([
  // Product buckets, not genres. Epic's bulk catalog returns them in the same
  // `categories` array as the genre segments, and a bucket such as `public`
  // used to become the genre «Public» (Alan Wake 2, 02.11.2026). Comparison is
  // case-insensitive through `epicTagCodeOf()` below.
  'PUBLIC',
  'GAMES',
  'GAME',
  'APPLICATIONS',
  'APPLICATION',
  'APP',
  'SOFTWARE',
  'CONTENT',
  'FREEGAMES',
  'ADDONS',
  'DLC',
  'EDITIONS',
  'EXPANSIONS',
  'EXPANSION',
  'SEASON_PASS',
  'PACK',
  'PLUGINS',
  'ASSETS',
  'PROJECTS',
  'SANDBOX',
  'AUDIENCE',
  'ENGINE',
  'MODS',
  'BUNDLES',
  'DEMOS',
  'TOOLS',
  'TOOL',
  'TEMPLATES',
  'THEMES',
  'MAPS',
]);

function epicGenresFromCategories(categories) {
  const out = [];
  for (const entry of Array.isArray(categories) ? categories : []) {
    const path =
      typeof entry === 'string'
        ? entry
        : entry && (entry.path || entry.name)
          ? entry.path || entry.name
          : null;
    if (!path) continue;
    const segments = String(path).split('/').filter(Boolean);
    if (!segments.length) continue;
    const code = epicTagCodeOf(segments[segments.length - 1]);
    if (!code || EPIC_NON_GENRE_CATEGORIES.has(code)) continue;
    const name = EPIC_TAG_NAMES[code] || epicTagName(code);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The same bucket filter applied to an already-normalized genre line. A detail
 * document written **before** a bucket entered `EPIC_NON_GENRE_CATEGORIES`
 * keeps it on disk for its 30-day TTL (`Alan Wake 2`, `genres: ["Public"]`).
 * Every read path passes the list through this helper, so the stale chip
 * disappears immediately without editing a cache file by hand.
 */
function sanitizeEpicGenres(genres) {
  const out = [];
  for (const name of uniqueStrings(Array.isArray(genres) ? genres : [])) {
    const code = epicTagCodeOf(name);
    if (code && EPIC_NON_GENRE_CATEGORIES.has(code)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Read-time sanitizer for a cached detail document. Pure: the same object is
 * returned when nothing was filtered, so a heal/write decision (`next !== data`)
 * still works. Only Epic documents are filtered — a GOG genre line never
 * contained store buckets.
 */
function sanitizeDetailGenres(data) {
  if (!data || data.source !== 'epic' || !Array.isArray(data.genres)) return data;
  const genres = sanitizeEpicGenres(data.genres);
  const unchanged =
    genres.length === data.genres.length &&
    genres.every((name, index) => name === data.genres[index]);
  if (unchanged) return data;
  const next = { ...data, genres };
  if (!genres.length) next.genresSource = null;
  return next;
}

function normalizeEpicProduct(payload, options = {}) {
  const page = pickEpicPage(payload);
  if (!page) {
    throw new SecondaryDetailsError(
      'Epic CMS: ответ без pages[].',
      'secondary_details_unparsed'
    );
  }
  const data = page.data || {};
  const meta = data.meta || {};
  const about = data.about && typeof data.about === 'object' ? data.about : {};
  const hero = data.hero || {};
  const catalog =
    options.catalog && typeof options.catalog === 'object' ? options.catalog : null;
  const tagsRaw = uniqueStrings(Array.isArray(meta.tags) ? meta.tags : []);
  const tags = tagsRaw.map(epicTagName).filter(Boolean);
  let genres = tagsRaw
    .filter((code) => !EPIC_FEATURE_TAGS.has(epicTagCodeOf(code)))
    .map(epicTagName)
    .filter(Boolean);
  let genresSource = genres.length ? 'epic-store' : null;
  // Stale CMS page: no tag line at all → the catalog's own category buckets are
  // the only store-owned genre hint left. Never invented from the title.
  if (!genres.length && catalog) {
    const fromCatalog = epicGenresFromCategories(catalog.categories);
    if (fromCatalog.length) {
      genres = fromCatalog;
      genresSource = 'epic-catalog';
    }
  }
  const releaseDate = meta.releaseDate || (catalog && catalog.releaseDate) || null;
  const releaseDateSource = meta.releaseDate
    ? 'epic-store'
    : catalog && catalog.releaseDate
      ? 'epic-catalog'
      : null;
  const slug = options.slug || (payload && payload._slug) || null;
  const title =
    (page.productName && String(page.productName).trim()) ||
    (payload && payload.productName) ||
    about.title ||
    (catalog && catalog.title) ||
    null;
  // `about.*Attribution` is present on pages whose `meta.developer` is empty
  // (Alan Wake 2: Remedy Entertainment / Epic Games Publishing).
  const developers = uniqueStrings(Array.isArray(meta.developer) ? meta.developer : []);
  const publishers = uniqueStrings(Array.isArray(meta.publisher) ? meta.publisher : []);
  if (!developers.length && about.developerAttribution) {
    developers.push(String(about.developerAttribution));
  }
  if (!publishers.length && about.publisherAttribution) {
    publishers.push(String(about.publisherAttribution));
  }
  if (!developers.length && catalog && catalog.developer) {
    developers.push(String(catalog.developer));
  }
  if (!publishers.length && catalog && catalog.publisher) {
    publishers.push(String(catalog.publisher));
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'epic',
    id: String(slug || ''),
    title,
    slug,
    genres: sanitizeEpicGenres(genres),
    genresSource,
    tags: uniqueStrings(tags),
    releaseDate,
    releaseYear: yearOfDate(releaseDate),
    releaseDateSource,
    globalReleaseDate: null,
    storeReleaseDate: releaseDate,
    verticalCover:
      absoluteUrl(hero.portraitBackgroundImageUrl) || epicPortraitFromImages(payload._images_),
    image: absoluteUrl(hero.backgroundImageUrl) || epicLandscapeFromImages(payload._images_),
    logo: absoluteUrl(hero.logoImage && hero.logoImage.src),
    developers: uniqueStrings(developers),
    publishers: uniqueStrings(publishers),
    series: null,
    platforms: uniqueStrings(Array.isArray(meta.platform) ? meta.platform : []),
    fetchedAt: isoOf(nowMs()),
  };
}

/* ------------------------------------------------------------------ */
/* catalog completion (which field is missing, what can fill it)       */
/* ------------------------------------------------------------------ */

/** Does the CMS page carry the fields the catalog could complete? */
function epicPageNeedsCatalog(payload) {
  const page = pickEpicPage(payload);
  const meta = (page && page.data && page.data.meta) || {};
  const hasTags = Array.isArray(meta.tags) && meta.tags.length > 0;
  return !meta.releaseDate && !hasTags;
}

/**
 * A cached detail that is not **complete** is a candidate for the catalog
 * step: neither genres nor a year (the original Alan Wake 2 case), or only one
 * of the two (partial). `shouldAttemptCatalog` still keeps a settled partial
 * from being re-asked on every poll — the attempt ledger/`catalogChecked`
 * marker decides whether another request is due.
 */
function detailNeedsCatalog(data) {
  if (!data || data.source !== 'epic') return false;
  return catalogMetaFlags(data).metaStatus !== 'complete';
}

/**
 * A detail written **before** the catalog fallback existed has neither genres
 * nor a year and no `catalogChecked` marker. It is retried once; every outcome
 * (filled, definitive negative, not connected) writes the marker, so a polled
 * `/stats` cannot kick the same work forever.
 */
function needsCatalogCompletion(data) {
  if (!detailNeedsCatalog(data)) return false;
  if (data.catalogChecked === true) return false;
  if (data.catalogPending === true) return false;
  return true;
}

function catalogHasMeta(catalog) {
  if (!catalog || typeof catalog !== 'object') return false;
  return Boolean(catalog.releaseDate) ||
    (Array.isArray(catalog.categories) && catalog.categories.length > 0);
}

/**
 * Can this cached catalog document actually supply the fact the detail is
 * missing? (fix 02.11.2026 — the silent skip that kept AW2 «partial» forever)
 *
 * `epic-import.js` writes `catalog/<id>.json` from the same bulk endpoint the
 * details phase uses, but **without** a per-owner attempt in the ledger. The
 * document can carry a release date and only bucket categories («games»), so
 * `catalogHasMeta` was true while the detail still had no genre. The phase then
 * returned the cached document before `getCatalogBulk` forever: the kick ran,
 * the job finished in a second, `catalogAttempts.total` stayed 0 and nothing
 * was recorded as an error.
 *
 * A cached document is a reason to skip the request only when it fills every
 * missing axis. `detail == null` (a CMS page with no meta at all) means *both*
 * axes are missing, so a date-only document is not enough either.
 */
function catalogAnswersMissing(detail, catalog) {
  if (!catalogHasMeta(catalog)) return false;
  const flags = catalogMetaFlags(detail);
  if (!flags.yearHas && !catalog.releaseDate) return false;
  if (!flags.genresOk && epicGenresFromCategories(catalog.categories).length === 0) return false;
  return true;
}

/**
 * Merge a catalog document into an already cached detail (the cached document
 * has no raw CMS payload to re-normalize). Additive only: a field that is
 * already set is never replaced, and an empty catalog never produces a fake
 * genre or date.
 */
function applyCatalogToDetail(data, catalog) {
  if (!data || !catalog) return data;
  const next = { ...data };
  if (!(Array.isArray(next.genres) && next.genres.length)) {
    const genres = epicGenresFromCategories(catalog.categories);
    if (genres.length) {
      next.genres = genres;
      next.genresSource = 'epic-catalog';
    }
  }
  if (next.releaseDate == null && catalog.releaseDate) {
    next.releaseDate = catalog.releaseDate;
    next.releaseYear = yearOfDate(catalog.releaseDate);
    next.releaseDateSource = 'epic-catalog';
    next.storeReleaseDate = catalog.releaseDate;
  }
  if (!(Array.isArray(next.developers) && next.developers.length) && catalog.developer) {
    next.developers = [String(catalog.developer)];
  }
  if (!(Array.isArray(next.publishers) && next.publishers.length) && catalog.publisher) {
    next.publishers = [String(catalog.publisher)];
  }
  return next;
}

/** `{ yearHas, genresOk, metaStatus }` for a normalized detail document. */
function catalogMetaFlags(data) {
  const yearHas = Boolean(data && data.releaseYear != null);
  const genresOk = Boolean(data && Array.isArray(data.genres) && data.genres.length);
  return {
    yearHas,
    genresOk,
    metaStatus: yearHas && genresOk ? 'complete' : yearHas || genresOk ? 'partial' : 'unavailable',
  };
}

/* ------------------------------------------------------------------ */
/* title helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * `"Alan Wake 2"` → `"alan-wake-2"`. ASCII-only on purpose: a title that cannot
 * be represented is not guessed (the CMS slug is English in practice).
 */
function slugFromTitle(title) {
  return String(title == null ? '' : title)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function comparableTitle(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

module.exports = {
  SCHEMA_VERSION,
  nowMs,
  isoOf,
  yearOfDate,
  absoluteUrl,
  uniqueStrings,
  epicTagName,
  epicTagCodeOf,
  EPIC_TAG_NAMES,
  EPIC_FEATURE_TAGS,
  EPIC_NON_GENRE_CATEGORIES,
  epicGenresFromCategories,
  sanitizeEpicGenres,
  sanitizeDetailGenres,
  slugFromStoreLink,
  normalizeGogProduct,
  pickEpicPage,
  epicPortraitFromImages,
  epicLandscapeFromImages,
  normalizeEpicProduct,
  epicPageNeedsCatalog,
  detailNeedsCatalog,
  needsCatalogCompletion,
  catalogHasMeta,
  catalogAnswersMissing,
  applyCatalogToDetail,
  catalogMetaFlags,
  slugFromTitle,
  comparableTitle,
};
