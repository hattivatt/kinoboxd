'use strict';

/*
 * Wikidata enrichment layer.
 *
 * Films are looked up by their IMDb id (P345) in batches through the Wikidata
 * Query Service (WDQS) and the result is persisted next to the other caches in
 * cache/wd-tags.json:
 *
 *   {
 *     "version": 1,
 *     "updatedAt": "2026-10-23T...",
 *     "labels": { "Q7725634": "literary work", ... },   // P144 type labels
 *     "imdb": { "tt0120735": <tag>, ... },
 *     "tmdb": { "100": <tag>, ... }                     // P4947 fallback
 *   }
 *
 * A <tag> is:
 *
 *   {
 *     "found": true,
 *     "item": "Q164716",          // Wikidata item (P345 match)
 *     "genres": ["Q...", ...],    // P136
 *     "colors": ["Q...", ...],    // P462
 *     "movements": ["Q...", ...], // P135
 *     "basedOn": ["Q...", ...],   // P144 source works
 *     "basedTypes": ["Q...", ...],// P31 of those works
 *     "basedClasses": ["book"],   // resolved source classes (see below)
 *     "checkedAt": "2026-10-23T..."
 *   }
 *
 * Entries for films that have no Wikidata item are stored as
 * `{ found: false, item: null, ... }`, so a repeated backfill is a no-op
 * instead of hammering WDQS forever. WIKIDATA_REFRESH=1 forces a refetch.
 *
 * P144 source classes (priority matches the task's taxonomy rules):
 *   remake > book > comic > play > video-game
 * "remake" means the source work is itself a film (a remake); television
 * sources are deliberately not promoted to an origin category.
 */

const fs = require('fs');
const path = require('path');

const cache = require('./cache');

const TAGS_PATH = path.join(cache.CACHE_DIR, 'wd-tags.json');
const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
const LABEL_ENDPOINT = 'https://www.wikidata.org/w/api.php';
const USER_AGENT =
  'kinoboxd/1.0 (https://github.com/hattivatt/kinoboxd); contact: github issue';

const BATCH_SIZE = 450;
const LABEL_BATCH_SIZE = 50;
const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;
const REQUEST_TIMEOUT_MS = 120000;

const counters = {
  requests: 0,
  retries: 0,
  rateLimited: 0,
  errors: 0,
  labelRequests: 0,
  batches: 0,
};

/* ------------------------------------------------------------------ */
/* P144 type classification                                            */
/* ------------------------------------------------------------------ */

/*
 * Wikidata classes observed as P144 source types in the local corpus (see the
 * research notes); the label lists are the vocabulary used by
 * /tmp/kb/p144_analyze.js. A few common ids that were not present in the
 * current sample are included so future cache refreshes classify correctly.
 */
const TYPE_GROUP_IDS = {
  BOOK: [
    'Q571', // book
    'Q699', // fairy tale
    'Q8261', // novel
    'Q127956', // short story
    'Q14974', // novella
    'Q277759', // book series
    'Q867335', // literary cycle
    'Q1667921', // novel series
    'Q2831984', // comic book album
    'Q7725634', // literary work
    'Q8275050', // children's book
    'Q47461344', // written work
  ],
  COMIC: [
    'Q1114461', // comics character
    'Q725377', // graphic novel
    'Q838795', // comic strip
    'Q1760610', // comic book
    'Q213369', // webcomic
    'Q14406742', // comic book series
    'Q21198342', // manga series
  ],
  PLAY: [
    'Q25379', // play
    'Q116476516', // dramatic work
    'Q58483083', // dramatico-musical work
  ],
  FILM: [
    'Q11424', // film
    'Q24856', // film series
    'Q24862', // short film
    'Q202866', // animated film
    'Q17517379', // animated short film
  ],
  VG: [
    'Q7889', // video game
    'Q7058673', // video game series
    'Q141546978', // video game franchise
  ],
};

const TYPE_GROUP_BY_QID = new Map();
for (const [group, ids] of Object.entries(TYPE_GROUP_IDS)) {
  for (const qid of ids) TYPE_GROUP_BY_QID.set(qid, group);
}

/* The exact label lists p144_analyze.js used. Labels are fetched once and
 * cached in wd-tags.json, so classification follows the researched rules. */
const TYPE_GROUP_LABELS = {
  BOOK: [
    'novel',
    'book',
    'literary work',
    'written work',
    'short story',
    'novella',
    'poem',
    'autobiography',
    'memoir',
    'biography',
    "children's book",
    'book series',
    'novel series',
    'literary cycle',
    'fairy tale',
    'comic book album',
  ],
  COMIC: [
    'comic book',
    'comics',
    'comic strip',
    'graphic novel',
    'manga',
    'manga series',
    'webcomic',
    'comic book series',
    'comics character',
    'comic book character',
  ],
  PLAY: ['play', 'dramatic work', 'theatre', 'musical play', 'dramatico-musical work'],
  FILM: ['film', 'animated film', 'short film', 'animated short film', 'film series', 'remake'],
  VG: ['video game', 'video game series', 'video game franchise', 'visual novel'],
};

const LABEL_TO_GROUP = new Map();
for (const [group, labels] of Object.entries(TYPE_GROUP_LABELS)) {
  for (const label of labels) LABEL_TO_GROUP.set(label, group);
}

/* Origin keys used by taxonomy.js. The priority order is the task's rule. */
const GROUP_TO_ORIGIN = {
  FILM: 'remake',
  BOOK: 'book',
  COMIC: 'comic',
  PLAY: 'play',
  VG: 'video-game',
};
const WIKIDATA_ORIGIN_PRIORITY = ['remake', 'book', 'comic', 'play', 'video-game'];

function groupOfType(typeQid, labels) {
  const qid = String(typeQid || '');
  if (!qid) return null;
  if (TYPE_GROUP_BY_QID.has(qid)) return TYPE_GROUP_BY_QID.get(qid);
  const label = labels && labels[qid] ? String(labels[qid]).toLowerCase() : '';
  return label ? LABEL_TO_GROUP.get(label) || null : null;
}

/**
 * Resolve the P144 source classes for a tag. Returns a de-duplicated list in
 * priority order (remake > book > comic > play > video-game).
 */
function classifyBasedOn(types, labels) {
  const groups = [];
  for (const type of Array.isArray(types) ? types : []) {
    const group = groupOfType(type, labels);
    if (!group) continue;
    const origin = GROUP_TO_ORIGIN[group];
    if (origin && !groups.includes(origin)) groups.push(origin);
  }
  groups.sort((a, b) => {
    const ai = WIKIDATA_ORIGIN_PRIORITY.indexOf(a);
    const bi = WIKIDATA_ORIGIN_PRIORITY.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  return groups;
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

let store = null;
let storeMtimeMs = -1;
let storeSize = -1;

function emptyStore() {
  return {
    version: 1,
    updatedAt: null,
    labels: {},
    imdb: {},
    tmdb: {},
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStore(parsed) {
  if (!isPlainObject(parsed)) return emptyStore();
  return {
    version: 1,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    labels: isPlainObject(parsed.labels) ? parsed.labels : {},
    imdb: isPlainObject(parsed.imdb) ? parsed.imdb : {},
    tmdb: isPlainObject(parsed.tmdb) ? parsed.tmdb : {},
  };
}

function readStoreFromDisk() {
  try {
    const raw = fs.readFileSync(TAGS_PATH, 'utf8');
    const stat = fs.statSync(TAGS_PATH);
    storeMtimeMs = stat.mtimeMs;
    storeSize = stat.size;
    if (!raw.trim()) return emptyStore();
    return normalizeStore(JSON.parse(raw));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[wikidata] could not read wd-tags.json (${err.message}); starting empty.`);
    }
    storeMtimeMs = -1;
    storeSize = -1;
    return emptyStore();
  }
}

function ensureLoaded() {
  if (!store) store = readStoreFromDisk();
  return store;
}

/**
 * Pick up a wd-tags.json written by the backfill CLI while the server is
 * running. Called once per stats build; mtime + size keep it cheap.
 */
function reloadIfChanged() {
  if (!store) {
    store = readStoreFromDisk();
    return;
  }
  let stat;
  try {
    stat = fs.statSync(TAGS_PATH);
  } catch (err) {
    if (err.code === 'ENOENT') {
      storeMtimeMs = -1;
      storeSize = -1;
      return;
    }
    return;
  }
  if (stat.mtimeMs !== storeMtimeMs || stat.size !== storeSize) {
    store = readStoreFromDisk();
  }
}

function persist() {
  ensureLoaded();
  store.updatedAt = new Date().toISOString();
  const tmp = `${TAGS_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
  fs.renameSync(tmp, TAGS_PATH);
  const stat = fs.statSync(TAGS_PATH);
  storeMtimeMs = stat.mtimeMs;
  storeSize = stat.size;
}

function fileBytes() {
  try {
    return fs.statSync(TAGS_PATH).size;
  } catch (err) {
    return 0;
  }
}

function normalizeImdbId(value) {
  const raw = String(value == null ? '' : value).trim();
  return /^tt\d+$/.test(raw) ? raw : null;
}

function normalizeTmdbId(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? String(Math.trunc(n)) : null;
}

/**
 * Tags for one film. IMDb is authoritative when the film has an IMDb id: a
 * negative IMDb result must NOT fall through to the TMDB index, because TMDB
 * movie/TV ids share one numeric namespace and a colliding entry could leak
 * the other kind's tags. The TMDB key is the P4947 fallback only for films
 * that have no IMDb id at all.
 */
function getTags(imdbId, tmdbId) {
  ensureLoaded();
  const imdb = normalizeImdbId(imdbId);
  if (imdb) {
    const tag = Object.prototype.hasOwnProperty.call(store.imdb, imdb)
      ? store.imdb[imdb]
      : null;
    return tag && tag.found !== false ? tag : null;
  }
  const tmdb = normalizeTmdbId(tmdbId);
  if (tmdb && Object.prototype.hasOwnProperty.call(store.tmdb, tmdb)) {
    const tag = store.tmdb[tmdb];
    if (tag && tag.found !== false) return tag;
  }
  return null;
}

function isChecked(imdbId, tmdbId) {
  ensureLoaded();
  const imdb = normalizeImdbId(imdbId);
  if (imdb && Object.prototype.hasOwnProperty.call(store.imdb, imdb)) return true;
  const tmdb = normalizeTmdbId(tmdbId);
  if (tmdb && Object.prototype.hasOwnProperty.call(store.tmdb, tmdb)) return true;
  return false;
}

function stats() {
  ensureLoaded();
  return {
    imdb: Object.keys(store.imdb).length,
    tmdb: Object.keys(store.tmdb).length,
    labels: Object.keys(store.labels).length,
    bytes: fileBytes(),
    updatedAt: store.updatedAt,
  };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(response) {
  const raw = response && response.headers ? response.headers.get('retry-after') : null;
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(MAX_BACKOFF_MS, seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.min(MAX_BACKOFF_MS, Math.max(0, date - Date.now()));
  return null;
}

function backoffMs(attempt, response) {
  const fromHeader = retryAfterMs(response);
  if (fromHeader != null) return fromHeader;
  const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  // Small jitter avoids synchronised retries from several workers.
  return Math.min(MAX_BACKOFF_MS, base + Math.floor(Math.random() * 500));
}

/**
 * POST is used instead of the GET form from the brief: 450 IMDb ids make the
 * query URL larger than WDQS' GET limit (HTTP 414). The endpoint and result
 * format are identical.
 */
async function querySparql(query, log = console.log) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    counters.requests++;
    let response = null;
    try {
      response = await fetch(SPARQL_ENDPOINT, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/sparql-results+json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ query, format: 'json' }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      lastError = err;
      counters.errors++;
      if (attempt === MAX_ATTEMPTS) break;
      const delay = backoffMs(attempt, null);
      counters.retries++;
      log(
        `[wikidata] network error (${err.message || err}); retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(delay / 1000)}s`
      );
      await sleep(delay);
      continue;
    }

    const text = await response.text();
    if (response.ok) {
      try {
        return JSON.parse(text);
      } catch (err) {
        lastError = new Error(`invalid JSON from WDQS: ${err.message}`);
        counters.errors++;
        if (attempt === MAX_ATTEMPTS) break;
        const delay = backoffMs(attempt, response);
        counters.retries++;
        log(`[wikidata] invalid JSON; retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(delay / 1000)}s`);
        await sleep(delay);
        continue;
      }
    }

    const status = response.status;
    const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
    lastError = new Error(`WDQS HTTP ${status}: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
    if (!retryable || attempt === MAX_ATTEMPTS) {
      counters.errors++;
      break;
    }
    if (status === 429) counters.rateLimited++;
    counters.retries++;
    const delay = backoffMs(attempt, response);
    log(
      `[wikidata] WDQS HTTP ${status}; retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(delay / 1000)}s`
    );
    await sleep(delay);
  }
  throw lastError || new Error('WDQS request failed');
}

/* ------------------------------------------------------------------ */
/* Query construction                                                  */
/* ------------------------------------------------------------------ */

function valuesClause(ids) {
  return ids.map((id) => JSON.stringify(String(id))).join(' ');
}

function concatExpr(variable) {
  return `(GROUP_CONCAT(DISTINCT ?${variable}; separator="|") AS ?${variable}s)`;
}

/** Query keyed by IMDb id (P345). */
function imdbQuery(imdbIds) {
  const values = valuesClause(imdbIds);
  return `SELECT ?imdb ?item ?genres ?colors ?movements ?basedOn ?basedTypes WHERE {
  {
    SELECT ?imdb ?item ${concatExpr('genre')} ${concatExpr('color')} ${concatExpr('movement')}
    WHERE {
      VALUES ?imdb { ${values} }
      ?item wdt:P345 ?imdb .
      OPTIONAL { ?item wdt:P136 ?genre }
      OPTIONAL { ?item wdt:P462 ?color }
      OPTIONAL { ?item wdt:P135 ?movement }
    } GROUP BY ?imdb ?item
  }
  OPTIONAL {
    SELECT ?imdb
      (GROUP_CONCAT(DISTINCT ?based; separator="|") AS ?basedOn)
      (GROUP_CONCAT(DISTINCT ?basedType; separator="|") AS ?basedTypes)
    WHERE {
      VALUES ?imdb { ${values} }
      ?item wdt:P345 ?imdb .
      OPTIONAL { ?item wdt:P144 ?based . OPTIONAL { ?based wdt:P31 ?basedType } }
    } GROUP BY ?imdb
  }
}`;
}

/** Query keyed by TMDB id (P4947) for films without an IMDb id. */
function tmdbQuery(tmdbIds) {
  const values = valuesClause(tmdbIds);
  return `SELECT ?tmdb ?item ?genres ?colors ?movements ?basedOn ?basedTypes WHERE {
  {
    SELECT ?tmdb ?item ${concatExpr('genre')} ${concatExpr('color')} ${concatExpr('movement')}
    WHERE {
      VALUES ?tmdb { ${values} }
      ?item wdt:P4947 ?tmdb .
      OPTIONAL { ?item wdt:P136 ?genre }
      OPTIONAL { ?item wdt:P462 ?color }
      OPTIONAL { ?item wdt:P135 ?movement }
    } GROUP BY ?tmdb ?item
  }
  OPTIONAL {
    SELECT ?tmdb
      (GROUP_CONCAT(DISTINCT ?based; separator="|") AS ?basedOn)
      (GROUP_CONCAT(DISTINCT ?basedType; separator="|") AS ?basedTypes)
    WHERE {
      VALUES ?tmdb { ${values} }
      ?item wdt:P4947 ?tmdb .
      OPTIONAL { ?item wdt:P144 ?based . OPTIONAL { ?based wdt:P31 ?basedType } }
    } GROUP BY ?tmdb
  }
}`;
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function entityId(uri) {
  const value = String(uri == null ? '' : uri).trim();
  if (!value) return null;
  const tail = value.split('/').pop();
  return /^Q\d+$/.test(tail) ? tail : null;
}

function splitConcat(value) {
  const raw = value && typeof value === 'object' ? value.value : value;
  if (!raw) return [];
  const out = [];
  for (const part of String(raw).split('|')) {
    const qid = entityId(part);
    if (qid && !out.includes(qid)) out.push(qid);
  }
  return out;
}

function emptyAccumulator() {
  return {
    item: null,
    items: [],
    itemScore: -1,
    genres: new Set(),
    colors: new Set(),
    movements: new Set(),
    basedOn: new Set(),
    basedTypes: new Set(),
  };
}

/**
 * Merge one WDQS row into an accumulator. The same IMDb id can be present on
 * several Wikidata items (bad data or a film/series pair); research merged
 * their signals and so do we instead of letting the last row win.
 */
function mergeRow(acc, row) {
  const item = entityId(row.item && row.item.value);
  if (item && !acc.items.includes(item)) acc.items.push(item);
  const before =
    acc.genres.size + acc.colors.size + acc.movements.size + acc.basedOn.size;
  for (const qid of splitConcat(row.genres)) acc.genres.add(qid);
  for (const qid of splitConcat(row.colors)) acc.colors.add(qid);
  for (const qid of splitConcat(row.movements)) acc.movements.add(qid);
  for (const qid of splitConcat(row.basedOn)) acc.basedOn.add(qid);
  for (const qid of splitConcat(row.basedTypes)) acc.basedTypes.add(qid);
  const after =
    acc.genres.size + acc.colors.size + acc.movements.size + acc.basedOn.size;
  // Prefer the item that actually carries the signals; ties keep the first.
  if (item && after > before && after > acc.itemScore) {
    acc.item = item;
    acc.itemScore = after;
  }
  return acc;
}

function tagFromAccumulator(acc, labels) {
  const basedTypes = [...acc.basedTypes].sort();
  return {
    found: true,
    item: acc.item || acc.items[0] || null,
    // Kept for diagnostics: duplicated P345 values are rare but real.
    items: acc.items.slice().sort(),
    genres: [...acc.genres].sort(),
    colors: [...acc.colors].sort(),
    movements: [...acc.movements].sort(),
    basedOn: [...acc.basedOn].sort(),
    basedTypes,
    basedClasses: classifyBasedOn(basedTypes, labels),
    checkedAt: new Date().toISOString(),
  };
}

function negativeTag() {
  return {
    found: false,
    item: null,
    items: [],
    genres: [],
    colors: [],
    movements: [],
    basedOn: [],
    basedTypes: [],
    basedClasses: [],
    checkedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* P144 type labels                                                    */
/* ------------------------------------------------------------------ */

async function fetchTypeLabels(typeIds, log = console.log) {
  const missing = [...new Set(typeIds)].filter((qid) => qid && !store.labels[qid]);
  for (let i = 0; i < missing.length; i += LABEL_BATCH_SIZE) {
    const chunk = missing.slice(i, i + LABEL_BATCH_SIZE);
    const url =
      `${LABEL_ENDPOINT}?action=wbgetentities&format=json&props=labels&languages=en%7Cru` +
      `&ids=${encodeURIComponent(chunk.join('|'))}`;
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      counters.labelRequests++;
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        for (const [qid, entity] of Object.entries(payload.entities || {})) {
          const labels = (entity && entity.labels) || {};
          const label = (labels.en && labels.en.value) || (labels.ru && labels.ru.value);
          if (label) store.labels[qid] = label;
        }
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < 3) {
          const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1));
          log(`[wikidata] label lookup failed (${err.message}); retry in ${delay / 1000}s`);
          await sleep(delay);
        }
      }
    }
    if (lastError) {
      log(`[wikidata] could not resolve ${chunk.length} P144 type label(s): ${lastError.message}`);
    }
  }
}

/** Recompute basedClasses for every stored tag (cheap, idempotent). */
function finalizeClasses(log = console.log) {
  ensureLoaded();
  const typeIds = new Set();
  const tags = [];
  for (const map of [store.imdb, store.tmdb]) {
    for (const tag of Object.values(map)) {
      if (!tag || !Array.isArray(tag.basedTypes) || !tag.basedTypes.length) continue;
      tags.push(tag);
      for (const type of tag.basedTypes) typeIds.add(type);
    }
  }
  if (!tags.length) return;
  const unresolved = [...typeIds].filter((qid) => !store.labels[qid]);
  if (unresolved.length) {
    // fetchTypeLabels is async; backfill awaits the async variant before
    // calling this. Server-side reads just use what is already cached.
    if (log) log(`[wikidata] ${unresolved.length} P144 type label(s) still unresolved`);
  }
  for (const tag of tags) {
    tag.basedClasses = classifyBasedOn(tag.basedTypes, store.labels);
  }
}

async function prepareClasses(log = console.log) {
  ensureLoaded();
  const typeIds = new Set();
  for (const map of [store.imdb, store.tmdb]) {
    for (const tag of Object.values(map)) {
      if (!tag || !Array.isArray(tag.basedTypes)) continue;
      for (const type of tag.basedTypes) typeIds.add(type);
    }
  }
  await fetchTypeLabels([...typeIds], log);
  finalizeClasses(null);
}

/* ------------------------------------------------------------------ */
/* Backfill                                                            */
/* ------------------------------------------------------------------ */

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function coverageOf(films) {
  const out = {
    movie: { total: 0, covered: 0, genres: 0, colors: 0, movements: 0, basedOn: 0 },
    tv: { total: 0, covered: 0, genres: 0, colors: 0, movements: 0, basedOn: 0 },
  };
  for (const film of films) {
    const bucket = out[film.kind === 'tv' ? 'tv' : 'movie'];
    bucket.total++;
    const tag = getTags(film.imdbId, film.tmdbId);
    if (!tag) continue;
    bucket.covered++;
    if (tag.genres && tag.genres.length) bucket.genres++;
    if (tag.colors && tag.colors.length) bucket.colors++;
    if (tag.movements && tag.movements.length) bucket.movements++;
    if (tag.basedOn && tag.basedOn.length) bucket.basedOn++;
  }
  return out;
}

function pct(part, total) {
  if (!total) return '0.0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

/**
 * Enrich the cached films.
 *
 * @param {Array<{tmdbId:number, kind:'movie'|'tv', imdbId:string|null, title?:string, year?:number|null}>} films
 * @param {{force?:boolean, log?:Function}} options
 */
async function backfill(films, options = {}) {
  const log = typeof options.log === 'function' ? options.log : console.log;
  const force =
    options.force === true || String(process.env.WIKIDATA_REFRESH || '') === '1';
  ensureLoaded();
  const startedAt = Date.now();
  const byImdb = new Map();
  const withoutImdb = [];
  for (const film of Array.isArray(films) ? films : []) {
    if (!film || !normalizeTmdbId(film.tmdbId)) continue;
    const imdb = normalizeImdbId(film.imdbId);
    if (imdb) {
      if (!byImdb.has(imdb)) byImdb.set(imdb, []);
      byImdb.get(imdb).push({ ...film, imdbId: imdb });
    } else {
      withoutImdb.push(film);
    }
  }

  // Resolve P144 type labels from previous runs before deciding what to skip.
  await prepareClasses(log);

  const pendingImdb = [...byImdb.keys()].filter((imdb) => force || !Object.prototype.hasOwnProperty.call(store.imdb, imdb));
  const imdbBatches = chunk(pendingImdb, BATCH_SIZE);
  const results = { batches: 0, failedBatches: 0, rows: 0, errors: [] };

  log(
    `[wikidata] films=${films.length} with-imdb=${byImdb.size} without-imdb=${withoutImdb.length} ` +
      `pending-imdb=${pendingImdb.length} batches=${imdbBatches.length} batch-size=${BATCH_SIZE}` +
      `${force ? ' (forced refresh)' : ''}`
  );

  for (let index = 0; index < imdbBatches.length; index++) {
    const batch = imdbBatches[index];
    const started = Date.now();
    let payload;
    try {
      payload = await querySparql(imdbQuery(batch), log);
    } catch (err) {
      results.failedBatches++;
      counters.errors++;
      results.errors.push(err);
      log(
        `[wikidata] batch ${index + 1}/${imdbBatches.length} failed after retries: ${err.message}; ` +
          'stopping here so the persisted partial result can be resumed by another run'
      );
      break;
    }
    counters.batches++;
    results.batches++;
    const rows = (payload && payload.results && payload.results.bindings) || [];
    results.rows += rows.length;
    const merged = new Map();
    for (const row of rows) {
      const imdb = row.imdb && row.imdb.value;
      if (!imdb) continue;
      let acc = merged.get(imdb);
      if (!acc) {
        acc = emptyAccumulator();
        merged.set(imdb, acc);
      }
      mergeRow(acc, row);
    }
    for (const [imdb, acc] of merged) {
      const tag = tagFromAccumulator(acc, store.labels);
      store.imdb[imdb] = tag;
      for (const film of byImdb.get(imdb) || []) {
        store.tmdb[normalizeTmdbId(film.tmdbId)] = tag;
      }
    }
    for (const imdb of batch) {
      if (!merged.has(imdb)) store.imdb[imdb] = negativeTag();
    }
    persist();
    const matched = [...batch].filter((imdb) => store.imdb[imdb] && store.imdb[imdb].found).length;
    log(
      `[wikidata] batch ${index + 1}/${imdbBatches.length}: ids=${batch.length} rows=${rows.length} ` +
        `matched=${matched} in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
        `(file=${(fileBytes() / 1024).toFixed(0)} KiB)`
    );
    // Be gentle to WDQS between batches; the query service rate-limits hard
    // during outages. A short pause also keeps interactive use possible.
    if (index < imdbBatches.length - 1) await sleep(1200);
  }

  // P4947 fallback: only the handful of films without an IMDb id.
  const pendingTmdb = withoutImdb
    .map((film) => normalizeTmdbId(film.tmdbId))
    .filter((id) => id && (force || !Object.prototype.hasOwnProperty.call(store.tmdb, id)));
  const tmdbBatches = chunk([...new Set(pendingTmdb)], BATCH_SIZE);
  if (tmdbBatches.length) {
    log(`[wikidata] P4947 fallback: ${pendingTmdb.length} film(s), ${tmdbBatches.length} batch(es)`);
  }
  for (let index = 0; index < tmdbBatches.length; index++) {
    const batch = tmdbBatches[index];
    let payload;
    try {
      payload = await querySparql(tmdbQuery(batch), log);
    } catch (err) {
      results.failedBatches++;
      counters.errors++;
      results.errors.push(err);
      log(`[wikidata] P4947 batch ${index + 1}/${tmdbBatches.length} failed: ${err.message}`);
      break;
    }
    counters.batches++;
    results.batches++;
    const rows = (payload && payload.results && payload.results.bindings) || [];
    results.rows += rows.length;
    const merged = new Map();
    for (const row of rows) {
      const tmdb = row.tmdb && row.tmdb.value;
      if (!tmdb) continue;
      let acc = merged.get(tmdb);
      if (!acc) {
        acc = emptyAccumulator();
        merged.set(tmdb, acc);
      }
      mergeRow(acc, row);
    }
    for (const [tmdb, acc] of merged) {
      store.tmdb[tmdb] = tagFromAccumulator(acc, store.labels);
    }
    for (const tmdb of batch) {
      if (!merged.has(tmdb)) store.tmdb[tmdb] = negativeTag();
    }
    persist();
    log(
      `[wikidata] P4947 batch ${index + 1}/${tmdbBatches.length}: ids=${batch.length} ` +
        `rows=${rows.length} matched=${[...batch].filter((id) => store.tmdb[id] && store.tmdb[id].found).length}`
    );
  }

  // New P144 types arrived with this run: resolve labels and compute classes.
  await prepareClasses(log);
  persist();

  const coverage = coverageOf(films);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const covered = coverage.movie.covered + coverage.tv.covered;
  log(
    `[backfill:wikidata] done: covered=${covered}/${films.length} (${pct(covered, films.length)}) ` +
      `movies=${coverage.movie.covered}/${coverage.movie.total} (${pct(coverage.movie.covered, coverage.movie.total)}) ` +
      `tv=${coverage.tv.covered}/${coverage.tv.total} (${pct(coverage.tv.covered, coverage.tv.total)}) ` +
      `in ${elapsed}s`
  );
  log(
    `[backfill:wikidata] fields: P136=${coverage.movie.genres + coverage.tv.genres} ` +
      `P462=${coverage.movie.colors + coverage.tv.colors} ` +
      `P135=${coverage.movie.movements + coverage.tv.movements} ` +
      `P144=${coverage.movie.basedOn + coverage.tv.basedOn}`
  );
  log(
    `[backfill:wikidata] requests=${counters.requests} retries=${counters.retries} ` +
      `429=${counters.rateLimited} errors=${counters.errors} label-requests=${counters.labelRequests} ` +
      `file=${(fileBytes() / 1024).toFixed(0)} KiB`
  );
  return {
    ...results,
    elapsed,
    coverage,
    counters: { ...counters },
    bytes: fileBytes(),
    skippedImdb: byImdb.size - pendingImdb.length,
    pendingImdb: pendingImdb.length,
  };
}

module.exports = {
  TAGS_PATH,
  USER_AGENT,
  WIKIDATA_ORIGIN_PRIORITY,
  classifyBasedOn,
  getTags,
  isChecked,
  stats,
  reloadIfChanged,
  backfill,
  // exposed for tests / diagnostics
  __internal: { imdbQuery, tmdbQuery, splitConcat, entityId },
};
