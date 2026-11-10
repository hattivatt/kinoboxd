'use strict';

const { catalogMetaFlags, slugFromTitle } = require('./normalize');
const {
  readDetail,
  readCatalogState,
  catalogCompletionState,
  catalogRetryDue,
} = require('./store');
const { applyWikidataFacts } = require('./enrich');
const { readSecondaryLinks, readSecondaryTitleLinks } = require('./cache');
const { MAX_SLUGLESS } = require('./details-config');
const { targetsForOwner } = require('./details-targets');

/**
 * Would the cached identity bridge fill an **empty** fact of this detail —
 * without a single request?
 *
 * `applyWikidataFacts` is the exact function the job's cached-document heal
 * branch calls, so the verdict and the heal cannot drift: `next !== data` means
 * the bridge already carries the release year (`P577`) or the genre line
 * (`P136`) this document is missing. A partial with such a fact is `healable`
 * and must reach the kick even when the catalog has nothing left to answer
 * (the Alan Wake 2 symptom: the genre line sat in `titleEntries`, the lazy kick
 * returned `attempted` because only catalog work counted).
 *
 * Only **facts** count, never the presence of an entry: a settled title `miss`
 * (`qid: null`), a genre-less QID, or two different QIDs leave the document
 * unchanged and are not healable — otherwise the kick would repeat forever with
 * nothing to apply. The bridge is read **fresh-only**, exactly like the heal
 * branch: a stale entry would not be applied by the job either, so it must not
 * start one.
 */
function healableFromBridge(data, slug, bridge) {
  if (!data || !slug || data.source !== 'epic') return false;
  // Both facts arrived — nothing to fill, whatever the bridge says.
  if (catalogMetaFlags(data).metaStatus === 'complete') return false;
  const { links, titleLinks } = bridge();
  return (
    applyWikidataFacts(data, { store: 'epic', slug, links, titleLinks }) !== data
  );
}

/**
 * How many of the owner's secondary products already have a detail document.
 * `total` includes **slugless** Epic works: the title probe is the only way to
 * address them, and «resolved < total» must stay true until one of them is
 * either resolved or explicitly given up (a probe negative is not resolved,
 * but it stops the retry loop through the probe TTL).

/**
 * How many of the owner's secondary products already have a detail document.
 * `total` includes **slugless** Epic works: the title probe is the only way to
 * address them, and «resolved < total» must stay true until one of them is
 * either resolved or explicitly given up (a probe negative is not resolved,
 * but it stops the retry loop through the probe TTL).
 */
function coverageForOwner(ownerKey) {
  const targets = targetsForOwner(ownerKey);
  const epicBinding = targets.epicBinding || { state: 'none', accountId: null };
  const epicHasToken = Boolean(
    epicBinding.accountId && epicBinding.hasAccessToken !== false
  );
  // One ledger read for the whole pass: `/stats` is polled, and a 300-work
  // Epic library must not re-read the same state file per target.
  let catalogState = null;
  try {
    catalogState = readCatalogState();
  } catch (err) {
    catalogState = null;
  }
  // The identity bridge is read **once** per pass and only when a partial Epic
  // document needs it: `/stats` is polled, and a 300-work library must not
  // re-read `links/secondary.json` per target. `null` = not read yet.
  let bridgeLinks = null;
  let bridgeTitleLinks = null;
  const bridge = () => {
    if (bridgeLinks === null) {
      try {
        bridgeLinks = readSecondaryLinks();
        bridgeTitleLinks = readSecondaryTitleLinks();
      } catch (err) {
        bridgeLinks = {};
        bridgeTitleLinks = {};
      }
    }
    return { links: bridgeLinks, titleLinks: bridgeTitleLinks };
  };
  const phase = (source, list, idOf) => {
    let resolved = 0;
    let notFound = 0;
    let unavailable = 0;
    let partial = 0;
    let retryablePartial = 0;
    let healable = 0;
    let pending = 0;
    for (const target of list) {
      const id = idOf(target);
      if (!id) {
        // A slugless Epic work is addressable only by its title guess. A fresh
        // probe negative means «attempted, nothing found» — not pending.
        let attempted = false;
        if (source === 'epic' && target.title) {
          const guess = slugFromTitle(target.title);
          const hit = guess ? readDetail('epic', guess) : null;
          if (
            hit &&
            hit.fresh &&
            hit.doc &&
            hit.doc.status === 'not_found' &&
            hit.doc.probe === true
          ) {
            notFound++;
            attempted = true;
          }
        }
        if (!attempted) pending++;
        continue;
      }
      const { doc, fresh } = readDetail(source, id);
      if (!fresh || !doc) {
        pending++;
        continue;
      }
      if (doc.status !== 'ok') {
        if (doc.status === 'not_found') notFound++;
        else pending++;
        continue;
      }
      if (source === 'gog') {
        // GOG was resolved before the `metaStatus` work; keep its contract.
        resolved++;
        continue;
      }
      // Epic: `resolved` means the **facts** arrived (year + genres), not that
      // a file exists. A settled negative is `unavailable` (honest «store has
      // no release info»), a deferred/pre-catalog document is still pending.
      const completion = catalogCompletionState(doc.data, {
        ownerKey,
        catalogItemId: target.catalogItemId,
        hasCatalogToken: epicHasToken,
        catalogState,
      });
      if (completion === 'complete') resolved++;
      else if (completion === 'partial') {
        // One fact arrived, the other did not. It is still a work the catalog
        // can complete, so it must reach the kick (fix 02.11.2026: `partial`
        // used to be counted as neither `resolved` nor `pending`, so the lazy
        // kick returned `attempted` and AW2 stayed poster-only forever).
        // A partial whose catalog answer is already settled (`shape_ok`, or
        // `ok` inside its 30-day probe TTL) is not re-asked on every poll, and
        // without an owner token there is nothing to ask — the next connect
        // makes it retryable again.
        partial++;
        if (
          epicHasToken &&
          target.catalogItemId &&
          catalogRetryDue(ownerKey, target.catalogItemId, { catalogState })
        ) {
          retryablePartial++;
        }
        // Independent of the catalog: a missing fact that is already in the
        // identity bridge is applied by the job's heal branch from the cache,
        // with no request and no owner token. This is what makes the AW2
        // genre line reach a kick at all.
        if (healableFromBridge(doc.data, id, bridge)) healable++;
      } else if (completion === 'pending') pending++;
      else unavailable++;
    }
    return {
      total: list.length,
      resolved,
      notFound,
      unavailable,
      partial,
      retryablePartial,
      healable,
      missingSlug: 0,
      pending,
    };
  };
  const gog = phase('gog', targets.gog, (target) => target.id);
  const epic = phase('epic', targets.epic, (target) => target.slug);
  epic.missingSlug = targets.epicNoSlug;
  const slugless = targets.epic
    .filter((target) => !target.slug)
    .slice(0, MAX_SLUGLESS)
    .map((target) => ({
      name: target.title || null,
      catalogItemId: target.catalogItemId || null,
      appName: target.appName || null,
    }));
  return {
    gog,
    epic,
    slugless,
    // Where the Epic binding actually stands (`bound`/`unbound`/`profile_missing`/
    // `owner_mismatch`/`ambiguous`/`none`) plus the account it resolves to, so a
    // missing/foreign token is a stated fact rather than an empty card.
    epicBinding,
    resolved: gog.resolved + epic.resolved,
    total: gog.total + epic.total,
    pending: gog.pending + epic.pending,
    // `partial` is a first-class state: the work has a detail document but one
    // of year/genres is missing. `retryablePartial` is the subset the catalog
    // can still answer for (no attempt yet, or the 30-day window expired);
    // `healable` is the subset whose missing fact already sits in the cached
    // identity bridge (a cache-only write, no request, no token).
    partial: gog.partial + epic.partial,
    retryablePartial: gog.retryablePartial + epic.retryablePartial,
    healable: gog.healable + epic.healable,
  };
}

/**
 * The single kick rule (fix 02.11.2026): a secondary library needs the store
 * metadata job when **any** of these holds:
 *
 *   - `resolved < total` — an addressable work has no detail yet;
 *   - `partial > 0`      — a detail exists but only one of year/genres
 *                          arrived; the time-based rule used to let this work
 *                          sit forever (the AW2 symptom), so it is now
 *                          re-posted with the goal «complete»;
 *   - `healable > 0`     — a partial whose missing fact is already in the
 *                          cached identity bridge: the job writes it from the
 *                          cache, no request. Absent from the cheap
 *                          `stats.meta.secondaryDetails` snapshot (that one is
 *                          built from the detail index alone); a coverage
 *                          snapshot carries it, and the lazy kick's refinement
 *                          is what turns it into a job;
 *   - `noSlug > 0`       — an Epic work has no store slug and can only be
 *                          addressed by the title probe.
 *
 * Callers pass either `stats.meta.secondaryDetails` (cheap, no cache reads) or
 * a refined `coverageForOwner()` snapshot; the predicate is identical.
 */
function coverageNeedsKick(meta) {
  if (!meta || typeof meta !== 'object') return false;
  const total = Number(meta.total) || 0;
  const resolved = Number(meta.resolved) || 0;
  const partial = Number(meta.partial) || 0;
  const healable = Number(meta.healable) || 0;
  const noSlug = Number(meta.noSlug) || 0;
  return (total > 0 && resolved < total) || partial > 0 || healable > 0 || noSlug > 0;
}

module.exports = {
  healableFromBridge,
  coverageForOwner,
  coverageNeedsKick,
};
