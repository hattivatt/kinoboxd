'use strict';

const { maskSecrets } = require('./errors');
const { catalogMetaFlags, isoOf, nowMs } = require('./normalize');
const {
  readDetail,
  writeDetail,
  shouldAttemptCatalog,
  recordError,
} = require('./store');
const { applyWikidataFacts } = require('./enrich');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPhase(job, source, targets, resolveOne) {
  const phase = job[source];
  phase.total = targets.length;
  for (const target of targets) {
    if (job.cancelled) break;
    if (job.requests >= job.budget) {
      job.budgetExceeded = true;
      job.warnings.push(`${source}_budget`);
      break;
    }
    const cached = readDetail(source, target.id);
    const completingCatalog =
      cached.fresh &&
      !job.force &&
      source === 'epic' &&
      cached.doc &&
      cached.doc.status === 'ok' &&
      target.catalogItemId &&
      shouldAttemptCatalog(cached.doc.data, {
        ownerKey: job.ownerKey,
        catalogItemId: target.catalogItemId,
      });
    if (cached.fresh && !job.force && !completingCatalog) {
      const cachedData = cached.doc && cached.doc.status === 'ok' ? cached.doc.data : null;
      const needsWikidataFacts = Boolean(
        cachedData &&
          (cachedData.releaseYear == null ||
            !(Array.isArray(cachedData.genres) && cachedData.genres.length))
      );
      if (source === 'epic' && needsWikidataFacts) {
        const healed = applyWikidataFacts(cachedData, {
          store: 'epic',
          slug: target.slug || target.id,
        });
        if (healed !== cachedData) {
          const flags = catalogMetaFlags(healed);
          writeDetail('epic', target.id, 'ok', {
            ...healed,
            metaStatus: flags.metaStatus,
            metaYearHas: flags.yearHas,
            metaGenresOk: flags.genresOk,
            metaCheckedAt: isoOf(nowMs()),
          });
          phase.resolved++;
          phase.cached++;
          continue;
        }
      }
      if (cached.doc.status === 'ok') phase.resolved++;
      else phase.notFound++;
      phase.cached++;
      continue;
    }
    try {
      if (!completingCatalog) job.requests++;
      const result = await resolveOne(target, {
        client: job.client,
        force: job.force,
        probeBudget: job.budget - job.requests + 1,
        canRequest: () => job.requests < job.budget,
        onWarning: (warning) => {
          if (warning) job.warnings.push(String(warning));
        },
        onCatalogDeferred: () => {
          phase.deferred++;
        },
        onRequest: () => {
          job.requests++;
        },
      });
      if (result.status === 'ok') {
        phase.resolved++;
        if (completingCatalog) phase.cached++;
        else phase.fetched++;
      } else if (result.status === 'not_found') {
        if (result.reason !== 'no_slug') {
          phase.notFound++;
          phase.fetched++;
        }
      }
      if (result.catalogSkipped) {
        phase.catalogSkipped++;
        const warning = `epic_catalog_${result.catalogSkipReason || result.catalogSkipped}`;
        if (!job.warnings.includes(warning)) job.warnings.push(warning);
      }
    } catch (err) {
      const code = (err && err.code) || 'secondary_details_error';
      const reason = (err && (err.breakerCode || err.reason)) || code;
      recordError({
        ownerKey: job.ownerKey,
        source,
        id: String(target.id || target.slug || ''),
        code,
        reason,
        status: err && err.status != null ? err.status : null,
        host: err && err.host ? err.host : null,
        message: maskSecrets((err && err.message) || '').slice(0, 200),
      });
      if (err && err.deferred) {
        phase.deferred++;
        job.warnings.push(`${source}_${reason}`);
        if (code === 'secondary_details_blocked') break;
      } else {
        phase.failed++;
        job.warnings.push(`${source}_${reason}`);
      }
    }
    if (job.requests < job.budget) await sleep(job.pauseMs);
  }
  if (source === 'epic' && phase.missingSlug > 0) {
    job.warnings.push('epic_no_slug');
  }
  job.stage = source === 'gog' ? 'epic' : 'done';
}

function titleCandidatesFor(epic) {
  const out = [];
  for (const entry of Array.isArray(epic) ? epic : []) {
    if (!entry || !entry.slug || !entry.title) continue;
    if (!entry.catalog) continue;
    const hasCatalogDate = Boolean(entry.catalog.releaseDate);
    let cached = null;
    try {
      cached = readDetail('epic', entry.slug);
    } catch (err) {
      cached = null;
    }
    const data = cached && cached.doc && cached.doc.status === 'ok' ? cached.doc.data : null;
    if (!data) {
      if (hasCatalogDate) continue;
      out.push({ slug: entry.slug, title: entry.title });
      continue;
    }
    const hasYear = data.releaseYear != null;
    const hasGenres = Array.isArray(data.genres) && data.genres.length > 0;
    if (hasYear && hasGenres) continue;
    out.push({
      slug: entry.slug,
      title: entry.title,
      releaseYear: data.releaseYear == null ? null : data.releaseYear,
      releaseDate: data.releaseDate || null,
      genres: Array.isArray(data.genres) ? data.genres : [],
    });
  }
  return out;
}

module.exports = {
  sleep,
  runPhase,
  titleCandidatesFor,
};
