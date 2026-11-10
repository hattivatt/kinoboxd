const DB_NAME = 'kinoboxd-registry';
const DB_VERSION = 1;
const ENTRY_STORE = 'entries';
const SCHEMA_KEY = 'meta:schema';
const OPEN_TIMEOUT_MS = 5000;
export const SCHEMA_VERSION = 1;
const LEGACY_DBS = [
  { name: 'kinoboxd', domain: 'films', kinds: { profiles: 'profile', stats: 'stats', files: 'file' } },
  { name: 'kinoboxd-books', domain: 'books', kinds: { profiles: 'profile' } },
];
const ACTIVE_KEYS = {
  films: 'kinoboxd.films.profile.v1',
  books: 'kinoboxd.books.profile.v1',
};
let mode = 'pending';
let dbPromise = null;
const memory = new Map();
const memoryActive = new Map();
export const normalizeId = (value) => (value == null ? '' : String(value).trim());
export const entryKey = (domain, kind, id) => `${normalizeId(domain)}:${normalizeId(kind)}:${normalizeId(id)}`;
export function entryFrom(domain, kind, id, value, savedAt = Date.now()) {
  const name = normalizeId(domain);
  const type = normalizeId(kind);
  const key = normalizeId(id);
  if (!name || !type || !key) return null;
  const stamp = Number(savedAt);
  return {
    key: entryKey(name, type, key), domain: name, kind: type, id: key,
    savedAt: Number.isFinite(stamp) && stamp > 0 ? stamp : Date.now(),
    value: value === undefined ? null : value,
  };
}

export function dedupeEntries(entries) {
  const newest = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !entry.key) continue;
    const known = newest.get(entry.key);
    if (!known || (Number(entry.savedAt) || 0) >= (Number(known.savedAt) || 0)) newest.set(entry.key, entry);
  }
  return [...newest.values()];
}

export function legacyEntry(domain, kind, record) {
  const id = normalizeId(record?.id);
  if (!id) return null;
  const value = kind === 'stats'
    ? { stats: record.stats, bytes: record.bytes }
    : kind === 'file' ? { name: record.name, type: record.type, blob: record.blob } : record;
  return entryFrom(domain, kind, id, value, record.savedAt);
}
export const needsMigration = (marker) => (Number(marker?.version) || 0) < SCHEMA_VERSION;
function idbFactory() {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB || null;
  } catch {
    return null;
  }
}

function webStorage() {
  try {
    return typeof window === 'undefined' ? null : window.localStorage || null;
  } catch {
    return null;
  }
}

function openDatabase(name, version, upgrade) {
  if (!idbFactory()) return Promise.reject(new Error('indexedDB unavailable'));
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(name, version);
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => reject(new Error(`indexedDB ${name} open timeout`)), OPEN_TIMEOUT_MS);
    const settle = (fn, value) => {
      clearTimeout(timer);
      fn(value);
    };
    request.onupgradeneeded = (event) => upgrade?.(request.result, event);
    request.onsuccess = () => settle(resolve, request.result);
    request.onerror = () => settle(reject, request.error || new Error(`indexedDB ${name} open failed`));
    request.onblocked = () => settle(reject, new Error(`indexedDB ${name} blocked`));
  });
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexedDB request failed'));
  });
}

async function runTx(db, storeNames, transactionMode, work) {
  const transaction = db.transaction(storeNames, transactionMode);
  const value = work(transaction);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('indexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('indexedDB transaction aborted'));
  });
  return value;
}

function openMain() {
  if (!dbPromise) {
    dbPromise = openDatabase(DB_NAME, DB_VERSION, (db) => {
      if (!db.objectStoreNames.contains(ENTRY_STORE)) db.createObjectStore(ENTRY_STORE, { keyPath: 'key' });
    }).then(async (db) => {
      await migrate(db).catch(() => {});
      return db;
    });
  }
  return dbPromise;
}

function transact(transactionMode, work) {
  return openMain().then((db) => runTx(db, ENTRY_STORE, transactionMode, (transaction) => work(transaction.objectStore(ENTRY_STORE))));
}

async function readLegacy({ name, domain, kinds }) {
  const factory = idbFactory();
  if (!factory) return { entries: [], failed: true };
  const known = typeof factory.databases === 'function' ? await factory.databases().catch(() => null) : null;
  if (known && !known.some((entry) => entry?.name === name)) return { entries: [], failed: false };
  const db = await openDatabase(name, 1).catch(() => null);
  if (!db) return { entries: [], failed: true };
  const fresh = db.objectStoreNames.length === 0;
  const entries = [];
  let failed = false;
  for (const storeName of Object.keys(kinds)) {
    if (!db.objectStoreNames.contains(storeName)) continue;
    try {
      const records = await runTx(db, storeName, 'readonly', (transaction) => requestValue(transaction.objectStore(storeName).getAll()));
      for (const record of Array.isArray(records) ? records : []) {
        const entry = legacyEntry(domain, kinds[storeName], record);
        if (entry) entries.push(entry);
      }
    } catch {
      failed = true;
    }
  }
  db.close();
  if (fresh) factory.deleteDatabase(name);
  return { entries, failed };
}

async function migrate(db) {
  const marker = await runTx(db, ENTRY_STORE, 'readonly', (transaction) => requestValue(transaction.objectStore(ENTRY_STORE).get(SCHEMA_KEY)));
  if (!needsMigration(marker)) return;
  const legacy = await Promise.all(LEGACY_DBS.map((source) => readLegacy(source)));
  const plan = dedupeEntries(legacy.flatMap((result) => result.entries));
  if (!legacy.some((result) => result.failed)) {
    plan.push({ key: SCHEMA_KEY, domain: 'meta', kind: 'schema', id: String(SCHEMA_VERSION), version: SCHEMA_VERSION, savedAt: Date.now() });
  }
  if (!plan.length) return;
  await runTx(db, ENTRY_STORE, 'readwrite', (transaction) => {
    const store = transaction.objectStore(ENTRY_STORE);
    for (const entry of plan) store.put(entry);
  });
}

export async function ready() {
  if (mode === 'pending') {
    try {
      await openMain();
      mode = 'idb';
    } catch {
      mode = 'memory';
    }
  }
  return { available: mode === 'idb', mode };
}
export const storageMode = () => mode;
async function readRaw(key) {
  await ready();
  if (mode === 'idb') {
    try {
      const record = await transact('readonly', (store) => requestValue(key ? store.get(key) : store.getAll()));
      return key ? record || null : (Array.isArray(record) ? record : []);
    } catch {
      mode = 'memory';
    }
  }
  return key ? memory.get(key) || null : [...memory.values()];
}

async function writeEntry(entry, demote = false) {
  if (!entry) return false;
  await ready();
  memory.set(entry.key, entry);
  if (mode !== 'idb') return true;
  try {
    await transact('readwrite', (store) => { store.put(entry); });
    return true;
  } catch {
    if (demote) mode = 'memory';
    return false;
  }
}

async function deleteEntries(keys) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter((key) => typeof key === 'string' && key);
  if (!list.length) return false;
  await ready();
  for (const key of list) memory.delete(key);
  try {
    if (mode === 'idb') await transact('readwrite', (store) => { for (const key of list) store.delete(key); });
  } catch {
    mode = 'memory';
  }
  return true;
}
const entriesOf = (records, domain, kind) => records.filter((record) => record && record.domain === domain && record.kind === kind);
async function loadProfiles(domain) {
  const values = entriesOf(await readRaw(''), domain, 'profile').map((record) => record.value);
  return values.filter((value) => value && typeof value === 'object')
    .sort((a, b) => (Number(b?.savedAt) || 0) - (Number(a?.savedAt) || 0));
}

async function saveProfileList(domain, list) {
  const next = (Array.isArray(list) ? list : []).filter((entry) => normalizeId(entry?.id));
  const keep = new Set(next.map((entry) => entryKey(domain, 'profile', entry.id)));
  const stale = entriesOf(await readRaw(''), domain, 'profile').filter((record) => !keep.has(record.key));
  if (stale.length) await deleteEntries(stale.map((record) => record.key));
  for (const entry of next) await putProfile(domain, entry);
  return loadProfiles(domain);
}

async function putProfile(domain, entry) {
  const id = normalizeId(entry?.id);
  if (!id) return null;
  await writeEntry(entryFrom(domain, 'profile', id, entry, entry.savedAt), true);
  return entry;
}

export function getStore(domain) {
  const name = normalizeId(domain);
  if (!name) throw new Error('profile-store: a domain is required');
  const key = (kind, id) => entryKey(name, kind, id);
  return {
    domain: name,
    load: () => loadProfiles(name),
    save: (list) => saveProfileList(name, list),
    get: async (id) => (await readRaw(key('profile', id)))?.value ?? null,
    put: (entry) => putProfile(name, entry),
    remove: (id) => (normalizeId(id) ? deleteEntries([key('profile', id)]) : false),
    clear: async () => deleteEntries((await readRaw('')).filter((record) => record?.domain === name).map((record) => record.key)),
  };
}

export async function readDoc(domain, kind, id) {
  const record = await readRaw(entryKey(domain, kind, id));
  return record ? { id: record.id, savedAt: record.savedAt, value: record.value } : null;
}

export async function writeDoc(domain, kind, id, value, savedAt = Date.now()) {
  return writeEntry(entryFrom(domain, kind, id, value, savedAt));
}

export async function deleteDoc(domain, kind, id) {
  return deleteEntries([entryKey(domain, kind, id)]);
}

export async function listDocs(domain, kind) {
  return entriesOf(await readRaw(''), normalizeId(domain), normalizeId(kind))
    .map((record) => ({ id: record.id, savedAt: record.savedAt, value: record.value }));
}
const activeKey = (domain) => ACTIVE_KEYS[domain] || `kinoboxd.profile.active.v1:${domain}`;
export function getActive(domain) {
  const name = normalizeId(domain);
  if (!name) return null;
  if (memoryActive.has(name)) return memoryActive.get(name);
  try {
    const value = webStorage()?.getItem(activeKey(name));
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function setActive(domain, id) {
  const name = normalizeId(domain);
  if (!name) return null;
  const value = normalizeId(id) || null;
  memoryActive.set(name, value);
  try {
    const store = webStorage();
    if (!store) return value;
    if (value) store.setItem(activeKey(name), value);
    else store.removeItem(activeKey(name));
  } catch {
    return value;
  }
}
