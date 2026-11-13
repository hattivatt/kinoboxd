'use strict';

const bookCache = require('../book-cache');

const PROFILE_SOURCES = ['livelib', 'hardcover'];

function connectedProfiles() {
  return bookCache.listProfiles();
}

function profileKeyOf(profile) {
  return `${profile.source}-${profile.userKey}`;
}

function parseProfileParam(raw) {
  const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const present = raw != null;
  const tokens = [];
  const malformed = [];
  let parts = 0;
  for (const value of values) {
    for (const part of String(value).split(',')) {
      const token = part.trim();
      if (!token) continue;
      parts++;
      const match = /^(livelib|hardcover)-(.+)$/i.exec(token);
      const userKey = match ? match[2].trim() : '';
      if (!match || !/^[\w.-]{1,120}$/.test(userKey)) {
        malformed.push(token);
        continue;
      }
      tokens.push({ token, source: match[1].toLowerCase(), userKey });
    }
  }
  const multi = parts > 1;
  return { present, tokens, malformed, multi, empty: present && parts === 0 };
}

function resolveProfileScope(raw, profilesIn) {
  const profiles = Array.isArray(profilesIn) ? profilesIn : connectedProfiles();
  const available = profiles.map((profile) => ({
    key: profileKeyOf(profile),
    source: profile.source,
    userKey: profile.userKey,
  }));
  const parsed = parseProfileParam(raw);
  const base = {
    explicit: parsed.present,
    multi: parsed.multi,
    empty: parsed.empty,
    requested: parsed.tokens.map((entry) => entry.token),
    selected: [],
    unknown: [],
    malformed: parsed.malformed,
    profiles,
    availableProfileKeys: available.map((entry) => entry.key),
  };
  if (!parsed.present) return base;
  if (parsed.multi) return base;
  const byLowerKey = new Map(available.map((entry) => [entry.key.toLowerCase(), entry]));
  const unknown = [];
  for (const { token, source, userKey } of parsed.tokens) {
    const hit = byLowerKey.get(`${source}-${userKey}`.toLowerCase());
    if (!hit) {
      unknown.push(token);
      continue;
    }
    base.selected.push(hit);
  }
  base.unknown = unknown;
  return base;
}

function selectProfiles(profileScope) {
  const scope = profileScope || resolveProfileScope(undefined);
  const profiles = scope.profiles;
  const connected = [...new Set(profiles.map((profile) => profile.source))];
  const allProfileKeys = profiles.map(profileKeyOf);
  const chosenMeta = scope.selected.length ? scope.selected : [];

  const loaded = [];
  for (const meta of chosenMeta) {
    const data = bookCache.getProfile(meta.source, meta.userKey);
    if (data && Array.isArray(data.events)) loaded.push(data);
  }
  const selected = [...new Set(chosenMeta.map((entry) => entry.source))];
  return {
    connected,
    selected,
    profiles: loaded,
    mode: chosenMeta.length ? 'profile' : 'none',
    requestedProfiles: scope.requested,
    selectedProfileKeys: chosenMeta.map(profileKeyOf),
    allProfileKeys,
  };
}

module.exports = {
  PROFILE_SOURCES,
  connectedProfiles,
  profileKeyOf,
  parseProfileParam,
  resolveProfileScope,
  selectProfiles,
};
