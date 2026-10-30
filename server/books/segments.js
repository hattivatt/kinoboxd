'use strict';

/**
 * Collection / omnibus titles -> separate works (S9 heuristic).
 *
 * Ported verbatim from `hc-migrate/lib/segment.js` (the reference
 * implementation, `СБОРНИКИ-ЭВРИСТИКА.md`). LiveLib carries an
 * anthology/omnibus row as ONE record whose title concatenates the publisher's
 * catalogue line, the volume marker and the actual works:
 *
 *   «Американская фантастика. Комплект из 14 томов. Том 8. Планета изгнания.
 *    Слово для «леса» и «мира» одно. Рассказы (сборник)»
 *
 * The row is unmatchable as a whole while each work inside is a normal book.
 * The module does exactly two things:
 *
 *   1. `parseCollectionTitle()` — a *conservative* splitter: split on `. `
 *      (period + space) only, drop publisher/volume/qualifier junk, detect the
 *      catalogue line, and return `works` only when at least TWO real works
 *      remain. One work after junk removal is an ordinary book (e.g. «Кафе
 *      "Таро". Том 4») and is left alone. A row is only split when it carries a
 *      structural marker (`editionMarker || qualifier || tail_genre`, §2.3).
 *   2. `segmentEventsOf()` — per-work synthetic events for the resolve chain
 *      and the stats payload. The parent record stays the host row: its title,
 *      its keys and its identity are never rewritten (§5.1/§5.2 of the spec).
 *
 * Boundaries (§6 of `СБОРНИКИ-ЭВРИСТИКА.md`, not negotiable):
 *   - no marker -> one book, even when the title contains `. `;
 *   - a volume marker in the middle with <= 1 content segment after it -> one
 *     book (the subtitle of that volume);
 *   - a segment without an author is never searched (no blind title search):
 *     the provider author gate is what stops false positives;
 *   - the anthology's rating is NOT spread over its works (`rating: null`);
 *   - the date is inherited from the parent (month precision included);
 *   - the catalogue line is not a work (`catalogSeries`, never in `works`).
 */

const crypto = require('crypto');

const { cleanText, normalizeTitle } = require('./normalize');
const { namesLookAlike } = require('./authors');

/** Resolve-link confidence that counts as a confirmed segment (high). */
const SEGMENT_HIGH_SCORE = 0.9;
/** `medium` links (fuzzy title+author, 0.7..0.9) need an explicit opt-in. */
const SEGMENT_MEDIUM_SCORE = 0.7;

/* ------------------------------------------------------------------ */
/* Title splitting                                                     */
/* ------------------------------------------------------------------ */

/**
 * Split a raw title on `. ` only.
 *
 * Deliberately NOT a regex split: `Р.И.К.` / `Дж. Р. Р. Толкин` / `Eyeshield 21,
 * Vol. 2` must survive. A period is a separator when it is followed by
 * whitespace and is not the period of an initial (`Дж.`, `Р.`) or of a known
 * abbreviation (`Vol.`, `т.`, `г.`).
 */
const NO_SPLIT_TOKENS = new Set([
  'vol', 'volume', 'tome', 'tom', 'part', 'book', 'band', 'no',
  'т', 'тт', 'кн', 'г', 'гг', 'стр', 'им', 'др', 'пр',
  'англ', 'нем', 'фр', 'лат', 'рус',
]);

function splitTitleSegments(rawTitle) {
  const text = cleanText(rawTitle);
  if (!text) return [];
  const parts = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '.') continue;
    const next = text[index + 1];
    if (next !== ' ' && next !== '\u00a0') continue;
    const candidate = text.slice(start, index).trim();
    const words = candidate.split(/\s+/).filter(Boolean);
    const lastWord = words.length ? words[words.length - 1] : '';
    // Initial: `Дж.`, `Р.` — a one-letter word, or a bare `Дж`-style digraph.
    if (/^\p{Lu}$/u.test(lastWord)) continue;
    if (words.length === 1 && lastWord.length <= 2 && /^\p{Lu}\p{Ll}?$/u.test(lastWord)) continue;
    if (NO_SPLIT_TOKENS.has(lastWord.toLowerCase())) continue;
    parts.push(text.slice(start, index));
    start = index + 1;
  }
  parts.push(text.slice(start));
  return parts.map((part) => cleanText(part)).filter(Boolean);
}

const QUALIFIER_RE = /^(.*?)\s*\((сборник(?:и| рассказов| повестей)?)\)\s*$/i;

const VOLUME_RE = /^(?:том|т\.|книг[аеу]?|книги|часть)\s*\.?\s*\d/i;
const EDITION_BLOCK_RE = /^в\s+[^\s.]+\s+(?:томах|книгах)$/i;
const COMPLETE_SET_RE = /^комплект(?:\s|$)/i;
const ALL_VOLUMES_RE = /^все\s+\d+\s+том(?:а|ов)?$/i;

const JUNK_RES = [
  COMPLETE_SET_RE,
  EDITION_BLOCK_RE,
  ALL_VOLUMES_RE,
  VOLUME_RE,
  /^роман\s+в\s+\S+\s+книгах$/i,
  /^собрани[ея]\s+сочинений(?:\s|$)/i,
  /^сочинения$/i,
  /^вошедшие\s+части\b/i,
  /^составител/i,
  /^сост\./i,
  /^под\s+редакцией/i,
  /^ред\./i,
  /^\(?сборник[^)]*\)?$/i,
];

/** Segments that are just a genre word are junk only in the trailing position. */
const TAIL_GENRE_RE = /^(?:рассказы|повести|стихотворения|сказки|пьесы|эссе)$/i;

/** «Том 8», «Книга 2», «В четырёх томах», «Комплект из 14 томов». */
function isEditionMarker(segmentText) {
  const text = cleanText(segmentText);
  if (!text) return false;
  return (
    VOLUME_RE.test(text) ||
    EDITION_BLOCK_RE.test(text) ||
    COMPLETE_SET_RE.test(text) ||
    ALL_VOLUMES_RE.test(text)
  );
}

function classifySegment(segment) {
  const text = cleanText(segment);
  const qualifier = QUALIFIER_RE.exec(text);
  const body = qualifier ? cleanText(qualifier[1]) : text;
  if (!body) {
    return {
      text,
      body,
      kind: 'junk',
      junkReasons: ['qualifier'],
      qualifier: Boolean(qualifier),
      editionMarker: false,
    };
  }
  const junkReasons = [];
  if (JUNK_RES.some((re) => re.test(body))) junkReasons.push('publisher');
  if (qualifier && TAIL_GENRE_RE.test(body)) junkReasons.push('tail_genre');
  return {
    text,
    body,
    kind: junkReasons.length ? 'junk' : 'content',
    junkReasons,
    // A trailing «(сборник)» is edition metadata; the body stays a work title.
    qualifier: Boolean(qualifier),
    editionMarker: isEditionMarker(body),
  };
}

/**
 * Frequency of the first content segment across many raw titles. The catalogue
 * line («Наруто», «Кафе "Таро"», «Библиотека современной фантастики») repeats at
 * the head of several rows; a one-off first segment is just the first work.
 *
 * @param {string[]} rawTitles
 * @returns {Map<string, number>} normalized first segment -> count
 */
function firstSegmentCounts(rawTitles) {
  const counts = new Map();
  for (const title of rawTitles || []) {
    const segments = splitTitleSegments(title).map(classifySegment);
    const first = segments.find((segment) => segment.kind === 'content');
    if (!first) continue;
    const key = normalizeTitle(first.body);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/**
 * Parse one raw title into a possible multi-work collection.
 *
 * @param {string} rawTitle
 * @param {{firstCounts?: Map<string,number>|null, catalogMin?: number}} [options]
 */
function parseCollectionTitle(rawTitle, { firstCounts = null, catalogMin = 3 } = {}) {
  const raw = cleanText(rawTitle);
  const rawSegments = splitTitleSegments(raw);
  const segments = rawSegments.map((text, index) => ({ ...classifySegment(text), index }));

  const junk = segments
    .filter((segment) => segment.kind === 'junk')
    .map((segment) => ({ text: segment.text, index: segment.index, reasons: segment.junkReasons }));

  const content = segments.filter((segment) => segment.kind === 'content');
  const result = (works, catalog) => ({
    raw,
    rawSegments,
    catalog,
    works,
    junk,
    isCollection: works.length >= 2,
  });

  if (!content.length) return result([], null);

  // Multi-work splitting needs structural evidence that the row really is an
  // anthology/omnibus: a volume/edition marker or a collection qualifier.
  // Without it «Дьюи. Кот из библиотеки, который потряс весь мир» or
  // «Геймдизайн. Рецепты успеха…» are one book with a subtitle, not two works.
  const hasCollectionMarker = segments.some(
    (segment) =>
      segment.editionMarker ||
      segment.qualifier ||
      segment.junkReasons.includes('tail_genre')
  );
  if (!hasCollectionMarker) {
    return result([{ title: content[0].body, index: content[0].index }], null);
  }

  const markerIndexes = segments
    .filter((segment) => segment.editionMarker)
    .map((segment) => segment.index);
  const lastMarker = markerIndexes.length ? markerIndexes[markerIndexes.length - 1] : null;

  // «Серия. Том N. Подзаголовок тома»: a volume marker *between* two content
  // segments and a single content segment after it is one book (the subtitle),
  // not a collection. Same for «У Понта Эвксинского. В двух томах. Том 1».
  if (lastMarker != null && lastMarker > 0) {
    const after = content.filter((segment) => segment.index > lastMarker);
    if (after.length <= 1) {
      return result([{ title: content[0].body, index: content[0].index }], null);
    }
  }

  let catalog = null;
  const first = content[0];
  if (content.length >= 2) {
    const key = normalizeTitle(first.body);
    const repeats = firstCounts && key ? Number(firstCounts.get(key) || 0) : 0;
    const firstMarker = markerIndexes.length ? markerIndexes[0] : null;
    const followedByMarker = firstMarker != null && firstMarker > first.index;
    const catalogCandidate = followedByMarker || repeats >= catalogMin;
    if (catalogCandidate && content.length >= 3) {
      // Dropping the catalogue line must leave at least two works.
      catalog = first.body;
    }
  }

  const works = (catalog ? content.slice(1) : content).map((segment) => ({
    title: segment.body,
    index: segment.index,
  }));

  // A single work after junk removal is an ordinary book.
  if (works.length < 2) {
    return result([{ title: content[0].body, index: content[0].index }], null);
  }
  return result(works, catalog);
}

/* ------------------------------------------------------------------ */
/* Segment identity                                                    */
/* ------------------------------------------------------------------ */

/** Stable per-work key (survives a re-import and a title re-export). */
function segmentKeyOf(title) {
  const normalized = normalizeTitle(title);
  if (!normalized) return null;
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 10);
}

/**
 * Parse a record title into the additive fields of the profile event:
 * `segmentTitles` (display/audit), `collectionSegments` (title + stable key)
 * and `catalogSeries`. Returns null for an ordinary book, so nothing is added
 * to the event (the payload/keys stay byte-identical for 97% of the rows).
 */
function collectionFieldsOf(title, options = {}) {
  const parsed = parseCollectionTitle(title, options);
  if (!parsed.isCollection) return null;
  const collectionSegments = parsed.works
    .map((work) => ({ title: work.title, key: segmentKeyOf(work.title), index: work.index }))
    .filter((segment) => segment.key);
  if (collectionSegments.length < 2) return null;
  const fields = {
    segmentTitles: collectionSegments.map((segment) => segment.title),
    collectionSegments,
  };
  if (parsed.catalog) fields.catalogSeries = parsed.catalog;
  return fields;
}

/** Does this event carry >= 2 parsed works? */
function hasCollectionSegments(event) {
  return Boolean(
    event &&
      Array.isArray(event.collectionSegments) &&
      event.collectionSegments.length >= 2 &&
      event.collectionSegments.every((segment) => segment && cleanText(segment.title))
  );
}

/** Resolve-cache identity of a segment (never the parent's own id). */
function segmentFileKeyOf(parentEvent, segmentKey) {
  if (!parentEvent || !segmentKey) return null;
  const base = parentEvent.fileKey
    ? String(parentEvent.fileKey)
    : parentEvent.sourceBookId
      ? `id:${parentEvent.sourceBookId}`
      : parentEvent.id
        ? String(parentEvent.id)
        : null;
  return base ? `${base}::seg:${segmentKey}` : null;
}

/** Candidate manual-year-override keys of a record (the user's edit wins). */
function manualYearKeysOf(event) {
  if (!event) return [];
  const keys = [];
  const push = (value) => {
    const key = value == null ? '' : String(value);
    if (key && !keys.includes(key)) keys.push(key);
  };
  push(event.workId);
  if (event.sourceBookId) {
    push(`ll:${event.sourceBookId}`);
    push(String(event.sourceBookId));
  }
  if (event.fileKey) {
    push(`file:${event.fileKey}`);
    push(`ll:file:${event.fileKey}`);
  }
  if (event.id) {
    push(`ll:${event.id}`);
  }
  return keys;
}

/**
 * Existing links / enrichment / manual year corrections are stronger than the
 * segmentation heuristic: a row already decided as ONE book is never re-opened
 * (§6, "не переоткрывать решения пользователя").
 *
 * @param {object} event profile record
 * @param {{link?: object|null, details?: object|null, yearOverrides?: object|null}} context
 */
function expansionBlocked(event, { link = null, details = null, yearOverrides = null } = {}) {
  if (!hasCollectionSegments(event)) return true;
  if (link && link.workId) return true;
  if (details) return true;
  if (yearOverrides && typeof yearOverrides === 'object') {
    for (const key of manualYearKeysOf(event)) {
      if (Object.prototype.hasOwnProperty.call(yearOverrides, key)) return true;
    }
  }
  return false;
}

/**
 * Synthetic per-work events of one collection record.
 *
 * The parent record is NOT included: it stays the host row (`title`, keys,
 * rating, date) and is never matched as a whole. A segment inherits the
 * parent's authors (the anthology's author is the works' author) and its date,
 * but NOT the anthology rating, ISBN, publisher, series, cover or year.
 */
function segmentEventsOf(parentEvent) {
  if (!hasCollectionSegments(parentEvent)) return [];
  const out = [];
  for (const segment of parentEvent.collectionSegments) {
    const title = cleanText(segment.title);
    const key = cleanText(segment.key) || segmentKeyOf(title);
    if (!title || !key) continue;
    const fileKey = segmentFileKeyOf(parentEvent, key);
    out.push({
      id: `${parentEvent.id || parentEvent.fileKey || 'row'}::seg:${key}`,
      fileKey,
      source: parentEvent.source || 'livelib',
      origin: parentEvent.origin || parentEvent.source || 'livelib',
      userKey: parentEvent.userKey || null,
      sourceBookId: null,
      sourceUrl: null,
      workId: null,
      title,
      authors: Array.isArray(parentEvent.authors) ? [...parentEvent.authors] : [],
      rating: null,
      ratingScale: null,
      rating10: null,
      status: parentEvent.status || 'read',
      shelf: parentEvent.shelf || null,
      startedAt: parentEvent.startedAt || null,
      startMonth: parentEvent.startMonth || null,
      finishedAt: parentEvent.finishedAt || null,
      readMonth: parentEvent.readMonth || null,
      readDateRaw: parentEvent.readDateRaw || null,
      reread: false,
      readIndex: 1,
      edition: {},
      genres: [],
      coverUrl: null,
      communityRating: null,
      bookStats: null,
      segmentKey: key,
      // Host identity for the candidate pool (is the row itself a visible
      // work? then its unproven works are worth asking about).
      collectionParentKey: parentEvent.sourceBookId
        ? String(parentEvent.sourceBookId)
        : parentEvent.fileKey
          ? `file:${parentEvent.fileKey}`
          : parentEvent.id
            ? String(parentEvent.id)
            : null,
      collectionParent: {
        workId: parentEvent.workId || null,
        title: parentEvent.title || null,
        catalogSeries: parentEvent.catalogSeries || null,
        parentUrl: parentEvent.sourceUrl || null,
      },
    });
  }
  return out.length >= 2 ? out : [];
}

/**
 * Expand a record list for the resolve pool / candidate pool: a collection
 * record is replaced by its works, every other row is passed through.
 */
function expandProfileEvents(events, options = {}) {
  const out = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event) continue;
    const segments = segmentEventsOf(event);
    if (segments.length && !(typeof options.canExpand === 'function' && !options.canExpand(event))) {
      out.push(...segments);
    } else {
      out.push(event);
    }
  }
  return out;
}

/** Author gate shared with the migration: any record author must look alike. */
function segmentAuthorConfirmed(recordAuthors, providerAuthors) {
  const ours = (recordAuthors || []).map(cleanText).filter(Boolean);
  const theirs = (providerAuthors || []).map(cleanText).filter(Boolean);
  for (const left of ours) {
    for (const right of theirs) {
      if (namesLookAlike(left, right)) return true;
    }
  }
  return false;
}

/** Confidence class of a resolve link for a segment. */
function segmentConfidenceOf(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return 'low';
  if (value >= SEGMENT_HIGH_SCORE) return 'high';
  if (value >= SEGMENT_MEDIUM_SCORE) return 'medium';
  return 'low';
}

module.exports = {
  SEGMENT_HIGH_SCORE,
  SEGMENT_MEDIUM_SCORE,
  NO_SPLIT_TOKENS,
  QUALIFIER_RE,
  VOLUME_RE,
  EDITION_BLOCK_RE,
  COMPLETE_SET_RE,
  ALL_VOLUMES_RE,
  JUNK_RES,
  TAIL_GENRE_RE,
  splitTitleSegments,
  isEditionMarker,
  firstSegmentCounts,
  parseCollectionTitle,
  segmentKeyOf,
  collectionFieldsOf,
  hasCollectionSegments,
  segmentFileKeyOf,
  manualYearKeysOf,
  expansionBlocked,
  segmentEventsOf,
  expandProfileEvents,
  segmentAuthorConfirmed,
  segmentConfidenceOf,
};
