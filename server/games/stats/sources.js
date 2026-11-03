'use strict';

/**
 * `sources` of the games payload: which profile produced it, the profile
 * catalog, and the per-source state (`steam` journal, `gog`/`epic` same-owner
 * secondary libraries).
 *
 * S1 «распил god-функции»: the literal moved out of `buildGamesStats` without
 * a shape change. The key order is the payload contract.
 */

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
    // M6a: per-source state. `steam` is the journal (the only source of
    // achievements and `totalHours`); `gog` is a same-owner secondary
    // library. A missing token is `not_connected`/`auth_expired`, never 0.
    steam: {
      configured: keyConfigured,
      status: partial ? 'partial' : 'ok',
      lastImportAt: library.fetchedAt || null,
      gameCount: library.game_count == null ? ownedCount : library.game_count,
    },
    gog: gogSource,
    // M6c: Epic read-model state. Same shape as `gog`, so the «Источники»
    // widget and the «Подключения» screen render both through one contract.
    epic: epicSource,
  };
}

module.exports = { buildSources };
