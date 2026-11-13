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

function listEpicProfilesSafe() {
  try {
    return epicCache.listEpicProfiles().filter((entry) => !entry.disconnectedAt);
  } catch {
    return [];
  }
}

function listGameProfileOwners() {
  const gogAccounts = gogCache.listAccounts();
  const epicProfiles = listEpicProfilesSafe();
  const profiles = gameCache.listProfiles().map((entry) => {
    const profile = gameCache.getProfile(entry.userKey);
    const library = gameCache.getLibrary(entry.userKey);
    const summary = profileSummary(profile, library);
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
  router.get('/profiles', (req, res) => {
    const { profiles, sources } = profileRegistry.snapshot('games');
    const gogAccounts = gogCache.listAccounts();
    res.status(200).json({
      profiles,
      connected: ['steam', ...(gogAccounts.length ? ['gog'] : [])],
      availableProfileKeys: profiles.map((entry) => entry.key),
      steamKey: keyInfo(),
      gog: {
        configured: true,
        accounts: gogAccounts.length,
        clientSource: gog.clientSource(),
      },
      cacheDir: gameCache.GAMES_CACHE_DIR,
      libraryTtlHours: Math.round(gameCache.libraryTtlMs() / 3600000),
      sources,
    });
  });
}

module.exports = { register };
