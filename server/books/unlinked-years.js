'use strict';

const bookCache = require('./book-cache');
const wikidata = require('./providers/wikidata');
const fantlab = require('./providers/fantlab');
const { claimOf, claimWins, storedFirstClaim } = require('./providers/claim');
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

function checkedBy(doc) {
  return new Set(
    String((doc && doc.firstPublishedYearCheckedBy) || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function needsYear(existing, nowMs, recheckDays, enabled) {
  if (!existing) return true;
  if (!isYearOnlyDetails(existing)) return false;
  const asked = checkedBy(existing);
  if (!enabled.every((name) => asked.has(name))) return true;
  if (existing.firstPublishedYear != null) return false;
  return !recentlyChecked(existing, nowMs, recheckDays);
}

function unlinkedTargets(options = {}) {
  const nowMs = options.nowMs == null ? Date.now() : Number(options.nowMs);
  const recheckDays = options.recheckDays == null ? DEFAULT_RECHECK_DAYS : options.recheckDays;
  const enabled = options.enabled || [SOURCE];
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
      if (!needsYear(existing, nowMs, recheckDays, enabled)) continue;
      targets.set(key, { key, title: String(event.title), authors: authorNames(event) });
    }
  }
  return [...targets.values()];
}

function yearOnlyDoc(target, result, now, options = {}) {
  const previous = options.previous || null;
  const asked = checkedBy(previous);
  for (const name of options.asked || [SOURCE]) asked.add(name);
  const doc = {
    schemaVersion: 2,
    workId: `ll:${target.key}`,
    yearOnly: true,
    title: target.title,
    authors: target.authors.map((name) => ({ name })),
    series: previous && Array.isArray(previous.series) ? previous.series : [],
    genres: [],
    metadataSources: [],
    partial: true,
    fetchedAt: now,
    firstPublishedYear: null,
    firstPublishedYearSource: null,
    firstPublishedYearPrecision: null,
    firstPublishedYearKind: null,
    firstPublishedYearCheckedAt: now,
    firstPublishedYearCheckedBy: [...asked].join(','),
    seriesCheckedAt: now,
    seriesCheckedBy: SOURCE,
  };
  const kept = storedFirstClaim(previous);
  const winner = result ? claimOf(result) : null;
  const claim = winner && claimWins(winner, kept) ? winner : kept;
  const sources = new Set(previous && Array.isArray(previous.metadataSources) ? previous.metadataSources : []);
  if (result) sources.add(result.source);
  doc.metadataSources = [...sources];
  if (claim) {
    const fromResult = claim === winner;
    doc.firstPublishedYear = claim.year;
    doc.firstPublishedYearSource = fromResult ? result.source : previous.firstPublishedYearSource;
    doc.firstPublishedYearPrecision = claim.precision || null;
    doc.firstPublishedYearKind = claim.kind || null;
  }
  const series = result && result.source === SOURCE ? seriesOfResult(result) : null;
  if (series && !doc.series.length) doc.series = [series];
  const identity = result && result.source === SOURCE ? wikidataIdentityOf(result) : {};
  const fantlabId = result && result.fantlabWorkId ? { fantlabWorkId: result.fantlabWorkId } : {};
  const carried = {};
  for (const field of ['wikidataWorkId', 'wikidataAuthorIds', 'fantlabWorkId']) {
    if (previous && previous[field] != null) carried[field] = previous[field];
  }
  return { ...doc, ...carried, ...identity, ...fantlabId };
}

function earliestResult(results) {
  let best = null;
  for (const result of results) {
    const claim = result ? claimOf(result) : null;
    if (!claim) continue;
    if (!best || claimWins(claim, best.claim)) best = { result, claim };
  }
  return best ? best.result : null;
}

async function askProvider(provider, targets, options) {
  try {
    return await provider.lookupTitles(targets, options);
  } catch (err) {
    return { byKey: new Map(), asked: new Set(), skipped: 'error', queries: 0, error: (err && err.code) || 'error' };
  }
}

async function backfillUnlinkedYears(options = {}) {
  const providers = [];
  const wd = options.wikidataProvider === undefined ? wikidata : options.wikidataProvider;
  if (wd && typeof wd.lookupTitles === 'function' && !wikidata.isDisabled()) {
    providers.push({ name: SOURCE, provider: wd, budget: options.budget });
  }
  const fl = options.fantlabProvider === undefined ? fantlab : options.fantlabProvider;
  if (fl && typeof fl.lookupTitles === 'function' && !fantlab.isDisabled()) {
    providers.push({ name: fantlab.NAME, provider: fl, budget: options.fantlabBudget });
  }
  const log = typeof options.log === 'function' ? options.log : () => {};
  const now = options.now ? new Date(options.now).toISOString() : new Date().toISOString();
  const report = { targets: 0, asked: 0, claimed: 0, missed: 0, skipped: null, requests: 0, error: null, bySource: {} };
  if (!providers.length) {
    report.skipped = 'disabled';
    return report;
  }
  const all = unlinkedTargets({
    nowMs: Date.parse(now),
    recheckDays: options.recheckDays,
    enabled: providers.map((entry) => entry.name),
  });
  const limit = options.limit == null ? 0 : Number(options.limit);
  const targets = limit > 0 ? all.slice(0, limit) : all;
  report.targets = all.length;
  if (!targets.length) return report;
  const answers = [];
  for (const entry of providers) {
    const found = await askProvider(entry.provider, targets, {
      budget: entry.budget,
      sleep: options.sleep,
      fetchImpl: options.fetchImpl,
      pauseMs: entry.name === SOURCE ? options.pauseMs : options.fantlabPauseMs,
      batchSize: options.batchSize,
    });
    report.requests += found.queries || 0;
    if (found.skipped) report.skipped = report.skipped || `${entry.name}:${found.skipped}`;
    answers.push({ name: entry.name, found });
  }
  for (const target of targets) {
    const asked = answers.filter((entry) => entry.found.asked.has(target.key));
    if (!asked.length) continue;
    report.asked++;
    const result = earliestResult(asked.map((entry) => entry.found.byKey.get(target.key) || null));
    const previous = bookCache.getWorkDetails(`ll:${target.key}`);
    const doc = yearOnlyDoc(target, result, now, {
      previous: isYearOnlyDetails(previous) ? previous : null,
      asked: asked.map((entry) => entry.name),
    });
    if (doc.firstPublishedYear != null) {
      report.claimed++;
      report.bySource[doc.firstPublishedYearSource] = (report.bySource[doc.firstPublishedYearSource] || 0) + 1;
    } else {
      report.missed++;
    }
    log(
      doc.firstPublishedYear != null
        ? `${target.key} ${target.title} :: ${doc.firstPublishedYear} (${doc.firstPublishedYearSource}, unlinked)`
        : `— ${target.key} ${target.title} :: no claim (unlinked)`
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
