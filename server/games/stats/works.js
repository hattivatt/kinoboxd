'use strict';

const editions = require('../editions');

function buildWorks({ input, keptGames, details, links, profileKey, library }) {
  const editionDoc =
    input.editions &&
    (!input.editions.algorithmVersion ||
      Number(input.editions.algorithmVersion) === editions.ALGORITHM_VERSION) &&
    editions.covers(input.editions, keptGames) &&
    input.editions.canonical &&
    typeof input.editions.canonical === 'object'
      ? input.editions
      : editions.buildEditionIndex({
          games: keptGames,
          details,
          links,
          manual: input.editions && input.editions.manual,
          profileKey,
          libraryFingerprint: library.fingerprint,
        });
  const canonicalOf = (appid) =>
    editionDoc.canonical[String(appid)] || {
      workKey: `steam:${appid}`,
      primaryAppid: appid,
      appids: [appid],
      editionCount: 1,
      confidence: 'single',
    };

  const workMap = new Map();
  for (const game of keptGames) {
    const canon = canonicalOf(game.appid);
    let work = workMap.get(canon.workKey);
    if (!work) {
      work = {
        workKey: canon.workKey,
        canonical: canon,
        games: [],
        minutes: 0,
        minutes2w: 0,
        rtime: 0,
      };
      workMap.set(canon.workKey, work);
    }
    work.games.push(game);
    work.minutes += Number(game.playtime_forever) || 0;
    work.minutes2w += Number(game.playtime_2weeks) || 0;
    work.rtime = Math.max(work.rtime, Number(game.rtime_last_played) || 0);
  }

  const allWorks = [...workMap.values()];
  for (const work of allWorks) {
    const persistedPrimary = work.canonical.primaryAppid;
    work.games.sort((left, right) => {
      const minutes =
        (Number(right.playtime_forever) || 0) - (Number(left.playtime_forever) || 0);
      if (minutes) return minutes;
      if (left.appid === persistedPrimary) return -1;
      if (right.appid === persistedPrimary) return 1;
      return Number(left.appid) - Number(right.appid);
    });
    work.primary = work.games[0];
    work.hours = work.minutes / 60;
  }

  return { editionDoc, canonicalOf, workMap, allWorks };
}

module.exports = { buildWorks };
