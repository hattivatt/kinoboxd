'use strict';

const { CYRILLIC_TITLE, eventKeyOf, isbnOfEvent } = require('./identity');
const { liveLibMetadata } = require('../year-only');

function createReport(ctx) {
  const { card, litres, gb, wikidata } = ctx.budget;
  return {
    total: ctx.plan.events.length,
    skippedPlanShelf: ctx.plan.skippedPlanShelf,
    cached: ctx.plan.cached,
    resolvedIsbn: 0,
    resolvedTitle: 0,
    resolvedGoogle: 0,
    resolvedOpenLibrary: 0,
    resolvedLitres: 0,
    resolvedLivelibCard: 0,
    resolvedHardcoverCard: 0,
    resolvedHardcoverFromLitres: 0,
    enriched: 0,
    withMetadata: 0,
    ambiguous: 0,
    unmatched: 0,
    requests: 0,
    corpusSize: 0,
    resolvedWorkIds: 0,
    methods: {},
    providerChain: {},
    cardBudget: { limit: card.limit, used: 0, remaining: card.limit },
    litresBudget: { limit: litres.limit, used: 0, remaining: litres.limit },
    gbBudget: { limit: gb.limit, used: 0, remaining: gb.limit },
    wikidataBudget: {
      limit: wikidata ? wikidata.limit : 0,
      used: 0,
      remaining: wikidata ? wikidata.limit : 0,
    },
    yearCandidates: 0,
    yearClaims: 0,
    yearClaimSkipped: null,
    yearClaimError: null,
  };
}

function budgetSnapshot(budget) {
  return { limit: budget.limit, used: budget.used, remaining: budget.remaining };
}

function budgetPendingKeys(ctx) {
  const { plan, chain, budget, state } = ctx;
  const keys = new Set(state.budgetBlockedKeys);
  const litresExhausted = Boolean(chain.litres) && budget.litres.used >= budget.litres.limit;
  const cardExhausted = Boolean(chain.card) && budget.card.used >= budget.card.limit;
  if (litresExhausted) {
    for (const event of plan.pending) {
      if (CYRILLIC_TITLE.test(String((event && event.title) || ''))) {
        const key = eventKeyOf(event);
        if (key) keys.add(key);
      }
    }
  }
  if (cardExhausted) {
    for (const event of plan.pending) {
      if (!isbnOfEvent(event)) {
        const key = eventKeyOf(event);
        if (key) keys.add(key);
      }
    }
  }
  return keys;
}

function finalizeReport(ctx) {
  const { report, plan, cache, chain, state } = ctx;
  report.providerChain = chain.report;
  report.cardBudget = budgetSnapshot(ctx.budget.card);
  report.litresBudget = budgetSnapshot(ctx.budget.litres);
  report.gbBudget = budgetSnapshot(ctx.budget.gb);
  if (ctx.budget.wikidata) report.wikidataBudget = budgetSnapshot(ctx.budget.wikidata);

  report.resolvedWorkIds = new Set(
    [...plan.links.values()].filter((link) => link.workId).map((link) => link.workId)
  ).size;
  report.resolved =
    report.cached + report.resolvedIsbn + report.resolvedTitle +
    report.resolvedGoogle + report.resolvedOpenLibrary + report.resolvedLitres +
    report.resolvedHardcoverCard + report.resolvedHardcoverFromLitres;
  report.withMetadata = report.resolved + report.enriched;
  report.unmatched = plan.pending.filter((event) => {
    const bookId = eventKeyOf(event);
    return !plan.links.has(bookId) && !liveLibMetadata(cache.getWorkDetails(`ll:${bookId}`));
  }).length;
  report.attempted = state.attemptedKeys.size;
  const pendingKeys = budgetPendingKeys(ctx);
  report.unmatchedKeys = [...state.attemptedKeys].filter(
    (bookId) =>
      !plan.links.has(bookId) &&
      !liveLibMetadata(cache.getWorkDetails(`ll:${bookId}`)) &&
      !state.providerErrorKeys.has(bookId) &&
      !pendingKeys.has(bookId)
  );
  report.attemptedKeys = [...state.attemptedKeys];
  report.askedKeys = [...state.askedKeys];
  report.providerErrorKeys = [...state.providerErrorKeys];
  report.budgetPendingKeys = [...pendingKeys];
  report.missedByKey = {};
  for (const [key, providers] of state.missedByKey) {
    if (providers && providers.size) report.missedByKey[String(key)] = [...providers].sort();
  }
  report.lookupErrors = ctx.lookupErrors;
  return report;
}

function logReport(ctx) {
  const { report, onProgress, chain, budget } = ctx;
  if (onProgress) {
    onProgress({ stage: 'resolve', resolved: report.withMetadata, total: report.total });
  }
  const providerSummary = Object.values(chain.report)
    .map((stat) => `${stat.name}=${stat.hits}/${stat.calls}${stat.errors ? `e${stat.errors}` : ''}`)
    .join(' ');
  console.log(
    `[resolve] ${report.withMetadata}/${report.total} livelib event(s) with metadata ` +
      `(cached=${report.cached}, isbn=${report.resolvedIsbn}, title=${report.resolvedTitle}, ` +
      `google=${report.resolvedGoogle}, openlibrary=${report.resolvedOpenLibrary}, ` +
      `litres=${report.resolvedLitres}, litres-hc=${report.resolvedHardcoverFromLitres}, ` +
      `card=${report.resolvedLivelibCard}, hc-card=${report.resolvedHardcoverCard}, ` +
      `ambiguous=${report.ambiguous}, unmatched=${report.unmatched}, requests=${report.requests}` +
      `${report.skippedPlanShelf ? `, plan-shelf-skipped=${report.skippedPlanShelf}` : ''}` +
      `${report.lookupErrors.length ? `, isbn-lookup-errors=${report.lookupErrors.join('|')}` : ''}) ` +
      `[${providerSummary}] card-budget=${budget.card.used}/${budget.card.limit} ` +
      `litres-budget=${budget.litres.used}/${budget.litres.limit} ` +
      `gb-budget=${budget.gb.used}/${budget.gb.limit}` +
      (report.yearCandidates
        ? ` year-claims=${report.yearClaims}/${report.yearCandidates}` +
          (report.yearClaimSkipped ? `(skipped:${report.yearClaimSkipped})` : '')
        : '')
  );
}

module.exports = {
  createReport,
  finalizeReport,
  logReport,
};
