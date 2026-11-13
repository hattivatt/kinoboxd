'use strict';

const express = require('express');

const { budgetLimitFromEnv } = require('../core/budget');
const { HttpError, mapDomainError } = require('../core/errors');
const { assertOnlyParams, parseForce } = require('../core/params');
const gameCache = require('./game-cache');
const gogCache = require('./gog-cache');
const gog = require('./gog');
const gogJobs = require('./gog-import');

const GOG_ERROR_STATUS = {
  gog_auth_required: 401,
  gog_auth_expired: 401,
  gog_not_connected: 400,
  gog_invalid_code: 400,
  gog_invalid_request: 400,
  gog_code_required: 400,
  gog_client_rejected: 502,
  gog_invalid_user: 400,
  gog_invalid_url: 400,
  gog_rate_limited: 429,
  gog_unreachable: 502,
  gog_http_error: 502,
  unknown_profile: 400,
  steam_profile_required: 400,
  owner_required: 400,
  owner_mismatch: 400,
  gog_already_connected: 400,
  account_required: 400,
  gog_owner_mismatch: 400,
};

const GOG_ERROR_PROFILE = {
  rules: [
    {
      is: gog.GogError,
      statuses: GOG_ERROR_STATUS,
      defaultStatus: 502,
      ownStatus: 'whenSet',
    },
  ],
  fallback: { code: 'games_gog_error' },
  retryAt: true,
};



function bodyOf(req) {
  return req.body && typeof req.body === 'object' ? req.body : {};
}

function createRouter(deps = {}) {
  const client = deps.client || null;
  const router = express.Router();

  router.get('/auth-url', (req, res, next) => {
    try {
      assertOnlyParams(req, [], 'GET /api/games/gog/auth-url');
      const api = client || gog.createClient();
      res.status(200).json({
        url: api.authorizeUrl(),
        redirectUri: gog.REDIRECT_URI,
        clientSource: gog.clientSource(),
        instructions:
          'Откройте ссылку, войдите в GOG и скопируйте параметр code из адресной строки ' +
          'страницы embed.gog.com/on_login_success — или скопируйте адрес страницы целиком. ' +
          'Вставьте в поле «code» сам code или всю ссылку: сервер разберёт её сам.',
      });
    } catch (err) {
      next(mapDomainError(err, GOG_ERROR_PROFILE));
    }
  });

  router.post('/auth', async (req, res, next) => {
    try {
      assertOnlyParams(req, ['code', 'profile'], 'POST /api/games/gog/auth');
      const body = bodyOf(req);
      const code = body.code != null ? body.code : req.query.code;
      if (code == null || String(code).trim() === '') {
        throw new HttpError(
          400,
          'Body must contain "code" — the one-time code from the GOG login redirect.',
          'gog_code_required'
        );
      }
      const ownerProfile = body.profile != null ? body.profile : req.query.profile;
      const result = await gogJobs.connect({
        code: String(code).trim(),
        ownerProfile,
        client: client || undefined,
      });
      res.status(200).json({ connected: true, ...result });
    } catch (err) {
      next(mapDomainError(err, GOG_ERROR_PROFILE));
    }
  });

  router.get('/status', (req, res, next) => {
    try {
      assertOnlyParams(req, [], 'GET /api/games/gog/status');
      const accounts = gogCache.listAccounts();
      const profiles = accounts.map((account) => {
        const library = gogCache.getLibrary(account.userKey);
        const playtime = gogCache.getPlaytime(account.userKey);
        return {
          ...account,
          binding: account.authState ? account.authState.binding : null,
          libraryCount:
            library && Array.isArray(library.products) ? library.products.length : null,
          libraryFetchedAt: library ? library.fetchedAt || null : null,
          playtimeGames:
            playtime && playtime.fetchedGames != null ? playtime.fetchedGames : null,
          playtimeFetchedAt: playtime ? playtime.fetchedAt || null : null,
          stale: library ? !gogCache.isFresh(library, gogCache.libraryTtlMs()) : true,
        };
      });
      res.status(200).json({
        source: 'gog',
        configured: true,
        clientSource: gog.clientSource(),
        accounts: profiles,
        owners: gameCache.listProfiles().map((entry) => ({
          key: entry.key,
          label: entry.label || entry.personaName || null,
        })),
        budget: budgetLimitFromEnv('GAMES_GOG_BUDGET', 200),
        libraryTtlHours: Math.round(gogCache.libraryTtlMs() / 3600000),
        playtimeTtlHours: Math.round(gogCache.playtimeTtlMs() / 3600000),
        debug: {
          authLifecycle: gogCache.debugPath(gogCache.AUTH_LIFECYCLE_NAME),
          dir: gogCache.DEBUG_DIR,
        },
      });
    } catch (err) {
      next(mapDomainError(err, GOG_ERROR_PROFILE));
    }
  });

  router.post('/import', (req, res, next) => {
    try {
      assertOnlyParams(req, ['account', 'force', 'profile'], 'POST /api/games/gog/import');
      const body = bodyOf(req);
      const force = parseForce(body.force != null ? body.force : req.query.force);
      const account = body.account != null ? body.account : req.query.account;
      const profile = body.profile != null ? body.profile : req.query.profile;
      const job = gogJobs.startImport({
        account,
        profile,
        force,
        client: client || undefined,
        budget: deps.budget,
      });
      const created = job.status === 'running' && !job.reused && job.stage === 'queued';
      res.status(created ? 201 : 200).json(job);
    } catch (err) {
      next(mapDomainError(err, GOG_ERROR_PROFILE));
    }
  });

  router.get('/import/status', (req, res, next) => {
    try {
      assertOnlyParams(req, ['id'], 'GET /api/games/gog/import/status');
      const id = req.query.id;
      if (id == null || String(id).trim() === '') {
        throw new HttpError(400, 'Query parameter "id" is required.', 'job_id_required');
      }
      const status = gogJobs.getStatus(String(id).trim());
      if (!status) throw new HttpError(404, 'Unknown GOG import job id.', 'unknown_job');
      res.status(200).json(status);
    } catch (err) {
      next(mapDomainError(err, GOG_ERROR_PROFILE));
    }
  });

  router.get('/import/:jobId', (req, res, next) => {
    try {
      const status = gogJobs.getStatus(req.params.jobId);
      if (!status) throw new HttpError(404, 'Unknown GOG import job id.', 'unknown_job');
      res.status(200).json(status);
    } catch (err) {
      next(mapDomainError(err, GOG_ERROR_PROFILE));
    }
  });

  router.post('/logout', (req, res, next) => {
    try {
      assertOnlyParams(req, ['account', 'profile'], 'POST /api/games/gog/logout');
      const body = bodyOf(req);
      const account = body.account != null ? body.account : req.query.account;
      const profile = body.profile != null ? body.profile : req.query.profile;
      let userKey;
      try {
        userKey = gogJobs.resolveAccount({ account, profile });
      } catch (err) {
        if (err && err.code === 'gog_not_connected' && account == null && profile == null) {
          res.status(200).json({ disconnected: false, reason: 'not_connected' });
          return;
        }
        throw err;
      }
      const removed = gogCache.deleteToken(userKey);
      res.status(200).json({
        disconnected: removed,
        account: gogCache.profileKeyOf(userKey),
        snapshotKept: Boolean(gogCache.getLibrary(userKey)),
      });
    } catch (err) {
      next(mapDomainError(err, GOG_ERROR_PROFILE));
    }
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
