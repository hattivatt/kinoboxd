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
 * Kill switch: `KINOBOXD_GAMES_WD=off` (shared with the personnel provider).
 * Budget: `GAMES_FRANCHISE_BUDGET` appids per pass (default 450 = one batch).
 * TTL: `GAMES_FRANCHISE_TTL_DAYS` (default 90).
 */

const path = require('path');

const gameCache = require('./game-cache');
const wd = require('./personnel/wikidata');

const LINKS_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'links');
const STATE_PATH = path.join(gameCache.STATE_DIR, 'franchise-state.json');

const DEFAULT_BUDGET = 450;
const DEFAULT_TTL_DAYS = 90;
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
  };
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

    const series = [...chosen.franchises.values()].sort((a, b) => {
      const labeledA = a.labelEn || a.labelRu || a.labelMul ? 1 : 0;
      const labeledB = b.labelEn || b.labelRu || b.labelMul ? 1 : 0;
      if (labeledA !== labeledB) return labeledB - labeledA;
      return qidNumber(a.qid) - qidNumber(b.qid);
    })[0];

    const date = chosen.dates.slice().sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      const rank = (PRECISION_RANK[b.precision] || 0) - (PRECISION_RANK[a.precision] || 0);
      if (rank) return rank;
      return a.time - b.time;
    })[0];

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
/* The pass                                                            */
/* ------------------------------------------------------------------ */

function budgetFromEnv() {
  const raw = Number(process.env.GAMES_FRANCHISE_BUDGET);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_BUDGET;
}

function ttlMsFromEnv() {
  const raw = Number(process.env.GAMES_FRANCHISE_TTL_DAYS);
  const days = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_DAYS;
  return days * 24 * 60 * 60 * 1000;
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
 * Ask Wikidata about the library of one cached profile and write
 * `links/<appid>.json`. Resumable: `links/` is the progress, `force` re-asks
 * everything. The caller (`franchise-jobs.js`) owns the cross-process lock.
 *
 * @param {{profileKey:string, limit?:number, force?:boolean,
 *          fetchImpl?:Function, stateStore?:object, now?:Function,
 *          sleep?:Function, pauseMs?:number, ttlMs?:number}} options
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

  if (!selected.length) {
    report.skipped = 'nothing_to_ask';
    recordRun(parsed.key, report);
    return report;
  }

  // The dispatcher (personnel/wikidata.js) owns the batches/pause/breaker.
  const provider = options.wikidata && typeof options.wikidata.runBatched === 'function'
    ? options.wikidata
    : wd;
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
      },
    });
    report.updated++;
    if (hit && hit.releaseYear) report.releaseYearsFilled++;
  }

  recordRun(parsed.key, report);
  return report;
}

module.exports = {
  LINKS_DIR,
  STATE_PATH,
  DEFAULT_BUDGET,
  DEFAULT_TTL_DAYS,
  PRECISION_BY_WD,
  FranchiseError,
  linksPath,
  readLinksDoc,
  readLinks,
  writeLinksDoc,
  readFranchiseState,
  saveFranchiseState,
  appidValues,
  franchiseQuery,
  parseWbDate,
  parseFranchiseResponse,
  isLinksFresh,
  enrichFranchises,
};
