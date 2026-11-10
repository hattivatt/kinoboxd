'use strict';

const { needsCatalogCompletion, catalogMetaFlags, sanitizeEpicGenres } = require('./normalize');
const { readSecondaryLink, readSecondaryTitleLink } = require('./cache');
const { uniqueStringList, sameStringList } = require('./union');

/**
 * Last-resort release year for a GOG/Epic detail whose store — and, for Epic,
 * catalog — answer carried no date (Alan Wake 2: `genresOk true`,
 * `yearHas false`). The value is the `P577` of the item the store slug resolves
 * to in the identity bridge (`cache-games/links/secondary.json`, written by
 * `fetchSecondaryLinks()` in this module); this function only **reads** that
 * cache and never calls WDQS.
 *
 * Rules, all hard:
 *   - only an **empty** `releaseYear` is filled — a store/catalog year is never
 *     replaced;
 *   - `releaseDate` is taken only for a **day**-precision statement, so a
 *     month/year precision cannot become a fake day;
 *   - provenance is `releaseDateSource: 'wikidata'` (the union exposes it as
 *     `releaseYearSource`); the store's own `storeReleaseDate` is untouched;
 *   - no cached entry / no QID / no P577 → the document is returned unchanged,
 *     i.e. the work stays honestly `partial` (no invented year, no extra
 *     request loop).
 *
 * Since 03.11.2026 the same entry also carries the title map's `P136` line for
 * **Epic** works: when the slug entry and the title entry name the same QID and
 * the slug entry has no genres, the title entry's (sanitized) genres are merged
 * in. A date on the slug entry is not a reason to drop them — the genre axis
 * and the year axis are independent facts of one item.
 */
function resolveWikidataEntry(data, options = {}) {
  const store = options.store;
  const slug = options.slug || data.slug;
  if (!store || !slug) return null;
  try {
    let entry = readSecondaryLink(store, slug, options);
    // A slug entry is the trustworthy `P6278`/`P2725` identity. The title map
    // is a **facts-only** fallback: it is used when there is no slug entry at
    // all (Alan Wake 2), or when both name the same QID and the slug entry has
    // no date. Two different QIDs are never mixed.
    const titleEntry = readSecondaryTitleLink(store, slug, options);
    if (titleEntry && titleEntry.qid) {
      const slugQid = entry && entry.qid ? String(entry.qid) : null;
      const titleQid = String(titleEntry.qid);
      const slugHasDate = Boolean(entry && entry.releaseYear != null);
      if (!slugQid) {
        // No slug identity at all: the title answer is the only evidence.
        entry = { ...(entry || {}), ...titleEntry, matchedBy: 'title' };
      } else if (slugQid === titleQid) {
        if (!slugHasDate) {
          entry = { ...entry, ...titleEntry, matchedBy: 'title' };
        } else {
          // The slug entry names the item, the title answer is a *fact* of the
          // same item: P136 is a metadata line, never an identity. A date on
          // the slug entry says nothing about the genre axis (Alan Wake 2: the
          // slug entry carries `P577` and no genres, the title entry carries
          // the genres), so an empty list is filled here — identity (`qid`),
          // `matchedBy`, `confidence` and every existing value stay as they
          // are.
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

/** Year-only view of the bridged Wikidata facts (kept for GOG and old callers). */
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
    // Honest provenance: a title match is weaker than a store-slug match.
    releaseYearMatchedBy: entry.matchedBy || 'slug',
  };
}

/**
 * Both facts a bridged Wikidata item can supply for a store-exclusive detail:
 * the release year (`P577`, only when empty) and the genre line (`P136`, only
 * when empty). Store/catalog values are never replaced; an Epic document
 * without a genre line (Alan Wake 2) receives `genresSource: 'wikidata'`.
 * Genres stay in the detail document — they are not written into the identity
 * bridge entry, so a title match can never become a P6278/P2725 link.
 */
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

/* ------------------------------------------------------------------ */
/* union enrichment                                                    */
/* ------------------------------------------------------------------ */

function detailKeyForEntry(entry) {
  if (entry && entry.gog && entry.gog.gogGameId) return `gog:${entry.gog.gogGameId}`;
  if (entry && entry.epic && entry.epic.slug) return `epic:${entry.epic.slug}`;
  return null;
}

/**
 * The detail document of one union entry: the priority store first (GOG, then
 * Epic), the other store only when the priority store has **no** document.
 * A work owned on both stores therefore still receives its product page facts
 * instead of silently keeping the library-snapshot fallback.
 */
function detailForEntry(entry, index) {
  const keys = [];
  if (entry && entry.gog && entry.gog.gogGameId) keys.push(`gog:${entry.gog.gogGameId}`);
  if (entry && entry.epic && entry.epic.slug) keys.push(`epic:${entry.epic.slug}`);
  for (const key of keys) {
    if (index[key]) return index[key];
  }
  return null;
}

/**
 * Fill the union entries from the detail cache. **Additive and never
 * destructive** for the fields that only a Steam card can own: a Steam-derived
 * value always wins (Steam `details` are read first by `stats.js`), and only an
 * empty field is filled. Two documented exceptions, both about provenance:
 *
 *   1. a release year that came from a **store snapshot** (`gog-library` /
 *      `epic-library`) — those dates are the store listing date, so the
 *      product's own `globalReleaseDate` replaces them;
 *   2. `developers`/`publishers` that came from a **weak fallback** — the
 *      library snapshot (`gog-catalog`) or the Epic catalog bulk
 *      (`epic-catalog`). Epic's catalog `developer` field is the
 *      seller/distributor (Alan Wake 2: «Epic Games Publishing»), not the
 *      studio, so the product page (CMS `meta.developer` →
 *      `about.developerAttribution`, `server/games/secondary/normalize.js`)
 *      is the authority and **replaces** such a value (04.11.2026).
 *
 * Company lists are never *merged* across stores: the union keeps one list per
 * work, and the detail document of the priority store (`detailForEntry`: GOG
 * first, then Epic — the same order genres/year use) is the one that wins.
 * Merging GOG and Epic lists would re-introduce the very bug this fixes (an
 * Epic catalogue seller glued to a GOG studio). An entry whose
 * `developersSource` is unknown or Steam-derived is left untouched, and an
 * empty detail list changes nothing (the fallback stays, honest gap).
 *
 * Returns the number of entries that received at least one field.
 */
function enrichUnionWithDetails(union, index) {
  if (!union || !Array.isArray(union.works) || !index) return 0;
  let touched = 0;
  for (const entry of union.works) {
    const detail = detailForEntry(entry, index);
    if (!detail) continue;
    let changed = false;
    // The detail's own provenance label: `gog-store`/`epic-store` is what
    // `metadataSources` already records for this document.
    const storeSource = detail.source === 'epic' ? 'epic-store' : 'gog-store';
    const weakDevelopers =
      entry.developersSource === 'epic-catalog' || entry.developersSource === 'gog-catalog';
    const weakPublishers =
      entry.publishersSource === 'epic-catalog' || entry.publishersSource === 'gog-catalog';
    // The library snapshot's tag slugs (`gog-library`) are a fallback: the
    // product page's own genre line replaces them. A Steam-derived list (no
    // `genresSource`) is never touched.
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
      // Fill an empty list, or replace a weak fallback (`epic-catalog` /
      // `gog-catalog`). A Steam-derived list has no marker and is never touched.
      if (!(entry.developers && entry.developers.length) || weakDevelopers) {
        if (!sameStringList(entry.developers, nextDevelopers)) {
          entry.developers = nextDevelopers;
          changed = true;
        }
        // The value may be identical (the catalogue seller *is* the publisher)
        // while the provenance is not: record the store that confirmed it.
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
      // The catalog step was deferred (owner token expired/blocked): the
      // poster is real, but year/genres are still pending — coverage must not
      // count this as resolved.
      catalogPending: detail.catalogPending === true,
      // A pre-catalog detail (poster only, no `catalogChecked`) is retried once
      // so the deployed fix heals an already written document.
      needsCatalog:
        Boolean(entry.epic && entry.epic.catalogItemId) &&
        needsCatalogCompletion(detail),
      // What the document actually contains: `resolved` counts `complete`
      // (year **and** genres), never the mere existence of a file. Computed
      // from the (read-sanitized) document, so a stale bucket genre such as
      // «Public» cannot keep a work «complete» on the strength of a persisted
      // marker written before the filter existed.
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
