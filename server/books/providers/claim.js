'use strict';

function firstYearOf(value) {
  if (value == null || value === '') return null;
  const year = Number(value);
  if (!Number.isFinite(year)) return null;
  const truncated = Math.trunc(year);
  return truncated >= -3000 && truncated <= 2100 ? truncated : null;
}

function earliestFirstYear(entries) {
  let best = null;
  for (const entry of entries) {
    const year = firstYearOf(entry && entry.firstPublishedYear);
    if (year == null) continue;
    if (best == null || year < best) best = year;
  }
  return best;
}

const PRECISIONS = ['year', 'decade', 'century', 'millennium'];
const PRECISION_RANK = { year: 4, decade: 3, century: 2, millennium: 1 };
const KINDS = ['publication', 'composition'];

function precisionOf(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return PRECISIONS.includes(text) ? text : null;
}

function kindOf(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return KINDS.includes(text) ? text : null;
}

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

function isPrintClaimSource(value) {
  return PRINT_CLAIM_SOURCES.includes(String(value == null ? '' : value));
}

function canOverrideClaim(result) {
  const match = result && result.match;
  return Boolean(
    match && match.authorHit === true && match.wholeWork !== true && match.fuzzy !== true
  );
}

function isChallengeableClaim(claim) {
  if (!claim) return false;
  return claim.source == null || isPrintClaimSource(claim.source);
}

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

function claimWins(a, b) {
  if (!b) return true;
  if (a.year !== b.year) return a.year < b.year;
  const rankA = PRECISION_RANK[a.precision] || 0;
  const rankB = PRECISION_RANK[b.precision] || 0;
  if (rankA !== rankB) return rankA > rankB;
  return a.kind === 'publication' && b.kind !== 'publication';
}

function earliestFirstClaim(entries) {
  let best = null;
  for (const entry of entries) {
    const claim = claimOf(entry);
    if (!claim) continue;
    if (claimWins(claim, best)) best = claim;
  }
  return best;
}

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
  if (Number.isFinite(authorBirth) && authorBirth > 0 && claim.year < authorBirth - 1) {
    return null;
  }
  return claim;
}

function mergedFirstClaim(entries, editionYear) {
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
  isChallengeableClaim,
  canOverrideClaim,
  PRECISIONS,
  PRECISION_RANK,
  KINDS,
};
