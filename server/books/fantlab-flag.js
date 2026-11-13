'use strict';

const { FALSY } = require('./wikidata-flag');

function fantlabEnabled() {
  const raw = String(process.env.KINOBOXD_BOOKS_FANTLAB || '')
    .trim()
    .toLowerCase();
  return !FALSY.includes(raw);
}

module.exports = { fantlabEnabled };
