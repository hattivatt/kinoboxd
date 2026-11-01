'use strict';

/**
 * Epic device-code auth sessions (M6b).
 *
 * The browser never sees `device_code` (it is the secret that grants the
 * token) — only the short `user_code` and the activation URL. The backend
 * polls the account service, stores the resulting token with 0600
 * (`epic-token-store.js`) and binds the Epic account to the same owner
 * (`steam-<steamid64>`) as the primary library.
 *
 * Session states: `pending` → `authorized` | `expired` | `failed`.
 * `slow_down` from Epic increases the polling interval; `authorization_pending`
 * keeps the session alive until `expires_in`. A network error during polling
 * is retried until the device code expires (it is not a failed login).
 */

const crypto = require('crypto');

const epic = require('./epic');
const epicCache = require('./epic-cache');
const tokenStore = require('./epic-token-store');
const importJobs = require('./epic-import');

const sessions = new Map();
const SESSION_RETENTION_MS = 10 * 60 * 1000;

function newAuthId() {
  return `epic-auth-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeOwnerKey(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return null;
  if (!/^steam-\d{17}$/.test(value)) {
    throw new epic.EpicError(
      'owner должен быть токеном Steam-профиля "steam-<steamid64>".',
      'invalid_owner',
      { status: 400 }
    );
  }
  return value;
}

function publicSession(session) {
  if (!session) return null;
  const now = Date.now();
  return {
    authId: session.id,
    source: 'epic',
    status: session.status,
    userCode: session.userCode,
    verificationUri: session.verificationUri,
    verificationUriComplete: session.verificationUriComplete,
    expiresIn: Math.max(0, Math.round((session.expiresAt - now) / 1000)),
    expiresAt: new Date(session.expiresAt).toISOString(),
    intervalMs: session.intervalMs,
    owner: session.ownerKey,
    accountId: session.accountId || null,
    displayName: session.displayName || null,
    code: session.code || null,
    error: session.error || null,
    importJobId: session.importJobId || null,
    importError: session.importError || null,
    polls: session.polls,
    authorizedAt: session.authorizedAt || null,
    // Never: deviceCode, access/refresh tokens.
  };
}

function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.status === 'pending') continue;
    if (session.finishedAt && now - session.finishedAt > SESSION_RETENTION_MS) {
      if (session.timer) clearTimeout(session.timer);
      sessions.delete(id);
    }
  }
}

/**
 * Refuse to attach an Epic account to a different owner. The games model is
 * one owner → one Epic secondary library; a second account is an explicit
 * `owner_mismatch`, never a silent sum (§14.4 rule 1).
 */
function assertOwnerBinding(accountId, ownerKey) {
  if (!ownerKey) return;
  const existing = epicCache.getEpicProfile(accountId);
  if (existing && existing.ownerKey && existing.ownerKey !== ownerKey) {
    throw new epic.EpicError(
      `Epic-аккаунт ${accountId} уже привязан к ${existing.ownerKey}. ` +
        'Библиотеки разных владельцев не сливаются (§14.4).',
      'owner_mismatch',
      { status: 400 }
    );
  }
  const other = epicCache.epicAccountForOwner(ownerKey);
  if (other && other !== accountId) {
    throw new epic.EpicError(
      `У владельца ${ownerKey} уже есть Epic-аккаунт ${other}. ` +
        'Одна вторичная библиотека на владельца, без суммы (§14.4).',
      'owner_mismatch',
      { status: 400 }
    );
  }
}

async function completeAuth(session, tokens) {
  const accountId = tokens.accountId;
  assertOwnerBinding(accountId, session.ownerKey);
  const existing = await tokenStore.getTokens(accountId);
  await tokenStore.saveTokens({
    ...(existing || {}),
    accountId,
    displayName: tokens.displayName || (existing && existing.displayName) || null,
    ownerKey: session.ownerKey || (existing && existing.ownerKey) || null,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || (existing && existing.refreshToken) || null,
    accessExpiresAt: tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt || (existing && existing.refreshExpiresAt) || null,
    tokenType: tokens.tokenType || (existing && existing.tokenType) || null,
    clientId: tokens.clientId || (existing && existing.clientId) || null,
    deviceAuth: existing && existing.deviceAuth ? existing.deviceAuth : null,
    authMethod: 'device_code',
    lastAuthError: null,
    lastAuthErrorAt: null,
  });

  const profile = epicCache.getEpicProfile(accountId);
  await epicCache.saveEpicProfile({
    ...(profile || {}),
    accountId,
    displayName: tokens.displayName || (profile && profile.displayName) || null,
    ownerKey: session.ownerKey || (profile && profile.ownerKey) || null,
    label: session.label || (profile && profile.label) || null,
    authMethod: 'device_code',
    connectedAt: (profile && profile.connectedAt) || new Date().toISOString(),
    disconnectedAt: null,
  });

  session.status = 'authorized';
  session.accountId = accountId;
  session.displayName = tokens.displayName || null;
  session.authorizedAt = new Date().toISOString();
  session.finishedAt = Date.now();
  delete session.deviceCode;
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }

  // The user just granted access: start the library import automatically so
  // the «Подключения» card can show counts/hours without a second click.
  if (session.autoImport) {
    try {
      const job = await importJobs.startImport({
        accountId,
        ownerKey: session.ownerKey,
        force: true,
        label: session.label,
        client: session.client,
        tokenStore: session.tokenStore,
      });
      session.importJobId = job && job.jobId ? job.jobId : null;
    } catch (err) {
      session.importError = epic.maskSecrets(err && err.message ? err.message : 'import failed');
    }
  }
}

async function pollSession(authId) {
  cleanupSessions();
  const session = sessions.get(String(authId || ''));
  if (!session) return null;
  if (session.status !== 'pending') return publicSession(session);
  if (Date.now() >= session.expiresAt) {
    session.status = 'expired';
    session.code = 'epic_auth_expired';
    session.error = 'Код Epic истёк — начните подключение заново.';
    session.finishedAt = Date.now();
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    return publicSession(session);
  }
  // The UI polls GET /epic/auth/:authId, the background loop polls too; one
  // network poll per `intervalMs` regardless of how many callers ask.
  if (session.lastPollAt && Date.now() - session.lastPollAt < session.intervalMs) {
    return publicSession(session);
  }
  session.lastPollAt = Date.now();

  session.polls++;
  let result;
  try {
    result = await session.client.exchangeDeviceCode(session.deviceCode);
  } catch (err) {
    // Network/5xx/breaker: the code is still valid, retry until it expires.
    session.error = epic.maskSecrets(err && err.message ? err.message : 'poll failed');
    session.code = (err && err.code) || 'epic_poll_failed';
    return publicSession(session);
  }

  if (result.status === 'pending') {
    session.error = null;
    session.code = null;
    return publicSession(session);
  }
  if (result.status === 'slow_down') {
    session.intervalMs = Math.max(session.intervalMs, result.intervalMs || 10000);
    return publicSession(session);
  }
  if (result.status === 'expired') {
    session.status = 'expired';
    session.code = result.code || 'epic_auth_expired';
    session.error = result.error || 'Код Epic истёк.';
    session.finishedAt = Date.now();
    return publicSession(session);
  }
  if (result.status === 'authorized') {
    try {
      await completeAuth(session, result.tokens);
    } catch (err) {
      session.status = 'failed';
      session.code = (err && err.code) || 'epic_auth_failed';
      session.error = epic.maskSecrets(err && err.message ? err.message : 'auth failed');
      session.finishedAt = Date.now();
    }
    return publicSession(session);
  }

  session.status = 'failed';
  session.code = result.code || 'epic_auth_failed';
  session.error = result.error || 'Epic отклонил вход.';
  session.finishedAt = Date.now();
  return publicSession(session);
}

function schedulePoll(session) {
  if (session.timer || session.status !== 'pending') return;
  const delay = Math.max(1000, Number(session.intervalMs) || 5000);
  session.timer = setTimeout(async () => {
    session.timer = null;
    if (session.status !== 'pending') return;
    await pollSession(session.id);
    if (session.status === 'pending') schedulePoll(session);
  }, delay);
  if (session.timer.unref) session.timer.unref();
}

/**
 * Start a device-code login. Returns the public session (user code + URL);
 * `device_code` stays in memory and is deleted as soon as the token arrives.
 */
async function startDeviceAuth(options = {}) {
  cleanupSessions();
  const ownerKey = normalizeOwnerKey(options.ownerKey);
  const store = options.tokenStore || tokenStore;
  const client = options.client || epic.createClient({ tokenStore: store });
  const device = await client.deviceAuthorization();
  const session = {
    id: newAuthId(),
    deviceCode: device.deviceCode,
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    verificationUriComplete: device.verificationUriComplete,
    expiresAt: Date.now() + device.expiresIn * 1000,
    intervalMs: device.intervalMs,
    ownerKey,
    label: options.label || null,
    status: 'pending',
    accountId: null,
    displayName: null,
    code: null,
    error: null,
    importJobId: null,
    importError: null,
    polls: 0,
    createdAt: Date.now(),
    client,
    tokenStore: store,
    autoImport: options.autoImport !== false,
    timer: null,
  };
  sessions.set(session.id, session);
  if (options.autoPoll !== false) schedulePoll(session);
  return publicSession(session);
}

function getSession(authId) {
  cleanupSessions();
  return publicSession(sessions.get(String(authId || '')));
}

function cancelSession(authId) {
  const session = sessions.get(String(authId || ''));
  if (!session) return false;
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;
  session.status = 'failed';
  session.code = 'epic_auth_cancelled';
  session.error = 'Подключение отменено.';
  session.finishedAt = Date.now();
  return true;
}

/** Tests only: drop every in-memory session. */
function _reset() {
  for (const session of sessions.values()) {
    if (session.timer) clearTimeout(session.timer);
  }
  sessions.clear();
}

module.exports = {
  startDeviceAuth,
  pollSession,
  getSession,
  cancelSession,
  publicSession,
  assertOwnerBinding,
  normalizeOwnerKey,
  _reset,
  SESSION_RETENTION_MS,
};
