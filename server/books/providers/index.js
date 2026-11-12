'use strict';

/**
 * Metadata provider registry + normalisation/merge helpers.
 *
 * Normalized result (one book, one provider, later merged):
 *   {
 *     source, sourceId, title, authors: [names], year, publisher,
 *     series: {name, position}|null, genres: [names], pages,
 *     isbn13, isbn10, cover, links: {pageUrl}, language,
 *     confidence: 0..1, match: {method,...}, mangaComics: true|false|null
 *   }
 *
 * Merge rule: the *primary* provider keeps content fields (Hardcover is the
 * canonical work namespace when present), missing pages/cover/year/publisher
 * are filled from the extras; `metadataSources` lists every contributor.
 */

const hardcover = require('./hardcover');
const litres = require('./litres');
const googlebooks = require('./googlebooks');
const openlibrary = require('./openlibrary');
const livelibCard = require('./livelib-card');
const wikidata = require('./wikidata');
const { detectManga } = require('./manga');
const { seriesEntryOf, seriesEntriesOf, seriesKeyOf } = require('./series-name');
const {
  firstYearOf,
  earliestFirstYear,
  earliestFirstClaim,
  claimOf,
  saneFirstYearClaim,
  mergedFirstClaim,
  precisionOf,
  kindOf,
  PRECISIONS,
  PRECISION_RANK,
  KINDS,
} = require('./claim');

const REGISTRY = {
  hardcover,
  litres,
  googlebooks,
  openlibrary,
  wikidata,
  'livelib-card': livelibCard,
};

/**
 * Provider order for *content* (title, authors, genres, cover).
 *
 * `wikidata` is last on purpose: it is a year-only source (no ISBN, no pages,
 * no genres), so it must never become the primary result of a resolve. The
 * resolve chain never calls it either — `resolve-stages/year-stage.js` and
 * `years-backfill.js` ask it separately, batched, for the year claim only.
 */
const PRIORITY = ['hardcover', 'litres', 'googlebooks', 'openlibrary', 'wikidata', 'livelib-card'];

function listProviders() {
  return PRIORITY.map((name) => REGISTRY[name]);
}

function getProvider(name) {
  return REGISTRY[name] || null;
}

function providerNames() {
  return [...PRIORITY];
}

/** Resolve an explicit provider list (names or modules); default = all. */
function selectProviders(requested) {
  if (requested == null) return listProviders();
  const names = Array.isArray(requested) ? requested : [requested];
  const selected = [];
  for (const entry of names) {
    if (entry == null) continue;
    if (typeof entry === 'string') {
      const provider = getProvider(entry);
      if (provider) selected.push(provider);
      continue;
    }
    if (typeof entry.getWork === 'function') selected.push(entry);
  }
  return selected;
}

function firstValue(primary, extras, field) {
  if (primary && primary[field] != null && primary[field] !== '') return primary[field];
  for (const extra of extras) {
    if (extra && extra[field] != null && extra[field] !== '') return extra[field];
  }
  return null;
}

/** First-publication claim rules live in their own module (see `claim.js`). */
function firstList(primary, extras, field) {
  if (primary && Array.isArray(primary[field]) && primary[field].length) return [...primary[field]];
  for (const extra of extras) {
    if (extra && Array.isArray(extra[field]) && extra[field].length) return [...extra[field]];
  }
  return [];
}

function seriesListOf(entry) {
  if (!entry) return [];
  const all = seriesEntriesOf(entry.seriesAll);
  if (entry.series) {
    const single = seriesEntryOf(entry.series);
    if (single) all.push(single);
  }
  return all;
}

function mergeSeriesEntries(entries) {
  const out = [];
  const index = new Map();
  for (const entry of entries) {
    const key = seriesKeyOf(entry.name);
    if (!key) continue;
    if (!index.has(key)) {
      index.set(key, out.length);
      out.push(entry);
      continue;
    }
    const current = out[index.get(key)];
    if (current.position == null && entry.position != null) current.position = entry.position;
    if (current.hcId == null && entry.hcId != null) current.hcId = entry.hcId;
  }
  return out;
}

function mergedSeries(entries) {
  return mergeSeriesEntries(entries.flatMap(seriesListOf));
}

function detailSeriesOf(result) {
  return mergeSeriesEntries(seriesListOf(result)).map((entry) => ({
    hcId: entry.hcId == null ? null : entry.hcId,
    name: entry.name || null,
    position: entry.position == null ? null : Number(entry.position),
    ...(entry.source ? { source: String(entry.source) } : {}),
  }));
}

function mergedManga(entries) {
  if (entries.some((entry) => entry && entry.mangaComics === true)) return true;
  if (entries.some((entry) => entry && entry.mangaComics === false)) return false;
  return null;
}

/** Union of every provider's detection corpus (subjects/categories/tags/…). */
function mergedMangaTexts(entries) {
  const out = [];
  for (const entry of entries) {
    for (const value of Array.isArray(entry && entry.mangaTexts) ? entry.mangaTexts : []) {
      const text = String(value == null ? '' : value).trim();
      if (text && !out.includes(text)) out.push(text);
    }
  }
  return out;
}

/**
 * Merge a primary result with enrichment results (no extra requests; used when
 * a LiveLib card identifies a book that Hardcover/Google/OL also knows).
 */
function mergeResults(primary, extras = []) {
  if (!primary) return null;
  const others = extras.filter((entry) => entry && entry.source !== primary.source);
  const sources = [];
  for (const entry of [primary, ...others]) {
    if (!entry || !entry.source) continue;
    if (!sources.some((value) => value.source === entry.source && value.sourceId === entry.sourceId)) {
      sources.push({
        source: entry.source,
        sourceId: entry.sourceId == null ? null : String(entry.sourceId),
        url: (entry.links && entry.links.pageUrl) || null,
        confidence: entry.confidence == null ? null : Number(entry.confidence),
      });
    }
  }
  const mangaTexts = mergedMangaTexts([primary, ...others]);
  const genres = firstList(primary, others, 'genres');
  // A clean primary plus a comics signal in an extra's subject list must not
  // stay `false`: re-run the detector over the merged corpus.
  const detectedManga = detectManga({ genres, texts: mangaTexts });
  const year = firstValue(primary, others, 'year');
  // Work-level first publication, not the edition in hand (see
  // `earliestFirstClaim`): the year chart uses this and nothing else. The
  // claim travels with its precision and kind so an ancient work can be
  // rendered as a century instead of a fake exact year.
  const firstClaim = mergedFirstClaim([primary, ...others], year);
  return {
    source: primary.source,
    sourceId: primary.sourceId == null ? null : String(primary.sourceId),
    workId: primary.workId || `${primary.source}:${primary.sourceId}`,
    title: firstValue(primary, others, 'title'),
    authors: firstList(primary, others, 'authors'),
    year,
    firstPublishedYear: firstClaim ? firstClaim.year : null,
    firstPublishedYearPrecision: firstClaim ? firstClaim.precision : null,
    firstPublishedYearKind: firstClaim ? firstClaim.kind : null,
    publisher: firstValue(primary, others, 'publisher'),
    series: firstValue(primary, others, 'series'),
    seriesAll: mergedSeries([primary, ...others]),
    genres,
    pages: firstValue(primary, others, 'pages'),
    isbn13: firstValue(primary, others, 'isbn13'),
    isbn10: firstValue(primary, others, 'isbn10'),
    cover: firstValue(primary, others, 'cover'),
    language: firstValue(primary, others, 'language'),
    links: (primary.links && primary.links.pageUrl ? primary.links : others.find((entry) => entry.links && entry.links.pageUrl)?.links) || {},
    confidence: Math.max(
      Number(primary.confidence) || 0,
      ...others.map((entry) => Number(entry.confidence) || 0)
    ),
    match: primary.match || null,
    mangaComics:
      detectedManga === true ? true : mergedManga([primary, ...others]),
    mangaTexts,
    metadataSources: [...new Set(sources.map((entry) => entry.source))],
    sources,
    hardcover: primary.hardcover || others.find((entry) => entry.hardcover)?.hardcover || null,
  };
}

/** Build a cache details document (schema 2) from a merged provider result. */
function resultToDetails(result, options = {}) {
  if (!result) return null;
  const workId = result.workId || `${result.source}:${result.sourceId}`;
  const authors = (result.authors || [])
    .filter(Boolean)
    .map((name) => {
      if (name && typeof name === 'object') {
        return {
          name: name.name ? String(name.name) : '',
          ...(name.hcId != null ? { hcId: name.hcId } : {}),
        };
      }
      return { name: String(name) };
    })
    .filter((author) => author.name);
  const series = detailSeriesOf(result);
  const doc = {
    schemaVersion: 2,
    workId,
    title: result.title || null,
    authors,
    series,
    genres: Array.isArray(result.genres) ? [...result.genres] : [],
    pages:
      result.pages == null || result.pages === ''
        ? null
        : Number.isFinite(Number(result.pages))
        ? Number(result.pages)
        : null,
    publicationYear:
      result.year == null || result.year === ''
        ? null
        : Number.isFinite(Number(result.year))
        ? Number(result.year)
        : null,
    // Work-level first publication (year chart), distinct from the edition
    // year above. Providers fill it when they know it (Hardcover work release,
    // Open Library first_publish_year, Литрес date_written_at, Wikidata P577/P571)
    // together with the precision of that claim and the statement it comes
    // from; an absent precision means an exact print year.
    firstPublishedYear:
      result.firstPublishedYear == null || result.firstPublishedYear === ''
        ? null
        : Number.isFinite(Number(result.firstPublishedYear))
        ? Number(result.firstPublishedYear)
        : null,
    firstPublishedYearPrecision:
      result.firstPublishedYear == null ? null : precisionOf(result.firstPublishedYearPrecision),
    firstPublishedYearKind:
      result.firstPublishedYear == null ? null : kindOf(result.firstPublishedYearKind),
    isbn13: result.isbn13 || null,
    isbn10: result.isbn10 || null,
    publisher: result.publisher || null,
    editionLanguage: result.language || null,
    coverUrl: result.cover || null,
    mangaComics: result.mangaComics == null ? null : Boolean(result.mangaComics),
    // Flattened text corpus for re-detection at stats-read time. It keeps OL
    // subjects / HC taggings that never became display `genres`.
    mangaTexts: Array.isArray(result.mangaTexts) ? [...result.mangaTexts] : [],
    metadataSources: Array.isArray(result.metadataSources)
      ? [...result.metadataSources]
      : [result.source],
    sources: Array.isArray(result.sources)
      ? result.sources.map((entry) => ({ ...entry }))
      : [
          {
            source: result.source,
            sourceId: result.sourceId == null ? null : String(result.sourceId),
            url: (result.links && result.links.pageUrl) || null,
            confidence: result.confidence == null ? null : Number(result.confidence),
          },
        ],
    links: result.links || {},
    partial: false,
    fetchedAt: options.now || new Date().toISOString(),
  };
  if (result.hardcover && result.hardcover.hcWorkId) {
    doc.hcWorkId = Number(result.hardcover.hcWorkId);
    doc.hcEditionId = result.hardcover.hcEditionId == null ? null : Number(result.hardcover.hcEditionId);
    doc.slug = result.hardcover.slug || null;
    doc.rating = result.hardcover.rating == null ? null : Number(result.hardcover.rating);
    doc.ratingsCount =
      result.hardcover.ratingsCount == null ? null : Number(result.hardcover.ratingsCount);
  }
  return doc;
}

module.exports = {
  REGISTRY,
  PRIORITY,
  listProviders,
  providerNames,
  getProvider,
  selectProviders,
  mergeResults,
  mergedManga,
  mergedMangaTexts,
  resultToDetails,
  firstYearOf,
  earliestFirstYear,
  earliestFirstClaim,
  claimOf,
  saneFirstYearClaim,
  mergedFirstClaim,
  precisionOf,
  kindOf,
  PRECISIONS,
  KINDS,
  PRECISION_RANK,
};
