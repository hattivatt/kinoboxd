'use strict';

/**
 * One kill switch for every books-side Wikidata call.
 *
 * Two consumers exist: the author-alias bridge (`authors-bridge.js`) and the
 * first-publication year provider (`providers/wikidata.js`). They must obey the
 * same word list, because `test/helpers/env.zeroBudgets()` writes `0` and an
 * operator may write `off`; a second parser would drift from the first one.
 *
 * `KINOBOXD_BOOKS_WIKIDATA` unset or empty means «enabled»: the sources table
 * (`core/sources.js`) owns the real politeness limits, this switch only exists
 * for tests and offline deployments.
 */
const FALSY = ['0', 'off', 'false', 'no'];

function wikidataEnabled() {
  const raw = String(process.env.KINOBOXD_BOOKS_WIKIDATA || '')
    .trim()
    .toLowerCase();
  return !FALSY.includes(raw);
}

module.exports = { wikidataEnabled, FALSY };
