'use strict';

const config = require('../config');
const { createJobs } = require('../core/jobs');
const bookCache = require('./book-cache');
const hardcover = require('./hardcover');
const livelib = require('./livelib');
const livelibCookies = require('./livelib-cookies');
const livelibFile = require('./livelib-file');
const resolve = require('./resolve');
const resolveLock = require('./resolve-lock');
const scheduledResolve = require('./scheduled-resolve');

const jobs = createJobs({
  name: 'books-import',
  idPrefix: 'books',
  maxJobs: 20,
  keyOf: (job) => `${job.source}:${String(job.userKey == null ? '' : job.userKey)}`,
});

const LIVELIB_REIMPORT_TTL_MS = Number(process.env.KINOBOXD_LIVELIB_REIMPORT_TTL_MS) > 0
  ? Number(process.env.KINOBOXD_LIVELIB_REIMPORT_TTL_MS)
  : 12 * 60 * 60 * 1000;

function isFreshImport(importedAt) {
  const ts = Date.parse(String(importedAt || ''));
  if (!Number.isFinite(ts)) return false;
  const age = Date.now() - ts;
  return age >= 0 && age < LIVELIB_REIMPORT_TTL_MS;
}

function newJobId(source, userKey) {
  return jobs.newId(userKey, source);
}

function rememberJob(job) {
  return jobs.remember(job);
}

function findRunningJob(source, userKey) {
  return jobs.findRunning(`${source}:${String(userKey == null ? '' : userKey)}`);
}

function findRunningHardcoverJob(requested) {
  const direct = findRunningJob('hardcover', requested);
  if (direct) return direct;
  for (const job of jobs.list()) {
    if (job.source !== 'hardcover' || job.done || job.stage === 'failed') continue;
    if (requested === 'me' || String(job.userKey) === 'me') return job;
  }
  return null;
}

function enqueue(job, task) {
  return jobs.run(job, task, {
    onError: (self, err) => {
      const message = err && err.message ? err.message : 'неизвестная ошибка';
      if (self.stage !== 'done' && self.stage !== 'failed') {
        self.stage = 'failed';
        self.error = message;
      }
      if (err && err.code === 'livelib_blocked') {
        self.code = 'livelib_blocked';
        self.blocked = {
          code: 'livelib_blocked',
          planB: 'cookieHeader',
          cookiesPresent: Boolean(self.cookies && self.cookies.present),
        };
      }
      console.error(`[books-import ${self.id}] ${message}`);
    },
    finish: false,
    onFinish: (self) => {
      self.finishedAt = Date.now();
      self.page = null;
      self.pageTotal = null;
      if (!self.done && self.stage !== 'failed') self.stage = 'done';
      self.done = self.stage === 'done';
      if (self.done) self.percent = 100;
      self.elapsedMs = self.finishedAt - self.startedAt;
      self.status = self.stage === 'failed' ? 'failed' : self.done ? 'done' : self.status;
      console.log(
        `[books-import ${self.id}] ${self.stage} after ${self.elapsedMs}ms ` +
          `(events=${self.events}${self.error ? `, error=${self.error}` : ''})`
      );
    },
  });
}

async function resolveAllLivelibProfiles(job, options = {}) {
  const reports = [];
  const profiles = bookCache.listProfiles().filter((profile) => profile.source === 'livelib');
  const cardBudget = resolve.createCardBudget(process.env.BOOKS_LIVELIB_CARD_BUDGET);
  const litresBudget = resolve.createLitresBudget(process.env.BOOKS_LITRES_BUDGET);
  job.stage = 'resolve';
  job.page = 0;
  job.pageTotal = profiles.length;
  job.setProgress(job.page, job.pageTotal);
  job.liveBudget = {
    litres: { limit: litresBudget.limit, used: litresBudget.used, remaining: litresBudget.remaining },
    card: { limit: cardBudget.limit, used: cardBudget.used, remaining: cardBudget.remaining },
  };
  const lockWaitMs = Number(process.env.BOOKS_RESOLVE_LOCK_WAIT_MS);
  const lock = await resolveLock.acquireLock({
    owner: `import:${job.id}`,
    waitMs: Number.isFinite(lockWaitMs) && lockWaitMs >= 0 ? lockWaitMs : 10 * 60 * 1000,
  });
  if (!lock.ok) {
    job.warning = 'resolve-lock-busy';
    console.warn(
      `[books-import ${job.id}] resolve lock busy for ${lock.waitedMs}ms — ` +
        'metadata pass skipped (a scheduled resolve is running)'
    );
    return reports;
  }
  try {
    for (const meta of profiles) {
      const data = bookCache.getProfile('livelib', meta.userKey);
      if (!data) continue;
      job.page++;
      const report = await resolve.resolveProfile(data, {
        force: Boolean(options.force),
        cardBudget,
        litresBudget,
        jar: options.jar,
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
      try {
        await scheduledResolve.mergeResolveState(data, report);
      } catch (err) {
        console.warn(`[books-import ${job.id}] resolve-state save failed: ${err.message}`);
      }
    }
  } finally {
    resolveLock.releaseLock(lock.token);
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

function startLivelibImport(username, options = {}) {
  const cleanUsername = String(username == null ? '' : username).trim().replace(/^@/, '');
  if (!/^[\w.-]{1,64}$/.test(cleanUsername)) {
    throw new livelib.LivelibError(
      'Укажите имя пользователя LiveLib (латиница, цифры, точка, дефис).',
      'livelib_invalid_username'
    );
  }

  const providedHeader =
    options.cookieHeader == null || String(options.cookieHeader).trim() === ''
      ? null
      : livelibCookies.normalizeCookieHeader(options.cookieHeader);
  const storedCookie = providedHeader ? null : livelibCookies.getCookies('livelib', cleanUsername);
  const cookieHeader = providedHeader || (storedCookie ? storedCookie.cookieHeader : null);
  const deepMode = options.deep === true ? true : options.deep === 'auto' ? 'auto' : false;

  const running = findRunningJob('livelib', cleanUsername);
  if (running) {
    if (providedHeader) {
      throw new livelib.LivelibError(
        'Импорт этого профиля уже выполняется — дождитесь завершения и повторите вставку cookie.',
        'livelib_import_running'
      );
    }
    return publicStatus(running);
  }

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
      status: 'done',
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
          job.setProgress(job.page, job.pageTotal);
          job.events = progress.events;
          job.percent = percentProgressOf(progress);
        },
      });

      profile = result.profile;
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

    const undated = profile.events.filter((event) => !event.finishedAt).length;
    const deepDone = Boolean(profile.deepScan && profile.deepScan.done === true);
    if (deepMode === true && deepDone) {
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
          job.setProgress(job.page, job.pageTotal);
          job.events = profile.events.length;
          job.undatedEventCount = undatedCount(profile.events);
          job.percent = percentOf(progress.page, progress.pageTotal);
          job.deep = deepSummary(profile.deepScan, profile.events, progress);
        },
        onBatch: async (draft, progress) => {
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

function undatedCount(events) {
  const list = Array.isArray(events) ? events : [];
  return list.filter(
    (event) => event && !event.finishedAt && !/^\d{4}-\d{2}$/.test(String(event.readMonth || ''))
  ).length;
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

function startHardcoverImport(userId, options = {}) {
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
  const force = options.force === true;

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
    force,
    percent: 0,
    sync: null,
    error: null,
    warning: null,
    startedAt: Date.now(),
  };
  rememberJob(job);

  enqueue(job, async () => {
    const owner = await hardcover.resolveUser(requested);
    job.userKey = String(owner.id);
    job.username = owner.username;
    const userKey = String(owner.id);
    const cachedProfile = bookCache.getProfile('hardcover', userKey);
    const cursor =
      cachedProfile && cachedProfile.sync && typeof cachedProfile.sync.lastSyncAt === 'string'
        ? cachedProfile.sync
        : null;
    const syncStartedAt = new Date().toISOString();
    const requestsBefore = hardcover.gate.snapshot().requests;

    const onProgress = (progress) => {
      job.stage = 'hardcover-journal';
      job.page = progress.page;
      job.pageTotal = progress.total ? Math.ceil(progress.total / 100) : null;
      job.setProgress(job.page, job.pageTotal);
      job.events = progress.events;
      if (job.sync) job.sync.changedRows = progress.changedRows;
      if (job.pageTotal) {
        job.percent = Math.max(1, Math.min(95, Math.round((progress.page / job.pageTotal) * 100)));
      }
    };

    let journal = null;
    if (!force && cursor) {
      job.sync = {
        mode: 'incremental',
        since: cursor.lastSyncAt,
        changedRows: 0,
        userBooksTotal: null,
        fallback: null,
      };
      journal = await hardcover.fetchJournalIncremental(owner.id, cursor.lastSyncAt, {
        knownTotal: cursor.userBooksTotal,
        onProgress,
      });
      if (journal.needsFull) {
        console.log(
          `[books-import ${job.id}] incremental journal shrank ` +
            `(${journal.totals.userBooks} < ${cursor.userBooksTotal}); full refresh`
        );
        job.sync.fallback = 'journal-shrank';
        journal = null;
      }
    }

    if (!journal) {
      job.sync = {
        mode: 'full',
        since: null,
        changedRows: null,
        userBooksTotal: null,
        fallback: job.sync && job.sync.fallback ? job.sync.fallback : null,
      };
      journal = await hardcover.fetchJournal(owner.id, { onProgress });
    }

    const events =
      journal.mode === 'incremental' && cachedProfile
        ? hardcover.mergeJournalEvents(cachedProfile.events, journal)
        : journal.events;
    const eventsWithDate = events.filter((event) => event && event.finishedAt).length;
    const mergedJournal = {
      ...journal,
      events,
      eventsWithDate,
      totals: { ...journal.totals, events: events.length },
    };

    const warnings = [];
    const profile = hardcover.buildProfile(owner, mergedJournal, warnings);
    profile.sync = {
      schemaVersion: 1,
      mode: journal.mode,
      lastSyncAt: syncStartedAt,
      fullSyncedAt:
        journal.mode === 'full'
          ? new Date().toISOString()
          : cursor && cursor.fullSyncedAt
          ? cursor.fullSyncedAt
          : null,
      userBooksTotal: journal.totals.userBooks == null ? null : Number(journal.totals.userBooks),
    };
    await bookCache.saveProfile('hardcover', userKey, profile);
    await bookCache.saveRawImport('hardcover', userKey, {
      totals: mergedJournal.totals,
      eventsWithDate,
      statusFilter: journal.statusFilter,
      keepStatusIds: journal.keepStatusIds,
      sync: profile.sync,
      importedAt: profile.importedAt,
    });

    job.events = events.length;
    job.percent = 100;
    job.requests = hardcover.gate.snapshot().requests - requestsBefore;
    job.sync = {
      mode: journal.mode,
      since: journal.mode === 'incremental' ? cursor.lastSyncAt : null,
      changedRows: journal.mode === 'incremental' ? journal.totals.changedRows : null,
      userBooksTotal: profile.sync.userBooksTotal,
      fallback: job.sync ? job.sync.fallback : null,
    };
    job.totals = {
      userBooks: mergedJournal.totals.userBooks,
      pages: mergedJournal.totals.pages,
      events: events.length,
      eventsWithDate,
      changedRows: job.sync.changedRows,
      skippedNonFinished: journal.statusFilter.skippedNonFinished,
      skippedByStatus: journal.statusFilter.byStatus,
      keepStatusIds: journal.keepStatusIds,
    };
    console.log(
      `[books-import ${job.id}] hardcover ${journal.mode} journal saved: ` +
        `${events.length} events (${eventsWithDate} dated), ${journal.works.size} works, ` +
        `changed=${job.sync.changedRows == null ? 'n/a' : job.sync.changedRows}, ` +
        `requests=${job.requests}, skipped=${journal.statusFilter.skippedNonFinished}`
    );

    const changedRows = journal.mode === 'incremental' ? journal.totals.changedRows || 0 : null;
    const shouldResolve = journal.mode === 'full' || changedRows > 0;
    if (shouldResolve) {
      const resolveJob = startResolveJob({ coalesce: true });
      job.resolveQueued = resolveJob ? resolveJob.id : null;
    } else {
      job.resolveQueued = null;
      job.resolveSkipped = true;
    }
  });

  return publicStatus(job);
}

function startResolveJob(options = {}) {
  const coalesce = options.coalesce !== false;
  if (coalesce) {
    const running = jobs.list().find(
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

function publicStatus(job) {
  return {
    ...jobs.snapshot(job),
    id: job.id,
    source: job.source,
    userKey: job.userKey,
    stage: job.stage,
    page: job.page,
    pageTotal: job.pageTotal,
    percent: job.percent == null ? null : Number(job.percent),
    events: job.events,
    done: Boolean(job.done),
    reused: Boolean(job.reused),
    force: Boolean(job.force),
    deepRequested: job.deepRequested === undefined ? false : job.deepRequested,
    skipLight: Boolean(job.skipLight),
    deep: job.deep || null,
    sync: job.sync || null,
    resolveQueued: job.resolveQueued || null,
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
    resolveBudget: job.stage === 'resolve' ? job.liveBudget || null : null,
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

function idle() {
  return jobs.whenIdle();
}

function resolveStateFromJobs(jobList, source) {
  const idle = { running: false, jobId: null, budgetRemaining: null };
  if (source !== 'livelib') return idle;
  for (const job of jobList) {
    if (!job || job.done) continue;
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
  return resolveStateFromJobs(jobs.list(), source);
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
  isRunning(source, userKey) {
    return Boolean(findRunningJob(source, String(userKey == null ? '' : userKey).trim()));
  },
  idle,
};
