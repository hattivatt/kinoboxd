'use strict';

const FALSY = ['0', 'off', 'false', 'no'];

function wikidataEnabled() {
  const raw = String(process.env.KINOBOXD_BOOKS_WIKIDATA || '')
    .trim()
    .toLowerCase();
  return !FALSY.includes(raw);
}

module.exports = { wikidataEnabled, FALSY };
