'use strict';

const gogCache = require('../gog-cache');
const gogAuth = require('../gog-auth');

/**
 * Return a token document with a usable access token. Delegates to
 * `gog-auth.ensureFreshToken`: a 5-minute buffer (not one minute) and a single
 * silent-refresh implementation shared with every API call. A failed refresh is
 * `auth_expired` — the library snapshot stays, only the auth state changes.
 */
async function ensureAccessToken(userKey, api, options = {}) {
  const { doc } = await gogAuth.ensureFreshToken(userKey, api, {
    ...options,
    reason: options.reason || 'import',
  });
  return doc;
}

async function runAccountStage(job, { api, userKey, tokenApi }) {
  job.stage = 'auth';
  job.percent = 5;
  let tokenDoc = await ensureAccessToken(userKey, api);

  job.stage = 'user';
  job.percent = 10;
  const user = await tokenApi.getUserData(tokenDoc);
  // Persist the Galaxy id (and the OAuth id when the token carried it): the
  // playtime phase needs it as `{uid}`, and an account connected before the
  // 01.11.2026 fix has neither field yet.
  if (user.galaxyUserId && tokenDoc.galaxyUserId !== user.galaxyUserId) {
    tokenDoc = { ...tokenDoc, galaxyUserId: user.galaxyUserId };
    try {
      gogCache.saveToken(userKey, tokenDoc);
    } catch (err) {
      /* a read-only cache must not break the import */
    }
  }
  // Self-heal the owner binding: a token written before the «one owner»
  // rule (or restored from a backup) has no `ownerProfile`, and `/stats`
  // then shows «подключите GOG заново» although the account is connected.
  const libraryOwner =
    (gogCache.getLibrary(userKey) && gogCache.getLibrary(userKey).ownerProfile) || null;
  const boundOwner = tokenDoc.ownerProfile || libraryOwner || job.ownerProfile || null;
  if (boundOwner && tokenDoc.ownerProfile !== boundOwner) {
    tokenDoc = { ...tokenDoc, ownerProfile: boundOwner };
    try {
      gogCache.saveToken(userKey, tokenDoc);
    } catch (err) {
      /* a read-only cache must not break the import */
    }
  }
  job.ownerProfile = tokenDoc.ownerProfile || null;
  gogAuth.recordEvent('user_data', {
    ok: true,
    reason: 'import',
    httpStatus: 200,
    doc: tokenDoc,
    userKey,
    galaxyUserId: user.galaxyUserId,
    sessionId: tokenDoc.sessionId || null,
  });
  const profile = gogCache.getProfile(userKey);
  gogCache.saveProfile({
    ...(profile || {}),
    userKey,
    username: user.username,
    galaxyUserId: user.galaxyUserId,
    country: user.country,
    avatar: user.avatar,
    ownerProfile: tokenDoc.ownerProfile || (profile && profile.ownerProfile) || null,
    connectedAt: (profile && profile.connectedAt) || tokenDoc.connectedAt || new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
  });
  return { tokenDoc, user };
}

module.exports = {
  ensureAccessToken,
  runAccountStage,
};
