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

function healableFromBridge(data, slug, bridge) {
  if (!data || !slug || data.source !== 'epic') return false;
  if (catalogMetaFlags(data).metaStatus === 'complete') return false;
  const { links, titleLinks } = bridge();
  return (
    applyWikidataFacts(data, { store: 'epic', slug, links, titleLinks }) !== data
  );
}

function coverageForOwner(ownerKey) {
  const targets = targetsForOwner(ownerKey);
  const epicBinding = targets.epicBinding || { state: 'none', accountId: null };
  const epicHasToken = Boolean(
    epicBinding.accountId && epicBinding.hasAccessToken !== false
  );
  let catalogState = null;
  try {
    catalogState = readCatalogState();
  } catch (err) {
    catalogState = null;
  }
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
        resolved++;
        continue;
      }
      const completion = catalogCompletionState(doc.data, {
        ownerKey,
        catalogItemId: target.catalogItemId,
        hasCatalogToken: epicHasToken,
        catalogState,
      });
      if (completion === 'complete') resolved++;
      else if (completion === 'partial') {
        partial++;
        if (
          epicHasToken &&
          target.catalogItemId &&
          catalogRetryDue(ownerKey, target.catalogItemId, { catalogState })
        ) {
          retryablePartial++;
        }
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
    epicBinding,
    resolved: gog.resolved + epic.resolved,
    total: gog.total + epic.total,
    pending: gog.pending + epic.pending,
    partial: gog.partial + epic.partial,
    retryablePartial: gog.retryablePartial + epic.retryablePartial,
    healable: gog.healable + epic.healable,
  };
}

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
