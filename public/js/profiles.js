/* Local profile registry (IndexedDB) with a memory-only degradation path.
 *
 * KinoPoisk is the only profile source. A Letterboxd archive is an attachment
 * on the server, not a registry entry: boot removes legacy `type:'lb'`
 * profiles and their `stats`/`files` records.
 *
 * Stores (DB «kinoboxd», version 1):
 *   profiles  keyPath id  { id, type:'kp', label, kpUrl, kpUserId, kpNick,
 *                           uploadId, savedAt, source }
 *   files     keyPath id  { id, name, type, blob, savedAt }   (legacy LB ZIPs)
 *   stats     keyPath id  { id, stats, savedAt, bytes }
 *
 * When IndexedDB is missing/blocked (private mode, hardened browser) every
 * operation transparently falls back to in-memory maps. main.js keeps its
 * existing localStorage session (kinoboxd.session.v1) working either way.
 */

const DB_NAME = 'kinoboxd';
const DB_VERSION = 1;
const PROFILE_STORE = 'profiles';
const FILE_STORE = 'files';
const STATS_STORE = 'stats';

export const MAX_PROFILES = 6;
export const MAX_STATS_JSON = 12 * 1024 * 1024;

let mode = 'pending'; // 'pending' | 'idb' | 'memory'
let dbPromise = null;
let activeId = null;

const memory = {
  profiles: new Map(),
  files: new Map(),
  stats: new Map(),
};

/* =========================================================
   IndexedDB plumbing
   ========================================================= */

function idbGlobal() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB ? indexedDB : null;
  } catch {
    return null;
  }
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let request;
    try {
      const factory = idbGlobal();
      if (!factory) throw new Error('indexedDB unavailable');
      request = factory.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('indexedDB open timeout'));
    }, 5000);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fn(value); } catch { /* ignore */ }
    };

    request.onupgradeneeded = () => {
      try {
        const db = request.result;
        if (!db.objectStoreNames.contains(PROFILE_STORE)) {
          db.createObjectStore(PROFILE_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(FILE_STORE)) {
          db.createObjectStore(FILE_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STATS_STORE)) {
          db.createObjectStore(STATS_STORE, { keyPath: 'id' });
        }
      } catch {
        /* a broken upgrade will surface through onerror/onblocked */
      }
    };

    request.onsuccess = () => finish(resolve, request.result);
    request.onerror = () => finish(reject, request.error || new Error('indexedDB open failed'));
    request.onblocked = () => finish(reject, new Error('indexedDB blocked'));
  });
  return dbPromise;
}

async function tx(storeNames, transactionMode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(storeNames, transactionMode);
    } catch (error) {
      reject(error);
      return;
    }
    let value;
    try {
      value = work(transaction);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = () => reject(transaction.error || new Error('indexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('indexedDB transaction aborted'));
  });
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexedDB request failed'));
  });
}

/** Open the database once; never throws — falls back to memory mode. */
export async function ready() {
  if (mode === 'idb' || mode === 'memory') {
    return { available: mode === 'idb', mode };
  }
  try {
    await openDb();
    mode = 'idb';
  } catch {
    mode = 'memory';
  }
  return { available: mode === 'idb', mode };
}

export function isAvailable() {
  return mode === 'idb';
}

export function storageMode() {
  return mode;
}

export function setActiveId(id) {
  activeId = typeof id === 'string' && id ? id : null;
}

export function getActiveId() {
  return activeId;
}

/* =========================================================
   records
   ========================================================= */

function fallbackId(record) {
  if (record.kpUserId) return `kp:${record.kpUserId}`;
  return `kp:legacy:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function labelFor(record) {
  const who = record.kpNick || (record.kpUserId ? `user ${record.kpUserId}` : 'профиль');
  return `Кинопоиск · ${who}`;
}

function normalizeRecord(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const record = {
    id: '',
    type: 'kp',
    label: '',
    kpUrl: typeof raw.kpUrl === 'string' && raw.kpUrl ? raw.kpUrl : null,
    kpUserId: raw.kpUserId != null && String(raw.kpUserId) ? String(raw.kpUserId) : null,
    kpNick: raw.kpNick != null && String(raw.kpNick) ? String(raw.kpNick) : null,
    uploadId: typeof raw.uploadId === 'string' && raw.uploadId ? raw.uploadId : null,
    savedAt: Number.isFinite(Number(raw.savedAt)) ? Number(raw.savedAt) : Date.now(),
    source: raw.source && typeof raw.source === 'object'
      ? { ...raw.source }
      : { type: 'kinopoisk' },
  };
  record.id = typeof raw.id === 'string' && raw.id ? raw.id : fallbackId(record);
  record.label = typeof raw.label === 'string' && raw.label.trim()
    ? raw.label.trim()
    : labelFor(record);
  return record;
}

function bySavedDesc(a, b) {
  return (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0);
}

/* =========================================================
   registry
   ========================================================= */

export async function listProfiles() {
  await ready();
  if (mode === 'idb') {
    try {
      const records = await tx(PROFILE_STORE, 'readonly', (transaction) => requestValue(transaction.objectStore(PROFILE_STORE).getAll()));
      return (Array.isArray(records) ? records : []).sort(bySavedDesc);
    } catch {
      mode = 'memory';
    }
  }
  return Array.from(memory.profiles.values()).sort(bySavedDesc);
}

export async function getProfile(id) {
  if (!id) return null;
  await ready();
  if (mode === 'idb') {
    try {
      const record = await tx(PROFILE_STORE, 'readonly', (transaction) => requestValue(transaction.objectStore(PROFILE_STORE).get(id)));
      return record || null;
    } catch {
      mode = 'memory';
    }
  }
  return memory.profiles.get(id) || null;
}

async function trimProfiles(keepId) {
  const records = await listProfiles();
  let excess = records.length - MAX_PROFILES;
  if (excess <= 0) return;
  const removable = records
    .filter((record) => record.id !== keepId)
    .sort((a, b) => (Number(a.savedAt) || 0) - (Number(b.savedAt) || 0));
  for (const victim of removable) {
    if (excess <= 0) break;
    await removeProfile(victim.id);
    excess -= 1;
  }
}

export async function saveProfile(input, { keepId = null } = {}) {
  await ready();
  const record = normalizeRecord(input);
  const protectedId = keepId || activeId || record.id;

  if (mode === 'idb') {
    try {
      await tx(PROFILE_STORE, 'readwrite', (transaction) => {
        transaction.objectStore(PROFILE_STORE).put(record);
      });
    } catch {
      mode = 'memory';
    }
  }
  if (mode === 'memory') memory.profiles.set(record.id, record);

  await trimProfiles(protectedId);
  return record;
}

export async function removeProfile(id) {
  if (!id) return false;
  await ready();
  memory.profiles.delete(id);
  memory.stats.delete(id);
  memory.files.delete(id);

  if (mode === 'idb') {
    try {
      await tx([PROFILE_STORE, STATS_STORE, FILE_STORE], 'readwrite', (transaction) => {
        transaction.objectStore(PROFILE_STORE).delete(id);
        transaction.objectStore(STATS_STORE).delete(id);
        transaction.objectStore(FILE_STORE).delete(id);
      });
    } catch {
      mode = 'memory';
    }
  }
  return true;
}

export async function clearProfiles() {
  await ready();
  memory.profiles.clear();
  memory.stats.clear();
  memory.files.clear();
  if (mode === 'idb') {
    try {
      await tx([PROFILE_STORE, STATS_STORE, FILE_STORE], 'readwrite', (transaction) => {
        transaction.objectStore(PROFILE_STORE).clear();
        transaction.objectStore(STATS_STORE).clear();
        transaction.objectStore(FILE_STORE).clear();
      });
    } catch {
      mode = 'memory';
    }
  }
}

/* =========================================================
   legacy Letterboxd standalone profiles (soft migration)
   ========================================================= */

function isLegacyLbId(id) {
  return typeof id === 'string' && id.startsWith('lb:');
}

/**
 * Letterboxd profiles no longer exist as registry entities. Called once at
 * boot: delete every non-KinoPoisk profile together with its cached stats and
 * stored ZIP. Returns the number of removed profile records.
 */
export async function migrateLetterboxdProfiles() {
  await ready();
  let removed = 0;

  const records = await listProfiles();
  for (const record of records) {
    if (record && record.type === 'kp') continue;
    await removeProfile(record.id);
    removed += 1;
  }

  // Orphaned payloads from an older registry version (profile row already
  // gone, stats/files keys left behind).
  for (const id of Array.from(memory.stats.keys())) {
    if (isLegacyLbId(id)) memory.stats.delete(id);
  }
  for (const id of Array.from(memory.files.keys())) {
    if (isLegacyLbId(id)) memory.files.delete(id);
  }
  if (mode === 'idb') {
    try {
      const statsRecords = await tx(STATS_STORE, 'readonly', (transaction) => (
        requestValue(transaction.objectStore(STATS_STORE).getAll())
      ));
      const fileRecords = await tx(FILE_STORE, 'readonly', (transaction) => (
        requestValue(transaction.objectStore(FILE_STORE).getAll())
      ));
      const statsIds = (Array.isArray(statsRecords) ? statsRecords : [])
        .map((record) => record && record.id)
        .filter(isLegacyLbId);
      const fileIds = (Array.isArray(fileRecords) ? fileRecords : [])
        .map((record) => record && record.id)
        .filter(isLegacyLbId);
      if (statsIds.length || fileIds.length) {
        await tx([STATS_STORE, FILE_STORE], 'readwrite', (transaction) => {
          for (const id of statsIds) transaction.objectStore(STATS_STORE).delete(id);
          for (const id of fileIds) transaction.objectStore(FILE_STORE).delete(id);
        });
      }
    } catch {
      mode = 'memory';
    }
  }

  return removed;
}

/* =========================================================
   stats cache (last successful payload per profile)
   ========================================================= */

export async function getStatsCache(id) {
  if (!id) return null;
  await ready();
  if (mode === 'idb') {
    try {
      const record = await tx(STATS_STORE, 'readonly', (transaction) => requestValue(transaction.objectStore(STATS_STORE).get(id)));
      if (record && record.stats) return record;
      return null;
    } catch {
      mode = 'memory';
    }
  }
  return memory.stats.get(id) || null;
}

export async function saveStatsCache(id, stats) {
  if (!id || !stats || typeof stats !== 'object') return false;

  let raw;
  try {
    raw = JSON.stringify(stats);
  } catch {
    return false;
  }
  if (!raw || raw.length > MAX_STATS_JSON) {
    // Too large to cache: drop any previous copy so a switch never shows stale
    // data instead of re-fetching from the server.
    await removeStatsCache(id);
    return false;
  }

  const record = { id, stats, savedAt: Date.now(), bytes: raw.length };
  await ready();
  memory.stats.set(id, record);

  if (mode === 'idb') {
    try {
      await tx(STATS_STORE, 'readwrite', (transaction) => {
        transaction.objectStore(STATS_STORE).put(record);
      });
      return true;
    } catch {
      // Quota or a locked database: the current session can still use the
      // in-memory copy, but we report that this was not persisted.
      return false;
    }
  }
  return true;
}

export async function removeStatsCache(id) {
  if (!id) return;
  memory.stats.delete(id);
  await ready();
  if (mode !== 'idb') return;
  try {
    await tx(STATS_STORE, 'readwrite', (transaction) => {
      transaction.objectStore(STATS_STORE).delete(id);
    });
  } catch {
    mode = 'memory';
  }
}

/* =========================================================
   ZIP bytes (Letterboxd re-import after a server restart)
   ========================================================= */

export async function saveFile(id, file) {
  if (!id || !file) return false;
  await ready();

  let blob = file;
  try {
    if (!(file instanceof Blob)) blob = new Blob([file], { type: 'application/zip' });
  } catch {
    return false;
  }

  const record = {
    id,
    name: typeof file.name === 'string' && file.name ? file.name : 'letterboxd-export.zip',
    type: typeof file.type === 'string' && file.type ? file.type : 'application/zip',
    blob,
    savedAt: Date.now(),
  };
  memory.files.set(id, record);

  if (mode === 'idb') {
    try {
      await tx(FILE_STORE, 'readwrite', (transaction) => {
        transaction.objectStore(FILE_STORE).put(record);
      });
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

export async function getFile(id) {
  if (!id) return null;
  await ready();

  let record = memory.files.get(id) || null;
  if (!record && mode === 'idb') {
    try {
      record = await tx(FILE_STORE, 'readonly', (transaction) => requestValue(transaction.objectStore(FILE_STORE).get(id)));
    } catch {
      mode = 'memory';
    }
  }
  if (!record || !record.blob) return null;

  try {
    return new File([record.blob], record.name || 'letterboxd-export.zip', {
      type: record.type || 'application/zip',
      lastModified: record.savedAt || Date.now(),
    });
  } catch {
    return record.blob;
  }
}

export async function hasFile(id) {
  if (!id) return false;
  await ready();
  if (memory.files.has(id)) return true;
  if (mode !== 'idb') return false;
  try {
    const record = await tx(FILE_STORE, 'readonly', (transaction) => requestValue(transaction.objectStore(FILE_STORE).get(id)));
    return Boolean(record && record.blob);
  } catch {
    mode = 'memory';
    return false;
  }
}
