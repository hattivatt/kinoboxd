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

let jobSeq = 0;

function emptyPhase() {
  return {
    total: 0,
    resolved: 0,
    fetched: 0,
    notFound: 0,
    cached: 0,
    failed: 0,
    deferred: 0,
    // Works whose catalog step exited without asking (token binding, probe,
    // budget, no client). Visible so a «done in 1 s» job can explain itself.
    catalogSkipped: 0,
    // Works with no store slug at all: «library-only» (title + hours), never a
    // silent drop and never a fake `not_found`.
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

/** Running job for an owner (for `meta.secondaryDetails.running`). */
function runningFor(ownerKey) {
  const job = jobs.get(String(ownerKey == null ? '' : ownerKey));
  return Boolean(job && job.status === 'running');
}

function jobFor(ownerKey) {
  return publicJob(jobs.get(String(ownerKey == null ? '' : ownerKey)));
}

/**
 * Start (or coalesce into) a details job. Returns the public job immediately;
 * the loop runs in the background and never rejects into the caller.
 */
function startSecondaryDetails(options = {}) {
  const ownerKey = String(options.ownerKey == null ? '' : options.ownerKey).trim();
  const gog = Array.isArray(options.gog) ? options.gog : [];
  const epic = Array.isArray(options.epic) ? options.epic : [];
  if (!ownerKey) {
    throw new SecondaryDetailsError('Нужен ownerKey.', 'secondary_details_no_owner');
  }
  const existing = jobs.get(ownerKey);
  if (existing && existing.status === 'running' && !options.force) {
    return { ...publicJob(existing), reused: true };
  }
  const budget =
    options.budget != null && Number.isFinite(Number(options.budget))
      ? Math.max(0, Math.floor(Number(options.budget)))
      : budgetDefault();
  // One client per job: its `client_credentials` token and throttle state are
  // reused across catalog refetches instead of fetched per product.
  const epicClient =
    options.epicClient || options.catalogClient || (epic.length ? createCatalogClient(options) : null);
  const job = {
    id: `secondary-details-${++jobSeq}`,
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
    // Owner-token catalog refetch (stale Epic CMS): injected in tests, created
    // once per job from the token store in production.
    epicClient: epicClient,
    tokenStore: options.tokenStore || null,
    epicAccountId: options.epicAccountId || null,
    pauseMs: options.pauseMs != null ? options.pauseMs : pauseMsFor('gog'),
    gog: emptyPhase(),
    epic: emptyPhase(),
    warnings: [],
    cancelled: false,
  };
  // Counters are visible in the immediate response, before the first await.
  job.gog.total = gog.filter((entry) => entry && entry.id).length;
  job.epic.total = epic.filter((entry) => entry && (entry.slug || entry.title)).length;
  job.epic.missingSlug = epic.filter((entry) => entry && !entry.slug).length;
  jobs.set(ownerKey, job);
  lastKick.set(ownerKey, nowMs());

  const run = async () => {
    try {
      // A store-exclusive with no date (Alan Wake 2) can get its P577 from a
      // unique exact-title Wikidata match. One cache-backed request per run,
      // skipped for inert clients and on the shared `KINOBOXD_GAMES_WD=off`
      // kill switch (checked inside `refreshForJob`).
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
  Promise.resolve().then(run);
  return publicJob(job);
}

module.exports = {
  runningFor,
  jobFor,
  startSecondaryDetails,
};
