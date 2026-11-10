'use strict';

const path = require('path');

const { round1, round2: roundNumber, round4: roundNumber4 } = require('../../core/stats');
const gameCache = require('../game-cache');

const round2 = (value) => roundNumber(value, 'numeric');
const round4 = (value) => roundNumber4(value, 'numeric');

const OVERRIDES_PATH = path.join(gameCache.GAMES_CACHE_DIR, 'personnel-overrides.json');

/** Canonical roles accepted by `?role=` (§5.3). */
const ROLES = [
  'developer',
  'publisher',
  'composer',
  'designer',
  'writer',
  'artist',
  'programmer',
  'producer',
  'director',
  'creator',
  'sound',
  'voice',
];

/**
 * Backward-compatible spellings. `studio` was the M3 default before the
 * developer/publisher split (01.11.2026); it must keep answering, otherwise a
 * cached frontend would get a 400 after the deploy. Aliases resolve to the
 * canonical role and are echoed as `roleRequested`.
 */
const ROLE_ALIASES = {
  studio: 'developer',
  studios: 'developer',
  dev: 'developer',
  pub: 'publisher',
};

const DEFAULT_ROLE = 'developer';

/** Studio roles (people roles are everything else). */
const STUDIO_ROLES = ['developer', 'publisher'];

/** People roles in the order §7.1 shows them (studios are a separate block). */
const PEOPLE_ROLES = [
  'composer',
  'designer',
  'writer',
  'artist',
  'programmer',
  'producer',
  'director',
  'creator',
  'sound',
  'voice',
];

const SORTS = ['hours', 'count', 'completion', 'name'];

class PersonnelError extends Error {
  constructor(message, code, status = 400, extra = {}) {
    super(message);
    this.name = 'PersonnelError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

/** NFKC, lowercase, «ё»→«е», ™/® stripped, punctuation → space (§4.2). */
function normalizeName(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[™®]/g, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function hasCyrillic(value) {
  return /[\u0400-\u04ff]/.test(String(value || ''));
}

function hasLatin(value) {
  return /[a-z]/i.test(String(value || ''));
}

function cleanName(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function minutesToHours(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return round1(value / 60);
}

function asNameList(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((entry) => {
      // M2 writes plain strings (§3.6); an object with `name` is accepted so a
      // richer details document cannot silently blank the studio block.
      if (entry && typeof entry === 'object') return cleanName(entry.name);
      return cleanName(entry);
    })
    .filter(Boolean);
}

function readJson(filePath) {
  const hit = gameCache.readJsonWithFingerprint(filePath);
  return hit && hit.data && typeof hit.data === 'object' ? hit.data : null;
}

function normalizeRole(raw) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!value) return DEFAULT_ROLE;
  if (ROLE_ALIASES[value]) return ROLE_ALIASES[value];
  if (!ROLES.includes(value)) {
    throw new PersonnelError(
      `Unknown role "${raw}". Accepted: ${ROLES.map((role) => `"${role}"`).join(', ')} ` +
        `(alias: "studio" → "developer").`,
      'invalid_role'
    );
  }
  return value;
}

/** Canonical role + what the caller actually asked for (alias transparency). */
function resolveRole(raw) {
  const requested = String(raw == null ? '' : raw).trim().toLowerCase() || null;
  const role = normalizeRole(raw);
  return {
    role,
    requested: requested || role,
    alias: requested && requested !== role ? requested : null,
  };
}

function normalizeSort(raw) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!value) return 'hours';
  if (!SORTS.includes(value)) {
    throw new PersonnelError(
      `Unknown sort "${raw}". Accepted: ${SORTS.map((sort) => `"${sort}"`).join(', ')}.`,
      'invalid_sort'
    );
  }
  return value;
}

/** Union-find over entry keys (same idea as `books/authors.js`). */
function createUnion() {
  const parent = new Map();
  const find = (key) => {
    if (!parent.has(key)) parent.set(key, key);
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(key) !== key) {
      const next = parent.get(key);
      parent.set(key, root);
      key = next;
    }
    return root;
  };
  const union = (a, b) => {
    const left = find(a);
    const right = find(b);
    if (left === right) return;
    if (left < right) parent.set(right, left);
    else parent.set(left, right);
  };
  return { find, union, parent };
}

function strongKey(entry) {
  if (entry.qid) return `qid:${entry.qid}`;
  if (entry.mobyId != null) return `moby:${entry.mobyId}`;
  return `name:${normalizeName(entry.name)}`;
}

/**
 * Legal-form tokens that are a company's *form*, not its name (§4.2 keeps
 * «Studio»/«Games»/«Interactive» — those are part of the name; «Inc.»/«Ltd»/
 * «GmbH» are not). Steam and Wikidata disagree exactly here: «Valve» vs
 * «Valve Corporation», «FromSoftware» vs «FromSoftware, Inc.», «Epic Games»
 * vs «Epic Games, Inc.» (round 01.11.2026: seven studios were shown twice).
 */
const LEGAL_FORM_TOKENS = new Set([
  'inc',
  'incorporated',
  'ltd',
  'limited',
  'llc',
  'gmbh',
  'corp',
  'corporation',
  'co',
  'company',
  'plc',
  'sa',
  'sas',
  'sarl',
  'srl',
  'spa',
  'bv',
  'nv',
  'ab',
  'oy',
  'oyj',
  'as',
  'aps',
  'kk',
  'pte',
  'kg',
  'ug',
  'sro',
  'doo',
]);

/** Normalized name without trailing legal-form tokens (never empty). */
function studioCoreKey(name) {
  const tokens = normalizeName(name).split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL_FORM_TOKENS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

function emptyOverrides() {
  return {
    schemaVersion: 1,
    updatedAt: null,
    manual: {
      person: {},
      studio: {},
      merges: [],
      aliases: [],
      splits: [],
    },
  };
}

function normalizeOverrides(raw) {
  const base = emptyOverrides();
  if (!raw || typeof raw !== 'object') return base;
  const manual = raw.manual && typeof raw.manual === 'object' ? raw.manual : {};
  const result = {
    ...base,
    updatedAt: raw.updatedAt || null,
    manual: {
      person: manual.person && typeof manual.person === 'object' ? { ...manual.person } : {},
      studio: manual.studio && typeof manual.studio === 'object' ? { ...manual.studio } : {},
      merges: Array.isArray(manual.merges) ? manual.merges.filter(Boolean) : [],
      aliases: Array.isArray(manual.aliases) ? manual.aliases.filter(Boolean) : [],
      splits: Array.isArray(manual.splits) ? manual.splits.filter(Boolean) : [],
    },
  };
  return result;
}

function readOverrides() {
  return normalizeOverrides(readJson(OVERRIDES_PATH));
}

function mergeEntryKey(entry) {
  return `${entry.type || ''}|${entry.from || ''}|${entry.to || ''}`;
}

function aliasEntryKey(entry) {
  return `${entry.type || ''}|${entry.name || ''}|${entry.alias || ''}`;
}

function splitEntryKey(entry) {
  return `${entry.type || ''}|${entry.name || ''}`;
}

/** Deep-merge a patch into the current overrides; untouched keys survive. */
function mergeOverrides(current, patch) {
  const base = normalizeOverrides(current);
  const next = normalizeOverrides(patch == null ? {} : patch);
  const merged = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    manual: {
      person: { ...base.manual.person, ...next.manual.person },
      studio: { ...base.manual.studio, ...next.manual.studio },
      merges: [...base.manual.merges],
      aliases: [...base.manual.aliases],
      splits: [...base.manual.splits],
    },
  };
  const addUnique = (target, extra, keyOf) => {
    const seen = new Set(target.map(keyOf));
    for (const entry of extra) {
      const key = keyOf(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      target.push(entry);
    }
  };
  addUnique(merged.manual.merges, next.manual.merges, mergeEntryKey);
  addUnique(merged.manual.aliases, next.manual.aliases, aliasEntryKey);
  addUnique(merged.manual.splits, next.manual.splits, splitEntryKey);
  return merged;
}

async function saveOverrides(patch) {
  const merged = mergeOverrides(readOverrides(), patch);
  const fingerprint = await gameCache.writeJsonAtomic(OVERRIDES_PATH, merged);
  return { data: merged, fingerprint };
}

/**
 * `POST /api/games/override` backend (ИГРЫ §5.5).
 *
 * @param {{type:'person'|'studio', action:'merge'|'split'|'alias',
 *          from?:string, to?:string}} input
 */
async function applyOverride(input) {
  const body = input && typeof input === 'object' ? input : {};
  const type = String(body.type == null ? '' : body.type).trim().toLowerCase();
  const action = String(body.action == null ? '' : body.action).trim().toLowerCase();
  const from = cleanName(body.from);
  const to = cleanName(body.to);
  if (!['person', 'studio'].includes(type)) {
    throw new PersonnelError('"type" must be "person" or "studio".', 'invalid_override_type');
  }
  if (!['merge', 'split', 'alias'].includes(action)) {
    throw new PersonnelError(
      '"action" must be "merge", "split" or "alias".',
      'invalid_override_action'
    );
  }
  if (!from) throw new PersonnelError('"from" is required.', 'invalid_override_from');
  if (action !== 'split' && !to) {
    throw new PersonnelError(`"to" is required for "${action}".`, 'invalid_override_to');
  }

  const at = new Date().toISOString();
  if (action === 'merge') {
    // A merge is a statement about the future too: drop any split that named
    // either side, otherwise the two instructions contradict each other.
    const patch = {
      manual: {
        merges: [{ type, action, from, to, at }],
        splits: [],
      },
    };
    const current = readOverrides();
    const cleaned = {
      ...patch,
      manual: {
        ...patch.manual,
        splits: current.manual.splits.filter(
          (entry) =>
            entry.type !== type ||
            (normalizeName(entry.name) !== normalizeName(from) &&
              normalizeName(entry.name) !== normalizeName(to))
        ),
      },
    };
    // `mergeOverrides` unions arrays; removed splits need an explicit write.
    const merged = mergeOverrides(current, cleaned);
    merged.manual.splits = cleaned.manual.splits;
    const fingerprint = await gameCache.writeJsonAtomic(OVERRIDES_PATH, merged);
    return { ok: true, type, action, from, to, overrides: merged, fingerprint };
  }
  if (action === 'alias') {
    const saved = await saveOverrides({ manual: { aliases: [{ type, name: to, alias: from, at }] } });
    return { ok: true, type, action, from, to, overrides: saved.data, fingerprint: saved.fingerprint };
  }
  // split: forget any merge that named this spelling, remember the decision.
  const current = readOverrides();
  const merged = mergeOverrides(current, { manual: { splits: [{ type, name: from, at }] } });
  merged.manual.merges = current.manual.merges.filter(
    (entry) => entry.type !== type || (normalizeName(entry.from) !== normalizeName(from) && normalizeName(entry.to) !== normalizeName(from))
  );
  const fingerprint = await gameCache.writeJsonAtomic(OVERRIDES_PATH, merged);
  return { ok: true, type, action, from, to: null, overrides: merged, fingerprint };
}

module.exports = {
  OVERRIDES_PATH,
  ROLES,
  ROLE_ALIASES,
  DEFAULT_ROLE,
  STUDIO_ROLES,
  PEOPLE_ROLES,
  SORTS,
  PersonnelError,
  normalizeName,
  hasCyrillic,
  hasLatin,
  cleanName,
  minutesToHours,
  round2,
  round4,
  asNameList,
  readJson,
  normalizeRole,
  resolveRole,
  normalizeSort,
  createUnion,
  strongKey,
  LEGAL_FORM_TOKENS,
  studioCoreKey,
  emptyOverrides,
  normalizeOverrides,
  readOverrides,
  mergeEntryKey,
  aliasEntryKey,
  splitEntryKey,
  mergeOverrides,
  saveOverrides,
  applyOverride,
};
