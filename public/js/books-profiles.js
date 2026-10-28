/* Books profile registry (IndexedDB, per browser) + pure helpers.
 *
 * A *books profile* is a local scoping entity, not a server record:
 *
 *   { id, label, sources: [ { source: 'livelib', username },
 *                            { source: 'hardcover', userId } ], savedAt }
 *
 * The reading events stay on the server (`cache-book/profiles/*`), but which
 * of them belong to "my profile" is decided by the browser. `/api/books/stats`
 * accepts the derived `profiles=` CSV (`livelib-<username>,hardcover-<id>`),
 * so switching profiles changes the request, not the cache.
 *
 * Storage: a dedicated DB «kinoboxd-books» (version 1, store `profiles`) so
 * the film registry («kinoboxd») is never upgraded/migrated by this module.
 * The active profile id lives in localStorage (readable synchronously at boot)
 * with an in-memory fallback for private mode.
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

/** `/api/books/stats?profiles=` value: `livelib-Margaret,hardcover-34748`. */
export function profileKeys(profile) {
  return profileSources(profile).map((entry) => (
    entry.source === 'livelib' ? `livelib-${entry.username}` : `hardcover-${entry.userId}`
  ));
}

export function profileQuery(profile) {
  return profileKeys(profile).join(',');
}

export function profileSourceNames(profile) {
  return profileSources(profile).map((entry) => entry.source);
}

/** Human summary for the switcher: «LiveLib @Margaret · Hardcover 34748». */
export function profileSummary(profile) {
  const parts = profileSources(profile).map((entry) => (
    entry.source === 'livelib'
      ? `LiveLib @${entry.username}`
      : `Hardcover ${entry.userId}`
  ));
  return parts.join(' · ');
}

/** Add or replace one source inside the profile; mutates a copy. */
export function withSource(profile, source, value) {
  const entry = normalizeSource(source, value);
  if (!entry) return profile;
  const base = {
    id: trim(profile && profile.id),
    label: trim(profile && profile.label),
    sources: profileSources(profile),
    savedAt: Number(profile && profile.savedAt) || Date.now(),
  };
  base.sources = base.sources.filter((item) => item.source !== entry.source);
  base.sources.push(entry);
  base.sources.sort((a, b) => SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source));
  return base;
}

function autoLabel(profile) {
  const parts = profileSources(profile).map((entry) => (
    entry.source === 'livelib' ? `@${entry.username}` : entry.userId
  ));
  return parts.length ? parts.join(' + ') : 'Книжный профиль';
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
 * Server-side sources → a profile the user can adopt with one click.
 * Used when this browser has no local profiles but the server still has
 * imported source caches (old install, cleared localStorage).
 *
 * A local profile carries one account per source, so when the server knows
 * several accounts for the same source the *latest import* wins (a source with
 * no `importedAt` sorts first, so any dated import beats it). This is a
 * restore shortcut, not a profile merge: the CTA names the accounts it will
 * take, and the user can edit the profile afterwards.
 */
export function adoptServerProfiles(serverProfiles, label = 'Сохранённый на сервере') {
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
  const sources = SOURCES.map((source) => latest.get(source)).filter(Boolean);
  if (!sources.length) return null;
  return normalizeProfile({ label, sources });
}

/**
 * First-run migration. Old builds kept the accounts in
 * localStorage (`kinoboxd.books.accounts.v1`) and pre-filled 34748/Margaret in
 * the HTML. Only *actually remembered* accounts are migrated — no defaults are
 * invented. Returns a profile or null.
 */
export function migrateLegacyAccounts(accounts) {
  if (!accounts || typeof accounts !== 'object') return null;
  const sources = [];
  const livelib = normalizeSource('livelib', accounts.livelib);
  if (livelib) sources.push(livelib);
  const hardcover = normalizeSource('hardcover', accounts.hardcover);
  if (hardcover) sources.push(hardcover);
  if (!sources.length) return null;
  return normalizeProfile({ label: 'Мой профиль', sources });
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

/** Local registry snapshot used by the UI: { profiles, active }. */
export async function loadRegistry() {
  const profiles = await listProfiles();
  const wanted = getActiveId();
  let active = profiles.find((profile) => profile.id === wanted) || null;
  if (!active && profiles.length) {
    // Never resurrect a deleted profile id: keep "no active profile" honest
    // instead of silently picking someone else's data.
    setActiveId(null);
  }
  return { profiles, active };
}
