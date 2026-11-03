'use strict';

/**
 * `booksIndex` (the drilldown map keyed by work id) and `unmatched` (works the
 * resolve chain could not link, for the «Не найдено» list).
 *
 * S2 «распил god-функции»: both are straight reads of the prepared work set.
 * `booksIndex` field order is the payload contract — the object is serialized
 * as-is, so conditional spreads keep the same positions they had inline.
 */

function buildBooksIndex(ctx) {
  const { works } = ctx;
  const booksIndex = {};
  for (const work of works.values()) {
    booksIndex[work.workId] = {
      workId: work.workId,
      ...(work.metadataWorkId && work.metadataWorkId !== work.workId
        ? { metadataWorkId: work.metadataWorkId }
        : {}),
      title: work.title,
      titleRu: work.titleRu,
      authors: work.authors,
      rating: work.rating10,
      finishedDate: work.finishedDate,
      sources: work.sources,
      genres: work.genres,
      series: work.series.map((entry) => entry.name),
      publisher: work.publisher,
      pages: work.pages,
      year: work.year,
      yearSource: work.yearSource || null,
      yearOverride: work.yearOverride,
      firstPublishedYear: work.firstPublishedYear,
      firstPublishedYearSource: work.firstPublishedYearSource || null,
      editionYear: work.editionYear,
      editionYearSource: work.editionYearSource || null,
      coverUrl: work.coverUrl,
      isbn13: work.isbn13,
      isbn10: work.isbn10,
      metadataSources: work.metadataSources,
      mangaComics: work.mangaComics,
      ...(work.mangaComicsSource ? { mangaComicsSource: work.mangaComicsSource } : {}),
      ...(typeof work.mangaComicsOverride === 'boolean'
        ? { mangaComicsOverride: work.mangaComicsOverride }
        : {}),
      ...(work.mangaComicsUpdatedAt ? { mangaComicsUpdatedAt: work.mangaComicsUpdatedAt } : {}),
      ...(work.mergedWorkIds && work.mergedWorkIds.length > 1
        ? { mergedWorkIds: work.mergedWorkIds }
        : {}),
      links: work.links,
      unresolved: work.unresolved,
      ...(work.collection ? { collection: work.collection } : {}),
    };
  }
  return booksIndex;
}

function buildUnmatched(ctx) {
  const { works } = ctx;
  return [...works.values()]
    .filter((work) => work.unresolved)
    .map((work) => ({
      workId: work.workId,
      bookId: String(work.workId).replace(/^ll:/, ''),
      title: work.title,
      authors: work.authors,
      rating: work.rating10,
      finishedDate: work.finishedDate,
    }))
    .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
}

module.exports = { buildBooksIndex, buildUnmatched };
