'use strict';

/**
 * Profile scope of the books stats payload: which profile documents exist on
 * disk, how `?profile=` is parsed and resolved, and which single profile the
 * aggregation loads.
 *
 * R12 «god module» split: moved out of `books/stats.js` unchanged.
 */

const bookCache = require('../book-cache');

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

/** Sources that can hold a profile document (`profiles/{source}-{userKey}`). */
const PROFILE_SOURCES = ['livelib', 'hardcover'];

/** Connected sources = profiles present on disk. */
function connectedProfiles() {
  return bookCache.listProfiles();
}

/** Canonical profile key, the same token `?profile=` accepts. */
function profileKeyOf(profile) {
  return `${profile.source}-${profile.userKey}`;
}

/**
 * Parse `?profile=` — exactly ONE `source-userKey` token naming a profile
 * document (`cache-book/profiles/{source}-{userKey}.json`).
 *
 * There is no second separator on purpose: the first `-` after the source is
 * the boundary, so a LiveLib username with dashes (`my-reader`) stays intact.
 * The userKey grammar matches what the importers accept (letters, digits,
 * `_`, `.`, `-`), so no token can address a file outside profiles/.
 *
 * A repeated parameter (`?profile=a&profile=b`) or a CSV (`?profile=a,b`) is
 * reported as `multi` — the caller answers 400 instead of picking one.
 */
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
  // The contract is exactly one token. `?profile=a&profile=` is still one;
  // `?profile=a,b` and `?profile=a&profile=b` are multi and get a 400.
  const multi = parts > 1;
  return { present, tokens, malformed, multi, empty: present && parts === 0 };
}

/**
 * Resolve the single `?profile=` token against the profiles on disk.
 *
 * Matching is case-insensitive (a client may lower-case the token) but the
 * result always carries the canonical `userKey` from the file, and a token
 * that names no cached profile is reported as `unknown` instead of silently
 * widening the selection — that is what keeps the scope honest.
 *
 * `explicit` is true whenever the parameter was present at all (including an
 * empty `?profile=`), so the caller can distinguish "no scope asked" from
 * "scope asked but resolved to nothing" (the latter is a 400 at the route).
 */
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

/**
 * Load the one profile that feeds the aggregation.
 *
 * No parameter at all means "no profile": the caller (route) answers 400
 * before this point, internal callers get an empty scope.
 */
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
