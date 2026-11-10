'use strict';

const { normalizeIsbn, isbn10Of } = require('../normalize');

const CHAIN_NAMES = ['hardcover', 'litres', 'googlebooks', 'openlibrary', 'livelib-card'];
const CYRILLIC_TITLE = /[а-яё]/i;

function createChainReport(providerList) {
  const report = {};
  for (const provider of providerList) {
    report[provider.NAME] = {
      name: provider.NAME,
      calls: 0,
      hits: 0,
      errors: 0,
      skipped: 0,
      methods: {},
      lastError: null,
    };
  }
  return report;
}

/**
 * ISBN of an event, whatever shape the source used.
 *
 * A scraped LiveLib event carries `edition.isbn` (fetched from the card); a
 * `livelib-backup` file row carries the export columns `edition.isbn13` /
 * `edition.isbn10` as well. The ISBN is a first-class resolve input — a file
 * import can skip the LiveLib card round-trip entirely and go straight to the
 * batched Hardcover lookup — so every shape is read here.
 */
function isbnOfEvent(event) {
  const edition = event && event.edition && typeof event.edition === 'object' ? event.edition : {};
  return (
    normalizeIsbn(edition.isbn13) ||
    normalizeIsbn(edition.isbn) ||
    normalizeIsbn(edition.isbn10)
  );
}

/**
 * Identity of an event inside the resolve caches (`links/<key>.json`,
 * `index.json`). Mirrors `eventKeyOf` in stats.js — the two must agree or a
 * resolved link would never be found by the payload.
 *
 * A scraped LiveLib event always has a numeric `sourceBookId`. A file row may
 * not: the default `livelib-backup` column set has no «Ссылка на книгу», so the
 * service exports no book id. Such a row is still a first-class resolve input
 * (it carries title, author and often ISBN), so it gets a stable synthetic key
 * from its `fileKey` — `file:tk:<sha1(title|surname)>` — instead of being
 * dropped from the pool or (worse) keyed by its position in the file.
 */
function eventKeyOf(event) {
  if (!event) return null;
  if (event.sourceBookId) return String(event.sourceBookId);
  if (event.fileKey) return `file:${String(event.fileKey)}`;
  return null;
}

function chainInput(event, extra) {
  const isbn = isbnOfEvent(event);
  return {
    isbn13: isbn,
    isbn10: isbn ? isbn10Of(isbn) : null,
    title: (event && event.title) || null,
    authors: Array.isArray(event && event.authors) ? event.authors : [],
    year:
      event && event.edition && Number.isFinite(Number(event.edition.year))
        ? Number(event.edition.year)
        : null,
    // `llBookId` is the *scrape* identity the LiveLib card provider fetches.
    // A file row without «Ссылка на книгу» has none, but it still has a
    // resolve-cache key (`file:tk:…`); `eventKey` carries that key so the
    // provider bookkeeping (attempted/hopeless) can name the row. Without it
    // 240 file-keyed works were invisible to `attempted`/`unmatchedKeys` and
    // the metadata badge kept them in the resolvable pool forever.
    llBookId: event && event.sourceBookId ? String(event.sourceBookId) : null,
    eventKey: eventKeyOf(event),
    coverUrl: (event && event.coverUrl) || null,
    ...(extra || {}),
  };
}

function chainNamesOf(providerList) {
  return providerList.map((provider) => provider.NAME);
}

module.exports = {
  CHAIN_NAMES,
  CYRILLIC_TITLE,
  createChainReport,
  isbnOfEvent,
  eventKeyOf,
  chainInput,
  chainNamesOf,
};
