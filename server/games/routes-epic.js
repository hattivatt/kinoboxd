'use strict';

/**
 * `/api/games/epic/*` router (M6b). Mounted under the same auth gate as the
 * other games routers (server/index.js) and deliberately on **its own paths**
 * (`/epic/...`), so the parallel GOG branch (M6a) can add `/gog/...` without a
 * route conflict. The integration round (M6c) owns the shared
 * «Подключения» screen and the union aggregates.
 *
 *   GET  /api/games/epic/status?owner=steam-<id64>|accountId=<id>
 *   GET  /api/games/epic/auth-url          (login URL, no network call)
 *   POST /api/games/epic/connect           { code, owner?, label? }   ← primary
 *   POST /api/games/epic/auth              { owner?, label? }         (device-code,
 *                                          unavailable for public clients)
 *   GET  /api/games/epic/auth/:authId
 *   DELETE /api/games/epic/auth/:authId    (cancel)
 *   POST /api/games/epic/import            { accountId?, owner?, force?, label? }
 *   POST /api/games/epic/refresh           { accountId?, owner? }  (force import)
 *   GET  /api/games/epic/import/:jobId
 *   GET  /api/games/epic/import/status?id=…
 *   GET  /api/games/epic/exported?owner=…|accountId=…
 *   POST /api/games/epic/disconnect        { accountId?, owner? }
 *
 * Security: no endpoint returns a device code, access token, refresh token or
 * the launcher client secret. `tokenStore.redactTokens()` is the only token
 * shape that leaves the server (presence + expiry).
 */

const express = require('express');

const { HttpError } = require('../upload');
const gameCache = require('./game-cache');
const epic = require('./epic');
const epicCache = require('./epic-cache');
const epicAuth = require('./epic-auth');
const epicImport = require('./epic-import');
const epicLayer = require('./epic-layer');
const tokenStore = require('./epic-token-store');

const EPIC_ERROR_STATUS = {
  invalid_owner: 400,
  unknown_owner: 400,
  epic_account_required: 400,
  epic_not_connected: 400,
  owner_mismatch: 400,
  epic_invalid_account: 400,
  epic_auth_failed: 400,
  epic_auth_cancelled: 400,
  epic_auth_pending: 409,
  epic_auth_expired: 401,
  epic_rate_limited: 429,
  epic_unreachable: 502,
  epic_http_error: 502,
  epic_invalid_url: 400,
  epic_client_invalid: 502,
  epic_device_grant_unavailable: 400,
  epic_code_required: 400,
  epic_invalid_code: 400,
  epic_library_empty: 400,
  epic_token_store_error: 500,
  epic_invalid_catalog_item: 400,
  epic_import_failed: 502,
  unknown_auth: 404,
};

function mapError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof epic.EpicError || (err && err.code && EPIC_ERROR_STATUS[err.code])) {
    const status =
      Number.isInteger(err.status) && err.status >= 400
        ? err.status
        : EPIC_ERROR_STATUS[err.code] || 502;
    const mapped = new HttpError(status, epic.maskSecrets(err.message || 'Epic error'), err.code);
    if (err.retryAt) mapped.retryAt = err.retryAt;
    return mapped;
  }
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) {
    return new HttpError(err.status, epic.maskSecrets(err.message || 'Epic error'), err.code);
  }
  return err;
}

function assertOnlyParams(req, allowed, endpoint) {
  const keys = Object.keys(req.query || {});
  const extra = keys.filter((key) => !allowed.includes(key));
  if (!extra.length) return;
  throw new HttpError(
    400,
    `Unexpected query parameter(s) for ${endpoint}: ${extra.map((key) => `"${key}"`).join(', ')}. ` +
      `Accepted: ${allowed.map((key) => `"${key}"`).join(', ')}.`,
    'unexpected_parameter'
  );
}

const OWNER_RE = /^steam-(\d{17})$/;
const ACCOUNT_RE = /^[A-Za-z0-9._-]{1,80}$/;

function parseOwner(raw, { requireProfile = false } = {}) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return null;
  const match = OWNER_RE.exec(value);
  if (!match) {
    throw new HttpError(
      400,
      `"owner" must be "steam-<steamid64>", got: ${value}.`,
      'invalid_owner'
    );
  }
  if (requireProfile && !gameCache.getProfile(match[1])) {
    throw new HttpError(
      400,
      `"owner": Steam-профиль ${value} ещё не импортирован. Сначала импортируйте Steam-библиотеку.`,
      'unknown_owner'
    );
  }
  return `steam-${match[1]}`;
}

function parseAccountId(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return null;
  if (!ACCOUNT_RE.test(value)) {
    throw new HttpError(
      400,
      `"accountId": некорректный Epic accountId: ${value}.`,
      'epic_invalid_account'
    );
  }
  return value;
}

function parseBool(value, name, fallback = false) {
  if (value == null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new HttpError(400, `Parameter "${name}" must be 0 or 1.`, `invalid_${name}`);
}

function createRouter(deps = {}) {
  const store = deps.tokenStore || tokenStore;
  const importer = deps.importer || epicImport;
  const auth = deps.auth || epicAuth;
  const router = express.Router();

  function resolveAccount({ accountId, owner }, { requireProfile = false } = {}) {
    const parsedOwner = parseOwner(owner, { requireProfile });
    const parsedAccount = parseAccountId(accountId);
    if (parsedAccount) return { accountId: parsedAccount, owner: parsedOwner };
    if (parsedOwner) {
      const bound = epicCache.epicAccountForOwner(parsedOwner);
      if (!bound) {
        throw new HttpError(
          400,
          `У владельца ${parsedOwner} нет подключённого Epic-аккаунта.`,
          'epic_not_connected'
        );
      }
      return { accountId: bound, owner: parsedOwner };
    }
    return { accountId: null, owner: null };
  }

  /* --------------------------- status --------------------------- */

  router.get('/epic/status', async (req, res, next) => {
    try {
      assertOnlyParams(req, ['owner', 'accountId'], 'GET /api/games/epic/status');
      const owner = parseOwner(req.query.owner);
      const accountId = parseAccountId(req.query.accountId);
      if (owner || accountId) {
        const layer = await epicLayer.buildEpicLayer({
          ownerKey: owner,
          accountId,
        });
        return res.status(200).json({
          ...layer,
          // The status endpoint is for the «Подключения» slot: per-game arrays
          // belong to `/exported` and the integration payload.
          games: undefined,
          exportedGames: undefined,
          gameCount: layer.games.length,
        });
      }

      const tokens = await store.listTokenAccounts();
      const tokenDocs = await store.listTokenDocs();
      const profiles = epicCache.listEpicProfiles();
      const accountIds = [...new Set([...tokens.map((t) => t.accountId), ...profiles.map((p) => p.accountId)])];
      const accounts = [];
      for (const id of accountIds) {
        const layer = await epicLayer.buildEpicLayer({ accountId: id });
        accounts.push({
          accountId: id,
          owner: layer.owner,
          displayName: layer.account ? layer.account.displayName : null,
          status: layer.status,
          summary: layer.summary,
          hoursBySource: layer.hoursBySource,
          ownedBySource: layer.ownedBySource,
          libraries: layer.libraries,
          token: layer.account ? layer.account.token : null,
        });
      }
      res.status(200).json({
        source: 'epic',
        contractVersion: epicLayer.CONTRACT_VERSION,
        configured: tokens.length > 0,
        status: tokens.length ? 'connected' : 'not_connected',
        accounts,
        // Never a token value: only presence/expiry.
        tokens: tokenDocs.map((doc) => tokenStore.redactTokens(doc)),
        cacheDir: epicCache.CACHE_DIR,
        libraryTtlHours: Math.round(epicCache.epicLibraryTtlMs() / 3600000),
      });
    } catch (err) {
      next(mapError(err));
    }
  });

  /* ------------------------ device auth ------------------------- */

  /**
   * Login URL for the authorization-code flow. No network call: the client id
   * is public and the page is the official Epic login. The user copies the
   * `code` from the redirect page and posts it to `/epic/connect`.
   */
  router.get('/epic/auth-url', (req, res, next) => {
    try {
      assertOnlyParams(req, [], 'GET /api/games/epic/auth-url');
      const api = deps.client || epic.createClient({ tokenStore: store });
      res.status(200).json({
        source: 'epic',
        url: api.authorizeUrl ? api.authorizeUrl() : epic.authorizeUrl(),
        // Source only: the credentials themselves are never exposed.
        clientSource: epic.clientSource(),
        instructions:
          'Откройте ссылку, войдите в аккаунт Epic и скопируйте значение code ' +
          'со страницы epicgames.com/id/api/redirect (или адрес страницы целиком). ' +
          'Вставьте в поле «code» сам код или всю ссылку: сервер разберёт её сам. ' +
          'Код одноразовый и живёт несколько минут.',
      });
    } catch (err) {
      next(mapError(err));
    }
  });

  router.post('/epic/connect', async (req, res, next) => {
    try {
      assertOnlyParams(req, [], 'POST /api/games/epic/connect');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const code = body.code != null ? body.code : req.query.code;
      if (code == null || String(code).trim() === '') {
        throw new HttpError(
          400,
          'Body must contain "code" — the one-time code from the Epic login redirect ' +
            '(epicgames.com/id/api/redirect?code=…).',
          'epic_code_required'
        );
      }
      const owner = parseOwner(body.owner != null ? body.owner : body.profile, {
        requireProfile: true,
      });
      const label =
        typeof body.label === 'string' && body.label.trim()
          ? body.label.trim().slice(0, 80)
          : null;
      const result = await auth.connectWithCode({
        code: String(code).trim(),
        ownerKey: owner,
        label,
        client: deps.client || undefined,
        tokenStore: store,
        autoImport: deps.autoImport !== false,
      });
      res.status(200).json({ connected: true, source: 'epic', ...result });
    } catch (err) {
      next(mapError(err));
    }
  });

  router.post('/epic/auth', async (req, res, next) => {
    try {
      assertOnlyParams(req, [], 'POST /api/games/epic/auth');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const owner = parseOwner(body.owner != null ? body.owner : body.profile, {
        requireProfile: true,
      });
      const label =
        typeof body.label === 'string' && body.label.trim()
          ? body.label.trim().slice(0, 80)
          : null;
      const session = await auth.startDeviceAuth({
        ownerKey: owner,
        label,
        client: deps.client || undefined,
        tokenStore: store,
        autoPoll: deps.autoPoll !== false,
        autoImport: deps.autoImport !== false,
      });
      res.status(201).json(session);
    } catch (err) {
      next(mapError(err));
    }
  });

  router.get('/epic/auth/:authId', async (req, res, next) => {
    try {
      assertOnlyParams(req, [], 'GET /api/games/epic/auth/:authId');
      let session = auth.getSession(req.params.authId);
      if (!session) {
        throw new HttpError(404, 'Unknown Epic auth session.', 'unknown_auth');
      }
      // The UI polls this endpoint; a pending session is polled here as well
      // as by the background loop (epic-auth rate-limits to `intervalMs`).
      if (session.status === 'pending' && deps.pollOnStatus !== false) {
        session = (await auth.pollSession(req.params.authId)) || session;
      }
      res.status(200).json(session);
    } catch (err) {
      next(mapError(err));
    }
  });

  router.delete('/epic/auth/:authId', (req, res, next) => {
    try {
      assertOnlyParams(req, [], 'DELETE /api/games/epic/auth/:authId');
      const cancelled = auth.cancelSession(req.params.authId);
      if (!cancelled) {
        throw new HttpError(404, 'Unknown Epic auth session.', 'unknown_auth');
      }
      res.status(200).json({ cancelled: true, authId: req.params.authId, source: 'epic' });
    } catch (err) {
      next(mapError(err));
    }
  });

  /* --------------------------- import --------------------------- */

  async function startFromRequest(req, res, forceDefault) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const owner = parseOwner(body.owner != null ? body.owner : body.profile, {
      requireProfile: true,
    });
    const accountId = parseAccountId(body.accountId);
    const force = parseBool(
      body.force != null ? body.force : req.query.force,
      'force',
      forceDefault
    );
    const label =
      typeof body.label === 'string' && body.label.trim()
        ? body.label.trim().slice(0, 80)
        : null;
    const job = await importer.startImport({
      accountId: accountId || undefined,
      ownerKey: owner || undefined,
      force,
      label,
      client: deps.client || undefined,
      tokenStore: store,
      autoCatalog: deps.autoCatalog !== false,
      forceCatalog: Boolean(deps.forceCatalog),
    });
    const created = job.status === 'running' && !job.reused && job.stage === 'queued';
    res.status(created ? 201 : 200).json(job);
  }

  router.post('/epic/import', async (req, res, next) => {
    try {
      assertOnlyParams(req, ['force'], 'POST /api/games/epic/import');
      await startFromRequest(req, res, false);
    } catch (err) {
      next(mapError(err));
    }
  });

  router.post('/epic/refresh', async (req, res, next) => {
    try {
      assertOnlyParams(req, [], 'POST /api/games/epic/refresh');
      await startFromRequest(req, res, true);
    } catch (err) {
      next(mapError(err));
    }
  });

  router.get('/epic/import/status', (req, res, next) => {
    try {
      assertOnlyParams(req, ['id'], 'GET /api/games/epic/import/status');
      const id = req.query.id;
      if (id == null || String(id).trim() === '') {
        throw new HttpError(400, 'Query parameter "id" is required.', 'job_id_required');
      }
      const status = importer.getStatus(String(id).trim());
      if (!status) throw new HttpError(404, 'Unknown Epic import job id.', 'unknown_job');
      res.status(200).json(status);
    } catch (err) {
      next(mapError(err));
    }
  });

  router.get('/epic/import/:jobId', (req, res, next) => {
    try {
      const status = importer.getStatus(req.params.jobId);
      if (!status) throw new HttpError(404, 'Unknown Epic import job id.', 'unknown_job');
      res.status(200).json(status);
    } catch (err) {
      next(mapError(err));
    }
  });

  /* -------------------------- contract -------------------------- */

  /**
   * The isolated contract for the M6c integration: one entry per Epic game,
   * with `workKey`/`steamAppId` deliberately `null` (the union is built by
   * the integration round, not here). `hoursBySource` stays split.
   */
  router.get('/epic/exported', async (req, res, next) => {
    try {
      assertOnlyParams(req, ['owner', 'accountId'], 'GET /api/games/epic/exported');
      const owner = parseOwner(req.query.owner);
      const accountId = parseAccountId(req.query.accountId);
      if (!owner && !accountId) {
        throw new HttpError(
          400,
          'Query parameter "owner" (steam-<steamid64>) or "accountId" is required.',
          'owner_required'
        );
      }
      const layer = await epicLayer.buildEpicLayer({ ownerKey: owner, accountId });
      res.status(200).json({
        source: 'epic',
        contractVersion: layer.contractVersion,
        owner: layer.owner,
        accountId: layer.accountId,
        status: layer.status,
        hoursBySource: layer.hoursBySource,
        ownedBySource: layer.ownedBySource,
        summary: layer.summary,
        games: layer.exportedGames,
        meta: layer.meta,
      });
    } catch (err) {
      next(mapError(err));
    }
  });

  /* ------------------------- disconnect ------------------------- */

  router.post('/epic/disconnect', async (req, res, next) => {
    try {
      assertOnlyParams(req, [], 'POST /api/games/epic/disconnect');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const resolved = resolveAccount(
        { accountId: body.accountId, owner: body.owner != null ? body.owner : body.profile },
        { requireProfile: false }
      );
      if (!resolved.accountId) {
        throw new HttpError(
          400,
          'Body must contain "accountId" or "owner" (steam-<steamid64>).',
          'epic_account_required'
        );
      }
      const doc = await store.getTokens(resolved.accountId);
      let remoteRevoked = false;
      if (doc && doc.accessToken) {
        const client = deps.client || epic.createClient({ tokenStore: store });
        remoteRevoked = await client.killSession(doc.accessToken);
      }
      const deleted = await store.deleteTokens(resolved.accountId);
      await epicCache.markEpicDisconnected(resolved.accountId);
      const library = epicCache.getEpicLibrary(resolved.accountId);
      res.status(200).json({
        source: 'epic',
        disconnected: deleted,
        accountId: resolved.accountId,
        owner: resolved.owner || null,
        remoteRevoked,
        // The snapshot is data, not a secret: keep it so the UI can say
        // "данные от <fetchedAt>, требуется переподключение" (§14.4 rule 7).
        snapshotKept: Boolean(library),
        snapshotFetchedAt: library ? library.fetchedAt || null : null,
        status: 'not_connected',
      });
    } catch (err) {
      next(mapError(err));
    }
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
