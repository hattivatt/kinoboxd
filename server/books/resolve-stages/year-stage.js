'use strict';

const wikidata = require('../providers/wikidata');
const {
  claimOf,
  isPrintClaimSource,
  PRECISION_RANK,
  saneFirstYearClaim,
  storedFirstClaim,
} = require('../providers/claim');
const { eventKeyOf } = require('./identity');

function eventTitles(ctx) {
  const titles = new Map();
  for (const event of ctx.plan.events || []) {
    const key = eventKeyOf(event);
    if (!key || titles.has(key)) continue;
    const title = (event && event.title) || null;
    if (!title) continue;
    titles.set(key, { title, authors: Array.isArray(event.authors) ? event.authors : [] });
  }
  return titles;
}

function isChallengeable(details, claim) {
  if (!claim) return true;
  if (String((details && details.yearSource) || '') === 'manual') return false;
  if (claim.source == null) return true;
  return isPrintClaimSource(claim.source);
}

function yearTargets(ctx) {
  const { plan, cache } = ctx;
  const titles = eventTitles(ctx);
  const seen = new Set();
  const targets = [];
  for (const [bookId, link] of plan.links) {
    const workId = link && link.workId;
    if (!workId || seen.has(workId)) continue;
    seen.add(workId);
    const details = cache.getWorkDetails(workId);
    if (!details) continue;
    const current = storedFirstClaim(details);
    if (!isChallengeable(details, current)) continue;
    const fromEvent = titles.get(bookId) || null;
    const title = (fromEvent && fromEvent.title) || details.title || null;
    if (!title) continue;
    targets.push({
      key: workId,
      workId,
      title,
      authors:
        fromEvent && fromEvent.authors.length
          ? fromEvent.authors
          : (details.authors || []).map((author) => (author && author.name) || author),
      details,
      current,
    });
  }
  return targets;
}

function acceptedClaim(current, result) {
  const claim = claimOf(result);
  if (!claim) return null;
  const sane = saneFirstYearClaim(
    { ...claim, source: result.source || 'wikidata' },
    { authorBirthYear: result.authorBirthYear }
  );
  if (!sane) return null;
  if (!current) return sane;
  if (sane.year < current.year) return sane;
  if (sane.year > current.year) return null;
  const rankNew = PRECISION_RANK[sane.precision] || 0;
  const rankCurrent = PRECISION_RANK[current.precision] || 0;
  return rankNew > rankCurrent ? sane : null;
}

async function applyClaim(ctx, target, result) {
  const { cache, now } = ctx;
  const details = target.details;
  const previous = target.current == null ? storedFirstClaim(details) : target.current;
  const next = {
    ...details,
    firstPublishedYear: result.firstPublishedYear,
    firstPublishedYearSource: result.source,
    firstPublishedYearPrecision: result.firstPublishedYearPrecision || null,
    firstPublishedYearKind: result.firstPublishedYearKind || null,
    firstPublishedYearCheckedAt: now,
    firstPublishedYearCheckedBy: result.source,
  };
  if (previous) {
    next.firstPublishedYearPrevious = previous.year;
    next.firstPublishedYearChallengedBy = previous.source || 'unknown';
  }
  await cache.saveDetails(cache.detailsKeyForWork(target.workId), next);
  target.details = next;
  return next;
}

async function patchYearClaims(ctx) {
  const { report, budget, options } = ctx;
  const targets = yearTargets(ctx);
  report.yearCandidates = targets.length;
  report.yearClaims = 0;
  report.yearChallenged = 0;
  report.yearCorrected = 0;
  if (!targets.length) return report;
  const wikidataBudget = budget.wikidata || null;
  const provider =
    options.wikidataProvider === undefined ? wikidata : options.wikidataProvider;
  if (!provider || typeof provider.lookupTitles !== 'function') return report;
  let found;
  try {
    found = await provider.lookupTitles(targets, {
      budget: wikidataBudget,
      sleep: options.sleep,
      fetchImpl: options.fetchImpl,
      pauseMs: options.wikidataPauseMs,
      onProgress: options.onProgress,
    });
  } catch (err) {
    report.yearClaimError = (err && err.code) || 'wikidata_error';
    return report;
  }
  report.yearClaimSkipped = found.skipped || null;
  const asked = found.asked instanceof Set ? found.asked : null;
  report.yearChallenged = targets.filter(
    (target) => target.current && (!asked || asked.has(String(target.workId)))
  ).length;
  for (const target of targets) {
    const result = found.byKey.get(target.workId);
    if (!result) continue;
    const claim = acceptedClaim(target.current, result);
    if (!claim) continue;
    try {
      await applyClaim(ctx, target, {
        ...result,
        source: claim.source,
        firstPublishedYear: claim.year,
        firstPublishedYearPrecision: claim.precision,
        firstPublishedYearKind: claim.kind,
      });
      report.yearClaims++;
      if (target.current) report.yearCorrected++;
    } catch (err) {
      report.yearClaimError = (err && err.code) || 'details_write_failed';
    }
  }
  return report;
}

module.exports = {
  eventTitles,
  yearTargets,
  applyClaim,
  patchYearClaims,
};
