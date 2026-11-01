'use strict';

/**
 * Edition matching for the games tab (ИГРЫ-АРХИТЕКТУРА §4.1, M5-B).
 *
 * One Steam game often has several store entries: a base card, a regional
 * re-release (`Dishonored RHCP`, `Max Payne (RU)`, `Fallout: New Vegas PCR`),
 * a remaster (`BioShock` / `BioShock Remastered`) or a re-release with a new
 * appid and no suffix at all (`Wasteland 2` / `Wasteland 2: Director's Cut`).
 * The owner does not want those rows counted as separate games, so the stats
 * payload aggregates them under one canonical work.
 *
 * Two signals, strongest first:
 *
 *   1. **Wikidata QID** — `links/<appid>.json` maps two appids to the same
 *      item (P1733). That is authoritative: merge, confidence `qid`.
 *   2. **Normalized title** — strip edition/region wrappers
 *      (`Special Edition`, `Enhanced`, `GOTY`, `Definitive`, `Director's Cut`,
 *      `Remastered`, `Warmastered`, `Legacy`, `Classic`, `HD`, `(RU)`, `RHCP`,
 *      `PCR`, …), then require an exact normalized match. Fuzzy (Levenshtein
 *      ≤2) is allowed only as a last resort and only with a strict guard.
 *
 * False-positive guards (the whole point — a merge is a data change):
 *
 *   - `type` must not differ; only `game`/unknown rows are mergeable (DLC and
 *     tools never merge with a base game);
 *   - the numeric signature (`2`, `III`, `IV`, …) must be identical, so
 *     `Gothic 1` ≠ `Gothic 2`, `GTA III` ≠ `GTA IV`;
 *   - if both rows carry developers, they must overlap (regional cards often
 *     have no credits, so a missing side is not a rejection);
 *   - if both rows carry a franchise key, it must be the same;
 *   - release years must be close: ≤3 years for a plain title match (guards
 *     `DOOM` 1993 vs `DOOM` 2016), ≤15 years when the title carries an
 *     explicit edition marker (`GTA V Legacy` 2015 vs `Enhanced` 2025);
 *   - fuzzy matches additionally require a developer overlap and ≤2 years.
 *
 * Deliberately **not** merged: `Counter-Strike` vs `Counter-Strike: Source`,
 * `BioShock` vs `BioShock Infinite` (different normalized titles, no fuzzy
 * hit), `Dark Messiah … Single Player` vs `… Multi-Player` (mode suffix is not
 * an edition marker), `Arma 2: Operation Arrowhead` vs its `Beta (Obsolete)`
 * card. A remaster whose title kept a subtitle (`The Raven - Legacy of a
 * Master Thief` vs `The Raven Remastered`) is also left alone: title-only
 * matching cannot tell that subtitle from `Counter-Strike: Source`.
 *
 * Persistence: `cache-games/editions.json` (one document, `profiles` keyed by
 * `steam-<steamid64>`, the same shape idea as `links/`). The document stores
 * the input fingerprint (library fingerprint + details/links watermarks), so
 * a rebuild happens when the library or the metadata moved, and it stores
 * `manual.merges` / `manual.splits` which survive every rebuild.
 */

const path = require('path');

const gameCache = require('./game-cache');

const ALGORITHM_VERSION = 1;
const EDITIONS_PATH = path.join(gameCache.GAMES_CACHE_DIR, 'editions.json');

const MAX_YEAR_GAP_EXACT = 3;
const MAX_YEAR_GAP_EDITION = 15;
const FUZZY_MAX_YEAR_GAP = 2;
const FUZZY_MAX_DISTANCE = 2;

/** Words that are an edition wrapper wherever they appear in a title. */
const EDITION_WORDS = new Set([
  'edition',
  'remastered',
  'remaster',
  'warmastered',
  'enhanced',
  'definitive',
  'deluxe',
  'ultimate',
  'complete',
  'extended',
  'anniversary',
  'special',
  'classic',
  'hd',
  'goty',
]);

/** Multi-word wrappers, removed before the single words above. */
const EDITION_PHRASES = [
  ['game', 'of', 'the', 'year'],
  ['director', 's', 'cut'],
  ['directors', 'cut'],
  ['gold', 'classic'],
  ['black', 'edition'],
  ['steam', 'edition'],
  ['legacy', 'edition'],
  ['reloaded', 'edition'],
];

/** Region wrappers: only stripped when trailing or parenthesized. */
const REGION_WORDS = new Set([
  'ru',
  'rhcp',
  'pcr',
  'cis',
  'row',
  'eur',
  'eu',
  'us',
  'jp',
  'kr',
  'cn',
  'br',
  'pl',
  'cz',
]);

function cleanName(value) {
  return String(value == null ? '' : value)
    .replace(/\u00a0/g, ' ')
    .replace(/[™®©]/g, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»“”„"']/g, ' ')
    .replace(/[—–]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRomanNumber(token) {
  return /^[ivxlcdm]+$/.test(token) && token.length <= 6;
}

/** `2`, `III`, `IV` — the part that must never differ between editions. */
function numericSignature(tokens) {
  return tokens
    .filter((token) => /^\d+$/.test(token) || isRomanNumber(token))
    .join(',');
}

function dropPhrases(tokens) {
  let current = tokens;
  let changed = true;
  while (changed) {
    changed = false;
    for (const phrase of EDITION_PHRASES) {
      for (let index = 0; index + phrase.length <= current.length; index++) {
        let hit = true;
        for (let offset = 0; offset < phrase.length; offset++) {
          if (current[index + offset] !== phrase[offset]) {
            hit = false;
            break;
          }
        }
        if (hit) {
          current = [...current.slice(0, index), ...current.slice(index + phrase.length)];
          changed = true;
          index = -1;
        }
      }
    }
  }
  return current;
}

function hasEditionMarker(raw) {
  const value = cleanName(raw);
  if (!value) return false;
  if (/\([^)]*\)/.test(value)) {
    const inner = value.replace(/^.*\(([^)]*)\).*$/, '$1').trim();
    if (inner && (REGION_WORDS.has(inner) || inner.split(' ').some((word) => EDITION_WORDS.has(word)))) {
      return true;
    }
  }
  const tokens = value.split(' ').filter(Boolean);
  return tokens.some((token) => EDITION_WORDS.has(token) || REGION_WORDS.has(token)) ||
    EDITION_PHRASES.some((phrase) =>
      tokens.some((_, index) => phrase.every((word, offset) => tokens[index + offset] === word))
    );
}

/**
 * Normalized title tokens: edition/region wrappers removed, punctuation gone.
 * The numeric part is kept, because it is the main false-positive guard.
 *
 * Region wrappers are only dropped when they are unambiguously wrappers:
 * `(RU)`, or a trailing ALL-CAPS token (`Max Payne RU`, `… PCR`). A trailing
 * lowercase word is part of the title — otherwise `The Last of Us` would
 * become `the last of`.
 */
function coreTokens(name) {
  const raw = String(name == null ? '' : name);
  // Parenthesized wrappers: `(Classic)`, `(RU)` — but never `(2016)`, `(Obsolete)`.
  const parenWrappers = [];
  raw.replace(/\(([^)]*)\)/g, (match, inner) => {
    const text = String(inner || '').trim();
    if (!text) return match;
    const lower = text.toLowerCase();
    const words = lower.split(/\s+/).filter(Boolean);
    if (REGION_WORDS.has(lower) && text === text.toUpperCase()) parenWrappers.push(text);
    else if (words.length && words.every((word) => EDITION_WORDS.has(word))) parenWrappers.push(text);
    return match;
  });

  let value = cleanName(raw);
  if (!value) return [];
  for (const wrapper of parenWrappers) {
    const cleaned = cleanName(wrapper);
    if (!cleaned) continue;
    value = value.replace(new RegExp(`(?:^|\\s)${cleaned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`), ' ');
  }
  let tokens = value.split(' ').filter(Boolean);

  // Trailing region token, only when the original spelled it in caps.
  const trailing = raw.match(/([A-Za-z]{2,5})\s*\)?\s*$/);
  if (trailing && trailing[1] === trailing[1].toUpperCase()) {
    const region = trailing[1].toLowerCase();
    if (REGION_WORDS.has(region)) {
      while (tokens.length && tokens[tokens.length - 1] === region) tokens.pop();
    }
  }

  tokens = dropPhrases(tokens);
  tokens = tokens.filter((token) => !EDITION_WORDS.has(token));
  // `Legacy` is a real word (`Legacy of Kain`), so only a trailing one is a wrapper.
  while (tokens.length && tokens[tokens.length - 1] === 'legacy') tokens.pop();
  return tokens;
}

function coreTitle(name) {
  return coreTokens(name).join(' ');
}

function levenshtein(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

function normalizedDevelopers(doc) {
  if (!doc || !Array.isArray(doc.developers)) return [];
  const out = [];
  for (const raw of doc.developers) {
    const name = cleanName(raw);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function developersOverlap(left, right) {
  if (!left.length || !right.length) return null;
  return left.some((name) => right.includes(name));
}

function yearOf(detailsDoc, linkDoc) {
  const detailYear = detailsDoc ? Number(detailsDoc.releaseYear) : NaN;
  if (Number.isInteger(detailYear) && detailYear >= 1970 && detailYear <= 2100) return detailYear;
  const linkYear = linkDoc ? Number(linkDoc.releaseYear) : NaN;
  if (Number.isInteger(linkYear) && linkYear >= 1970 && linkYear <= 2100) return linkYear;
  return null;
}

function qidOf(linkDoc) {
  const qid = linkDoc && linkDoc.qid ? String(linkDoc.qid).trim().toUpperCase() : null;
  return qid && /^Q\d+$/.test(qid) ? qid : null;
}

/** One library row with the name it is matched by. */
function nodeOf(game, detailsDoc, linkDoc) {
  // The library name is the owner-facing one and, unlike `appdetails.name`,
  // it is per-entry: some store documents repeat the base game's name for a
  // separate multiplayer/DLC appid (`Dark Messiah … Multi-Player` answered as
  // `Dark Messiah of Might & Magic`). Details are a fallback only.
  const rawName = (game && game.name) || (detailsDoc && detailsDoc.name) || null;
  const names = [];
  if (rawName) {
    const tokens = coreTokens(rawName);
    const key = tokens.join(' ');
    if (key) names.push({ raw: String(rawName), tokens, key, marker: hasEditionMarker(rawName) });
  }
  return {
    appid: Number(game.appid),
    name: rawName || null,
    names,
    type: detailsDoc && detailsDoc.type ? String(detailsDoc.type) : null,
    developers: normalizedDevelopers(detailsDoc),
    year: yearOf(detailsDoc, linkDoc),
    qid: qidOf(linkDoc),
    franchiseKey: (linkDoc && linkDoc.franchiseKey) || null,
  };
}

function typeCompatible(left, right) {
  if (left.type && left.type !== 'game') return false;
  if (right.type && right.type !== 'game') return false;
  if (left.type && right.type && left.type !== right.type) return false;
  return true;
}

/**
 * Why two rows may be the same work, or `null` when they may not.
 * `confidence` is one of `qid` / `exact-edition` / `exact` / `fuzzy`.
 */
function editionMatch(left, right) {
  if (!left || !right || left.appid === right.appid) return null;
  if (!typeCompatible(left, right)) return null;

  if (left.qid && right.qid && left.qid === right.qid) {
    return { confidence: 'qid', reason: 'wikidata_qid', qid: left.qid };
  }

  if (
    left.franchiseKey &&
    right.franchiseKey &&
    left.franchiseKey !== right.franchiseKey
  ) {
    return null;
  }

  const developerHit = developersOverlap(left.developers, right.developers);
  if (developerHit === false) return null;

  const gap =
    left.year != null && right.year != null ? Math.abs(left.year - right.year) : null;

  let best = null;
  for (const leftName of left.names) {
    for (const rightName of right.names) {
      if (numericSignature(leftName.tokens) !== numericSignature(rightName.tokens)) continue;
      if (leftName.key === rightName.key) {
        const edition = leftName.marker || rightName.marker;
        const limit = edition ? MAX_YEAR_GAP_EDITION : MAX_YEAR_GAP_EXACT;
        if (gap != null && gap > limit) continue;
        const candidate = {
          confidence: edition ? 'exact-edition' : 'exact',
          reason: edition ? 'normalized_title_edition' : 'normalized_title',
        };
        if (!best || candidate.confidence === 'exact-edition') best = candidate;
        continue;
      }
      if (best) continue;
      const shorter =
        leftName.key.length <= rightName.key.length ? leftName.key : rightName.key;
      const longer =
        leftName.key.length <= rightName.key.length ? rightName.key : leftName.key;
      if (shorter.length < 6) continue;
      if (Math.abs(shorter.length - longer.length) > FUZZY_MAX_DISTANCE) continue;
      if (levenshtein(shorter, longer) > FUZZY_MAX_DISTANCE) continue;
      // Fuzzy is only a typo-level last resort: same developers and a tight year.
      if (developerHit !== true) continue;
      if (gap != null && gap > FUZZY_MAX_YEAR_GAP) continue;
      best = { confidence: 'fuzzy', reason: 'fuzzy_title' };
    }
  }
  return best;
}

const CONFIDENCE_RANK = { single: 0, fuzzy: 1, exact: 2, 'exact-edition': 3, qid: 4, manual: 5 };

function mergeConfidence(left, right) {
  return (CONFIDENCE_RANK[left] || 0) >= (CONFIDENCE_RANK[right] || 0) ? left : right;
}

function primaryOf(appids, nodes, gamesByAppid) {
  const sorted = [...appids].sort((left, right) => {
    const leftGame = gamesByAppid.get(left) || {};
    const rightGame = gamesByAppid.get(right) || {};
    const minutes = (Number(rightGame.playtime_forever) || 0) - (Number(leftGame.playtime_forever) || 0);
    if (minutes) return minutes;
    const leftNode = nodes.get(left) || {};
    const rightNode = nodes.get(right) || {};
    // Tie: prefer a row with real credits, then the earliest release, then appid.
    const credits = rightNode.developers.length - leftNode.developers.length;
    if (credits) return credits;
    const years = (leftNode.year || 9999) - (rightNode.year || 9999);
    if (years) return years;
    return left - right;
  });
  return sorted[0];
}

function componentKey(appids, nodes) {
  const qids = new Set();
  for (const appid of appids) {
    const node = nodes.get(appid);
    if (node && node.qid) qids.add(node.qid);
  }
  if (qids.size === 1) return `wd:${[...qids][0]}`;
  return `steam:${Math.min(...appids)}`;
}

/**
 * Build the edition index from library rows + cached details/links.
 * Pure: no disk reads. `manual` is `{ merges: [[a,b]], splits: [[a,b]] }`.
 */
function buildEditionIndex(input = {}) {
  const games = Array.isArray(input.games) ? input.games : [];
  const details = input.details && typeof input.details === 'object' ? input.details : {};
  const links = input.links && typeof input.links === 'object' ? input.links : {};
  const manual = input.manual && typeof input.manual === 'object' ? input.manual : {};

  const nodes = new Map();
  const gamesByAppid = new Map();
  for (const game of games) {
    const appid = Number(game && game.appid);
    if (!Number.isInteger(appid) || appid <= 0) continue;
    if (nodes.has(appid)) continue;
    const detailsDoc =
      details[String(appid)] && details[String(appid)].success ? details[String(appid)] : null;
    const linkDoc = links[String(appid)] || null;
    nodes.set(appid, nodeOf(game, detailsDoc, linkDoc));
    gamesByAppid.set(appid, game);
  }

  const blocked = new Set();
  for (const pair of Array.isArray(manual.splits) ? manual.splits : []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const left = Number(pair[0]);
    const right = Number(pair[1]);
    if (!Number.isInteger(left) || !Number.isInteger(right)) continue;
    blocked.add(`${Math.min(left, right)}:${Math.max(left, right)}`);
  }

  const adjacency = new Map();
  const confidences = new Map();
  const addEdge = (left, right, confidence) => {
    const key = `${Math.min(left, right)}:${Math.max(left, right)}`;
    if (blocked.has(key)) return;
    if (!adjacency.has(left)) adjacency.set(left, new Set());
    if (!adjacency.has(right)) adjacency.set(right, new Set());
    adjacency.get(left).add(right);
    adjacency.get(right).add(left);
    confidences.set(key, mergeConfidence(confidences.get(key) || 'single', confidence));
  };

  const appids = [...nodes.keys()];
  // Pass 1: same Wikidata QID is authoritative.
  const byQid = new Map();
  for (const appid of appids) {
    const node = nodes.get(appid);
    if (!node.qid) continue;
    const list = byQid.get(node.qid) || [];
    list.push(appid);
    byQid.set(node.qid, list);
  }
  for (const list of byQid.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const match = editionMatch(nodes.get(list[i]), nodes.get(list[j]));
        if (match && match.confidence === 'qid') addEdge(list[i], list[j], 'qid');
      }
    }
  }

  // Pass 2: normalized title. Index by normalized key so only real candidates
  // reach the (more expensive) guard code.
  const byTitle = new Map();
  for (const appid of appids) {
    const node = nodes.get(appid);
    for (const name of node.names) {
      const list = byTitle.get(name.key) || [];
      if (!list.includes(appid)) list.push(appid);
      byTitle.set(name.key, list);
    }
  }
  for (const list of byTitle.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const match = editionMatch(nodes.get(list[i]), nodes.get(list[j]));
        if (match) addEdge(list[i], list[j], match.confidence);
      }
    }
  }

  // Pass 3: fuzzy — only rows with the same numeric signature and a length
  // within two edits. This is O(k²) inside a signature bucket, tiny in practice.
  const bySignature = new Map();
  for (const appid of appids) {
    const node = nodes.get(appid);
    for (const name of node.names) {
      const signature = numericSignature(name.tokens);
      const list = bySignature.get(signature) || [];
      if (!list.includes(appid)) list.push(appid);
      bySignature.set(signature, list);
    }
  }
  for (const list of bySignature.values()) {
    if (list.length < 2 || list.length > 60) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const match = editionMatch(nodes.get(list[i]), nodes.get(list[j]));
        if (match && match.confidence === 'fuzzy') addEdge(list[i], list[j], 'fuzzy');
      }
    }
  }

  // Manual merges win over every heuristic (and over a split of the same pair).
  for (const pair of Array.isArray(manual.merges) ? manual.merges : []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const left = Number(pair[0]);
    const right = Number(pair[1]);
    if (!nodes.has(left) || !nodes.has(right)) continue;
    const key = `${Math.min(left, right)}:${Math.max(left, right)}`;
    blocked.delete(key);
    addEdge(left, right, 'manual');
  }

  // Connected components.
  const seen = new Set();
  const components = [];
  for (const appid of appids) {
    if (seen.has(appid)) continue;
    const stack = [appid];
    const component = [];
    seen.add(appid);
    while (stack.length) {
      const current = stack.pop();
      component.push(current);
      for (const neighbour of adjacency.get(current) || []) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        stack.push(neighbour);
      }
    }
    components.push(component.sort((a, b) => a - b));
  }

  const canonical = {};
  const groups = [];
  let mergedAppids = 0;
  for (const component of components) {
    const primaryAppid = primaryOf(component, nodes, gamesByAppid);
    const workKey = componentKey(component, nodes);
    let confidence = 'single';
    for (let i = 0; i < component.length; i++) {
      for (let j = i + 1; j < component.length; j++) {
        const key = `${Math.min(component[i], component[j])}:${Math.max(component[i], component[j])}`;
        const edge = confidences.get(key);
        if (edge) confidence = mergeConfidence(confidence, edge);
      }
    }
    const editionList = component.map((appid) => {
      const node = nodes.get(appid) || {};
      const game = gamesByAppid.get(appid) || {};
      return {
        appid,
        name: node.name || null,
        hours: Math.round(((Number(game.playtime_forever) || 0) / 60) * 10) / 10,
        isPrimary: appid === primaryAppid,
      };
    });
    const entry = {
      workKey,
      primaryAppid,
      appids: component,
      editions: editionList,
      editionCount: component.length,
      confidence,
    };
    for (const appid of component) canonical[String(appid)] = entry;
    if (component.length > 1) {
      mergedAppids += component.length;
      groups.push({
        workKey,
        primaryAppid,
        appids: component,
        editions: editionList,
        confidence,
        names: component
          .map((appid) => (nodes.get(appid) || {}).name)
          .filter(Boolean),
      });
    }
  }

  groups.sort((left, right) => right.appids.length - left.appids.length || left.primaryAppid - right.primaryAppid);

  return {
    schemaVersion: 1,
    algorithmVersion: ALGORITHM_VERSION,
    profileKey: input.profileKey || null,
    libraryFingerprint: input.libraryFingerprint || null,
    inputsFingerprint: input.inputsFingerprint || null,
    builtAt: new Date().toISOString(),
    manual: {
      merges: Array.isArray(manual.merges) ? manual.merges : [],
      splits: Array.isArray(manual.splits) ? manual.splits : [],
    },
    groups,
    canonical,
    meta: {
      appids: appids.length,
      works: components.length,
      groups: groups.length,
      gamesMerged: mergedAppids,
      savedCount: appids.length - components.length,
    },
  };
}

/**
 * Cheap watermark of everything the grouping depends on. Details arrive after
 * the library import, so the library fingerprint alone is not enough.
 */
function inputSignature(library, details, links) {
  const libraryFingerprint = (library && library.fingerprint) || '';
  const describe = (map) => {
    let count = 0;
    let latest = '';
    for (const doc of Object.values(map && typeof map === 'object' ? map : {})) {
      if (!doc || typeof doc !== 'object') continue;
      if (doc.success === false) continue;
      count++;
      const stamp = String(doc.fetchedAt || '');
      if (stamp > latest) latest = stamp;
    }
    return `${count}:${latest}`;
  };
  return `${libraryFingerprint}|d${describe(details)}|l${describe(links)}`;
}

/** True when every one of `games` has a canonical entry in `doc`. */
function covers(doc, games) {
  if (!doc || !doc.canonical || typeof doc.canonical !== 'object') return false;
  for (const game of Array.isArray(games) ? games : []) {
    const appid = Number(game && game.appid);
    if (!Number.isInteger(appid)) continue;
    if (!doc.canonical[String(appid)]) return false;
  }
  return true;
}

/**
 * `editionKeyOf(doc, appid)` → the canonical work key of a store row, or a
 * per-appid fallback when the index has not seen it yet.
 */
function editionKeyOf(doc, appid) {
  const entry = doc && doc.canonical ? doc.canonical[String(appid)] : null;
  return entry && entry.workKey ? entry.workKey : `steam:${appid}`;
}

/* ------------------------------------------------------------------ */
/* Persistence (`cache-games/editions.json`, profiles keyed)            */
/* ------------------------------------------------------------------ */

function readEditionsFile() {
  const hit = gameCache.readJsonWithFingerprint(EDITIONS_PATH);
  if (!hit || !hit.data || typeof hit.data !== 'object') {
    return { schemaVersion: 1, profiles: {} };
  }
  return {
    schemaVersion: Number(hit.data.schemaVersion) || 1,
    profiles:
      hit.data.profiles && typeof hit.data.profiles === 'object' ? hit.data.profiles : {},
  };
}

function readEditions(profileKey) {
  const file = readEditionsFile();
  const doc = file.profiles[String(profileKey)];
  return doc && typeof doc === 'object' ? doc : null;
}

function saveEditions(profileKey, doc) {
  const file = readEditionsFile();
  file.profiles[String(profileKey)] = doc;
  file.schemaVersion = 1;
  gameCache.writeJsonAtomicSync(EDITIONS_PATH, file);
  return doc;
}

/**
 * Read the persisted index, or rebuild+persist it when the inputs moved.
 * Manual overrides survive the rebuild. Returns the document (never null).
 */
function ensureEditions(profileKey, input = {}) {
  const existing = readEditions(profileKey);
  const signature = inputSignature(input.library, input.details, input.links);
  const fresh =
    existing &&
    Number(existing.algorithmVersion) === ALGORITHM_VERSION &&
    existing.inputsFingerprint === signature &&
    covers(existing, input.games);
  if (fresh) return { doc: existing, rebuilt: false };
  const built = buildEditionIndex({
    games: input.games,
    details: input.details,
    links: input.links,
    manual: existing && existing.manual,
    profileKey,
    libraryFingerprint: input.library && input.library.fingerprint,
    inputsFingerprint: signature,
  });
  saveEditions(profileKey, built);
  return { doc: built, rebuilt: true };
}

module.exports = {
  ALGORITHM_VERSION,
  EDITIONS_PATH,
  MAX_YEAR_GAP_EXACT,
  MAX_YEAR_GAP_EDITION,
  FUZZY_MAX_YEAR_GAP,
  FUZZY_MAX_DISTANCE,
  EDITION_WORDS,
  EDITION_PHRASES,
  REGION_WORDS,
  cleanName,
  hasEditionMarker,
  coreTokens,
  coreTitle,
  numericSignature,
  levenshtein,
  editionMatch,
  buildEditionIndex,
  inputSignature,
  covers,
  editionKeyOf,
  readEditionsFile,
  readEditions,
  saveEditions,
  ensureEditions,
};
