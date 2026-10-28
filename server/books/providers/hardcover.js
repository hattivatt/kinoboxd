'use strict';

/**
 * Hardcover provider: a thin normaliser over the existing ISBN lookup
 * (`hardcover-editions.lookupIsbns`, the same query the resolve job batches).
 * Hardcover remains the canonical work namespace (`hc:{id}`); the chain only
 * asks it for ISBNs, the title/author stage reuses the local details corpus.
 */

const hardcover = require('../hardcover');
const editions = require('../hardcover-editions');
const { detectManga, collectMangaTexts } = require('./manga');
const { normalizeIsbn } = require('../normalize');

const NAME = 'hardcover';

/** Normalise a details document (journal/cache schema 1 or 2) to a provider result. */
function normalizeDetails(details, editionId) {
  if (!details) return null;
  const series = Array.isArray(details.series) && details.series.length
    ? { name: details.series[0].name || null, position: details.series[0].position ?? null }
    : null;
  const genres = Array.isArray(details.genres) ? details.genres.filter(Boolean) : [];
  const tags = Array.isArray(details.tags) ? details.tags.filter(Boolean) : [];
  const authors = (Array.isArray(details.authors) ? details.authors : [])
    .map((author) => {
      if (author && typeof author === 'object') {
        return {
          name: author.name,
          ...(author.hcId != null ? { hcId: author.hcId } : {}),
        };
      }
      return { name: author };
    })
    .filter((author) => author.name);
  const sourceId = details.hcWorkId != null ? String(details.hcWorkId) : null;
  if (!sourceId) return null;
  return {
    source: NAME,
    sourceId,
    workId: `hc:${sourceId}`,
    title: details.title || null,
    authors,
    year: details.publicationYear == null ? null : Number(details.publicationYear),
    // Hardcover names the work (`books`), so `book.release_year` is the first
    // publication (detailsFromBook stores it as `firstPublishedYear`). Legacy
    // schema-1 documents have no such field; their `publicationYear` also
    // prefers `book.release_year` over the edition, so it is the same value —
    // used as a fallback only until the document is refreshed.
    firstPublishedYear:
      details.firstPublishedYear != null
        ? Number(details.firstPublishedYear)
        : details.publicationYear == null
        ? null
        : Number(details.publicationYear),
    publisher: details.publisher || null,
    series,
    genres,
    pages: Number.isFinite(Number(details.pages)) ? Number(details.pages) : null,
    isbn13: normalizeIsbn(details.isbn13),
    isbn10: details.isbn10 || null,
    cover: details.coverUrl || null,
    links: {
      pageUrl: details.slug ? `https://hardcover.app/books/${details.slug}` : null,
    },
    language: details.editionLanguage || null,
    confidence: 0.99,
    match: { method: 'isbn', titleSim: 1, exact: true, authorHit: null },
    mangaComics: detectManga({
      genres,
      tags,
      texts: details.mangaTexts,
      series: details.series || [],
      publisher: details.publisher || null,
    }),
    mangaTexts: collectMangaTexts({
      genres,
      tags,
      texts: details.mangaTexts,
      series: details.series || [],
      publisher: details.publisher || null,
    }),
    hardcover: {
      hcWorkId: Number(details.hcWorkId),
      hcEditionId: editionId == null ? details.hcEditionId ?? null : editionId,
      slug: details.slug || null,
      rating: details.rating == null ? null : Number(details.rating),
      ratingsCount: details.ratingsCount == null ? null : Number(details.ratingsCount),
    },
  };
}

/**
 * @param {{isbn13?:string, isbn10?:string}} input
 * @returns {Promise<object|null>} normalized work
 */
async function getWork(input = {}, options = {}) {
  const isbn = normalizeIsbn(input.isbn13) || normalizeIsbn(input.isbn10);
  if (!isbn) return null;
  const lookup = options.lookupIsbns || editions.lookupIsbns;
  const found = await lookup([isbn], {
    onProgress: options.onProgress,
  });
  if (!found || !(found.byIsbn instanceof Map)) return null;
  const entry = found.byIsbn.get(isbn) || [...found.byIsbn.values()][0];
  if (!entry || !entry.details) return null;
  return normalizeDetails(entry.details, entry.editionId);
}

module.exports = {
  NAME,
  getWork,
  normalizeDetails,
};
