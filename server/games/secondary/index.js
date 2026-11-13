'use strict';

const identity = require('./identity');
const bridge = require('./bridge');
const cache = require('./cache');
const titleGenres = require('./title-genres');
const union = require('./union');
const epic = require('./epic');
const enrich = require('./enrich');
const normalize = require('./normalize');

module.exports = {
  EDITION_SUFFIXES: identity.EDITION_SUFFIXES,
  normalizeTitle: identity.normalizeTitle,
  normalizeSlug: identity.normalizeSlug,
  slugsOfLink: identity.slugsOfLink,
  buildGogUnion: identity.buildGogUnion,
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
  yearOfDate: normalize.yearOfDate,
  genreNames: union.genreNames,
  flattenGogSnapshots: union.flattenGogSnapshots,
  buildSecondaryUnion: union.buildSecondaryUnion,
  CONTRACT_VERSION: epic.CONTRACT_VERSION,
  buildEpicLayer: epic.buildEpicLayer,
  buildEpicLayerSync: epic.buildEpicLayerSync,
  buildEpicSources: epic.buildEpicSources,
  epicSourceBlock: epic.epicSourceBlock,
  epicSecondaryWorks: epic.epicSecondaryWorks,
  steamSide: epic.steamSide,
  minutesToHours: epic.minutesToHours,
  applyWikidataYear: enrich.applyWikidataYear,
  applyWikidataFacts: enrich.applyWikidataFacts,
  detailKeyForEntry: enrich.detailKeyForEntry,
  enrichUnionWithDetails: enrich.enrichUnionWithDetails,
};
