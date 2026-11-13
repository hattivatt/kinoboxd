'use strict';

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
      client: client || undefined,
    });
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
