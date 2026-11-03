'use strict';

/**
 * `gamesIndex` of the games payload: a light `appid → entry` map (the
 * frontend reads it with `Object.values`) plus the secondary-only rows keyed
 * by their own `workKey` (`gog:<id>` / `epic:<id>`, `appid: null`).
 *
 * S1 «распил god-функции»: pure over the visible works and the cache maps.
 * Every owned appid stays in the index (the library table must not lose rows);
 * the edition fields are additive so the client can group without re-deriving
 * anything.
 */

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

  /* ---------------- per-appid index (keeps every edition) ---------------- */
  const gamesIndex = {};
  for (const game of visibleGames) {
    const appid = game.appid;
    if (appid == null) continue;
    const completion = completionByAppid.get(appid) || null;
    const doc = detailOf(details, game.appid);
    const baseDoc = baseDetailOfAppid(appid);
    // B6: the same year chain `workYear` uses, so the frontend's canonical
    // recount (min year over a work's editions) matches `years[]` exactly.
    const year = yearOfAppid(appid);
    const spyDoc = spyOf(spyDocs, appid);
    const reviewDoc = reviewsOf(reviewDocs, appid);
    const linkDoc = linksOf(linkDocs, appid);
    const work = workByAppid.get(appid) || null;
    // M7 artwork: the canonical (primary) edition's `header_image` wins so two
    // editions of one work paint the same cover; an unavailable primary doc
    // falls back to this edition's own document, never to a guessed URL.
    const primaryDoc = work ? detailOf(details, work.primary.appid) : null;
    // Vertical capsule: the canonical (primary) edition's resolve document
    // wins, exactly like `headerImage` above. Additive — absent until the
    // details phase has resolved this appid.
    const artDoc =
      artOf(art, work ? work.primary.appid : appid) || artOf(art, appid);
    const genres = genreNamesOf(doc);
    const developers = doc && Array.isArray(doc.developers) ? [...doc.developers] : [];
    const publishers = doc && Array.isArray(doc.publishers) ? [...doc.publishers] : [];
    gamesIndex[appid] = {
      appid,
      name: game.name || null,
      // Per-edition hours stay per-edition; the canonical total is additive.
      hours: minutesToHours(game.playtime_forever),
      hours2w: game.playtime_2weeks ? minutesToHours(game.playtime_2weeks) : 0,
      rtime: Number(game.rtime_last_played) || 0,
      lastPlayed: isoOfSeconds(game.rtime_last_played),
      iconUrl: iconUrlOf(appid, game.img_icon_url),
      // M7 (additive): the store header from `appdetails`, primary edition
      // first. `null` means «details not fetched yet» — the client then walks
      // the legacy CDN chain (header.jpg → capsule → icon → initials).
      headerImage: headerImageOf(primaryDoc) || headerImageOf(doc) || null,
      // Vertical poster + small-icon fallback (03.11.2026). Absent when the
      // appid has not been resolved yet; `verticalCapsuleKnown: false` means
      // Steam genuinely has no vertical capsule (kind 'none').
      ...artFieldsOf(artDoc),
      // M5-B: edition identity (additive; `hours` above is still this row's).
      canonicalWorkKey: work ? work.workKey : `steam:${appid}`,
      primaryAppid: work ? work.primary.appid : appid,
      isPrimary: Boolean(work && work.primary.appid === appid),
      editionCount: work ? work.games.length : 1,
      canonicalHours: work ? round1(work.hours) : minutesToHours(game.playtime_forever),
      // M6a/M6c: cross-store identity — only when a secondary library is
      // connected. `hoursBySource` is in **hours** (payload contract), the
      // union keeps minutes internally. A Steam-only payload stays additive
      // (no empty cross-store fields).
      ...(gogUnion && gogUnion.byAppid[String(appid)]
        ? {
            sources: gogUnion.byAppid[String(appid)].sources,
            storeIds: gogUnion.byAppid[String(appid)].storeIds,
            hoursBySource: hoursBySourceOf(gogUnion.byAppid[String(appid)]),
            ownedOn: gogUnion.byAppid[String(appid)].ownedOn,
            crossStoreMatchedBy: gogUnion.byAppid[String(appid)].matchedBy,
          }
        : {}),
      // M2 (appdetails) — null/[] while details are missing, never invented.
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
      // M4: the five heaviest SteamSpy tags of this game (the full list stays
      // in `cache-games/spy/<appid>.json`; the index is already the biggest
      // part of the payload) + the community review grade.
      tags: spyDoc && Array.isArray(spyDoc.tags)
        ? spyDoc.tags
            .slice()
            .sort((left, right) => (Number(right.weight) || 0) - (Number(left.weight) || 0))
            .slice(0, TAG_INDEX_LIMIT)
            .map((tag) => ({ name: tag.name, weight: Number(tag.weight) || 0 }))
        : [],
      reviewScore: reviewDoc && reviewDoc.score != null ? Number(reviewDoc.score) : null,
      reviewDesc: reviewDoc && reviewDoc.desc != null ? String(reviewDoc.desc) : null,
      // M4-B (additive): the Wikidata series this game belongs to and the P577
      // year. `null` means «Wikidata has not answered yet», not «no franchise»
      // — the dedicated `/api/games/franchises` route owns coverage/grouping.
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
      // B6 (additive): the base version of a regional SKU. `canonicalName` is
      // the work's own title (`Dishonored` for `Dishonored RHCP`); `name`
      // above stays the owned edition. Absent keys mean «no bridge», never
      // «unknown».
      ...(linkDoc && linkDoc.baseAppid
        ? { baseAppid: linkDoc.baseAppid, baseQid: linkDoc.baseQid || null }
        : {}),
      ...(baseDoc && baseDoc.name ? { canonicalName: String(baseDoc.name) } : {}),
      completion: completion ? completion.percent : null,
      achievements: completion,
    };
  }

  /* --------- M6c: secondary-only works in the client-side index ---------- */
  // The frontend recounts charts from `gamesIndex`; a secondary-only work has
  // no appid, so it is keyed by its own `workKey` (`gog:<id>` / `epic:<id>`)
  // with `appid: null`, `secondaryOnly: true` and the same field names. A
  // client that only knows appids skips these rows (they stay additive); a
  // client that renders the union counts exactly what the server counts.
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
      // M6 follow-up: Wikidata identity + P179 series of a secondary-only
      // work, so the union card can paint the same franchise chip a Steam
      // row does and the drilldown can match by `workKey`.
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
