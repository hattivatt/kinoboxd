'use strict';

/**
 * The secondary-library model: **one** place where a GOG/Epic product gets its
 * identity (`workKey`) and where the same owner's libraries are unioned.
 *
 * This module absorbs the four modules the domain used to have
 * (`gog-union.js`, `secondary-union.js`, `secondary-identity.js`,
 * `epic-layer.js`); their old paths stay as thin re-export facades until the
 * tests move. Everything here is pure plain-objects-in/plain-objects-out apart
 * from explicit cache reads and the one WDQS batch, so it is unit-testable
 * without HTTP or the filesystem.
 *
 * Identity (`workKey`) resolution, strongest first (§14.3):
 *   1. **Wikidata bridge** — a store slug resolved to a Steam appid by the
 *      `P2725`/`P6278` → `P1733` batch, then `appid → workKey` through the
 *      canonical edition index. `P1733` names the **base** game while the
 *      owner's Steam row may be a regional SKU, so the bridge appid is also
 *      resolved through the base identity `links/<appid>.json` carries
 *      (`wikidata.baseQid/baseAppid`, B6);
 *   2. **`links/<appid>.json` `P2725`** — the GOG slug of a Steam work;
 *   3. **exact normalised title** — unique among Steam works, confidence
 *      `medium`; the canonical `editions.coreTitle` key is tried after the
 *      plain key, so edition/region wrappers do not hide the same work;
 *   4. **own work** — `gog:<gogGameId>` / `epic:<catalogItemId>`, confidence
 *      `single`.
 *
 * Hours are **never summed across sources**: `hoursBySource.steam/gog/epic`
 * stay separate numbers (the display sum is `displayMinutes`, computed here
 * once so no aggregate can forget the rule). An unknown number is **never** a
 * zero: `hoursBySource.<store>` is `null` and the entry is `hoursUnknown`.
 *
 * The identity bridge (`links/secondary.json`) is also the last-resort source
 * of a release year (`P577`) and of a genre line (`P136`) for a store document
 * that carries no date/genres; `applyWikidataYear()` fills only an **empty**
 * year and `applyWikidataFacts()` also fills only an **empty** genre list —
 * store/catalog values are never replaced. Genres never enter the identity
 * maps: a title match stays a metadata answer, not a `P6278` link.
 */

const path = require('path');

const gameCache = require('../game-cache');
const epicCache = require('../epic-cache');
const tokenStore = require('../epic-token-store');
const epic = require('../epic');
const editions = require('../editions');
const { fetchOnce, responseFacade } = require('../../core/http');
// The P577 statement parser/picker is shared with the Steam franchise pass so
// both WD readers agree on precision and on «earliest year» selection.
const { parseWbDate, pickDate } = require('../franchise');
const { yearOfDate, needsCatalogCompletion, catalogMetaFlags, sanitizeEpicGenres } = require('./normalize');

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

/* ------------------------------------------------------------------ */
/* identity bridge (was `secondary-identity.js`)                       */
/* ------------------------------------------------------------------ */

const WDQS = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'kinoboxd/1.0 (games secondary identity; https://github.com/hattivatt/kinoboxd)';
const BATCH_SIZE = 450;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 25000;

const LINKS_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'links');
const CACHE_PATH = path.join(LINKS_DIR, 'secondary.json');

class SecondaryIdentityError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'SecondaryIdentityError';
    this.code = code || 'secondary_identity_error';
    if (details.status != null) this.status = details.status;
    if (details.retryAfter != null) this.retryAfter = details.retryAfter;
  }
}

function ttlMs() {
  const raw = Number(process.env.GAMES_SECONDARY_LINKS_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}


function escapeLiteral(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]/g, ' ');
}

/**
 * One SPARQL query for both stores. GOG values are written as `game/<slug>`
 * (the P2725 literal form), Epic values as the bare slug (P6278). The
 * publication date is `OPTIONAL` so a QID without P577 still answers identity
 * (and is cached as a settled «no date», not as a failure).
 */
function buildBridgeQuery({ gogSlugs = [], epicSlugs = [] } = {}) {
  const gog = gogSlugs.map((slug) => `"game/${escapeLiteral(slug)}"`);
  const epic = epicSlugs.map((slug) => `"${escapeLiteral(slug)}"`);
  const branches = [];
  if (gog.length) {
    branches.push(
      `  { VALUES ?gogSlug { ${gog.join(' ')} }\n    ?item wdt:P2725 ?gogSlug .\n    BIND(?gogSlug AS ?slug)\n    BIND("gog" AS ?store) }`
    );
  }
  if (epic.length) {
    branches.push(
      `  { VALUES ?epicSlug { ${epic.join(' ')} }\n    ?item wdt:P6278 ?epicSlug .\n    BIND(?epicSlug AS ?slug)\n    BIND("epic" AS ?store) }`
    );
  }
  return `SELECT ?item ?store ?slug ?appid ?date ?precision WHERE {
${branches.join('\n  UNION\n')}
  OPTIONAL { ?item wdt:P1733 ?appid . }
  OPTIONAL {
    ?item p:P577 ?st .
    ?st psv:P577 ?val .
    ?val wikibase:timeValue ?date .
    ?val wikibase:timePrecision ?precision .
  }
}`;
}

/**
 * One entry per `store:slug`. A date is only ever *added*: several P577
 * statements (regional releases) are reduced by the shared `pickDate` rule
 * (earliest year, then the most precise statement). `releaseDate` stays `null`
 * unless the statement is day-precision — a month/year precision must not
 * become a fake day.
 */
function parseBridgeResponse(data) {
  const bindings =
    data && data.results && Array.isArray(data.results.bindings) ? data.results.bindings : [];
  const acc = {};
  for (const row of bindings) {
    const item = row && row.item && row.item.value ? String(row.item.value) : null;
    const qid = item ? item.slice(item.lastIndexOf('/') + 1) : null;
    const store = row && row.store && row.store.value ? String(row.store.value) : null;
    const slug = row && row.slug && row.slug.value ? normalizeSlug(row.slug.value) : null;
    if (!qid || !store || !slug) continue;
    const key = `${store}:${slug}`;
    let entry = acc[key];
    if (!entry) {
      entry = { qid, appid: null, store, dates: [] };
      acc[key] = entry;
    }
    const appid = row.appid && row.appid.value ? String(row.appid.value) : null;
    // Several rows per item (base + expansion pass): keep the one with an appid.
    if (appid && !entry.appid) entry.appid = appid;
    if (row.date && row.date.value) {
      const date = parseWbDate(row.date.value, row.precision && row.precision.value);
      if (
        date &&
        !entry.dates.some((known) => known.iso === date.iso && known.precision === date.precision)
      ) {
        entry.dates.push(date);
      }
    }
  }
  const entries = {};
  for (const [key, entry] of Object.entries(acc)) {
    const date = pickDate(entry.dates);
    entries[key] = {
      qid: entry.qid,
      appid: entry.appid,
      store: entry.store,
      releaseYear: date ? date.year : null,
      releasePrecision: date ? date.precision : null,
      releaseDate: date && date.precision === 'day' ? date.iso : null,
      releaseDateSource: date ? 'wikidata' : null,
    };
  }
  return entries;
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
 * The title fallback query. It is deliberately exact-literal: the title (and
 * its bounded Roman/Arabic variants) is a `VALUES` constant on both
 * `rdfs:label` and `skos:altLabel`, restricted to video-game items
 * (`P31/P279* Q7889`). It is used **only** for Epic works whose store/catalog
 * metadata has no date — or, since 03.11.2026, no genre line either (a stale
 * CMS page such as Alan Wake 2's). `wdt:P136` (genre) is `OPTIONAL` and only
 * labels the QID the title already resolved: it never creates an identity and
 * never turns an ambiguous title into a link.
 */
function buildTitleQuery(titles) {
  const values = new Set();
  for (const title of Array.isArray(titles) ? titles : []) {
    for (const variant of titleVariants(title)) {
      const literal = escapeLiteral(variant);
      for (const lang of ['en', 'ru', 'mul']) values.add(`"${literal}"@${lang}`);
    }
  }
  if (!values.size) return null;
  return `SELECT ?item ?matched ?appid ?date ?precision ?genreLabel WHERE {
  VALUES ?matched { ${[...values].join(' ')} }
  { ?item rdfs:label ?matched } UNION { ?item skos:altLabel ?matched }
  ?item wdt:P31/wdt:P279* wd:Q7889 .
  OPTIONAL { ?item wdt:P1733 ?appid . }
  OPTIONAL {
    ?item p:P577 ?st .
    ?st psv:P577 ?val .
    ?val wikibase:timeValue ?date .
    ?val wikibase:timePrecision ?precision .
  }
  OPTIONAL {
    ?item wdt:P136 ?genre .
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en,ru". }
  }
}`;
}

/**
 * Wikidata P136 labels are lowercase («survival horror», «third-person
 * shooter», «role-playing video game»), while the genre wall draws store
 * genres capitalized («Horror», «Turn-Based»). Only the generic «video game»
 * suffix is dropped and the first letter is capitalized: no renaming, no
 * invented umbrella genre.
 */
function wikidataGenreName(label) {
  let text = String(label == null ? '' : label).trim();
  if (!text) return null;
  // The generic class itself is not a genre chip.
  if (/^(?:video\s+)?games?$/i.test(text)) return null;
  text = text.replace(/\s+video\s+games?$/i, '').replace(/\s+games?$/i, '').trim();
  if (!text) return null;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * One entry per candidate (`epic:<normalised slug>`), but only when the exact
 * title matched **exactly one** Wikidata item. Several different QIDs for the
 * same label are the «Prey (2006) vs Prey (2017)» case: no link, recorded as
 * `titleMatched: 'ambiguous'` so the pass does not ask again while the cache is
 * fresh. A plain miss is stored the same way (`'miss'`) — in the **title map**,
 * never in `entries`, so it cannot suppress a later `P6278` match.
 */
function parseTitleResponse(data, candidates) {
  const bindings =
    data && data.results && Array.isArray(data.results.bindings) ? data.results.bindings : [];
  const byLabel = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    for (const variant of titleVariants(candidate.title)) {
      if (!byLabel.has(variant)) byLabel.set(variant, []);
      byLabel.get(variant).push(candidate);
    }
  }
  const acc = new Map();
  for (const row of bindings) {
    const item = row && row.item && row.item.value ? String(row.item.value) : null;
    const qid = item ? item.slice(item.lastIndexOf('/') + 1) : null;
    const matched = row && row.matched && row.matched.value ? String(row.matched.value) : null;
    if (!qid || !matched || !byLabel.has(matched)) continue;
    for (const candidate of byLabel.get(matched)) {
      const key = `${candidate.store}:${normalizeSlug(candidate.slug)}`;
      let entry = acc.get(key);
      if (!entry) {
        entry = {
          candidate,
          qids: new Set(),
          appid: null,
          dates: [],
          genres: [],
          matchedLabel: matched,
        };
        acc.set(key, entry);
      }
      entry.qids.add(qid);
      const appid = row.appid && row.appid.value ? String(row.appid.value) : null;
      if (appid && !entry.appid) entry.appid = appid;
      const genre = wikidataGenreName(row.genreLabel && row.genreLabel.value);
      if (genre && !entry.genres.includes(genre)) entry.genres.push(genre);
      if (row.date && row.date.value) {
        const date = parseWbDate(row.date.value, row.precision && row.precision.value);
        if (
          date &&
          !entry.dates.some((known) => known.iso === date.iso && known.precision === date.precision)
        ) {
          entry.dates.push(date);
        }
      }
    }
  }
  const entries = {};
  for (const [key, entry] of acc) {
    const ambiguous = entry.qids.size !== 1;
    const qid = ambiguous ? null : [...entry.qids][0];
    const date = qid ? pickDate(entry.dates) : null;
    entries[key] = {
      qid,
      appid: qid ? entry.appid : null,
      store: entry.candidate.store,
      slug: entry.candidate.slug,
      title: entry.candidate.title,
      matchedLabel: entry.matchedLabel,
      matchedBy: 'title',
      confidence: qid ? 'medium' : 'none',
      titleMatched: ambiguous ? 'ambiguous' : qid ? 'unique' : 'miss',
      releaseYear: date ? date.year : null,
      releasePrecision: date ? date.precision : null,
      releaseDate: date && date.precision === 'day' ? date.iso : null,
      releaseDateSource: date ? 'wikidata' : null,
      // P136 labels are a **metadata** answer of the resolved QID, never an
      // identity: they live in this map only (the P6278 entry stays untouched).
      genres: qid ? sanitizeEpicGenres(entry.genres) : [],
    };
  }
  return entries;
}

/**
 * Candidate list for the title pass: only an Epic work with a slug and a title
 * whose store/catalog/known year is still empty — or, when the caller already
 * knows the genre axis (`genres` property present, even empty), whose genre
 * line is empty too (the «Public» bucket case: the stale cached document is
 * sanitized to `[]` on read and the real P136 genres are asked for once).
 * `releaseYear`/`releaseDate`/`genres` are optional hints the caller already
 * knows. A card without a `genres` key is judged by the year axis only, so the
 * Epic import (which has no detail documents at hand) does not grow the pass.
 */
function collectTitleCandidates(epicGames) {
  const out = [];
  const seen = new Set();
  for (const game of Array.isArray(epicGames) ? epicGames : []) {
    if (!game) continue;
    const slug = String(game.slug == null ? '' : game.slug).trim();
    const title = String(game.title == null ? '' : game.title).trim();
    if (!slug || !title) continue;
    const hasYear = game.releaseYear != null || game.releaseDate;
    const knowsGenres = Object.prototype.hasOwnProperty.call(game, 'genres');
    const hasGenres = Array.isArray(game.genres) && game.genres.length > 0;
    if (hasYear && (!knowsGenres || hasGenres)) continue;
    const key = normalizeSlug(slug);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ store: 'epic', slug, title });
  }
  return out;
}

/**
 * Resolve Epic titles to Wikidata items when the store slug has no `P6278`
 * identity (or no date). The answer goes to `titleEntries`; a miss/ambiguity
 * is cached there with `qid: null` so it is not re-asked while fresh.
 */
async function fetchSecondaryTitleLinks(input = {}, options = {}) {
  const candidates = collectTitleCandidates(
    input.epicGames || input.titles || []
  );
  const cached = readCache();
  const cachedTitleEntries =
    cached && cached.titleEntries && typeof cached.titleEntries === 'object'
      ? cached.titleEntries
      : {};
  const fresh = cached && gameCache.isFresh(cached, options.ttlMs || ttlMs());
  const covered = (candidate) =>
    isSettledTitleEntry(cachedTitleEntries[`${candidate.store}:${normalizeSlug(candidate.slug)}`]);
  const pending = fresh && options.force !== true
    ? candidates.filter((candidate) => !covered(candidate))
    : candidates;
  const result = {
    titleEntries: { ...cachedTitleEntries },
    queries: 0,
    resolved: 0,
    ambiguous: 0,
    cached: candidates.length - pending.length,
    skipped: null,
    errors: [],
  };
  if (!pending.length) return result;

  for (const batch of chunk(pending, BATCH_SIZE)) {
    const query = buildTitleQuery(batch.map((candidate) => candidate.title));
    if (!query) continue;
    result.queries++;
    let response;
    try {
      response = await sparqlRequest(query, options);
    } catch (err) {
      result.errors.push(`wd_network:${(err && err.code) || 'failed'}`);
      result.skipped = 'network';
      continue;
    }
    if (!response || !response.ok) {
      const status = response ? Number(response.status) || 0 : 0;
      result.errors.push(`wd_${status || 'http'}`);
      result.skipped = status === 429 ? 'rate_limited' : 'http';
      continue;
    }
    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      result.errors.push('wd_parse');
      result.skipped = 'parse';
      continue;
    }
    const parsed = parseTitleResponse(data, batch);
    for (const candidate of batch) {
      const key = `${candidate.store}:${normalizeSlug(candidate.slug)}`;
      if (parsed[key]) {
        result.titleEntries[key] = parsed[key];
        if (parsed[key].qid) result.resolved++;
        else if (parsed[key].titleMatched === 'ambiguous') result.ambiguous++;
      } else {
        result.titleEntries[key] = {
          qid: null,
          appid: null,
          store: candidate.store,
          slug: candidate.slug,
          title: candidate.title,
          matchedBy: 'title',
          confidence: 'none',
          titleMatched: 'miss',
          releaseYear: null,
          releasePrecision: null,
          releaseDate: null,
          releaseDateSource: null,
          genres: [],
        };
      }
    }
  }

  if (!result.skipped || result.resolved > 0) {
    writeCache(
      cached && cached.entries && typeof cached.entries === 'object' ? cached.entries : {},
      {
        titleEntries: result.titleEntries,
        stats: {
          ...((cached && cached.stats) || {}),
          epicTitles: candidates.length,
          titleQueries: result.queries,
          titleMatched: result.resolved,
        },
      }
    );
  }
  return result;
}

function isSettledTitleEntry(entry) {
  if (!(entry && typeof entry === 'object' && entry.matchedBy === 'title')) return false;
  // A resolved match written before the genre pass (schema 3) has no `genres`
  // key at all. It is re-asked **once**, so a P136 genre line can arrive and
  // heal the detail; after that the key exists (even as `[]`) and the entry is
  // settled again. A miss (`qid: null`) has no facts to gain and stays settled.
  if (entry.qid && !Object.prototype.hasOwnProperty.call(entry, 'genres')) return false;
  return true;
}

function isSettledEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (!entry.qid) return true;
  return entry.releaseDateSource !== undefined;
}

function readCache() {
  const hit = gameCache.readJsonWithFingerprint(CACHE_PATH);
  return hit ? hit.data : null;
}

/** Cached bridge entries (fresh only unless `allowStale`), never a network call. */
function readSecondaryLinks({ allowStale = false } = {}) {
  const doc = readCache();
  if (!doc || !doc.entries || typeof doc.entries !== 'object') return {};
  if (!allowStale && !gameCache.isFresh(doc, ttlMs())) return {};
  return doc.entries;
}

/**
 * Title-matched identities live **next to** the store-slug entries, never
 * inside them: a unique exact-label match is honest evidence for a year, but
 * it is not a `P6278` identity. Keeping the maps separate means a title match
 * can never silently upgrade a work to `matchedBy: 'wikidata'`.
 */
function readSecondaryTitleLinks({ allowStale = false } = {}) {
  const doc = readCache();
  if (!doc || !doc.titleEntries || typeof doc.titleEntries !== 'object') return {};
  if (!allowStale && !gameCache.isFresh(doc, ttlMs())) return {};
  return doc.titleEntries;
}

/**
 * One cached entry (`{qid, appid, store, releaseYear, releasePrecision,
 * releaseDate, releaseDateSource}`) for a store slug — a cache read, never a
 * request. The key is the normalised slug, exactly like the writer.
 */
function readSecondaryLink(store, slug, options = {}) {
  const key = normalizeSlug(slug);
  const prefix = String(store == null ? '' : store).trim().toLowerCase();
  if (!key || !prefix) return null;
  const links = options.links && typeof options.links === 'object'
    ? options.links
    : readSecondaryLinks(options);
  return links[`${prefix}:${key}`] || null;
}

/** A title-matched entry (separate map, `matchedBy: 'title'`). */
function readSecondaryTitleLink(store, slug, options = {}) {
  const key = normalizeSlug(slug);
  const prefix = String(store == null ? '' : store).trim().toLowerCase();
  if (!key || !prefix) return null;
  const links = options.titleLinks && typeof options.titleLinks === 'object'
    ? options.titleLinks
    : readSecondaryTitleLinks(options);
  return links[`${prefix}:${key}`] || null;
}

function writeCache(entries, extra = {}) {
  // Title matches are a *separate* column: a write of slug entries must not
  // drop them, and the title pass must not drop the slug entries.
  const previous = readCache();
  const hasTitleEntries = Object.prototype.hasOwnProperty.call(extra, 'titleEntries');
  const titleEntries = hasTitleEntries
    ? extra.titleEntries
    : (previous && previous.titleEntries) || {};
  const rest = { ...extra };
  delete rest.titleEntries;
  const doc = {
    schemaVersion: 3,
    source: 'wikidata',
    fetchedAt: new Date().toISOString(),
    entries,
    titleEntries,
    ...rest,
  };
  try {
    gameCache.writeJsonAtomicSync(CACHE_PATH, doc);
  } catch (err) {
    /* a read-only cache (worktree) must not fail the import */
  }
  return doc;
}

function sparqlRequest(query, options = {}) {
  const fetchImpl = options.fetchImpl;
  if (!fetchImpl && typeof globalThis.fetch !== 'function') {
    return Promise.reject(
      new SecondaryIdentityError('fetch is not available', 'secondary_identity_unavailable')
    );
  }
  const timeoutMs =
    options.timeoutMs == null
      ? DEFAULT_TIMEOUT_MS
      : Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  return fetchOnce(options.endpoint || process.env.KINOBOXD_WDQS_ENDPOINT || WDQS, {
    fetchImpl,
    method: 'POST',
    headers: {
      accept: 'application/sparql-results+json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT,
    },
    body: new URLSearchParams({ query, format: 'json' }).toString(),
    timeoutMs,
    label: 'secondary-identity',
  }).then(responseFacade);
}

function chunk(list, size) {
  const out = [];
  for (let index = 0; index < list.length; index += size) {
    out.push(list.slice(index, index + size));
  }
  return out;
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

/** A cached miss: the QID is unknown, so there is no date either. */
function emptyEntry(store, slug) {
  return {
    qid: null,
    appid: null,
    store,
    slug,
    releaseYear: null,
    releasePrecision: null,
    releaseDate: null,
    releaseDateSource: null,
  };
}

/**
 * Resolve GOG/Epic slugs to Wikidata items and Steam appids, merging into the
 * cached document.
 *
 * @param {object} input `{ gogSlugs: string[], epicSlugs: string[] }`
 * @param {object} [options] `{ fetchImpl, endpoint, ttlMs, force, timeoutMs }`
 * @returns {Promise<{entries, queries, resolved, cached, skipped, errors}>}
 */
async function fetchSecondaryLinks(input = {}, options = {}) {
  // The **raw** slug is what Wikidata stores (`P6278 the-witcher-3-wild-hunt`,
  // `P2725 game/the_witcher_3_wild_hunt`); the normalised form is only the
  // cache key, because the two stores spell the same game differently.
  const rawGog = uniqueSlugs(input.gogSlugs);
  const rawEpic = uniqueSlugs(input.epicSlugs);
  const cached = readCache();
  const cachedEntries = cached && cached.entries && typeof cached.entries === 'object'
    ? cached.entries
    : {};
  const fresh = cached && gameCache.isFresh(cached, options.ttlMs || ttlMs());
  const known = (store, slug) => isSettledEntry(cachedEntries[`${store}:${normalizeSlug(slug)}`]);
  const pendingGog = fresh && options.force !== true
    ? rawGog.filter((slug) => !known('gog', slug))
    : rawGog;
  const pendingEpic = fresh && options.force !== true
    ? rawEpic.filter((slug) => !known('epic', slug))
    : rawEpic;
  const result = {
    entries: { ...cachedEntries },
    queries: 0,
    resolved: 0,
    cached: rawGog.length + rawEpic.length - pendingGog.length - pendingEpic.length,
    skipped: null,
    errors: [],
  };
  if (!pendingGog.length && !pendingEpic.length) return result;

  const batches = [];
  const gogBatches = chunk(pendingGog, BATCH_SIZE);
  const epicBatches = chunk(pendingEpic, BATCH_SIZE);
  const total = Math.max(gogBatches.length, epicBatches.length, 1);
  for (let index = 0; index < total; index++) {
    batches.push({ gogSlugs: gogBatches[index] || [], epicSlugs: epicBatches[index] || [] });
  }

  for (const batch of batches) {
    if (!batch.gogSlugs.length && !batch.epicSlugs.length) continue;
    const query = buildBridgeQuery(batch);
    result.queries++;
    let response;
    try {
      response = await sparqlRequest(query, options);
    } catch (err) {
      result.errors.push(`wd_network:${(err && err.code) || 'failed'}`);
      result.skipped = 'network';
      // Deferred, not negative: nothing is written for this batch.
      continue;
    }
    if (!response || !response.ok) {
      const status = response ? Number(response.status) || 0 : 0;
      result.errors.push(`wd_${status || 'http'}`);
      result.skipped = status === 429 ? 'rate_limited' : 'http';
      continue;
    }
    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      result.errors.push('wd_parse');
      result.skipped = 'parse';
      continue;
    }
    const parsed = parseBridgeResponse(data);
    // A slug the query did not answer is a real miss for the cached document.
    for (const slug of batch.gogSlugs) {
      const key = `gog:${normalizeSlug(slug)}`;
      if (parsed[key]) result.entries[key] = parsed[key];
      else if (!result.entries[key]) {
        result.entries[key] = emptyEntry('gog', slug);
      }
    }
    for (const slug of batch.epicSlugs) {
      const key = `epic:${normalizeSlug(slug)}`;
      if (parsed[key]) result.entries[key] = parsed[key];
      else if (!result.entries[key]) {
        result.entries[key] = emptyEntry('epic', slug);
      }
    }
    result.resolved += Object.values(parsed).filter((entry) => entry.qid).length;
  }

  // Only a batch that was actually answered may extend the TTL: a failed pass
  // keeps the previous `fetchedAt` so the next run retries.
  if (!result.skipped || result.resolved > 0) {
    writeCache(result.entries, {
      stats: { gogSlugs: rawGog.length, epicSlugs: rawEpic.length, queries: result.queries },
    });
  }
  return result;
}

/** Slugs of the GOG products / Epic games that still need an identity. */
function collectSlugs({ gogProducts = [], epicGames = [] } = {}) {
  const gogSlugs = uniqueSlugs(gogProducts.map((product) => product && product.slug));
  const epicSlugs = uniqueSlugs(epicGames.map((game) => game && game.slug));
  return { gogSlugs, epicSlugs };
}

/**
 * Job-side wrapper: refresh the bridge for the slugs of one import.
 *
 * Runs **only for a real import** (`options.client` absent): a job driven by an
 * injected client is hermetic (tests, diagnostics) and must not touch WDQS.
 * Never throws — the import's own result is what the user asked for; the bridge
 * is an enhancement and a WD outage is reported as `skipped`.
 */
async function refreshForJob({ gogProducts = [], epicGames = [], options = {} } = {}) {
  if (options.client) return { skipped: 'injected_client' };
  if (options.wikidata === false || options.secondaryLinks === false) {
    return { skipped: 'disabled' };
  }
  if (String(process.env.KINOBOXD_GAMES_WD || '').trim().toLowerCase() === 'off') {
    return { skipped: 'disabled' };
  }
  const { gogSlugs, epicSlugs } = collectSlugs({ gogProducts, epicGames });
  const titleCandidates = collectTitleCandidates(epicGames);
  if (!gogSlugs.length && !epicSlugs.length && !titleCandidates.length) {
    return { skipped: 'no_slugs' };
  }
  const common = {
    fetchImpl: options.fetchImpl,
    endpoint: options.wdqsEndpoint,
    force: options.force === true,
  };
  try {
    let report = { queries: 0, resolved: 0, cached: 0, skipped: null, errors: [] };
    if (gogSlugs.length || epicSlugs.length) {
      report = await fetchSecondaryLinks({ gogSlugs, epicSlugs }, common);
    }
    // Separate pass: a title is not a P6278 identity, so it can only fill a
    // year that the slug pass left empty (the Alan Wake 2 case).
    let titleReport = { queries: 0, resolved: 0, ambiguous: 0, skipped: null, errors: [] };
    if (titleCandidates.length && !report.skipped) {
      titleReport = await fetchSecondaryTitleLinks({ epicGames }, common);
    }
    return {
      gogSlugs: gogSlugs.length,
      epicSlugs: epicSlugs.length,
      epicTitles: titleCandidates.length,
      queries: report.queries + titleReport.queries,
      titleQueries: titleReport.queries,
      resolved: report.resolved + titleReport.resolved,
      titleResolved: titleReport.resolved,
      titleAmbiguous: titleReport.ambiguous,
      cached: report.cached,
      skipped: titleReport.skipped || report.skipped || null,
      errors: [...report.errors, ...titleReport.errors].slice(0, 5),
    };
  } catch (err) {
    return { skipped: 'error', errors: [String((err && err.code) || 'failed')] };
  }
}

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

  // A QID (or a base appid) must name exactly one work: two works claiming the
  // same identity is a data conflict, not a match, so the key is dropped.
  const registerIdentity = (map, ambiguous, key, workKey) => {
    if (key == null || key === '') return;
    const value = String(key);
    if (map.has(value) && map.get(value) !== workKey) ambiguous.add(value);
    else map.set(value, workKey);
  };

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
    });
  }
  for (const title of ambiguousTitles) titleToWork.delete(title);
  for (const title of ambiguousCoreTitles) coreTitleToWork.delete(title);
  for (const qid of ambiguousQids) qidToWork.delete(qid);
  for (const appid of ambiguousBaseAppids) baseAppidToWork.delete(appid);

  /* ------------------------------ bridge ------------------------------ */
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
    if (!workKey) {
      workKey = resolveByTitle(product.title);
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
      workKey = resolveByTitle(game.name);
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

/* ------------------------------------------------------------------ */
/* Epic read model (was `epic-layer.js`)                               */
/* ------------------------------------------------------------------ */

const CONTRACT_VERSION = 1;

function minutesToHours(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value)) return null;
  return Math.round((value / 60) * 10) / 10;
}

/**
 * Steam side of the contract: the **raw library sum** (`totalMinutes` of every
 * entry). `/api/games/stats` reports the filtered journal total (games only,
 * canonical works), which can be a few hours lower — the stats payload
 * therefore overrides this field with its own `totalHours` instead of copying
 * the layer value.
 */
function steamSide(ownerKey) {
  const match = /^steam-(\d{17})$/.exec(String(ownerKey == null ? '' : ownerKey).trim());
  if (!match) return { hours: null, owned: null };
  const library = gameCache.getLibrary(match[1]);
  if (!library) return { hours: null, owned: null };
  const hours = Number.isFinite(Number(library.totalMinutes))
    ? minutesToHours(library.totalMinutes)
    : null;
  const owned = Number.isFinite(Number(library.game_count))
    ? Number(library.game_count)
    : Array.isArray(library.games)
      ? library.games.length
      : null;
  return { hours, owned };
}

function tokenStatus(token, profile) {
  if (!token) return 'not_connected';
  if (profile && profile.disconnectedAt) return 'not_connected';
  if (token.lastAuthError) return 'auth_expired';
  return 'connected';
}

function libraryStatus(tokenStatusValue, library) {
  if (tokenStatusValue === 'not_connected' || tokenStatusValue === 'auth_expired') {
    return tokenStatusValue;
  }
  if (!library) return 'not_imported';
  return gameCache.isFresh(library, epicCache.epicLibraryTtlMs()) ? 'ok' : 'stale';
}

function joinGames(library, playtime, catalog) {
  const games = Array.isArray(library && library.games) ? library.games : [];
  // One file read for the whole library: a slug discovered by the store-metadata
  // job (validated CMS title probe) is the last resort before `null`.
  let slugOverrides = {};
  try {
    slugOverrides = epicCache.readSlugOverrides();
  } catch (err) {
    slugOverrides = {};
  }
  // `productmapping` keys are appNames **or namespaces**; an Epic exclusive
  // (Alan Wake 2) is present only under its namespace key. Read once.
  let productMapping = {};
  try {
    const mapping = epicCache.getProductMapping();
    productMapping = mapping && mapping.byAppName ? mapping.byAppName : {};
  } catch (err) {
    productMapping = {};
  }
  return games.map((game) => {
    const meta = (game.catalogItemId && catalog[game.catalogItemId]) || null;
    const tracked = epic.playtimeForGame(game, playtime);
    const name =
      (meta && meta.title) || game.name || game.appName || game.entitlementName || null;
    const mappedSlug =
      (game.appName && productMapping[game.appName]) ||
      (game.namespace && productMapping[game.namespace]) ||
      null;
    const discovered =
      game.catalogItemId && slugOverrides[game.catalogItemId]
        ? slugOverrides[game.catalogItemId].slug || null
        : null;
    return {
      source: 'epic',
      appName: game.appName || null,
      catalogItemId: game.catalogItemId || null,
      namespace: game.namespace || null,
      productId: game.productId || null,
      sandboxType: game.sandboxType || null,
      platforms: Array.isArray(game.platforms) ? game.platforms : [],
      acquisitionDate: game.acquisitionDate || null,
      entitlementName: game.entitlementName || null,
      entitlementType: game.entitlementType || null,
      sources: Array.isArray(game.sources) ? game.sources : [],
      // Catalog metadata (global) or the productmapping fallback written by
      // the importer; `null` means "not fetched", never a fabricated title.
      name,
      title: meta ? meta.title || null : null,
      slug: (meta && meta.slug) || game.slug || mappedSlug || discovered || null,
      developer: meta ? meta.developer || null : null,
      publisher: meta ? meta.publisher || null : null,
      releaseDate: meta ? meta.releaseDate || null : null,
      metadataSource: meta
        ? 'epic-catalog'
        : game.slug || mappedSlug
          ? 'epic-productmapping'
          : discovered
            ? 'epic-slug-probe'
            : null,
      // Seconds stay available for the integration; minutes/hours are the
      // normalized units (Epic `totalTime` is seconds, §14.2).
      totalTimeSec: tracked ? tracked.totalTimeSec : null,
      totalMinutes: tracked ? tracked.totalMinutes : null,
      hours: tracked ? epic.secondsToHours(tracked.totalTimeSec) : null,
      playtimeKnown: Boolean(tracked),
      lastPlayed: null, // not in Epic's playtime model — never invented
    };
  });
}

function toExportedGame(game, accountId, ownerKey) {
  return {
    source: 'epic',
    accountId,
    owner: ownerKey || null,
    appName: game.appName || null,
    catalogItemId: game.catalogItemId || null,
    namespace: game.namespace || null,
    slug: game.slug || null,
    name: game.name || null,
    developer: game.developer || null,
    publisher: game.publisher || null,
    totalTimeSec: game.totalTimeSec,
    totalMinutes: game.totalMinutes,
    hours: game.hours,
    platforms: game.platforms,
    // M6c fills these through the Wikidata bridge (P6278/P2725/P1733) and
    // unions by `workKey`. The Epic layer never guesses a work key.
    workKey: null,
    steamAppId: null,
  };
}

/**
 * Build the Epic read model for one owner (or one account).
 *
 * Options: `{ ownerKey, accountId }` — `ownerKey` is a Steam profile token
 * (`steam-<steamid64>`), `accountId` an Epic account id. When both are given
 * they must agree with the stored binding.
 */
async function buildEpicLayer(options = {}) {
  const { ownerKey, accountId } = resolveOwner(options);
  const steam = steamSide(ownerKey);
  const libraries = ownerKey ? epicCache.librariesForOwner(ownerKey) : [];
  if (!accountId) return emptyLayer(ownerKey, libraries, steam);
  // Only the redacted summary is needed here (presence/expiry/auth error):
  // the layer never reads or returns a token value.
  const token = tokenStore.readTokenSummarySync(accountId);
  return composeLayer({ ownerKey, accountId, token, steam, libraries });
}

/**
 * Synchronous variant for the `/stats` builder (the route is synchronous and
 * polled by the UI). Same numbers as `buildEpicLayer`, but no `exportedGames`
 * array is materialized — the stats payload only needs the aggregate and the
 * per-game `secondaryWorks` entries, and copying 300+ objects on every poll is
 * waste. The contract version and all `hoursBySource`/`ownedBySource` fields
 * are identical, so the UI cannot see two different answers.
 */
function buildEpicLayerSync(options = {}) {
  const { ownerKey, accountId } = resolveOwner(options);
  const steam = steamSide(ownerKey);
  const libraries = ownerKey ? epicCache.librariesForOwner(ownerKey) : [];
  if (!accountId) {
    const { exportedGames, ...rest } = emptyLayer(ownerKey, libraries, steam);
    return rest;
  }
  const token = tokenStore.readTokenSummarySync(accountId);
  const { exportedGames, ...rest } = composeLayer({ ownerKey, accountId, token, steam, libraries });
  return rest;
}

/**
 * The `sources.epic` block of the games payload — the same shape as
 * `sources.gog`, so the «Источники» widget and the «Подключения» screen read
 * both secondary libraries through one contract. Numbers stay per source.
 */
function epicSourceBlock(layer) {
  if (!layer) {
    return {
      configured: false,
      connected: false,
      status: 'not_connected',
      accountId: null,
      displayName: null,
      ownerProfile: null,
      lastImportAt: null,
      libraryFetchedAt: null,
      playtimeFetchedAt: null,
      productCount: null,
      hours: null,
      stale: false,
    };
  }
  const status = layer.status || 'not_connected';
  return {
    configured: status !== 'not_connected',
    connected: status !== 'not_connected' && status !== 'auth_expired',
    status,
    accountId: layer.accountId || null,
    displayName: (layer.account && layer.account.displayName) || null,
    ownerProfile: layer.owner || null,
    lastImportAt: (layer.meta && layer.meta.fetchedAt) || null,
    libraryFetchedAt: (layer.meta && layer.meta.fetchedAt) || null,
    playtimeFetchedAt: (layer.meta && layer.meta.playtimeFetchedAt) || null,
    productCount: layer.summary ? layer.summary.ownedCount : null,
    hours: layer.summary ? layer.summary.hours : null,
    // A stale snapshot keeps its numbers and its date, never a zero.
    stale: status === 'stale' || status === 'auth_expired' || status === 'not_imported',
  };
}

/**
 * Epic games as `secondaryWorks` entries. Epic has **no** work identity yet
 * (the Wikidata bridge P6278/P2725/P1733 is M6c), so every game is its own
 * secondary entry with `workKey: null` and is never merged into a Steam work.
 * The shape mirrors the GOG entries so the UI renders one list.
 */
function epicSecondaryWorks(layer, { limit = 200 } = {}) {
  const games = Array.isArray(layer && layer.games) ? layer.games : [];
  return games
    .filter((game) => game && game.name)
    .slice(0, limit)
    .map((game) => ({
      workKey: null,
      source: 'epic',
      name: game.name,
      sources: ['epic'],
      ownedOn: ['epic'],
      storeIds: { steam: null, gog: null, epic: game.catalogItemId || null },
      hoursBySource: {
        steam: null,
        gog: null,
        epic: game.totalMinutes == null ? null : game.totalMinutes,
      },
      primaryAppid: null,
      gog: null,
      epic: {
        accountId: (layer && layer.accountId) || null,
        appName: game.appName || null,
        catalogItemId: game.catalogItemId || null,
        slug: game.slug || null,
        namespace: game.namespace || null,
        platforms: game.platforms || [],
        image: null,
      },
      matchedBy: 'none',
      confidence: 'single',
    }));
}

function resolveOwner(options = {}) {
  const ownerKey = options.ownerKey ? String(options.ownerKey).trim() : null;
  let accountId = options.accountId ? String(options.accountId).trim() : null;
  if (!accountId && ownerKey) accountId = epicCache.epicAccountForOwner(ownerKey);
  return { ownerKey, accountId };
}

function emptyLayer(ownerKey, libraries, steam) {
  return {
    source: 'epic',
    contractVersion: CONTRACT_VERSION,
    owner: ownerKey,
    accountId: null,
    status: 'not_connected',
    account: null,
    libraries,
    summary: null,
    hoursBySource: { steam: steam.hours, epic: null },
    ownedBySource: { steam: steam.owned, epic: null },
    games: [],
    exportedGames: [],
    meta: {
      note:
        'Epic не подключён: часы Epic отсутствуют (null), а не 0. ' +
        'Steam-журнал не меняется.',
    },
  };
}

/**
 * Assemble the layer from already-read cache documents. Pure apart from the
 * cache reads inside; the token arrives as a **redacted summary**, so no token
 * value ever reaches this function.
 */
function composeLayer({ ownerKey, accountId, token, steam, libraries }) {
  const profile = epicCache.getEpicProfile(accountId);
  const library = epicCache.getEpicLibrary(accountId);
  const playtime = epicCache.getEpicPlaytime(accountId);
  const tokenState = tokenStatus(token, profile);
  const status = libraryStatus(tokenState, library);

  if (ownerKey && profile && profile.ownerKey && profile.ownerKey !== ownerKey) {
    throw Object.assign(
      new Error(
        `Epic-аккаунт ${accountId} привязан к другому владельцу (${profile.ownerKey}); ` +
          'библиотеки двух людей не сливаются (§14.4).'
      ),
      { code: 'owner_mismatch', status: 400 }
    );
  }

  const catalogIds = library
    ? (library.games || []).map((game) => game.catalogItemId).filter(Boolean)
    : [];
  const catalog = epicCache.listEpicCatalogItems(catalogIds);
  const games = library ? joinGames(library, playtime, catalog) : [];
  const knownPlaytime = games.filter((game) => game.playtimeKnown);
  const matchedSeconds = knownPlaytime.reduce(
    (sum, game) => sum + (Number(game.totalTimeSec) || 0),
    0
  );
  const hours = playtime ? epic.secondsToHours(playtime.totalSeconds) : null;
  const ownedCount = library ? games.length : null;
  const playedCount = knownPlaytime.filter((game) => game.totalMinutes > 0).length;
  const withMetadata = games.filter((game) => game.metadataSource).length;

  const exportedGames = games.map((game) => toExportedGame(game, accountId, ownerKey || profile && profile.ownerKey));

  return {
    source: 'epic',
    contractVersion: CONTRACT_VERSION,
    owner: ownerKey || (profile && profile.ownerKey) || null,
    accountId,
    status,
    account: {
      accountId,
      displayName: (profile && profile.displayName) || (token && token.displayName) || null,
      label: (profile && profile.label) || null,
      connectedAt: (profile && profile.connectedAt) || null,
      importedAt: (profile && profile.importedAt) || null,
      disconnectedAt: (profile && profile.disconnectedAt) || null,
      authMethod: (token && token.authMethod) || null,
      token: token || null,
    },
    libraries,
    summary: library
      ? {
          ownedCount,
          playedCount,
          unplayedCount: ownedCount == null ? null : ownedCount - playedCount,
          hours,
          totalTimeSec: playtime ? playtime.totalSeconds : null,
          totalMinutes: playtime ? playtime.totalMinutes : null,
          // Explicit names for the integration: Epic is a secondary library,
          // counted separately from Steam (§14.4 rules 2–4).
          externalOwnedCount: ownedCount,
          externalHours: hours,
          libraryExternalNumberCount: ownedCount,
          matchedPlaytimeSeconds: matchedSeconds,
          playtimeCoverage:
            ownedCount && knownPlaytime.length
              ? Math.round((knownPlaytime.length / ownedCount) * 1000) / 10
              : 0,
        }
      : null,
    hoursBySource: { steam: steam.hours, epic: hours },
    ownedBySource: { steam: steam.owned, epic: ownedCount },
    games,
    exportedGames,
    meta: {
      contractVersion: CONTRACT_VERSION,
      fetchedAt: (library && library.fetchedAt) || null,
      playtimeFetchedAt: (playtime && playtime.fetchedAt) || null,
      libraryFresh: library ? gameCache.isFresh(library, epicCache.epicLibraryTtlMs()) : false,
      playtimeFresh: playtime ? gameCache.isFresh(playtime, epicCache.epicPlaytimeTtlMs()) : false,
      catalogCoverage:
        ownedCount && withMetadata
          ? Math.round((withMetadata / ownedCount) * 1000) / 10
          : 0,
      counts: (library && library.counts) || null,
      warnings: (library && Array.isArray(library.warnings) ? library.warnings : []).slice(),
      units: { totalTimeSec: 'seconds', totalMinutes: 'minutes', hours: 'hours (1 decimal)' },
    },
  };
}

/** Status-only view: no per-game arrays (for the «Подключения» slot). */
async function buildEpicSources(ownerKey) {
  const layer = await buildEpicLayer({ ownerKey });
  return {
    source: 'epic',
    contractVersion: layer.contractVersion,
    owner: layer.owner,
    status: layer.status,
    account: layer.account,
    libraries: layer.libraries,
    summary: layer.summary,
    hoursBySource: layer.hoursBySource,
    ownedBySource: layer.ownedBySource,
    meta: layer.meta,
  };
}

/**
 * Last-resort release year for a GOG/Epic detail whose store — and, for Epic,
 * catalog — answer carried no date (Alan Wake 2: `genresOk true`,
 * `yearHas false`). The value is the `P577` of the item the store slug resolves
 * to in the identity bridge (`cache-games/links/secondary.json`, written by
 * `fetchSecondaryLinks()` in this module); this function only **reads** that
 * cache and never calls WDQS.
 *
 * Rules, all hard:
 *   - only an **empty** `releaseYear` is filled — a store/catalog year is never
 *     replaced;
 *   - `releaseDate` is taken only for a **day**-precision statement, so a
 *     month/year precision cannot become a fake day;
 *   - provenance is `releaseDateSource: 'wikidata'` (the union exposes it as
 *     `releaseYearSource`); the store's own `storeReleaseDate` is untouched;
 *   - no cached entry / no QID / no P577 → the document is returned unchanged,
 *     i.e. the work stays honestly `partial` (no invented year, no extra
 *     request loop).
 *
 * Since 03.11.2026 the same entry also carries the title map's `P136` line for
 * **Epic** works: when the slug entry and the title entry name the same QID and
 * the slug entry has no genres, the title entry's (sanitized) genres are merged
 * in. A date on the slug entry is not a reason to drop them — the genre axis
 * and the year axis are independent facts of one item.
 */
function resolveWikidataEntry(data, options = {}) {
  const store = options.store;
  const slug = options.slug || data.slug;
  if (!store || !slug) return null;
  try {
    let entry = readSecondaryLink(store, slug, options);
    // A slug entry is the trustworthy `P6278`/`P2725` identity. The title map
    // is a **facts-only** fallback: it is used when there is no slug entry at
    // all (Alan Wake 2), or when both name the same QID and the slug entry has
    // no date. Two different QIDs are never mixed.
    const titleEntry = readSecondaryTitleLink(store, slug, options);
    if (titleEntry && titleEntry.qid) {
      const slugQid = entry && entry.qid ? String(entry.qid) : null;
      const titleQid = String(titleEntry.qid);
      const slugHasDate = Boolean(entry && entry.releaseYear != null);
      if (!slugQid) {
        // No slug identity at all: the title answer is the only evidence.
        entry = { ...(entry || {}), ...titleEntry, matchedBy: 'title' };
      } else if (slugQid === titleQid) {
        if (!slugHasDate) {
          entry = { ...entry, ...titleEntry, matchedBy: 'title' };
        } else {
          // The slug entry names the item, the title answer is a *fact* of the
          // same item: P136 is a metadata line, never an identity. A date on
          // the slug entry says nothing about the genre axis (Alan Wake 2: the
          // slug entry carries `P577` and no genres, the title entry carries
          // the genres), so an empty list is filled here — identity (`qid`),
          // `matchedBy`, `confidence` and every existing value stay as they
          // are.
          const slugGenres = Array.isArray(entry.genres) ? entry.genres : [];
          if (!slugGenres.length) {
            const genres = sanitizeEpicGenres(
              Array.isArray(titleEntry.genres) ? titleEntry.genres : []
            );
            if (genres.length) entry = { ...entry, genres };
          }
        }
      }
    }
    return entry;
  } catch (err) {
    return null;
  }
}

/** Year-only view of the bridged Wikidata facts (kept for GOG and old callers). */
function applyWikidataYear(data, options = {}) {
  if (!data || data.releaseYear != null) return data;
  const entry = resolveWikidataEntry(data, options);
  if (
    !entry ||
    !entry.qid ||
    entry.releaseDateSource !== 'wikidata' ||
    entry.releaseYear == null
  ) {
    return data;
  }
  return {
    ...data,
    releaseYear: entry.releaseYear,
    releaseDate: entry.releaseDate || null,
    releaseDateSource: 'wikidata',
    // Honest provenance: a title match is weaker than a store-slug match.
    releaseYearMatchedBy: entry.matchedBy || 'slug',
  };
}

/**
 * Both facts a bridged Wikidata item can supply for a store-exclusive detail:
 * the release year (`P577`, only when empty) and the genre line (`P136`, only
 * when empty). Store/catalog values are never replaced; an Epic document
 * without a genre line (Alan Wake 2) receives `genresSource: 'wikidata'`.
 * Genres stay in the detail document — they are not written into the identity
 * bridge entry, so a title match can never become a P6278/P2725 link.
 */
function applyWikidataFacts(data, options = {}) {
  if (!data) return data;
  const entry = resolveWikidataEntry(data, options);
  if (!entry || !entry.qid) return data;
  let next = data;
  if (
    next.releaseYear == null &&
    entry.releaseDateSource === 'wikidata' &&
    entry.releaseYear != null
  ) {
    next = {
      ...next,
      releaseYear: entry.releaseYear,
      releaseDate: entry.releaseDate || null,
      releaseDateSource: 'wikidata',
      releaseYearMatchedBy: entry.matchedBy || 'slug',
    };
  }
  const hasGenres = Array.isArray(next.genres) && next.genres.length > 0;
  if (!hasGenres && next.source === 'epic') {
    const genres = sanitizeEpicGenres(Array.isArray(entry.genres) ? entry.genres : []);
    if (genres.length) {
      next = { ...next, genres, genresSource: 'wikidata' };
    }
  }
  return next;
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
 * The detail document of one union entry: the priority store first (GOG, then
 * Epic), the other store only when the priority store has **no** document.
 * A work owned on both stores therefore still receives its product page facts
 * instead of silently keeping the library-snapshot fallback.
 */
function detailForEntry(entry, index) {
  const keys = [];
  if (entry && entry.gog && entry.gog.gogGameId) keys.push(`gog:${entry.gog.gogGameId}`);
  if (entry && entry.epic && entry.epic.slug) keys.push(`epic:${entry.epic.slug}`);
  for (const key of keys) {
    if (index[key]) return index[key];
  }
  return null;
}

/**
 * Fill the union entries from the detail cache. **Additive and never
 * destructive** for the fields that only a Steam card can own: a Steam-derived
 * value always wins (Steam `details` are read first by `stats.js`), and only an
 * empty field is filled. Two documented exceptions, both about provenance:
 *
 *   1. a release year that came from a **store snapshot** (`gog-library` /
 *      `epic-library`) — those dates are the store listing date, so the
 *      product's own `globalReleaseDate` replaces them;
 *   2. `developers`/`publishers` that came from a **weak fallback** — the
 *      library snapshot (`gog-catalog`) or the Epic catalog bulk
 *      (`epic-catalog`). Epic's catalog `developer` field is the
 *      seller/distributor (Alan Wake 2: «Epic Games Publishing»), not the
 *      studio, so the product page (CMS `meta.developer` →
 *      `about.developerAttribution`, `server/games/secondary/normalize.js`)
 *      is the authority and **replaces** such a value (04.11.2026).
 *
 * Company lists are never *merged* across stores: the union keeps one list per
 * work, and the detail document of the priority store (`detailForEntry`: GOG
 * first, then Epic — the same order genres/year use) is the one that wins.
 * Merging GOG and Epic lists would re-introduce the very bug this fixes (an
 * Epic catalogue seller glued to a GOG studio). An entry whose
 * `developersSource` is unknown or Steam-derived is left untouched, and an
 * empty detail list changes nothing (the fallback stays, honest gap).
 *
 * Returns the number of entries that received at least one field.
 */
function enrichUnionWithDetails(union, index) {
  if (!union || !Array.isArray(union.works) || !index) return 0;
  let touched = 0;
  for (const entry of union.works) {
    const detail = detailForEntry(entry, index);
    if (!detail) continue;
    let changed = false;
    // The detail's own provenance label: `gog-store`/`epic-store` is what
    // `metadataSources` already records for this document.
    const storeSource = detail.source === 'epic' ? 'epic-store' : 'gog-store';
    const weakDevelopers =
      entry.developersSource === 'epic-catalog' || entry.developersSource === 'gog-catalog';
    const weakPublishers =
      entry.publishersSource === 'epic-catalog' || entry.publishersSource === 'gog-catalog';
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
    if (detail.developers && detail.developers.length) {
      const nextDevelopers = uniqueStringList(detail.developers);
      // Fill an empty list, or replace a weak fallback (`epic-catalog` /
      // `gog-catalog`). A Steam-derived list has no marker and is never touched.
      if (!(entry.developers && entry.developers.length) || weakDevelopers) {
        if (!sameStringList(entry.developers, nextDevelopers)) {
          entry.developers = nextDevelopers;
          changed = true;
        }
        // The value may be identical (the catalogue seller *is* the publisher)
        // while the provenance is not: record the store that confirmed it.
        if (entry.developersSource !== storeSource) {
          entry.developersSource = storeSource;
          changed = true;
        }
      }
    }
    if (detail.publishers && detail.publishers.length) {
      const nextPublishers = uniqueStringList(detail.publishers);
      if (!(entry.publishers && entry.publishers.length) || weakPublishers) {
        if (!sameStringList(entry.publishers, nextPublishers)) {
          entry.publishers = nextPublishers;
          changed = true;
        }
        if (entry.publishersSource !== storeSource) {
          entry.publishersSource = storeSource;
          changed = true;
        }
      }
    }
    const metadataSource = storeSource;
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
      // (year **and** genres), never the mere existence of a file. Computed
      // from the (read-sanitized) document, so a stale bucket genre such as
      // «Public» cannot keep a work «complete» on the strength of a persisted
      // marker written before the filter existed.
      yearHas: flags.yearHas,
      genresOk: flags.genresOk,
      metaStatus: flags.metaStatus,
    };
    if (changed) touched++;
  }
  return touched;
}

module.exports = {
  // titles / slugs / edition markers
  EDITION_SUFFIXES,
  normalizeTitle,
  normalizeSlug,
  slugsOfLink,
  buildGogUnion,
  // identity bridge
  WDQS,
  BATCH_SIZE,
  CACHE_PATH,
  SecondaryIdentityError,
  buildBridgeQuery,
  parseBridgeResponse,
  titleVariants,
  buildTitleQuery,
  wikidataGenreName,
  parseTitleResponse,
  collectTitleCandidates,
  isSettledEntry,
  isSettledTitleEntry,
  emptyEntry,
  readSecondaryLinks,
  readSecondaryLink,
  readSecondaryTitleLinks,
  readSecondaryTitleLink,
  readCache,
  writeCache,
  fetchSecondaryLinks,
  fetchSecondaryTitleLinks,
  collectSlugs,
  refreshForJob,
  // union
  yearOfDate,
  genreNames,
  flattenGogSnapshots,
  buildSecondaryUnion,
  // Epic read model
  CONTRACT_VERSION,
  buildEpicLayer,
  buildEpicLayerSync,
  buildEpicSources,
  epicSourceBlock,
  epicSecondaryWorks,
  steamSide,
  minutesToHours,
  // store documents
  applyWikidataYear,
  applyWikidataFacts,
  detailKeyForEntry,
  enrichUnionWithDetails,
};
