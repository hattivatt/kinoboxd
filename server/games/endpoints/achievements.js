'use strict';

const { HttpError } = require('../../core/errors');
const { assertOnlyParams, parseBoolParam } = require('../../core/params');
const gameCache = require('../game-cache');

function register(router, ctx) {
  const { client, mapError, resolveProfileOrThrow } = ctx;

  /* ----------------------- achievements ----------------------- */

  function globalPercentFor(global, apiname) {
    if (!global || !global.byName || !apiname) return null;
    const direct = global.byName[apiname];
    if (direct != null) return direct;
    return global.byName[String(apiname).toLowerCase()] ?? null;
  }

  router.get('/achievements', async (req, res, next) => {
    try {
      assertOnlyParams(
        req,
        ['profile', 'appid', 'refresh'],
        'GET /api/games/achievements'
      );
      const scope = resolveProfileOrThrow(req.query.profile);
      const appid = Number(req.query.appid);
      if (!Number.isInteger(appid) || appid <= 0) {
        throw new HttpError(400, 'Query parameter "appid" must be a positive integer.', 'invalid_appid');
      }
      const game = (scope.library.games || []).find((entry) => entry.appid === appid) || null;
      const refresh = parseBoolParam(req.query.refresh, 'refresh', false);
      const cached = gameCache.getAchievements(scope.parsed.userKey, appid);
      let doc = cached;
      let fetched = false;
      if (!doc || refresh || !gameCache.isFresh(doc, gameCache.achievementsTtlMs())) {
        doc = await client.getAchievements(scope.parsed.userKey, appid);
        doc = {
          ...doc,
          fetchedAt: new Date().toISOString(),
        };
        await gameCache.saveAchievements(scope.parsed.userKey, appid, doc);
        fetched = true;
      }

      let global = gameCache.getGlobal(appid);
      let globalFetched = false;
      let globalError = null;
      if (!global || !gameCache.isFresh(global, gameCache.globalTtlMs())) {
        try {
          const fresh = await client.getGlobalPercentages(appid);
          global = { ...fresh, fetchedAt: new Date().toISOString() };
          await gameCache.saveGlobal(appid, global);
          globalFetched = true;
        } catch (err) {
          globalError = (err && err.code) || 'global_failed';
        }
      }

      const items = (doc.achievements || []).map((entry) => ({
        apiname: entry.apiname,
        name: entry.name,
        description: entry.description,
        achieved: entry.achieved,
        unlockTimestamp: entry.unlockTimestamp,
        unlockAt: entry.unlockAt,
        icon: entry.achieved ? entry.iconOpen || entry.iconClosed : entry.iconClosed || entry.iconOpen,
        globalPercent: globalPercentFor(global, entry.apiname),
      }));
      const rareUnlocked = items.filter(
        (entry) => entry.achieved && entry.globalPercent != null && entry.globalPercent < 5
      ).length;
      res.status(200).json({
        profile: scope.parsed.key,
        appid,
        inLibrary: Boolean(game),
        name: (game && game.name) || doc.gameName || null,
        gameName: doc.gameName || null,
        hoursPlayedStats: doc.statsHoursPlayed,
        unlocked: doc.unlockedCount,
        total: doc.totalCount,
        percent: doc.totalCount ? Math.round((doc.unlockedCount / doc.totalCount) * 1000) / 10 : 0,
        rareUnlocked,
        rareThresholdPercent: 5,
        items,
        source: 'steam-community',
        fetched,
        fetchedAt: doc.fetchedAt || null,
        globalFetched,
        globalAvailable: Boolean(global),
        globalFetchedAt: global ? global.fetchedAt || null : null,
        globalError,
      });
    } catch (err) {
      next(mapError(err));
    }
  });
}

module.exports = { register };
