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
    // A cached Epic detail that is still «poster only» (stale CMS page, no
    // catalog when it was written) is completed from the catalog with the
    // owner's token. This is not a CMS refetch: `resolveEpic` sees the fresh
    // document and only merges catalog fields into it.
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
      // A fresh document can still receive facts that appeared in the identity
      // bridge after it was written: a release year (the Alan Wake 2 heal) or
      // a P136 genre line when the store/catalog gave none (its stale CMS page
      // has only the `public` bucket, whose chip is filtered out on read since
      // 03.11.2026). This is a cache read + a write only when something was
      // actually filled; no network, no request counter.
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
        // A no-slug target needs a probe + a product page; both count.
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
        // `no_slug` is not a verdict about the product (it was never
        // addressed): it is already counted in `phase.missingSlug`.
        if (result.reason !== 'no_slug') {
          phase.notFound++;
          phase.fetched++;
        }
      }
      if (result.catalogSkipped) {
        // «The phase found the work, saw the catalog could help and did not
        // ask» must be a visible fact, not a fast `done`.
        phase.catalogSkipped++;
        const warning = `epic_catalog_${result.catalogSkipReason || result.catalogSkipped}`;
        if (!job.warnings.includes(warning)) job.warnings.push(warning);
      }
    } catch (err) {
      const code = (err && err.code) || 'secondary_details_error';
      // `cms_blocked` is the reason an edge refused the CMS — it must not be
      // reported as «no metadata» (ИГРЫ §14.5).
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
        // A blocked/unreachable host is not a per-product failure: stop this
        // phase instead of hammering it for every remaining product.
        if (code === 'secondary_details_blocked') break;
      } else {
        phase.failed++;
        job.warnings.push(`${source}_${reason}`);
      }
    }
    if (job.requests < job.budget) await sleep(job.pauseMs);
  }
  if (source === 'epic' && phase.missingSlug > 0) {
    // Honest diagnostic: these works stay «library-only» (title + hours) —
    // not a `not_found` verdict about a product we never addressed.
    job.warnings.push('epic_no_slug');
  }
  job.stage = source === 'gog' ? 'epic' : 'done';
}


/**
 * Epic works that may still gain facts from a Wikidata title match: the store
 * and catalog gave no date, **or** the cached detail has no genre line (the
 * stale `public` bucket is filtered away on read, so the genre axis is empty).
 * Only these may be title-matched; a work with a store date and a store genre
 * line is never re-identified by title.
 *
 * Since 03.11.2026 a catalog date no longer stops the pass by itself: `P577`
 * and `P136` are independent facts of the item, so a dated Epic exclusive with
 * an empty genre line (Alan Wake 2) is a candidate too. This costs **no**
 * network when the title answer is already cached — `isSettledTitleEntry()`
 * filters it in `fetchSecondaryTitleLinks()` — and exactly one question when
 * the cache has no genre answer yet. A dated work with no cached detail
 * document is still skipped: there is no genre axis to judge before the
 * document exists, and the catalog date is trusted as before.
 */
function titleCandidatesFor(epic) {
  const out = [];
  for (const entry of Array.isArray(epic) ? epic : []) {
    if (!entry || !entry.slug || !entry.title) continue;
    // No catalog document means the store date is unknown; the import writes
    // one for every game, so wait for that instead of asking on a guess.
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
      // The old rule: a catalog date is enough while no document exists.
      if (hasCatalogDate) continue;
      out.push({ slug: entry.slug, title: entry.title });
      continue;
    }
    const hasYear = data.releaseYear != null;
    const hasGenres = Array.isArray(data.genres) && data.genres.length > 0;
    if (hasYear && hasGenres) continue;
    // The `genres` key makes the genre axis explicit for `collectTitleCandidates`;
    // `releaseYear`/`releaseDate` keep the year axis honest.
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
