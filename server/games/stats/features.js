'use strict';

/**
 * Feature aggregates of the games payload: DLC facts, Wikidata franchise
 * coverage and the M2 mode/early-access/F2P/platform blocks.
 *
 * S1 «распил god-функции»: split out of `aggregates.js` so every builder stays
 * under the 300-line target. Pure over the visible works and the details map.
 */

const { DLC_TOP_LIMIT } = require('./constants');
const { round1, round2, round3, minutesToHours } = require('./numeric');
const { detailOf, linksOf } = require('./documents');

function buildFeatures(ctx) {
  const {
    visibleWorks,
    hasDetails,
    linkDocs,
    platformMinutes,
    totalMinutes,
    details,
    gameCount,
    hoursOf,
    rawTotalHours,
  } = ctx;
  const { workDlc, workModeFlags, workHasFlag } = ctx.workMeta;

  /* ---------------- M4: DLC facts ---------------- */
  // `dlcCount` already lives in the details document (`dlc[]` length); the
  // widget only needs the facts, not the DLC appids. Editions share DLCs, so
  // the work's count is the union of its editions' DLC appids.
  let dlcSummary = null;
  if (hasDetails) {
    const dlcGames = [];
    let dlcTotal = 0;
    for (const work of visibleWorks) {
      const info = workDlc(work);
      if (!info.hasDetails) continue;
      dlcTotal += info.count;
      dlcGames.push({
        appid: work.primary.appid,
        name: work.primary.name || null,
        dlcCount: info.count,
      });
    }
    const withDlc = dlcGames.filter((entry) => entry.dlcCount > 0);
    dlcSummary = {
      gamesWithDlc: withDlc.length,
      dlcTotal,
      avgCount: dlcGames.length ? round2(dlcTotal / dlcGames.length) : 0,
      max: [...withDlc]
        .sort(
          (left, right) =>
            right.dlcCount - left.dlcCount || String(left.name || '').localeCompare(String(right.name || ''))
        )
        .slice(0, DLC_TOP_LIMIT),
    };
  }

  /* ---------------- M4-B: Wikidata links (franchise / P577 year) ---------------- */
  // Per-game assignment lives in `gamesIndex`; this block only counts what the
  // WD pass answered so `summary` and `meta.pending` stay honest. The grouping
  // (and the low-confidence title heuristic) belongs to `/api/games/franchises`
  // — `summary.coverage.franchises` is therefore Wikidata-only on purpose.
  let gamesWithFranchiseLinks = 0;
  let linksResolved = 0;
  for (const work of visibleWorks) {
    let answered = false;
    let franchise = false;
    for (const game of work.games) {
      const links = linksOf(linkDocs, game.appid);
      if (!links) continue;
      if (links.resolved) answered = true;
      if (links.franchiseKey) franchise = true;
    }
    if (answered) linksResolved++;
    if (franchise) gamesWithFranchiseLinks++;
  }
  const franchiseCoverage = {
    source: 'wikidata',
    includesHeuristic: false,
    gamesWithFranchise: gamesWithFranchiseLinks,
    gamesAnswered: linksResolved,
    gamesTotal: gameCount,
    percent: gameCount ? round1((gamesWithFranchiseLinks / gameCount) * 100) : 0,
  };

  const modes = hasDetails
    ? {
        single: 0,
        multi: 0,
        coop: 0,
        onlineCoop: 0,
        localCoop: 0,
        onlinePvp: 0,
        mmo: 0,
        cloud: 0,
        controller: 0,
      }
    : null;
  let earlyCount = 0;
  let earlyHours = 0;
  let freeCount = 0;
  let freeHours = 0;
  const platformGames = { windows: 0, mac: 0, linux: 0 };
  if (hasDetails) {
    for (const work of visibleWorks) {
      const hours = hoursOf(work);
      const flags = workModeFlags(work);
      for (const key of Object.keys(modes)) {
        if (flags[key]) modes[key]++;
      }
      if (workHasFlag(work, (doc) => doc.earlyAccess)) {
        earlyCount++;
        earlyHours += hours;
      }
      let workFree = false;
      for (const game of work.games) {
        const doc = detailOf(details, game.appid);
        if (!doc || doc.is_free !== true) continue;
        workFree = true;
        freeHours += (Number(game.playtime_forever) || 0) / 60;
      }
      if (workFree) freeCount++;
      if (workHasFlag(work, (doc) => doc.platforms && doc.platforms.windows)) platformGames.windows++;
      if (workHasFlag(work, (doc) => doc.platforms && doc.platforms.mac)) platformGames.mac++;
      if (workHasFlag(work, (doc) => doc.platforms && doc.platforms.linux)) platformGames.linux++;
    }
  }
  const earlyAccess = hasDetails
    ? {
        count: earlyCount,
        hours: round1(earlyHours),
        share: rawTotalHours > 0 ? round3(earlyHours / rawTotalHours) : 0,
      }
    : null;
  const freeToPlay = hasDetails
    ? {
        count: freeCount,
        hours: round1(freeHours),
        share: rawTotalHours > 0 ? round3(freeHours / rawTotalHours) : 0,
      }
    : null;
  const platforms = hasDetails
    ? {
        windows: platformGames.windows,
        mac: platformGames.mac,
        linux: platformGames.linux,
        deckHours: minutesToHours(platformMinutes.deck),
        deckHoursShare: totalMinutes ? round3(platformMinutes.deck / totalMinutes) : 0,
      }
    : null;

  return {
    dlcSummary,
    franchiseCoverage,
    modes,
    earlyAccess,
    freeToPlay,
    platforms,
    linksResolved,
  };
}

module.exports = { buildFeatures };
