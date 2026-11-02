'use strict';

/**
 * Wikidata credit provider for games (ИГРЫ-АРХИТЕКТУРА §2.4, §7.2).
 *
 * This module is the *transport* only: it knows how to ask WDQS for the
 * people/companies credited on a set of video games and how to normalise the
 * answer. The *policy* (which games to ask about, when to cache, how the
 * result is merged with Steam studios and Moby credits) lives in
 * `personnel.js`; the personal layer never invents a role, it only forwards
 * `roleSource: 'wikidata'` (ИГРЫ §7.2 «роль показывается только с roleSource»).
 *
 * Properties (the doc's own table, §7.2):
 *
 *   P86  composer          → role `composer`   (high)
 *   P287 designed by       → role `designer`   (high; «неровно», but verified)
 *   P57  director          → role `director`   (high; game director)
 *   P58  screenwriter      → role `writer`     (low: rare/ambiguous for games)
 *   P943 programmer        → role `programmer` (high)
 *   P162 producer          → role `producer`   (high)
 *   P170 creator           → role `creator`    (low: generic)
 *   P178 developer         → studio role `developer`
 *   P123 publisher         → studio role `publisher`
 *
 * There is no stable "artist" property on Wikidata (ИГРЫ §2.4 table: «свойство
 * нестабильно»), so `artist` comes from MobyGames only. Never derive a role
 * from a name — an unmapped property is dropped, not guessed.
 *
 * Politeness (same class as the book Wikidata bridge):
 *   - batches of ≤450 QIDs, one SPARQL query per batch, pause between batches;
 *   - `429`/`403`/`5xx`/network → count a failure; three failures open a
 *     30-minute cooldown (`disabledUntil`) so a blocked WDQS is not hammered;
 *   - while the breaker is half-open (failures > 0) at most one attempt per
 *     minute (`minOutageGapMs`);
 *   - `Retry-After` (seconds or HTTP date) wins when it is longer;
 *   - the cooldown is persisted in `cache-games/state/personnel-wikidata.json`,
 *     so a restart does not reset it. Tests inject `stateStore`/`now`/`fetchImpl`
 *     and never touch the network.
 *
 * Kill switch: `KINOBOXD_GAMES_WD=off`.
 *
 * Steam appids: Wikidata carries `P1733` (Steam application ID), so a game can
 * be resolved without a pre-built `links/<appid>.json`. `creditsForAppids()`
 * does both steps in one query, which is what the live coverage probe and the
 * future `kinoboxd-games-personnel` job use. `personnel.js` prefers the
 * resolved QID from `links/` when it exists (ИГРЫ §4.1: «резолв один раз»).
 */

const gameCache = require('../game-cache');
const { fetchOnce, responseFacade } = require('../../core/http');
const sources = require('../../core/sources');

const WDQS = 'https://query.wikidata.org/sparql';
const BATCH_SIZE = 450;
const DEFAULT_PAUSE_MS = 1100;
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_MIN_OUTAGE_GAP_MS = 60 * 1000;
const DEFAULT_MAX_FAILURES = 3;
const USER_AGENT = 'kinoboxd/1.0 (games personnel; https://github.com/hattivatt/kinoboxd)';

const STATE_PATH = require('path').join(gameCache.STATE_DIR, 'personnel-wikidata.json');

/** Wikidata property → local role (+ confidence, §7.2). */
const PROPERTY_ROLES = {
  P86: { role: 'composer', confidence: 'high' },
  P287: { role: 'designer', confidence: 'high' },
  P57: { role: 'director', confidence: 'high' },
  P58: { role: 'writer', confidence: 'low' },
  P943: { role: 'programmer', confidence: 'high' },
  P162: { role: 'producer', confidence: 'high' },
  P170: { role: 'creator', confidence: 'low' },
};

/** Studio properties: `developer` / `publisher` (§2.4, §4.2). */
const STUDIO_PROPERTIES = {
  P178: 'developer',
  P123: 'publisher',
};

/** role → confidence, so a person credited twice keeps the stronger signal. */
const ROLE_CONFIDENCE = new Map();
for (const info of Object.values(PROPERTY_ROLES)) {
  ROLE_CONFIDENCE.set(info.role, info.confidence);
}

class WikidataError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'WikidataError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function wikidataEnabled() {
  const raw = String(process.env.KINOBOXD_GAMES_WD || '').trim().toLowerCase();
  return !['0', 'off', 'false', 'no'].includes(raw);
}

/* ------------------------------------------------------------------ */
/* State (breaker / cooldown)                                          */
/* ------------------------------------------------------------------ */

function emptyState() {
  return {
    schemaVersion: 1,
    failures: 0,
    disabledUntil: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  };
}

function defaultStateStore() {
  return {
    read() {
      const hit = gameCache.readJsonWithFingerprint(STATE_PATH);
      const data = hit && hit.data && typeof hit.data === 'object' ? hit.data : {};
      return { ...emptyState(), ...data };
    },
    write(state) {
      try {
        gameCache.writeJsonAtomicSync(STATE_PATH, { ...emptyState(), ...state });
      } catch (err) {
        /* best-effort: an unwritable state dir must not hide the real error */
      }
    },
  };
}

function cooldownMs(options) {
  const raw = options.cooldownMs == null ? DEFAULT_COOLDOWN_MS : Number(options.cooldownMs);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COOLDOWN_MS;
}

function minOutageGapMs(options) {
  const raw =
    options.minOutageGapMs == null ? DEFAULT_MIN_OUTAGE_GAP_MS : Number(options.minOutageGapMs);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MIN_OUTAGE_GAP_MS;
}

function maxFailures(options) {
  const raw = options.maxFailures == null ? DEFAULT_MAX_FAILURES : Number(options.maxFailures);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_FAILURES;
}

/** `Retry-After` is either delta-seconds or an HTTP date. Returns ms or null. */
function parseRetryAfter(raw, nowMs) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  }
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}

/* ------------------------------------------------------------------ */
/* SPARQL                                                              */
/* ------------------------------------------------------------------ */

function qidValues(qids) {
  return qids
    .map((qid) => String(qid || '').trim())
    .filter((qid) => /^Q\d+$/.test(qid))
    .map((qid) => `wd:${qid}`)
    .join(' ');
}

function appidValues(appids) {
  // P1733 is an external identifier: its values are strings, not integers.
  return appids
    .map((appid) => String(appid == null ? '' : appid).trim())
    .filter((appid) => /^\d+$/.test(appid))
    .map((appid) => `"${appid}"`)
    .join(' ');
}

function creditBranches() {
  const branches = [];
  for (const [prop, info] of Object.entries(PROPERTY_ROLES)) {
    branches.push(
      `  { ?game wdt:${prop} ?entity . BIND("${info.role}" AS ?role) BIND("person" AS ?kind) }`
    );
  }
  for (const [prop, role] of Object.entries(STUDIO_PROPERTIES)) {
    branches.push(
      `  { ?game wdt:${prop} ?entity . BIND("${role}" AS ?role) BIND("studio" AS ?kind) }`
    );
  }
  return branches.join('\n  UNION\n');
}

const SELECT_TAIL = `  OPTIONAL { ?entity rdfs:label ?label . FILTER(LANG(?label) IN ("en", "ru", "mul")) }
  OPTIONAL { ?entity wdt:P18 ?image }
}`;

/** SPARQL for a batch of game QIDs. */
function creditsQuery(qids) {
  return `SELECT ?game ?kind ?role ?entity ?label ?image WHERE {
  VALUES ?game { ${qidValues(qids)} }
${creditBranches()}
${SELECT_TAIL}`;
}

/** SPARQL for a batch of Steam appids: resolves P1733 and credits in one pass. */
function appidCreditsQuery(appids) {
  return `SELECT ?game ?appid ?kind ?role ?entity ?label ?image WHERE {
  VALUES ?appid { ${appidValues(appids)} }
  ?game wdt:P1733 ?appid .
${creditBranches()}
${SELECT_TAIL}`;
}

function sparql(query, options = {}) {
  const fetchImpl = options.fetchImpl;
  if (!fetchImpl && typeof globalThis.fetch !== 'function') {
    return Promise.reject(new WikidataError('fetch is not available', 'wikidata_unavailable'));
  }
  const timeoutMs =
    options.timeoutMs == null ? DEFAULT_TIMEOUT_MS : Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  // POST, not GET: 450 QIDs do not fit an URL (WDQS answers 414 around 8 KB).
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
    label: 'games-personnel-wikidata',
  }).then(responseFacade);
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function lastSegment(value) {
  const text = String(value == null ? '' : value);
  const index = text.lastIndexOf('/');
  return index >= 0 ? text.slice(index + 1) : text;
}

function languageOf(binding) {
  return binding && binding['xml:lang'] ? String(binding['xml:lang']) : null;
}

function labelText(binding) {
  return binding && binding.value != null ? String(binding.value) : null;
}

function emptyCredits(key) {
  return { qid: key, appid: null, people: [], studios: [] };
}

function cleanLabel(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim() || null;
}

/** Folded comparison form; mirrors `personnel.normalizeName` (NFKC, lowercase, ё→е). */
function foldLabel(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[™®]/g, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** `short` is a whole-word prefix/suffix of `long` (never the whole string). */
function isWordFragment(short, long) {
  const a = foldLabel(short);
  const b = foldLabel(long);
  if (!a || !b || a === b) return false;
  return b.startsWith(`${a} `) || b.endsWith(` ${a}`);
}

/**
 * Canonical name of a Wikidata entity (§4.2).
 *
 * `mul` is Wikidata's language-neutral label: by definition the spelling that
 * is valid in every language, so it is the best identity anchor available.
 * Some items carry a truncated English label next to a complete `mul` one —
 * Q3539040 reads «Development Studio» in English while `mul`/ja/it all say
 * «Paradox Development Studio» (round 01.11.2026: the fragment made the same
 * studio appear twice, once as `wd:Q3539040` and once as the Steam
 * `developers[]` string, because the Steam↔Wikidata unification compares
 * normalized names). The `mul` spelling therefore wins when the English label
 * is only a word-fragment (prefix/suffix) of it. A genuinely shorter `mul`
 * («Warner Bros.» vs the English «Warner Bros. Entertainment») never degrades
 * the name: there the English label is the more specific one and stays.
 */
function canonicalLabel(entry) {
  const en = cleanLabel(entry.nameEn);
  const mul = cleanLabel(entry.nameMul);
  if (mul && (!en || isWordFragment(en, mul))) return { name: mul, nameEn: mul };
  const name = en || mul || cleanLabel(entry.nameOther) || cleanLabel(entry.nameRu) || null;
  return { name, nameEn: en };
}

/**
 * Turn a SPARQL results document into `Map<gameKey, credits>`.
 *
 * @param {object} data WDQS JSON (`results.bindings`)
 * @param {{keyBy?: 'qid'|'appid'}} [options] which game column identifies the
 *        document (appid queries also return `?appid`).
 * @returns {Map<string, {qid:string, appid:number|null,
 *          people:Array, studios:Array}>}
 */
function parseCreditsResponse(data, options = {}) {
  const keyBy = options.keyBy === 'appid' ? 'appid' : 'qid';
  const rows =
    data && data.results && Array.isArray(data.results.bindings) ? data.results.bindings : [];
  const games = new Map();
  // Intermediate accumulators keep labels from several OPTIONAL rows.
  const people = new Map(); // `${gameKey}\u0000${qid}` → entry
  const studios = new Map();

  for (const row of rows) {
    const gameQid = row.game ? lastSegment(row.game.value) : null;
    const appid = row.appid && /^\d+$/.test(String(row.appid.value)) ? Number(row.appid.value) : null;
    const gameKey = keyBy === 'appid' ? (appid == null ? null : String(appid)) : gameQid;
    if (!gameKey) continue;
    const entityQid = row.entity ? lastSegment(row.entity.value) : null;
    if (!entityQid || !/^Q\d+$/.test(entityQid)) continue;
    const role = row.role && row.role.value ? String(row.role.value) : null;
    if (!role) continue;
    const kind = row.kind && row.kind.value ? String(row.kind.value) : 'person';
    const label = labelText(row.label);
    const lang = languageOf(row.label);
    const image = row.image && row.image.value ? String(row.image.value) : null;

    if (!games.has(gameKey)) {
      const doc = emptyCredits(gameQid);
      doc.appid = appid;
      games.set(gameKey, doc);
    }
    const bucket = kind === 'studio' ? studios : people;
    const mapKey = `${gameKey}\u0000${entityQid}`;
    if (!bucket.has(mapKey)) {
      bucket.set(mapKey, {
        gameKey,
        qid: entityQid,
        roles: new Set(),
        nameEn: null,
        nameRu: null,
        nameMul: null,
        nameOther: null,
        image: null,
        confidence: null,
      });
    }
    const entry = bucket.get(mapKey);
    entry.roles.add(role);
    if (label) {
      if (lang === 'en') entry.nameEn = entry.nameEn || label;
      else if (lang === 'ru') entry.nameRu = entry.nameRu || label;
      else if (lang === 'mul') entry.nameMul = entry.nameMul || label;
      else entry.nameOther = entry.nameOther || label;
    }
    if (image && !entry.image) entry.image = image;
    // P58/P170 are `low` (§7.2: screenwriter is rare for games, P170 is
    // generic). A person with any `high` property keeps `high`.
    const confidence = ROLE_CONFIDENCE.get(role);
    if (confidence === 'high' || !entry.confidence) {
      entry.confidence = confidence || entry.confidence || 'high';
    }
  }

  const finalize = (entry, source) => {
    const canonical = canonicalLabel(entry);
    if (!canonical.name) return null;
    return {
      name: canonical.name,
      nameEn: canonical.nameEn,
      nameRu: entry.nameRu || null,
      qid: entry.qid,
      mobyId: null,
      roles: [...entry.roles].sort(),
      roleSource: source,
      source,
      confidence: entry.confidence || 'high',
      image: entry.image || null,
    };
  };

  // Studios first: the person pass below drops a company that is already a
  // studio of the same game (e.g. CD Projekt RED credited as P162 producer).
  for (const entry of studios.values()) {
    const studio = finalize(entry, 'wikidata');
    if (studio) games.get(entry.gameKey).studios.push(studio);
  }
  for (const entry of people.values()) {
    const person = finalize(entry, 'wikidata');
    if (!person) continue;
    const doc = games.get(entry.gameKey);
    // A company credited as `producer` (P162) is not a person: when the same
    // QID is already a studio of this game (P178/P123), the studio record wins
    // (ИГРЫ §7.2: roles come from properties, but a company is never a person).
    if (doc.studios.some((studio) => studio.qid === person.qid)) continue;
    if (person.image) person.image = person.image.replace(/^http:\/\//, 'https://');
    doc.people.push(person);
  }
  return games;
}

/* ------------------------------------------------------------------ */
/* Requests with politeness                                            */
/* ------------------------------------------------------------------ */

function responseError(response, stage) {
  const status = Number(response && response.status) || 0;
  const retryHeader =
    response && response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('retry-after')
      : null;
  return new WikidataError(`wikidata_${status || 'network'}`, 'wikidata_http_error', {
    status,
    retryAfter: retryHeader,
    stage,
  });
}

/**
 * Run one SPARQL query per batch and merge the parsed documents.
 *
 * @param {string[]} qids game QIDs (batched here, ≤450 per query)
 * @param {object} [options]
 * @returns {Promise<{credits: Map, queries: number, batches: number,
 *          skipped?: string, disabledUntil?: string|null,
 *          retryAfterMs?: number|null, errors: string[]}>}
 */
async function fetchCredits(qids, options = {}) {
  return runBatched(qids, (batch) => creditsQuery(batch), 'qid', options);
}

/**
 * Same as `fetchCredits` but keyed by Steam appid; resolves `P1733` in the
 * same query, so no `links/<appid>.json` is needed.
 *
 * @returns {Promise<{credits: Map<string, object>, queries: number, ...}>}
 *          `credits` keys are appid strings (`"292030"`).
 */
async function creditsForAppids(appids, options = {}) {
  return runBatched(appids, (batch) => appidCreditsQuery(batch), 'appid', options);
}

async function runBatched(values, buildQuery, keyBy, options) {
  const result = {
    credits: new Map(),
    queries: 0,
    batches: 0,
    errors: [],
    disabledUntil: null,
    retryAfterMs: null,
  };
  if (!wikidataEnabled()) {
    result.skipped = 'disabled_by_env';
    return result;
  }
  const list = [...new Set((values || []).map((value) => String(value == null ? '' : value).trim()))]
    .filter((value) => (keyBy === 'appid' ? /^\d+$/.test(value) : /^Q\d+$/.test(value)));
  if (!list.length) {
    result.skipped = 'nothing_to_ask';
    return result;
  }

  const store = options.stateStore || defaultStateStore();
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pauseMs = options.pauseMs == null ? DEFAULT_PAUSE_MS : Number(options.pauseMs);
  const batchSize = Math.max(1, Number(options.batchSize) || BATCH_SIZE);

  const state = { ...emptyState(), ...(store.read() || {}) };
  const nowMs = now();
  if (state.disabledUntil) {
    const until = Date.parse(state.disabledUntil);
    if (Number.isFinite(until) && until > nowMs) {
      result.skipped = 'wikidata_disabled';
      result.disabledUntil = state.disabledUntil;
      return result;
    }
  }
  // Half-open breaker: at most one attempt per minute while WDQS is failing.
  if (Number(state.failures) > 0 && state.lastAttemptAt) {
    const last = Date.parse(state.lastAttemptAt);
    if (Number.isFinite(last) && nowMs - last < minOutageGapMs(options)) {
      result.skipped = 'wikidata_outage_gap';
      result.disabledUntil = state.disabledUntil || null;
      return result;
    }
  }

  const batches = [];
  for (let i = 0; i < list.length; i += batchSize) batches.push(list.slice(i, i + batchSize));
  result.batches = batches.length;

  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    const attemptAt = new Date(now()).toISOString();
    state.lastAttemptAt = attemptAt;
    try {
      store.write(state);
    } catch (err) {
      /* best-effort */
    }

    let response;
    try {
      response = await sparql(buildQuery(batch), options);
    } catch (err) {
      const failure = registerFailure(state, store, options, now, err, result);
      if (failure) return result;
      continue;
    }
    result.queries++;
    if (!response || !response.ok) {
      const failure = registerFailure(
        state,
        store,
        options,
        now,
        responseError(response, 'credits'),
        result
      );
      if (failure) return result;
      continue;
    }
    let data;
    try {
      data = await response.json();
    } catch (err) {
      const failure = registerFailure(
        state,
        store,
        options,
        now,
        new WikidataError('wikidata_bad_json', 'wikidata_bad_json', { stage: 'credits' }),
        result
      );
      if (failure) return result;
      continue;
    }
    // The dispatcher is shared: callers may inject their own parser (the
    // franchise pass parses P179/P577, not credits) while keeping the exact
    // same batching, pause and breaker semantics.
    const parse = typeof options.parse === 'function'
      ? options.parse
      : (payload) => parseCreditsResponse(payload, { keyBy });
    const parsed = parse(data);
    for (const [key, doc] of parsed) result.credits.set(key, doc);

    state.failures = 0;
    state.disabledUntil = null;
    state.lastError = null;
    state.lastSuccessAt = new Date(now()).toISOString();
    try {
      store.write(state);
    } catch (err) {
      /* best-effort */
    }

    if (pauseMs > 0 && index + 1 < batches.length) await sleep(pauseMs);
  }
  result.disabledUntil = state.disabledUntil || null;
  return result;
}

/**
 * Record a failed attempt. Returns true when the caller must stop (breaker
 * opened or a hard stop), false when the next batch may still be tried.
 */
function registerFailure(state, store, options, now, err, result) {
  const nowMs = now();
  state.failures = Number(state.failures || 0) + 1;
  state.lastError = (err && (err.code || err.message)) || 'wikidata_error';
  const retryAfterMs = parseRetryAfter(err && err.retryAfter, nowMs);
  result.retryAfterMs = retryAfterMs;
  result.errors.push(state.lastError);

  const status = Number(err && err.status) || 0;
  // 4xx other than 403/429 is a query problem, not an outage: retrying the same
  // batch is pointless, but it must not disable the provider for everything.
  const outage = status === 0 || status === 403 || status === 429 || status >= 500;

  if (state.failures >= maxFailures(options) && outage) {
    const untilMs = nowMs + Math.max(cooldownMs(options), retryAfterMs || 0);
    state.disabledUntil = new Date(untilMs).toISOString();
    result.disabledUntil = state.disabledUntil;
    try {
      store.write(state);
    } catch (writeErr) {
      /* best-effort */
    }
    result.skipped = 'wikidata_disabled';
    return true;
  }
  try {
    store.write(state);
  } catch (writeErr) {
    /* best-effort */
  }
  if (status && status !== 403 && status !== 429 && status < 500) return true;
  return false;
}

module.exports = {
  WDQS,
  BATCH_SIZE,
  DEFAULT_PAUSE_MS,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_FAILURES,
  STATE_PATH,
  PROPERTY_ROLES,
  STUDIO_PROPERTIES,
  WikidataError,
  wikidataEnabled,
  parseRetryAfter,
  creditsQuery,
  appidCreditsQuery,
  canonicalLabel,
  parseCreditsResponse,
  fetchCredits,
  creditsForAppids,
  runBatched,
  defaultStateStore,
};
