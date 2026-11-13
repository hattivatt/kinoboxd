'use strict';

const path = require('path');

const bookCache = require('../book-cache');
const fsStore = require('../../core/fs-store');
const { normalizeTitle, tokenJaccard } = require('../normalize');
const { FUZZY_GUARDED } = require('./matching');

function listDetailsFiles() {
  const works = [];
  for (const name of fsStore.listJsonFiles(bookCache.DETAILS_DIR)) {
    const found = bookCache.readJsonWithFingerprint(path.join(bookCache.DETAILS_DIR, name));
    if (found && found.data && found.data.hcWorkId) works.push(found.data);
  }
  return works;
}

function loadWorks() {
  const works = new Map();
  for (const details of listDetailsFiles()) {
    works.set(String(details.hcWorkId), details);
  }
  return works;
}

function buildCorpus(works) {
  const byTitle = new Map();
  for (const work of works) {
    const key = normalizeTitle(work.title);
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(work);
  }
  return { works, byTitle };
}

function corpusCandidates(corpus, title) {
  const exact = corpus.byTitle.get(normalizeTitle(title));
  if (exact && exact.length) return exact;
  return corpus.works.filter((work) => tokenJaccard(title, work.title) >= FUZZY_GUARDED);
}

module.exports = {
  listDetailsFiles,
  loadWorks,
  buildCorpus,
  corpusCandidates,
};
