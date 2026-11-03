'use strict';

/**
 * Per-work metadata helpers of the games payload: release year (own edition →
 * Wikidata P577 → base version), genres, canonical name, developers/publishers,
 * SteamSpy tags, review summary, DLC facts, mode flags.
 *
 * S1 «распил god-функции»: one factory over the input maps and the visible-work
 * lookup. The helpers are pure reads; they never mutate the work rows. The
 * builder keeps the same precedence chain as before the split.
 */

const {
  detailOf,
  spyOf,
  reviewsOf,
  linksOf,
  genreNamesOf,
  modeFlagsOf,
  releaseYearOf,
} = require('./documents');

function buildWorkMeta({ details, detailsBase, linkDocs, spyDocs, reviewDocs, unionOf, workByAppid }) {
  /**
   * B6: the base-version document of an owned row, or null. `links` carries
   * `baseAppid` (written by the Wikidata label bridge); the document itself
   * lives in `details-base/` because the owner does not own that card.
   */
  const baseDetailOfAppid = (appid) => {
    const link = linksOf(linkDocs, appid);
    if (!link || !link.baseAppid) return null;
    const doc = detailsBase[String(link.baseAppid)];
    return doc && doc.success ? doc : null;
  };
  const baseDetailOfWork = (work) => {
    for (const game of work.games) {
      const doc = baseDetailOfAppid(game.appid);
      if (doc) return doc;
    }
    return null;
  };
  /**
   * The year of one owned row from **its own** metadata, strongest first:
   *   1. store `appdetails.releaseYear` (the edition's own date);
   *   2. Wikidata `P577` of the SKU (`links.releaseYear`, M4-B).
   * Nothing else: a base-version year is not this row's year.
   */
  const ownYearOfAppid = (appid) => {
    const detailYear = releaseYearOf(detailOf(details, appid));
    if (detailYear != null) return detailYear;
    const link = linksOf(linkDocs, appid);
    if (link) {
      const linkYear = releaseYearOf({ releaseYear: link.releaseYear });
      if (linkYear != null) return linkYear;
    }
    return null;
  };
  /**
   * B6 last resort: the year of the **base version** — a regional SKU has no
   * item of its own, its work does (`links.baseReleaseYear`, then the base
   * card's `appdetails` in `details-base/`). Used only when nothing else knows
   * the year, so a re-release never moves a work that already has a year
   * (`Grand Theft Auto III` stays 2008, not the 2001 original).
   */
  const baseYearOfAppid = (appid) => {
    const link = linksOf(linkDocs, appid);
    if (link) {
      const baseYear = releaseYearOf({ releaseYear: link.baseReleaseYear });
      if (baseYear != null) return baseYear;
    }
    return releaseYearOf(baseDetailOfAppid(appid));
  };
  const workYear = (work) => {
    let year = null;
    for (const game of work.games) {
      const value = ownYearOfAppid(game.appid);
      if (value == null) continue;
      year = year == null ? value : Math.min(year, value);
    }
    if (year != null) return year;
    for (const game of work.games) {
      const value = baseYearOfAppid(game.appid);
      if (value == null) continue;
      year = year == null ? value : Math.min(year, value);
    }
    if (year != null) return year;
    // M6c: a work that exists only outside Steam has no `appdetails`; the
    // store catalogue's own release date is the honest year (GOG
    // `getFilteredProducts.releaseDate`, Epic catalog `releaseInfo.date`).
    const entry = work.union || unionOf(work);
    return entry && entry.releaseYear != null ? entry.releaseYear : null;
  };
  /**
   * Per-appid year for `gamesIndex`. A row with no year of its own inherits
   * the work year, so the frontend's canonical recount (`min` over editions)
   * lands on exactly the same number as `years[]`.
   */
  const yearOfAppid = (appid) => {
    const own = ownYearOfAppid(appid);
    if (own != null) return own;
    const work = workByAppid.get(appid);
    return work ? workYear(work) : baseYearOfAppid(appid);
  };
  const workGenres = (work) => {
    const out = [];
    for (const game of work.games) {
      for (const name of genreNamesOf(detailOf(details, game.appid))) {
        if (!out.includes(name)) out.push(name);
      }
    }
    if (!out.length) {
      // B6: a regional SKU has no store page — the work still has genres.
      for (const name of genreNamesOf(baseDetailOfWork(work))) {
        if (!out.includes(name)) out.push(name);
      }
    }
    if (!out.length) {
      // M6c: GOG/Epic catalogue genres when the snapshot carries them. A store
      // that has no genre field contributes nothing (honest gap, no guessing
      // from tags).
      const entry = work.union || unionOf(work);
      for (const name of (entry && Array.isArray(entry.genres) ? entry.genres : [])) {
        if (!out.includes(name)) out.push(name);
      }
    }
    return out;
  };
  /** B6: canonical (base-version) name of a work, when it differs. */
  const workCanonicalName = (work) => {
    const base = baseDetailOfWork(work);
    if (base && base.name) return String(base.name);
    for (const game of work.games) {
      const link = linksOf(linkDocs, game.appid);
      if (link && link.baseName) return String(link.baseName);
    }
    return null;
  };
  const workDevelopers = (work) => {
    for (const game of work.games) {
      const doc = detailOf(details, game.appid);
      if (doc && Array.isArray(doc.developers) && doc.developers.length) return [...doc.developers];
    }
    const base = baseDetailOfWork(work);
    if (base && Array.isArray(base.developers) && base.developers.length) {
      return [...base.developers];
    }
    // M6c: a secondary-only work takes the store catalogue's developers.
    const entry = work.union || unionOf(work);
    return entry && Array.isArray(entry.developers) ? [...entry.developers] : [];
  };
  const workPublishers = (work) => {
    for (const game of work.games) {
      const doc = detailOf(details, game.appid);
      if (doc && Array.isArray(doc.publishers) && doc.publishers.length) return [...doc.publishers];
    }
    const base = baseDetailOfWork(work);
    if (base && Array.isArray(base.publishers) && base.publishers.length) {
      return [...base.publishers];
    }
    const entry = work.union || unionOf(work);
    return entry && Array.isArray(entry.publishers) ? [...entry.publishers] : [];
  };
  const workSpy = (work) => {
    for (const game of work.games) {
      const doc = spyOf(spyDocs, game.appid);
      if (doc && Array.isArray(doc.tags) && doc.tags.length) return doc;
    }
    return null;
  };
  const workReview = (work) => {
    for (const game of work.games) {
      const doc = reviewsOf(reviewDocs, game.appid);
      if (doc && doc.score != null) return doc;
    }
    return null;
  };
  const workDlc = (work) => {
    let maxCount = 0;
    const ids = new Set();
    for (const game of work.games) {
      const doc = detailOf(details, game.appid);
      if (!doc) continue;
      if (Array.isArray(doc.dlc)) {
        for (const id of doc.dlc) ids.add(Number(id));
      }
      const count = Number(doc.dlcCount);
      if (Number.isFinite(count)) maxCount = Math.max(maxCount, count);
    }
    return {
      hasDetails: work.games.some((game) => detailOf(details, game.appid)),
      // Union of edition DLC appids; a document that only has `dlcCount`
      // (no array) still contributes its count.
      count: Math.max(ids.size, maxCount),
    };
  };
  const workModeFlags = (work) => {
    const flags = {};
    for (const game of work.games) {
      const doc = detailOf(details, game.appid);
      if (!doc) continue;
      const own = modeFlagsOf(doc);
      for (const key of Object.keys(own)) if (own[key]) flags[key] = true;
    }
    return flags;
  };
  const workHasFlag = (work, predicate) =>
    work.games.some((game) => {
      const doc = detailOf(details, game.appid);
      return Boolean(doc && predicate(doc));
    });

  return {
    baseDetailOfAppid,
    baseDetailOfWork,
    ownYearOfAppid,
    baseYearOfAppid,
    workYear,
    yearOfAppid,
    workGenres,
    workCanonicalName,
    workDevelopers,
    workPublishers,
    workSpy,
    workReview,
    workDlc,
    workModeFlags,
    workHasFlag,
  };
}

module.exports = { buildWorkMeta };
