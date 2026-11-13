'use strict';

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const gogCache = require('../gog-cache');
const { nodeRequest } = require('../../core/http');
const { createSourceGate } = require('../../core/source-client');
const {
  GogError,
  maskSecrets,
  envInt,
  PUBLIC_CLIENT_ID,
  PUBLIC_CLIENT_SECRET,
  DEFAULT_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
} = require('./gog-core');

const CLIENT_FILE_ENV = 'KINOBOXD_GOG_CLIENT_FILE';
const CLIENT_FILE_PATH = path.join(__dirname, '..', '..', '..', 'config', 'gog-client.json');

let credentialsCache = null;

function clientFilePath() {
  const override = process.env[CLIENT_FILE_ENV];
  if (typeof override === 'string' && override.trim()) return path.resolve(override.trim());
  return CLIENT_FILE_PATH;
}

function readClientFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const clientId = parsed && (parsed.clientId || parsed.client_id);
    const clientSecret = parsed && (parsed.clientSecret || parsed.client_secret);
    if (clientId && clientSecret) {
      return { clientId: String(clientId), clientSecret: String(clientSecret), source: 'file' };
    }
    return null;
  } catch (err) {
    return null;
  }
}

function loadCredentials() {
  if (credentialsCache) return credentialsCache;
  const envId = process.env.GOG_CLIENT_ID;
  const envSecret = process.env.GOG_CLIENT_SECRET;
  if (envId && envSecret) {
    credentialsCache = {
      clientId: String(envId).trim(),
      clientSecret: String(envSecret).trim(),
      source: 'env',
    };
    return credentialsCache;
  }
  const fromFile = readClientFile(clientFilePath());
  if (fromFile) {
    credentialsCache = fromFile;
    return credentialsCache;
  }
  credentialsCache = {
    clientId: PUBLIC_CLIENT_ID,
    clientSecret: PUBLIC_CLIENT_SECRET,
    source: 'default',
  };
  return credentialsCache;
}

function clientSource() {
  return loadCredentials().source;
}

function resetCredentialsCache() {
  credentialsCache = null;
}

function networkError(err, target) {
  if (err instanceof GogError) return err;
  let host = '';
  try {
    host = new URL(target).host;
  } catch (e) {
    host = '';
  }
  return new GogError(
    `GOG недоступен (${host || 'network'}): ${maskSecrets((err && (err.code || err.message)) || 'network error')}. ` +
      'Это сетевая ошибка, данные не кэшируются как «пустая библиотека».',
    'gog_unreachable',
    { host }
  );
}

function httpGet(target, options = {}) {
  const timeoutMs = options.timeoutMs || envInt('GAMES_GOG_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const redirectsLeft = options.redirectsLeft == null ? MAX_REDIRECTS : options.redirectsLeft;
  const followRedirect = options.followRedirect !== false;
  return nodeRequest(target, {
    timeoutMs,
    maxRedirects: followRedirect ? redirectsLeft : 0,
    followRedirect,
    maxBytes: MAX_BODY_BYTES,
    headers: {
      'User-Agent': 'kinoboxd/1.0 (+games-tab; gog)',
      Accept: 'application/json, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(options.headers || {}),
    },
    label: 'gog',
  }).catch((err) => {
    if (err && err.code === 'invalid_url') {
      throw new GogError(`Некорректный URL: ${maskSecrets(target)}`, 'gog_invalid_url');
    }
    if (err && err.code === 'too_many_redirects') {
      throw new GogError(`Слишком много редиректов: ${maskSecrets(target)}`, 'gog_http_error', {
        status: err.status,
      });
    }
    throw networkError(err, target);
  });
}

function parseJsonBody(response, url) {
  try {
    return JSON.parse(response.body);
  } catch (err) {
    throw new GogError(
      `GOG ответил ${response.status} не-JSON: ${maskSecrets(url)}`,
      'gog_http_error',
      { status: response.status }
    );
  }
}

function createRequestPipeline(context) {
  const {
    request,
    sleep,
    now,
    libraryPauseMs,
    playtimePauseMs,
    breakerMs,
    breakerStore,
  } = context;

  let lastLibraryAt = null;
  let lastPlaytimeAt = null;
  const gate = createSourceGate({
    now,
    breakerMs: () => breakerMs,
    breakerStore,
    createError: (host, entry) =>
      new GogError(
        `GOG (${host}) временно не опрашивается: предыдущий ответ ${entry.reason}. ` +
          `Повтор через ${Math.max(1, Math.ceil((entry.until - now()) / 60000))} мин.`,
        'gog_rate_limited',
        { host, retryAt: new Date(entry.until).toISOString() }
      ),
  });

  function breakerFor(host) {
    return gate.breakerFor(host);
  }

  function tripBreaker(host, reason) {
    return gate.tripBreaker(host, reason);
  }

  function assertNotBlocked(host) {
    return gate.assertNotBlocked(host);
  }

  async function pause(kind) {
    if (kind === 'library') {
      if (libraryPauseMs > 0 && lastLibraryAt != null) {
        await sleep(libraryPauseMs);
      }
      lastLibraryAt = now();
      return;
    }
    if (playtimePauseMs > 0 && lastPlaytimeAt != null) await sleep(playtimePauseMs);
    lastPlaytimeAt = now();
  }

  function bearer(tokenDoc) {
    if (!tokenDoc || !tokenDoc.accessToken) {
      throw new GogError(
        'GOG не подключён: нет токена. Нажмите «Войти через GOG».',
        'gog_auth_required'
      );
    }
    return { Authorization: `Bearer ${tokenDoc.accessToken}` };
  }

  async function authenticatedGet(url, tokenDoc, { host, kind }) {
    assertNotBlocked(host);
    await pause(kind);
    const response = await request(url, {
      headers: bearer(tokenDoc),
      followRedirect: false,
    });
    const status = response.status;
    if (status >= 300 && status < 400) {
      throw new GogError(
        `GOG (${host}) требует повторного входа (${status} → логин). Токен истёк или отозван.`,
        'gog_auth_expired',
        { host, status }
      );
    }
    if (status === 401 || status === 403) {
      if (status === 403) tripBreaker(host, '403');
      throw new GogError(
        status === 401
          ? 'GOG отклонил токен (401): требуется повторный вход.'
          : 'GOG ответил 403: автоматизация временно заблокирована (breaker 30 мин).',
        status === 401 ? 'gog_auth_expired' : 'gog_rate_limited',
        { host, status, retryAt: status === 403 ? new Date(now() + breakerMs).toISOString() : undefined }
      );
    }
    if (status === 429) {
      tripBreaker(host, '429');
      throw new GogError(
        'GOG ответил 429: запросы приостановлены на 30 минут (breaker).',
        'gog_rate_limited',
        { host, status, retryAt: new Date(now() + breakerMs).toISOString() }
      );
    }
    if (status < 200 || status >= 300) {
      throw new GogError(
        `GOG (${host}) ответил ${status}: ${maskSecrets(url)}`,
        'gog_http_error',
        { host, status }
      );
    }
    return response;
  }

  return {
    pause,
    bearer,
    authenticatedGet,
    assertNotBlocked,
    tripBreaker,
    breakerFor,
  };
}

module.exports = {
  CLIENT_FILE_ENV,
  CLIENT_FILE_PATH,
  clientFilePath,
  readClientFile,
  loadCredentials,
  clientSource,
  resetCredentialsCache,
  networkError,
  httpGet,
  parseJsonBody,
  createRequestPipeline,
};
