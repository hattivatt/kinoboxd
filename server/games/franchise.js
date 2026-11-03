'use strict';

/**
 * Wikidata franchise / release-year pass for games (ИГРЫ-АРХИТЕКТУРА §2.5, §4.4).
 *
 * What it does — exactly two properties, no invention:
 *
 *   P1733  Steam application ID → the game item (`?game`) for a library appid;
 *   P179   «part of the series» → the franchise/series QID + en/ru labels;
 *   P577   «publication date»   → the release year (with the statement's
 *          precision: day / month / year / coarse), used to close the gaps the
 *          store could not answer (region-locked `success:false` documents and
 *          coarse Steam dates like «Q4 2026» / «September 2026»).
 *
 * One SPARQL query per ≤450 appids (the whole library fits one batch). The
 * batching/pause/breaker engine is **not** duplicated here: the personnel
 * provider (`personnel/wikidata.js`) is the single dispatcher, and this module
 * only injects its own query + parser. That keeps one WDQS politeness budget
 * for the whole games tab (429/403 → 30-minute persisted cooldown, one attempt
 * per minute while the breaker is half-open).
 *
 * The pass is the only writer of `cache-games/links/<appid>.json`:
 *
 *   {
 *     "appid": 292030,
 *     "wikidata": {
 *       "qid": "Q…",
 *       "franchise": { "qid": "Q…", "labelEn": "The Witcher", "labelRu": "Ведьмак" },
 *       "releaseYear": 2015,
 *       "releasePrecision": "day",
 *       "releaseDate": "2015-05-19",
 *       "resolved": true,
 *       "fetchedAt": "2026-11-01T…"
 *     },
 *     "franchiseKey": "wd:Q…",
 *     "sources": ["wikidata"],
 *     "fetchedAt": "2026-11-01T…"
 *   }
 *
 * A *miss* (no P1733 / no P179 / no P577) is written as `qid: null` with
 * `resolved: true`, i.e. a 90-day negative cache — the same policy as the
 * personnel pass. A network/5xx/breaker answer is NOT written: the next run
 * retries instead of pretending the game has no franchise.
 *
 * The existing document is merged, never replaced: `mobyId`, `igdbId` and a
 * legacy string `wikidata: "Q…"` survive a franchise refresh.
 *
 * B6 — **base-version bridge** (ИГРЫ §8.2.2 «издания», audit §4.5-A). A
 * regional SKU (`Dishonored RHCP` 217980, `Max Payne (RU)` 210350,
 * `Fallout: New Vegas PCR` 22490) has no `P1733` in Wikidata at all, so the
 * first pass honestly answers `qid: null` — and the store answers
 * `success:false` for it. The work therefore has no identity, no year, no
 * genres. The bridge adds a **second batch in the same pass** (same dispatcher,
 * same budget/breaker/lock): it looks up items by the exact label of the
 * stripped core title (`Dishonored`, `Max Payne`, `Fallout: New Vegas`),
 * requires `P1733` on the item and — the actual decision — an **exact
 * normalized title + numeric-signature match** against the SKU name, then
 * writes the base identity **next to** the SKU's own (absent) identity:
 *
 *   wikidata: {
 *     qid: null,                  // unchanged: the SKU is NOT the base game
 *     baseQid: "Q323264", baseAppid: 205100, baseName: "Dishonored",
 *     baseReleaseYear: 2012, baseReleasePrecision: "day",
 *     baseFranchise: { qid, labelEn, labelRu } | null,
 *     baseMatch: "label",         // provenance; never "qid"
 *     baseCheckedAt: "…",         // negative marker: «bridge ran, no base»
 *     resolved: true
 *   }
 *
 * `baseQid`/`baseAppid` are consumed by `editions.js` (merge the regional card
 * into the base work) and by `stats.js` (`workYear` fallback, canonical
 * name/genres/studios from `details-base/`). They never leak into
 * `wikidata.qid`, so the SKU card cannot pretend to be the base game.
 *
 * The bridge re-asks a `qid: null` document that has no `baseCheckedAt`
 * (i.e. every negative cache written before B6), which is how a deploy heals
 * the ~20 stale regionals without a `force` over the whole library.
 *
 * Kill switch: `KINOBOXD_GAMES_WD=off` (shared with the personnel provider).
 * Budget: `GAMES_FRANCHISE_BUDGET` appids per pass (default 450 = one batch).
 * TTL: `GAMES_FRANCHISE_TTL_DAYS` (default 90).
 *
 * `enrichBaseDetails()` is the companion store step (separate function, no WD
 * lock): for every `baseAppid` written by the bridge it fetches `appdetails`
 * **once** into `details-base/<baseAppid>.json` (budget
 * `GAMES_BASE_DETAILS_BUDGET`, default 20, the store client's own 1.7 s pause
 * and 30-minute breaker). The owner does not own that card, so it must not go
 * into `details/`.
 */

const path = require('path');

const editions = require('./editions');
const gameCache = require('./game-cache');
const store = require('./store');
const wd = require('./personnel/wikidata');
const { budgetLimitFromEnv } = require('../core/budget');
const sources = require('../core/sources');

const LINKS_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'links');
const STATE_PATH = path.join(gameCache.STATE_DIR, 'franchise-state.json');
/**
 * Franchise of works that exist only outside Steam (GOG/Epic exclusives such
 * as Alan Wake 2). Global metadata cache (no owner dimension), keyed both by
 * the store slug (`epic:alan_wake_2`) and by the Wikidata item (`qid:Q…`), so
 * the payload can answer from a slug it knows and the pass can reuse an answer
 * it already has for a QID. A miss is a settled negative for the TTL.
 */
const SECONDARY_FRANCHISE_PATH = path.join(LINKS_DIR, 'secondary-franchise.json');

const DEFAULT_BUDGET = 450;
const DEFAULT_TTL_DAYS = 90;
const DEFAULT_BASE_DETAILS_BUDGET = 20;
const MAX_RUNS = 10;
const YEAR_MIN = 1970;
const YEAR_MAX = 2100;

/** WD `wikibase:timePrecision` → the store's own precision vocabulary. */
const PRECISION_BY_WD = { 11: 'day', 10: 'month', 9: 'year' };
const PRECISION_RANK = { day: 4, month: 3, year: 2, coarse: 1 };

class FranchiseError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'FranchiseError';
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* Paths / links document                                              */
/* ------------------------------------------------------------------ */

function linksPath(appid) {
  return path.join(LINKS_DIR, `${gameCache.safeKey(appid)}.json`);
}

/** Read the raw `links/<appid>.json` (or null). */
function readLinksDoc(appid) {
  const hit = gameCache.readJsonWithFingerprint(linksPath(appid));
  return hit && hit.data && typeof hit.data === 'object' ? hit.data : null;
}

/** Normalised view used by the aggregator: `{qid, franchise, releaseYear, …}`. */
function readLinks(appid) {
  const doc = readLinksDoc(appid) || {};
  const wdRaw = doc.wikidata && typeof doc.wikidata === 'object' ? doc.wikidata : null;
  const qidRaw = wdRaw ? wdRaw.qid : doc.wikidata;
  const qid =
    qidRaw && /^Q\d+$/i.test(String(qidRaw).trim()) ? String(qidRaw).trim().toUpperCase() : null;
  const franchise =
    wdRaw && wdRaw.franchise && typeof wdRaw.franchise === 'object' ? wdRaw.franchise : null;
  const baseFranchise =
    wdRaw && wdRaw.baseFranchise && typeof wdRaw.baseFranchise === 'object' ? wdRaw.baseFranchise : null;
  const baseQidRaw = wdRaw ? wdRaw.baseQid : doc.baseQid;
  const baseQid =
    baseQidRaw && /^Q\d+$/i.test(String(baseQidRaw).trim())
      ? String(baseQidRaw).trim().toUpperCase()
      : null;
  const baseAppidRaw = wdRaw && wdRaw.baseAppid != null ? wdRaw.baseAppid : doc.baseAppid;
  const baseAppid = Number(baseAppidRaw);
  const releaseYear = validYear(wdRaw && wdRaw.releaseYear);
  return {
    qid,
    franchise: franchise
      ? {
          qid: franchise.qid || null,
          labelEn: franchise.labelEn || null,
          labelRu: franchise.labelRu || null,
        }
      : null,
    releaseYear,
    releasePrecision: (wdRaw && wdRaw.releasePrecision) || null,
    releaseDate: (wdRaw && wdRaw.releaseDate) || null,
    franchiseKey: doc.franchiseKey || (franchise && franchise.qid ? `wd:${franchise.qid}` : null),
    resolved: Boolean(wdRaw && wdRaw.resolved === true),
    fetchedAt: (wdRaw && wdRaw.fetchedAt) || doc.fetchedAt || null,
    sources: Array.isArray(doc.sources) ? doc.sources : [],
    // B6: base-version bridge (see the module header). `baseQid` is the
    // identity of the *work*, `qid` above stays the identity of this SKU.
    baseQid,
    baseAppid: Number.isInteger(baseAppid) && baseAppid > 0 ? baseAppid : null,
    baseName: (wdRaw && wdRaw.baseName) || null,
    baseReleaseYear: validYear(wdRaw && wdRaw.baseReleaseYear),
    baseReleasePrecision: (wdRaw && wdRaw.baseReleasePrecision) || null,
    baseFranchise: baseFranchise
      ? {
          qid: baseFranchise.qid || null,
          labelEn: baseFranchise.labelEn || null,
          labelRu: baseFranchise.labelRu || null,
        }
      : null,
    baseMatch: (wdRaw && wdRaw.baseMatch) || null,
    baseCheckedAt: (wdRaw && wdRaw.baseCheckedAt) || null,
  };
}

/**
 * Bulk variant for the stats payload: `{ "<appid>": readLinks(appid) }` for
 * the appids that actually have a links document. One `stat`+`read` per appid
 * (the same primitive `readLinks` uses), no network.
 */
function readLinksMap(appids) {
  const out = {};
  if (!Array.isArray(appids)) return out;
  for (const raw of appids) {
    const appid = Number(raw);
    if (!Number.isInteger(appid) || appid <= 0) continue;
    if (!readLinksDoc(appid)) continue;
    out[String(appid)] = readLinks(appid);
  }
  return out;
}

function validYear(raw) {
  const year = Number(raw);
  return Number.isInteger(year) && year >= YEAR_MIN && year <= YEAR_MAX ? year : null;
}

function uniqueList(values) {
  const out = [];
  for (const value of values) {
    if (value == null) continue;
    const text = String(value);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/**
 * Merge one patch into `links/<appid>.json`. Atomic, additive: nothing another
 * provider wrote (`mobyId`, `igdbId`, legacy `wikidata: "Q…"`) is dropped.
 */
function writeLinksDoc(appid, patch) {
  const existing = readLinksDoc(appid) || {};
  const legacyQid =
    typeof existing.wikidata === 'string' && /^Q\d+$/i.test(existing.wikidata)
      ? existing.wikidata.toUpperCase()
      : null;
  const existingWd =
    existing.wikidata && typeof existing.wikidata === 'object' ? existing.wikidata : {};
  const nextWd = { ...existingWd, ...(patch.wikidata || {}) };
  if (!nextWd.qid && legacyQid) nextWd.qid = legacyQid;
  const doc = {
    schemaVersion: 1,
    ...existing,
    appid: Number(appid),
    wikidata: nextWd,
    franchiseKey: patch.franchiseKey !== undefined ? patch.franchiseKey : existing.franchiseKey || null,
    sources: uniqueList([...(Array.isArray(existing.sources) ? existing.sources : []), ...(patch.sources || [])]),
    fetchedAt: patch.fetchedAt || existing.fetchedAt || null,
  };
  gameCache.writeJsonAtomicSync(linksPath(appid), doc);
  return doc;
}

/* ------------------------------------------------------------------ */
/* Secondary-only works: franchise cache (slug/QID → P179)             */
/* ------------------------------------------------------------------ */

function emptySecondaryFranchise() {
  return { schemaVersion: 1, fetchedAt: null, entries: {} };
}

/** Read `links/secondary-franchise.json` (never throws, `{}` when absent). */
function readSecondaryFranchise() {
  const hit = gameCache.readJsonWithFingerprint(SECONDARY_FRANCHISE_PATH);
  if (!hit || !hit.data || typeof hit.data !== 'object') return emptySecondaryFranchise();
  return {
    schemaVersion: Number(hit.data.schemaVersion) || 1,
    fetchedAt: hit.data.fetchedAt || null,
    entries:
      hit.data.entries && typeof hit.data.entries === 'object' ? hit.data.entries : {},
  };
}

/**
 * Merge entries into the cache atomically. Additive: a slug/QID written by
 * another pass survives, and only the keys in `patch` are replaced.
 */
function writeSecondaryFranchiseEntries(patch, options = {}) {
  const current = readSecondaryFranchise();
  const entries = { ...current.entries, ...(patch || {}) };
  const doc = {
    schemaVersion: 1,
    source: 'wikidata',
    fetchedAt: options.fetchedAt || new Date().toISOString(),
    entries,
  };
  gameCache.writeJsonAtomicSync(SECONDARY_FRANCHISE_PATH, doc);
  return doc;
}

/** Is this settled franchise answer inside the TTL window? */
function isSecondaryFranchiseFresh(entry, ttlMs, nowMs) {
  if (!entry || typeof entry !== 'object' || entry.resolved !== true) return false;
  const at = Date.parse(String(entry.fetchedAt || ''));
  if (!Number.isFinite(at)) return false;
  const ttl = Number.isFinite(Number(ttlMs)) ? Number(ttlMs) : ttlMsFromEnv();
  return nowMs - at >= 0 && nowMs - at < ttl;
}

/**
 * One cached answer for a secondary work, looked up by store slug first and
 * by QID second. Pure over the document handed in.
 */
function secondaryFranchiseFrom(doc, { store, slug, qid } = {}) {
  const entries = doc && doc.entries && typeof doc.entries === 'object' ? doc.entries : {};
  const prefix = String(store == null ? '' : store).trim().toLowerCase();
  const key = String(slug == null ? '' : slug).trim();
  if (prefix && key) {
    const hit = entries[`${prefix}:${key}`];
    if (hit) return hit;
  }
  if (qid && /^Q\d+$/.test(String(qid))) return entries[`qid:${String(qid)}`] || null;
  return null;
}

/** One cache entry from a WDQS hit (or an honest «no P179» answer). */
function secondaryFranchiseEntry(hit, { store = null, slug = null, fetchedAt } = {}) {
  const franchise =
    hit && hit.franchise && hit.franchise.qid
      ? {
          qid: hit.franchise.qid,
          labelEn: hit.franchise.labelEn || null,
          labelRu: hit.franchise.labelRu || null,
          labelMul: hit.franchise.labelMul || null,
        }
      : null;
  return {
    qid: hit && hit.qid ? hit.qid : null,
    franchiseKey: franchise ? `wd:${franchise.qid}` : null,
    franchiseLabel: franchise
      ? franchise.labelEn || franchise.labelMul || franchise.labelRu || null
      : null,
    labelRu: franchise ? franchise.labelRu || null : null,
    franchise,
    source: 'wikidata',
    resolved: true,
    store: store || null,
    slug: slug || null,
    fetchedAt,
  };
}

/* ------------------------------------------------------------------ */
/* State (resumable journal)                                           */
/* ------------------------------------------------------------------ */

function emptyState() {
  return { schemaVersion: 1, updatedAt: null, profiles: {}, runs: [] };
}

function readFranchiseState() {
  const hit = gameCache.readJsonWithFingerprint(STATE_PATH);
  if (!hit || !hit.data || typeof hit.data !== 'object') return emptyState();
  return {
    schemaVersion: Number(hit.data.schemaVersion) || 1,
    updatedAt: hit.data.updatedAt || null,
    profiles:
      hit.data.profiles && typeof hit.data.profiles === 'object' ? hit.data.profiles : {},
    runs: Array.isArray(hit.data.runs) ? hit.data.runs : [],
  };
}

function saveFranchiseState(state) {
  const payload = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    profiles: state && state.profiles && typeof state.profiles === 'object' ? state.profiles : {},
    runs: state && Array.isArray(state.runs) ? state.runs.slice(-MAX_RUNS) : [],
  };
  gameCache.writeJsonAtomicSync(STATE_PATH, payload);
  return payload;
}

function recordRun(profileKey, report) {
  const state = readFranchiseState();
  const entry = {
    lastRunAt: new Date().toISOString(),
    games: report.games,
    candidates: report.candidates,
    updated: report.updated,
    skippedFresh: report.skippedFresh,
    remaining: report.remaining || 0,
    wdQueries: report.wdQueries || 0,
    wdAnswered: report.wdAnswered || 0,
    wdSkipped: report.wdSkipped || null,
    wdDisabledUntil: report.wdDisabledUntil || null,
    releaseYearsFilled: report.releaseYearsFilled || 0,
    // B6: the base-version bridge (second batch) and its store step.
    bridgeCandidates: report.bridgeCandidates || 0,
    bridgeQueries: report.bridgeQueries || 0,
    bridged: report.bridged || 0,
    bridgeMisses: report.bridgeMisses || 0,
    // Secondary-only works (GOG/Epic): P179 by QID in the same pass.
    secondaryTargets: report.secondaryTargets || 0,
    secondaryCandidates: report.secondaryCandidates || 0,
    secondaryUpdated: report.secondaryUpdated || 0,
    secondarySkippedFresh: report.secondarySkippedFresh || 0,
    secondaryQueries: report.secondaryQueries || 0,
    force: Boolean(report.force),
    errors: (report.errors || []).slice(0, 5),
  };
  state.profiles[profileKey] = entry;
  state.runs.push({ profile: profileKey, ...entry });
  return saveFranchiseState(state);
}

/* ------------------------------------------------------------------ */
/* SPARQL                                                              */
/* ------------------------------------------------------------------ */

function appidValues(appids) {
  return appids
    .map((appid) => String(appid == null ? '' : appid).trim())
    .filter((appid) => /^\d+$/.test(appid))
    .map((appid) => `"${appid}"`)
    .join(' ');
}

/**
 * One query: appid → game QID (P1733), series (P179 + en/ru labels) and the
 * publication date with its statement precision (P577). `OPTIONAL` keeps a
 * game in the answer when it has no series/date, so the negative cache is an
 * honest "WD answered nothing".
 */
function franchiseQuery(appids) {
  return `SELECT ?appid ?game ?franchise ?franchiseEn ?franchiseRu ?franchiseMul ?date ?precision WHERE {
  VALUES ?appid { ${appidValues(appids)} }
  ?game wdt:P1733 ?appid .
  OPTIONAL {
    ?game wdt:P179 ?franchise .
    OPTIONAL { ?franchise rdfs:label ?franchiseEn . FILTER(LANG(?franchiseEn) = "en") }
    OPTIONAL { ?franchise rdfs:label ?franchiseRu . FILTER(LANG(?franchiseRu) = "ru") }
    OPTIONAL { ?franchise rdfs:label ?franchiseMul . FILTER(LANG(?franchiseMul) = "mul") }
  }
  OPTIONAL {
    ?game p:P577 ?st .
    ?st psv:P577 ?val .
    ?val wikibase:timeValue ?date .
    ?val wikibase:timePrecision ?precision .
  }
}`;
}

function lastSegment(value) {
  const text = String(value == null ? '' : value);
  const index = text.lastIndexOf('/');
  return index >= 0 ? text.slice(index + 1) : text;
}

function precisionOf(raw) {
  const value = Number(raw);
  return PRECISION_BY_WD[value] || 'coarse';
}

/** `+2015-05-19T00:00:00Z` + precision → `{year, month, day, precision, iso, time}`. */
function parseWbDate(value, precisionRaw) {
  const match = /^([+-]?)(\d{4,6})-(\d{2})-(\d{2})T/.exec(String(value == null ? '' : value));
  if (!match) return null;
  const year = Number(match[2]) * (match[1] === '-' ? -1 : 1);
  if (!Number.isInteger(year) || year < YEAR_MIN || year > YEAR_MAX) return null;
  const month = Number(match[3]);
  const day = Number(match[4]);
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const precision = precisionOf(precisionRaw);
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return {
    year,
    month: precision === 'day' || precision === 'month' ? month : null,
    day: precision === 'day' ? day : null,
    precision,
    iso,
    time: Date.UTC(year, month - 1, day),
  };
}

function qidNumber(qid) {
  const match = /^Q(\d+)$/.exec(String(qid || ''));
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * Turn a WDQS answer into `Map<appidString, {qid, franchise, releaseYear,
 * releasePrecision, releaseDate}>`.
 *
 * Several P179 values and several regional P577 dates are common; the choice
 * is deterministic and documented:
 *   - one game QID per appid — prefer the item that carries a series and/or a
 *     date, then the lowest QID (never merge two QIDs into one franchise);
 *   - one series per game — the lowest QID that has a label (en, else ru);
 *   - one date — the earliest year; inside a year the most precise statement
 *     (day > month > year > coarse), then the earliest date.
 */
function parseFranchiseResponse(data) {
  const rows = data && data.results && Array.isArray(data.results.bindings)
    ? data.results.bindings
    : [];
  const byAppid = new Map();

  for (const row of rows) {
    const appid = row.appid && /^\d+$/.test(String(row.appid.value)) ? String(row.appid.value) : null;
    if (!appid) continue;
    const gameQid = row.game ? lastSegment(row.game.value) : null;
    if (!gameQid || !/^Q\d+$/.test(gameQid)) continue;

    if (!byAppid.has(appid)) byAppid.set(appid, new Map());
    const qids = byAppid.get(appid);
    if (!qids.has(gameQid)) qids.set(gameQid, { qid: gameQid, franchises: new Map(), dates: [] });
    const game = qids.get(gameQid);

    const franchiseQid = row.franchise ? lastSegment(row.franchise.value) : null;
    if (franchiseQid && /^Q\d+$/.test(franchiseQid)) {
      if (!game.franchises.has(franchiseQid)) {
        game.franchises.set(franchiseQid, { qid: franchiseQid, labelEn: null, labelRu: null, labelMul: null });
      }
      const franchise = game.franchises.get(franchiseQid);
      if (row.franchiseEn && row.franchiseEn.value && !franchise.labelEn) {
        franchise.labelEn = String(row.franchiseEn.value);
      }
      if (row.franchiseRu && row.franchiseRu.value && !franchise.labelRu) {
        franchise.labelRu = String(row.franchiseRu.value);
      }
      // Some series items carry only the multilingual (`mul`) label —
      // Q752241 «Half-Life», Q7231475 «Portal». Without this fallback the
      // franchise would exist but show a bare QID.
      if (row.franchiseMul && row.franchiseMul.value && !franchise.labelMul) {
        franchise.labelMul = String(row.franchiseMul.value);
      }
    }

    if (row.date && row.date.value) {
      const date = parseWbDate(row.date.value, row.precision && row.precision.value);
      if (date && !game.dates.some((known) => known.iso === date.iso && known.precision === date.precision)) {
        game.dates.push(date);
      }
    }
  }

  const result = new Map();
  for (const [appid, qids] of byAppid) {
    const chosen = [...qids.values()].sort((a, b) => {
      const scoreA = (a.franchises.size ? 2 : 0) + (a.dates.length ? 1 : 0);
      const scoreB = (b.franchises.size ? 2 : 0) + (b.dates.length ? 1 : 0);
      if (scoreA !== scoreB) return scoreB - scoreA;
      return qidNumber(a.qid) - qidNumber(b.qid);
    })[0];

    const series = pickSeries(chosen.franchises);

    const date = pickDate(chosen.dates);

    result.set(appid, {
      appid: Number(appid),
      qid: chosen.qid,
      franchise: series
        ? {
            qid: series.qid,
            labelEn: series.labelEn || series.labelMul || null,
            labelRu: series.labelRu,
          }
        : null,
      releaseYear: date ? date.year : null,
      releasePrecision: date ? date.precision : null,
      releaseDate: date && date.precision === 'day' ? date.iso : null,
    });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Secondary-only works: P179 by QID                                   */
/* ------------------------------------------------------------------ */

function qidValues(qids) {
  return qids
    .map((qid) => String(qid == null ? '' : qid).trim())
    .filter((qid) => /^Q\d+$/.test(qid))
    .map((qid) => `wd:${qid}`)
    .join(' ');
}

/**
 * One query for the Wikidata items of secondary-only works: the item is known
 * (from `links/secondary.json`), only P179 + labels are missing. `OPTIONAL`
 * keeps an item without a series in the answer, so «no franchise» is an honest
 * settled negative instead of a retry loop.
 */
function qidFranchiseQuery(qids) {
  return `SELECT ?game ?franchise ?franchiseEn ?franchiseRu ?franchiseMul WHERE {
  VALUES ?game { ${qidValues(qids)} }
  OPTIONAL {
    ?game wdt:P179 ?franchise .
    OPTIONAL { ?franchise rdfs:label ?franchiseEn . FILTER(LANG(?franchiseEn) = "en") }
    OPTIONAL { ?franchise rdfs:label ?franchiseRu . FILTER(LANG(?franchiseRu) = "ru") }
    OPTIONAL { ?franchise rdfs:label ?franchiseMul . FILTER(LANG(?franchiseMul) = "mul") }
  }
}`;
}

/**
 * `qidFranchiseQuery` answer → `Map<QID, {qid, franchise}>`. Several P179
 * values are reduced by the same deterministic rule as the Steam pass (lowest
 * labelled series QID); two QIDs are never merged.
 */
function parseFranchiseByQid(data) {
  const rows = data && data.results && Array.isArray(data.results.bindings)
    ? data.results.bindings
    : [];
  const byQid = new Map();
  for (const row of rows) {
    const gameQid = row.game ? lastSegment(row.game.value) : null;
    if (!gameQid || !/^Q\d+$/.test(gameQid)) continue;
    if (!byQid.has(gameQid)) byQid.set(gameQid, { qid: gameQid, franchises: new Map() });
    const game = byQid.get(gameQid);
    const franchiseQid = row.franchise ? lastSegment(row.franchise.value) : null;
    if (!franchiseQid || !/^Q\d+$/.test(franchiseQid)) continue;
    if (!game.franchises.has(franchiseQid)) {
      game.franchises.set(franchiseQid, {
        qid: franchiseQid,
        labelEn: null,
        labelRu: null,
        labelMul: null,
      });
    }
    const franchise = game.franchises.get(franchiseQid);
    if (row.franchiseEn && row.franchiseEn.value && !franchise.labelEn) {
      franchise.labelEn = String(row.franchiseEn.value);
    }
    if (row.franchiseRu && row.franchiseRu.value && !franchise.labelRu) {
      franchise.labelRu = String(row.franchiseRu.value);
    }
    if (row.franchiseMul && row.franchiseMul.value && !franchise.labelMul) {
      franchise.labelMul = String(row.franchiseMul.value);
    }
  }
  const result = new Map();
  for (const [qid, game] of byQid) {
    const series = pickSeries(game.franchises);
    result.set(qid, {
      qid,
      franchise: series
        ? {
            qid: series.qid,
            labelEn: series.labelEn || series.labelMul || null,
            labelRu: series.labelRu,
            labelMul: series.labelMul || null,
          }
        : null,
    });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* B6: base-version bridge (second WDQS batch by label)                */
/* ------------------------------------------------------------------ */

/**
 * Words that are an edition wrapper **only when they are the last token**
 * (`East India Company Gold`, `Stronghold Crusader Extreme HD`). They are not
 * in `editions.EDITION_WORDS` on purpose: `Gold`/`Platinum` in the middle of a
 * title is a real word, and a merge heuristic must not eat it.
 */
const TRAILING_EDITION_WORDS = new Set([
  ...editions.EDITION_WORDS,
  'gold',
  'platinum',
  'silver',
  'cut',
  'legacy',
]);

function normalizeSpaces(value) {
  return String(value == null ? '' : value)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `"Dishonored"` → `"Dishonored"` (SPARQL literal, no language tag). */
function escapeSparqlLiteral(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]+/g, ' ');
}

/** Drop `(RU)`, `(Special Edition)` — parenthesized region/edition wrappers. */
function stripParenWrappers(raw) {
  return normalizeSpaces(
    raw.replace(/\s*\(([^)]*)\)/g, (match, inner) => {
      const words = editions.cleanName(inner).split(' ').filter(Boolean);
      if (!words.length) return match;
      if (words.length === 1 && editions.REGION_WORDS.has(words[0])) return '';
      if (words.every((word) => editions.EDITION_WORDS.has(word))) return '';
      return match;
    })
  );
}

/** Drop multi-word wrappers (`Game of the Year`, `Director's Cut`) anywhere. */
function stripEditionPhrases(raw) {
  let value = normalizeSpaces(raw);
  for (const phrase of editions.EDITION_PHRASES) {
    const pattern = phrase.map(escapeRegex).join('[^\\p{L}\\p{N}]+');
    const re = new RegExp(`(?:^|[\\s-])${pattern}(?=$|[\\s-])`, 'giu');
    value = normalizeSpaces(value.replace(re, ' '));
  }
  return normalizeSpaces(value.replace(/[\s\-–—:,]+$/g, ''));
}

/** Drop trailing region/edition tokens, preserving the original casing. */
function stripTrailingWrappers(raw) {
  const tokens = normalizeSpaces(raw).split(' ').filter(Boolean);
  const out = [...tokens];
  while (out.length > 1) {
    const last = out[out.length - 1];
    const bare = last.replace(/[^\p{L}\p{N}]/gu, '');
    const lower = bare.toLowerCase();
    if (!lower) {
      out.pop();
      continue;
    }
    const capsRegion =
      editions.REGION_WORDS.has(lower) &&
      /^[A-Za-z]{2,5}$/.test(bare) &&
      bare === bare.toUpperCase();
    if (capsRegion || TRAILING_EDITION_WORDS.has(lower)) {
      out.pop();
      continue;
    }
    break;
  }
  return normalizeSpaces(out.join(' '));
}

/**
 * Candidate WD labels for one Steam title, case preserved (the lookup is an
 * exact `rdfs:label` match — a regex scan over labels would time out).
 *
 *   "Dishonored RHCP"                    → ["Dishonored RHCP", "Dishonored"]
 *   "Max Payne (RU)"                     → ["Max Payne (RU)", "Max Payne"]
 *   "Fallout: New Vegas PCR"             → [..., "Fallout: New Vegas"]
 *   "Metro: Last Light Complete Edition" → [..., "Metro: Last Light"]
 *
 * Over-generating is harmless: the *decision* is `coreTitle` equality in
 * `matchBaseFor`, so a wrong variant only costs one VALUES entry.
 */
function labelVariants(name) {
  const raw = normalizeSpaces(String(name == null ? '' : name).replace(/[™®©]/g, ' '));
  if (!raw) return [];
  const out = [];
  const push = (value) => {
    const text = normalizeSpaces(String(value == null ? '' : value).replace(/[\s\-–—:,]+$/g, ''));
    if (text.length >= 2 && !out.includes(text)) out.push(text);
  };
  push(raw);
  const noParens = stripParenWrappers(raw);
  push(noParens);
  const noPhrases = stripEditionPhrases(noParens);
  push(noPhrases);
  push(stripTrailingWrappers(noPhrases));
  return out;
}

/**
 * Language tags to try for one candidate label. English is the default for
 * video-game items; a Cyrillic title is looked up in `ru` as well.
 */
function labelLanguages(text) {
  return /[А-Яа-яЁё]/.test(text) ? ['ru', 'en'] : ['en'];
}

function baseLabelValues(entries) {
  const values = [];
  const seen = new Set();
  for (const entry of entries) {
    for (const label of entry.labels) {
      const value = `"${escapeSparqlLiteral(label.text)}"@${label.lang}`;
      if (seen.has(value)) continue;
      seen.add(value);
      values.push(value);
    }
  }
  return values;
}

/**
 * Second batch: exact-label lookup among items that carry `P1733`.
 *
 * `VALUES ?label { "Dishonored"@en … }` + `?item rdfs:label ?label` is an
 * index lookup (unlike a `FILTER(REGEX(…))` scan, which times out on WDQS).
 * `skos:altLabel` is a UNION branch: some regional items only exist there.
 * Series (P179) and date (P577) are fetched for the *base* item, because that
 * is the metadata the regional SKU is missing.
 */
function baseLabelQuery(entries) {
  const values = baseLabelValues(entries);
  return `SELECT ?label ?item ?appid ?franchise ?franchiseEn ?franchiseRu ?franchiseMul ?date ?precision WHERE {
  VALUES ?label { ${values.join(' ')} }
  { ?item rdfs:label ?label } UNION { ?item skos:altLabel ?label }
  ?item wdt:P1733 ?appid .
  OPTIONAL {
    ?item wdt:P179 ?franchise .
    OPTIONAL { ?franchise rdfs:label ?franchiseEn . FILTER(LANG(?franchiseEn) = "en") }
    OPTIONAL { ?franchise rdfs:label ?franchiseRu . FILTER(LANG(?franchiseRu) = "ru") }
    OPTIONAL { ?franchise rdfs:label ?franchiseMul . FILTER(LANG(?franchiseMul) = "mul") }
  }
  OPTIONAL {
    ?item p:P577 ?st .
    ?st psv:P577 ?val .
    ?val wikibase:timeValue ?date .
    ?val wikibase:timePrecision ?precision .
  }
}`;
}

/** Lowest QID that has a label; `mul` is a label too (Q752241 «Half-Life»). */
function pickSeries(franchises) {
  return (
    [...franchises.values()].sort((a, b) => {
      const labeledA = a.labelEn || a.labelRu || a.labelMul ? 1 : 0;
      const labeledB = b.labelEn || b.labelRu || b.labelMul ? 1 : 0;
      if (labeledA !== labeledB) return labeledB - labeledA;
      return qidNumber(a.qid) - qidNumber(b.qid);
    })[0] || null
  );
}

/** Earliest year; inside a year the most precise statement, then the earliest. */
function pickDate(dates) {
  return (
    dates
      .slice()
      .sort((a, b) => {
        if (a.year !== b.year) return a.year - b.year;
        const rank = (PRECISION_RANK[b.precision] || 0) - (PRECISION_RANK[a.precision] || 0);
        if (rank) return rank;
        return a.time - b.time;
      })[0] || null
  );
}

/**
 * WDQS answer of `baseLabelQuery` → `Map<QID, {qid, labels[], appids[],
 * franchise, date}>`. Keyed by the **base item**, not by appid: one item can
 * carry several P1733 values (regional re-releases), and one label can match
 * several items (that is what the guards in `matchBaseFor` are for).
 */
function parseBaseLabelResponse(data) {
  const rows =
    data && data.results && Array.isArray(data.results.bindings) ? data.results.bindings : [];
  const byQid = new Map();
  for (const row of rows) {
    const itemQid = row.item ? lastSegment(row.item.value) : null;
    if (!itemQid || !/^Q\d+$/.test(itemQid)) continue;
    if (!byQid.has(itemQid)) {
      byQid.set(itemQid, {
        qid: itemQid,
        labels: [],
        appids: [],
        franchises: new Map(),
        dates: [],
      });
    }
    const item = byQid.get(itemQid);
    const label = row.label && row.label.value ? String(row.label.value) : null;
    if (label && !item.labels.includes(label)) item.labels.push(label);
    const appid =
      row.appid && /^\d+$/.test(String(row.appid.value)) ? Number(row.appid.value) : null;
    if (appid && !item.appids.includes(appid)) item.appids.push(appid);

    const franchiseQid = row.franchise ? lastSegment(row.franchise.value) : null;
    if (franchiseQid && /^Q\d+$/.test(franchiseQid)) {
      if (!item.franchises.has(franchiseQid)) {
        item.franchises.set(franchiseQid, {
          qid: franchiseQid,
          labelEn: null,
          labelRu: null,
          labelMul: null,
        });
      }
      const franchise = item.franchises.get(franchiseQid);
      if (row.franchiseEn && row.franchiseEn.value && !franchise.labelEn) {
        franchise.labelEn = String(row.franchiseEn.value);
      }
      if (row.franchiseRu && row.franchiseRu.value && !franchise.labelRu) {
        franchise.labelRu = String(row.franchiseRu.value);
      }
      if (row.franchiseMul && row.franchiseMul.value && !franchise.labelMul) {
        franchise.labelMul = String(row.franchiseMul.value);
      }
    }

    if (row.date && row.date.value) {
      const date = parseWbDate(row.date.value, row.precision && row.precision.value);
      if (
        date &&
        !item.dates.some((known) => known.iso === date.iso && known.precision === date.precision)
      ) {
        item.dates.push(date);
      }
    }
  }

  const result = new Map();
  for (const [qid, item] of byQid) {
    const series = pickSeries(item.franchises);
    const date = pickDate(item.dates);
    result.set(qid, {
      qid,
      labels: item.labels,
      appids: item.appids,
      franchise: series
        ? {
            qid: series.qid,
            labelEn: series.labelEn || series.labelMul || null,
            labelRu: series.labelRu,
          }
        : null,
      date,
      releaseYear: date ? date.year : null,
      releasePrecision: date ? date.precision : null,
    });
  }
  return result;
}

/**
 * The actual bridge decision for one SKU.
 *
 * Guards, in order (a merge is a data change, so all of them are hard):
 *   1. **exact normalized title** — `coreTitle(wdLabel) === coreTitle(steamName)`
 *      (`Dishonored` ↔ `Dishonored RHCP`, but not `Dishonored 2`, not
 *      `Fallout` vs `Fallout: New Vegas`);
 *   2. **numeric signature** — `Gothic 1` never bridges to `Gothic 2`;
 *   3. the item must carry `P1733` (it is a Steam game, not a novel/film);
 *   4. if the SKU already knows its series (another provider), the base item
 *      must agree — a different franchise means a different work.
 *
 * @returns {{qid,appid,label,franchise,date}|null}
 */
function matchBaseFor(name, items, options = {}) {
  const key = editions.coreTitle(name);
  if (!key) return null;
  const signature = editions.numericSignature(editions.coreTokens(name));
  const franchiseKey = options.franchiseKey || null;
  let best = null;
  for (const item of items.values()) {
    if (!item.appids.length) continue;
    const label = item.labels.find(
      (candidate) =>
        editions.coreTitle(candidate) === key &&
        editions.numericSignature(editions.coreTokens(candidate)) === signature
    );
    if (!label) continue;
    if (
      franchiseKey &&
      item.franchise &&
      item.franchise.qid &&
      `wd:${item.franchise.qid}` !== franchiseKey
    ) {
      continue;
    }
    const appid = Math.min(...item.appids);
    const score = (item.franchise ? 2 : 0) + (item.releaseYear ? 1 : 0);
    if (
      !best ||
      score > best.score ||
      (score === best.score && qidNumber(item.qid) < qidNumber(best.qid))
    ) {
      best = {
        qid: item.qid,
        appid,
        label,
        franchise: item.franchise,
        date: item.date,
        score,
      };
    }
  }
  return best;
}

/** Does this links document need the bridge (no P1733 answer, no base yet)? */
function needsBaseBridge(doc, ttlMs, nowMs) {
  if (!doc) return false;
  const wdDoc = doc.wikidata && typeof doc.wikidata === 'object' ? doc.wikidata : null;
  if (!wdDoc || wdDoc.resolved !== true) return false;
  if (wdDoc.qid) return false;
  if (wdDoc.baseQid) return false;
  const at = Date.parse(String(wdDoc.baseCheckedAt || ''));
  if (Number.isFinite(at) && nowMs - at >= 0 && nowMs - at < ttlMs) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* The pass                                                            */
/* ------------------------------------------------------------------ */

function budgetFromEnv() {
  return budgetLimitFromEnv('GAMES_FRANCHISE_BUDGET', DEFAULT_BUDGET);
}

function ttlMsFromEnv() {
  return sources.ttlMs('wikidataFranchise');
}

/** Is this appid already answered inside the TTL window? */
function isLinksFresh(doc, ttlMs, nowMs) {
  if (!doc || !doc.wikidata || typeof doc.wikidata !== 'object') return false;
  if (doc.wikidata.resolved !== true) return false;
  const at = Date.parse(String(doc.wikidata.fetchedAt || doc.fetchedAt || ''));
  if (!Number.isFinite(at)) return false;
  return nowMs - at >= 0 && nowMs - at < ttlMs;
}

/**
 * B6 second batch: for every considered appid whose links document has no
 * `P1733` answer and no base identity yet, look the base version up by exact
 * label and write `baseQid`/`baseAppid` next to the SKU's own (absent) QID.
 *
 * Politeness is inherited: the same `runBatched` dispatcher (≤450 values per
 * query, pause, persisted breaker, shared lock in `franchise-jobs.js`), one
 * extra query for the whole library.
 */
async function runBaseBridge(context) {
  const { considered, provider, options, now, ttlMs, budget } = context;
  const report = {
    candidates: 0,
    asked: 0,
    queries: 0,
    answered: 0,
    bridged: 0,
    misses: 0,
    skipped: null,
    errors: [],
  };

  const pending = considered.filter((game) =>
    needsBaseBridge(readLinksDoc(game.appid), ttlMs, now())
  );
  report.candidates = pending.length;
  if (!pending.length) {
    report.skipped = 'nothing_to_bridge';
    return report;
  }

  const selected = pending.slice(0, budget);
  const labelsByAppid = new Map();
  for (const game of selected) {
    const labels = [];
    for (const text of labelVariants(game.name)) {
      for (const lang of labelLanguages(text)) labels.push({ text, lang });
    }
    if (labels.length) labelsByAppid.set(String(game.appid), labels);
  }
  const appids = [...labelsByAppid.keys()];
  if (!appids.length) {
    report.skipped = 'no_label';
    return report;
  }
  report.asked = appids.length;

  const result = await provider.runBatched(
    appids,
    (batch) =>
      baseLabelQuery(
        batch.map((appid) => ({ labels: labelsByAppid.get(appid) || [] }))
      ),
    'appid',
    { ...options, parse: parseBaseLabelResponse }
  );
  report.queries = result.queries;
  report.answered = result.credits.size;
  report.skipped = result.skipped || null;
  report.errors = [...(result.errors || [])];

  // Same rule as the first pass: a positive hit is real data and is written
  // even after a partial failure; a "nothing found" marker is written only
  // when Wikidata actually answered everything.
  const cleanAnswer = !result.skipped && !(result.errors || []).length;
  const fetchedAt = new Date(now()).toISOString();
  for (const appid of appids) {
    const game = selected.find((entry) => String(entry.appid) === appid);
    if (!game) continue;
    const existing = readLinksDoc(game.appid) || {};
    const best = matchBaseFor(game.name, result.credits, {
      franchiseKey: existing.franchiseKey || null,
    });
    if (!best && !cleanAnswer) continue;
    const patch = best
      ? {
          baseQid: best.qid,
          baseAppid: best.appid,
          baseName: best.label,
          baseReleaseYear: best.date ? best.date.year : null,
          baseReleasePrecision: best.date ? best.date.precision : null,
          baseFranchise: best.franchise,
          baseMatch: 'label',
          baseCheckedAt: fetchedAt,
        }
      : {
          baseQid: null,
          baseAppid: null,
          baseName: null,
          baseReleaseYear: null,
          baseReleasePrecision: null,
          baseFranchise: null,
          baseMatch: null,
          baseCheckedAt: fetchedAt,
        };
    writeLinksDoc(game.appid, { fetchedAt, sources: ['wikidata'], wikidata: patch });
    if (best) report.bridged++;
    else report.misses++;
  }
  return report;
}

/**
 * Ask Wikidata about the library of one cached profile and write
 * `links/<appid>.json`. Resumable: `links/` is the progress, `force` re-asks
 * everything. The caller (`franchise-jobs.js`) owns the cross-process lock.
 *
 * @param {{profileKey:string, limit?:number, force?:boolean,
 *          fetchImpl?:Function, stateStore?:object, now?:Function,
 *          sleep?:Function, pauseMs?:number, ttlMs?:number,
 *          bridge?:boolean}} options
 */
async function enrichFranchises(options = {}) {
  const parsed = gameCache.parseProfileToken(options.profileKey);
  if (!parsed) {
    throw new FranchiseError(
      `"profile": expected "steam-<steamid64>", got: ${options.profileKey}.`,
      'invalid_profile'
    );
  }
  const library = gameCache.getLibrary(parsed.userKey);
  if (!library) {
    throw new FranchiseError(
      `"profile": not a cached games profile: ${parsed.key}. Run the import first.`,
      'unknown_profile'
    );
  }
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Math.max(0, Number(options.ttlMs)) : ttlMsFromEnv();
  // NOTE: 0 → 1 request (pre-existing; `Math.max(1, …)` predates the «0 =
  // off» convention and is intentionally not changed here).
  const budget = Math.max(1, Number(options.limit) || budgetFromEnv());
  const force = Boolean(options.force);

  const report = {
    profile: parsed.key,
    force,
    games: 0,
    candidates: 0,
    updated: 0,
    skippedFresh: 0,
    remaining: 0,
    unavailableDetails: 0,
    releaseYearsFilled: 0,
    wdQueries: 0,
    wdAnswered: 0,
    wdSkipped: null,
    wdDisabledUntil: null,
    errors: [],
  };

  const considered = [];
  for (const game of library.games || []) {
    const appid = Number(game.appid);
    if (!Number.isInteger(appid) || appid <= 0) continue;
    const details = gameCache.getDetails(appid);
    // DLC/demo/software/video are not games: their franchise is the base
    // game's, and counting them would inflate every franchise (§5.1).
    if (details && details.success !== false && details.type && details.type !== 'game') continue;
    if (details && details.success === false) report.unavailableDetails++;
    considered.push({
      appid,
      name: (details && details.name) || game.name || null,
    });
  }
  report.games = considered.length;

  const candidates = [];
  for (const game of considered) {
    if (!force && isLinksFresh(readLinksDoc(game.appid), ttlMs, now())) {
      report.skippedFresh++;
      continue;
    }
    candidates.push(game);
  }
  report.remaining = Math.max(0, candidates.length - budget);
  const selected = candidates.slice(0, budget);
  report.candidates = selected.length;

  // The dispatcher (personnel/wikidata.js) owns the batches/pause/breaker.
  const provider = options.wikidata && typeof options.wikidata.runBatched === 'function'
    ? options.wikidata
    : wd;

  if (selected.length) {
    const result = await provider.runBatched(
      selected.map((game) => game.appid),
      franchiseQuery,
      'appid',
      { ...options, parse: parseFranchiseResponse }
    );
    report.wdQueries = result.queries;
    report.wdAnswered = result.credits.size;
    report.wdSkipped = result.skipped || null;
    report.wdDisabledUntil = result.disabledUntil || null;
    report.errors = [...(result.errors || [])];
    if (result.skipped) report.skipped = result.skipped;

    // A skipped/erroring answer is not an answer: positive hits may still be
    // written (they are real data), misses are not cached.
    const cleanAnswer = !result.skipped && !(result.errors || []).length;
    const fetchedAt = new Date(now()).toISOString();
    for (const game of selected) {
      const hit = result.credits.get(String(game.appid)) || null;
      if (!hit && !cleanAnswer) continue;
      const franchise = hit && hit.franchise ? hit.franchise : null;
      writeLinksDoc(game.appid, {
        fetchedAt,
        franchiseKey: franchise && franchise.qid ? `wd:${franchise.qid}` : null,
        sources: ['wikidata'],
        wikidata: {
          qid: hit ? hit.qid : null,
          franchise,
          releaseYear: hit ? hit.releaseYear : null,
          releasePrecision: hit ? hit.releasePrecision : null,
          releaseDate: hit ? hit.releaseDate : null,
          resolved: true,
          fetchedAt,
          // A fresh P1733 miss invalidates the previous bridge answer: the
          // base version must be re-checked against this new answer.
          ...(hit && hit.qid ? {} : { baseCheckedAt: null }),
        },
      });
      report.updated++;
      if (hit && hit.releaseYear) report.releaseYearsFilled++;
    }
  } else {
    report.skipped = 'nothing_to_ask';
  }

  // B6: the base-version bridge runs in the same pass (same budget/lock).
  if (options.bridge === false) {
    report.bridge = { skipped: 'disabled_by_option' };
  } else {
    const bridge = await runBaseBridge({ considered, provider, options, now, ttlMs, budget });
    report.bridge = bridge;
    report.bridgeCandidates = bridge.candidates;
    report.bridgeQueries = bridge.queries;
    report.bridgeAnswered = bridge.answered;
    report.bridged = bridge.bridged;
    report.bridgeMisses = bridge.misses;
    if (bridge.errors && bridge.errors.length) {
      report.errors = [...report.errors, ...bridge.errors];
    }
    if (!selected.length && bridge.asked) report.skipped = null;
  }

  // Secondary-only works (GOG/Epic exclusives): P179 by their already-known
  // QID. Runs in the same pass/lock with the same dispatcher, pause and
  // breaker; the store-slug/QID cache is the progress, so a second run costs
  // nothing unless something is missing or `force` is set.
  if (options.secondary === false) {
    report.secondary = { skipped: 'disabled_by_option' };
  } else {
    try {
      const secondary = await enrichSecondaryFranchises({
        ...options,
        ownerKey: parsed.key,
        limit: budget,
        now,
        ttlMs,
      });
      report.secondary = secondary;
      report.secondaryTargets = secondary.targets || 0;
      report.secondaryCandidates = secondary.candidates || 0;
      report.secondarySelected = secondary.selected || 0;
      report.secondaryUpdated = secondary.updated || 0;
      report.secondarySkippedFresh = secondary.skippedFresh || 0;
      report.secondaryQueries = secondary.queries || 0;
      report.secondarySkipped = secondary.skipped || null;
      report.wdQueries += secondary.queries || 0;
      report.wdAnswered += secondary.answered || 0;
      if (!selected.length && (secondary.queries || 0) > 0) report.skipped = null;
      if (secondary.errors && secondary.errors.length) {
        report.errors = [...report.errors, ...secondary.errors];
      }
    } catch (err) {
      report.secondary = { skipped: 'secondary_failed', error: String((err && err.message) || '').slice(0, 200) };
    }
  }

  recordRun(parsed.key, report);
  return report;
}

/* ------------------------------------------------------------------ */
/* B6: canonical metadata of the base version (store appdetails)       */
/* ------------------------------------------------------------------ */

function baseDetailsBudgetFromEnv() {
  return budgetLimitFromEnv('GAMES_BASE_DETAILS_BUDGET', DEFAULT_BASE_DETAILS_BUDGET);
}

/**
 * Fetch `appdetails` for the base versions the bridge discovered, into
 * `details-base/<baseAppid>.json`.
 *
 * Why a separate pass (and not part of the WD batch):
 *   - it is a *store* request (1.7 s pause, 30-minute store breaker), not a
 *     WDQS one — mixing them would hold the WD lock for a minute;
 *   - it is deliberately tiny: `GAMES_BASE_DETAILS_BUDGET` (default **20**)
 *     appids per run, because only the `qid: null` regionals need it;
 *   - `details/` is untouched: the owner does not own the base card, and that
 *     directory's file count is the enrich job's progress counter.
 *
 * A `success:false` answer is an honest "no store page" and is cached (the
 * store client owns that decision); a network/429 failure is NOT written.
 *
 * @param {{profileKey:string, limit?:number, storeClient?:object,
 *          now?:Function}} options
 */
async function enrichBaseDetails(options = {}) {
  const parsed = gameCache.parseProfileToken(options.profileKey);
  if (!parsed) {
    throw new FranchiseError(
      `"profile": expected "steam-<steamid64>", got: ${options.profileKey}.`,
      'invalid_profile'
    );
  }
  const library = gameCache.getLibrary(parsed.userKey);
  if (!library) {
    throw new FranchiseError(
      `"profile": not a cached games profile: ${parsed.key}. Run the import first.`,
      'unknown_profile'
    );
  }
  const budget = Math.max(1, Number(options.limit) || baseDetailsBudgetFromEnv());
  const report = {
    profile: parsed.key,
    budget,
    candidates: 0,
    fetched: 0,
    unavailable: 0,
    skippedFresh: 0,
    remaining: 0,
    skipped: null,
    errors: [],
  };

  const needed = [];
  for (const game of library.games || []) {
    const appid = Number(game.appid);
    if (!Number.isInteger(appid) || appid <= 0) continue;
    const link = readLinks(appid);
    if (!link || !link.baseAppid) continue;
    if (needed.includes(link.baseAppid)) continue;
    const existing = gameCache.getDetailsBase(link.baseAppid);
    if (existing && store.detailsFresh(existing)) {
      report.skippedFresh++;
      continue;
    }
    needed.push(link.baseAppid);
  }
  report.candidates = needed.length;
  const selected = needed.slice(0, budget);
  report.remaining = Math.max(0, needed.length - selected.length);
  if (!selected.length) {
    report.skipped = 'nothing_to_fetch';
    return report;
  }

  const client = options.storeClient || store.createClient(options.storeOptions || {});
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  for (const baseAppid of selected) {
    try {
      const doc = await client.getAppDetails(baseAppid);
      // `fetchedAt` drives `store.detailsFresh()` on the next run — the store
      // parser does not stamp the clock (the caller owns it, same as enrich.js).
      const payload = { ...doc, fetchedAt: new Date(now()).toISOString() };
      await gameCache.saveDetailsBase(baseAppid, payload);
      if (payload.success === false) report.unavailable++;
      else report.fetched++;
    } catch (err) {
      // A breaker/network answer is deferred: nothing is written, the next
      // run retries (AGENTS §1: no negative cache for an outage).
      report.errors.push((err && err.code) || 'store_error');
    }
  }
  return report;
}

/* ------------------------------------------------------------------ */
/* Secondary-only works: franchise pass                                */
/* ------------------------------------------------------------------ */

/**
 * Works of one owner that exist **only** outside Steam, with the Wikidata QID
 * the secondary bridge already resolved for their store slug. A slug without
 * a QID is not a candidate: there is nothing to ask (and the store details
 * pass may still resolve the identity later).
 *
 * @returns {Array<{store:'gog'|'epic', slug:string, qid:string, title:string|null}>}
 */
function secondaryFranchiseTargets(ownerKey, options = {}) {
  const key = String(ownerKey == null ? '' : ownerKey).trim();
  if (!key) return [];
  // Lazy requires: `secondary-details` → `secondary` → `franchise` is a cycle
  // at module-load time, but not at call time.
  const { targetsForOwner } = require('./secondary-details');
  const { readSecondaryLinks, readSecondaryTitleLinks, normalizeSlug } = require('./secondary-identity');
  const links = options.links && typeof options.links === 'object'
    ? options.links
    : readSecondaryLinks({ allowStale: true });
  const titleLinks = options.titleLinks && typeof options.titleLinks === 'object'
    ? options.titleLinks
    : readSecondaryTitleLinks({ allowStale: true });
  const targets = targetsForOwner(key);
  const list = [
    ...(targets.gog || []).map((target) => ({ store: 'gog', slug: target.slug, title: target.title })),
    ...(targets.epic || []).map((target) => ({ store: 'epic', slug: target.slug, title: target.title })),
  ];
  const out = [];
  const seen = new Set();
  for (const target of list) {
    const rawSlug = String(target.slug == null ? '' : target.slug).trim();
    if (!rawSlug) continue;
    const slug = normalizeSlug(rawSlug);
    if (!slug) continue;
    const link =
      links[`${target.store}:${slug}`] ||
      links[`${target.store}:${rawSlug}`] ||
      titleLinks[`${target.store}:${slug}`] ||
      titleLinks[`${target.store}:${rawSlug}`] ||
      null;
    const qid = link && link.qid ? String(link.qid) : null;
    if (!qid || !/^Q\d+$/.test(qid)) continue;
    const dedupe = `${target.store}:${slug}:${qid}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ store: target.store, slug, qid, title: target.title || null });
  }
  return out;
}

/**
 * Ask P179 for the secondary-only works of one owner and write
 * `links/secondary-franchise.json`.
 *
 * Same dispatcher as the Steam pass (`runBatched`: ≤450 QIDs, pause, shared
 * WD breaker), same budget knob (`GAMES_FRANCHISE_BUDGET`, counted in QIDs /
 * batches) and the same 90-day TTL. A skipped/erroring answer writes nothing
 * for misses; a positive hit is real data and is written anyway.
 *
 * @param {{ownerKey?:string, profileKey?:string, targets?:Array,
 *          limit?:number, force?:boolean, ttlMs?:number, now?:Function,
 *          wikidata?:object, links?:object, titleLinks?:object,
 *          fetchImpl?:Function, stateStore?:object, sleep?:Function,
 *          pauseMs?:number}} [options]
 */
async function enrichSecondaryFranchises(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const ttlMs = Number.isFinite(Number(options.ttlMs))
    ? Math.max(0, Number(options.ttlMs))
    : ttlMsFromEnv();
  const budget = Math.max(1, Number(options.limit) || budgetFromEnv());
  const force = Boolean(options.force);
  const ownerKey = options.ownerKey || options.profileKey || '';
  const report = {
    owner: ownerKey || null,
    targets: 0,
    candidates: 0,
    selected: 0,
    remaining: 0,
    updated: 0,
    skippedFresh: 0,
    queries: 0,
    answered: 0,
    skipped: null,
    disabledUntil: null,
    errors: [],
  };
  const targets = Array.isArray(options.targets)
    ? options.targets
    : secondaryFranchiseTargets(ownerKey, options);
  report.targets = targets.length;
  const doc = readSecondaryFranchise();
  const pending = [];
  for (const target of targets) {
    const entry =
      doc.entries[`${target.store}:${target.slug}`] ||
      (target.qid ? doc.entries[`qid:${target.qid}`] : null);
    if (!force && isSecondaryFranchiseFresh(entry, ttlMs, now())) {
      report.skippedFresh++;
      continue;
    }
    pending.push(target);
  }
  report.candidates = pending.length;
  const qids = [];
  for (const target of pending) {
    if (!qids.includes(target.qid)) qids.push(target.qid);
  }
  const selectedQids = qids.slice(0, budget);
  report.selected = selectedQids.length;
  report.remaining = Math.max(0, qids.length - selectedQids.length);
  if (!selectedQids.length) {
    report.skipped = 'nothing_to_ask';
    return report;
  }

  const provider =
    options.wikidata && typeof options.wikidata.runBatched === 'function'
      ? options.wikidata
      : wd;
  const result = await provider.runBatched(
    selectedQids,
    qidFranchiseQuery,
    'qid',
    { ...options, parse: parseFranchiseByQid }
  );
  report.queries = result.queries;
  report.answered = result.credits.size;
  report.skipped = result.skipped || null;
  report.disabledUntil = result.disabledUntil || null;
  report.errors = [...(result.errors || [])];

  const cleanAnswer = !result.skipped && !(result.errors || []).length;
  const fetchedAt = new Date(now()).toISOString();
  const patch = {};
  for (const target of pending) {
    if (!selectedQids.includes(target.qid)) continue;
    const hit = result.credits.get(target.qid) || null;
    if (!hit && !cleanAnswer) continue;
    const entry = secondaryFranchiseEntry(hit, {
      store: target.store,
      slug: target.slug,
      fetchedAt,
    });
    patch[`${target.store}:${target.slug}`] = entry;
    // The QID key is the identity-level answer: another slug of the same item
    // (GOG + Epic) reads it without a second query.
    patch[`qid:${target.qid}`] = { ...entry, store: null, slug: null };
    report.updated++;
  }
  if (Object.keys(patch).length) writeSecondaryFranchiseEntries(patch, { fetchedAt });
  return report;
}

module.exports = {
  LINKS_DIR,
  STATE_PATH,
  SECONDARY_FRANCHISE_PATH,
  DEFAULT_BUDGET,
  DEFAULT_TTL_DAYS,
  DEFAULT_BASE_DETAILS_BUDGET,
  PRECISION_BY_WD,
  FranchiseError,
  linksPath,
  readLinksDoc,
  readLinks,
  readLinksMap,
  writeLinksDoc,
  readSecondaryFranchise,
  writeSecondaryFranchiseEntries,
  secondaryFranchiseFrom,
  secondaryFranchiseEntry,
  isSecondaryFranchiseFresh,
  readFranchiseState,
  saveFranchiseState,
  appidValues,
  franchiseQuery,
  qidFranchiseQuery,
  parseFranchiseByQid,
  baseLabelQuery,
  labelVariants,
  labelLanguages,
  parseBaseLabelResponse,
  matchBaseFor,
  needsBaseBridge,
  parseWbDate,
  pickDate,
  parseFranchiseResponse,
  isLinksFresh,
  budgetFromEnv,
  ttlMsFromEnv,
  secondaryFranchiseTargets,
  enrichSecondaryFranchises,
  enrichFranchises,
  enrichBaseDetails,
};
