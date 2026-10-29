'use strict';

/**
 * Candidate guards shared by the Google Books / Open Library title fallbacks.
 * Mirrors the film-lesson rules: title similarity alone is never enough, the
 * author hit is mandatory when both sides expose authors.
 *
 * `fuzzyAuthor` exists for the cross-language case Google Books exposes: a
 * LiveLib row says «Агата Кристи», the volume says «Agatha Christie», and an
 * exact surname comparison can never match them. The fuzzy path transliterates
 * Cyrillic to Latin and accepts a close surname (similarity >= 0.6, surnames of
 * at least 4 letters). It is opt-in per provider so the strict title matchers
 * (Литрес, Open Library) keep their exact rule.
 */

const { normalizeTitle, tokenJaccard, surnameOf } = require('../normalize');

const STRICT_SIM = 0.6;
const FUZZY_SURNAME_SIM = 0.6;
const FUZZY_SURNAME_MIN_LEN = 4;

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Cyrillic -> Latin skeleton used only for surname comparison. */
function transliterate(value) {
  let out = '';
  for (const char of String(value == null ? '' : value).toLowerCase()) {
    out += Object.prototype.hasOwnProperty.call(TRANSLIT, char) ? TRANSLIT[char] : char;
  }
  return out.replace(/[^a-z0-9]+/g, '');
}

/** Consonant skeleton: drops vowels and folds w/v (transliteration noise). */
function surnameSkeleton(value) {
  return transliterate(value)
    .replace(/w/g, 'v')
    .replace(/[aeiouy]/g, '');
}

function levenshtein(left, right) {
  const a = String(left);
  const b = String(right);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/** 0..1 similarity of two surnames after transliteration.
 *
 * Vowels and the w/v pair are dropped before comparing: Russian-to-Latin
 * transliterations disagree exactly there («Твен» -> tven vs «Twain» -> twain,
 * «Кристи» -> kristi vs «Christie» -> christie), while the consonant skeleton
 * stays stable. Short skeletons fall back to the full transliteration ratio.
 */
function surnameSimilarity(left, right) {
  const aFull = transliterate(left);
  const bFull = transliterate(right);
  if (!aFull || !bFull) return 0;
  if (aFull === bFull) return 1;
  const a = surnameSkeleton(left);
  const b = surnameSkeleton(right);
  if (!a || !b || Math.min(a.length, b.length) < 3) {
    const longest = Math.max(aFull.length, bFull.length);
    return 1 - levenshtein(aFull, bFull) / longest;
  }
  const longest = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / longest;
}

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

/** Exact surname OR a transliterated near-match (see module header). */
function authorsFuzzyOverlap(left, right) {
  if (authorsOverlap(left, right)) return true;
  const a = [...authorSurnames(left)];
  if (!a.length) return false;
  for (const b of authorSurnames(right)) {
    for (const surname of a) {
      if (surnameSimilarity(surname, b) >= FUZZY_SURNAME_SIM) return true;
    }
  }
  return false;
}

/**
 * Score a candidate against the query.
 * Returns { score, titleSim, exact, authorHit, authorFuzzy } or null when the
 * candidate is rejected (wrong author, too little title overlap).
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
  let authorHit =
    queryAuthors.length === 0
      ? true
      : candidateAuthors.length === 0
      ? null
      : authorsOverlap(queryAuthors, candidateAuthors);
  let authorFuzzy = false;
  if (authorHit === false && options.fuzzyAuthor === true) {
    if (authorsFuzzyOverlap(queryAuthors, candidateAuthors)) {
      authorHit = true;
      authorFuzzy = true;
    }
  }
  const minSim = options.minSim == null ? STRICT_SIM : Number(options.minSim);

  if (queryAuthors.length > 0 && authorHit === false) return null;
  if (queryAuthors.length > 0 && authorHit === null && !exact) return null;
  if (!exact && titleSim < minSim) return null;

  const score = exact
    ? authorHit === true
      ? 0.9
      : 0.75
    : Number(Math.min(0.88, 0.5 + titleSim * 0.4).toFixed(3));
  return { score, titleSim, exact, authorHit, authorFuzzy };
}

module.exports = {
  STRICT_SIM,
  FUZZY_SURNAME_SIM,
  authorsOverlap,
  authorsFuzzyOverlap,
  surnameSimilarity,
  transliterate,
  scoreCandidate,
};
