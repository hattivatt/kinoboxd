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

const gameCache = require('./game-cache');
const { createJobs } = require('../core/jobs');
const gogCache = require('./gog-cache');
const gog = require('./gog');
const gogAuth = require('./gog-auth');
const secondaryIdentity = require('./secondary-identity');
const secondaryDetails = require('./secondary-details');
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

/** How many raw `sessions` answers one run keeps in `cache-games/debug/gog/`. */
const DEBUG_DUMP_LIMIT = 3;
const DEFAULT_RECHECK_ZERO_MS = 24 * 60 * 60 * 1000;

/**
 * Zero-hour rows are re-checked instead of being skipped forever: a 404 or a
 * wrong `{uid}` used to freeze «0 ч» permanently (01.11.2026). Bounded by the
 * same per-run budget, at most once per window.
 */
function recheckZeroMs() {
  const raw = Number(process.env.GAMES_GOG_RECHECK_ZERO_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RECHECK_ZERO_MS;
}

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
  if (profiles.length === 0) {
    throw new gog.GogError(
      'Сначала импортируйте Steam-профиль: GOG — вторая библиотека того же владельца, ' +
        'без владельца её не к чему привязать.',
      'steam_profile_required',
      { status: 400 }
    );
  }
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
  let tokens;
  try {
    tokens = await api.exchangeCode(code);
  } catch (err) {
    gogAuth.recordEvent('connect', {
      ok: false,
      reason: 'code_exchange',
      httpStatus: err && err.status,
      error: (err && err.code) || 'gog_error',
      errorDescription: gogAuth.descriptionOf(err),
    });
    throw err;
  }
  const provisional = {
    accessToken: tokens.accessToken,
    userKey: tokens.userId || '',
  };
  let user;
  try {
    user = await api.getUserData(provisional);
  } catch (err) {
    gogAuth.recordEvent('user_data', {
      ok: false,
      reason: 'connect',
      httpStatus: err && err.status,
      error: (err && err.code) || 'gog_error',
      errorDescription: gogAuth.descriptionOf(err),
      doc: provisional,
      userKey: provisional.userKey || null,
      sessionId: tokens.sessionId,
    });
    throw err;
  }
  const userKey = user.userKey;

  const existing = gogCache.getToken(userKey);
  const owner = resolveOwner(ownerProfile != null ? ownerProfile : profile, { userKey, existing });
  if (existing && existing.ownerProfile && existing.ownerProfile !== owner) {
    throw new gog.GogError(
      `GOG-аккаунт ${userKey} уже привязан к профилю ${existing.ownerProfile}. ` +
        'Чужой аккаунт нельзя перевесить на другого владельца: отключите его сначала.',
      'owner_mismatch',
      { status: 400 }
    );
  }
  assertOwnerFree(owner, userKey);

  const nowIso = new Date().toISOString();
  const tokenDoc = {
    userKey,
    // The two ids `gameplay.gog.com` may expect: the OAuth `user_id` (Heroic)
    // and the `galaxyUserId` from `userData.json` (comet/unifideck). Both are
    // stored so the playtime phase never falls back to `userData.json.userId`
    // — that field is not the Galaxy id (01.11.2026 zero-hours bug).
    userId: tokens.userId || (existing && existing.userId) || null,
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
    // A fresh connect is a clean slate: a stale refresh error from the previous
    // token must not keep the account in «подключите GOG заново».
    lastRefreshError: null,
    lastError: null,
    sessionId: tokens.sessionId || null,
  };
  gogCache.saveToken(userKey, tokenDoc);
  gogAuth.recordEvent('connect', {
    ok: true,
    reason: 'code_exchange',
    httpStatus: 200,
    doc: tokenDoc,
    userKey,
    galaxyUserId: user.galaxyUserId,
    sessionId: tokens.sessionId || null,
    now: Date.parse(nowIso),
  });
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

/**
 * Return a token document with a usable access token. Delegates to
 * `gog-auth.ensureFreshToken`: a 5-minute buffer (not one minute) and a single
 * silent-refresh implementation shared with every API call. A failed refresh is
 * `auth_expired` — the library snapshot stays, only the auth state changes.
 */
async function ensureAccessToken(userKey, api, options = {}) {
  const { doc } = await gogAuth.ensureFreshToken(userKey, api, {
    ...options,
    reason: options.reason || 'import',
  });
  return doc;
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
  // Every token-needing call goes through the silent-refresh wrapper: a 5-min
  // buffer check before the call and exactly one retry after a 401/302.
  const tokenApi = gogAuth.wrapClient(api, userKey, options.authOptions || {});
  try {
    job.stage = 'auth';
    job.percent = 5;
    let tokenDoc = await ensureAccessToken(userKey, api);

    job.stage = 'user';
    job.percent = 10;
    const user = await tokenApi.getUserData(tokenDoc);
    // Persist the Galaxy id (and the OAuth id when the token carried it): the
    // playtime phase needs it as `{uid}`, and an account connected before the
    // 01.11.2026 fix has neither field yet.
    if (user.galaxyUserId && tokenDoc.galaxyUserId !== user.galaxyUserId) {
      tokenDoc = { ...tokenDoc, galaxyUserId: user.galaxyUserId };
      try {
        gogCache.saveToken(userKey, tokenDoc);
      } catch (err) {
        /* a read-only cache must not break the import */
      }
    }
    // Self-heal the owner binding: a token written before the «one owner»
    // rule (or restored from a backup) has no `ownerProfile`, and `/stats`
    // then shows «подключите GOG заново» although the account is connected.
    const libraryOwner =
      (gogCache.getLibrary(userKey) && gogCache.getLibrary(userKey).ownerProfile) || null;
    const boundOwner = tokenDoc.ownerProfile || libraryOwner || job.ownerProfile || null;
    if (boundOwner && tokenDoc.ownerProfile !== boundOwner) {
      tokenDoc = { ...tokenDoc, ownerProfile: boundOwner };
      try {
        gogCache.saveToken(userKey, tokenDoc);
      } catch (err) {
        /* a read-only cache must not break the import */
      }
    }
    job.ownerProfile = tokenDoc.ownerProfile || null;
    gogAuth.recordEvent('user_data', {
      ok: true,
      reason: 'import',
      httpStatus: 200,
      doc: tokenDoc,
      userKey,
      galaxyUserId: user.galaxyUserId,
      sessionId: tokenDoc.sessionId || null,
    });
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
      const fetched = await tokenApi.fetchAllProducts(tokenDoc);
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
      job.partial = job.libraryPartial;
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
    const priorEntries =
      prior && prior.entries && typeof prior.entries === 'object' ? prior.entries : {};
    const targets = playtimeTargets(products);
    // The uid this run will use: a snapshot written with a different one has
    // untrustworthy zeros and is re-checked immediately.
    const currentUidSource = gog.gameplayUserId(tokenDoc).source;
    // Every id the token can offer, with its source: the decisive diagnostic
    // for a persisting «0.0 ч» (same number in `token:user_id` and
    // `userData:userId`, different `userData:galaxyUserId` → the order is the
    // remaining bug, not a missing field).
    const uidCandidates = gog.gameplayUserIdCandidates(tokenDoc);
    const minutes = job.force ? {} : { ...priorMinutes };
    const entries = job.force ? {} : { ...priorEntries };
    const errors = [];
    const stats = {
      requests: 0,
      ok: 0,
      notFound: 0,
      zero: 0,
      unparsed: 0,
      errors: 0,
      fields: {},
      uidSource: null,
      // Which numeric ids the token carries and which one the run used. Ids are
      // account labels, not secrets; no token value is included.
      uidCandidates,
      dump: [],
    };
    const sample = [];
    let requests = 0;
    let pending = 0;
    for (const product of targets) {
      const cached = Object.prototype.hasOwnProperty.call(priorMinutes, product.gogGameId);
      // A cached **zero** is not a final answer: a 404 or a wrong `{uid}` wrote
      // it and the 01.11.2026 fix would never reach those rows. Zero-hour games
      // are re-checked (bounded by the same budget), positive ones are reused.
      const cachedPositive = cached && Number(priorMinutes[product.gogGameId]) > 0;
      if (!job.force && cachedPositive) continue;
      if (!job.force && cached && Number(priorMinutes[product.gogGameId]) === 0) {
        // Re-check immediately when the previous snapshot is not trustworthy:
        //   - it was written with a different `{uid}` (the identity fix), or
        //   - the answer did not parse (`unparsed`).
        // Otherwise at most once per `GAMES_GOG_RECHECK_ZERO_MS` (24 h) so a
        // normal import does not hammer the endpoint with dozens of 404s.
        const entry = entries[product.gogGameId] || null;
        const identityChanged = Boolean(prior.uidSource) && prior.uidSource !== currentUidSource;
        const staleAnswer = !entry || entry.status === 'unparsed';
        if (!identityChanged && !staleAnswer) {
          const age = entry.at ? Date.now() - Date.parse(entry.at) : Infinity;
          if (Number.isFinite(age) && age < recheckZeroMs()) continue;
        }
      }
      if (requests >= budget) {
        pending = targets.length - requests - Object.keys(minutes).length;
        job.budgetExceeded = true;
        break;
      }
      const captureRaw = stats.dump.length < DEBUG_DUMP_LIMIT;
      try {
        const session = await tokenApi.getSessions(tokenDoc, product.gogGameId, {
          raw: captureRaw,
        });
        requests++;
        stats.requests++;
        stats.uidSource = stats.uidSource || session.uidSource || null;
        if (session.field) stats.fields[session.field] = (stats.fields[session.field] || 0) + 1;
        // A client that predates the `status` field (or a fake in a test) is
        // read through the old `found` boolean: `found:false` was a 404.
        const status =
          session.status || (session.found === false ? 'not_found' : 'ok');
        if (status === 'ok' && session.minutes != null) {
          stats.ok++;
          if (!(session.minutes > 0)) stats.zero++;
          minutes[product.gogGameId] = session.minutes;
          entries[product.gogGameId] = {
            minutes: session.minutes,
            status: 'ok',
            field: session.field || null,
            at: new Date().toISOString(),
          };
        } else if (status === 'not_found') {
          stats.notFound++;
          minutes[product.gogGameId] = 0;
          entries[product.gogGameId] = {
            minutes: 0,
            status: 'not_found',
            field: null,
            at: new Date().toISOString(),
          };
        } else {
          // 200 without a recognizable field: keep it pending, never a zero.
          stats.unparsed++;
          delete minutes[product.gogGameId];
          entries[product.gogGameId] = {
            minutes: null,
            status: 'unparsed',
            field: null,
            at: new Date().toISOString(),
          };
        }
        if (captureRaw) {
          const dumpDoc = {
            schemaVersion: 1,
            source: 'gog',
            kind: 'sessions-raw',
            gogGameId: String(product.gogGameId),
            title: product.title || null,
            capturedAt: new Date().toISOString(),
            uidSource: session.uidSource || null,
            httpStatus: session.httpStatus || null,
            status: session.status,
            field: session.field || null,
            minutes: session.minutes,
            // The token is never part of the dump: only the answer shape.
            urlShape: `gameplay.gog.com/games/{gogGameId}/users/{uid}/sessions`,
            raw: session.raw || null,
          };
          gogCache.writeDebugDump(String(product.gogGameId), dumpDoc);
          stats.dump.push(String(product.gogGameId));
        }
        if (sample.length < 5) {
          sample.push({
            name: product.title || null,
            gogGameId: String(product.gogGameId),
            hours: session.minutes == null ? null : Math.round((session.minutes / 60) * 10) / 10,
            status: session.status,
          });
        }
      } catch (err) {
        if (err && (err.code === 'gog_auth_expired' || err.code === 'gog_auth_required')) {
          throw err;
        }
        if (err && err.code === 'gog_rate_limited') throw err;
        stats.errors++;
        errors.push({
          gogGameId: product.gogGameId,
          code: (err && err.code) || 'gog_error',
          message: gog.maskSecrets((err && err.message) || 'playtime failed'),
        });
        requests++;
        stats.requests++;
      }
      const done = Object.keys(minutes).length;
      job.percent = Math.min(95, 50 + Math.floor((done / Math.max(1, targets.length)) * 45));
      job.playtimeGames = done;
      job.setProgress(done, targets.length);
    }
    if (pending < 0) pending = 0;
    job.playtimePending = pending;
    job.playtime = {
      ...stats,
      targets: targets.length,
      cached: Object.keys(minutes).length,
      pending,
      // `sample` is the first five works of this run: name + hours, so the job
      // summary answers «часы вообще пришли?» without opening the cache.
      sample,
    };
    gogCache.savePlaytime(userKey, {
      userKey,
      ownerProfile: tokenDoc.ownerProfile || null,
      fetchedAt: new Date().toISOString(),
      minutes,
      entries,
      fetchedGames: Object.keys(minutes).length,
      pendingGames: pending,
      budget,
      budgetExceeded: Boolean(job.budgetExceeded),
      uidSource: stats.uidSource,
      uidCandidates,
      fields: stats.fields,
      errors,
      libraryFingerprint: library ? library.fingerprint || null : null,
    });
    job.playtimeGames = Object.keys(minutes).length;

    // M6c: one Wikidata batch (P2725 → P1733) so the GOG products that are not
    // matched by title can join their Steam work. Never fatal, never on an
    // injected client (tests stay hermetic).
    job.stage = 'identity';
    job.percent = 96;
    job.secondaryLinks = await secondaryIdentity.refreshForJob({
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
