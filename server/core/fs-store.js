'use strict';

/**
 * Durable JSON documents on disk: atomic writes and fingerprint-checked reads.
 *
 * Why a fingerprint and not just `JSON.parse`: a running server must notice a
 * file written by another process (backfill, rematch, resolve timer) without a
 * restart, and it must never pair parsed data with a fingerprint from another
 * version of the file. `mtimeNs:size:ino` is cheap enough for the hot path.
 *
 * The code is lifted from `server/cache.js` and `server/books/book-cache.js`,
 * which carried the same two functions. `label` only prefixes the corrupt-JSON
 * warning so existing logs stay recognisable.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/** Same identity everywhere: inode + size + mtime(ns); null when absent. */
function fingerprintOf(filePath) {
  try {
    const st = fs.statSync(filePath, { bigint: true });
    return `${st.mtimeNs}:${st.size}:${st.ino}`;
  } catch (err) {
    return null;
  }
}

/**
 * Read + parse one JSON file together with the fingerprint of the exact bytes
 * that were parsed. A writer replacing the file mid-read makes the fingerprints
 * differ; retry once so data and fingerprint always describe the same version.
 * Returns `{ data, fingerprint }` or `null` for missing/corrupt files.
 */
function readJsonWithFingerprint(filePath, options = {}) {
  const label = options.label || 'fs-store';
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = fingerprintOf(filePath);
      if (before === null) return null;
      const raw = fs.readFileSync(filePath, 'utf8');
      const after = fingerprintOf(filePath);
      if (after === null) return null;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        console.warn(`[${label}] corrupt JSON in ${filePath}: ${err.message}`);
        return null;
      }
      if (after === before) return { data: parsed, fingerprint: after };
    }
    return null;
  } catch (err) {
    return null;
  }
}

/** Parsed document or null (missing/corrupt). */
function readJson(filePath, options = {}) {
  const read = readJsonWithFingerprint(filePath, options);
  return read ? read.data : null;
}

/** Unique sibling name: two concurrent writers must not share a tmp file. */
function tmpNameFor(filePath, tag) {
  const unique = Math.random().toString(36).slice(2, 8);
  return `${filePath}.${process.pid}.${Date.now()}.${tag ? `${tag}.` : ''}${unique}.tmp`;
}

/** Atomic replace: write a sibling tmp file, then rename over the target. */
async function writeJsonAtomic(filePath, data, options = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = tmpNameFor(filePath);
  try {
    await fsp.writeFile(tmp, JSON.stringify(data, null, options.space), options.encoding || 'utf8');
    await fsp.rename(tmp, filePath);
  } catch (err) {
    removeQuietly(tmp);
    throw err;
  }
  return fingerprintOf(filePath);
}

function writeJsonAtomicSync(filePath, data, options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = tmpNameFor(filePath, 'flush');
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, options.space), options.encoding || 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    removeQuietly(tmp);
    throw err;
  }
  return fingerprintOf(filePath);
}

/**
 * Verify a secret file after the rename: it must be a regular file without
 * group/other permission bits. A wrong mode is repaired once (best effort) and
 * then re-checked; a symlink/directory or a repair that did not stick throws
 * `secret_mode_error`, so the writer cannot report success for a world-readable
 * secret.
 */
function verifySecretFileSync(filePath, mode = 0o600) {
  let stat = fs.lstatSync(filePath);
  if (stat.isFile() && (stat.mode & 0o077) === 0) return stat;
  if (stat.isFile()) {
    try {
      fs.chmodSync(filePath, mode);
    } catch (err) {
      /* re-checked below; a read-only FS must surface as an error */
    }
    stat = fs.lstatSync(filePath);
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw Object.assign(
      new Error(`secret file is not a regular ${mode.toString(8)} file: ${filePath}`),
      { code: 'secret_mode_error' }
    );
  }
  return stat;
}

/**
 * Atomic write of a secret document: directory 0700, file 0600.
 *
 * The tmp file is created with `O_CREAT|O_EXCL|O_NOFOLLOW` and the final mode,
 * so (a) the payload is never world-readable, even between `open` and
 * `rename`, and (b) a symlink planted at the tmp name is not followed.
 * `rename` replaces a symlink at the target instead of following it, so a
 * planted target link cannot redirect the secret either. A failed write leaves
 * no tmp file behind.
 */
function writeSecretAtomicSync(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = tmpNameFor(filePath);
  let fd = null;
  try {
    fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600
    );
    fs.writeFileSync(fd, JSON.stringify(data), 'utf8');
    fs.fchmodSync(fd, 0o600);
    // Same durability the Epic writer had before U1: the bytes are on disk
    // before the rename makes them visible under the final name.
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (closeErr) {
        /* best-effort */
      }
    }
    removeQuietly(tmp);
    throw err;
  }
  verifySecretFileSync(filePath, 0o600);
  return fingerprintOf(filePath);
}

function ensureDir(dir, options = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: options.mode });
  return dir;
}

function ensureDirs(dirs) {
  for (const dir of dirs) if (dir) ensureDir(dir);
}

function removeQuietly(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    return false;
  }
}

/** JSON documents in one directory (names only, sorted, no subdirectories). */
function listJsonFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      // A worktree cache is a symlink to the main tree (AGENTS §3.2), and a
      // link to a cached document is still a cached document: accept both.
      .filter(
        (entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.json')
      )
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    return [];
  }
}

/** Make an arbitrary user key safe for a file name (no path traversal). */
function safeKey(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/[^\w.-]/g, '_')
    .slice(0, 120);
}

module.exports = {
  fingerprintOf,
  readJsonWithFingerprint,
  readJson,
  writeJsonAtomic,
  writeJsonAtomicSync,
  writeSecretAtomicSync,
  verifySecretFileSync,
  ensureDir,
  ensureDirs,
  removeQuietly,
  listJsonFiles,
  safeKey,
};
