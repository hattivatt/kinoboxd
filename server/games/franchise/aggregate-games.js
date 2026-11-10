'use strict';

const { round1 } = require('./aggregate-rules');

function resolveSecondaryWorks(options, parsed) {
  // M6 follow-up (03.11.2026): works that exist only outside Steam (GOG/Epic
  // exclusives) belong to the same franchises. The caller may pass them
  // explicitly (tests/purity); production reads the cache through the union.
  // Injected readers mean «pure unit test» — then no disk read happens.
  let secondaryWorks = options.secondaryWorks;
  if (secondaryWorks === undefined) {
    const injected = Boolean(
      options.getLibrary || options.getProfile || options.readDetails || options.readLinks
    );
    secondaryWorks = injected
      ? []
      : (() => {
          try {
            return require('../secondary-works').secondaryWorksForOwner(parsed.key);
          } catch (err) {
            return [];
          }
        })();
  }
  return Array.isArray(secondaryWorks) ? secondaryWorks.filter(Boolean) : [];
}

function collectLibraryGames(library, { readDetails, readLinks, ttlMs, nowMs }) {
  const games = [];
  const release = { fromDetails: 0, fromWikidata: 0, fromBase: 0, unknown: 0, unavailableDetails: 0 };
  const linksCoverage = {
    documents: 0,
    withQid: 0,
    withBase: 0,
    withFranchise: 0,
    withReleaseYear: 0,
    fresh: 0,
  };
  /** `qid: null` rows whose base version has not been looked up yet (B6). */
  let bridgePending = 0;

  for (const game of library.games || []) {
    const appid = Number(game.appid);
    if (!Number.isInteger(appid) || appid <= 0) continue;
    const details = readDetails(appid);
    if (details && details.success !== false && details.type && details.type !== 'game') continue;
    if (details && details.success === false) release.unavailableDetails++;

    const links = readLinks(appid) || {};
    if (links.resolved || links.qid || links.franchise || links.releaseYear) linksCoverage.documents++;
    if (links.qid) linksCoverage.withQid++;
    if (links.baseQid) linksCoverage.withBase++;
    if (links.franchiseKey || links.franchise) linksCoverage.withFranchise++;
    if (links.releaseYear) linksCoverage.withReleaseYear++;
    const linksAt = Date.parse(String(links.fetchedAt || ''));
    const linksFresh =
      Boolean(links.resolved) &&
      (ttlMs == null
        ? true
        : Number.isFinite(linksAt) && nowMs - linksAt >= 0 && nowMs - linksAt < ttlMs);
    if (linksFresh) linksCoverage.fresh++;

    // B6: a `qid: null` row is not «done» any more — the base-version bridge
    // may still give the work an identity. `baseCheckedAt` is its own
    // negative marker, inside the same 90-day window.
    if (links.resolved && !links.qid && !links.baseQid) {
      const baseAt = Date.parse(String(links.baseCheckedAt || ''));
      const baseFresh =
        ttlMs != null && Number.isFinite(baseAt) && nowMs - baseAt >= 0 && nowMs - baseAt < ttlMs;
      if (!baseFresh) bridgePending++;
    }

    let releaseYear = null;
    let releaseSource = null;
    const detailYear = details && details.success !== false ? details.releaseYear : null;
    if (Number.isInteger(Number(detailYear)) && Number(detailYear) > 0) {
      releaseYear = Number(detailYear);
      releaseSource = 'steam-store';
      release.fromDetails++;
    } else if (Number.isInteger(Number(links.releaseYear)) && Number(links.releaseYear) > 0) {
      releaseYear = Number(links.releaseYear);
      releaseSource = 'wikidata';
      release.fromWikidata++;
    } else if (Number.isInteger(Number(links.baseReleaseYear)) && Number(links.baseReleaseYear) > 0) {
      // B6: the regional SKU has no P577 of its own; its work does.
      releaseYear = Number(links.baseReleaseYear);
      releaseSource = 'wikidata-base';
      release.fromBase++;
    } else {
      release.unknown++;
    }

    const wdFranchise = links.franchise;
    const wdKey = links.franchiseKey || (wdFranchise && wdFranchise.qid ? `wd:${wdFranchise.qid}` : null);
    games.push({
      appid,
      name: (details && details.name) || game.name || null,
      hours: round1((Number(game.playtime_forever) || 0) / 60),
      releaseYear,
      releaseSource,
      releasePrecision:
        releaseSource === 'steam-store'
          ? details.releasePrecision || null
          : releaseSource === 'wikidata'
            ? links.releasePrecision || null
            : null,
      // Did Wikidata answer inside the TTL? (independent of whether P179/P577
      // were found: a negative answer is still an answer).
      wdResolved: Boolean(links.resolved),
      wdFresh: linksFresh,
      // WD assignment; the heuristic is applied below, after grouping.
      wdKey,
      wdFranchise: wdKey
        ? {
            key: wdKey,
            label: (wdFranchise && (wdFranchise.labelEn || wdFranchise.labelRu)) || null,
            labelRu: (wdFranchise && wdFranchise.labelRu) || null,
            confidence: 'high',
          }
        : null,
    });
  }

  return { games, release, linksCoverage, bridgePending };
}

function collectSecondaryGames(secondaryList) {
  // ---- secondary-only works (GOG/Epic exclusives) ----
  // They are owned works of the same owner, so they join the same franchise
  // buckets by their P179 key. `appid` stays `null`; `workKey` is the identity
  // the drilldown and the union card use. They never enter the title
  // heuristic (a store title alone is not enough evidence).
  const games = [];
  let secondaryGames = 0;
  let secondaryWithFranchise = 0;
  let secondaryFranchisePending = 0;
  for (const work of secondaryList) {
    if (!work || !work.workKey) continue;
    secondaryGames++;
    const series = work.franchise && work.franchise.key ? work.franchise : null;
    const wdKey = series ? series.key : null;
    if (wdKey) secondaryWithFranchise++;
    // Only a work whose QID is known can be asked; a QID-less store exclusive
    // is not «pending Wikidata» forever (the bridge may resolve it later, but
    // that is the secondary-details pass, not this kick).
    if (work.qid && !work.franchiseChecked) secondaryFranchisePending++;
    const year = Number(work.releaseYear);
    games.push({
      appid: null,
      workKey: work.workKey,
      secondaryOnly: true,
      name: work.name || null,
      hours: round1(Number(work.hours) || 0),
      releaseYear: Number.isInteger(year) && year > 0 ? year : null,
      releaseSource: Number.isInteger(year) && year > 0 ? 'secondary-store' : null,
      releasePrecision: null,
      // A secondary identity is answered by the bridge (QID) and the franchise
      // cache; `franchiseChecked` is the TTL marker for `pending.secondary`.
      wdResolved: Boolean(work.qid || work.franchiseChecked),
      wdFresh: Boolean(work.franchiseChecked),
      wdKey,
      wdFranchise: wdKey
        ? {
            key: wdKey,
            label: (series && (series.label || series.labelRu)) || null,
            labelRu: (series && series.labelRu) || null,
            confidence: 'high',
          }
        : null,
    });
  }
  return { games, secondaryGames, secondaryWithFranchise, secondaryFranchisePending };
}

module.exports = {
  resolveSecondaryWorks,
  collectLibraryGames,
  collectSecondaryGames,
};
