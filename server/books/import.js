'use strict';

/**
 * Background import jobs for the books tab (film-enrich job model).
 *
 *   POST /api/books/import/livelib  { username }  -> job
 *   POST /api/books/import/hardcover { userId }   -> job
 *   GET  /api/books/import/status?id=...          -> { stage, page, pageTotal, ... }
 *
 * Stages: livelib-bulk -> livelib-rsc -> resolve -> done (or failed).
 *          hardcover-journal -> resolve -> done.
 *
 * Jobs are serialized through one chain: two source imports never scrape/
 * write the resolve caches concurrently. A repeat request for a source that is
 * already running coalesces into the existing job.
 */

const crypto = require('crypto');

const config = require('../config');
const bookCache = require('./book-cache');
const hardcover = require('./hardcover');
const livelib = require('./livelib');
const livelibCookies = require('./livelib-cookies');
const livelibFile = require('./livelib-file');
const resolve = require('./resolve');

const jobs = new Map();
const jobOrder = [];
const MAX_JOBS = 20;

// A cached LiveLib profile is considered current for 12 hours: repeat clicks
// reuse it instead of re-scraping the whole profile (LiveLib politeness).
const LIVELIB_REIMPORT_TTL_MS = Number(process.env.KINOBOXD_LIVELIB_REIMPORT_TTL_MS) > 0
  ? Number(process.env.KINOBOXD_LIVELIB_REIMPORT_TTL_MS)
  : 12 * 60 * 60 * 1000;

let importChain = Promise.resolve();

/** True when `importedAt` is a valid timestamp within the reuse window. */
function isFreshImport(importedAt) {
  const ts = Date.parse(String(importedAt || ''));
  if (!Number.isFinite(ts)) return false;
  const age = Date.now() - ts;
  return age >= 0 && age < LIVELIB_REIMPORT_TTL_MS;
}

/* ------------------------------------------------------------------ */
/* Job bookkeeping                                                     */
/* ------------------------------------------------------------------ */

function newJobId(source, userKey) {
  return `${source}-${bookCache.safeKey(userKey)}-${Date.now().toString(36)}-${crypto
    .randomBytes(3)
    .toString('hex')}`;
}

function rememberJob(job) {
  jobs.set(job.id, job);
  jobOrder.push(job.id);
  while (jobOrder.length > MAX_JOBS) {
    const stale = jobOrder.shift();
    if (stale !== job.id) jobs.delete(stale);
  }
}

function findRunningJob(source, userKey) {
  for (const job of jobs.values()) {
    if (
      job.source === source &&
      String(job.userKey) === String(userKey) &&
      !job.done &&
      job.stage !== 'failed'
    ) {
      return job;
    }
  }
  return null;
}

/**
 * Hardcover coalescing is slightly looser than LiveLib: `me` and the resolved
 * numeric owner id name the same profile, so a click on the books refresh
 * button (numeric userId) joins an import started from the import screen
 * (`me`) instead of queueing a second journal fetch.
 */
function findRunningHardcoverJob(requested) {
  const direct = findRunningJob('hardcover', requested);
  if (direct) return direct;
  for (const job of jobs.values()) {
    if (job.source !== 'hardcover' || job.done || job.stage === 'failed') continue;
    if (requested === 'me' || String(job.userKey) === 'me') return job;
  }
  return null;
}

function enqueue(job, task) {
  importChain = importChain
    .then(task)
    .catch((err) => {
      const message = err && err.message ? err.message : 'неизвестная ошибка';
      if (job.stage !== 'done' && job.stage !== 'failed') {
        job.stage = 'failed';
        job.error = message;
      }
      // A blocked source is a first-class state for the UI: it decides whether
      // to offer the cookie paste form ("plan B") or just a retry.
      if (err && err.code === 'livelib_blocked') {
        job.code = 'livelib_blocked';
        job.blocked = {
          code: 'livelib_blocked',
          planB: 'cookieHeader',
          cookiesPresent: Boolean(job.cookies && job.cookies.present),
        };
      }
      console.error(`[books-import ${job.id}] ${message}`);
    })
    .then(() => {
      job.finishedAt = Date.now();
      job.page = null;
      job.pageTotal = null;
      if (!job.done && job.stage !== 'failed') job.stage = 'done';
      job.done = job.stage === 'done';
      if (job.done) job.percent = 100;
      job.elapsedMs = job.finishedAt - job.startedAt;
      console.log(
        `[books-import ${job.id}] ${job.stage} after ${job.elapsedMs}ms ` +
          `(events=${job.events}${job.error ? `, error=${job.error}` : ''})`
      );
    });
}

/* ------------------------------------------------------------------ */
/* Resolution pass                                                     */
/* ------------------------------------------------------------------ */

/**
 * Re-run the LiveLib -> Hardcover resolve for every cached LiveLib profile
 * (unmatched positives are never cached, so a new Hardcover import can
 * improve the picture). Positive links are reused unless `force` is set.
 */
async function resolveAllLivelibProfiles(job, options = {}) {
  const reports = [];
  const profiles = bookCache.listProfiles().filter((profile) => profile.source === 'livelib');
  const cardBudget = resolve.createCardBudget(process.env.BOOKS_LIVELIB_CARD_BUDGET);
  const litresBudget = resolve.createLitresBudget(process.env.BOOKS_LITRES_BUDGET);
  job.stage = 'resolve';
  job.page = 0;
  job.pageTotal = profiles.length;
  // Live budget snapshot for the metadata badge: the object is mutated in
  // place by the resolve chain, so refresh the copy after every profile.
  job.liveBudget = {
    litres: { limit: litresBudget.limit, used: litresBudget.used, remaining: litresBudget.remaining },
    card: { limit: cardBudget.limit, used: cardBudget.used, remaining: cardBudget.remaining },
  };
  for (const meta of profiles) {
    const data = bookCache.getProfile('livelib', meta.userKey);
    if (!data) continue;
    job.page++;
    const report = await resolve.resolveProfile(data, {
      force: Boolean(options.force),
      cardBudget,
      litresBudget,
      // Same anonymous session for the card pages: with plan-B cookies the
      // enrichment must not fall back to a cold, blockable IP.
      jar: options.jar,
      // A file-import-triggered pass must not scrape livelib.ru (§9): only a
      // scrape import (which already has a bootstrapped session) may use the
      // LiveLib card provider.
      allowLivelibCard: options.allowLivelibCard !== false,
      onProgress: (progress) => {
        job.resolved = progress.resolved;
        job.resolveTotal = progress.total;
      },
    });
    job.liveBudget = {
      litres: { limit: litresBudget.limit, used: litresBudget.used, remaining: litresBudget.remaining },
      card: { limit: cardBudget.limit, used: cardBudget.used, remaining: cardBudget.remaining },
    };
    reports.push({ userKey: meta.userKey, ...report });
  }
  const providerChain = {};
  for (const report of reports) {
    for (const [name, stat] of Object.entries(report.providerChain || {})) {
      if (!providerChain[name]) {
        providerChain[name] = { ...stat, methods: { ...(stat.methods || {}) } };
        continue;
      }
      const target = providerChain[name];
      target.calls += stat.calls;
      target.hits += stat.hits;
      target.errors += stat.errors;
      target.skipped += stat.skipped;
      for (const [method, count] of Object.entries(stat.methods || {})) {
        target.methods[method] = (target.methods[method] || 0) + count;
      }
      target.lastError = stat.lastError || target.lastError;
    }
  }
  job.resolve = {
    profiles: reports.length,
    resolved: reports.reduce((sum, report) => sum + report.resolved, 0),
    withMetadata: reports.reduce((sum, report) => sum + report.withMetadata, 0),
    total: reports.reduce((sum, report) => sum + report.total, 0),
    isbn: reports.reduce((sum, report) => sum + report.resolvedIsbn, 0),
    title: reports.reduce((sum, report) => sum + report.resolvedTitle, 0),
    google: reports.reduce((sum, report) => sum + report.resolvedGoogle, 0),
    openlibrary: reports.reduce((sum, report) => sum + report.resolvedOpenLibrary, 0),
    litres: reports.reduce((sum, report) => sum + report.resolvedLitres, 0),
    hardcoverFromLitres: reports.reduce(
      (sum, report) => sum + report.resolvedHardcoverFromLitres,
      0
    ),
    livelibCard: reports.reduce((sum, report) => sum + report.resolvedLivelibCard, 0),
    hardcoverCard: reports.reduce((sum, report) => sum + report.resolvedHardcoverCard, 0),
    enriched: reports.reduce((sum, report) => sum + report.enriched, 0),
    ambiguous: reports.reduce((sum, report) => sum + report.ambiguous, 0),
    unmatched: reports.reduce((sum, report) => sum + report.unmatched, 0),
    planShelfSkipped: reports.reduce((sum, report) => sum + (report.skippedPlanShelf || 0), 0),
    isbnLookupErrors: [...new Set(reports.flatMap((report) => report.lookupErrors || []))],
    requests: reports.reduce((sum, report) => sum + report.requests, 0),
    providerChain,
    cardBudget: { limit: cardBudget.limit, used: cardBudget.used, remaining: cardBudget.remaining },
    litresBudget: {
      limit: litresBudget.limit,
      used: litresBudget.used,
      remaining: litresBudget.remaining,
    },
    reports,
  };
  return job.resolve;
}

/* ------------------------------------------------------------------ */
/* LiveLib import                                                      */
/* ------------------------------------------------------------------ */

/**
 * LiveLib import job.
 *
 * `options.cookieHeader` is "plan B" for a DDoS-Guard-flagged host: the user
 * pastes the `Cookie:` value from a browser where the profile opens. The header
 * is validated synchronously (a malformed paste is a 400, not a failed job),
 * persisted to `cache-book/cookies/livelib-{username}.json` (0600), and used to
 * seed the anonymous jar for the bootstrap, the scrape AND the card resolve.
 * Only a masked `{ provided, stored, present, savedAt }` block ever reaches the
 * job status — never the value.
 *
 * A supplied header also disables the 12 h reuse window: the user is
 * explicitly retrying because the cached state did not work.
 *
 * `options.deep`:
 *   - `false` (default) — light only: bulk + RSC page 1, ~3 requests;
 *   - `true` — light (unless a fresh profile is reused) + a full RSC deep scan;
 *   - `'auto'` — light, then deep only when the profile still has undated
 *     events (what «Обновить профиль» asks for: fast re-check first, exact
 *     dates in the background when the history is incomplete).
 *
 * The deep phase does not block the dashboard: the profile file is rewritten
 * every 5 pages and `/api/books/stats` revalidates its fingerprint per read.
 */
function startLivelibImport(username, options = {}) {
  const cleanUsername = String(username == null ? '' : username).trim().replace(/^@/, '');
  if (!/^[\w.-]{1,64}$/.test(cleanUsername)) {
    throw new livelib.LivelibError(
      'Укажите имя пользователя LiveLib (латиница, цифры, точка, дефис).',
      'livelib_invalid_username'
    );
  }

  // Validate the paste before anything is queued or written.
  const providedHeader =
    options.cookieHeader == null || String(options.cookieHeader).trim() === ''
      ? null
      : livelibCookies.normalizeCookieHeader(options.cookieHeader);
  const storedCookie = providedHeader ? null : livelibCookies.getCookies('livelib', cleanUsername);
  const cookieHeader = providedHeader || (storedCookie ? storedCookie.cookieHeader : null);
  const deepMode = options.deep === true ? true : options.deep === 'auto' ? 'auto' : false;

  const running = findRunningJob('livelib', cleanUsername);
  if (running) {
    // A paste during a running scrape cannot be applied to that job; silently
    // dropping it would look like "cookies saved" in the UI. 409 asks for a
    // retry after the current import finishes.
    if (providedHeader) {
      throw new livelib.LivelibError(
        'Импорт этого профиля уже выполняется — дождитесь завершения и повторите вставку cookie.',
        'livelib_import_running'
      );
    }
    return publicStatus(running);
  }

  // Repeat-import guard (politeness + cheap UI): a cached profile younger than
  // LIVELIB_REIMPORT_TTL_MS is reused instead of re-scraping the bulk pass. An
  // explicit { force: true }, an expired profile or a fresh cookie paste still
  // performs a light import. A cached profile also means a deep request can run
  // without touching the bulk endpoint again.
  const force = Boolean(options.force) || Boolean(providedHeader);
  const cached = bookCache.getProfile('livelib', cleanUsername);
  const cachedFresh = Boolean(cached && isFreshImport(cached.importedAt));
  const deepPending = Boolean(
    cached &&
      cached.deepScan &&
      cached.deepScan.done !== true &&
      Number(cached.deepScan.lastPage) > 0
  );
  const undatedCached = cached ? undatedCount(cached.events) : 0;
  const wantDeep =
    deepMode === true || (deepMode === 'auto' && (deepPending || undatedCached > 0));
  if (!force && !wantDeep && cachedFresh) {
    const now = Date.now();
    const reused = {
      id: newJobId('livelib', cleanUsername),
      source: 'livelib',
      userKey: cleanUsername,
      stage: 'done',
      page: null,
      pageTotal: null,
      events: cached.events.length,
      done: true,
      reused: true,
      force: false,
      percent: 100,
      cachedAt: cached.importedAt || null,
      error: null,
      warning: null,
      deep: cached.deepScan || null,
      cookies: {
        provided: false,
        stored: Boolean(storedCookie),
        present: Boolean(cookieHeader),
        savedAt: storedCookie ? storedCookie.savedAt : null,
      },
      startedAt: now,
      finishedAt: now,
    };
    rememberJob(reused);
    console.log(
      `[books-import ${reused.id}] livelib profile reused from cache ` +
        `(${cached.events.length} events, importedAt=${cached.importedAt})`
    );
    return publicStatus(reused);
  }

  // A fresh profile + a deep request needs no bulk re-scrape: the deep scan
  // only adds dates to events that are already stored.
  const skipLight = Boolean(cached && cachedFresh && !force && wantDeep);

  const job = {
    id: newJobId('livelib', cleanUsername),
    source: 'livelib',
    userKey: cleanUsername,
    stage: 'queued',
    page: 0,
    pageTotal: null,
    events: 0,
    done: false,
    reused: false,
    force,
    deepRequested: deepMode,
    skipLight,
    percent: 0,
    error: null,
    warning: null,
    cookies: {
      provided: Boolean(providedHeader),
      stored: Boolean(storedCookie),
      present: Boolean(cookieHeader),
      savedAt: storedCookie ? storedCookie.savedAt : null,
    },
    startedAt: Date.now(),
  };
  rememberJob(job);

  enqueue(job, async () => {
    if (providedHeader) {
      const saved = await livelibCookies.saveCookies('livelib', cleanUsername, providedHeader);
      job.cookies = {
        provided: true,
        stored: true,
        present: true,
        savedAt: saved.savedAt,
        count: saved.count,
      };
      console.log(
        `[books-import ${job.id}] livelib cookies stored ` +
          `(${saved.count} cookie(s), savedAt=${saved.savedAt})`
      );
    }

    const jar = livelib.makeJar(cookieHeader);
    let profile = cached;

    if (!skipLight) {
      job.stage = 'livelib-bulk';
      const result = await livelib.importLivelib(cleanUsername, {
        jar,
        existingProfile: cached,
        onSession: (session) => {
          job.session = maskSession(session);
        },
        onProgress: (progress) => {
          job.stage = progress.stage === 'bulk' ? 'livelib-bulk' : 'livelib-rsc';
          job.page = progress.page;
          job.pageTotal = progress.pageTotal;
          job.events = progress.events;
          job.percent = percentProgressOf(progress);
        },
      });

      profile = result.profile;
      // A scrape rebuilds the document from the «Прочитал» page only. Keep the
      // plan/abandoned shelves a file import contributed (they are never
      // scraped) and the file-import audit trail.
      const carried = livelibFile.preserveFileState(cached, profile);
      if (carried.preserved > 0) {
        profile = carried.profile;
        console.log(
          `[books-import ${job.id}] kept ${carried.preserved} file-import event(s) of plan shelves`
        );
      }
      await bookCache.saveProfile('livelib', cleanUsername, profile);
      await bookCache.saveRawImport('livelib', cleanUsername, {
        totals: result.totals,
        requests: result.requests,
        warnings: result.warnings,
        importedAt: result.profile.importedAt,
      });
      job.events = profile.events.length;
      job.requests = result.requests;
      job.totals = result.totals;
      job.session = result.session ? result.session : job.session || null;
      job.cookies = Object.assign({}, job.cookies, {
        present: true,
        jarAfter: result.session ? result.session.cookiesUsed : null,
      });
      job.warning = result.warnings.length ? result.warnings.join(' ') : null;
      job.undatedEventCount = undatedCount(profile.events);
      console.log(
        `[books-import ${job.id}] livelib profile saved: ${profile.events.length} events ` +
          `(${result.totals.dated} dated), requests=${result.requests.total}, ` +
          `cookies=${job.cookies.present ? 'jar' : 'none'}`
      );
    } else {
      job.events = profile.events.length;
      job.undatedEventCount = undatedCached;
    }

    // Deep phase: fill exact dates on the already imported events. `auto`
    // skips it when the history is already fully dated.
    const undated = profile.events.filter((event) => !event.finishedAt).length;
    const deepDone = Boolean(profile.deepScan && profile.deepScan.done === true);
    if (deepMode === true && deepDone) {
      // An explicit `deep: true` is a full re-scan request: re-read the pages
      // instead of returning "already complete". Dates/months are idempotent.
      profile.deepScan = { ...profile.deepScan, done: false, lastPage: 1 };
    }
    const shouldDeep =
      deepMode === true || (deepMode === 'auto' && !deepDone && undated > 0);
    if (shouldDeep) {
      job.stage = 'livelib-deep';
      job.percent = deepDone ? 100 : percentFromDeep(profile.deepScan);
      job.deep = deepSummary(profile.deepScan, profile.events);
      const deep = await livelib.deepScanProfile(cleanUsername, profile, {
        jar,
        onProgress: (progress) => {
          job.stage = 'livelib-deep';
          job.page = progress.page;
          job.pageTotal = progress.pageTotal;
          job.events = profile.events.length;
          job.undatedEventCount = undatedCount(profile.events);
          job.percent = percentOf(progress.page, progress.pageTotal);
          job.deep = deepSummary(profile.deepScan, profile.events, progress);
        },
        onBatch: async (draft, progress) => {
          // Write the profile every N pages: stats read it by fingerprint, so
          // the dashboard gains dated events while the job is still running.
          await bookCache.saveProfile('livelib', cleanUsername, draft);
          job.percent = percentOf(progress.page, progress.pageTotal);
          job.deep = deepSummary(draft.deepScan, profile.events, progress);
          job.events = profile.events.length;
          job.undatedEventCount = undatedCount(profile.events);
        },
      });
      job.deep = deepSummary(profile.deepScan, profile.events);
      job.deepSkipped = Boolean(deep.skipped);
      job.deepRequests = deep.requests;
      if (Array.isArray(deep.warnings) && deep.warnings.length) {
        job.warning = [job.warning, ...deep.warnings].filter(Boolean).join(' ');
      }
      job.percent = 100;
      console.log(
        `[books-import ${job.id}] livelib deep scan: ${deep.dated}/${deep.total} dated, ` +
          `requests=${deep.requests}${deep.skipped ? ' (already complete)' : ''}`
      );
    }

    await resolveQuietly(job, { jar });
  });

  return publicStatus(job);
}

/**
 * Metadata resolve is enrichment, not part of the import contract: a provider
 * outage (LiveLib card / Litres / Hardcover) must not turn a successfully
 * scraped profile into a failed job. The error is reported as a warning.
 */
async function resolveQuietly(job, options = {}) {
  try {
    await resolveAllLivelibProfiles(job, options);
  } catch (err) {
    const message = err && err.message ? err.message : 'resolve failed';
    job.resolveError = message;
    job.warning = [job.warning, `метадата: ${message}`].filter(Boolean).join(' ');
    console.warn(`[books-import ${job.id}] resolve failed (import kept): ${message}`);
  }
}

/** Events with neither an exact day nor a month: the honest "undated" count. */
function undatedCount(events) {
  const list = Array.isArray(events) ? events : [];
  return list.filter(
    (event) => event && !event.finishedAt && !/^\d{4}-\d{2}$/.test(String(event.readMonth || ''))
  ).length;
}

/** Dated (exact day) events of a LiveLib profile. */
function deepCount(profile) {
  return profile.events.filter((event) => event && event.finishedAt).length;
}

function percentOf(page, pageTotal) {
  const done = Number(page);
  const total = Number(pageTotal);
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(1, Math.min(100, Math.round((done / total) * 100)));
}

function percentFromDeep(deep) {
  if (!deep) return 0;
  if (deep.done) return 100;
  return percentOf(deep.lastPage, deep.pageTotal);
}

function percentProgressOf(progress) {
  return percentOf(progress && progress.page, progress && progress.pageTotal);
}

/** Masked deep-scan state for the job status: page numbers and counts only. */
function deepSummary(deep, events, progress) {
  const list = Array.isArray(events) ? events : [];
  const dated = list.filter((event) => event && event.finishedAt).length;
  const monthOnly = list.filter(
    (event) => event && !event.finishedAt && /^\d{4}-\d{2}$/.test(String(event.readMonth || ''))
  ).length;
  const page = progress ? progress.page : deep && deep.lastPage;
  const pageTotal = (progress && progress.pageTotal) || (deep && deep.pageTotal) || null;
  return {
    page: page == null ? null : Number(page),
    pageTotal: pageTotal == null ? null : Number(pageTotal),
    percent: percentOf(page, pageTotal),
    dated,
    monthOnly,
    total: list.length,
    undated: list.length - dated - monthOnly,
    done: Boolean(deep && deep.done),
    lastPage: deep && deep.lastPage != null ? Number(deep.lastPage) : null,
  };
}

/** Bootstrap diagnostics for the job status: statuses/counts, never values. */
function maskSession(session) {
  if (!session) return null;
  return {
    bootstrap: {
      skipped: Boolean(session.skipped),
      status: session.status == null ? null : session.status,
      challenge: Boolean(session.challenge),
      blocked: Boolean(session.blocked),
      cookieCount: session.cookieCount || 0,
      title: session.title || null,
      hops: Array.isArray(session.hops)
        ? session.hops.map((hop) => ({ status: hop.status, cookieCount: hop.cookieCount }))
        : [],
    },
    cookiesUsed: session.cookieCount || 0,
  };
}
/* ------------------------------------------------------------------ */
/* Hardcover import                                                    */
/* ------------------------------------------------------------------ */

/**
 * Hardcover import.
 *
 * Deliberately has no reuse TTL: every click re-fetches the journal (~7 pages,
 * a few seconds) so a profile written by an older schema gets `statusId` for
 * every event. LiveLib is the opposite trade-off (20+ polite requests, 12 h
 * reuse) — see `startLivelibImport`.
 */
function startHardcoverImport(userId) {
  // Fail before creating a job when the token is absent: the UI needs a clear
  // "token not configured" state, not a failed background job.
  try {
    config.getHardcoverToken();
  } catch (err) {
    if (err && err.code === 'HARDCOVER_TOKEN_MISSING') {
      throw new hardcover.HardcoverError(
        'Hardcover-токен не настроен (HARDCOVER_API_TOKEN или config/hardcover-token).',
        'hardcover_token_missing'
      );
    }
    throw err;
  }

  const requested = userId == null || String(userId).trim() === '' ? 'me' : String(userId).trim();
  const running = findRunningHardcoverJob(requested);
  if (running) return publicStatus(running);

  const job = {
    id: newJobId('hardcover', requested),
    source: 'hardcover',
    userKey: requested,
    stage: 'queued',
    page: 0,
    pageTotal: null,
    events: 0,
    done: false,
    reused: false,
    // Hardcover has no reuse path: every job re-fetches the journal.
    force: true,
    error: null,
    warning: null,
    startedAt: Date.now(),
  };
  rememberJob(job);

  enqueue(job, async () => {
    const owner = await hardcover.resolveUser(requested);
    job.userKey = String(owner.id);
    job.username = owner.username;

    const journal = await hardcover.fetchJournal(owner.id, {
      onProgress: (progress) => {
        job.stage = 'hardcover-journal';
        job.page = progress.page;
        job.pageTotal = progress.total ? Math.ceil(progress.total / 100) : null;
        job.events = progress.events;
      },
    });
    const warnings = [];
    const profile = hardcover.buildProfile(owner, journal, warnings);
    await bookCache.saveProfile('hardcover', String(owner.id), profile);
    await bookCache.saveRawImport('hardcover', String(owner.id), {
      totals: journal.totals,
      eventsWithDate: journal.eventsWithDate,
      statusFilter: journal.statusFilter,
      keepStatusIds: journal.keepStatusIds,
      importedAt: profile.importedAt,
    });
    job.events = journal.events.length;
    job.totals = {
      userBooks: journal.totals.userBooks,
      pages: journal.totals.pages,
      eventsWithDate: journal.eventsWithDate,
      skippedNonFinished: journal.statusFilter.skippedNonFinished,
      skippedByStatus: journal.statusFilter.byStatus,
      keepStatusIds: journal.keepStatusIds,
    };
    console.log(
      `[books-import ${job.id}] hardcover journal saved: ${journal.events.length} events ` +
        `(${journal.eventsWithDate} dated), ${journal.works.size} works, ` +
        `skipped=${journal.statusFilter.skippedNonFinished} ` +
        `${JSON.stringify(journal.statusFilter.byStatus)}`
    );

    await resolveQuietly(job);
  });

  return publicStatus(job);
}

/* ------------------------------------------------------------------ */
/* Resolve-only job (file import enrichment)                           */
/* ------------------------------------------------------------------ */

/**
 * Metadata enrichment job for LiveLib profiles.
 *
 * The regular resolve stage of a scraped import does the same work, so a
 * resolve-only job reuses `resolveAllLivelibProfiles` and the regular job
 * bookkeeping (`getResolveState` drives the «Метадата: N%» badge while it runs).
 *
 * A `livelib-file` import starts this job BY DEFAULT (§3.3.2): the export file
 * is reading history first and bibliographic columns second, and a profile that
 * was just merged must not wait for a manual click to get pages/series/editions.
 *
 * `options.coalesce` (default true) joins an already-running resolve stage —
 * that is what a duplicate click wants. A file import passes `false`: it has
 * just written new events, so it needs a *later* pass over the merged profile,
 * not the pass that may have already walked it. The import chain still
 * serializes the jobs, so the second pass starts right after the first.
 */
function startResolveJob(options = {}) {
  const coalesce = options.coalesce !== false;
  if (coalesce) {
    const running = [...jobs.values()].find(
      (job) => job && job.source === 'livelib' && !job.done && job.stage === 'resolve'
    );
    if (running) return publicStatus(running);
  }

  const job = {
    id: newJobId('resolve', 'livelib'),
    source: 'livelib',
    userKey: 'all',
    stage: 'queued',
    page: 0,
    pageTotal: null,
    events: 0,
    done: false,
    reused: false,
    force: false,
    error: null,
    warning: null,
    startedAt: Date.now(),
  };
  rememberJob(job);

  enqueue(job, async () => {
    const report = await resolveAllLivelibProfiles(job, {
      allowLivelibCard: options.allowLivelibCard !== false,
    });
    job.events = report.total || 0;
  });

  return publicStatus(job);
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

function publicStatus(job) {
  return {
    id: job.id,
    source: job.source,
    userKey: job.userKey,
    stage: job.stage,
    page: job.page,
    pageTotal: job.pageTotal,
    // Overall job progress, 0..100 (the progress screen uses it).
    percent: job.percent == null ? null : Number(job.percent),
    events: job.events,
    done: Boolean(job.done),
    reused: Boolean(job.reused),
    force: Boolean(job.force),
    deepRequested: job.deepRequested === undefined ? false : job.deepRequested,
    skipLight: Boolean(job.skipLight),
    // Deep scan progress of the profile: the "Обновить профиль" button renders
    // `deep.percent` as «История 45%», and stats stay usable meanwhile.
    deep: job.deep || null,
    deepSkipped: Boolean(job.deepSkipped),
    undatedEventCount: job.undatedEventCount == null ? null : Number(job.undatedEventCount),
    cachedAt: job.cachedAt || null,
    error: job.error || null,
    code: job.code || null,
    warning: job.warning || null,
    startedAt: job.startedAt,
    elapsedMs: job.finishedAt ? job.finishedAt - job.startedAt : Date.now() - job.startedAt,
    requests: job.requests || null,
    totals: job.totals || null,
    resolve: job.resolve || null,
    // Live resolve budget while the stage is running (masked data only).
    resolveBudget: job.stage === 'resolve' ? job.liveBudget || null : null,
    // Masked only: `present`/`savedAt`/counts. The header value never leaves
    // the cookie store.
    cookies: job.cookies || null,
    session: job.session || null,
    blocked: job.blocked || null,
  };
}

function getStatus(id) {
  const job = jobs.get(String(id || ''));
  if (!job) return null;
  return publicStatus(job);
}

/** Test helper: wait for the whole import chain to drain. */
function idle() {
  return importChain.then(() => undefined);
}

/**
 * Is the metadata resolve stage running for THIS profile, and how much of the
 * Litres budget is left?
 *
 * The resolve pass always walks every cached LiveLib profile, whichever import
 * triggered it (a LiveLib re-import or a fresh Hardcover journal — enrichment
 * of LiveLib dates/metadata is the same pass). So a LiveLib profile is
 * "loading" while any job sits in stage `resolve`. A Hardcover profile is not:
 * its bibliographic metadata arrives with the journal itself.
 */
/**
 * Pure core of `getResolveState`: pick a live resolve job out of an iterable.
 * Exported so the mapping (which stage counts, which source counts, how the
 * budget is read) is unit-tested without starting a network import.
 */
function resolveStateFromJobs(jobList, source) {
  const idle = { running: false, jobId: null, budgetRemaining: null };
  if (source !== 'livelib') return idle;
  for (const job of jobList) {
    if (!job || job.done) continue;
    // A resolve-only job is `queued` for a moment before its stage opens (the
    // import chain may still be draining). The badge must say "догружается"
    // from the first refresh after a file import, not only once the network
    // stage literally starts.
    const queuedResolve = job.stage === 'queued' && String(job.id || '').startsWith('resolve-');
    if (job.stage !== 'resolve' && !queuedResolve) continue;
    const litres = job.liveBudget && job.liveBudget.litres;
    return {
      running: true,
      jobId: job.id || null,
      startedAt: job.startedAt || null,
      resolved: job.resolved == null ? null : Number(job.resolved),
      total: job.resolveTotal == null ? null : Number(job.resolveTotal),
      budgetRemaining: litres && litres.remaining != null && Number.isFinite(Number(litres.remaining))
        ? Number(litres.remaining)
        : null,
    };
  }
  return idle;
}

function getResolveState(source, userKey) {
  return resolveStateFromJobs(jobs.values(), source);
}

module.exports = {
  startLivelibImport,
  startHardcoverImport,
  startResolveJob,
  getStatus,
  publicStatus,
  maskSession,
  isFreshImport,
  LIVELIB_REIMPORT_TTL_MS,
  resolveAllLivelibProfiles,
  resolveStateFromJobs,
  getResolveState,
  /** True when an import for this `(source, userKey)` is still in flight. */
  isRunning(source, userKey) {
    return Boolean(findRunningJob(source, String(userKey == null ? '' : userKey).trim()));
  },
  idle,
};
