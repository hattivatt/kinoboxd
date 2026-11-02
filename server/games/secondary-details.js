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
 *      **Production hardening (02.11.2026).** The production server reaches the
 *      CMS from a different IP than the dev box; a Cloudflare edge can answer
 *      `403` there while the same page is `200` elsewhere. The request now
 *      carries a browser `User-Agent` (a `kinoboxd/1.0` bot string is the first
 *      thing an edge challenge looks at), and a failed primary host is retried
 *      once against the IPv4 mirror `store-content-ipv4.ak.epicgames.com`.
 *      A `403`/`429` from either host trips the 30-minute breaker with
 *      `code: 'cms_blocked'` — the status endpoint reports that reason, so a
 *      blocked edge is never mistaken for «the game has no metadata». The first
 *      three failed CMS answers are dumped (status + ≤2 KB body, tokens masked)
 *      to `cache-games/debug/epic/<slug>.json` for the owner to send back.
 *
 * Politeness (§14.5): one request per product, pause `GAMES_SECONDARY_PAUSE_MS`
 * (default **2 s**, GOG's undocumented ~200 req/h/IP limit is the reference),
 * budget `GAMES_SECONDARY_BUDGET` (default **200** requests/run, GOG first then
 * Epic), 30-minute breaker on `403`/`429`. A network/5xx answer is **deferred**
 * (nothing is cached, the previous detail stays), a `404` is a negative cache
 * entry (`not_found`, 30 days) — the same «unknown ≠ empty» rule as everywhere
 * else in the games tab. A **guessed** slug (title probe) that 404s is cached
 * with `probe: true` for `GAMES_SECONDARY_PROBE_TTL_MS` (7 days) so a «library
 * only» work is not probed on every kick.
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
// Cloudflare fronts the store CMS; the IPv4-only name is the same origin and
// is the documented workaround for an edge that rejects a network's IPv6 path.
const EPIC_CONTENT_MIRROR_HOST = 'store-content-ipv4.ak.epicgames.com';
const EPIC_HOSTS = [EPIC_CONTENT_HOST, EPIC_CONTENT_MIRROR_HOST];
// A browser UA: the CMS (and its CDN) answers a bot string with a challenge on
// some edges. The value is a plain desktop Chrome string, no cookies, no token.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CACHE_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'secondary-details');
const STATE_DIR = gameCache.STATE_DIR;
const BREAKER_PATH = path.join(STATE_DIR, 'secondary-details-breaker.json');
const STATUS_PATH = path.join(STATE_DIR, 'secondary-details-status.json');
// Failed CMS answers kept for the owner to send back (diagnostics only).
const DEBUG_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'debug', 'epic');

const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 30 * DAY_MS;
const DEFAULT_NOT_FOUND_TTL_MS = 30 * DAY_MS;
const DEFAULT_PROBE_TTL_MS = 7 * DAY_MS;
const DEFAULT_BUDGET = 200;
const DEFAULT_PAUSE_MS = 2000;
const DEFAULT_EPIC_PAUSE_MS = 1500;
const DEFAULT_BREAKER_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_KICK_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_DEBUG_FILES = 3;
const DEBUG_BODY_LIMIT = 2048;
const MAX_STATUS_ERRORS = 5;
const MAX_KICK_HISTORY = 10;
const MAX_SLUGLESS = 50;

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
    // Diagnostics for the CMS debug dump (never a token; masked on write).
    if (details.url != null) this.url = details.url;
    if (details.body != null) this.body = details.body;
    if (details.contentType != null) this.contentType = details.contentType;
    if (details.bodyBytes != null) this.bodyBytes = details.bodyBytes;
    if (details.reason != null) this.reason = details.reason;
    if (details.breakerCode != null) this.breakerCode = details.breakerCode;
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

/** Shorter TTL for a *guessed* slug that 404s (the guess may become valid). */
function probeTtlMs() {
  return envMs('GAMES_SECONDARY_PROBE_TTL_MS', DEFAULT_PROBE_TTL_MS);
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

function epicUrl(slug, host = EPIC_CONTENT_HOST) {
  return `https://${host}/api/en-US/content/products/${encodeURIComponent(String(slug))}`;
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

/**
 * Epic's catalog `categories` are product buckets (`games`, `freegames`, …) and
 * sometimes a genre segment (`games/action`, `games/horror`). Only the genre
 * segment is used, and only when the CMS page has no `meta.tags` at all — the
 * case of a **stale CMS page** (Alan Wake 2: `meta` has only
 * `customReleaseDate: "Coming Soon"`, no tags/releaseDate/developer).
 */
const EPIC_NON_GENRE_CATEGORIES = new Set([
  'GAMES',
  'APPLICATIONS',
  'FREEGAMES',
  'ADDONS',
  'DLC',
  'EDITIONS',
  'PLUGINS',
  'ASSETS',
  'PROJECTS',
  'SANDBOX',
  'AUDIENCE',
  'ENGINE',
  'MODS',
  'BUNDLES',
  'DEMOS',
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
    genres: uniqueStrings(genres),
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
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function httpGetJson(target, options = {}) {
  const timeout = options.timeoutMs || timeoutMs();
  const userAgent = options.userAgent || 'kinoboxd/1.0 (+games-tab; secondary-details)';
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
            'User-Agent': userAgent,
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
  let ttl = ttlMs();
  if (doc.status === 'not_found') {
    // A guessed slug is not a verdict about the product: shorter memory.
    ttl = doc.probe === true ? probeTtlMs() : notFoundTtlMs();
  }
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
      entry.genresSource =
        detail.genresSource || (detail.source === 'epic' ? 'epic-store' : 'gog-store');
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
/* status state (diagnostics the owner can paste back)                 */
/* ------------------------------------------------------------------ */

/**
 * A small persisted ledger behind `GET /api/games/secondary-details/status`:
 * the last 5 failures (so a `cms_blocked` survives a restart) and the last 10
 * kicks. Never a token, never a response body — only codes, hosts, dates.
 */
function readStatusState() {
  const hit = gameCache.readJsonWithFingerprint(STATUS_PATH);
  const doc = (hit && hit.data) || {};
  return {
    schemaVersion: SCHEMA_VERSION,
    lastErrors: Array.isArray(doc.lastErrors) ? doc.lastErrors.slice(-MAX_STATUS_ERRORS) : [],
    kicks: Array.isArray(doc.kicks) ? doc.kicks.slice(-MAX_KICK_HISTORY) : [],
    lastRunAt: doc.lastRunAt || null,
  };
}

function writeStatusState(state) {
  try {
    gameCache.writeJsonAtomicSync(STATUS_PATH, { schemaVersion: SCHEMA_VERSION, ...state });
  } catch (err) {
    /* diagnostics must never break the job */
  }
}

function recordError(entry) {
  try {
    const state = readStatusState();
    state.lastErrors.push({ at: isoOf(nowMs()), ...entry });
    state.lastErrors = state.lastErrors.slice(-MAX_STATUS_ERRORS);
    writeStatusState(state);
  } catch (err) {
    /* ignore */
  }
}

function recordKick(entry) {
  try {
    const state = readStatusState();
    state.kicks.push({ at: isoOf(nowMs()), ...entry });
    state.kicks = state.kicks.slice(-MAX_KICK_HISTORY);
    writeStatusState(state);
  } catch (err) {
    /* ignore */
  }
}

function recordRunFinished(job) {
  try {
    const state = readStatusState();
    state.lastRunAt = job.finishedAt || isoOf(nowMs());
    writeStatusState(state);
  } catch (err) {
    /* ignore */
  }
}

/** Latest kick of one owner, memory first, then the persisted ledger. */
function lastKickAtFor(ownerKey) {
  const key = String(ownerKey == null ? '' : ownerKey);
  const memory = lastKick.get(key);
  if (memory) return memory;
  const state = readStatusState();
  let latest = 0;
  for (const kick of state.kicks) {
    if (!kick || kick.ownerKey !== key) continue;
    if (kick.result === 'skipped') continue;
    const at = Date.parse(kick.at || '');
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  if (latest) lastKick.set(key, latest);
  return latest || null;
}

/* ------------------------------------------------------------------ */
/* resolver                                                            */
/* ------------------------------------------------------------------ */

/**
 * One product → normalized detail. The injected `client` (tests) may expose
 * `getJson(url)`; otherwise a minimal HTTPS GET is used. `client` is also
 * allowed to be a plain function `(url) => Promise<payload>`.
 *
 * `options.headers`/`options.userAgent` only affect the built-in HTTPS path —
 * an injected client owns its own request shape.
 */
async function fetchJson(client, url, options = {}) {
  if (client && typeof client.getJson === 'function') return client.getJson(url);
  if (typeof client === 'function') return client(url);
  const response = await httpGetJson(url, { userAgent: options.userAgent });
  const meta = {
    url,
    host: (() => {
      try {
        return new URL(url).host;
      } catch (err) {
        return null;
      }
    })(),
    body: response.body,
    contentType: response.headers && response.headers['content-type'],
    bodyBytes: Buffer.byteLength(String(response.body == null ? '' : response.body), 'utf8'),
  };
  if (response.status === 404) {
    throw new SecondaryDetailsError('Продукт не найден.', 'secondary_details_not_found', {
      ...meta,
      status: 404,
      reason: 'not_found',
    });
  }
  if (response.status === 403 || response.status === 429) {
    throw new SecondaryDetailsError(
      `Источник ограничил запросы (${response.status}).`,
      'secondary_details_blocked',
      { ...meta, status: response.status, deferred: true, reason: 'blocked' }
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new SecondaryDetailsError(
      `Источник ответил ${response.status}.`,
      'secondary_details_http_error',
      {
        ...meta,
        status: response.status,
        deferred: response.status >= 500,
        reason: 'http_error',
      }
    );
  }
  try {
    return parseJson(response.body, response.status);
  } catch (err) {
    if (err && typeof err === 'object') {
      Object.assign(err, meta);
      err.reason = err.reason || 'unparsed';
    }
    throw err;
  }
}

/* ------------------------- Epic CMS transport ---------------------- */

/**
 * Keep the first `MAX_DEBUG_FILES` failed CMS answers for the owner to send
 * back. The body is truncated to 2 KB and secrets are masked; the file name is
 * the slug, so a re-run overwrites its own dump instead of growing the folder.
 * Diagnostics must never fail the request.
 */
function dumpEpicFailure(slug, info = {}) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const file = path.join(DEBUG_DIR, `${safeKey(slug)}.json`);
    if (!fs.existsSync(file)) {
      let count = 0;
      for (const name of fs.readdirSync(DEBUG_DIR)) {
        if (name.endsWith('.json')) count++;
      }
      if (count >= MAX_DEBUG_FILES) return null;
    }
    const body = info.body == null ? null : maskSecrets(String(info.body)).slice(0, DEBUG_BODY_LIMIT);
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      source: 'epic',
      slug: String(slug),
      at: isoOf(nowMs()),
      host: info.host || null,
      url: info.url ? maskSecrets(String(info.url)) : null,
      status: info.status == null ? null : Number(info.status),
      reason: info.reason || null,
      contentType: info.contentType || null,
      bodyBytes: info.bodyBytes == null ? null : Number(info.bodyBytes),
      body,
      note: 'Диагностика CMS Epic: только статус и первые 2 KB ответа, секреты замаскированы.',
    };
    gameCache.writeJsonAtomicSync(file, doc);
    return file;
  } catch (err) {
    return null;
  }
}

/**
 * Fetch one Epic CMS product page: primary host first, then the IPv4 mirror
 * when the primary fails for a reason that may be edge-specific (network,
 * `403`, `5xx`, a non-JSON challenge page). A `404` is the product's own
 * verdict and is **not** retried against the mirror; `429` is an account/IP
 * rate limit and is not retried either.
 *
 * Returns `{ payload, host, url }`. Every failed answer is dumped (capped).
 * `onExtraRequest` is called for the mirror attempt so the job budget counts
 * the real request count.
 */
async function fetchEpicProduct(slug, options = {}) {
  const hosts = Array.isArray(options.hosts) && options.hosts.length
    ? options.hosts
    : EPIC_HOSTS;
  const urlOf = typeof options.urlOf === 'function' ? options.urlOf : epicUrl;
  let lastError = null;
  for (let index = 0; index < hosts.length; index++) {
    const host = hosts[index];
    const url = urlOf(slug, host);
    if (index > 0 && typeof options.onExtraRequest === 'function') {
      try {
        options.onExtraRequest();
      } catch (err) {
        /* a counting hook must never break the fetch */
      }
    }
    try {
      const payload = await fetchJson(options.client, url, { userAgent: BROWSER_UA });
      return { payload, host, url };
    } catch (err) {
      lastError = err || lastError;
      const code = (err && err.code) || 'secondary_details_error';
      dumpEpicFailure(slug, {
        host,
        url,
        status: err && err.status,
        reason: (err && err.reason) || code,
        body: err && err.body,
        contentType: err && err.contentType,
        bodyBytes: err && err.bodyBytes,
      });
      if (code === 'secondary_details_not_found') throw err;
      if (err && err.status === 429) throw err;
    }
  }
  throw lastError || new SecondaryDetailsError('CMS Epic недоступна.', 'secondary_details_unreachable');
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

/**
 * Last-resort slug discovery for an Epic exclusive that is in neither
 * `productmapping` (~1 283 records) nor the catalog's `productSlug`/`urlSlug`:
 * the store slug of a game is almost always its title in kebab-case, and the
 * public CMS answers `200`/`404` without a token. The guess is **validated** —
 * the page's own `productName` must equal the library title, so a wrong slug
 * can never attach another game's poster/genres.
 */
async function discoverEpicSlug(options = {}) {
  const title = options.title ? String(options.title).trim() : '';
  const guess = slugFromTitle(title);
  if (!guess || guess.length < 3) return null;
  if (comparableTitle(title).length < 3) return null;
  // A previous probe of this guess 404'd. It is a short-lived memory (7 days),
  // not a verdict: the same guess is retried later, and an explicit slug from
  // the catalog always bypasses it.
  if (!options.force) {
    const known = readDetail('epic', guess);
    if (
      known.fresh &&
      known.doc &&
      known.doc.status === 'not_found' &&
      known.doc.probe === true
    ) {
      return null;
    }
  }
  let fetched;
  try {
    if (typeof options.onRequest === 'function') options.onRequest();
    fetched = await fetchEpicProduct(guess, {
      client: options.client,
      onExtraRequest: options.onRequest,
      hosts: options.hosts,
      urlOf: options.urlOf,
    });
  } catch (err) {
    if (err && err.code === 'secondary_details_not_found') {
      // The guess is not a verdict about the product: remember it briefly so
      // the next kick does not probe again, and stay «library-only».
      writeDetail('epic', guess, 'not_found', null, { probe: true, title: title || null });
      return null;
    }
    if (err && (err.status === 403 || err.status === 429)) {
      tripBreaker('epic', 'cms_blocked', err.status);
      // The reason travels with the error: the job warning and the status
      // ledger must say «blocked by the CMS», not «no metadata».
      err.breakerCode = 'cms_blocked';
    }
    throw err;
  }
  const payload = fetched.payload;
  const name =
    (payload && (payload.productName || payload._title)) ||
    (payload && payload.pages && payload.pages[0] && payload.pages[0].productName) ||
    null;
  if (!name || comparableTitle(name) !== comparableTitle(title)) return null;
  // The validated page is the product page itself — no second request.
  return { slug: guess, payload, host: fetched.host || null };
}

async function resolveEpic(slug, options = {}) {
  let id = String(slug == null ? '' : slug).trim();
  let probedPayload = null;
  let probedHost = null;
  const title = options.title ? String(options.title).trim() : '';
  const canProbe =
    Boolean(title) &&
    comparableTitle(title).length >= 3 &&
    (options.probeBudget == null || options.probeBudget >= 2);
  if (!id) {
    // Two requests are needed (probe + product page): only try when the job
    // still has that much budget left. Without a title there is nothing to
    // guess — the caller reports the work as `library-only`.
    if (!canProbe) {
      return { data: null, status: 'not_found', cached: false, reason: 'no_slug' };
    }
    const discovered = await discoverEpicSlug(options);
    if (!discovered) {
      return { data: null, status: 'not_found', cached: false, reason: 'no_slug' };
    }
    id = discovered.slug;
    probedPayload = discovered.payload;
    probedHost = discovered.host;
  }
  const { doc, fresh } = readDetail('epic', id);
  // A probe negative cache (`probe: true`) is a memory about a *guess*, not a
  // verdict about this id — an explicitly addressed product is re-fetched.
  const probeOnlyNegative = Boolean(
    doc && doc.status === 'not_found' && doc.probe === true
  );
  if (fresh && doc && !options.force && !(probeOnlyNegative && !probedPayload)) {
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
      {
        deferred: true,
        retryAt: blocked.until,
        reason: blocked.code || 'blocked',
        breakerCode: blocked.code || 'blocked',
      }
    );
  }
  let payload = probedPayload;
  let host = probedHost;
  if (!payload) {
    try {
      const fetched = await fetchEpicProduct(id, {
        client: options.client,
        onExtraRequest: options.onRequest,
        hosts: options.hosts,
        urlOf: options.urlOf,
      });
      payload = fetched.payload;
      host = fetched.host || null;
    } catch (err) {
      let recovered = null;
      // A catalog/productmapping slug can be stale (the catalog knows the base
      // game, the owned SKU has a different slug). A validated title probe is
      // the only way to tell «removed product» from «wrong slug»; it runs once
      // and must match the library title.
      if (err && err.code === 'secondary_details_not_found' && canProbe) {
        const guess = slugFromTitle(title);
        if (guess && guess !== id) {
          recovered = await discoverEpicSlug(options);
        }
      }
      if (!recovered) {
        if (err && err.code === 'secondary_details_not_found') {
          writeDetail('epic', id, 'not_found', null);
          return { data: null, status: 'not_found', cached: false };
        }
        if (err && (err.status === 403 || err.status === 429)) {
          tripBreaker('epic', 'cms_blocked', err.status);
          err.breakerCode = 'cms_blocked';
        }
        throw err;
      }
      id = recovered.slug;
      payload = recovered.payload;
      host = recovered.host || null;
    }
  }
  const data = normalizeEpicProduct(payload, {
    slug: id,
    title: options.title,
    catalog: options.catalog,
  });
  writeDetail('epic', id, 'ok', data);
  // Persist a discovered slug so the read model (`epic-layer.joinGames`) can
  // key the union entry `epic:<slug>` and attach this detail next request.
  if (options.catalogItemId && data.slug) {
    try {
      require('./epic-cache').saveEpicSlugOverride(options.catalogItemId, data.slug, {
        title: data.title || options.title || null,
        source: 'cms-title-probe',
      });
    } catch (err) {
      /* a read-only cache must not fail the fetch */
    }
  }
  return { data, status: 'ok', cached: false, host: host || null };
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
  return {
    total: 0,
    resolved: 0,
    fetched: 0,
    notFound: 0,
    cached: 0,
    failed: 0,
    deferred: 0,
    // Works with no store slug at all: «library-only» (title + hours), never a
    // silent drop and never a fake `not_found`.
    missingSlug: 0,
  };
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
      const result = await resolveOne(target, {
        client: job.client,
        force: job.force,
        // A no-slug target needs a probe + a product page; both count.
        probeBudget: job.budget - job.requests + 1,
        onRequest: () => {
          job.requests++;
        },
      });
      if (result.status === 'ok') {
        phase.resolved++;
        phase.fetched++;
      } else if (result.status === 'not_found') {
        // `no_slug` is not a verdict about the product (it was never
        // addressed): it is already counted in `phase.missingSlug`.
        if (result.reason !== 'no_slug') {
          phase.notFound++;
          phase.fetched++;
        }
      }
    } catch (err) {
      const code = (err && err.code) || 'secondary_details_error';
      // `cms_blocked` is the reason an edge refused the CMS — it must not be
      // reported as «no metadata» (ИГРЫ §14.5).
      const reason = (err && (err.breakerCode || err.reason)) || code;
      recordError({
        ownerKey: job.ownerKey,
        source,
        id: String(target.id || target.slug || ''),
        code,
        reason,
        status: err && err.status != null ? err.status : null,
        host: err && err.host ? err.host : null,
        message: maskSecrets((err && err.message) || '').slice(0, 200),
      });
      if (err && err.deferred) {
        phase.deferred++;
        job.warnings.push(`${source}_${reason}`);
        // A blocked/unreachable host is not a per-product failure: stop this
        // phase instead of hammering it for every remaining product.
        if (code === 'secondary_details_blocked') break;
      } else {
        phase.failed++;
        job.warnings.push(`${source}_${reason}`);
      }
    }
    if (job.requests < job.budget) await sleep(job.pauseMs);
  }
  if (source === 'epic' && phase.missingSlug > 0) {
    // Honest diagnostic: these works stay «library-only» (title + hours) —
    // not a `not_found` verdict about a product we never addressed.
    job.warnings.push('epic_no_slug');
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
  job.epic.total = epic.filter((entry) => entry && (entry.slug || entry.title)).length;
  job.epic.missingSlug = epic.filter((entry) => entry && !entry.slug).length;
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
          .filter((entry) => entry && (entry.slug || entry.title))
          .map((entry) => ({
            id: String(entry.slug || entry.id || `catalog:${entry.catalogItemId || ''}`),
            slug: entry.slug || null,
            title: entry.title || null,
            catalogItemId: entry.catalogItemId || null,
            catalog: entry.catalog || null,
          })),
        (target, opts) =>
          resolveEpic(target.slug, {
            ...opts,
            title: target.title,
            catalog: target.catalog,
            catalogItemId: target.catalogItemId,
          })
      );
      job.status = job.budgetExceeded ? 'partial' : 'done';
    } catch (err) {
      job.status = 'failed';
      job.warnings.push((err && err.code) || 'secondary_details_error');
    } finally {
      job.finishedAt = isoOf(nowMs());
      job.stage = 'done';
      recordRunFinished(job);
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
  const last = lastKickAtFor(key);
  const cooldown =
    options.kickCooldownMs != null ? Number(options.kickCooldownMs) : kickCooldownMs();
  if (last && nowMs() - last < cooldown) return 'cooldown';
  return null;
}

/**
 * Fire-and-forget kick after a GOG/Epic import (the `kickFranchiseQuietly`
 * pattern): a failure is a job warning, the import stays `done`. `forceKick`
 * is set for an explicit user import so the cooldown does not swallow it.
 *
 * `trigger` is recorded in the kick ledger (`import`, `refresh`, `stats`) —
 * the status endpoint shows it, so «the fix did nothing on prod» can be told
 * apart from «nobody asked».
 */
function kickSecondaryDetailsQuietly(ownerKey, options = {}) {
  const key = String(ownerKey == null ? '' : ownerKey);
  const trigger = options.trigger || 'import';
  const gate = kickGate(key, options);
  if (gate) {
    if (trigger !== 'stats') {
      recordKick({ ownerKey: key, result: 'skipped', skipped: gate, trigger });
    }
    return { skipped: gate, ownerKey: ownerKey || null };
  }
  try {
    const job = startSecondaryDetails({ ...options, ownerKey });
    recordKick({
      ownerKey: key,
      result: job.reused ? 'reused' : 'started',
      jobId: job.id || null,
      trigger,
      budget: job.budget == null ? null : job.budget,
    });
    console.log(
      `[games-secondary-details] kicked ${job.id} ` +
        `(gog=${job.gog.total}, epic=${job.epic.total}, budget=${job.budget}, trigger=${trigger})`
    );
    return job;
  } catch (err) {
    const message = maskSecrets((err && err.message) || 'secondary details failed');
    console.warn(`[games-secondary-details] kick failed (caller kept): ${message}`);
    recordKick({ ownerKey: key, result: 'failed', trigger, code: (err && err.code) || 'kick_failed' });
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
  if (!key) return { gog, epic, epicNoSlug: 0 };
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
  let epicNoSlug = 0;
  const epicAccount = epicCache.epicAccountForOwner(key);
  if (epicAccount) {
    const library = epicCache.getEpicLibrary(epicAccount);
    const games = (library && library.games) || [];
    // The library snapshot's own `slug` is only the productmapping fallback
    // (~1 283 appNames). The catalog bulk (`productSlug`/`urlSlug`) and a
    // previously discovered slug override cover Epic exclusives such as
    // Alan Wake 2, which `productmapping` does not list at all.
    const catalog = epicCache.listEpicCatalogItems(
      games.map((game) => game && game.catalogItemId).filter(Boolean)
    );
    for (const game of games) {
      if (!game) continue;
      const meta = (game.catalogItemId && catalog[game.catalogItemId]) || null;
      const slug =
        (meta && meta.slug) ||
        game.slug ||
        (game.catalogItemId ? epicCache.getEpicSlugOverride(game.catalogItemId) : null) ||
        null;
      const title = (meta && meta.title) || game.name || game.appName || null;
      if (!slug) epicNoSlug++;
      epic.push({
        slug: slug || null,
        id: String(game.catalogItemId || game.appName || slug || ''),
        catalogItemId: game.catalogItemId || null,
        appName: game.appName || null,
        title,
        catalog: meta,
      });
    }
  }
  return { gog, epic, epicNoSlug };
}

/* ------------------------------------------------------------------ */
/* coverage / status / lazy kick                                       */
/* ------------------------------------------------------------------ */

/**
 * How many of the owner's secondary products already have a detail document.
 * `total` includes **slugless** Epic works: the title probe is the only way to
 * address them, and «resolved < total» must stay true until one of them is
 * either resolved or explicitly given up (a probe negative is not resolved,
 * but it stops the retry loop through the probe TTL).
 */
function coverageForOwner(ownerKey) {
  const targets = targetsForOwner(ownerKey);
  const phase = (source, list, idOf) => {
    let resolved = 0;
    let notFound = 0;
    for (const target of list) {
      const id = idOf(target);
      if (!id) {
        // A slugless Epic work is addressable only by its title guess. A fresh
        // probe negative means «attempted, nothing found» — not pending.
        if (source === 'epic' && target.title) {
          const guess = slugFromTitle(target.title);
          const hit = guess ? readDetail('epic', guess) : null;
          if (
            hit &&
            hit.fresh &&
            hit.doc &&
            hit.doc.status === 'not_found' &&
            hit.doc.probe === true
          ) {
            notFound++;
          }
        }
        continue;
      }
      const { doc, fresh } = readDetail(source, id);
      if (!fresh || !doc) continue;
      if (doc.status === 'ok') resolved++;
      else if (doc.status === 'not_found') notFound++;
    }
    return {
      total: list.length,
      resolved,
      notFound,
      missingSlug: 0,
      pending: Math.max(0, list.length - resolved - notFound),
    };
  };
  const gog = phase('gog', targets.gog, (target) => target.id);
  const epic = phase('epic', targets.epic, (target) => target.slug);
  epic.missingSlug = targets.epicNoSlug;
  const slugless = targets.epic
    .filter((target) => !target.slug)
    .slice(0, MAX_SLUGLESS)
    .map((target) => ({
      name: target.title || null,
      catalogItemId: target.catalogItemId || null,
      appName: target.appName || null,
    }));
  return {
    gog,
    epic,
    slugless,
    resolved: gog.resolved + epic.resolved,
    total: gog.total + epic.total,
    pending: gog.pending + epic.pending,
  };
}

/**
 * The owner-facing diagnostic (`GET /api/games/secondary-details/status`).
 * Contract: `{ resolved, total, running, bySource, slugless[], lastErrors[],
 * cooldownUntil, kick, lastRunAt }`. Everything here is a cache/state read —
 * the endpoint never makes a network request.
 */
function statusForOwner(ownerKey) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  const coverage = coverageForOwner(key);
  const state = readStatusState();
  const lastKick = lastKickAtFor(key);
  const kicks = state.kicks
    .filter((kick) => kick && kick.ownerKey === key)
    .slice(-MAX_KICK_HISTORY);
  const last = kicks.length ? kicks[kicks.length - 1] : null;
  const gogBreaker = breakerBlock('gog');
  const epicBreaker = breakerBlock('epic');
  const cooldownUntil = lastKick ? isoOf(lastKick + kickCooldownMs()) : null;
  const kickCooldownActive = Boolean(
    lastKick && nowMs() - lastKick < kickCooldownMs()
  );
  return {
    profile: key || null,
    resolved: coverage.resolved,
    total: coverage.total,
    pending: Math.max(0, coverage.total - coverage.resolved),
    running: runningFor(key),
    bySource: {
      gog: { ...coverage.gog },
      epic: { ...coverage.epic },
    },
    slugless: coverage.slugless,
    lastErrors: state.lastErrors
      .filter((entry) => entry && entry.ownerKey === key)
      .slice(-MAX_STATUS_ERRORS),
    // `null` when a kick is allowed right now (cooldown is advisory, the
    // breaker is the hard stop and is reported separately).
    cooldownUntil: kickCooldownActive ? cooldownUntil : null,
    cooldownActive: kickCooldownActive,
    breakers: {
      gog: gogBreaker ? { until: gogBreaker.until, code: gogBreaker.code } : null,
      epic: epicBreaker ? { until: epicBreaker.until, code: epicBreaker.code } : null,
    },
    kick: {
      lastKickAt: lastKick ? isoOf(lastKick) : null,
      lastJobId: last ? last.jobId || null : null,
      lastResult: last ? last.result || null : null,
      lastSkipped: last && last.result === 'skipped' ? last.skipped || null : null,
      lastTrigger: last ? last.trigger || null : null,
      history: kicks,
    },
    lastRunAt: state.lastRunAt || null,
    checkedAt: isoOf(nowMs()),
  };
}

/** `true` when at least one addressable work has no successful detail yet. */
function coverageNeedsKick(meta) {
  if (!meta || typeof meta !== 'object') return false;
  const total = Number(meta.total) || 0;
  const resolved = Number(meta.resolved) || 0;
  const noSlug = Number(meta.noSlug) || 0;
  return (total > 0 && resolved < total) || noSlug > 0;
}

/**
 * Lazy kick from `GET /api/games/stats` (the missing piece after the 66c3d21
 * deploy: an Epic library imported *before* the deploy never fired a kick, and
 * nothing re-kicked it). Fire-and-forget, coalesced by `kickGate`, disabled
 * with `GAMES_SECONDARY_LAZY_KICK=0`.
 */
function kickFromStats(ownerKey, meta, options = {}) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  if (!key) return { skipped: 'no_owner' };
  if (String(process.env.GAMES_SECONDARY_LAZY_KICK || '').trim() === '0') {
    return { skipped: 'disabled' };
  }
  if (!coverageNeedsKick(meta)) return { skipped: 'covered' };
  // Refine with the cache: a product whose slug 404'd (or whose title probe
  // already failed) is *attempted*, not pending. Without this a no-op job would
  // start every cooldown window for a work that cannot be resolved.
  const coverage = coverageForOwner(key);
  if (coverage.pending <= 0) return { skipped: 'attempted' };
  const gate = kickGate(key, options);
  if (gate) return { skipped: gate };
  return kickSecondaryDetailsQuietly(key, {
    trigger: 'stats',
    client: options.client,
    ...targetsForOwner(key),
  });
}

/** Test helper: forget job/cooldown state between cases. */
function resetJobs() {
  jobs.clear();
  lastKick.clear();
  try {
    fs.rmSync(STATUS_PATH, { force: true });
  } catch (err) {
    /* nothing to clean */
  }
}

module.exports = {
  SecondaryDetailsError,
  GOG_API_HOST,
  EPIC_CONTENT_HOST,
  EPIC_CONTENT_MIRROR_HOST,
  EPIC_HOSTS,
  BROWSER_UA,
  CACHE_DIR,
  DEBUG_DIR,
  STATE_DIR,
  BREAKER_PATH,
  STATUS_PATH,
  DEFAULT_BUDGET,
  DEFAULT_PAUSE_MS,
  DEFAULT_BREAKER_MS,
  DEFAULT_PROBE_TTL_MS,
  MAX_DEBUG_FILES,
  EPIC_FEATURE_TAGS,
  yearOfDate,
  absoluteUrl,
  normalizeGogProduct,
  normalizeEpicProduct,
  pickEpicPage,
  epicTagName,
  epicGenresFromCategories,
  slugFromTitle,
  discoverEpicSlug,
  gogUrl,
  epicUrl,
  fetchEpicProduct,
  dumpEpicFailure,
  readDetail,
  getDetail,
  writeDetail,
  readDetailsIndex,
  enrichUnionWithDetails,
  readBreaker,
  writeBreaker,
  breakerBlock,
  tripBreaker,
  readStatusState,
  writeStatusState,
  resolveGog,
  resolveEpic,
  startSecondaryDetails,
  kickSecondaryDetailsQuietly,
  kickGate,
  kickFromStats,
  coverageNeedsKick,
  coverageForOwner,
  statusForOwner,
  runningFor,
  jobFor,
  targetsForOwner,
  resetJobs,
};
