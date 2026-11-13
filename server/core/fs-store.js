'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

function fingerprintOf(filePath) {
  try {
    const st = fs.statSync(filePath, { bigint: true });
    return `${st.mtimeNs}:${st.size}:${st.ino}`;
  } catch (err) {
    return null;
  }
}

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

function readJson(filePath, options = {}) {
  const read = readJsonWithFingerprint(filePath, options);
  return read ? read.data : null;
}

function tmpNameFor(filePath, tag) {
  const unique = Math.random().toString(36).slice(2, 8);
  return `${filePath}.${process.pid}.${Date.now()}.${tag ? `${tag}.` : ''}${unique}.tmp`;
}

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

function verifySecretFileSync(filePath, mode = 0o600) {
  let stat = fs.lstatSync(filePath);
  if (stat.isFile() && (stat.mode & 0o077) === 0) return stat;
  if (stat.isFile()) {
    try {
      fs.chmodSync(filePath, mode);
    } catch (err) {
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
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (closeErr) {
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

function listJsonFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.json')
      )
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    return [];
  }
}

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
