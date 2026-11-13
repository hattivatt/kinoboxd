'use strict';

const {
  cleanText,
  normalizeTitle,
  tokenJaccard,
  surnameOf,
  volumeNumberOf,
} = require('../normalize');

const FUZZY_ACCEPT = 0.9;
const FUZZY_GUARDED = 0.8;
const RATINGS_FLOOR = 50;

const AUTHOR_ALIASES = {
  'джоан роулинг': ['j. k. rowling', 'jk rowling', 'robert galbraith'],
  'joanne rowling': ['j. k. rowling', 'jk rowling'],
  'стивен кинг': ['stephen king', 'richard bachman'],
  'борис акунин': ['boris akunin', 'анатолий брусникин', 'анна борисова'],
  'макс фрай': ['макс фрай', 'светлана мартынчик'],
};

function authorKeySet(names) {
  const keys = new Set();
  for (const name of names || []) {
    const surname = surnameOf(name);
    if (!surname) continue;
    keys.add(surname);
    const full = cleanText(name).toLowerCase().replace(/ё/g, 'е');
    for (const [canonical, aliases] of Object.entries(AUTHOR_ALIASES)) {
      if (canonical === full || aliases.includes(full) || surnameOf(canonical) === surname) {
        keys.add(surnameOf(canonical));
        for (const alias of aliases) keys.add(surnameOf(alias));
      }
    }
  }
  return keys;
}

function authorsOverlap(llAuthors, hcAuthors) {
  const left = authorKeySet(llAuthors);
  if (left.size === 0) return false;
  for (const key of authorKeySet(hcAuthors)) {
    if (left.has(key)) return true;
  }
  return false;
}

const COLLECTION_MARKERS = /сборник|антолог|избранн|полное собрание|собрание сочинений/i;
const ADAPTATION_MARKERS = /иллюстрированн|подарочн|адаптац|краткое содержание|пересказ|сокращ/i;
const positionOf = volumeNumberOf;

function workVolumeOf(work) {
  const fromTitle = volumeNumberOf(work && work.title);
  if (fromTitle != null) return fromTitle;
  const series = Array.isArray(work && work.series) ? work.series : [];
  const entry = series.find((item) => item && item.position != null);
  const position = entry ? Number(entry.position) : null;
  return Number.isFinite(position) ? position : null;
}

function volumesConflict(left, right) {
  return left != null && right != null && Number(left) !== Number(right);
}

function hardcoverEntryConflict(eventTitle, entry, options = {}) {
  if (!entry || !entry.details) return null;
  const editionTitle = entry.editionTitle ? String(entry.editionTitle) : null;
  const eventVolume = volumeNumberOf(eventTitle);
  const editionVolume = volumeNumberOf(editionTitle);
  const ownVolume = eventVolume != null ? eventVolume : editionVolume;
  if (volumesConflict(ownVolume, workVolumeOf(entry.details))) return 'volume';
  if (options.derived && editionTitle && eventTitle) {
    const sameScript = /[а-яё]/i.test(editionTitle) === /[а-яё]/i.test(String(eventTitle));
    const exact = normalizeTitle(editionTitle) === normalizeTitle(eventTitle);
    if (sameScript && !exact && tokenJaccard(editionTitle, eventTitle) < 0.5) return 'edition-title';
  }
  return null;
}

function guardReject(llEvent, candidate) {
  const llTitle = String(llEvent.title || '');
  const hcTitle = String(candidate.title || '');
  if (COLLECTION_MARKERS.test(llTitle) && !COLLECTION_MARKERS.test(hcTitle)) {
    return 'collection-marker';
  }
  if (ADAPTATION_MARKERS.test(llTitle) && !ADAPTATION_MARKERS.test(hcTitle)) {
    return 'adaptation-marker';
  }
  if (volumesConflict(positionOf(llTitle), workVolumeOf(candidate))) {
    return 'series-position';
  }
  return null;
}

function yearDelta(llYear, hcYear) {
  if (!Number.isFinite(Number(llYear)) || !Number.isFinite(Number(hcYear))) return null;
  return Math.abs(Number(llYear) - Number(hcYear));
}

function scoreCandidate(event, candidate) {
  const titleSim = tokenJaccard(event.title, candidate.title);
  const authorHit = authorsOverlap(event.authors, (candidate.authors || []).map((author) => author.name));
  const eventYear = event.edition && event.edition.year ? Number(event.edition.year) : null;
  const candidateYear = candidate.publicationYear || null;
  const delta = yearDelta(eventYear, candidateYear);
  const ratingsCount = Number.isFinite(Number(candidate.ratingsCount))
    ? Number(candidate.ratingsCount)
    : 0;
  const exactTitle = normalizeTitle(event.title) === normalizeTitle(candidate.title) && normalizeTitle(event.title) !== '';

  const evidence = { titleSim: Number(titleSim.toFixed(3)), authorHit, yearDelta: delta, ratingsCount };

  const guard = guardReject(event, candidate);
  if (guard) return { score: 0, method: 'rejected', evidence: { ...evidence, guard } };

  if (exactTitle && authorHit && delta != null && delta <= 1) {
    return { score: 1, method: 'title-author-year', evidence };
  }
  if (exactTitle && authorHit && delta == null) {
    return { score: 0.95, method: 'title-author', evidence };
  }
  if (titleSim >= FUZZY_ACCEPT && authorHit) {
    return { score: Number((0.9 + titleSim * 0.1).toFixed(3)), method: 'title-author-fuzzy', evidence };
  }
  if (
    titleSim >= FUZZY_GUARDED &&
    authorHit &&
    delta != null &&
    delta <= 1 &&
    ratingsCount >= RATINGS_FLOOR
  ) {
    return { score: Number(titleSim.toFixed(3)), method: 'title-author-fuzzy', evidence };
  }
  return null;
}

function bestCandidate(event, candidates) {
  const scored = [];
  for (const candidate of candidates) {
    const result = scoreCandidate(event, candidate);
    if (result && result.score > 0) {
      scored.push({ candidate, ...result });
    }
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const left = Number(a.candidate.hcWorkId) || 0;
    const right = Number(b.candidate.hcWorkId) || 0;
    return left - right;
  });
  const best = scored[0];
  if (scored.length > 1 && scored[1].score === best.score) {
    return { ambiguous: true, score: best.score, evidence: best.evidence };
  }
  return best;
}

module.exports = {
  FUZZY_ACCEPT,
  FUZZY_GUARDED,
  RATINGS_FLOOR,
  AUTHOR_ALIASES,
  authorKeySet,
  authorsOverlap,
  positionOf,
  workVolumeOf,
  volumesConflict,
  hardcoverEntryConflict,
  guardReject,
  yearDelta,
  scoreCandidate,
  bestCandidate,
};
