'use strict';

/**
 * SteamGridDB — optional artwork fallback for SKUs whose vertical capsule Steam
 * does not publish at all (resolve `kind: 'none'`).
 *
 * Keyless services cannot draw a 2:3 poster for every appid: CONTROL Resonant
 * (3669870, live 03.11.2026) has no `library_600x900.jpg` *and* no
 * `library_capsule.jpg` on the Steam CDN, so the card legitimately degrades to
 * a cropped landscape header. SteamGridDB is a community grid database with
 * proper 600×900 grids; it is **opt-in**:
 *
 *   STEAMGRIDDB_API_KEY            env
 *   config/steamgriddb-token       dev fallback (0600, gitignored)
 *
 * Without a key the provider is skipped silently (`status: 'skipped'`), so the
 * resolve document stays `none` exactly as before. The key value is never
 * logged or returned — only the source name.
 *
 * API (documented):
 *   GET /api/v2/games/steam/<appid>      -> { data: { id } }
 *   GET /api/v2/grids/game/<id>?dimensions=600x900&types=static&nsfw=false
 *                                        -> { data: [{ url, width, height }] }
 *
 * Politeness: one appid per resolve, ≤2 requests; `GAMES_SGDB_BUDGET` (50)
 * appids per enrich run, 1 s pause, persisted 30 min breaker on 403/429. A
 * transport/5xx failure is deferred (no negative cache).
 */

const gameCache = require('./game-cache');
const { createSourceGate } = require('../core/source-client');
const { fetchJson } = require('../core/http');
const sources = require('../core/sources');
const config = require('../config');

const API_BASE = 'https://www.steamgriddb.com/api/v2';
const BREAKER_KEY = 'www.steamgriddb.com';
const GRID_DIMENSIONS = '600x900';
const KEYLESS_STATUS = 'skipped';
const CDN_HOST_RE = /(^|\.)steamgriddb\.com$/i;

let lastRequestAt = null;

function keyOf(options = {}) {
  if (options.key !== undefined) return options.key || null;
  try {
    return config.loadSteamgriddbKey();
  } catch (err) {
    return null;
  }
}

async function pause(options = {}) {
  const pauseMs = options.pauseMs != null ? Number(options.pauseMs) : sources.pauseMs('steamGridDb');
  if (!(pauseMs > 0)) return;
  const now = options.now ? Number(options.now()) : Date.now();
  if (lastRequestAt != null) {
    const wait = pauseMs - (now - lastRequestAt);
    if (wait > 0) {
      const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
      await sleep(wait);
    }
  }
  lastRequestAt = options.now ? Number(options.now()) : Date.now();
}

/** Only a https URL on a SteamGridDB CDN host may become payload art. */
function allowedGridUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value == null ? '' : value));
  } catch (err) {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return CDN_HOST_RE.test(parsed.hostname.toLowerCase());
}

/**
 * Pick the first usable vertical grid. `nsfw=false` is already requested; an
 * explicit width/height check keeps an unexpected horizontal asset out.
 */
function pickGrid(data) {
  if (!Array.isArray(data)) return null;
  for (const grid of data) {
    if (!grid || !allowedGridUrl(grid.url)) continue;
    const width = Number(grid.width);
    const height = Number(grid.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      if (width >= height) continue;
    }
    return String(grid.url);
  }
  return null;
}

/**
 * Resolve one appid's 600×900 grid.
 *
 * @returns {Promise<{status:'found'|'none'|'skipped'|'deferred', url?:string,
 *   source?:string, reason?:string}>}
 */
async function resolveSteamGridDb(rawAppid, options = {}) {
  const appid = Number(rawAppid);
  if (!Number.isSafeInteger(appid) || appid <= 0) return { status: 'none' };
  const key = keyOf(options);
  if (!key) return { status: KEYLESS_STATUS, reason: 'no_key' };

  const now = options.now || (() => Date.now());
  const budget = options.budget || null;
  if (budget && !budget.take()) return { status: 'deferred', reason: 'budget' };

  const gate = createSourceGate({
    breaker: options.breaker,
    now: options.now,
    breakerMs: () => sources.breakerMs('steamGridDb'),
    breakerStore: {
      read: () => gameCache.readBreaker(),
      write: (state) => gameCache.writeBreaker(state),
    },
  });
  const open = gate.breakerFor(BREAKER_KEY);
  if (open) return { status: 'deferred', reason: 'breaker' };

  const request = async (url) => {
    await pause(options);
    return fetchJson(url, {
      fetchImpl: options.fetch,
      timeoutMs:
        options.timeoutMs != null ? options.timeoutMs : sources.timeoutMs('steamGridDb'),
      userAgent: sources.userAgent('steamGridDb'),
      headers: { authorization: `Bearer ${key}` },
      label: 'steamgriddb',
      retries: options.retries != null ? options.retries : 1,
      sleep: options.sleep,
    });
  };

  let lookup;
  try {
    lookup = await request(`${API_BASE}/games/steam/${appid}`);
  } catch (err) {
    const status = Number(err && err.status) || 0;
    if (status === 403 || status === 429 || (err && err.code === 'provider_rate_limited')) {
      gate.tripBreaker(BREAKER_KEY, {
        reason: status === 429 ? '429 Too Many Requests' : 'HTTP 403',
        untilMs: sources.breakerMs('steamGridDb'),
      });
      return { status: 'deferred', reason: 'rate_limited' };
    }
    if (status === 404) return { status: 'none', reason: 'no_game' };
    return { status: 'deferred', reason: 'unreachable' };
  }
  if (!lookup || lookup.success === false) return { status: 'none', reason: 'no_game' };
  const gameId = lookup.data && lookup.data.id;
  if (!gameId) return { status: 'none', reason: 'no_game' };

  let grids;
  try {
    grids = await request(
      `${API_BASE}/grids/game/${encodeURIComponent(gameId)}` +
        `?dimensions=${GRID_DIMENSIONS}&types=static&nsfw=false`
    );
  } catch (err) {
    const status = Number(err && err.status) || 0;
    if (status === 403 || status === 429 || (err && err.code === 'provider_rate_limited')) {
      gate.tripBreaker(BREAKER_KEY, {
        reason: status === 429 ? '429 Too Many Requests' : 'HTTP 403',
        untilMs: sources.breakerMs('steamGridDb'),
      });
      return { status: 'deferred', reason: 'rate_limited' };
    }
    return { status: 'deferred', reason: 'unreachable' };
  }
  const url = pickGrid(grids && grids.data);
  if (!url) return { status: 'none', reason: 'no_grid' };
  return { status: 'found', url, source: 'steamgriddb' };
}

module.exports = {
  API_BASE,
  BREAKER_KEY,
  GRID_DIMENSIONS,
  resolveSteamGridDb,
  pickGrid,
  allowedGridUrl,
};
