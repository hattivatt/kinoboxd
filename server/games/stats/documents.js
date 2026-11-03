'use strict';

/**
 * Cache-document accessors of the games payload: one place that knows how an
 * `appdetails`, SteamSpy, review-summary or Wikidata-link document is keyed
 * and when it counts as answered.
 *
 * S1 «распил god-функции»: pure readers over the maps `buildGamesStats` gets
 * as input; no disk access, no network.
 */

const { MODE_TESTS } = require('./constants');

function detailOf(details, appid) {
  if (!details || typeof details !== 'object') return null;
  const doc = details[String(appid)];
  return doc && doc.success ? doc : null;
}

/** A successful SteamSpy document (tags/owners/ccu) for one appid. */
function spyOf(spyDocs, appid) {
  if (!spyDocs || typeof spyDocs !== 'object') return null;
  const doc = spyDocs[String(appid)];
  return doc && doc.success ? doc : null;
}

/** A successful review summary for one appid (score may still be null). */
function reviewsOf(reviewDocs, appid) {
  if (!reviewDocs || typeof reviewDocs !== 'object') return null;
  const doc = reviewDocs[String(appid)];
  return doc && doc.success ? doc : null;
}

/**
 * Wikidata links view of one appid (`franchise.readLinks`), or null when the
 * WD pass has not written `cache-games/links/<appid>.json` yet.
 */
function linksOf(linkDocs, appid) {
  if (!linkDocs || typeof linkDocs !== 'object') return null;
  const doc = linkDocs[String(appid)];
  return doc && typeof doc === 'object' ? doc : null;
}

function genreNamesOf(doc) {
  return (doc && Array.isArray(doc.genres) ? doc.genres : [])
    .map((entry) => (entry && entry.description ? String(entry.description) : null))
    .filter(Boolean);
}

function categoryNamesOf(doc) {
  return (doc && Array.isArray(doc.categories) ? doc.categories : [])
    .map((entry) => (entry && entry.description ? String(entry.description) : null))
    .filter(Boolean);
}

function modeFlagsOf(doc) {
  const flags = {};
  const categories = categoryNamesOf(doc);
  for (const [key, test] of Object.entries(MODE_TESTS)) {
    flags[key] = categories.some((name) => test.test(name));
  }
  return flags;
}

function releaseYearOf(doc) {
  if (!doc) return null;
  const year = Number(doc.releaseYear);
  return Number.isInteger(year) && year >= 1970 && year <= 2100 ? year : null;
}

module.exports = {
  detailOf,
  spyOf,
  reviewsOf,
  linksOf,
  genreNamesOf,
  categoryNamesOf,
  modeFlagsOf,
  releaseYearOf,
};
