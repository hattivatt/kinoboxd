'use strict';

const {
  EpicError,
  extractAuthCode,
  formEncode,
  numOrNull,
  parseJsonBody,
  unique,
  maskSecrets,
  normalizeDeviceAuthorization,
  normalizeTokenResponse,
  normalizePlaytimeResponse,
  normalizeCatalogItem,
  normalizeProductMapping,
  MAX_LIBRARY_PAGES,
  MAX_ENTITLEMENT_PAGES,
  ACCESS_REFRESH_SKEW_MS,
  CATALOG_CHUNK,
} = require('./epic-core');

function createTokenGrants(context) {
  const { requestRaw, requestAccountJson, classify, now, creds, accountHosts } = context;

  let clientToken = null;

  async function getClientToken(force = false) {
    if (!force && clientToken && clientToken.expiresAt > now() + 30000) {
      return clientToken.token;
    }
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`, 'utf8').toString('base64');
    let json;
    try {
      json = await requestAccountJson('/account/api/oauth/token', {
        method: 'POST',
        basic,
        contentType: 'application/x-www-form-urlencoded',
        body: formEncode({ grant_type: 'client_credentials' }),
      });
    } catch (err) {
      if (err && err.code === 'epic_auth_expired') {
        throw new EpicError(
          'Epic отклонил client credentials лаунчера (значения не печатаются). ' +
            'Проверьте EPIC_CLIENT_ID/EPIC_CLIENT_SECRET.',
          'epic_client_invalid'
        );
      }
      throw err;
    }
    const token = json.access_token || json.accessToken || null;
    if (!token) {
      throw new EpicError(
        'Epic не выдал client token (проверьте client credentials; значения не печатаются).',
        'epic_auth_failed'
      );
    }
    const expiresIn = numOrNull(json.expires_in != null ? json.expires_in : json.expiresIn);
    clientToken = {
      token: String(token),
      expiresAt: now() + (expiresIn && expiresIn > 0 ? expiresIn * 1000 : 3600000),
    };
    return clientToken.token;
  }

  async function deviceAuthorization() {
    const requestDevice = async (clientToken) => {
      const host = accountHosts[0];
      const url = `https://${host}/account/api/oauth/deviceAuthorization`;
      const response = await requestRaw({
        method: 'POST',
        url,
        host,
        token: clientToken,
        contentType: 'application/x-www-form-urlencoded',
        body: '',
      });
      const json = parseJsonBody(response.body) || {};
      if (response.status >= 200 && response.status < 300) {
        return normalizeDeviceAuthorization(json);
      }
      const errorText = `${json.errorCode || ''} ${json.error || ''}`.toLowerCase();
      if (
        response.status === 400 &&
        (json.numericErrorCode === 1016 || errorText.includes('unsupported_grant_type'))
      ) {
        throw new EpicError(
          'Epic закрыл вход по device-code для публичных клиентов лаунчера ' +
            '(400 unsupported_grant_type, 1016): этот grant доступен только клиентам консолей. ' +
            'Используйте вход по authorization code: «Войти через Epic» → ссылка → вставьте code.',
          'epic_device_grant_unavailable',
          { status: 400, host }
        );
      }
      throw classify(response.status, url, host);
    };
    let client = await getClientToken();
    try {
      return await requestDevice(client);
    } catch (err) {
      if (!err || err.code !== 'epic_auth_expired') throw err;
      client = await getClientToken(true);
      return requestDevice(client);
    }
  }

  async function exchangeAuthorizationCode(codeOrUrl) {
    const code = extractAuthCode(codeOrUrl);
    if (!code) {
      throw new EpicError(
        'Не найден authorization code: вставьте code из адресной строки epicgames.com/id/api/redirect ' +
          'или всю ссылку целиком — сервер выделит code сам.',
        'epic_code_required',
        { status: 400 }
      );
    }
    const host = accountHosts[0];
    const url = `https://${host}/account/api/oauth/token`;
    const response = await requestRaw({
      method: 'POST',
      url,
      host,
      basic: Buffer.from(`${creds.clientId}:${creds.clientSecret}`, 'utf8').toString('base64'),
      contentType: 'application/x-www-form-urlencoded',
      body: formEncode({
        grant_type: 'authorization_code',
        code,
        token_type: 'eg1',
      }),
    });
    const json = parseJsonBody(response.body) || {};
    if (response.status >= 200 && response.status < 300) {
      return normalizeTokenResponse(json, now());
    }
    const errorText = `${json.errorCode || ''} ${json.error || ''}`.toLowerCase();
    if (
      response.status === 401 ||
      (response.status === 400 &&
        (json.numericErrorCode === 1011 || errorText.includes('invalid_client')))
    ) {
      throw new EpicError(
        'Epic отклонил client credentials лаунчера при обмене code (значения не печатаются). ' +
          'Проверьте EPIC_CLIENT_ID/EPIC_CLIENT_SECRET или config/epic-client.json.',
        'epic_client_invalid',
        { status: 502 }
      );
    }
    if (response.status === 403 || response.status === 429) {
      throw classify(response.status, url, host);
    }
    const detail = maskSecrets(
      String(json.errorMessage || json.error_description || json.errorCode || '')
    ).slice(0, 200);
    throw new EpicError(
      `Epic не принял code входа (${response.status})${detail ? `: ${detail}` : ''}. ` +
        'Code одноразовый и живёт несколько минут — откройте ссылку входа заново и скопируйте новый.',
      'epic_invalid_code',
      { status: 400 }
    );
  }

  async function exchangeDeviceCode(deviceCode) {
    const client = await getClientToken();
    const response = await requestRaw({
      method: 'POST',
      url: `https://${accountHosts[0]}/account/api/oauth/token`,
      host: accountHosts[0],
      basic: Buffer.from(`${creds.clientId}:${creds.clientSecret}`, 'utf8').toString('base64'),
      contentType: 'application/x-www-form-urlencoded',
      body: formEncode({
        grant_type: 'device_code',
        device_code: deviceCode,
        token_type: 'eg1',
      }),
    });
    const json = parseJsonBody(response.body) || {};
    if (response.status === 200) {
      return { status: 'authorized', tokens: normalizeTokenResponse(json, now()) };
    }
    if (response.status === 403 || response.status === 429) {
      throw new EpicError(
        `Epic (${accountHosts[0]}) ответил ${response.status} на опрос device-code: ` +
          'запросы приостановлены на 30 минут (breaker).',
        'epic_rate_limited',
        { status: response.status, host: accountHosts[0] }
      );
    }
    const errorText = `${json.errorCode || ''} ${json.error || ''} ${json.errorMessage || ''}`.toLowerCase();
    if (errorText.includes('authorization_pending') || errorText.includes('pending')) {
      return { status: 'pending' };
    }
    if (errorText.includes('slow_down') || errorText.includes('slowdown')) {
      const interval = numOrNull(json.interval);
      return {
        status: 'slow_down',
        intervalMs: interval && interval > 0 ? Math.round(interval * 1000) : 10000,
      };
    }
    if (errorText.includes('expired')) {
      return {
        status: 'expired',
        code: 'epic_auth_expired',
        error: 'Код Epic истёк — начните подключение заново.',
      };
    }
    return {
      status: 'failed',
      code: 'epic_auth_failed',
      error: maskSecrets(
        json.errorMessage || json.errorCode || `Epic ответил ${response.status}`
      ),
    };
  }

  async function refreshTokens(refreshToken) {
    const client = await getClientToken();
    let response;
    try {
      response = await requestRaw({
        method: 'POST',
        url: `https://${accountHosts[0]}/account/api/oauth/token`,
        host: accountHosts[0],
        basic: Buffer.from(`${creds.clientId}:${creds.clientSecret}`, 'utf8').toString('base64'),
        contentType: 'application/x-www-form-urlencoded',
        body: formEncode({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          token_type: 'eg1',
        }),
      });
    } catch (err) {
      if (err && err.deferred) throw err;
      throw new EpicError(
        'Не удалось обновить Epic-токен: сеть недоступна, повторите позже.',
        'epic_unreachable',
        { deferred: true }
      );
    }
    if (response.status !== 200) {
      throw new EpicError(
        'Epic-токен больше не действует (refresh отклонён): требуется переподключение.',
        'epic_auth_expired',
        { status: response.status }
      );
    }
    const json = parseJsonBody(response.body);
    if (!json) {
      throw new EpicError('Epic вернул не JSON при refresh.', 'epic_http_error');
    }
    return normalizeTokenResponse(json, now());
  }

  return {
    getClientToken,
    deviceAuthorization,
    exchangeAuthorizationCode,
    exchangeDeviceCode,
    refreshTokens,
  };
}

function createTokenAccess(context, grants) {
  const { now, tokenStore } = context;
  const { refreshTokens } = grants;

  async function markAuthExpired(accountId) {
    if (!tokenStore || typeof tokenStore.getTokens !== 'function') return;
    try {
      const doc = await tokenStore.getTokens(accountId);
      if (!doc) return;
      await tokenStore.saveTokens({
        ...doc,
        lastAuthError: 'auth_expired',
        lastAuthErrorAt: new Date().toISOString(),
      });
    } catch (_) {
    }
  }

  async function readWithAuth(accountId, task) {
    try {
      return await task();
    } catch (err) {
      if (err && err.code === 'epic_auth_expired') await markAuthExpired(accountId);
      throw err;
    }
  }

  async function getAccessToken(accountId) {
    if (!tokenStore || typeof tokenStore.getTokens !== 'function') {
      throw new EpicError(
        'Epic token store не подключён — доступ к библиотеке невозможен.',
        'epic_not_connected'
      );
    }
    const doc = await tokenStore.getTokens(accountId);
    if (!doc || !doc.accessToken) {
      throw new EpicError(
        'Epic-аккаунт не подключён: сначала выполните «Войти через Epic» (device-code).',
        'epic_not_connected'
      );
    }
    const expiresAt = Date.parse(String(doc.accessExpiresAt || ''));
    const needsRefresh = !Number.isFinite(expiresAt) || expiresAt - now() < ACCESS_REFRESH_SKEW_MS;
    if (!needsRefresh) return doc.accessToken;
    if (!doc.refreshToken) {
      await markAuthExpired(accountId);
      throw new EpicError(
        'Epic access token истёк, refresh token отсутствует: требуется переподключение.',
        'epic_auth_expired'
      );
    }
    try {
      const fresh = await refreshTokens(doc.refreshToken);
      const merged = {
        ...doc,
        ...fresh,
        refreshToken: fresh.refreshToken || doc.refreshToken,
        deviceAuth: doc.deviceAuth || null,
        ownerKey: doc.ownerKey || null,
        displayName: fresh.displayName || doc.displayName,
        lastAuthError: null,
        lastAuthErrorAt: null,
      };
      if (typeof tokenStore.saveTokens === 'function') await tokenStore.saveTokens(merged);
      return merged.accessToken;
    } catch (err) {
      if (err && err.code === 'epic_auth_expired') await markAuthExpired(accountId);
      throw err;
    }
  }

  return {
    getAccessToken,
    markAuthExpired,
    readWithAuth,
  };
}

function createReadEndpoints(context, access) {
  const {
    requestRaw,
    requestJson,
    requestAccountJson,
    classify,
    accountHosts,
    libraryHost,
    catalogHost,
    entitlementHost,
    storeContentHost,
    country,
    locale,
  } = context;
  const { getAccessToken, readWithAuth, markAuthExpired } = access;

  async function getAccount(accountId) {
    const token = await getAccessToken(accountId);
    try {
      const json = await requestAccountJson(
        `/account/api/public/account/${encodeURIComponent(accountId)}`,
        { token }
      );
      return {
        accountId: json.id ? String(json.id) : String(accountId),
        displayName: json.displayName || json.display_name || null,
        country: json.country || null,
        preferredLanguage: json.preferredLanguage || null,
      };
    } catch (err) {
      if (err && err.code === 'epic_auth_expired') await markAuthExpired(accountId);
      throw err;
    }
  }

  async function getEntitlements(accountId, opts = {}) {
    return readWithAuth(accountId, async () => {
      const token = await getAccessToken(accountId);
      const pageSize = Math.max(1, Math.min(1000, Number(opts.pageSize) || 1000));
      const maxPages = Math.max(1, Number(opts.maxPages) || MAX_ENTITLEMENT_PAGES);
      const all = [];
      let start = 0;
      let pages = 0;
      for (let page = 0; page < maxPages; page++) {
        const json = await requestJson({
          url:
            `https://${entitlementHost}/entitlement/api/account/` +
            `${encodeURIComponent(accountId)}` +
            `/entitlements?start=${start}&count=${pageSize}&includeMetadata=true`,
          host: entitlementHost,
          token,
        });
        const list = Array.isArray(json.entitlements)
          ? json.entitlements
          : Array.isArray(json.records)
            ? json.records
            : Array.isArray(json.items)
              ? json.items
              : [];
        pages++;
        all.push(...list);
        if (list.length < pageSize) break;
        start += pageSize;
      }
      return { entitlements: all, pages };
    });
  }

  async function getLibraryItems(accountId, opts = {}) {
    return readWithAuth(accountId, async () => {
      const token = await getAccessToken(accountId);
      const maxPages = Math.max(1, Number(opts.maxPages) || MAX_LIBRARY_PAGES);
      const records = [];
      let cursor = opts.cursor || null;
      let pages = 0;
      let truncated = false;
      for (let page = 0; page < maxPages; page++) {
        const query = new URLSearchParams({ includeMetadata: 'true' });
        if (cursor) query.set('cursor', cursor);
        const json = await requestJson({
          url: `https://${libraryHost}/library/api/public/items?${query.toString()}`,
          host: libraryHost,
          token,
        });
        const list = Array.isArray(json.records)
          ? json.records
          : Array.isArray(json.items)
            ? json.items
            : [];
        pages++;
        records.push(...list);
        cursor =
          (json.responseMetadata && json.responseMetadata.nextCursor) ||
          json.nextCursor ||
          null;
        if (!cursor) break;
        if (page === maxPages - 1) truncated = true;
      }
      return { records, pages, truncated, nextCursor: cursor || null };
    });
  }

  async function getPlaytime(accountId) {
    return readWithAuth(accountId, async () => {
      const token = await getAccessToken(accountId);
      const json = await requestJson({
        url:
          `https://${libraryHost}/library/api/public/playtime/account/` +
          `${encodeURIComponent(accountId)}/all`,
        host: libraryHost,
        token,
      });
      return normalizePlaytimeResponse(json);
    });
  }

  async function getCatalogBulk(namespace, catalogItemIds, opts = {}) {
    return readWithAuth(opts.accountId, async () => {
      const ids = unique((Array.isArray(catalogItemIds) ? catalogItemIds : []).map(String));
      if (!ids.length) return { items: {}, requests: 0, failures: [], chunks: [] };
      const token = await getAccessToken(opts.accountId);
      const chunkSize = Math.max(1, Math.min(50, Number(opts.chunkSize) || CATALOG_CHUNK));
      const items = {};
      const failures = [];
      const chunks = [];
      let requests = 0;
      for (let index = 0; index < ids.length; index += chunkSize) {
        const chunk = ids.slice(index, index + chunkSize);
        const query = new URLSearchParams({
          includeDLCDetails: 'true',
          includeMainGameDetails: 'true',
          country,
          locale,
        });
        for (const id of chunk) query.append('id', id);
        const url =
          `https://${catalogHost}/catalog/api/shared/namespace/` +
          `${encodeURIComponent(namespace || 'fn')}/bulk/items?${query.toString()}`;
        let bytes = null;
        try {
          const response = await requestRaw({ url, host: catalogHost, token });
          requests++;
          bytes = Buffer.byteLength(String(response.body || ''), 'utf8');
          if (response.status < 200 || response.status >= 300) {
            throw classify(response.status, url, catalogHost);
          }
          const json = parseJsonBody(response.body);
          if (json == null) {
            throw new EpicError(
              `Epic (${catalogHost}) вернул не JSON: ${maskSecrets(url)}`,
              'epic_http_error',
              { status: response.status, host: catalogHost }
            );
          }
          chunks.push({ ids: chunk, status: response.status, bytes });
          const source = json && typeof json === 'object' && json.items ? json.items : json;
          for (const id of chunk) {
            const raw = source && typeof source === 'object' ? source[id] : null;
            if (raw && typeof raw === 'object') {
              items[id] = normalizeCatalogItem(raw, id);
            }
          }
        } catch (err) {
          requests++;
          failures.push({
            namespace: namespace || null,
            ids: chunk,
            code: (err && err.code) || 'epic_http_error',
            status: err && err.status != null ? err.status : null,
            bytes,
          });
          if (err && (err.code === 'epic_auth_expired' || err.code === 'epic_rate_limited')) {
            throw err;
          }
        }
      }
      return { items, requests, failures, chunks };
    });
  }

  async function getProductMapping() {
    const json = await requestJson({
      url: `https://${storeContentHost}/api/content/productmapping`,
      host: storeContentHost,
    });
    return normalizeProductMapping(json);
  }

  async function killSession(accessToken) {
    if (!accessToken) return false;
    try {
      const response = await requestRaw({
        method: 'DELETE',
        url:
          `https://${accountHosts[0]}/account/api/oauth/sessions/kill/` +
          encodeURIComponent(accessToken),
        host: accountHosts[0],
        token: accessToken,
      });
      return response.status >= 200 && response.status < 300;
    } catch (err) {
      return false;
    }
  }

  return {
    getAccount,
    getEntitlements,
    getLibraryItems,
    getPlaytime,
    getCatalogBulk,
    getProductMapping,
    killSession,
  };
}

function createClientApi(context) {
  const grants = createTokenGrants(context);
  const access = createTokenAccess(context, grants);
  const endpoints = createReadEndpoints(context, access);
  return {
    getClientToken: grants.getClientToken,
    deviceAuthorization: grants.deviceAuthorization,
    exchangeAuthorizationCode: grants.exchangeAuthorizationCode,
    exchangeDeviceCode: grants.exchangeDeviceCode,
    refreshTokens: grants.refreshTokens,
    getAccessToken: access.getAccessToken,
    getAccount: endpoints.getAccount,
    getEntitlements: endpoints.getEntitlements,
    getLibraryItems: endpoints.getLibraryItems,
    getPlaytime: endpoints.getPlaytime,
    getCatalogBulk: endpoints.getCatalogBulk,
    getProductMapping: endpoints.getProductMapping,
    killSession: endpoints.killSession,
  };
}

module.exports = {
  createTokenGrants,
  createTokenAccess,
  createReadEndpoints,
  createClientApi,
};
