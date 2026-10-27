'use strict';

/**
 * LiveLib -> Hardcover resolve.
 *
 * LiveLib events arrive with edition-level ids and Russian titles; Hardcover is
 * the canonical work namespace (`books.id` = work id, `hc:{id}`). Matching is
 * deliberately asymmetric — hardcover events need no matching at all.
 *
 * Order (КНИГИ-АРХИТЕКТУРА.md §4.0):
 *   1. cached link `links/{livelibBookId}.json` (positive results only);
 *   2. ISBN-13/ISBN-10 bulk lookup against `editions` (batches of 100);
 *   3. strict title + first-author surname + year (±1);
 *   4. fuzzy token-Jaccard with the film-lesson guards
 *      (author hit mandatory, 0.80-0.90 needs year ±1 and ratings_count >= 50);
 *   5. otherwise unmatched (NOT cached: a later Hardcover import may resolve it).
 *
 * All broad decisions are appended to match-log.jsonl. Negatives are never
 * cached, which avoids the "unmatched forever" trap of the film rematch flow.
 */

const hardcover = require('./hardcover');
const bookCache = require('./book-cache');

const ISBN_BATCH_SIZE = 100;
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

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalize a title for comparison (display keeps the original). */
function normalizeTitle(title) {
  let value = cleanText(title).toLowerCase();
  value = value.replace(/ё/g, 'е');
  value = value.replace(/[«»“”„"']/g, ' ');
  value = value.replace(/[—–]/g, '-');
  // Series/volume markers that are not part of the work title.
  value = value.replace(/\((?:[^()]*?(?:#\s*\d+|кн\.?\s*\d+|том\s*\d+|book\s*\d+)[^()]*?)\)/g, ' ');
  value = value.replace(
    /(?<![\p{L}])(?:кн\.?|том|часть|книга|book|vol(?:ume)?)\s*\d+/giu,
    ' '
  );
  value = value.replace(/#\s*\d+\b/g, ' ');
  // Subtitle after ":" / " - " only when the main part is substantial,
  // otherwise "Дюна: Мессия" would collapse into "Дюна".
  const split = value.split(/\s*:\s*|\s+-\s+/);
  if (split.length > 1 && split[0].trim().split(/\s+/).filter(Boolean).length >= 3) {
    value = split[0];
  }
  value = value.replace(/[^\p{L}\p{N}]+/gu, ' ');
  return value.replace(/\s+/g, ' ').trim();
}

function tokensOf(value) {
  return normalizeTitle(value).split(' ').filter(Boolean);
}

/** Token Jaccard similarity of two normalized titles. */
function tokenJaccard(left, right) {
  const a = new Set(tokensOf(left));
  const b = new Set(tokensOf(right));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Surname = last token ("Джефф Вандермеер" -> "вандермеер", "J. K. Rowling" -> "rowling"). */
function surnameOf(name) {
  const tokens = cleanText(name)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
  return tokens.length ? tokens[tokens.length - 1] : '';
}

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

function normalizeIsbn(value) {
  const digits = String(value == null ? '' : value).replace(/[^\dXx]/g, '').toUpperCase();
  if (digits.length === 13) return digits;
  if (digits.length === 10) return isbn10to13(digits) || digits;
  return null;
}

/** ISBN-10 -> ISBN-13 (978 prefix only); returns null for invalid input. */
function isbn10to13(isbn10) {
  const value = String(isbn10 == null ? '' : isbn10).replace(/[^\dXx]/g, '').toUpperCase();
  if (value.length !== 10) return null;
  const core = `978${value.slice(0, 9)}`;
  if (!/^\d{12}$/.test(core)) return null;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return `${core}${check}`;
}

function isbn10Of(isbn13) {
  const value = String(isbn13 || '');
  if (!/^978\d{10}$/.test(value)) return null;
  const core = value.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(core[i]) * (10 - i);
  const check = (11 - (sum % 11)) % 11;
  return `${core}${check === 10 ? 'X' : check}`;
}

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

const COLLECTION_MARKERS = /сборник|антолог|избранн|полное собрание|собрание сочинений/i;
const ADAPTATION_MARKERS = /иллюстрированн|подарочн|адаптац|краткое содержание|пересказ|сокращ/i;
const POSITION_MARKERS = /(?<![\p{L}])(?:том|часть|книга|кн\.)\s*(\d+)/iu;

function positionOf(title) {
  const match = String(title || '').match(POSITION_MARKERS);
  return match ? Number(match[1]) : null;
}

/**
 * Reject obvious traps: collection/adaptation markers on one side only, and
 * volume markers that contradict the candidate's series position.
 */
function guardReject(llEvent, candidate) {
  const llTitle = String(llEvent.title || '');
  const hcTitle = String(candidate.title || '');
  if (COLLECTION_MARKERS.test(llTitle) && !COLLECTION_MARKERS.test(hcTitle)) {
    return 'collection-marker';
  }
  if (ADAPTATION_MARKERS.test(llTitle) && !ADAPTATION_MARKERS.test(hcTitle)) {
    return 'adaptation-marker';
  }
  const llPosition = positionOf(llTitle);
  const hcPosition =
    Array.isArray(candidate.series) && candidate.series.length
      ? candidate.series.find((entry) => entry && entry.position != null)?.position
      : null;
  if (llPosition != null && hcPosition != null && Number(llPosition) !== Number(hcPosition)) {
    return 'series-position';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Candidate scoring                                                   */
/* ------------------------------------------------------------------ */

function yearDelta(llYear, hcYear) {
  if (!Number.isFinite(Number(llYear)) || !Number.isFinite(Number(hcYear))) return null;
  return Math.abs(Number(llYear) - Number(hcYear));
}

/**
 * Score one livelib event against one hardest-cover work.
 * Returns { score, method, evidence } or null when the pair is rejected.
 */
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

/**
 * Pick the single best candidate deterministically.
 * Returns { candidate, score, method, evidence } or null.
 */
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
  // Two equally good, different works are ambiguous: refuse to guess.
  if (scored.length > 1 && scored[1].score === best.score) {
    return { ambiguous: true, score: best.score, evidence: best.evidence };
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Corpus                                                              */
/* ------------------------------------------------------------------ */

function listDetailsFiles() {
  try {
    const fs = require('fs');
    const path = require('path');
    const names = fs.readdirSync(bookCache.DETAILS_DIR).filter((name) => name.endsWith('.json'));
    const works = [];
    for (const name of names) {
      const found = bookCache.readJsonWithFingerprint(path.join(bookCache.DETAILS_DIR, name));
      if (found && found.data && found.data.hcWorkId) works.push(found.data);
    }
    return works;
  } catch (err) {
    return [];
  }
}

/** normalized title -> details[] for the title/author strategies. */
function buildCorpus(works) {
  const byTitle = new Map();
  for (const work of works) {
    const key = normalizeTitle(work.title);
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(work);
  }
  return { works, byTitle };
}

function corpusCandidates(corpus, title) {
  const exact = corpus.byTitle.get(normalizeTitle(title));
  if (exact && exact.length) return exact;
  // Fuzzy: candidate titles that share at least one token. Small corpus
  // (hundreds of works), so a linear scan is cheaper than an index per token.
  return corpus.works.filter((work) => tokenJaccard(title, work.title) >= FUZZY_GUARDED);
}

/* ------------------------------------------------------------------ */
/* ISBN bulk lookup                                                    */
/* ------------------------------------------------------------------ */

const ISBN_QUERY = `
query IsbnBatch($isbns: [String!]!) {
  editions(
    where: { _or: [{ isbn_13: { _in: $isbns } }, { isbn_10: { _in: $isbns } }] }
    order_by: { id: asc }
    limit: 500
  ) {
    id
    book_id
    isbn_13
    isbn_10
    language_id
    pages
    publisher_id
    release_year
    release_date
    book {
      id
      title
      slug
      pages
      release_date
      release_year
      rating
      ratings_count
      cached_image
      contributions { author { id name } contribution }
      book_series { position series { id name } }
      taggings(limit: 30) { tag { id tag slug tag_category_id } }
    }
    publisher { id name }
    language { id language }
  }
}`;

/**
 * Resolve a set of normalized ISBNs to hardcover works.
 * Returns { byIsbn: Map<isbn, {details, editionId}>, queries }.
 */
async function lookupIsbns(isbns, options = {}) {
  const byIsbn = new Map();
  const works = new Map();
  const queries = [];
  let requestCount = 0;
  const unique = [...new Set(isbns.filter(Boolean))];
  for (let i = 0; i < unique.length; i += ISBN_BATCH_SIZE) {
    const batch = unique.slice(i, i + ISBN_BATCH_SIZE);
    const isbn10s = batch.map(isbn10Of).filter(Boolean);
    const queryValues = [...new Set([...batch, ...isbn10s])];
    requestCount++;
    if (typeof options.onProgress === 'function') {
      options.onProgress({ batch: requestCount, queries: Math.ceil(unique.length / ISBN_BATCH_SIZE) });
    }
    const data = await hardcover.graphql(
      ISBN_QUERY,
      { isbns: queryValues },
      { label: `isbn batch ${requestCount}` }
    );
    const editions = Array.isArray(data.editions) ? data.editions : [];
    for (const edition of editions) {
      if (!edition || !edition.book) continue;
      const details = hardcover.detailsFromBook(edition.book, edition);
      if (!details) continue;
      works.set(details.hcWorkId, details);
      const keys = new Set();
      for (const raw of [edition.isbn_13, edition.isbn_10]) {
        const normalized = normalizeIsbn(raw);
        if (normalized) keys.add(normalized);
      }
      for (const key of keys) {
        if (batch.includes(key)) {
          byIsbn.set(key, { details, editionId: edition.id ? Number(edition.id) : null });
        }
      }
    }
    queries.push({ batch: batch.length, editions: editions.length });
    console.log(
      `[resolve] isbn batch ${requestCount}: ${batch.length} isbn(s) -> ${editions.length} edition(s)`
    );
  }
  return { byIsbn, works, queries, requests: requestCount };
}

/* ------------------------------------------------------------------ */
/* Resolve job                                                         */
/* ------------------------------------------------------------------ */

/**
 * Resolve all livelib events of one profile.
 *
 * Returns a report:
 *   { total, cached, resolvedIsbn, resolvedTitle, ambiguous, unmatched,
 *     requests, corpusSize, resolvedWorkIds }
 */
async function resolveProfile(llProfile, options = {}) {
  const force = Boolean(options.force);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const events = Array.isArray(llProfile && llProfile.events) ? llProfile.events : [];
  const now = new Date().toISOString();

  const report = {
    total: events.length,
    cached: 0,
    resolvedIsbn: 0,
    resolvedTitle: 0,
    ambiguous: 0,
    unmatched: 0,
    requests: 0,
    corpusSize: 0,
    resolvedWorkIds: 0,
    methods: {},
  };

  // 1. Existing positive links.
  const links = new Map(); // bookId -> link doc
  const pending = [];
  for (const event of events) {
    const bookId = event && event.sourceBookId ? String(event.sourceBookId) : null;
    if (!bookId) continue;
    if (!force) {
      const cached = bookCache.getLink(bookId);
      if (cached && cached.workId) {
        links.set(bookId, cached);
        report.cached++;
        continue;
      }
    }
    pending.push(event);
  }

  // Works known from previous imports (journal metadata on disk).
  const works = new Map();
  for (const details of listDetailsFiles()) {
    works.set(String(details.hcWorkId), details);
  }

  // 2. ISBN bulk lookup (only events that have an ISBN and no cached link).
  const isbnToBookIds = new Map();
  for (const event of pending) {
    const isbn = normalizeIsbn(event.edition && event.edition.isbn);
    if (!isbn) continue;
    if (!isbnToBookIds.has(isbn)) isbnToBookIds.set(isbn, new Set());
    isbnToBookIds.get(isbn).add(String(event.sourceBookId));
  }

  if (isbnToBookIds.size > 0) {
    const lookup = await lookupIsbns([...isbnToBookIds.keys()], { onProgress });
    report.requests += lookup.requests;
    for (const [isbn, entry] of lookup.byIsbn) {
      const workId = `hc:${entry.details.hcWorkId}`;
      works.set(String(entry.details.hcWorkId), entry.details);
      for (const bookId of isbnToBookIds.get(isbn) || []) {
        if (links.has(bookId)) continue;
        const link = {
          schemaVersion: 1,
          livelibBookId: bookId,
          workId,
          method: 'isbn',
          score: 1,
          evidence: { isbn },
          resolvedAt: now,
        };
        links.set(bookId, link);
        report.resolvedIsbn++;
      }
    }
    // Persist freshly discovered works once.
    for (const details of lookup.works.values()) {
      await bookCache.saveDetails(details.hcWorkId, details);
    }
  }

  // 3. Strict/fuzzy title + author over the local corpus.
  const corpus = buildCorpus([...works.values()]);
  report.corpusSize = corpus.works.length;

  for (const event of pending) {
    const bookId = String(event.sourceBookId);
    if (links.has(bookId)) continue;
    const candidates = corpusCandidates(corpus, event.title);
    if (candidates.length === 0) {
      report.unmatched++;
      continue;
    }
    const best = bestCandidate(event, candidates);
    if (!best) {
      report.unmatched++;
      continue;
    }
    if (best.ambiguous) {
      report.ambiguous++;
      bookCache.appendMatchLog({
        ts: now,
        source: 'livelib',
        livelibBookId: bookId,
        query: event.title,
        decision: 'ambiguous',
        score: best.score,
        evidence: best.evidence,
        candidates: candidates.slice(0, 5).map((work) => work.hcWorkId),
      });
      continue;
    }
    const workId = `hc:${best.candidate.hcWorkId}`;
    const link = {
      schemaVersion: 1,
      livelibBookId: bookId,
      workId,
      method: best.method,
      score: best.score,
      evidence: best.evidence,
      resolvedAt: now,
    };
    links.set(bookId, link);
    report.resolvedTitle++;
    if (best.method !== 'title-author-year') {
      bookCache.appendMatchLog({
        ts: now,
        source: 'livelib',
        livelibBookId: bookId,
        query: event.title,
        candidateId: best.candidate.hcWorkId,
        score: best.score,
        titleSim: best.evidence.titleSim,
        authorHit: best.evidence.authorHit,
        yearDelta: best.evidence.yearDelta,
        ratingsCount: best.evidence.ratingsCount,
        decision: 'match',
      });
    }
  }

  // 4. Persist links + index + links.json.
  for (const [bookId, link] of links) {
    const previous = bookCache.getLink(bookId);
    if (previous && previous.workId === link.workId && !force) continue;
    await bookCache.saveLink(bookId, link);
    bookCache.setIndexValue(`ll:${bookId}`, link.workId ? Number(link.workId.replace('hc:', '')) : false);
    if (link.method === 'isbn' && link.evidence && link.evidence.isbn) {
      bookCache.setIndexValue(`isbn:${link.evidence.isbn}`, Number(link.workId.replace('hc:', '')));
    }
    bookCache.setWorkLink(link.workId, { livelib: [bookId] });
    report.methods[link.method] = (report.methods[link.method] || 0) + 1;
  }
  bookCache.flushIndex();
  bookCache.flushLinks();

  report.resolvedWorkIds = new Set(
    [...links.values()].filter((link) => link.workId).map((link) => link.workId)
  ).size;
  report.resolved = report.cached + report.resolvedIsbn + report.resolvedTitle;

  if (onProgress) {
    onProgress({ stage: 'resolve', resolved: report.resolved, total: report.total });
  }
  console.log(
    `[resolve] ${report.resolved}/${report.total} livelib event(s) resolved ` +
      `(cached=${report.cached}, isbn=${report.resolvedIsbn}, title=${report.resolvedTitle}, ` +
      `ambiguous=${report.ambiguous}, unmatched=${report.unmatched}, requests=${report.requests})`
  );
  return report;
}

module.exports = {
  AUTHOR_ALIASES,
  ISBN_BATCH_SIZE,
  normalizeTitle,
  tokensOf,
  tokenJaccard,
  surnameOf,
  authorKeySet,
  authorsOverlap,
  normalizeIsbn,
  isbn10to13,
  isbn10Of,
  positionOf,
  guardReject,
  scoreCandidate,
  bestCandidate,
  buildCorpus,
  lookupIsbns,
  resolveProfile,
  listDetailsFiles,
};
