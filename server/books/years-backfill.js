'use strict';

/**
 * First-publication-year backfill for existing details documents.
 *
 * Why this exists: the year chart reads `details.firstPublishedYear` and
 * nothing else (stats.js `firstPublishedYearOf`). A cache built before that
 * field existed — or before a provider was asked — has `publicationYear` (the
 * print run in hand) but no first-publication claim, so every classic falls
 * into «год неизвестен». `resolveProfile` cannot fix that on its own: it skips
 * a LiveLib book that already has a cached link, so the document is never
 * re-fetched.
 *
 * This job re-asks only for the missing year:
 *   - candidates: details docs with no `firstPublishedYear` (or `--force`);
 *   - providers: Hardcover (ISBN only, book-level `release_year`) →
 *     Литрес (Cyrillic titles, «дата написания») → Open Library (ISBN edition
 *     → work `first_publish_year`, then title search);
 *   - the earliest claim wins (`providers.earliestFirstYear`) — the same rule
 *     the import merge uses, so a later print run can never outvote an older
 *     honest year;
 *   - only `firstPublishedYear` + `firstPublishedYearSource` are written; the
 *     rest of the document (genres, series, cover, links) is untouched;
 *   - the LiveLib card never enters this path: no scraping, no cookies.
 *
 * Budgets (AGENTS.md): Литрес ≤ `BOOKS_LITRES_BUDGET` books/run (default 200,
 * 2 requests and a 2 s pause per book), Hardcover ≤ 55 req/min via the shared
 * gate, Open Library with the provider's 250 ms delay. Run it in slices:
 *
 *   BOOKS_LITRES_BUDGET=40 node server/books/years-backfill.js --limit 20 --dry-run
 *   BOOKS_LITRES_BUDGET=40 node server/books/years-backfill.js --limit 20
 *   node server/books/years-backfill.js --ids lr:73939817,ol:OL37431263W
 *
 * Negative cache: a document nobody could answer for is marked with
 * `firstPublishedYearCheckedAt` (+ `firstPublishedYearCheckedBy`), and the next
 * run inside `DEFAULT_RECHECK_DAYS` skips it without a single request. Without
 * that marker a re-run would re-ask Hardcover/Литрес/OL for every hopeless book
 * forever — the same "repeat the run" idempotency the film backfills have.
 * `--force` (or `--ids`, an explicit request) bypasses the marker.
 */

const fs = require('fs');
const path = require('path');

const bookCache = require('./book-cache');
const providers = require('./providers');
const litres = require('./providers/litres');
const openlibrary = require('./providers/openlibrary');
const hardcover = require('./providers/hardcover');

const DEFAULT_LIMIT = 20;
const DEFAULT_PAUSE_MS = 2000; // Литрес politeness (AGENTS.md)
/** Days a "nobody knows the year" verdict stays final before re-asking. */
const DEFAULT_RECHECK_DAYS = 30;

const CYRILLIC_TITLE = /[а-яё]/i;

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Timestamp of the last hopeless check of a document, or null. */
function checkedAtOf(doc) {
  const ts = Date.parse(String((doc && doc.firstPublishedYearCheckedAt) || ''));
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Has this document been checked for a first-publication year recently enough
 * that asking the providers again would be pure politeness debt?
 */
function recentlyChecked(doc, now, recheckDays) {
  const ts = checkedAtOf(doc);
  if (ts == null) return false;
  const days = Number(recheckDays);
  const window = Number.isFinite(days) && days >= 0 ? days : DEFAULT_RECHECK_DAYS;
  return now - ts < window * 24 * 60 * 60 * 1000;
}

/** Details documents on disk (`cache-book/details/*.json`). */
function detailDocs() {
  let names = [];
  try {
    names = fs.readdirSync(bookCache.DETAILS_DIR).filter((name) => name.endsWith('.json'));
  } catch (err) {
    return [];
  }
  const out = [];
  for (const name of names) {
    const key = path.basename(name, '.json');
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(bookCache.DETAILS_DIR, name), 'utf8'));
      if (doc && typeof doc === 'object') out.push({ key, doc });
    } catch (err) {
      // A half-written document is not a candidate; the cache reader skips it too.
    }
  }
  return out;
}

function authorsOf(doc) {
  return (Array.isArray(doc && doc.authors) ? doc.authors : [])
    .map((entry) => (entry && typeof entry === 'object' ? entry.name : entry))
    .filter(Boolean);
}

function workIdOf(doc) {
  if (!doc) return null;
  return doc.workId || (doc.hcWorkId != null ? `hc:${doc.hcWorkId}` : null);
}

/**
 * Ask the chain for one work's first publication.
 * Returns `{year, source, candidates}`; `year` is null when nobody knows.
 */
async function firstYearForDoc(doc, options = {}) {
  const sleep = options.sleep || sleepDefault;
  const pause = options.pause == null ? DEFAULT_PAUSE_MS : Number(options.pause);
  const lookupIsbns = options.lookupIsbns;
  const budget = options.budget || null;
  const authors = authorsOf(doc);
  const isbn13 = doc.isbn13 || null;
  const isbn10 = doc.isbn10 || null;
  const title = doc.title || null;
  const hardcoverProvider = options.hardcoverProvider || hardcover;
  const litresProvider = options.litresProvider || litres;
  const openlibraryProvider = options.openlibraryProvider || openlibrary;

  const candidates = [];
  const push = (result, label) => {
    if (!result) return;
    const year = providers.firstYearOf(result.firstPublishedYear);
    if (year == null) return;
    candidates.push({ year, source: label || result.source, workId: result.workId || null });
  };

  const input = { isbn13, isbn10, title, authors };

  // 1. Hardcover knows the work by ISBN (`book.release_year`).
  // `requireWorkClaim` keeps the product rule strict: an edition year is not a
  // first-publication claim, so a legacy document that only has one contributes
  // nothing here (the other providers still get their turn).
  if (isbn13 || isbn10) {
    try {
      push(
        await hardcoverProvider.getWork(input, {
          lookupIsbns,
          sleep,
          requestDelayMs: pause,
          requireWorkClaim: true,
        }),
        'hardcover'
      );
    } catch (err) {
      // ISBN lookups degrade quietly: the other providers still run.
    }
  }

  // 2. Литрес is the RU metadata source («дата написания»).
  if (title && CYRILLIC_TITLE.test(title)) {
    try {
      push(
        await litresProvider.getWork(input, { budget, sleep, litresPauseMs: pause }),
        'litres'
      );
    } catch (err) {
      // Breaker/429 → the other providers still run.
    }
  }

  // 3. Open Library: ISBN edition → work `first_publish_year`, then title search.
  try {
    push(await openlibraryProvider.getWork(input, { sleep, requestDelayMs: 250 }), 'openlibrary');
  } catch (err) {
    // Offline/5xx is not fatal for a backfill.
  }

  const year = candidates.reduce(
    (best, entry) => (best == null || entry.year < best ? entry.year : best),
    null
  );
  const winner = year == null ? null : candidates.find((entry) => entry.year === year);
  return { year, source: winner ? winner.source : null, candidates };
}

/**
 * Backfill loop.
 *
 * Options: `limit` (0 = no cap), `ids` (array), `force`, `dryRun`, `pause`,
 * `budget`, `sleep`, `now` (ISO string), `recheckDays`, provider overrides,
 * `log`.
 */
async function backfill(options = {}) {
  const dryRun = options.dryRun === true;
  const limit = options.limit == null ? DEFAULT_LIMIT : Number(options.limit);
  const ids = Array.isArray(options.ids) ? new Set(options.ids.map(String)) : null;
  const force = options.force === true;
  const log = typeof options.log === 'function' ? options.log : console.log;
  const budget = options.budget === undefined ? litres.budgetFromEnv() : options.budget;
  const nowDate = options.now ? new Date(options.now) : new Date();
  const checkedAt = nowDate.toISOString();
  const nowMs = nowDate.getTime();
  const recheckDays =
    options.recheckDays == null ? DEFAULT_RECHECK_DAYS : Number(options.recheckDays);

  const docs = detailDocs();
  const candidates = [];
  let skippedChecked = 0;
  for (const { key, doc } of docs) {
    const workId = workIdOf(doc);
    if (!workId) continue;
    const matchesId =
      ids &&
      [...ids].some(
        (id) => id === workId || id === key || id === doc.workId || id === String(doc.hcWorkId)
      );
    if (ids && !matchesId) continue;
    if (!ids && !force && providers.firstYearOf(doc.firstPublishedYear) != null) continue;
    // A hopeless document is left alone for `recheckDays`: re-asking three
    // providers for a year nobody has is exactly the load AGENTS.md budgets
    // against. An explicit `--ids` still wins — the user asked for that one.
    if (!ids && !force && recentlyChecked(doc, nowMs, recheckDays)) {
      skippedChecked++;
      continue;
    }
    candidates.push({ key, doc, workId });
  }

  const selected = limit > 0 ? candidates.slice(0, limit) : candidates;
  const report = {
    scanned: docs.length,
    candidates: candidates.length,
    selected: selected.length,
    skippedChecked,
    checked: 0,
    resolved: [],
    unknown: [],
    errors: [],
    byProvider: {},
    litresBudgetUsed: 0,
  };

  for (const { key, doc, workId } of selected) {
    report.checked++;
    try {
      const found = await firstYearForDoc(doc, {
        ...options,
        budget,
      });
      if (found.year == null) {
        report.unknown.push({ workId, title: doc.title || null });
        log(`— ${workId} ${doc.title || ''} :: no first-publication claim`);
        // Negative cache: the next run must not repeat these requests.
        if (!dryRun) {
          await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), {
            ...doc,
            firstPublishedYearCheckedAt: checkedAt,
            firstPublishedYearCheckedBy: found.candidates.length
              ? [...new Set(found.candidates.map((entry) => entry.source))].join(',')
              : 'none',
          });
        }
        continue;
      }
      report.byProvider[found.source] = (report.byProvider[found.source] || 0) + 1;
      report.resolved.push({
        workId,
        title: doc.title || null,
        year: found.year,
        source: found.source,
        publicationYear: doc.publicationYear == null ? null : Number(doc.publicationYear),
      });
      log(
        `${workId} ${doc.title || ''} :: ${found.year}` +
          ` (${found.source}; edition ${doc.publicationYear == null ? '?' : doc.publicationYear})`
      );
      if (!dryRun) {
        await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), {
          ...doc,
          firstPublishedYear: found.year,
          firstPublishedYearSource: found.source,
          firstPublishedYearCheckedAt: checkedAt,
          firstPublishedYearCheckedBy: found.source,
        });
      }
    } catch (err) {
      report.errors.push({ workId, error: err && err.message ? err.message : String(err) });
      log(`ERROR ${workId}: ${err && err.message}`);
    }
    if (budget && typeof budget.remaining === 'number') report.litresBudgetUsed = budget.used;
  }
  if (budget && typeof budget.used === 'number') report.litresBudgetUsed = budget.used;
  return report;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--limit') options.limit = Number(argv[++i]);
    else if (arg === '--pause') options.pause = Number(argv[++i]);
    else if (arg === '--recheck-days') options.recheckDays = Number(argv[++i]);
    else if (arg === '--ids') {
      options.ids = String(argv[++i] || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    }
  }
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  backfill(options)
    .then((report) => {
      const summary = {
        scanned: report.scanned,
        candidates: report.candidates,
        selected: report.selected,
        skippedChecked: report.skippedChecked,
        checked: report.checked,
        resolved: report.resolved.length,
        unknown: report.unknown.length,
        errors: report.errors.length,
        byProvider: report.byProvider,
        litresBudgetUsed: report.litresBudgetUsed,
      };
      console.log(JSON.stringify({ summary, resolved: report.resolved }, null, 2));
      if (report.errors.length) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_LIMIT,
  DEFAULT_PAUSE_MS,
  DEFAULT_RECHECK_DAYS,
  detailDocs,
  workIdOf,
  recentlyChecked,
  firstYearForDoc,
  backfill,
  parseArgs,
};
