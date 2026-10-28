/* Books profile registry (IndexedDB, per browser) + pure helpers.
 *
 * A *books profile* is one reading account of one service — the user's model
 * (28.10.2026): Hardcover-34748 and LiveLib-Margaret are DIFFERENT profiles,
 * never merged into one statistics payload.
 *
 *   { id, label, sources: [ { source: 'livelib', username } ], savedAt }
 *   { id, label, sources: [ { source: 'hardcover', userId } ], savedAt }
 *
 * The reading events stay on the server (`cache-book/profiles/*`), but which
 * of them belong to "my profile" is decided by the browser. `/api/books/stats`
 * accepts exactly one `profile=` token (`livelib-<username>` or
 * `hardcover-<id>`), so switching profiles changes the request, not the cache.
 *
 * Storage: a dedicated DB «kinoboxd-books» (version 1, store `profiles`) so
 * the film registry («kinoboxd») is never upgraded/migrated by this module.
 * The active profile id lives in localStorage (readable synchronously at boot)
 * with an in-memory fallback for private mode.
 *
 * K6 wrote profiles with two sources (`sources: [livelib, hardcover]`); those
 * legacy records are split into two single-source profiles by `loadRegistry`
 * (Hardcover keeps the id, the second gets a new one and an explicit label).
 *
 * No cookie / token values ever land here: the LiveLib cookie is sent once to
 * the server and only kept by the backend.
 */

const DB_NAME = 'kinoboxd-books';
const DB_VERSION = 1;
const PROFILE_STORE = 'profiles';

export const ACTIVE_KEY = 'kinoboxd.books.profile.v1';
export const LEGACY_ACCOUNTS_KEY = 'kinoboxd.books.accounts.v1';
export const MAX_PROFILES = 8;

const SOURCES = ['livelib', 'hardcover'];

let mode = 'pending'; // 'pending' | 'idb' | 'memory'
let dbPromise = null;
const memory = new Map(); // id -> record
let memoryActive = null;

/* =========================================================
   pure helpers (unit-tested without a browser)
   ========================================================= */

function trim(value) {
  return value == null ? '' : String(value).trim();
}

/** LiveLib reader names: letters/digits/underscore/dot/dash, no spaces. */
export function isValidLivelibUsername(value) {
  const username = trim(value).replace(/^@/, '');
  return /^[\w.\-]{1,64}$/u.test(username);
}

/** Hardcover user id is numeric (`me` is not a stable profile key). */
export function isValidHardcoverUser(value) {
  return /^\d{1,12}$/.test(trim(value));
}

/**
 * One source entry for a profile. Returns null for an unknown source or an
 * empty/invalid account, so callers can filter `[a, b].map(...).filter(Boolean)`.
 */
export function normalizeSource(source, value) {
  const key = trim(source).toLowerCase();
  if (!SOURCES.includes(key)) return null;
  if (key === 'livelib') {
    const username = trim(value).replace(/^@/, '');
    if (!isValidLivelibUsername(username)) return null;
    return { source: 'livelib', username };
  }
  const userId = trim(value);
  if (!isValidHardcoverUser(userId)) return null;
  return { source: 'hardcover', userId };
}

export function sourceAccount(profile, source) {
  const entry = Array.isArray(profile && profile.sources)
    ? profile.sources.find((item) => item && item.source === source)
    : null;
  if (!entry) return '';
  return trim(source === 'hardcover' ? entry.userId : entry.username);
}

/** Deduped, validated sources in a stable order (LiveLib → Hardcover). */
export function profileSources(profile) {
  const list = Array.isArray(profile && profile.sources) ? profile.sources : [];
  const bySource = new Map();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const source = trim(item.source).toLowerCase();
    const normalized = normalizeSource(source, source === 'hardcover' ? item.userId : item.username);
    if (normalized) bySource.set(normalized.source, normalized);
  }
  return SOURCES.map((source) => bySource.get(source)).filter(Boolean);
}

/**
 * The one source a profile stands for. Hardcover wins when a legacy record
 * still carries two accounts (the migration keeps it on the original id); for
 * every record written by this build the array already has length 1.
 */
export function primarySource(profile) {
  const list = profileSources(profile);
  if (!list.length) return null;
  return list.find((entry) => entry.source === 'hardcover') || list[0];
}

/** `/api/books/stats?profile=` value: ONE token (`livelib-Margaret`). */
export function profileKey(profile) {
  const entry = primarySource(profile);
  if (!entry) return '';
  return entry.source === 'livelib' ? `livelib-${entry.username}` : `hardcover-${entry.userId}`;
}

/** @deprecated alias of `profileKey`, kept for the switcher/tests. */
export function profileKeys(profile) {
  const key = profileKey(profile);
  return key ? [key] : [];
}

/** @deprecated alias of `profileKey`: the API takes one profile, not a CSV. */
export function profileQuery(profile) {
  return profileKey(profile);
}

/** Exactly one source name ('' when the profile carries nothing). */
export function profileSourceNames(profile) {
  const entry = primarySource(profile);
  return entry ? [entry.source] : [];
}

/**
 * Sources that the server actually scoped a stats payload to
 * (`payload.sources.profiles.selected`, e.g. `["livelib-Margaret"]`).
 * Returns [] when the payload carries no scope (legacy server) so callers can
 * fall back to `connected`.
 */
export function scopeSourceNames(profilesBlock) {
  const list = profilesBlock && Array.isArray(profilesBlock.selected)
    ? profilesBlock.selected
    : [];
  const names = [];
  for (const token of list) {
    const source = trim(token).split('-')[0].toLowerCase();
    if (SOURCES.includes(source) && !names.includes(source)) names.push(source);
  }
  return names;
}

/** Human summary for the switcher: «LiveLib @Margaret» / «Hardcover 34748». */
export function profileSummary(profile) {
  const entry = primarySource(profile);
  if (!entry) return '';
  return entry.source === 'livelib'
    ? `LiveLib @${entry.username}`
    : `Hardcover ${entry.userId}`;
}

/**
 * Set (or replace) the profile's source. A profile is one source, so this
 * resets `sources` to that single entry: importing a second service creates a
 * second profile, never a union.
 */
export function withSource(profile, source, value) {
  const entry = normalizeSource(source, value);
  if (!entry) return profile;
  return {
    id: trim(profile && profile.id),
    label: trim(profile && profile.label),
    sources: [entry],
    savedAt: Number(profile && profile.savedAt) || Date.now(),
  };
}

function autoLabel(profile) {
  const entry = primarySource(profile);
  if (!entry) return 'Книжный профиль';
  return entry.source === 'livelib' ? `@${entry.username}` : entry.userId;
}

function fallbackId() {
  return `bk:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Canonical record. `label` falls back to the accounts it carries (never to a
 * hardcoded 34748/Margaret), sources are deduped per source and ordered
 * LiveLib → Hardcover to keep the request URL stable.
 */
export function normalizeProfile(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const record = {
    id: trim(raw.id) || fallbackId(),
    label: trim(raw.label),
    sources: profileSources(raw),
    savedAt: Number.isFinite(Number(raw.savedAt)) && Number(raw.savedAt) > 0
      ? Number(raw.savedAt)
      : Date.now(),
  };
  if (!record.label) record.label = autoLabel(record);
  return record;
}

/**
 * Server-side profiles → local profiles the user can adopt with one click.
 * Used when this browser has no local profiles but the server still has
 * imported source caches (old install, cleared localStorage).
 *
 * One server profile = one local profile (one source + one account), so this
 * returns a LIST: adopting both Hardcover and LiveLib creates two switcher
 * entries, never a union. When several accounts of a source exist, the latest
 * import wins per source.
 */
export function adoptServerProfiles(serverProfiles) {
  const rows = (Array.isArray(serverProfiles) ? serverProfiles : [])
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const left = Number(a.item && a.item.importedAt) || 0;
      const right = Number(b.item && b.item.importedAt) || 0;
      if (left !== right) return left - right;
      return a.index - b.index;
    });
  const latest = new Map();
  for (const { item } of rows) {
    const source = trim(item && item.source).toLowerCase();
    const account = trim(item && (item.userKey != null ? item.userKey : item.account));
    const normalized = normalizeSource(source, account);
    if (!normalized) continue;
    latest.set(normalized.source, normalized);
  }
  return SOURCES.map((source) => latest.get(source)).filter(Boolean).map((entry) => (
    normalizeProfile({
      label: entry.source === 'livelib' ? `LiveLib @${entry.username}` : `Hardcover ${entry.userId}`,
      sources: [entry],
    })
  ));
}

/**
 * K6 profiles carried two sources in one record. Split such a record into
 * single-source profiles: Hardcover keeps the original id (it was the primary
 * source of the union model), the other one gets a fresh id. A custom user
 * label survives on the primary record; the split-off record is named after
 * its account («LiveLib Margaret», «Hardcover 34748»).
 *
 * Pure: returns records to save, the caller persists them.
 */
export function splitMultiSourceProfile(profile) {
  const entries = profileSources(profile);
  if (entries.length === 0) return { records: [], unchanged: true };
  if (entries.length === 1) return { records: [normalizeProfile(profile)], unchanged: true };

  const primaryEntry = entries.find((entry) => entry.source === 'hardcover') || entries[0];
  const oldLabel = trim(profile && profile.label);
  // K6's autoLabel joined the accounts as "@Margaret + 34748"; a label equal
  // to that (or to the single-source auto label) is not a user's name.
  const legacyAuto = entries
    .map((entry) => (entry.source === 'livelib' ? `@${entry.username}` : entry.userId))
    .join(' + ');
  const customLabel =
    oldLabel && oldLabel !== legacyAuto && oldLabel !== autoLabel(profile) ? oldLabel : '';
  const records = entries.map((entry) => {
    const isPrimary = entry.source === primaryEntry.source;
    return normalizeProfile({
      id: isPrimary ? trim(profile && profile.id) : fallbackId(),
      label: isPrimary && customLabel
        ? customLabel
        : entry.source === 'livelib'
        ? `LiveLib ${entry.username}`
        : `Hardcover ${entry.userId}`,
      sources: [entry],
      savedAt: Number(profile && profile.savedAt) || Date.now(),
    });
  });
  // Primary first so callers can rely on records[0].
  records.sort((a, b) => (a.id === trim(profile && profile.id) ? -1 : 1));
  return { records, unchanged: false, primaryId: records[0].id };
}

/**
 * First-run migration. Old builds kept the accounts in
 * localStorage (`kinoboxd.books.accounts.v1`) and pre-filled 34748/Margaret in
 * the HTML. Only *actually remembered* accounts are migrated — no defaults are
 * invented. Returns a profile or null.
 */
/**
 * First-run migration from the very old builds that kept accounts in
 * localStorage (`kinoboxd.books.accounts.v1`). Only *actually remembered*
 * accounts are migrated — no defaults are invented — and each account becomes
 * its own single-source profile. Returns an array (possibly empty).
 */
export function migrateLegacyAccounts(accounts) {
  if (!accounts || typeof accounts !== 'object') return [];
  const sources = [];
  const livelib = normalizeSource('livelib', accounts.livelib);
  if (livelib) sources.push(livelib);
  const hardcover = normalizeSource('hardcover', accounts.hardcover);
  if (hardcover) sources.push(hardcover);
  return sources.map((entry) => normalizeProfile({
    label: entry.source === 'livelib' ? `LiveLib @${entry.username}` : `Hardcover ${entry.userId}`,
    sources: [entry],
  }));
}

/**
 * Tolerant 403 detection for the LiveLib anti-bot block. Accepts an ApiError,
 * a job status object or a plain string (job.error / status.error).
 */
export function isLivelibBlocked(value) {
  if (!value) return false;
  const codeBlocked = (code) => {
    const normalized = trim(code).toLowerCase();
    return normalized === 'livelib_blocked'
      || normalized === 'livelib_403'
      || normalized === 'livelib_captcha';
  };
  if (typeof value === 'string') {
    const message = value.toLowerCase();
    if (!message) return false;
    if (message.includes('livelib_blocked')) return true;
    if (!message.includes('livelib')) return false;
    return message.includes('403')
      || message.includes('blocked')
      || message.includes('forbidden')
      || message.includes('заблок')
      || message.includes('ddos');
  }
  if (typeof value !== 'object') return false;
  if (codeBlocked(value.code)) return true;
  if (Number(value.status) === 403) return true;
  const payload = value.payload && typeof value.payload === 'object' ? value.payload : null;
  if (payload) {
    if (codeBlocked(payload.code)) return true;
    if (isLivelibBlocked(trim(payload.message || payload.error))) return true;
  }
  return isLivelibBlocked(trim(value.message || value.error));
}

/**
 * Accept a pasted `Cookie: __ddg1=...; ...` header.
 * Strips the optional «Cookie:» prefix, collapses line breaks into `; ` and
 * rejects values that cannot be a cookie header. Never logs the value.
 */
export function sanitizeCookieHeader(raw) {
  let value = trim(raw);
  if (!value) return '';
  value = value.replace(/^cookie\s*:\s*/i, '');
  // A pasted header is often wrapped over several lines: fold it into one.
  value = value.replace(/[\r\n\t]+/g, ' ');
  value = value.replace(/\s{2,}/g, ' ');
  value = value.replace(/;\s*;+/g, ';');
  value = value.replace(/\s*;\s*/g, '; ');
  value = value.trim().replace(/[;\s]+$/, '');
  if (!value || !value.includes('=')) return '';
  if (value.length > 8000) return '';
  // A header is not JSON and not a URL; reject accidental paste of the page.
  if (/^[[{<]/.test(value) || /\s[<>]/.test(value)) return '';
  return value;
}

export function looksLikeCookieHeader(raw) {
  return Boolean(sanitizeCookieHeader(raw));
}

/* =========================================================
   IndexedDB plumbing (memory fallback)
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
      } catch {
        /* a broken upgrade surfaces through onerror/onblocked */
      }
    };
    request.onsuccess = () => finish(resolve, request.result);
    request.onerror = () => finish(reject, request.error || new Error('indexedDB open failed'));
    request.onblocked = () => finish(reject, new Error('indexedDB blocked'));
  });
  return dbPromise;
}

async function txWork(storeName, transactionMode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(storeName, transactionMode);
    } catch (error) {
      reject(error);
      return;
    }
    let value;
    try {
      value = work(transaction.objectStore(storeName));
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

/** Open once; never throws (private mode → memory mode). */
export async function ready() {
  if (mode === 'idb' || mode === 'memory') return { available: mode === 'idb', mode };
  try {
    await openDb();
    mode = 'idb';
  } catch {
    mode = 'memory';
  }
  return { available: mode === 'idb', mode };
}

export function storageMode() {
  return mode;
}

function bySavedDesc(a, b) {
  return (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0);
}

export async function listProfiles() {
  await ready();
  if (mode === 'idb') {
    try {
      const records = await txWork(PROFILE_STORE, 'readonly', (store) => requestValue(store.getAll()));
      return (Array.isArray(records) ? records : []).map(normalizeProfile).sort(bySavedDesc);
    } catch {
      mode = 'memory';
    }
  }
  return Array.from(memory.values()).map(normalizeProfile).sort(bySavedDesc);
}

export async function getProfile(id) {
  const key = trim(id);
  if (!key) return null;
  await ready();
  if (mode === 'idb') {
    try {
      const record = await txWork(PROFILE_STORE, 'readonly', (store) => requestValue(store.get(key)));
      return record ? normalizeProfile(record) : null;
    } catch {
      mode = 'memory';
    }
  }
  const record = memory.get(key);
  return record ? normalizeProfile(record) : null;
}

export async function saveProfile(input, { keepId = null } = {}) {
  await ready();
  const record = normalizeProfile(input);
  memory.set(record.id, record);
  if (mode === 'idb') {
    try {
      await txWork(PROFILE_STORE, 'readwrite', (store) => {
        store.put(record);
      });
    } catch {
      mode = 'memory';
    }
  }
  await trimProfiles(keepId || record.id);
  return record;
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

export async function removeProfile(id) {
  const key = trim(id);
  if (!key) return false;
  await ready();
  memory.delete(key);
  if (mode === 'idb') {
    try {
      await txWork(PROFILE_STORE, 'readwrite', (store) => {
        store.delete(key);
      });
    } catch {
      mode = 'memory';
    }
  }
  if (getActiveId() === key) setActiveId(null);
  return true;
}

/* =========================================================
   active profile id (localStorage; per browser)
   ========================================================= */

export function getActiveId() {
  if (memoryActive) return memoryActive;
  try {
    const value = window.localStorage.getItem(ACTIVE_KEY);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function setActiveId(id) {
  const value = trim(id) || null;
  memoryActive = value;
  try {
    if (value) window.localStorage.setItem(ACTIVE_KEY, value);
    else window.localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* private mode — the current tab still remembers it in memoryActive */
  }
  return value;
}

/** Split legacy two-source records into single-source profiles. */
async function migrateMultiSourceRecords(profiles) {
  const multi = profiles.filter((profile) => profileSources(profile).length > 1);
  if (!multi.length) return false;
  for (const record of multi) {
    const { records } = splitMultiSourceProfile(record);
    for (const next of records) {
      // Keep the original id on the primary record; the split-off one is new.
      await saveProfile(next, { keepId: next.id });
    }
  }
  return true;
}

/** Local registry snapshot used by the UI: { profiles, active }. */
export async function loadRegistry() {
  let profiles = await listProfiles();
  // K6 wrote union profiles (livelib + hardcover in one record). The single-
  // profile contract splits them once, on first load after the upgrade.
  if (await migrateMultiSourceRecords(profiles)) {
    profiles = await listProfiles();
  }
  const wanted = getActiveId();
  let active = profiles.find((profile) => profile.id === wanted) || null;
  if (!active && profiles.length) {
    // Never resurrect a deleted profile id: keep "no active profile" honest
    // instead of silently picking someone else's data.
    setActiveId(null);
  }
  return { profiles, active };
}
