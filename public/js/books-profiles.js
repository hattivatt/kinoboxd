import {
  getStore, getActive, setActive, ready as storeReady, storageMode as storeStorageMode,
} from './core/profile-store.js';

export const ACTIVE_KEY = 'kinoboxd.books.profile.v1';
export const LEGACY_ACCOUNTS_KEY = 'kinoboxd.books.accounts.v1';
export const MAX_PROFILES = 8;

const SOURCES = ['livelib', 'hardcover'];
const DOMAIN = 'books';
const profiles = getStore(DOMAIN);

function trim(value) {
  return value == null ? '' : String(value).trim();
}

export function isValidLivelibUsername(value) {
  const username = trim(value).replace(/^@/, '');
  return /^[\w.\-]{1,64}$/u.test(username);
}

export function isValidHardcoverUser(value) {
  return /^\d{1,12}$/.test(trim(value));
}

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

export function primarySource(profile) {
  const list = profileSources(profile);
  if (!list.length) return null;
  return list.find((entry) => entry.source === 'hardcover') || list[0];
}

export function profileKey(profile) {
  const entry = primarySource(profile);
  if (!entry) return '';
  return entry.source === 'livelib' ? `livelib-${entry.username}` : `hardcover-${entry.userId}`;
}

export function profileKeys(profile) {
  const key = profileKey(profile);
  return key ? [key] : [];
}

export function profileQuery(profile) {
  return profileKey(profile);
}

export function profileSourceNames(profile) {
  const entry = primarySource(profile);
  return entry ? [entry.source] : [];
}

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

export function profileSummary(profile) {
  const entry = primarySource(profile);
  if (!entry) return '';
  return entry.source === 'livelib'
    ? `LiveLib @${entry.username}`
    : `Hardcover ${entry.userId}`;
}

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

export function splitMultiSourceProfile(profile) {
  const entries = profileSources(profile);
  if (entries.length === 0) return { records: [], unchanged: true };
  if (entries.length === 1) return { records: [normalizeProfile(profile)], unchanged: true };

  const primaryEntry = entries.find((entry) => entry.source === 'hardcover') || entries[0];
  const oldLabel = trim(profile && profile.label);
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
  records.sort((a, b) => (a.id === trim(profile && profile.id) ? -1 : 1));
  return { records, unchanged: false, primaryId: records[0].id };
}

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

export function sanitizeCookieHeader(raw) {
  let value = trim(raw);
  if (!value) return '';
  value = value.replace(/^cookie\s*:\s*/i, '');
  value = value.replace(/[\r\n\t]+/g, ' ');
  value = value.replace(/\s{2,}/g, ' ');
  value = value.replace(/;\s*;+/g, ';');
  value = value.replace(/\s*;\s*/g, '; ');
  value = value.trim().replace(/[;\s]+$/, '');
  if (!value || !value.includes('=')) return '';
  if (value.length > 8000) return '';
  if (/^[[{<]/.test(value) || /\s[<>]/.test(value)) return '';
  return value;
}

export function looksLikeCookieHeader(raw) {
  return Boolean(sanitizeCookieHeader(raw));
}

export async function ready() {
  return storeReady();
}

export function storageMode() {
  return storeStorageMode();
}

function bySavedDesc(a, b) {
  return (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0);
}

export async function listProfiles() {
  const records = await profiles.load();
  return records.map(normalizeProfile).sort(bySavedDesc);
}

export async function getProfile(id) {
  const key = trim(id);
  if (!key) return null;
  const record = await profiles.get(key);
  return record ? normalizeProfile(record) : null;
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
  const record = normalizeProfile(input);
  await profiles.put(record);
  await trimProfiles(keepId || record.id);
  return record;
}

export async function removeProfile(id) {
  const key = trim(id);
  if (!key) return false;
  await profiles.remove(key);
  if (getActiveId() === key) setActiveId(null);
  return true;
}

export function getActiveId() {
  return getActive(DOMAIN);
}

export function setActiveId(id) {
  return setActive(DOMAIN, id);
}

async function migrateMultiSourceRecords(records) {
  const multi = records.filter((profile) => profileSources(profile).length > 1);
  if (!multi.length) return false;
  for (const record of multi) {
    const { records } = splitMultiSourceProfile(record);
    for (const next of records) {
      await saveProfile(next, { keepId: next.id });
    }
  }
  return true;
}

export async function loadRegistry() {
  let list = await listProfiles();
  if (await migrateMultiSourceRecords(list)) {
    list = await listProfiles();
  }
  const wanted = getActiveId();
  const active = list.find((profile) => profile.id === wanted) || null;
  if (!active && list.length) {
    setActiveId(null);
  }
  return { profiles: list, active };
}
