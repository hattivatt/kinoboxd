'use strict';

const {
  CACHE_DIR,
  DEBUG_DIR,
  CATALOG_PROBE_DIR,
  CATALOG_STATE_PATH,
  STATUS_PATH,
  readCatalogProbe,
  writeCatalogProbe,
  writeCatalogState,
  readCatalogAttempt,
  recordCatalogAttempt,
  readDetail,
  writeDetail,
  readDetailsIndex,
  writeBreaker,
  breakerBlock,
  readStatusState,
} = require('./secondary/store');
const {
  yearOfDate,
  absoluteUrl,
  normalizeGogProduct,
  normalizeEpicProduct,
  pickEpicPage,
  epicTagName,
  epicGenresFromCategories,
  sanitizeEpicGenres,
  sanitizeDetailGenres,
  catalogAnswersMissing,
  catalogMetaFlags,
  slugFromTitle,
} = require('./secondary/normalize');
const { refetchEpicCatalog, resolveEpic } = require('./sources/epic');
const { resolveGog } = require('./sources/gog');
const {
  applyWikidataYear,
  applyWikidataFacts,
  enrichUnionWithDetails,
} = require('./secondary/enrich');
const { startSecondaryDetails, runningFor, jobFor } = require('./secondary/details-job');
const {
  kickGate,
  kickSecondaryDetailsQuietly,
  kickFromStats,
} = require('./secondary/details-kick');
const {
  coverageNeedsKick,
  coverageForOwner,
} = require('./secondary/details-coverage');
const { titleCandidatesFor } = require('./secondary/details-run');
const { statusForOwner } = require('./secondary/details-status');
const { targetsForOwner } = require('./secondary/details-targets');
const { resetJobs } = require('./secondary/details-state');

module.exports = {
  CACHE_DIR,
  DEBUG_DIR,
  CATALOG_PROBE_DIR,
  CATALOG_STATE_PATH,
  STATUS_PATH,
  yearOfDate,
  absoluteUrl,
  normalizeGogProduct,
  normalizeEpicProduct,
  pickEpicPage,
  epicTagName,
  epicGenresFromCategories,
  sanitizeEpicGenres,
  sanitizeDetailGenres,
  catalogAnswersMissing,
  catalogMetaFlags,
  refetchEpicCatalog,
  readCatalogProbe,
  writeCatalogProbe,
  writeCatalogState,
  readCatalogAttempt,
  recordCatalogAttempt,
  applyWikidataYear,
  applyWikidataFacts,
  slugFromTitle,
  readDetail,
  writeDetail,
  readDetailsIndex,
  enrichUnionWithDetails,
  writeBreaker,
  breakerBlock,
  readStatusState,
  resolveGog,
  resolveEpic,
  startSecondaryDetails,
  kickSecondaryDetailsQuietly,
  kickGate,
  kickFromStats,
  coverageNeedsKick,
  coverageForOwner,
  titleCandidatesFor,
  statusForOwner,
  runningFor,
  jobFor,
  targetsForOwner,
  resetJobs,
};
