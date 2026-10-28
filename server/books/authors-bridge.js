'use strict';

/**
 * Default-on Wikidata bridge for author spellings the offline rule cannot
 * connect (КНИГИ-АРХИТЕКТУРА §7.2).
 *
 * The offline rule in `authors.js` (normalize + ids + transliteration) proves
 * most RU/EN pairs, but an established exonym has nothing to prove:
 * «Уильям Сомерсет Моэм» vs «W. Somerset Maugham», «Говард Лавкрафт» vs
 * «H. P. Lovecraft». Until 28.10.2026 the bridge only ran from
 * `npm run backfill:authors -- --wikidata`, so a fresh deployment kept those
 * duplicates until the user typed the command — unacceptable.
 *
 * Policy here (the transport stays in `authors-wikidata.js`):
 *
 *   - only spellings that are still a *singleton* group after the offline rule
 *     AND were never asked from WDQS (`authors.json → wikidata.checked`);
 *   - one batch per stage (≤450 values), all candidates together: for a
 *     personal profile that is 1–3 SPARQL calls once per new spelling;
 *   - a repeat payload build with a full cache issues ZERO requests;
 *   - `429`/`403`/network failure → degrade and start a 30-min cooldown
 *     (`wikidata.disabledUntil`), so a blocked WDQS is not hammered on every
 *     request; the answer is retried later without user action;
 *   - fire-and-forget: `/api/books/stats` never waits for the network, the
 *     merged table is applied by the next payload (the UI refresh after a
 *     resolve job is what shows the merge);
 *   - `manual` edits in `authors.json` always win over a Wikidata merge.
 *
 * Kill switch: `KINOBOXD_BOOKS_WIKIDATA=off` (tests/offline deployments).
 */

const authors = require('./authors');
const wd = require('./authors-wikidata');
const bookCache = require('./book-cache');

const COOLDOWN_MS = 30 * 60 * 1000;
/** Upper bound of names per automatic pass (2 SPARQL name batches). */
const MAX_NAMES_PER_RUN = 900;

/** In-process guard: never run two automatic passes at once. */
let inFlight = null;
/** Minimum gap between two automatic passes (a polling UI must not burst WDQS). */
const MIN_GAP_MS = 5000;
let lastPassStartedAt = 0;

function wikidataEnabled() {
  const raw = String(process.env.KINOBOXD_BOOKS_WIKIDATA || '').trim().toLowerCase();
  return !['0', 'off', 'false', 'no'].includes(raw);
}

/**
 * Spellings still worth asking Wikidata about.
 *
 * @param {Array<{name:string}>} entries every author occurrence
 * @param {object} persisted `authors.json` document
 * @param {Array<{names:string[]}>} [groups] the grouping the payload already
 *        built (`groupAuthors(...).groups`); a group of one name is a spelling
 *        the offline rule could not connect. Omitted → computed here.
 * @returns {string[]} display spellings, deduped
 */
function pendingCandidates(entries, persisted = {}, groups = null) {
  const checked = (persisted && persisted.wikidata && persisted.wikidata.checked) || {};
  const list = Array.isArray(groups)
    ? groups
    : authors.groupAuthors(entries, persisted || {}).groups;
  const out = [];
  const seen = new Set();
  for (const group of list) {
    // Already merged (Hardcover id, manual alias, transliteration) or merged by
    // an earlier Wikidata pass: nothing left to connect.
    if (!group || !Array.isArray(group.names) || group.names.length !== 1) continue;
    const name = group.names[0];
    const key = authors.normalizeAuthorName(name);
    if (!key || seen.has(key) || checked[key]) continue;
    seen.add(key);
    out.push(String(name));
  }
  return out;
}

function cooldownUntil(persisted) {
  const state = persisted && persisted.wikidata;
  if (!state || !state.disabledUntil) return 0;
  const at = Date.parse(String(state.disabledUntil));
  return Number.isFinite(at) ? at : 0;
}

/**
 * One bounded Wikidata pass. Never rejects on a network/quota problem: the
 * caller (a stats build) must not learn about WDQS at all.
 *
 * @param {Array<{name:string}>} entries
 * @param {{persisted?:object, groups?:Array, fetchImpl?:Function,
 *          sleep?:Function, pauseMs?:number, maxNames?:number,
 *          cooldownMs?:number, now?:Function, force?:boolean}} options
 * @returns {Promise<{ran:boolean, reason?:string, pending:number,
 *                    queries:number, merged:number, checked:number,
 *                    skipped?:string|null, names?:Array}>}
 */
async function resolveAuthorsWikidata(entries, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const persisted = options.persisted || bookCache.getAuthorsMap();
  const pending = pendingCandidates(entries, persisted, options.groups);
  if (!pending.length) {
    return { ran: false, reason: 'nothing_to_do', pending: 0, queries: 0, merged: 0, checked: 0 };
  }
  if (!options.force) {
    if (!wikidataEnabled() && options.ignoreEnv !== true) {
      return { ran: false, reason: 'disabled', pending: pending.length, queries: 0, merged: 0, checked: 0 };
    }
    const until = cooldownUntil(persisted);
    if (until > now()) {
      return {
        ran: false,
        reason: 'cooldown',
        pending: pending.length,
        queries: 0,
        merged: 0,
        checked: 0,
        until: new Date(until).toISOString(),
      };
    }
  }

  const maxNames = options.maxNames == null ? MAX_NAMES_PER_RUN : Number(options.maxNames);
  const names = pending.slice(0, Math.max(0, maxNames));

  let result;
  try {
    result = await wd.resolveWikidataAliases(entries, {
      persisted,
      names,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
      pauseMs: options.pauseMs,
      limit: names.length,
    });
  } catch (err) {
    // Unknown failure (DNS, TLS, malformed JSON, timeout): degrade and back off.
    await applyCooldown(options, err);
    console.warn(
      `[books-authors] wikidata unavailable (${(err && err.message) || 'error'}), ` +
        'degraded to the offline rule'
    );
    return {
      ran: false,
      reason: 'error',
      pending: pending.length,
      queries: 0,
      merged: 0,
      checked: 0,
      error: (err && err.message) || 'wikidata_failed',
    };
  }

  if (result.skipped) {
    // Nothing was merged. Do NOT remember the names as checked: a transient
    // block must not freeze the merge set forever.
    await applyCooldown(options, {
      status: result.skipped,
      retryAfter: result.retryAfter,
    });
    console.warn(`[books-authors] wikidata ${result.skipped}, cooldown started; duplicates stay for now`);
    return {
      ran: true,
      reason: 'degraded',
      pending: pending.length,
      queries: result.queries || 0,
      merged: 0,
      checked: 0,
      skipped: result.skipped,
    };
  }

  const checkedKeys = {};
  for (const name of result.checked || []) {
    const key = authors.normalizeAuthorName(name);
    if (key) checkedKeys[key] = true;
  }
  if (options.persist === false) {
    return {
      ran: true,
      reason: 'dry_run',
      pending: pending.length,
      queries: result.queries || 0,
      merged: (result.merged || []).length,
      checked: Object.keys(checkedKeys).length,
      names: result.merged || [],
    };
  }
  try {
    await bookCache.saveAuthorsMap({
      canonical: result.canonical || {},
      wikidata: {
        checked: checkedKeys,
        checkedAt: new Date(now()).toISOString(),
        // A successful pass clears any earlier cooldown.
        disabledUntil: null,
      },
    });
  } catch (err) {
    // A read-only cache must not break the payload; the merge is retried later.
    console.warn(`[books-authors] authors.json is not writable: ${(err && err.message) || 'save_failed'}`);
    return {
      ran: true,
      reason: 'cache_read_only',
      pending: pending.length,
      queries: result.queries || 0,
      merged: (result.merged || []).length,
      checked: Object.keys(checkedKeys).length,
      error: (err && err.message) || 'save_failed',
    };
  }

  return {
    ran: true,
    reason: 'ok',
    pending: pending.length,
    queries: result.queries || 0,
    merged: (result.merged || []).length,
    checked: Object.keys(checkedKeys).length,
    names: result.merged || [],
  };
}

/**
 * One-line operation log: which QID merges were applied and how much the pass
 * cost. Silent for the "nothing to do" case, which is every normal payload.
 */
function logPass(report) {
  if (!report || !report.ran) return;
  if (report.reason === 'ok' || report.reason === 'dry_run') {
    if (!report.merged) return;
    console.log(
      `[books-authors] wikidata merged=${report.merged} queries=${report.queries} ` +
        `checked=${report.checked}`
    );
  }
}

/** Persist the cooldown (best-effort; a read-only cache just skips it). */
async function applyCooldown(options, err) {
  if (options.persist === false) return null;
  const persisted = options.persisted || bookCache.getAuthorsMap();
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const base = options.cooldownMs == null ? COOLDOWN_MS : Number(options.cooldownMs);
  // `Retry-After` (seconds) wins when it is longer than our default pause.
  const retrySeconds = err && Number.isFinite(Number(err.retryAfter)) && Number(err.retryAfter) > 0
    ? Number(err.retryAfter) * 1000
    : 0;
  const until = new Date(now() + Math.max(base, retrySeconds)).toISOString();
  try {
    await bookCache.saveAuthorsMap({
      wikidata: { checked: {}, checkedAt: persisted.wikidata ? persisted.wikidata.checkedAt : null, disabledUntil: until },
    });
  } catch (saveErr) {
    // ignored on purpose
  }
  return until;
}

/**
 * Fire-and-forget hook for the stats route: returns a promise the caller may
 * ignore (and must not await). Coalesces concurrent calls into one pass.
 */
function kickAuthorsWikidata(entries, options = {}) {
  if (inFlight) return inFlight;
  if (!Array.isArray(entries) || !entries.length) return null;
  if (!wikidataEnabled()) return null;
  // A deep profile may need more than one pass; the UI polls stats while a
  // resolve job runs, so keep a floor between automatic passes.
  const gap = options.minGapMs == null ? MIN_GAP_MS : Number(options.minGapMs);
  if (gap > 0 && Date.now() - lastPassStartedAt < gap) return null;
  lastPassStartedAt = Date.now();
  const promise = resolveAuthorsWikidata(entries, options)
    .then((report) => {
      logPass(report);
      return report;
    })
    .catch(() => null)
    .finally(() => {
      if (inFlight === promise) inFlight = null;
    });
  inFlight = promise;
  return promise;
}

/** Test helper: is a pass running? Also lets a test drain the last one. */
function currentPass() {
  return inFlight;
}

module.exports = {
  COOLDOWN_MS,
  MAX_NAMES_PER_RUN,
  wikidataEnabled,
  pendingCandidates,
  resolveAuthorsWikidata,
  kickAuthorsWikidata,
  currentPass,
};
