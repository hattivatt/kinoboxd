'use strict';

const { SecondaryDetailsError } = require('./errors');

const SCHEMA_VERSION = 1;

function nowMs() {
  return Date.now();
}

function isoOf(ms) {
  return new Date(ms).toISOString();
}

function yearOfDate(value) {
  const match = /^(\d{4})/.exec(String(value == null ? '' : value).trim());
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isFinite(year) && year > 1900 && year < 2200 ? year : null;
}

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

function slugFromStoreLink(href) {
  const text = String(href == null ? '' : href);
  const match = /\/game\/([^/?#]+)/.exec(text);
  return match ? match[1] : null;
}

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

const EPIC_NON_GENRE_CATEGORIES = new Set([
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

function sanitizeEpicGenres(genres) {
  const out = [];
  for (const name of uniqueStrings(Array.isArray(genres) ? genres : [])) {
    const code = epicTagCodeOf(name);
    if (code && EPIC_NON_GENRE_CATEGORIES.has(code)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

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

function epicPageNeedsCatalog(payload) {
  const page = pickEpicPage(payload);
  const meta = (page && page.data && page.data.meta) || {};
  const hasTags = Array.isArray(meta.tags) && meta.tags.length > 0;
  return !meta.releaseDate && !hasTags;
}

function detailNeedsCatalog(data) {
  if (!data || data.source !== 'epic') return false;
  return catalogMetaFlags(data).metaStatus !== 'complete';
}

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

function catalogAnswersMissing(detail, catalog) {
  if (!catalogHasMeta(catalog)) return false;
  const flags = catalogMetaFlags(detail);
  if (!flags.yearHas && !catalog.releaseDate) return false;
  if (!flags.genresOk && epicGenresFromCategories(catalog.categories).length === 0) return false;
  return true;
}

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

function catalogMetaFlags(data) {
  const yearHas = Boolean(data && data.releaseYear != null);
  const genresOk = Boolean(data && Array.isArray(data.genres) && data.genres.length);
  return {
    yearHas,
    genresOk,
    metaStatus: yearHas && genresOk ? 'complete' : yearHas || genresOk ? 'partial' : 'unavailable',
  };
}

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
