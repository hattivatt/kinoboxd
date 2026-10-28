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
      onProgress: (progress) => {
        job.resolved = progress.resolved;
        job.resolveTotal = progress.total;
      },
    });
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
  // LIVELIB_REIMPORT_TTL_MS is reused instead of re-scraping 20+ pages. An
  // explicit { force: true }, an expired profile or a fresh cookie paste still
  // performs a full import, and a Hardcover import re-runs resolve over the
  // cached profile.
  const force = Boolean(options.force) || Boolean(providedHeader);
  if (!force) {
    const cached = bookCache.getProfile('livelib', cleanUsername);
    if (cached && isFreshImport(cached.importedAt)) {
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
        cachedAt: cached.importedAt || null,
        error: null,
        warning: null,
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
  }

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
    const result = await livelib.importLivelib(cleanUsername, {
      jar,
      onSession: (session) => {
        job.session = maskSession(session);
      },
      onProgress: (progress) => {
        job.stage = progress.stage === 'bulk' ? 'livelib-bulk' : 'livelib-rsc';
        job.page = progress.page;
        job.pageTotal = progress.pageTotal;
        job.events = progress.events;
      },
    });

    await bookCache.saveProfile('livelib', cleanUsername, result.profile);
    await bookCache.saveRawImport('livelib', cleanUsername, {
      totals: result.totals,
      requests: result.requests,
      warnings: result.warnings,
      importedAt: result.profile.importedAt,
    });
    job.events = result.profile.events.length;
    job.requests = result.requests;
    job.totals = result.totals;
    job.session = result.session ? result.session : job.session || null;
    job.cookies = Object.assign({}, job.cookies, {
      present: true,
      jarAfter: result.session ? result.session.cookiesUsed : null,
    });
    job.warning = result.warnings.length ? result.warnings.join(' ') : null;
    console.log(
      `[books-import ${job.id}] livelib profile saved: ${result.profile.events.length} events ` +
        `(${result.totals.dated} dated), requests=${result.requests.total}, ` +
        `cookies=${job.cookies.present ? 'jar' : 'none'}`
    );

    await resolveAllLivelibProfiles(job, { jar });
  });

  return publicStatus(job);
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

    await resolveAllLivelibProfiles(job);
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
    events: job.events,
    done: Boolean(job.done),
    reused: Boolean(job.reused),
    force: Boolean(job.force),
    cachedAt: job.cachedAt || null,
    error: job.error || null,
    code: job.code || null,
    warning: job.warning || null,
    startedAt: job.startedAt,
    elapsedMs: job.finishedAt ? job.finishedAt - job.startedAt : Date.now() - job.startedAt,
    requests: job.requests || null,
    totals: job.totals || null,
    resolve: job.resolve || null,
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

module.exports = {
  startLivelibImport,
  startHardcoverImport,
  getStatus,
  publicStatus,
  maskSession,
  isFreshImport,
  LIVELIB_REIMPORT_TTL_MS,
  resolveAllLivelibProfiles,
  idle,
};
