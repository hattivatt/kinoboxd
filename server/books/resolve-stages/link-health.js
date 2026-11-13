'use strict';

const { normalizeIsbn, normalizeTitle, volumeNumberOf } = require('../normalize');
const { workVolumeOf, volumesConflict } = require('./matching');
const { eventKeyOf, isbnOfEvent } = require('./identity');

function derivedIsbnOf(event, link) {
  if (!link || link.method !== 'isbn') return null;
  const isbn = normalizeIsbn(link.evidence && link.evidence.isbn);
  if (!isbn || isbnOfEvent(event) === isbn) return null;
  return isbn;
}

function staleLinkKeys(events, cache) {
  const stale = new Set();
  const byIsbn = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const key = event ? eventKeyOf(event) : null;
    if (!key) continue;
    const link = cache.getLink(key);
    if (!link || !link.workId || link.method === 'manual') continue;
    const work = cache.getWorkDetails(link.workId);
    if (volumesConflict(volumeNumberOf(event.title), workVolumeOf(work))) {
      stale.add(key);
      continue;
    }
    const isbn = derivedIsbnOf(event, link);
    if (!isbn) continue;
    const group = byIsbn.get(isbn) || { keys: [], titles: new Set() };
    group.keys.push(key);
    group.titles.add(normalizeTitle(event.title));
    byIsbn.set(isbn, group);
  }
  for (const group of byIsbn.values()) {
    if (group.titles.size > 1) for (const key of group.keys) stale.add(key);
  }
  return stale;
}

module.exports = { staleLinkKeys };
