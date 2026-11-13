'use strict';

const { saneYear } = require('./numeric');
const { eventLinkKeyOf } = require('./events');

function saneFirstYear(value) {
  if (value == null || value === '') return null;
  const year = Number(value);
  if (!Number.isFinite(year)) return null;
  return year >= -3000 && year <= 2100 ? Math.trunc(year) : null;
}

function firstPublishedYearOf(details) {
  return saneFirstYear(details && details.firstPublishedYear);
}

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

function editionYearOf(details, displayEvent, fileMeta) {
  const fromFile = saneYear(
    (displayEvent && displayEvent.edition && displayEvent.edition.year) || (fileMeta && fileMeta.year)
  );
  if (fromFile != null) return { year: fromFile, source: 'file' };
  const legacy = saneFirstYear(details && details.publicationYear);
  if (legacy != null && legacy !== 0) return { year: legacy, source: 'details' };
  return { year: null, source: null };
}

function saneManualYear(value) {
  const year = saneFirstYear(value);
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
