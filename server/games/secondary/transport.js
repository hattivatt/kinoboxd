'use strict';

const { URL } = require('url');

const { nodeRequest } = require('../../core/http');
const sources = require('../../core/sources');
const { SecondaryDetailsError, maskSecrets } = require('./errors');

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function timeoutMs() {
  return sources.timeoutMs('secondary');
}

function httpGetJson(target, options = {}) {
  const timeout = options.timeoutMs == null ? timeoutMs() : Number(options.timeoutMs);
  const userAgent = options.userAgent || sources.userAgent('secondary');
  let host = null;
  try {
    host = new URL(target).host;
  } catch (err) {
    host = null;
  }
  return nodeRequest(target, {
    timeoutMs: timeout,
    followRedirect: false,
    maxBytes: MAX_BODY_BYTES,
    headers: {
      'User-Agent': userAgent,
      Accept: 'application/json, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    label: 'secondary-details',
  }).catch((err) => {
    if (err && err.code === 'invalid_url') {
      throw new SecondaryDetailsError('Некорректный URL метадаты.', 'secondary_details_invalid_url');
    }
    const cause = (err && err.cause && err.cause.code) || (err && err.code) || 'error';
    throw new SecondaryDetailsError(
      `Сеть: ${maskSecrets(cause)}`,
      'secondary_details_unreachable',
      { host, deferred: true }
    );
  });
}

function parseJson(body, status) {
  try {
    return JSON.parse(String(body == null ? '' : body));
  } catch (err) {
    throw new SecondaryDetailsError(
      `Ответ ${status} не JSON.`,
      'secondary_details_unparsed',
      { status }
    );
  }
}

async function fetchJson(client, url, options = {}) {
  if (client && typeof client.getJson === 'function') return client.getJson(url);
  if (typeof client === 'function') return client(url);
  const response = await httpGetJson(url, { userAgent: options.userAgent });
  const meta = {
    url,
    host: (() => {
      try {
        return new URL(url).host;
      } catch (err) {
        return null;
      }
    })(),
    body: response.body,
    contentType: response.headers && response.headers['content-type'],
    bodyBytes: Buffer.byteLength(String(response.body == null ? '' : response.body), 'utf8'),
  };
  if (response.status === 404) {
    throw new SecondaryDetailsError('Продукт не найден.', 'secondary_details_not_found', {
      ...meta,
      status: 404,
      reason: 'not_found',
    });
  }
  if (response.status === 403 || response.status === 429) {
    throw new SecondaryDetailsError(
      `Источник ограничил запросы (${response.status}).`,
      'secondary_details_blocked',
      { ...meta, status: response.status, deferred: true, reason: 'blocked' }
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new SecondaryDetailsError(
      `Источник ответил ${response.status}.`,
      'secondary_details_http_error',
      {
        ...meta,
        status: response.status,
        deferred: response.status >= 500,
        reason: 'http_error',
      }
    );
  }
  try {
    return parseJson(response.body, response.status);
  } catch (err) {
    if (err && typeof err === 'object') {
      Object.assign(err, meta);
      err.reason = err.reason || 'unparsed';
    }
    throw err;
  }
}

module.exports = {
  MAX_BODY_BYTES,
  timeoutMs,
  httpGetJson,
  parseJson,
  fetchJson,
};
