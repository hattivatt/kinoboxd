'use strict';

const fsStore = require('../core/fs-store');
const bookCache = require('./book-cache');

const MANUAL_METHOD = 'manual';

function isManualLink(link) {
  return Boolean(link) && link.method === MANUAL_METHOD;
}

function manualLinkDoc(bookId, workId, now = new Date().toISOString()) {
  return {
    schemaVersion: 2,
    livelibBookId: String(bookId),
    workId: String(workId),
    method: MANUAL_METHOD,
    score: 1,
    evidence: { manual: true },
    resolvedAt: now,
  };
}

async function saveManualLink(bookId, workId) {
  const doc = manualLinkDoc(bookId, workId);
  await bookCache.saveLink(String(bookId), doc);
  return doc;
}

function deleteLink(bookId) {
  return fsStore.removeQuietly(bookCache.linkPath(String(bookId)));
}

module.exports = {
  MANUAL_METHOD,
  isManualLink,
  manualLinkDoc,
  saveManualLink,
  deleteLink,
};
