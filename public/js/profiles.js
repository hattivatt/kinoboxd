/* Local film profile registry: a thin domain facade over core/profile-store.js.
 *
 * KinoPoisk is the only profile source. A Letterboxd archive is an attachment
 * on the server, not a registry entry: boot removes legacy `type:'lb'`
 * profiles and their `stats`/`files` records.
 *
 * Records are the same shape as before:
 *   { id, type:'kp', label, kpUrl, kpUserId, kpNick, uploadId, savedAt, source }
 *
 * The shared store keeps every record in one IndexedDB object store and
 * degrades to memory when IndexedDB is missing/blocked (private mode).
 * main.js keeps its localStorage session (kinoboxd.session.v1) working.
 */

import {
  getStore, getActive, setActive, ready as storeReady, storageMode as storeStorageMode,
  readDoc, writeDoc, deleteDoc, listDocs,
} from './core/profile-store.js';

const DOMAIN = 'films';
const profiles = getStore(DOMAIN);

export const MAX_PROFILES = 6;
export const MAX_STATS_JSON = 12 * 1024 * 1024;

export async function ready() {
  return storeReady();
}

export function isAvailable() {
  return storeStorageMode() === 'idb';
}

export function storageMode() {
  return storeStorageMode();
}

export function setActiveId(id) {
  setActive(DOMAIN, id);
}

export function getActiveId() {
  return getActive(DOMAIN);
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

/* =========================================================
   registry
   ========================================================= */

export async function listProfiles() {
  return profiles.load();
}

export async function getProfile(id) {
  if (!id) return null;
  return profiles.get(id);
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
  const record = normalizeRecord(input);
  await profiles.put(record);
  await trimProfiles(keepId || getActiveId() || record.id);
  return record;
}

export async function removeProfile(id) {
  if (!id) return false;
  await profiles.remove(id);
  await deleteDoc(DOMAIN, 'stats', id);
  await deleteDoc(DOMAIN, 'file', id);
  return true;
}

export async function clearProfiles() {
  await profiles.clear();
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
  await storeReady();
  let removed = 0;
  for (const record of await listProfiles()) {
    if (record && record.type === 'kp') continue;
    await removeProfile(record.id);
    removed += 1;
  }
  for (const doc of await listDocs(DOMAIN, 'stats')) {
    if (isLegacyLbId(doc.id)) await deleteDoc(DOMAIN, 'stats', doc.id);
  }
  for (const doc of await listDocs(DOMAIN, 'file')) {
    if (isLegacyLbId(doc.id)) await deleteDoc(DOMAIN, 'file', doc.id);
  }
  return removed;
}

/* =========================================================
   stats cache (last successful payload per profile)
   ========================================================= */

export async function getStatsCache(id) {
  if (!id) return null;
  const record = await readDoc(DOMAIN, 'stats', id);
  if (!record || !record.value || !record.value.stats) return null;
  return { id: record.id, stats: record.value.stats, savedAt: record.savedAt, bytes: record.value.bytes };
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
  return writeDoc(DOMAIN, 'stats', id, { stats, bytes: raw.length });
}

export async function removeStatsCache(id) {
  if (!id) return;
  await deleteDoc(DOMAIN, 'stats', id);
}

/* =========================================================
   ZIP bytes (Letterboxd re-import after a server restart)
   ========================================================= */

export async function saveFile(id, file) {
  if (!id || !file) return false;

  let blob = file;
  try {
    if (!(file instanceof Blob)) blob = new Blob([file], { type: 'application/zip' });
  } catch {
    return false;
  }
  return writeDoc(DOMAIN, 'file', id, {
    name: typeof file.name === 'string' && file.name ? file.name : 'letterboxd-export.zip',
    type: typeof file.type === 'string' && file.type ? file.type : 'application/zip',
    blob,
  });
}

export async function getFile(id) {
  if (!id) return null;
  const doc = await readDoc(DOMAIN, 'file', id);
  const record = doc && doc.value;
  if (!record || !record.blob) return null;
  try {
    return new File([record.blob], record.name || 'letterboxd-export.zip', {
      type: record.type || 'application/zip',
      lastModified: doc.savedAt || Date.now(),
    });
  } catch {
    return record.blob;
  }
}

export async function hasFile(id) {
  if (!id) return false;
  const doc = await readDoc(DOMAIN, 'file', id);
  return Boolean(doc && doc.value && doc.value.blob);
}
