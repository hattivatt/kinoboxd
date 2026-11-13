'use strict';

const { TAG_INDEX_LIMIT } = require('./constants');
const {
  minutesToHours,
  isoOfSeconds,
  iconUrlOf,
  headerImageOf,
  artFieldsOf,
  hoursBySourceOf,
  round1,
} = require('./numeric');
const { detailOf, spyOf, reviewsOf, linksOf, genreNamesOf, categoryNamesOf } = require('./documents');

function artOf(art, appid) {
  if (appid == null) return null;
  const map = art && typeof art === 'object' ? art : {};
  return map[appid] || map[String(appid)] || null;
}

function buildGamesIndex(ctx) {
  const {
    visibleGames,
    completionByAppid,
    details,
    spyDocs,
    reviewDocs,
    linkDocs,
    art,
    workByAppid,
    gogUnion,
    secondaryVisible,
  } = ctx;
  const { baseDetailOfAppid, yearOfAppid } = ctx.workMeta;

  const gamesIndex = {};
  for (const game of visibleGames) {
    const appid = game.appid;
    if (appid == null) continue;
    const completion = completionByAppid.get(appid) || null;
    const doc = detailOf(details, game.appid);
    const baseDoc = baseDetailOfAppid(appid);
    const year = yearOfAppid(appid);
    const spyDoc = spyOf(spyDocs, appid);
    const reviewDoc = reviewsOf(reviewDocs, appid);
    const linkDoc = linksOf(linkDocs, appid);
    const work = workByAppid.get(appid) || null;
    const primaryDoc = work ? detailOf(details, work.primary.appid) : null;
    const artDoc =
      artOf(art, work ? work.primary.appid : appid) || artOf(art, appid);
    const genres = genreNamesOf(doc);
    const developers = doc && Array.isArray(doc.developers) ? [...doc.developers] : [];
    const publishers = doc && Array.isArray(doc.publishers) ? [...doc.publishers] : [];
    gamesIndex[appid] = {
      appid,
      name: game.name || null,
      hours: minutesToHours(game.playtime_forever),
      hours2w: game.playtime_2weeks ? minutesToHours(game.playtime_2weeks) : 0,
      rtime: Number(game.rtime_last_played) || 0,
      lastPlayed: isoOfSeconds(game.rtime_last_played),
      iconUrl: iconUrlOf(appid, game.img_icon_url),
      headerImage: headerImageOf(primaryDoc) || headerImageOf(doc) || null,
      ...artFieldsOf(artDoc),
      canonicalWorkKey: work ? work.workKey : `steam:${appid}`,
      primaryAppid: work ? work.primary.appid : appid,
      isPrimary: Boolean(work && work.primary.appid === appid),
      editionCount: work ? work.games.length : 1,
      canonicalHours: work ? round1(work.hours) : minutesToHours(game.playtime_forever),
      ...(gogUnion && gogUnion.byAppid[String(appid)]
        ? {
            sources: gogUnion.byAppid[String(appid)].sources,
            storeIds: gogUnion.byAppid[String(appid)].storeIds,
            hoursBySource: hoursBySourceOf(gogUnion.byAppid[String(appid)]),
            ownedOn: gogUnion.byAppid[String(appid)].ownedOn,
            crossStoreMatchedBy: gogUnion.byAppid[String(appid)].matchedBy,
          }
        : {}),
      type: doc ? doc.type : null,
      year,
      releaseYear: year,
      genres: genres.length ? genres : genreNamesOf(baseDoc),
      developers: developers.length
        ? developers
        : baseDoc && Array.isArray(baseDoc.developers)
          ? [...baseDoc.developers]
          : [],
      publishers: publishers.length
        ? publishers
        : baseDoc && Array.isArray(baseDoc.publishers)
          ? [...baseDoc.publishers]
          : [],
      categories: categoryNamesOf(doc),
      dlcCount:
        doc && Number.isFinite(Number(doc.dlcCount)) ? Number(doc.dlcCount) : null,
      metacritic:
        doc && doc.metacritic && Number.isFinite(Number(doc.metacritic.score))
          ? Number(doc.metacritic.score)
          : null,
      isFree: doc && typeof doc.is_free === 'boolean' ? doc.is_free : null,
      earlyAccess: doc ? Boolean(doc.earlyAccess) : null,
      metadataSources: [
        ...(doc ? ['steam-store'] : []),
        ...(!doc && baseDoc ? ['steam-store:base'] : []),
        ...(spyDoc ? ['steamspy'] : []),
        ...(reviewDoc ? ['steam-reviews'] : []),
        ...(linkDoc && (linkDoc.qid || linkDoc.baseQid) ? ['wikidata'] : []),
      ],
      tags: spyDoc && Array.isArray(spyDoc.tags)
        ? spyDoc.tags
            .slice()
            .sort((left, right) => (Number(right.weight) || 0) - (Number(left.weight) || 0))
            .slice(0, TAG_INDEX_LIMIT)
            .map((tag) => ({ name: tag.name, weight: Number(tag.weight) || 0 }))
        : [],
      reviewScore: reviewDoc && reviewDoc.score != null ? Number(reviewDoc.score) : null,
      reviewDesc: reviewDoc && reviewDoc.desc != null ? String(reviewDoc.desc) : null,
      franchise: linkDoc && linkDoc.franchiseKey
        ? {
            key: linkDoc.franchiseKey,
            label:
              (linkDoc.franchise && (linkDoc.franchise.labelEn || linkDoc.franchise.labelRu)) || null,
            labelRu: (linkDoc.franchise && linkDoc.franchise.labelRu) || null,
          }
        : null,
      releaseYearWikidata:
        linkDoc && Number.isInteger(Number(linkDoc.releaseYear)) && Number(linkDoc.releaseYear) > 0
          ? Number(linkDoc.releaseYear)
          : null,
      ...(linkDoc && linkDoc.baseAppid
        ? { baseAppid: linkDoc.baseAppid, baseQid: linkDoc.baseQid || null }
        : {}),
      ...(baseDoc && baseDoc.name ? { canonicalName: String(baseDoc.name) } : {}),
      completion: completion ? completion.percent : null,
      achievements: completion,
    };
  }

  for (const entry of secondaryVisible) {
    const key = entry.workKey;
    if (gamesIndex[key]) continue;
    const source = entry.sources.includes('gog') ? 'gog' : 'epic';
    gamesIndex[key] = {
      appid: null,
      workKey: key,
      secondaryOnly: true,
      source,
      name: entry.name || null,
      hours: round1(entry.secondaryMinutes / 60),
      hours2w: 0,
      rtime: 0,
      lastPlayed: null,
      iconUrl: null,
      canonicalWorkKey: key,
      primaryAppid: null,
      isPrimary: true,
      editionCount: 1,
      canonicalHours: round1(entry.secondaryMinutes / 60),
      sources: [...entry.sources],
      storeIds: { ...entry.storeIds },
      hoursBySource: hoursBySourceOf(entry),
      hoursUnknown: Boolean(entry.hoursUnknown),
      hoursStatus: { ...entry.hoursStatus },
      type: 'game',
      year: entry.releaseYear == null ? null : entry.releaseYear,
      releaseYear: entry.releaseYear == null ? null : entry.releaseYear,
      genres: [...entry.genres],
      developers: [...entry.developers],
      publishers: [...entry.publishers],
      qid: entry.qid || null,
      franchise: entry.franchise ? { ...entry.franchise } : null,
      categories: [],
      dlcCount: null,
      metacritic: null,
      isFree: null,
      earlyAccess: null,
      metadataSources: [...entry.metadataSources],
      tags: [],
      reviewScore: null,
      reviewDesc: null,
      releaseYearWikidata: null,
      completion: null,
      achievements: null,
    };
  }

  return gamesIndex;
}

module.exports = { buildGamesIndex };
