'use strict';

const path = require('path');
const fsStore = require('../core/fs-store');
const bookCache = require('./book-cache');
const { eventLinkKeyOf } = require('./stats/events');
const { normalizeIsbn, volumeNumberOf } = require('./normalize');

const MAX_ITEMS = 200;

function isbnOfValue(value) {
  if (value == null || value === '') return null;
  return normalizeIsbn(String(value));
}

function eventIsbn(event) {
  const edition = event && event.edition && typeof event.edition === 'object' ? event.edition : {};
  for (const value of [edition.isbn13, edition.isbn10, edition.isbn]) {
    const isbn = isbnOfValue(value);
    if (isbn) return isbn;
  }
  return null;
}

function linkIsbn(link) {
  const evidence = link && link.evidence && typeof link.evidence === 'object' ? link.evidence : {};
  return isbnOfValue(evidence.isbn);
}

function workTitleOf(link) {
  const details = bookCache.getWorkDetails(link.workId);
  return details && details.title ? String(details.title) : null;
}

function profileEvents(profile) {
  const data = bookCache.getProfile(profile.source, profile.userKey);
  return data && Array.isArray(data.events) ? data.events : [];
}

function inspectEvent(event, link, items) {
  const bookId = eventLinkKeyOf(event);
  const base = {
    bookId,
    workId: String(link.workId),
    title: event.title == null ? null : String(event.title),
    workTitle: workTitleOf(link),
  };
  const fromEvent = eventIsbn(event);
  const fromLink = linkIsbn(link);
  if (fromEvent && fromLink && fromEvent !== fromLink) {
    items.push({
      ...base,
      kind: 'isbn-mismatch',
      detail: `издание ${fromEvent}, ссылка ${fromLink}`,
    });
  }
  const eventVolume = volumeNumberOf(event.title);
  const workVolume = volumeNumberOf(base.workTitle);
  if (eventVolume != null && workVolume != null && eventVolume !== workVolume) {
    items.push({
      ...base,
      kind: 'volume-mismatch',
      detail: `том ${eventVolume}, у произведения том ${workVolume}`,
    });
  }
  if (!bookCache.getWorkDetails(link.workId)) {
    items.push({
      ...base,
      kind: 'missing-details',
      detail: `нет details/${bookCache.detailsKeyForWork(link.workId)}.json`,
    });
  }
}

function orphanItems(knownKeys, items) {
  for (const name of fsStore.listJsonFiles(bookCache.LINKS_DIR)) {
    const filePath = path.join(bookCache.LINKS_DIR, name);
    const found = fsStore.readJsonWithFingerprint(filePath, { label: 'books-audit' });
    const doc = found && found.data && typeof found.data === 'object' ? found.data : null;
    if (!doc || !doc.workId) continue;
    const bookId = doc.livelibBookId == null || doc.livelibBookId === ''
      ? name.replace(/\.json$/, '')
      : String(doc.livelibBookId);
    if (!bookId || knownKeys.has(bookId)) continue;
    items.push({
      kind: 'orphan',
      bookId,
      workId: String(doc.workId),
      title: null,
      workTitle: workTitleOf(doc),
      detail: 'события с таким ключом нет в профиле',
    });
  }
}

function compareItems(left, right) {
  const byKind = left.kind.localeCompare(right.kind);
  if (byKind !== 0) return byKind;
  return String(left.bookId).localeCompare(String(right.bookId));
}

function listSuspiciousLinks(profile) {
  const items = [];
  const knownKeys = new Set();
  for (const event of profileEvents(profile)) {
    const bookId = eventLinkKeyOf(event);
    if (!bookId) continue;
    knownKeys.add(bookId);
    const link = bookCache.getLink(bookId);
    if (!link || !link.workId) continue;
    inspectEvent(event, link, items);
  }
  orphanItems(knownKeys, items);
  items.sort(compareItems);
  const sliced = items.slice(0, MAX_ITEMS);
  return { count: sliced.length, items: sliced };
}

module.exports = {
  MAX_ITEMS,
  volumeNumberOf,
  eventIsbn,
  listSuspiciousLinks,
};
