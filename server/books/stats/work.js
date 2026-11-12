'use strict';

/**
 * Work metadata of the books stats payload: authors/genres/series of one work,
 * the manga/comics flag, the year block, links and the cross-source work
 * dedupe that merges one book seen under several ids.
 *
 * R12 «god module» split: moved out of `books/stats.js` unchanged.
 */

const bookCache = require('../book-cache');
const { getSeriesOverrides, findSeriesOverride } = require('../series-overrides');
const { filterBlacklistedSeries } = require('../series-blacklist');
const { surnameOf, strictTitleKey } = require('../normalize');
const { detectManga } = require('../providers/manga');
const { FILE_METADATA_SOURCE } = require('./constants');
const {
  nameKeyOf,
  metadataSourcesOf,
  mergeSeriesLists,
  fileMetadataOf,
  filterDetailsSeries,
} = require('./series');
const { resolveWorkYear, yearOverrideKeysOf, findYearOverride } = require('./years');

function detailsAuthors(details) {
  if (!details || !Array.isArray(details.authors)) return [];
  const names = [];
  for (const author of details.authors) {
    const name = author && typeof author === 'object' ? author.name : author;
    if (name && !names.includes(String(name))) names.push(String(name));
  }
  return names;
}

/**
 * Union of the metadata chain's genres and the file columns' genres.
 *
 * They are not the same vocabulary: Литрес calls a book «Зарубежное фэнтези»,
 * the export says «фэнтези», Hardcover says «Fantasy». The previous rule
 * (`details.genres` wins, else file) silently dropped what the user's own
 * export said the moment the chain resolved the work. Union keeps both, deduped
 * by normalized name; the chain's labels come first, so a donut still has one
 * entry per concept when the labels match.
 */
function mergeGenreLists(primary, extra) {
  const out = [];
  const seen = new Set();
  for (const list of [primary, extra]) {
    for (const name of Array.isArray(list) ? list : []) {
      const clean = String(name == null ? '' : name).trim();
      const key = nameKeyOf(clean);
      if (!clean || !key || seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
    }
  }
  return out;
}

/**
 * Effective manga/comics flag for one work.
 *
 * The detector is re-run on every read over the full persisted corpus
 * (`mangaTexts`, `tags`) instead of trusting a stale `details.mangaComics`
 * boolean: a cache written before the detector learned new keywords/publishers
 * must start filtering without a full re-import. The stored boolean stays as an
 * additive `true` (a provider may have known a signal we cannot reconstruct)
 * and as the fallback when the current corpus has no classification fields.
 *
 * `fileMeta` (§3.3.2) is a second, independent signal source. A
 * `livelib-backup` file export carries «Жанры»/«Серия»/«Издатель» on the event
 * itself; without it a file-imported profile has no details document at all,
 * so the flag used to be `null` and manga/comics leaked into the statistics.
 * Both corpora are consulted (details *and* file) and `true` wins, because a
 * provider tag on one volume is as valid as a file genre on another: the
 * detector is deliberately greedy and the user can always restore a work with
 * a manual `false` (§5, `POST /api/books/work/flag`).
 */
function mangaOfDetails(details, genres, series, publisher, fileMeta) {
  const sources = [{
    genres,
    tags: details && Array.isArray(details.tags) ? details.tags : [],
    texts: details && Array.isArray(details.mangaTexts) ? details.mangaTexts : [],
    series,
    publisher,
  }];
  if (fileMeta && fileMeta.present) {
    sources.push({
      genres: fileMeta.genres,
      series: fileMeta.series.map((entry) => entry.name),
      publisher: fileMeta.publisher,
    });
  }

  let clean = false;
  for (const input of sources) {
    const detected = detectManga(input);
    if (detected === true) return true;
    if (detected === false) clean = true;
  }
  // A stored provider `true` is additive: it survives a clean re-detection.
  if (details && details.mangaComics === true) return true;
  if (clean) return false;
  return details && typeof details.mangaComics === 'boolean' ? details.mangaComics : null;
}

function workMetadata(workId, events, options = {}) {
  const hcEvents = events.filter((event) => event.source === 'hardcover');
  const llEvents = events.filter((event) => event.source === 'livelib');
  // Volumes of one work share `metadataWorkId`; the book identity `workId` may
  // carry a `#n` suffix that no details file knows about.
  const metadataWorkId = (events.find((event) => event.metadataWorkId) || {}).metadataWorkId || workId;
  const details = bookCache.getWorkDetails(metadataWorkId);
  // Bibliographic columns of a `livelib-backup` file export (genres,
  // publisher, series, language, ISBN) are already in the file, so a
  // file-imported profile does not have to wait for the metadata chain.
  const fileMeta = fileMetadataOf(events);

  const latest = (list, field) =>
    list.reduce((best, event) => laterDate(best, event[field]), null);

  // Hardcover priority for display fields; LiveLib is the fallback (§3.3.1).
  const hcWithRating = [...hcEvents]
    .filter((event) => event.rating10 != null)
    .sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')))[0];
  const llWithRating = [...llEvents]
    .filter((event) => event.rating10 != null)
    .sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')))[0];
  const displayEvent = hcWithRating || hcEvents[0] || llWithRating || llEvents[0] || null;

  const detailTitle = details && details.title ? details.title : null;
  const hcTitle = detailTitle || (hcEvents[0] && hcEvents[0].title) || null;
  const llTitle = (llEvents.find((event) => event.title) || {}).title || null;
  // A collection work remembers the record it came from, so the UI can say
  // «из сборника «X»» and link the parent page (СБОРНИКИ-ЭВРИСТИКА §5.1).
  const collection = (events.find((event) => event && event.collectionParent) || {}).collectionParent
    || null;

  const authors = [];
  const detailAuthors = detailsAuthors(details);
  if (detailAuthors.length) {
    for (const name of detailAuthors) authors.push(name);
  } else {
    for (const event of hcEvents.concat(llEvents)) {
      for (const name of event.authors || []) {
        if (name && !authors.includes(name)) authors.push(name);
      }
    }
  }

  const publisher =
    (details && details.publisher) ||
    (displayEvent && displayEvent.edition && displayEvent.edition.publisher) ||
    fileMeta.publisher ||
    null;
  const overrideKeys = yearOverrideKeysOf(workId, metadataWorkId, events);
  const yearOverride = findYearOverride(options.yearOverrides, overrideKeys);
  const yearInfo = resolveWorkYear(details, displayEvent, fileMeta, yearOverride);
  const year = yearInfo.year;
  const editionYear = yearInfo.editionYear;
  const editionYearSource = yearInfo.editionYearSource;
  const firstPublishedYear = yearInfo.firstPublishedYear;
  const firstPublishedYearSource = yearInfo.firstPublishedYearSource;
  const firstPublishedYearPrecision = yearInfo.firstPublishedYearPrecision;
  const firstPublishedYearKind = yearInfo.firstPublishedYearKind;
  const pages =
    details && details.pages != null && Number.isFinite(Number(details.pages)) && Number(details.pages) > 0
      ? Number(details.pages)
      : null;
  const genres = mergeGenreLists(
    details && Array.isArray(details.genres) ? details.genres : [],
    fileMeta.genres
  );
  const mergedSeries = mergeSeriesLists(
    filterDetailsSeries(details, fileMeta.series.map((entry) => entry.name)),
    fileMeta.series
  );
  // Catalogue tags («Книга на все времена») are not series (series-blacklist.js).
  // The filter runs on the merged list, *after* the file column has had its
  // say, so a tag that the user's own export carries is still dropped — and it
  // runs before counting/manga detection, so neither sees the tag.
  const seriesFilter = filterBlacklistedSeries(mergedSeries);
  const seriesOverride = findSeriesOverride(getSeriesOverrides(), overrideKeys);
  const series = seriesOverride
    ? seriesOverride.series.map((entry) => ({
        hcId: null,
        name: entry.name,
        position: entry.position == null ? null : entry.position,
      }))
    : seriesFilter.list;
  const coverUrl =
    (details && details.coverUrl) ||
    (displayEvent && displayEvent.coverUrl) ||
    null;

  const finishDates = events.map((event) => event.finishedAt).filter(Boolean);
  const finishedDate = finishDates.length
    ? finishDates.sort()[finishDates.length - 1]
    : null;

  // Link menu (§6.3): LiveLib is derivable for every work with an LL event or
  // an LL link in links.json; provider page URLs come from the details doc.
  const links = {};
  const llSourceId = String(metadataWorkId).startsWith('ll:') ? String(metadataWorkId).slice(3) : null;
  // Only a real LiveLib book id makes a LiveLib URL; a file-keyed stub
  // (`ll:file:tk:<sha1>`) is an internal identity, not a page. A file row may
  // know its own id even when the resolve link is a HardCover work.
  const llBookId = (events.find((event) => event.sourceBookId) || {}).sourceBookId || llSourceId;
  if (llBookId && /^\d+$/.test(String(llBookId))) {
    links.livelib = `https://www.livelib.ru/book/${llBookId}`;
  }
  if (String(metadataWorkId).startsWith('hc:')) {
    const workLink = bookCache.getWorkLink(metadataWorkId);
    const llId = workLink && Array.isArray(workLink.livelib)
      ? workLink.livelib.map(String).find(Boolean)
      : null;
    if (llId && !links.livelib) links.livelib = `https://www.livelib.ru/book/${llId}`;
  }
  if (details) {
    const providerLinks = Array.isArray(details.sources) ? details.sources : [];
    for (const entry of providerLinks) {
      if (!entry || !entry.url) continue;
      const key = entry.source === 'livelib-card' ? 'livelib' : entry.source;
      if (!links[key]) links[key] = entry.url;
    }
    if (details.slug && !links.hardcover) {
      links.hardcover = `https://hardcover.app/books/${details.slug}`;
    }
  }

  const metadataSources = metadataSourcesOf(details);
  // Union, not either/or: a file-imported work keeps the «livelib-file»
  // provenance after the chain adds litres/hardcover — the file is still where
  // the event's own columns (genres/publisher/series) came from (§5).
  if (fileMeta.present && !metadataSources.includes(FILE_METADATA_SOURCE)) {
    metadataSources.push(FILE_METADATA_SOURCE);
  }

  return {
    workId,
    metadataWorkId,
    title: hcTitle || llTitle,
    titleRu: hcTitle && llTitle && hcTitle !== llTitle ? llTitle : hcTitle ? hcTitle : llTitle,
    authors,
    genres,
    series,
    seriesTagsFiltered: seriesFilter.removed,
    publisher,
    year: year == null ? null : Number(year),
    yearSource: yearInfo.yearSource,
    yearOverride: yearInfo.yearOverride,
    firstPublishedYear,
    firstPublishedYearSource,
    firstPublishedYearPrecision,
    firstPublishedYearKind,
    editionYear,
    editionYearSource,
    pages,
    coverUrl,
    isbn13: (details && details.isbn13) || fileMeta.isbn13 || null,
    isbn10: (details && details.isbn10) || fileMeta.isbn10 || null,
    language: (details && details.editionLanguage) || fileMeta.language || null,
    metadataSources,
    mangaComics: mangaOfDetails(details, genres, series, publisher, fileMeta),
    details,
    links,
    finishedDate,
    collection,
    // Option A: Hardcover priority, LiveLib fallback. With one profile this is
    // simply the rating of the profile's own event(s).
    rating10: hcWithRating ? hcWithRating.rating10 : llEvents.find((e) => e.rating10 != null)?.rating10 ?? null,
    sources: [...new Set(events.map((event) => event.source))].sort(),
    // "Unresolved" means "no bibliographic metadata at all": a details
    // document from the chain or the meaningful columns of a file export
    // (genres/series/publisher/year) both count. A file row carrying only a
    // title and a date is real reading history but not enrichment, so it stays
    // unresolved and the «Метадата: N%» badge keeps telling the truth.
    unresolved: !details && !fileMeta.coverage,
  };
}

/* ------------------------------------------------------------------ */
/* Cross-source work dedupe                                            */
/* ------------------------------------------------------------------ */

const SOURCE_PRIORITY = { hc: 4, lr: 3.5, gb: 3, ol: 2, ll: 1 };

function workPrefix(workId) {
  return String(workId || '').split(':')[0];
}

/**
 * Stable dedupe key: normalized title + author surnames. LiveLib (RU title)
 * and Google Books (same RU edition) can otherwise produce two works for one
 * book, double-counting it in authors/genres widgets.
 */
function canonicalKeyOf(work) {
  const title = strictTitleKey(work.title || work.titleRu || '');
  const authors = [...new Set((work.authors || []).map((name) => surnameOf(name)).filter(Boolean))].sort();
  if (!title || authors.length === 0) return null;
  return `${title}|${authors.join(',')}`;
}

function unionBy(list, keyOf) {
  const seen = new Map();
  for (const entry of list) {
    if (!entry) continue;
    const key = keyOf(entry);
    if (key == null) continue;
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()];
}

function mergeWorkGroup(list) {
  const rank = (work) => (work.unresolved ? 0 : 10) + (SOURCE_PRIORITY[workPrefix(work.workId)] || 0);
  const ordered = [...list].sort((a, b) => {
    const delta = rank(b) - rank(a);
    if (delta !== 0) return delta;
    return String(a.workId) < String(b.workId) ? -1 : 1;
  });
  const primary = ordered[0];
  const pick = (field) => {
    for (const work of ordered) {
      if (work[field] != null && work[field] !== '') return work[field];
    }
    return null;
  };
  const titles = [...new Set(ordered.map((work) => work.title).filter(Boolean))];
  const authors = unionBy(ordered.flatMap((work) => work.authors || []), (name) => name);
  const genres = unionBy(ordered.flatMap((work) => work.genres || []), (name) => name);
  const series = unionBy(
    ordered.flatMap((work) => work.series || []),
    (entry) => `${entry.hcId == null ? '' : entry.hcId}|${entry.name || ''}`
  );
  const metadataSources = [
    ...new Set(ordered.flatMap((work) => work.metadataSources || [])),
  ];
  const links = {};
  for (const work of [...ordered].reverse()) Object.assign(links, work.links || {});
  const mangaValues = ordered.map((work) => work.mangaComics);
  const mangaComics = mangaValues.includes(true)
    ? true
    : mangaValues.includes(false)
    ? false
    : null;
  const finishedDates = ordered.map((work) => work.finishedDate).filter(Boolean).sort();
  // Year priority across merged ids: the user's correction, then the work's
  // first publication, then an edition fallback. A later provider claim must
  // not override an older honest one.
  const yearRank = { manual: 3, first: 2, edition: 1 };
  const yearWork = ordered
    .filter((work) => Number.isFinite(work.year))
    .sort((a, b) => (yearRank[b.yearSource] || 0) - (yearRank[a.yearSource] || 0))[0] || null;

  return {
    ...primary,
    workId: primary.workId,
    mergedWorkIds: ordered.map((work) => work.workId),
    title: pick('title'),
    titleRu: titles.find((title) => title !== primary.title) || primary.title || pick('titleRu'),
    authors,
    genres,
    series,
    publisher: pick('publisher'),
    year: yearWork ? yearWork.year : null,
    yearSource: yearWork ? yearWork.yearSource : null,
    yearOverride: yearWork ? yearWork.yearOverride : null,
    firstPublishedYear: yearWork ? yearWork.firstPublishedYear : null,
    firstPublishedYearSource: yearWork ? yearWork.firstPublishedYearSource : null,
    firstPublishedYearPrecision: yearWork ? yearWork.firstPublishedYearPrecision || null : null,
    firstPublishedYearKind: yearWork ? yearWork.firstPublishedYearKind || null : null,
    editionYear: pick('editionYear'),
    editionYearSource: yearWork ? yearWork.editionYearSource || null : null,
    pages: pick('pages'),
    coverUrl: pick('coverUrl'),
    isbn13: pick('isbn13'),
    isbn10: pick('isbn10'),
    metadataSources,
    mangaComics,
    links,
    finishedDate: finishedDates.length ? finishedDates[finishedDates.length - 1] : null,
    rating10: pick('rating10'),
    sources: [...new Set(ordered.flatMap((work) => work.sources || []))].sort(),
    unresolved: primary.unresolved,
    details: primary.details,
  };
}

/** Merge works that share a canonical title+authors key; return the remap. */
function dedupeWorks(works) {
  const groups = new Map();
  for (const work of works.values()) {
    const key = canonicalKeyOf(work);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(work);
  }
  const merged = new Map(works);
  const remap = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const combined = mergeWorkGroup(group);
    for (const work of group) {
      remap.set(work.workId, combined.workId);
      if (work.workId !== combined.workId) merged.delete(work.workId);
    }
    merged.set(combined.workId, combined);
  }
  return { works: merged, remap };
}

module.exports = {
  workMetadata,
  detailsAuthors,
  mergeGenreLists,
  mangaOfDetails,
  canonicalKeyOf,
  dedupeWorks,
  mergeWorkGroup,
};
