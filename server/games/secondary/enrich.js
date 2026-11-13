'use strict';

const { needsCatalogCompletion, catalogMetaFlags, sanitizeEpicGenres } = require('./normalize');
const { readSecondaryLink, readSecondaryTitleLink } = require('./cache');
const { uniqueStringList, sameStringList } = require('./union');

function resolveWikidataEntry(data, options = {}) {
  const store = options.store;
  const slug = options.slug || data.slug;
  if (!store || !slug) return null;
  try {
    let entry = readSecondaryLink(store, slug, options);
    const titleEntry = readSecondaryTitleLink(store, slug, options);
    if (titleEntry && titleEntry.qid) {
      const slugQid = entry && entry.qid ? String(entry.qid) : null;
      const titleQid = String(titleEntry.qid);
      const slugHasDate = Boolean(entry && entry.releaseYear != null);
      if (!slugQid) {
        entry = { ...(entry || {}), ...titleEntry, matchedBy: 'title' };
      } else if (slugQid === titleQid) {
        if (!slugHasDate) {
          entry = { ...entry, ...titleEntry, matchedBy: 'title' };
        } else {
          const slugGenres = Array.isArray(entry.genres) ? entry.genres : [];
          if (!slugGenres.length) {
            const genres = sanitizeEpicGenres(
              Array.isArray(titleEntry.genres) ? titleEntry.genres : []
            );
            if (genres.length) entry = { ...entry, genres };
          }
        }
      }
    }
    return entry;
  } catch (err) {
    return null;
  }
}

function applyWikidataYear(data, options = {}) {
  if (!data || data.releaseYear != null) return data;
  const entry = resolveWikidataEntry(data, options);
  if (
    !entry ||
    !entry.qid ||
    entry.releaseDateSource !== 'wikidata' ||
    entry.releaseYear == null
  ) {
    return data;
  }
  return {
    ...data,
    releaseYear: entry.releaseYear,
    releaseDate: entry.releaseDate || null,
    releaseDateSource: 'wikidata',
    releaseYearMatchedBy: entry.matchedBy || 'slug',
  };
}

function applyWikidataFacts(data, options = {}) {
  if (!data) return data;
  const entry = resolveWikidataEntry(data, options);
  if (!entry || !entry.qid) return data;
  let next = data;
  if (
    next.releaseYear == null &&
    entry.releaseDateSource === 'wikidata' &&
    entry.releaseYear != null
  ) {
    next = {
      ...next,
      releaseYear: entry.releaseYear,
      releaseDate: entry.releaseDate || null,
      releaseDateSource: 'wikidata',
      releaseYearMatchedBy: entry.matchedBy || 'slug',
    };
  }
  const hasGenres = Array.isArray(next.genres) && next.genres.length > 0;
  if (!hasGenres && next.source === 'epic') {
    const genres = sanitizeEpicGenres(Array.isArray(entry.genres) ? entry.genres : []);
    if (genres.length) {
      next = { ...next, genres, genresSource: 'wikidata' };
    }
  }
  return next;
}

function detailKeyForEntry(entry) {
  if (entry && entry.gog && entry.gog.gogGameId) return `gog:${entry.gog.gogGameId}`;
  if (entry && entry.epic && entry.epic.slug) return `epic:${entry.epic.slug}`;
  return null;
}

function detailForEntry(entry, index) {
  const keys = [];
  if (entry && entry.gog && entry.gog.gogGameId) keys.push(`gog:${entry.gog.gogGameId}`);
  if (entry && entry.epic && entry.epic.slug) keys.push(`epic:${entry.epic.slug}`);
  for (const key of keys) {
    if (index[key]) return index[key];
  }
  return null;
}

function enrichUnionWithDetails(union, index) {
  if (!union || !Array.isArray(union.works) || !index) return 0;
  let touched = 0;
  for (const entry of union.works) {
    const detail = detailForEntry(entry, index);
    if (!detail) continue;
    let changed = false;
    const storeSource = detail.source === 'epic' ? 'epic-store' : 'gog-store';
    const weakDevelopers =
      entry.developersSource === 'epic-catalog' || entry.developersSource === 'gog-catalog';
    const weakPublishers =
      entry.publishersSource === 'epic-catalog' || entry.publishersSource === 'gog-catalog';
    const libraryGenreSource =
      entry.genresSource === 'gog-library' || entry.genresSource === 'epic-library';
    if (
      detail.genres &&
      detail.genres.length &&
      (!(entry.genres && entry.genres.length) || libraryGenreSource)
    ) {
      entry.genres = [...detail.genres];
      entry.genresSource =
        detail.genresSource || (detail.source === 'epic' ? 'epic-store' : 'gog-store');
      changed = true;
    }
    const libraryYearSource =
      entry.releaseYearSource === 'gog-library' || entry.releaseYearSource === 'epic-library';
    if (
      detail.releaseYear != null &&
      (entry.releaseYear == null || libraryYearSource)
    ) {
      entry.releaseYear = detail.releaseYear;
      entry.releaseYearSource = detail.releaseDateSource || 'store';
      changed = true;
    }
    if (detail.releaseDate && (entry.releaseDate == null || libraryYearSource)) {
      entry.releaseDate = detail.releaseDate;
      changed = true;
    }
    if (detail.verticalCover && !entry.verticalCover) {
      entry.verticalCover = detail.verticalCover;
      changed = true;
    }
    if (detail.image && !entry.image) {
      entry.image = detail.image;
      changed = true;
    }
    if (detail.developers && detail.developers.length) {
      const nextDevelopers = uniqueStringList(detail.developers);
      if (!(entry.developers && entry.developers.length) || weakDevelopers) {
        if (!sameStringList(entry.developers, nextDevelopers)) {
          entry.developers = nextDevelopers;
          changed = true;
        }
        if (entry.developersSource !== storeSource) {
          entry.developersSource = storeSource;
          changed = true;
        }
      }
    }
    if (detail.publishers && detail.publishers.length) {
      const nextPublishers = uniqueStringList(detail.publishers);
      if (!(entry.publishers && entry.publishers.length) || weakPublishers) {
        if (!sameStringList(entry.publishers, nextPublishers)) {
          entry.publishers = nextPublishers;
          changed = true;
        }
        if (entry.publishersSource !== storeSource) {
          entry.publishersSource = storeSource;
          changed = true;
        }
      }
    }
    const metadataSource = storeSource;
    if (!Array.isArray(entry.metadataSources)) entry.metadataSources = [];
    if (!entry.metadataSources.includes(metadataSource)) {
      entry.metadataSources.push(metadataSource);
      changed = true;
    }
    const flags = catalogMetaFlags(detail);
    entry.secondaryDetails = {
      source: detail.source,
      id: detail.id,
      releaseDateSource: detail.releaseDateSource || null,
      fetchedAt: detail.fetchedAt || null,
      catalogPending: detail.catalogPending === true,
      needsCatalog:
        Boolean(entry.epic && entry.epic.catalogItemId) &&
        needsCatalogCompletion(detail),
      yearHas: flags.yearHas,
      genresOk: flags.genresOk,
      metaStatus: flags.metaStatus,
    };
    if (changed) touched++;
  }
  return touched;
}

module.exports = {
  applyWikidataYear,
  applyWikidataFacts,
  detailKeyForEntry,
  enrichUnionWithDetails,
};
