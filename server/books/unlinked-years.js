'use strict';

const bookCache = require('./book-cache');
const wikidata = require('./providers/wikidata');
const segments = require('./segments');
const { expandedProfileEvents } = require('./scheduled-resolve');
const { eventKeyOf } = require('./resolve-stages/identity');
const { isYearOnlyDetails } = require('./year-only');
const { recentlyChecked } = require('./backfill-queue');
const { seriesOfResult, wikidataIdentityOf } = require('./series-stage');

const PLAN_SHELVES = new Set(['reading', 'wish']);
const SOURCE = 'wikidata';
const DEFAULT_RECHECK_DAYS = 30;

function authorNames(event) {
  return (Array.isArray(event && event.authors) ? event.authors : [])
    .map((name) => (name && typeof name === 'object' ? name.name : name))
    .map((name) => String(name || '').trim())
    .filter(Boolean);
}

function needsYear(existing, nowMs, recheckDays) {
  if (!existing) return true;
  if (!isYearOnlyDetails(existing)) return false;
  if (existing.firstPublishedYear != null) return false;
  return !recentlyChecked(existing, nowMs, recheckDays);
}

function unlinkedTargets(options = {}) {
  const nowMs = options.nowMs == null ? Date.now() : Number(options.nowMs);
  const recheckDays = options.recheckDays == null ? DEFAULT_RECHECK_DAYS : options.recheckDays;
  const targets = new Map();
  for (const summary of bookCache.listProfiles()) {
    if (summary.source !== 'livelib') continue;
    const profile = bookCache.getProfile(summary.source, summary.userKey);
    for (const event of expandedProfileEvents(profile)) {
      if (!event || !event.title || PLAN_SHELVES.has(event.shelf)) continue;
      if (segments.hasCollectionSegments(event)) continue;
      const key = eventKeyOf(event);
      if (!key || targets.has(key)) continue;
      const link = bookCache.getLink(key);
      if (link && link.workId) continue;
      const existing = bookCache.getWorkDetails(`ll:${key}`);
      if (!needsYear(existing, nowMs, recheckDays)) continue;
      targets.set(key, { key, title: String(event.title), authors: authorNames(event) });
    }
  }
  return [...targets.values()];
}

function yearOnlyDoc(target, result, now) {
  const doc = {
    schemaVersion: 2,
    workId: `ll:${target.key}`,
    yearOnly: true,
    title: target.title,
    authors: target.authors.map((name) => ({ name })),
    series: [],
    genres: [],
    metadataSources: result ? [SOURCE] : [],
    partial: true,
    fetchedAt: now,
    firstPublishedYear: null,
    firstPublishedYearSource: null,
    firstPublishedYearPrecision: null,
    firstPublishedYearKind: null,
    firstPublishedYearCheckedAt: now,
    firstPublishedYearCheckedBy: SOURCE,
    seriesCheckedAt: now,
    seriesCheckedBy: SOURCE,
  };
  if (!result) return doc;
  doc.firstPublishedYear = Number(result.firstPublishedYear);
  doc.firstPublishedYearSource = SOURCE;
  doc.firstPublishedYearPrecision = result.firstPublishedYearPrecision || null;
  doc.firstPublishedYearKind = result.firstPublishedYearKind || null;
  const series = seriesOfResult(result);
  if (series) doc.series = [series];
  return { ...doc, ...wikidataIdentityOf(result) };
}

async function backfillUnlinkedYears(options = {}) {
  const provider = options.wikidataProvider === undefined ? wikidata : options.wikidataProvider;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const now = options.now ? new Date(options.now).toISOString() : new Date().toISOString();
  const report = { targets: 0, asked: 0, claimed: 0, missed: 0, skipped: null, requests: 0, error: null };
  if (!provider || typeof provider.lookupTitles !== 'function' || wikidata.isDisabled()) {
    report.skipped = 'disabled';
    return report;
  }
  const all = unlinkedTargets({ nowMs: Date.parse(now), recheckDays: options.recheckDays });
  const limit = options.limit == null ? 0 : Number(options.limit);
  const targets = limit > 0 ? all.slice(0, limit) : all;
  report.targets = all.length;
  if (!targets.length) return report;
  let found;
  try {
    found = await provider.lookupTitles(targets, {
      budget: options.budget,
      sleep: options.sleep,
      fetchImpl: options.fetchImpl,
      pauseMs: options.pauseMs,
      batchSize: options.batchSize,
    });
  } catch (err) {
    report.error = (err && err.code) || 'wikidata-error';
    return report;
  }
  report.skipped = found.skipped;
  report.requests = found.queries || 0;
  for (const target of targets) {
    if (!found.asked.has(target.key)) continue;
    report.asked++;
    const result = found.byKey.get(target.key) || null;
    const doc = yearOnlyDoc(target, result, now);
    if (result) report.claimed++;
    else report.missed++;
    log(
      result
        ? `${target.key} ${target.title} :: ${doc.firstPublishedYear} (wikidata, unlinked)`
        : `— ${target.key} ${target.title} :: no claim (wikidata, unlinked)`
    );
    if (!options.dryRun) {
      await bookCache.saveDetails(bookCache.detailsKeyForWork(doc.workId), doc);
    }
  }
  return report;
}

module.exports = {
  unlinkedTargets,
  yearOnlyDoc,
  backfillUnlinkedYears,
};
