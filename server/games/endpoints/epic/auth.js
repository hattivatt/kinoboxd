'use strict';

const { HttpError } = require('../../../upload');
const epic = require('../../epic');
const { assertOnlyParams, parseOwner } = require('./params');

function register(router, ctx) {
  const { deps, store, auth, mapError } = ctx;

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
}

module.exports = { register };
