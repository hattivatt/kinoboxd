'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const gameCache = require('./game-cache');
const fsStore = require('../core/fs-store');

const ACCOUNT_RE = /^[A-Za-z0-9._-]{1,80}$/;

const TOKENS_DIR = process.env.KINOBOXD_EPIC_TOKENS_DIR
  ? path.resolve(process.env.KINOBOXD_EPIC_TOKENS_DIR)
  : path.join(gameCache.GAMES_CACHE_DIR, 'tokens');

const TOKEN_MODE = 0o600;
const DIR_MODE = 0o700;

function tokenPath(accountId) {
  const value = String(accountId == null ? '' : accountId).trim();
  if (!ACCOUNT_RE.test(value) || value === '.' || value === '..') {
    throw Object.assign(new Error('Некорректный Epic accountId для token store.'), {
      code: 'epic_invalid_account',
    });
  }
  return path.join(TOKENS_DIR, `epic-${value}.json`);
}

async function ensureTokensDir() {
  await fsp.mkdir(TOKENS_DIR, { recursive: true, mode: DIR_MODE });
  const stat = await fsp.lstat(TOKENS_DIR);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw Object.assign(new Error('Epic token store: tokens path is not a real directory.'), {
      code: 'epic_token_store_error',
    });
  }
  if ((stat.mode & 0o077) !== 0) {
    await fsp.chmod(TOKENS_DIR, DIR_MODE);
  }
}

function ensureTokensDirSync() {
  fs.mkdirSync(TOKENS_DIR, { recursive: true, mode: DIR_MODE });
  const stat = fs.lstatSync(TOKENS_DIR);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw Object.assign(new Error('Epic token store: tokens path is not a real directory.'), {
      code: 'epic_token_store_error',
    });
  }
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(TOKENS_DIR, DIR_MODE);
}

async function writeSecretAtomic(filePath, data) {
  await ensureTokensDir();
  try {
    fsStore.writeSecretAtomicSync(filePath, data);
  } catch (err) {
    throw Object.assign(new Error('Не удалось сохранить Epic-токен (0600).'), {
      code: 'epic_token_store_error',
      cause: err && err.code ? err.code : undefined,
    });
  }
}

async function readTokenDoc(accountId) {
  const filePath = tokenPath(accountId);
  let stat;
  try {
    stat = await fsp.lstat(filePath);
  } catch (err) {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    console.warn('[epic-tokens] token path is not a regular file — ignored');
    return null;
  }
  if ((stat.mode & 0o077) !== 0) {
    try {
      await fsp.chmod(filePath, TOKEN_MODE);
      console.warn('[epic-tokens] token file mode repaired to 0600');
    } catch (err) {
      console.warn('[epic-tokens] token file is readable by group/other and could not be fixed');
    }
  }
  let raw;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    return null;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    console.warn('[epic-tokens] token file is corrupt JSON — ignored');
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  if (String(doc.accountId || '') !== String(accountId)) return null;
  return doc;
}

function normalizeDoc(doc) {
  const accountId = String(doc && doc.accountId ? doc.accountId : '').trim();
  if (!ACCOUNT_RE.test(accountId)) {
    throw Object.assign(new Error('Epic token document needs a valid accountId.'), {
      code: 'epic_invalid_account',
    });
  }
  const nowIso = new Date().toISOString();
  const deviceAuth =
    doc.deviceAuth && typeof doc.deviceAuth === 'object'
      ? {
          deviceId: doc.deviceAuth.deviceId == null ? null : String(doc.deviceAuth.deviceId),
          secret: doc.deviceAuth.secret == null ? null : String(doc.deviceAuth.secret),
        }
      : null;
  return {
    schemaVersion: 1,
    source: 'epic',
    accountId,
    displayName: doc.displayName == null ? null : String(doc.displayName),
    ownerKey: doc.ownerKey == null ? null : String(doc.ownerKey),
    accessToken: doc.accessToken == null ? null : String(doc.accessToken),
    refreshToken: doc.refreshToken == null ? null : String(doc.refreshToken),
    accessExpiresAt: doc.accessExpiresAt || null,
    refreshExpiresAt: doc.refreshExpiresAt || null,
    tokenType: doc.tokenType || null,
    clientId: doc.clientId || null,
    deviceAuth,
    authMethod: doc.authMethod || 'device_code',
    lastAuthError: doc.lastAuthError || null,
    lastAuthErrorAt: doc.lastAuthErrorAt || null,
    createdAt: doc.createdAt || nowIso,
    updatedAt: nowIso,
  };
}

async function saveTokens(doc) {
  const payload = normalizeDoc(doc);
  await writeSecretAtomic(tokenPath(payload.accountId), payload);
  return redactTokens(payload);
}

async function getTokens(accountId) {
  return readTokenDoc(accountId);
}

function readTokenSummarySync(accountId) {
  let filePath;
  try {
    filePath = tokenPath(accountId);
  } catch (err) {
    return null;
  }
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (err) {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  if (String(doc.accountId || '') !== String(accountId)) return null;
  return redactTokens(doc);
}

function listTokenSummariesSync() {
  let names = [];
  try {
    names = fs.readdirSync(TOKENS_DIR);
  } catch (err) {
    return [];
  }
  const out = [];
  for (const name of names) {
    const match = /^epic-(.+)\.json$/.exec(name);
    if (!match) continue;
    const summary = readTokenSummarySync(match[1]);
    if (summary) out.push(summary);
  }
  return out;
}

async function listTokenDocs() {
  let names = [];
  try {
    names = await fsp.readdir(TOKENS_DIR);
  } catch (err) {
    return [];
  }
  const docs = [];
  for (const name of names) {
    if (!/^epic-.+\.json$/.test(name)) continue;
    const accountId = name.slice('epic-'.length, -'.json'.length);
    const doc = await readTokenDoc(accountId);
    if (doc) docs.push(doc);
  }
  docs.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return docs;
}

async function deleteTokens(accountId) {
  const filePath = tokenPath(accountId);
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw Object.assign(new Error('Не удалось удалить Epic-токен.'), {
      code: 'epic_token_store_error',
    });
  }
}

function redactTokens(doc) {
  if (!doc) return null;
  return {
    source: 'epic',
    accountId: doc.accountId || null,
    displayName: doc.displayName || null,
    ownerKey: doc.ownerKey || null,
    ownerProfile: doc.ownerProfile || null,
    authMethod: doc.authMethod || null,
    hasAccessToken: Boolean(doc.accessToken),
    hasRefreshToken: Boolean(doc.refreshToken),
    hasDeviceAuth: Boolean(doc.deviceAuth && doc.deviceAuth.secret),
    accessExpiresAt: doc.accessExpiresAt || null,
    refreshExpiresAt: doc.refreshExpiresAt || null,
    lastAuthError: doc.lastAuthError || null,
    lastAuthErrorAt: doc.lastAuthErrorAt || null,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

async function listTokenAccounts() {
  return (await listTokenDocs()).map(redactTokens);
}

module.exports = {
  TOKENS_DIR,
  TOKEN_MODE,
  DIR_MODE,
  tokenPath,
  ensureTokensDir,
  ensureTokensDirSync,
  writeSecretAtomic,
  saveTokens,
  getTokens,
  readTokenSummarySync,
  listTokenSummariesSync,
  listTokenDocs,
  listTokenAccounts,
  deleteTokens,
  redactTokens,
};
