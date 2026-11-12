'use strict';

/**
 * First-publication claims: one year, how precise it is, and which statement
 * it comes from.
 *
 * Pure data rules, no I/O. They live in their own module because both sides of
 * the provider registry need them: `index.js` (merge, details) and
 * `wikidata.js` (which must not require `index.js` back — that cycle would
 * hand it a half-initialised export).
 */

/**
 * A work's first-publication year, as one provider claims it.
 *
 * The bounds mirror `stats.saneFirstYear`: a work may be ancient («Искусство
 * войны», V century BC), so negative and sub-1000 years are valid here, while a
 * zero/garbage value is not.
 */
function firstYearOf(value) {
  if (value == null || value === '') return null;
  const year = Number(value);
  if (!Number.isFinite(year)) return null;
  const truncated = Math.trunc(year);
  return truncated >= -3000 && truncated <= 2100 ? truncated : null;
}

/**
 * Earliest *claimed first publication* across the merged providers.
 *
 * Provider priority is right for content fields (Hardcover names the work), but
 * not for this one: the failure mode that matters is an edition year dressed as
 * a first-publication year (Литрес `publication_date` 2026, an OL work record
 * built from one 2013 translation). Such a claim is always *later* than the
 * truth, so the earliest sane claim wins and a modern mistake can never
 * outvote an older honest year.
 */
function earliestFirstYear(entries) {
  let best = null;
  for (const entry of entries) {
    const year = firstYearOf(entry && entry.firstPublishedYear);
    if (year == null) continue;
    if (best == null || year < best) best = year;
  }
  return best;
}

/** First-publication precision of a provider claim, as Wikidata knows it. */
const PRECISIONS = ['year', 'decade', 'century', 'millennium'];
/** Higher wins a tie: a dated claim beats a century bucket. */
const PRECISION_RANK = { year: 4, decade: 3, century: 2, millennium: 1 };
/**
 * Which statement the year comes from: a publication date (P577) or the
 * composition/inception date (P571). Ancient texts usually only have the
 * second one, and the payload must not present it as a print year.
 */
const KINDS = ['publication', 'composition'];

function precisionOf(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return PRECISIONS.includes(text) ? text : null;
}

function kindOf(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return KINDS.includes(text) ? text : null;
}

/**
 * One provider result as a first-publication *claim*.
 *
 * A provider may only fill `firstPublishedYear`; precision/kind default to the
 * print-year case (`year`/`publication`), which is what Hardcover, Литрес and
 * Open Library all mean.
 */
function claimOf(entry) {
  if (!entry) return null;
  const year = firstYearOf(entry.firstPublishedYear);
  if (year == null) return null;
  return {
    year,
    source: entry.source ? String(entry.source) : null,
    precision: precisionOf(entry.firstPublishedYearPrecision) || 'year',
    kind: kindOf(entry.firstPublishedYearKind) || 'publication',
  };
}

const PRINT_CLAIM_SOURCES = ['hardcover', 'litres', 'openlibrary', 'googlebooks'];

/** Is the source one that reports an edition/print year for the work? */
function isPrintClaimSource(value) {
  return PRINT_CLAIM_SOURCES.includes(String(value == null ? '' : value));
}

/** The first-publication claim a details document already carries. */
function storedFirstClaim(doc) {
  const year = firstYearOf(doc && doc.firstPublishedYear);
  if (year == null) return null;
  return {
    year,
    source: doc.firstPublishedYearSource ? String(doc.firstPublishedYearSource) : null,
    precision: precisionOf(doc.firstPublishedYearPrecision) || 'year',
    kind: kindOf(doc.firstPublishedYearKind) || 'publication',
  };
}

/** Is claim `a` a better first-publication claim than `b`? */
function claimWins(a, b) {
  if (!b) return true;
  if (a.year !== b.year) return a.year < b.year;
  const rankA = PRECISION_RANK[a.precision] || 0;
  const rankB = PRECISION_RANK[b.precision] || 0;
  if (rankA !== rankB) return rankA > rankB;
  return a.kind === 'publication' && b.kind !== 'publication';
}

/**
 * The earliest sane first-publication claim, with its precision and kind.
 *
 * Earliest still wins (`earliestFirstYear` rule): a late claim is always an
 * edition year dressed as a first publication, so it can never outvote an
 * older honest one. Precision only breaks ties, kind only breaks precision
 * ties.
 */
function earliestFirstClaim(entries) {
  let best = null;
  for (const entry of entries) {
    const claim = claimOf(entry);
    if (!claim) continue;
    if (claimWins(claim, best)) best = claim;
  }
  return best;
}

/**
 * Is the year a provider claims actually a first-publication claim?
 *
 * Print-metadata sources (Hardcover, Open Library, Google Books) describe
 * *editions*: a positive year below 1000 is a field artefact, not a
 * bibliographic statement (Hardcover reports `release_year: 3` for a 2019
 * manga volume — a real document in the live cache). A source that carries
 * authentic ancient dates says so: Литрес stores «Искусство войны» as
 * `-0500-01-01`, and Wikidata returns a century/millennium precision or an
 * explicit `composition` kind. Those pass; a bare `year` claim from a print
 * source only counts inside the modern era, and the honest `edition` channel
 * stays available for it.
 *
 * An author birth year (when known) rejects a claim older than the author.
 */
function saneFirstYearClaim(claim, options = {}) {
  if (!claim) return null;
  if (claim.year === 0) return null;
  const ancientClaim =
    claim.source === 'litres' ||
    claim.kind === 'composition' ||
    (claim.precision != null && claim.precision !== 'year');
  if (claim.year > 0 && claim.year < 1000 && !ancientClaim) return null;
  if (claim.year < 0 && !ancientClaim) return null;
  const editionYear = Number(options.editionYear);
  if (Number.isFinite(editionYear) && editionYear >= 1000 && claim.year > editionYear + 1) {
    return null;
  }
  const authorBirth = Number(options.authorBirthYear);
  // A work cannot be published before its author was born (a small tolerance
  // keeps a posthumous edition from tripping the rule).
  if (Number.isFinite(authorBirth) && authorBirth > 0 && claim.year < authorBirth - 1) {
    return null;
  }
  return claim;
}

/**
 * First-publication claim of a merged result, after the plausibility gate.
 * `editionYear` is the print run in hand (`result.year`), used only as an
 * upper bound.
 */
function mergedFirstClaim(entries, editionYear) {
  // The gate runs per claim, not once on the winner: one artefact
  // (`release_year: 3`) must not throw away the honest 1930 next to it.
  const authorBirthYear = entries.find((entry) => entry && entry.authorBirthYear != null)
    ? Number(entries.find((entry) => entry && entry.authorBirthYear != null).authorBirthYear)
    : null;
  let winner = null;
  for (const entry of entries) {
    const claim = saneFirstYearClaim(claimOf(entry), { editionYear, authorBirthYear });
    if (claim && claimWins(claim, winner)) winner = claim;
  }
  return winner;
}

module.exports = {
  firstYearOf,
  earliestFirstYear,
  earliestFirstClaim,
  claimOf,
  claimWins,
  saneFirstYearClaim,
  mergedFirstClaim,
  precisionOf,
  kindOf,
  storedFirstClaim,
  isPrintClaimSource,
  PRECISIONS,
  PRECISION_RANK,
  KINDS,
};
