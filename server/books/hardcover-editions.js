'use strict';

/**
 * Hardcover ISBN -> work lookup, shared by the resolve job (batched) and the
 * `hardcover` provider (single ISBN). Extracted from resolve.js so providers
 * can reuse it without a require-cycle.
 */

const hardcover = require('./hardcover');
const { normalizeIsbn, isbn10Of } = require('./normalize');

const ISBN_BATCH_SIZE = 100;

const ISBN_QUERY = `
query IsbnBatch($isbns: [String!]!) {
  editions(
    where: { _or: [{ isbn_13: { _in: $isbns } }, { isbn_10: { _in: $isbns } }] }
    order_by: { id: asc }
    limit: 500
  ) {
    id
    book_id
    isbn_13
    isbn_10
    language_id
    pages
    publisher_id
    release_year
    release_date
    book {
      id
      title
      slug
      pages
      release_date
      release_year
      rating
      ratings_count
      cached_image
      contributions { author { id name } contribution }
      book_series { position series { id name } }
      taggings(limit: 30) { tag { id tag slug tag_category_id } }
    }
    publisher { id name }
    language { id language }
  }
}`;

/**
 * Resolve a set of normalized ISBNs to hardcover works.
 * Returns { byIsbn: Map<isbn, {details, editionId}>, works, queries, requests }.
 */
async function lookupIsbns(isbns, options = {}) {
  const byIsbn = new Map();
  const works = new Map();
  const queries = [];
  let requestCount = 0;
  const unique = [...new Set((Array.isArray(isbns) ? isbns : []).map(normalizeIsbn).filter(Boolean))];
  for (let i = 0; i < unique.length; i += ISBN_BATCH_SIZE) {
    const batch = unique.slice(i, i + ISBN_BATCH_SIZE);
    const isbn10s = batch.map(isbn10Of).filter(Boolean);
    const queryValues = [...new Set([...batch, ...isbn10s])];
    requestCount++;
    if (typeof options.onProgress === 'function') {
      options.onProgress({ batch: requestCount, queries: Math.ceil(unique.length / ISBN_BATCH_SIZE) });
    }
    const data = await hardcover.graphql(
      ISBN_QUERY,
      { isbns: queryValues },
      { label: `isbn batch ${requestCount}` }
    );
    const editions = Array.isArray(data.editions) ? data.editions : [];
    for (const edition of editions) {
      if (!edition || !edition.book) continue;
      const details = hardcover.detailsFromBook(edition.book, edition);
      if (!details) continue;
      works.set(details.hcWorkId, details);
      const keys = new Set();
      for (const raw of [edition.isbn_13, edition.isbn_10]) {
        const normalized = normalizeIsbn(raw);
        if (normalized) keys.add(normalized);
      }
      for (const key of keys) {
        if (batch.includes(key)) {
          byIsbn.set(key, { details, editionId: edition.id ? Number(edition.id) : null });
        }
      }
    }
    queries.push({ batch: batch.length, editions: editions.length });
    console.log(
      `[resolve] isbn batch ${requestCount}: ${batch.length} isbn(s) -> ${editions.length} edition(s)`
    );
  }
  return { byIsbn, works, queries, requests: requestCount };
}

module.exports = {
  ISBN_BATCH_SIZE,
  ISBN_QUERY,
  lookupIsbns,
};
