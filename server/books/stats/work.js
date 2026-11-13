'use strict';

const bookCache = require('../book-cache');
const { getSeriesOverrides, findSeriesOverride } = require('../series-overrides');
const { filterBlacklistedSeries } = require('../series-blacklist');
const { surnameOf, strictTitleKey } = require('../normalize');
const { detectManga } = require('../providers/manga');
const { FILE_METADATA_SOURCE } = require('./constants');
const {
  nameKeyOf,
  metadataSourcesOf,
  mergeSeriesLists,
  fileMetadataOf,
  filterDetailsSeries,
} = require('./series');
const { resolveWorkYear, yearOverrideKeysOf, findYearOverride } = require('./years');

function detailsAuthors(details) {
  if (!details || !Array.isArray(details.authors)) return [];
  const names = [];
  for (const author of details.authors) {
    const name = author && typeof author === 'object' ? author.name : author;
    if (name && !names.includes(String(name))) names.push(String(name));
  }
  return names;
}

function mergeGenreLists(primary, extra) {
  const out = [];
  const seen = new Set();
  for (const list of [primary, extra]) {
    for (const name of Array.isArray(list) ? list : []) {
      const clean = String(name == null ? '' : name).trim();
      const key = nameKeyOf(clean);
      if (!clean || !key || seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
    }
  }
  return out;
}

function mangaOfDetails(details, genres, series, publisher, fileMeta) {
  const sources = [{
    genres,
    tags: details && Array.isArray(details.tags) ? details.tags : [],
    texts: details && Array.isArray(details.mangaTexts) ? details.mangaTexts : [],
    series,
    publisher,
  }];
  if (fileMeta && fileMeta.present) {
    sources.push({
      genres: fileMeta.genres,
      series: fileMeta.series.map((entry) => entry.name),
      publisher: fileMeta.publisher,
    });
  }

  let clean = false;
  for (const input of sources) {
    const detected = detectManga(input);
    if (detected === true) return true;
    if (detected === false) clean = true;
  }
  if (details && details.mangaComics === true) return true;
  if (clean) return false;
  return details && typeof details.mangaComics === 'boolean' ? details.mangaComics : null;
}

function workMetadata(workId, events, options = {}) {
  const hcEvents = events.filter((event) => event.source === 'hardcover');
  const llEvents = events.filter((event) => event.source === 'livelib');
  const metadataWorkId = (events.find((event) => event.metadataWorkId) || {}).metadataWorkId || workId;
  const details = bookCache.getWorkDetails(metadataWorkId);
  const fileMeta = fileMetadataOf(events);

  const latest = (list, field) =>
    list.reduce((best, event) => laterDate(best, event[field]), null);

  const hcWithRating = [...hcEvents]
    .filter((event) => event.rating10 != null)
    .sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')))[0];
  const llWithRating = [...llEvents]
    .filter((event) => event.rating10 != null)
    .sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')))[0];
  const displayEvent = hcWithRating || hcEvents[0] || llWithRating || llEvents[0] || null;

  const detailTitle = details && details.title ? details.title : null;
  const hcTitle = detailTitle || (hcEvents[0] && hcEvents[0].title) || null;
  const llTitle = (llEvents.find((event) => event.title) || {}).title || null;
  const collection = (events.find((event) => event && event.collectionParent) || {}).collectionParent
    || null;

  const authors = [];
  const detailAuthors = detailsAuthors(details);
  if (detailAuthors.length) {
    for (const name of detailAuthors) authors.push(name);
  } else {
    for (const event of hcEvents.concat(llEvents)) {
      for (const name of event.authors || []) {
        if (name && !authors.includes(name)) authors.push(name);
      }
    }
  }

  const publisher =
    (details && details.publisher) ||
    (displayEvent && displayEvent.edition && displayEvent.edition.publisher) ||
    fileMeta.publisher ||
    null;
  const overrideKeys = yearOverrideKeysOf(workId, metadataWorkId, events);
  const yearOverride = findYearOverride(options.yearOverrides, overrideKeys);
  const yearInfo = resolveWorkYear(details, displayEvent, fileMeta, yearOverride);
  const year = yearInfo.year;
  const editionYear = yearInfo.editionYear;
  const editionYearSource = yearInfo.editionYearSource;
  const firstPublishedYear = yearInfo.firstPublishedYear;
  const firstPublishedYearSource = yearInfo.firstPublishedYearSource;
  const firstPublishedYearPrecision = yearInfo.firstPublishedYearPrecision;
  const firstPublishedYearKind = yearInfo.firstPublishedYearKind;
  const pages =
    details && details.pages != null && Number.isFinite(Number(details.pages)) && Number(details.pages) > 0
      ? Number(details.pages)
      : null;
  const genres = mergeGenreLists(
    details && Array.isArray(details.genres) ? details.genres : [],
    fileMeta.genres
  );
  const mergedSeries = mergeSeriesLists(
    filterDetailsSeries(details, fileMeta.series.map((entry) => entry.name)),
    fileMeta.series
  );
  const seriesFilter = filterBlacklistedSeries(mergedSeries);
  const seriesOverride = findSeriesOverride(getSeriesOverrides(), overrideKeys);
  const series = seriesOverride
    ? seriesOverride.series.map((entry) => ({
        hcId: null,
        name: entry.name,
        position: entry.position == null ? null : entry.position,
      }))
    : seriesFilter.list;
  const coverUrl =
    (details && details.coverUrl) ||
    (displayEvent && displayEvent.coverUrl) ||
    null;

  const finishDates = events.map((event) => event.finishedAt).filter(Boolean);
  const finishedDate = finishDates.length
    ? finishDates.sort()[finishDates.length - 1]
    : null;

  const links = {};
  const llSourceId = String(metadataWorkId).startsWith('ll:') ? String(metadataWorkId).slice(3) : null;
  const llBookId = (events.find((event) => event.sourceBookId) || {}).sourceBookId || llSourceId;
  if (llBookId && /^\d+$/.test(String(llBookId))) {
    links.livelib = `https://www.livelib.ru/book/${llBookId}`;
  }
  if (String(metadataWorkId).startsWith('hc:')) {
    const workLink = bookCache.getWorkLink(metadataWorkId);
    const llId = workLink && Array.isArray(workLink.livelib)
      ? workLink.livelib.map(String).find(Boolean)
      : null;
    if (llId && !links.livelib) links.livelib = `https://www.livelib.ru/book/${llId}`;
  }
  if (details) {
    const providerLinks = Array.isArray(details.sources) ? details.sources : [];
    for (const entry of providerLinks) {
      if (!entry || !entry.url) continue;
      const key = entry.source === 'livelib-card' ? 'livelib' : entry.source;
      if (!links[key]) links[key] = entry.url;
    }
    if (details.slug && !links.hardcover) {
      links.hardcover = `https://hardcover.app/books/${details.slug}`;
    }
  }

  const metadataSources = metadataSourcesOf(details);
  if (fileMeta.present && !metadataSources.includes(FILE_METADATA_SOURCE)) {
    metadataSources.push(FILE_METADATA_SOURCE);
  }

  return {
    workId,
    metadataWorkId,
    title: hcTitle || llTitle,
    titleRu: hcTitle && llTitle && hcTitle !== llTitle ? llTitle : hcTitle ? hcTitle : llTitle,
    authors,
    genres,
    series,
    seriesTagsFiltered: seriesFilter.removed,
    publisher,
    year: year == null ? null : Number(year),
    yearSource: yearInfo.yearSource,
    yearOverride: yearInfo.yearOverride,
    firstPublishedYear,
    firstPublishedYearSource,
    firstPublishedYearPrecision,
    firstPublishedYearKind,
    editionYear,
    editionYearSource,
    pages,
    coverUrl,
    isbn13: (details && details.isbn13) || fileMeta.isbn13 || null,
    isbn10: (details && details.isbn10) || fileMeta.isbn10 || null,
    language: (details && details.editionLanguage) || fileMeta.language || null,
    metadataSources,
    mangaComics: mangaOfDetails(details, genres, series, publisher, fileMeta),
    details,
    links,
    finishedDate,
    collection,
    rating10: hcWithRating ? hcWithRating.rating10 : llEvents.find((e) => e.rating10 != null)?.rating10 ?? null,
    sources: [...new Set(events.map((event) => event.source))].sort(),
    unresolved: !details && !fileMeta.coverage,
  };
}

function canonicalKeyOf(work) {
  const title = strictTitleKey(work.title || work.titleRu || '');
  const authors = [...new Set((work.authors || []).map((name) => surnameOf(name)).filter(Boolean))].sort();
  if (!title || authors.length === 0) return null;
  return `${title}|${authors.join(',')}`;
}

module.exports = {
  workMetadata,
  detailsAuthors,
  mergeGenreLists,
  mangaOfDetails,
  canonicalKeyOf,
};
