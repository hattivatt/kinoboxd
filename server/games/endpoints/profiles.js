'use strict';

const config = require('../../config');
const profileRegistry = require('../../core/profile');
const epicCache = require('../epic-cache');
const gameCache = require('../game-cache');
const gog = require('../gog');
const gogCache = require('../gog-cache');
const { profileSummary } = require('../stats');

function keyInfo() {
  const configured = Boolean(config.loadSteamKey());
  return { configured, source: configured ? config.steamKeySource() : null };
}

/** Epic accounts bound to a Steam owner; a missing cache is not an error. */
function listEpicProfilesSafe() {
  try {
    return epicCache.listEpicProfiles().filter((entry) => !entry.disconnectedAt);
  } catch {
    return [];
  }
}

/**
 * Unified owner snapshot of the games domain (`core/profile`, U8).
 *
 * A games owner is a Steam account; GOG and Epic libraries of the same person
 * are `enrichers` (§6/§14.4: a second account is never a second owner). The
 * legacy per-profile fields (`summary`, `libraries`, `gameCount`, …) are passed
 * through untouched; `metrics` is the very object `summary` carries, so the
 * unified form does not compute anything new.
 *
 * - `id`        the `?profile=` token (`steam-<steamid64>`),
 * - `label`     the name typed at import (`ownerLabel`), `null` when absent —
 *               the same value the switcher already reads,
 * - `updatedAt` `importedAt` (the import write), falling back to the profile
 *               fetch time; no invented timestamps.
 */
function listGameProfileOwners() {
  const gogAccounts = gogCache.listAccounts();
  const epicProfiles = listEpicProfilesSafe();
  const profiles = gameCache.listProfiles().map((entry) => {
    const profile = gameCache.getProfile(entry.userKey);
    const library = gameCache.getLibrary(entry.userKey);
    const summary = profileSummary(profile, library);
    // M6a: same-owner secondary libraries (GOG today, Epic later).
    // A GOG account is never shown under two Steam owners.
    const libraries = gogAccounts
      .filter((account) => account.ownerProfile === entry.key)
      .map((account) => ({
        source: 'gog',
        userKey: account.userKey,
        key: account.key,
        username: account.username,
        connectedAt: account.connectedAt,
        expiresAt: account.expiresAt,
        expired: account.expired,
      }));
    return {
      ...entry,
      summary,
      libraries,
      id: entry.key,
      label: entry.label,
      primary: {
        source: 'steam',
        userKey: entry.userKey,
        status: 'connected',
        updatedAt: entry.importedAt || entry.profileFetchedAt || null,
      },
      enrichers: [
        ...libraries.map((account) => ({
          source: 'gog',
          userKey: account.userKey,
          status: account.expired ? 'expired' : 'connected',
          updatedAt: account.connectedAt || null,
        })),
        ...epicProfiles
          .filter((account) => account.ownerKey === entry.key)
          .map((account) => ({
            source: 'epic',
            userKey: account.accountId,
            status: 'connected',
            updatedAt: account.libraryFetchedAt || account.connectedAt || null,
          })),
      ],
      metrics: summary,
    };
  });

  const gogConnected = gogAccounts.length > 0;
  const gogExpired = gogConnected && gogAccounts.every((account) => account.expired);
  const epicConnected = epicProfiles.length > 0;
  return {
    profiles,
    sources: [
      { id: 'steam', role: 'primary', connected: true, state: 'ready' },
      {
        id: 'gog',
        role: 'enricher',
        connected: gogConnected,
        state: gogConnected ? (gogExpired ? 'expired' : 'ready') : 'missing',
      },
      {
        id: 'epic',
        role: 'enricher',
        connected: epicConnected,
        state: epicConnected ? 'ready' : 'missing',
      },
    ],
  };
}

profileRegistry.registerDomainProfiles('games', listGameProfileOwners);

function register(router) {
  /* ------------------------- profiles ------------------------- */

  router.get('/profiles', (req, res) => {
    // The unified owner snapshot (core/profile) is the single source of the
    // list; the legacy domain fields stay exactly where they were.
    const { profiles, sources } = profileRegistry.snapshot('games');
    const gogAccounts = gogCache.listAccounts();
    res.status(200).json({
      profiles,
      connected: ['steam', ...(gogAccounts.length ? ['gog'] : [])],
      availableProfileKeys: profiles.map((entry) => entry.key),
      // Boolean only: the key value is never exposed.
      steamKey: keyInfo(),
      gog: {
        configured: true,
        accounts: gogAccounts.length,
        // Source only (`env`/`file`/`default`), never the client value.
        clientSource: gog.clientSource(),
      },
      cacheDir: gameCache.GAMES_CACHE_DIR,
      libraryTtlHours: Math.round(gameCache.libraryTtlMs() / 3600000),
      sources,
    });
  });
}

module.exports = { register };
