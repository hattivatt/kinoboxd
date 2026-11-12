'use strict';

/**
 * Art store: the `cache-games/art/` layout, its TTLs and its two document
 * kinds.
 *
 *   `<key>.json` + `<key>.bin` — one relayed image per art request. The meta
 *     document carries `url`/`contentType`/`bytes`/`fetchedAt`, the bin the
 *     bytes. TTL is `TTL_MS` (7 days) and the cache is LRU-capped by
 *     `MAX_ART_FILES`/`MAX_ART_BYTES`, so a long-lived profile cannot grow it
 *     without bound. The meta mtime is the LRU clock.
 *   `resolved/<appid>.json` — one vertical-art verdict per appid
 *     (`resolveVerticalArt()` in `./resolve`). A positive answer is re-checked
 *     after 180 days (the store TTL), a negative one after 30 days, because
 *     Valve may publish the art later.
 *
 * Everything here is disk-only: no network, no domain policy. Writers are
 * atomic (`gameCache.writeJsonAtomic*`) and a read-only cache must never throw
 * into the caller.
 */

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
  // Post-2024 SKUs put the true vertical capsule under the per-asset hash of
  // `IStoreBrowseService.assets.library_capsule` and call the file
  // `library_capsule.jpg` (live 03.11.2026: 3669870 has this file 200/56 KB,
  // while every `library_600x900.jpg` path — hashed and legacy — 404s).
  library_capsule: 'library_capsule.jpg',
  small_capsule: 'capsule_231x87.jpg',
};

// Path/query token gate shared by the proxy route and the store-browse client:
// `appid` is digits only, `h` is a community-icon or asset hash.
const APPID_RE = /^[1-9]\d{0,9}$/;
const HASH_RE = /^[A-Za-z0-9]{1,64}$/;

// Resolve cache (`cache-games/art/resolved/<appid>.json`): one document per
// appid saying whether a vertical capsule exists and where. A positive answer
// is re-checked after 180 days (the store TTL); a negative one after 30 days,
// because Valve may publish the art later.
const RESOLVED_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const RESOLVED_NONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESOLVED_SCHEMA_VERSION = 1;
const ART_PATH = '/api/games/steam-art';

fs.mkdirSync(ART_DIR, { recursive: true });

// One key sanitiser for every cache (`core/fs-store`); art keys are built from
// already-validated `type`/`appid`/`hash` tokens, so the shared rules (trim,
// `[^\w.-]` -> `_`, 120-char cap) never change an existing file name here.
function artCacheKey(type, appid, hash) {
  return safeKey(`${type}-${appid}${hash ? `-${hash}` : ''}`);
}

/* ------------------------------------------------------------------ */
/* Vertical-art resolve (one document per appid)                       */
/* ------------------------------------------------------------------ */

function resolvedPath(appid) {
  return path.join(RESOLVED_DIR, `${safeKey(appid)}.json`);
}

function readResolvedArt(appid) {
  const hit = gameCache.readJsonWithFingerprint(resolvedPath(appid));
  const doc = hit && hit.data;
  if (!doc || Number(doc.schemaVersion) !== RESOLVED_SCHEMA_VERSION) return null;
  return doc;
}

/** `{ [appid]: resolvedDoc }`; missing/corrupt files are simply absent. */
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

/** Positive answer lives 180 days, `none` 30 days (Steam may publish later). */
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

/** Delete the least recently used entries until both caps hold. */
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
      // A half-written pair is garbage: remove both halves.
      try {
        fs.rmSync(metaFile, { force: true });
        fs.rmSync(binFile, { force: true });
      } catch (rmErr) {
        /* best effort */
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
      /* best effort */
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
  // A unique temp name: two concurrent misses for the same key must not
  // rename each other's file away.
  const tmp = `${binPath(key)}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, fetched.buffer);
  fs.renameSync(tmp, binPath(key));
}

/** Slide the LRU clock of a served entry (the meta mtime is the key order). */
function touchEntry(key) {
  try {
    const now = new Date();
    fs.utimesSync(metaPath(key), now, now);
  } catch (err) {
    /* a read-only cache must not break the relay */
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
