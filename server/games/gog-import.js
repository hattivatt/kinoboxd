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
 * Import stages: queued → auth (refresh if needed) → user (identity) →
 * library (getFilteredProducts, 100/page) → playtime (gameplay sessions,
 * `time_sum` minutes, one request per game, budget `GAMES_GOG_BUDGET`) → done.
 *
 * Degradation is honest (§14.4 п. 7): an expired token is `auth_expired` and
 * the previous snapshot is kept with its `fetchedAt`; a network/5xx error is
 * `deferred` and never overwrites the library with an empty one; a `401` is an
 * auth state, not "0 games".
 *
 * Tokens never leave `gog-cache` and never appear in the job status. All
 * secrets are masked before any error message is built.
 */

const crypto = require('crypto');

const gameCache = require('./game-cache');
const gogCache = require('./gog-cache');
const gog = require('./gog');

const jobs = new Map();
const jobOrder = [];
const MAX_JOBS = 20;
const chains = new Map();

function newJobId(userKey) {
  return `games-gog-${gogCache.safeKey(userKey)}-${Date.now().toString(36)}-${crypto
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

function chainFor(userKey) {
  if (!chains.has(userKey)) chains.set(userKey, Promise.resolve());
  return chains.get(userKey);
}

function findRunningJob(userKey) {
  for (const job of jobs.values()) {
    if (job.done || job.status !== 'running') continue;
    if (job.userKey === userKey) return job;
  }
  return null;
}

function publicStatus(job) {
  if (!job) return null;
  return {
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
    budget: job.budget == null ? null : job.budget,
    budgetExceeded: Boolean(job.budgetExceeded),
    pages: job.pages || null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    elapsedMs: (job.finishedAt ? job.finishedAt : Date.now()) - job.startedAt,
  };
}

function fail(job, err) {
  job.status = 'failed';
  job.done = true;
  job.code = (err && err.code) || 'gog_error';
  job.error = gog.maskSecrets((err && err.message) || 'GOG import failed');
  if (err && err.retryAt) job.retryAt = err.retryAt;
  job.finishedAt = Date.now();
  return job;
}

/* ------------------------------------------------------------------ */
/* connect                                                             */
/* ------------------------------------------------------------------ */

function resolveOwner(ownerProfile, { userKey, existing }) {
  const explicit = String(ownerProfile == null ? '' : ownerProfile).trim();
  if (explicit) {
    const parsed = gameCache.parseProfileToken(explicit);
    if (!parsed || !gameCache.getProfile(parsed.userKey)) {
      throw new gog.GogError(
        `"profile": неизвестный Steam-профиль ${explicit}. Сначала импортируйте Steam.`,
        'unknown_profile',
        { status: 400 }
      );
    }
    return parsed.key;
  }
  if (existing && existing.ownerProfile) return existing.ownerProfile;
  const profiles = gameCache.listProfiles();
  if (profiles.length === 1) return profiles[0].key;
  if (profiles.length === 0) return null;
  throw new gog.GogError(
    'Профилей Steam несколько: укажите "profile" (steam-<steamid64>), к какому владельцу привязать GOG.',
    'owner_required',
    { status: 400 }
  );
}

function assertOwnerFree(ownerProfile, userKey) {
  if (!ownerProfile) return;
  const attached = gogCache.accountsForOwner(ownerProfile);
  const other = attached.find((entry) => entry.userKey !== String(userKey));
  if (other) {
    throw new gog.GogError(
      `К профилю ${ownerProfile} уже подключён GOG-аккаунт ${other.userKey}. ` +
        'Один владелец — один GOG; отключите предыдущий или укажите другой профиль.',
      'gog_already_connected',
      { status: 400 }
    );
  }
}

/**
 * Exchange the one-time `code` for tokens, read the identity and persist both
 * the token (0600) and the public profile. Returns a sanitized view.
 */
async function connect({ code, ownerProfile, profile, client }) {
  const api = client || gog.createClient();
  const tokens = await api.exchangeCode(code);
  const provisional = {
    accessToken: tokens.accessToken,
    userKey: tokens.userId || '',
  };
  const user = await api.getUserData(provisional);
  const userKey = user.userKey;

  const existing = gogCache.getToken(userKey);
  const owner = resolveOwner(ownerProfile != null ? ownerProfile : profile, { userKey, existing });
  assertOwnerFree(owner, userKey);

  const nowIso = new Date().toISOString();
  const tokenDoc = {
    userKey,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || (existing && existing.refreshToken) || null,
    expiresAt: tokens.expiresAt,
    tokenType: tokens.tokenType,
    scope: tokens.scope,
    username: user.username,
    galaxyUserId: user.galaxyUserId,
    country: user.country,
    avatar: user.avatar,
    ownerProfile: owner,
    connectedAt: (existing && existing.connectedAt) || nowIso,
    obtainedAt: nowIso,
    refreshedAt: (existing && existing.refreshedAt) || null,
  };
  gogCache.saveToken(userKey, tokenDoc);
  gogCache.saveProfile({
    userKey,
    username: user.username,
    galaxyUserId: user.galaxyUserId,
    country: user.country,
    avatar: user.avatar,
    ownerProfile: owner,
    connectedAt: tokenDoc.connectedAt,
    fetchedAt: nowIso,
  });
  return {
    account: gogCache.publicTokenView(gogCache.getToken(userKey)),
    // Boolean only: the token value is never exposed.
    tokenStored: true,
  };
}

/* ------------------------------------------------------------------ */
/* token refresh                                                       */
/* ------------------------------------------------------------------ */

const REFRESH_MARGIN_MS = 60 * 1000;

/**
 * Return a token document with a usable access token. Refreshes when the
 * access token expires within a minute; a failed refresh is `auth_expired`
 * (the snapshot stays, the UI asks to reconnect).
 */
async function ensureAccessToken(userKey, api) {
  const doc = gogCache.getToken(userKey);
  if (!doc) {
    throw new gog.GogError(
      'GOG не подключён: нет токена. Нажмите «Войти через GOG».',
      'gog_auth_required'
    );
  }
  const expiresMs = doc.expiresAt ? Date.parse(doc.expiresAt) : NaN;
  if (Number.isFinite(expiresMs) && expiresMs > Date.now() + REFRESH_MARGIN_MS) {
    return doc;
  }
  if (!doc.refreshToken) {
    throw new gog.GogError(
      'Срок действия токена GOG истёк, refresh_token отсутствует: подключите GOG заново.',
      'gog_auth_expired'
    );
  }
  let fresh;
  try {
    fresh = await api.refresh(doc.refreshToken);
  } catch (err) {
    if (err && (err.code === 'gog_auth_expired' || err.code === 'gog_invalid_code')) {
      throw new gog.GogError(
        'GOG refresh_token больше не действителен: подключите GOG заново.',
        'gog_auth_expired'
      );
    }
    throw err;
  }
  const merged = {
    ...doc,
    accessToken: fresh.accessToken,
    refreshToken: fresh.refreshToken || doc.refreshToken,
    expiresAt: fresh.expiresAt,
    refreshedAt: new Date().toISOString(),
  };
  gogCache.saveToken(userKey, merged);
  return merged;
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

function playtimeTargets(products) {
  // Movies and DLC have no gameplay sessions; `category` is absent on some
  // rows, so unknown rows are kept (a 404 is a real zero).
  return (products || []).filter((product) => {
    if (!product || !product.gogGameId) return false;
    if (product.isMovie === true) return false;
    if (product.isGame === false && product.category !== 'game') return false;
    if (product.category === 'dlc' || product.category === 'movie') return false;
    if (product.isHidden === true) return false;
    return true;
  });
}

async function runImport(job, api, options) {
  const userKey = job.userKey;
  try {
    job.stage = 'auth';
    job.percent = 5;
    let tokenDoc = await ensureAccessToken(userKey, api);

    job.stage = 'user';
    job.percent = 10;
    const user = await api.getUserData(tokenDoc);
    const profile = gogCache.getProfile(userKey);
    gogCache.saveProfile({
      ...(profile || {}),
      userKey,
      username: user.username,
      galaxyUserId: user.galaxyUserId,
      country: user.country,
      avatar: user.avatar,
      ownerProfile: tokenDoc.ownerProfile || (profile && profile.ownerProfile) || null,
      connectedAt: (profile && profile.connectedAt) || tokenDoc.connectedAt || new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    });

    job.stage = 'library';
    job.percent = 15;
    const previous = gogCache.getLibrary(userKey);
    if (!job.force && gogCache.isFresh(previous, gogCache.libraryTtlMs())) {
      job.reused = true;
      job.libraryCount = Array.isArray(previous.products) ? previous.products.length : 0;
      job.pages = Array.isArray(previous.pages) ? previous.pages : null;
      job.warning = job.warning || 'library_fresh';
    } else {
      const fetched = await api.fetchAllProducts(tokenDoc);
      job.percent = 45;
      const nowIso = new Date().toISOString();
      const doc = {
        userKey,
        ownerProfile: tokenDoc.ownerProfile || null,
        fetchedAt: nowIso,
        partial: !fetched.complete,
        products: fetched.products,
        pages: fetched.pages,
        totalPages: fetched.totalPages,
        totalProducts: fetched.totalProducts,
        productsPerPage: fetched.productsPerPage,
        fingerprint: gog.libraryFingerprint(fetched.products),
        account: {
          username: user.username,
          galaxyUserId: user.galaxyUserId,
          country: user.country,
          avatar: user.avatar,
        },
      };
      gogCache.saveLibrary(userKey, doc);
      job.libraryCount = fetched.products.length;
      job.pages = fetched.pages;
      job.libraryPartial = !fetched.complete;
    }

    const library = gogCache.getLibrary(userKey) || previous;
    const products = Array.isArray(library && library.products) ? library.products : [];
    if (!products.length) {
      // A genuinely empty library is possible, but an empty page set usually
      // means the token lost access. Keep the snapshot and say so.
      job.warning = job.warning || 'library_empty';
    }

    job.stage = 'playtime';
    job.percent = 50;
    const budget = options.budget;
    const prior = gogCache.getPlaytime(userKey);
    const priorMinutes =
      prior && prior.minutes && typeof prior.minutes === 'object' ? prior.minutes : {};
    const targets = playtimeTargets(products);
    const minutes = job.force ? {} : { ...priorMinutes };
    const errors = [];
    let requests = 0;
    let pending = 0;
    for (const product of targets) {
      if (!job.force && Object.prototype.hasOwnProperty.call(priorMinutes, product.gogGameId)) {
        continue;
      }
      if (requests >= budget) {
        pending = targets.length - requests - Object.keys(minutes).length;
        job.budgetExceeded = true;
        break;
      }
      try {
        const session = await api.getSessions(tokenDoc, product.gogGameId);
        minutes[product.gogGameId] = session.minutes;
        requests++;
      } catch (err) {
        if (err && (err.code === 'gog_auth_expired' || err.code === 'gog_auth_required')) {
          throw err;
        }
        if (err && err.code === 'gog_rate_limited') throw err;
        errors.push({
          gogGameId: product.gogGameId,
          code: (err && err.code) || 'gog_error',
          message: gog.maskSecrets((err && err.message) || 'playtime failed'),
        });
        requests++;
      }
      const done = Object.keys(minutes).length;
      job.percent = Math.min(95, 50 + Math.floor((done / Math.max(1, targets.length)) * 45));
      job.playtimeGames = done;
    }
    if (pending < 0) pending = 0;
    job.playtimePending = pending;
    gogCache.savePlaytime(userKey, {
      userKey,
      ownerProfile: tokenDoc.ownerProfile || null,
      fetchedAt: new Date().toISOString(),
      minutes,
      fetchedGames: Object.keys(minutes).length,
      pendingGames: pending,
      budget,
      budgetExceeded: Boolean(job.budgetExceeded),
      errors,
      libraryFingerprint: library ? library.fingerprint || null : null,
    });
    job.playtimeGames = Object.keys(minutes).length;

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
function startImport({ account, profile, force = false, client, budget } = {}) {
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
      (gogCache.getToken(userKey) && gogCache.getToken(userKey).ownerProfile) || null,
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
    budget: null,
    budgetExceeded: false,
    pages: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  const api = client || gog.createClient();
  const envBudget = Number(process.env.GAMES_GOG_BUDGET);
  const resolvedBudget =
    budget != null
      ? Number(budget)
      : Number.isFinite(envBudget) && envBudget > 0
        ? envBudget
        : 200;
  job.budget = resolvedBudget;
  rememberJob(job);

  const previous = chainFor(userKey);
  const next = previous
    .catch(() => {})
    .then(() => runImport(job, api, { budget: resolvedBudget }));
  chains.set(userKey, next);
  return publicStatus(job);
}

function getStatus(jobId) {
  return publicStatus(jobs.get(String(jobId == null ? '' : jobId).trim()));
}

function listJobs() {
  return [...jobs.values()].map(publicStatus).sort((a, b) => b.startedAt - a.startedAt);
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
