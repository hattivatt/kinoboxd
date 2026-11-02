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
 *      **Catalog fallback (02.11.2026).** A stale CMS page can carry a poster
 *      but no `meta.releaseDate`/`meta.tags` (Alan Wake 2). The catalog bulk is
 *      then the only store-owned source, and it requires the **owner's** token.
 *      The details job calls `getCatalogBulk` once for that `catalogItemId`
 *      (same per-run budget/pause, same Epic secondary-details breaker), writes
 *      `catalog/<catalogItemId>.json` in the old schema and re-runs the
 *      normalizer, so genres/year/developers appear without a fake value. A
 *      401 triggers one silent token refresh + retry; a still-expired token is
 *      **deferred** (`catalogPending` in the detail, coverage stays pending so
 *      the next kick retries). A definitive empty/invalid answer is a negative
 *      probe (`catalog-probe/`, 30 days), so a polled kick never repeats it. No
 *      token (not connected) keeps the previous library-only behaviour.
 *
 *      **Catalog trace (02.11.2026 fix-round).** Production showed
 *      `resolved 1/1` for Alan Wake 2 while the card still had no year/genres,
 *      and there was no evidence whether the catalog had been asked at all.
 *      Every attempt is now recorded per owner + `catalogItemId` in
 *      `state/catalog-state.json` (result `shape_ok`/`ok`/`empty`/`401`/`403`/
 *      `unavailable`/`budget`, HTTP status, response bytes, `genresOk`,
 *      `yearHas`, at most 5 entries). Any attempt that is not `shape_ok` also
 *      leaves a ≤2 KB diagnostic dump in `cache-games/debug/epic/
 *      catalog-<catalogItemId>.json` (status/namespace/normalized item,
 *      secrets masked, token never written) — including an `empty` bulk answer,
 *      which used to be invisible. `/secondary-details/status` exposes the same
 *      ledger as `catalogAttempts`, and `resolved` counts only documents whose
 *      year **and** genres actually arrived: a settled negative (the store has
 *      no release info at all) is reported as `unavailable` instead of a fake
 *      success. A retry is due when the ledger is missing/unsuccessful, the
 *      negative TTL expired, or the job is forced.
 *
 *      **Partial is kickable (02.11.2026 fix-round).** Alan Wake 2 sat at
 *      `resolved 0/1, partial 1` with an empty `catalogAttempts` ledger and no
 *      kick: `coverageForOwner` counted a partial detail as neither resolved
 *      nor pending, so the lazy kick concluded «attempted» without ever asking
 *      the catalog. The kick rule is now
 *      `resolved < total || partial > 0 || noSlug > 0`, `partial` is part of
 *      `stats.meta.secondaryDetails`, and the coverage snapshot exposes
 *      `partial` / `retryablePartial` (the subset whose catalog answer is still
 *      due). A partial with a settled `shape_ok`/fresh `ok` ledger stays
 *      settled, so a polled `/stats` cannot loop on a store that simply has no
 *      second field.
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
// A stale Epic CMS page can only be completed from the catalog bulk (needs the
// owner's token). A catalog answer that cannot help is remembered for 30 days
// so a repeated kick does not spend a request on the same dead end.
const CATALOG_PROBE_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'catalog-probe');
// Per-owner catalog ledger (see `recordCatalogAttempt`): what the catalog
// actually answered for every `catalogItemId`, so «resolved 1/1 with an empty
// card» can be told apart from «the job never asked».
const CATALOG_STATE_PATH = path.join(STATE_DIR, 'catalog-state.json');
const MAX_CATALOG_ATTEMPTS = 5;
const MAX_CATALOG_DEBUG_FILES = 5;
const MAX_CATALOG_STATUS_ITEMS = 20;

const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 30 * DAY_MS;
const DEFAULT_NOT_FOUND_TTL_MS = 30 * DAY_MS;
const DEFAULT_PROBE_TTL_MS = 7 * DAY_MS;
const DEFAULT_CATALOG_PROBE_TTL_MS = 30 * DAY_MS;
const DEFAULT_EPIC_NAMESPACE = 'fn';
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
const COVERAGE_MEMO_MS = 60 * 1000;

try {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(CATALOG_PROBE_DIR, { recursive: true });
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

/**
 * A failed catalog probe is a memory, not a verdict about the game: the same
 * `catalogItemId` is retried after 30 days or on an explicit forced import.
 */
function catalogProbeTtlMs() {
  return envMs('GAMES_SECONDARY_CATALOG_PROBE_TTL_MS', DEFAULT_CATALOG_PROBE_TTL_MS);
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
/* Epic catalog refetch (owner token)                                  */
/* ------------------------------------------------------------------ */

/**
 * A stale Epic CMS page (Alan Wake 2: `meta` has only `customReleaseDate:
 * "Coming Soon"`) has no tags/release date. The catalog bulk is the only
 * store-owned source left, and it requires the **owner's** token. This block
 * is the bounded fallback: it is reached only for an Epic work whose CMS page
 * has no meta and whose catalog document is missing/stale, uses the same
 * per-run budget and pause as the Epic details phase, and never invents a
 * genre/date.
 */

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

/**
 * Should the job spend a catalog attempt on this cached detail? Yes for a
 * pre-catalog document (one-time heal), for a document whose catalog step was
 * deferred (retry on every kick until the token works), and for a document the
 * per-owner ledger says is due again (a definitive negative after its 30-day
 * window, or no attempt recorded at all — the pre-deploy heal). `options`
 * carries `ownerKey` + `catalogItemId`; without them the marker alone decides
 * (backward-compatible for the read model and the old tests).
 */
function shouldAttemptCatalog(data, options = {}) {
  if (!detailNeedsCatalog(data)) return false;
  if (data.catalogPending === true) return true;
  if (data.catalogChecked !== true) return true;
  if (options.ownerKey && options.catalogItemId) {
    return catalogRetryDue(options.ownerKey, options.catalogItemId, options);
  }
  return false;
}

/**
 * How complete is an Epic detail as far as the stores allow?
 *   - `complete`    — year **and** genres arrived;
 *   - `partial`     — only one of them (reported honestly, never invented);
 *   - `pending`     — an attempt is still due (deferred token, pre-catalog
 *                     document, or a negative answer whose TTL expired);
 *   - `unavailable` — settled: the store has no release info for this work
 *                     (an `empty` catalog, or no catalog at all / not
 *                     connected). «resolved 0/1» must not pretend otherwise.
 */
function catalogCompletionState(data, options = {}) {
  if (!data || typeof data !== 'object') return 'unavailable';
  const flags = catalogMetaFlags(data);
  if (flags.metaStatus !== 'unavailable') return flags.metaStatus;
  if (data.catalogPending === true) return 'pending';
  if (data.catalogChecked !== true) return 'pending';
  // «Not connected» is terminal while there is no token; a later connect makes
  // the same document retryable again (the ledger has no attempt for it).
  if (data.catalogSkipped === 'not_connected') {
    return options.hasCatalogToken === true ? 'pending' : 'unavailable';
  }
  if (options.catalogItemId && options.ownerKey) {
    return catalogRetryDue(options.ownerKey, options.catalogItemId, options)
      ? 'pending'
      : 'unavailable';
  }
  return 'unavailable';
}

/** Does this owner have a usable Epic access token right now? Cheap sync read. */
function ownerHasCatalogToken(ownerKey) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  if (!key) return false;
  try {
    const epicCache = require('./epic-cache');
    const accountId = epicCache.epicAccountForOwner(key);
    if (!accountId) return false;
    const store = require('./epic-token-store');
    const summary =
      typeof store.readTokenSummarySync === 'function'
        ? store.readTokenSummarySync(accountId)
        : null;
    return Boolean(summary && summary.hasAccessToken);
  } catch (err) {
    return false;
  }
}

function catalogHasMeta(catalog) {
  if (!catalog || typeof catalog !== 'object') return false;
  return Boolean(catalog.releaseDate) ||
    (Array.isArray(catalog.categories) && catalog.categories.length > 0);
}

function catalogIsFresh(catalog) {
  if (!catalog || typeof catalog !== 'object') return false;
  try {
    return gameCache.isFresh(catalog, require('./epic-cache').epicCatalogTtlMs());
  } catch (err) {
    return false;
  }
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

function createCatalogClient(options = {}) {
  try {
    const epic = require('./epic');
    const store = options.tokenStore || require('./epic-token-store');
    return epic.createClient({ tokenStore: store });
  } catch (err) {
    return null;
  }
}

/**
 * One silent refresh + one retry. `getAccessToken` already refreshes a token
 * that is within two minutes of expiry; a 401 after that means the token was
 * revoked, but Epic sometimes rejects a token that the local clock still
 * considers valid. The retry is bounded (exactly one) and never prints a value.
 */
async function trySilentTokenRefresh(options, accountId) {
  const client =
    options.epicClient || options.catalogClient || createCatalogClient(options);
  if (!client || typeof client.refreshTokens !== 'function') return false;
  const store = options.tokenStore || require('./epic-token-store');
  if (typeof store.getTokens !== 'function' || typeof store.saveTokens !== 'function') {
    return false;
  }
  let doc;
  try {
    doc = await store.getTokens(accountId);
  } catch (err) {
    return false;
  }
  if (!doc || !doc.refreshToken) return false;
  try {
    if (typeof options.onRequest === 'function') options.onRequest();
    const fresh = await client.refreshTokens(doc.refreshToken);
    if (!fresh || !fresh.accessToken) return false;
    await store.saveTokens({
      ...doc,
      ...fresh,
      refreshToken: fresh.refreshToken || doc.refreshToken,
      lastAuthError: null,
      lastAuthErrorAt: null,
    });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Fetch `catalog/<catalogItemId>.json` with the owner's token. Returns
 * `{ catalog, pending, deferred, warning, skipped }`:
 *
 *   - `catalog` — the saved catalog document (or null);
 *   - `pending` — the owner may still get this metadata later (401/expired,
 *     rate limit, network): the detail is written but coverage stays pending,
 *     so the next kick retries. A *negative* answer is not pending;
 *   - `warning` — the job/status code (`catalog_auth_expired`, `catalog_blocked`,
 *     `catalog_empty`, …).
 *
 * Guards: no token / not connected → `skipped: 'not_connected'` (library-only,
 * previous behaviour); a fresh negative probe → `skipped: 'probe'`; a spent
 * budget → `skipped: 'budget'`. A 403/429 trips the **existing** Epic
 * secondary-details breaker (no new breaker is introduced).
 */
async function refetchEpicCatalog(options = {}) {
  const catalogItemId = options.catalogItemId ? String(options.catalogItemId) : '';
  if (!catalogItemId) return { catalog: null, skipped: 'no_catalog_id' };
  const epicCache = require('./epic-cache');
  const ownerKey = options.ownerKey ? String(options.ownerKey) : '';
  const accountId =
    options.epicAccountId || (ownerKey ? epicCache.epicAccountForOwner(ownerKey) : null);
  if (!accountId) return { catalog: null, skipped: 'not_connected' };
  const store = options.tokenStore || require('./epic-token-store');
  let token = null;
  try {
    token = typeof store.readTokenSummarySync === 'function'
      ? store.readTokenSummarySync(accountId)
      : null;
  } catch (err) {
    token = null;
  }
  if (!token || !token.hasAccessToken) return { catalog: null, skipped: 'not_connected' };
  const namespace = options.namespace || DEFAULT_EPIC_NAMESPACE;
  if (options.force !== true && options.forceCatalog !== true) {
    const probe = readCatalogProbe(catalogItemId);
    if (probe.fresh && probe.doc && probe.doc.status && probe.doc.status !== 'ok') {
      return { catalog: null, skipped: 'probe' };
    }
  }
  if (typeof options.canRequest === 'function' && !options.canRequest()) {
    noteCatalogAttempt(ownerKey, catalogItemId, {
      namespace,
      result: 'budget',
      code: 'catalog_budget',
      reason: 'budget',
    });
    return { catalog: null, skipped: 'budget', warning: 'catalog_budget' };
  }
  const client =
    options.epicClient || options.catalogClient || createCatalogClient(options);
  if (!client || typeof client.getCatalogBulk !== 'function') {
    return { catalog: null, skipped: 'no_client' };
  }

  const record = (entry) => {
    try {
      recordError({
        ownerKey: ownerKey || null,
        source: 'epic',
        id: catalogItemId,
        ...entry,
      });
    } catch (err) {
      /* diagnostics must never break the job */
    }
  };

  const attempt = async () => {
    if (typeof options.onRequest === 'function') options.onRequest();
    return client.getCatalogBulk(namespace, [catalogItemId], { accountId });
  };

  let result;
  try {
    result = await attempt();
  } catch (err) {
    const code = (err && err.code) || 'epic_http_error';
    if (code === 'epic_auth_expired') {
      // One silent refresh (rerun the token), then one retry. If that fails,
      // the metadata is deferred, not denied: the next kick tries again.
      if (await trySilentTokenRefresh(options, accountId)) {
        try {
          result = await attempt();
        } catch (retryErr) {
          return catalogFailure(retryErr, failureKindOf(retryErr), {
            record,
            catalogItemId,
            namespace,
            ownerKey,
          });
        }
      } else {
        return catalogFailure(err, 'auth', { record, catalogItemId, namespace, ownerKey });
      }
    } else {
      return catalogFailure(err, failureKindOf(err), {
        record,
        catalogItemId,
        namespace,
        ownerKey,
      });
    }
  }

  const item = result && result.items ? result.items[catalogItemId] : null;
  const transport = catalogTransportFacts(result, catalogItemId);
  if (item) {
    try {
      await epicCache.saveEpicCatalogItem(catalogItemId, item);
    } catch (err) {
      /* a read-only cache must not fail the fetch */
    }
    const yearHas = Boolean(item.releaseDate);
    const genresOk = epicGenresFromCategories(item.categories).length > 0;
    if (!catalogHasMeta(item)) {
      // The catalog knows the item but has no date/categories either: this is
      // a definitive dead end, not a retryable one. Remember it for 30 days
      // and leave a dump — «the item exists but its shape is empty» is exactly
      // the Alan Wake 2 symptom that used to be invisible.
      writeCatalogProbe(catalogItemId, 'empty', { namespace, code: 'no_meta' });
      record({ code: 'catalog_empty', reason: 'no_meta', status: transport.httpStatus, message: null });
      noteCatalogAttempt(ownerKey, catalogItemId, {
        namespace,
        result: 'empty',
        ...transport,
        genresOk,
        yearHas,
        code: 'catalog_empty',
        reason: 'no_meta',
        item,
      });
      return { catalog: item, pending: false, deferred: false, warning: 'catalog_empty' };
    }
    // `shape_ok` is the only outcome that needs no follow-up: a release date
    // AND a real genre line. `ok` (one of them) is dumped for the owner.
    noteCatalogAttempt(ownerKey, catalogItemId, {
      namespace,
      result: yearHas && genresOk ? 'shape_ok' : 'ok',
      ...transport,
      genresOk,
      yearHas,
      item,
    });
    return { catalog: item, pending: false, deferred: false, warning: null };
  }

  const failures = Array.isArray(result && result.failures) ? result.failures : [];
  const failure = failures[0] || null;
  if (failure) {
    const code = failure.code || 'epic_http_error';
    if (code === 'epic_auth_expired') {
      return catalogFailure(failure, 'auth', { record, catalogItemId, namespace, ownerKey });
    }
    if (code === 'epic_rate_limited') {
      return catalogFailure(failure, 'rate', { record, catalogItemId, namespace, ownerKey });
    }
    if (code === 'epic_unreachable') {
      return catalogFailure(failure, 'network', { record, catalogItemId, namespace, ownerKey });
    }
  }
  // A 200 without the item is a definitive answer for this catalog id: remember
  // it for 30 days so a polled kick does not repeat the request.
  writeCatalogProbe(catalogItemId, failure ? 'http_error' : 'empty', {
    namespace,
    code: failure ? failure.code || null : null,
  });
  const warning = failure ? 'catalog_http_error' : 'catalog_empty';
  record({
    code: warning,
    reason: warning,
    status: transport.httpStatus,
    message: null,
  });
  noteCatalogAttempt(ownerKey, catalogItemId, {
    namespace,
    result: failure && transport.httpStatus !== 404 ? 'unavailable' : 'empty',
    ...transport,
    code: failure ? failure.code || null : 'catalog_empty',
    reason: warning,
  });
  return { catalog: null, pending: false, deferred: false, warning };
}

/**
 * Status + byte size of the chunk that carried this catalog id. A fake client
 * may omit `chunks` (tests) — then the fields stay `null`, never invented.
 */
function catalogTransportFacts(result, catalogItemId) {
  const id = String(catalogItemId == null ? '' : catalogItemId);
  const has = (entry) =>
    Array.isArray(entry && entry.ids) && entry.ids.map(String).includes(id);
  const chunks = Array.isArray(result && result.chunks) ? result.chunks : [];
  const chunk = chunks.find(has);
  if (chunk) {
    return {
      httpStatus: chunk.status == null ? null : Number(chunk.status),
      bytes: chunk.bytes == null ? null : Number(chunk.bytes),
    };
  }
  const failures = Array.isArray(result && result.failures) ? result.failures : [];
  const failure = failures.find(has);
  if (failure) {
    return {
      httpStatus: failure.status == null ? null : Number(failure.status),
      bytes: failure.bytes == null ? null : Number(failure.bytes),
    };
  }
  return { httpStatus: null, bytes: null };
}

/**
 * Record one catalog attempt in the owner ledger and dump a diagnostic file
 * for anything short of `shape_ok`. Both are best-effort: diagnostics must
 * never fail the job.
 */
function noteCatalogAttempt(ownerKey, catalogItemId, entry = {}) {
  if (!ownerKey || !catalogItemId) return null;
  const recorded = recordCatalogAttempt(ownerKey, catalogItemId, entry);
  if (entry.result !== 'shape_ok') {
    dumpCatalogFailure(catalogItemId, entry);
  }
  return recorded;
}

function failureKindOf(err) {
  const code = (err && err.code) || 'epic_http_error';
  if (code === 'epic_auth_expired') return 'auth';
  if (code === 'epic_rate_limited') return 'rate';
  if (code === 'epic_unreachable' || (err && err.deferred)) return 'network';
  return 'http';
}

function catalogFailure(err, kind, context = {}) {
  const { record, catalogItemId, namespace, ownerKey } = context;
  const code = (err && err.code) || 'epic_http_error';
  const status = err && err.status != null ? err.status : null;
  const bytes = err && err.bodyBytes != null ? err.bodyBytes : null;
  const note = (result, extra = {}) =>
    noteCatalogAttempt(ownerKey, catalogItemId, {
      namespace,
      result,
      httpStatus: status,
      bytes,
      code,
      ...extra,
    });
  if (kind === 'auth') {
    if (record) record({ code: 'catalog_auth_expired', reason: code, status, message: null });
    note('401');
    return {
      catalog: null,
      pending: true,
      deferred: true,
      warning: 'catalog_auth_expired',
    };
  }
  if (kind === 'rate') {
    tripBreaker('epic', 'catalog_blocked', status);
    if (record) record({ code: 'catalog_blocked', reason: code, status, message: null });
    note('403');
    return {
      catalog: null,
      pending: true,
      deferred: true,
      warning: 'catalog_blocked',
    };
  }
  if (kind === 'network') {
    if (record) record({ code: 'catalog_deferred', reason: code, status, message: null });
    note('unavailable');
    return {
      catalog: null,
      pending: true,
      deferred: true,
      warning: 'catalog_deferred',
    };
  }
  if (catalogItemId) {
    writeCatalogProbe(catalogItemId, 'http_error', {
      namespace: namespace || null,
      code,
    });
  }
  if (record) record({ code: 'catalog_http_error', reason: code, status, message: null });
  note(status === 404 ? 'empty' : 'unavailable');
  return {
    catalog: null,
    pending: false,
    deferred: false,
    warning: 'catalog_http_error',
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

/* --------------------- Epic catalog probe cache -------------------- */

function catalogProbePath(catalogItemId) {
  return path.join(CATALOG_PROBE_DIR, `${safeKey(catalogItemId)}.json`);
}

/**
 * `{doc, fresh}` for the negative catalog memory of one `catalogItemId`.
 * Only *negative* answers are stored here; a successful catalog document lives
 * in `cache-games/catalog/<id>.json` (180-day TTL) and is read by the caller.
 */
function readCatalogProbe(catalogItemId, options = {}) {
  if (!catalogItemId) return { doc: null, fresh: false };
  const hit = gameCache.readJsonWithFingerprint(catalogProbePath(catalogItemId));
  if (!hit || !hit.data) return { doc: null, fresh: false };
  const fetchedAt = Date.parse(hit.data.fetchedAt || '');
  const at = options.now == null ? nowMs() : options.now;
  const fresh = Number.isFinite(fetchedAt) && at - fetchedAt < catalogProbeTtlMs();
  return { doc: hit.data, fresh };
}

function writeCatalogProbe(catalogItemId, status, extra = {}) {
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    source: 'epic-catalog-probe',
    catalogItemId: String(catalogItemId),
    status,
    fetchedAt: isoOf(nowMs()),
    ...extra,
  };
  try {
    gameCache.writeJsonAtomicSync(catalogProbePath(catalogItemId), doc);
  } catch (err) {
    /* diagnostics/cache must never fail the job */
  }
  return doc;
}

/* -------------------- Epic catalog attempt ledger ------------------ */

/**
 * Per-owner catalog ledger (`state/catalog-state.json`):
 *
 *   { schemaVersion, updatedAt, owners: { "<ownerKey>": {
 *       "<catalogItemId>": { catalogItemId, namespace, lastResult, lastAt,
 *                            attempts: [{ at, result, httpStatus, bytes,
 *                                         genresOk, yearHas }, … ≤5] } } } }
 *
 * The authoritative token is per owner, so the ledger is too — a shared
 * `catalog/` document is global, but «did *this* owner's token answer?» is not.
 * Results: `shape_ok` (date + genres), `ok` (only one of them), `empty` (no
 * item/no meta), `401`/`403`/`unavailable` (retryable), `budget` (not asked).
 */
function readCatalogState() {
  const hit = gameCache.readJsonWithFingerprint(CATALOG_STATE_PATH);
  const doc = (hit && hit.data) || {};
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: doc.updatedAt || null,
    owners: doc.owners && typeof doc.owners === 'object' ? doc.owners : {},
  };
}

function writeCatalogState(state) {
  try {
    gameCache.writeJsonAtomicSync(CATALOG_STATE_PATH, {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: isoOf(nowMs()),
      owners: state && state.owners && typeof state.owners === 'object' ? state.owners : {},
    });
  } catch (err) {
    /* diagnostics must never break the job */
  }
}

function readCatalogAttempt(ownerKey, catalogItemId, state) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  const id = String(catalogItemId == null ? '' : catalogItemId);
  if (!key || !id) return null;
  const source = state || readCatalogState();
  const owner = source.owners[key];
  const entry = owner && owner[id];
  return entry && typeof entry === 'object' ? entry : null;
}

/** Append one attempt (ring of `MAX_CATALOG_ATTEMPTS`) and persist. */
function recordCatalogAttempt(ownerKey, catalogItemId, entry = {}) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  const id = String(catalogItemId == null ? '' : catalogItemId);
  if (!key || !id) return null;
  try {
    const state = readCatalogState();
    if (!state.owners[key] || typeof state.owners[key] !== 'object') state.owners[key] = {};
    const previous = state.owners[key][id] || {};
    const attempts = Array.isArray(previous.attempts) ? previous.attempts.slice() : [];
    const result = entry.result || 'unavailable';
    attempts.push({
      at: isoOf(nowMs()),
      result,
      httpStatus: entry.httpStatus == null ? null : Number(entry.httpStatus),
      bytes: entry.bytes == null ? null : Number(entry.bytes),
      genresOk: entry.genresOk === true,
      yearHas: entry.yearHas === true,
    });
    const next = {
      catalogItemId: id,
      namespace: entry.namespace || previous.namespace || null,
      lastResult: result,
      lastAt: attempts[attempts.length - 1].at,
      attempts: attempts.slice(-MAX_CATALOG_ATTEMPTS),
    };
    state.owners[key][id] = next;
    writeCatalogState(state);
    return next;
  } catch (err) {
    return null;
  }
}

/**
 * Is another catalog attempt due for this owner/item? A successful `shape_ok`
 * is final; a retryable answer (`401`/`403`/`unavailable`/`budget`) is retried
 * on the next kick; a definitive negative (`empty`/`ok` partial) waits for the
 * same 30-day window as the negative probe. No ledger entry means the catalog
 * was never asked for this owner — due (a pre-deploy document, the heal case).
 */
function catalogRetryDue(ownerKey, catalogItemId, options = {}) {
  const entry = readCatalogAttempt(ownerKey, catalogItemId, options.catalogState);
  if (!entry) return true;
  const result = entry.lastResult || null;
  if (result === 'shape_ok') return false;
  if (result === '401' || result === '403' || result === 'unavailable' || result === 'budget') {
    return true;
  }
  const at = Date.parse(entry.lastAt || '');
  const now = options.now == null ? nowMs() : options.now;
  if (!Number.isFinite(at)) return true;
  return now - at >= catalogProbeTtlMs();
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

/**
 * Keep a ≤2 KB diagnostic dump of a failed catalog attempt for the owner to
 * send back. Written for every result except `shape_ok` — including an `empty`
 * bulk answer, which used to leave no trace at all. The token is never part of
 * `info` (the client keeps it inside the Authorization header), and the item
 * JSON is masked + truncated just in case. The file name is the catalog id, so
 * a retry overwrites its own dump instead of growing the folder.
 */
function dumpCatalogFailure(catalogItemId, info = {}) {
  try {
    const id = String(catalogItemId == null ? '' : catalogItemId);
    if (!id) return null;
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const file = path.join(DEBUG_DIR, `catalog-${safeKey(id)}.json`);
    if (!fs.existsSync(file)) {
      let count = 0;
      for (const name of fs.readdirSync(DEBUG_DIR)) {
        if (name.startsWith('catalog-') && name.endsWith('.json')) count++;
      }
      if (count >= MAX_CATALOG_DEBUG_FILES) return null;
    }
    let item = null;
    if (info.item != null) {
      try {
        item = maskSecrets(JSON.stringify(info.item)).slice(0, DEBUG_BODY_LIMIT);
      } catch (err) {
        item = null;
      }
    }
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      source: 'epic-catalog',
      catalogItemId: id,
      namespace: info.namespace || null,
      at: isoOf(nowMs()),
      result: info.result || 'unavailable',
      httpStatus: info.httpStatus == null ? null : Number(info.httpStatus),
      bytes: info.bytes == null ? null : Number(info.bytes),
      genresOk: info.genresOk === true,
      yearHas: info.yearHas === true,
      code: info.code || null,
      reason: info.reason || null,
      item,
      note:
        'Диагностика каталога Epic: статус/размер ответа и нормализованный item ' +
        '(≤2 KB, секреты замаскированы; токен не пишется).',
    };
    gameCache.writeJsonAtomicSync(file, doc);
    return file;
  } catch (err) {
    return null;
  }
}

/** Owner-facing catalog ledger for the status endpoint (newest first). */
function catalogAttemptsForOwner(ownerKey) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  const state = readCatalogState();
  const owner = (key && state.owners[key]) || {};
  const items = Object.values(owner)
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const attempts = Array.isArray(entry.attempts) ? entry.attempts.slice(-MAX_CATALOG_ATTEMPTS) : [];
      const last = attempts.length ? attempts[attempts.length - 1] : null;
      return {
        catalogItemId: entry.catalogItemId || null,
        namespace: entry.namespace || null,
        attempts: attempts.length,
        lastResult: entry.lastResult || null,
        lastAt: entry.lastAt || null,
        httpStatus: last ? last.httpStatus : null,
        bytes: last ? last.bytes : null,
        genresOk: last ? last.genresOk === true : false,
        yearHas: last ? last.yearHas === true : false,
        history: attempts,
      };
    })
    .sort((a, b) => (Date.parse(b.lastAt || '') || 0) - (Date.parse(a.lastAt || '') || 0));
  return {
    total: items.reduce((sum, entry) => sum + entry.attempts, 0),
    items: items.slice(0, MAX_CATALOG_STATUS_ITEMS),
  };
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
    const flags = catalogMetaFlags(detail);
    entry.secondaryDetails = {
      source: detail.source,
      id: detail.id,
      releaseDateSource: detail.releaseDateSource || null,
      fetchedAt: detail.fetchedAt || null,
      // The catalog step was deferred (owner token expired/blocked): the
      // poster is real, but year/genres are still pending — coverage must not
      // count this as resolved.
      catalogPending: detail.catalogPending === true,
      // A pre-catalog detail (poster only, no `catalogChecked`) is retried once
      // so the deployed fix heals an already written document.
      needsCatalog:
        Boolean(entry.epic && entry.epic.catalogItemId) &&
        needsCatalogCompletion(detail),
      // What the document actually contains: `resolved` counts `complete`
      // (year **and** genres), never the mere existence of a file.
      yearHas: flags.yearHas,
      genresOk: flags.genresOk,
      metaStatus: detail.metaStatus || flags.metaStatus,
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
        // The catalog ledger has its own cap (`MAX_CATALOG_DEBUG_FILES`): a
        // catalog failure must not evict the CMS dumps and vice versa.
        if (name.endsWith('.json') && !name.startsWith('catalog-')) count++;
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

/**
 * Use the cached catalog when it is fresh, otherwise refetch it with the
 * owner's token. A stale-but-present catalog is still returned as a fallback
 * even when the refetch is deferred: a real store date beats no date.
 */
async function ensureEpicCatalog(options = {}) {
  const catalog = options.catalog;
  if (catalogHasMeta(catalog) && catalogIsFresh(catalog)) {
    return { catalog, pending: false, deferred: false, warning: null };
  }
  const result = await refetchEpicCatalog(options);
  if (result.catalog) return result;
  if (catalogHasMeta(catalog)) return { ...result, catalog };
  return result;
}

function noteCatalogResult(result, options = {}) {
  if (!result) return;
  if (result.warning && typeof options.onWarning === 'function') {
    try {
      options.onWarning(result.warning);
    } catch (err) {
      /* a diagnostic hook must never break the fetch */
    }
  }
  if (result.deferred && typeof options.onCatalogDeferred === 'function') {
    try {
      options.onCatalogDeferred(result.warning);
    } catch (err) {
      /* ignore */
    }
  }
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
    let data = doc.status === 'ok' ? doc.data : null;
    // A detail cached before the catalog existed (Alan Wake 2: poster only)
    // is completed in place: the raw CMS payload is not cached, so the catalog
    // fields are merged additively. No catalog item → nothing to do.
    if (
      data &&
      options.catalogItemId &&
      shouldAttemptCatalog(data, {
        ownerKey: options.ownerKey,
        catalogItemId: options.catalogItemId,
      })
    ) {
      const ensured = await ensureEpicCatalog(options);
      noteCatalogResult(ensured, options);
      let next = data;
      if (ensured.catalog) next = applyCatalogToDetail(next, ensured.catalog);
      if (ensured.skipped === 'not_connected') {
        if (next.catalogSkipped !== 'not_connected') {
          next = { ...next, catalogSkipped: 'not_connected' };
        }
      } else if (ensured.pending) {
        if (next.catalogPending !== true || next.catalogChecked === true) {
          next = { ...next, catalogPending: true };
          delete next.catalogChecked;
        }
        if (next.catalogSkipped) {
          next = { ...next };
          delete next.catalogSkipped;
        }
      } else if (next.catalogChecked !== true || next.catalogPending || next.catalogSkipped) {
        // Filled, definitively empty, or «not connected»: the one-time
        // completion attempt is over. A later connect still re-imports and the
        // run-phase `completingCatalog` path retries regardless of this marker.
        next = { ...next, catalogChecked: true };
        delete next.catalogPending;
        delete next.catalogSkipped;
      }
      const flags = catalogMetaFlags(next);
      if (next.metaStatus !== flags.metaStatus || next.metaCheckedAt == null) {
        next = {
          ...next,
          metaStatus: flags.metaStatus,
          metaYearHas: flags.yearHas,
          metaGenresOk: flags.genresOk,
          metaCheckedAt: isoOf(nowMs()),
        };
      }
      if (next !== data) {
        writeDetail('epic', id, 'ok', next);
        data = next;
      }
    }
    return {
      data,
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
  let catalog = options.catalog;
  let catalogPending = false;
  // Stale CMS page (Alan Wake 2): `meta` has no tags/releaseDate at all, so
  // the catalog bulk is the only store-owned source left. It needs the
  // owner's token and is bounded by the same budget/breaker as this phase.
  let catalogSkipped = null;
  if (epicPageNeedsCatalog(payload)) {
    const ensured = await ensureEpicCatalog(options);
    noteCatalogResult(ensured, options);
    if (ensured.catalog) catalog = ensured.catalog;
    catalogPending = Boolean(ensured.pending);
    if (ensured.skipped === 'not_connected') catalogSkipped = 'not_connected';
  }
  const data = normalizeEpicProduct(payload, {
    slug: id,
    title: options.title,
    catalog,
  });
  if (catalogPending) {
    data.catalogPending = true;
  } else {
    // The catalog question is settled for this detail: either the CMS page
    // carried its own meta, the catalog filled it, or the answer was
    // definitively empty. This is what keeps a polled `/stats` from re-kicking
    // a work whose store metadata is as complete as the stores allow.
    data.catalogChecked = true;
  }
  if (catalogSkipped) data.catalogSkipped = catalogSkipped;
  const flags = catalogMetaFlags(data);
  data.metaStatus = flags.metaStatus;
  data.metaYearHas = flags.yearHas;
  data.metaGenresOk = flags.genresOk;
  data.metaCheckedAt = isoOf(nowMs());
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
// `ownerKey → {at, pending}` — a *negative* coverage verdict, memoized because
// `/stats` is polled (see `kickFromStats`).
const coverageMemo = new Map();
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
    // A cached Epic detail that is still «poster only» (stale CMS page, no
    // catalog when it was written) is completed from the catalog with the
    // owner's token. This is not a CMS refetch: `resolveEpic` sees the fresh
    // document and only merges catalog fields into it.
    const completingCatalog =
      cached.fresh &&
      !job.force &&
      source === 'epic' &&
      cached.doc &&
      cached.doc.status === 'ok' &&
      target.catalogItemId &&
      shouldAttemptCatalog(cached.doc.data, {
        ownerKey: job.ownerKey,
        catalogItemId: target.catalogItemId,
      });
    if (cached.fresh && !job.force && !completingCatalog) {
      if (cached.doc.status === 'ok') phase.resolved++;
      else phase.notFound++;
      phase.cached++;
      continue;
    }
    try {
      if (!completingCatalog) job.requests++;
      const result = await resolveOne(target, {
        client: job.client,
        force: job.force,
        // A no-slug target needs a probe + a product page; both count.
        probeBudget: job.budget - job.requests + 1,
        canRequest: () => job.requests < job.budget,
        onWarning: (warning) => {
          if (warning) job.warnings.push(String(warning));
        },
        onCatalogDeferred: () => {
          phase.deferred++;
        },
        onRequest: () => {
          job.requests++;
        },
      });
      if (result.status === 'ok') {
        phase.resolved++;
        if (completingCatalog) phase.cached++;
        else phase.fetched++;
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
  // One client per job: its `client_credentials` token and throttle state are
  // reused across catalog refetches instead of fetched per product.
  const epicClient =
    options.epicClient || options.catalogClient || (epic.length ? createCatalogClient(options) : null);
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
    // Owner-token catalog refetch (stale Epic CMS): injected in tests, created
    // once per job from the token store in production.
    epicClient: epicClient,
    tokenStore: options.tokenStore || null,
    epicAccountId: options.epicAccountId || null,
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
            namespace: entry.namespace || null,
          })),
        (target, opts) =>
          resolveEpic(target.slug, {
            ...opts,
            title: target.title,
            catalog: target.catalog,
            catalogItemId: target.catalogItemId,
            namespace: target.namespace,
            ownerKey: job.ownerKey,
            epicClient: job.epicClient,
            tokenStore: job.tokenStore,
            epicAccountId: job.epicAccountId,
            forceCatalog: job.force,
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
        namespace: game.namespace || null,
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
  const epicHasToken = ownerHasCatalogToken(ownerKey);
  // One ledger read for the whole pass: `/stats` is polled, and a 300-work
  // Epic library must not re-read the same state file per target.
  let catalogState = null;
  try {
    catalogState = readCatalogState();
  } catch (err) {
    catalogState = null;
  }
  const phase = (source, list, idOf) => {
    let resolved = 0;
    let notFound = 0;
    let unavailable = 0;
    let partial = 0;
    let retryablePartial = 0;
    let pending = 0;
    for (const target of list) {
      const id = idOf(target);
      if (!id) {
        // A slugless Epic work is addressable only by its title guess. A fresh
        // probe negative means «attempted, nothing found» — not pending.
        let attempted = false;
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
            attempted = true;
          }
        }
        if (!attempted) pending++;
        continue;
      }
      const { doc, fresh } = readDetail(source, id);
      if (!fresh || !doc) {
        pending++;
        continue;
      }
      if (doc.status !== 'ok') {
        if (doc.status === 'not_found') notFound++;
        else pending++;
        continue;
      }
      if (source === 'gog') {
        // GOG was resolved before the `metaStatus` work; keep its contract.
        resolved++;
        continue;
      }
      // Epic: `resolved` means the **facts** arrived (year + genres), not that
      // a file exists. A settled negative is `unavailable` (honest «store has
      // no release info»), a deferred/pre-catalog document is still pending.
      const completion = catalogCompletionState(doc.data, {
        ownerKey,
        catalogItemId: target.catalogItemId,
        hasCatalogToken: epicHasToken,
        catalogState,
      });
      if (completion === 'complete') resolved++;
      else if (completion === 'partial') {
        // One fact arrived, the other did not. It is still a work the catalog
        // can complete, so it must reach the kick (fix 02.11.2026: `partial`
        // used to be counted as neither `resolved` nor `pending`, so the lazy
        // kick returned `attempted` and AW2 stayed poster-only forever).
        // A partial whose catalog answer is already settled (`shape_ok`, or
        // `ok` inside its 30-day probe TTL) is not re-asked on every poll, and
        // without an owner token there is nothing to ask — the next connect
        // makes it retryable again.
        partial++;
        if (
          epicHasToken &&
          target.catalogItemId &&
          catalogRetryDue(ownerKey, target.catalogItemId, { catalogState })
        ) {
          retryablePartial++;
        }
      } else if (completion === 'pending') pending++;
      else unavailable++;
    }
    return {
      total: list.length,
      resolved,
      notFound,
      unavailable,
      partial,
      retryablePartial,
      missingSlug: 0,
      pending,
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
    // `partial` is a first-class state: the work has a detail document but one
    // of year/genres is missing. `retryablePartial` is the subset the catalog
    // can still answer for (no attempt yet, or the 30-day window expired).
    partial: gog.partial + epic.partial,
    retryablePartial: gog.retryablePartial + epic.retryablePartial,
  };
}

/**
 * The owner-facing diagnostic (`GET /api/games/secondary-details/status`).
 * Contract: `{ resolved, total, pending, partial, retryablePartial, running,
 * bySource, slugless[], lastErrors[], cooldownUntil, kick, lastRunAt }`.
 * Everything here is a cache/state read — the endpoint never makes a network
 * request.
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
    pending: coverage.pending,
    // Degraded-but-present metadata: a detail document exists, but only one of
    // year/genres arrived. `retryablePartial` is the subset the catalog can
    // still complete (no attempt yet / probe TTL expired) — that subset, not
    // every partial, is what a lazy kick will address.
    partial: coverage.partial,
    retryablePartial: coverage.retryablePartial,
    running: runningFor(key),
    bySource: {
      gog: { ...coverage.gog },
      epic: { ...coverage.epic },
    },
    // The per-owner catalog ledger: which `catalogItemId`s were asked, what
    // the token answered, HTTP status/bytes and whether year/genres arrived.
    // `total: 0` is itself the answer to «did the job ever ask?».
    catalogAttempts: catalogAttemptsForOwner(key),
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

/**
 * The single kick rule (fix 02.11.2026): a secondary library needs the store
 * metadata job when **any** of these holds:
 *
 *   - `resolved < total` — an addressable work has no detail yet;
 *   - `partial > 0`      — a detail exists but only one of year/genres
 *                          arrived; the time-based rule used to let this work
 *                          sit forever (the AW2 symptom), so it is now
 *                          re-posted with the goal «complete»;
 *   - `noSlug > 0`       — an Epic work has no store slug and can only be
 *                          addressed by the title probe.
 *
 * Callers pass either `stats.meta.secondaryDetails` (cheap, no cache reads) or
 * a refined `coverageForOwner()` snapshot; the predicate is identical.
 */
function coverageNeedsKick(meta) {
  if (!meta || typeof meta !== 'object') return false;
  const total = Number(meta.total) || 0;
  const resolved = Number(meta.resolved) || 0;
  const partial = Number(meta.partial) || 0;
  const noSlug = Number(meta.noSlug) || 0;
  return (total > 0 && resolved < total) || partial > 0 || noSlug > 0;
}

/**
 * Lazy kick from `GET /api/games/stats` (the missing piece after the 66c3d21
 * deploy: an Epic library imported *before* the deploy never fired a kick, and
 * nothing re-kicked it). Fire-and-forget, coalesced by `kickGate`, disabled
 * with `GAMES_SECONDARY_LAZY_KICK=0`.
 *
 * Kick rule (fix 02.11.2026): `resolved < total || partial > 0 || noSlug > 0`
 * — see `coverageNeedsKick`. The cache refinement then drops works that were
 * already attempted (404/settled negative), while a `partial` whose catalog
 * answer is still due stays kickable.
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
  // start every cooldown window for a work that cannot be resolved. A negative
  // verdict is memoized for a minute: `/stats` is polled, and the refinement
  // re-reads the library/catalog.
  const memo = coverageMemo.get(key);
  if (
    memo &&
    memo.pending <= 0 &&
    memo.retryablePartial <= 0 &&
    nowMs() - memo.at < COVERAGE_MEMO_MS
  ) {
    return { skipped: 'attempted' };
  }
  const coverage = coverageForOwner(key);
  // `partial` is kickable (fix 02.11.2026): the detail exists, but year/genres
  // are incomplete — the catalog is re-asked when no attempt is recorded yet
  // or its 30-day probe window expired. A settled `shape_ok` partial stays
  // settled and must not burn a request on every poll.
  const retryablePartial = coverage.retryablePartial;
  if (coverage.pending <= 0 && retryablePartial <= 0) {
    coverageMemo.set(key, { at: nowMs(), pending: 0, retryablePartial: 0 });
    return { skipped: 'attempted' };
  }
  coverageMemo.delete(key);
  const gate = kickGate(key, options);
  if (gate) return { skipped: gate };
  return kickSecondaryDetailsQuietly(key, {
    trigger: 'stats',
    client: options.client,
    // Catalog refetch injection for tests (and for a caller that already owns
    // a client): the lazy kick must use the same token-bound client as an
    // explicit run.
    epicClient: options.epicClient,
    catalogClient: options.catalogClient,
    tokenStore: options.tokenStore,
    epicAccountId: options.epicAccountId,
    pauseMs: options.pauseMs,
    ...targetsForOwner(key),
  });
}

/** Test helper: forget job/cooldown state between cases. */
function resetJobs() {
  jobs.clear();
  lastKick.clear();
  coverageMemo.clear();
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
  CATALOG_PROBE_DIR,
  CATALOG_STATE_PATH,
  STATE_DIR,
  BREAKER_PATH,
  STATUS_PATH,
  DEFAULT_BUDGET,
  DEFAULT_PAUSE_MS,
  DEFAULT_BREAKER_MS,
  DEFAULT_PROBE_TTL_MS,
  DEFAULT_CATALOG_PROBE_TTL_MS,
  MAX_DEBUG_FILES,
  MAX_CATALOG_ATTEMPTS,
  MAX_CATALOG_DEBUG_FILES,
  EPIC_FEATURE_TAGS,
  yearOfDate,
  absoluteUrl,
  normalizeGogProduct,
  normalizeEpicProduct,
  pickEpicPage,
  epicTagName,
  epicGenresFromCategories,
  epicPageNeedsCatalog,
  detailNeedsCatalog,
  needsCatalogCompletion,
  shouldAttemptCatalog,
  catalogHasMeta,
  applyCatalogToDetail,
  refetchEpicCatalog,
  ensureEpicCatalog,
  readCatalogProbe,
  writeCatalogProbe,
  catalogProbePath,
  readCatalogState,
  writeCatalogState,
  readCatalogAttempt,
  recordCatalogAttempt,
  catalogRetryDue,
  catalogMetaFlags,
  catalogCompletionState,
  ownerHasCatalogToken,
  catalogTransportFacts,
  dumpCatalogFailure,
  catalogAttemptsForOwner,
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
