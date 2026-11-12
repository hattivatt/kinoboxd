'use strict';

const path = require('path');
const fsStore = require('../core/fs-store');

const BOOK_CACHE_DIR = process.env.KINOBOXD_CACHE_BOOK_DIR
  ? path.resolve(process.env.KINOBOXD_CACHE_BOOK_DIR)
  : path.join(__dirname, '..', '..', 'cache-book');

const SERIES_OVERRIDES_PATH = path.join(BOOK_CACHE_DIR, 'series-overrides.json');

const MAX_SERIES = 20;
const MAX_SERIES_NAME = 200;
const MAX_WORK_ID = 120;

let overrides = {};
let overridesFingerprint = null;
let overridesSaving = Promise.resolve();

function nameKeyOf(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function positionOf(value) {
  if (value == null || value === '') return null;
  const position = Number(value);
  if (!Number.isFinite(position) || position < 0) return null;
  return position;
}

function normalizeSeriesList(list) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const name = String(entry && entry.name != null ? entry.name : '')
      .trim()
      .slice(0, MAX_SERIES_NAME);
    const key = nameKeyOf(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ hcId: null, name, position: positionOf(entry.position) });
    if (out.length >= MAX_SERIES) break;
  }
  return out;
}

function sanitizeWorks(raw) {
  const out = {};
  const works =
    raw && typeof raw === 'object' && !Array.isArray(raw) && raw.works && typeof raw.works === 'object'
      ? raw.works
      : null;
  if (!works || Array.isArray(works)) return out;
  for (const [workId, entry] of Object.entries(works)) {
    const key = String(workId == null ? '' : workId).trim().slice(0, MAX_WORK_ID);
    if (!key || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    out[key] = {
      series: normalizeSeriesList(entry.series),
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
    };
  }
  return out;
}

{
  const found = fsStore.readJsonWithFingerprint(SERIES_OVERRIDES_PATH, { label: 'series-overrides' });
  if (found) overrides = sanitizeWorks(found.data);
  overridesFingerprint = fsStore.fingerprintOf(SERIES_OVERRIDES_PATH);
}

function refreshIfChanged() {
  const current = fsStore.fingerprintOf(SERIES_OVERRIDES_PATH);
  if (current === overridesFingerprint) return false;
  if (current === null) {
    overrides = {};
    overridesFingerprint = null;
    return true;
  }
  const found = fsStore.readJsonWithFingerprint(SERIES_OVERRIDES_PATH, { label: 'series-overrides' });
  overrides = sanitizeWorks(found && found.data);
  overridesFingerprint = current;
  return true;
}

function getSeriesOverrides() {
  refreshIfChanged();
  return overrides;
}

function findSeriesOverride(works, keys) {
  const list = works && typeof works === 'object' ? works : {};
  for (const key of Array.isArray(keys) ? keys : []) {
    if (key == null) continue;
    const value = String(key);
    if (Object.prototype.hasOwnProperty.call(list, value)) return list[value];
  }
  return null;
}

function enqueueWrite(task) {
  const run = overridesSaving.then(task);
  overridesSaving = run.catch(() => {});
  return run;
}

function saveSeriesOverrides(workId, series) {
  const key = String(workId == null ? '' : workId).trim();
  if (!key) return Promise.reject(new Error('workId is required'));
  const list = normalizeSeriesList(series);
  return enqueueWrite(async () => {
    refreshIfChanged();
    const entry = { series: list, updatedAt: new Date().toISOString() };
    const next = { schemaVersion: 1, works: { ...overrides, [key]: entry } };
    const stored = await fsStore.writeJsonAtomic(SERIES_OVERRIDES_PATH, next);
    overrides = next.works;
    overridesFingerprint = stored;
    return entry;
  });
}

function clearSeriesOverrides(workId) {
  const key = String(workId == null ? '' : workId).trim();
  if (!key) return Promise.reject(new Error('workId is required'));
  return enqueueWrite(async () => {
    refreshIfChanged();
    if (!Object.prototype.hasOwnProperty.call(overrides, key)) return false;
    const next = { ...overrides };
    delete next[key];
    const stored = await fsStore.writeJsonAtomic(SERIES_OVERRIDES_PATH, {
      schemaVersion: 1,
      works: next,
    });
    overrides = next;
    overridesFingerprint = stored;
    return true;
  });
}

function clearMemory() {
  overrides = {};
  overridesFingerprint = null;
  overridesSaving = Promise.resolve();
}

module.exports = {
  BOOK_CACHE_DIR,
  SERIES_OVERRIDES_PATH,
  MAX_SERIES,
  MAX_SERIES_NAME,
  MAX_WORK_ID,
  nameKeyOf,
  normalizeSeriesList,
  getSeriesOverrides,
  findSeriesOverride,
  saveSeriesOverrides,
  clearSeriesOverrides,
  clearMemory,
};
