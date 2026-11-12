'use strict';

/**
 * Year-claim stage: the pass that stops a resolved work from staying dateless.
 *
 * Why it is separate from the provider chain: the chain is ordered by *content*
 * (Hardcover names the work, Литрес/the card know the Russian edition) and it
 * stops at the first hit. That is right for title/genres/cover and wrong for
 * the first-publication year: a Google Books hit closes the work with
 * `firstPublishedYear: null`, and nobody asks again (79 such documents in the
 * live cache). Re-asking the whole chain per work would cost a Литрес book
 * budget and two requests per title for a source that measured zero coverage
 * on Russian ISBNs.
 *
 * So the year is asked once, in one batched Wikidata query for every work this
 * pass resolved *without* a claim. Nothing is written when Wikidata does not
 * know: the negative cache belongs to `years-backfill.js`, which owns the
 * «everyone was asked» verdict (a resolve pass that ran out of budget must not
 * poison a document for 30 days).
 *
 * The search title is the reader's own (`event.title`), not `details.title`:
 * a work matched by Open Library carries a transliterated name
 * («Doktor ZHivago») that no source can be asked for.
 */

const wikidata = require('../providers/wikidata');
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

/**
 * Works of this pass that have a details document but no first-publication
 * claim, with the spelling the reader actually saw.
 */
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
    if (!details || details.firstPublishedYear != null) continue;
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
    });
  }
  return targets;
}

/** Write one Wikidata claim into a details document, keeping everything else. */
async function applyClaim(ctx, target, result) {
  const { cache, now } = ctx;
  const details = target.details;
  const next = {
    ...details,
    firstPublishedYear: result.firstPublishedYear,
    firstPublishedYearSource: result.source,
    firstPublishedYearPrecision: result.firstPublishedYearPrecision || null,
    firstPublishedYearKind: result.firstPublishedYearKind || null,
    firstPublishedYearCheckedAt: now,
    firstPublishedYearCheckedBy: result.source,
  };
  await cache.saveDetails(cache.detailsKeyForWork(target.workId), next);
  target.details = next;
  return next;
}

/**
 * Ask Wikidata for the year of every dateless work of this pass.
 * Never throws: a broken WDQS answer is a missing enrichment, not a failed
 * resolve (the archive import must not die because a reference site is down).
 */
async function patchYearClaims(ctx) {
  const { report, budget, options } = ctx;
  const targets = yearTargets(ctx);
  report.yearCandidates = targets.length;
  report.yearClaims = 0;
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
  for (const target of targets) {
    const result = found.byKey.get(target.workId);
    if (!result) continue;
    try {
      await applyClaim(ctx, target, result);
      report.yearClaims++;
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
