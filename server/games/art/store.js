'use strict';

const fs = require('fs');
const path = require('path');

const gameCache = require('../game-cache');
const { safeKey } = require('../../core/fs-store');

const ART_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'art');
const RESOLVED_DIR = path.join(ART_DIR, 'resolved');

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ART_FILES = 600;
const MAX_ART_BYTES = 64 * 1024 * 1024;
const MAX_ART_ENTRY_BYTES = 8 * 1024 * 1024;

const TYPES = new Set(['header', 'capsule', 'library', 'library_capsule', 'small_capsule', 'icon']);
const FILE_BY_TYPE = {
  header: 'header.jpg',
  capsule: 'capsule_231x87.jpg',
  library: 'library_600x900.jpg',
  library_capsule: 'library_capsule.jpg',
  small_capsule: 'capsule_231x87.jpg',
};

const APPID_RE = /^[1-9]\d{0,9}$/;
const HASH_RE = /^[A-Za-z0-9]{1,64}$/;

const RESOLVED_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const RESOLVED_NONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESOLVED_SCHEMA_VERSION = 1;
const ART_PATH = '/api/games/steam-art';

fs.mkdirSync(ART_DIR, { recursive: true });

function artCacheKey(type, appid, hash) {
  return safeKey(`${type}-${appid}${hash ? `-${hash}` : ''}`);
}

function resolvedPath(appid) {
  return path.join(RESOLVED_DIR, `${safeKey(appid)}.json`);
}

function readResolvedArt(appid) {
  const hit = gameCache.readJsonWithFingerprint(resolvedPath(appid));
  const doc = hit && hit.data;
  if (!doc || Number(doc.schemaVersion) !== RESOLVED_SCHEMA_VERSION) return null;
  return doc;
}

function listResolvedArt(appids) {
  const result = {};
  if (!Array.isArray(appids)) return result;
  for (const appid of appids) {
    if (appid == null) continue;
    const key = String(appid);
    if (result[key]) continue;
    const doc = readResolvedArt(appid);
    if (doc) result[key] = doc;
  }
  return result;
}

async function saveResolvedArt(doc) {
  return gameCache.writeJsonAtomic(resolvedPath(doc.appid), doc);
}

function resolvedFresh(doc, now = Date.now()) {
  if (!doc || !doc.resolvedAt) return false;
  const ts = Date.parse(doc.resolvedAt);
  if (!Number.isFinite(ts)) return false;
  const ttl = doc.kind === 'none' ? RESOLVED_NONE_TTL_MS : RESOLVED_TTL_MS;
  const age = now - ts;
  return age >= 0 && age < ttl;
}

function artProxyUrlFor(doc) {
  if (!doc || doc.kind === 'none') return null;
  if (doc.kind === 'sgdb') return doc.url || null;
  if (doc.kind === 'library-legacy') return `${ART_PATH}/library/${doc.appid}`;
  if (doc.kind === 'library-hashed') {
    const type = doc.proxyType || 'library';
    return `${ART_PATH}/${type}/${doc.appid}?h=${doc.h}`;
  }
  return null;
}

function metaPath(key) {
  return path.join(ART_DIR, `${key}.json`);
}

function binPath(key) {
  return path.join(ART_DIR, `${key}.bin`);
}

function readMeta(key) {
  const hit = gameCache.readJsonWithFingerprint(metaPath(key));
  return (hit && hit.data) || null;
}

function readEntry(key, now = Date.now()) {
  const meta = readMeta(key);
  if (!meta || !meta.fetchedAt || !meta.contentType) return null;
  let buffer;
  try {
    buffer = fs.readFileSync(binPath(key));
  } catch (err) {
    return null;
  }
  const fetchedAt = Date.parse(meta.fetchedAt);
  const fresh = Number.isFinite(fetchedAt) && now - fetchedAt < TTL_MS;
  return {
    meta,
    buffer,
    fresh,
    contentType: meta.contentType,
    bytes: buffer.length,
  };
}

function pruneArtCache(options = {}) {
  const maxFiles =
    Number.isFinite(Number(options.maxFiles)) && Number(options.maxFiles) >= 0
      ? Math.floor(Number(options.maxFiles))
      : MAX_ART_FILES;
  const maxBytes =
    Number.isFinite(Number(options.maxBytes)) && Number(options.maxBytes) >= 0
      ? Number(options.maxBytes)
      : MAX_ART_BYTES;
  let names;
  try {
    names = fs.readdirSync(ART_DIR);
  } catch (err) {
    return { removed: 0, files: 0, bytes: 0 };
  }
  const entries = [];
  let totalBytes = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const key = name.slice(0, -5);
    const metaFile = path.join(ART_DIR, name);
    const binFile = binPath(key);
    let stat;
    let binStat;
    try {
      stat = fs.statSync(metaFile);
      binStat = fs.statSync(binFile);
    } catch (err) {
      try {
        fs.rmSync(metaFile, { force: true });
        fs.rmSync(binFile, { force: true });
      } catch (rmErr) {
      }
      continue;
    }
    entries.push({ key, at: stat.mtimeMs, bytes: binStat.size });
    totalBytes += binStat.size;
  }
  entries.sort((a, b) => a.at - b.at);
  let removed = 0;
  let files = entries.length;
  while (entries.length && (files > maxFiles || totalBytes > maxBytes)) {
    const victim = entries.shift();
    try {
      fs.rmSync(metaPath(victim.key), { force: true });
      fs.rmSync(binPath(victim.key), { force: true });
    } catch (err) {
    }
    totalBytes -= victim.bytes;
    files -= 1;
    removed += 1;
  }
  return { removed, files, bytes: totalBytes };
}

function writeEntry(key, fetched) {
  fs.mkdirSync(ART_DIR, { recursive: true });
  gameCache.writeJsonAtomicSync(metaPath(key), {
    schemaVersion: 1,
    key,
    url: fetched.url,
    contentType: fetched.contentType,
    bytes: fetched.buffer.length,
    fetchedAt: new Date().toISOString(),
  });
  const tmp = `${binPath(key)}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, fetched.buffer);
  fs.renameSync(tmp, binPath(key));
}

function touchEntry(key) {
  try {
    const now = new Date();
    fs.utimesSync(metaPath(key), now, now);
  } catch (err) {
  }
}

module.exports = {
  ART_DIR,
  RESOLVED_DIR,
  TTL_MS,
  RESOLVED_TTL_MS,
  RESOLVED_NONE_TTL_MS,
  RESOLVED_SCHEMA_VERSION,
  ART_PATH,
  MAX_ART_FILES,
  MAX_ART_BYTES,
  MAX_ART_ENTRY_BYTES,
  TYPES,
  FILE_BY_TYPE,
  APPID_RE,
  HASH_RE,
  artCacheKey,
  readEntry,
  writeEntry,
  pruneArtCache,
  touchEntry,
  readResolvedArt,
  listResolvedArt,
  saveResolvedArt,
  resolvedFresh,
  artProxyUrlFor,
};
