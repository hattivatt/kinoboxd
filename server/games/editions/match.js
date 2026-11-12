'use strict';

/**
 * Node-level comparison for the edition index (ИГРЫ-АРХИТЕКТУРА §4.1, M5-B).
 *
 * `nodeOf()` turns one library row (game + cached details + cached links) into
 * the fields the matcher needs; `editionMatch()` says whether two rows may be
 * one work, and with what confidence. Records, QID bridges and the merge guards
 * (type, developers, franchise key, release-year gap) live here; the string
 * primitives are in `normalize.js`.
 */

const {
  hasEditionMarker,
  coreTokens,
  numericSignature,
  levenshtein,
  normalizedDevelopers,
  developersOverlap,
} = require('./normalize');

const MAX_YEAR_GAP_EXACT = 3;
const MAX_YEAR_GAP_EDITION = 15;
const FUZZY_MAX_YEAR_GAP = 2;
const FUZZY_MAX_DISTANCE = 2;

function yearOf(detailsDoc, linkDoc) {
  const detailYear = detailsDoc ? Number(detailsDoc.releaseYear) : NaN;
  if (Number.isInteger(detailYear) && detailYear >= 1970 && detailYear <= 2100) return detailYear;
  const linkYear = linkDoc ? Number(linkDoc.releaseYear) : NaN;
  if (Number.isInteger(linkYear) && linkYear >= 1970 && linkYear <= 2100) return linkYear;
  // Deliberately NOT `baseReleaseYear`: this year feeds the «≤3/≤15 years»
  // merge guard, and the base version's original year is often a decade away
  // from the store's re-release date (`GTA III` 2001 vs 2008) — using it would
  // *break* an otherwise valid title merge. The base year is a display
  // fallback (`stats.js workYear`), not an edition-matching signal.
  return null;
}

function asQid(value) {
  if (value == null) return null;
  const text = String(value).trim().toUpperCase();
  return /^Q\d+$/.test(text) ? text : null;
}

/**
 * Wikidata identity of one library row.
 *
 * **Two document shapes must both work** (audit §4.4e): the raw file on disk
 * stores `{"wikidata": {"qid": "Q…"}}` (and a legacy `{"wikidata": "Q…"}`
 * string), while `franchise.readLinks()` hands out a flat
 * `{qid, baseQid, baseAppid}` view. Reading only `linkDoc.qid` silently lost
 * every QID merge whenever the raw documents were passed in — that is a
 * contract bug, not a heuristic.
 */
function qidOf(linkDoc) {
  if (!linkDoc || typeof linkDoc !== 'object') return null;
  const nested =
    linkDoc.wikidata && typeof linkDoc.wikidata === 'object' ? linkDoc.wikidata : null;
  return asQid(linkDoc.qid) || asQid(nested && nested.qid) || asQid(linkDoc.wikidata);
}

/** B6: QID of the base version of a regional SKU (`wikidata.baseQid`). */
function baseQidOf(linkDoc) {
  if (!linkDoc || typeof linkDoc !== 'object') return null;
  const nested =
    linkDoc.wikidata && typeof linkDoc.wikidata === 'object' ? linkDoc.wikidata : null;
  return asQid(linkDoc.baseQid) || asQid(nested && nested.baseQid);
}

/** B6: Steam appid of the base version (`wikidata.baseAppid`). */
function baseAppidOf(linkDoc) {
  if (!linkDoc || typeof linkDoc !== 'object') return null;
  const nested =
    linkDoc.wikidata && typeof linkDoc.wikidata === 'object' ? linkDoc.wikidata : null;
  const raw = linkDoc.baseAppid != null ? linkDoc.baseAppid : nested && nested.baseAppid;
  const appid = Number(raw);
  return Number.isInteger(appid) && appid > 0 ? appid : null;
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
    baseQid: baseQidOf(linkDoc),
    baseAppid: baseAppidOf(linkDoc),
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

  // B6: the base-version bridge. A regional SKU has no P1733 of its own, so
  // `qid` is null and `baseQid` names the work; the base card carries the same
  // QID as its own `qid`. Two regional SKUs of one base share `baseQid` only.
  // The bridge writes `baseQid` under strict guards (exact normalized label +
  // numeric signature, `franchise.js`), so this is as strong as a QID hit —
  // but the QIDs must actually agree, `null` never matches.
  if (left.qid && right.baseQid && left.qid === right.baseQid) {
    return { confidence: 'qid', reason: 'wikidata_base_qid', qid: left.qid };
  }
  if (right.qid && left.baseQid && right.qid === left.baseQid) {
    return { confidence: 'qid', reason: 'wikidata_base_qid', qid: right.qid };
  }
  if (left.baseQid && right.baseQid && left.baseQid === right.baseQid) {
    return { confidence: 'qid', reason: 'wikidata_base_qid', qid: left.baseQid };
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

/**
 * Work key of a connected component.
 *
 * Precedence: **one own QID** (the SKU's own `P1733` item) beats **one base
 * QID**, and only when neither is unique does the key fall back to
 * `steam:<min appid>`. This matters for a component like
 * `Serious Sam HD: The Second Encounter` + `Serious Sam Classic: …` — Wikidata
 * models them as two items (HD is a remaster), so after the bridge there are
 * two QIDs in one work; the own QID keeps the stable key the title merge had.
 */
function componentKey(appids, nodes) {
  const own = new Set();
  const base = new Set();
  for (const appid of appids) {
    const node = nodes.get(appid);
    if (!node) continue;
    if (node.qid) own.add(node.qid);
    if (node.baseQid) base.add(node.baseQid);
  }
  if (own.size === 1) return `wd:${[...own][0]}`;
  if (own.size === 0 && base.size === 1) return `wd:${[...base][0]}`;
  return `steam:${Math.min(...appids)}`;
}

module.exports = {
  MAX_YEAR_GAP_EXACT,
  MAX_YEAR_GAP_EDITION,
  FUZZY_MAX_YEAR_GAP,
  FUZZY_MAX_DISTANCE,
  yearOf,
  asQid,
  qidOf,
  baseQidOf,
  baseAppidOf,
  nodeOf,
  typeCompatible,
  editionMatch,
  CONFIDENCE_RANK,
  mergeConfidence,
  primaryOf,
  componentKey,
};
