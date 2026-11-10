'use strict';

/**
 * GOG connect + import jobs (M6a).
 *
 *   POST /api/games/gog/auth   { code, profile? }  → connects the account
 *   POST /api/games/gog/import { account?, profile?, force? } → 201 job
 *   GET  /api/games/gog/import/:jobId / status?id=…
 *
 * The account is a **same-owner secondary library** (ИГРЫ §14.4): `profile`
 * is the Steam owner token (`steam-<steamid64>`) the GOG library belongs to.
 * A GOG account can be attached to one owner only; a second GOG account for the
 * same owner is a 400 (`gog_already_connected`), never a silent sum.
 *
 * Import stages: queued → auth (silent refresh, 5-min buffer) → user (identity)
 * → library (getFilteredProducts, 100/page) → playtime (gameplay sessions,
 * `time_sum` minutes, one request per game, budget `GAMES_GOG_BUDGET`) →
 * identity (one Wikidata batch, P2725 → P1733) → done.
 *
 * Every token-needing call goes through `gog-auth.wrapClient`: the access token
 * is refreshed silently when it is inside the buffer and the call is retried
 * **once** after a 401/302. A refresh failure changes the token's auth state
 * only — the library snapshot is never overwritten or deleted.
 *
 * Playtime is diagnosable (§M6c): every run reports
 * `playtime {requests, ok, notFound, zero, unparsed, fields, uidSource,
 * sample[5]}` in the job status, and the first three raw `sessions` answers are
 * written to `cache-games/debug/gog/<gogGameId>.json` (5 KB cap, no token), so
 * «0.00 ч при часах в профиле» can be answered with the real body instead of a
 * guess. A cached zero is not final: it is re-checked when the `{uid}` changed
 * or the answer never parsed, otherwise once per `GAMES_GOG_RECHECK_ZERO_MS`.
 *
 * Degradation is honest (§14.4 п. 7): an expired token is `auth_expired` and
 * the previous snapshot is kept with its `fetchedAt`; a network/5xx error is
 * `deferred` and never overwrites the library with an empty one; a `401` is an
 * auth state, not "0 games".
 *
 * Tokens never leave `gog-cache` and never appear in the job status. All
 * secrets are masked before any error message is built.
 */

const { createJobs } = require('../core/jobs');
const gogCache = require('./gog-cache');
const gog = require('./gog');
const gogAuth = require('./gog-auth');
const { refreshForJob } = require('./secondary/title-genres');
const { connect, resolveOwner } = require('./gog-connect');
const secondaryDetails = require('./secondary-details');
const { ensureAccessToken, runAccountStage } = require('./gog-import-stages/account-stage');
const { runLibraryStage } = require('./gog-import-stages/library-stage');
const { playtimeTargets, runPlaytimeStage } = require('./gog-import-stages/playtime-stage');
const { budgetLimitFromEnv } = require('../core/budget');

/**
 * Job registry (core/jobs): single-flight per GOG account, one chain per
 * `userKey` (two accounts may import at once, one account never twice) and the
 * 20-job ring. `force` still starts a second job for the same account — the
 * per-key chain serializes it, which is the legacy behaviour.
 */
const jobs = createJobs({
  name: 'games-gog-import',
  idPrefix: 'games-gog',
  maxJobs: 20,
  keyOf: (job) => job.userKey,
  maskError: (err) => gog.maskSecrets((err && err.message) || 'GOG import failed'),
  errorCode: 'gog_error',
});

function newJobId(userKey) {
  return jobs.newId(userKey);
}

function rememberJob(job) {
  return jobs.remember(job);
}

function findRunningJob(userKey) {
  return jobs.findRunning(userKey);
}

function publicStatus(job) {
  if (!job) return null;
  return {
    ...jobs.snapshot(job),
    jobId: job.id,
    id: job.id,
    source: 'gog',
    account: job.userKey ? gogCache.profileKeyOf(job.userKey) : null,
    userKey: job.userKey || null,
    profile: job.ownerProfile || null,
    status: job.status,
    stage: job.stage,
    done: job.done,
    percent: job.percent,
    reused: job.reused,
    force: job.force,
    code: job.code,
    error: job.error,
    warning: job.warning,
    retryAt: job.retryAt || null,
    libraryPartial: Boolean(job.libraryPartial),
    libraryCount: job.libraryCount == null ? null : job.libraryCount,
    playtimeGames: job.playtimeGames == null ? null : job.playtimeGames,
    playtimePending: job.playtimePending == null ? null : job.playtimePending,
    // Per-run playtime diagnostics: how many requests answered 200/404/zero/
    // unparsed, which response field carried the minutes, and the first five
    // works with their hours. No tokens, no full payloads.
    playtime: job.playtime || null,
    secondaryLinks: job.secondaryLinks || null,
    budget: job.budget == null ? null : job.budget,
    budgetExceeded: Boolean(job.budgetExceeded),
    pages: job.pages || null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    elapsedMs: (job.finishedAt ? job.finishedAt : Date.now()) - job.startedAt,
  };
}

function fail(job, err) {
  return jobs.fail(job, err);
}

/* ------------------------------------------------------------------ */
/* import                                                              */
/* ------------------------------------------------------------------ */

function resolveAccount({ account, profile }) {
  const requested = String(account == null ? '' : account).trim();
  if (requested) {
    const userKey = gogCache.userKeyOf(requested);
    if (!userKey || !gogCache.getToken(userKey)) {
      throw new gog.GogError(
        `GOG-аккаунт "${requested}" не подключён. Сначала POST /api/games/gog/auth.`,
        'gog_not_connected',
        { status: 400 }
      );
    }
    return userKey;
  }
  const owner = String(profile == null ? '' : profile).trim();
  if (owner) {
    const accounts = gogCache.accountsForOwner(owner);
    if (accounts.length === 1) return accounts[0].userKey;
    if (accounts.length === 0) {
      throw new gog.GogError(
        `К профилю ${owner} GOG не подключён. Нажмите «Войти через GOG».`,
        'gog_not_connected',
        { status: 400 }
      );
    }
    throw new gog.GogError(
      `К профилю ${owner} подключено несколько GOG-аккаунтов: укажите "account".`,
      'account_required',
      { status: 400 }
    );
  }
  const all = gogCache.listAccounts();
  if (all.length === 1) return all[0].userKey;
  if (all.length === 0) {
    throw new gog.GogError(
      'GOG не подключён: нет ни одного аккаунта.',
      'gog_not_connected',
      { status: 400 }
    );
  }
  throw new gog.GogError(
    'Подключено несколько GOG-аккаунтов: укажите "account" (gog-<userId>).',
    'account_required',
    { status: 400 }
  );
}

async function runImport(job, api, options) {
  const userKey = job.userKey;
  // Every token-needing call goes through the silent-refresh wrapper: a 5-min
  // buffer check before the call and exactly one retry after a 401/302.
  const tokenApi = gogAuth.wrapClient(api, userKey, options.authOptions || {});
  try {
    const { tokenDoc, user } = await runAccountStage(job, { api, userKey, tokenApi });
    const { library, products } = await runLibraryStage(job, { tokenApi, tokenDoc, userKey, user });
    await runPlaytimeStage(job, {
      tokenApi,
      tokenDoc,
      userKey,
      library,
      products,
      budget: options.budget,
    });

    // M6c: one Wikidata batch (P2725 → P1733) so the GOG products that are not
    // matched by title can join their Steam work. Never fatal, never on an
    // injected client (tests stay hermetic).
    job.stage = 'identity';
    job.percent = 96;
    job.secondaryLinks = await refreshForJob({
      gogProducts: products,
      options: { ...options, force: job.force },
    });

    job.stage = 'done';
    job.percent = 100;
    job.status = 'done';
    job.done = true;
    job.finishedAt = Date.now();
    return job;
  } catch (err) {
    return fail(job, err);
  }
}

/**
 * Start (or coalesce into) an import job for one GOG account. `budget` is the
 * maximum number of `gameplay` requests in this run (`GAMES_GOG_BUDGET`,
 * default 200); already-cached minutes are reused and do not count.
 */
function startImport({
  account,
  profile,
  force = false,
  client,
  budget,
  autoSecondaryDetails = true,
} = {}) {
  const userKey = resolveAccount({ account, profile });
  const running = findRunningJob(userKey);
  if (running && !force) {
    running.reused = true;
    return publicStatus(running);
  }
  const job = {
    id: newJobId(userKey),
    userKey,
    // The owner binding is the token's, or — for a token written before the
    // «one owner» rule — the one its library snapshot already claims.
    ownerProfile:
      (gogCache.getToken(userKey) && gogCache.getToken(userKey).ownerProfile) ||
      (gogCache.getLibrary(userKey) && gogCache.getLibrary(userKey).ownerProfile) ||
      null,
    status: 'running',
    stage: 'queued',
    done: false,
    percent: 0,
    reused: false,
    force: Boolean(force),
    code: null,
    error: null,
    warning: null,
    libraryPartial: false,
    libraryCount: null,
    playtimeGames: null,
    playtimePending: null,
    playtime: null,
    secondaryLinks: null,
    budget: null,
    budgetExceeded: false,
    pages: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  const api = client || gog.createClient();
  const resolvedBudget =
    budget != null ? Number(budget) : budgetLimitFromEnv('GAMES_GOG_BUDGET', 200);
  job.budget = resolvedBudget;
  rememberJob(job);

  jobs.run(job, async () => {
    await runImport(job, api, {
      budget: resolvedBudget,
      // The identity bridge runs only for a real import: an injected client
      // (tests, diagnostics) keeps the job hermetic and never touches WDQS.
      client: client || undefined,
    });
    // M6d: the freshly written library snapshot is the target list for the
    // public store metadata (genres/year/poster). Same fire-and-forget rule
    // as the Steam enrich chain: a failure is a job warning, the import
    // stays `done`. An injected client (tests/diagnostics) never kicks.
    if (autoSecondaryDetails !== false && !client && job.ownerProfile) {
      const status = secondaryDetails.kickSecondaryDetailsQuietly(job.ownerProfile, {
        forceKick: true,
        ...secondaryDetails.targetsForOwner(job.ownerProfile),
      });
      job.secondaryDetailsJobId = (status && status.id) || null;
      job.secondaryDetailsSkipped = (status && status.skipped) || null;
    }
  }, {
    chainKey: userKey,
    onError: (self, err) => {
      jobs.fail(self, err);
      console.error(`[games-gog-import ${self.id}] ${self.code}: ${self.error}`);
    },
  });
  return publicStatus(job);
}

function getStatus(jobId) {
  return publicStatus(jobs.get(String(jobId == null ? '' : jobId).trim()));
}

function listJobs() {
  return jobs.list().map(publicStatus).sort((a, b) => b.startedAt - a.startedAt);
}

module.exports = {
  connect,
  ensureAccessToken,
  resolveAccount,
  resolveOwner,
  playtimeTargets,
  startImport,
  getStatus,
  listJobs,
  publicStatus,
};
