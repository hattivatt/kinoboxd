'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const bookCache = require('./book-cache');
const fsStore = require('../core/fs-store');
const {
  MAX_HEADER_LENGTH,
  CookieError,
  normalizeCookieHeader,
  parseCookieHeader,
  countCookies,
} = require('./cookie-header');

const COOKIES_DIR = path.join(bookCache.BOOK_CACHE_DIR, 'cookies');

const SCHEMA_VERSION = 1;
const SUPPORTED_SOURCES = ['livelib'];

function cookiePath(source, userKey) {
  return path.join(
    COOKIES_DIR,
    `${bookCache.safeKey(source)}-${bookCache.safeKey(userKey)}.json`
  );
}

async function ensureDir() {
  await fsp.mkdir(COOKIES_DIR, { recursive: true, mode: 0o700 });
  try {
    await fsp.chmod(COOKIES_DIR, 0o700);
  } catch (err) {
  }
}

const memory = new Map();

function memoryKey(source, userKey) {
  return `${source}:${userKey}`;
}

function readStored(source, userKey) {
  const filePath = cookiePath(source, userKey);
  const key = memoryKey(source, userKey);
  const cached = memory.get(key);
  if (cached && bookCache.fingerprintOf(cached.path) === cached.fingerprint) {
    return cached;
  }
  if (cached) memory.delete(key);
  const found = bookCache.readJsonWithFingerprint(filePath);
  if (!found || !found.data || typeof found.data.cookieHeader !== 'string') return null;
  const entry = { data: found.data, path: filePath, fingerprint: found.fingerprint };
  memory.set(key, entry);
  return entry;
}

async function saveCookies(source, userKey, rawHeader, options = {}) {
  if (!SUPPORTED_SOURCES.includes(source)) {
    throw new CookieError(
      `Cookie-хранилище поддерживает только: ${SUPPORTED_SOURCES.join(', ')}.`,
      'unsupported_cookie_source'
    );
  }
  const key = String(userKey == null ? '' : userKey).trim();
  if (!/^[\w.-]{1,120}$/.test(key)) {
    throw new CookieError('Некорректное имя пользователя LiveLib.', 'invalid_user_key');
  }
  const cookieHeader = normalizeCookieHeader(rawHeader);
  const data = {
    schemaVersion: SCHEMA_VERSION,
    source,
    userKey: key,
    cookieHeader,
    savedAt: options.now || new Date().toISOString(),
  };
  const filePath = cookiePath(source, key);
  await ensureDir();
  const fingerprint = fsStore.writeSecretAtomicSync(filePath, data);
  memory.set(memoryKey(source, key), { data, path: filePath, fingerprint });
  return {
    present: true,
    savedAt: data.savedAt,
    count: countCookies(cookieHeader),
    path: filePath,
  };
}

function getCookies(source, userKey) {
  const entry = readStored(source, String(userKey == null ? '' : userKey).trim());
  if (!entry) return null;
  return {
    cookieHeader: entry.data.cookieHeader,
    savedAt: entry.data.savedAt || null,
    count: countCookies(entry.data.cookieHeader),
  };
}

function cookieStatus(source, userKey) {
  const stored = getCookies(source, userKey);
  if (!stored) return { present: false, savedAt: null, count: 0 };
  return { present: true, savedAt: stored.savedAt, count: stored.count };
}

async function clearCookies(source, userKey) {
  const key = String(userKey == null ? '' : userKey).trim();
  const filePath = cookiePath(source, key);
  memory.delete(memoryKey(source, key));
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

function clearMemory() {
  memory.clear();
}

module.exports = {
  COOKIES_DIR,
  SCHEMA_VERSION,
  MAX_HEADER_LENGTH,
  SUPPORTED_SOURCES,
  CookieError,
  cookiePath,
  normalizeCookieHeader,
  parseCookieHeader,
  countCookies,
  saveCookies,
  getCookies,
  cookieStatus,
  clearCookies,
  clearMemory,
};
