'use strict';

/**
 * Stored browser cookies for the LiveLib scraper ("plan B").
 *
 * Background: LiveLib sits behind DDoS-Guard. On a clean IP the anonymous
 * bootstrap (`GET /reader/{username}/read` with a full browser header set)
 * hands out the `__ddg*` cookies and scraping works. On a flagged IP the same
 * request gets a JS challenge 403 within ~0.3 s, and no amount of server-side
 * work can solve it — only cookies minted by a real browser do.
 *
 * So the importer accepts a user-supplied `Cookie:` header, and this module is
 * its only storage:
 *
 *   cache-book/cookies/livelib-{userKey}.json   mode 0600, dir 0700
 *   { schemaVersion, source, userKey, cookieHeader, savedAt }
 *
 * Rules that must not be relaxed:
 *   - the header value is NEVER logged, echoed in an HTTP response, written to
 *     `imports/` snapshots or returned by the API — only `present`/`savedAt`/
 *     `count` may be reported;
 *   - the file is the single source of truth and is revalidated by fingerprint
 *     (`mtimeNs:size:ino`), so an external rotation is visible to a running
 *     server without a restart;
 *   - a cookie file is scoped to `(source, userKey)`: importing user B never
 *     reuses user A's cookies.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const bookCache = require('./book-cache');
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

/** Directory is created on first write: importing this module has no side effects. */
async function ensureDir() {
  await fsp.mkdir(COOKIES_DIR, { recursive: true, mode: 0o700 });
  try {
    await fsp.chmod(COOKIES_DIR, 0o700);
  } catch (err) {
    // Best effort: a shared cache dir may forbid chmod; the files are 0600.
  }
}

/* ------------------------------------------------------------------ */
/* Storage (fingerprint-invalidated, 0600)                             */
/* ------------------------------------------------------------------ */

const memory = new Map(); // "source:userKey" -> { data, path, fingerprint }

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

/**
 * Persist a cookie header for one profile. Returns status metadata only —
 * callers may log the result, never the header itself.
 */
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
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  // mode is applied at open() time, so the secret never exists world-readable
  // even for a moment; chmod again in case of an odd umask.
  await fsp.writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  await fsp.chmod(tmp, 0o600);
  await fsp.rename(tmp, filePath);
  await fsp.chmod(filePath, 0o600).catch(() => {});
  const fingerprint = bookCache.fingerprintOf(filePath);
  memory.set(memoryKey(source, key), { data, path: filePath, fingerprint });
  return {
    present: true,
    savedAt: data.savedAt,
    count: countCookies(cookieHeader),
    path: filePath,
  };
}

/** Stored header for one profile, or null. Callers must not log the value. */
function getCookies(source, userKey) {
  const entry = readStored(source, String(userKey == null ? '' : userKey).trim());
  if (!entry) return null;
  return {
    cookieHeader: entry.data.cookieHeader,
    savedAt: entry.data.savedAt || null,
    count: countCookies(entry.data.cookieHeader),
  };
}

/**
 * Masked status for API responses: `{ present, savedAt, count }` — never the
 * header, never cookie names (a name alone is harmless, but "only a presence
 * flag" is a simpler rule to keep than "these names are fine").
 */
function cookieStatus(source, userKey) {
  const stored = getCookies(source, userKey);
  if (!stored) return { present: false, savedAt: null, count: 0 };
  return { present: true, savedAt: stored.savedAt, count: stored.count };
}

/** Remove the stored header (idempotent). */
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

/** Test helper: drop the memory cache (files stay on disk). */
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
