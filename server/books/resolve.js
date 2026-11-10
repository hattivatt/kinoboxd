'use strict';

/**
 * LiveLib -> Hardcover resolve.
 *
 * LiveLib events arrive with edition-level ids and Russian titles; Hardcover is
 * the canonical work namespace (`books.id` = work id, `hc:{id}`). Matching is
 * deliberately asymmetric — hardcover events need no matching at all.
 *
 * Order (AGENTS.md §5.2):
 *   1. cached link `links/{livelibBookId}.json` (positive results only);
 *   2. ISBN-13/ISBN-10 bulk lookup against Hardcover `editions` (batches of 100);
 *   3. strict title + first-author surname + year (±1) over the local corpus;
 *   4. fuzzy token-Jaccard with the film-lesson guards
 *      (author hit mandatory, 0.80-0.90 needs year ±1 and ratings_count >= 50);
 *   5. provider chain for the rest: Google Books ISBN -> Open Library ISBN ->
 *      LiveLib card (genres/ISBN/pages for RU editions);
 *   6. events without an ISBN start with the LiveLib card (it supplies the
 *      ISBN), then the card's ISBN goes through the Hardcover bulk lookup,
 *      then Google Books/Open Library;
 *   7. otherwise unmatched (NOT cached: a later import may resolve it).
 *
 * `livelib-file` events are first-class inputs to the same pass (§3.3.2): the
 * `livelib-backup` export often carries ISBN, genres, publisher, year and
 * series, so a file row usually starts at step 2 (no LiveLib card round-trip),
 * and a row without «Ссылка на книгу» is keyed by its `fileKey` (`file:tk:…`)
 * instead of being dropped. Plan shelves (`reading`/`wish`) are skipped: they
 * never reach the stats payload, so they must not spend the network budget.
 *
 * Provider negatives are memoised per run only (soft TTL, no disk cache) so a
 * growing source is queried again on the next run. All broad decisions are
 * appended to match-log.jsonl.
 *
 * Stages live in ./resolve-stages: `context` (one per pass), `plan` (events,
 * cached links), `isbn-stage` (batch lookup), `title-stage` (local corpus),
 * `chain` (provider registry + per-call bookkeeping), `litres-stage`/
 * `card-stage` (network chain), `persist` (links/index) and `report`
 * (skeleton, counters, logging).
 */

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
const { persistLinks } = require('./resolve-stages/persist');

/**
 * Resolve all livelib events of one profile.
 *
 * Returns the report built by `resolve-stages/report` (`cached`, `resolved*`,
 * `enriched`, `withMetadata`, `ambiguous`, `unmatched`, `requests`,
 * `corpusSize`, `resolvedWorkIds`, `providerChain`, the per-run budgets,
 * `unmatchedKeys`, `attemptedKeys`, `askedKeys`, `providerErrorKeys`,
 * `budgetPendingKeys`, `missedByKey` and `lookupErrors`).
 */
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
