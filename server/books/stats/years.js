'use strict';

/**
 * Publication-year resolution of a work: the work's first publication, the
 * print run in hand, and the user's manual override (manual > first >
 * edition > unknown).
 *
 * R12 «god module» split: moved out of `books/stats.js` unchanged.
 */

const { saneYear } = require('./numeric');
const { eventLinkKeyOf } = require('./events');

/**
 * A work's *first publication* year may be ancient («Искусство войны» is
 * ~5th century BC). It is kept in the payload and bucketed as «до 1000 г.»
 * instead of being filtered out like a bad edition year.
 */
function saneFirstYear(value) {
  if (value == null || value === '') return null;
  const year = Number(value);
  if (!Number.isFinite(year)) return null;
  return year >= -3000 && year <= 2100 ? Math.trunc(year) : null;
}

/**
 * First publication year of the *work* — when a provider actually knows it.
 *
 * `details.firstPublishedYear` is the single source of truth for the work's
 * first publication: Hardcover `book.release_year`, Open Library
 * `first_publish_year` (only when the record has more than one edition),
 * Литрес «дата написания». It is preferred over an edition year, but since the
 * 29.10.2026 verdict it is no longer the only source: `resolveWorkYear` falls
 * back to the print run (`editionYear`) with an honest `yearSource: 'edition'`
 * mark, and a manual correction outranks both. A work with neither lands in
 * the honest «год неизвестен» bucket (`decades[]` with `unknown: true`).
 *
 * Ancient years are valid here (Сунь Цзы, ~V century BC).
 */
function firstPublishedYearOf(details) {
  return saneFirstYear(details && details.firstPublishedYear);
}

// How exact a first-publication claim is (`century` for ancient reprints) and
// whether it names the work's publication or its composition. Absent = the
// plain defaults; anything outside the vocabulary is garbage, not a claim.
const YEAR_PRECISIONS = new Set(['year', 'decade', 'century', 'millennium']);
const YEAR_KINDS = new Set(['publication', 'composition']);

function firstPublishedYearPrecisionOf(details) {
  const value = details && details.firstPublishedYearPrecision;
  if (value == null) return 'year';
  const normalized = String(value).trim().toLowerCase();
  return YEAR_PRECISIONS.has(normalized) ? normalized : null;
}

function firstPublishedYearKindOf(details) {
  const value = details && details.firstPublishedYearKind;
  if (value == null) return 'publication';
  const normalized = String(value).trim().toLowerCase();
  return YEAR_KINDS.has(normalized) ? normalized : null;
}

/**
 * The print run in hand — the «год издания» of the copy the reader actually
 * holds, i.e. the legacy year channel of the pre-ef593a8 chart.
 *
 * Two sources, in this order:
 *   1. the export/event column (`edition.year` of a `livelib-file` row, the
 *      reader's own LiveLib card «Год издания») — the file column wins because
 *      it is the user's data, not a provider's guess;
 *   2. the details document's `publicationYear` — the print run the metadata
 *      provider knows (Литрес `publication_date`, an OL/HC edition record).
 *      Before ef593a8 this field went through `saneFirstYear`, so a reprint of
 *      an ancient text keeps its ancient year instead of vanishing from the
 *      chart; that bound is preserved here.
 *
 * `source` is echoed as `editionYearSource` so the payload/UI can say *which*
 * legacy channel answered instead of lumping them together.
 */
function editionYearOf(details, displayEvent, fileMeta) {
  const fromFile = saneYear(
    (displayEvent && displayEvent.edition && displayEvent.edition.year) || (fileMeta && fileMeta.year)
  );
  if (fromFile != null) return { year: fromFile, source: 'file' };
  const legacy = saneFirstYear(details && details.publicationYear);
  // There is no year zero; a 0 is a typo, not an ancient date.
  if (legacy != null && legacy !== 0) return { year: legacy, source: 'details' };
  return { year: null, source: null };
}

/**
 * Publication year of a work, with the user's priority (verdict 29.10.2026):
 *
 *   manual > firstPublishedYear > editionYear > unknown
 *
 * `firstPublishedYear` is still the preferred bibliographic claim (Hardcover
 * work release, Open Library `first_publish_year`, Литрес «дата написания»).
 * When no provider knows the work's first publication, the edition in hand is
 * an honest fallback: the chart shows the book under its print year and marks
 * it as such (`yearSource: 'edition'`) instead of hiding it in «год неизвестен».
 * The edition year is NEVER labelled as a first publication in the payload/UI.
 *
 * A manual correction is the user's word and outranks every provider. It lives
 * in `cache-book/year-overrides/<profile>.json` (book-cache.js) and survives
 * resolve/backfill/file re-import; `yearOverride` is echoed so the UI can offer
 * "reset".
 */
function saneManualYear(value) {
  const year = saneFirstYear(value);
  // There is no year zero; a 0 is a typo, not an ancient date.
  return year === 0 ? null : year;
}

function resolveWorkYear(details, displayEvent, fileMeta, override) {
  const firstPublishedYear = firstPublishedYearOf(details);
  const edition = editionYearOf(details, displayEvent, fileMeta);
  const editionYear = edition.year;
  const editionYearSource = edition.source;
  const manualYear = override ? saneManualYear(override.year) : null;
  const firstPublishedYearSource =
    details && details.firstPublishedYearSource ? String(details.firstPublishedYearSource) : null;
  // The precision/kind describe the first-publication *claim*, so they travel
  // only with a claim: `null` when the payload has no firstPublishedYear.
  const firstPublishedYearPrecision = firstPublishedYear != null ? firstPublishedYearPrecisionOf(details) : null;
  const firstPublishedYearKind = firstPublishedYear != null ? firstPublishedYearKindOf(details) : null;
  if (manualYear != null) {
    return {
      year: manualYear,
      yearSource: 'manual',
      yearOverride: manualYear,
      firstPublishedYear,
      firstPublishedYearSource,
      firstPublishedYearPrecision,
      firstPublishedYearKind,
      editionYear,
      editionYearSource,
    };
  }
  if (firstPublishedYear != null) {
    return {
      year: firstPublishedYear,
      yearSource: 'first',
      yearOverride: null,
      firstPublishedYear,
      firstPublishedYearSource,
      firstPublishedYearPrecision,
      firstPublishedYearKind,
      editionYear,
      editionYearSource,
    };
  }
  if (editionYear != null) {
    return {
      year: editionYear,
      yearSource: 'edition',
      yearOverride: null,
      firstPublishedYear: null,
      firstPublishedYearSource,
      firstPublishedYearPrecision: null,
      firstPublishedYearKind: null,
      editionYear,
      editionYearSource,
    };
  }
  return {
    year: null,
    yearSource: null,
    yearOverride: null,
    firstPublishedYear: null,
    firstPublishedYearSource,
    firstPublishedYearPrecision: null,
    firstPublishedYearKind: null,
    editionYear: null,
    editionYearSource: null,
  };
}

/**
 * Stable keys a manual year override may be stored under. The client stores the
 * `workId` it saw; after a resolve that id can change
 * (`ll:file:tk:<sha1>` / `ll:<bookId>` -> `hc:<id>`). The event's own identity
 * is stable, so the override follows the work across the metadata chain.
 */
function yearOverrideKeysOf(workId, metadataWorkId, events) {
  const keys = [];
  const push = (value) => {
    const key = value == null ? '' : String(value);
    if (key && !keys.includes(key)) keys.push(key);
  };
  push(workId);
  push(metadataWorkId);
  for (const event of events || []) {
    if (!event) continue;
    if (event.sourceBookId) {
      push(`${event.source === 'hardcover' ? 'hc' : 'll'}:${event.sourceBookId}`);
    }
    const linkKey = eventLinkKeyOf(event);
    if (linkKey) {
      push(linkKey);
      push(`ll:${linkKey}`);
    }
  }
  return keys;
}

function findYearOverride(overrides, keys) {
  if (!overrides || typeof overrides !== 'object') return null;
  for (const key of keys) {
    const entry = overrides[key];
    if (entry && saneManualYear(entry.year) != null) return entry;
  }
  return null;
}

module.exports = {
  saneFirstYear,
  firstPublishedYearOf,
  firstPublishedYearPrecisionOf,
  firstPublishedYearKindOf,
  editionYearOf,
  resolveWorkYear,
  yearOverrideKeysOf,
  findYearOverride,
};
