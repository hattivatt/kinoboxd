'use strict';

const { HttpError, mapDomainError } = require('../../core/errors');
const { assertOnlyParams } = require('../../core/params');
const franchise = require('../franchise');
const gameCache = require('../game-cache');
const { personnelForGame } = require('../personnel/personnel');
const steamArt = require('../art');
const { genreNamesOf, categoryNamesOf, minutesToHours } = require('../stats');

function register(router, ctx) {
  const { deps, errorProfile, resolveProfileOrThrow } = ctx;
  const artHandler = steamArt.createSteamArtHandler({
    fetch: deps.steamArtFetch || deps.fetch,
  });

  router.get(
    '/steam-art/:type/:appid',
    (req, res, next) => {
      try {
        assertOnlyParams(req, ['h'], 'GET /api/games/steam-art/:type/:appid');
      } catch (err) {
        return next(err);
      }
      return artHandler(req, res, next);
    }
  );

  router.get('/game/:appid', (req, res, next) => {
    try {
      assertOnlyParams(req, ['profile'], 'GET /api/games/game/:appid');
      const scope = resolveProfileOrThrow(req.query.profile);
      const appid = Number(req.params.appid);
      if (!Number.isInteger(appid) || appid <= 0) {
        throw new HttpError(400, 'Path parameter "appid" must be a positive integer.', 'invalid_appid');
      }
      const game = (scope.library.games || []).find((entry) => entry.appid === appid);
      if (!game) {
        throw new HttpError(
          404,
          `App ${appid} is not in the ${scope.parsed.key} library.`,
          'game_not_in_library'
        );
      }
      const detailsDoc = gameCache.getDetails(appid);
      const details =
        detailsDoc && detailsDoc.success
          ? {
              type: detailsDoc.type || null,
              name: detailsDoc.name || null,
              isFree: typeof detailsDoc.is_free === 'boolean' ? detailsDoc.is_free : null,
              developers: detailsDoc.developers || [],
              publishers: detailsDoc.publishers || [],
              genres: genreNamesOf(detailsDoc),
              categories: categoryNamesOf(detailsDoc),
              releaseDate: (detailsDoc.release_date && detailsDoc.release_date.date) || null,
              releaseYear: detailsDoc.releaseYear == null ? null : detailsDoc.releaseYear,
              releasePrecision: detailsDoc.releasePrecision || null,
              earlyAccess: Boolean(detailsDoc.earlyAccess),
              metacritic:
                detailsDoc.metacritic && detailsDoc.metacritic.score != null
                  ? detailsDoc.metacritic.score
                  : null,
              dlc: Array.isArray(detailsDoc.dlc) ? detailsDoc.dlc : [],
              dlcCount: detailsDoc.dlcCount == null ? null : detailsDoc.dlcCount,
              platforms: detailsDoc.platforms || null,
              headerImage: detailsDoc.headerImage || null,
              capsuleImage: detailsDoc.capsuleImage || null,
              screenshots: Array.isArray(detailsDoc.screenshots) ? detailsDoc.screenshots : [],
              fetchedAt: detailsDoc.fetchedAt || null,
              metadataSource: detailsDoc.metadataSource || 'steam-store',
            }
          : null;
      const cached = gameCache.getAchievements(scope.parsed.userKey, appid);
      const spyDoc = gameCache.getSpy(appid);
      const tags = spyDoc && spyDoc.success && Array.isArray(spyDoc.tags) ? spyDoc.tags : [];
      const reviewDoc = gameCache.getReviews(appid);
      const review =
        reviewDoc && reviewDoc.success
          ? {
              score: reviewDoc.score == null ? null : reviewDoc.score,
              desc: reviewDoc.desc || null,
              positive: reviewDoc.positive,
              negative: reviewDoc.negative,
              total: reviewDoc.total,
              fetchedAt: reviewDoc.fetchedAt || null,
              source: 'steam-reviews',
            }
          : null;
      const personnel = personnelForGame(appid);
      const wdLinks = franchise.readLinks(appid);
      const achievements = cached
        ? {
            unlocked: cached.unlockedCount,
            total: cached.totalCount,
            percent: cached.totalCount
              ? Math.round((cached.unlockedCount / cached.totalCount) * 1000) / 10
              : 0,
            fetchedAt: cached.fetchedAt || null,
            items: (cached.achievements || []).map((entry) => ({
              apiname: entry.apiname,
              name: entry.name,
              description: entry.description,
              achieved: entry.achieved,
              unlockTimestamp: entry.unlockTimestamp,
              unlockAt: entry.unlockAt,
            })),
          }
        : null;
      res.status(200).json({
        profile: scope.parsed.key,
        appid,
        name: game.name || null,
        hours: minutesToHours(game.playtime_forever),
        hours2w: game.playtime_2weeks ? minutesToHours(game.playtime_2weeks) : 0,
        lastPlayed: Number(game.rtime_last_played)
          ? new Date(Number(game.rtime_last_played) * 1000).toISOString()
          : null,
        iconUrl: game.img_icon_url
          ? `https://media.steampowered.com/steamcommunity/public/images/apps/${appid}/${game.img_icon_url}.jpg`
          : null,
        achievements,
        details,
        tags,
        review,
        personnel: personnelForGame(appid),
        franchise: wdLinks.franchiseKey
          ? {
              key: wdLinks.franchiseKey,
              qid: wdLinks.franchise ? wdLinks.franchise.qid : null,
              label:
                (wdLinks.franchise && (wdLinks.franchise.labelEn || wdLinks.franchise.labelRu)) ||
                null,
              labelRu: (wdLinks.franchise && wdLinks.franchise.labelRu) || null,
              source: 'wikidata',
              confidence: 'high',
            }
          : null,
        releaseYearWikidata: wdLinks.releaseYear,
        releasePrecisionWikidata: wdLinks.releasePrecision,
        links: {
          steam: `https://store.steampowered.com/app/${appid}`,
          steamdb: `https://steamdb.info/app/${appid}/`,
        },
        meta: {
          achievementsCached: Boolean(cached),
          detailsCached: Boolean(details),
          tagsCached: tags.length > 0,
          reviewCached: Boolean(review),
          personnelCached: Boolean(personnel && personnel.coverage),
          pending: [
            ...new Set([
              ...(details ? [] : ['details']),
              ...(tags.length ? [] : ['tags']),
              ...(review ? [] : ['reviews']),
              ...(personnel && Array.isArray(personnel.pending)
                ? personnel.pending
                : ['personnel']),
              ...(wdLinks.qid ? [] : ['links.wikidata']),
              'links.igdb',
            ]),
          ],
        },
      });
    } catch (err) {
      next(mapDomainError(err, errorProfile));
    }
  });
}

module.exports = { register };
