'use strict';

const path = require('path');

const bookCache = require('./book-cache');
const providers = require('./providers');
const litres = require('./providers/litres');
const openlibrary = require('./providers/openlibrary');
const hardcover = require('./providers/hardcover');
const editions = require('./hardcover-editions');
const { normalizeIsbn } = require('./normalize');
const { defaultSleep } = require('../core/http');
const { usedOf, budgetRefused } = require('../core/budget');
const fsStore = require('../core/fs-store');
const sources = require('../core/sources');
const wikidata = require('./providers/wikidata');
const { storedFirstClaim, isPrintClaimSource } = require('./providers/claim');

const DEFAULT_LIMIT = 20;
const DEFAULT_PAUSE_MS = sources.pauseMs('litres'); // Литрес politeness (AGENTS.md)
/** Days a "nobody knows the year" verdict stays final before re-asking. */
const DEFAULT_RECHECK_DAYS = 30;

const CYRILLIC_TITLE = /[а-яё]/i;

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

/** The stored claim of a document when it is a print-run year worth challenging. */
function storedPrintClaim(doc) {
  const claim = storedFirstClaim(doc);
  if (!claim || !isPrintClaimSource(claim.source)) return null;
  if (String((doc && doc.yearSource) || '') === 'manual') return null;
  return claim;
}

function needsYearQuestion(doc) {
  return storedFirstClaim(doc) == null || storedPrintClaim(doc) != null;
}

function earlierClaim(stored, found) {
  if (!stored) return Boolean(found);
  if (!found) return false;
  if (found.year < stored.year) return true;
  if (found.year > stored.year) return false;
  const rankNew = providers.PRECISION_RANK[found.precision] || 0;
  const rankStored = providers.PRECISION_RANK[stored.precision] || 0;
  return rankNew > rankStored;
}

/**
 * Providers that can answer for this document.
 *
 * The negative-cache marker is only a verdict for the providers that were
 * actually asked. A document whose marker predates Wikidata must not stay
 * hidden for the rest of the recheck window: a Russian reprint (no Hardcover
 * ISBN match, no Open Library edition) is exactly the document a new provider
 * can still date.
 */
function applicableProviders(doc) {
  const out = [];
  if (isbnOfDoc(doc)) out.push('hardcover');
  if (CYRILLIC_TITLE.test(String((doc && doc.title) || ''))) out.push('litres');
  out.push('openlibrary');
  if (doc && doc.title) out.push('wikidata');
  return out;
}

/**
 * Does the stored marker name every applicable provider?
 *
 * `none` (the old shape for «nobody answered») and an empty marker never
 * cover: they say nothing about the provider that was added later.
 */
function markerCovers(doc) {
  const asked = String((doc && doc.firstPublishedYearCheckedBy) || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!asked.length || (asked.length === 1 && asked[0] === 'none')) return false;
  const set = new Set(asked);
  return applicableProviders(doc).every((name) => set.has(name));
}

/**
 * The providers a run will really ask: `applicableProviders`, minus Wikidata
 * when the phase is off for this caller.
 *
 * The negative marker must name only what was actually asked. Writing
 * «wikidata» for a run that had the phase disabled would hide the document for
 * the whole recheck window after the phase is turned back on.
 */
function askedProviders(doc, options = {}) {
  const list = applicableProviders(doc);
  const provider =
    options.wikidataProvider === undefined ? wikidata : options.wikidataProvider;
  if (!provider || typeof provider.lookupTitles !== 'function' || wikidata.isDisabled()) {
    return list.filter((name) => name !== 'wikidata');
  }
  return list;
}

/**
 * The reader's own spelling of each work: `workId -> {title, authors}`.
 *
 * A work matched by Open Library keeps the provider's transliterated title
 * («Malenʹkie zhenshchiny zamuzhem»), and asking that spelling anywhere is a
 * wasted request. The profile event carries the title the user saw; the
 * resolve link names the work it belongs to.
 */
function profileTitles() {
  const out = new Map();
  let profiles = [];
  try {
    profiles = bookCache.listProfiles();
  } catch (err) {
    return out;
  }
  for (const summary of profiles) {
    let profile;
    try {
      profile = bookCache.getProfile(summary.source, summary.userKey);
    } catch (err) {
      continue;
    }
    const events = profile && Array.isArray(profile.events) ? profile.events : [];
    for (const event of events) {
      if (!event || !event.title) continue;
      const key = event.sourceBookId
        ? String(event.sourceBookId)
        : event.fileKey
          ? `file:${String(event.fileKey)}`
          : null;
      if (!key) continue;
      const link = bookCache.getLink(key);
      if (!link || !link.workId || out.has(link.workId)) continue;
      const authors = Array.isArray(event.authors)
        ? event.authors.map((name) => (name && name.name ? name.name : name)).filter(Boolean)
        : [];
      out.set(link.workId, { title: event.title, authors });
    }
  }
  return out;
}

/** Details documents on disk (`cache-book/details/*.json`). */
function detailDocs() {
  const out = [];
  for (const name of fsStore.listJsonFiles(bookCache.DETAILS_DIR)) {
    // A half-written document is not a candidate; `readJson` returns null for it.
    const doc = fsStore.readJson(path.join(bookCache.DETAILS_DIR, name), {
      label: 'years-backfill',
    });
    if (doc && typeof doc === 'object') out.push({ key: path.basename(name, '.json'), doc });
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

async function firstYearForDoc(doc, options = {}) {
  const sleep = options.sleep || defaultSleep;
  const pause = options.pause == null ? DEFAULT_PAUSE_MS : Number(options.pause);
  const lookupIsbns = options.lookupIsbns;
  const budget = options.budget || null;
  const hinted = Array.isArray(options.authors)
    ? options.authors.filter((name) => name && String(name).trim())
    : [];
  const authors = hinted.length ? hinted : authorsOf(doc);
  const isbn13 = doc.isbn13 || null;
  const isbn10 = doc.isbn10 || null;
  const title = doc.title || null;
  const hardcoverProvider = options.hardcoverProvider || hardcover;
  const litresProvider = options.litresProvider || litres;
  const openlibraryProvider = options.openlibraryProvider || openlibrary;
  const editionYear = doc.publicationYear == null ? null : Number(doc.publicationYear);

  const candidates = [];
  const incomplete = [];
  const push = (result, label) => {
    if (!result) return;
    const claim = providers.claimOf({ ...result, source: label || result.source });
    if (!claim) return;
    const sane = providers.saneFirstYearClaim(claim, {
      editionYear,
      authorBirthYear: result.authorBirthYear,
    });
    if (!sane) return;
    candidates.push({ ...sane, source: label || result.source, workId: result.workId || null });
  };

  const stored = storedFirstClaim(doc);
  if (stored && isPrintClaimSource(stored.source)) {
    push(
      {
        firstPublishedYear: stored.year,
        firstPublishedYearPrecision: stored.precision,
        firstPublishedYearKind: stored.kind,
      },
      stored.source
    );
  }

  const input = { isbn13, isbn10, title, authors };

  if (isbn13 || isbn10) {
    if (options.hardcoverUnavailable === true) {
      incomplete.push('hardcover-error');
    } else {
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
        incomplete.push('hardcover-error');
      }
    }
  }

  if (title && CYRILLIC_TITLE.test(title)) {
    const breakerOpen =
      typeof litresProvider.isBreakerOpen === 'function' && litresProvider.isBreakerOpen();
    if (breakerOpen) {
      incomplete.push('litres-breaker');
    } else {
      const usedBefore = usedOf(budget);
      try {
        const result = await litresProvider.getWork(input, {
          budget,
          sleep,
          litresPauseMs: pause,
        });
        if (budgetRefused(budget, usedBefore)) incomplete.push('litres-budget');
        else push(result, 'litres');
      } catch (err) {
        incomplete.push('litres-error');
      }
    }
  }

  try {
    push(await openlibraryProvider.getWork(input, { sleep, requestDelayMs: 250 }), 'openlibrary');
  } catch (err) {
    incomplete.push('openlibrary-error');
  }

  const workId = options.workId || null;
  const asked = options.yearClaimsAsked instanceof Set ? options.yearClaimsAsked : null;
  const prefetched = options.yearClaims instanceof Map && workId ? options.yearClaims.get(workId) : null;
  if (prefetched) push(prefetched, 'wikidata');
  else if (asked && workId && !asked.has(workId)) {
    if (options.yearClaimsSkipped === 'breaker') incomplete.push('wikidata-breaker');
    else if (options.yearClaimsSkipped === 'budget') incomplete.push('wikidata-budget');
    else if (options.yearClaimsError) incomplete.push('wikidata-error');
  }

  const rank = providers.PRECISION_RANK;
  let winner = null;
  for (const entry of candidates) {
    if (!winner) {
      winner = entry;
      continue;
    }
    if (entry.year !== winner.year) {
      if (entry.year < winner.year) winner = entry;
      continue;
    }
    if ((rank[entry.precision] || 0) > (rank[winner.precision] || 0)) winner = entry;
  }
  return {
    year: winner ? winner.year : null,
    source: winner ? winner.source : null,
    precision: winner ? winner.precision : null,
    kind: winner ? winner.kind : null,
    candidates,
    incomplete,
  };
}

/**
 * Ask Wikidata for the whole slice in one batched pass.
 *
 * Returns `{byWork, asked, skipped, budget, requests}`; `byWork` only holds the
 * documents that got a claim, `asked` the ones the provider really saw. The
 * caller distinguishes «asked, no claim» from «never asked» with those two.
 */
async function prefetchWikidata(docs, options = {}) {
  // Injectable like every other provider: a test that does not want WDQS to be
  // asked, and a caller that wants the whole phase off, pass their own object
  // (or `null`).
  const provider = options.wikidataProvider === undefined ? wikidata : options.wikidataProvider;
  if (!provider || typeof provider.lookupTitles !== "function") {
    return { byWork: new Map(), asked: new Set(), skipped: null, requests: 0 };
  }
  const titles = options.profileTitles instanceof Map ? options.profileTitles : profileTitles();
  const entries = [];
  for (const entry of docs) {
    const workId = workIdOf(entry.doc);
    if (!workId) continue;
    const fromProfile = titles.get(workId) || null;
    const title = (fromProfile && fromProfile.title) || entry.doc.title || null;
    if (!title) continue;
    const authors =
      fromProfile && fromProfile.authors.length ? fromProfile.authors : authorsOf(entry.doc);
    entries.push({ key: workId, title, authors });
  }
  if (!entries.length) return { byWork: new Map(), asked: new Set(), skipped: null, requests: 0 };
  const budget =
    options.wikidataBudget === undefined ? wikidata.budgetFromEnv() : options.wikidataBudget;
  const found = await provider.lookupTitles(entries, {
    budget,
    sleep: options.sleep,
    fetchImpl: options.fetchImpl,
    pauseMs: options.wikidataPauseMs,
    batchSize: options.wikidataBatchSize,
    onProgress: options.onProgress,
  });
  const byWork = new Map();
  for (const [workId, result] of found.byKey) if (result) byWork.set(workId, result);
  return { byWork, asked: found.asked, skipped: found.skipped, budget, requests: found.queries || 0 };
}

/** Normalised ISBN of a details document, or null. */
function isbnOfDoc(doc) {
  return normalizeIsbn(doc && doc.isbn13) || normalizeIsbn(doc && doc.isbn10);
}

/**
 * One batched Hardcover ISBN lookup for the whole selected slice.
 *
 * The chain's per-document Hardcover call would be one GraphQL request per
 * book; `lookupIsbns` takes 100 ISBNs per request, so a 200-document run costs
 * two requests instead of ~190. That is the difference between a bounded,
 * polite job and a rate-limit incident (AGENTS.md: Hardcover free plan counts
 * every top-level field as a query). Returns a Map<isbn,{details,editionId}>
 * or null when the slice has no ISBNs / the batch failed (then the providers
 * are still asked per document, and the error path marks them incomplete).
 */
async function prefetchHardcover(docs, options = {}) {
  const lookup = options.lookupIsbns || editions.lookupIsbns;
  const isbns = new Set();
  for (const doc of docs) {
    const isbn = isbnOfDoc(doc);
    if (isbn) isbns.add(isbn);
  }
  if (!isbns.size) return { byIsbn: new Map(), requests: 0 };
  try {
    const found = await lookup([...isbns], { onProgress: options.onProgress });
    return {
      byIsbn: found && found.byIsbn instanceof Map ? found.byIsbn : new Map(),
      requests: Number(found && found.requests) || 0,
    };
  } catch (err) {
    return { byIsbn: new Map(), requests: 0, error: (err && err.code) || 'isbn_lookup_failed' };
  }
}

/** A `lookupIsbns` override that answers from the prefetched batch only. */
function prefetchedLookup(index) {
  return async (isbns) => {
    const byIsbn = new Map();
    for (const raw of isbns) {
      const isbn = normalizeIsbn(raw);
      const entry = isbn && index.get(isbn);
      if (entry) byIsbn.set(isbn, entry);
    }
    return { byIsbn, works: new Map(), queries: [], requests: 0 };
  };
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
    if (!ids && !force && !needsYearQuestion(doc)) continue;
    // A hopeless document is left alone for `recheckDays`: re-asking three
    // providers for a year nobody has is exactly the load AGENTS.md budgets
    // against. An explicit `--ids` still wins — the user asked for that one.
    // The marker only counts when it names every provider that applies today:
    // a verdict written before Wikidata joined the chain is not a verdict.
    if (!ids && !force && recentlyChecked(doc, nowMs, recheckDays) && markerCovers(doc)) {
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
    yearChallenged: 0,
    yearCorrected: 0,
    // Budget/breaker/network stopped the question before a provider could
    // answer. These documents stay unchecked (no negative cache): the next
    // run asks again instead of losing them for `DEFAULT_RECHECK_DAYS`.
    deferred: [],
    errors: [],
    byProvider: {},
    hardcoverRequests: 0,
    wikidataRequests: 0,
    wikidataSkipped: null,
    wikidataError: null,
    wikidataClaimed: 0,
    wikidataBudget: null,
    litresBudgetUsed: 0,
    litresBudgetLimit: budget && Number.isFinite(Number(budget.limit)) ? Number(budget.limit) : null,
    litresBudgetRemaining: budget && Number.isFinite(Number(budget.remaining))
      ? Number(budget.remaining)
      : null,
    pending: 0,
    runsLeft: 0,
  };

  // One batched Hardcover lookup for the whole slice: 100 ISBNs per request,
  // not one request per book. Fake providers in tests skip it (they assert the
  // exact per-document calls), and an explicit `lookupIsbns` is respected.
  let hardcoverLookup = null;
  if (!options.hardcoverProvider && !options.dryRun) {
    hardcoverLookup = await prefetchHardcover(
      selected.map((entry) => entry.doc),
      options
    );
    report.hardcoverRequests = hardcoverLookup.requests;
    if (hardcoverLookup.error) report.hardcoverLookupError = hardcoverLookup.error;
  }
  const lookupIsbns = hardcoverLookup && !hardcoverLookup.error
    ? prefetchedLookup(hardcoverLookup.byIsbn)
    : options.lookupIsbns;
  const hardcoverUnavailable = Boolean(hardcoverLookup && hardcoverLookup.error);

  // One batched Wikidata pass for the whole slice. It runs even when Hardcover
  // answered, because the earliest claim wins and Wikidata is the only source
  // that knows the work behind a Russian reprint (see AGENTS.md §5.2).
  // The pass is read-only, so `--dry-run` runs it too: the report must show
  // what a real run would resolve, not a subset that ignores Wikidata.
  const yearClaims = { byWork: new Map(), asked: new Set(), skipped: null };
  const profileTitleIndex =
    options.profileTitles instanceof Map ? options.profileTitles : profileTitles();
  let yearClaimsError = null;
  {
    try {
      const lookup = await prefetchWikidata(selected, {
        ...options,
        profileTitles: profileTitleIndex,
      });
      yearClaims.byWork = lookup.byWork;
      yearClaims.asked = lookup.asked;
      yearClaims.skipped = lookup.skipped;
      report.wikidataRequests = lookup.requests;
      report.wikidataSkipped = lookup.skipped;
      report.wikidataBudget = lookup.budget
        ? { limit: lookup.budget.limit, used: lookup.budget.used, remaining: lookup.budget.remaining }
        : null;
    } catch (err) {
      yearClaimsError = (err && err.code) || 'wikidata-error';
      report.wikidataError = yearClaimsError;
    }
  }

  for (const { key, doc, workId } of selected) {
    report.checked++;
    const stored = storedPrintClaim(doc);
    if (stored) report.yearChallenged++;
    const fromProfile = profileTitleIndex.get(workId) || null;
    try {
      const found = await firstYearForDoc(doc, {
        ...options,
        authors:
          fromProfile && fromProfile.authors.length ? fromProfile.authors : undefined,
        workId,
        lookupIsbns,
        hardcoverUnavailable,
        budget,
        yearClaims: yearClaims.byWork,
        yearClaimsAsked: yearClaims.asked,
        yearClaimsSkipped: yearClaims.skipped,
        yearClaimsError,
      });
      if (found.year == null) {
        // Only an answer from every applicable provider is a verdict. A
        // budget-exhausted or failed question is a deferral: write nothing, so
        // the next run sees the document as a candidate again.
        if (found.incomplete.length) {
          report.deferred.push({
            workId,
            title: doc.title || null,
            reasons: [...new Set(found.incomplete)],
          });
          log(
            `… ${workId} ${doc.title || ''} :: deferred (${[...new Set(found.incomplete)].join(',')})`
          );
          continue;
        }
        // Name every applicable provider, not only the one that answered: the
        // next provider added to the chain must be able to re-open this verdict.
        const asked = askedProviders(doc, options).join(',');
        report.unknown.push({ workId, title: doc.title || null, asked });
        log(`— ${workId} ${doc.title || ''} :: no first-publication claim (${asked})`);
        // Negative cache: the next run must not repeat these requests. This is
        // only reached when every applicable provider really answered.
        if (!dryRun) {
          await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), {
            ...doc,
            firstPublishedYearCheckedAt: checkedAt,
            firstPublishedYearCheckedBy: asked,
          });
        }
        continue;
      }
      if (!earlierClaim(stored, found)) {
        const asked = askedProviders(doc, options).join(',');
        log(
          `= ${workId} ${doc.title || ''} :: kept ${stored.year} (${stored.source || 'unknown'})` +
            `, nothing earlier (${asked})`
        );
        if (!dryRun) {
          await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), {
            ...doc,
            firstPublishedYearCheckedAt: checkedAt,
            firstPublishedYearCheckedBy: asked,
          });
        }
        continue;
      }
      if (stored) report.yearCorrected++;
      report.byProvider[found.source] = (report.byProvider[found.source] || 0) + 1;
      if (found.source === 'wikidata') report.wikidataClaimed++;
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
        const next = {
          ...doc,
          firstPublishedYear: found.year,
          firstPublishedYearSource: found.source,
          firstPublishedYearPrecision: found.precision || null,
          firstPublishedYearKind: found.kind || null,
          firstPublishedYearCheckedAt: checkedAt,
          firstPublishedYearCheckedBy: found.source,
        };
        if (stored) {
          next.firstPublishedYearPrevious = stored.year;
          next.firstPublishedYearChallengedBy = stored.source || 'unknown';
        }
        await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), next);
      }
    } catch (err) {
      report.errors.push({ workId, error: err && err.message ? err.message : String(err) });
      log(`ERROR ${workId}: ${err && err.message}`);
    }
    if (budget && typeof budget.remaining === 'number') report.litresBudgetUsed = budget.used;
  }
  if (budget && typeof budget.used === 'number') report.litresBudgetUsed = budget.used;
  if (budget && typeof budget.remaining === 'number') {
    report.litresBudgetRemaining = Number(budget.remaining);
  }
  report.litresBudgetExhausted = report.litresBudgetRemaining === 0;

  // Pending queue after the run: a fresh scan, so newly written years and the
  // freshly written negative cache are both taken into account. This is the
  // number the journal and the UI promise: «осталось ~K прогонов».
  let pending = 0;
  for (const { key, doc } of detailDocs()) {
    const workId = workIdOf(doc);
    if (!workId) continue;
    if (ids && ![...ids].some((id) => id === workId || id === key)) continue;
    if (!force && !needsYearQuestion(doc)) continue;
    if (!force && recentlyChecked(doc, nowMs, recheckDays) && markerCovers(doc)) continue;
    pending++;
  }
  report.pending = pending;
  const perRun = limit > 0 ? limit : Math.max(pending, 1);
  report.runsLeft = pending > 0 ? Math.ceil(pending / perRun) : 0;

  // «Честно неизвестные» grouped by who was asked: the journal line below
  // names the providers that answered nothing, so an operator can tell a
  // provider outage from a genuinely undocumented book.
  report.unknownByAsked = {};
  for (const entry of report.unknown) {
    report.unknownByAsked[entry.asked] = (report.unknownByAsked[entry.asked] || 0) + 1;
  }
  const unknownCounts = Object.entries(report.unknownByAsked)
    .map(([asked, count]) => `${asked}: ${count}`)
    .join('; ');
  const sourceCounts = Object.entries(report.byProvider)
    .map(([source, count]) => `${source} ${count}`)
    .join(', ');
  log(
    `[years-backfill] scanned=${report.scanned} candidates=${report.candidates} ` +
      `selected=${report.selected} checked=${report.checked} ` +
      `resolved=${report.resolved.length}${sourceCounts ? ` (${sourceCounts})` : ''} ` +
      `challenged=${report.yearCorrected}/${report.yearChallenged} ` +
      `unknown=${report.unknown.length}${unknownCounts ? ` [${unknownCounts}]` : ''} ` +
      `deferred=${report.deferred.length} ` +
      `errors=${report.errors.length} ` +
      `litres=${report.litresBudgetUsed}/${report.litresBudgetLimit == null ? '?' : report.litresBudgetLimit}` +
      `${report.litresBudgetExhausted ? ' (exhausted)' : ''} ` +
      `hardcoverRequests=${report.hardcoverRequests} ` +
      `wikidata=${report.wikidataClaimed} claims/${report.wikidataRequests} queries` +
      `${report.wikidataSkipped ? ` (${report.wikidataSkipped})` : ''}` +
      `${report.wikidataError ? ` (error ${report.wikidataError})` : ''} ` +
      `pending=${report.pending} runsLeft=${report.runsLeft}`
  );
  log(
    `[years-backfill] итог: год получили ${report.resolved.length}` +
      `${sourceCounts ? ` (${sourceCounts})` : ''}; честно неизвестны ${report.unknown.length}; ` +
      `отложено (бюджет/сеть/breaker) ${report.deferred.length}; ` +
      `в очереди ${report.pending}` +
      (report.runsLeft ? ` — это ~${report.runsLeft} прогон(ов) по ${perRun}` : ' — очередь пуста')
  );
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
        yearChallenged: report.yearChallenged,
        yearCorrected: report.yearCorrected,
        unknown: report.unknown.length,
        unknownByAsked: report.unknownByAsked,
        deferred: report.deferred.length,
        errors: report.errors.length,
        byProvider: report.byProvider,
        hardcoverRequests: report.hardcoverRequests,
        wikidataRequests: report.wikidataRequests,
        wikidataClaimed: report.wikidataClaimed,
        wikidataSkipped: report.wikidataSkipped,
        wikidataError: report.wikidataError,
        litresBudgetUsed: report.litresBudgetUsed,
        litresBudgetLimit: report.litresBudgetLimit,
        litresBudgetRemaining: report.litresBudgetRemaining,
        litresBudgetExhausted: report.litresBudgetExhausted,
        pending: report.pending,
        runsLeft: report.runsLeft,
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
  applicableProviders,
  askedProviders,
  markerCovers,
  profileTitles,
  firstYearForDoc,
  prefetchWikidata,
  prefetchHardcover,
  backfill,
  parseArgs,
};
