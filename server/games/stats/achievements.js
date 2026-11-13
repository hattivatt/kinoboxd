'use strict';

const { round1 } = require('./numeric');
const { RARE_PERCENT } = require('./constants');

function buildAchievements({ achievements, visibleGames, visibleWorks, globals }) {
  const visibleAppids = new Set(visibleGames.map((game) => game.appid));
  const achievementDocs = (achievements || []).filter(
    (doc) => doc && doc.totalCount > 0 && visibleAppids.has(doc.appid)
  );
  const achievementByAppid = new Map(achievementDocs.map((doc) => [doc.appid, doc]));
  const completionByAppid = new Map();
  for (const doc of achievementDocs) {
    completionByAppid.set(doc.appid, {
      unlocked: doc.unlockedCount,
      total: doc.totalCount,
      percent: round1((doc.unlockedCount / doc.totalCount) * 100),
    });
  }

  const workAchievement = new Map();
  for (const work of visibleWorks) {
    let chosen = null;
    for (const game of work.games) {
      const doc = achievementByAppid.get(game.appid);
      if (doc) {
        chosen = doc;
        break;
      }
    }
    workAchievement.set(work.workKey, chosen);
    work.completion = chosen
      ? {
          unlocked: chosen.unlockedCount,
          total: chosen.totalCount,
          percent: round1((chosen.unlockedCount / chosen.totalCount) * 100),
        }
      : null;
  }

  const chosenDocs = [...workAchievement.values()].filter(Boolean);
  const percentList = chosenDocs.map((doc) => (doc.unlockedCount / doc.totalCount) * 100);
  const unlockedTotal = chosenDocs.reduce((sum, doc) => sum + doc.unlockedCount, 0);
  const achievementsTotal = chosenDocs.reduce((sum, doc) => sum + doc.totalCount, 0);

  const globalByAppid = globals || new Map();
  let rareUnlocked = 0;
  for (const doc of chosenDocs) {
    const global = globalByAppid.get ? globalByAppid.get(doc.appid) : null;
    if (!global || !global.byName) continue;
    for (const entry of doc.achievements || []) {
      if (!entry.achieved || !entry.apiname) continue;
      const percent =
        global.byName[entry.apiname] != null
          ? global.byName[entry.apiname]
          : global.byName[entry.apiname.toLowerCase()];
      if (percent != null && percent < RARE_PERCENT) rareUnlocked++;
    }
  }

  return {
    visibleAppids,
    achievementDocs,
    achievementByAppid,
    completionByAppid,
    workAchievement,
    chosenDocs,
    percentList,
    unlockedTotal,
    achievementsTotal,
    rareUnlocked,
  };
}

module.exports = { buildAchievements };
