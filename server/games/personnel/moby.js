'use strict';

/**
 * MobyGames credit provider for games (ИГРЫ-АРХИТЕКТУРА §2.4, §7.2).
 *
 * MobyGames is the *primary* source of structured people credits (Composer,
 * Game Design, Writing, Art/Graphics, Programming, Production, Voice …), but it
 * needs an API key and the docs are blocked from the dev network (§2.4: «docs
 * 403»). No key was provided for this round, so the provider is implemented as
 * a **graceful no-key skeleton**:
 *
 *   - `mobyKeyInfo()` / `mobyStatus()` report `{configured: false, source: null}`
 *     and never make a request; the personnel payload shows
 *     `sources.mobygames = { enabled: false, reason: 'key_missing' }`;
 *   - the key is resolved like every other token in this project:
 *     env `MOBYGAMES_API_KEY` (alias `MOBY_API_KEY`) → `config/moby-token`
 *     (0600, gitignored, dev fallback). The value is never logged, returned or
 *     put into a payload — only the source name (`env`/`file`);
 *   - tests inject `fetchImpl` and a fake key; live requests are never made
 *     from `npm test` (ИГРЫ §10.3).
 *
 * Politeness (§3.9): 1.1 s pause between requests, `GAMES_MOBY_BUDGET`
 * (default 100 games per run), 30-minute breaker on `403`/`429`, network/5xx is
 * `deferred` (not a negative cache). Credits are cached by `personnel.js` in
 * `cache-games/personnel/<appid>.json` for 90 days, including «no credits»
 * (negative cache), so a game is asked once per quarter.
 *
 * Test hook: `KINOBOXD_MOBY_KEY_FILE` points the file fallback at a non-existent
 * path so a dev token in the main tree cannot change a test result; a
 * `KINOBOXD_GAMES_MOBY=off` kill switch disables the provider entirely.
 */

const fs = require('fs');
const path = require('path');

const gameCache = require('../game-cache');

const MOBY_API = 'https://api.mobygames.com/v1';
const KEY_ENV_KEYS = ['MOBYGAMES_API_KEY', 'MOBY_API_KEY'];
const KEY_FILE_ENV = 'KINOBOXD_MOBY_KEY_FILE';
const KEY_FILE = path.join(__dirname, '..', '..', '..', 'config', 'moby-token');
const BREAKER_PATH = path.join(gameCache.STATE_DIR, 'moby-breaker.json');

const DEFAULT_PAUSE_MS = 1100;
const DEFAULT_BUDGET = 100;
const BREAKER_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Moby role string → local role. Order matters: «Audio/Graphics» must land in
 * `artist` before the generic `audio` rule, QA is explicitly dropped (ИГРЫ
 * §7.2: QA is never shown).
 */
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

/**
 * Resolve the MobyGames key once: env → local file. Returns null when absent.
 * Never log the returned value: report `mobyKeyInfo().source` instead.
 */
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
      /* no local fallback: a missing key is a normal condition */
    }
  }
  cachedKey = found ? found.token : null;
  cachedSource = found ? found.source : null;
  keyLoaded = true;
  return cachedKey;
}

/** `{ configured, source }` — the source is a name, never the key value. */
function mobyKeyInfo() {
  loadMobyKey();
  return { configured: Boolean(cachedKey), source: cachedSource };
}

function mobyEnabled() {
  const raw = String(process.env.KINOBOXD_GAMES_MOBY || '').trim().toLowerCase();
  if (['0', 'off', 'false', 'no'].includes(raw)) return false;
  return mobyKeyInfo().configured;
}

/** Test helper: forget the cached key so the next call re-reads env/file. */
function resetMobyKeyCache() {
  keyLoaded = false;
  cachedKey = null;
  cachedSource = null;
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/** Map one Moby role string to our role (or null when the role is not shown). */
function mapRole(rawRole) {
  const text = String(rawRole == null ? '' : rawRole).trim();
  if (!text) return null;
  for (const [pattern, role] of ROLE_PATTERNS) {
    if (pattern.test(text)) return role;
  }
  return null;
}

/**
 * Normalise a MobyGames credits answer.
 *
 * The documented shape is `{ credits: { "<role>": [{person_id, name}, …] } }`;
 * an array form `[{ role, person_id, name }]` is accepted defensively because
 * the docs themselves are unreachable from this network (§2.4).
 *
 * @returns {{source: 'mobygames', people: Array, studios: Array, rolesSeen: string[]}}
 */
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

/* ------------------------------------------------------------------ */
/* Breaker                                                             */
/* ------------------------------------------------------------------ */

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
        /* best-effort */
      }
    },
  };
}

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {object} [options] `fetchImpl`, `keyProvider`, `now`, `sleep`,
 *        `pauseMs`, `budget`, `breakerStore` — every one injectable for tests.
 */
function createClient(options = {}) {
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pauseMs = options.pauseMs == null ? envInt('GAMES_MOBY_PAUSE_MS', DEFAULT_PAUSE_MS) : Number(options.pauseMs);
  const budget =
    options.budget == null ? envInt('GAMES_MOBY_BUDGET', DEFAULT_BUDGET) : Number(options.budget);
  const breakerStore = options.breakerStore || defaultBreakerStore();
  const keyProvider =
    options.keyProvider ||
    (() => ({ key: loadMobyKey(), source: loadMobyKey() ? cachedSource : null }));
  const stats = { requests: 0, budgetUsed: 0, budget };

  let lastRequestAt = null;

  function assertNotBlocked() {
    const state = breakerStore.read() || {};
    const entry = state[MOBY_API];
    if (!entry || !entry.until) return;
    if (now() < entry.until) {
      throw new MobyError(
        `MobyGames временно не опрашивается (${entry.reason || 'blocked'}), ` +
          `повтор через ${Math.max(1, Math.ceil((entry.until - now()) / 60000))} мин.`,
        'moby_rate_limited',
        { retryAt: new Date(entry.until).toISOString() }
      );
    }
  }

  function tripBreaker(reason) {
    const state = { ...(breakerStore.read() || {}) };
    state[MOBY_API] = { until: now() + BREAKER_MS, reason: String(reason || 'blocked'), at: now() };
    breakerStore.write(state);
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
      response = await fetchImpl(`${MOBY_API}${urlPath}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${info.key}`,
          'user-agent': 'kinoboxd/1.0 (games personnel)',
        },
      });
    } catch (err) {
      // Transport error: deferred, never a negative cache (§3.9).
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
      json = await response.json();
    } catch (err) {
      throw new MobyError('MobyGames вернул не JSON.', 'moby_bad_json', { status });
    }
    return json;
  }

  return {
    stats,
    /** Status for the personnel payload: booleans and a source name, no key. */
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
    /**
     * Credits of one game platform. Requires a resolved Moby id (`links/`),
     * which is the M2/M3 resolver's job (ИГРЫ §4.1).
     *
     * @param {{mobyId: number|string, platformId: number|string}} target
     */
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
    /** Title search — used by the future resolver, not by the stats payload. */
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
