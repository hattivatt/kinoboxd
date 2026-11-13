'use strict';

const steam = require('./steam');
const gameCache = require('./game-cache');
const { createSourceGate } = require('../core/source-client');
const sources = require('../core/sources');

const SPY_HOST = 'steamspy.com';
const SPY_ENDPOINT = `https://${SPY_HOST}/api.php`;
const DEFAULT_PAUSE_MS = sources.pauseMs('steamSpy');
const DEFAULT_BREAKER_MS = sources.breakerMs('steamSpy');
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TAGS = 50;

class SpyError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'SpyError';
    this.code = code || 'spy_error';
    if (details.status != null) this.status = details.status;
    if (details.retryAt != null) this.retryAt = details.retryAt;
    if (details.host != null) this.host = details.host;
  }
}

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spyTtlMs() {
  return gameCache.spyTtlMs();
}

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function parseTags(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const out = [];
  for (const [name, weight] of Object.entries(value)) {
    const label = String(name == null ? '' : name).trim();
    const numeric = Number(weight);
    if (!label || !Number.isFinite(numeric) || numeric <= 0) continue;
    out.push({ name: label, weight: Math.round(numeric) });
  }
  out.sort((left, right) => right.weight - left.weight || left.name.localeCompare(right.name));
  return out.slice(0, MAX_TAGS);
}

function parseSpyDetails(data, appid) {
  const source = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const tags = parseTags(source.tags);
  const name = source.name == null ? null : String(source.name).trim() || null;
  const positive = nonNegativeInt(source.positive);
  const negative = nonNegativeInt(source.negative);
  const hasData = Boolean(name) || tags.length > 0 || (positive != null && positive > 0);
  if (!hasData) {
    return {
      appid: Number(appid),
      success: false,
      unavailable: true,
      reason: 'no_data',
      name: null,
      tags: [],
      metadataSource: 'steamspy',
    };
  }
  return {
    appid: Number(appid),
    success: true,
    unavailable: false,
    name,
    developer: source.developer == null ? null : String(source.developer) || null,
    publisher: source.publisher == null ? null : String(source.publisher) || null,
    positive,
    negative,
    owners: source.owners == null ? null : String(source.owners) || null,
    ccu: nonNegativeInt(source.ccu),
    averageForever: nonNegativeInt(source.average_forever),
    genre: source.genre == null ? null : String(source.genre) || null,
    tags,
    metadataSource: 'steamspy',
  };
}

function spyFresh(doc, ttlMs) {
  if (!doc || typeof doc !== 'object') return false;
  const ts = Date.parse(String(doc.fetchedAt || ''));
  if (!Number.isFinite(ts)) return false;
  const age = Date.now() - ts;
  return age >= 0 && age < (ttlMs == null ? spyTtlMs() : ttlMs);
}

function spyUrl(appid) {
  return `${SPY_ENDPOINT}?request=appdetails&appid=${encodeURIComponent(String(appid))}`;
}

function createClient(options = {}) {
  const request = options.request || steam.httpGet;
  const sleep = options.sleep || sleepDefault;
  const now = options.now || (() => Date.now());
  const pauseMs =
    options.pauseMs != null ? options.pauseMs : sources.pauseMs('steamSpy');
  const breakerMs =
    options.breakerMs != null ? options.breakerMs : sources.breakerMs('steamSpy');

  const gate = createSourceGate({
    now,
    sleep,
    pauseMs,
    breakerMs,
    breakerStore: {
      read: () => gameCache.readBreaker(),
      write: (state) => gameCache.writeBreaker(state),
    },
    createError(host, entry) {
      return new SpyError(
        `SteamSpy (${host}) временно не опрашивается: предыдущий ответ ${entry.reason}. ` +
          `Повтор через ${Math.max(1, Math.ceil((entry.until - now()) / 60000))} мин.`,
        'spy_rate_limited',
        { host, retryAt: new Date(entry.until).toISOString() }
      );
    },
    mapTransportError(err) {
      if (err instanceof SpyError) return err;
      const host = SPY_HOST;
      if (err && err.code === 'steam_unreachable') {
        return new SpyError(err.message, 'spy_unreachable', { host });
      }
      return new SpyError(
        `SteamSpy недоступен (${host}, ${(err && err.code) || 'ENETWORK'}). ` +
          'Это сеть/DNS/TLS, не повод считать игру «без тегов» — повторите позже.',
        'spy_unreachable',
        { host }
      );
    },
  });

  function breakerEntry() {
    return gate.breakerFor(SPY_HOST);
  }

  function tripBreaker(reason) {
    return gate.tripBreaker(SPY_HOST, reason);
  }

  function assertNotBlocked() {
    return gate.assertNotBlocked(SPY_HOST);
  }

  async function getAppTags(rawAppid) {
    const appid = Number(rawAppid);
    if (!Number.isInteger(appid) || appid <= 0) {
      throw new SpyError(`Некорректный appid: ${rawAppid}`, 'spy_invalid_appid');
    }
    const response = await gate.request(
      SPY_HOST,
      () =>
        request(spyUrl(appid), {
          timeoutMs: envInt('GAMES_SPY_TIMEOUT_MS', 20000),
        })
    );
    const status = Number(response && response.status) || 0;
    if (status === 403 || status === 429) {
      tripBreaker(status === 429 ? '429 Too Many Requests' : 'HTTP 403');
      throw new SpyError(
        `SteamSpy ответил ${status}: запросы к appdetails приостановлены на ` +
          `${Math.round(breakerMs / 60000)} мин (breaker).`,
        'spy_rate_limited',
        { host: SPY_HOST, status, retryAt: new Date(now() + breakerMs).toISOString() }
      );
    }
    if (status < 200 || status >= 300) {
      throw new SpyError(
        `SteamSpy ответил ${status} для appid ${appid} — ответ не закэширован (deferred).`,
        'spy_http_error',
        { host: SPY_HOST, status }
      );
    }
    let json;
    try {
      json = JSON.parse(String((response && response.body) || ''));
    } catch (err) {
      throw new SpyError(
        `SteamSpy вернул не JSON для appid ${appid} — ответ не закэширован (deferred).`,
        'spy_http_error',
        { host: SPY_HOST, status }
      );
    }
    return parseSpyDetails(json, appid);
  }

  return {
    options: { pauseMs, breakerMs },
    getAppTags,
    assertNotBlocked,
    tripBreaker,
    breakerEntry,
    spyTtlMs,
  };
}

module.exports = {
  SpyError,
  SPY_HOST,
  SPY_ENDPOINT,
  DEFAULT_PAUSE_MS,
  DEFAULT_BREAKER_MS,
  DEFAULT_TTL_MS,
  MAX_TAGS,
  createClient,
  spyUrl,
  parseTags,
  parseSpyDetails,
  spyFresh,
  spyTtlMs,
};
