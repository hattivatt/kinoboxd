'use strict';

/**
 * Candidate guards shared by the Google Books / Open Library title fallbacks.
 * Mirrors the film-lesson rules: title similarity alone is never enough, the
 * author hit is mandatory when both sides expose authors.
 */

const { normalizeTitle, tokenJaccard, surnameOf } = require('../normalize');

const STRICT_SIM = 0.6;

function authorSurnames(names) {
  return new Set(
    (Array.isArray(names) ? names : [])
      .map((name) => surnameOf(name))
      .filter(Boolean)
  );
}

function authorsOverlap(left, right) {
  const a = authorSurnames(left);
  if (a.size === 0) return false;
  for (const surname of authorSurnames(right)) {
    if (a.has(surname)) return true;
  }
  return false;
}

/**
 * Score a candidate against the query.
 * Returns { score, titleSim, exact, authorHit } or null when the candidate is
 * rejected (wrong author, too little title overlap).
 */
function scoreCandidate(query, candidate, options = {}) {
  const queryTitle = query && query.title ? String(query.title) : '';
  const candidateTitle = candidate && candidate.title ? String(candidate.title) : '';
  if (!queryTitle || !candidateTitle) return null;

  const titleSim = tokenJaccard(queryTitle, candidateTitle);
  const exact =
    normalizeTitle(queryTitle) !== '' &&
    normalizeTitle(queryTitle) === normalizeTitle(candidateTitle);
  const queryAuthors = Array.isArray(query.authors) ? query.authors.filter(Boolean) : [];
  const candidateAuthors = Array.isArray(candidate.authors)
    ? candidate.authors.filter(Boolean)
    : [];
  const authorHit =
    queryAuthors.length === 0
      ? true
      : candidateAuthors.length === 0
      ? null
      : authorsOverlap(queryAuthors, candidateAuthors);
  const minSim = options.minSim == null ? STRICT_SIM : Number(options.minSim);

  if (queryAuthors.length > 0 && authorHit === false) return null;
  if (queryAuthors.length > 0 && authorHit === null && !exact) return null;
  if (!exact && titleSim < minSim) return null;

  const score = exact
    ? authorHit === true
      ? 0.9
      : 0.75
    : Number(Math.min(0.88, 0.5 + titleSim * 0.4).toFixed(3));
  return { score, titleSim, exact, authorHit };
}

module.exports = {
  STRICT_SIM,
  authorsOverlap,
  scoreCandidate,
};
