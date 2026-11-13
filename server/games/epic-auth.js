'use strict';

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

async function persistAuth({
  accountId,
  tokens,
  ownerKey,
  label,
  authMethod,
  client,
  tokenStore: store,
  autoImport = true,
}) {
  assertOwnerBinding(accountId, ownerKey);
  const existing = await store.getTokens(accountId);
  await store.saveTokens({
    ...(existing || {}),
    accountId,
    displayName: tokens.displayName || (existing && existing.displayName) || null,
    ownerKey: ownerKey || (existing && existing.ownerKey) || null,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || (existing && existing.refreshToken) || null,
    accessExpiresAt: tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt || (existing && existing.refreshExpiresAt) || null,
    tokenType: tokens.tokenType || (existing && existing.tokenType) || null,
    clientId: tokens.clientId || (existing && existing.clientId) || null,
    deviceAuth: existing && existing.deviceAuth ? existing.deviceAuth : null,
    authMethod,
    lastAuthError: null,
    lastAuthErrorAt: null,
  });

  const profile = epicCache.getEpicProfile(accountId);
  await epicCache.saveEpicProfile({
    ...(profile || {}),
    accountId,
    displayName: tokens.displayName || (profile && profile.displayName) || null,
    ownerKey: ownerKey || (profile && profile.ownerKey) || null,
    label: label || (profile && profile.label) || null,
    authMethod,
    connectedAt: (profile && profile.connectedAt) || new Date().toISOString(),
    disconnectedAt: null,
  });

  let importJobId = null;
  let importError = null;
  if (!autoImport) return { importJobId, importError };
  try {
    const job = await importJobs.startImport({
      accountId,
      ownerKey,
      force: true,
      label,
      client,
      tokenStore: store,
    });
    importJobId = job && job.jobId ? job.jobId : null;
  } catch (err) {
    importError = epic.maskSecrets(err && err.message ? err.message : 'import failed');
  }
  return { importJobId, importError };
}

async function completeAuth(session, tokens) {
  const accountId = tokens.accountId;
  const { importJobId, importError } = await persistAuth({
    accountId,
    tokens,
    ownerKey: session.ownerKey,
    label: session.label,
    authMethod: 'device_code',
    client: session.client,
    tokenStore: session.tokenStore,
    autoImport: session.autoImport !== false,
  });
  session.importJobId = importJobId;
  session.importError = importError;

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
}

async function connectWithCode(options = {}) {
  const ownerKey = normalizeOwnerKey(options.ownerKey);
  const store = options.tokenStore || tokenStore;
  const client = options.client || epic.createClient({ tokenStore: store });
  const tokens = await client.exchangeAuthorizationCode(options.code);
  const accountId = tokens.accountId;
  const { importJobId, importError } = await persistAuth({
    accountId,
    tokens,
    ownerKey,
    label: options.label || null,
    authMethod: 'authorization_code',
    client,
    tokenStore: store,
    autoImport: options.autoImport !== false,
  });
  return {
    accountId,
    displayName: tokens.displayName || null,
    owner: ownerKey,
    authMethod: 'authorization_code',
    accessExpiresAt: tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    importJobId,
    importError,
  };
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
  if (session.lastPollAt && Date.now() - session.lastPollAt < session.intervalMs) {
    return publicSession(session);
  }
  session.lastPollAt = Date.now();

  session.polls++;
  let result;
  try {
    result = await session.client.exchangeDeviceCode(session.deviceCode);
  } catch (err) {
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

function _reset() {
  for (const session of sessions.values()) {
    if (session.timer) clearTimeout(session.timer);
  }
  sessions.clear();
}

module.exports = {
  startDeviceAuth,
  connectWithCode,
  persistAuth,
  pollSession,
  getSession,
  cancelSession,
  publicSession,
  assertOwnerBinding,
  normalizeOwnerKey,
  _reset,
  SESSION_RETENTION_MS,
};
