'use strict';

/**
 * Personnel layer for the games tab (ИГРЫ-АРХИТЕКТУРА §2.4, §5.3, §7).
 *
 * Steam gives only `developers[]`/`publishers[]`; people credits come from
 * Wikidata (`wikidata.js`) and MobyGames (`moby.js`). This module is the
 * *aggregation* on top of those caches:
 *
 *   cache-games/details/<appid>.json       studios (M2 enricher writes it)
 *   cache-games/links/<appid>.json         qid / mobyId (M2 resolver writes it)
 *   cache-games/personnel/<appid>.json     credits per game (this module)
 *   cache-games/personnel-overrides.json   manual merges/aliases (this module)
 *
 * Reading never touches the network: a missing details document is reported as
 * `pending.details`, a missing credits document as `pending.credits`, never as
 * «0 people» (ИГРЫ §7.2: «Не знаем» — валидное состояние). The network phase is
 * `enrichPersonnel()`, called by the on-demand job (`jobs.js`: import/refresh/
 * enrich kick + the lazy `GET /api/games/personnel`) and by the manual
 * `backfill.js`; both share `personnel.lock`.
 *
 * Identity rules (§4.2, §4.3, §7.4), deliberately conservative:
 *
 *   studio: QID → Moby company id → slug(name)
 *   person: QID → Moby person id → slug(name)  (never by a bare name when the
 *           same name belongs to two QIDs: such a group is `ambiguous: true`)
 *
 * Two different QIDs are never merged by name. A Steam studio (no QID) is
 * unified with its Wikidata record by normalized name, because that is the same
 * company seen through two sources; the QID stays on the merged item.
 *
 * Weights (§7.3): `count` (games in this role), `hours` (sum of
 * `playtime_forever`), `hoursShare` (of the profile's considered hours),
 * `avgCompletion` (only games with achievements; `null` otherwise, never 0).
 *
 * Roles (§2.4/§7.2, round 01.11.2026): studios are NOT one bucket any more.
 * `developer` (Steam `developers[]`, Wikidata `P178`) and `publisher`
 * (Steam `publishers[]`, Wikidata `P123`) are separate roles, both selectable
 * and both fed by the same studio entity (a company credited as both stays one
 * item whose `roles` says so). `developer` is the default; the old `studio`
 * token is a documented alias for it, so a cached frontend that still asks for
 * `role=studio` keeps working.
 *
 * Manual overrides are union-safe: `applyOverride()` merges into the existing
 * file and never drops keys it did not touch (§5.5).
 */

const fs = require('fs');
const path = require('path');

const gameCache = require('../game-cache');
const wikidataProvider = require('./wikidata');
const mobyProvider = require('./moby');

const DETAILS_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'details');
const LINKS_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'links');
const PERSONNEL_DIR = path.join(gameCache.GAMES_CACHE_DIR, 'personnel');
const OVERRIDES_PATH = path.join(gameCache.GAMES_CACHE_DIR, 'personnel-overrides.json');

const PERSONNEL_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Version of the rule that turns Wikidata labels into a credit name (§4.2).
 *
 * v1 (no field in the document): the display name was the raw English
 * `rdfs:label`. v2 (round 01.11.2026): the language-neutral `mul` label wins
 * when the English one is only a word-fragment of it (`wikidata.canonicalLabel`
 * — Q3539040 is «Development Studio» in English but «Paradox Development
 * Studio» in `mul`). A document written under an older rule keeps the
 * truncated name for its whole 90-day TTL, which is exactly the «две
 * одинаковые студии» bug the user saw, so such a document is re-fetched once
 * (`labelsStale` below) instead of waiting three months.
 */
const LABEL_RULE_VERSION = 2;

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

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

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
  return Math.round((value / 60) * 10) / 10;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function round4(value) {
  return Math.round(Number(value) * 10000) / 10000;
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

/* ------------------------------------------------------------------ */
/* Cache readers                                                       */
/* ------------------------------------------------------------------ */

function detailsPath(appid) {
  return path.join(DETAILS_DIR, `${gameCache.safeKey(appid)}.json`);
}

function linksPath(appid) {
  return path.join(LINKS_DIR, `${gameCache.safeKey(appid)}.json`);
}

function personnelPath(appid) {
  return path.join(PERSONNEL_DIR, `${gameCache.safeKey(appid)}.json`);
}

/**
 * Details document (M2 contract, ИГРЫ §3.6). `success: false` (region-locked
 * store answer) is not details; the game is honestly pending.
 *
 * `developers`/`publishers` are the documented names; `developirts` is accepted
 * because the M2 brief used that spelling — tolerance is cheap, a silent
 * missing studio block is not.
 */
function readDetails(appid) {
  const doc = readJson(detailsPath(appid));
  if (!doc) return null;
  if (doc.success === false) return null;
  return doc;
}

/** External ids of one game: `{ qid, mobyId, mobyPlatformId, igdbId }`. */
function readLinks(appid) {
  const doc = readJson(linksPath(appid)) || {};
  // `links/<appid>.json` carries two shapes: the legacy string
  // (`wikidata: "Q…"`) and the M4 object written by the franchise pass
  // (`wikidata: { qid, franchise, releaseYear, … }`). Both must resolve to the
  // same QID, otherwise the franchise pass would silently disable the
  // «resolve once» reuse in the personnel pass.
  const wikidataRaw = doc.wikidata && typeof doc.wikidata === 'object'
    ? doc.wikidata.qid
    : doc.wikidata;
  const qidRaw = wikidataRaw || doc.wikidataQid || doc.qid || null;
  const qid = qidRaw && /^Q\d+$/i.test(String(qidRaw).trim())
    ? String(qidRaw).trim().toUpperCase()
    : null;
  const mobyRaw = doc.moby || doc.mobyId || doc.mobygames || null;
  const mobyId = Number.isFinite(Number(mobyRaw)) && Number(mobyRaw) > 0 ? Number(mobyRaw) : null;
  const platformRaw = doc.mobyPlatformId || doc.mobyPlatform || null;
  const mobyPlatformId =
    Number.isFinite(Number(platformRaw)) && Number(platformRaw) > 0 ? Number(platformRaw) : null;
  return { qid, mobyId, mobyPlatformId, igdbId: doc.igdb || doc.igdbId || null };
}

function readPersonnelDoc(appid) {
  const doc = readJson(personnelPath(appid));
  if (!doc || typeof doc !== 'object') return null;
  return {
    ...doc,
    people: Array.isArray(doc.people) ? doc.people : [],
    studios: Array.isArray(doc.studios) ? doc.studios : [],
    sources: Array.isArray(doc.sources) ? doc.sources : [],
  };
}

function isPersonnelFresh(doc, nowMs, ttlMs = PERSONNEL_TTL_MS) {
  if (!doc || !doc.fetchedAt) return false;
  const ts = Date.parse(String(doc.fetchedAt));
  if (!Number.isFinite(ts)) return false;
  const age = nowMs - ts;
  return age >= 0 && age < ttlMs;
}

async function savePersonnelDoc(appid, doc) {
  const payload = {
    schemaVersion: 1,
    appid: Number(appid),
    ...doc,
  };
  const fingerprint = await gameCache.writeJsonAtomic(personnelPath(appid), payload);
  return { data: payload, fingerprint };
}

/** Studios credited by Steam appdetails (the base of the first block, §7.1). */
function studiosFromDetails(details) {
  if (!details) return [];
  const out = [];
  const push = (names, role) => {
    for (const name of names) {
      out.push({
        name,
        nameEn: hasLatin(name) && !hasCyrillic(name) ? name : null,
        nameRu: hasCyrillic(name) ? name : null,
        qid: null,
        mobyId: null,
        roles: [role],
        roleSource: 'steam-store',
        source: 'steam-store',
        confidence: 'high',
      });
    }
  };
  push(asNameList(details.developers != null ? details.developers : details.developirts), 'developer');
  push(asNameList(details.publishers), 'publisher');
  return out;
}

/* ------------------------------------------------------------------ */
/* Overrides (union-safe)                                              */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

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

/**
 * Group raw credit entries into entities.
 *
 * @param {Array<object>} entries every (game, entity, role) occurrence
 * @param {'person'|'studio'} kind
 * @param {object} overrides normalized overrides document
 */
function groupEntries(entries, kind, overrides) {
  const union = createUnion();
  const keys = new Set(entries.map(strongKey));
  for (const key of keys) union.find(key);

  // 1. Strong ids are already in the key: nothing to do.
  // 2. Same name, no strong ids → same entity. Same name, several strong ids →
  //    separate entities (never merge two QIDs, §4.3).
  const byName = new Map();
  for (const entry of entries) {
    const nameKey = normalizeName(entry.name);
    if (!nameKey) continue;
    if (!byName.has(nameKey)) byName.set(nameKey, new Set());
    byName.get(nameKey).add(strongKey(entry));
  }
  const splitNames = new Set(
    overrides.manual.splits
      .filter((entry) => entry.type === kind)
      .map((entry) => normalizeName(entry.name))
  );
  const ambiguousNames = new Set();
  for (const [nameKey, keySet] of byName) {
    const list = [...keySet];
    const strong = list.filter((key) => !key.startsWith('name:'));
    if (strong.length > 1) {
      // Two people with the same name: keep them apart and say so.
      ambiguousNames.add(nameKey);
      continue;
    }
    if (splitNames.has(nameKey)) {
      ambiguousNames.add(nameKey);
      continue;
    }
    for (let i = 1; i < list.length; i++) union.union(list[0], list[i]);
  }

  // 2b. Studios: the same company reaches us twice — as a Wikidata entity with
  //     a QID and as the Steam `developers[]` string — with spellings that
  //     differ only by a legal form («Valve Corporation» vs «Valve»,
  //     «FromSoftware, Inc.» vs «FromSoftware»). That pair is one company when
  //     exactly ONE strong id claims the core name: two QIDs are never merged
  //     (§4.3), and a core name that no id claims is left alone (no fuzzy
  //     matching without a QID, §4.2).
  if (kind === 'studio') {
    const byCore = new Map();
    for (const [nameKey, keySet] of byName) {
      const core = studioCoreKey(nameKey);
      if (!core) continue;
      if (!byCore.has(core)) byCore.set(core, new Set());
      for (const key of keySet) byCore.get(core).add(key);
    }
    for (const [core, keySet] of byCore) {
      if (keySet.size < 2 || splitNames.has(core)) continue;
      const strong = [...keySet].filter((key) => !key.startsWith('name:'));
      if (strong.length !== 1) continue;
      for (const key of keySet) union.union(strong[0], key);
    }
  }

  // 3. Manual merges: `from` spelling joins the `to` entity (only when the
  //    override explicitly asks for it — a manual decision beats the rule).
  for (const merge of overrides.manual.merges) {
    if (merge.type !== kind) continue;
    const fromKey = normalizeName(merge.from);
    const toKey = normalizeName(merge.to);
    const fromKeys = byName.get(fromKey);
    const toKeys = byName.get(toKey);
    if (!fromKeys || !toKeys) continue;
    const anchor = [...toKeys][0];
    for (const key of [...fromKeys, ...toKeys]) union.union(anchor, key);
  }

  const groups = new Map();
  for (const entry of entries) {
    const root = union.find(strongKey(entry));
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(entry);
  }

  const result = [];
  for (const [root, list] of groups) {
    const names = [...new Set(list.map((entry) => cleanName(entry.name)).filter(Boolean))];
    const nameEn =
      list.map((entry) => cleanName(entry.nameEn)).find((name) => name && hasLatin(name) && !hasCyrillic(name)) ||
      names.find((name) => hasLatin(name) && !hasCyrillic(name)) ||
      null;
    const nameRu =
      list.map((entry) => cleanName(entry.nameRu)).find((name) => name && hasCyrillic(name)) ||
      names.find((name) => hasCyrillic(name)) ||
      null;
    const qids = [...new Set(list.map((entry) => entry.qid).filter(Boolean))];
    const mobyIds = [...new Set(list.map((entry) => entry.mobyId).filter((id) => id != null))];
    const roles = [...new Set(list.flatMap((entry) => entry.roles || []))].sort();
    const sources = [...new Set(list.map((entry) => entry.source).filter(Boolean))];
    const ambiguous =
      qids.length > 1 ||
      [...byName.entries()].some(
        ([nameKey, keySet]) => ambiguousNames.has(nameKey) && keySet.has(root)
      );
    result.push({
      key: root,
      names,
      nameEn,
      nameRu,
      qid: qids[0] || null,
      mobyId: mobyIds[0] || null,
      roles,
      sources,
      ambiguous,
      entries: list,
    });
  }
  return { groups: result, ambiguousNames };
}

function applyManualNames(group, kind, overrides) {
  const manual = overrides.manual[kind] || {};
  let display = null;
  const extraAliases = [];
  for (const name of group.names) {
    const entry = manual[normalizeName(name)];
    if (!entry) continue;
    if (entry.display) display = cleanName(entry.display) || display;
    if (Array.isArray(entry.aliases)) extraAliases.push(...entry.aliases.map(cleanName).filter(Boolean));
  }
  for (const alias of overrides.manual.aliases) {
    if (alias.type !== kind) continue;
    const target = normalizeName(alias.name);
    if (group.names.some((name) => normalizeName(name) === target)) {
      const value = cleanName(alias.alias);
      if (value) extraAliases.push(value);
    }
  }
  // Every known spelling (EN, RU, alternate) stays reachable as an alias; the
  // display name is filtered out below. A manual display only changes which
  // spelling is primary, never hides the others.
  for (const name of [group.nameEn, group.nameRu, ...group.names]) {
    if (name) extraAliases.push(name);
  }
  const primary = display || group.nameEn || group.names[0] || group.nameRu || '';
  const aliases = [...new Set(extraAliases.map(cleanName).filter(Boolean))]
    .filter((name) => normalizeName(name) !== normalizeName(primary));
  return { display: primary, aliases };
}

function itemId(group) {
  if (group.qid) return `wd:${group.qid}`;
  if (group.mobyId != null) return `moby:${group.mobyId}`;
  return `name:${normalizeName(group.names[0] || '')}`;
}

/**
 * «WD: …» coverage badge (ИГРЫ §8.3). The state is derived from the persisted
 * breaker document, so the answer is honest even when the widget was opened
 * long after the last run: `never_run` means Wikidata was never asked for this
 * cache, `unavailable` carries the provider's own error code, `cooldown` says
 * until when. `ok` has no badge (nothing to warn about).
 */
const WIKIDATA_BADGES = {
  ok: null,
  never_run: 'WD: не запущено',
  unavailable: 'WD: недоступно',
  cooldown: 'WD: недоступно',
  disabled: 'WD: выключено',
};

function wikidataStatus(state, nowMs, enabled) {
  const doc = state && typeof state === 'object' ? state : {};
  const disabledUntilRaw = doc.disabledUntil || null;
  const disabledUntilMs = disabledUntilRaw ? Date.parse(String(disabledUntilRaw)) : NaN;
  const disabledUntil =
    Number.isFinite(disabledUntilMs) && disabledUntilMs > nowMs ? disabledUntilRaw : null;
  const base = {
    enabled: Boolean(enabled),
    lastSuccessAt: doc.lastSuccessAt || null,
    lastAttemptAt: doc.lastAttemptAt || null,
    lastError: doc.lastError || null,
    disabledUntil,
  };
  let status;
  if (!enabled) {
    status = { state: 'disabled', reason: 'disabled_by_env' };
  } else if (disabledUntil) {
    status = { state: 'cooldown', reason: doc.lastError || 'cooldown' };
  } else if (Number(doc.failures) > 0 && doc.lastError) {
    status = { state: 'unavailable', reason: doc.lastError };
  } else if (doc.lastSuccessAt) {
    status = { state: 'ok', reason: null };
  } else {
    status = { state: 'never_run', reason: 'never_run' };
  }
  return { ...base, ...status, badge: WIKIDATA_BADGES[status.state] || null };
}

/**
 * Build the personnel payload for one profile (ИГРЫ §5.3).
 *
 * @param {string} profileKey `steam-<steamid64>`
 * @param {{role?:string, sort?:string, gamesLimit?:number,
 *          overrides?:object, now?:number, running?:boolean}} [options]
 * @returns {object|null} null when the profile/library is unknown
 */
function buildPersonnel(profileKey, options = {}) {
  const started = Date.now();
  const parsed = gameCache.parseProfileToken(profileKey);
  if (!parsed) {
    throw new PersonnelError(
      `"profile": expected "steam-<steamid64>", got: ${profileKey}.`,
      'invalid_profile'
    );
  }
  const library = gameCache.getLibrary(parsed.userKey);
  if (!library) return null;

  const resolvedRole = resolveRole(options.role);
  const role = resolvedRole.role;
  const sort = normalizeSort(options.sort);
  const gamesLimit = Math.min(
    50,
    Math.max(1, Number.isFinite(Number(options.gamesLimit)) ? Number(options.gamesLimit) : 5)
  );
  const nowMs = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const overrides = options.overrides || readOverrides();
  const wdEnabled = wikidataProvider.wikidataEnabled();

  const games = [];
  let excludedNonGame = 0;
  // Credits written under an older label rule (§4.2): they are still inside
  // their TTL, so only a re-fetch repairs a truncated name. Counted in this
  // loop because it already reads every document; the route turns the number
  // into the lazy kick (`pending.staleLabels`).
  let staleLabels = 0;
  for (const game of library.games || []) {
    const appid = Number(game.appid);
    if (!Number.isInteger(appid) || appid <= 0) continue;
    const details = readDetails(appid);
    if (details && details.type && details.type !== 'game') {
      excludedNonGame++;
      continue;
    }
    const doc = readPersonnelDoc(appid);
    if (wdEnabled && doc && doc.wdAsked === true && doc.labelRule !== LABEL_RULE_VERSION) {
      staleLabels++;
    }
    const studios = studiosFromDetails(details);
    const wdStudios = doc ? doc.studios : [];
    for (const studio of wdStudios) {
      const name = cleanName(studio.name);
      if (!name) continue;
      studios.push({
        name,
        nameEn: studio.nameEn || null,
        nameRu: studio.nameRu || null,
        qid: studio.qid || null,
        mobyId: studio.mobyId != null ? studio.mobyId : null,
        roles: Array.isArray(studio.roles) && studio.roles.length ? studio.roles : ['developer'],
        roleSource: studio.roleSource || studio.source || 'wikidata',
        source: studio.source || 'wikidata',
        confidence: studio.confidence || 'high',
      });
    }
    const people = doc
      ? doc.people
          .map((person) => ({
            name: cleanName(person.name),
            nameEn: person.nameEn || null,
            nameRu: person.nameRu || null,
            qid: person.qid || null,
            mobyId: person.mobyId != null ? person.mobyId : null,
            roles: Array.isArray(person.roles) ? person.roles : [],
            roleSource: person.roleSource || person.source || 'wikidata',
            source: person.source || 'wikidata',
            confidence: person.confidence || 'high',
          }))
          .filter((person) => person.name && person.roles.length)
      : [];

    const achievements = gameCache.getAchievements(parsed.userKey, appid);
    const total = achievements ? Number(achievements.totalCount) : 0;
    const unlocked = achievements ? Number(achievements.unlockedCount) : 0;
    const completion = total > 0 && Number.isFinite(unlocked) ? round2((unlocked / total) * 100) : null;

    games.push({
      appid,
      name: cleanName(game.name) || cleanName(details && details.name) || String(appid),
      hours: minutesToHours(game.playtime_forever),
      completion,
      detailsResolved: Boolean(details),
      creditsResolved: Boolean(doc),
      studios,
      people,
    });
  }

  const totalHours = round2(games.reduce((sum, game) => sum + game.hours, 0));
  const wantStudios = STUDIO_ROLES.includes(role);

  const buildItems = (kind) => {
    const entries = [];
    for (const game of games) {
      const list = kind === 'studio' ? game.studios : game.people;
      for (const credit of list) {
        entries.push({ ...credit, game });
      }
    }
    const { groups } = groupEntries(entries, kind, overrides);
    const items = [];
    for (const group of groups) {
      // Studio entities are grouped across both studio roles (one company =
      // one card), but `count`/`hours` only over the games where this entity
      // actually holds the requested role (§7.2: developer and publisher are
      // separate answers, not one "studio" bucket).
      const relevant = group.entries.filter((entry) => (entry.roles || []).includes(role));
      if (!relevant.length) continue;
      const gamesById = new Map();
      for (const entry of relevant) {
        const existing = gamesById.get(entry.game.appid);
        if (existing) {
          for (const r of entry.roles || []) {
            if (!existing.roles.includes(r)) existing.roles.push(r);
          }
          continue;
        }
        gamesById.set(entry.game.appid, {
          appid: entry.game.appid,
          name: entry.game.name,
          hours: entry.game.hours,
          completion: entry.game.completion,
          roles: [...(entry.roles || [])],
        });
      }
      const gameList = [...gamesById.values()];
      const hours = round2(gameList.reduce((sum, game) => sum + game.hours, 0));
      const completions = gameList.map((game) => game.completion).filter((value) => value != null);
      const names = applyManualNames(group, kind, overrides);
      items.push({
        id: itemId(group),
        name: names.display,
        aliases: names.aliases,
        qid: group.qid,
        mobyId: group.mobyId,
        roles: group.roles,
        count: gameList.length,
        hours,
        hoursShare: totalHours > 0 ? round4(hours / totalHours) : 0,
        avgCompletion: completions.length
          ? Math.round(completions.reduce((sum, value) => sum + value, 0) / completions.length)
          : null,
        games: gameList
          .slice()
          .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name, 'ru'))
          .slice(0, gamesLimit)
          .map((game) => ({ appid: game.appid, name: game.name, hours: game.hours })),
        ambiguous: group.ambiguous,
        sources: group.sources.sort(),
      });
    }
    items.sort((a, b) => {
      if (sort === 'count') return b.count - a.count || b.hours - a.hours || a.name.localeCompare(b.name, 'ru');
      if (sort === 'completion') {
        return (
          (b.avgCompletion == null ? -1 : b.avgCompletion) -
            (a.avgCompletion == null ? -1 : a.avgCompletion) || b.hours - a.hours
        );
      }
      if (sort === 'name') return a.name.localeCompare(b.name, 'ru');
      return b.hours - a.hours || b.count - a.count || a.name.localeCompare(b.name, 'ru');
    });
    return items;
  };

  const items = buildItems(wantStudios ? 'studio' : 'person');

  const detailsResolved = games.filter((game) => game.detailsResolved).length;
  const gamesWithCredits = games.filter((game) => game.creditsResolved && game.people.length > 0).length;
  const studiosResolved = games.filter((game) => game.studios.length > 0).length;
  const byRole = {};
  for (const peopleRole of PEOPLE_ROLES) {
    byRole[peopleRole] = games.filter((game) =>
      game.people.some((person) => (person.roles || []).includes(peopleRole))
    ).length;
  }
  // Studio roles are counted separately: a game can have a developer without a
  // publisher and vice versa, and mixing them into `byRole` (people) would
  // make the two numbers incomparable.
  const byStudioRole = {};
  for (const studioRole of STUDIO_ROLES) {
    byStudioRole[studioRole] = games.filter((game) =>
      game.studios.some((studio) => (studio.roles || []).includes(studioRole))
    ).length;
  }
  const gamesTotal = games.length;
  const percent = gamesTotal ? Math.round((gamesWithCredits / gamesTotal) * 100) : 0;
  const studioPercent = gamesTotal ? Math.round((studiosResolved / gamesTotal) * 100) : 0;
  const developerPercent = gamesTotal
    ? Math.round((byStudioRole.developer / gamesTotal) * 100)
    : 0;
  const publisherPercent = gamesTotal
    ? Math.round((byStudioRole.publisher / gamesTotal) * 100)
    : 0;

  const wdState = wikidataProvider.defaultStateStore().read();
  const wdStatus = wikidataStatus(wdState, nowMs, wdEnabled);
  const mobyStatus = mobyProvider.createClient().status();
  const pendingCredits = gamesTotal - gamesWithCredits;
  let pendingReason = null;
  if (pendingCredits > 0) {
    if (wdStatus.state === 'cooldown') pendingReason = 'wikidata_cooldown';
    else if (wdStatus.state === 'disabled' && !mobyStatus.enabled) pendingReason = 'sources_disabled';
    else if (wdStatus.state === 'never_run' && !mobyStatus.enabled) pendingReason = 'wikidata_not_run';
    else if (wdStatus.state === 'unavailable') pendingReason = 'wikidata_unavailable';
    else pendingReason = 'not_fetched';
  } else if (staleLabels > 0) {
    pendingReason = 'labels_stale';
  }

  return {
    profile: parsed.key,
    role,
    // Alias transparency: a cached frontend asking `role=studio` gets the
    // developer answer but can see what it asked for.
    roleRequested: resolvedRole.requested,
    roleAlias: resolvedRole.alias,
    sort,
    // Contract for the frontend role select (default = developer, §7.2).
    roles: {
      accepted: [...ROLES],
      default: DEFAULT_ROLE,
      aliases: { ...ROLE_ALIASES },
      studio: [...STUDIO_ROLES],
      people: [...PEOPLE_ROLES],
    },
    items,
    totals: {
      games: gamesTotal,
      hours: totalHours,
      excludedNonGame,
    },
    coverage: {
      gamesTotal,
      gamesWithDetails: detailsResolved,
      detailsPercent: gamesTotal ? Math.round((detailsResolved / gamesTotal) * 100) : 0,
      gamesWithCredits,
      percent,
      gamesWithStudios: studiosResolved,
      studioPercent,
      gamesWithDevelopers: byStudioRole.developer,
      developerPercent,
      gamesWithPublishers: byStudioRole.publisher,
      publisherPercent,
      byRole,
      byStudioRole,
      // «WD: не запущено» / «WD: недоступно» (reason) — the badge the widget
      // can print next to «Кредиты: N%» without another request.
      wikidata: wdStatus,
    },
    pending: {
      details: gamesTotal - detailsResolved,
      credits: pendingCredits,
      // Documents whose labels were written under an older rule (§4.2): the
      // route re-fetches them once, so a truncated name («Development Studio»)
      // does not survive the 90-day TTL.
      staleLabels,
      // Filled by the route/job layer: is an enrichment pass in flight right
      // now, and why credits are still missing when it is not.
      running: Boolean(options.running),
      jobId: null,
      reason: pendingReason,
    },
    sources: {
      credits: ['steam-store', 'wikidata'].concat(mobyStatus.enabled ? ['mobygames'] : []),
      wikidata: wdStatus,
      mobygames: mobyStatus,
    },
    meta: {
      builtAt: new Date(nowMs).toISOString(),
      buildMs: Date.now() - started,
      gamesConsidered: gamesTotal,
      completionAvailable: games.some((game) => game.completion != null),
      detailsSource: 'cache-games/details',
      creditsCache: 'cache-games/personnel',
      libraryPartial: Boolean(library.partial),
      libraryFetchedAt: library.fetchedAt || null,
    },
  };
}

/** Per-game personnel block for `/api/games/game/:appid` (§5.2). */
function personnelForGame(appid, options = {}) {
  const id = Number(appid);
  const details = readDetails(id);
  const doc = readPersonnelDoc(id);
  const overrides = options.overrides || readOverrides();
  const studios = studiosFromDetails(details);
  if (doc) studios.push(...doc.studios);
  const people = doc ? doc.people : [];
  const groupedStudios = groupEntries(
    studios.map((studio) => ({ ...studio, game: { appid: id, name: '', hours: 0 } })),
    'studio',
    overrides
  ).groups.map((group) => {
    const names = applyManualNames(group, 'studio', overrides);
    return { name: names.display, aliases: names.aliases, roles: group.roles, qid: group.qid, mobyId: group.mobyId, sources: group.sources.sort() };
  });
  const groupedPeople = groupEntries(
    people.map((person) => ({ ...person, game: { appid: id, name: '', hours: 0 } })),
    'person',
    overrides
  ).groups.map((group) => {
    const names = applyManualNames(group, 'person', overrides);
    return {
      name: names.display,
      aliases: names.aliases,
      roles: group.roles,
      qid: group.qid,
      mobyId: group.mobyId,
      roleSource: group.entries[0] ? group.entries[0].roleSource : null,
      sources: group.sources.sort(),
    };
  });
  return {
    studios: groupedStudios,
    people: groupedPeople,
    sources: doc ? doc.sources : [],
    coverage: doc ? doc.coverage || null : null,
    pending: !details && !doc ? ['details', 'credits'] : !doc ? ['credits'] : [],
  };
}

/* ------------------------------------------------------------------ */
/* Enrichment (network phase)                                          */
/* ------------------------------------------------------------------ */

function sourceRank(sources) {
  if (sources.has('mobygames')) return 'mobygames';
  if (sources.has('wikidata')) return 'wikidata';
  if (sources.has('steam-store')) return 'steam-store';
  return [...sources].sort()[0] || null;
}

function strongestRoleSource(entries) {
  if (entries.some((entry) => (entry.roleSource || entry.source) === 'mobygames')) return 'mobygames';
  if (entries.some((entry) => (entry.roleSource || entry.source) === 'wikidata')) return 'wikidata';
  return 'steam-store';
}

/**
 * Merge credits inside one game's document. Reuses `groupEntries`, so the same
 * identity rules apply: a Steam studio without a QID is unified with its
 * Wikidata record by normalized name, while two different QIDs never merge.
 */
function dedupeWithinGame(list, kind) {
  const entries = (list || [])
    .map((entry) => ({ ...entry, game: { appid: 0, name: '', hours: 0 } }))
    .filter((entry) => cleanName(entry.name));
  const { groups } = groupEntries(entries, kind, emptyOverrides());
  return groups.map((group) => {
    const sources = new Set(group.entries.map((entry) => entry.source).filter(Boolean));
    const confidence = group.entries.some((entry) => entry.confidence === 'high')
      ? 'high'
      : (group.entries[0] && group.entries[0].confidence) || 'high';
    return {
      name: group.nameEn || group.names[0] || group.nameRu,
      nameEn: group.nameEn,
      nameRu: group.nameRu,
      qid: group.qid,
      mobyId: group.mobyId,
      roles: group.roles,
      roleSource: strongestRoleSource(group.entries),
      source: sourceRank(sources),
      sources: [...sources].sort(),
      confidence,
      image: (group.entries.find((entry) => entry.image) || {}).image || null,
    };
  });
}

function dedupePeople(list) {
  return dedupeWithinGame(list, 'person');
}

function dedupeStudios(list) {
  return dedupeWithinGame(list, 'studio').map(({ image, ...studio }) => studio);
}

/**
 * Fetch credits for the profile's games and persist `personnel/<appid>.json`.
 * Network phase: Wikidata batches + optional MobyGames per game (1.1 s pause).
 *
 * @param {{profileKey:string, limit?:number, force?:boolean, now?:Function,
 *          wikidata?:object, moby?:object, sleep?:Function}} options
 */
async function enrichPersonnel(options = {}) {
  const parsed = gameCache.parseProfileToken(options.profileKey);
  if (!parsed) {
    throw new PersonnelError(
      `"profile": expected "steam-<steamid64>", got: ${options.profileKey}.`,
      'invalid_profile'
    );
  }
  const library = gameCache.getLibrary(parsed.userKey);
  if (!library) {
    throw new PersonnelError(`No library snapshot for ${parsed.key}.`, 'profile_not_imported', 400);
  }
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const wd = options.wikidata || wikidataProvider;
  const moby = options.moby || mobyProvider.createClient();
  const mobyEnabled = typeof moby.isEnabled === 'function' ? moby.isEnabled() : mobyProvider.mobyEnabled();
  const limit = Math.max(1, Number(options.limit) || 200);
  const force = Boolean(options.force);

  const report = {
    profile: parsed.key,
    games: 0,
    updated: 0,
    skippedFresh: 0,
    pendingDetails: 0,
    wdQueries: 0,
    wdSkipped: null,
    wdDisabledUntil: null,
    wdAnswered: 0,
    wdDeferred: 0,
    mobyRequests: 0,
    mobyErrors: [],
    errors: [],
  };

  const wdEnabled = wd.wikidataEnabled();
  const targets = [];
  for (const game of library.games || []) {
    const appid = Number(game.appid);
    if (!Number.isInteger(appid) || appid <= 0) continue;
    const details = readDetails(appid);
    if (!details) {
      report.pendingDetails++;
      continue;
    }
    if (details.type && details.type !== 'game') continue;
    const links = readLinks(appid);
    const existing = readPersonnelDoc(appid);
    // Which sources can still add something? `wikidata` counts as covered only
    // when the document records that Wikidata actually answered (`wdAsked`),
    // otherwise a failed/skipped run would look complete and the 90-day
    // freshness window would keep the credits away for three months.
    const needs = ['steam-store'];
    if (wdEnabled && !(existing && existing.wdAsked === true)) needs.push('wikidata');
    if (mobyEnabled && links.mobyId && links.mobyPlatformId) needs.push('mobygames');
    // A document written under an older label rule is re-fetched once even
    // while it is still «fresh»: its names may be truncated fragments of the
    // real ones (§4.2, Q3539040 «Development Studio»).
    const labelsStale =
      wdEnabled &&
      Boolean(existing) &&
      existing.wdAsked === true &&
      existing.labelRule !== LABEL_RULE_VERSION;
    const covered =
      Boolean(existing) &&
      !labelsStale &&
      needs.every((source) => (existing.sources || []).includes(source));
    if (!force && covered && isPersonnelFresh(existing, now())) {
      report.skippedFresh++;
      continue;
    }
    targets.push({ appid, details, links, existing, name: game.name });
    if (targets.length >= limit) break;
  }
  report.games = targets.length;

  // Wikidata: one appid batch (resolves P1733) for games without a QID, then
  // one QID batch for the rest. Both are ≤450 values inside the provider.
  const withoutQid = targets.filter((target) => !target.links.qid).map((target) => target.appid);
  if (withoutQid.length && wdEnabled) {
    const result = await wd.creditsForAppids(withoutQid, options);
    report.wdQueries += result.queries;
    report.wdSkipped = result.skipped || report.wdSkipped;
    report.wdDisabledUntil = result.disabledUntil || report.wdDisabledUntil;
    report.errors.push(...(result.errors || []));
    if (!result.skipped && !(result.errors || []).length) {
      // Asked AND answered (even with «nothing»): the negative cache is valid
      // for 90 days, so the game is not asked again on the next run. A network
      // failure / breaker / HTTP error is NOT an answer — `wdAsked` stays
      // false and the game is retried.
      for (const target of targets) {
        if (!target.links.qid) target.wdAsked = true;
      }
    }
    for (const target of targets) {
      const hit = result.credits.get(String(target.appid));
      if (hit) {
        target.wdCredits = hit;
        target.qid = hit.qid;
      }
    }
  }
  const qids = targets
    .filter((target) => !target.wdCredits)
    .map((target) => target.links.qid)
    .filter(Boolean);
  if (qids.length && wdEnabled) {
    const result = await wd.fetchCredits(qids, options);
    report.wdQueries += result.queries;
    report.wdSkipped = result.skipped || report.wdSkipped;
    report.wdDisabledUntil = result.disabledUntil || report.wdDisabledUntil;
    report.errors.push(...(result.errors || []));
    if (!result.skipped && !(result.errors || []).length) {
      for (const target of targets) {
        if (!target.wdCredits && target.links.qid) target.wdAsked = true;
      }
    }
    for (const target of targets) {
      if (target.wdCredits || !target.links.qid) continue;
      const hit = result.credits.get(target.links.qid);
      if (hit) target.wdCredits = hit;
    }
  }

  /** Credits already cached for a source that did not answer this run. */
  const carryOver = (existing, source) => {
    if (!existing || !Array.isArray(existing.sources) || !existing.sources.includes(source)) {
      return { studios: [], people: [] };
    }
    const has = (entry) =>
      entry &&
      (entry.source === source ||
        (Array.isArray(entry.sources) && entry.sources.includes(source)));
    return {
      studios: (existing.studios || []).filter(has),
      people: (existing.people || []).filter(has),
    };
  };

  for (const target of targets) {
    const studios = studiosFromDetails(target.details);
    const people = [];
    const sources = new Set(['steam-store']);
    const wdAnswered = Boolean(target.wdCredits) || target.wdAsked === true;
    if (target.wdCredits) {
      studios.push(...target.wdCredits.studios);
      people.push(...target.wdCredits.people);
      sources.add('wikidata');
    } else if (target.links.qid || target.wdAsked) {
      // Asked, but the game has no WD item/credits: remember the answer so the
      // negative cache lasts 90 days (ИГРЫ §3.3).
      sources.add('wikidata');
    }
    // Wikidata/Moby did not answer (cooldown, outage, budget): keep the credits
    // already cached for that source instead of wiping them with an empty run.
    if (!target.wdCredits && !target.wdAsked) {
      const carried = carryOver(target.existing, 'wikidata');
      if (carried.people.length || carried.studios.length) {
        studios.push(...carried.studios);
        people.push(...carried.people);
        sources.add('wikidata');
      }
    }
    let mobyAnswered = false;
    if (mobyEnabled && target.links.mobyId && target.links.mobyPlatformId) {
      try {
        const doc = await moby.fetchGameCredits({
          mobyId: target.links.mobyId,
          platformId: target.links.mobyPlatformId,
        });
        report.mobyRequests++;
        people.push(...doc.people);
        sources.add('mobygames');
        mobyAnswered = true;
      } catch (err) {
        report.mobyErrors.push((err && err.code) || 'mobygames_failed');
        const carried = carryOver(target.existing, 'mobygames');
        if (carried.people.length) {
          people.push(...carried.people);
          sources.add('mobygames');
        }
      }
    }
    // Nothing was asked successfully and nothing is cached: writing a document
    // now would look «fresh» and hide the credits for 90 days. Defer instead —
    // the next pass (or the lazy route kick) retries.
    if (!wdAnswered && !mobyAnswered && !target.existing) {
      report.wdDeferred++;
      continue;
    }
    if (wdAnswered) report.wdAnswered++;
    const mergedPeople = dedupePeople(people);
    const mergedStudios = dedupeStudios(studios);
    const doc = {
      schemaVersion: 1,
      appid: target.appid,
      name: cleanName(target.name) || null,
      qid: target.qid || target.links.qid || null,
      fetchedAt: new Date(now()).toISOString(),
      // Persisted verdict: «Wikidata was actually asked» (credits or a negative
      // answer). `isPersonnelFresh`/`covered` rely on it, so a transient WDQS
      // failure can never be mistaken for a complete run.
      wdAsked: wdAnswered,
      // Which label rule produced these names (§4.2). Only a real Wikidata
      // answer can raise it: a carried-over document keeps its old number and
      // stays eligible for the one-off re-fetch.
      labelRule: wdAnswered
        ? LABEL_RULE_VERSION
        : (target.existing && target.existing.labelRule) || null,
      studios: mergedStudios,
      people: mergedPeople,
      sources: [...sources].sort(),
      coverage: {
        people: mergedPeople.length,
        studios: mergedStudios.length,
        roles: [...new Set(mergedPeople.flatMap((person) => person.roles || []))].sort(),
      },
      empty: mergedPeople.length === 0 && mergedStudios.length === 0,
    };
    await savePersonnelDoc(target.appid, doc);
    report.updated++;
  }
  return report;
}

module.exports = {
  DETAILS_DIR,
  LINKS_DIR,
  PERSONNEL_DIR,
  OVERRIDES_PATH,
  PERSONNEL_TTL_MS,
  LABEL_RULE_VERSION,
  ROLES,
  ROLE_ALIASES,
  DEFAULT_ROLE,
  STUDIO_ROLES,
  PEOPLE_ROLES,
  SORTS,
  WIKIDATA_BADGES,
  PersonnelError,
  normalizeName,
  normalizeRole,
  resolveRole,
  normalizeSort,
  wikidataStatus,
  minutesToHours,
  readDetails,
  readLinks,
  readPersonnelDoc,
  isPersonnelFresh,
  savePersonnelDoc,
  studiosFromDetails,
  readOverrides,
  saveOverrides,
  mergeOverrides,
  applyOverride,
  buildPersonnel,
  personnelForGame,
  enrichPersonnel,
  dedupePeople,
  dedupeStudios,
};
