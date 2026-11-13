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

function isbnOfEvent(event) {
  const edition = event && event.edition && typeof event.edition === 'object' ? event.edition : {};
  return (
    normalizeIsbn(edition.isbn13) ||
    normalizeIsbn(edition.isbn) ||
    normalizeIsbn(edition.isbn10)
  );
}

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
