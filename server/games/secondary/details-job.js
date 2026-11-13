'use strict';

const { SecondaryDetailsError } = require('./errors');
const { isoOf, nowMs } = require('./normalize');
const { recordRunFinished } = require('./store');
const { refreshForJob } = require('./title-genres');
const { resolveGog } = require('../sources/gog');
const { resolveEpic, createCatalogClient } = require('../sources/epic');
const { jobs, lastKick } = require('./details-state');
const { budgetDefault, pauseMsFor } = require('./details-config');
const { runPhase, titleCandidatesFor } = require('./details-run');

function emptyPhase() {
  return {
    total: 0,
    resolved: 0,
    fetched: 0,
    notFound: 0,
    cached: 0,
    failed: 0,
    deferred: 0,
    catalogSkipped: 0,
    missingSlug: 0,
  };
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    ownerKey: job.ownerKey,
    status: job.status,
    stage: job.stage,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    requests: job.requests,
    budget: job.budget,
    budgetExceeded: job.budgetExceeded,
    gog: { ...job.gog },
    epic: { ...job.epic },
    pending: Math.max(0, job.gog.total + job.epic.total - job.gog.resolved - job.epic.resolved),
    warnings: [...job.warnings],
  };
}

function runningFor(ownerKey) {
  return jobs.isRunning(String(ownerKey == null ? '' : ownerKey));
}

function jobFor(ownerKey) {
  const key = String(ownerKey == null ? '' : ownerKey);
  let latest = null;
  for (const job of jobs.list()) {
    if (job.ownerKey === key) latest = job;
  }
  return publicJob(latest);
}

function startSecondaryDetails(options = {}) {
  const ownerKey = String(options.ownerKey == null ? '' : options.ownerKey).trim();
  const gog = Array.isArray(options.gog) ? options.gog : [];
  const epic = Array.isArray(options.epic) ? options.epic : [];
  if (!ownerKey) {
    throw new SecondaryDetailsError('Нужен ownerKey.', 'secondary_details_no_owner');
  }
  const existing = jobs.findRunning(ownerKey);
  if (existing && !options.force) {
    return { ...publicJob(existing), reused: true };
  }
  const budget =
    options.budget != null && Number.isFinite(Number(options.budget))
      ? Math.max(0, Math.floor(Number(options.budget)))
      : budgetDefault();
  const epicClient =
    options.epicClient || options.catalogClient || (epic.length ? createCatalogClient(options) : null);
  const job = jobs.createJob({
    seed: ownerKey,
    ownerKey,
    status: 'running',
    stage: gog.length ? 'gog' : 'epic',
    startedAt: isoOf(nowMs()),
    finishedAt: null,
    requests: 0,
    budget,
    budgetExceeded: false,
    force: Boolean(options.force),
    client: options.client,
    epicClient: epicClient,
    tokenStore: options.tokenStore || null,
    epicAccountId: options.epicAccountId || null,
    pauseMs: options.pauseMs != null ? options.pauseMs : pauseMsFor('gog'),
    gog: emptyPhase(),
    epic: emptyPhase(),
    warnings: [],
    cancelled: false,
  });
  job.gog.total = gog.filter((entry) => entry && entry.id).length;
  job.epic.total = epic.filter((entry) => entry && (entry.slug || entry.title)).length;
  job.epic.missingSlug = epic.filter((entry) => entry && !entry.slug).length;
  jobs.remember(job);
  lastKick.set(ownerKey, nowMs());

  const run = async () => {
    try {
      const titleCards = titleCandidatesFor(epic);
      if (!job.client && titleCards.length) {
        try {
          job.titleLinks = await refreshForJob({
            epicGames: titleCards,
            options: {
              fetchImpl: options.fetchImpl,
              wdqsEndpoint: options.wdqsEndpoint,
              wikidata: options.wikidata,
            },
          });
        } catch (err) {
          job.titleLinks = { skipped: 'error' };
        }
      }
      await runPhase(
        job,
        'gog',
        gog
          .filter((entry) => entry && entry.id)
          .map((entry) => ({ id: String(entry.id), slug: entry.slug || null, title: entry.title || null })),
        (target, opts) => resolveGog(target.id, { ...opts, slug: target.slug, title: target.title })
      );
      if (job.pauseMs && !job.cancelled && job.requests < job.budget) {
        job.pauseMs = pauseMsFor('epic');
      }
      await runPhase(
        job,
        'epic',
        epic
          .filter((entry) => entry && (entry.slug || entry.title))
          .map((entry) => ({
            id: String(entry.slug || entry.id || `catalog:${entry.catalogItemId || ''}`),
            slug: entry.slug || null,
            title: entry.title || null,
            catalogItemId: entry.catalogItemId || null,
            catalog: entry.catalog || null,
            namespace: entry.namespace || null,
          })),
        (target, opts) =>
          resolveEpic(target.slug, {
            ...opts,
            title: target.title,
            catalog: target.catalog,
            catalogItemId: target.catalogItemId,
            namespace: target.namespace,
            ownerKey: job.ownerKey,
            epicClient: job.epicClient,
            tokenStore: job.tokenStore,
            epicAccountId: job.epicAccountId,
            forceCatalog: job.force,
          })
      );
      job.status = job.budgetExceeded ? 'partial' : 'done';
    } catch (err) {
      job.status = 'failed';
      job.warnings.push((err && err.code) || 'secondary_details_error');
    } finally {
      job.finishedAt = isoOf(nowMs());
      job.stage = 'done';
      recordRunFinished(job);
    }
  };
  jobs.run(job, run, { chainKey: ownerKey });
  return publicJob(job);
}

module.exports = {
  runningFor,
  jobFor,
  startSecondaryDetails,
};
