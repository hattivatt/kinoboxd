'use strict';

const hardcover = require('../hardcover');
const editions = require('../hardcover-editions');
const { detectManga, collectMangaTexts } = require('./manga');
const { seriesEntriesOf } = require('./series-name');
const { normalizeIsbn } = require('../normalize');

const NAME = 'hardcover';

function normalizeDetails(details, editionId, options = {}) {
  if (!details) return null;
  const seriesAll = seriesEntriesOf(details.series);
  const series = seriesAll.length
    ? { name: seriesAll[0].name, position: seriesAll[0].position }
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
    firstPublishedYear:
      details.firstPublishedYear != null
        ? Number(details.firstPublishedYear)
        : options.requireWorkClaim === true || details.publicationYear == null
        ? null
        : Number(details.publicationYear),
    publisher: details.publisher || null,
    series,
    seriesAll,
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
  return normalizeDetails(entry.details, entry.editionId, {
    requireWorkClaim: options.requireWorkClaim === true,
  });
}

module.exports = {
  NAME,
  getWork,
  normalizeDetails,
};
