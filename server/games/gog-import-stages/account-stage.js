'use strict';

const gogCache = require('../gog-cache');
const gogAuth = require('../gog-auth');

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
  if (user.galaxyUserId && tokenDoc.galaxyUserId !== user.galaxyUserId) {
    tokenDoc = { ...tokenDoc, galaxyUserId: user.galaxyUserId };
    try {
      gogCache.saveToken(userKey, tokenDoc);
    } catch (err) {
    }
  }
  const libraryOwner =
    (gogCache.getLibrary(userKey) && gogCache.getLibrary(userKey).ownerProfile) || null;
  const boundOwner = tokenDoc.ownerProfile || libraryOwner || job.ownerProfile || null;
  if (boundOwner && tokenDoc.ownerProfile !== boundOwner) {
    tokenDoc = { ...tokenDoc, ownerProfile: boundOwner };
    try {
      gogCache.saveToken(userKey, tokenDoc);
    } catch (err) {
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
