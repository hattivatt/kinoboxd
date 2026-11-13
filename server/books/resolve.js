'use strict';

const {
  normalizeTitle,
  tokensOf,
  tokenJaccard,
  surnameOf,
  normalizeIsbn,
  isbn10to13,
  isbn10Of,
} = require('./normalize');
const {
  ISBN_BATCH_SIZE,
  ISBN_QUERY,
  lookupIsbns,
} = require('./hardcover-editions');
const providers = require('./providers');
const livelibCard = require('./providers/livelib-card');
const litres = require('./providers/litres');
const googlebooks = require('./providers/googlebooks');

const {
  AUTHOR_ALIASES,
  authorKeySet,
  authorsOverlap,
  positionOf,
  guardReject,
  scoreCandidate,
  bestCandidate,
} = require('./resolve-stages/matching');
const {
  CHAIN_NAMES,
  CYRILLIC_TITLE,
  createChainReport,
  eventKeyOf,
  isbnOfEvent,
} = require('./resolve-stages/identity');
const { listDetailsFiles, buildCorpus } = require('./resolve-stages/corpus');
const { createContext } = require('./resolve-stages/context');
const { buildPlan } = require('./resolve-stages/plan');
const {
  createReport,
  finalizeReport,
  logReport,
} = require('./resolve-stages/report');
const { createLookup, applyIsbnLinks } = require('./resolve-stages/isbn-stage');
const { matchCorpus } = require('./resolve-stages/title-stage');
const { prepareChain } = require('./resolve-stages/chain');
const { runLitres } = require('./resolve-stages/litres-stage');
const { runCard } = require('./resolve-stages/card-stage');
const { patchYearClaims } = require('./resolve-stages/year-stage');
const { persistLinks } = require('./resolve-stages/persist');

async function resolveProfile(llProfile, options = {}) {
  const ctx = createContext(llProfile, options);
  ctx.lookup = createLookup(ctx);
  ctx.plan = buildPlan(ctx);
  ctx.report = createReport(ctx);

  await applyIsbnLinks(ctx);
  matchCorpus(ctx);
  prepareChain(ctx);
  await runLitres(ctx);
  await runCard(ctx);
  await patchYearClaims(ctx);
  await persistLinks(ctx);

  finalizeReport(ctx);
  logReport(ctx);
  return ctx.report;
}

module.exports = {
  AUTHOR_ALIASES,
  ISBN_BATCH_SIZE,
  ISBN_QUERY,
  CHAIN_NAMES,
  CYRILLIC_TITLE,
  providers,
  createChainReport,
  createCardBudget: livelibCard.createBudget,
  createLitresBudget: litres.createBudget,
  createGbooksBudget: googlebooks.createBudget,
  normalizeTitle,
  tokensOf,
  tokenJaccard,
  surnameOf,
  authorKeySet,
  authorsOverlap,
  eventKeyOf,
  isbnOfEvent,
  normalizeIsbn,
  isbn10to13,
  isbn10Of,
  positionOf,
  guardReject,
  scoreCandidate,
  bestCandidate,
  buildCorpus,
  lookupIsbns,
  resolveProfile,
  listDetailsFiles,
};
