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

const {
  EDITION_WORDS,
  EDITION_PHRASES,
  REGION_WORDS,
  cleanName,
  hasEditionMarker,
  coreTokens,
  coreTitle,
  numericSignature,
  levenshtein,
} = require('./normalize');
const {
  MAX_YEAR_GAP_EXACT,
  MAX_YEAR_GAP_EDITION,
  FUZZY_MAX_YEAR_GAP,
  FUZZY_MAX_DISTANCE,
  editionMatch,
  qidOf,
  baseQidOf,
  baseAppidOf,
  nodeOf,
} = require('./match');
const {
  ALGORITHM_VERSION,
  buildEditionIndex,
  inputSignature,
  manualSignature,
  covers,
  editionKeyOf,
} = require('./index-build');
const {
  EDITIONS_PATH,
  readEditionsFile,
  readEditions,
  saveEditions,
  ensureEditions,
} = require('./store');

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
  qidOf,
  baseQidOf,
  baseAppidOf,
  nodeOf,
  buildEditionIndex,
  inputSignature,
  manualSignature,
  covers,
  editionKeyOf,
  readEditionsFile,
  readEditions,
  saveEditions,
  ensureEditions,
};
