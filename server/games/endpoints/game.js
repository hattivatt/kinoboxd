'use strict';

const { HttpError } = require('../../core/errors');
const { assertOnlyParams } = require('../../core/params');
const franchise = require('../franchise');
const gameCache = require('../game-cache');
const { personnelForGame } = require('../personnel/personnel');
const steamArt = require('../steam-art');
const { genreNamesOf, categoryNamesOf, minutesToHours } = require('../stats');

function register(router, ctx) {
  const { deps, mapError, resolveProfileOrThrow } = ctx;
  const artHandler = steamArt.createSteamArtHandler({
    fetch: deps.steamArtFetch || deps.fetch,
  });

  /* ------------------------ game card ------------------------- */

  // Steam art CDN proxy (fix-round 02.11.2026, ИГРЫ §8.2 artwork). The owner's
  // ISP blocks the Steam CDN in Vietnam; the server relays the public asset.
  // The upstream URL is built from type/appid/hash, never from client input.
  // The global `/api` auth gate in `server/index.js` already protects it.
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
      // M4: cached tags and review summary (no network, no fabrication).
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
      // M3: cached credits for this appid (no network, no fabrication).
      const personnel = personnelForGame(appid);
      // M4-B: franchise / release year from links/<appid>.json (written by the
      // WD pass). `null` when Wikidata has not answered yet — the card says so
      // instead of pretending the game has no franchise.
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
        // M2: store appdetails (null until the enrich job has fetched it).
        details,
        // M4: SteamSpy tags (top-20, weighted) and the community review grade
        // (reference only — Steam has no personal 1..10 ratings, ИГРЫ §1.2).
        tags,
        review,
        // M3: credits for this game from cache-games/personnel/<appid>.json
        // (studios from details + Wikidata/Moby, people, honest `pending`).
        // Never a network call — the personnel job fills the cache.
        personnel: personnelForGame(appid),
        // M4-B: Wikidata series + P577 year (cache-games/links/<appid>.json).
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
              // `personnelForGame` already says whether details/credits are
              // missing for this appid, so the card never claims a full
              // payload it does not have (and never lists what is present).
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
      next(mapError(err));
    }
  });
}

module.exports = { register };
