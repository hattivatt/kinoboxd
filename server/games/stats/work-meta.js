'use strict';

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
    const entry = work.union || unionOf(work);
    return entry && entry.releaseYear != null ? entry.releaseYear : null;
  };
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
      for (const name of genreNamesOf(baseDetailOfWork(work))) {
        if (!out.includes(name)) out.push(name);
      }
    }
    if (!out.length) {
      const entry = work.union || unionOf(work);
      for (const name of (entry && Array.isArray(entry.genres) ? entry.genres : [])) {
        if (!out.includes(name)) out.push(name);
      }
    }
    return out;
  };
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
