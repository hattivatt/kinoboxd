'use strict';

/**
 * The secondary-library model: **one** place where a GOG/Epic product gets its
 * identity (`workKey`) and where the same owner's libraries are unioned.
 *
 * This module is one barrel over the model modules the domain used to keep
 * as separate files (`identity.js`, `union.js`, `bridge.js`, `epic.js`,
 * `cache.js`, `title-genres.js`, `enrich.js`, `normalize.js`). Everything here
 * is pure plain-objects-in/plain-objects-out apart
 * from explicit cache reads and the one WDQS batch, so it is unit-testable
 * without HTTP or the filesystem.
 *
 * Identity (`workKey`) resolution, strongest first (§14.3):
 *   1. **Wikidata bridge** — a store slug resolved to a Steam appid by the
 *      `P2725`/`P6278` → `P1733` batch, then `appid → workKey` through the
 *      canonical edition index. `P1733` names the **base** game while the
 *      owner's Steam row may be a regional SKU, so the bridge appid is also
 *      resolved through the base identity `links/<appid>.json` carries
 *      (`wikidata.baseQid/baseAppid`, B6);
 *   2. **`links/<appid>.json` `P2725`** — the GOG slug of a Steam work;
 *   3. **exact normalised title** — unique among Steam works, confidence
 *      `medium`; the canonical `editions.coreTitle` key is tried after the
 *      plain key, so edition/region wrappers do not hide the same work;
 *   4. **own work** — `gog:<gogGameId>` / `epic:<catalogItemId>`, confidence
 *      `single`.
 *
 * Hours are **never summed across sources**: `hoursBySource.steam/gog/epic`
 * stay separate numbers (the display sum is `displayMinutes`, computed here
 * once so no aggregate can forget the rule). An unknown number is **never** a
 * zero: `hoursBySource.<store>` is `null` and the entry is `hoursUnknown`.
 *
 * The identity bridge (`links/secondary.json`) is also the last-resort source
 * of a release year (`P577`) and of a genre line (`P136`) for a store document
 * that carries no date/genres; `applyWikidataYear()` fills only an **empty**
 * year and `applyWikidataFacts()` also fills only an **empty** genre list —
 * store/catalog values are never replaced. Genres never enter the identity
 * maps: a title match stays a metadata answer, not a `P6278` link.
 */

const identity = require('./identity');
const bridge = require('./bridge');
const cache = require('./cache');
const titleGenres = require('./title-genres');
const union = require('./union');
const epic = require('./epic');
const enrich = require('./enrich');
const normalize = require('./normalize');

module.exports = {
  // titles / slugs / edition markers
  EDITION_SUFFIXES: identity.EDITION_SUFFIXES,
  normalizeTitle: identity.normalizeTitle,
  normalizeSlug: identity.normalizeSlug,
  slugsOfLink: identity.slugsOfLink,
  buildGogUnion: identity.buildGogUnion,
  // identity bridge
  WDQS: bridge.WDQS,
  BATCH_SIZE: bridge.BATCH_SIZE,
  CACHE_PATH: cache.CACHE_PATH,
  SecondaryIdentityError: bridge.SecondaryIdentityError,
  buildBridgeQuery: bridge.buildBridgeQuery,
  parseBridgeResponse: bridge.parseBridgeResponse,
  titleVariants: identity.titleVariants,
  buildTitleQuery: titleGenres.buildTitleQuery,
  wikidataGenreName: titleGenres.wikidataGenreName,
  parseTitleResponse: titleGenres.parseTitleResponse,
  collectTitleCandidates: titleGenres.collectTitleCandidates,
  isSettledEntry: cache.isSettledEntry,
  isSettledTitleEntry: cache.isSettledTitleEntry,
  emptyEntry: cache.emptyEntry,
  readSecondaryLinks: cache.readSecondaryLinks,
  readSecondaryLink: cache.readSecondaryLink,
  readSecondaryTitleLinks: cache.readSecondaryTitleLinks,
  readSecondaryTitleLink: cache.readSecondaryTitleLink,
  readCache: cache.readCache,
  writeCache: cache.writeCache,
  fetchSecondaryLinks: bridge.fetchSecondaryLinks,
  fetchSecondaryTitleLinks: titleGenres.fetchSecondaryTitleLinks,
  collectSlugs: identity.collectSlugs,
  refreshForJob: titleGenres.refreshForJob,
  // union
  yearOfDate: normalize.yearOfDate,
  genreNames: union.genreNames,
  flattenGogSnapshots: union.flattenGogSnapshots,
  buildSecondaryUnion: union.buildSecondaryUnion,
  // Epic read model
  CONTRACT_VERSION: epic.CONTRACT_VERSION,
  buildEpicLayer: epic.buildEpicLayer,
  buildEpicLayerSync: epic.buildEpicLayerSync,
  buildEpicSources: epic.buildEpicSources,
  epicSourceBlock: epic.epicSourceBlock,
  epicSecondaryWorks: epic.epicSecondaryWorks,
  steamSide: epic.steamSide,
  minutesToHours: epic.minutesToHours,
  // store documents
  applyWikidataYear: enrich.applyWikidataYear,
  applyWikidataFacts: enrich.applyWikidataFacts,
  detailKeyForEntry: enrich.detailKeyForEntry,
  enrichUnionWithDetails: enrich.enrichUnionWithDetails,
};
