'use strict';

const bookCache = require('../book-cache');
const providers = require('../providers');
const hardcoverProvider = require('../providers/hardcover');
const { usedOf, budgetRefused } = require('../../core/budget');
const { createChainReport, eventKeyOf } = require('./identity');

function providerBudgetFor(budget, provider) {
  if (provider.NAME === 'litres') return budget.litres;
  if (provider.NAME === 'googlebooks') return budget.gb;
  return budget.card;
}

function providerOptionsFor(ctx, provider) {
  const { options } = ctx;
  return {
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    // Anonymous LiveLib session cookies (bootstrap/plan B). Only the card
    // provider talks to LiveLib.
    jar: provider.NAME === 'livelib-card' ? options.jar : undefined,
    negativeMemo:
      ctx.negativeMemo && ctx.negativeMemo[provider.NAME]
        ? ctx.negativeMemo[provider.NAME]
        : null,
    lookupIsbns: options.lookupIsbns,
    // Each network provider has its own per-run allowance: Литрес books,
    // Google Books books (BOOKS_GB_BUDGET), LiveLib cards. Sharing one counter
    // would let a GB-only tail eat the card budget (and vice versa).
    budget: providerBudgetFor(ctx.budget, provider),
    cardPauseMs: options.cardPauseMs,
    litresPauseMs: options.litresPauseMs,
    requestDelayMs: options.requestDelayMs,
    onProgress: options.onProgress,
  };
}

async function tryProvider(provider, input, ctx) {
  if (!provider) return null;
  const stat = ctx.chain.report[provider.NAME];
  if (!stat) return null;
  if (typeof provider.isBreakerOpen === 'function' && provider.isBreakerOpen()) {
    stat.skipped++;
    return null;
  }
  const options = ctx.options;
  // "Providers were asked": recorded per event so the metadata badge can keep
  // its denominator on the resolvable pool. A breaker/budget skip is NOT an
  // answer, so those keys are removed again below. The key is the resolve-cache
  // key (`sourceBookId` OR `file:<fileKey>`), not the scrape-only `llBookId`:
  // a file row without «Ссылка на книгу» must be addressable too.
  const key = input ? input.eventKey || input.llBookId || null : null;
  const keyString = key == null ? null : String(key);
  const budget = providerBudgetFor(ctx.budget, provider);
  const usedBefore = usedOf(budget);
  stat.calls++;
  try {
    const result = await provider.getWork(input, providerOptionsFor(ctx, provider));
    const budgetBlocked = budgetRefused(budget, usedBefore);
    if (keyString && budgetBlocked) {
      options.budgetBlockedKeys && options.budgetBlockedKeys.add(keyString);
    }
    if (keyString && !budgetBlocked) {
      options.askedKeys && options.askedKeys.add(keyString);
      if (result) {
        options.attemptedKeys && options.attemptedKeys.delete(keyString);
      } else if (!budgetBlocked) {
        options.attemptedKeys && options.attemptedKeys.add(keyString);
        // Per-candidate provenance for the scheduled resolve negative cache:
        // which providers really answered "nothing" for this key.
        if (options.missedByKey instanceof Map) {
          if (!options.missedByKey.has(keyString)) options.missedByKey.set(keyString, new Set());
          options.missedByKey.get(keyString).add(provider.NAME);
        }
      }
    }
    if (result) {
      stat.hits++;
      const method = (result.match && result.match.method) || 'unknown';
      stat.methods[method] = (stat.methods[method] || 0) + 1;
    } else if (typeof provider.isBreakerOpen === 'function' && provider.isBreakerOpen()) {
      stat.skipped++;
      if (keyString) {
        options.attemptedKeys && options.attemptedKeys.delete(keyString);
        if (options.missedByKey instanceof Map) options.missedByKey.delete(keyString);
      }
    }
    return result;
  } catch (err) {
    stat.errors++;
    stat.lastError = (err && err.code) || 'provider_error';
    if (keyString) {
      options.attemptedKeys && options.attemptedKeys.delete(keyString);
      options.providerErrorKeys && options.providerErrorKeys.add(keyString);
      // Keep any real "answered nothing" provenance collected before the
      // error: Литрес may already have answered for this Cyrillic title, and
      // the scheduled resolve is allowed to remember that verdict.
    }
    if (typeof provider.noteError === 'function') provider.noteError(err);
    return null;
  }
}

function prepareChain(ctx) {
  const { options } = ctx;
  // `allowLivelibCard: false` drops the LiveLib card provider. A resolve pass
  // that a `livelib-backup` file import triggered must never touch livelib.ru
  // (the whole point of the safe path, §9 ban risk): the file rows are enriched
  // by Hardcover/Литрес/GB/OL only, and a row that needs the card waits for a
  // regular scrape import instead of silently scraping.
  const list = providers
    .selectProviders(options.providers)
    .filter((provider) => options.allowLivelibCard !== false || provider.NAME !== 'livelib-card');
  const report = createChainReport(list);
  const byName = new Map(list.map((provider) => [provider.NAME, provider]));
  ctx.chain = {
    list,
    byName,
    report,
    card: byName.get('livelib-card') || null,
    litres: byName.get('litres') || null,
    google: byName.get('googlebooks') || null,
    openLibrary: byName.get('openlibrary') || null,
    hardcover: hardcoverProvider,
  };
  return ctx.chain;
}

function linkMethodFor(result) {
  if (result.source === 'hardcover') return 'isbn';
  const method = result.match && result.match.method;
  if (method === 'title') return `${result.source}-title`;
  return `${result.source}-isbn`;
}

function countResolution(report, result) {
  if (result.source === 'googlebooks') report.resolvedGoogle++;
  else if (result.source === 'openlibrary') report.resolvedOpenLibrary++;
  else if (result.source === 'hardcover') report.resolvedHardcoverCard++;
  else if (result.source === 'litres') report.resolvedLitres++;
}

/** Fields of a first-publication claim; they survive a re-resolve. */
const YEAR_CLAIM_FIELDS = [
  'firstPublishedYear',
  'firstPublishedYearSource',
  'firstPublishedYearPrecision',
  'firstPublishedYearKind',
  'firstPublishedYearCheckedAt',
  'firstPublishedYearCheckedBy',
];

/**
 * Keep a year backfilled earlier when a fresh resolve knows nothing about it.
 *
 * `saveDetails` is a blind overwrite, and the chain rebuilds a document from
 * the provider answer alone: a Google Books hit that knows only the print year
 * would silently delete the first-publication claim `years-backfill` had just
 * written (and with it the 30-day marker). Content fields still follow the
 * fresh answer — only an *absent* claim is inherited.
 */
function keepYearClaim(previous, next) {
  if (!next || next.firstPublishedYear != null || !previous) return next;
  const merged = { ...next };
  for (const field of YEAR_CLAIM_FIELDS) {
    if (previous[field] != null) merged[field] = previous[field];
  }
  return merged;
}

async function saveProviderWork(ctx, merged) {
  const details = providers.resultToDetails(merged, { now: ctx.now });
  if (!details) return null;
  const workId = merged.workId || `${merged.source}:${merged.sourceId}`;
  const key = bookCache.detailsKeyForWork(workId);
  const kept = keepYearClaim(ctx.cache.getWorkDetails(workId), details);
  await ctx.cache.saveDetails(key, kept);
  return { workId, details: kept };
}

function makeLink(bookId, merged, now) {
  const workId = merged.workId || `${merged.source}:${merged.sourceId}`;
  return {
    schemaVersion: 2,
    livelibBookId: bookId,
    workId,
    method: linkMethodFor(merged),
    score: Number(merged.confidence) || 0.5,
    evidence: {
      provider: merged.source,
      sourceId: merged.sourceId == null ? null : String(merged.sourceId),
      isbn: merged.isbn13 || merged.isbn10 || null,
      match: merged.match || null,
    },
    resolvedAt: now,
  };
}

async function saveCardMetadata(ctx, event, card) {
  const bookId = eventKeyOf(event);
  // Only events with an identity reach this point (see the pending pool), so a
  // null here means a caller bug, not a data shape: skip instead of writing a
  // shared `ll:` details document for unrelated rows.
  if (!bookId) return null;
  const doc = providers.resultToDetails(
    {
      ...card,
      workId: `ll:${bookId}`,
      metadataSources: ['livelib-card'],
      sources: [
        {
          source: 'livelib-card',
          sourceId: bookId,
          url: (card.links && card.links.pageUrl) || null,
          confidence: 1,
        },
      ],
    },
    { now: ctx.now }
  );
  const kept = keepYearClaim(ctx.cache.getWorkDetails(`ll:${bookId}`), doc);
  await ctx.cache.saveDetails(bookCache.detailsKeyForWork(`ll:${bookId}`), kept);
  return kept;
}

module.exports = {
  providerBudgetFor,
  providerOptionsFor,
  tryProvider,
  prepareChain,
  linkMethodFor,
  countResolution,
  saveProviderWork,
  makeLink,
  saveCardMetadata,
  keepYearClaim,
};
