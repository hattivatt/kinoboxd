'use strict';

/**
 * Epic token store (M6b).
 *
 * `cache-games/tokens/epic-<accountId>.json`, directory `0700`, file `0600`.
 * The token is **equivalent to a password** (ИГРЫ-АРХИТЕКТУРА §14.5): a
 * refresh token / device-auth secret grants access to the account, not just to
 * the library. Therefore this module deliberately does NOT use the generic
 * `game-cache.writeJsonAtomic` (which creates a temp file with the process
 * umask and only then renames it):
 *
 *   - the temp file is created with `O_CREAT|O_EXCL|O_NOFOLLOW` and mode 0600,
 *     so there is no window where the secret is world-readable (TOCTOU);
 *   - the final rename replaces a symlink instead of following it, and the
 *     resulting inode is verified to be a regular file with mode 0600;
 *   - a token file that was chmod-ed to 0644 by an operator is repaired on the
 *     next read (and the repair is logged without the value);
 *   - a symlink at the token path is never read (lstat + regular-file check).
 *
 * The value of a token is never logged, never returned from a public view and
 * never put into an error message. `redactTokens()` is the only shape allowed
 * outside this module (routes/status/UI).
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const gameCache = require('./game-cache');

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

/**
 * Create/verify the token directory. A symlinked directory is refused: the
 * games cache may itself be a symlink (worktree layout), but the `tokens/`
 * leaf must be a real directory owned by this process.
 */
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

/**
 * Atomic secret write. Never throws with a token value in the message; the
 * caller gets a stable `epic_token_store_error`.
 */
async function writeSecretAtomic(filePath, data) {
  await ensureTokensDir();
  const dir = path.dirname(filePath);
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  let handle = null;
  try {
    handle = await fsp.open(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      TOKEN_MODE
    );
    await handle.writeFile(JSON.stringify(data), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    // `rename` replaces a symlink entry instead of following it, so a planted
    // symlink cannot redirect the secret into an arbitrary file.
    await fsp.rename(tmp, filePath);
    await fsp.chmod(filePath, TOKEN_MODE);
    const stat = await fsp.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('not a regular file after rename');
    }
    if ((stat.mode & 0o077) !== 0) {
      await fsp.chmod(filePath, TOKEN_MODE);
      const repaired = await fsp.lstat(filePath);
      if ((repaired.mode & 0o077) !== 0) throw new Error('mode is still not 0600');
    }
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch (_) {
        /* best-effort */
      }
    }
    try {
      await fsp.unlink(tmp);
    } catch (_) {
      /* best-effort */
    }
    throw Object.assign(new Error('Не удалось сохранить Epic-токен (0600).'), {
      code: 'epic_token_store_error',
      cause: err && err.code ? err.code : undefined,
    });
  }
}

/** Read a token document; symlinks and non-regular files are refused. */
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
    // Repair an operator mistake without ever printing the content.
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

/**
 * Synchronous **summary** of a token document for read-only paths that cannot
 * await (the `/stats` builder is synchronous and polled by the UI). Returns the
 * same redacted shape as `redactTokens()` — presence booleans and dates, never
 * a token value. A symlink or a non-regular file is refused, exactly like the
 * async reader; the file mode is NOT repaired here (a read-only stats call must
 * not mutate the cache), so an operator mistake is still fixed on the next
 * async read.
 */
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

/**
 * Synchronous, redacted list of every token document. Read-only paths (the
 * owner-binding scan behind `/secondary-details/status` and the kick rule)
 * cannot await, and must never see a token value. Broken/symlinked files are
 * simply absent.
 */
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

/** All token documents, newest first. Internal use only (refresh/import). */
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

/**
 * The only public shape of a token document: presence booleans and expiry
 * timestamps. Never the values, not even masked fragments.
 */
function redactTokens(doc) {
  if (!doc) return null;
  return {
    source: 'epic',
    accountId: doc.accountId || null,
    displayName: doc.displayName || null,
    ownerKey: doc.ownerKey || null,
    // Old-format binding (pre-«ownerKey»): kept so the owner-binding self-heal
    // can recognise a token that was adopted by the GOG-style `ownerProfile`
    // field instead of silently treating it as unbound.
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
