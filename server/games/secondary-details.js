'use strict';

/**
 * Store metadata for **secondary-only** works (M6d, ИГРЫ §14).
 *
 * A GOG/Epic game that has no Steam twin has no `details/<appid>.json`, so the
 * genre wall / year chart / decade chart had nothing to draw for it and the
 * «Вне Steam» card had no vertical poster. This module fetches the *public*
 * store metadata of those games and normalizes it into one shape:
 *
 *   { source, id, title, slug, genres[], tags[], releaseDate, releaseYear,
 *     releaseDateSource, verticalCover, image, logo, developers[], publishers[],
 *     series, platforms[], fetchedAt }
 *
 * Sources (both public, **no user token**, verified live 01.11.2026):
 *
 *   1. **GOG** — `api.gog.com/v2/games/{id}` (the endpoint the GOG web store
 *      itself uses). `api.gog.com/products/{id}` has **no** genre/tag fields at
 *      all, and `catalog.gog.com/v1/catalog` cannot be filtered by product id
 *      (its `ids=`/`productIds=` parameters are ignored) — so v2 is the only
 *      one-call source. It carries:
 *        - `_embedded.tags[]` — the store's genre line (`Role-playing`,
 *          `Action`, `Fantasy`; `level` 1..3);
 *        - `_embedded.product.globalReleaseDate` — the **original** release and
 *          `gogReleaseDate` — the date the game landed on GOG (for The Witcher 1
 *          that is 2007-10-26 vs 2011-05-09; for Baldur's Gate 3 the store date
 *          is the 2020 Early Access date, the global one is 2023-08-03);
 *        - `_links.boxArtImage` — **vertical** box art (`171×241`), while
 *          `backgroundImage` is the horizontal hero;
 *        - `_embedded.developers[]`/`publishers[]`/`series`.
 *   2. **Epic** — `store-content.ak.epicgames.com/api/en-US/content/products/
 *      {slug}` (public CMS page, `200` from this network). The base page is the
 *      one with `type === 'productHome'`; its `data.meta` has `releaseDate`,
 *      `tags` (`RPG`, `ACTION`, …) and `developer`/`publisher`, and
 *      `data.hero.portraitBackgroundImageUrl` is the **vertical** 1200×1600
 *      poster (`backgroundImageUrl` is the 2560×1440 horizontal one). The
 *      `addon`/`offer` pages are skipped: their release date belongs to a DLC or
 *      an edition, not to the base game.
 *
 * Politeness (§14.5): one request per product, pause `GAMES_SECONDARY_PAUSE_MS`
 * (default **2 s**, GOG's undocumented ~200 req/h/IP limit is the reference),
 * budget `GAMES_SECONDARY_BUDGET` (default **200** requests/run, GOG first then
 * Epic), 30-minute breaker on `403`/`429`. A network/5xx answer is **deferred**
 * (nothing is cached, the previous detail stays), a `404` is a negative cache
 * entry (`not_found`, 30 days) — the same «unknown ≠ empty» rule as everywhere
 * else in the games tab.
 *
 * Cache: `cache-games/secondary-details/<source>-<id>.json`, TTL 30 days,
 * resumable by construction (each product is its own file, so an interrupted
 * run continues where it stopped).
 *
 * Secrets: none. These endpoints are public and the module never reads a token
 * file. `maskSecrets()` is still applied to error text so a stray URL query is
 * not echoed.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const gameCache = require('./game-cache');

const GOG_API_HOST = 'api.gog.com';
const EPIC_CONTENT_HOST = 'store-content.ak.epicgames.com';

const CACHE_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'secondary-details');
const STATE_DIR = gameCache.STATE_DIR;
const BREAKER_PATH = path.join(STATE_DIR, 'secondary-details-breaker.json');

const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 30 * DAY_MS;
const DEFAULT_NOT_FOUND_TTL_MS = 30 * DAY_MS;
const DEFAULT_BUDGET = 200;
const DEFAULT_PAUSE_MS = 2000;
const DEFAULT_EPIC_PAUSE_MS = 1500;
const DEFAULT_BREAKER_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_KICK_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

try {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
} catch (err) {
  /* read-only worktree: reading still works, writing will fail loudly */
}

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */

class SecondaryDetailsError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'SecondaryDetailsError';
    this.code = code || 'secondary_details_error';
    if (details.status != null) this.status = details.status;
    if (details.retryAt != null) this.retryAt = details.retryAt;
    if (details.host != null) this.host = details.host;
    // A deferred answer must never become a negative cache entry.
    this.deferred = details.deferred === true;
  }
}

function maskSecrets(value) {
  return String(value == null ? '' : value).replace(
    /([?&](?:access_token|refresh_token|client_secret|code|token)=)[^&\s"']+/gi,
    '$1***'
  );
}

/* ------------------------------------------------------------------ */
/* env / time helpers                                                  */
/* ------------------------------------------------------------------ */

function envMs(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

function ttlMs() {
  return envMs('GAMES_SECONDARY_TTL_MS', DEFAULT_TTL_MS);
}

function notFoundTtlMs() {
  return envMs('GAMES_SECONDARY_NOT_FOUND_TTL_MS', DEFAULT_NOT_FOUND_TTL_MS);
}

function budgetDefault() {
  return envInt('GAMES_SECONDARY_BUDGET', DEFAULT_BUDGET);
}

function pauseMsFor(source) {
  const fallback = source === 'epic' ? DEFAULT_EPIC_PAUSE_MS : DEFAULT_PAUSE_MS;
  return envMs('GAMES_SECONDARY_PAUSE_MS', fallback);
}

function breakerMs() {
  return envMs('GAMES_SECONDARY_BREAKER_MS', DEFAULT_BREAKER_MS);
}

function timeoutMs() {
  return envMs('GAMES_SECONDARY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
}

function kickCooldownMs() {
  return envMs('GAMES_SECONDARY_KICK_COOLDOWN_MS', DEFAULT_KICK_COOLDOWN_MS);
}

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

function gogUrl(gogGameId) {
  return `https://${GOG_API_HOST}/v2/games/${encodeURIComponent(String(gogGameId))}`;
}

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

function epicUrl(slug) {
  return `https://${EPIC_CONTENT_HOST}/api/en-US/content/products/${encodeURIComponent(
    String(slug)
  )}`;
}

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
  const hero = data.hero || {};
  const tagsRaw = uniqueStrings(Array.isArray(meta.tags) ? meta.tags : []);
  const tags = tagsRaw.map(epicTagName).filter(Boolean);
  const genres = tagsRaw
    .filter((code) => !EPIC_FEATURE_TAGS.has(epicTagCodeOf(code)))
    .map(epicTagName)
    .filter(Boolean);
  const releaseDate = meta.releaseDate || null;
  const slug = options.slug || (payload && payload._slug) || null;
  const title =
    (page.productName && String(page.productName).trim()) ||
    (payload && payload.productName) ||
    (data.about && data.about.title) ||
    null;
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'epic',
    id: String(slug || ''),
    title,
    slug,
    genres: uniqueStrings(genres),
    tags: uniqueStrings(tags),
    releaseDate,
    releaseYear: yearOfDate(releaseDate),
    releaseDateSource: releaseDate ? 'epic-store' : null,
    globalReleaseDate: null,
    storeReleaseDate: releaseDate,
    verticalCover:
      absoluteUrl(hero.portraitBackgroundImageUrl) || epicPortraitFromImages(payload._images_),
    image: absoluteUrl(hero.backgroundImageUrl) || epicLandscapeFromImages(payload._images_),
    logo: absoluteUrl(hero.logoImage && hero.logoImage.src),
    developers: uniqueStrings(Array.isArray(meta.developer) ? meta.developer : []),
    publishers: uniqueStrings(Array.isArray(meta.publisher) ? meta.publisher : []),
    series: null,
    platforms: uniqueStrings(Array.isArray(meta.platform) ? meta.platform : []),
    fetchedAt: isoOf(nowMs()),
  };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function httpGetJson(target, options = {}) {
  const timeout = options.timeoutMs || timeoutMs();
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(target);
    } catch (err) {
      reject(new SecondaryDetailsError('Некорректный URL метадаты.', 'secondary_details_invalid_url'));
      return;
    }
    const lib = parsed.protocol === 'http:' ? http : https;
    let req;
    try {
      req = lib.request(
        parsed,
        {
          method: 'GET',
          headers: {
            'User-Agent': 'kinoboxd/1.0 (+games-tab; secondary-details)',
            Accept: 'application/json, */*',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          timeout,
        },
        (res) => {
          const status = Number(res.statusCode) || 0;
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              req.destroy(new Error('response too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            resolve({
              status,
              headers: res.headers || {},
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          res.on('error', (err) =>
            reject(
              new SecondaryDetailsError(
                `Сеть: ${maskSecrets((err && (err.code || err.message)) || 'error')}`,
                'secondary_details_unreachable',
                { host: parsed.host, deferred: true }
              )
            )
          );
        }
      );
    } catch (err) {
      reject(
        new SecondaryDetailsError(
          `Сеть: ${maskSecrets((err && (err.code || err.message)) || 'error')}`,
          'secondary_details_unreachable',
          { host: parsed.host, deferred: true }
        )
      );
      return;
    }
    req.on('timeout', () =>
      req.destroy(
        new SecondaryDetailsError(
          `Таймаут ${timeout} мс: ${parsed.host}.`,
          'secondary_details_unreachable',
          { host: parsed.host, deferred: true }
        )
      )
    );
    req.on('error', (err) =>
      reject(
        new SecondaryDetailsError(
          `Сеть: ${maskSecrets((err && (err.code || err.message)) || 'error')}`,
          'secondary_details_unreachable',
          { host: parsed.host, deferred: true }
        )
      )
    );
    req.end();
  });
}

function parseJson(body, status) {
  try {
    return JSON.parse(String(body == null ? '' : body));
  } catch (err) {
    throw new SecondaryDetailsError(
      `Ответ ${status} не JSON.`,
      'secondary_details_unparsed',
      { status }
    );
  }
}

/* ------------------------------------------------------------------ */
/* cache                                                               */
/* ------------------------------------------------------------------ */

function safeKey(value) {
  return gameCache.safeKey(value);
}

function cachePath(source, id) {
  return path.join(CACHE_DIR, `${safeKey(source)}-${safeKey(id)}.json`);
}

function isFresh(doc, atMs) {
  const fetchedAt = doc && doc.fetchedAt ? Date.parse(doc.fetchedAt) : NaN;
  if (!Number.isFinite(fetchedAt)) return false;
  const ttl = doc.status === 'not_found' ? notFoundTtlMs() : ttlMs();
  return atMs - fetchedAt < ttl;
}

/**
 * Cached detail document (`{status, data, fetchedAt}`) for one product.
 * `{doc, fresh}` — a stale document is still returned (`doc`), so callers can
 * decide whether to re-fetch or to serve it as a fallback.
 */
function readDetail(source, id, options = {}) {
  if (!source || !id) return { doc: null, fresh: false };
  const hit = gameCache.readJsonWithFingerprint(cachePath(source, id));
  if (!hit || !hit.data) return { doc: null, fresh: false };
  const doc = hit.data;
  return { doc, fresh: isFresh(doc, options.now == null ? nowMs() : options.now) };
}

/** Fresh, successfully resolved detail data (or null). */
function getDetail(source, id) {
  const { doc, fresh } = readDetail(source, id);
  if (!fresh || !doc || doc.status !== 'ok') return null;
  return doc.data || null;
}

function writeDetail(source, id, status, data, extra = {}) {
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    source,
    id: String(id),
    status,
    fetchedAt: isoOf(nowMs()),
    ...extra,
    data: data || null,
  };
  gameCache.writeJsonAtomicSync(cachePath(source, id), doc);
  return doc;
}

/**
 * Sync index for `stats.js`: `{ 'gog:<id>': data, 'epic:<slug>': data }` of
 * fresh, successfully resolved entries only. Stale entries are excluded so a
 * 30-day-old poster cannot silently outlive the refresh window.
 */
function readDetailsIndex({ gogIds = [], epicSlugs = [], now = nowMs() } = {}) {
  const index = {};
  // One directory listing instead of one `stat` per library product: `/stats`
  // is polled and a 340-game library must not do hundreds of failed reads.
  let present = null;
  try {
    present = new Set(fs.readdirSync(CACHE_DIR));
  } catch (err) {
    present = null;
  }
  const has = (source, id) =>
    !present || present.has(`${safeKey(source)}-${safeKey(id)}.json`);
  for (const id of gogIds) {
    if (!id || !has('gog', id)) continue;
    const { doc, fresh } = readDetail('gog', id, { now });
    if (fresh && doc && doc.status === 'ok' && doc.data) index[`gog:${id}`] = doc.data;
  }
  for (const slug of epicSlugs) {
    if (!slug || !has('epic', slug)) continue;
    const { doc, fresh } = readDetail('epic', slug, { now });
    if (fresh && doc && doc.status === 'ok' && doc.data) index[`epic:${slug}`] = doc.data;
  }
  return index;
}

/* ------------------------------------------------------------------ */
/* union enrichment                                                    */
/* ------------------------------------------------------------------ */

function detailKeyForEntry(entry) {
  if (entry && entry.gog && entry.gog.gogGameId) return `gog:${entry.gog.gogGameId}`;
  if (entry && entry.epic && entry.epic.slug) return `epic:${entry.epic.slug}`;
  return null;
}

/**
 * Fill the union entries from the detail cache. **Additive and never
 * destructive**: a Steam-derived value always wins (Steam `details` are read
 * first by `stats.js`), and only an empty field is filled. The one exception is
 * a release year that came from a **store snapshot** (`gog-library` /
 * `epic-library`): those dates are the store listing date, so the product's own
 * `globalReleaseDate` replaces them.
 *
 * Returns the number of entries that received at least one field.
 */
function enrichUnionWithDetails(union, index) {
  if (!union || !Array.isArray(union.works) || !index) return 0;
  let touched = 0;
  for (const entry of union.works) {
    const key = detailKeyForEntry(entry);
    const detail = key ? index[key] : null;
    if (!detail) continue;
    let changed = false;
    // The library snapshot's tag slugs (`gog-library`) are a fallback: the
    // product page's own genre line replaces them. A Steam-derived list (no
    // `genresSource`) is never touched.
    const libraryGenreSource =
      entry.genresSource === 'gog-library' || entry.genresSource === 'epic-library';
    if (
      detail.genres &&
      detail.genres.length &&
      (!(entry.genres && entry.genres.length) || libraryGenreSource)
    ) {
      entry.genres = [...detail.genres];
      entry.genresSource = detail.source === 'epic' ? 'epic-store' : 'gog-store';
      changed = true;
    }
    const libraryYearSource =
      entry.releaseYearSource === 'gog-library' || entry.releaseYearSource === 'epic-library';
    if (
      detail.releaseYear != null &&
      (entry.releaseYear == null || libraryYearSource)
    ) {
      entry.releaseYear = detail.releaseYear;
      entry.releaseYearSource = detail.releaseDateSource || 'store';
      changed = true;
    }
    if (detail.releaseDate && (entry.releaseDate == null || libraryYearSource)) {
      entry.releaseDate = detail.releaseDate;
      changed = true;
    }
    if (detail.verticalCover && !entry.verticalCover) {
      entry.verticalCover = detail.verticalCover;
      changed = true;
    }
    if (detail.image && !entry.image) {
      entry.image = detail.image;
      changed = true;
    }
    if (detail.developers && detail.developers.length && !(entry.developers && entry.developers.length)) {
      entry.developers = [...detail.developers];
      changed = true;
    }
    if (detail.publishers && detail.publishers.length && !(entry.publishers && entry.publishers.length)) {
      entry.publishers = [...detail.publishers];
      changed = true;
    }
    const metadataSource = detail.source === 'epic' ? 'epic-store' : 'gog-store';
    if (!Array.isArray(entry.metadataSources)) entry.metadataSources = [];
    if (!entry.metadataSources.includes(metadataSource)) {
      entry.metadataSources.push(metadataSource);
      changed = true;
    }
    entry.secondaryDetails = {
      source: detail.source,
      id: detail.id,
      releaseDateSource: detail.releaseDateSource || null,
      fetchedAt: detail.fetchedAt || null,
    };
    if (changed) touched++;
  }
  return touched;
}

/* ------------------------------------------------------------------ */
/* breaker                                                             */
/* ------------------------------------------------------------------ */

function readBreaker() {
  const hit = gameCache.readJsonWithFingerprint(BREAKER_PATH);
  return (hit && hit.data) || {};
}

function writeBreaker(state) {
  return gameCache.writeJsonAtomicSync(BREAKER_PATH, state || {});
}

/** `null` when the host may be queried; `{until, code}` when it is blocked. */
function breakerBlock(source, now = nowMs()) {
  const state = readBreaker();
  const entry = state && state[source];
  if (!entry) return null;
  const until = Date.parse(entry.until || '');
  if (!Number.isFinite(until) || until <= now) return null;
  return { until: isoOf(until), code: entry.code || 'blocked' };
}

function tripBreaker(source, code, status) {
  const state = readBreaker();
  state[source] = {
    until: isoOf(nowMs() + breakerMs()),
    at: isoOf(nowMs()),
    code: code || 'blocked',
    status: status == null ? null : status,
  };
  writeBreaker(state);
  return state[source];
}

/* ------------------------------------------------------------------ */
/* resolver                                                            */
/* ------------------------------------------------------------------ */

/**
 * One product → normalized detail. The injected `client` (tests) may expose
 * `getJson(url)`; otherwise a minimal HTTPS GET is used. `client` is also
 * allowed to be a plain function `(url) => Promise<payload>`.
 */
async function fetchJson(client, url) {
  if (client && typeof client.getJson === 'function') return client.getJson(url);
  if (typeof client === 'function') return client(url);
  const response = await httpGetJson(url);
  if (response.status === 404) {
    const err = new SecondaryDetailsError('Продукт не найден.', 'secondary_details_not_found', {
      status: 404,
    });
    throw err;
  }
  if (response.status === 403 || response.status === 429) {
    throw new SecondaryDetailsError(
      `Источник ограничил запросы (${response.status}).`,
      'secondary_details_blocked',
      { status: response.status, deferred: true }
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new SecondaryDetailsError(
      `Источник ответил ${response.status}.`,
      'secondary_details_http_error',
      { status: response.status, deferred: response.status >= 500 }
    );
  }
  return parseJson(response.body, response.status);
}

/**
 * Resolve one GOG product, honouring cache → breaker → network. Returns
 * `{ data, cached, status }`; throws `SecondaryDetailsError` for a deferred
 * answer (nothing cached) and returns `{status:'not_found', data:null}` for a
 * 404 that is now cached.
 */
async function resolveGog(gogGameId, options = {}) {
  const id = String(gogGameId == null ? '' : gogGameId);
  if (!id) throw new SecondaryDetailsError('Нет GOG id.', 'secondary_details_bad_target');
  const { doc, fresh } = readDetail('gog', id);
  if (fresh && doc && !options.force) {
    return {
      data: doc.status === 'ok' ? doc.data : null,
      status: doc.status,
      cached: true,
    };
  }
  const blocked = breakerBlock('gog');
  if (blocked && !options.ignoreBreaker) {
    throw new SecondaryDetailsError(
      `GOG на паузе до ${blocked.until}.`,
      'secondary_details_blocked',
      { deferred: true, retryAt: blocked.until }
    );
  }
  let payload;
  try {
    payload = await fetchJson(options.client, gogUrl(id));
  } catch (err) {
    if (err && err.code === 'secondary_details_not_found') {
      writeDetail('gog', id, 'not_found', null);
      return { data: null, status: 'not_found', cached: false };
    }
    if (err && (err.status === 403 || err.status === 429)) {
      tripBreaker('gog', 'blocked', err.status);
    }
    throw err;
  }
  let data;
  try {
    data = normalizeGogProduct(payload, { id, slug: options.slug, title: options.title });
  } catch (err) {
    // A 200 that does not parse is not a verdict about the product.
    throw err;
  }
  writeDetail('gog', id, 'ok', data);
  return { data, status: 'ok', cached: false };
}

async function resolveEpic(slug, options = {}) {
  const id = String(slug == null ? '' : slug);
  if (!id) throw new SecondaryDetailsError('Нет Epic slug.', 'secondary_details_bad_target');
  const { doc, fresh } = readDetail('epic', id);
  if (fresh && doc && !options.force) {
    return {
      data: doc.status === 'ok' ? doc.data : null,
      status: doc.status,
      cached: true,
    };
  }
  const blocked = breakerBlock('epic');
  if (blocked && !options.ignoreBreaker) {
    throw new SecondaryDetailsError(
      `Epic на паузе до ${blocked.until}.`,
      'secondary_details_blocked',
      { deferred: true, retryAt: blocked.until }
    );
  }
  let payload;
  try {
    payload = await fetchJson(options.client, epicUrl(id));
  } catch (err) {
    if (err && err.code === 'secondary_details_not_found') {
      writeDetail('epic', id, 'not_found', null);
      return { data: null, status: 'not_found', cached: false };
    }
    if (err && (err.status === 403 || err.status === 429)) {
      tripBreaker('epic', 'blocked', err.status);
    }
    throw err;
  }
  const data = normalizeEpicProduct(payload, { slug: id, title: options.title });
  writeDetail('epic', id, 'ok', data);
  return { data, status: 'ok', cached: false };
}

/* ------------------------------------------------------------------ */
/* job                                                                 */
/* ------------------------------------------------------------------ */

const jobs = new Map();
const lastKick = new Map();
let jobSeq = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyPhase() {
  return { total: 0, resolved: 0, fetched: 0, notFound: 0, cached: 0, failed: 0, deferred: 0 };
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    ownerKey: job.ownerKey,
    status: job.status,
    stage: job.stage,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    requests: job.requests,
    budget: job.budget,
    budgetExceeded: job.budgetExceeded,
    gog: { ...job.gog },
    epic: { ...job.epic },
    pending: Math.max(0, job.gog.total + job.epic.total - job.gog.resolved - job.epic.resolved),
    warnings: [...job.warnings],
  };
}

/** Running job for an owner (for `meta.secondaryDetails.running`). */
function runningFor(ownerKey) {
  const job = jobs.get(String(ownerKey == null ? '' : ownerKey));
  return Boolean(job && job.status === 'running');
}

function jobFor(ownerKey) {
  return publicJob(jobs.get(String(ownerKey == null ? '' : ownerKey)));
}

async function runPhase(job, source, targets, resolveOne) {
  const phase = job[source];
  phase.total = targets.length;
  for (const target of targets) {
    if (job.cancelled) break;
    if (job.requests >= job.budget) {
      job.budgetExceeded = true;
      job.warnings.push(`${source}_budget`);
      break;
    }
    const cached = readDetail(source, target.id);
    if (cached.fresh && !job.force) {
      if (cached.doc.status === 'ok') phase.resolved++;
      else phase.notFound++;
      phase.cached++;
      continue;
    }
    try {
      job.requests++;
      const result = await resolveOne(target, { client: job.client, force: job.force });
      if (result.status === 'ok') {
        phase.resolved++;
        phase.fetched++;
      } else if (result.status === 'not_found') {
        phase.notFound++;
        phase.fetched++;
      }
    } catch (err) {
      const code = (err && err.code) || 'secondary_details_error';
      if (err && err.deferred) {
        phase.deferred++;
        job.warnings.push(`${source}_${code}`);
        // A blocked/unreachable host is not a per-product failure: stop this
        // phase instead of hammering it for every remaining product.
        if (code === 'secondary_details_blocked') break;
      } else {
        phase.failed++;
        job.warnings.push(`${source}_${code}`);
      }
    }
    if (job.requests < job.budget) await sleep(job.pauseMs);
  }
  job.stage = source === 'gog' ? 'epic' : 'done';
}

/**
 * Start (or coalesce into) a details job. Returns the public job immediately;
 * the loop runs in the background and never rejects into the caller.
 */
function startSecondaryDetails(options = {}) {
  const ownerKey = String(options.ownerKey == null ? '' : options.ownerKey).trim();
  const gog = Array.isArray(options.gog) ? options.gog : [];
  const epic = Array.isArray(options.epic) ? options.epic : [];
  if (!ownerKey) {
    throw new SecondaryDetailsError('Нужен ownerKey.', 'secondary_details_no_owner');
  }
  const existing = jobs.get(ownerKey);
  if (existing && existing.status === 'running' && !options.force) {
    return { ...publicJob(existing), reused: true };
  }
  const budget =
    options.budget != null && Number.isFinite(Number(options.budget))
      ? Math.max(0, Math.floor(Number(options.budget)))
      : budgetDefault();
  const job = {
    id: `secondary-details-${++jobSeq}`,
    ownerKey,
    status: 'running',
    stage: gog.length ? 'gog' : 'epic',
    startedAt: isoOf(nowMs()),
    finishedAt: null,
    requests: 0,
    budget,
    budgetExceeded: false,
    force: Boolean(options.force),
    client: options.client,
    pauseMs: options.pauseMs != null ? options.pauseMs : pauseMsFor('gog'),
    gog: emptyPhase(),
    epic: emptyPhase(),
    warnings: [],
    cancelled: false,
  };
  // Counters are visible in the immediate response, before the first await.
  job.gog.total = gog.filter((entry) => entry && entry.id).length;
  job.epic.total = epic.filter((entry) => entry && entry.slug).length;
  jobs.set(ownerKey, job);
  lastKick.set(ownerKey, nowMs());

  const run = async () => {
    try {
      await runPhase(
        job,
        'gog',
        gog
          .filter((entry) => entry && entry.id)
          .map((entry) => ({ id: String(entry.id), slug: entry.slug || null, title: entry.title || null })),
        (target, opts) => resolveGog(target.id, { ...opts, slug: target.slug, title: target.title })
      );
      if (job.pauseMs && !job.cancelled && job.requests < job.budget) {
        job.pauseMs = pauseMsFor('epic');
      }
      await runPhase(
        job,
        'epic',
        epic
          .filter((entry) => entry && entry.slug)
          .map((entry) => ({ id: String(entry.slug), slug: entry.slug, title: entry.title || null })),
        (target, opts) => resolveEpic(target.slug, { ...opts, title: target.title })
      );
      job.status = job.budgetExceeded ? 'partial' : 'done';
    } catch (err) {
      job.status = 'failed';
      job.warnings.push((err && err.code) || 'secondary_details_error');
    } finally {
      job.finishedAt = isoOf(nowMs());
      job.stage = 'done';
    }
  };
  Promise.resolve().then(run);
  return publicJob(job);
}

/** Cheap re-kick guard: `null` = go ahead, otherwise the reason. */
function kickGate(ownerKey, options = {}) {
  const key = String(ownerKey == null ? '' : ownerKey);
  if (!key) return 'no_owner';
  const job = jobs.get(key);
  if (job && job.status === 'running') return 'running';
  if (options.forceKick) return null;
  const last = lastKick.get(key);
  const cooldown =
    options.kickCooldownMs != null ? Number(options.kickCooldownMs) : kickCooldownMs();
  if (last && nowMs() - last < cooldown) return 'cooldown';
  return null;
}

/**
 * Fire-and-forget kick after a GOG/Epic import (the `kickFranchiseQuietly`
 * pattern): a failure is a job warning, the import stays `done`. `forceKick`
 * is set for an explicit user import so the cooldown does not swallow it.
 */
function kickSecondaryDetailsQuietly(ownerKey, options = {}) {
  const gate = kickGate(ownerKey, options);
  if (gate) return { skipped: gate, ownerKey: ownerKey || null };
  try {
    const job = startSecondaryDetails({ ...options, ownerKey });
    console.log(
      `[games-secondary-details] kicked ${job.id} ` +
        `(gog=${job.gog.total}, epic=${job.epic.total}, budget=${job.budget})`
    );
    return job;
  } catch (err) {
    const message = maskSecrets((err && err.message) || 'secondary details failed');
    console.warn(`[games-secondary-details] kick failed (caller kept): ${message}`);
    return { skipped: 'kick_failed', code: (err && err.code) || 'kick_failed' };
  }
}

/* ------------------------------------------------------------------ */
/* targets from the cached libraries                                   */
/* ------------------------------------------------------------------ */

function targetsForOwner(ownerKey) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  const gog = [];
  const epic = [];
  if (!key) return { gog, epic };
  const gogCache = require('./gog-cache');
  const epicCache = require('./epic-cache');
  // Both a bound token and a dated snapshot carry the owner: a restored
  // snapshot without a token still deserves metadata (its games are in the
  // union), so libraries are read directly and filtered by `ownerProfile`.
  const seenGog = new Set();
  for (const library of gogCache.listLibraries()) {
    if (!library || library.ownerProfile !== key) continue;
    for (const product of library.products || []) {
      if (!product || !product.gogGameId) continue;
      const id = String(product.gogGameId);
      if (seenGog.has(id)) continue;
      seenGog.add(id);
      gog.push({ id, slug: product.slug || null, title: product.title || null });
    }
  }
  const epicAccount = epicCache.epicAccountForOwner(key);
  if (epicAccount) {
    const library = epicCache.getEpicLibrary(epicAccount);
    for (const game of (library && library.games) || []) {
      if (!game || !game.slug) continue;
      epic.push({
        slug: game.slug,
        id: game.catalogItemId || game.appName || game.slug,
        title: game.name || null,
      });
    }
  }
  return { gog, epic };
}

/** Test helper: forget job/cooldown state between cases. */
function resetJobs() {
  jobs.clear();
  lastKick.clear();
}

module.exports = {
  SecondaryDetailsError,
  GOG_API_HOST,
  EPIC_CONTENT_HOST,
  CACHE_DIR,
  BREAKER_PATH,
  DEFAULT_BUDGET,
  DEFAULT_PAUSE_MS,
  DEFAULT_BREAKER_MS,
  EPIC_FEATURE_TAGS,
  yearOfDate,
  absoluteUrl,
  normalizeGogProduct,
  normalizeEpicProduct,
  pickEpicPage,
  epicTagName,
  gogUrl,
  epicUrl,
  readDetail,
  getDetail,
  writeDetail,
  readDetailsIndex,
  enrichUnionWithDetails,
  readBreaker,
  writeBreaker,
  breakerBlock,
  tripBreaker,
  resolveGog,
  resolveEpic,
  startSecondaryDetails,
  kickSecondaryDetailsQuietly,
  kickGate,
  runningFor,
  jobFor,
  targetsForOwner,
  resetJobs,
};
