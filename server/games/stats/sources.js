'use strict';

function buildSources(ctx) {
  const {
    profileKey,
    steamId64,
    profile,
    allProfileKeys,
    partial,
    keyConfigured,
    ownedCount,
    library,
    gogSource,
    epicSource,
  } = ctx;
  return {
    connected: [profileKey],
    selected: [profileKey],
    profile: {
      key: profileKey,
      source: 'steam',
      userKey: steamId64,
      personaName: (profile && profile.personaName) || null,
      label: (profile && profile.ownerLabel) || null,
      avatarUrl: (profile && profile.avatarUrl) || null,
      profileUrl:
        (profile && profile.profileUrl) ||
        `https://steamcommunity.com/profiles/${steamId64}`,
      privacy: (profile && profile.privacy) || null,
      importedAt: (profile && profile.importedAt) || null,
      timeCreated: (profile && profile.timeCreated) || null,
      lastLogOff: (profile && profile.lastLogOff) || null,
      gameCount: library.game_count == null ? ownedCount : library.game_count,
    },
    profiles: { connected: allProfileKeys, selected: [profileKey] },
    steam: {
      configured: keyConfigured,
      status: partial ? 'partial' : 'ok',
      lastImportAt: library.fetchedAt || null,
      gameCount: library.game_count == null ? ownedCount : library.game_count,
    },
    gog: gogSource,
    epic: epicSource,
  };
}

module.exports = { buildSources };
