'use strict';

const gameCache = require('./game-cache');
const gogCache = require('./gog-cache');
const gog = require('./gog');
const gogAuth = require('./gog-auth');

/* ------------------------------------------------------------------ */
/* connect                                                             */
/* ------------------------------------------------------------------ */

function resolveOwner(ownerProfile, { userKey, existing }) {
  const explicit = String(ownerProfile == null ? '' : ownerProfile).trim();
  if (explicit) {
    const parsed = gameCache.parseProfileToken(explicit);
    if (!parsed || !gameCache.getProfile(parsed.userKey)) {
      throw new gog.GogError(
        `"profile": неизвестный Steam-профиль ${explicit}. Сначала импортируйте Steam.`,
        'unknown_profile',
        { status: 400 }
      );
    }
    return parsed.key;
  }
  if (existing && existing.ownerProfile) return existing.ownerProfile;
  const profiles = gameCache.listProfiles();
  if (profiles.length === 1) return profiles[0].key;
  if (profiles.length === 0) {
    throw new gog.GogError(
      'Сначала импортируйте Steam-профиль: GOG — вторая библиотека того же владельца, ' +
        'без владельца её не к чему привязать.',
      'steam_profile_required',
      { status: 400 }
    );
  }
  throw new gog.GogError(
    'Профилей Steam несколько: укажите "profile" (steam-<steamid64>), к какому владельцу привязать GOG.',
    'owner_required',
    { status: 400 }
  );
}

function assertOwnerFree(ownerProfile, userKey) {
  if (!ownerProfile) return;
  const attached = gogCache.accountsForOwner(ownerProfile);
  const other = attached.find((entry) => entry.userKey !== String(userKey));
  if (other) {
    throw new gog.GogError(
      `К профилю ${ownerProfile} уже подключён GOG-аккаунт ${other.userKey}. ` +
        'Один владелец — один GOG; отключите предыдущий или укажите другой профиль.',
      'gog_already_connected',
      { status: 400 }
    );
  }
}

/**
 * Exchange the one-time `code` for tokens, read the identity and persist both
 * the token (0600) and the public profile. Returns a sanitized view.
 */
async function connect({ code, ownerProfile, profile, client }) {
  const api = client || gog.createClient();
  let tokens;
  try {
    tokens = await api.exchangeCode(code);
  } catch (err) {
    gogAuth.recordEvent('connect', {
      ok: false,
      reason: 'code_exchange',
      httpStatus: err && err.status,
      error: (err && err.code) || 'gog_error',
      errorDescription: gogAuth.descriptionOf(err),
    });
    throw err;
  }
  const provisional = {
    accessToken: tokens.accessToken,
    userKey: tokens.userId || '',
  };
  let user;
  try {
    user = await api.getUserData(provisional);
  } catch (err) {
    gogAuth.recordEvent('user_data', {
      ok: false,
      reason: 'connect',
      httpStatus: err && err.status,
      error: (err && err.code) || 'gog_error',
      errorDescription: gogAuth.descriptionOf(err),
      doc: provisional,
      userKey: provisional.userKey || null,
      sessionId: tokens.sessionId,
    });
    throw err;
  }
  const userKey = user.userKey;

  const existing = gogCache.getToken(userKey);
  const owner = resolveOwner(ownerProfile != null ? ownerProfile : profile, { userKey, existing });
  if (existing && existing.ownerProfile && existing.ownerProfile !== owner) {
    throw new gog.GogError(
      `GOG-аккаунт ${userKey} уже привязан к профилю ${existing.ownerProfile}. ` +
        'Чужой аккаунт нельзя перевесить на другого владельца: отключите его сначала.',
      'owner_mismatch',
      { status: 400 }
    );
  }
  assertOwnerFree(owner, userKey);

  const nowIso = new Date().toISOString();
  const tokenDoc = {
    userKey,
    // The two ids `gameplay.gog.com` may expect: the OAuth `user_id` (Heroic)
    // and the `galaxyUserId` from `userData.json` (comet/unifideck). Both are
    // stored so the playtime phase never falls back to `userData.json.userId`
    // — that field is not the Galaxy id (01.11.2026 zero-hours bug).
    userId: tokens.userId || (existing && existing.userId) || null,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || (existing && existing.refreshToken) || null,
    expiresAt: tokens.expiresAt,
    tokenType: tokens.tokenType,
    scope: tokens.scope,
    username: user.username,
    galaxyUserId: user.galaxyUserId,
    country: user.country,
    avatar: user.avatar,
    ownerProfile: owner,
    connectedAt: (existing && existing.connectedAt) || nowIso,
    obtainedAt: nowIso,
    refreshedAt: (existing && existing.refreshedAt) || null,
    // A fresh connect is a clean slate: a stale refresh error from the previous
    // token must not keep the account in «подключите GOG заново».
    lastRefreshError: null,
    lastError: null,
    sessionId: tokens.sessionId || null,
  };
  gogCache.saveToken(userKey, tokenDoc);
  gogAuth.recordEvent('connect', {
    ok: true,
    reason: 'code_exchange',
    httpStatus: 200,
    doc: tokenDoc,
    userKey,
    galaxyUserId: user.galaxyUserId,
    sessionId: tokens.sessionId || null,
    now: Date.parse(nowIso),
  });
  gogCache.saveProfile({
    userKey,
    username: user.username,
    galaxyUserId: user.galaxyUserId,
    country: user.country,
    avatar: user.avatar,
    ownerProfile: owner,
    connectedAt: tokenDoc.connectedAt,
    fetchedAt: nowIso,
  });
  return {
    account: gogCache.publicTokenView(gogCache.getToken(userKey)),
    // Boolean only: the token value is never exposed.
    tokenStored: true,
  };
}

module.exports = {
  connect,
  resolveOwner,
};
