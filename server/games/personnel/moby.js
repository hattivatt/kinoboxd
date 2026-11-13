'use strict';

const fs = require('fs');
const path = require('path');

const gameCache = require('../game-cache');
const { fetchOnce } = require('../../core/http');
const { createBreaker } = require('../../core/breaker');
const { budgetLimitFromEnv } = require('../../core/budget');
const sources = require('../../core/sources');

const MOBY_API = 'https://api.mobygames.com/v1';
const KEY_ENV_KEYS = ['MOBYGAMES_API_KEY', 'MOBY_API_KEY'];
const KEY_FILE_ENV = 'KINOBOXD_MOBY_KEY_FILE';
const KEY_FILE = path.join(__dirname, '..', '..', '..', 'config', 'moby-token');
const BREAKER_PATH = path.join(gameCache.STATE_DIR, 'moby-breaker.json');

const DEFAULT_PAUSE_MS = sources.pauseMs('moby');
const DEFAULT_BUDGET = sources.budgetLimit('moby');
const BREAKER_MS = sources.breakerMs('moby');
const DEFAULT_TIMEOUT_MS = sources.timeoutMs('moby');

const ROLE_PATTERNS = [
  [/quality assurance|\bqa\b|testing/i, null],
  [/voice/i, 'voice'],
  [/composer|music|soundtrack/i, 'composer'],
  [/game design|level design|design/i, 'designer'],
  [/writing|narrative|scenario|story/i, 'writer'],
  [/art|graphics|animation|visual/i, 'artist'],
  [/programming|programmer|engineer|technical/i, 'programmer'],
  [/production|producer|director/i, 'producer'],
  [/audio|sound/i, 'sound'],
];

class MobyError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'MobyError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function keyFilePath() {
  const override = process.env[KEY_FILE_ENV];
  if (typeof override === 'string' && override.trim()) return path.resolve(override.trim());
  return KEY_FILE;
}

let cachedKey = null;
let cachedSource = null;
let keyLoaded = false;

function loadMobyKey() {
  if (keyLoaded) return cachedKey;
  let found = null;
  for (const name of KEY_ENV_KEYS) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) {
      found = { token: value.trim(), source: name };
      break;
    }
  }
  if (!found) {
    try {
      const value = fs.readFileSync(keyFilePath(), 'utf8').trim();
      if (value) found = { token: value, source: 'file' };
    } catch (err) {
    }
  }
  cachedKey = found ? found.token : null;
  cachedSource = found ? found.source : null;
  keyLoaded = true;
  return cachedKey;
}

function mobyKeyInfo() {
  loadMobyKey();
  return { configured: Boolean(cachedKey), source: cachedSource };
}

function mobyEnabled() {
  const raw = String(process.env.KINOBOXD_GAMES_MOBY || '').trim().toLowerCase();
  if (['0', 'off', 'false', 'no'].includes(raw)) return false;
  return mobyKeyInfo().configured;
}

function resetMobyKeyCache() {
  keyLoaded = false;
  cachedKey = null;
  cachedSource = null;
}

function mapRole(rawRole) {
  const text = String(rawRole == null ? '' : rawRole).trim();
  if (!text) return null;
  for (const [pattern, role] of ROLE_PATTERNS) {
    if (pattern.test(text)) return role;
  }
  return null;
}

function parseCreditsResponse(json) {
  const credits = json && typeof json === 'object' ? json.credits : null;
  const people = new Map();
  const rolesSeen = new Set();

  const add = (rawRole, entry) => {
    if (!entry || typeof entry !== 'object') return;
    const role = mapRole(rawRole);
    if (!role) return;
    const mobyId =
      entry.person_id != null && Number.isFinite(Number(entry.person_id))
        ? Number(entry.person_id)
        : null;
    const name = entry.name != null ? String(entry.name).trim() : '';
    if (!name) return;
    const key = mobyId != null ? `moby:${mobyId}` : `name:${name.toLowerCase()}`;
    if (!people.has(key)) {
      people.set(key, { name, mobyId, roles: new Set() });
    }
    people.get(key).roles.add(role);
    rolesSeen.add(String(rawRole));
  };

  if (Array.isArray(credits)) {
    for (const entry of credits) add(entry && entry.role, entry);
  } else if (credits && typeof credits === 'object') {
    for (const [rawRole, list] of Object.entries(credits)) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) add(rawRole, entry);
    }
  }

  return {
    source: 'mobygames',
    people: [...people.values()].map((entry) => ({
      name: entry.name,
      nameEn: entry.name,
      nameRu: null,
      qid: null,
      mobyId: entry.mobyId,
      roles: [...entry.roles].sort(),
      roleSource: 'mobygames',
      source: 'mobygames',
      confidence: 'high',
    })),
    studios: [],
    rolesSeen: [...rolesSeen],
  };
}

function defaultBreakerStore() {
  return {
    read() {
      const hit = gameCache.readJsonWithFingerprint(BREAKER_PATH);
      return hit && hit.data && typeof hit.data === 'object' ? hit.data : {};
    },
    write(state) {
      try {
        gameCache.writeJsonAtomicSync(BREAKER_PATH, state && typeof state === 'object' ? state : {});
      } catch (err) {
      }
    },
  };
}

function createClient(options = {}) {
  const fetchImpl = options.fetchImpl;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pauseMs = options.pauseMs == null ? sources.pauseMs('moby') : Number(options.pauseMs);
  const budget =
    options.budget == null
      ? budgetLimitFromEnv('GAMES_MOBY_BUDGET', DEFAULT_BUDGET)
      : Number(options.budget);
  const breakerStore = options.breakerStore || defaultBreakerStore();
  const keyProvider =
    options.keyProvider ||
    (() => ({ key: loadMobyKey(), source: loadMobyKey() ? cachedSource : null }));
  const stats = { requests: 0, budgetUsed: 0, budget };
  const breaker = createBreaker({
    now,
    cooldownMs: BREAKER_MS,
    read: () => breakerStore.read() || {},
    write: (state) => breakerStore.write(state),
  });

  let lastRequestAt = null;

  function assertNotBlocked() {
    const entry = breaker.entry(MOBY_API);
    if (!entry) return;
    throw new MobyError(
      `MobyGames временно не опрашивается (${entry.reason || 'blocked'}), ` +
        `повтор через ${Math.max(1, Math.ceil((entry.until - now()) / 60000))} мин.`,
      'moby_rate_limited',
      { retryAt: new Date(entry.until).toISOString() }
    );
  }

  function tripBreaker(reason) {
    return breaker.trip(MOBY_API, reason);
  }

  async function request(urlPath, label) {
    if (!fetchImpl) throw new MobyError('fetch is not available', 'moby_unavailable');
    const info = keyProvider() || {};
    if (!info.key) {
      throw new MobyError(
        'MobyGames API-ключ не задан: кредиты людей берутся только из Wikidata. ' +
          'Ключ — env MOBYGAMES_API_KEY или config/moby-token.',
        'moby_key_missing'
      );
    }
    assertNotBlocked();
    if (stats.budgetUsed >= budget) {
      throw new MobyError(
        `MobyGames: бюджет прогона исчерпан (${budget} игр).`,
        'moby_budget_exhausted'
      );
    }
    if (pauseMs > 0 && lastRequestAt != null) {
      const wait = pauseMs - (now() - lastRequestAt);
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt = now();
    stats.budgetUsed++;
    stats.requests++;

    let response;
    try {
      response = await fetchOnce(`${MOBY_API}${urlPath}`, {
        fetchImpl,
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${info.key}`,
          'user-agent': 'kinoboxd/1.0 (games personnel)',
        },
        timeoutMs: DEFAULT_TIMEOUT_MS,
        label: 'moby',
      });
    } catch (err) {
      throw new MobyError(`MobyGames недоступен: ${err.message}`, 'moby_unreachable', {
        cause: err,
      });
    }
    const status = Number(response && response.status) || 0;
    if (status === 401) {
      throw new MobyError('MobyGames отклонил ключ (401).', 'moby_key_invalid', { status });
    }
    if (status === 403 || status === 429) {
      tripBreaker(status === 429 ? '429 Too Many Requests' : 'HTTP 403');
      throw new MobyError(
        `MobyGames ответил ${status}: запросы приостановлены на 30 минут (breaker).`,
        'moby_rate_limited',
        { status }
      );
    }
    if (status === 404) {
      throw new MobyError(`MobyGames: ${label} не найден.`, 'moby_not_found', { status });
    }
    if (status < 200 || status >= 300) {
      throw new MobyError(`MobyGames ответил ${status} (${label}).`, 'moby_http_error', { status });
    }
    let json;
    try {
      json = JSON.parse(response.body);
    } catch (err) {
      throw new MobyError('MobyGames вернул не JSON.', 'moby_bad_json', { status });
    }
    return json;
  }

  return {
    stats,
    status() {
      const info = mobyKeyInfo();
      const enabled = mobyEnabled();
      const state = breakerStore.read() || {};
      const breaker = state[MOBY_API] || null;
      return {
        enabled,
        configured: info.configured,
        source: info.source,
        reason: enabled ? null : 'key_missing',
        budget,
        budgetUsed: stats.budgetUsed,
        pauseMs,
        breaker: breaker
          ? { until: new Date(breaker.until).toISOString(), reason: breaker.reason || null }
          : null,
      };
    },
    async fetchGameCredits(target, opts = {}) {
      const mobyId = Number(target && target.mobyId);
      const platformId = Number(target && target.platformId);
      if (!Number.isInteger(mobyId) || mobyId <= 0) {
        throw new MobyError('mobyId is required', 'moby_invalid_target');
      }
      if (!Number.isInteger(platformId) || platformId <= 0) {
        throw new MobyError('platformId is required', 'moby_invalid_target');
      }
      const json = await request(
        `/games/${mobyId}/platforms/${platformId}/credits`,
        `credits ${mobyId}/${platformId}`
      );
      return { ...parseCreditsResponse(json), mobyId, platformId, fetchedAt: new Date().toISOString() };
    },
    async searchGame(title, opts = {}) {
      const text = String(title == null ? '' : title).trim();
      if (!text) throw new MobyError('title is required', 'moby_invalid_target');
      const query = new URLSearchParams({ title: text });
      const json = await request(`/games?${query.toString()}`, `search "${text}"`);
      const games = json && Array.isArray(json.games) ? json.games : [];
      return games.map((game) => ({
        mobyId: game.game_id != null ? Number(game.game_id) : null,
        title: game.title || null,
        platforms: Array.isArray(game.platforms)
          ? game.platforms.map((entry) => ({
              platformId: entry.platform_id != null ? Number(entry.platform_id) : null,
              name: entry.platform_name || null,
            }))
          : [],
      }));
    },
  };
}

module.exports = {
  MOBY_API,
  KEY_ENV_KEYS,
  KEY_FILE,
  BREAKER_PATH,
  DEFAULT_PAUSE_MS,
  DEFAULT_BUDGET,
  BREAKER_MS,
  MobyError,
  loadMobyKey,
  mobyKeyInfo,
  mobyEnabled,
  resetMobyKeyCache,
  mapRole,
  parseCreditsResponse,
  createClient,
};
